'use strict';

/**
 * E2E do encaixe do Braga Frame em outro app (docs/modulo-bds.md), com o Electron de verdade.
 *
 * Parte 1 (módulo embutido): um mini "app hospedeiro" (tests/e2e/fixtures/host-app) faz o papel do Braga Digital Studio: abre uma
 * janela, carrega o Braga Frame num <iframe ?embedded=1>, registra UM canal genérico que repassa para
 * createBfModule({ channelPrefix: 'bf:', userDataDir: <pasta própria> }).invoke e entrega os eventos ao iframe. O teste olha o
 * iframe pelo DevTools Protocol: carrega sem erros, menu em trilho sem controles de janela, tools:status e source:open pela ponte,
 * projeto criado na pasta do módulo, abas, tema do hospedeiro, eventos, arrastar e soltar, pedido de abrir vídeo, ferramentas do
 * hospedeiro valendo antes das do app, segurança da ponte e dispose() interrompendo uma exportação de verdade.
 *
 * Parte 2 (app próprio): BragaFrame com um vídeo na linha de comando abre o projeto; uma segunda instância com outro vídeo faz a
 * primeira abri-lo (second-instance); argumentos inválidos viram aviso na tela e não abrem nada.
 *
 * Uso: node tests/e2e/embed.e2e.js   (BF_E2E_SHOTDIR=<pasta> guarda capturas)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { locateTools } = require('../../src/core/ffmpeg/locate');
const h = require('./helpers');

const { sleep, waitFor, ROOT } = h;
const HOST_MAIN = path.join(__dirname, 'fixtures', 'host-app', 'main.js');
const tools = locateTools();
const step = (message) => console.log(`✔ ${message}`);
const jq = JSON.stringify;
const sessions = new Set();
const hostDirs = [];

const ANTI_THROTTLE = ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion'];

function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* já tinha terminado */ }
}

// ---------------------------------------------------------------------------------------------------------------------
// hospedeiro de teste
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Abre o app hospedeiro (fixtures/host-app) com perfil temporário. Devolve { host (página do hospedeiro), frame { eval, waitFor },
 * errors, userData, moduleDir, stop }.
 */
async function startHost({ env = {}, hostPage = 'host.html' } = {}) {
  const userData = h.mkTemp('embed-host');
  hostDirs.push(userData);
  const electron = require('electron');
  const proc = spawn(electron, [HOST_MAIN, `--user-data-dir=${userData}`, '--remote-debugging-port=0', ...ANTI_THROTTLE], {
    cwd: ROOT, stdio: 'ignore', windowsHide: false, env: h.mergeEnv(process.env, { HOST_PAGE: hostPage, ...env })
  });
  const session = { proc, userData, browserUrl: null, host: null, stopped: false };
  session.stop = async () => {
    if (session.stopped) return;
    session.stopped = true;
    try { session.host && session.host.ws.close(); } catch { /* ignorar */ }
    if (proc.exitCode === null && session.browserUrl) {
      try {
        const browser = await h.connect(session.browserUrl);
        browser.send('Browser.close').catch(() => {});
        browser.ws.close();
      } catch { /* cai no taskkill */ }
    }
    const end = Date.now() + 8000;
    while (proc.exitCode === null && Date.now() < end) await sleep(100);
    if (proc.exitCode === null) killTree(proc.pid);
    const started = Date.now();
    for (;;) { // processos auxiliares do Electron levam um instante para sair
      const left = h.processesUsing(userData);
      if (!left.length || Date.now() - started > 12000) { for (const p of left) killTree(p.pid); break; }
      await sleep(250);
    }
    sessions.delete(session);
  };
  sessions.add(session);

  try {
    const deadline = Date.now() + 60000;
    let port = null;
    while (Date.now() < deadline && !port) {
      if (proc.exitCode !== null) throw new Error(`O hospedeiro fechou antes de abrir a janela (código ${proc.exitCode}).`);
      const content = h.readPortFile(path.join(userData, 'DevToolsActivePort'));
      if (content) {
        const [first, browserPath] = content.split(/\r?\n/);
        if (Number(first) > 0 && browserPath) { port = Number(first); session.browserUrl = `ws://127.0.0.1:${port}${browserPath}`; }
      }
      if (!port) await sleep(150);
    }
    if (!port) throw new Error('O hospedeiro não informou a porta de depuração a tempo.');

    let target = null;
    while (Date.now() < deadline && !target) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && /host[^/]*\.html/.test(t.url)) || null;
      } catch { /* ainda subindo */ }
      if (!target) await sleep(200);
    }
    if (!target) throw new Error('A janela do hospedeiro não apareceu a tempo.');

    const host = await h.connect(target.webSocketDebuggerUrl);
    session.host = host;
    const contexts = new Map(); // id -> { frameId, isDefault }
    host.on('Runtime.executionContextCreated', ({ context }) => contexts.set(context.id, { frameId: context.auxData && context.auxData.frameId, isDefault: Boolean(context.auxData && context.auxData.isDefault) }));
    host.on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
    host.on('Runtime.exceptionThrown', (p) => host.errors.push(`exceção: ${p.exceptionDetails.exception?.description || p.exceptionDetails.text}`));
    host.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error' || p.type === 'assert') host.errors.push(`console.${p.type}: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    });
    host.on('Log.entryAdded', ({ entry }) => {
      if (entry.level === 'error') host.errors.push(`log: ${entry.text}${entry.url ? ` (${entry.url})` : ''}`);
      else if (entry.level === 'warning') host.warnings.push(`${entry.text} (${entry.url || ''})`);
    });
    host.warnings = [];
    await host.send('Runtime.enable');
    await host.send('Log.enable');
    await host.send('Page.enable');
    await waitFor(host, 'window.__host && window.__host.embed && window.__host.embed.ready === true', 40000, 'o hospedeiro carregar o Braga Frame (ready)');

    /** Contexto JavaScript principal do iframe (muda se o iframe recarregar: sempre consulta de novo). */
    async function frameContext() {
      const tree = await host.send('Page.getFrameTree');
      const child = (tree.result.frameTree.childFrames || [])[0];
      if (!child) throw new Error('o iframe do Braga Frame não existe');
      const ids = [...contexts.entries()].filter(([, c]) => c.frameId === child.frame.id && c.isDefault).map(([id]) => id);
      if (!ids.length) throw new Error('o iframe ainda não tem contexto JavaScript');
      return Math.max(...ids);
    }
    const frame = {
      async eval(expression) {
        const contextId = await frameContext();
        const r = await host.send('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true, userGesture: true });
        if (r.error) throw new Error(`Erro do DevTools: ${r.error.message}`);
        if (r.result.exceptionDetails) throw new Error(`Erro no iframe: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
        return r.result.result.value;
      },
      async waitFor(expression, timeout = 20000, what = expression) {
        const end = Date.now() + timeout;
        let last = null;
        while (Date.now() < end) {
          try { if (await frame.eval(expression)) return; last = null; } catch (err) { last = err; }
          await sleep(150);
        }
        throw new Error(`Tempo esgotado esperando (no iframe): ${what}${last ? ` (último erro: ${last.message})` : ''}`);
      },
      api: (channel, payload) => frame.eval(`BF.api(${jq(channel)}, ${jq(payload || {})})`)
    };
    await frame.waitFor("document.readyState === 'complete' && window.BF ? BF.ready.then(() => true) : false", 40000, 'o Braga Frame carregar (BF.ready)');
    await sleep(300);
    return {
      host, frame, userData, moduleDir: path.join(userData, 'braga-frame'), proc, stop: session.stop,
      get errors() { return host.errors; }, get warnings() { return host.warnings; },
      /** Chama a API do preload do hospedeiro (o que o BDS chamaria por window.bds). */
      hostApi: (expression) => host.eval(`window.hostApi.${expression}`)
    };
  } catch (err) {
    await session.stop();
    throw err;
  }
}

const hostClose = (app) => app.host.eval('window.__host.embed.close()');
const noErrors = (app, what = 'a página') => assert.deepEqual(app.errors, [], `erros no console (${what}):\n- ${app.errors.join('\n- ')}`);
const listProjects = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []);

async function runSecondInstance(userData, args, { timeout = 60000, appArg = '.' } = {}) {
  const proc = spawn(require('electron'), [appArg, `--user-data-dir=${userData}`, ...args], { cwd: ROOT, stdio: 'ignore', windowsHide: false });
  const started = Date.now();
  while (proc.exitCode === null && Date.now() - started < timeout) await sleep(100);
  const exitCode = proc.exitCode;
  if (exitCode === null) killTree(proc.pid);
  return { exitCode, ms: Date.now() - started };
}

// ---------------------------------------------------------------------------------------------------------------------

async function main() {
  assert.ok(tools.ffmpeg && tools.ffprobe, 'ffmpeg/ffprobe necessários para o teste');
  const tmp = h.mkTemp('embed-e2e');
  const shotDir = process.env.BF_E2E_SHOTDIR;
  const videoA = path.join(tmp, 'gameplay A.mp4');
  const videoB = path.join(tmp, 'live B.mp4');
  const videoLong = path.join(tmp, 'longo.mp4');
  const exportDir = path.join(tmp, 'Cortes');
  const dummyFfmpeg = path.join(tmp, 'ffmpeg-do-ambiente.exe'); // arquivo qualquer: a variável de ambiente aponta para ele
  fs.writeFileSync(dummyFfmpeg, 'não é um programa');

  try {
    h.makeSampleVideo(tools.ffmpeg, videoA, { seconds: 12, size: '640x360', rate: 15 });
    h.makeSampleVideo(tools.ffmpeg, videoB, { seconds: 8, size: '640x360', rate: 15 });
    h.makeSampleVideo(tools.ffmpeg, videoLong, { seconds: 70, size: '1280x720', rate: 30 });
    step('vídeos de teste gerados');

    // =====================================================================================
    // PARTE 1 — módulo embutido num app hospedeiro
    // =====================================================================================
    let app = await startHost({
      env: {
        HOST_PICK_FILE: videoB,
        // o ambiente aponta o ffmpeg para um arquivo falso; as ferramentas do hospedeiro têm que ganhar
        CORTE_FFMPEG: dummyFfmpeg,
        HOST_TOOLS: JSON.stringify({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe })
      }
    });
    let { host, frame } = app;

    // ---- 1.1 carrega limpo, em modo embutido, com ponte por mensagens
    assert.equal(await frame.eval('BF.embedded'), true);
    assert.equal(await frame.eval("document.getElementById('app').classList.contains('embedded')"), true);
    assert.equal(await frame.eval("typeof window.hostApi + '|' + typeof require + '|' + typeof process"), 'undefined|undefined|undefined', 'o iframe não tem preload, require nem process');
    assert.equal(await frame.eval('window.bf.transport'), 'postMessage', 'window.bf vem da ponte (renderer/bridge.js)');
    assert.equal(await frame.eval("new URLSearchParams(location.search).get('embedded')"), '1');
    assert.equal(await host.eval("window.__host.config.userDataDir.endsWith('braga-frame')"), true);
    assert.equal((await app.hostApi('stats()')).prefix, 'bf:');
    assert.deepEqual(await host.eval('window.__host.errors'), [], 'nenhuma falha de transporte');
    noErrors(app);
    assert.deepEqual(app.warnings.filter((w) => /sandbox/i.test(w)), [], 'sem o aviso do Chromium sobre sandbox');
    step('Braga Frame carrega no iframe sem erros de console, em modo embutido e com window.bf vindo da ponte (sem preload no iframe)');

    // ---- 1.2 visual: trilho de ícones, sem controles de janela
    const look = await frame.eval(`(() => {
      const box = (id) => { const e = document.getElementById(id); const r = e ? e.getBoundingClientRect() : { width: 0, height: 0 }; return { w: Math.round(r.width), h: Math.round(r.height), display: e ? getComputedStyle(e).display : 'none' }; };
      const tabs = [...document.querySelectorAll('#tabBar .tab-button')];
      return { sidebar: box('sidebar'), controls: box('windowControls'), toggle: box('sidebarToggleBtn'), min: box('win-min'), close: box('win-close'),
        tabCount: tabs.length, label: tabs[0] ? getComputedStyle(tabs[0].querySelector('.tab-label')).display : null,
        drag: getComputedStyle(document.getElementById('globalHeader')).webkitAppRegion || '' };
    })()`);
    assert.ok(look.sidebar.w >= 56 && look.sidebar.w <= 72, `menu em trilho de ~64px (veio ${look.sidebar.w})`);
    assert.equal(look.controls.w * look.controls.h, 0, 'sem controles de janela');
    assert.equal(look.min.w * look.min.h, 0);
    assert.equal(look.close.w * look.close.h, 0);
    assert.equal(look.toggle.w * look.toggle.h, 0, 'sem botão de recolher');
    assert.equal(look.label, 'none', 'só os ícones aparecem no menu');
    assert.notEqual(look.drag, 'drag', 'o app não reivindica a região de arrasto da janela do hospedeiro');
    assert.equal(look.tabCount, 5, 'o trilho tem os 5 itens do menu');
    step('menu lateral em trilho (64px) e sem botões de janela nem região de arrasto');

    // ---- 1.3 tools:status e app:info pela ponte (e pelo canal genérico do hospedeiro)
    const status = await frame.api('tools:status');
    assert.equal(status.ok, true, status.message);
    assert.equal(status.system.length, 2);
    assert.equal(status.system.find((s) => s.id === 'ffmpeg').path, tools.ffmpeg, 'a ferramenta do hospedeiro vale antes da variável CORTE_FFMPEG');
    assert.equal(status.system.find((s) => s.id === 'ffmpeg').found, true);
    assert.ok(status.tools.some((t) => t.id === 'ytdlp'));
    const info = await frame.api('app:info');
    assert.equal(info.name, 'Braga Frame');
    assert.equal(info.version, require('../../package.json').version, 'a versão é a do Braga Frame, não a do hospedeiro');
    assert.equal(info.tools.ffprobe, tools.ffprobe);
    assert.equal(await frame.eval('BF.state.tools.ffmpeg'), tools.ffmpeg);
    const direct = await app.hostApi("invoke('tools:status')");
    assert.equal(direct.ok, true, 'o hospedeiro também chama o módulo pelo canal genérico');
    assert.equal(direct.system.find((s) => s.id === 'ffmpeg').path, tools.ffmpeg);
    const stats = await app.hostApi('stats()');
    assert.ok(stats.channels.includes('tools:status') && stats.channels.includes('app:info'), 'as chamadas passaram pelo canal genérico');
    assert.ok(stats.moduleChannels > 40, 'canais do módulo registrados só no mapa do módulo');
    assert.equal(stats.refused, 0);
    step('tools:status e app:info funcionam pela ponte; ffmpeg do hospedeiro ganhou da variável de ambiente; versão é a do Braga Frame');

    // ---- 1.4 abrir vídeo: o projeto vai para a pasta do módulo
    const opened = await app.hostApi(`invoke('source:open', { path: ${jq(videoA)} })`);
    assert.equal(opened.ok, true, opened.message);
    assert.equal(opened.project.source.path, videoA);
    assert.equal(opened.info.width, 640);
    const inModule = listProjects(path.join(app.moduleDir, 'projects'));
    assert.equal(inModule.length, 1, 'projeto criado na pasta do módulo');
    assert.equal(fs.existsSync(path.join(app.userData, 'projects')), false, 'nada na pasta de dados do hospedeiro');
    assert.deepEqual(fs.readdirSync(app.userData).filter((n) => ['queue.json', 'preferences.json', 'cache', 'tools', 'downloads', 'history'].includes(n)), [], 'o estado do módulo não vaza para a pasta do hospedeiro');
    step('source:open pelo canal genérico criou o projeto em <hospedeiro>/braga-frame/projects (e em nenhum outro lugar)');

    // pela interface (BF.openSource dentro do iframe)
    await frame.eval(`BF.openSource(${jq(videoA)}).then((r) => r.ok)`);
    await frame.waitFor(`BF.state.project && BF.state.project.source.path === ${jq(videoA)}`, 20000, 'projeto aberto no iframe');
    assert.equal(await frame.eval("document.getElementById('app').classList.contains('no-project')"), false);
    await frame.waitFor("document.getElementById('video').getAttribute('src').startsWith('file:')", 10000, 'player com o vídeo');
    assert.equal(listProjects(path.join(app.moduleDir, 'projects')).length, 1, 'o mesmo vídeo reaproveita o projeto');
    await frame.eval("BF.project.addCut({ title: 'Corte do teste', start: 1, end: 5 }) && true");
    await frame.eval('BF.project.flush()');
    const savedProject = JSON.parse(fs.readFileSync(path.join(app.moduleDir, 'projects', listProjects(path.join(app.moduleDir, 'projects'))[0]), 'utf8'));
    assert.equal(savedProject.cuts.length, 1, 'o salvamento do renderer também vai para a pasta do módulo');
    step('a interface abre o vídeo e salva o corte na pasta do módulo');

    // ---- 1.5 menu e telas
    const menuIds = await frame.eval("[...document.querySelectorAll('#tabBar .tab-button')].map((b) => b.dataset.tab)");
    assert.deepEqual(menuIds, ['home', 'projects', 'editor', 'queue', 'settings'], 'os 5 itens do menu (Novo projeto abre pelos botões, sem item)');
    // as 12 telas abrem pelos botões de verdade: o item do menu, depois a aba interna (Cortes e Configurações) ou, para Novo projeto, o botão de Projetos
    const screens = [
      { id: 'home', menu: 'home' }, { id: 'projects', menu: 'projects' }, { id: 'sources', menu: 'projects' }, { id: 'cuts', menu: 'editor' }, { id: 'export', menu: 'editor' },
      { id: 'queue', menu: 'queue' }, { id: 'subtitles', menu: 'editor' }, { id: 'audio', menu: 'editor' }, { id: 'analysis', menu: 'editor' }, { id: 'general', menu: 'settings' }, { id: 'prefs', menu: 'settings' }, { id: 'tools', menu: 'settings' }
    ];
    for (const { id, menu } of screens) {
      if (id === 'sources') {
        await frame.eval("document.getElementById('tab-projects').click()");
        await frame.eval("document.querySelector('#tabpanel-projects .prj-head [data-act=new]').click()");
      } else {
        await frame.eval(`document.getElementById('tab-${menu}').click()`);
        if (id !== menu) await frame.eval(`document.getElementById('tab-${id}').click()`);
      }
      await frame.waitFor(`document.getElementById('app').dataset.activeTab === '${id}' && document.getElementById('tab-${menu}').getAttribute('aria-selected') === 'true' && !document.getElementById('tabpanel-${id}').hidden`, 8000, `tela ${id} aberta pelo menu ${menu}`);
      assert.equal(await frame.eval(`document.getElementById('tabpanel-${id}').children.length > 0`), true, `tela ${id} montada`);
    }
    assert.equal(await frame.eval('BF.ui.selectTab("cuts")'), true);
    assert.match(await frame.eval("document.getElementById('pageTitle').textContent"), /Cortes/);
    noErrors(app, 'depois de percorrer as telas');
    step('as 12 telas abrem e montam dentro do iframe pelo menu de 5 itens (e Novo projeto pelo botão de Projetos), sem erros');

    // ---- 1.6 botão "Abrir vídeo" (diálogo do hospedeiro) e pedido de abrir vídeo vindo do hospedeiro
    await frame.eval("document.getElementById('btnOpen').click()");
    await frame.waitFor(`BF.state.project && BF.state.project.source.path === ${jq(videoB)}`, 20000, 'Abrir vídeo (source:pick → source:open)');
    assert.equal(listProjects(path.join(app.moduleDir, 'projects')).length, 2);
    step('"Abrir vídeo" usa o diálogo do hospedeiro (source:pick) e abre o projeto');

    assert.equal(await app.hostApi(`openVideo(${jq(videoA)})`), true);
    await frame.waitFor(`BF.state.project && BF.state.project.source.path === ${jq(videoA)}`, 20000, 'pedido de abrir vídeo do hospedeiro');
    assert.equal(await app.hostApi(`openVideo(${jq(path.join(tmp, 'fantasma.mp4'))})`), true);
    await frame.waitFor("[...document.querySelectorAll('#toasts .toast.error')].some((t) => /não foi encontrado/.test(t.textContent))", 15000, 'aviso de arquivo inexistente');
    assert.equal(await frame.eval('BF.state.project.source.path'), videoA, 'o pedido inválido não troca o vídeo');
    assert.deepEqual((await app.hostApi("invoke('app:takeOpenRequest')")).requests, [], 'cada pedido é entregue uma vez');
    // o mesmo pedido, pelo canal genérico (é como o BDS pediria sem chamar o módulo direto)
    const viaChannel = await app.hostApi(`invoke('app:requestOpen', { path: ${jq(videoB)} })`);
    assert.equal(viaChannel.ok, true, viaChannel.message);
    await frame.waitFor(`BF.state.project && BF.state.project.source.path === ${jq(videoB)}`, 20000, 'app:requestOpen pelo canal genérico');
    const refused = await app.hostApi(`invoke('app:requestOpen', { path: 'relativo.mp4' })`);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'RELATIVE_PATH');
    assert.equal(await app.hostApi(`openVideo(${jq(videoA)})`), true);
    await frame.waitFor(`BF.state.project && BF.state.project.source.path === ${jq(videoA)}`, 20000, 'volta ao vídeo A');
    step('requestOpen do hospedeiro abre o vídeo na interface; pedido inválido vira aviso e não abre nada');

    // ---- 1.7 tema do hospedeiro e do app
    assert.equal(await frame.eval("document.documentElement.getAttribute('data-theme')"), 'dark');
    await host.eval("document.getElementById('hostTheme').click()");
    await frame.waitFor("document.documentElement.getAttribute('data-theme') === 'light'", 8000, 'tema claro repassado ao iframe');
    assert.equal(await frame.eval("getComputedStyle(document.body).backgroundColor !== 'rgb(0, 0, 0)'"), true, 'o tema claro realmente muda as cores');
    await frame.eval("BF.ui.setTheme(BF.ui.theme() === 'light' ? 'dark' : 'light'); true");
    await waitFor(host, "window.__host.themeFromFrame === 'dark' && document.documentElement.getAttribute('data-theme') === 'dark'", 8000, 'tema escolhido no app volta ao hospedeiro');
    assert.equal(await frame.eval("document.documentElement.getAttribute('data-theme')"), 'dark');
    await host.eval("document.getElementById('hostTheme').click()"); // claro de novo
    await frame.waitFor("document.documentElement.getAttribute('data-theme') === 'light'");
    await host.eval("document.getElementById('hostTheme').click()"); // escuro
    await frame.waitFor("document.documentElement.getAttribute('data-theme') === 'dark'");
    step('tema: o hospedeiro repassa ao Braga Frame e o botão de tema do app avisa o hospedeiro');

    // ---- 1.8 eventos do processo principal chegam à interface
    await app.hostApi("emit('tools:changed', { tools: { ffmpeg: 'X:\\\\evento\\\\ffmpeg.exe', ffprobe: null, ytdlp: null, whisper: null, twitchDownloader: null } })");
    await frame.waitFor("BF.state.tools.ffmpeg === 'X:\\\\evento\\\\ffmpeg.exe'", 8000, 'evento tools:changed no iframe');
    assert.equal((await frame.api('app:refreshTools')).tools.ffmpeg, tools.ffmpeg, 'o estado real do módulo não foi alterado pelo evento de teste');
    await frame.api('queue:setSettings', { retries: 3 });
    await frame.waitFor('BF.queue && BF.queue.state && BF.queue.state.settings && BF.queue.state.settings.retries === 3', 8000, 'evento queue:update (real) no iframe');
    await frame.api('queue:setSettings', { retries: 2 });
    step('eventos do módulo (tools:changed, queue:update) chegam ao iframe pela assinatura da ponte');

    // ---- 1.9 foco e teclado
    await host.eval("document.getElementById('hostFocus').click()");
    await sleep(100);
    assert.equal(await host.eval("document.activeElement && document.activeElement.tagName"), 'IFRAME', 'o foco vai para o iframe');
    step('focus() do hospedeiro leva o foco do teclado para o Braga Frame');

    // ---- 1.10 segurança da ponte
    const before = (await app.hostApi('stats()')).invokes;
    const forged = await frame.eval(`new Promise((resolve) => {
      const results = [];
      window.addEventListener('message', (e) => { if (e.data && e.data.kind === 'result' && e.data.id >= 9000) results.push(e.data); });
      const send = (id, channel) => window.parent.postMessage({ source: 'braga-frame', version: 1, kind: 'invoke', id, channel, payload: {} }, '*');
      send(9001, '../../etc:passwd');
      send(9002, 'window:close');   // formato válido, mas o módulo embutido não expõe controles da janela
      send(9003, 'bf:app:info');    // o iframe só conhece nomes simples
      window.parent.postMessage({ source: 'outra-coisa', kind: 'invoke', id: 9004, channel: 'app:info' }, '*');
      window.parent.postMessage('texto solto', '*');
      setTimeout(() => resolve(results), 800);
    })`);
    const byId = Object.fromEntries(forged.map((m) => [m.id, m]));
    assert.equal(byId[9001].ok, false, 'canal fora do formato recusado pelo hospedeiro');
    assert.equal(byId[9002].ok, true);
    assert.equal(byId[9002].value.code, 'UNKNOWN_CHANNEL', 'window:close não existe no módulo embutido');
    assert.equal(byId[9003].ok, false);
    assert.equal(byId[9004], undefined);
    assert.equal(await host.eval('window.closed === false && document.querySelector("iframe") !== null'), true, 'a janela do hospedeiro continua aberta');
    const after = (await app.hostApi('stats()')).invokes;
    assert.ok(after > before, 'a chamada de formato válido (window:close) chegou ao canal genérico');
    const seen = (await app.hostApi('stats()')).channels;
    assert.ok(seen.includes('window:close'));
    assert.ok(!seen.some((c) => c.includes('etc') || c === 'bf:app:info'), 'os canais inválidos nunca chegaram ao canal genérico');
    noErrors(app, 'depois das mensagens forjadas');
    step('mensagens forjadas: canal inválido e remetente estranho são barrados; window:close não existe no módulo embutido');

    // ---- 1.11 arrastar e soltar um arquivo no iframe (caminho resolvido pelo preload do hospedeiro)
    const rect = await host.eval('(() => { const r = document.querySelector("iframe").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
    await frame.eval("BF.ui.selectTab('sources')"); // a tela Novo projeto: abrir um vídeo estando nela leva para Análise
    const dragData = { items: [], files: [videoB, videoA], dragOperationsMask: 1 }; // dois arquivos: só o primeiro abre, e o aviso diz isso
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      const r = await host.send('Input.dispatchDragEvent', { type, x: rect.x, y: rect.y, data: dragData });
      assert.ok(!r.error, `Input.dispatchDragEvent ${type}: ${r.error && r.error.message}`);
    }
    await frame.waitFor(`BF.state.project && BF.state.project.source.path === ${jq(videoB)}`, 20000, 'arquivo solto no iframe abre o projeto');
    assert.equal(await frame.eval("document.getElementById('app').classList.contains('drag')"), false, 'o destaque da área de soltar some');
    await frame.waitFor("document.getElementById('app').dataset.activeTab === 'analysis'", 10000, 'soltar um vídeo estando em Novo projeto leva para Análise');
    assert.match(await frame.eval("document.getElementById('toasts').textContent"), /abri só o primeiro \(1 ficou de fora\)/, 'dois arquivos soltos: o aviso de que só o primeiro abriu');
    step('arrastar e soltar no iframe: o hospedeiro descobre o caminho (webUtils), o Braga Frame abre o primeiro vídeo (avisa do segundo) e segue de Novo projeto para Cortes');

    if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); await h.screenshot(host, path.join(shotDir, 'embed-host.png')); }
    noErrors(app, 'ao final da parte principal');

    // ---- 1.12 dispose() encerra tudo: exportação de verdade interrompida, processos parados, canais fechados
    const job = {
      id: 'embed-1', projectId: 'sem-projeto', projectTitle: 'longo', sourcePath: videoLong,
      sourceInfo: { width: 1280, height: 720, fps: 30, duration: 70, hasAudio: true },
      cut: { id: 'corte-1', title: 'Longo', start: 2, end: 60, revision: 1, audio: { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0, history: [] }, subtitles: null, framing: null, exports: [] },
      profile: { id: 'e2e-1080', name: 'Teste 1080×1920', kind: 'custom', width: 1080, height: 1920, codec: 'h264', bitrateKbps: 12000, encoder: 'software', fps: 'source', container: 'mp4' },
      framing: null, outputDir: exportDir, baseName: 'Longo', onConflict: 'ask', createdAt: new Date().toISOString()
    };
    const queued = await app.hostApi(`invoke('queue:enqueue', { jobs: [${jq(job)}] })`);
    assert.equal(queued.ok, true, queued.message);
    await waitFor(host, `window.hostApi.invoke('queue:list').then((r) => r.jobs.some((j) => j.state === 'running'))`, 60000, 'a exportação começar');
    const ffmpegBefore = h.processesUsing(exportDir).filter((p) => /ffmpeg/i.test(p.name));
    assert.ok(ffmpegBefore.length >= 1, 'há um ffmpeg exportando para a pasta de saída');

    assert.equal(await app.hostApi('dispose()'), true);
    const disposedStats = await app.hostApi('stats()');
    assert.equal(disposedStats.disposed, true);
    assert.equal(disposedStats.moduleChannels, 0);
    const queueAfter = JSON.parse(fs.readFileSync(path.join(app.moduleDir, 'queue.json'), 'utf8'));
    assert.equal(queueAfter.jobs.find((j) => j.id === 'embed-1').state, 'interrupted', 'a exportação foi interrompida e gravada como tal');
    let gone = false;
    for (let i = 0; i < 40 && !gone; i += 1) { gone = h.processesUsing(exportDir).filter((p) => /ffmpeg/i.test(p.name)).length === 0; if (!gone) await sleep(250); }
    assert.equal(gone, true, 'o ffmpeg da exportação parou');
    const afterDispose = await frame.api('app:info');
    assert.equal(afterDispose.ok, false);
    assert.equal(afterDispose.code, 'MODULE_DISPOSED');
    assert.match(afterDispose.message, /desligado/);
    assert.equal((await app.hostApi("invoke('tools:status')")).code, 'MODULE_DISPOSED');
    assert.equal((await app.hostApi('stats()')).invokes > disposedStats.invokes - 1, true);
    assert.deepEqual(fs.readdirSync(exportDir).filter((f) => f.endsWith('.part')), [], 'nenhum .part sobrou na pasta do usuário');
    step('dispose(): a exportação em andamento virou "interrompida", o ffmpeg parou, os canais fecharam e o módulo responde MODULE_DISPOSED');

    // destruir o iframe (sair da tela) solta tudo no hospedeiro
    await host.eval('window.__host.embed.destroy()');
    assert.equal(await host.eval('document.querySelector("iframe") === null && window.__host.embed.destroyed'), true);
    noErrors(app, 'no fim');
    await app.stop();
    assert.deepEqual(h.processesUsing(app.userData), [], 'nenhum processo do hospedeiro ficou aberto');
    step('o hospedeiro fecha sem deixar processo nenhum');

    // =====================================================================================
    // PARTE 1b — CSP do BDS e prefixo
    // =====================================================================================
    app = await startHost({ hostPage: 'host-bds-csp.html', env: { HOST_TOOLS: JSON.stringify({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe }) } });
    assert.equal(await app.frame.eval('BF.embedded'), true);
    assert.equal((await app.frame.api('app:info')).ok, true);
    noErrors(app, 'com a CSP exata do BDS');
    step('com a CSP atual do BDS (sem frame-src) o iframe de file:// carrega: não é preciso mudar a CSP');

    // sair da tela: close() faz o Braga Frame gravar o que ainda esperava o salvamento (300 ms) antes de tirar o iframe
    await app.frame.eval(`BF.openSource(${jq(videoA)}).then((r) => r.ok)`);
    await app.frame.waitFor(`BF.state.project && BF.state.project.source.path === ${jq(videoA)}`, 20000, 'projeto aberto');
    await app.frame.eval("BF.project.addCut({ title: 'Salvo ao sair', start: 2, end: 6 }) && true");
    assert.equal(await app.frame.eval('BF.state.project.cuts.length'), 1);
    const projectFile = path.join(app.moduleDir, 'projects', listProjects(path.join(app.moduleDir, 'projects'))[0]);
    assert.equal(JSON.parse(fs.readFileSync(projectFile, 'utf8')).cuts.length, 0, 'ainda não gravou (o salvamento espera 300 ms)');
    assert.equal(await app.frame.eval('document.getElementById("video").paused'), true);
    assert.equal(await hostClose(app), true, 'close() confirma que gravou');
    assert.equal(JSON.parse(fs.readFileSync(projectFile, 'utf8')).cuts.length, 1, 'o corte foi gravado antes de o iframe sair');
    assert.equal(await app.host.eval('document.querySelector("iframe") === null'), true);
    await app.stop();
    step('close(): o corte feito na hora de sair é gravado antes de o iframe ser removido');

    // =====================================================================================
    // PARTE 1c — a cópia do doc (só renderer/, src/ e package.json) funciona sozinha
    // =====================================================================================
    const vendor = path.join(tmp, 'vendor', 'braga-frame');
    fs.mkdirSync(vendor, { recursive: true });
    fs.cpSync(path.join(ROOT, 'renderer'), path.join(vendor, 'renderer'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'src'), path.join(vendor, 'src'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(vendor, 'package.json'));
    app = await startHost({ env: { HOST_BF_ROOT: vendor, HOST_PICK_FILE: videoB, HOST_TOOLS: JSON.stringify({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe }) } });
    assert.ok((await app.frame.eval('location.pathname')).endsWith('/vendor/braga-frame/renderer/index.html'), 'o iframe carregou a cópia');
    assert.equal((await app.frame.api('app:info')).version, require('../../package.json').version);
    assert.equal((await app.frame.api('tools:status')).ok, true);
    await app.frame.eval(`BF.openSource(${jq(videoA)}).then((r) => r.ok)`);
    await app.frame.waitFor(`BF.state.project && BF.state.project.source.path === ${jq(videoA)}`, 20000, 'abrir vídeo na cópia');
    for (const id of ['export', 'queue', 'subtitles', 'audio', 'analysis', 'sources', 'general', 'prefs', 'tools', 'cuts']) {
      await app.frame.eval(`BF.ui.selectTab('${id}')`);
      await app.frame.waitFor(`document.getElementById('app').dataset.activeTab === '${id}' && !document.getElementById('tabpanel-${id}').hidden`, 8000, `tela ${id}`);
    }
    noErrors(app, 'na cópia do vendor');
    await app.stop();
    step('a cópia só com renderer/, src/ e package.json (como em vendor/braga-frame do BDS) carrega e funciona');

    // =====================================================================================
    // PARTE 2 — app próprio: linha de comando e segunda instância
    // =====================================================================================
    const userData = path.join(tmp, 'perfil-proprio');
    let own = await h.launchApp(userData, { args: [videoA] });
    await waitFor(own.page, `BF.state.project && BF.state.project.source.path === ${jq(videoA)}`, 30000, 'o vídeo da linha de comando abrir na partida');
    assert.equal(await own.page.eval("document.getElementById('app').classList.contains('embedded')"), false, 'app próprio não está em modo embutido');
    assert.equal(await own.page.eval("getComputedStyle(document.getElementById('windowControls')).display !== 'none'"), true, 'janela própria mantém os controles');
    assert.equal(await own.page.eval('window.bf.transport'), undefined, 'janela própria usa o preload, não a ponte');
    assert.equal(await own.page.eval("BF.api('window:state').then((r) => r.ok)"), true, 'canais window:* existem no app próprio');
    assert.equal(await own.page.eval('BF.state.project.cuts.length'), 0);
    assert.equal(listProjects(path.join(userData, 'projects')).length, 1);
    assert.equal((await own.page.eval("BF.api('app:takeOpenRequest')")).requests.length, 0, 'o pedido da partida já foi entregue');
    step('BragaFrame "<vídeo>" abre esse vídeo como projeto ao iniciar (janela própria intacta)');

    const second = await runSecondInstance(userData, [videoB]);
    assert.equal(second.exitCode, 0, `a segunda instância sai sozinha (código ${second.exitCode})`);
    await waitFor(own.page, `BF.state.project && BF.state.project.source.path === ${jq(videoB)}`, 30000, 'a primeira instância abrir o vídeo da segunda');
    assert.equal(listProjects(path.join(userData, 'projects')).length, 2);
    step('segunda instância com outro vídeo: ela encerra e a primeira abre o projeto desse vídeo');

    const bad = await runSecondInstance(userData, ['relativo.mp4']);
    assert.equal(bad.exitCode, 0);
    await waitFor(own.page, "[...document.querySelectorAll('#toasts .toast.error')].some((t) => /caminho completo/.test(t.textContent))", 20000, 'aviso de caminho relativo');
    const ghost = await runSecondInstance(userData, [path.join(tmp, 'fantasma.mkv')]);
    assert.equal(ghost.exitCode, 0);
    await waitFor(own.page, "[...document.querySelectorAll('#toasts .toast.error')].some((t) => /não foi encontrado/.test(t.textContent))", 20000, 'aviso de arquivo inexistente');
    const notVideo = path.join(tmp, 'anotacoes.txt');
    fs.writeFileSync(notVideo, 'x');
    assert.equal((await runSecondInstance(userData, [notVideo])).exitCode, 0);
    await waitFor(own.page, "[...document.querySelectorAll('#toasts .toast.error')].some((t) => /Formato não suportado/.test(t.textContent))", 20000, 'aviso de formato');
    assert.equal(await own.page.eval('BF.state.project.source.path'), videoB, 'argumentos inválidos não trocam o vídeo aberto');
    assert.equal(listProjects(path.join(userData, 'projects')).length, 2, 'nem criam projeto');
    step('argumentos inválidos (relativo, inexistente, formato) viram aviso na tela e não abrem nada');

    // como o BDS abre em desenvolvimento: electron.exe + pasta do Braga Frame por extenso + vídeo
    assert.equal((await runSecondInstance(userData, [videoA], { appArg: ROOT })).exitCode, 0);
    await waitFor(own.page, `BF.state.project && BF.state.project.source.path === ${jq(videoA)}`, 30000, 'abrir com a pasta do app por extenso');
    assert.equal((await runSecondInstance(userData, [videoB], { appArg: ROOT })).exitCode, 0);
    await waitFor(own.page, `BF.state.project && BF.state.project.source.path === ${jq(videoB)}`, 30000, 'voltar ao vídeo B');
    step('electron.exe "<pasta do Braga Frame>" "<vídeo>" (forma de desenvolvimento) também abre o vídeo');

    assert.equal((await runSecondInstance(userData, [])).exitCode, 0);
    await sleep(500);
    assert.equal(await own.page.eval('BF.state.project.source.path'), videoB, 'segunda instância sem vídeo só traz a janela para a frente');
    if (shotDir) await h.screenshot(own.page, path.join(shotDir, 'embed-own.png'));
    h.assertNoConsoleErrors(own.page);
    await own.stop();

    // partida com um caminho inválido: avisa, abre a tela inicial normalmente
    own = await h.launchApp(path.join(tmp, 'perfil-proprio-2'), { args: [path.join(tmp, 'nao-existe.mp4')] });
    await waitFor(own.page, "[...document.querySelectorAll('#toasts .toast.error')].some((t) => /não foi encontrado/.test(t.textContent))", 20000, 'aviso na partida');
    assert.equal(await own.page.eval('BF.state.project'), null);
    await own.stop();
    step('partida com caminho inválido: avisa e abre normalmente, sem projeto');
    console.log('\nOK: embed.e2e');
  } finally {
    for (const session of [...sessions]) await session.stop();
    await h.cleanupAll();
    for (const dir of hostDirs) h.removeDir(dir);
    h.removeDir(tmp);
  }
}

main().catch(async (err) => {
  console.error('FALHOU:', err);
  for (const session of [...sessions]) await session.stop();
  await h.cleanupAll();
  process.exit(1);
});

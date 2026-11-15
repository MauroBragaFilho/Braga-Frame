'use strict';

/**
 * E2E da aba Ferramentas: abre o app Electron de verdade (perfil de usuário temporário) e confere
 *  1) sem entradas de TESTE: FFmpeg e FFprobe do sistema (com versão, sem botão algum) e exatamente as quatro
 *     ferramentas oficiais do registro (ytdlp, whisper, twitchdownloader, deno), todas com origem oficial e sem selo de teste;
 *  2) sem FFmpeg no PATH: instruções de instalação (sem oferecer download) e aviso na aba;
 *  3) com uma entrada de TESTE apontando para um servidor HTTP local (BF_TEST_TOOL_ENTRIES, que só vale com
 *     NODE_ENV=test e app não empacotado): cancelar, instalar com progresso, erro de SHA-256 explicado,
 *     persistência após reiniciar, remover (com confirmação) e o ctx.tools / BF.bus acompanhando tudo.
 * Uso: node tests/e2e/tools.e2e.js     (BF_E2E_SHOTDIR=C:\pasta guarda capturas da janela)
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { locateTools } = require('../../src/core/ffmpeg/locate');
const { makeZip, startServer, makeEntry, listTree } = require('../tools-fixtures');
const h = require('./helpers');

const { sleep, waitFor, answerModal } = h;
const tools = locateTools();
const KEY = `${process.platform}-${process.arch}`;
const PANEL = '#tabpanel-tools';

const OFFICIAL_IDS = ['deno', 'twitchdownloader', 'whisper', 'whisper-cuda', 'ytdlp']; // entradas oficiais de src/core/tools/entries (ordem alfabética)

const row = (id) => `${PANEL} li.tool[data-tool="${id}"]`;
const rowState = (page, id) => page.eval(`(document.querySelector('${row(id)}') || { dataset: {} }).dataset.state || null`);
const rowText = (page, id) => page.eval(`(document.querySelector('${row(id)}') || {}).textContent || ''`);
const click = (page, id, act) => page.eval(`document.querySelector('${row(id)} button[data-act="${act}"]').click()`);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Manda o arquivo aos poucos, para a barra de progresso ter o que mostrar. */
function slowSend(res, buf, { chunk = 32 * 1024, everyMs = 120 } = {}) {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length });
  let offset = 0;
  const timer = setInterval(() => {
    if (res.destroyed) { clearInterval(timer); return; }
    res.write(buf.subarray(offset, offset + chunk));
    offset += chunk;
    if (offset >= buf.length) { clearInterval(timer); res.end(); }
  }, everyMs);
  res.on('close', () => clearInterval(timer));
}

/** Lê a linha da ferramenta (estado, valor da barra e texto de progresso) até `until(amostra)` ser verdadeiro. */
async function watchRow(page, id, until, timeoutMs = 30000) {
  const samples = [];
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await page.eval(`(() => {
      const li = document.querySelector('${row(id)}');
      if (!li) return null;
      const bar = li.querySelector('progress');
      const text = li.querySelector('.tool-progress-text');
      return { state: li.dataset.state, value: bar && bar.hasAttribute('value') ? bar.value : null, text: text ? text.textContent : null };
    })()`);
    samples.push(s);
    if (s && until(s)) return samples;
    await sleep(60);
  }
  throw new Error(`Tempo esgotado esperando a linha "${id}" (últimas amostras: ${JSON.stringify(samples.slice(-3))})`);
}

async function showToolsTab(app, { video } = {}) {
  const { page } = app;
  if (video) {
    await page.eval(`BF.openSource(${JSON.stringify(video)})`);
    await waitFor(page, "!document.getElementById('app').classList.contains('no-project')", 20000, 'vídeo aberto');
  }
  await page.eval("BF.ui.selectTab('tools')");
  await waitFor(page, `document.querySelectorAll('${PANEL} li.tool').length > 0`, 20000, 'lista de ferramentas da aba');
}

async function main() {
  assert.ok(tools.ffmpeg && tools.ffprobe, 'ffmpeg/ffprobe necessários para o teste');
  const tmp = h.mkTemp('e2e-tools');
  const shotDir = process.env.BF_E2E_SHOTDIR;
  const shot = async (page, name) => { if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); await h.screenshot(page, path.join(shotDir, `${name}.png`)); } };
  const step = (m) => console.log(`✔ ${m}`);
  const video = path.join(tmp, 'amostra.mp4');
  const noTestEnv = { NODE_ENV: '', BF_TEST_TOOL_ENTRIES: '' };
  let srv = null;

  try {
    h.makeSampleVideo(tools.ffmpeg, video, { seconds: 3, size: '320x180', rate: 10 });

    // ---------- 1) registro sem entradas de teste: só as ferramentas do sistema ----------
    {
      const userData = path.join(tmp, 'ud-sistema');
      const app = await h.launchApp(userData, { env: noTestEnv });
      const { page } = app;
      await showToolsTab(app, { video });
      const status = await page.eval("BF.api('tools:status')");
      assert.equal(status.ok, true);
      assert.deepEqual(status.system.map((s) => [s.id, s.found]), [['ffmpeg', true], ['ffprobe', true]]);

      for (const id of ['ffmpeg', 'ffprobe']) {
        assert.equal(await rowState(page, id), 'found');
        const text = await rowText(page, id);
        assert.match(text, /versão \S+/, `${id}: versão detectada aparece`);
        assert.ok(text.includes(tools[id]), `${id}: caminho aparece`);
      }
      const registryRows = await page.eval(`document.querySelectorAll('${PANEL} li.tool:not(.sys)').length`);
      assert.equal(registryRows, status.tools.length, 'uma linha por entrada do registro (e nenhuma a mais)');
      assert.deepEqual(status.tools.map((t) => t.id).sort(), OFFICIAL_IDS, 'o registro oficial traz exatamente as cinco ferramentas do app (a quinta é o pacote CUDA do Whisper)');
      assert.ok(status.tools.every((t) => !t.test && /^oficial: https:\/\//.test(t.source) && t.sizeBytes > 0 && t.version), 'só entradas oficiais, com origem https, versão e tamanho do download');
      for (const id of OFFICIAL_IDS) assert.ok(['missing', 'system'].includes(await rowState(page, id)), `${id}: perfil novo, nada instalado pelo app (ausente ou usando a do sistema)`);
      assert.deepEqual(await page.eval(`[...document.querySelectorAll('${PANEL} h2')].map((n) => n.textContent)`), ['No seu computador', 'Instaladas pelo app'], 'duas seções, sem placeholder');
      assert.equal(await page.eval(`document.querySelectorAll('${PANEL} li.tool:not(.sys) .tool-tag').length`), 0, 'nenhuma ferramenta marcada como "teste local"');
      assert.equal(await page.eval(`document.querySelectorAll('${PANEL} li.tool.sys button').length`), 0, 'FFmpeg e FFprobe nunca têm botão de instalar');
      assert.deepEqual(await page.eval(`[...document.querySelectorAll('${PANEL} button')].filter((b) => !b.closest('li.tool:not(.sys)')).map((b) => b.dataset.act)`), ['recheck'], 'fora das ferramentas do registro só existe o botão Verificar de novo');
      assert.doesNotMatch(await page.eval(`document.querySelector('${PANEL}').textContent`), /Em construção|Carregando|\bnull\b|undefined/);
      assert.equal(await page.eval("document.querySelector('#tab-tools .tab-badge').hidden"), true, 'sem aviso na aba quando o FFmpeg existe');
      assert.equal(await page.eval(`document.querySelector('${PANEL} .tool-help')`), null, 'sem instruções quando nada falta');

      await page.eval(`document.querySelector('${PANEL} button[data-act="recheck"]').click()`);
      await waitFor(page, "/FFmpeg e FFprobe encontrados/.test(document.getElementById('toasts').textContent)", 15000, 'aviso de que o FFmpeg foi encontrado');
      await shot(page, 'tools-sistema');
      h.assertNoConsoleErrors(page);
      await app.stop();
      step('sem entradas de teste: FFmpeg e FFprobe com versão e caminho (sem botões) e as 4 ferramentas oficiais, sem placeholder');
    }

    // ---------- 2) sem FFmpeg no PATH: instruções, sem oferta de download ----------
    {
      const bare = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
      const app = await h.launchApp(path.join(tmp, 'ud-semffmpeg'), { env: { ...noTestEnv, PATH: bare, CORTE_FFMPEG: '', CORTE_FFPROBE: '' } });
      const { page } = app;
      if (await page.eval('BF.state.tools.ffmpeg || BF.state.tools.ffprobe')) {
        // não é mais "pulado": launchApp usa mergeEnv, então PATH=System32 de fato esconde o ffmpeg; se ele aparece, o teste não prova nada
        throw new Error(`o ffmpeg deveria estar escondido (PATH só com a pasta do sistema): ${JSON.stringify(await page.eval('BF.state.tools'))}`);
      } else {
        await showToolsTab(app);
        assert.deepEqual([await rowState(page, 'ffmpeg'), await rowState(page, 'ffprobe')], ['absent', 'absent']);
        const text = await page.eval(`document.querySelector('${PANEL}').textContent`);
        assert.match(text, /não encontrado/i);
        assert.match(text, /ffmpeg\.org\/download\.html/, 'aponta a página oficial do projeto');
        assert.match(text, /não baixa esta ferramenta/, 'explica por que o app não baixa o FFmpeg');
        assert.doesNotMatch(text, /\bnull\b|undefined/);
        assert.match(text, /CORTE_FFMPEG/);
        assert.deepEqual(await page.eval(`[...document.querySelectorAll('${PANEL} button')].filter((b) => !b.closest('li.tool:not(.sys)')).map((b) => b.dataset.act)`), ['recheck'], 'fora das ferramentas do registro só existe "Verificar de novo": nenhum botão de instalar o FFmpeg');
        assert.equal(await page.eval(`document.querySelectorAll('${PANEL} li.tool.sys button').length`), 0, 'as linhas do FFmpeg e do FFprobe não têm botão');
        assert.deepEqual(await page.eval(`[...document.querySelectorAll('${PANEL} li.tool:not(.sys) button[data-act="install"]')].map((b) => b.dataset.tool).sort()`), OFFICIAL_IDS, 'os botões Instalar são só das ferramentas oficiais do registro');
        assert.equal(await page.eval("document.querySelector('#tab-tools .tab-badge').textContent"), '!', 'a aba avisa que falta algo');
        assert.equal(await page.eval("document.getElementById('toolsWarn').hidden"), false);
        await shot(page, 'tools-semffmpeg');
        await page.eval(`document.querySelector('${PANEL} button[data-act="recheck"]').click()`);
        await waitFor(page, "/ainda não foi encontrado/.test(document.getElementById('toasts').textContent)", 15000, 'aviso de que o FFmpeg continua ausente');
        h.assertNoConsoleErrors(page);
        step('sem FFmpeg: instruções claras na aba, aviso "!" na aba, nenhum botão que baixe o FFmpeg');
      }
      await app.stop();
    }

    // ---------- 3) instalar/remover com uma entrada de TESTE servida por HTTP local ----------
    const payload = crypto.randomBytes(512 * 1024); // incompressível: o download dura o bastante para ver a barra
    const good = makeZip([{ name: 'whisper-cli.exe', data: payload }, { name: 'LEIAME.txt', data: 'pacote de teste' }]);
    const evil = Buffer.from(good);
    evil[evil.length - 40] ^= 0xff; // mesmo tamanho, outro conteúdo -> SHA-256 não confere
    srv = await startServer((req, res) => {
      if (req.url === '/whisper.zip') slowSend(res, good);
      else if (req.url === '/ruim.zip') slowSend(res, evil, { chunk: 128 * 1024, everyMs: 20 });
      else { res.writeHead(404); res.end(); }
    });
    const whisper = { ...makeEntry({ base: srv.base, buf: good, id: 'whisper', version: 'b9999', file: 'whisper.zip', exe: 'whisper-cli.exe', key: KEY }), label: 'Whisper (transcrição)' };
    const twitch = { ...makeEntry({ base: srv.base, buf: good, id: 'twitchdownloader', version: '9.9.9', file: 'ruim.zip', exe: 'whisper-cli.exe', key: KEY }), label: 'TwitchDownloaderCLI' };
    const testEnv = { NODE_ENV: 'test', BF_TEST_TOOL_ENTRIES: JSON.stringify([whisper, twitch]) };

    const userData = path.join(tmp, 'ud-teste');
    const toolsDir = path.join(userData, 'tools');
    const exe = path.join(toolsDir, 'whisper', 'b9999', 'whisper-cli.exe');
    let app = await h.launchApp(userData, { env: testEnv });
    let page = app.page;
    await showToolsTab(app, { video });

    // as entradas de teste SUBSTITUEM as oficiais de mesmo id (whisper e twitchdownloader); deno e ytdlp seguem oficiais
    assert.deepEqual(await page.eval(`[...document.querySelectorAll('${PANEL} li.tool:not(.sys)')].map((li) => li.dataset.tool)`).then((ids) => [...ids].sort()), OFFICIAL_IDS);
    assert.deepEqual(await page.eval(`[...document.querySelectorAll('${PANEL} li.tool:not(.sys) .tool-tag')].map((n) => n.closest('li').dataset.tool).sort()`), ['twitchdownloader', 'whisper'], 'só as duas entradas de teste ganham o selo "teste local"');
    for (const id of ['deno', 'ytdlp']) assert.doesNotMatch(await rowText(page, id), /teste local/, `${id} continua sendo a entrada oficial`);
    const before = await page.eval('BF.state.tools.whisper'); // null (ou um whisper-cli do PATH desta máquina)
    assert.ok(['missing', 'system'].includes(await rowState(page, 'whisper')));
    const text0 = await rowText(page, 'whisper');
    assert.match(text0, /Whisper/);
    assert.match(text0, /transcrição/, 'a descrição do rótulo aparece sob o nome');
    assert.match(text0, /Site oficial · exemplo\.invalid/, 'origem resumida (o endereço completo fica em Detalhes e no title)');
    assert.match(await page.eval(`document.querySelector('${row('whisper')} .tool-origin').title`), /^https:\/\/exemplo\.invalid\//);
    assert.match(text0, /teste local/, 'entrada de teste é marcada como tal (nunca passa por oficial)');
    assert.match(text0, /Origem: oficial:/);
    assert.doesNotMatch(await page.eval(`document.querySelector('${PANEL}').textContent`), /\bnull\b|undefined/);
    assert.match(text0, /download de/);
    assert.equal(await page.eval(`document.querySelector('${row('whisper')} button[data-act="install"]').disabled`), false);
    await page.eval("window.__tc = 0; window.__phases = []; BF.bus.on('tools:changed', () => { window.__tc += 1; }); BF.on('tools:progress', (ev) => window.__phases.push(ev.phase)); true");
    step('entrada de teste aparece com estado, origem, tamanho do download e botão Instalar');

    // cancelar no meio do download: nada é alterado e não sobra pasta de trabalho
    await page.eval(`document.querySelector('${row('whisper')} button[data-act="install"]').focus()`);
    await click(page, 'whisper', 'install');
    await watchRow(page, 'whisper', (s) => s.state === 'busy' && s.value >= 10);
    assert.equal(await page.eval(`document.activeElement.dataset.act`), 'cancel', 'o foco acompanha o botão (teclado não se perde)');
    await click(page, 'whisper', 'cancel');
    await watchRow(page, 'whisper', (s) => s.state !== 'busy');
    assert.match(await rowText(page, 'whisper'), /Instalação cancelada/);
    assert.equal(await page.eval(`document.querySelector('${row('whisper')} .tool-error')`), null, 'cancelar não é erro');
    await waitFor(page, `!document.querySelector('${row('whisper')} button[data-act="cancel"]')`);
    assert.deepEqual(listTree(toolsDir), [], 'cancelamento não deixou arquivos (nem .tmp, nem .part)');
    assert.equal(await page.eval('BF.state.tools.whisper'), before);
    assert.equal(await page.eval('window.__tc'), 0, 'nada mudou: sem tools:changed');
    step('cancelar o download: linha volta ao normal, mensagem neutra, nada sobra no disco');

    // instalar de verdade, vendo o progresso
    await click(page, 'whisper', 'install');
    const samples = await watchRow(page, 'whisper', (s) => s.state === 'installed');
    const partial = samples.filter((s) => s.state === 'busy' && s.value > 0 && s.value < 100);
    assert.ok(new Set(partial.map((s) => s.value)).size >= 2, `a barra mostrou progresso parcial crescente: ${JSON.stringify(partial.map((s) => s.value))}`);
    assert.ok(samples.some((s) => /Baixando… \d+% · .* de .*\/s/.test(s.text || '')), 'texto com percentual, bytes e velocidade');
    const phases = await page.eval('[...new Set(window.__phases)]');
    for (const p of ['prepare', 'download', 'verify', 'extract', 'install', 'done']) assert.ok(phases.includes(p), `evento tools:progress da fase ${p} chegou ao renderer`);
    assert.match(await rowText(page, 'whisper'), /Instalado · versão b9999/);
    await waitFor(page, "/Whisper \\(transcrição\\) instalado/.test(document.getElementById('toasts').textContent)", 5000, 'aviso de instalação concluída');
    assert.ok(fs.existsSync(exe), 'executável no lugar');
    const manifest = JSON.parse(fs.readFileSync(path.join(toolsDir, 'whisper', 'b9999', 'manifest.json'), 'utf8'));
    assert.deepEqual([manifest.id, manifest.version, manifest.sha256], ['whisper', 'b9999', whisper.assets[KEY].sha256]);
    assert.ok(samePath(await page.eval('BF.state.tools.whisper'), exe), 'BF.state.tools aponta para a instalada pelo app');
    assert.equal(await page.eval('window.__tc'), 1, 'BF.bus emitiu tools:changed uma vez');
    assert.equal(await page.eval('document.getElementById(\'toolsWarn\').hidden'), true);
    assert.deepEqual(listTree(toolsDir).filter((p) => p.startsWith('.tmp')), [], 'sem pasta de trabalho');
    assert.equal(await page.eval(`document.querySelector('${row('whisper')} button[data-act="remove"]') !== null`), true);
    step('instalar: barra de progresso real (parcial e crescente), fases, manifesto, BF.state.tools e BF.bus atualizados');

    // erro de integridade: mensagem compreensível, nada instalado
    await click(page, 'twitchdownloader', 'install');
    await waitFor(page, `!!document.querySelector('${row('twitchdownloader')} .tool-error')`, 30000, 'mensagem de erro de integridade');
    const err = await page.eval(`document.querySelector('${row('twitchdownloader')} .tool-error').textContent`);
    assert.match(err, /verificação de integridade \(SHA-256 diferente do oficial\)/);
    assert.match(err, /tente de novo/);
    assert.equal(await rowState(page, 'twitchdownloader'), 'missing');
    assert.equal(await page.eval('BF.state.tools.twitchDownloader'), null);
    assert.equal(fs.existsSync(path.join(toolsDir, 'twitchdownloader')), false);
    assert.equal(await page.eval('window.__tc'), 1, 'falha não mexe nas ferramentas');
    await shot(page, 'tools-instalada-e-erro');
    step('SHA-256 que não confere: erro explicado na linha e nada instalado');

    // reiniciar o app: a instalação continua valendo
    h.assertNoConsoleErrors(page);
    await app.stop();
    app = await h.launchApp(userData, { env: testEnv });
    page = app.page;
    assert.ok(samePath(await page.eval('BF.state.tools.whisper'), exe), 'ctx.tools lê a instalação do disco ao iniciar');
    await showToolsTab(app, { video });
    await waitFor(page, `document.querySelector('${row('whisper')}').dataset.state === 'installed'`, 15000, 'instalada após reiniciar');
    await page.eval("window.__tc = 0; BF.bus.on('tools:changed', () => { window.__tc += 1; }); true");
    step('depois de reiniciar o app a ferramenta continua instalada e em uso');

    // remover: confirmar/cancelar o modal
    await click(page, 'whisper', 'remove');
    const asked = await answerModal(page, false);
    assert.equal(asked.title, 'Remover Whisper (transcrição)?');
    assert.match(asked.message, /Se houver uma no sistema, ele volta a usá-la/);
    await sleep(200);
    assert.equal(await rowState(page, 'whisper'), 'installed', 'cancelar a confirmação não remove');
    assert.ok(fs.existsSync(exe));
    await click(page, 'whisper', 'remove');
    await answerModal(page, true);
    await waitFor(page, `document.querySelector('${row('whisper')}').dataset.state !== 'installed'`, 20000, 'remoção concluída');
    assert.ok(['missing', 'system'].includes(await rowState(page, 'whisper')));
    assert.equal(await page.eval('BF.state.tools.whisper'), before, 'volta ao que havia antes (sistema ou nada)');
    assert.equal(await page.eval('window.__tc'), 1, 'BF.bus emitiu tools:changed na remoção');
    await waitFor(page, "/Whisper \\(transcrição\\) removido/.test(document.getElementById('toasts').textContent)", 5000, 'aviso de remoção');
    assert.equal(fs.existsSync(path.join(toolsDir, 'whisper')), false);
    assert.deepEqual(listTree(toolsDir), [], 'nada sobrou na pasta de ferramentas');
    h.assertNoConsoleErrors(page);
    await app.stop();
    step('remover: confirmação, pasta apagada, ctx.tools e BF.bus voltam ao estado anterior');

    // sem NODE_ENV=test a variável é ignorada (como em produção)
    app = await h.launchApp(path.join(tmp, 'ud-producao'), { env: { ...testEnv, NODE_ENV: 'production' } });
    await showToolsTab(app);
    const prod = await app.page.eval("BF.api('tools:status')");
    assert.equal(prod.tools.some((t) => t.test || /teste local/.test(t.source)), false, 'entradas de teste ignoradas fora de NODE_ENV=test');
    await app.stop();
    step('com NODE_ENV diferente de "test" as entradas de teste são ignoradas');

    assert.deepEqual(listTree(tmp).filter((p) => p.endsWith('.part')), [], 'nenhum .part esquecido');
    console.log('\nE2E OK');
  } finally {
    await h.cleanupAll();
    if (srv) await srv.close();
    h.removeDir(tmp);
  }
}

main().then(() => process.exit(0), (err) => {
  console.error(`\n✖ E2E FALHOU: ${err.message}`);
  h.cleanupAll().finally(() => process.exit(1));
});

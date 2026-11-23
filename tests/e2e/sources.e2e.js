'use strict';

/**
 * E2E da tela Novo projeto (aba `sources`, a antiga Fontes): abre o app Electron de verdade (perfil de usuário temporário) e confere pela interface:
 *  0) A TELA: a pergunta e os quatro cartões (Arquivos locais, YouTube, Twitch, Gravações do OBS) lado a lado, a área de soltar grande, um painel
 *     por vez, Enter no cartão, o link colado que troca o cartão, a escolha lembrada depois de recarregar, janela estreita, tema claro, arrastar
 *     e soltar de verdade (arquivo real, dois arquivos, arquivo que não é vídeo) e escolher o arquivo pelo botão (leva para a aba Cortes);
 *  1) SEM yt-dlp e SEM projeto aberto: a aba funciona; OBS detectado na configuração real (um %APPDATA% de teste com basic.ini
 *     e user.ini), gravações por dia com duração do ffprobe, arquivo em gravação de verdade (ffmpeg escrevendo), aviso e
 *     confirmação ao abrir, abrir como projeto com origin { type:'obs' }; yt-dlp ausente explicado, com atalho para Ferramentas;
 *  2) COM yt-dlp FALSO (programa .exe de teste que imita a saída real): erros da fonte em português, download com progresso,
 *     chat do YouTube, abrir como projeto (origem, canal e chat), cancelar e RETOMAR, nome único, cookies do navegador (Avançado),
 *     baixar o chat depois num projeto aberto, Twitch sem o TwitchDownloaderCLI explicado;
 *  3) COM TwitchDownloaderCLI falso, depois de REINICIAR o app: configurações persistidas, chat da Twitch, e reabrir um arquivo
 *     baixado por "Abrir vídeo…" (sem origem) traz origem, jogo, canal e chat pelo gancho; chat apagado é avisado;
 *  4) REDE REAL (desligue com BF_E2E_OFFLINE=1): yt-dlp do sistema com o vídeo público "Me at the zoo" (19 s): metadados e um
 *     download curto. Se o YouTube pedir confirmação de robô, isso é dito no final como NÃO verificado (não é falha do app).
 * Uso: node tests/e2e/sources.e2e.js     (BF_E2E_SHOTDIR=C:\pasta guarda capturas da janela)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { locateTools, findTool } = require('../../src/core/ffmpeg/locate');
const { freeBytes } = require('../../src/core/sources/naming');
const fakes = require('../sources-fakes');
const { makeZip, startServer, makeEntry } = require('../tools-fixtures');
const h = require('./helpers');

const { sleep, waitFor, answerModal } = h;

/** Clica em Baixar; se o app pedir confirmação de download grande (> 5 GB), aceita. */
async function clickDownload(page) {
  await click(page, act('download'));
  const end = Date.now() + 400;
  while (Date.now() < end) {
    if (await page.eval("!!document.querySelector('.bf-modal')")) { await answerModal(page, true); return; }
    await sleep(50);
  }
}
const tools = locateTools();
const FIX = path.join(__dirname, '..', 'sources-fixtures');
const PANEL = '#tabpanel-sources';
const YT_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const TW_URL = 'https://www.twitch.tv/videos/2345678901';

const q = (sel) => `document.querySelector('${PANEL} ${sel}')`;
const qa = (sel) => `[...document.querySelectorAll('${PANEL} ${sel}')]`;
const act = (name) => `button[data-act="${name}"]`;

async function click(page, sel) { await page.eval(`${q(sel)}.click()`); }
async function text(page, sel = '') { return page.eval(`(${q(sel || '.sources')} || { textContent: '' }).textContent`); }
async function has(page, sel) { return page.eval(`!!${q(sel)}`); }
async function setUrl(page, url) {
  await page.eval(`(() => { const i = ${q('.src-url')}; i.value = ${JSON.stringify(url)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}
/** Mostra a tela Novo projeto; com `kind` ('files' | 'youtube' | 'twitch' | 'obs') escolhe também o cartão, como o usuário faz (o painel dele é o que fica à vista). */
async function showSources(page, kind) {
  await page.eval("BF.ui.selectTab('sources')");
  await waitFor(page, `document.querySelector('${PANEL}') && !document.querySelector('${PANEL}').hidden`, 10000, 'tela Novo projeto visível');
  if (kind) {
    await page.eval(`${q(`.src-choice[data-source="${kind}"]`)}.click()`);
    await waitFor(page, `${q(`.src-choice[data-source="${kind}"]`)}.getAttribute('aria-pressed') === 'true'`, 5000, `cartão ${kind} escolhido`);
  }
}
async function selectOption(page, sel, value) {
  await page.eval(`(() => { const s = ${q(sel)}; s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
}

/** PATH sem as pastas que têm o programa `exe` (para simular "não instalado" mesmo com ele no PATH desta máquina). */
function pathWithout(exes) {
  const entries = (process.env.Path || process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return entries.filter((dir) => !exes.some((exe) => fs.existsSync(path.join(dir, exe)))).join(path.delimiter);
}
function envWithPath(value) {
  return { PATH: value, Path: value };
}

/** Amostra a barra de progresso do download até `done(amostra)` ser verdadeiro. */
async function watchProgress(page, done, timeoutMs = 60000) {
  const samples = [];
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await page.eval(`(() => {
      const box = ${q('.src-progress')};
      if (!box) return { gone: true, finished: !!${q('.src-card.ok')}, failed: !!${q('.src-card.bad')} };
      const bar = box.querySelector('progress');
      return { gone: false, value: bar.hasAttribute('value') ? bar.value : null, text: box.querySelector('[data-role="text"]').textContent, phase: box.dataset.phase };
    })()`);
    samples.push(s);
    if (done(s)) return samples;
    await sleep(60);
  }
  throw new Error(`Tempo esgotado esperando o download (últimas amostras: ${JSON.stringify(samples.slice(-4))})`);
}

/** launchApp com nova tentativa: o Windows às vezes trava a leitura do DevToolsActivePort enquanto o Chromium ainda o grava (EBUSY). */
async function launch(userDataDir, opts) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await h.launchApp(userDataDir, opts); } catch (err) {
      last = err;
      if (!/EBUSY|EPERM|EACCES/.test(String(err && (err.code || err.message)))) throw err;
      await h.cleanupAll();
      await sleep(1000);
    }
  }
  throw last;
}

function waitProc(proc) { return new Promise((resolve) => { if (proc.exitCode !== null) resolve(); else proc.once('exit', resolve); }); }

async function main() {
  assert.ok(tools.ffmpeg && tools.ffprobe, 'ffmpeg/ffprobe necessários para o teste');
  const skipFake = fakes.fakeExeSkipReason();
  assert.ok(!skipFake, `programa falso indisponível: ${skipFake}`);
  const tmp = h.mkTemp('e2e-sources');
  const shotDir = process.env.BF_E2E_SHOTDIR;
  const shot = async (page, name) => { if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); await h.screenshot(page, path.join(shotDir, `${name}.png`)); } };
  const step = (m) => console.log(`✔ ${m}`);
  const notVerified = [];
  let recorder = null;
  let toolServer = null;
  const report = { net: null };

  try {
    // ---------- cenário: configuração do OBS, gravações e programas falsos ----------
    const appData = path.join(tmp, 'Roaming');
    const obsDir = path.join(appData, 'obs-studio');
    const rec1 = path.join(tmp, 'REC', 'Gameplay');
    const rec2 = path.join(tmp, 'REC', 'Serie');
    fs.mkdirSync(path.join(obsDir, 'basic', 'profiles', 'Gameplay'), { recursive: true });
    fs.mkdirSync(path.join(obsDir, 'basic', 'profiles', 'Serie'), { recursive: true });
    fs.mkdirSync(rec1, { recursive: true });
    fs.mkdirSync(rec2, { recursive: true });
    fs.writeFileSync(path.join(obsDir, 'basic', 'profiles', 'Gameplay', 'basic.ini'), `\uFEFF[General]\nName=Gameplay\n\n[Output]\nMode=Advanced\n\n[AdvOut]\nRecType=Standard\nRecFilePath=${rec1.replace(/\\/g, '/')}\n`);
    fs.writeFileSync(path.join(obsDir, 'basic', 'profiles', 'Serie', 'basic.ini'), `[General]\nName=Série e Anime\r\n[Output]\r\nMode=Simple\r\n[SimpleOutput]\r\nFilePath=${rec2.replace(/\\/g, '\\\\')}\r\n`);
    fs.writeFileSync(path.join(obsDir, 'user.ini'), '[Basic]\nProfile=Gameplay\nProfileDir=Gameplay\n');
    const old = new Date(Date.now() - 6 * 3600 * 1000);
    const f1 = path.join(rec1, '2026-10-20 21-00-00.mkv');
    const f2 = path.join(rec1, '2026-10-19 18-30-00.mp4');
    h.makeSampleVideo(tools.ffmpeg, f1, { seconds: 5, size: '320x180', rate: 10 });
    h.makeSampleVideo(tools.ffmpeg, f2, { seconds: 7, size: '320x180', rate: 10 });
    h.makeSampleVideo(tools.ffmpeg, path.join(rec2, '2026-10-18 10-00-00.mp4'), { seconds: 3, size: '320x180', rate: 10 });
    for (const f of [f1, f2, path.join(rec2, '2026-10-18 10-00-00.mp4')]) fs.utimesSync(f, old, old);
    // pasta com muitas gravações (49): só as 40 mais recentes são lidas na hora; as outras completam ao abrir a lista toda
    const tiny = path.join(tmp, 'tiny.mp4');
    h.makeSampleVideo(tools.ffmpeg, tiny, { seconds: 1, size: '160x90', rate: 10 });
    for (let i = 1; i <= 48; i++) {
      const file = path.join(rec2, `2026-08-${String(i % 28 + 1).padStart(2, '0')} ${String(10 + Math.floor(i / 28)).padStart(2, '0')}-${String(i).padStart(2, '0')}-00.mp4`);
      fs.copyFileSync(tiny, file);
      fs.utimesSync(file, old, old);
    }
    fs.writeFileSync(path.join(rec1, 'anotacoes.txt'), 'não é vídeo');

    process.env.BF_FAKE_NODE = process.execPath;
    const ytBin = path.join(tmp, 'bin-yt');
    const tdlBin = path.join(tmp, 'bin-tdl');
    const fakeYt = fakes.makeFakeYtdlp(ytBin);
    const fakeTdl = fakes.makeFakeTwitchDownloader(tdlBin);
    const sample = path.join(tmp, 'amostra-vod.mp4');
    h.makeSampleVideo(tools.ffmpeg, sample, { seconds: 4, size: '320x180', rate: 10 });
    const replay = JSON.parse(fs.readFileSync(path.join(FIX, 'ytdlp-youtube-zoo.json'), 'utf8'));
    replay.live_status = 'was_live';
    replay.subtitles = { live_chat: [{ ext: 'json' }] };
    fs.writeFileSync(path.join(ytBin, 'replay.json'), JSON.stringify(replay));
    const ytScenario = (s) => fakes.fakeScenario(ytBin, { metaFile: path.join(ytBin, 'replay.json'), sampleFile: sample, liveChatFile: path.join(FIX, 'youtube-live-chat.jsonl'), steps: 10, stepMs: 120, ...s });
    const tdlScenario = (s) => fakes.fakeScenario(tdlBin, { chatFile: path.join(FIX, 'twitchdownloader-chat.json'), ...s });
    const calls = () => fs.readFileSync(path.join(ytBin, 'calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    ytScenario({});
    tdlScenario({});

    const vods = path.join(tmp, 'VODs');
    const baseEnv = { APPDATA: appData, BF_FAKE_NODE: process.execPath, BF_TEST_TOOL_ENTRIES: '', NODE_ENV: '' };
    const noYtPath = pathWithout(['yt-dlp.exe', 'yt-dlp']);

    // ================== 0) OBS não instalado: explica e deixa escolher a pasta ==================
    {
      const emptyAppData = path.join(tmp, 'Roaming-vazio');
      fs.mkdirSync(emptyAppData, { recursive: true });
      const app = await launch(path.join(tmp, 'ud0'), { env: { ...baseEnv, APPDATA: emptyAppData, ...envWithPath(noYtPath), CORTE_YTDLP: '' } });
      const { page } = app;
      await showSources(page, 'obs');
      await waitFor(page, `/Não encontrei a configuração do OBS/.test(${q('[data-section="obs"]')}.textContent)`, 15000, 'aviso de OBS não encontrado');
      const obsText = await text(page, '[data-section="obs"]');
      assert.match(obsText, /Escolha a pasta onde as suas gravações ficam/);
      assert.match(obsText, /modo portátil/, 'a mensagem lista as causas possíveis');
      assert.ok(await has(page, 'button[data-act="obs-pick"]'), 'o botão de escolher a pasta está lá');
      assert.equal(await has(page, 'li.src-file'), false, 'nada de lista inventada');
      // pasta escolhida à mão (o diálogo nativo é testado no IPC; aqui entra pela mesma configuração que ele grava)
      await page.eval(`BF.api('sources:setSettings', { obsFolder: ${JSON.stringify(rec2)} })`);
      await page.eval('BF.sources.refresh()');
      await waitFor(page, `${qa('li.src-file')}.length === 6`, 30000, 'lista da pasta escolhida à mão');
      assert.match(await text(page, '.src-folder'), /escolhida por você/);
      assert.doesNotMatch(await text(page, '[data-section="obs"]'), /Não encontrei a configuração do OBS/);
      // pasta escolhida que sumiu depois: erro explicado, sem travar
      await page.eval(`BF.api('sources:obsList', { folder: ${JSON.stringify(path.join(tmp, 'sumiu'))} }).then((r) => { window.__missing = r; })`);
      assert.match(await page.eval('window.__missing.error'), /A pasta não existe/);
      h.assertNoConsoleErrors(page);
      await app.stop();
      step('OBS não instalado: mensagem com as causas, botão de escolher a pasta e lista da pasta escolhida à mão');
    }

    // ================== 0b) perfil do OBS apontando para uma rede fora do ar: o app inteiro segue respondendo ==================
    {
      // endereço de documentação (RFC 5737), diferente a cada execução: o Windows guarda por ~2 min o erro de um endereço já tentado
      const share = `//192.0.2.${2 + Math.floor(Math.random() * 252)}/gravacoes`;
      const netAppData = path.join(tmp, 'Roaming-rede');
      const netObs = path.join(netAppData, 'obs-studio');
      for (const [name, folder] of [['Live', share], ['Local', rec1.replace(/\\/g, '/')]]) {
        fs.mkdirSync(path.join(netObs, 'basic', 'profiles', name), { recursive: true });
        fs.writeFileSync(path.join(netObs, 'basic', 'profiles', name, 'basic.ini'), `[General]\nName=${name}\n[Output]\nMode=Simple\n[SimpleOutput]\nFilePath=${folder}\n`);
      }
      fs.writeFileSync(path.join(netObs, 'user.ini'), '[Basic]\nProfile=Live\nProfileDir=Live\n');
      const app = await launch(path.join(tmp, 'ud0b'), { env: { ...baseEnv, APPDATA: netAppData, ...envWithPath(pathWithout(['yt-dlp.exe', 'yt-dlp'])), CORTE_YTDLP: '' } });
      const { page } = app;
      // antes: statSync na pasta da rede parava o processo principal ~21 s e QUALQUER chamada (app:info, a fila, a exportação) esperava junto
      const detecting = page.eval("BF.api('sources:obsDetect')");
      await sleep(200);
      const t0 = Date.now();
      const info = await page.eval("BF.api('app:info')");
      const infoMs = Date.now() - t0;
      assert.equal(info.ok, true);
      assert.ok(infoMs < 1500, `app:info demorou ${infoMs} ms enquanto a pasta de rede era conferida`);
      const det = await detecting;
      assert.equal(det.ok, true);
      const live = det.profiles.find((p) => p.name === 'Live');
      assert.ok(live.exists === null || live.exists === false, 'a pasta da rede não vira "existe"');
      assert.equal(det.selected, path.normalize(rec1), 'a pasta local que responde é a escolhida');
      await showSources(page, 'obs');
      await waitFor(page, `${qa('li.src-file')}.length === 2`, 25000, 'as duas gravações da pasta local (a gravação ao vivo só é criada na etapa seguinte)');
      if (live.exists === null) {
        const shown = await text(page, '[data-section="obs"]');
        assert.match(shown, /Live: Não consegui acessar a pasta de gravação/);
        assert.match(await page.eval(`${qa('select[data-act="obs-folder"] option')}.map((o) => o.textContent).join('|')`), /não consegui acessar/);
      }
      h.assertNoConsoleErrors(page);
      await app.stop(); // com a leitura da rede ainda pendurada no sistema
      step(`OBS com perfil em rede fora do ar: app:info respondeu em ${infoMs} ms durante a conferência e a pasta local foi escolhida`);
    }

    // ================== 0c) a tela Novo projeto: a pergunta, os quatro cartões, a área de soltar e um painel por vez ==================
    {
      const clip = path.join(tmp, 'solto.mp4');
      const clip2 = path.join(tmp, 'solto-2.mp4');
      h.makeSampleVideo(tools.ffmpeg, clip, { seconds: 3, size: '320x180', rate: 10 });
      fs.copyFileSync(clip, clip2);
      const notVideo = path.join(tmp, 'anotacoes-soltas.txt');
      fs.writeFileSync(notVideo, 'isto não é um vídeo');
      const app = await launch(path.join(tmp, 'ud0c'), { env: { ...baseEnv, ...envWithPath(noYtPath), CORTE_YTDLP: '', CORTE_TWITCHDOWNLOADER: '' } });
      const { page } = app;
      assert.equal(await page.eval("document.getElementById('app').classList.contains('no-project')"), true);
      const cardIds = () => page.eval(`${qa('.src-choice')}.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.source)`);
      const shown = () => page.eval(`${qa('[data-section]')}.filter((s) => ['files', 'vod', 'obs'].includes(s.dataset.section) && s.getClientRects().length > 0).map((s) => s.dataset.section)`);
      const vodTitle = () => text(page, '[data-section="vod"] h2');
      const activeTab = () => page.eval("document.getElementById('app').dataset.activeTab");
      const zoneLook = () => page.eval(`(() => { const s = getComputedStyle(${q('.src-drop')}); return [s.borderTopColor, s.backgroundColor]; })()`);

      // ---- a tela: a pergunta, os quatro cartões lado a lado e a área de soltar
      await showSources(page);
      assert.equal(await page.eval("document.getElementById('pageTitle').textContent"), 'Novo projeto');
      assert.equal(await text(page, '.src-question'), 'Como deseja adicionar o seu vídeo?');
      const cards = await page.eval(`${qa('.src-choice')}.map((b) => { const r = b.getBoundingClientRect(); const i = b.querySelector('.material-symbols-rounded'); return { id: b.dataset.source, title: b.querySelector('strong').textContent, hint: b.querySelector('.muted').textContent, icon: i.textContent, iconW: Math.round(i.getBoundingClientRect().width), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), pressed: b.getAttribute('aria-pressed') }; })`);
      assert.deepEqual(cards.map((c) => [c.id, c.title, c.hint, c.icon, c.pressed]), [
        ['files', 'Arquivos locais', 'Do seu computador', 'video_file', 'true'],
        ['youtube', 'YouTube', 'Link de um vídeo ou live', 'smart_display', 'false'],
        ['twitch', 'Twitch', 'Link de um VOD', 'live_tv', 'false'],
        ['obs', 'Gravações do OBS', 'Da pasta de gravações', 'videocam', 'false']
      ]);
      assert.equal(new Set(cards.map((c) => c.top)).size, 1, 'os quatro cartões ficam lado a lado');
      assert.ok(cards.every((c) => c.w >= 150 && c.h >= 100), `cartões do tamanho de um botão grande: ${JSON.stringify(cards)}`);
      assert.ok(cards.every((c) => c.iconW >= 18 && c.iconW <= 44), `ícones desenhados pela fonte (e não o nome como texto): ${JSON.stringify(cards.map((c) => c.iconW))}`);
      const area = await page.eval(`(() => { const b = ${q('.src-drop')}; const r = b.getBoundingClientRect(); const i = b.querySelector('.src-drop-icon'); return { tag: b.tagName, w: Math.round(r.width), h: Math.round(r.height), border: getComputedStyle(b).borderTopStyle, text: b.textContent, iconW: Math.round(i.getBoundingClientRect().width) }; })()`);
      assert.equal(area.tag, 'BUTTON', 'a área de soltar é um botão (teclado e leitor de tela)');
      assert.equal(area.border, 'dashed');
      assert.ok(area.w >= 500 && area.h >= 180, `área de soltar grande: ${area.w}x${area.h}`);
      assert.ok(area.iconW >= 36, 'o ícone de enviar é desenhado pela fonte');
      assert.match(area.text, /Arraste e solte o vídeo aqui/);
      assert.match(area.text, /ou clique para escolher o arquivo/);
      assert.match(area.text, /MP4, MKV, MOV, WebM, AVI, FLV ou TS/);
      assert.deepEqual(await shown(), ['files'], 'só o painel de Arquivos locais à vista');
      assert.equal(await page.eval(`${q('details.src-advanced')}.open`), false, 'o Avançado vem recolhido');
      assert.equal(await has(page, '[data-section="chat"]:not([hidden])'), false, 'sem projeto não há a seção do chat');
      await sleep(300); // a troca de cartão tem transição: a captura espera ela acabar
      await shot(page, 'novo-projeto-arquivos');
      step('Novo projeto: a pergunta, os quatro cartões lado a lado e a área de soltar grande de borda tracejada; Avançado recolhido e nada do chat sem projeto');

      // ---- cada cartão mostra só o seu painel; Enter no cartão em foco também escolhe, e o foco fica nele
      await page.eval(`${q('.src-choice[data-source="youtube"]')}.focus()`);
      await page.press('Enter');
      assert.deepEqual([await cardIds(), await shown()], [['youtube'], ['vod']]);
      assert.equal(await page.eval('document.activeElement.dataset.source'), 'youtube', 'o foco continua no cartão escolhido');
      await page.eval('document.activeElement.blur(); true'); // as capturas seguintes mostram a tela como com o mouse, sem o anel de foco do teclado
      assert.equal(await vodTitle(), 'Vídeo do YouTube');
      assert.equal(await page.eval(`${q('.src-url')}.placeholder`), 'https://www.youtube.com/watch?v=…');
      assert.match(await text(page, '[data-section="vod"] .src-lead'), /Playlists não são aceitas/);
      assert.equal(await page.eval(`${q('[data-section="vod"] .src-head-icon .material-symbols-rounded')}.textContent`), 'smart_display');
      await sleep(300); // a troca de cartão tem transição: a captura espera ela acabar
      await shot(page, 'novo-projeto-youtube');
      await click(page, '.src-choice[data-source="twitch"]');
      assert.deepEqual([await cardIds(), await shown()], [['twitch'], ['vod']]);
      assert.equal(await vodTitle(), 'VOD da Twitch');
      assert.equal(await page.eval(`${q('.src-url')}.placeholder`), 'https://www.twitch.tv/videos/…');
      assert.match(await text(page, '[data-section="vod"] .src-lead'), /Clipes e transmissões ao vivo não são aceitos/);
      assert.equal(await page.eval(`${q('[data-section="vod"] .src-head-icon .material-symbols-rounded')}.textContent`), 'live_tv');
      await sleep(300); // a troca de cartão tem transição: a captura espera ela acabar
      await shot(page, 'novo-projeto-twitch');
      await click(page, '.src-choice[data-source="obs"]');
      assert.deepEqual([await cardIds(), await shown()], [['obs'], ['obs']]);
      await waitFor(page, `${qa('li.src-file')}.length === 2`, 25000, 'as duas gravações do perfil ativo no cartão do OBS');
      await sleep(300); // a troca de cartão tem transição: a captura espera ela acabar
      await shot(page, 'novo-projeto-obs');
      step('Novo projeto: YouTube, Twitch e OBS mostram cada um o seu painel (título, explicação e ícone próprios); o teclado escolhe o cartão');

      // ---- colar o link do outro site troca o cartão (o painel do link é um só); um endereço de outro lugar não mexe em nada
      await click(page, '.src-choice[data-source="youtube"]');
      await setUrl(page, TW_URL);
      assert.deepEqual([await cardIds(), await vodTitle()], [['twitch'], 'VOD da Twitch'], 'o link da Twitch no cartão do YouTube leva ao cartão da Twitch');
      await setUrl(page, YT_URL);
      assert.deepEqual([await cardIds(), await vodTitle()], [['youtube'], 'Vídeo do YouTube'], 'e o do YouTube leva de volta');
      await setUrl(page, 'https://exemplo.com.br/video');
      assert.deepEqual(await cardIds(), ['youtube'], 'um endereço de outro lugar deixa o cartão como está');
      await setUrl(page, '');
      step('Novo projeto: colar o link do outro site troca o cartão sozinho');

      // ---- a escolha fica guardada: recarregada a janela, o app abre no mesmo cartão
      await click(page, '.src-choice[data-source="twitch"]');
      await page.eval('window.__marker = 1; true');
      await page.send('Page.reload');
      await waitFor(page, "window.__marker === undefined && document.readyState === 'complete' && !!window.BF", 30000, 'janela recarregada');
      await page.eval('BF.ready.then(() => true)');
      await showSources(page);
      assert.deepEqual([await cardIds(), await shown(), await vodTitle()], [['twitch'], ['vod'], 'VOD da Twitch'], 'o cartão escolhido volta depois de recarregar');
      step('Novo projeto: o cartão escolhido é lembrado');

      // ---- janela estreita (o app também abre num painel estreito dentro do BDS): dois cartões por linha e nada fora da tela
      await click(page, '.src-choice[data-source="files"]');
      const narrow = await page.send('Emulation.setDeviceMetricsOverride', { width: 680, height: 820, deviceScaleFactor: 1, mobile: false });
      assert.ok(!narrow.error, `Emulation.setDeviceMetricsOverride: ${narrow.error && narrow.error.message}`);
      try {
        await sleep(400);
        const tops = await page.eval(`${qa('.src-choice')}.map((b) => Math.round(b.getBoundingClientRect().top))`);
        assert.equal(new Set(tops).size, 2, `dois cartões por linha na janela estreita: ${tops}`);
        const fits = await page.eval(`(() => { const root = ${q('.sources')}; const zone = ${q('.src-drop')}.getBoundingClientRect(); const box = root.getBoundingClientRect(); return { rootFits: root.scrollWidth <= root.clientWidth + 1, zoneInside: zone.left >= box.left - 1 && zone.right <= box.right + 1, pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth }; })()`);
        assert.deepEqual(fits, { rootFits: true, zoneInside: true, pageFits: true }, 'nada passa da largura da janela estreita');
        await shot(page, 'novo-projeto-estreito');
      } finally {
        await page.send('Emulation.clearDeviceMetricsOverride');
      }
      await sleep(300);
      step('Novo projeto: em janela estreita os cartões ficam dois por linha, sem rolagem horizontal');

      // ---- tema claro
      await page.eval("BF.ui.setTheme('light')");
      await sleep(200);
      await shot(page, 'novo-projeto-claro');
      assert.notEqual(await page.eval(`getComputedStyle(${q('.src-choice[aria-pressed="true"]')}).backgroundColor`), await page.eval(`getComputedStyle(${q('.src-choice[aria-pressed="false"]')}).backgroundColor`), 'no tema claro o cartão escolhido também se destaca');
      await page.eval("BF.ui.setTheme('dark')");

      // ---- arrastar e soltar de verdade (arquivo real; a janela inteira é a área de soltar)
      const drag = (type, files) => page.send('Input.dispatchDragEvent', { type, x: 600, y: 420, data: { items: [], files, dragOperationsMask: 1 } });
      const dragOver = async (files) => {
        const entered = await drag('dragEnter', files);
        assert.ok(!entered.error, `Input.dispatchDragEvent: ${entered.error && entered.error.message}`);
        await drag('dragOver', files);
      };
      const dragging = () => page.eval("document.getElementById('app').classList.contains('drag')");
      const lookKey = async () => JSON.stringify(await zoneLook());
      // o aspecto de repouso é medido antes de qualquer evento de arrastar (depois deles o ponteiro fica parado sobre a área, que também a acende)
      const resting = await lookKey();
      // um arquivo que não é vídeo: a janela acende, o aviso aparece ao soltar e a tela continua onde está, sem projeto nenhum
      await dragOver([notVideo]);
      assert.equal(await dragging(), true, 'a janela marca que há um arquivo sobre ela');
      await waitFor(page, `JSON.stringify((() => { const s = getComputedStyle(${q('.src-drop')}); return [s.borderTopColor, s.backgroundColor]; })()) !== ${JSON.stringify(resting)}`, 5000, 'a área de soltar acende com o arquivo sobre a janela');
      await drag('drop', [notVideo]);
      await waitFor(page, "document.getElementById('toasts').textContent.trim().length > 0", 20000, 'aviso de que o arquivo não abre');
      assert.equal(await page.eval('BF.state.project'), null, 'um arquivo que não é vídeo não abre projeto nenhum');
      assert.equal(await activeTab(), 'sources', 'e a tela continua em Novo projeto');
      assert.equal(await dragging(), false, 'soltou: o destaque da janela some');
      // dois vídeos: o primeiro abre e o segundo não some em silêncio
      await dragOver([clip, clip2]);
      assert.equal(await dragging(), true);
      await drag('drop', [clip, clip2]);
      await waitFor(page, `BF.state.project && BF.state.project.source.path.toLowerCase() === ${JSON.stringify(clip.toLowerCase())}`, 30000, 'o primeiro vídeo solto abre como projeto');
      assert.equal(await dragging(), false, 'soltou: o destaque some');
      assert.equal(await activeTab(), 'cuts', 'abriu o vídeo estando em Novo projeto: segue para Cortes');
      assert.match(await page.eval("document.getElementById('toasts').textContent"), /abri só o primeiro \(1 ficou de fora\)/);
      step('Novo projeto: soltar na janela acende a área; arquivo que não é vídeo avisa sem sair da tela; dois vídeos abrem o primeiro, avisam do outro e seguem para Cortes');

      // ---- escolher o arquivo pelo botão: o diálogo do sistema não dá para acionar daqui, então a resposta dele entra pela chamada que o botão usa
      await page.eval(`(() => { const real = BF.api; window.__realApi = real; window.__pick = { ok: true, path: ${JSON.stringify(clip2)} }; BF.api = (channel, payload, opts) => (channel === 'source:pick' ? Promise.resolve(window.__pick) : real.call(BF, channel, payload, opts)); })()`);
      await click(page, '.src-choice[data-source="files"]');
      await click(page, '.src-drop');
      await waitFor(page, `BF.state.project && BF.state.project.source.path.toLowerCase() === ${JSON.stringify(clip2.toLowerCase())}`, 30000, 'o arquivo escolhido abre como projeto');
      assert.equal(await activeTab(), 'cuts', 'escolher o arquivo em Novo projeto também segue para Cortes');
      await showSources(page);
      await page.eval('window.__pick = { ok: true, canceled: true }');
      await click(page, '.src-drop');
      await sleep(600);
      assert.equal(await activeTab(), 'sources', 'cancelar o diálogo não tira ninguém da tela');
      assert.match(await page.eval('BF.state.project.source.path'), /solto-2/, 'nem troca o projeto');
      await page.eval('BF.api = window.__realApi; delete window.__realApi; delete window.__pick;');
      h.assertNoConsoleErrors(page);
      await app.stop();
      step('Novo projeto: escolher o arquivo pelo botão abre o projeto e segue para Cortes; cancelar o diálogo não muda nada');
    }

    // ================== 1) sem yt-dlp, sem projeto: OBS ==================
    {
      // o "yt-dlp oficial" desta etapa é o programa falso empacotado num zip e servido por HTTP local (entrada de TESTE do catálogo,
      // que só vale com NODE_ENV=test); o ToolInstaller baixa, confere tamanho e SHA-256 e instala de verdade
      const pkg = makeZip([
        { name: 'yt-dlp.exe', data: fs.readFileSync(fakeYt) },
        { name: 'yt-dlp.js', data: fs.readFileSync(path.join(ytBin, 'yt-dlp.js')) },
        { name: 'scenario.json', data: JSON.stringify({ metaFile: path.join(ytBin, 'replay.json'), sampleFile: sample, steps: 5, stepMs: 60, version: '9.9.9' }) }
      ]);
      toolServer = await startServer((req, res) => {
        if (req.url === '/yt-dlp.zip') { res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': pkg.length }); res.end(pkg); } else { res.writeHead(404); res.end(); }
      });
      const testEntry = { ...makeEntry({ base: toolServer.base, buf: pkg, id: 'ytdlp', version: '9.9.9', file: 'yt-dlp.zip', exe: 'yt-dlp.exe', key: `${process.platform}-${process.arch}` }), label: 'yt-dlp (teste)' };
      const app = await launch(path.join(tmp, 'ud1'), { env: { ...baseEnv, ...envWithPath(noYtPath), CORTE_YTDLP: '', CORTE_TWITCHDOWNLOADER: '', NODE_ENV: 'test', BF_TEST_TOOL_ENTRIES: JSON.stringify([testEntry]) } });
      const { page } = app;
      assert.equal(await page.eval("document.getElementById('app').classList.contains('no-project')"), true);
      assert.equal(await page.eval("document.getElementById('tab-projects').disabled"), false, 'a tela Novo projeto (do item Projetos) funciona sem projeto');
      assert.equal(await page.eval('BF.state.tools.ytdlp'), null, 'yt-dlp realmente ausente neste cenário');

      // gravação de verdade: o ffmpeg escreve um .mkv enquanto o app lista (como o OBS faz)
      const live = path.join(rec1, '2026-10-21 05-00-00.mkv');
      recorder = spawn(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '120', '-c:v', 'libx264', '-preset', 'ultrafast', '-flush_packets', '1', '-f', 'matroska', live], { stdio: 'ignore', windowsHide: true });
      // espera o arquivo ser legível (como no OBS, que escreve o cabeçalho na hora): só então a interface é testada
      const readable = () => { try { execFileSync(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', live], { stdio: 'pipe', windowsHide: true }); return true; } catch { return false; } };
      for (let i = 0; i < 60 && !readable(); i++) await sleep(500);
      assert.ok(readable(), 'a gravação de teste precisa estar legível');

      await showSources(page, 'obs');
      await waitFor(page, `${qa('li.src-file')}.length === 3`, 25000, 'três gravações do perfil ativo (mkv, mp4 e a em gravação)');
      const rows = await page.eval(`${qa('li.src-file')}.map((li) => ({ name: li.querySelector('.src-name').textContent, dur: li.querySelector('.src-dur').textContent, rec: li.classList.contains('recording') }))`);
      assert.deepEqual(rows.map((r) => r.name.replace(/gravando$/, '')), ['2026-10-21 05-00-00.mkv', '2026-10-20 21-00-00.mkv', '2026-10-19 18-30-00.mp4'], 'da mais recente para a mais antiga, sem o .txt');
      assert.equal(rows[0].rec, true);
      assert.equal(rows[0].dur, '—', 'sem duração enquanto grava');
      assert.deepEqual([rows[1].dur, rows[2].dur], ['0:05', '0:07'], 'duração lida pelo ffprobe');
      assert.match(await text(page, '.src-folder'), new RegExp(rec1.replace(/[\\.]/g, '\\$&')), 'pasta vinda da configuração do OBS');
      assert.match(await text(page, '.src-folder'), /Perfil Gameplay \(ativo\)/);
      assert.match(await text(page, '[data-section="obs"]'), /O OBS está gravando agora/, 'aviso (não bloqueio) de arquivo em gravação');
      assert.ok(await has(page, 'span.src-tag.rec'));
      const days = await page.eval(`${qa('h3.src-day')}.map((n) => n.textContent)`);
      assert.ok(days.length >= 2, `agrupado por dia: ${days}`);
      await shot(page, 'sources-obs');
      step('OBS: pasta lida do basic.ini/user.ini, gravações por dia com duração real e a em gravação marcada com aviso');

      // as duas pastas dos perfis aparecem num seletor
      const options = await page.eval(`${qa('select[data-act="obs-folder"] option')}.map((o) => o.textContent)`);
      assert.equal(options.length, 2);
      assert.match(options[0], /Gameplay.*\(ativo\)/);
      assert.match(options[1], /Série e Anime/);
      await selectOption(page, 'select[data-act="obs-folder"]', rec2);
      await waitFor(page, `${qa('li.src-file')}.length === 6 && /2026-10-18/.test(${q('li.src-file .src-name')}.textContent)`, 30000, 'lista da segunda pasta (só as 6 mais recentes)');
      assert.match(await text(page, 'button[data-act="obs-more"]'), /Mostrar todas \(49\)/);
      assert.equal(await page.eval(`${qa('li.src-file .src-dur')}.some((n) => n.textContent === '…')`), false, 'as 6 primeiras já têm duração');
      await click(page, 'button[data-act="obs-more"]');
      await waitFor(page, `${qa('li.src-file')}.length === 49`, 20000, 'lista toda aberta');
      await waitFor(page, `${qa('li.src-file .src-dur')}.every((n) => /^\\d+:\\d\\d$/.test(n.textContent))`, 30000, 'durações pendentes completadas pelo ffprobe');
      assert.ok((await page.eval(`${qa('li.src-file .src-dur')}.filter((n) => n.textContent === '0:01').length`)) >= 45, 'os arquivos de 1 s mostram 0:01');
      assert.match(await text(page, 'button[data-act="obs-more"]'), /Mostrar só as mais recentes/);
      await selectOption(page, 'select[data-act="obs-folder"]', rec1);
      await waitFor(page, `${qa('li.src-file')}.length === 3`, 20000, 'volta à primeira pasta');
      step('OBS: vários perfis, pasta escolhida no seletor');

      // abrir uma gravação pronta: projeto com origin obs; a aba vai para Cortes
      await page.eval(`${qa('li.src-file')}.find((li) => /21-00-00/.test(li.textContent)).querySelector('button').click()`);
      await waitFor(page, 'BF.state.project && /21-00-00/.test(BF.state.project.source.path)', 30000, 'projeto aberto');
      const origin = await page.eval('BF.state.project.source.origin');
      assert.deepEqual(origin, { type: 'obs' });
      assert.ok(Math.abs((await page.eval('BF.state.info.duration')) - 5) < 0.6);
      assert.equal(await page.eval("document.getElementById('tab-cuts').getAttribute('aria-selected')"), 'true');
      await showSources(page);
      await waitFor(page, `/1 corte|0 cortes|Gravações do OBS não têm chat/.test(${q('[data-section="chat"]')}.textContent)`, 10000, 'seção do chat do projeto');
      assert.match(await text(page, '[data-section="chat"]'), /Gravações do OBS não têm chat para baixar/, 'honesto: sem chat em gravação do OBS');
      step('OBS: "Abrir" cria o projeto com origin {type:"obs"} e vai para a aba Cortes');

      // arquivo em gravação: pergunta antes (aviso, não bloqueio)
      await page.eval(`${qa('li.src-file')}.find((li) => li.classList.contains('recording')).querySelector('button').click()`);
      const modal = await answerModal(page, false);
      assert.match(modal.title, /ainda está em andamento/);
      assert.match(modal.message, /incompleto/);
      assert.match(await page.eval('BF.state.project.source.path'), /21-00-00/, 'cancelar não troca de projeto');
      await page.eval(`${qa('li.src-file')}.find((li) => li.classList.contains('recording')).querySelector('button').click()`);
      await answerModal(page, true);
      await waitFor(page, "BF.state.project && /05-00-00/.test(BF.state.project.source.path)", 30000, 'gravação em andamento aberta depois da confirmação');
      assert.deepEqual(await page.eval('BF.state.project.source.origin'), { type: 'obs' });
      step('OBS: gravação em andamento pede confirmação e abre se o usuário insistir');
      recorder.kill();
      await waitProc(recorder);

      // sem yt-dlp: explicação e atalho
      await showSources(page, 'youtube');
      const vodText = await text(page, '[data-section="vod"]');
      assert.match(vodText, /O yt-dlp \(programa que baixa os vídeos\) não está instalado/);
      assert.match(vodText, /tamanho e SHA-256 conferidos/);
      assert.match(vodText, /depende de acesso, permissões e disponibilidade da fonte/, 'o aviso de dependência da fonte está visível');
      assert.equal(await page.eval(`${q(act('fetch'))}.disabled`), true, 'ação desabilitada sem a ferramenta');
      await click(page, 'button[data-act="tools"]');
      assert.equal(await page.eval("document.getElementById('tab-tools').getAttribute('aria-selected')"), 'true', 'o atalho leva à aba Ferramentas');
      await showSources(page, 'youtube');
      await page.eval(`${q('details.src-advanced')}.open = true`);
      assert.match(await text(page, 'details.src-advanced'), /yt-dlp: não instalado/);
      assert.match(await text(page, 'details.src-advanced'), /cookies do navegador/);
      assert.match(await text(page, 'details.src-advanced'), /não guarda nem copia esses cookies/, 'explicação de privacidade');
      step('sem yt-dlp: mensagem clara, "Buscar" desabilitado e atalho para Ferramentas; Avançado explica os cookies');

      // instalar pela aba Ferramentas: a tela Novo projeto se liga sozinha (ctx.tools.ytdlp) e o programa instalado funciona
      const installed = await page.eval("BF.api('tools:install', { id: 'ytdlp' })");
      assert.equal(installed.ok, true, JSON.stringify(installed));
      await waitFor(page, `!${q(act('fetch'))}.disabled`, 15000, 'Buscar habilitado depois de instalar o yt-dlp');
      assert.equal(await page.eval('BF.state.tools.ytdlp === ' + JSON.stringify(installed.path)), true, 'o caminho é o da instalação do app');
      assert.doesNotMatch(await text(page, '[data-section="vod"]'), /não está instalado/);
      assert.match(await text(page, 'details.src-advanced'), /yt-dlp: versão 9\.9\.9/);
      await setUrl(page, YT_URL);
      await click(page, act('fetch'));
      await waitFor(page, `${q('.src-card .src-title')} && ${q(act('download'))}`, 20000, 'consulta com o yt-dlp instalado pelo app');
      assert.equal(await text(page, '.src-card .src-title'), 'Me at the zoo');
      // remover pela aba Ferramentas: a aba volta a explicar que falta o yt-dlp
      const removed = await page.eval("BF.api('tools:remove', { id: 'ytdlp' })");
      assert.equal(removed.ok, true);
      await waitFor(page, `${q(act('fetch'))}.disabled`, 15000, 'Buscar desabilitado depois de remover');
      await waitFor(page, `/não está instalado/.test(${q('[data-section="vod"]')}.textContent)`, 15000, 'aviso de volta');
      step('instalar/remover o yt-dlp pela aba Ferramentas liga e desliga a tela Novo projeto (ToolInstaller + ctx.tools)');
      h.assertNoConsoleErrors(page);
      await app.stop();
    }

    // ================== 2) yt-dlp falso, sem TwitchDownloaderCLI ==================
    const ud2 = path.join(tmp, 'ud2');
    {
      const app = await launch(ud2, { env: { ...baseEnv, ...envWithPath(pathWithout(['yt-dlp.exe', 'yt-dlp', 'TwitchDownloaderCLI.exe'])), CORTE_YTDLP: fakeYt, CORTE_TWITCHDOWNLOADER: '' } });
      const { page } = app;
      const settings = await page.eval(`BF.api('sources:setSettings', { downloadDir: ${JSON.stringify(vods)} })`);
      assert.equal(settings.ok, true);
      await showSources(page, 'youtube');
      await page.eval('BF.sources.refresh()');
      await waitFor(page, `!${q(act('fetch'))}.disabled`, 15000, 'Buscar habilitado com o yt-dlp');

      // erros da fonte em português, com causa, solução e "depende de acesso"
      ytScenario({ metaStderr: "ERROR: [youtube] jNQXAC9IVRw: Private video. Sign in if you've been granted access to this video", metaCode: 1 });
      await setUrl(page, YT_URL);
      await click(page, act('fetch'));
      await waitFor(page, `!!${q('.src-card.bad')}`, 15000, 'erro mostrado');
      let err = await text(page, '.src-card.bad');
      assert.match(err, /O vídeo é privado/);
      assert.match(err, /Em Avançado, ligue "Usar cookies do navegador"/, 'a solução vem junto');
      assert.match(err, /depende de acesso, permissões ou disponibilidade da fonte/);
      assert.ok(await has(page, '.src-card.bad details.src-tech'), 'detalhe técnico recolhido');
      assert.equal(await page.eval(`${q('.src-card.bad details.src-tech')}.open`), false);
      assert.doesNotMatch(err, /\bnull\b|undefined|ERROR:/);
      ytScenario({ metaStderr: 'ERROR: [youtube] jNQXAC9IVRw: Unable to download webpage: Failed to resolve \'www.youtube.com\' ([Errno 11001] getaddrinfo failed)', metaCode: 1 });
      await click(page, act('retry'));
      await waitFor(page, `/Sem conexão com o servidor/.test(${q('.src-card.bad')} ? ${q('.src-card.bad')}.textContent : '')`, 15000, 'erro de rede');
      assert.doesNotMatch(await text(page, '.src-card.bad'), /depende de acesso/, 'erro de rede não é culpa da fonte');
      await page.eval("document.querySelector('#tabpanel-sources [data-section=\"vod\"]').scrollIntoView()"); await shot(page, 'sources-erro');
      step('erros da fonte: privado (depende de acesso) e sem rede, em português, com solução');

      // YouTube com replay de chat: metadados, qualidades, download com progresso
      ytScenario({});
      await click(page, act('retry'));
      await waitFor(page, `${q('.src-card .src-title')} && ${q(act('download'))}`, 15000, 'cartão do vídeo');
      assert.equal(await text(page, '.src-card .src-title'), 'Me at the zoo');
      const meta = await text(page, '.src-card .muted');
      assert.match(meta, /jawed/);
      assert.match(meta, /0:19/);
      assert.match(meta, /24\/04\/2005/);
      const qualities = await page.eval(`${qa('select[data-act="quality"] option')}.map((o) => o.textContent)`);
      assert.match(qualities[0], /^Melhor disponível \(240p\)/);
      assert.match(qualities[1], /^144p/);
      assert.equal(await page.eval(`${q('input[data-act="with-chat"]')}.checked`), true, 'o replay do chat está listado: marcado por padrão');
      assert.equal(await page.eval(`${q('input[data-act="with-chat"]')}.disabled`), false);
      assert.match(await text(page, '.src-card'), new RegExp(vods.replace(/[\\.]/g, '\\$&')), 'mostra onde vai salvar');
      await page.eval("document.querySelector('#tabpanel-sources [data-section=\"vod\"]').scrollIntoView()"); await shot(page, 'sources-vod-pronto');

      ytScenario({ steps: 24, stepMs: 150, mergeMs: 1500 }); // fase de junção longa: a amostragem da interface a vê mesmo com o computador ocupado
      await clickDownload(page);
      const early = await watchProgress(page, (s) => !s.gone && s.value !== null && s.value >= 30);
      await page.eval("document.querySelector('#tabpanel-sources [data-section=\"vod\"]').scrollIntoView()");
      await shot(page, 'sources-vod-baixando');
      const samples = [...early, ...(await watchProgress(page, (s) => s.finished))];
      const values = samples.filter((s) => !s.gone && s.value !== null).map((s) => s.value);
      assert.ok(values.length >= 3, `barra com percentual: ${values}`);
      for (let i = 1; i < values.length; i++) assert.ok(values[i] >= values[i - 1], `a barra recuou: ${values}`);
      assert.ok(values[values.length - 1] > 50, 'a barra chega perto do fim');
      assert.ok(samples.some((s) => !s.gone && /%.*MB|%.*KB|%.*B/.test(s.text)), 'texto com percentual e bytes');
      assert.ok(samples.some((s) => !s.gone && s.phase === 'merge'), 'mostra a junção de vídeo e áudio');
      assert.ok(samples.some((s) => !s.gone && s.phase === 'chat'), 'mostra o download do chat');
      const done = await text(page, '.src-card.ok');
      assert.match(done, /Download concluído/);
      assert.match(done, /Chat baixado: 6 mensagens/);
      const savedPath = path.join(vods, 'Me at the zoo.mp4');
      assert.ok(fs.existsSync(savedPath), 'arquivo salvo com título e código no nome');
      assert.deepEqual(fs.readdirSync(vods), ['Me at the zoo.mp4'], 'sem pasta de trabalho nem .part');
      assert.equal(await page.eval("document.querySelector('#tab-projects .tab-badge').hidden"), true, 'o selo "…" (que sobe de Novo projeto para o item Projetos) some');
      await page.eval("document.querySelector('#tabpanel-sources [data-section=\"vod\"]').scrollIntoView()"); await shot(page, 'sources-vod-concluido');
      step('YouTube (replay de chat): metadados, barra de progresso real, junção, chat e arquivo salvo com nome único');

      // abrir como projeto: origem, canal e chat preenchidos
      await click(page, act('open-vod'));
      await waitFor(page, 'BF.state.project && /Me at the zoo/.test(BF.state.project.source.path)', 30000, 'projeto do VOD aberto');
      await waitFor(page, 'BF.state.project.chat && BF.state.project.meta.channel', 10000, 'chat e canal anexados pelo gancho');
      const project = await page.eval('JSON.parse(JSON.stringify(BF.state.project))');
      assert.equal(project.source.origin.type, 'vod');
      assert.equal(project.source.origin.platform, 'youtube');
      assert.equal(project.source.origin.videoId, 'jNQXAC9IVRw');
      assert.equal(project.source.origin.url, YT_URL);
      assert.equal(project.source.origin.channel, 'jawed');
      assert.equal(project.source.origin.title, 'Me at the zoo');
      assert.equal(project.source.origin.uploadDate, '2005-04-24');
      assert.ok(project.source.origin.fetchedAt);
      assert.equal(project.meta.channel, 'jawed');
      assert.equal(project.meta.game, '', 'a categoria genérica do YouTube não vira jogo');
      assert.equal(project.chat.format, 'bf-chat-1');
      assert.equal(project.chat.count, 6);
      assert.equal(project.chat.platform, 'youtube');
      assert.ok(fs.existsSync(project.chat.path));
      const chatJson = JSON.parse(fs.readFileSync(project.chat.path, 'utf8'));
      assert.equal(chatJson.format, 'bf-chat-1');
      assert.equal(chatJson.messages[0].text, 'oi pessoal');
      await page.eval('BF.project.flush()');
      await showSources(page);
      await waitFor(page, `/Chat anexado: 6 mensagens/.test(${q('[data-section="chat"]')}.textContent)`, 10000, 'chat anexado mostrado');
      step('"Abrir como projeto": origin {type:"vod"…} completo, meta.channel e project.chat preenchidos');

      // cancelar e retomar; o segundo download do mesmo vídeo nunca sobrescreve o primeiro
      ytScenario({ steps: 40, stepMs: 200, liveChatWarn: true });
      await setUrl(page, YT_URL);
      await click(page, act('fetch'));
      await waitFor(page, `${q(act('download'))}`, 15000, 'cartão do vídeo de novo');
      await page.eval(`(() => { const c = ${q('input[data-act="with-chat"]')}; c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await clickDownload(page);
      await watchProgress(page, (s) => !s.gone && s.value !== null && s.value >= 15);
      await click(page, act('cancel'));
      await waitFor(page, `${q(act('download'))} && /Retomar download/.test(${q(act('download'))}.textContent)`, 20000, 'botão de retomar depois de cancelar');
      const afterCancel = await text(page, '[data-section="vod"]');
      assert.match(afterCancel, /Download cancelado\. O que já foi baixado ficou guardado/);
      assert.match(afterCancel, /KB guardados\./, 'diz quanto ficou guardado');
      assert.ok(await has(page, 'button[data-act="discard"]'));
      assert.equal(fs.readdirSync(vods).length, 2, 'o arquivo anterior + a pasta de trabalho com o .part');
      const work = fs.readdirSync(vods).find((n) => n.startsWith('.bf-vod-'));
      assert.ok(fs.readdirSync(path.join(vods, work)).some((n) => n.endsWith('.part')), 'o .part ficou guardado');
      await page.eval("document.querySelector('#tabpanel-sources [data-section=\"vod\"]').scrollIntoView()"); await shot(page, 'sources-cancelado');
      ytScenario({ steps: 12, stepMs: 100, liveChatWarn: true });
      await click(page, act('download')); // vídeo pequeno: sem confirmação, e a amostragem precisa começar já
      const resumed = await watchProgress(page, (s) => s.finished);
      assert.ok(resumed.some((s) => !s.gone && /Retomado|Retomando/.test(s.text)), 'a interface diz que está retomando');
      assert.match(await text(page, '.src-card.ok'), /retomado de um download anterior/);
      const second = path.join(vods, 'Me at the zoo (2).mp4');
      assert.ok(fs.existsSync(second), 'segundo download com nome único');
      assert.ok(fs.existsSync(savedPath), 'o primeiro continua lá');
      assert.deepEqual(fs.readdirSync(vods).sort(), ['Me at the zoo (2).mp4', 'Me at the zoo.mp4']);
      step('cancelar guarda o .part, "Retomar download" continua de onde parou, nome único e nada sobrescrito');

      // chat depois: projeto do VOD sem chat -> "Baixar chat"
      ytScenario({});
      await click(page, act('open-vod'));
      await waitFor(page, "BF.state.project && /\\(2\\)/.test(BF.state.project.source.path)", 30000, 'segundo VOD aberto');
      assert.equal(await page.eval('BF.state.project.chat'), null);
      await showSources(page);
      await waitFor(page, `!!${q('button[data-act="download-chat"]')}`, 10000, 'botão de baixar o chat');
      assert.match(await text(page, '[data-section="chat"]'), /Este projeto vem de um VOD e ainda não tem o chat/);
      await click(page, 'button[data-act="download-chat"]');
      await waitFor(page, 'BF.state.project.chat && BF.state.project.chat.count === 6', 30000, 'chat anexado depois');
      await waitFor(page, `/Chat anexado: 6 mensagens/.test(${q('[data-section="chat"]')}.textContent) && !${q('button[data-act="download-chat"]')}`, 10000, 'seção atualizada');
      step('chat baixado depois, para um projeto aberto sem chat');

      // Twitch sem TwitchDownloaderCLI: explicado, caixa desabilitada
      fakes.fakeScenario(ytBin, { metaFile: path.join(FIX, 'ytdlp-twitch-vod.json'), sampleFile: sample, steps: 5, stepMs: 80 });
      await setUrl(page, TW_URL);
      assert.equal(await page.eval(`${q('.src-choice[aria-pressed="true"]')}.dataset.source`), 'twitch', 'colar o link da Twitch no cartão do YouTube leva ao cartão da Twitch');
      assert.equal(await text(page, '[data-section="vod"] h2'), 'VOD da Twitch');
      await click(page, act('fetch'));
      await waitFor(page, `${q(act('download'))}`, 15000, 'cartão do VOD da Twitch');
      await page.eval("document.querySelector('#tabpanel-sources [data-section=\"vod\"]').scrollIntoView()"); await shot(page, 'sources-twitch-pronto');
      const tw = await text(page, '.src-card');
      assert.match(tw, /Live de teste - maratona/);
      assert.match(tw, /Canal de Teste · Minecraft · 2:00:00 · 20\/10\/2026/);
      assert.equal(await page.eval(`${q('input[data-act="with-chat"]')}.disabled`), true);
      assert.equal(await page.eval(`${q('input[data-act="with-chat"]')}.checked`), false);
      assert.match(tw, /instale o TwitchDownloaderCLI na aba Ferramentas/);
      assert.ok(await has(page, 'button[data-act="tools-chat"]'));
      const tqs = await page.eval(`${qa('select[data-act="quality"] option')}.map((o) => o.textContent.replace(/ · ~.*/, ''))`);
      assert.deepEqual(tqs, ['Melhor disponível (1080p60)', '720p60', '480p', '360p', '160p']);
      step('Twitch sem TwitchDownloaderCLI: o app diz por que o chat está desabilitado e aponta a aba Ferramentas');

      // Avançado: cookies do navegador, persistidos e entregues ao yt-dlp
      await page.eval(`${q('details.src-advanced')}.open = true`);
      await selectOption(page, 'select[data-act="cookies"]', 'firefox');
      await waitFor(page, "BF.api('sources:state').then((s) => s.settings.cookiesBrowser === 'firefox')", 10000, 'cookies salvos');
      await click(page, act('fetch'));
      await waitFor(page, `${q(act('download'))}`, 15000, 'consulta com cookies');
      const lastMeta = calls().filter((c) => c.includes('-J')).pop();
      assert.equal(lastMeta[lastMeta.indexOf('--cookies-from-browser') + 1], 'firefox');
      assert.equal(lastMeta[lastMeta.length - 1], TW_URL);
      assert.equal(lastMeta[lastMeta.length - 2], '--');
      h.assertNoConsoleErrors(page);
      await app.stop();
      step('Avançado: cookies do navegador escolhidos, salvos e passados ao yt-dlp (só quando ligados)');
    }

    // ================== 2b) teclado, consulta cancelável, chat com troca de aba e aviso de espaço (achados da revisão cruzada) ==================
    {
      const vods2 = path.join(tmp, 'VODs-2b');
      const app = await launch(path.join(tmp, 'ud2b'), { env: { ...baseEnv, ...envWithPath(pathWithout(['yt-dlp.exe', 'yt-dlp', 'TwitchDownloaderCLI.exe'])), CORTE_YTDLP: fakeYt, CORTE_TWITCHDOWNLOADER: '' } });
      const { page } = app;
      assert.equal((await page.eval(`BF.api('sources:setSettings', { downloadDir: ${JSON.stringify(vods2)} })`)).ok, true);
      await showSources(page, 'youtube');
      await page.eval('BF.sources.refresh()');
      await waitFor(page, `!${q(act('fetch'))}.disabled`, 15000, 'Buscar habilitado');
      const activeIs = (sel) => page.eval(`document.activeElement === document.querySelector('${PANEL} ${sel}')`);
      const inVod = () => page.eval(`!!document.activeElement && !!document.activeElement.closest('${PANEL} [data-section="vod"]')`);
      const fakeProcs = () => h.processesUsing(path.join(ytBin, 'yt-dlp.js'));
      const waitFakeStarted = async (before) => {
        for (let i = 0; i < 200 && calls().length <= before; i++) await sleep(50);
        assert.ok(calls().length > before, 'o yt-dlp falso começou a consulta');
      };

      // --- teclado: Enter no campo do link não manda o foco para o topo da página (antes o campo era desabilitado durante a consulta)
      ytScenario({ delayBeforeMetaMs: 1500 });
      await setUrl(page, YT_URL);
      await page.eval(`${q('.src-url')}.focus()`);
      await page.press('Enter');
      await waitFor(page, `/Consultando o vídeo/.test(${q('[data-section="vod"]')}.textContent)`, 10000, 'consulta começou');
      assert.equal(await activeIs('.src-url'), true, 'durante a consulta o foco continua no campo do link');
      assert.equal(await page.eval(`${q('.src-url')}.readOnly`), true, 'somente leitura (e não desabilitado)');
      await waitFor(page, `!!${q(act('download'))}`, 20000, 'cartão do vídeo');
      assert.equal(await activeIs('.src-url'), true, 'depois da consulta o foco continua no campo');
      assert.equal(await page.eval(`${q('.src-url')}.readOnly`), false);

      // --- teclado: Baixar (Enter) leva o foco para a barra de progresso e, ao concluir, para o resultado — nunca para o topo
      ytScenario({ steps: 10, stepMs: 150 });
      await page.eval(`(() => { const c = ${q('input[data-act="with-chat"]')}; c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await page.eval(`${q(act('download'))}.focus()`);
      await page.press('Enter');
      await waitFor(page, `!!${q('.src-progress')}`, 15000, 'download começou');
      assert.equal(await inVod(), true, 'depois de Baixar o foco continua na seção do VOD');
      assert.equal(await page.eval('document.activeElement.dataset.focus'), 'stage', 'pousa na barra de progresso (sem ação), não em "Cancelar"');
      await waitFor(page, `!!${q('.src-card.ok')}`, 60000, 'download concluído');
      assert.equal(await inVod(), true, 'ao concluir o foco fica no resultado');
      assert.equal(await page.eval('document.activeElement.dataset.focus'), 'stage');
      step('teclado: Enter no link e em Baixar não mandam o foco para o topo da página (campo somente leitura; foco no progresso e no resultado)');

      // --- chat baixando + troca de aba: a seção do VOD não pode ficar presa em "Download em andamento"
      await click(page, act('open-vod'));
      await waitFor(page, 'BF.state.project && /Me at the zoo/.test(BF.state.project.source.path)', 30000, 'projeto do VOD aberto');
      assert.equal(await page.eval('BF.state.project.chat'), null);
      await showSources(page);
      await waitFor(page, `!!${q('button[data-act="download-chat"]')}`, 10000, 'botão de baixar o chat');
      ytScenario({ chatStepMs: 3500 });
      await click(page, 'button[data-act="download-chat"]');
      await waitFor(page, 'BF.sources.state.chat.busy === true', 5000, 'chat baixando');
      await page.eval("BF.ui.selectTab('cuts')");
      await page.eval("BF.ui.selectTab('sources')"); // onShow -> refresh -> sources:state devolve o job de chat
      await page.eval('BF.sources.refresh()');
      assert.equal(await page.eval('BF.sources.state.chat.busy'), true, 'o chat segue baixando');
      assert.notEqual(await page.eval('BF.sources.state.vod.stage'), 'running', 'o job de chat não vira "Download em andamento"');
      assert.equal(await has(page, '[data-section="vod"] .src-progress'), false, 'nenhuma barra de download de vídeo na seção do VOD');
      await waitFor(page, 'BF.state.project.chat && BF.state.project.chat.count === 6', 30000, 'chat anexado');
      await sleep(400);
      assert.notEqual(await page.eval('BF.sources.state.vod.stage'), 'running', 'antes: ficava "running" para sempre');
      assert.equal(await page.eval(`${q('.src-url')}.readOnly`), false, 'o campo do link volta a aceitar texto');
      assert.equal(await page.eval(`${q(act('fetch'))}.disabled`), false);
      assert.equal(await page.eval("document.querySelector('#tab-projects .tab-badge').hidden"), true, 'o selo "…" do item Projetos some');
      step('chat baixando + troca de aba: a seção do VOD não fica presa em "Download em andamento"');

      // --- gravações do OBS: o redesenho da lista devolve o foco à MESMA linha (antes: sempre à primeira)
      await showSources(page, 'obs'); // o painel precisa estar à vista para receber o foco
      await waitFor(page, `${qa('li.src-file')}.length >= 3`, 20000, 'lista do OBS');
      const rowKey = await page.eval(`(() => { const b = ${qa('li.src-file button[data-act="open-recording"]')}[2]; window.__row = b; b.focus(); return b.dataset.key; })()`);
      assert.ok(rowKey, 'cada botão "Abrir" tem a chave da sua linha');
      await page.eval('BF.sources.refresh()'); // redesenha a lista, como a gravação em andamento faz a cada ~6 s
      await waitFor(page, `!window.__row.isConnected && document.activeElement && document.activeElement.dataset.key === ${JSON.stringify(rowKey)}`, 20000, 'foco de volta à mesma linha depois do redesenho');
      step('OBS: o foco continua na linha escolhida depois que a lista é redesenhada');

      // --- pasta de gravação que não respondeu (rede fora do ar): a aba explica em vez de dizer "não existe". O processo principal já foi
      // conferido nos testes do recurso (laço de eventos medido); aqui só o desenho, com a resposta de sources:obsDetect trocada na página.
      await page.eval(`(() => {
        const real = BF.api;
        window.__realApi = real;
        const share = '\\\\\\\\192.0.2.9\\\\gravacoes\\\\';
        BF.api = (channel, payload, opts) => (channel === 'sources:obsDetect'
          ? Promise.resolve({ ok: true, found: true, obsDir: 'X', active: null, manual: null, manualExists: false, selected: null, selectedBy: null,
              profiles: [{ name: 'Live', dir: 'Live', active: true, mode: 'simple', key: 'SimpleOutput.FilePath', folder: share, exists: null, note: 'Não consegui acessar a pasta de gravação agora (compartilhamento de rede fora do ar, unidade desconectada ou sem permissão).' }],
              folders: [{ folder: share, profile: 'Live', active: true, mode: 'simple', exists: null }] })
          : real.call(BF, channel, payload, opts));
      })()`);
      await page.eval('BF.sources.refresh()');
      await waitFor(page, `/Não consegui acessar \\\\\\\\192\\.0\\.2\\.9/.test(${q('[data-section="obs"]')}.textContent)`, 15000, 'aviso de pasta sem resposta');
      const silent = await text(page, '[data-section="obs"]');
      assert.match(silent, /compartilhamento de rede pode estar fora do ar/);
      assert.match(silent, /Live: Não consegui acessar a pasta de gravação agora/);
      assert.doesNotMatch(silent, /não existe neste computador/, 'rede fora do ar não é "a pasta não existe"');
      assert.equal(await has(page, 'li.src-file'), false);
      await page.eval('BF.api = window.__realApi; delete window.__realApi;');
      await page.eval('BF.sources.refresh()');
      await waitFor(page, `${qa('li.src-file')}.length >= 3`, 20000, 'lista do OBS de volta');
      step('OBS: pasta que não respondeu aparece como "não consegui acessar" (rede fora do ar), não como "não existe"');

      // --- aviso de espaço livre ANTES de baixar (e só aviso: o botão continua habilitado)
      await showSources(page, 'youtube');
      const free = await freeBytes(vods2);
      const sized = (bytes) => {
        const info = JSON.parse(fs.readFileSync(path.join(ytBin, 'replay.json'), 'utf8'));
        for (const f of info.formats) { f.filesize = f.vcodec !== 'none' ? bytes : 0; delete f.filesize_approx; }
        fs.writeFileSync(path.join(ytBin, 'sized.json'), JSON.stringify(info));
        ytScenario({ metaFile: path.join(ytBin, 'sized.json') });
      };
      await click(page, act('another'));
      sized(Math.floor(free / 1.5));
      await setUrl(page, YT_URL);
      await click(page, act('fetch'));
      await waitFor(page, `/Pouco espaço livre em/.test(${q('[data-section="vod"]')}.textContent)`, 20000, 'aviso de pouco espaço no cartão do vídeo');
      assert.ok(await has(page, '.src-card .src-note.warn'), 'aviso, não bloqueio');
      assert.equal(await page.eval(`${q(act('download'))}.disabled`), false, 'o download continua permitido');
      assert.match(await text(page, '.src-card'), new RegExp(vods2.replace(/[\\.]/g, '\\$&')), 'o aviso cita a pasta de destino');
      sized(free * 2);
      await click(page, act('fetch'));
      await waitFor(page, `/Não há espaço suficiente em/.test(${q('[data-section="vod"]')}.textContent)`, 20000, 'aviso de que não cabe');
      assert.ok(await has(page, '.src-card .src-note.error'));
      assert.equal(await page.eval(`${q(act('download'))}.disabled`), false, 'quem recusa é o download, com a mesma mensagem');
      const advance = await text(page, '.src-card .src-note.error');
      await click(page, act('download'));
      // vídeo grande (> 5 GB): o app pede confirmação antes; recusar não baixa nada e volta ao cartão
      const big = await answerModal(page, false);
      assert.match(big.title, /Download grande/);
      assert.match(big.message, /cerca de .* GB|cerca de .* TB/);
      assert.equal(await page.eval(`${q(act('download'))}.disabled`), false, 'cancelar a confirmação mantém o botão Baixar');
      await click(page, act('download'));
      await answerModal(page, true);
      await waitFor(page, `!!${q('.src-card.bad')}`, 20000, 'download recusado');
      // o aviso de antes e a recusa dizem a mesma coisa (o espaço livre pode variar alguns MB entre as duas leituras: compara sem ele)
      const withoutFree = (s) => s.replace(/restam .*? (MB|GB)\./, 'restam X.');
      assert.equal(withoutFree(await text(page, '.src-card.bad')).includes(withoutFree(advance.trim())), true, 'o aviso de antes e a recusa dizem a mesma coisa');
      step('espaço livre: "Pouco espaço livre" aparece ao lado de "Salvar em" antes de baixar (sem bloquear); se não cabe, a recusa repete o aviso');

      // --- consulta cancelável pelo botão (antes: sem Cancelar durante "Consultando o vídeo…")
      ytScenario({ delayBeforeMetaMs: 40000 });
      const before = calls().length;
      await click(page, act('retry'));
      await waitFor(page, `!!${q(act('cancel-fetch'))}`, 10000, 'botão Cancelar da consulta');
      await waitFakeStarted(before);
      assert.ok(fakeProcs().length > 0, 'o yt-dlp da consulta está rodando');
      await click(page, act('cancel-fetch'));
      await waitFor(page, `/Consulta cancelada/.test(${q('[data-section="vod"]')}.textContent) && !${q('.src-url')}.readOnly`, 15000, 'consulta cancelada');
      assert.equal(await page.eval(`${q(act('fetch'))}.disabled`), false);
      for (let i = 0; i < 100 && fakeProcs().length; i++) await sleep(100);
      assert.deepEqual(fakeProcs(), [], 'o yt-dlp da consulta foi encerrado');
      step('consulta de metadados: botão Cancelar encerra o yt-dlp e libera o campo');

      // --- fechar o app no meio de uma consulta não deixa o yt-dlp órfão
      const before2 = calls().length;
      await click(page, act('fetch'));
      await waitFakeStarted(before2);
      assert.ok(fakeProcs().length > 0);
      h.assertNoConsoleErrors(page);
      await app.stop();
      for (let i = 0; i < 100 && fakeProcs().length; i++) await sleep(100);
      assert.deepEqual(fakeProcs(), [], 'nenhum yt-dlp ficou rodando depois de fechar o app');
      step('fechar o app durante uma consulta encerra o yt-dlp (sem processo órfão)');
    }

    // ================== 3) reinicia o app: configurações salvas, TwitchDownloaderCLI falso ==================
    {
      const app = await launch(ud2, { env: { ...baseEnv, ...envWithPath(pathWithout(['yt-dlp.exe', 'yt-dlp'])), CORTE_YTDLP: fakeYt, CORTE_TWITCHDOWNLOADER: fakeTdl } });
      const { page } = app;
      const state = await page.eval("BF.api('sources:state')");
      assert.equal(state.settings.downloadDir, vods, 'pasta de downloads lembrada');
      assert.equal(state.settings.cookiesBrowser, 'firefox', 'cookies lembrados');
      assert.equal(state.tools.twitchDownloader.found, true);
      await page.eval("BF.api('sources:setSettings', { cookiesBrowser: '' })");

      await showSources(page);
      assert.equal(await page.eval(`${q('.src-choice[aria-pressed="true"]')}.dataset.source`), 'twitch', 'a escolha do cartão (a Twitch, pelo link colado) foi lembrada ao reiniciar o app');
      assert.equal(await page.eval(`${q('[data-section="vod"]')}.getClientRects().length > 0`), true, 'e o painel do link já abre à vista');
      await page.eval('BF.sources.refresh()');
      await waitFor(page, `!${q(act('fetch'))}.disabled`, 15000, 'Buscar habilitado');
      fakes.fakeScenario(ytBin, { metaFile: path.join(FIX, 'ytdlp-twitch-vod.json'), sampleFile: sample, steps: 8, stepMs: 100 });
      tdlScenario({ stepMs: 500 }); // a fase do chat dura ~1,5 s: dá para a amostragem da interface vê-la mesmo com o computador ocupado
      await setUrl(page, TW_URL);
      await click(page, act('fetch'));
      await waitFor(page, `${q(act('download'))}`, 15000, 'cartão do VOD da Twitch');
      assert.equal(await page.eval(`${q('input[data-act="with-chat"]')}.disabled`), false, 'com a ferramenta o chat é oferecido');
      assert.equal(await page.eval(`${q('input[data-act="with-chat"]')}.checked`), true);
      await clickDownload(page);
      const tsamples = await watchProgress(page, (s) => s.finished);
      assert.ok(tsamples.some((s) => !s.gone && s.phase === 'chat' && /%|chat/i.test(s.text)));
      assert.match(await text(page, '.src-card.ok'), /Chat baixado: 5 mensagens/);
      const twPath = path.join(vods, 'Live de teste - maratona.mp4');
      assert.ok(fs.existsSync(twPath));

      // o usuário abre o arquivo por "Abrir vídeo…" (sem origem): o gancho reconhece o VOD baixado aqui
      const opened = await page.eval(`BF.openSource(${JSON.stringify(twPath)}).then((r) => r.ok)`);
      assert.equal(opened, true);
      await waitFor(page, 'BF.state.project && BF.state.project.chat', 15000, 'chat anexado ao reabrir');
      const p = await page.eval('JSON.parse(JSON.stringify(BF.state.project))');
      assert.equal(p.source.origin.type, 'vod');
      assert.equal(p.source.origin.platform, 'twitch');
      assert.equal(p.source.origin.videoId, '2345678901');
      assert.equal(p.source.origin.game, 'Minecraft');
      assert.equal(p.meta.game, 'Minecraft');
      assert.equal(p.meta.channel, 'Canal de Teste');
      assert.equal(p.chat.count, 5);
      assert.equal(p.chat.platform, 'twitch');
      // o usuário muda o jogo; ao reabrir, a escolha dele vale
      await page.eval("BF.project.update((pr) => { pr.meta.game = 'Outro jogo'; }, { reason: 'teste' }); BF.project.flush()");
      await page.eval(`BF.openSource(${JSON.stringify(sample)})`);
      await waitFor(page, `/amostra-vod/.test(BF.state.project.source.path)`, 15000, 'outro vídeo');
      await page.eval(`BF.openSource(${JSON.stringify(twPath)})`);
      await waitFor(page, `/maratona/.test(BF.state.project.source.path)`, 15000, 'VOD reaberto');
      await sleep(300);
      assert.equal(await page.eval('BF.state.project.meta.game'), 'Outro jogo', 'o que o usuário editou nunca é sobrescrito');
      step('Twitch: chat pelo TwitchDownloaderCLI; reabrir pelo "Abrir vídeo…" traz origem, jogo, canal e chat sem sobrescrever edições');

      // chat apagado: o app avisa e oferece baixar de novo
      const chatPath = await page.eval('BF.state.project.chat.path');
      fs.unlinkSync(chatPath);
      await page.eval('BF.sources.refresh()');
      await showSources(page);
      await waitFor(page, `/O arquivo do chat não foi encontrado/.test(${q('[data-section="chat"]')}.textContent)`, 10000, 'aviso de chat ausente');
      assert.ok(await has(page, 'button[data-act="download-chat"]'));
      await click(page, 'button[data-act="download-chat"]');
      await waitFor(page, `/Chat anexado: 5 mensagens/.test(${q('[data-section="chat"]')}.textContent)`, 30000, 'chat baixado de novo');
      assert.ok(fs.existsSync(chatPath), 'o mesmo arquivo foi recriado');

      // VOD que a Twitch já apagou: o vídeo é salvo e o chat explica
      tdlScenario({ stderr: 'Unhandled exception. System.AggregateException: One or more errors occurred. (Invalid VOD, deleted/expired VOD possibly?)', code: 127 });
      fs.unlinkSync(chatPath);
      await page.eval('BF.sources.refresh()');
      await waitFor(page, `/O arquivo do chat não foi encontrado/.test(${q('[data-section="chat"]')}.textContent)`, 10000, 'aviso de chat ausente de novo');
      await click(page, 'button[data-act="download-chat"]');
      await waitFor(page, `/apagado ou expirado/.test(${q('[data-section="chat"]')}.textContent)`, 30000, 'erro do chat explicado');
      assert.match(await text(page, '[data-section="chat"]'), /Isso depende de acesso, permissões ou disponibilidade da fonte/);
      h.assertNoConsoleErrors(page);
      await app.stop();
      step('chat apagado e VOD expirado: avisos claros em português, sem travar');
    }

    // ================== 4) rede real: yt-dlp do sistema + "Me at the zoo" ==================
    if (process.env.BF_E2E_OFFLINE === '1') {
      notVerified.push('rede real (BF_E2E_OFFLINE=1)');
    } else if (!findTool('yt-dlp', 'CORTE_YTDLP')) {
      notVerified.push('rede real: yt-dlp não encontrado no PATH');
    } else {
      const app = await launch(path.join(tmp, 'ud4'), { env: { ...baseEnv, CORTE_YTDLP: '', CORTE_TWITCHDOWNLOADER: '' } });
      const { page } = app;
      const netDir = path.join(tmp, 'VODs-rede');
      await page.eval(`BF.api('sources:setSettings', { downloadDir: ${JSON.stringify(netDir)} })`);
      await showSources(page, 'youtube');
      await page.eval('BF.sources.refresh()');
      await waitFor(page, `!${q(act('fetch'))}.disabled`, 15000, 'Buscar habilitado com o yt-dlp do sistema');
      let blocked = null;
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        await setUrl(page, YT_URL);
        await click(page, act('fetch'));
        await waitFor(page, `${q('.src-card .src-title')} || ${q('.src-card.bad')}`, 90000, 'resultado da consulta real');
        if (await has(page, '.src-card .src-title')) { ok = true; break; }
        blocked = await text(page, '.src-card.bad');
        await sleep(3000);
      }
      if (!ok) {
        // honestidade: a consulta real falhou. Só aceitamos se a mensagem for a explicação clara do bloqueio.
        assert.match(blocked, /robô|conexão|disponível|bloque/i, `falha inesperada na consulta real: ${blocked}`);
        report.net = `consulta real NÃO concluída (3 tentativas): ${blocked.replace(/\s+/g, ' ').slice(0, 200)}`;
        notVerified.push(`rede real: ${report.net}`);
      } else {
        assert.equal(await text(page, '.src-card .src-title'), 'Me at the zoo');
        assert.match(await text(page, '.src-card .muted'), /jawed · .*0:19 · 24\/04\/2005/);
        const qualities = await page.eval(`${qa('select[data-act="quality"] option')}.map((o) => o.value)`);
        assert.ok(qualities.length >= 2);
        const smallest = qualities[qualities.length - 1];
        await selectOption(page, 'select[data-act="quality"]', smallest);
        await page.eval(`(() => { const c = ${q('input[data-act="with-chat"]')}; if (c && !c.disabled) { c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
        let downloaded = false;
        for (let attempt = 1; attempt <= 2 && !downloaded; attempt++) {
          await clickDownload(page);
          await watchProgress(page, (s) => s.finished || s.failed, 180000);
          downloaded = await has(page, '.src-card.ok');
          if (!downloaded) { blocked = await text(page, '.src-card.bad'); await click(page, act('retry')); await waitFor(page, `${q(act('download'))}`, 90000, 'consulta de novo'); }
        }
        if (!downloaded) {
          report.net = `download real NÃO concluído: ${blocked.replace(/\s+/g, ' ').slice(0, 200)}`;
          notVerified.push(`rede real: ${report.net}`);
        } else {
          const file = path.join(netDir, 'Me at the zoo.mp4');
          assert.ok(fs.existsSync(file), 'arquivo baixado da rede real');
          const dur = Number(execFileSync(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8', windowsHide: true }).trim());
          assert.ok(Math.abs(dur - 19) < 2, `duração real ${dur}`);
          await click(page, act('open-vod'));
          await waitFor(page, 'BF.state.project && /Me at the zoo/.test(BF.state.project.source.path)', 30000, 'projeto do vídeo real');
          const o = await page.eval('BF.state.project.source.origin');
          assert.equal(o.type, 'vod');
          assert.equal(o.videoId, 'jNQXAC9IVRw');
          assert.equal(o.channel, 'jawed');
          assert.equal(await page.eval('BF.state.project.meta.channel'), 'jawed');
          assert.deepEqual(fs.readdirSync(netDir), ['Me at the zoo.mp4']);
          report.net = 'consulta e download reais concluídos (Me at the zoo)';
          step(`REDE REAL: ${report.net}`);
        }
      }
      h.assertNoConsoleErrors(page);
      await app.stop();
    }

    console.log('\nE2E da tela Novo projeto concluído.');
    for (const item of notVerified) console.log(`⚠ NÃO verificado: ${item}`);
  } finally {
    if (recorder && recorder.exitCode === null) { try { recorder.kill(); } catch { /* já saiu */ } }
    await h.cleanupAll();
    if (toolServer) await toolServer.close().catch(() => {});
    await sleep(500);
    h.removeDir(tmp);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

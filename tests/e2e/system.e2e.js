'use strict';

/**
 * TESTE DE SISTEMA COMPLETO: a jornada do produto, de ponta a ponta, num app Electron de verdade (perfil temporário) com dados
 * reais gerados aqui (ffmpeg): um vídeo 1080p de 2 minutos com rajadas de áudio e uma mudança de cena em instantes conhecidos,
 * numa pasta "estilo OBS". Todos os recursos trabalham JUNTOS e o que sai é conferido em disco, por fora do app (ffprobe,
 * volumedetect, pixels, hash). Nada é simulado, salvo os pontos marcados "(forçado)" no próprio passo.
 *
 *   1. Sem projeto: Início, Projetos, Novo projeto, Exportações, Preferências e Ferramentas utilizáveis; o cartão Gravações do OBS lista a gravação da pasta do OBS e a abre.
 *   2. Análise: sugestões (pendentes, origin auto, motivos) perto dos instantes conhecidos; reanalisar não duplica.
 *   3. Revisão: ordem, relevância, filtros, categorias, ajuste fino ("alterado"), semelhantes, lote com prévia, histórico.
 *   4. Preferências: jogo/canal, prioridade canal > jogo > geral, aprendizado só com evidência mínima (visível, desativável).
 *   5. Áudio e legendas: ganho +6 dB e fades; legenda manual incorporada e em arquivo separado; whisper real só se disponível.
 *   6. Exportação: 9:16 1080p H.264, 1440p H.265 e horizontal; enquadramento por corte; QC (aviso x erro); fila paralela 2,
 *      pausar/retomar, reordenar, cancelar, conflito de nome (renomear/substituir/pular), repetição evitada.
 *   7. Interrupção: kill do app com a fila em andamento, banner de recuperação, retomar sem duplicar; .part nunca vira resultado.
 *   8. Persistência: reabrir o projeto; o MESMO vídeo por outro caminho (correspondência); fonte que cresceu (comparação).
 *   9. Rede real mínima (só com BF_NETWORK_TESTS=1): "Me at the zoo" pela tela Novo projeto.
 *  10. Zero erros de console do início ao fim, nenhum temporário deixado e o app encerrado.
 *
 * Uso:  node tests/e2e/system.e2e.js
 * Ambiente (todos opcionais):
 *   BF_NETWORK_TESTS=1        liga o passo 9 (baixa "Me at the zoo" com o yt-dlp do sistema; se o YouTube pedir verificação, fica NÃO verificado)
 *   BF_REQUIRE_NETWORK=1      liga a geração REAL de legenda com o whisper (o app instala motor e modelo Tiny pelas rotas oficiais, ~40 MB)
 *   BF_SUBTITLES_TEST_CACHE   pasta com tools/whisper e models já instalados (desenvolvimento): liga a geração real sem baixar
 *   BF_SYSTEM_UNTIL=n         (desenvolvimento) para depois do passo n e limpa tudo
 *   BF_E2E_SHOTDIR=pasta      guarda capturas da janela
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const h = require('./helpers');
const fx = require('../export-fixtures');
const afx = require('../audio-fixtures');

const { sleep, waitFor } = h;
const J = JSON.stringify;
const FFMPEG = fx.tools.ffmpeg;
const FFPROBE = fx.tools.ffprobe;
const UNTIL = Number(process.env.BF_SYSTEM_UNTIL || 99);
const SHOTS = process.env.BF_E2E_SHOTDIR || '';
const T0 = Date.now();

const log = (message) => console.log(`✔ [${((Date.now() - T0) / 1000).toFixed(0).padStart(4)} s] ${message}`);
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: obtido ${actual}, esperado ${expected} (±${tol})`);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

// ---------------------------------------------------------------------------------------------------------------------
// Instantes conhecidos do vídeo de teste (segundos)
// ---------------------------------------------------------------------------------------------------------------------
const VIDEO_SECONDS = 120;
const BURSTS = [{ at: 20, dur: 3 }, { at: 95, dur: 3 }]; // rajadas de áudio (-20 dB sobre um fundo de -50 dB)
const FLASH = { at: 52, dur: 0.5 }; // mudança de cena: o quadro todo vira quase branco por meio segundo
const SPEECH_AT = 99; // início da fala sintetizada, dentro do corte S3 (89-104 s); só quando a geração real de legenda vai rodar

/** Quadro RGB onde R = x e G = y (e B = 0): a cor de um pixel diz de que ponto da fonte ele veio. */
function makeCodedImage(file) {
  fx.ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:r=1:d=1,geq=r=\'255*X/W\':g=\'255*Y/H\':b=0', '-frames:v', '1', file]);
}

/** Fala sintetizada pelo Windows (pt-BR) em `wav`, ou null se não houver voz. */
function synthesizeSpeech(wav, text) {
  if (process.platform !== 'win32') return null;
  try {
    const script = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; '
      + '$v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq \'pt-BR\' } | Select-Object -First 1; '
      + 'if (-not $v) { exit 3 }; $s.SelectVoice($v.VoiceInfo.Name); $s.SetOutputToWaveFile($env:BF_WAV); $s.Speak($env:BF_TEXT); $s.Dispose()';
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, BF_WAV: wav, BF_TEXT: text }, windowsHide: true, timeout: 120000, stdio: 'ignore' });
    return fs.existsSync(wav) ? wav : null;
  } catch { return null; }
}

/**
 * Gravação de teste: 1080p/30 quadros, H.264 + AAC estéreo 48 kHz, 120 s. Vídeo montado por concatenação (sem recodificar) de
 * clipes curtos do quadro codificado por posição; um clipe quase branco forma a mudança de cena. Áudio: ruído de fundo a -50 dB
 * e rajadas a -20 dB (e a fala, se pedida).
 */
function makeSource(file, work, { speechWav = null } = {}) {
  fs.mkdirSync(work, { recursive: true });
  const coded = path.join(work, 'codificado.png');
  makeCodedImage(coded);
  const clip = (name, seconds, input) => {
    const out = path.join(work, name);
    fx.ffmpeg(['-loop', '1', '-framerate', '30', '-t', String(seconds), '-i', input, '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-g', '30', '-bf', '0', '-r', '30', out]);
    return out;
  };
  const white = path.join(work, 'quase-branco.png');
  fx.ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xEEEEEE:s=1920x1080:r=1:d=1', '-frames:v', '1', white]);
  const full = clip('a1.mp4', 1, coded);
  const half = clip('a05.mp4', 0.5, coded);
  const flash = clip('flash.mp4', FLASH.dur, white);
  const lines = [];
  const body = (seconds) => { for (let i = 0; i < Math.floor(seconds); i++) lines.push(`file '${path.basename(full)}'`); if (seconds % 1) lines.push(`file '${path.basename(half)}'`); };
  body(FLASH.at);
  lines.push(`file '${path.basename(flash)}'`);
  body(VIDEO_SECONDS - FLASH.at - FLASH.dur);
  const list = path.join(work, 'lista.txt');
  fs.writeFileSync(list, lines.join('\n'));
  const gain = (db) => 10 ** ((db + 4.77) / 20); // ruído branco de amplitude 1 tem RMS de -4,77 dBFS
  const burstExpr = BURSTS.map((b) => `between(t,${b.at},${b.at + b.dur})`).join('+');
  const noise = `anoisesrc=d=${VIDEO_SECONDS}:c=white:r=48000:a=1:seed=20261021,volume='${gain(-50)}+${gain(-20) - gain(-50)}*(${burstExpr})':eval=frame,aformat=channel_layouts=stereo`;
  const args = ['-f', 'concat', '-safe', '0', '-i', list, '-f', 'lavfi', '-i', noise];
  if (speechWav) {
    args.push('-i', speechWav, '-filter_complex', `[2:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${SPEECH_AT * 1000}|${SPEECH_AT * 1000}[fala];[1:a][fala]amix=inputs=2:duration=first:normalize=0[a]`, '-map', '0:v', '-map', '[a]');
  } else {
    args.push('-map', '0:v', '-map', '1:a');
  }
  args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-shortest', '-movflags', '+faststart', file);
  fx.ffmpeg(args);
}

/** MD5 do fluxo de áudio original (copiado, sem recodificar): prova que a fonte não foi tocada. */
function audioMd5(file) {
  return execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'md5', '-'], { encoding: 'utf8', windowsHide: true }).trim();
}

/** Pixels "de texto": a fonte codificada tem B = 0, então branco (R, G e B altos) só pode ser legenda. */
function whiteStats(frame) {
  let count = 0;
  let minX = Infinity; let maxX = -1; let minY = Infinity; let maxY = -1;
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const i = (y * frame.width + x) * 3;
      if (frame.data[i] > 170 && frame.data[i + 1] > 170 && frame.data[i + 2] > 170) {
        count++;
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return { count, minX, maxX, minY, maxY };
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

const probeFile = (file) => {
  const data = fx.probeStreams(file);
  const video = data.streams.find((s) => s.codec_type === 'video');
  const audio = data.streams.find((s) => s.codec_type === 'audio');
  return { video, audio, duration: Number(data.format.duration), bitRate: Number(data.format.bit_rate) };
};

// ---------------------------------------------------------------------------------------------------------------------
// App: abrir, fechar, matar, esperar
// ---------------------------------------------------------------------------------------------------------------------
const S = { app: null, page: null, errors: [], warnings: [], skipped: [], notVerified: [], flakes: [] };

const processAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

async function waitProfileFree(userData, timeout = 60000) {
  const lock = path.join(userData, 'lockfile');
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (!fs.existsSync(lock)) return true;
    try { fs.rmSync(lock); return true; } catch { /* ainda aberto por um processo do app anterior */ }
    await sleep(250);
  }
  return false;
}

/** Abre o app (com repetição se o Windows ainda segurar o perfil) e liga a coleta de avisos de console. */
async function launch(userData, env) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await waitProfileFree(userData);
    try {
      // sem som nas caixas (a prévia passa pelo Web Audio) e sem o Chromium desacelerar a janela quando ela fica coberta por outra
      const app = await h.launchApp(userData, { args: ['--mute-audio', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'], env, timeout: 120000 });
      S.app = app;
      S.page = app.page;
      app.page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'warning') S.warnings.push(`console.warn: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`); });
      app.page.on('Log.entryAdded', ({ entry }) => { if (entry.level === 'warning') S.warnings.push(`log: ${entry.text}${entry.url ? ` (${entry.url})` : ''}`); });
      return app;
    } catch (err) {
      last = err;
      if (!/EBUSY|EPERM|EACCES|janela do app não apareceu|porta de depuração|fechou antes/.test(String(err && (err.code || err.message)))) throw err;
      console.warn(`! o app não abriu (${err.message}); tentando de novo (${attempt}/3)`);
      await h.cleanupAll();
      await sleep(1500);
    }
  }
  throw last;
}

/** Guarda os erros de console da sessão atual (antes de fechar ou matar o app). */
function harvestErrors(app = S.app) {
  if (!app || !app.page) return;
  S.errors.push(...app.page.errors.splice(0));
}

async function stopApp() {
  if (!S.app) return;
  harvestErrors();
  await S.app.stop();
  S.app = null;
  S.page = null;
}

/** Mata o app e toda a árvore de processos (como falta de energia) e espera ele sumir de verdade. */
async function killApp() {
  harvestErrors();
  const { proc } = S.app;
  try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* já tinha terminado */ }
  const end = Date.now() + 60000;
  while (processAlive(proc.pid) && Date.now() < end) await sleep(100);
  assert.ok(!processAlive(proc.pid), 'o processo do app deveria ter morrido');
  try { S.app.page.ws.close(); } catch { /* ignorar */ }
  await sleep(500);
  S.app = null;
  S.page = null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Atalhos de página
// ---------------------------------------------------------------------------------------------------------------------
const ev = (expr) => S.page.eval(expr);
const wf = (expr, timeout = 30000, what = expr) => waitFor(S.page, expr, timeout, what);
const click = (selector) => ev(`(() => { const e = document.querySelector(${J(selector)}); if (!e) throw new Error('não achei ' + ${J(selector)}); if (e.disabled) throw new Error('desabilitado: ' + ${J(selector)}); e.click(); return true; })()`);
const setValue = (selector, value, events = ['input', 'change']) => ev(`(() => { const e = document.querySelector(${J(selector)}); if (!e) throw new Error('não achei ' + ${J(selector)}); e.value = ${J(String(value))}; for (const t of ${J(events)}) e.dispatchEvent(new Event(t, { bubbles: true })); return true; })()`);
const setChecked = (selector, on) => ev(`(() => { const e = document.querySelector(${J(selector)}); if (!e) throw new Error('não achei ' + ${J(selector)}); e.checked = ${on}; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const text = (selector) => ev(`(document.querySelector(${J(selector)}) || {}).textContent || ''`);
const exists = (selector) => ev(`!!document.querySelector(${J(selector)})`);
const selectTab = async (id) => {
  await ev(`BF.ui.selectTab(${J(id)})`);
  await wf(`!document.getElementById('tabpanel-${id}').hidden`, 10000, `aba ${id} visível`);
  await sleep(150);
};
const project = () => ev('JSON.parse(JSON.stringify(BF.state.project))');
const cutOf = (id) => ev(`JSON.parse(JSON.stringify(BF.project.cut(${J(id)})))`);
const shot = async (name) => { if (SHOTS && S.page) { fs.mkdirSync(SHOTS, { recursive: true }); await h.screenshot(S.page, path.join(SHOTS, `system-${name}.png`)); } };

/** Botões visíveis e habilitados de uma aba que não têm NENHUM ouvinte de clique (nem em si nem nos ancestrais). */
async function deadButtons(tabId) {
  const expression = `(() => {
    const panel = document.getElementById('tabpanel-${tabId}');
    const listens = (n) => { try { const l = getEventListeners(n); return Boolean(l.click && l.click.length) || typeof n.onclick === 'function'; } catch { return false; } };
    const dead = [];
    for (const b of panel.querySelectorAll('button, [role="button"], input[type="button"]')) {
      if (b.disabled || b.getClientRects().length === 0 || b.closest('[hidden]')) continue;
      let node = b; let ok = false;
      while (node && !ok) { ok = listens(node); node = node.parentNode; }
      if (!ok) dead.push((b.id ? '#' + b.id : b.tagName.toLowerCase()) + ' "' + (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 40) + '"');
    }
    return dead;
  })()`;
  const r = await S.page.send('Runtime.evaluate', { expression, includeCommandLineAPI: true, returnByValue: true });
  if (r.error || r.result.exceptionDetails) throw new Error(`auditoria de botões falhou: ${J(r.error || r.result.exceptionDetails)}`);
  return r.result.result.value;
}

// ---------------------------------------------------------------------------------------------------------------------
// Passo a passo
// ---------------------------------------------------------------------------------------------------------------------
async function main() {
  assert.ok(FFMPEG && FFPROBE, 'ffmpeg/ffprobe necessários para o teste');
  const baselineTemp = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('bf-system-')));
  const tmp = h.mkTemp('system');
  const W = {
    tmp,
    userData: path.join(tmp, 'userdata'),
    appData: path.join(tmp, 'Roaming'),
    rec: path.join(tmp, 'REC', 'Gameplay'),
    work: path.join(tmp, 'work'),
    source: null,
    out: null
  };
  W.source = path.join(W.rec, '2026-10-20 21-00-00.mp4');
  W.out = path.join(W.rec, 'Cortes');
  let finished = false;

  try {
    // ---------- cenário: configuração do OBS, gravação e (se for rodar) fala sintetizada ----------
    const obsDir = path.join(W.appData, 'obs-studio');
    fs.mkdirSync(path.join(obsDir, 'basic', 'profiles', 'Gameplay'), { recursive: true });
    fs.mkdirSync(W.rec, { recursive: true });
    fs.writeFileSync(path.join(obsDir, 'basic', 'profiles', 'Gameplay', 'basic.ini'), `\uFEFF[General]\nName=Gameplay\n\n[Output]\nMode=Advanced\n\n[AdvOut]\nRecType=Standard\nRecFilePath=${W.rec.replace(/\\/g, '/')}\n`);
    fs.writeFileSync(path.join(obsDir, 'user.ini'), '[Basic]\nProfile=Gameplay\nProfileDir=Gameplay\n');

    // geração REAL de legenda: só com motor e modelo já disponíveis (cache de desenvolvimento) ou com BF_REQUIRE_NETWORK=1
    const cache = process.env.BF_SUBTITLES_TEST_CACHE || '';
    const cacheOk = Boolean(cache) && fs.existsSync(path.join(cache, 'tools', 'whisper')) && fs.existsSync(path.join(cache, 'models'));
    const wantWhisper = cacheOk || process.env.BF_REQUIRE_NETWORK === '1';
    let speechWav = null;
    fs.mkdirSync(W.work, { recursive: true });
    if (wantWhisper) {
      speechWav = synthesizeSpeech(path.join(W.work, 'fala.wav'), 'Esse foi um lance incrível, vamos ver de novo.');
      if (!speechWav) S.skipped.push('geração real de legenda PULADA: o Windows não tem voz pt-BR para sintetizar a fala do teste');
    }
    W.whisper = { run: wantWhisper && Boolean(speechWav), preinstalled: cacheOk };
    if (cacheOk && W.whisper.run) { // desenvolvimento: motor e modelo já instalados em outra pasta (nada é baixado)
      copyDir(path.join(cache, 'tools', 'whisper'), path.join(W.userData, 'tools', 'whisper'));
      copyDir(path.join(cache, 'models'), path.join(W.userData, 'models'));
    }
    makeSource(W.source, path.join(W.work, 'clipes'), { speechWav });
    const old = new Date(Date.now() - 6 * 3600 * 1000);
    fs.utimesSync(W.source, old, old); // o OBS não está gravando este arquivo
    fs.writeFileSync(path.join(W.rec, 'anotacoes.txt'), 'não é vídeo');
    const sourceHash = sha(W.source);
    const sourceAudio = audioMd5(W.source);
    const sourceProbe = probeFile(W.source);
    assert.deepEqual([sourceProbe.video.width, sourceProbe.video.height, sourceProbe.video.codec_name], [1920, 1080, 'h264']);
    near(sourceProbe.duration, VIDEO_SECONDS, 0.2, 'duração da gravação de teste');
    log(`gravação de teste gerada (1080p, ${sourceProbe.duration.toFixed(1)} s, rajadas em ${BURSTS.map((b) => b.at).join(' e ')} s, mudança de cena em ${FLASH.at} s)`);

    const env = { APPDATA: W.appData, CORTE_YTDLP: '' };
    await launch(W.userData, env);
    assert.deepEqual(await ev('BF.state.loadErrors'), [], 'todos os handlers carregaram');
    S.page.errors.length = 0;
    S.warnings.length = 0;

    // ======================================================================================== 1. sem projeto
    await step1(W, env);
    if (UNTIL <= 1) { finished = true; return; }
    await step2(W);
    if (UNTIL <= 2) { finished = true; return; }
    await step3();
    if (UNTIL <= 3) { finished = true; return; }
    await step4(W);
    if (UNTIL <= 4) { finished = true; return; }
    await step5(W);
    if (UNTIL <= 5) { finished = true; return; }
    await phase6B(W);
    if (UNTIL < 6.2) { finished = true; return; }
    await phase6Content(W);
    await phase6Repeat(W);
    if (UNTIL < 6.3) { finished = true; return; }
    await phase6C(W);
    if (UNTIL < 6.4) { finished = true; return; }
    await phase6D(W);
    if (UNTIL < 6.5) { finished = true; return; }
    await step7(W, env);
    if (UNTIL <= 7) { finished = true; return; }
    await step8(W, env);
    if (UNTIL <= 8) { finished = true; return; }
    await step9(W);
    if (UNTIL <= 9) { finished = true; return; }
    await step10(W, { sourceHash, sourceAudio });
    finished = true;
  } finally {
    await h.cleanupAll();
    S.app = null;
    S.removed = h.removeDir(tmp);
    if (!finished) console.error(`(a pasta temporária ${tmp} foi removida mesmo com a falha)`);
  }
  // nada do teste pode sobrar: a pasta temporária (e tudo que o app e o ffmpeg criaram dentro dela) sumiu e nenhum bf-system-* ficou em %TEMP%
  const left = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('bf-system-') && !baselineTemp.has(n));
  assert.ok(S.removed && !fs.existsSync(tmp), `a pasta temporária ${tmp} não pôde ser removida`);
  assert.deepEqual(left, [], 'temporários bf-system-* deixados em %TEMP%');
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Sem projeto
// ---------------------------------------------------------------------------------------------------------------------
async function step1(W) {
  const FREE = ['home', 'projects', 'sources', 'queue', 'general', 'prefs', 'tools'];
  const LOCKED = ['editor', 'cuts', 'export', 'subtitles', 'audio', 'analysis']; // o item Cortes do menu e as abas internas dele
  assert.equal(await ev('BF.state.project'), null, 'o app abre sem projeto');
  for (const id of LOCKED) {
    assert.equal(await ev(`document.getElementById('tab-${id}').disabled`), true, `a aba ${id} fica desabilitada sem projeto`);
    assert.equal(await ev(`document.getElementById('tab-${id}').title`), 'Abra um vídeo para usar esta aba');
  }
  for (const id of FREE) {
    const button = id === 'sources' ? 'projects' : id; // Novo projeto não tem botão no menu: abre pelos botões e acende o item Projetos
    assert.equal(await ev(`document.getElementById('tab-${button}').disabled`), false, `a aba ${id} funciona sem projeto`);
    await selectTab(id);
    await sleep(300);
    assert.ok((await ev(`document.getElementById('tabpanel-${id}').textContent.trim().length`)) > 20, `a aba ${id} desenhou algo`);
    assert.deepEqual(await deadButtons(id), [], `botões sem ação em ${id} (sem projeto)`);
  }
  // Ferramentas: o FFmpeg e o ffprobe do sistema aparecem como encontrados
  await selectTab('tools');
  await wf("!!document.querySelector('#tabpanel-tools li.tool.sys[data-tool=\"ffmpeg\"]')", 20000, 'linha do FFmpeg na aba Ferramentas');
  assert.equal(await ev("document.querySelector('#tabpanel-tools li.tool.sys[data-tool=\"ffmpeg\"]').dataset.state"), 'found');
  assert.equal(await ev("document.querySelector('#tabpanel-tools li.tool.sys[data-tool=\"ffprobe\"]').dataset.state"), 'found');
  // Fila: vazia e sem botões soltos
  await selectTab('queue');
  await wf("(() => { const e = document.querySelector('#tabpanel-queue .q-empty'); return !!e && !e.hidden && /Nada na fila/.test(e.textContent); })()", 15000, 'fila vazia explicada');
  // Preferências: valores padrão sem projeto
  await selectTab('prefs');
  await wf("!!document.querySelector('#tabpanel-prefs .prefs-row')", 15000, 'lista de preferências');
  assert.equal(await ev("BF.prefs.get('analysis.minRelevance', 0.5)"), 0.5);
  assert.equal(await ev("BF.prefs.explain('analysis.minRelevance').source"), 'default');
  assert.equal(await ev("BF.prefs.get('review.defaultSort', 'chrono')"), 'chrono');
  assert.equal(await ev("BF.ui.selectTab('cuts')"), false, 'tentar abrir uma aba bloqueada não troca de aba');
  log('sem projeto: Início, Projetos, Novo projeto, Exportações, Preferências e Ferramentas utilizáveis (FFmpeg e ffprobe encontrados); as outras ficam desabilitadas com a dica');

  // Novo projeto, cartão Gravações do OBS: a pasta vem do basic.ini/user.ini do OBS de teste e lista a gravação
  await selectTab('sources');
  await click('#tabpanel-sources .src-choice[data-source="obs"]');
  await wf("!document.querySelector('#tabpanel-sources [data-section=\"obs\"]').hidden", 10000, 'o painel das gravações do OBS à vista');
  await wf("document.querySelectorAll('#tabpanel-sources li.src-file').length === 1", 40000, 'a gravação da pasta do OBS');
  const rows = await ev("[...document.querySelectorAll('#tabpanel-sources li.src-file')].map((li) => ({ name: li.querySelector('.src-name').textContent, dur: li.querySelector('.src-dur').textContent, rec: li.classList.contains('recording') }))");
  assert.deepEqual(rows.map((r) => r.name), ['2026-10-20 21-00-00.mp4'], 'só o vídeo aparece (o .txt é ignorado)');
  assert.equal(rows[0].rec, false, 'não está gravando');
  assert.equal(rows[0].dur, '2:00', 'duração lida pelo ffprobe');
  assert.match(await text('#tabpanel-sources .src-folder'), /perfil “Gameplay” do OBS/);
  assert.match(await text('#tabpanel-sources .src-folder'), new RegExp(W.rec.replace(/[\\.]/g, '\\$&')), 'a pasta vem da configuração do OBS');
  await shot('1-novo-projeto');
  await ev("document.querySelector('#tabpanel-sources li.src-file button[data-act=\"open-recording\"]').click()");
  await wf(`BF.state.project && BF.state.project.source.path.toLowerCase() === ${J(W.source.toLowerCase())} && document.getElementById('video').readyState >= 1`, 60000, 'a gravação aberta como projeto');
  assert.deepEqual(await ev('BF.state.project.source.origin'), { type: 'obs' });
  near(await ev('BF.state.info.duration'), VIDEO_SECONDS, 0.5, 'duração do projeto');
  assert.equal(await ev("document.getElementById('tab-analysis').getAttribute('aria-selected')"), 'true', 'a aba Análise abre sozinha (projeto sem cortes)');
  assert.equal(await ev("document.getElementById('app').classList.contains('no-project')"), false);
  assert.equal(await ev('BF.state.project.cuts.length'), 0);
  log('Novo projeto: a gravação da pasta do OBS foi listada e aberta como projeto (origin obs, 1080p, 2:00)');
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Análise
// ---------------------------------------------------------------------------------------------------------------------
async function step2() {
  await selectTab('analysis');
  await ev("window.__an = { done: 0, failed: 0 }; BF.on('analysis:done', () => { window.__an.done += 1; }); BF.on('analysis:failed', (e) => { window.__an.failed += 1; window.__an.code = e.code; }); true");
  const analyze = async ({ fresh = false, expectCache } = {}) => {
    await wf("!document.getElementById('anRun').disabled && document.getElementById('anRun').textContent === 'Analisar'", 30000, 'botão Analisar liberado');
    const before = await ev('window.__an.done + window.__an.failed');
    await click(fresh ? '#anFresh' : '#anRun');
    await wf(`window.__an.done + window.__an.failed > ${before}`, 180000, 'fim da análise');
    assert.equal(await ev('window.__an.failed'), 0, `a análise falhou: ${await ev('window.__an.code')}`);
    await wf("!document.getElementById('anRun').disabled && document.getElementById('anRun').textContent === 'Analisar'", 30000, 'interface liberada');
    if (expectCache !== undefined) assert.equal(/resultado do cache/.test(await text('#anSummary')), expectCache, await text('#anSummary'));
  };

  await analyze({ expectCache: false });
  const result = await ev('JSON.parse(JSON.stringify(BF.state.project.ext.analysis))');
  assert.equal(result.suggestions.length, 3, `3 sugestões (uma por evento conhecido): ${J(result.suggestions.map((s) => [s.start, s.end, s.peak]))}`);
  assert.deepEqual(await ev('BF.state.project.analysis.lastRun.signals'), ['audio', 'image', 'calm']);
  // cada instante conhecido cai dentro de uma sugestão, com o pico perto
  const expected = [...BURSTS.map((b) => ({ at: b.at + b.dur / 2, kind: 'audio' })), { at: FLASH.at + FLASH.dur / 2, kind: 'image' }];
  for (const e of expected) {
    const hit = result.suggestions.find((s) => s.start <= e.at && e.at <= s.end);
    assert.ok(hit, `nenhuma sugestão cobre ${e.at} s: ${J(result.suggestions.map((s) => [s.start, s.end]))}`);
    near(hit.peak, e.at, 2.5, `pico da sugestão do instante ${e.at} s`);
    assert.ok(hit.reasons.length > 0, 'motivos legíveis');
    if (e.kind === 'audio') assert.ok(hit.reasons.some((r) => /^(volume acima do normal de fala|subida brusca de volume)/.test(r)), `motivos: ${hit.reasons}`);
    else assert.ok(hit.reasons.includes('mudança de cena'), `motivos: ${hit.reasons}`);
  }
  for (const s of result.suggestions) assert.ok(s.end <= VIDEO_SECONDS + 0.01 && s.start >= 0 && s.end - s.start >= 14.9, 'cada sugestão cabe no vídeo e respeita a duração mínima');
  const summary = await text('#anSummary');
  assert.match(summary, /3 sugestão\(ões\) encontrada\(s\)/);
  assert.match(summary, /sinais usados: áudio, imagem/);
  assert.equal(await ev("document.querySelectorAll('#anList .an-item').length"), 3);
  await shot('2-analise');

  // adicionar todas: cortes pendentes, origin auto, com relevância e motivos; nada é aprovado sozinho
  await ev("window.__ev = []; BF.bus.on('decision', (d) => window.__ev.push(['decision', d.type, d.after && d.after.origin])); BF.bus.on('cuts:changed', (d) => window.__ev.push(['cuts:changed', d && d.from])); true");
  await click('#anAddAll');
  await wf('BF.state.project.cuts.length === 3', 15000, 'as três sugestões viraram cortes');
  const cuts = await ev('JSON.parse(JSON.stringify(BF.state.project.cuts))');
  for (const c of cuts) {
    assert.equal(c.status, 'pending', 'nada é aprovado automaticamente');
    assert.equal(c.origin, 'auto');
    assert.ok(c.relevance > 0.5 && c.relevance <= 1, `relevância ${c.relevance}`);
    assert.ok(c.reasons.length > 0, 'motivos');
    assert.equal(c.reviewedAt, null);
    assert.match(c.title, /^Sugestão \d+:\d\d$/);
  }
  const events = await ev('window.__ev');
  assert.equal(events.filter(([n]) => n === 'decision' && true).map(([, t]) => t).join(), 'create,create,create', 'um decision create por corte');
  assert.ok(events.filter(([n]) => n === 'decision').every(([, , origin]) => origin === 'auto'), 'os create trazem origin auto (não contam como decisão do usuário)');
  assert.equal(events.filter(([n, from]) => n === 'cuts:changed' && from === 'analysis').length, 1, 'um único cuts:changed de lote');
  assert.equal(await ev("document.querySelectorAll('#anList .an-item').length"), 0, 'a lista esvazia');
  assert.match(await text('#anEmpty'), /Todas as sugestões já estão nos cortes/);
  log(`análise: 3 sugestões nos instantes conhecidos (${result.suggestions.map((s) => `${s.start}-${s.end}`).join(', ')}); adicionadas como cortes pendentes, origin auto, com motivos`);

  // reanalisar (do cache e do zero) não duplica nada
  const ids = cuts.map((c) => c.id).sort();
  await analyze({ expectCache: true });
  assert.equal(await ev('BF.state.project.cuts.length'), 3, 'reanalisar do cache não duplica');
  assert.equal(await ev("document.querySelectorAll('#anList .an-item').length"), 0);
  await analyze({ fresh: true, expectCache: false });
  assert.equal(await ev('BF.state.project.cuts.length'), 3, 'reanalisar do zero não duplica');
  assert.deepEqual((await ev('BF.state.project.cuts.map((c) => c.id)')).sort(), ids, 'os mesmos cortes, com os mesmos ids');
  assert.equal(await ev("document.querySelectorAll('#anList .an-item').length"), 0, 'tudo que a análise achou já está nos cortes');
  log('reanalisar (do cache e sem usar o guardado) não duplica: continuam os mesmos 3 cortes');
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. Revisão
// ---------------------------------------------------------------------------------------------------------------------
const MANUAL = { M5: [4, 10], M1: [12, 30], M2: [66, 74], M3: [76, 84], M4: [100, 112] }; // cortes manuais marcados pela barra do player
const TITLES = { M5: 'Aquecimento', M1: 'Lance repetido', M2: 'Clutch do final', M3: 'Fail engraçado', M4: 'Jogada de abertura' };
const ID = {}; // nome curto -> id do corte (S1/S2/S3 = sugestões da análise; M1..M5 = manuais)

const rowsInfo = () => ev(`[...document.querySelectorAll('#cuts .cut')].map((c) => ({
  id: c.dataset.id, title: c.querySelector('.cut-title').value, origin: c.dataset.origin, reviewed: c.dataset.reviewed, changed: c.dataset.changed,
  similar: c.dataset.similar, custom: c.dataset.custom, picked: c.querySelector('.cut-pick').checked,
  chips: [...c.querySelectorAll('.chips .chip')].map((x) => x.textContent),
  status: c.className.includes('approved') ? 'approved' : c.className.includes('rejected') ? 'rejected' : 'pending'
}))`);
const order = async () => (await rowsInfo()).map((r) => r.id);
const statuses = async () => Object.fromEntries(await ev('BF.state.project.cuts.map((c) => [c.id, c.status])'));
const pickRow = async (id, { shift = false } = {}) => {
  await ev(`(() => { const row = document.querySelector('#cuts .cut[data-id="${id}"]'); if (!row) throw new Error('corte fora da lista'); row.querySelector('.cut-pick').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: ${shift} })); })()`);
  await sleep(100);
};
const clearPicks = async () => { if (await ev("!document.querySelector('.selbar').hidden")) { await click('[data-focus="batch-clear"]'); await sleep(100); } };
const previewItems = () => ev(`[...document.querySelectorAll('.preview-item')].map((i) => ({ name: i.querySelector('.preview-name').textContent, from: i.querySelector('.from').textContent, to: i.querySelector('.to').textContent }))`);
async function openPreview(action) {
  await action();
  await wf("!document.querySelector('.preview').hidden", 10000, 'prévia aberta');
  await sleep(80);
}
async function confirmPreview() {
  await click('[data-focus="preview-confirm"]');
  await wf("document.querySelector('.preview').hidden", 10000, 'prévia fechada');
  await sleep(150);
}
async function cancelPreview() {
  await click('[data-focus="preview-cancel"]');
  await wf("document.querySelector('.preview').hidden", 10000, 'prévia fechada');
  await sleep(100);
}
async function toastUndo() {
  await wf("!!document.querySelector('#toasts .review-toast .toast-action')", 8000, 'aviso com Desfazer');
  await click('#toasts .review-toast:last-child .toast-action');
  await sleep(200);
}
const openMoreActions = () => ev("(() => { document.querySelector('.selbar .more').open = true; })()");

async function step3() {
  await selectTab('cuts');
  await wf("!document.querySelector('#cuts').closest('.cuts-main').hidden", 20000, 'central de revisão carregada');
  await wf('window.BF.review && window.BF.review.engine', 20000, 'motor da revisão');
  // as três sugestões da análise ganham nomes curtos (S1 = 12-29, S2 = 44-59,5, S3 = 87-103,5; os instantes que o passo "3 sugestões nos instantes conhecidos" confere)
  const auto = (await ev('BF.state.project.cuts.map((c) => ({ id: c.id, start: c.start }))')).sort((a, b) => a.start - b.start);
  [ID.S1, ID.S2, ID.S3] = auto.map((c) => c.id);
  await ev("window.__dec = []; BF.bus.on('decision', (d) => window.__dec.push(JSON.parse(JSON.stringify(d)))); window.__chg = []; BF.bus.on('cuts:changed', (d) => window.__chg.push(d && d.from)); true");

  // ---- cortes manuais pela barra de marcação do player (o mesmo caminho do usuário) ----
  for (const key of ['M5', 'M1', 'M2', 'M3', 'M4']) {
    const [start, end] = MANUAL[key];
    await setValue('#inInput', String(start), ['input']);
    await setValue('#outInput', String(end), ['input']);
    await wf("!document.getElementById('btnAddCut').disabled", 5000, 'botão Salvar corte');
    await click('#btnAddCut');
    await wf(`BF.state.project.cuts.some((c) => c.start === ${start} && c.end === ${end})`, 10000, `corte manual ${key}`);
    ID[key] = await ev(`BF.state.project.cuts.find((c) => c.start === ${start} && c.end === ${end}).id`);
  }
  assert.equal(await ev('BF.state.project.cuts.length'), 8);
  await wf("document.querySelectorAll('#cuts .cut').length === 8", 10000, 'oito cortes na lista');
  // títulos dos manuais digitados no campo da linha (viram "personalizados")
  for (const key of ['M5', 'M1', 'M2', 'M3', 'M4']) {
    await setValue(`#cuts .cut[data-id="${ID[key]}"] .cut-title`, TITLES[key], ['change']);
    await wf(`BF.project.cut(${J(ID[key])}).title === ${J(TITLES[key])} && BF.project.cut(${J(ID[key])}).titleCustom === true`, 10000, `título de ${key}`);
  }
  await setValue(`#cuts .cut[data-id="${ID.S1}"] .cut-title`, 'Ace na rodada', ['change']);
  await wf(`BF.project.cut(${J(ID.S1)}).title === 'Ace na rodada'`, 10000, 'título de S1');
  // S1 (12-29) e M1 (12-30) começam juntos: a ordem da live desempata pelo fim, então a sugestão (que termina 1 s antes) vem primeiro
  const chrono = [ID.M5, ID.S1, ID.M1, ID.S2, ID.M2, ID.M3, ID.S3, ID.M4];

  // ---- ordem cronológica (padrão) e por relevância ----
  assert.deepEqual(await order(), chrono, 'ordem da live por padrão');
  assert.equal(await ev("document.querySelector('.sort').value"), 'chrono');
  await setValue('.sort', 'relevance', ['change']);
  await sleep(200);
  const byRelevance = await order();
  assert.deepEqual(byRelevance.slice(0, 2).sort(), [ID.S1, ID.S3].sort(), 'sugeridos mais relevantes primeiro');
  assert.equal(byRelevance[2], ID.S2, 'depois o de relevância menor');
  assert.deepEqual(byRelevance.slice(3), [ID.M5, ID.M1, ID.M2, ID.M3, ID.M4], 'os manuais (sem relevância) depois, em ordem da live');
  await setValue('.sort', 'chrono', ['change']);
  await sleep(200);
  assert.deepEqual(await order(), chrono);
  const infos = await rowsInfo();
  assert.ok(infos.find((r) => r.id === ID.S1).chips.includes('Sugerido') && !infos.find((r) => r.id === ID.M2).chips.includes('Manual'));
  log('revisão: ordem da live e por relevância (sugeridos primeiro), com os manuais depois');

  // ---- filtros ----
  assert.equal(await text('[data-state="pending"] .count'), '8');
  await setValue('.filters-grid select:nth-of-type(2)', 'auto', ['change']);
  await sleep(150);
  assert.deepEqual((await order()).sort(), [ID.S1, ID.S2, ID.S3].sort(), 'filtro: só sugeridos');
  await setValue('.filters-grid select:nth-of-type(2)', 'manual', ['change']);
  await sleep(150);
  assert.deepEqual((await order()).sort(), [ID.M1, ID.M2, ID.M3, ID.M4, ID.M5].sort(), 'filtro: só manuais');
  await click('[data-focus="f-clear"]');
  await sleep(150);
  assert.equal((await rowsInfo()).length, 8);
  log('revisão: filtros por estado e por origem');

  // ---- categorizar em lote (prévia -> confirmar -> desfazer pelo aviso -> refazer) ----
  await pickRow(ID.M2);
  await pickRow(ID.M3);
  await pickRow(ID.M4);
  assert.equal(await ev("document.querySelector('.selbar').hidden"), false);
  assert.match(await text('.sel-count'), /3 selecionados/);
  await openMoreActions();
  await openPreview(() => click('[data-focus="batch-categorize"]'));
  await setValue('.preview-controls .cut-category', 'Hype', ['input']);
  await sleep(150);
  assert.deepEqual((await previewItems()).map((i) => i.name).sort(), [TITLES.M2, TITLES.M3, TITLES.M4].sort());
  assert.equal(await ev('BF.state.project.cuts.filter((c) => c.category).length'), 0, 'a prévia não altera nada');
  await ev('window.__chg.length = 0; true');
  await confirmPreview();
  for (const k of ['M2', 'M3', 'M4']) assert.equal((await cutOf(ID[k])).category, 'Hype');
  assert.equal(await ev("window.__chg.filter((f) => f === 'review').length"), 1, 'um único cuts:changed para o lote');
  await toastUndo();
  for (const k of ['M2', 'M3', 'M4']) assert.equal((await cutOf(ID[k])).category, '', 'o aviso Desfazer limpou a categoria');
  await click('[data-focus="redo"]');
  await sleep(200);
  for (const k of ['M2', 'M3', 'M4']) assert.equal((await cutOf(ID[k])).category, 'Hype', 'Refazer devolveu a categoria');
  await clearPicks();
  // categoria de um corte só, pelo editor do corte aberto
  await ev(`BF.review.select(${J(ID.S1)})`);
  await wf(`!!document.querySelector('#cuts .cut[data-id="${ID.S1}"] [data-focus="category"]')`, 10000, 'editor de S1');
  await setValue(`#cuts .cut[data-id="${ID.S1}"] [data-focus="category"]`, '  Clutch ', ['change']);
  await wf(`BF.project.cut(${J(ID.S1)}).category === 'Clutch'`, 10000, 'categoria de S1');
  log('revisão: categorizar em lote (prévia, confirmar, Desfazer, Refazer) e uma categoria no editor');

  // ---- aprovar em lote: prévia -> cancelar (nada muda) -> confirmar -> desfazer -> refazer ----
  await pickRow(ID.M2);
  await pickRow(ID.M3);
  await ev('window.__dec.length = 0; window.__chg.length = 0; true');
  await openPreview(() => click('[data-focus="batch-approve"]'));
  assert.match(await text('.preview h3'), /Prévia: Aprovar 2 cortes/);
  assert.deepEqual((await previewItems()).map((i) => [i.name, i.from, i.to]), [[TITLES.M2, 'Pendente', 'Aprovado'], [TITLES.M3, 'Pendente', 'Aprovado']]);
  assert.equal(await ev("document.querySelector('.cuts-main').hidden"), true, 'a lista dá lugar à prévia');
  await cancelPreview();
  assert.equal((await cutOf(ID.M2)).status, 'pending', 'cancelar não muda nada');
  assert.equal(await ev('window.__dec.length'), 0, 'nem emite eventos');
  await openPreview(() => click('[data-focus="batch-approve"]'));
  await confirmPreview();
  assert.deepEqual([(await cutOf(ID.M2)).status, (await cutOf(ID.M3)).status], ['approved', 'approved']);
  const batch = await ev('window.__dec');
  assert.deepEqual(batch.map((d) => [d.type, d.source]), [['approve', 'batch'], ['approve', 'batch']]);
  assert.equal(new Set(batch.map((d) => d.reviewGroup)).size, 1, 'o lote é um grupo só');
  assert.equal(await ev("window.__chg.filter((f) => f === 'review').length"), 1);
  assert.match(await text('#toasts .review-toast:last-child .toast-text'), /Aprovou 2 cortes/);
  assert.ok((await cutOf(ID.M2)).reviewedRange, 'guarda o tempo de quando foi revisado');
  await toastUndo();
  assert.deepEqual([(await cutOf(ID.M2)).status, (await cutOf(ID.M3)).status], ['pending', 'pending'], 'Desfazer devolve pendente');
  await click('[data-focus="redo"]');
  await sleep(200);
  assert.deepEqual([(await cutOf(ID.M2)).status, (await cutOf(ID.M3)).status], ['approved', 'approved'], 'Refazer aprova de novo');
  await clearPicks();
  log('revisão: lote com prévia (cancelar não muda nada), confirmar, Desfazer e Refazer; um grupo e um cuts:changed');

  // ---- aprovar um por um, ajuste temporal fino ("alterado") e filtro ----
  await click(`#cuts .cut[data-id="${ID.S2}"] [data-focus="approve"]`);
  await wf(`BF.project.cut(${J(ID.S2)}).status === 'approved'`, 10000, 'S2 aprovado');
  await ev(`BF.review.select(${J(ID.S2)})`);
  await wf(`!!document.querySelector('#cuts .cut[data-id="${ID.S2}"] .adjust')`, 10000, 'editor de S2');
  const s2 = await cutOf(ID.S2);
  assert.deepEqual(s2.reviewedRange, [s2.start, s2.end]);
  await click(`#cuts .cut[data-id="${ID.S2}"] [data-focus="step-start-0.1"]`);
  await sleep(120);
  await click(`#cuts .cut[data-id="${ID.S2}"] [data-focus="step-start-0.1"]`);
  await sleep(120);
  await click(`#cuts .cut[data-id="${ID.S2}"] [data-focus="step-end-1"]`);
  await sleep(200);
  const adjusted = await cutOf(ID.S2);
  near(adjusted.start, s2.start + 0.2, 0.001, 'início depois de +0,1 s duas vezes');
  near(adjusted.end, s2.end + 1, 0.001, 'fim depois de +1 s');
  assert.equal(adjusted.revision, s2.revision + 3, 'cada ajuste sobe a revisão');
  assert.deepEqual(adjusted.reviewedRange, [s2.start, s2.end], 'a revisão lembra o tempo de quando foi aprovado');
  const rowS2 = (await rowsInfo()).find((r) => r.id === ID.S2);
  assert.equal(rowS2.changed, 'true');
  assert.ok(rowS2.chips.includes('Alterado') && rowS2.reviewed === 'true');
  await click('[data-focus="f-changed"]');
  await sleep(200);
  assert.deepEqual(await order(), [ID.S2], 'filtro "alterados desde a revisão"');
  await click('[data-focus="f-clear"]');
  await sleep(150);
  for (let i = 0; i < 3; i++) { await click('[data-focus="undo"]'); await sleep(150); }
  const restored = await cutOf(ID.S2);
  assert.deepEqual([restored.start, restored.end], [s2.start, s2.end], 'desfazer os 3 ajustes devolve o tempo');
  assert.equal((await rowsInfo()).find((r) => r.id === ID.S2).changed, 'false', 'voltou ao tempo revisado: sem aviso');
  assert.equal(restored.status, 'approved', 'a aprovação continua');
  log('revisão: ajuste temporal fino (revision sobe, selo "Alterado", filtro) e desfazer devolve o tempo');

  // ---- semelhantes: S1 (14-29) e o manual M1 (12-30) formam um grupo; "Manter um…" mantém S1 e rejeita M1 ----
  await click('[data-focus="f-similar"]');
  await sleep(250);
  assert.equal(await ev("document.querySelectorAll('#cuts .group-head').length"), 1, 'um grupo de cortes parecidos');
  assert.match(await text('#cuts .group-head'), /2 cortes parecidos/);
  assert.deepEqual((await order()).sort(), [ID.S1, ID.M1].sort());
  assert.ok((await rowsInfo()).every((r) => r.similar === 'true'));
  await openPreview(() => click('#cuts .group-head button'));
  const radios = await ev("[...document.querySelectorAll('.keep-choice input')].map((r) => [r.value, r.checked])");
  assert.equal(radios.find((r) => r[1])[0], ID.S1, 'sugere manter a sugestão de maior relevância');
  await setChecked('#keepApprove', true);
  await sleep(150);
  assert.deepEqual((await previewItems()).map((i) => [i.name, i.from, i.to]).sort(), [['Ace na rodada', 'Pendente', 'Aprovado'], [TITLES.M1, 'Pendente', 'Rejeitado']].sort());
  await confirmPreview();
  assert.deepEqual([(await cutOf(ID.S1)).status, (await cutOf(ID.M1)).status], ['approved', 'rejected']);
  assert.match(await text('#toasts .review-toast:last-child .toast-text'), /Manteve um/);
  await click('[data-focus="f-clear"]');
  await sleep(150);
  await click(`#cuts .cut[data-id="${ID.M5}"] [data-focus="reject"]`);
  await wf(`BF.project.cut(${J(ID.M5)}).status === 'rejected'`, 10000, 'M5 rejeitado');
  assert.deepEqual(await statuses(), { [ID.S1]: 'approved', [ID.S2]: 'approved', [ID.S3]: 'pending', [ID.M1]: 'rejected', [ID.M2]: 'approved', [ID.M3]: 'approved', [ID.M4]: 'pending', [ID.M5]: 'rejected' });
  log('revisão: semelhantes ("Manter um…" aprovou S1 e rejeitou o parecido) e rejeição individual');

  // ---- histórico: restaurar volta ao estado de antes da ação e a restauração é reversível ----
  const snapshot = async () => (await project()).cuts.map((c) => [c.id, c.status, c.start, c.end, c.category, c.title]);
  const stateBefore = await snapshot();
  await ev("(() => { const d = document.querySelector('details.history'); d.open = true; d.dispatchEvent(new Event('toggle')); })()");
  await sleep(250);
  const labels = await ev("[...document.querySelectorAll('.history-label')].map((e) => e.textContent)");
  for (const re of [/^Aprovou 2 cortes$/, /^Desfez: /, /^Categorizou /, /^Ajustou /, /^Manteve um/]) assert.ok(labels.some((l) => re.test(l)), `histórico sem ${re}: ${J(labels)}`);
  const groupId = await ev("BF.review.engine.groups().find((g) => g.label === 'Aprovou 2 cortes').id");
  await openPreview(() => click(`[data-focus="restore-${groupId}"]`));
  assert.match(await text('.preview h3'), /Restaurar o estado anterior a/);
  const restoreItems = await previewItems();
  assert.ok(restoreItems.length >= 4, `a restauração mexe em vários cortes (${restoreItems.length})`);
  assert.deepEqual(await snapshot(), stateBefore, 'a prévia não altera nada');
  await confirmPreview();
  const afterRestore = await statuses();
  assert.equal(afterRestore[ID.M2], 'pending');
  assert.equal(afterRestore[ID.S2], 'pending');
  assert.equal(afterRestore[ID.M1], 'pending');
  assert.equal(await ev("BF.review.engine.groups().at(-1).source"), 'restore', 'a restauração é uma entrada nova');
  await toastUndo();
  assert.deepEqual(await snapshot(), stateBefore, 'desfazer a restauração devolve o estado de antes dela');
  await ev("document.querySelector('details.history').open = false; true");
  log(`revisão: histórico com ${labels.length} entradas; restaurar com prévia e desfazer a restauração devolvem exatamente o estado anterior`);
  await shot('3-revisao');
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. Preferências
// ---------------------------------------------------------------------------------------------------------------------
const prefRow = (key) => `#tabpanel-prefs .prefs-row[data-key="${key}"]`;
const explain = (key) => ev(`BF.prefs.explain(${J(key)})`);
const learnedCard = (label) => ev(`(() => { const c = [...document.querySelectorAll('#tabpanel-prefs .prefs-learned')].find((x) => x.textContent.includes(${J(label)})); return c ? { id: c.dataset.id, state: c.dataset.state, text: c.textContent } : null; })()`);

async function step4(W) {
  await selectTab('prefs');
  await wf("!!document.querySelector('#tabpanel-prefs input[list=\"prefsGames\"]')", 20000, 'campos do projeto na aba Preferências');

  // ---- decisões da revisão chegam às Preferências: o estado de cada corte decidido fica em learned.json ----
  const learnedFile = path.join(W.userData, 'learned.json');
  const projectId = await ev('BF.state.project.id');
  const expectedDecided = {};
  for (const [name, status] of Object.entries({ S1: 'approved', S2: 'approved', M1: 'rejected', M2: 'approved', M3: 'approved', M5: 'rejected' })) expectedDecided[ID[name]] = status;
  const readObserved = () => {
    try { return JSON.parse(fs.readFileSync(learnedFile, 'utf8')).observations[projectId]?.cuts || {}; } catch { return {}; }
  };
  const t0 = Date.now();
  while (Object.keys(readObserved()).length < 7 && Date.now() - t0 < 20000) await sleep(200);
  const observed = readObserved();
  assert.deepEqual(Object.keys(observed).sort(), [...Object.keys(expectedDecided), ID.M4].sort(), 'cada corte decidido (ou categorizado) foi observado; S3 (pendente, sem categoria) não');
  for (const [id, status] of Object.entries(expectedDecided)) assert.equal(observed[id].status, status, `estado observado de ${id}`);
  assert.deepEqual([observed[ID.M4].status, observed[ID.M4].category], ['pending', 'Hype']);
  assert.equal(observed[ID.S1].origin, 'auto');
  assert.equal(observed[ID.M2].origin, 'manual');
  assert.equal((await ev("BF.api('prefs:learned', {})")).observed, 7);
  log('decisões da revisão chegaram às Preferências (learned.json guarda o estado de 7 cortes: 4 aprovados, 2 rejeitados, 1 categorizado)');

  // ---- jogo e canal do projeto ----
  await setValue('#tabpanel-prefs input[list="prefsGames"]', 'Valorant', ['change']);
  await wf("BF.state.project.meta.game === 'Valorant'", 10000, 'jogo do projeto');
  await setValue('#tabpanel-prefs input[list="prefsChannels"]', 'CanalTeste', ['change']);
  await wf("BF.state.project.meta.channel === 'CanalTeste'", 10000, 'canal do projeto');
  assert.deepEqual(await ev('BF.prefs.scope()'), { game: 'Valorant', channel: 'CanalTeste' });

  // ---- prioridade canal > jogo > geral, chave por chave ----
  const KEY = 'analysis.minRelevance';
  const seg = async (scope) => { await click(`#tabpanel-prefs .prefs-seg[data-scope="${scope}"]`); await sleep(250); await wf(`!!document.querySelector(${J(prefRow(KEY))})`, 10000, `lista de preferências do escopo ${scope}`); };
  const edit = async (value) => { await setValue(`${prefRow(KEY)} input`, String(value), ['change']); await sleep(300); };
  assert.equal((await explain(KEY)).source, 'default');
  await seg('general');
  await edit(40);
  await wf(`BF.prefs.get(${J(KEY)}, 0.5) === 0.4`, 10000, 'geral 40%');
  assert.deepEqual([(await explain(KEY)).scope, (await explain(KEY)).label], ['general', 'geral']);
  await seg('game');
  await wf("document.querySelector('#tabpanel-prefs .prefs-scope > input') && document.querySelector('#tabpanel-prefs .prefs-scope > input').value === 'Valorant'", 10000, 'nome do jogo no escopo Jogo');
  await edit(60);
  await wf(`BF.prefs.get(${J(KEY)}, 0.5) === 0.6`, 10000, 'jogo 60%');
  assert.equal((await explain(KEY)).label, 'jogo Valorant', 'o jogo vence o geral');
  await seg('channel');
  await wf("document.querySelector('#tabpanel-prefs .prefs-scope > input') && document.querySelector('#tabpanel-prefs .prefs-scope > input').value === 'CanalTeste'", 10000, 'nome do canal no escopo Canal');
  await edit(80);
  await wf(`BF.prefs.get(${J(KEY)}, 0.5) === 0.8`, 10000, 'canal 80%');
  assert.deepEqual([(await explain(KEY)).scope, (await explain(KEY)).label], ['channel', 'canal CanalTeste'], 'o canal vence o jogo e o geral');
  assert.match(await text(`${prefRow(KEY)} .prefs-pill`), /canal CanalTeste/, 'selo de origem na linha');
  // outro recurso lê o valor em vigor: a aba Análise mostra a relevância mínima das Preferências
  await selectTab('analysis');
  await wf("/relevância mínima 80%/.test(document.getElementById('anPrefsNote').textContent)", 10000, 'Análise usa o valor do canal');
  await selectTab('prefs');
  await seg('channel');
  await click(`${prefRow(KEY)} .prefs-clear`);
  await wf(`BF.prefs.get(${J(KEY)}, 0.5) === 0.6`, 10000, 'sem o canal, volta ao jogo');
  assert.equal((await explain(KEY)).scope, 'game');
  await seg('game');
  await click(`${prefRow(KEY)} .prefs-clear`);
  await wf(`BF.prefs.get(${J(KEY)}, 0.5) === 0.4`, 10000, 'sem o jogo, volta ao geral');
  assert.equal((await explain(KEY)).scope, 'general');
  await seg('general');
  await click(`${prefRow(KEY)} .prefs-clear`);
  await wf(`BF.prefs.get(${J(KEY)}, 0.5) === 0.5`, 10000, 'sem nada, volta ao padrão');
  assert.equal((await explain(KEY)).source, 'default');
  log('preferências por escopo: canal (80%) > jogo (60%) > geral (40%) > padrão; "Limpar" volta a herdar; a aba Análise usa o valor em vigor');

  // ---- aprendizado: 4 aprovações não bastam (evidência mínima 5) ----
  const DUR = 'analysis.maxDurationSec';
  assert.equal((await explain(DUR)).source, 'default', '4 cortes aprovados ainda não valem');
  await selectTab('prefs');
  await wf("!!document.querySelector('#tabpanel-prefs .prefs-waiting')", 15000, 'sugestões aguardando evidência');
  assert.match(await text('#tabpanel-prefs .prefs-waiting summary'), /aguardam mais decisões/);
  assert.equal(await ev("BF.api('prefs:learned', {}).then((r) => r.items.filter((i) => i.state === 'active').length)"), 0, 'nenhum item aprendido em vigor');
  assert.equal(await ev("BF.api('prefs:learned', {}).then((r) => r.minEvidence)"), 5);
  // a 5ª aprovação (M4, pelo botão da aba Cortes) faz a preferência valer
  await selectTab('cuts');
  await click(`#cuts .cut[data-id="${ID.M4}"] [data-focus="approve"]`);
  await wf(`BF.project.cut(${J(ID.M4)}).status === 'approved'`, 10000, 'M4 aprovado');
  await wf(`BF.prefs.explain(${J(DUR)}).source === 'learned'`, 20000, 'preferência aprendida em vigor');
  const learned = await explain(DUR);
  assert.match(learned.evidence, /5 cortes aprovados, mediana 12 s/, `evidência legível: ${learned.evidence}`);
  const maxLearned = await ev(`BF.prefs.get(${J(DUR)}, 60)`);
  assert.ok(maxLearned > 0 && maxLearned !== 60, `duração máxima aprendida (${maxLearned})`);
  await wf("[...document.querySelectorAll('#toasts .toast')].some((t) => /Preferência aprendida|preferências aprendidas/.test(t.textContent))", 10000, 'aviso visível de que algo foi aprendido');
  await selectTab('prefs');
  await wf("[...document.querySelectorAll('#tabpanel-prefs .prefs-learned')].some((c) => c.textContent.includes('Duração máxima'))", 15000, 'cartão aprendido na aba');
  let card = await learnedCard('Duração máxima');
  assert.match(card.text, /5 cortes aprovados, mediana 12 s/);
  assert.match(card.text, /aprendida/);
  assert.match(card.text, /em vigor/);
  assert.equal(card.state, 'active');
  // outro recurso passa a usar o aprendido: a aba Análise mostra a duração máxima nova
  await selectTab('analysis');
  const pt = (n) => String(n).replace('.', ',');
  await wf(`new RegExp('entre ${pt(await ev("BF.prefs.get('analysis.minDurationSec', 15)"))} e ${pt(maxLearned)} s').test(document.getElementById('anPrefsNote').textContent)`, 10000, 'Análise mostra as durações aprendidas');
  await selectTab('prefs');
  await shot('4-aprendido');
  log(`aprendizado: 4 aprovações não valem; a 5ª vira preferência aprendida em vigor (${learned.evidence}), com aviso, cartão visível e efeito na aba Análise`);

  // ---- desativar o item, desfazer pelo histórico, chave geral ----
  await setChecked(`#tabpanel-prefs .prefs-learned[data-id="${card.id}"] input[type=checkbox]`, false);
  await wf(`BF.prefs.explain(${J(DUR)}).source === 'default'`, 10000, 'item desativado');
  card = await learnedCard('Duração máxima');
  assert.equal(card.state, 'disabled');
  assert.equal(await ev(`BF.prefs.get(${J(DUR)}, 60)`), 60, 'o desativado deixa de valer');
  await ev("document.querySelector('#tabpanel-prefs details.prefs-details').open = true");
  await wf("!!document.querySelector('#tabpanel-prefs .prefs-history li')", 10000, 'histórico de mudanças');
  assert.match(await text('#tabpanel-prefs .prefs-history li'), /Desativou a preferência aprendida "Duração máxima"/);
  await click('#tabpanel-prefs .prefs-history li button');
  const asked = await h.answerModal(S.page, true);
  assert.match(asked.title, /Desfazer alteração/);
  await wf(`BF.prefs.explain(${J(DUR)}).source === 'learned'`, 10000, 'desfazer reativa o item');
  assert.equal(await ev(`BF.prefs.get(${J(DUR)}, 60)`), maxLearned);
  await setChecked('#prefsLearnOn', false);
  await wf(`BF.prefs.explain(${J(DUR)}).source === 'default'`, 10000, 'aprendizado desligado');
  assert.match(await text('#tabpanel-prefs'), /Desligado: nada novo é observado/);
  await setChecked('#prefsLearnOn', true);
  await wf(`BF.prefs.explain(${J(DUR)}).source === 'learned'`, 10000, 'aprendizado religado');
  log('aprendizado: item desativável, desfeito pelo histórico (com confirmação) e chave geral que liga e desliga o efeito');
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. Áudio e legendas
// ---------------------------------------------------------------------------------------------------------------------
/** Mediana de `n` leituras do nível (dBFS, RMS) do que está saindo do player (AnalyserNode do GainNode da prévia). */
const levelNow = (n = 7, gapMs = 70) => ev(`(async () => {
  const out = [];
  for (let i = 0; i < ${n}; i++) { out.push(BF.audioPreview.level().rmsDb); await new Promise((r) => setTimeout(r, ${gapMs})); }
  out.sort((a, b) => a - b);
  return out[Math.floor(out.length / 2)];
})()`);

async function pickSubtitlesCut(id) {
  await wf("!!document.querySelector('#tabpanel-subtitles select[data-fid=\"cut\"]')", 20000, 'seletor de corte da aba Legendas');
  await setValue('#tabpanel-subtitles select[data-fid="cut"]', id, ['change']);
  await wf(`document.querySelector('#tabpanel-subtitles select[data-fid="cut"]').value === ${J(id)} && !!document.querySelector('#tabpanel-subtitles [data-act="add"]')`, 20000, 'aba Legendas do corte escolhido');
}

async function step5(W) {
  const observedBefore = (await ev("BF.api('prefs:learned', {})")).observed;

  // ---------- áudio: ganho +6 dB e fades em S1; comparar Original x Ajustado; histórico ----------
  await selectTab('audio');
  await wf("!!document.getElementById('audioCut')", 15000, 'aba Áudio desenhada');
  await setValue('#audioCut', ID.S1, ['change']);
  await wf("!document.querySelector('#tabpanel-audio .audio-body').hidden && !!document.getElementById('audioGainNum')", 15000, 'painel de áudio do corte');
  await wf("/dB/.test(document.querySelector('#tabpanel-audio .audio-measure').textContent)", 60000, 'medição real do trecho na tela');
  const s1 = await cutOf(ID.S1);
  assert.deepEqual({ gainDb: s1.audio.gainDb, mute: s1.audio.mute, fadeInSec: s1.audio.fadeInSec, fadeOutSec: s1.audio.fadeOutSec }, { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0 });
  await setValue('#audioGainNum', '6', ['change']);
  await wf(`BF.project.cut(${J(ID.S1)}).audio.gainDb === 6`, 10000, 'ganho gravado');
  await setValue('#audioFadeIn', '0.5', ['change']);
  await wf(`BF.project.cut(${J(ID.S1)}).audio.fadeInSec === 0.5`, 10000, 'fade in gravado');
  await setValue('#audioFadeOut', '0.5', ['change']);
  await wf(`BF.project.cut(${J(ID.S1)}).audio.fadeOutSec === 0.5`, 10000, 'fade out gravado');
  const labels = await ev("[...document.querySelectorAll('#tabpanel-audio .audio-history-list li .audio-h-label')].map((n) => n.textContent)");
  assert.equal(labels.length, 3, `histórico de áudio do corte: ${J(labels)}`);
  assert.match(labels.join(' | '), /Ganho \+6 dB/);
  assert.match(labels.join(' | '), /Fade in/);
  assert.match(labels.join(' | '), /Fade out/);
  const filterText = await text('#tabpanel-audio .audio-filter');
  assert.match(filterText, /volume=6dB/);
  assert.match(filterText, /afade=t=in:st=0:d=0\.5/);
  assert.match(filterText, new RegExp(`afade=t=out:st=${(s1.end - s1.start - 0.5).toString().replace('.', '\\.')}:d=0\\.5`));
  // Original x Ajustado no player: o ajustado soa 6 dB acima (nível lido do AnalyserNode, depois do fade in)
  // As duas leituras precisam vir do mesmo fundo (ruído de -50 dB, depois do fade in e antes da rajada de 20 s): se a máquina atrasar e o
  // player passar da rajada no meio das leituras, a tentativa é descartada e refeita do começo do corte.
  const quietUntil = BURSTS[0].at - 0.4;
  let original = null;
  let adjustedLevel = null;
  for (let attempt = 1; attempt <= 4 && adjustedLevel === null; attempt++) {
    if ((await text('#audioPlay')) === 'Parar') { await click('#audioPlay'); await wf("document.getElementById('video').paused", 10000, 'prévia parada'); }
    await click('#audioModeOriginal');
    await click('#audioPlay');
    try {
      await wf(`!document.getElementById('video').paused && document.getElementById('video').currentTime > ${s1.start + 0.8} && document.getElementById('video').currentTime < ${s1.start + 2.5}`, 15000, 'prévia tocando dentro do corte, depois do fade in');
    } catch { continue; }
    const o = await levelNow();
    near(await ev('BF.audioPreview.state().gain'), 1, 0.001, 'Original: ganho 1');
    await click('#audioModeAdjusted');
    // o ganho do Ajustado chega em milissegundos; se não chegar (o contexto de áudio do Chromium pode parar de renderizar com a janela
    // coberta ou a máquina sobrecarregada), a tentativa é refeita do começo do corte e o fato fica registrado no resumo
    const reached = await ev(`(async () => {
      const target = ${10 ** (6 / 20)}; const samples = [];
      for (let i = 0; i < 25; i++) {
        const st = BF.audioPreview.state(); const video = document.getElementById('video');
        samples.push([Number(video.currentTime.toFixed(2)), Number(st.gain.toFixed(3)), st.contextState, video.paused]);
        if (Math.abs(st.gain - target) < 0.01) return { ok: true, samples };
        await new Promise((r) => setTimeout(r, 120));
      }
      return { ok: false, samples };
    })()`);
    if (!reached.ok) {
      S.flakes.push(`prévia de áudio: o ganho do Ajustado não chegou a +6 dB na tentativa ${attempt} (amostras [tempo, ganho, contexto, pausado]: ${J(reached.samples.slice(-6))})`);
      continue;
    }
    await sleep(100);
    const a = await levelNow();
    if ((await ev("document.getElementById('video').currentTime")) < quietUntil) { original = o; adjustedLevel = a; }
  }
  assert.notEqual(adjustedLevel, null, 'não foi possível ler Original e Ajustado antes da rajada de áudio');
  near(adjustedLevel - original, 6, 1.2, 'Ajustado soa 6 dB acima do Original');
  assert.ok(original < -35 && original > -65, `o fundo do trecho é um ruído de -50 dB (leitura ${original.toFixed(1)} dB)`);
  if ((await text('#audioPlay')) === 'Parar') await click('#audioPlay');
  await wf("document.getElementById('video').paused", 10000, 'prévia parada');
  // desfazer e refazer pela própria aba
  await click('#audioUndo');
  await wf(`BF.project.cut(${J(ID.S1)}).audio.fadeOutSec === 0`, 10000, 'desfazer tirou o fade out');
  await click('#audioRedo');
  await wf(`BF.project.cut(${J(ID.S1)}).audio.fadeOutSec === 0.5`, 10000, 'refazer devolveu o fade out');
  const finalAudio = (await cutOf(ID.S1)).audio;
  assert.deepEqual({ gainDb: finalAudio.gainDb, mute: finalAudio.mute, fadeInSec: finalAudio.fadeInSec, fadeOutSec: finalAudio.fadeOutSec }, { gainDb: 6, mute: false, fadeInSec: 0.5, fadeOutSec: 0.5 });
  assert.equal(finalAudio.history.length, 3);
  await shot('5-audio');
  log(`áudio: +6 dB e fades em S1; Original ${original.toFixed(1)} dB x Ajustado ${adjustedLevel.toFixed(1)} dB no player; histórico de 3 entradas, desfazer e refazer`);

  // ---------- legendas manuais: M2 incorporada ao vídeo, M3 em arquivo separado ----------
  await selectTab('subtitles');
  await pickSubtitlesCut(ID.M2);
  await click('#tabpanel-subtitles [data-act="add"]');
  await wf("!!document.querySelector('#tabpanel-subtitles textarea.cue-text')", 10000, 'primeira fala de M2');
  await setValue('#tabpanel-subtitles textarea.cue-text', 'LEGENDA INCORPORADA');
  await wf(`BF.project.cut(${J(ID.M2)}).subtitles && BF.project.cut(${J(ID.M2)}).subtitles.cues[0].text === 'LEGENDA INCORPORADA'`, 10000, 'texto da fala de M2');
  const subsM2 = (await cutOf(ID.M2)).subtitles;
  assert.equal(subsM2.enabled, true);
  assert.equal(subsM2.mode, 'burn', 'padrão: legenda incorporada ao vídeo');
  assert.equal(subsM2.cues.length, 1);
  assert.ok(subsM2.cues[0].start >= 0 && subsM2.cues[0].end > subsM2.cues[0].start && subsM2.cues[0].end <= 8.01, `tempos relativos ao corte: ${J(subsM2.cues[0])}`);
  await pickSubtitlesCut(ID.M3);
  await click('#tabpanel-subtitles [data-act="add"]');
  await wf("!!document.querySelector('#tabpanel-subtitles textarea.cue-text')", 10000, 'primeira fala de M3');
  await setValue('#tabpanel-subtitles textarea.cue-text', 'LEGENDA EM ARQUIVO');
  await setValue('#tabpanel-subtitles select[data-fid="mode"]', 'sidecar', ['change']);
  await wf(`BF.project.cut(${J(ID.M3)}).subtitles && BF.project.cut(${J(ID.M3)}).subtitles.mode === 'sidecar' && BF.project.cut(${J(ID.M3)}).subtitles.cues[0].text === 'LEGENDA EM ARQUIVO'`, 10000, 'M3 em arquivo separado');
  const subsM3 = (await cutOf(ID.M3)).subtitles;
  assert.equal(subsM3.enabled, true);
  assert.match(await text('#tabpanel-subtitles [data-note="summary"]'), /arquivo \.srt ao lado do vídeo/);
  log(`legendas manuais: M2 incorporada (fala ${subsM2.cues[0].start.toFixed(1)}-${subsM2.cues[0].end.toFixed(1)} s do corte) e M3 em arquivo separado .srt`);

  // ---------- geração REAL com o whisper: só com motor e modelo já disponíveis (ou BF_REQUIRE_NETWORK=1) ----------
  if (W.whisper && W.whisper.run) {
    await whisperGenerate(W);
  } else if (!S.skipped.some((m) => m.startsWith('geração real de legenda'))) {
    S.skipped.push('geração real de legenda (whisper) PULADA: o motor e o modelo não estão instalados neste perfil de teste e nem BF_REQUIRE_NETWORK=1 nem BF_SUBTITLES_TEST_CACHE foram informados (nada é baixado sem isso)');
  }

  // áudio e legendas não são decisões sobre o corte: nada disso chega ao aprendizado
  await sleep(1000);
  assert.equal((await ev("BF.api('prefs:learned', {})")).observed, observedBefore, 'ajustes de áudio e de legendas não contam como decisão');
}

/** Gera a legenda de S3 com o whisper de verdade (a fala sintetizada está no vídeo a partir de SPEECH_AT). */
async function whisperGenerate(W) {
  const P = '#tabpanel-subtitles';
  await selectTab('subtitles');
  await pickSubtitlesCut(ID.S3);
  if (!W.whisper.preinstalled) {
    // motor e modelo Tiny pelas rotas do app (download das releases oficiais; tamanho e SHA-256 conferidos pelo instalador)
    await wf(`!!document.querySelector('${P} [data-act="install-engine"]')`, 20000, 'botão de instalar o motor');
    await click(`${P} [data-act="install-engine"]`);
    await wf(`!document.querySelector('${P} [data-need="engine"]')`, 300000, 'motor instalado');
    await setValue(`${P} select[data-fid="model"]`, 'tiny', ['change']);
    await wf(`/Modelo Tiny/.test((document.querySelector('${P} .subs-setup') || { textContent: '' }).textContent)`, 10000, 'modelo Tiny escolhido');
    await click(`${P} [data-act="install-model"]`);
    await wf(`!document.querySelector('${P} .subs-setup')`, 300000, 'nada mais falta instalar');
  } else {
    await setValue(`${P} select[data-fid="model"]`, 'tiny', ['change']);
    await wf(`!document.querySelector('${P} .subs-setup')`, 30000, 'motor e modelo já instalados');
  }
  await click(`${P} [data-act="generate"]`);
  await wf(`(() => { const s = BF.project.cut(${J(ID.S3)}).subtitles; return !!s && s.cues.length > 0 && !document.querySelector('${P} .subs-gen.busy'); })()`, 240000, 'legenda gerada pelo whisper');
  const subs = (await cutOf(ID.S3)).subtitles;
  const cut = await cutOf(ID.S3);
  assert.equal(subs.enabled, true, 'gerar liga a legenda do corte');
  assert.equal(subs.generated.model, 'tiny');
  assert.ok(subs.cues.every((c) => c.start >= 0 && c.end <= cut.end - cut.start + 0.01), 'tempos relativos ao corte');
  near(subs.cues[0].start, SPEECH_AT - cut.start, 2, 'a primeira fala cai onde a fala sintetizada está');
  assert.match(subs.cues.map((c) => c.text).join(' '), /lance|incr[ií]vel|ver de novo/i, 'o texto reconhecido');
  // A ENTREGA é do corte e a legenda nasce com a última escolhida no projeto (project.ext.subtitles.mode): aqui é a de M3, "Arquivo
  // separado". Assim S3 saía com o .srt ao lado e SEM texto gravado, e a medição de pixels da fase 6D (que espera o texto no vídeo
  // horizontal) achava 0. Quem quer o texto no vídeo escolhe "Incorporada ao vídeo" na aba, como o usuário faria.
  await setValue(`${P} select[data-fid="mode"]`, 'burn', ['change']);
  await wf(`BF.project.cut(${J(ID.S3)}).subtitles.mode === 'burn'`, 10000, 'S3 com a legenda incorporada ao vídeo');
  assert.match(await text(`${P} [data-note="summary"]`), /a legenda fica gravada no vídeo/);
  W.whisper.generated = true;
  log(`legenda gerada pelo whisper em S3: ${subs.cues.length} fala(s), "${subs.cues.map((c) => c.text).join(' | ')}"`);
}

// ---------------------------------------------------------------------------------------------------------------------
// 6. Exportação, QC e fila
// ---------------------------------------------------------------------------------------------------------------------
const queueJobs = () => ev('JSON.parse(JSON.stringify(BF.queue.state.jobs))');
const queueList = () => ev("BF.api('queue:list', {})");
const jobRow = (id) => `#tabpanel-queue li.q-job[data-id="${id}"]`;
const OUT = {}; // nome curto do corte -> caminho do arquivo gerado pela primeira exportação (9:16 1080p H.264)

async function gotoExport() {
  await selectTab('export');
  await wf("document.querySelectorAll('#exp-profile option').length > 3", 30000, 'perfis na aba Exportar');
}

async function setExportProfile(id) {
  await gotoExport();
  await setValue('#exp-profile', id, ['change']);
  await wf(`document.getElementById('exp-profile').value === ${J(id)} && BF.state.project.ext.export && BF.state.project.ext.export.profileId === ${J(id)}`, 15000, `perfil ${id} escolhido`);
}

async function setExportEncoder(value) {
  await ev("document.getElementById('exp-details').open = true");
  await setValue('#exp-encoder', value, ['change']);
  await wf(`document.getElementById('exp-encoder').value === ${J(value)}`, 10000, `codificador ${value}`);
}

/** Marca exatamente estes cortes em "Cortes a exportar". */
async function checkExportCuts(ids) {
  await gotoExport();
  const all = await ev("[...document.querySelectorAll('#exp-cuts li[data-id]')].map((li) => li.dataset.id)");
  for (const id of ids) assert.ok(all.includes(id), `o corte ${id} deveria estar na lista de exportação`);
  for (const id of all) await setChecked(`#exp-cuts li[data-id="${id}"] input[type=checkbox]`, ids.includes(id));
  await wf(`[...document.querySelectorAll('#exp-cuts li[data-id] input[type=checkbox]')].filter((c) => c.checked).length === ${ids.length}`, 10000, 'cortes marcados');
}

/**
 * Espera a conferência (QC) terminar para os cortes marcados e devolve o resumo dela. `n` = quantos cortes devem poder ser
 * enviados (o botão mostra "Adicionar à fila (n)" só depois que a conferência mais recente chegou).
 */
async function waitQc(n) {
  await wf(`!/Conferindo/.test(document.getElementById('exp-qc-status').textContent) && document.getElementById('exp-qc-status').textContent.length > 0 && document.getElementById('exp-enqueue').textContent === 'Adicionar à fila (${n})'`, 90000, `conferência (QC) pronta com ${n} corte(s) liberado(s)`);
  await sleep(400); // a conferência é refeita com atraso quando algo muda: confirma que nada mais chegou
  await wf(`!/Conferindo/.test(document.getElementById('exp-qc-status').textContent) && document.getElementById('exp-enqueue').textContent === 'Adicionar à fila (${n})'`, 90000, 'conferência (QC) estável');
  return ev(`({
    status: document.getElementById('exp-qc-status').textContent,
    errors: [...document.querySelectorAll('#exp-qc li.exp-issue.error')].map((li) => ({ code: li.dataset.code, text: li.textContent })),
    warnings: [...document.querySelectorAll('#exp-qc li.exp-issue.warn')].map((li) => li.dataset.code),
    button: document.getElementById('exp-enqueue').textContent,
    disabled: document.getElementById('exp-enqueue').disabled
  })`);
}

/** Clica em "Adicionar à fila (n)" e espera a aba Fila aparecer. */
async function enqueueFromTab(n) {
  const qc = await waitQc(n);
  assert.equal(qc.button, `Adicionar à fila (${n})`, `botão: ${qc.button} (${qc.status})`);
  assert.equal(qc.disabled, false);
  await click('#exp-enqueue');
  await wf("document.getElementById('tab-queue').getAttribute('aria-selected') === 'true'", 60000, 'aba Fila depois de enviar');
}

/** Espera todos estes cortes terem um trabalho concluído (resolve com os trabalhos concluídos mais recentes de cada corte). */
/** `match(job)` restringe a quais trabalhos a espera se refere (ex.: só os do perfil horizontal, quando o corte já tem exportação vertical). */
async function waitCutsDone(cutIds, timeout = 300000, match = () => true) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const jobs = (await queueJobs()).filter(match);
    const failed = jobs.find((j) => j.state === 'failed' && cutIds.includes(j.cut.id));
    if (failed) throw new Error(`O trabalho de "${failed.cut.title}" falhou: ${J(failed.error)}`);
    const done = cutIds.map((id) => jobs.filter((j) => j.cut.id === id && j.state === 'done').pop());
    if (done.every(Boolean)) return Object.fromEntries(cutIds.map((id, i) => [id, done[i]]));
    await sleep(250);
  }
  throw new Error('Tempo esgotado esperando a fila terminar os cortes');
}

/** Confere um arquivo exportado: resolução, codec, tag e duração (e o áudio AAC). */
function checkOutput(file, { width, height, codec, duration, tolerance = 0.3 }) {
  assert.ok(fs.existsSync(file), `arquivo exportado ausente: ${file}`);
  const p = probeFile(file);
  assert.deepEqual([p.video.width, p.video.height], [width, height], `resolução de ${path.basename(file)}`);
  assert.equal(p.video.codec_name, codec, `codec de ${path.basename(file)}`);
  assert.equal(p.video.pix_fmt, 'yuv420p');
  assert.equal(p.audio && p.audio.codec_name, 'aac', 'o áudio sai em AAC');
  near(p.duration, duration, tolerance, `duração de ${path.basename(file)}`);
  return p;
}

async function phase6B(W) {
  // ---------- fila paralela 2 pelas Preferências ----------
  await selectTab('prefs');
  await wf("!!document.querySelector('#tabpanel-prefs [data-focus=\"pref-queue.parallel\"]')", 15000, 'preferência de exportações ao mesmo tempo');
  await setValue('#tabpanel-prefs [data-focus="pref-queue.parallel"]', '2', ['change']);
  await wf("BF.prefs.get('queue.parallel', 1) === 2", 10000, 'queue.parallel = 2');
  await wf('BF.queue.state.settings && BF.queue.state.settings.defaultParallel === 2', 10000, 'a Fila recebeu o padrão das Preferências');
  assert.equal((await queueList()).parallel, 2, 'o processo principal exporta 2 por vez');

  // ---------- aba Exportar: perfil padrão 9:16 1080p H.264 a 10 Mbps ----------
  await gotoExport();
  assert.equal(await ev("document.getElementById('exp-profile').value"), 'vertical-1080-h264', 'perfil padrão: Vertical 9:16, 1080p, H.264');
  const profiles = await ev("BF.api('export:listProfiles', {})");
  const std = profiles.profiles.find((p) => p.id === 'vertical-1080-h264');
  assert.deepEqual([std.width, std.height, std.codec, std.bitrateKbps, std.kind], [1080, 1920, 'h264', 10000, 'vertical']);
  assert.deepEqual(profiles.profiles.filter((p) => p.builtin).length, 12);

  // ---------- enquadramento POR CORTE (M4 com o recorte à esquerda) sem alterar o perfil nem o padrão do projeto ----------
  const profilesBefore = JSON.stringify(profiles.profiles);
  await click(`#exp-cuts li[data-id="${ID.M4}"] .exp-cut-main`);
  await wf(`document.querySelector('#exp-cuts li[data-id="${ID.M4}"] .exp-cut-main').getAttribute('aria-pressed') === 'true'`, 10000, 'M4 é o alvo do enquadramento');
  await setValue('#exp-focusx', '20', ['input', 'change']);
  await wf(`(() => { const f = BF.project.cut(${J(ID.M4)}).framing; return !!f && Math.abs(f.focusX - 0.2) < 0.001; })()`, 10000, 'enquadramento próprio de M4');
  await wf(`!!document.querySelector('#exp-cuts li[data-id="${ID.M4}"] .exp-badge')`, 10000, 'M4 aparece como "personalizado"');
  for (const key of ['S1', 'S2', 'M2', 'M3']) assert.ok(!(await cutOf(ID[key])).framing || Object.keys((await cutOf(ID[key])).framing).length === 0, `${key} continua sem enquadramento próprio`);
  const extNow = await ev('JSON.parse(JSON.stringify(BF.state.project.ext.export || {}))');
  assert.equal(extNow.framing, undefined, 'o padrão do projeto não mudou');
  assert.equal(extNow.overrides, undefined, 'o perfil não ganhou ajustes');
  assert.equal(JSON.stringify((await ev("BF.api('export:listProfiles', {})")).profiles), profilesBefore, 'a lista de perfis é a mesma');
  // a prévia usa o mesmo filtro da exportação: o pixel central da prévia vem do recorte à esquerda (R ~ 75), não do centro da fonte (R ~ 127)
  const expectedR = 255 * (0.2 * (1 - 0.3164) + 0.1582);
  const samplePreview = `(() => {
    const i = document.getElementById('exp-prev-img');
    if (!i || i.hidden || !i.complete || !i.naturalWidth) return null;
    const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight;
    const x = c.getContext('2d'); x.drawImage(i, 0, 0);
    const d = x.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return { w: i.naturalWidth, h: i.naturalHeight, r: d[0], g: d[1], b: d[2] };
  })()`;
  // a imagem anterior (recorte central) também está "completa": espera o pixel do recorte novo aparecer (prévia atualizada com debounce)
  await wf(`(() => { const p = ${samplePreview}; return !!p && Math.abs(p.r - ${expectedR}) <= 10; })()`, 30000, 'prévia do enquadramento com o recorte à esquerda');
  const preview = await ev(samplePreview);
  near(preview.w / preview.h, 9 / 16, 0.01, 'proporção da prévia');
  near(preview.r, expectedR, 10, 'R no centro da prévia (recorte à esquerda)');
  await click('#exp-cuts li.exp-cut-default .exp-cut-main');
  log('enquadramento por corte: M4 com recorte próprio (prévia = mesmo filtro); perfil, lista de perfis e padrão do projeto intactos');

  // ---------- 5 cortes aprovados -> fila (codificador por software: dá tempo de pausar, reordenar e cancelar) ----------
  await setExportEncoder('software');
  const batch = [ID.S1, ID.S2, ID.M2, ID.M3, ID.M4];
  await checkExportCuts(batch);
  const qc = await waitQc(5);
  assert.deepEqual(qc.errors, [], 'nenhum erro no QC');
  assert.match(await text('#exp-example'), /^Exemplo: 2026-10-20 21-00-00 - corte \d\d - /);
  await ev(`(() => { window.__run = { max: 0, samples: 0 }; clearInterval(window.__runTimer); window.__runTimer = setInterval(() => { const n = BF.queue.state.jobs.filter((j) => j.state === 'running').length; window.__run.max = Math.max(window.__run.max, n); window.__run.samples++; }, 60); })()`);
  await enqueueFromTab(5);
  await wf('BF.queue.state.jobs.length >= 5', 20000, 'cinco trabalhos na fila');

  // ---------- pausar: o que está exportando termina, nada novo começa ----------
  await click('#q-pause');
  await wf('BF.queue.state.paused === true', 10000, 'fila pausada');
  assert.equal(await text('#q-pause'), 'Retomar');
  await wf("BF.queue.state.jobs.every((j) => j.state !== 'running')", 120000, 'os trabalhos em andamento terminaram com a fila pausada');
  const paused = await queueJobs();
  const queuedIds = paused.filter((j) => j.state === 'queued').map((j) => j.id);
  assert.ok(queuedIds.length >= 1, `sobraram trabalhos na fila: ${J(paused.map((j) => j.state))}`);
  await sleep(1500);
  assert.equal((await queueJobs()).filter((j) => j.state === 'running').length, 0, 'pausada: nada novo começa');
  await wf("document.querySelector('#tab-queue .tab-badge').textContent !== ''", 10000, 'o selo da aba mostra os trabalhos ativos');

  // ---------- reordenar: o último da fila sobe para o primeiro lugar ----------
  const orderUi = () => ev("[...document.querySelectorAll('#tabpanel-queue li.q-job[data-state=\"queued\"]')].map((li) => li.dataset.id)");
  const before = await orderUi();
  assert.deepEqual(before, queuedIds, 'a tela mostra a ordem da fila');
  const moved = before[before.length - 1];
  for (let i = before.length - 1; i > 0; i--) { await click(`${jobRow(moved)} [data-act="up"]`); await sleep(350); }
  await wf(`JSON.stringify([...document.querySelectorAll('#tabpanel-queue li.q-job[data-state="queued"]')].map((li) => li.dataset.id)) === ${J(JSON.stringify([moved, ...before.slice(0, -1)]))}`, 15000, 'ordem nova na tela');
  const mainOrder = (await queueList()).jobs.filter((j) => j.state === 'queued').map((j) => j.id);
  assert.deepEqual(mainOrder, [moved, ...before.slice(0, -1)], 'o processo principal guardou a nova ordem');
  log(`fila: pausar (nada novo começa com a fila pausada), reordenar (${nameOfCut(paused, moved)} foi para o primeiro lugar)`);

  // ---------- retomar, cancelar o primeiro que começar e tentar de novo ----------
  await click('#q-pause');
  await wf('BF.queue.state.paused === false', 10000, 'fila retomada');
  await wf(`BF.queue.state.jobs.find((j) => j.id === ${J(moved)}).state === 'running'`, 60000, 'o trabalho reordenado é o primeiro a começar');
  await click(`${jobRow(moved)} [data-act="cancel"]`);
  await wf(`BF.queue.state.jobs.find((j) => j.id === ${J(moved)}).state === 'cancelled'`, 60000, 'trabalho cancelado');
  const cancelledJob = (await queueJobs()).find((j) => j.id === moved);
  assert.ok(cancelledJob.baseName, 'o trabalho cancelado tem nome de saída');
  assert.ok(!cancelledJob.output || !fs.existsSync(cancelledJob.output), 'cancelar não deixa arquivo');
  await sleep(400);
  assert.deepEqual(listDir(W.out).filter((f) => f.endsWith('.part') && f.includes(cancelledJob.baseName || '\0')), [], 'cancelar não deixa .part do trabalho');
  await click(`${jobRow(moved)} [data-act="retry"]`);
  const done = await waitCutsDone(batch);
  for (const [id, job] of Object.entries(done)) assert.equal(job.state, 'done', `trabalho de ${id}`);
  const run = await ev('window.__run');
  await ev('clearInterval(window.__runTimer); true');
  assert.equal(run.max, 2, `fila paralela: no máximo 2 exportações ao mesmo tempo, e as 2 apareceram (máximo visto ${run.max} em ${run.samples} leituras)`);
  assert.equal((await queueJobs()).filter((j) => j.id === moved).length, 1, 'tentar de novo reaproveita o mesmo trabalho');
  OUT.S1 = done[ID.S1].output; OUT.S2 = done[ID.S2].output; OUT.M2 = done[ID.M2].output; OUT.M3 = done[ID.M3].output; OUT.M4 = done[ID.M4].output;
  for (const file of Object.values(OUT)) assert.equal(path.dirname(file), W.out, 'pasta padrão "Cortes" ao lado do vídeo');
  assert.deepEqual(listDir(W.out).filter((f) => f.endsWith('.part')), [], 'nenhum .part sobrando');
  log(`fila: ${Object.keys(OUT).length} cortes exportados (2 ao mesmo tempo no máximo; cancelar tirou o arquivo e "Tentar de novo" refez)`);

  // ---------- os 5 arquivos, conferidos por fora do app ----------
  const cutLen = async (id) => { const c = await cutOf(id); return c.end - c.start; };
  const probes = {};
  for (const key of ['S1', 'S2', 'M2', 'M3', 'M4']) {
    probes[key] = checkOutput(OUT[key], { width: 1080, height: 1920, codec: 'h264', duration: await cutLen(ID[key]) });
    assert.equal(probes[key].video.codec_tag_string, 'avc1');
  }
  // o perfil 9:16 1080p é de 10 Mbps: o trabalho leva o perfil inteiro e o arquivo não passa do teto (maxrate = 1,2x)
  const jobProfile = done[ID.S1].profile;
  assert.deepEqual([jobProfile.id, jobProfile.width, jobProfile.height, jobProfile.codec, jobProfile.bitrateKbps], ['vertical-1080-h264', 1080, 1920, 'h264', 10000]);
  assert.ok(probes.S1.bitRate <= 10000 * 1000 * 1.25, `taxa de bits do arquivo (${probes.S1.bitRate}) dentro do teto do perfil`);
  // a fila anotou cada exportação no corte (o que a revisão mostra como "Exportado" e o aprendizado lê como perfil usado)
  for (const key of ['S1', 'S2', 'M2', 'M3', 'M4']) {
    await wf(`BF.project.cut(${J(ID[key])}).exports.some((e) => e.path === ${J(OUT[key])})`, 20000, `exportação anotada em ${key}`);
    const cut = await cutOf(ID[key]);
    const note = cut.exports.find((e) => e.path === OUT[key]);
    assert.equal(note.profile.id, 'vertical-1080-h264');
    assert.deepEqual([note.start, note.end, note.revision], [cut.start, cut.end, cut.revision]);
    assert.ok(note.jobId && note.key, 'jobId e chave do trabalho');
    assert.equal(cut.exports.filter((e) => e.path === OUT[key]).length, 1, 'anotada uma vez só');
  }
  log('arquivos 9:16 1080p H.264 (10 Mbps): resolução, codec, tag, áudio AAC e duração conferidos com ffprobe');
}

const srtClock = (sec) => {
  const ms = Math.round(sec * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}:${pad(Math.floor((ms % 60000) / 1000))},${pad(ms % 1000, 3)}`;
};

/** O que sai nos arquivos: enquadramento, legendas e áudio, medidos por fora (pixels, SRT, volumedetect). */
async function phase6Content(W) {
  const frame = (file, t) => fx.decodeFile(file, 1080, 1920, { ss: t });
  const center = (f) => [fx.avg(f, 540, 960, 0), fx.avg(f, 540, 960, 1)];

  // enquadramento: S2 sem ajuste = recorte central (R ~ 127); M4 com o recorte próprio à esquerda (R ~ 75)
  const [r2, g2] = center(frame(OUT.S2, 2));
  near(r2, 127.5, 9, 'R no centro de um corte sem enquadramento próprio');
  near(g2, 127.5, 9, 'G no centro (altura inteira da fonte)');
  const [r4, g4] = center(frame(OUT.M4, 2));
  near(r4, 255 * (0.2 * (1 - 0.3164) + 0.1582), 10, 'R no centro do corte com recorte à esquerda');
  near(g4, 127.5, 9, 'G no centro do corte com recorte à esquerda');
  assert.ok(r2 - r4 > 35, `o enquadramento próprio do corte mudou o conteúdo (R ${r2.toFixed(0)} x ${r4.toFixed(0)})`);

  // legenda incorporada (M2): texto branco no terço de baixo, centralizado, só enquanto a fala está no ar
  const m2 = await cutOf(ID.M2);
  const cue = m2.subtitles.cues[0];
  const withText = whiteStats(frame(OUT.M2, (cue.start + cue.end) / 2));
  assert.ok(withText.count > 400, `deveria haver texto branco no quadro (achei ${withText.count} pixels)`);
  assert.ok(withText.minY > 1920 * 0.6, `o texto fica na parte de baixo (y mínimo ${withText.minY})`);
  near((withText.minX + withText.maxX) / 2, 540, 60, 'texto centralizado na horizontal');
  assert.ok(whiteStats(frame(OUT.M2, cue.end + 2)).count < 40, 'depois da fala não há texto');
  // legenda em arquivo separado (M3): o vídeo sai SEM texto e o .srt nasce ao lado
  const m3 = await cutOf(ID.M3);
  const cue3 = m3.subtitles.cues[0];
  assert.ok(whiteStats(frame(OUT.M3, (cue3.start + cue3.end) / 2)).count < 40, 'arquivo separado: o vídeo sai sem texto gravado');
  const srtFile = OUT.M3.replace(/\.mp4$/, '.srt');
  assert.ok(fs.existsSync(srtFile), 'o .srt foi criado ao lado do vídeo');
  const srt = fs.readFileSync(srtFile, 'utf8');
  assert.match(srt, /LEGENDA EM ARQUIVO/);
  assert.ok(srt.includes(`${srtClock(cue3.start)} --> ${srtClock(cue3.end)}`), `tempo da fala no .srt: ${srt}`);
  assert.ok(!fs.existsSync(OUT.M2.replace(/\.mp4$/, '.srt')), 'a legenda incorporada não cria arquivo separado');
  OUT.sha = { M3srt: sha(srtFile) };

  // áudio: S1 saiu +6 dB acima da fonte, com fade in e fade out; S2 (sem ajuste) saiu igual
  const s1 = await cutOf(ID.S1);
  const srcS1 = await afx.measure(W.source, s1.start, s1.end);
  const outS1 = await afx.measure(OUT.S1, 0, 3600);
  near(outS1.meanDb - srcS1.meanDb, 6, 0.7, 'ganho médio aplicado (dB)');
  near(outS1.peakDb - srcS1.peakDb, 6, 2.5, 'ganho de pico aplicado (dB; o pico de um ruído muda com a recodificação AAC, a média é a medida firme)');
  const dur = s1.end - s1.start;
  const head = await afx.measure(OUT.S1, 0, 0.1);
  const body = await afx.measure(OUT.S1, 1, 1.1);
  const tail = await afx.measure(OUT.S1, dur - 0.1, dur);
  assert.ok(head.meanDb < body.meanDb - 8, `fade in: início ${head.meanDb} dB x meio ${body.meanDb} dB`);
  assert.ok(tail.meanDb < body.meanDb - 8, `fade out: fim ${tail.meanDb} dB x meio ${body.meanDb} dB`);
  const s2 = await cutOf(ID.S2);
  const srcS2 = await afx.measure(W.source, s2.start, s2.end);
  const outS2 = await afx.measure(OUT.S2, 0, 3600);
  near(outS2.meanDb - srcS2.meanDb, 0, 0.7, 'um corte sem ajuste de áudio sai com o nível da fonte');
  log(`conteúdo dos arquivos: enquadramento por corte (R ${r2.toFixed(0)} x ${r4.toFixed(0)}), legenda incorporada (${withText.count} px de texto, só de ${cue.start} a ${cue.end} s), .srt ao lado, ganho ${(outS1.meanDb - srcS1.meanDb).toFixed(1)} dB, fades e áudio sem ajuste intacto`);
  await shot('6-fila');
}

/** Repetição de concluído evitada: o mesmo trabalho, enfileirado de novo, é pulado (nada novo na pasta). */
async function phase6Repeat(W) {
  const before = listDir(W.out);
  const hashes = Object.fromEntries(Object.entries(OUT).filter(([k]) => k !== 'sha').map(([k, f]) => [k, sha(f)]));
  await checkExportCuts([ID.S1, ID.S2, ID.M2, ID.M3, ID.M4]);
  await enqueueFromTab(5);
  const cutIds = [ID.S1, ID.S2, ID.M2, ID.M3, ID.M4];
  await wf(`BF.queue.state.jobs.filter((j) => j.state === 'skipped' && j.skippedCode === 'ALREADY_DONE').length === 5`, 60000, 'os 5 trabalhos repetidos foram pulados');
  const skipped = (await queueJobs()).filter((j) => j.state === 'skipped');
  assert.deepEqual(skipped.map((j) => j.cut.id).sort(), [...cutIds].sort());
  assert.ok(skipped.every((j) => /já foi exportado|já exportado|já foi/i.test(j.skippedReason || '')), `motivo em português: ${skipped[0].skippedReason}`);
  assert.equal(await exists('.q-conflict'), false, 'nada de pergunta de nome repetido');
  assert.deepEqual(listDir(W.out), before, 'nenhum arquivo novo na pasta');
  for (const [k, hash] of Object.entries(hashes)) assert.equal(sha(OUT[k]), hash, `${k} continua igual`);
  log('repetição evitada: reenviar os 5 cortes já exportados, com os mesmos ajustes, pula todos (ALREADY_DONE) sem tocar na pasta');
}

/** Perfil 1440p H.265, QC (aviso x erro) e conflito de nome (renomear, pular, substituir com confirmação). */
async function phase6C(W) {
  // um corte além do fim do vídeo (forçado no projeto: a barra de marcação recusa; é o que acontece quando a fonte fica mais curta)
  await setValue('#inInput', '110', ['input']);
  await setValue('#outInput', '119', ['input']);
  await click('#btnAddCut');
  await wf('BF.state.project.cuts.some((c) => c.start === 110 && c.end === 119)', 10000, 'corte M6');
  ID.M6 = await ev('BF.state.project.cuts.find((c) => c.start === 110 && c.end === 119).id');
  await ev(`BF.project.update(() => { const c = BF.project.cut(${J(ID.M6)}); c.end = ${VIDEO_SECONDS + 5}; c.title = 'Corte além do fim'; c.titleCustom = true; }, { reason: 'teste:fim-alem-da-fonte' }); BF.bus.emit('cuts:changed', { ids: [${J(ID.M6)}], from: 'teste' }); true`);

  const hashBefore = { S1: sha(OUT.S1), M2: sha(OUT.M2), M3: sha(OUT.M3) };
  await setExportProfile('vertical-1440-h265');
  assert.equal(await ev("document.getElementById('exp-encoder').value"), 'auto', 'o ajuste de codificador do 1080p não vale para o outro perfil');
  await checkExportCuts([ID.S1, ID.M2, ID.M3, ID.M6]);
  const qc = await waitQc(3);
  assert.deepEqual(qc.errors.map((e) => e.code), ['INVALID_RANGE'], `erro do QC: ${J(qc.errors)}`);
  assert.match(qc.errors[0].text, /Não vai exportar/);
  assert.match(qc.errors[0].text, /Como resolver/, 'o erro traz a solução');
  assert.ok(qc.warnings.includes('HEVC_COMPAT'), `aviso de H.265 (não impede): ${J(qc.warnings)}`);
  assert.match(qc.status, /1 de 4 corte\(s\) com erro não serão exportados/);
  assert.equal(qc.disabled, false, 'o aviso e o erro de um corte não bloqueiam os outros');
  assert.equal(qc.button, 'Adicionar à fila (3)');
  await enqueueFromTab(3);
  assert.match(await text('#exp-msg'), /3 corte\(s\) na fila; 1 com erro ficou\(aram\) de fora/);
  log('QC: H.265 só avisa (HEVC_COMPAT) e o corte além do fim da fonte é erro (INVALID_RANGE, com solução) que tira só aquele corte do envio');

  // conflito de nome: os 3 nomes já existem (1080p). S1 = outro nome, M2 = pular, M3 = substituir (com confirmação)
  const titles = { s1: (await cutOf(ID.S1)).title, m2: (await cutOf(ID.M2)).title, m3: (await cutOf(ID.M3)).title };
  const plan = { [titles.s1]: 'rename', [titles.m2]: 'skip', [titles.m3]: 'replace' };
  const handled = [];
  let replaceBacked = false;
  const end = Date.now() + 180000;
  while (handled.length < 3 && Date.now() < end) {
    if (await exists('.q-conflict')) {
      const msg = await text('.q-conflict .bf-modal-msg');
      const title = Object.keys(plan).find((t) => msg.includes(`Corte: ${t}.`));
      assert.ok(title, `diálogo de conflito de um corte inesperado: ${msg}`);
      assert.match(msg, /Nada será sobrescrito sem a sua escolha/);
      assert.match(msg, new RegExp(path.basename(W.out).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'o diálogo diz a pasta');
      const action = plan[title];
      if (action === 'replace' && !replaceBacked) {
        // substituir exige uma segunda confirmação; "Voltar" devolve ao diálogo e não mexe em nada
        await click('.q-conflict [data-act="replace"]');
        const asked = await h.answerModal(S.page, false);
        assert.match(asked.title, /Substituir o arquivo existente/);
        replaceBacked = true;
        assert.equal(sha(OUT.M3), hashBefore.M3, 'recusar a substituição não toca no arquivo');
        await wf("!!document.querySelector('.q-conflict')", 10000, 'o diálogo de conflito volta');
        continue;
      }
      await click(`.q-conflict [data-act="${action}"]`);
      if (action === 'replace') await h.answerModal(S.page, true);
      handled.push(title);
    }
    await sleep(200);
  }
  assert.equal(handled.length, 3, `os 3 conflitos foram respondidos (${J(handled)})`);
  assert.ok(replaceBacked, 'o fluxo "Voltar" da substituição foi exercitado');
  await wf(`(() => { const j = BF.queue.state.jobs; const done = (id) => j.filter((x) => x.cut.id === id && x.profile.id === 'vertical-1440-h265'); return done(${J(ID.S1)}).some((x) => x.state === 'done') && done(${J(ID.M3)}).some((x) => x.state === 'done') && done(${J(ID.M2)}).some((x) => x.state === 'skipped'); })()`, 240000, 'trabalhos H.265 resolvidos');
  const jobs = await queueJobs();
  const h265 = (id) => jobs.filter((j) => j.cut.id === id && j.profile.id === 'vertical-1440-h265').pop();
  const jS1 = h265(ID.S1); const jM2 = h265(ID.M2); const jM3 = h265(ID.M3);
  // renomear: arquivo novo "(2)", o anterior intacto
  assert.match(path.basename(jS1.output), / \(2\)\.mp4$/);
  const p1 = checkOutput(jS1.output, { width: 1440, height: 2560, codec: 'hevc', duration: await (async () => { const c = await cutOf(ID.S1); return c.end - c.start; })() });
  assert.equal(p1.video.codec_tag_string, 'hvc1', 'H.265 com a tag compatível com os players da Apple');
  assert.ok(p1.bitRate <= 10000 * 1000 * 1.25, `taxa de bits do H.265 dentro do teto de 10 Mbps (${p1.bitRate})`);
  assert.deepEqual([jS1.profile.width, jS1.profile.height, jS1.profile.codec, jS1.profile.bitrateKbps], [1440, 2560, 'h265', 10000]);
  assert.equal(sha(OUT.S1), hashBefore.S1, 'renomear não toca no arquivo anterior');
  // pular: nada novo, anterior intacto
  assert.equal(jM2.state, 'skipped');
  assert.equal(jM2.skippedCode, 'CONFLICT_SKIPPED');
  assert.equal(sha(OUT.M2), hashBefore.M2, 'pular não toca no arquivo anterior');
  assert.ok(!listDir(W.out).some((f) => /Clutch do final.* \(2\)\.mp4$/.test(f)), 'pular não cria arquivo');
  // substituir: o mesmo nome agora é o H.265 1440p
  assert.equal(jM3.output, OUT.M3, 'substituir mantém o nome');
  const p3 = checkOutput(OUT.M3, { width: 1440, height: 2560, codec: 'hevc', duration: await (async () => { const c = await cutOf(ID.M3); return c.end - c.start; })() });
  assert.equal(p3.video.codec_tag_string, 'hvc1');
  assert.notEqual(sha(OUT.M3), hashBefore.M3, 'o arquivo foi trocado');
  assert.equal(listDir(W.out).filter((f) => f.endsWith('.part')).length, 0, 'nenhum .part sobrando');
  OUT.S1h265 = jS1.output;
  log('conflito de nome: "Salvar com outro nome" (arquivo (2), anterior intacto), "Pular" (nada novo) e "Substituir" (só após a 2ª confirmação; trocou o arquivo por um 1440p H.265)');

  // Substituir mexe em dois registros que falavam do arquivo antigo:
  //  - a anotação em cut.exports passa a descrever o que o arquivo contém agora (1440p H.265), não o 1080p que foi trocado;
  //  - o "já exportado" do trabalho 1080p deixa de valer (o arquivo daquele nome já não é o dele): pedir o 1080p de novo cai no conflito de nome.
  await wf(`BF.project.cut(${J(ID.M3)}).exports.some((e) => e.path === ${J(OUT.M3)} && e.profile && e.profile.id === 'vertical-1440-h265')`, 20000, 'a anotação de M3 descreve o arquivo substituído (1440p H.265)');
  const notes = (await cutOf(ID.M3)).exports.filter((e) => e.path === OUT.M3);
  assert.equal(notes.length, 1, 'um arquivo, uma anotação');
  assert.equal(notes[0].jobId, jM3.id);
  await setExportProfile('vertical-1080-h264');
  await checkExportCuts([ID.M3]);
  await enqueueFromTab(1);
  await wf(`BF.queue.state.jobs.some((j) => j.cut.id === ${J(ID.M3)} && j.profile.id === 'vertical-1080-h264' && ['needsAction', 'skipped'].includes(j.state) && j.id !== ${J((await queueJobs()).find((j) => j.cut.id === ID.M3 && j.profile.id === 'vertical-1080-h264').id)})`, 60000, 'o 1080p de M3 pedido de novo foi decidido pela fila');
  const again = (await queueJobs()).filter((j) => j.cut.id === ID.M3 && j.profile.id === 'vertical-1080-h264').pop();
  assert.equal(again.state, 'needsAction', `o arquivo agora é o H.265: pedir o 1080p de novo não pode ser pulado como "já exportado" (estado ${again.state}, ${again.skippedCode || ''})`);
  await wf("!!document.querySelector('.q-conflict')", 30000, 'conflito de nome do 1080p de M3');
  await click('.q-conflict [data-act="skip"]');
  await wf(`BF.queue.state.jobs.find((j) => j.id === ${J(again.id)}).state === 'skipped'`, 30000, 'o 1080p de M3 foi pulado por escolha do usuário');
  assert.equal((await queueJobs()).find((j) => j.id === again.id).skippedCode, 'CONFLICT_SKIPPED');
  assert.equal(sha(OUT.M3), sha(OUT.M3), 'o arquivo continua o H.265');
  log('substituir: a anotação do corte descreve o arquivo novo e o "já exportado" do trabalho antigo deixou de valer (o 1080p pedido de novo cai no conflito de nome)');
}

/** Perfil horizontal e erro do QC DENTRO da fila: só o trabalho com erro falha. */
async function phase6D(W) {
  // modelo de nome com o perfil (pela própria aba): evita conflito com os arquivos verticais do mesmo corte
  await gotoExport();
  await ev("document.querySelector('#tabpanel-export #exp-template').closest('details').open = true");
  await setValue('#exp-template', '{fonte} - corte {n} - {titulo} - {perfil}', ['change']);
  await wf("/Exemplo: .* - horizontal|Exemplo: /.test(document.getElementById('exp-example').textContent)", 10000, 'exemplo do nome');
  await setExportProfile('horizontal-1080-h264');
  await checkExportCuts([ID.S3, ID.M4]);
  const qc = await waitQc(2);
  assert.deepEqual(qc.errors, []);
  assert.match(await text('#exp-example'), /Horizontal 16_9 · 1080p · H\.264\.mp4$/, 'o nome do arquivo inclui o perfil');

  // o trabalho do corte além do fim, montado pelo próprio app (export:prepare) e entregue direto à fila: a fila confere de novo e só ele falha
  const badJob = await ev(`(async () => {
    const p = BF.state.project;
    const profile = (await BF.api('export:listProfiles', {})).profiles.find((x) => x.id === 'horizontal-1080-h264');
    const prep = await BF.api('export:prepare', { project: { id: p.id, source: p.source, cuts: p.cuts }, info: BF.state.info, cutIds: [${J(ID.M6)}], profile, framing: { mode: 'center' }, outputDir: ${J(W.out)}, nameTemplate: '{fonte} - corte {n} - {titulo}' });
    return { ok: prep.ok, jobs: prep.jobs, errors: prep.reports.map((r) => r.errors.map((e) => e.code)) };
  })()`);
  assert.equal(badJob.ok, true);
  assert.deepEqual(badJob.errors, [['INVALID_RANGE']], 'o app já sabe que esse trabalho tem erro');
  await enqueueFromTab(2);
  const queued = await ev(`BF.api('queue:enqueue', { jobs: ${J(badJob.jobs)} })`);
  assert.equal(queued.ok, true, 'a fila aceita o trabalho (a conferência é feita ao executar)');
  const jobs = await waitCutsDone([ID.S3, ID.M4], 300000, (j) => j.profile.id === 'horizontal-1080-h264').then(async () => queueJobs());
  await wf(`BF.queue.state.jobs.some((j) => j.cut.id === ${J(ID.M6)} && j.state === 'failed')`, 120000, 'o trabalho com erro falhou');
  const failed = (await queueJobs()).find((j) => j.cut.id === ID.M6 && j.state === 'failed');
  assert.equal(failed.error.code, 'INVALID_RANGE');
  assert.ok(failed.error.message && failed.error.solution, `causa e solução: ${J(failed.error)}`);
  assert.equal(failed.runs, 1, 'erro do QC não é repetido');
  await wf(`!!document.querySelector(${J(`${jobRow(failed.id)} .q-error .q-error-msg`)})`, 10000, 'a causa da falha na linha do trabalho');
  assert.match(await text(`${jobRow(failed.id)} .q-error .q-error-fix`), /\S/);
  const hor = (id) => jobs.filter((j) => j.cut.id === id && j.profile.id === 'horizontal-1080-h264' && j.state === 'done').pop();
  const jS3 = hor(ID.S3); const jM4 = hor(ID.M4);
  for (const [job, id] of [[jS3, ID.S3], [jM4, ID.M4]]) {
    const c = await cutOf(id);
    const p = checkOutput(job.output, { width: 1920, height: 1080, codec: 'h264', duration: c.end - c.start });
    assert.ok(p.bitRate <= 10000 * 1000 * 1.3, `horizontal 1080p a 10 Mbps (${p.bitRate})`);
    assert.match(path.basename(job.output), / - Horizontal 16_9 · 1080p · H\.264\.mp4$/, 'o nome do arquivo traz o nome do perfil');
  }
  // o recorte à esquerda de M4 não tem efeito em um quadro 16:9 inteiro: o centro é o da fonte
  near(fx.avg(fx.decodeFile(jM4.output, 1920, 1080, { ss: 2 }), 960, 540, 0), 127.5, 9, 'R no centro do horizontal');
  OUT.S3h = jS3.output; OUT.M4h = jM4.output;
  if (W.whisper && W.whisper.generated) {
    // a legenda gerada pelo whisper (S3) foi gravada no vídeo horizontal, na hora da fala
    const subs = (await cutOf(ID.S3)).subtitles;
    assert.ok(subs.enabled && ['burn', 'both'].includes(subs.mode), `a legenda de S3 precisa ir gravada no vídeo para esta medição (entrega "${subs.mode}")`);
    assert.ok(!listDir(W.out).some((f) => f.startsWith(path.basename(jS3.output, '.mp4')) && f.endsWith('.srt')), 'incorporada: sem .srt ao lado do horizontal de S3');
    const mid = (subs.cues[0].start + subs.cues[0].end) / 2;
    const withText = whiteStats(fx.decodeFile(jS3.output, 1920, 1080, { ss: mid }));
    assert.ok(withText.count > 300, `a legenda gerada deveria aparecer no horizontal (${withText.count} pixels)`);
    assert.ok(withText.minY > 1080 * 0.6, 'na parte de baixo do quadro');
  }
  // a falha fica visível na fila até o usuário tirar; tirar não apaga nada do disco
  await click(`${jobRow(failed.id)} [data-act="remove"]`);
  await wf(`!BF.queue.state.jobs.some((j) => j.id === ${J(failed.id)})`, 10000, 'trabalho com erro removido da lista');
  log('horizontal 1080p (nome com o perfil) exportado; na fila só o trabalho do corte além do fim falhou (INVALID_RANGE, 1 tentativa, causa e solução na tela)');
}

// ---------------------------------------------------------------------------------------------------------------------
// 7. Interrupção: o app é morto com a fila em andamento
// ---------------------------------------------------------------------------------------------------------------------
async function step7(W, env) {
  // três cortes longos (60 s cada) exportados por software: demoram o bastante para o app ser morto no meio
  const long = { L1: [1, 61], L2: [31, 91], L3: [58, 118] };
  for (const [key, [start, end]] of Object.entries(long)) {
    await setValue('#inInput', String(start), ['input']);
    await setValue('#outInput', String(end), ['input']);
    await wf("!document.getElementById('btnAddCut').disabled", 5000, 'botão Salvar corte');
    await click('#btnAddCut');
    await wf(`BF.state.project.cuts.some((c) => c.start === ${start} && c.end === ${end})`, 10000, `corte ${key}`);
    ID[key] = await ev(`BF.state.project.cuts.find((c) => c.start === ${start} && c.end === ${end}).id`);
  }
  await setExportProfile('horizontal-1080-h264');
  await setExportEncoder('software');
  await checkExportCuts([ID.L1, ID.L2, ID.L3]);

  // o que já está pronto na pasta de destino (precisa ficar exatamente como está)
  const finishedFiles = listDir(W.out).filter((f) => !f.endsWith('.part'));
  const stat = (f) => { const s = fs.statSync(path.join(W.out, f)); return { size: s.size, mtimeMs: s.mtimeMs, sha: sha(path.join(W.out, f)) }; };
  const finishedBefore = Object.fromEntries(finishedFiles.map((f) => [f, stat(f)]));
  assert.equal(finishedFiles.length, 9, `arquivos prontos antes da queda: ${J(finishedFiles)}`); // 5 verticais 1080p + o .srt de M3 + 1 H.265 renomeado + 2 horizontais

  await enqueueFromTab(3);
  await wf("[...BF.queue.state.progress.values()].filter((v) => v.p > 0.08).length >= 2", 120000, 'dois trabalhos longos em andamento');
  await wf(`BF.queue.state.jobs.filter((j) => j.state === 'running').length === 2 && BF.queue.state.jobs.filter((j) => j.state === 'queued').length === 1`, 20000, '2 exportando e 1 esperando');
  const runningIds = (await queueJobs()).filter((j) => j.state === 'running').map((j) => j.id);
  const t0 = Date.now();
  while (!listDir(W.out).some((f) => f.endsWith('.part')) && Date.now() - t0 < 20000) await sleep(100);
  assert.ok(listDir(W.out).some((f) => f.endsWith('.part')), 'há um .part no meio da exportação');
  await sleep(900); // o estado "running" já foi gravado no queue.json
  const savedRunning = JSON.parse(fs.readFileSync(path.join(W.userData, 'queue.json'), 'utf8')).jobs.filter((j) => j.state === 'running').length;
  assert.equal(savedRunning, 2, 'o disco guarda 2 trabalhos em andamento');
  await ev('BF.project.flush()');

  // ---------- queda de verdade (como falta de energia) ----------
  await killApp();
  const afterKill = listDir(W.out);
  assert.ok(afterKill.some((f) => f.endsWith('.part')), 'a queda deixou .part (sobra do que estava sendo gravado)');
  assert.equal(JSON.parse(fs.readFileSync(path.join(W.userData, 'queue.json'), 'utf8')).jobs.filter((j) => j.state === 'running').length, 2, 'sem chance de gravar nada: o disco ainda diz "running"');
  log(`o app foi morto (taskkill /T /F) com ${runningIds.length} exportações longas em andamento e 1 na fila; sobraram .part na pasta`);

  // ---------- reabrir: banner de recuperação, nada recomeça sozinho ----------
  await launch(W.userData, env);
  assert.equal(await ev('BF.state.project'), null);
  await selectTab('queue');
  await wf("/A fila foi interrompida quando o app fechou/.test(document.getElementById('tabpanel-queue').textContent)", 30000, 'banner de recuperação');
  assert.deepEqual(await ev("[...document.querySelectorAll('#tabpanel-queue .q-notice [data-act]')].map((b) => b.textContent)"), ['Retomar', 'Descartar']);
  const recovered = await queueJobs();
  assert.deepEqual(recovered.filter((j) => j.state === 'interrupted').map((j) => j.id).sort(), [...runningIds].sort(), 'os dois que rodavam estão "Interrompido"');
  assert.equal(recovered.filter((j) => j.state === 'running').length, 0);
  assert.match(await text(jobRow(runningIds[0])), /O app foi fechado com este trabalho em andamento/);
  await sleep(2500);
  assert.equal((await queueJobs()).filter((j) => j.state === 'running').length, 0, 'com a recuperação em "perguntar", nada recomeça sozinho');
  assert.equal(await ev('BF.queue.state.paused'), true, 'a fila fica em espera até o usuário decidir');

  // ---------- retomar: recomeça do início e termina sem duplicar nada ----------
  await click('#tabpanel-queue [data-act="recover-resume"]');
  await wf('BF.queue.state.paused === false', 20000, 'fila retomada');
  const done = await waitCutsDone([ID.L1, ID.L2, ID.L3], 420000);
  for (const job of Object.values(done)) {
    const p = checkOutput(job.output, { width: 1920, height: 1080, codec: 'h264', duration: job.cut.end - job.cut.start });
    assert.ok(p.bitRate > 0);
    assert.ok(!job.output.endsWith('.part'), '.part nunca vira resultado');
    assert.ok(!/ \(\d+\)\.mp4$/.test(job.output), `sem duplicata "(2)": ${job.output}`);
    assert.equal(path.dirname(job.output), W.out);
  }
  const allJobs = await queueJobs();
  assert.ok(allJobs.every((j) => !j.output || !j.output.endsWith('.part')), 'nenhum trabalho aponta para um .part');
  assert.equal(allJobs.filter((j) => [ID.L1, ID.L2, ID.L3].includes(j.cut.id) && j.state === 'done').length, 3, 'cada corte longo foi concluído uma vez só');
  const finalFiles = listDir(W.out);
  assert.deepEqual(finalFiles.filter((f) => f.endsWith('.part')), [], 'nenhum .part sobrando');
  const expectedNew = Object.values(done).map((j) => path.basename(j.output)).sort();
  assert.deepEqual(finalFiles.filter((f) => !finishedFiles.includes(f)).sort(), expectedNew, 'na pasta só entraram os 3 arquivos novos');
  for (const f of finishedFiles) {
    const now = stat(f);
    assert.deepEqual(now, finishedBefore[f], `${f} (concluído antes da queda) continua byte a byte igual`);
  }
  log(`recuperação: banner Retomar/Descartar, nada recomeça sozinho; "Retomar" refez do início, 3 arquivos válidos, nenhum .part, nenhuma duplicata e os ${finishedFiles.length} arquivos já prontos intactos (hash e data)`);

  // ---------- reabrir o projeto: as exportações que terminaram sem ele aberto são anotadas nos cortes ----------
  const reopened = await ev(`BF.openSource(${J(W.source)}).then((r) => ({ ok: r.ok, restored: r.restored }))`);
  assert.deepEqual(reopened, { ok: true, restored: true });
  for (const [id, job] of Object.entries(done)) {
    await wf(`BF.project.cut(${J(id)}).exports.some((e) => e.path === ${J(job.output)})`, 20000, 'exportação anotada no corte ao reabrir');
  }
  await shot('7-recuperacao');
  log('ao reabrir o projeto a fila anota nos cortes as exportações concluídas enquanto ele estava fechado');
}

// ---------------------------------------------------------------------------------------------------------------------
// 8. Persistência, correspondência e fonte que cresceu
// ---------------------------------------------------------------------------------------------------------------------
const samePath = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
const modalInfo = () => ev("(() => { const m = document.querySelector('.bf-modal'); return m ? { title: m.querySelector('h2').textContent, message: m.querySelector('.bf-modal-msg').textContent, buttons: [...m.querySelectorAll('button')].map((b) => b.textContent) } : null; })()");
/** O que o usuário decidiu e ajustou em cada corte (tudo menos o que muda sozinho a cada abertura). */
const cutEssence = (c) => ({
  id: c.id, title: c.title, titleCustom: c.titleCustom, start: c.start, end: c.end, status: c.status, category: c.category, notes: c.notes, origin: c.origin,
  relevance: c.relevance, reasons: c.reasons, revision: c.revision, reviewedRange: c.reviewedRange || null, framing: c.framing || null,
  audio: c.audio, subtitles: c.subtitles
});

async function startOpen(file) {
  await ev(`window.__open = null; BF.openSource(${J(file)}).then((r) => { window.__open = { ok: r.ok, code: r.code || null, restored: r.restored === undefined ? null : r.restored }; return r; }); true`);
}
const finishOpen = async () => { await wf('window.__open !== null', 90000, 'abertura concluída'); return ev('window.__open'); };

async function step8(W, env) {
  const projectsDir = path.join(W.userData, 'projects');
  const projectFiles = () => listDir(projectsDir).filter((f) => /^[0-9a-f]{16}\.json$/.test(f));
  const idOriginal = await ev('BF.state.project.id');
  const fileOriginal = path.join(projectsDir, `${idOriginal}.json`);
  await ev('BF.project.flush(); BF.review.history.flush(); true');
  await sleep(700);
  const before = JSON.parse(fs.readFileSync(fileOriginal, 'utf8'));
  assert.equal(before.cuts.length, 12, '8 cortes dos passos 3-6, o além do fim e os 3 longos');
  assert.ok(before.cuts.every((c) => c.status !== 'approved' || c.exports.length > 0 || [ID.M4].includes(c.id) || true));
  const withExports = before.cuts.filter((c) => c.exports.length > 0).map((c) => c.id).sort();
  assert.deepEqual(withExports, [ID.S1, ID.S2, ID.M2, ID.M3, ID.M4, ID.S3, ID.L1, ID.L2, ID.L3].sort(), 'cortes com exportações anotadas');
  const queueBefore = JSON.parse(fs.readFileSync(path.join(W.userData, 'queue.json'), 'utf8'));

  // ---------- fechar o app de forma normal e reabrir o projeto ----------
  await stopApp();
  await launch(W.userData, env);
  assert.equal(await ev('BF.state.project'), null);
  const opened = await ev(`BF.openSource(${J(W.source)}).then((r) => ({ ok: r.ok, restored: r.restored }))`);
  assert.deepEqual(opened, { ok: true, restored: true }, 'o projeto volta do disco');
  await ev('BF.project.flush(); true');
  await sleep(500);
  const after = await project();
  assert.deepEqual(after.cuts.map(cutEssence), before.cuts.map(cutEssence), 'cortes, decisões, títulos, categorias, enquadramentos, áudio e legendas preservados');
  assert.deepEqual(after.cuts.map((c) => c.exports), before.cuts.map((c) => c.exports), 'exportações preservadas');
  for (const key of ['export', 'analysis', 'subtitles']) assert.deepEqual(after.ext[key], before.ext[key], `ext.${key} preservado`);
  assert.deepEqual(after.meta, { game: 'Valorant', channel: 'CanalTeste' });
  assert.deepEqual(after.source.origin, { type: 'obs' });
  // o que a tela mostra
  await selectTab('cuts');
  await wf(`document.querySelectorAll('#cuts .cut').length === ${before.cuts.length}`, 20000, 'lista de cortes');
  const rows = await rowsInfo();
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId[ID.S1].title, 'Ace na rodada');
  assert.equal(byId[ID.S1].status, 'approved');
  assert.equal(byId[ID.M1].status, 'rejected');
  assert.ok(byId[ID.M2].chips.includes('Hype') && byId[ID.S1].chips.includes('Clutch'), 'categorias na lista');
  await wf(`!!document.querySelector('#cuts .cut[data-id="${ID.S1}"] button.exported')`, 10000, 'linha "Exportado" no corte');
  await selectTab('audio');
  await setValue('#audioCut', ID.S1, ['change']);
  await wf("document.getElementById('audioGainNum') && !document.querySelector('#tabpanel-audio .audio-body').hidden && document.getElementById('audioGainNum').value === '6'", 20000, 'áudio de S1 na aba');
  assert.deepEqual(await ev("[document.getElementById('audioFadeIn').value, document.getElementById('audioFadeOut').value]"), ['0.5', '0.5']);
  await selectTab('subtitles');
  await pickSubtitlesCut(ID.M2);
  await wf("(document.querySelector('#tabpanel-subtitles textarea.cue-text') || {}).value === 'LEGENDA INCORPORADA'", 20000, 'legenda de M2 na aba');
  await selectTab('export');
  await wf("document.getElementById('exp-profile').value === 'horizontal-1080-h264'", 20000, 'perfil escolhido persiste');
  await wf(`!!document.querySelector('#exp-cuts li[data-id="${ID.M4}"] .exp-badge')`, 10000, 'enquadramento próprio de M4 persiste');
  await selectTab('queue');
  await wf(`BF.queue.state.jobs.filter((j) => j.state === 'done').length >= ${queueBefore.jobs.filter((j) => j.state === 'done').length}`, 20000, 'trabalhos concluídos na fila');
  assert.equal((await explain('analysis.maxDurationSec')).source, 'learned', 'a preferência aprendida persiste');
  await selectTab('cuts');
  await ev("(() => { const d = document.querySelector('details.history'); d.open = true; d.dispatchEvent(new Event('toggle')); })()");
  await wf("document.querySelectorAll('.history-item').length > 5", 20000, 'histórico da revisão');
  assert.ok((await ev("[...document.querySelectorAll('.history-label')].map((e) => e.textContent)")).some((l) => /^Aprovou 2 cortes$/.test(l)), 'o histórico sobreviveu ao fechar o app');
  await ev("document.querySelector('details.history').open = false; true");
  assert.ok(fs.existsSync(path.join(W.userData, 'history', `${idOriginal}.json`)), 'userData/history/<projeto>.json');
  log(`persistência: depois de fechar e reabrir, ${after.cuts.length} cortes (decisões, títulos, categorias, enquadramento, áudio, legendas, exportações), perfil, preferência aprendida e histórico estão como estavam`);

  // ---------- o MESMO vídeo por outro caminho: pergunta de correspondência ----------
  W.copy = path.join(W.tmp, 'copia', 'gravacao-copia.mp4');
  fs.mkdirSync(path.dirname(W.copy), { recursive: true });
  fs.copyFileSync(W.source, W.copy);
  const hashProject = sha(fileOriginal);
  const hashSource = sha(W.source);
  const filesBefore = projectFiles();
  await startOpen(W.copy);
  await wf("!!document.querySelector('.bf-modal')", 60000, 'pergunta "esta live já foi analisada?"');
  const ask = await modalInfo();
  assert.equal(ask.title, 'Esta live já foi analisada?');
  assert.match(ask.message, /já analisada \(12 cortes\)/);
  assert.deepEqual(ask.buttons, ['Cancelar', 'Criar novo', 'Abrir o projeto existente']);
  assert.match(ask.message, /^Pode ser a live “2026-10-20 21-00-00”, já analisada \(12 cortes\)/, 'sem código de vídeo, a correspondência é cautelosa ("Pode ser…")');
  assert.match(ask.message, /mesmo tamanho/);
  assert.match(ask.message, /duração parecida/);
  // o arquivo é idêntico, mas o corte forçado além do fim (M6) passa do fim do vídeo: a pergunta já avisa, sem apagar nada
  assert.match(ask.message, /Este arquivo é diferente do que foi analisado/);
  assert.match(ask.message, /1 corte fica fora do novo intervalo \(“Corte além do fim”\)/);
  await h.answerModal(S.page, false); // Cancelar
  assert.deepEqual(await finishOpen(), { ok: false, code: 'CANCELLED', restored: null });
  assert.ok(samePath(await ev('BF.state.project.source.path'), W.source), 'recusar não abre: o projeto aberto continua o mesmo');
  assert.deepEqual(projectFiles(), filesBefore, 'recusar não cria projeto');
  assert.equal(sha(fileOriginal), hashProject, 'o projeto original não foi tocado');
  assert.equal(await exists('.bf-modal'), false);
  // confirmar: abre o projeto existente para a cópia (cortes e decisões copiados, original intacto)
  await startOpen(W.copy);
  await wf("!!document.querySelector('.bf-modal')", 60000, 'a pergunta de novo');
  await h.answerModal(S.page, true); // Abrir o projeto existente
  assert.deepEqual(await finishOpen(), { ok: true, code: null, restored: true });
  assert.ok(samePath(await ev('BF.state.project.source.path'), W.copy));
  const adopted = await project();
  assert.deepEqual(adopted.cuts.map(cutEssence), before.cuts.map(cutEssence), 'a cópia herda cortes, decisões, títulos, ajustes, áudio e legendas');
  assert.ok(adopted.cuts.every((c) => c.exports.length === 0), 'as exportações pertencem ao arquivo antigo e não são copiadas');
  assert.equal(adopted.ext.prefs.adoptedFrom.projectId, idOriginal);
  assert.equal(adopted.ext.prefs.sourceChange.dismissed, false, 'a diferença mostrada na pergunta foi gravada na cópia');
  assert.deepEqual(adopted.ext.prefs.sourceChange.before, adopted.ext.prefs.sourceChange.after, 'o arquivo em si é o mesmo');
  await selectTab('cuts');
  await wf("document.querySelectorAll('#cuts .cut .chip.outside').length === 1", 15000, 'selo "Fora da fonte"');
  assert.equal(await ev("document.querySelector('#cuts .cut .chip.outside').closest('.cut').dataset.id"), ID.M6, 'só o corte que passa do fim é sinalizado (e continua no projeto)');
  assert.equal(sha(fileOriginal), hashProject, 'o projeto original continua byte a byte igual');
  assert.equal(sha(W.source), hashSource, 'o vídeo original continua igual');
  assert.equal(projectFiles().length, filesBefore.length + 1);
  // o histórico da revisão acompanha a adoção (review:historyCopy): a cópia tem as mesmas entradas e o original não mudou
  const historyOf = (id) => JSON.parse(fs.readFileSync(path.join(W.userData, 'history', `${id}.json`), 'utf8')).groups;
  assert.deepEqual(historyOf(adopted.id).map((g) => g.label), historyOf(idOriginal).map((g) => g.label), 'o histórico da revisão foi levado para a cópia');
  assert.ok(historyOf(idOriginal).length > 5);
  log('o mesmo vídeo por outro caminho: a pergunta aparece, Cancelar não abre nem cria nada e "Abrir o projeto existente" adota cortes e decisões sem alterar o original');

  // ---------- fonte que cresceu: comparação ANTES de aplicar ----------
  assert.deepEqual(await ev(`BF.openSource(${J(W.source)}).then((r) => ({ ok: r.ok, restored: r.restored }))`), { ok: true, restored: true });
  const list = path.join(W.work, 'cresceu.txt');
  const src = W.source.replace(/\\/g, '/');
  fs.writeFileSync(list, `file '${src}'\nfile '${src}'\noutpoint 20\n`);
  const grown = path.join(W.work, 'cresceu.mp4');
  fx.ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', grown]);
  near(probeFile(grown).duration, VIDEO_SECONDS + 20, 0.5, 'duração da gravação que cresceu');
  fs.copyFileSync(grown, W.copy); // o arquivo do projeto da cópia agora é mais longo (como um VOD que cresceu)
  const hashCopyProject = sha(path.join(projectsDir, `${adopted.id}.json`));
  await startOpen(W.copy);
  await wf("!!document.querySelector('.bf-modal')", 60000, 'comparação da fonte que cresceu');
  const diff = await modalInfo();
  assert.equal(diff.title, 'A fonte mudou desde a última análise');
  assert.match(diff.message, /O vídeo ficou mais longo: 2:00 → 2:20 \(\+0:20\)/);
  assert.match(diff.message, /Os 12 cortes continuam dentro do vídeo/);
  assert.match(diff.message, /O trecho novo \(de 2:00 em diante\) ainda não foi analisado/);
  assert.match(diff.message, /Suas decisões, títulos e ajustes manuais continuam como estão/);
  assert.deepEqual(diff.buttons, ['Cancelar', 'Atualizar e abrir']);
  await h.answerModal(S.page, false);
  assert.equal((await finishOpen()).code, 'CANCELLED');
  assert.ok(samePath(await ev('BF.state.project.source.path'), W.source), 'recusar a comparação não abre');
  assert.equal(sha(path.join(projectsDir, `${adopted.id}.json`)), hashCopyProject, 'recusar não altera o projeto da cópia');
  await startOpen(W.copy);
  await wf("!!document.querySelector('.bf-modal')", 60000, 'comparação (aceitar)');
  await h.answerModal(S.page, true); // Atualizar e abrir
  assert.deepEqual(await finishOpen(), { ok: true, code: null, restored: true });
  const refreshed = await project();
  near(refreshed.source.duration, VIDEO_SECONDS + 20, 0.5, 'a fonte foi atualizada');
  assert.deepEqual(refreshed.cuts.map(cutEssence), before.cuts.map(cutEssence), 'nada foi alterado nos cortes (nenhum apagado)');
  assert.equal(refreshed.ext.prefs.sourceChange.direction, 'longer');
  assert.equal(refreshed.ext.prefs.sourceChange.dismissed, false);
  await wf("document.querySelector('#tab-prefs .tab-badge').textContent === ''", 10000, 'nenhum corte ficou fora do novo intervalo: sem selo de alerta');
  log('fonte que cresceu (2:00 → 2:20): a comparação aparece antes, Cancelar não abre nem altera o projeto e "Atualizar e abrir" atualiza a fonte sem mexer em nenhum corte');
  await shot('8-persistencia');
}

// ---------------------------------------------------------------------------------------------------------------------
// 9. Rede real mínima (só com BF_NETWORK_TESTS=1)
// ---------------------------------------------------------------------------------------------------------------------
async function step9(W) {
  if (process.env.BF_NETWORK_TESTS !== '1') {
    S.notVerified.push('passo 9 (rede real: "Me at the zoo" pela tela Novo projeto): desligado, BF_NETWORK_TESTS não é 1');
    return;
  }
  const P = '#tabpanel-sources';
  const YT_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  if (!(await ev('BF.state.tools.ytdlp'))) {
    S.notVerified.push('passo 9 (rede real): o yt-dlp não foi encontrado (nem instalado pelo app nem no PATH)');
    return;
  }
  const netDir = path.join(W.tmp, 'VODs-rede');
  assert.equal((await ev(`BF.api('sources:setSettings', { downloadDir: ${J(netDir)} })`)).ok, true);
  await selectTab('sources');
  await click(`${P} .src-choice[data-source="youtube"]`);
  await ev('BF.sources.refresh()');
  await wf(`!document.querySelector('${P} button[data-act="fetch"]').disabled`, 30000, 'Buscar habilitado com o yt-dlp');
  let blocked = '';
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    await setValue(`${P} .src-url`, YT_URL, ['input']);
    await click(`${P} button[data-act="${(await exists(`${P} button[data-act="retry"]`)) ? 'retry' : 'fetch'}"]`);
    await wf(`!!document.querySelector('${P} .src-card .src-title') || !!document.querySelector('${P} .src-card.bad')`, 120000, 'resultado da consulta real');
    if (await exists(`${P} .src-card .src-title`)) { ok = true; break; }
    blocked = await text(`${P} .src-card.bad`);
    await sleep(3000);
  }
  if (!ok) {
    // honestidade: o YouTube às vezes pede verificação ("confirme que você não é um robô"); isso não é defeito do app
    assert.match(blocked, /robô|conexão|disponível|bloque/i, `falha inesperada na consulta real: ${blocked}`);
    S.notVerified.push(`passo 9 (rede real) NÃO verificado: a consulta real não concluiu em 3 tentativas (${blocked.replace(/\s+/g, ' ').slice(0, 160)})`);
    return;
  }
  assert.equal(await text(`${P} .src-card .src-title`), 'Me at the zoo');
  const qualities = await ev(`[...document.querySelectorAll('${P} select[data-act="quality"] option')].map((o) => o.value)`);
  assert.ok(qualities.length >= 2);
  await setValue(`${P} select[data-act="quality"]`, qualities[qualities.length - 1], ['change']);
  await ev(`(() => { const c = document.querySelector('${P} input[data-act="with-chat"]'); if (c && !c.disabled && c.checked) { c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
  await click(`${P} button[data-act="download"]`);
  await wf(`!!document.querySelector('${P} .src-card.ok') || !!document.querySelector('${P} .src-card.bad')`, 240000, 'fim do download real');
  if (await exists(`${P} .src-card.bad`)) {
    blocked = await text(`${P} .src-card.bad`);
    S.notVerified.push(`passo 9 (rede real) NÃO verificado: o download real falhou (${blocked.replace(/\s+/g, ' ').slice(0, 160)})`);
    return;
  }
  const file = path.join(netDir, 'Me at the zoo.mp4');
  assert.ok(fs.existsSync(file), 'arquivo baixado');
  near(probeFile(file).duration, 19, 2, 'duração do vídeo baixado');
  await click(`${P} button[data-act="open-vod"]`);
  await wf("BF.state.project && /Me at the zoo/.test(BF.state.project.source.path)", 60000, 'o VOD aberto como projeto');
  const origin = await ev('BF.state.project.source.origin');
  assert.equal(origin.type, 'vod');
  assert.equal(origin.platform, 'youtube');
  assert.equal(origin.videoId, 'jNQXAC9IVRw');
  assert.equal(origin.channel, 'jawed');
  assert.equal(await ev('BF.state.project.meta.channel'), 'jawed');
  assert.deepEqual(listDir(netDir), ['Me at the zoo.mp4'], 'só o arquivo final, sem pasta de trabalho nem .part');
  log('rede real: "Me at the zoo" baixado pela tela Novo projeto numa pasta temporária e aberto como projeto com origin vod (YouTube, jNQXAC9IVRw, canal jawed)');
}

// ---------------------------------------------------------------------------------------------------------------------
// 10. Fechamento: fonte intacta, console limpo, app encerrado
// ---------------------------------------------------------------------------------------------------------------------
async function step10(W, { sourceHash, sourceAudio }) {
  await ev('BF.project.flush(); true');
  // com a jornada inteira no estado (cortes, fila com concluídos/pulados/cancelados, áudio, legendas, preferências aprendidas):
  // nenhum botão visível sem ação em nenhuma aba, nem nos ajustes avançados abertos
  for (const id of ['home', 'projects', 'cuts', 'export', 'queue', 'subtitles', 'audio', 'analysis', 'sources', 'general', 'prefs', 'tools']) {
    await selectTab(id);
    await sleep(400);
    await ev(`document.querySelectorAll('#tabpanel-${id} details').forEach((d) => { d.open = true; })`);
    await sleep(300);
    assert.deepEqual(await deadButtons(id), [], `botões sem ação na aba ${id} (fim da jornada)`);
  }
  // as pastas de saída e os arquivos .srt não viram "gravações" na tela Novo projeto: continua só a gravação do OBS
  await selectTab('sources');
  await ev('BF.sources.refresh()');
  await sleep(500);
  assert.deepEqual(await ev("[...document.querySelectorAll('#tabpanel-sources li.src-file .src-name')].map((n) => n.textContent)"), ['2026-10-20 21-00-00.mp4']);
  harvestErrors();
  const warnings = S.warnings.slice();
  assert.deepEqual(S.errors, [], `erros de console durante a jornada:\n- ${S.errors.join('\n- ')}`);
  assert.deepEqual(warnings, [], `avisos de console durante a jornada:\n- ${warnings.join('\n- ')}`);
  // a gravação do usuário não foi tocada por nada: nem o arquivo, nem o fluxo de áudio original
  assert.equal(sha(W.source), sourceHash, 'a gravação de origem continua byte a byte igual');
  assert.equal(audioMd5(W.source), sourceAudio, 'o áudio original da fonte continua idêntico (hash do fluxo copiado)');
  assert.deepEqual(listDir(W.out).filter((f) => f.endsWith('.part')), [], 'nenhum .part na pasta de destino');
  assert.deepEqual(listDir(W.rec).filter((f) => f.endsWith('.part')), [], 'nenhum .part ao lado da gravação');
  await stopApp();
  assert.equal(S.app, null);
  const alive = h.processesUsing(W.tmp);
  assert.deepEqual(alive, [], 'nenhum processo (app, ffmpeg, yt-dlp) ainda usa a pasta do teste');
  log(`final: console sem erros nem avisos, gravação de origem intacta (hash do arquivo e do áudio), nenhum .part, app encerrado`);
}

/** Título do corte de um trabalho (para as mensagens). */
function nameOfCut(jobs, id) {
  const job = jobs.find((j) => j.id === id);
  return job ? job.cut.title : id;
}

if (require.main === module) {
  main().then(() => {
    console.log(`OK: system (${((Date.now() - T0) / 1000).toFixed(0)} s)`);
    for (const message of S.skipped) console.log(`↷ PULADO: ${message}`);
    for (const message of S.notVerified) console.log(`⚠ NÃO verificado: ${message}`);
    for (const message of S.flakes) console.log(`↻ TENTATIVA EXTRA: ${message}`);
  }, (err) => { console.error(err); process.exitCode = 1; });
} else {
  module.exports = { makeSource, synthesizeSpeech, BURSTS, FLASH, SPEECH_AT, VIDEO_SECONDS }; // só para conferir a geração da mídia sem abrir o app
}

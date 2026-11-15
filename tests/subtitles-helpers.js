'use strict';

/**
 * Utilitários dos testes de legendas (tests/subtitles*.test.js e tests/e2e/subtitles.e2e.js): mídia gerada de verdade
 * com o ffmpeg, fala sintetizada pelo Windows (System.Speech), servidor HTTP local e comparação de quadros.
 * Não é um teste: o nome não termina em ".test.js".
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { locateTools } = require('../src/core/ffmpeg/locate');
const { MODELS } = require('../src/core/subtitles/models');

const tools = locateTools();
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function tmpDir(prefix = 'bf-subs-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}

/**
 * Copia uma pasta inteira. (fs.cpSync do Node 24 no Windows não copia nada, sem erro, quando o destino tem caracteres
 * fora do ASCII: por isso a cópia manual.)
 */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

/** Executa o ffmpeg (síncrono) e devolve a saída; lança com o erro do ffmpeg se falhar. */
function ffmpeg(args, opts = {}) {
  try {
    return execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...opts });
  } catch (err) {
    throw new Error(`ffmpeg falhou: ${String((err.stderr || err.message)).slice(0, 800)}`);
  }
}

// ---------- fala sintetizada (Windows) ----------

/** Vozes instaladas no Windows (System.Speech): [{ name, culture }]. Vazio fora do Windows ou sem vozes. */
function listVoices() {
  if (process.platform !== 'win32') return [];
  try {
    const script = "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return out.split(/\r?\n/).filter(Boolean).map((l) => { const [name, culture] = l.split('|'); return { name, culture }; });
  } catch {
    return [];
  }
}

/** Sintetiza `text` com a voz `voice` e grava um WAV em `file`. */
function synthesize(text, voice, file) {
  const esc = (s) => String(s).replace(/'/g, "''");
  const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('${esc(voice)}'); $s.SetOutputToWaveFile('${esc(file)}'); $s.Speak('${esc(text)}'); $s.Dispose()`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 120000 });
  if (!fs.existsSync(file)) throw new Error('A síntese de fala não gerou o arquivo.');
}

// ---------- mídia ----------

/**
 * Vídeo de teste (640x360, 10 fps) com o áudio montado de pedaços: [{ silence: s }, { wav: caminho }, { noise: s, amp }, { tone: s }].
 * `pcm`: áudio sem compressão (use .mkv): o AAC destrói fala muito baixa e o teste seria do AAC, não do app.
 * Devolve { file, duration, parts:[{ start, end, kind }] }. Sem pedaços de áudio, o vídeo não tem faixa de áudio.
 */
function makeVideo(file, pieces, { size = '640x360', noAudio = false, still = false, pcm = false } = {}) {
  const inputs = [];
  const filters = [];
  const parts = [];
  let at = 0;
  pieces.forEach((p, i) => {
    let duration;
    if (p.wav) {
      duration = Number(execFileSync(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p.wav], { encoding: 'utf8', windowsHide: true }).trim());
      inputs.push('-i', p.wav);
      filters.push(`[${i + 1}:a]aresample=16000,aformat=channel_layouts=mono[p${i}]`);
    } else if (p.noise) {
      duration = p.noise;
      inputs.push('-f', 'lavfi', '-i', `anoisesrc=d=${p.noise}:c=pink:r=16000:a=${p.amp || 0.2}`);
      filters.push(`[${i + 1}:a]aformat=channel_layouts=mono[p${i}]`);
    } else if (p.tone) {
      duration = p.tone;
      inputs.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${p.tone}:sample_rate=16000`);
      filters.push(`[${i + 1}:a]aformat=channel_layouts=mono[p${i}]`);
    } else {
      duration = p.silence;
      inputs.push('-f', 'lavfi', '-i', `anullsrc=r=16000:cl=mono`);
      filters.push(`[${i + 1}:a]atrim=0:${duration},asetpts=N/SR/TB[p${i}]`);
    }
    parts.push({ start: at, end: at + duration, kind: p.wav ? 'speech' : (p.noise ? 'noise' : (p.tone ? 'tone' : 'silence')) });
    at += duration;
  });
  const total = Math.ceil(at * 10) / 10;
  // `still`: fundo parado (quadros iguais, para comparar com e sem legenda); senão o padrão de teste animado
  const video = ['-f', 'lavfi', '-i', still ? `color=c=0x202830:s=${size}:r=10:d=${total}` : `testsrc2=size=${size}:rate=10:duration=${total}`];
  if (noAudio || !pieces.length) {
    ffmpeg([...video, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', file]);
  } else {
    const labels = pieces.map((_, i) => `[p${i}]`).join('');
    ffmpeg([...video, ...inputs, '-filter_complex', `${filters.join(';')};${labels}concat=n=${pieces.length}:v=0:a=1[a]`,
      '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', pcm ? 'pcm_s16le' : 'aac', '-shortest', file]);
  }
  return { file, duration: at, parts };
}

/** Quadro (cinza, 8 bits) no tempo `t` de um vídeo, depois do filtro `vf` (opcional). */
function grayFrame(file, t, { vf, width, height } = {}) {
  const args = ['-ss', String(t), '-i', file, ...(vf ? ['-vf', vf] : []), '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'];
  const data = ffmpeg(args);
  if (width && height && data.length !== width * height) throw new Error(`Quadro com tamanho inesperado: ${data.length} bytes (esperado ${width * height})`);
  return data;
}

/** Caixa (retângulo) onde dois quadros cinza diferem mais que `threshold`, ou null se são iguais. */
function diffBox(a, b, width, height, threshold = 24) {
  let minX = width; let minY = height; let maxX = -1; let maxY = -1; let count = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (Math.abs(a[row + x] - b[row + x]) > threshold) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return count ? { x0: minX, y0: minY, x1: maxX, y1: maxY, w: maxX - minX + 1, h: maxY - minY + 1, count } : null;
}

// ---------- servidor local ----------

async function startServer(handler) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => { requests.push({ url: req.url, method: req.method }); handler(req, res, { requests }); });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, requests,
    async close() { for (const s of sockets) s.destroy(); await new Promise((resolve) => server.close(resolve)); }
  };
}

const REV = 'a'.repeat(40);
const REPO = 'ggerganov/whisper.cpp';

/**
 * Servidor que imita a fonte oficial: só o arquivo do modelo, em `/<repo>/resolve/<revisão>/<arquivo>`, com o conteúdo dado.
 * O app NÃO consulta a API da fonte (revisão, tamanho e SHA-256 são fixos no catálogo): qualquer pedido a `/api/` aparece em
 * `hub.requests` e responde 404.
 */
async function fakeHub({ file = 'ggml-tiny-q5_1.bin', data = crypto.randomBytes(300 * 1024), served = null, slow = false, revision = REV } = {}) {
  const body = served || data;
  const server = await startServer((req, res) => {
    if (req.url === `/${REPO}/resolve/${revision}/${file}`) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
      if (!slow) { res.end(body); return; }
      let offset = 0;
      const timer = setInterval(() => {
        if (res.destroyed) { clearInterval(timer); return; }
        res.write(body.subarray(offset, offset + 16 * 1024));
        offset += 16 * 1024;
        if (offset >= body.length) { clearInterval(timer); res.end(); }
      }, 40);
      res.on('close', () => clearInterval(timer));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return { ...server, data, file, revision };
}

/**
 * Catálogo de modelos com o `tiny` fixado nos valores do servidor falso (revisão, tamanho e SHA-256), do mesmo jeito que o
 * catálogo do app fixa os da fonte real. `overrides` muda campos do tiny (ex.: um SHA-256 que o servidor não cumpre).
 */
function pinnedCatalog(hub, overrides = {}) {
  return MODELS.map((m) => (m.id === 'tiny' ? { ...m, revision: hub.revision, sizeBytes: hub.data.length, sha256: sha256(hub.data), ...overrides } : m));
}


/** Lista recursiva (caminhos relativos com "/") para conferir que não sobrou lixo. */
function listTree(root) {
  const out = [];
  const walk = (dir, rel) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of items) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
    }
  };
  walk(root, '');
  return out.sort();
}

/** ipcMain/app/dialog/shell falsos: guardam os handlers para chamá-los direto (como tests/ipc-base.test.js). */
function fakeElectron(userData, extra = {}) {
  const handlers = new Map();
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } };
  const dialogs = { next: { canceled: true, filePaths: [] }, calls: [] };
  const quitListeners = [];
  const silent = { log() {}, info() {}, warn() {}, error() {} };
  const deps = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: () => userData, getVersion: () => '9.9.9', on: (evt, fn) => { if (evt === 'before-quit') quitListeners.push(fn); } },
    dialog: { showOpenDialog: async (_win, opts) => { dialogs.calls.push(opts); return dialogs.next; } },
    shell: {},
    getWindow: () => win,
    logger: silent,
    ...extra
  };
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  return { deps, handlers, sent, dialogs, call, quit: () => quitListeners.forEach((fn) => fn()) };
}

/**
 * Trava entre processos para os testes que rodam o whisper-cli de verdade (subtitles-whisper e subtitles-gpu-real rodam em arquivos
 * paralelos e um conta os whisper-cli.exe do outro como "processo sobrando"). Devolve a função que solta a trava.
 * Trava esquecida (processo morto) vence em 20 min.
 */
async function acquireWhisperLock(timeoutMs = 20 * 60 * 1000) {
  const dir = path.join(os.tmpdir(), 'bf-whisper-real.lock');
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { fs.mkdirSync(dir); return () => { try { fs.rmdirSync(dir); } catch { /* já solta */ } }; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try { if (Date.now() - fs.statSync(dir).mtimeMs > 20 * 60 * 1000) fs.rmdirSync(dir); } catch { /* outro processo soltou */ }
      if (Date.now() > end) throw new Error('trava dos testes do whisper não liberou a tempo');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

module.exports = {
  REV, REPO, fakeHub, pinnedCatalog, copyDir, tools, sha256, tmpDir, cleanup, ffmpeg, listVoices, synthesize, makeVideo, grayFrame, diffBox, startServer, listTree, fakeElectron, acquireWhisperLock
};

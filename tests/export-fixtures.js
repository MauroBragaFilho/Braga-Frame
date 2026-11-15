'use strict';

/**
 * Utilitários dos testes de exportação (tests/export*.test.js e tests/e2e/export.e2e.js): fontes geradas
 * com o ffmpeg de verdade, leitura de quadros em RGB e amostragem de pixels.
 * Não é um teste: o nome não termina em ".test.js".
 *
 * A "fonte codificada por posição" tem R = posição horizontal (0..255) e G = posição vertical (0..255):
 * a cor de um pixel da saída diz de que ponto da fonte ele veio, o que permite provar numericamente
 * que focusX, zoom, stack, blur e retângulos realmente mudam o conteúdo.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { locateTools } = require('../src/core/ffmpeg/locate');
const { probeMedia } = require('../src/core/ffmpeg/probe');

const tools = locateTools();
const skipMedia = !tools.ffmpeg || !tools.ffprobe ? 'ffmpeg/ffprobe não encontrados' : false;

function tmpDir(prefix = 'bf-export-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}

function ffmpeg(args) {
  execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

/** Fonte H.264 com R = x e G = y (e tom de 440 Hz se `audio`). */
function makeCodedSource(file, { width = 1920, height = 1080, fps = 10, seconds = 3, audio = true } = {}) {
  const video = `color=c=black:s=${width}x${height}:r=${fps}:d=${seconds},geq=r='255*X/W':g='255*Y/H':b=0`;
  ffmpeg([
    '-f', 'lavfi', '-i', video,
    ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`] : []),
    '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac', '-shortest'] : []), file
  ]);
}

/** Fonte H.264 com xadrez de alto contraste (casas de 16 px), sem áudio. */
function makeCheckerSource(file, { width = 1920, height = 1080, fps = 10, seconds = 2 } = {}) {
  ffmpeg([
    '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${seconds},geq=lum='255*mod(floor(X/16)+floor(Y/16),2)':cb=128:cr=128`,
    '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', file
  ]);
}

/** Fonte H.264 com ruído (alta entropia): faz o codificador gastar o bitrate pedido. */
function makeNoiseSource(file, { width = 1280, height = 720, fps = 10, seconds = 4 } = {}) {
  ffmpeg([
    '-f', 'lavfi', '-i', `color=c=gray:s=${width}x${height}:r=${fps}:d=${seconds},noise=alls=90:allf=t+u`,
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`,
    '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file
  ]);
}

/**
 * Vídeo com DOIS "layouts" de verdade e um terceiro que não é nenhum dos dois, em segmentos de `segSeconds` (padrão: conversa, jogo,
 * conversa, jogo, outro). O fundo é um plasma que muda a cada quadro (como o conteúdo de um jogo ou uma câmera) e o CENÁRIO é fixo:
 *  - conversa: barra vermelha no alto, bloco branco com grade (QR code) embaixo à direita e painel escuro de linhas (chat) à direita;
 *  - jogo: caixa da câmera (outro plasma, com moldura branca) no canto superior ESQUERDO e a barra de itens embaixo;
 *  - outro: caixa da câmera no canto superior DIREITO (moldura amarela) e um bloco ciano embaixo à esquerda.
 * Devolve { width, height, segments:[{ layout, start, end }], duration }.
 */
function makeLayoutSource(file, { segSeconds = 6, fps = 5, order = ['conversa', 'jogo', 'conversa', 'jogo', 'outro'] } = {}) {
  const W = 960;
  const H = 540;
  const plasma = (w, h, k, phase) => `color=c=gray:s=${w}x${h}:r=${fps}:d=${segSeconds},format=yuv420p,geq=lum='128+70*sin(X/${55 * k}+T*2.1+${phase})*cos(Y/${45 * k}-T*1.7)+25*sin(X*0.9+Y*0.7+T*9+${phase})':cb='128+60*sin(X/${70 * k}-T*1.3+${phase})':cr='128+60*cos(Y/${60 * k}+T*1.9)',format=rgba`;
  const graphs = order.map((layout, i) => {
    const n = (name) => `[s${i}${name}]`;
    const base = plasma(W, H, 1, i * 7.3);
    if (layout === 'conversa') {
      return [
        `${base},drawbox=x=15:y=12:w=${W - 30}:h=26:color=red:t=2${n('b')}`,
        `color=c=white:s=170x150:r=${fps}:d=${segSeconds},format=rgba,drawgrid=w=20:h=20:t=6:c=black${n('q')}`,
        `color=c=black@0.55:s=190x260:r=${fps}:d=${segSeconds},format=rgba,drawgrid=w=190:h=26:t=2:c=white@0.9${n('c')}`,
        `${n('b')}${n('q')}overlay=x=${W - 185}:y=${H - 165}${n('o')}`,
        `${n('o')}${n('c')}overlay=x=${W - 215}:y=50,format=yuv420p${n('v')}`
      ].join(';');
    }
    if (layout === 'jogo') {
      return [
        `${base}${n('b')}`,
        `${plasma(280, 158, 0.4, i * 3.1)},drawbox=x=0:y=0:w=280:h=158:color=white:t=3${n('q')}`,
        `color=c=0x303030:s=360x40:r=${fps}:d=${segSeconds},format=rgba,drawgrid=w=40:h=40:t=2:c=white${n('c')}`,
        `${n('b')}${n('q')}overlay=x=0:y=0${n('o')}`,
        `${n('o')}${n('c')}overlay=x=${(W - 360) / 2}:y=${H - 60},format=yuv420p${n('v')}`
      ].join(';');
    }
    return [
      `${base}${n('b')}`,
      `${plasma(280, 158, 0.4, i * 5.7)},drawbox=x=0:y=0:w=280:h=158:color=yellow:t=3${n('q')}`,
      `${n('b')}${n('q')}overlay=x=${W - 280}:y=0,drawbox=x=20:y=${H - 90}:w=200:h=60:color=cyan:t=6,drawbox=x=0:y=200:w=14:h=200:color=magenta:t=14,format=yuv420p${n('v')}`
    ].join(';');
  });
  const concat = `${order.map((_, i) => `[s${i}v]`).join('')}concat=n=${order.length}:v=1:a=0[vout]`;
  ffmpeg(['-filter_complex', `${graphs.join(';')};${concat}`, '-map', '[vout]', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', file]);
  return { width: W, height: H, duration: order.length * segSeconds, segments: order.map((layout, i) => ({ layout, start: i * segSeconds, end: (i + 1) * segSeconds })) };
}

/**
 * Passa a fonte pelo grafo (o mesmo da exportação) e devolve o primeiro quadro em RGB.
 * @returns {{width:number,height:number,data:Buffer}}
 */
function renderRaw(source, graph, width, height, { ss = 0.5 } = {}) {
  const res = spawnSync(tools.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(ss), '-i', source, '-frames:v', '1',
    '-filter_complex', graph, '-map', '[vout]', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
  ], { maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (res.status !== 0) throw new Error(`ffmpeg falhou: ${String(res.stderr).slice(-600)}`);
  if (res.stdout.length !== width * height * 3) throw new Error(`tamanho do quadro inesperado: ${res.stdout.length} (esperado ${width * height * 3})`);
  return { width, height, data: res.stdout };
}

/** Quadro RGB de um arquivo de vídeo (já exportado), no tempo `ss`, nas medidas informadas. */
function decodeFile(file, width, height, { ss = 0.3 } = {}) {
  const res = spawnSync(tools.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(ss), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
  ], { maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (res.status !== 0 || res.stdout.length !== width * height * 3) throw new Error(`não foi possível decodificar ${file}: ${String(res.stderr).slice(-300)}`);
  return { width, height, data: res.stdout };
}

const pixel = (frame, x, y) => {
  const i = (Math.min(frame.height - 1, Math.max(0, y)) * frame.width + Math.min(frame.width - 1, Math.max(0, x))) * 3;
  return [frame.data[i], frame.data[i + 1], frame.data[i + 2]];
};

/** Média do canal (0=R, 1=G, 2=B) numa caixa pequena em torno de (x, y). */
function avg(frame, x, y, channel, radius = 3) {
  let sum = 0;
  let count = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) { sum += pixel(frame, x + dx, y + dy)[channel]; count++; }
  }
  return sum / count;
}

/** Desvio padrão do canal R numa região (mede "quanto detalhe/contraste há"). */
function stddev(frame, x0, y0, x1, y1) {
  const values = [];
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) values.push(pixel(frame, x, y)[0]);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

/** Janela (frações da fonte) que um retângulo `rect` mostra ao preencher uma caixa tw x th (corte central). */
function coverWindow(rect, sw, sh, tw, th) {
  const rectAspect = (rect.w * sw) / (rect.h * sh);
  const target = tw / th;
  const visW = rectAspect > target ? target / rectAspect : 1;
  const visH = rectAspect > target ? 1 : rectAspect / target;
  return {
    x0: rect.x + (rect.w * (1 - visW)) / 2, x1: rect.x + (rect.w * (1 + visW)) / 2,
    y0: rect.y + (rect.h * (1 - visH)) / 2, y1: rect.y + (rect.h * (1 + visH)) / 2
  };
}

const probe = (file) => probeMedia(tools.ffprobe, file);

/**
 * Contexto de IPC de verdade com ipcMain/app/dialog falsos (guarda os handlers para chamá-los direto, o mesmo estilo de
 * tests/ipc-base.test.js) e o handler de exportação registrado. `call(canal, payload)` devolve a resposta do canal.
 */
function setupExportIpc(userData, extra = {}) {
  const { createContext } = require('../src/ipc/context');
  const exportHandler = require('../src/ipc/handlers/export');
  const silent = { log() {}, info() {}, warn() {}, error() {} };
  const handlers = new Map();
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } };
  const ctx = createContext({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: () => userData, getVersion: () => '9.9.9', isPackaged: true },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: {}, getWindow: () => win, logger: silent, ...extra
  });
  exportHandler.register(ctx);
  return { ctx, handlers, sent, call: (channel, payload) => handlers.get(channel)({}, payload) };
}

/** Dados ricos do ffprobe para conferir tag, perfil e codec do arquivo exportado. */
function probeStreams(file) {
  const out = execFileSync(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8', windowsHide: true });
  return JSON.parse(out);
}

/** Contagem de processos do ffmpeg com este PID ainda vivos (cancelamento deve matar o filho). */
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

module.exports = {
  tools, skipMedia, tmpDir, cleanup, ffmpeg, makeCodedSource, makeCheckerSource, makeNoiseSource, makeLayoutSource, renderRaw, decodeFile,
  pixel, avg, stddev, coverWindow, probe, probeStreams, isAlive, setupExportIpc
};

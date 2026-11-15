'use strict';

/**
 * Quadros para a tela de enquadramento:
 *  - renderFramePreview: UM quadro gerado pelo MESMO grafo de filtros da exportação (framing.buildVideoGraph),
 *    opcionalmente reduzido no fim (só para a prévia ficar leve);
 *  - renderSourceFrame: um quadro da fonte, reduzido, para o usuário ajustar os retângulos por cima.
 */

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { validateProfile } = require('./profiles');
const { buildVideoGraph } = require('./framing');

const MAX_BYTES = 24 * 1024 * 1024;
const TIMEOUT_MS = 30000;

class PreviewError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PreviewError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const even = (v) => Math.max(2, Math.round(v / 2) * 2);

/** Roda o ffmpeg e junta a saída padrão (a imagem). Cancelável por `signal`. */
function runToBuffer(ffmpeg, args, { signal, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new PreviewError('FFMPEG_START_FAILED', `Não foi possível iniciar o ffmpeg: ${err.message}`));
      return;
    }
    const chunks = [];
    let size = 0;
    let stderr = '';
    let aborted = false;
    let tooBig = false;
    const kill = () => { try { child.kill(); } catch { /* já terminou */ } };
    const onAbort = () => { aborted = true; kill(); };
    const timer = setTimeout(() => { aborted = true; kill(); }, timeoutMs);
    if (signal) {
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) { tooBig = true; kill(); return; }
      chunks.push(c);
    });
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new PreviewError('FFMPEG_START_FAILED', `Não foi possível iniciar o ffmpeg: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (aborted) return reject(new PreviewError(signal && signal.aborted ? 'SUPERSEDED' : 'TIMEOUT', signal && signal.aborted ? 'Pedido substituído por outro mais novo.' : 'O ffmpeg demorou demais para gerar o quadro.'));
      if (tooBig) return reject(new PreviewError('PREVIEW_FAILED', 'A imagem gerada ficou grande demais.'));
      if (code !== 0 || size === 0) {
        return reject(new PreviewError('NO_FRAME', 'Não foi possível ler um quadro neste ponto do vídeo. Escolha outro ponto ou confira se o arquivo está íntegro.', { exitCode: code, stderr }));
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

function checkSource(sourcePath) {
  let ok = false;
  try { ok = typeof sourcePath === 'string' && sourcePath !== '' && fs.statSync(sourcePath).isFile(); } catch { /* ok = false */ }
  if (!ok) throw new PreviewError('INPUT_MISSING', 'O arquivo de origem não foi encontrado.', { path: sourcePath });
}

const seekArg = (t) => String(Math.max(0, Number(Number(t).toFixed(3)) || 0));

/** Quanto voltar quando o ponto pedido cai depois do último quadro do vídeo. */
const END_RETRY_SEC = 0.5;

/**
 * Pega UM quadro em `timeSec`. Nos últimos instantes do vídeo (por exemplo, o fim de um corte que vai até o fim do arquivo) o
 * `-ss` pode cair depois do último quadro e o ffmpeg não entrega nada: então tenta de novo um pouco antes, em vez de mostrar erro.
 */
async function grabFrame(ffmpeg, argsAt, timeSec, signal) {
  try {
    return await runToBuffer(ffmpeg, argsAt(timeSec), { signal });
  } catch (err) {
    if (!(err instanceof PreviewError) || err.code !== 'NO_FRAME' || !(Number(timeSec) > END_RETRY_SEC)) throw err;
    return runToBuffer(ffmpeg, argsAt(timeSec - END_RETRY_SEC), { signal });
  }
}

/** Largura e altura de um PNG (cabeçalho IHDR). */
function pngSize(buf) {
  return buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
}

/** Largura e altura de um JPEG (marcador SOF). */
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * Um quadro (PNG) da fonte já enquadrado como na exportação.
 * `maxSide`: maior lado da imagem devolvida (0/null = tamanho real do perfil).
 * @returns {Promise<{dataUrl:string,width:number,height:number,graph:string}>}
 */
async function renderFramePreview({ ffmpeg, sourcePath, timeSec = 0, profile: profileInput, framing, maxSide = 640, signal }) {
  const { profile, errors } = validateProfile(profileInput);
  if (errors.length) throw new PreviewError('INVALID_PROFILE', errors.join(' '), { errors });
  checkSource(sourcePath);
  const postFilters = [];
  const longest = Math.max(profile.width, profile.height);
  if (maxSide > 0 && longest > maxSide) {
    const f = maxSide / longest;
    postFilters.push(`scale=w=${even(profile.width * f)}:h=${even(profile.height * f)}:flags=area`);
  }
  const graph = buildVideoGraph({ framing, profile, postFilters });
  const png = await grabFrame(ffmpeg, (t) => [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', seekArg(t), '-i', sourcePath,
    '-frames:v', '1', '-filter_complex', graph, '-map', '[vout]', '-an', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'
  ], timeSec, signal);
  const size = pngSize(png) || { width: profile.width, height: profile.height };
  return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: size.width, height: size.height, graph };
}

/** Um quadro (JPEG) da fonte, reduzido a no máximo `maxWidth` de largura. */
async function renderSourceFrame({ ffmpeg, sourcePath, timeSec = 0, maxWidth = 960, signal }) {
  checkSource(sourcePath);
  const jpeg = await grabFrame(ffmpeg, (t) => [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', seekArg(t), '-i', sourcePath,
    '-frames:v', '1', '-vf', `scale=w='min(${Math.round(maxWidth)},iw)':h=-2`, '-an', '-q:v', '3', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'
  ], timeSec, signal);
  const size = jpegSize(jpeg) || { width: 0, height: 0 };
  return { dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`, width: size.width, height: size.height };
}

module.exports = { PreviewError, renderFramePreview, renderSourceFrame, runToBuffer, pngSize, jpegSize };

'use strict';

const fs = require('node:fs');
const { measureAudio, AudioError } = require('../../core/audio/measure');

const CACHE_MAX = 200;

function problem(code, message) {
  return new AudioError(code, message);
}

/**
 * Ajustes manuais de áudio por corte (arquitetura 3.3). O processo principal só MEDE (somente leitura);
 * os ajustes ficam em cut.audio, gravado pelo renderer, e o filtro da exportação vem de
 * src/core/audio/audioFilter.js. Nenhum canal aqui escreve ou altera a fonte.
 *
 * Canal:
 *   audio:measure { sourcePath, start, end } -> { hasAudio, peakDb, meanDb, samples, start, end, cached }
 *     (ffmpeg volumedetect no trecho; pico e média em dB; hasAudio:false quando a fonte não tem áudio)
 */
function register(ctx) {
  const cache = new Map(); // chave (arquivo + tamanho + data + trecho) -> resultado
  const inflight = new Map(); // chave -> Promise (pedidos iguais ao mesmo tempo compartilham a medição)
  const running = new Set(); // AbortController dos ffmpeg em andamento

  ctx.handle('audio:measure', async ({ sourcePath, start, end }) => {
    if (typeof sourcePath !== 'string' || !sourcePath) throw problem('INVALID_PATH', 'Informe o caminho do vídeo a medir.');
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw problem('INVALID_RANGE', 'O trecho a medir é inválido: o fim precisa ser maior que o início.');
    }
    if (!ctx.tools.ffmpeg) throw problem('NO_FFMPEG', 'FFmpeg não encontrado, então não dá para medir o áudio. Instale o FFmpeg (ffmpeg.org/download.html), deixe-o no PATH e use “Verificar de novo” no aviso do topo.');

    let stat;
    try { stat = fs.statSync(sourcePath); } catch { stat = null; }
    if (!stat || !stat.isFile()) throw problem('INPUT_MISSING', `O arquivo de origem não foi encontrado: ${sourcePath}. Confira se ele não foi movido ou apagado.`);

    const key = [sourcePath, stat.size, Math.round(stat.mtimeMs), start.toFixed(3), end.toFixed(3)].join('|');
    if (cache.has(key)) return { ...cache.get(key), cached: true };

    let pending = inflight.get(key);
    if (!pending) {
      const abort = new AbortController();
      running.add(abort);
      pending = measureAudio({ ffmpeg: ctx.tools.ffmpeg, sourcePath, start, end, signal: abort.signal })
        .then((result) => {
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
          cache.set(key, result);
          return result;
        })
        .finally(() => { running.delete(abort); inflight.delete(key); });
      inflight.set(key, pending);
    }
    return { ...(await pending), cached: false };
  });

  // não deixa o ffmpeg de uma medição órfão ao fechar o app
  if (ctx.app && typeof ctx.app.on === 'function') {
    ctx.app.on('before-quit', () => { for (const abort of running) abort.abort(); });
  }
}

module.exports = { register };

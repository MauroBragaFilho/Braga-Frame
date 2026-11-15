'use strict';

const path = require('node:path');
const { WaveformService, sanitizeHint } = require('../../core/review/waveform');
const { HistoryStore } = require('../../core/history/store');

function problem(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const MAX_BUCKETS = 20000;

function optionalNumber(value, name) {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw problem('INVALID_ARGS', `Valor inválido para "${name}".`);
  return n;
}

/**
 * Revisão (dono: review): forma de onda real para a timeline e histórico de decisões por projeto.
 *
 *  - `review:waveform { sourcePath, buckets?, start?, end?, durationHint? }` -> { duration, start, end, buckets,
 *    secPerBucket, peaks:[0..255], cached, partial }; evento `review:waveformProgress { sourcePath, p }`
 *    (`durationHint` fora de 0..7 dias é ignorado);
 *  - `review:waveformCancel { sourcePath }` -> { cancelled };
 *  - `review:historyLoad { projectId }` -> { groups, dropped, recovered? };
 *  - `review:historyAppend { projectId, groups }` -> { count, dropped };
 *  - `review:historyCopy { fromProjectId, toProjectId }` -> { copied, count, reason? } (nunca sobrescreve).
 * O histórico fica em `userData/history/<projectId>.json` (só o renderer decide o que gravar; o projeto
 * em si continua sendo gravado só pelo renderer).
 */
function register(ctx) {
  const waveform = new WaveformService({
    getFfmpeg: () => ctx.tools.ffmpeg,
    cacheDir: path.join(ctx.paths.cache, 'waveform'),
    log: ctx.log
  });
  const history = new HistoryStore(path.join(ctx.paths.userData, 'history'));

  ctx.handle('review:waveform', async (payload) => {
    const { sourcePath } = payload;
    if (typeof sourcePath !== 'string' || !sourcePath) throw problem('INVALID_ARGS', 'Informe o caminho do vídeo para calcular a forma de onda.');
    const buckets = payload.buckets === undefined ? 1000 : Math.floor(Number(payload.buckets));
    if (!Number.isFinite(buckets) || buckets < 1 || buckets > MAX_BUCKETS) throw problem('INVALID_ARGS', `Use entre 1 e ${MAX_BUCKETS} colunas para a forma de onda.`);
    return waveform.peaks({
      sourcePath,
      buckets,
      start: optionalNumber(payload.start, 'start'),
      end: optionalNumber(payload.end, 'end'),
      durationHint: sanitizeHint(payload.durationHint), // só dica de tamanho/progresso: valor absurdo (cabeçalho de duração corrompido) é ignorado, não vira erro
      onProgress: (p) => ctx.send('review:waveformProgress', { sourcePath, p })
    });
  });

  ctx.handle('review:waveformCancel', ({ sourcePath }) => ({ cancelled: typeof sourcePath === 'string' && waveform.cancel(sourcePath) }));

  ctx.handle('review:historyLoad', ({ projectId }) => history.load(projectId));

  ctx.handle('review:historyAppend', ({ projectId, groups }) => history.append(projectId, groups));

  ctx.handle('review:historyCopy', ({ fromProjectId, toProjectId }) => history.copy(fromProjectId, toProjectId));

  if (ctx.app && typeof ctx.app.on === 'function') ctx.app.on('before-quit', () => waveform.cancelAll());
}

module.exports = { register };

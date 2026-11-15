'use strict';

/**
 * Módulos de outros recursos que a exportação usa SE existirem (contrato 3.3):
 *   - src/core/audio/audioFilter.js     -> buildAudioFilter(audio[, { durationSec }]) -> string|null
 *   - src/core/subtitles/burnIn.js      -> prepareBurnIn(cut, { tmpDir, width, height }) -> null | { vfFilter, sidecars:[{path, ext}] }
 * Módulo ausente = recurso ainda não entregue (a exportação segue sem ele e avisa). Módulo presente
 * mas quebrado = erro real, devolvido em `error` para quem chamou decidir.
 */

/** Só para testes: substitui um módulo por um de mentira ({ module }) ou por "ausente" ({ module:null }); null desfaz. */
const overrides = {};
function _setOverrides(next) {
  for (const key of ['audioFilter', 'burnIn']) {
    if (next && key in next) { if (next[key] === null) delete overrides[key]; else overrides[key] = next[key]; }
  }
  if (next === null) for (const key of Object.keys(overrides)) delete overrides[key];
}

function load(id, label, key) {
  if (overrides[key]) return { module: overrides[key].module || null, error: null, missing: !overrides[key].module };
  try {
    return { module: require(id), error: null };
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(`'${id}'`)) return { module: null, error: null, missing: true };
    return { module: null, error: `${label} não carregou: ${err && err.message}` };
  }
}

const audioFilter = () => load('../audio/audioFilter', 'O módulo de áudio', 'audioFilter');
const burnIn = () => load('../subtitles/burnIn', 'O módulo de legendas', 'burnIn');

/** O corte tem algum ajuste de áudio diferente do padrão (ganho, mudo, fades)? */
function hasAudioAdjust(audio) {
  if (!audio || typeof audio !== 'object') return false;
  return Boolean(audio.mute) || Math.abs(Number(audio.gainDb) || 0) > 1e-9 || Number(audio.fadeInSec) > 0 || Number(audio.fadeOutSec) > 0;
}

module.exports = { audioFilter, burnIn, hasAudioAdjust, _setOverrides };

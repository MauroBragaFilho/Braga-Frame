'use strict';

/**
 * EPISÓDIOS e TELAS DE ESPERA (params.episodes; docs/recursos/analysis.md, "Episódios e telas de espera").
 *
 * Uma live longa costuma ser vários programas seguidos, separados por uma arte parada ("Voltamos em instantes", "Iniciamos em
 * instantes", "Encerramos por hoje"). Na tela de espera a imagem fica PARADA (diferença entre quadros ~0; numa câmera de verdade
 * nunca é zero, nem com a pessoa quieta) e o som some (silêncio digital) ou só toca música, sem fala.
 *
 * Por segundo há até três evidências: imagem parada, som em silêncio e ausência de fala na transcrição. Um segundo é de espera
 * quando as evidências disponíveis concordam: com as três, basta duas (a transcrição costuma "vazar" para dentro da espera, e a
 * música da espera tira o silêncio); com duas, as duas; com uma só (só imagem ou só som), ela basta. Só texto não decide nada.
 * Trechos de espera com pelo menos BREAK_MIN_SEC (aceitando buracos de até BRIDGE_SEC) viram INTERVALOS; o que sobra entre eles são
 * os EPISÓDIOS. Se os intervalos somam mais que MAX_BREAK_SHARE do vídeo, o vídeo é parado por natureza (slides, tela estática) e
 * nada é marcado.
 */

const STILL_MOTION = 0.3; // diferença média entre quadros (em %) abaixo da qual a imagem está parada; câmera real: ~1 a 5
const SILENT_DB = -60; // dBFS: abaixo disto em todo o segundo é silêncio (fala baixa fica em -45 ou mais)
const BREAK_MIN_SEC = 30; // espera mais curta que isto é pausa, não intervalo
const BRIDGE_SEC = 5; // a arte de espera pode ter uma animação curta: buracos de até 5 s não quebram o intervalo
const MAX_BREAK_SHARE = 0.6;
const MIN_EPISODE_SEC = 90; // trecho entre intervalos mais curto que isto não é episódio (não ganha cota)

/**
 * `image`: { seconds, motion, fast } (extractImage) ou null. No modo rápido (só quadros-chave) os segundos sem quadro valem 0 e
 * pareceriam parados: a imagem não entra. `audio`: { windowSec, db } (extractAudio) ou null. `cues`: falas da transcrição ou null.
 * Devolve { breaks: [{ start, end }], episodes: [{ start, end }] } em segundos inteiros, em ordem.
 */
function findBreaks({ image = null, audio = null, cues = null, n }) {
  const none = { breaks: [], episodes: [] };
  if (!(n > 0)) return none;
  const useImage = Boolean(image && !image.fast && Array.isArray(image.motion) && image.motion.length);
  const useAudio = Boolean(audio && Array.isArray(audio.db) && audio.db.length && audio.windowSec > 0);
  if (!useImage && !useAudio) return none; // só a transcrição não basta: falta de fala também é jogo sem narração
  const useText = Array.isArray(cues) && cues.length > 0;

  const speech = useText ? new Uint8Array(n) : null;
  if (useText) {
    for (const c of cues) {
      for (let k = Math.max(0, Math.floor(c.start)); k < Math.min(n, Math.ceil(c.end)); k += 1) speech[k] = 1;
    }
  }
  const perSec = useAudio ? 1 / audio.windowSec : 0;
  const wait = new Uint8Array(n);
  for (let k = 0; k < n; k += 1) {
    let have = 0;
    let yes = 0;
    if (useImage) {
      have += 1;
      if (k < image.motion.length && image.motion[k] <= STILL_MOTION) yes += 1;
    }
    if (useAudio) {
      have += 1;
      const a = Math.floor(k * perSec);
      const b = Math.min(audio.db.length, Math.max(a + 1, Math.floor((k + 1) * perSec)));
      let loud = a >= audio.db.length; // depois do fim do áudio: sem dado, não é silêncio
      for (let i = a; i < b && !loud; i += 1) if (audio.db[i] > SILENT_DB) loud = true;
      if (!loud) yes += 1;
    }
    if (useText) {
      have += 1;
      if (!speech[k]) yes += 1;
    }
    wait[k] = yes >= Math.min(have, 2) ? 1 : 0;
  }

  const breaks = [];
  let s = -1;
  let last = -1;
  for (let k = 0; k <= n; k += 1) {
    if (k < n && wait[k]) {
      if (s < 0) s = k;
      last = k;
    } else if (s >= 0 && (k === n || k - last > BRIDGE_SEC)) {
      if (last + 1 - s >= BREAK_MIN_SEC) breaks.push({ start: s, end: last + 1 });
      s = -1;
    }
  }
  const total = breaks.reduce((sum, b) => sum + b.end - b.start, 0);
  if (!breaks.length || total > n * MAX_BREAK_SHARE) return none;

  const episodes = [];
  let from = 0;
  for (const b of [...breaks, { start: n, end: n }]) {
    if (b.start - from >= MIN_EPISODE_SEC) episodes.push({ start: from, end: b.start });
    from = b.end;
  }
  return { breaks, episodes };
}

/** Índice (1, 2, 3…) do episódio que contém o instante `t`, ou null. */
function episodeAt(episodes, t) {
  for (let i = 0; i < episodes.length; i += 1) if (t >= episodes[i].start && t < episodes[i].end) return i + 1;
  return null;
}

module.exports = { findBreaks, episodeAt, STILL_MOTION, SILENT_DB, BREAK_MIN_SEC, BRIDGE_SEC, MAX_BREAK_SHARE, MIN_EPISODE_SEC };

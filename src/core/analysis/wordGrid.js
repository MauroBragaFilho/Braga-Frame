'use strict';

/**
 * Grade de quadros para as palavras do Whisper. O Whisper dá o tempo de cada palavra em segundos, com folga de centésimos e, às vezes,
 * palavras que se sobrepõem. Aqui cada início e fim vai para o quadro mais próximo do vídeo (fps real do arquivo) e as palavras ficam em
 * ordem, sem sobreposição e com pelo menos um quadro cada. Um corte que começa ou termina numa palavra cai então num quadro exato.
 */

const { normalizeWords } = require('./words');

const NTSC = [[24000 / 1001, 23.976], [30000 / 1001, 29.97], [60000 / 1001, 59.94], [120000 / 1001, 119.88]];

/** fps do probe (arredondado a 2 casas) -> fps exato (29,97 vira 30000/1001). 0 se inválido. */
function exactFps(fps) {
  const n = Number(fps);
  if (!Number.isFinite(n) || n <= 0 || n > 480) return 0;
  for (const [exact, shown] of NTSC) if (Math.abs(n - shown) < 0.012) return exact;
  return n;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/** Segundos -> número do quadro (0 = primeiro quadro). */
const frameOf = (sec, fps) => Math.round(Math.max(0, Number(sec) || 0) * exactFps(fps));

/** Número do quadro -> segundos (3 casas). */
const timeOfFrame = (frame, fps) => round3(frame / exactFps(fps));

/**
 * `[[início, fim, texto], …]` -> `[{ start, end, text, startFrame, endFrame }]` na grade de quadros. Sem fps válido devolve as palavras
 * normalizadas sem quadros (`startFrame` e `endFrame` nulos).
 */
function snapWordsToFrames(raw, fps) {
  const words = normalizeWords(raw);
  const f = exactFps(fps);
  if (!f) return words.map((w) => ({ ...w, startFrame: null, endFrame: null }));
  const out = [];
  let prevEnd = 0;
  for (const w of words) {
    let a = Math.round(w.start * f);
    let b = Math.round(w.end * f);
    if (a < prevEnd) a = prevEnd; // palavra que invade a anterior começa onde a anterior termina
    if (b <= a) b = a + 1;        // toda palavra ocupa ao menos um quadro
    out.push({ start: round3(a / f), end: round3(b / f), text: w.text, startFrame: a, endFrame: b });
    prevEnd = b;
  }
  return out;
}

module.exports = { exactFps, frameOf, timeOfFrame, snapWordsToFrames };

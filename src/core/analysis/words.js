'use strict';

/**
 * Palavras com tempo (do Whisper) e o ajuste fino do início e do fim de um corte à fala ("snap to speech").
 *
 * Guardadas na transcrição como `words: [[início, fim, texto], …]` (segundos desde o início do vídeo, em ordem). Transcrições importadas
 * (.srt/.vtt) não têm palavras: quem chama cai no ajuste por falas de verify.js.
 *
 * Regras do snap (pedido da Alice, 16/11/2026):
 *  - INÍCIO: vai para o começo da primeira palavra depois de uma pausa (> pauseSec de silêncio). Nunca no meio de uma palavra.
 *  - FIM: vai para o fim da última palavra da frase (+ tailSec de folga), sem entrar na palavra seguinte.
 * O ajuste anda no máximo maxMoveSec para cada lado; sem palavra por perto o horário fica como veio.
 */

const PAUSE_SEC = 0.3;
const TAIL_SEC = 0.2;
const LEAD_SEC = 0.1;      // folga antes da primeira palavra: o tempo de início do Whisper costuma vir alguns centésimos tarde
const MAX_MOVE_SEC = 4;
const SENTENCE_END = /[.!?…]["')\]]*$/;

const round3 = (n) => Math.round(n * 1000) / 1000;

/** `[[s, e, texto], …]` (ou objetos já prontos) -> `[{ start, end, text }]` válido e em ordem. */
function normalizeWords(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    let start;
    let end;
    let text;
    if (Array.isArray(item)) [start, end, text] = item;
    else if (item && typeof item === 'object') ({ start, end, text } = item);
    else continue;
    start = Number(start);
    end = Number(end);
    text = typeof text === 'string' ? text.trim() : '';
    if (!Number.isFinite(start) || !Number.isFinite(end) || !text || start < 0) continue;
    if (end < start) end = start;
    out.push({ start: round3(start), end: round3(end), text });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

/** Forma compacta para guardar em disco. */
const packWords = (words) => words.map((w) => [round3(w.start), round3(w.end), w.text]);

/** Índice da última palavra com início <= t (-1 se nenhuma). Busca binária. */
function lastStartingAtOrBefore(words, t) {
  let lo = 0;
  let hi = words.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

const isPauseStart = (words, i, pauseSec) => i === 0 || words[i].start - words[i - 1].end > pauseSec;

/** Novo início. `start` em silêncio vai para a próxima palavra se ela abre depois de uma pausa; dentro de uma palavra, recua. */
function snapStartToSpeech(start, words, { pauseSec, leadSec, maxMoveSec }) {
  if (!words.length) return start;
  const idx = lastStartingAtOrBefore(words, start);
  let target = null;
  if (idx >= 0 && words[idx].end > start) {
    // dentro de uma palavra: recua até a primeira palavra depois de uma pausa; se não houver perto, pelo menos até o começo desta
    for (let j = idx; j >= 0 && start - words[j].start <= maxMoveSec; j -= 1) {
      if (isPauseStart(words, j, pauseSec)) { target = j; break; }
    }
    if (target === null) target = idx;
  } else {
    // no silêncio: se a próxima palavra abre depois de uma pausa e está perto, o início vai para ela (corta o silêncio)
    const next = idx + 1;
    if (next < words.length && words[next].start - start <= maxMoveSec && isPauseStart(words, next, pauseSec)) target = next;
    else if (idx >= 0 && start - words[idx].end <= 0) target = idx;
  }
  if (target === null) return start;
  const floor = target > 0 ? words[target - 1].end : 0;
  return round3(Math.max(floor, words[target].start - leadSec, 0));
}

/** Novo fim: o fim da última palavra da frase + folga, sem invadir a palavra seguinte. */
function snapEndToSpeech(end, words, { pauseSec, tailSec, maxMoveSec }) {
  if (!words.length) return end;
  const k = lastStartingAtOrBefore(words, end);
  if (k < 0) return end;
  const done = (j) => j + 1 >= words.length || SENTENCE_END.test(words[j].text) || words[j + 1].start - words[j].end > pauseSec;
  let j = k;
  while (!done(j)) {
    if (words[j + 1].end > end + maxMoveSec) { j = -1; break; } // a frase não acaba perto: não vale esticar tanto
    j += 1;
  }
  if (j >= 0) return round3(withTail(words, j, tailSec));
  // sem fim de frase por perto: só não corta a palavra em andamento
  return words[k].end > end ? round3(withTail(words, k, tailSec)) : end;
}

function withTail(words, i, tailSec) {
  const limit = i + 1 < words.length ? Math.max(words[i].end, words[i + 1].start - 0.02) : Infinity;
  return Math.min(words[i].end + tailSec, limit);
}

/**
 * Ajusta [start, end] à fala. `words` = normalizeWords(...). Devolve { start, end, movedStart, movedEnd }.
 * Sem palavras por perto, devolve os horários de entrada (movedX = false).
 */
function snapToSpeech(start, end, words, { pauseSec = PAUSE_SEC, tailSec = TAIL_SEC, leadSec = LEAD_SEC, maxMoveSec = MAX_MOVE_SEC } = {}) {
  const s = snapStartToSpeech(start, words, { pauseSec, leadSec, maxMoveSec });
  let e = snapEndToSpeech(end, words, { pauseSec, tailSec, maxMoveSec });
  if (!(e > s)) e = end;
  return { start: s, end: e, movedStart: Math.abs(s - start) > 0.001, movedEnd: Math.abs(e - end) > 0.001 };
}

/** Fim recuado: o fim da última frase COMPLETA que acaba antes de `end` (até maxMoveSec para trás), + folga. null se não há. */
function snapEndBack(end, words, { pauseSec = PAUSE_SEC, tailSec = TAIL_SEC, maxMoveSec = MAX_MOVE_SEC } = {}) {
  for (let j = words.length - 1; j >= 0; j -= 1) {
    if (words[j].end > end) continue;
    if (end - words[j].end > maxMoveSec) return null;
    const done = j + 1 >= words.length || SENTENCE_END.test(words[j].text) || words[j + 1].start - words[j].end > pauseSec;
    if (done) return round3(withTail(words, j, tailSec));
  }
  return null;
}

/**
 * snapToSpeech que respeita a duração: tenta os dois lados ajustados, depois só o início, só o fim e, por fim, o fim recuado para a
 * frase anterior. Devolve { start, end, snapped } (snapped=false: nada coube e os horários ficam como vieram).
 * `limits` = { minSec, maxSec, duration }.
 */
function snapWithin(start, end, words, limits, opts = {}) {
  if (!words || !words.length) return { start, end, snapped: false };
  const { minSec = 0, maxSec = Infinity, duration = Infinity } = limits || {};
  const s = snapToSpeech(start, end, words, opts);
  const fits = (a, b) => b > a && b <= duration + 1e-6 && a >= 0 && b - a >= minSec - 0.01 && b - a <= maxSec + 0.01;
  const back = snapEndBack(end, words, opts);
  // primeiro o que NÃO corta palavra (os dois lados, um lado, o fim recuado); só por último o horário original
  const tries = [[s.start, s.end], [start, s.end], ...(back !== null ? [[s.start, back], [start, back]] : []), [s.start, end]];
  const hit = tries.find(([a, b]) => fits(a, b));
  if (!hit) return { start, end, snapped: false };
  return { start: hit[0], end: hit[1], snapped: Math.abs(hit[0] - start) > 0.001 || Math.abs(hit[1] - end) > 0.001 };
}

module.exports = { snapWithin, snapEndBack, normalizeWords, packWords, snapToSpeech, snapStartToSpeech, snapEndToSpeech, lastStartingAtOrBefore, PAUSE_SEC, TAIL_SEC, LEAD_SEC, MAX_MOVE_SEC };

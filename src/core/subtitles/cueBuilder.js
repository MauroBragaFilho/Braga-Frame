'use strict';

/**
 * Agrupa palavras com tempo em falas de legenda (código puro).
 *
 * Adaptado de src/core/transcription/subtitles.js do BDS (somente leitura; porta fiel do legendar.py):
 *   - quebra a fala na pontuação final e em pausas maiores que MAX_GAP;
 *   - nunca passa de MAX_DURATION nem do limite de caracteres/linhas escolhido;
 *   - prefere cortar em vírgula/ponto e vírgula e evita terminar em "de", "o", "que"…;
 *   - cada fala fica ao menos MIN_DURATION na tela e nunca se sobrepõe à seguinte.
 * Aqui cada fala também leva a confiança média das palavras (`p`) para a revisão.
 *
 * Japonês e chinês não usam espaço entre as palavras: o parser (whisperOutput.js) entrega cada pedaço como uma "palavra" com
 * `glue: true` (continua a anterior sem espaço), a fala as junta sem espaço e a largura da linha conta o caractere de
 * largura total como 2 (shared.textWidth), então `maxChars` vale em "letras latinas" também nesses idiomas.
 */

const shared = require('./shared');

const MIN_DURATION = 0.5; // segundos que uma fala fica na tela, no mínimo
const MAX_GAP = 1.0;      // um silêncio maior que isso sempre abre uma fala nova
const MAX_DURATION = 6.0;
const SENTENCE_END = ['.', '?', '!', '…', '。', '？', '！', '．'];
const SOFT_BREAK = [',', ';', ':', '、', '，', '；', '：'];

// Palavras com que uma fala não deve terminar: leem melhor no começo da próxima (português).
const WEAK_ENDINGS = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas',
  'e', 'ou', 'que', 'para', 'por', 'com', 'se', 'ao', 'aos', 'à', 'às', 'pelo', 'pela', 'pelos', 'pelas'
]);

/** Largura em "letras latinas": pontos de código, e o caractere de largura total (japonês, chinês, hangul) vale 2. */
const size = (text) => shared.textWidth(text);
const endsWithAny = (text, endings) => endings.some((e) => text.endsWith(e));
const clean = (word) => String(word.word ?? '').trim();
const stripPunct = (text) => text.replace(/^[,.;:?!]+/, '').replace(/[,.;:?!]+$/, '');
/** Palavra (objeto do parser ou texto) -> unidade de `shared.joinUnits`. */
const unitOf = (word) => (typeof word === 'string' ? { text: word, glue: false } : { text: clean(word), glue: word.glue === true });

/** Divide uma fala em até `lines` linhas equilibradas (só para medir se estoura o limite). `words`: textos ou palavras do parser. */
function wrapLines(words, lines, maxChars) {
  const units = words.map(unitOf);
  const text = shared.joinUnits(units);
  if (lines <= 1 || size(text) <= maxChars || units.length < 2) return text;
  let best = text;
  let bestDiff = null;
  for (let cut = 1; cut < units.length; cut++) {
    const first = shared.joinUnits(units.slice(0, cut));
    const second = shared.joinUnits(units.slice(cut));
    const diff = Math.abs(size(first) - size(second));
    if (bestDiff === null || diff < bestDiff) { best = `${first}\n${second}`; bestDiff = diff; }
  }
  return best;
}

const overflows = (words, lines, maxChars) => wrapLines(words, lines, maxChars).split('\n').some((line) => size(line) > maxChars);

const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

/**
 * @param {Array<{word:string,start:number,end:number,p?:number|null}>} words
 * @param {{maxWords?:number, lines?:number, maxChars?:number}} [opts]  maxWords 0 = automático
 * @returns {Array<{start:number,end:number,text:string,p:number|null,segs:number[]}>}
 *   segs: índices dos trechos do motor (`word.seg`) de onde vieram as palavras da fala.
 */
function buildCues(words, { maxWords = 0, lines = 2, maxChars = 22 } = {}) {
  const cues = [];
  let current = [];

  const emit = (items) => {
    if (!items.length) return;
    const ps = items.map((w) => w.p).filter((p) => Number.isFinite(p));
    const m = mean(ps);
    cues.push({
      start: items[0].start,
      end: items[items.length - 1].end,
      text: shared.joinUnits(items.map(unitOf)),
      p: m === null ? null : Math.round(m * 1000) / 1000,
      segs: [...new Set(items.map((w) => w.seg).filter((s) => Number.isInteger(s)))]
    });
  };

  for (const word of words || []) {
    if (!clean(word)) continue;
    if (current.length) {
      const last = current[current.length - 1];
      const gap = word.start - last.end;
      const sentenceEnd = endsWithAny(clean(last), SENTENCE_END) && current.length >= (maxWords ? 1 : 3);
      if (gap > MAX_GAP || sentenceEnd) {
        emit(current);
        current = [];
      } else if (
        (maxWords > 0 && current.length >= maxWords)
        || overflows([...current, word], lines, maxChars)
        || word.end - current[0].start > MAX_DURATION
      ) {
        let splitAt = current.length;
        let broke = false;
        for (let k = current.length; k >= Math.floor(current.length / 2); k--) { // prefere cortar em vírgula/ponto e vírgula
          if (k > 0 && endsWithAny(clean(current[k - 1]), SOFT_BREAK)) { splitAt = k; broke = true; break; }
        }
        if (!broke) {
          while (splitAt > 1 && WEAK_ENDINGS.has(stripPunct(clean(current[splitAt - 1]).toLowerCase()))) splitAt--;
        }
        emit(current.slice(0, splitAt));
        current = current.slice(splitAt);
      }
    }
    current.push(word);
  }
  emit(current);

  // Cada fala fica legível e nunca se sobrepõe à seguinte.
  cues.forEach((cue, i) => {
    const nextStart = i + 1 < cues.length ? cues[i + 1].start : Infinity;
    cue.end = Math.max(cue.end, cue.start + MIN_DURATION);
    if (nextStart - cue.end < 0.05) cue.end = Math.max(nextStart - 0.05, cue.start + 0.1);
  });
  return cues;
}

module.exports = { buildCues, wrapLines, MIN_DURATION, MAX_GAP, MAX_DURATION, WEAK_ENDINGS };

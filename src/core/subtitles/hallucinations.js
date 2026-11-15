'use strict';

/**
 * Regras para NUNCA inventar fala (dono: subtitles). O whisper, quando recebe silêncio, ruído ou música, costuma
 * devolver anotações ("[Música]"), frases decoradas dos dados de treino ("Legendas pela comunidade Amara.org",
 * "Obrigado por assistir") ou repetições. Esta camada olha cada trecho (segmento) que o motor devolveu e decide:
 *
 *   - descartar (e REGISTRAR o motivo, nunca em silêncio): anotação de áudio, frase típica de alucinação em trecho
 *     sem fala ou de baixa confiança, trecho dentro de silêncio, repetição em laço, confiança extremamente baixa;
 *   - manter, mas marcar `needsReview` (nunca esconder): confiança baixa que não chega a ser ruído.
 *
 * Código puro (sem disco nem processo): recebe o resultado já interpretado e as faixas de silêncio.
 */

/** Confiança (0..1, média da probabilidade das palavras) abaixo da qual o trecho é descartado como provável ruído. */
const DISCARD_BELOW = 0.28;
/** Confiança abaixo da qual a fala é mantida, mas marcada para revisão. */
const REVIEW_BELOW = 0.55;
/** Frase típica de alucinação só é descartada se a confiança for menor que isto (ou se estiver fora de fala). */
const KNOWN_PHRASE_CONFIDENCE = 0.6;

const REASONS = Object.freeze({
  annotation: 'anotação de áudio (não é fala)',
  known: 'frase típica de ruído ou silêncio, sem fala nesse trecho',
  silence: 'trecho sem som',
  repetition: 'repetição em laço (provável ruído)',
  lowConfidence: 'confiança muito baixa (provável ruído)'
});

/** Minúsculas, sem acentos, sem pontuação nas pontas e com espaços simples. */
function normalize(text) {
  return String(text || '')
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,;:!?¡¿"'`´*_\-–—…()[\]{}♪♫]+|[\s.,;:!?¡¿"'`´*_\-–—…()[\]{}♪♫]+$/g, '')
    .trim();
}

/**
 * Frases que, SOZINHAS, são típicas de alucinação (comparação exata, já normalizadas). Também podem ser fala de verdade
 * ("obrigado, até a próxima!"), então só são descartadas em trecho sem fala ou com confiança baixa.
 */
const COMMON_EXACT = new Set([
  'obrigado', 'obrigada', 'obrigado por assistir', 'obrigada por assistir', 'tchau', 'tchau tchau', 'ate a proxima',
  'ate o proximo video', 'ate logo', 'valeu', 'musica',
  'thank you', 'thanks', 'thank you very much', 'bye', 'bye bye', 'you', 'thanks for watching', 'thank you for watching',
  'see you next time', 'the end',
  'gracias', 'gracias por ver el video', 'suscribete',
  'merci', 'merci d avoir regarde cette video',
  'vielen dank', 'danke', 'vielen dank furs zuschauen'
]);

/** Chamadas comuns em lives e vídeos ("inscreva-se no canal"): podem ser fala de verdade; mesma regra condicional. */
const COMMON_CONTAINS = [
  'inscreva-se no canal', 'se inscreva no canal', 'nao se esqueca de se inscrever', 'please subscribe', 'like and subscribe'
];

/**
 * Créditos de legenda que o modelo decorou dos dados de treino: nunca são fala de uma live. Quem contém uma destas frases
 * é descartado sempre (com o motivo registrado).
 */
const CERTAIN_CONTAINS = [
  'amara.org', 'legendas pela comunidade', 'legenda adriana zanotto', 'legendado por', 'transcrito por', 'traducao e legendas por',
  'subtitles by', 'subtitulos por', 'subtitulos realizados', 'sous-titrage', 'sous-titres realises', 'untertitel der', 'untertitel im auftrag',
  'www.mooji.org'
];

/** O texto inteiro é uma anotação de áudio: "[Música]", "(risos)", "*aplausos*", "♪♪", "[BLANK_AUDIO]", "[ Silence ]"… */
function isAnnotation(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/^[\s♪♫♬*#_.\-–—…]+$/u.test(t)) return true; // só símbolos de música/pontuação
  // tira o que está entre colchetes, parênteses, chaves ou asteriscos e as notas musicais: se não sobrou fala, era só anotação
  const rest = t.replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|\*[^*]*\*|[♪♫♬]/gu, '').replace(/[\s.,;:!?…\-–—]+/gu, '');
  return rest === '';
}

/**
 * 'certain' = crédito de legenda decorado (nunca é fala); 'common' = frase que o modelo costuma inventar mas que também
 * pode ser dita de verdade; null = nenhuma das duas.
 */
function hallucinationKind(text) {
  const n = normalize(text);
  if (!n) return null;
  // sem a pontuação do meio também ("Tchau, tchau!" = "tchau tchau")
  const loose = n.replace(/[.,;:!?¡¿"'`´*_…]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (CERTAIN_CONTAINS.some((p) => n.includes(p) || loose.includes(p))) return 'certain';
  if (COMMON_EXACT.has(n) || COMMON_EXACT.has(loose) || COMMON_CONTAINS.some((p) => n.includes(p) || loose.includes(p))) return 'common';
  return null;
}

/** O texto é uma frase típica de alucinação (de qualquer tipo)? */
const isKnownHallucination = (text) => hallucinationKind(text) !== null;

/** Fração (0..1) do intervalo [start, end] coberta por `ranges` (lista de {start,end}). */
function coverage(start, end, ranges) {
  const span = end - start;
  if (!(span > 0)) return 0;
  let covered = 0;
  for (const r of ranges || []) {
    const a = Math.max(start, r.start);
    const b = Math.min(end, r.end);
    if (b > a) covered += b - a;
  }
  return Math.min(1, covered / span);
}

/**
 * Classifica cada segmento do motor.
 * @param {Array<{start:number,end:number,text:string,p:number|null}>} segments  (tempos no mesmo referencial das faixas)
 * @param {{ speech?:Array<{start:number,end:number}>, silences?:Array<{start:number,end:number|null}>, duration?:number }} ctx
 *   speech: trechos com som; silences: silêncios detectados (end null = até o fim)
 * @returns {Array<{ keep:boolean, reason:string|null, review:boolean }>} um item por segmento, na mesma ordem
 */
function classifySegments(segments, { speech = null, silences = [], duration = Infinity } = {}) {
  const silent = (silences || []).map((s) => ({ start: s.start, end: s.end === null || s.end === undefined ? duration : s.end }));
  const out = segments.map((seg) => {
    const p = Number.isFinite(seg.p) ? seg.p : null;
    const result = { keep: true, reason: null, review: false };
    if (isAnnotation(seg.text)) return { ...result, keep: false, reason: REASONS.annotation };
    const inSilence = coverage(seg.start, seg.end, silent) >= 0.9;
    if (inSilence) return { ...result, keep: false, reason: REASONS.silence };
    const kind = hallucinationKind(seg.text);
    if (kind === 'certain') return { ...result, keep: false, reason: REASONS.known };
    if (kind === 'common') {
      const outsideSpeech = Array.isArray(speech) && coverage(seg.start, seg.end, speech) < 0.5;
      if (outsideSpeech || (p !== null && p < KNOWN_PHRASE_CONFIDENCE)) return { ...result, keep: false, reason: REASONS.known };
    }
    if (p !== null && p < DISCARD_BELOW) return { ...result, keep: false, reason: REASONS.lowConfidence };
    if (p !== null && p < REVIEW_BELOW) result.review = true;
    return result;
  });

  // laço de repetição: 3 ou mais trechos seguidos com o mesmo texto -> fica o primeiro, marcado; o resto sai
  let i = 0;
  while (i < segments.length) {
    let j = i + 1;
    const key = normalize(segments[i].text);
    while (j < segments.length && key && normalize(segments[j].text) === key) j++;
    if (key && j - i >= 3 && out[i].keep) {
      out[i].review = true;
      for (let k = i + 1; k < j; k++) if (out[k].keep) out[k] = { keep: false, reason: REASONS.repetition, review: false };
    }
    i = j;
  }
  return out;
}

module.exports = {
  DISCARD_BELOW, REVIEW_BELOW, KNOWN_PHRASE_CONFIDENCE, REASONS,
  normalize, isAnnotation, isKnownHallucination, hallucinationKind, coverage, classifySegments
};

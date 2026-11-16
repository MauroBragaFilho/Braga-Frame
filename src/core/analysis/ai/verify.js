'use strict';

/**
 * CONFERÊNCIA LOCAL dos cortes sugeridos pela IA. Nunca se confia no modelo para isto: tudo é conferido contra a transcrição e o vídeo.
 *
 * Um candidato só passa se:
 *   - tem horários numéricos, início < fim, dentro do vídeo e dentro do bloco que foi enviado;
 *   - há fala de verdade na transcrição naquele intervalo (a IA não "inventa" um horário no silêncio); num jogo, onde quase não se fala
 *     durante o lance, a risada marcada também conta e basta menos do intervalo;
 *   - o texto de `punchline` EXISTE na transcrição do intervalo (cópia literal, tolerando pontuação, caixa e pequenas trocas);
 *   - cabe nas durações mínima/máxima das preferências (depois do ajuste; o que passa do máximo por pouco perde o começo, não o desfecho);
 *   - não repete um corte que já existe (qualquer status, inclusive rejeitado) nem outro candidato melhor;
 *   - tem relevância igual ou maior que a mínima das preferências.
 * O que passa é AJUSTADO aos limites das falas (início no começo da fala, fim no fim da fala), ganha as margens das preferências
 * (sem passar da duração máxima) e entra como sugestão. O que falha é descartado COM o motivo (o app conta e avisa).
 */

const { normText, cuesInRange, round3 } = require('../transcript/format');

const SNAP_SEC = 4;           // ajuste máximo de um horário até o limite de fala mais próximo
const MIN_SPEECH_RATIO = 0.2; // conversa e podcast: fração do intervalo com fala
const MIN_VOICE_RATIO = 0.1;  // jogo: fração do intervalo com fala OU risada marcada (num lance quase não se fala; a reação é a pista)
const MIN_WORDS = 3;
const MAX_START_TRIM_SEC = SNAP_SEC + 6; // quanto o começo pode ser adiantado para caber na duração máxima: o que o ajuste às falas pode ter somado
const DUP_OVERLAP = 0.3;      // sobreposição (do menor) a partir da qual dois candidatos são o mesmo momento
const FUZZY_MIN = 0.75;       // fração das palavras do desfecho que precisa aparecer, em ordem frouxa, para valer como "existe"

const REASONS = Object.freeze({
  time: 'horário inválido',
  range: 'fora do vídeo',
  window: 'fora do bloco enviado',
  nospeech: 'sem fala na transcrição nesse horário',
  punchline: 'o desfecho citado não existe na transcrição',
  duration: 'duração fora do permitido',
  existing: 'já coberto por um corte existente',
  duplicate: 'repete outro corte melhor',
  relevance: 'relevância abaixo do mínimo'
});

function overlapSec(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

/** O trecho já está coberto por algum corte existente? Mesma regra da aba Análise (renderer): pico dentro, 20% do trecho ou 50% do menor. */
function coveredBy(s, cuts) {
  const len = Math.max(0.001, s.end - s.start);
  for (const cut of cuts || []) {
    if (!cut || !Number.isFinite(cut.start) || !Number.isFinite(cut.end)) continue;
    const ov = overlapSec(s.start, s.end, cut.start, cut.end);
    if (ov <= 0) continue;
    if (Number.isFinite(s.peak) && s.peak >= cut.start && s.peak <= cut.end) return true;
    if (ov / len >= 0.2) return true;
    if (ov / Math.max(0.001, Math.min(len, cut.end - cut.start)) >= 0.5) return true;
  }
  return false;
}

const words = (text) => normText(text).split(' ').filter(Boolean);

/**
 * Onde o desfecho aparece nas falas `cues`? Devolve { start, end } (do começo da 1ª fala ao fim da última que o contém) ou null.
 * Exato (como trecho de palavras) ou, para frases de 3 ou mais palavras, quase exato (>= 75% das palavras numa janela curta).
 */
function findPunchline(punchline, cues) {
  const want = words(punchline);
  if (!want.length || !cues.length) return null;
  const tokens = [];
  for (const cue of cues) for (const w of words(cue.text)) tokens.push({ w, cue });
  if (tokens.length < want.length * 0.7) return null;
  const span = (i, j) => ({ start: tokens[i].cue.start, end: tokens[j].cue.end });
  // 1) sequência exata de palavras
  for (let i = 0; i + want.length <= tokens.length; i += 1) {
    let ok = true;
    for (let k = 0; k < want.length; k += 1) if (tokens[i + k].w !== want[k]) { ok = false; break; }
    if (ok) return span(i, i + want.length - 1);
  }
  if (want.length < MIN_WORDS) return null;
  // 2) janela deslizante com a maior parte das palavras
  const size = Math.ceil(want.length * 1.4) + 1;
  const need = new Map();
  for (const w of want) need.set(w, (need.get(w) || 0) + 1);
  let best = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const left = new Map(need);
    let hit = 0;
    let first = -1;
    let last = -1;
    for (let j = i; j < Math.min(tokens.length, i + size); j += 1) {
      const c = left.get(tokens[j].w);
      if (c > 0) { left.set(tokens[j].w, c - 1); hit += 1; if (first < 0) first = j; last = j; }
    }
    const score = hit / want.length;
    if (score >= FUZZY_MIN && (!best || score > best.score)) best = { score, first, last };
    if (best && best.score === 1) break;
  }
  return best ? span(best.first, best.last) : null;
}

/** Início ajustado ao começo da fala: a fala que contém `t`, ou o começo de fala mais próximo (até SNAP_SEC). */
function snapStart(t, cues) {
  for (const c of cues) if (c.start <= t && t < c.end) return t - c.start <= 6 ? c.start : t;
  let best = t;
  let dist = SNAP_SEC;
  for (const c of cues) {
    const d = Math.abs(c.start - t);
    if (d <= dist) { dist = d; best = c.start; }
  }
  return best;
}

/** Fim ajustado ao final da fala: a fala que contém `t`, ou o fim de fala mais próximo (até SNAP_SEC). */
function snapEnd(t, cues) {
  for (const c of cues) if (c.start < t && t <= c.end) return c.end - t <= 6 ? c.end : t;
  let best = t;
  let dist = SNAP_SEC;
  for (const c of cues) {
    const d = Math.abs(c.end - t);
    if (d <= dist) { dist = d; best = c.end; }
  }
  return best;
}

function shrinkToCueEnd(limit, minEnd, cues) {
  let best = null;
  for (const c of cues) if (c.end <= limit && c.end >= minEnd) best = c.end;
  return best;
}

/** Começo adiantado: o início de fala mais cedo dentro de [from, to]; null se não há nenhum. */
function trimStartToCue(from, to, cues) {
  let best = null;
  for (const c of cues) if (c.start >= from && c.start <= to && (best === null || c.start < best)) best = c.start;
  return best;
}

/**
 * @param {object} c candidato já lido (parse.js): { start, end, title, category, relevance, hook, punchline, reasons, layout, flags }
 * @param {object} x { cues, duration, window:{from,to}, prefs, existing }
 * @returns {{ ok:true, suggestion:object, adjusted:boolean } | { ok:false, reason:string, detail:string }}
 */
function verifyCandidate(c, x) {
  const { cues, duration, prefs } = x;
  const fail = (reason, detail) => ({ ok: false, reason, detail: detail || REASONS[reason] });
  let start = c.start;
  let end = c.end;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return fail('time');
  if (start < -1 || start >= duration || end > duration + 2) return fail('range');
  start = Math.max(0, start);
  end = Math.min(duration, end);
  if (end - start < 3) return fail('time', 'curto demais');
  const w = x.window;
  if (w && (start < w.from - 5 || end > w.to + 5)) return fail('window');
  if (end - start > prefs.maxDurationSec * 3) return fail('duration', 'bem mais longo que o máximo permitido');

  // há fala de verdade ali? Em conversa e podcast: 20% do intervalo com fala. Num jogo quase não se fala durante o lance (na live de
  // referência, metade das janelas de 45 s tem menos de 20% de fala e nenhum momento escolhido à mão tem menos de 10% de voz): a risada
  // marcada conta como voz e bastam 10%. Nos dois casos, pelo menos 3 palavras ditas, e o desfecho ainda precisa existir na
  // transcrição (logo abaixo): a IA continua sem poder inventar um horário no silêncio.
  const around = cuesInRange(cues, start - 2, end + 2);
  const spoken = around.filter((q) => !q.laugh);
  const speechSec = spoken.reduce((n, q) => n + overlapSec(q.start, q.end, start, end), 0);
  const wordCount = spoken.reduce((n, q) => n + words(q.text).length, 0);
  const talk = prefs.profile === 'conversa';
  const voiceSec = talk ? speechSec : around.reduce((n, q) => n + overlapSec(q.start, q.end, start, end), 0);
  if (voiceSec / (end - start) < (talk ? MIN_SPEECH_RATIO : MIN_VOICE_RATIO) || wordCount < MIN_WORDS) return fail('nospeech');

  // o desfecho existe na transcrição do intervalo?
  if (!c.punchline) return fail('punchline', 'o corte não traz a frase do desfecho');
  const where = findPunchline(c.punchline, around);
  if (!where) return fail('punchline');

  // ajuste aos limites das falas
  const origStart = start;
  const origEnd = end;
  start = snapStart(start, around);
  end = snapEnd(end, around);
  if (where.start < start) start = where.start;
  if (where.end > end) end = where.end;

  // margens das preferências, sem passar da duração máxima
  const padStart = Math.max(0, start - prefs.padBeforeSec);
  const padEnd = Math.min(duration, end + prefs.padAfterSec);
  if (padEnd - padStart <= prefs.maxDurationSec) { start = padStart; end = padEnd; }
  else if (end - padStart <= prefs.maxDurationSec) start = padStart;
  else if (padEnd - start <= prefs.maxDurationSec) end = padEnd;

  // duração máxima: encolhe o fim até o fim de uma fala que ainda inclui o desfecho
  if (end - start > prefs.maxDurationSec) {
    const cut = shrinkToCueEnd(start + prefs.maxDurationSec, where.end, around);
    if (cut !== null) end = cut;
    else {
      // o desfecho está no fim e encolher por ali o cortaria: adianta o começo até o início de uma fala, no máximo o que o ajuste às
      // falas pode ter somado (um corte de 60 s que ficou com 60,7 s não se perde por isso). O desfecho continua dentro.
      const moved = trimStartToCue(end - prefs.maxDurationSec, Math.min(where.start, start + MAX_START_TRIM_SEC), around);
      if (moved === null) return fail('duration', `passa de ${Math.round(prefs.maxDurationSec)} s e o desfecho fica depois disso`);
      start = moved;
    }
  }
  // duração mínima: estende (primeiro o fim, depois o começo), sempre dentro do vídeo
  if (end - start < prefs.minDurationSec) {
    let need = prefs.minDurationSec - (end - start);
    const wide = cuesInRange(cues, start - need - SNAP_SEC, end + need + SNAP_SEC);
    let newEnd = Math.min(duration, end + need * 0.6);
    const snappedEnd = snapEnd(newEnd, wide);
    if (snappedEnd >= newEnd && snappedEnd <= duration) newEnd = snappedEnd;
    end = newEnd;
    need = prefs.minDurationSec - (end - start);
    if (need > 0) {
      let newStart = Math.max(0, start - need);
      const snappedStart = snapStart(newStart, wide);
      if (snappedStart <= newStart) newStart = snappedStart;
      start = newStart;
    }
    if (end - start < prefs.minDurationSec) end = Math.min(duration, start + prefs.minDurationSec);
    if (end - start < prefs.minDurationSec - 0.01) return fail('duration', 'o vídeo é curto demais para a duração mínima');
    if (end - start > prefs.maxDurationSec) return fail('duration');
  }
  start = round3(Math.max(0, start));
  end = round3(Math.min(duration, end));
  if (!(end > start)) return fail('time');

  const relevance = c.relevance == null ? 0.5 : c.relevance;
  if (relevance < prefs.minRelevance) return fail('relevance', `${Math.round(relevance * 100)}% (mínimo ${Math.round(prefs.minRelevance * 100)}%)`);
  const peak = round3(Math.min(end, Math.max(start, where.start)));
  const suggestion = {
    id: `${Math.round(start * 10)}_${Math.round(end * 10)}`,
    start, end, peak, relevance: Math.round(relevance * 100) / 100,
    reasons: [...c.reasons],
    title: c.title, category: c.category, layout: c.layout, flags: [...c.flags], hook: c.hook, punchline: c.punchline,
    keywords: [...(c.keywords || [])], theme: c.theme || ''
  };
  if (coveredBy(suggestion, x.existing)) return fail('existing');
  return { ok: true, suggestion, adjusted: Math.abs(start - origStart) > 0.05 || Math.abs(end - origEnd) > 0.05 };
}

/** Tira os que são o mesmo momento (fica o de maior relevância). Entrada e saída: sugestões de verifyCandidate. */
function dedupe(list) {
  const sorted = [...list].sort((a, b) => b.relevance - a.relevance || a.start - b.start);
  const kept = [];
  const dropped = [];
  for (const s of sorted) {
    const dup = kept.some((k) => {
      const ov = overlapSec(s.start, s.end, k.start, k.end);
      if (ov <= 0) return false;
      return (s.peak >= k.start && s.peak <= k.end) || ov / Math.min(s.end - s.start, k.end - k.start) >= DUP_OVERLAP;
    });
    if (dup) dropped.push(s); else kept.push(s);
  }
  return { kept, dropped };
}

module.exports = { verifyCandidate, dedupe, findPunchline, coveredBy, snapStart, snapEnd, REASONS, SNAP_SEC };

'use strict';

/**
 * MODO "ALGORITMO + IA" (docs/recursos/analysis.md, "Algoritmo + IA"): junta as sugestões dos dois motores numa lista só.
 *   - o MESMO momento achado pelos dois (começo a até SAME_START_SEC um do outro, ou sobreposição de SAME_OVERLAP do menor) vira UMA sugestão,
 *     marcada `engines: ['algorithm', 'ai']`, com a relevância dos dois somada como chances independentes (1 - (1 - a)(1 - b): quando os
 *     dois acham, sobe para o topo), os motivos dos dois, o título e a categoria da IA e o episódio do algoritmo;
 *   - o que só um achou entra como veio (`engines: ['algorithm']` ou `['ai']`); o da IA ganha o episódio pelo instante do pico.
 * As BORDAS da sugestão em dupla seguem `bounds`: 'union' (padrão: do começo mais cedo ao fim mais tarde; na gameplay de CoD medida, mais
 * cortes começando no lance e mais do momento coberto que as bordas só da IA ou só do algoritmo), 'ai' ou 'algorithm'.
 * Ordem: veja orderMerged.
 * Se um dos motores falhou, o resultado é o do outro com um aviso (`aiError` / `algorithmError`).
 * CONFERÊNCIA: se a IA devolveu vereditos (`ai.review.verdicts`, ai/analyze.js) sobre as sugestões que só o algoritmo achou, as
 * recusadas saem da lista e vão para `review.droppedList` (com o motivo dela); as aprovadas ficam com `review: 'ai'`, o título dela e o
 * motivo na frente dos do algoritmo. A nota continua a do algoritmo. Sugestão sem veredito fica como estava.
 * Se o veredito traz início e fim novos (já conferidos em ai/analyze.js, reviewBounds), a aprovada passa a usá-los, sem invadir a
 * sugestão vizinha e sem ficar abaixo da duração mínima; as bordas do algoritmo ficam em `reviewFrom` e um motivo diz o que mudou.
 */
const { episodeAt } = require('./segments');

const SAME_START_SEC = 5;
const SAME_OVERLAP = 0.5;
const MERGE_BOUNDS = 'union';
const MAX_MERGED = 600;

function overlapShare(a, b) {
  const ov = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  return shorter > 0 ? ov / shorter : 0;
}

/** Os dois motores apontam o mesmo momento? (a mesma regra do placar de scripts/eval-analysis.js) */
function sameMoment(a, b) {
  return Math.abs(a.start - b.start) <= SAME_START_SEC || overlapShare(a, b) >= SAME_OVERLAP;
}

const round3 = (x) => Math.round(x * 1000) / 1000;

/** Pares um-para-um: os de maior sobreposição primeiro (empate: começo mais próximo). */
function pairUp(algo, ai) {
  const pairs = [];
  algo.forEach((a, i) => ai.forEach((b, j) => {
    if (sameMoment(a, b)) pairs.push({ i, j, share: overlapShare(a, b), gap: Math.abs(a.start - b.start) });
  }));
  pairs.sort((x, y) => y.share - x.share || x.gap - y.gap);
  const usedA = new Set();
  const usedB = new Set();
  const out = [];
  for (const p of pairs) {
    if (usedA.has(p.i) || usedB.has(p.j)) continue;
    usedA.add(p.i);
    usedB.add(p.j);
    out.push(p);
  }
  return out;
}

function boundsOf(a, b, mode, maxSec) {
  if (mode === 'ai') return { start: b.start, end: b.end };
  if (mode === 'algorithm') return { start: a.start, end: a.end };
  const start = Math.min(a.start, b.start);
  const end = Math.max(a.end, b.end);
  // a união não passa da duração máxima: aí vale a borda da IA (que já respeita a duração, conferida em ai/verify.js)
  if (maxSec > 0 && end - start > maxSec) return { start: b.start, end: b.end };
  return { start, end };
}

function together(a, b, mode, maxSec) {
  const { start, end } = boundsOf(a, b, mode, maxSec);
  const reasons = [];
  for (const r of [...(b.reasons || []), ...(a.reasons || [])]) if (r && !reasons.includes(r)) reasons.push(r);
  const peak = a.peak >= start && a.peak <= end ? a.peak : Math.min(end, Math.max(start, b.peak));
  const out = {
    ...b, ...a, // campos de cada motor (evidence/signals do algoritmo; title/category/layout/flags/theme/keywords da IA abaixo)
    id: a.id, start, end, peak,
    relevance: round3(1 - (1 - (a.relevance || 0)) * (1 - (b.relevance || 0))),
    reasons, engines: ['algorithm', 'ai']
  };
  for (const key of ['title', 'category', 'layout', 'flags', 'theme', 'keywords']) {
    if (b[key] !== undefined) out[key] = b[key]; else delete out[key];
  }
  return out;
}

/** "a IA ajustou o corte: começa 12 s antes e termina 6 s depois". */
function adjustText(from, to) {
  const parts = [];
  const ds = Math.round(from.start - to.start);
  if (ds >= 1) parts.push(`começa ${ds} s antes`); else if (ds <= -1) parts.push(`começa ${-ds} s depois`);
  const de = Math.round(to.end - from.end);
  if (de >= 1) parts.push(`termina ${de} s depois`); else if (de <= -1) parts.push(`termina ${-de} s antes`);
  return `a IA ajustou o corte: ${parts.join(' e ')}`;
}

/**
 * Bordas que a IA acertou na conferência. Em ordem de tempo, cada uma só cresce até a sugestão vizinha (a de antes e a de depois, já com as
 * bordas novas): nunca invade espaço de outra (se já havia sobreposição, ela não aumenta). Se o que sobra fica abaixo da duração mínima ou
 * deixa de ser o mesmo momento, a sugestão fica como o algoritmo deixou. Devolve quantas mudaram.
 */
function applyReviewBounds(suggestions, pending, minSec) {
  let adjusted = 0;
  for (const [s, b] of [...pending].sort((x, y) => x[0].start - y[0].start)) {
    let lo = 0;
    let hi = Infinity;
    for (const o of suggestions) {
      if (o === s) continue;
      if (o.start < s.start) lo = Math.max(lo, o.end); else hi = Math.min(hi, o.start);
    }
    const start = round3(Math.max(b.start, Math.min(lo, s.start)));
    const end = round3(Math.min(b.end, Math.max(hi, s.end)));
    if (end - start < minSec - 0.01 || end <= start) continue;
    if (!sameMoment({ start, end }, s)) continue;
    if (Math.abs(start - s.start) < 1 && Math.abs(end - s.end) < 1) continue;
    const from = { start: s.start, end: s.end };
    const reasons = s.reasons.slice();
    reasons.splice(b.at, 0, adjustText(from, { start, end }));
    Object.assign(s, { start, end, reviewFrom: from, reasons });
    if (Number.isFinite(s.peak)) s.peak = Math.min(end, Math.max(start, s.peak));
    adjusted += 1;
  }
  return adjusted;
}

/**
 * Ordem da lista ("mais relevantes primeiro"): o que os DOIS acharam vem primeiro; depois alterna um da IA e um do algoritmo, cada motor na
 * própria ordem de relevância. As relevâncias dos dois motores não estão na mesma escala (a do algoritmo encosta em 100% nos picos fortes),
 * então ordenar tudo pelo número misturaria mal; alternar não supõe que um motor seja melhor que o outro.
 */
function orderMerged(list) {
  const byRel = (x, y) => y.relevance - x.relevance || x.start - y.start;
  const kind = (s) => (s.engines.length === 2 ? 'both' : s.engines[0]);
  const both = list.filter((s) => kind(s) === 'both').sort(byRel);
  const ai = list.filter((s) => kind(s) === 'ai').sort(byRel);
  const algo = list.filter((s) => kind(s) === 'algorithm').sort(byRel);
  const out = [...both];
  for (let i = 0; i < Math.max(ai.length, algo.length); i += 1) {
    if (ai[i]) out.push(ai[i]);
    if (algo[i]) out.push(algo[i]);
  }
  return out;
}

/**
 * Junta o resultado do algoritmo (`algo`) e o da IA (`ai`); qualquer um pode faltar (o motor falhou: `algorithmError` / `aiError` dizem por quê).
 * Devolve um resultado no formato dos dois motores, com `engine: 'both'` e `merge: { algorithm, ai, both, aiFailed?, algorithmFailed? }`
 * (quantas sugestões só do algoritmo, só da IA e dos dois).
 */
function mergeResults(algo, ai, { bounds = MERGE_BOUNDS, aiError = null, algorithmError = null } = {}) {
  if (!algo && !ai) throw new Error('mergeResults: falta o resultado dos dois motores');
  const A = algo ? algo.suggestions || [] : [];
  const B = ai ? ai.suggestions || [] : [];
  const pairs = pairUp(A, B);
  const pairedA = new Map(pairs.map((p) => [p.i, p.j]));
  const pairedB = new Set(pairs.map((p) => p.j));
  const episodes = algo && Array.isArray(algo.episodes) ? algo.episodes : [];
  const maxSec = Number((algo && algo.params && algo.params.maxDurationSec) || (ai && ai.params && ai.params.maxDurationSec)) || 0;
  const suggestions = [];
  const verdicts = new Map(((ai && ai.review && Array.isArray(ai.review.verdicts)) ? ai.review.verdicts : []).map((v) => [String(v.id), v]));
  const droppedList = [];
  const pending = new Map(); // sugestão aprovada -> { start, end, at } (bordas novas da IA; at = onde entra o motivo do ajuste)
  A.forEach((a, i) => {
    if (pairedA.has(i)) { suggestions.push(together(a, B[pairedA.get(i)], bounds, maxSec)); return; }
    const v = verdicts.get(String(a.id));
    if (v && v.keep === false) {
      droppedList.push({ start: a.start, end: a.end, relevance: a.relevance, why: (v.reasons && v.reasons[0]) || '' });
      return;
    }
    const s = { ...a, engines: ['algorithm'] };
    if (v && v.keep === true) {
      s.review = 'ai';
      if (v.title) s.title = v.title;
      if (v.category) s.category = v.category;
      const reasons = [];
      for (const r of [...(v.reasons || []), ...(a.reasons || [])]) if (r && !reasons.includes(r)) reasons.push(r);
      s.reasons = reasons;
      if (Number.isFinite(v.start) && Number.isFinite(v.end) && v.end > v.start) {
        pending.set(s, { start: v.start, end: v.end, at: (v.reasons || []).filter(Boolean).length });
      }
    }
    suggestions.push(s);
  });
  B.forEach((b, j) => {
    if (pairedB.has(j)) return;
    const s = { ...b, engines: ['ai'] };
    if (episodes.length) {
      const ep = episodeAt(episodes, b.peak);
      if (ep) s.episode = ep;
    }
    suggestions.push(s);
  });
  const minSec = Number((algo && algo.params && algo.params.minDurationSec) || (ai && ai.params && ai.params.minDurationSec)) || 0;
  const adjusted = pending.size ? applyReviewBounds(suggestions, pending, minSec) : 0;
  // ids únicos (o da IA e o do algoritmo têm o mesmo formato "início_fim" e podem coincidir)
  const seen = new Set();
  for (const s of suggestions) {
    let id = String(s.id);
    while (seen.has(id)) id = `${id}b`;
    seen.add(id);
    s.id = id;
  }
  const ordered = orderMerged(suggestions);

  const warnings = [...(algo && algo.warnings ? algo.warnings : []), ...(ai && ai.warnings ? ai.warnings : [])];
  if (aiError) warnings.unshift({ code: 'AI_FAILED', message: `A parte da IA falhou (${aiError.message || aiError.code || 'erro'}); ficaram só as sugestões do algoritmo.` });
  if (algorithmError) warnings.unshift({ code: 'ALGORITHM_FAILED', message: `A parte do algoritmo falhou (${algorithmError.message || algorithmError.code || 'erro'}); ficaram só as sugestões da IA.` });
  const base = algo || ai;
  return {
    ...base,
    engine: 'both',
    at: (ai && ai.at) || base.at,
    fromCache: false,
    tookMs: (algo ? algo.tookMs || 0 : 0) + (ai ? ai.tookMs || 0 : 0),
    usedSignals: [...(algo ? algo.usedSignals || [] : []), ...(ai ? ['ai'] : [])],
    limit: (algo ? algo.limit || 0 : 0) + (ai ? ai.limit || 0 : 0),
    warnings,
    suggestions: ordered.slice(0, MAX_MERGED),
    ...(ai && ai.ai ? { ai: ai.ai } : {}),
    ...(ai && ai.review ? { review: { sent: ai.review.sent || 0, kept: ai.review.kept || 0, dropped: droppedList.length, unanswered: ai.review.unanswered || 0, adjusted, droppedList } } : {}),
    merge: {
      algorithm: suggestions.filter((s) => s.engines.length === 1 && s.engines[0] === 'algorithm').length,
      ai: suggestions.filter((s) => s.engines.length === 1 && s.engines[0] === 'ai').length,
      both: pairs.length,
      ...(aiError ? { aiFailed: true } : {}),
      ...(algorithmError ? { algorithmFailed: true } : {})
    }
  };
}

module.exports = { mergeResults, sameMoment, overlapShare, SAME_START_SEC, SAME_OVERLAP, MERGE_BOUNDS };

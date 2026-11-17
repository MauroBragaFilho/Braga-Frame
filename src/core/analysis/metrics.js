'use strict';

/**
 * Métricas de qualidade das sugestões de corte (Etapa 4, docs/avaliacao.md). Puro (sem disco, sem rede): recebe listas de trechos
 * `{ start, end, relevance? }` (sugestões) e `{ start, end }` (gabarito) e devolve números.
 *
 * Regra de "bater" (a mesma do scripts/eval-analysis.js): o INÍCIO da sugestão difere do do gabarito em até `tolerance` segundos, OU a
 * sobreposição é de pelo menos `overlapFraction` da menor das duas durações.
 *
 *   prf(sugestões, gabarito)          precisão, revocação e F1 com pareamento 1:1 (cada sugestão serve a um item; cada item a uma sugestão)
 *   duplicity(sugestões)              quantas sugestões repetem um momento já coberto por outra, mais relevante
 *   reviewSeconds(sugestões)          quantos segundos de vídeo o usuário precisa ASSISTIR para revisar a lista (união dos trechos, sem contar duas vezes)
 *   reviewCurve(sugestões, gabarito)  revocação x tempo de revisão, da mais para a menos relevante, e o FATOR DE TEMPO ECONOMIZADO contra procurar à mão
 *   atBudget(sugestões, n)            só as `n` mais relevantes (para comparar motores com o MESMO número de sugestões: achar mais candidatos não é ser melhor)
 */

const overlapSec = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const ratio = (a, b) => (b > 0 ? a / b : null);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** A sugestão bate com o item do gabarito? */
function matches(sug, gold, { tolerance = 5, overlapFraction = 0.5 } = {}) {
  if (Math.abs(sug.start - gold.start) <= tolerance) return true;
  const ov = overlapSec(sug.start, sug.end, gold.start, gold.end);
  return ov > 0 && ov / Math.min(sug.end - sug.start, gold.end - gold.start) >= overlapFraction;
}

/** Pareamento guloso 1:1: os pares de início mais próximo primeiro. Devolve [{ g, s, d }]. */
function pairOneToOne(suggestions, gold, opts) {
  const candidates = [];
  for (const g of gold) for (const s of suggestions) if (matches(s, g, opts)) candidates.push({ g, s, d: Math.abs(s.start - g.start) });
  candidates.sort((a, b) => a.d - b.d);
  const usedG = new Set();
  const usedS = new Set();
  const pairs = [];
  for (const c of candidates) {
    if (usedG.has(c.g) || usedS.has(c.s)) continue;
    usedG.add(c.g);
    usedS.add(c.s);
    pairs.push(c);
  }
  return pairs;
}

const clean = (list) => (Array.isArray(list) ? list : []).filter((x) => x && finite(x.start) && finite(x.end) && x.end > x.start);

/** F1 a partir de precisão e revocação (null se alguma não existe; 0 se as duas são 0). */
function f1Of(precision, recall) {
  if (precision === null || recall === null) return null;
  return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
}

/** Precisão, revocação e F1 com pareamento 1:1. `tp` = pares; `fp` = sugestões sem par; `fn` = itens do gabarito sem par. */
function prf(suggestions, gold, opts = {}) {
  const sugs = clean(suggestions);
  const gs = clean(gold);
  const pairs = pairOneToOne(sugs, gs, opts);
  const tp = pairs.length;
  const precision = ratio(tp, sugs.length);
  const recall = ratio(tp, gs.length);
  return { tp, fp: sugs.length - tp, fn: gs.length - tp, precision, recall, f1: f1Of(precision, recall), suggestions: sugs.length, gold: gs.length };
}

/**
 * Duplicidade: uma sugestão é REPETIDA quando se sobrepõe a outra de maior relevância em pelo menos `overlapFraction` da menor das duas, ou
 * começa a menos de `nearSec` do início dela (o mesmo momento achado duas vezes). Devolve { repeated, rate }; sem sugestões, rate null.
 */
function duplicity(suggestions, { overlapFraction = 0.3, nearSec = 8 } = {}) {
  const sugs = clean(suggestions).map((s, i) => ({ ...s, order: i }));
  const ranked = [...sugs].sort((a, b) => (finite(b.relevance) ? b.relevance : -1) - (finite(a.relevance) ? a.relevance : -1) || a.order - b.order);
  const kept = [];
  let repeated = 0;
  for (const s of ranked) {
    const dup = kept.some((k) => {
      const ov = overlapSec(s.start, s.end, k.start, k.end);
      return Math.abs(s.start - k.start) <= nearSec || (ov > 0 && ov / Math.min(s.end - s.start, k.end - k.start) >= overlapFraction);
    });
    if (dup) repeated += 1; else kept.push(s);
  }
  return { repeated, rate: ratio(repeated, sugs.length) };
}

/** Segundos de vídeo que cobrem os trechos (a união: trechos que se sobrepõem contam uma vez). `padSec` acrescenta contexto de cada lado. */
function reviewSeconds(suggestions, { padSec = 0 } = {}) {
  const spans = clean(suggestions).map((s) => [s.start - padSec, s.end + padSec]).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = null;
  let curEnd = null;
  for (const [a, b] of spans) {
    if (curEnd === null || a > curEnd) { if (curEnd !== null) total += curEnd - curStart; curStart = a; curEnd = b; } else curEnd = Math.max(curEnd, b);
  }
  if (curEnd !== null) total += curEnd - curStart;
  return total;
}

/** Só as `n` mais relevantes (empate: a ordem em que vieram). `n` null/0 devolve tudo. */
function atBudget(suggestions, n) {
  const list = clean(suggestions).map((s, i) => ({ ...s, order: i }));
  if (!(n > 0)) return list;
  return list.sort((a, b) => (finite(b.relevance) ? b.relevance : -1) - (finite(a.relevance) ? a.relevance : -1) || a.order - b.order).slice(0, Math.floor(n));
}

/**
 * Revocação x tempo de revisão. O usuário revisa as sugestões da MAIS para a MENOS relevante; cada ponto diz quantos segundos de vídeo ele já
 * assistiu (união dos trechos, com `padSec` de contexto) e quantos itens do gabarito já viu (qualquer sugestão revisada que bata).
 * `saved[r]` (r = 0,25 / 0,5 / 0,75): para chegar a esse nível de revocação o usuário assistiu `seconds` segundos; procurando à mão, o esperado é
 * r × duração (percorrer o vídeo em ordem: ver uma fração f do vídeo mostra, em média, f dos momentos). `factor` = (r × duração) / seconds: 3,0 quer dizer
 * "três vezes menos vídeo para achar a mesma metade". null quando a lista nunca chega a esse nível.
 */
function reviewCurve(suggestions, gold, duration, { tolerance = 5, overlapFraction = 0.5, padSec = 0, levels = [0.25, 0.5, 0.75] } = {}) {
  const gs = clean(gold);
  const ranked = atBudget(suggestions, 0);
  ranked.sort((a, b) => (finite(b.relevance) ? b.relevance : -1) - (finite(a.relevance) ? a.relevance : -1) || a.order - b.order);
  const points = [];
  const seen = new Set();
  const reviewed = [];
  for (const s of ranked) {
    reviewed.push(s);
    gs.forEach((g, i) => { if (!seen.has(i) && matches(s, g, { tolerance, overlapFraction })) seen.add(i); });
    points.push({ n: reviewed.length, seconds: reviewSeconds(reviewed, { padSec }), found: seen.size, recall: ratio(seen.size, gs.length) });
  }
  const saved = {};
  for (const r of levels) {
    const point = points.find((p) => p.recall !== null && p.recall >= r);
    saved[r] = point && duration > 0 ? { seconds: point.seconds, suggestions: point.n, manualSeconds: r * duration, factor: point.seconds > 0 ? (r * duration) / point.seconds : null } : null;
  }
  return { points, saved, finalRecall: points.length ? points[points.length - 1].recall : (gs.length ? 0 : null), totalSeconds: points.length ? points[points.length - 1].seconds : 0 };
}

module.exports = { matches, pairOneToOne, f1Of, prf, duplicity, reviewSeconds, reviewCurve, atBudget, overlapSec };

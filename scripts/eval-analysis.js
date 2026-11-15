#!/usr/bin/env node
'use strict';

/**
 * Avaliação da análise de momentos (algoritmo ou IA) contra um gabarito feito à mão. Sem dependências.
 *
 *   node scripts/eval-analysis.js --result <resultado.json> --gold <gabarito.json> [--run <nome>] [--tolerance 5] [--overlap 0.5] [--top 8]
 *                                  [--from <seg>] [--to <seg>] [--chance <duração do vídeo em seg>] [--draws N] [--skip-breaks] [--json]
 *   (ou as variáveis BF_EVAL_RESULT e BF_EVAL_GOLD; os caminhos NUNCA ficam no repositório: transcrição, chat e gabarito são conteúdo do dono)
 *
 * Entradas aceitas
 *   resultado: lista [{ start, end, relevance? }], ou um objeto com `suggestions` (resultado de `analysis:done`), ou um objeto com
 *              `results: { <nome>: { suggestions } }` (use --run <nome>).
 *   gabarito:  lista [{ s, e, r?, t?, c? }] (ou start/end em vez de s/e), tempos em segundos.
 *
 * Quando uma sugestão "bate" com um item do gabarito: o INÍCIO difere até --tolerance segundos (padrão 5), OU a sobreposição é de pelo
 * menos --overlap (padrão 0,5 = 50%) da menor das duas durações.
 *
 * Faixa (--from/--to, em segundos): só entram os itens do gabarito e as sugestões cujo INÍCIO cai em [from, to). Serve para separar a metade em
 * que se AJUSTOU o algoritmo da metade em que ele só é TESTADO (o gabarito de uma live só é feito por quem leu a transcrição: sobreajuste e
 * circularidade são riscos reais; reporte as duas faixas separadas).
 *
 * Acaso (--chance <duração do vídeo em segundos> [--draws 20000]): sorteia os MESMOS número e durações de trechos das sugestões, sem sobreposição, em qualquer
 * ponto do vídeo (semente fixa: repetível) e diz quantos itens do gabarito o acaso acerta (média, p95, p99) e a chance de acertar tantos quanto a execução
 * real ou mais. Com um gabarito pequeno o acaso acerta bastante: a revocação sozinha não diz se o resultado é melhor do que sortear trechos.
 * Com --skip-breaks o acaso só sorteia FORA das telas de espera que a análise achou (`breaks` do resultado; docs/recursos/analysis.md, "Episódios e
 * telas de espera"). Numa live com muita espera (a live de podcast medida tem 54 de 119 min) o sorteio no vídeo inteiro cai na espera e faz o motor parecer
 * melhor do que é: o acaso justo sorteia só onde há programa.
 *
 * Números (todos honestos sobre o que medem):
 *   revocação          itens do gabarito que têm AO MENOS uma sugestão batendo / total do gabarito
 *   revocação 1:1      o mesmo, mas cada sugestão só serve a um item (pareamento guloso pelo início mais próximo)
 *   precisão aprox.    sugestões que batem com ALGUM item do gabarito / total de sugestões. É APROXIMADA: o gabarito tem poucos itens e uma sugestão
 *                      fora dele não é necessariamente ruim (pode ser um bom momento que o dono não marcou)
 *   precisão 1:1       sugestões pareadas / total de sugestões
 *   distância média    média de |início sugerido - início do gabarito| e de |fim - fim| nos pares 1:1, em segundos
 *   revocação nas N melhores   só as N sugestões mais relevantes (ordem de `relevance`, ou a ordem recebida) contam
 */

const fs = require('node:fs');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function normalizeGold(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.picks) ? raw.picks : []);
  return list.map((g, i) => ({
    index: i + 1,
    start: num(g.s) ?? num(g.start),
    end: num(g.e) ?? num(g.end),
    relevance: num(g.r) ?? num(g.relevance),
    title: String(g.t || g.title || ''),
    category: String(g.c || g.category || '')
  })).filter((g) => g.start !== null && g.end !== null && g.end > g.start);
}

function normalizeSuggestions(raw, run) {
  let list = raw;
  if (raw && !Array.isArray(raw)) {
    if (raw.results && typeof raw.results === 'object') {
      const key = run || Object.keys(raw.results)[0];
      if (!raw.results[key]) throw new Error(`Execução "${key}" não existe no resultado. Opções: ${Object.keys(raw.results).join(', ')}`);
      list = raw.results[key].suggestions;
    } else list = raw.suggestions;
  }
  if (!Array.isArray(list)) throw new Error('Resultado sem a lista de sugestões (esperava uma lista ou um objeto com "suggestions").');
  return list.map((s, i) => ({ order: i, start: num(s.start), end: num(s.end), relevance: num(s.relevance), title: String(s.title || '') })).filter((s) => s.start !== null && s.end !== null && s.end > s.start);
}

function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

/** A sugestão bate com o item do gabarito? */
function matches(sug, gold, { tolerance = 5, overlapFraction = 0.5 } = {}) {
  if (Math.abs(sug.start - gold.start) <= tolerance) return true;
  const ov = overlap(sug.start, sug.end, gold.start, gold.end);
  return ov > 0 && ov / Math.min(sug.end - sug.start, gold.end - gold.start) >= overlapFraction;
}

/** Pareamento guloso 1:1: os pares mais próximos (pelo início) primeiro. Devolve [{ g, s }]. */
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

const ratio = (a, b) => (b > 0 ? a / b : null);
const mean = (xs) => (xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : null);

/**
 * @param {Array} suggestionsRaw
 * @param {Array} goldRaw
 * @param {{ tolerance?:number, overlapFraction?:number, top?:number }} [opts]
 */
function evaluate(suggestionsRaw, goldRaw, opts = {}) {
  const o = { tolerance: opts.tolerance ?? 5, overlapFraction: opts.overlapFraction ?? 0.5 };
  const from = Number.isFinite(opts.from) ? opts.from : -Infinity;
  const to = Number.isFinite(opts.to) ? opts.to : Infinity;
  const inRange = (x) => x.start >= from && x.start < to;
  const allGold = Array.isArray(goldRaw) && goldRaw[0] && 'index' in goldRaw[0] ? goldRaw : normalizeGold(goldRaw);
  const allSugs = Array.isArray(suggestionsRaw) && suggestionsRaw[0] && 'order' in suggestionsRaw[0] ? suggestionsRaw : normalizeSuggestions(suggestionsRaw);
  const gold = allGold.filter(inRange);
  const sugs = allSugs.filter(inRange);
  const hitGold = gold.filter((g) => sugs.some((s) => matches(s, g, o)));
  const hitSugs = sugs.filter((s) => gold.some((g) => matches(s, g, o)));
  const pairs = pairOneToOne(sugs, gold, o);
  const byRelevance = [...sugs].sort((a, b) => (b.relevance ?? -1) - (a.relevance ?? -1) || a.order - b.order);
  const topN = (n) => {
    const top = byRelevance.slice(0, n);
    const hits = gold.filter((g) => top.some((s) => matches(s, g, o)));
    return { n, recall: ratio(hits.length, gold.length), hits: hits.length };
  };
  const best = gold.filter((g) => (g.relevance ?? 0) >= 0.78);
  const bestHits = best.filter((g) => sugs.some((s) => matches(s, g, o)));
  return {
    range: Number.isFinite(from) || Number.isFinite(to) ? { from: Number.isFinite(from) ? from : null, to: Number.isFinite(to) ? to : null } : null,
    gold: gold.length,
    suggestions: sugs.length,
    tolerance: o.tolerance,
    overlapFraction: o.overlapFraction,
    recall: ratio(hitGold.length, gold.length),
    recallHits: hitGold.length,
    recallOneToOne: ratio(pairs.length, gold.length),
    precisionApprox: ratio(hitSugs.length, sugs.length),
    precisionHits: hitSugs.length,
    precisionOneToOne: ratio(pairs.length, sugs.length),
    pairs: pairs.length,
    meanStartDistanceSec: mean(pairs.map((p) => Math.abs(p.s.start - p.g.start))),
    meanEndDistanceSec: mean(pairs.map((p) => Math.abs(p.s.end - p.g.end))),
    recallBest: { total: best.length, hits: bestHits.length, recall: ratio(bestHits.length, best.length) },
    topN: opts.top ? topN(opts.top) : null,
    topGold: topN(gold.length || 1),
    missed: gold.filter((g) => !hitGold.includes(g)).map((g) => ({ index: g.index, start: g.start, end: g.end, relevance: g.relevance, title: g.title })),
    pairsDetail: pairs.map((p) => ({ gold: p.g.index, goldStart: p.g.start, start: p.s.start, end: p.s.end, deltaStart: Math.round((p.s.start - p.g.start) * 10) / 10 }))
  };
}

/**
 * Referência do ACASO (sem dependências, repetível: gerador com semente fixa). Sorteia os MESMOS número e durações de trechos das sugestões, sem
 * sobreposição, em qualquer ponto de [0, duration], e conta quantos itens do gabarito eles acertam pela mesma regra de `matches`. Responde "isso é
 * melhor do que colocar os trechos ao acaso?": um gabarito de 15 itens numa live de 3 h é acertado ao acaso com frequência (18 trechos de 36 s
 * acertam em média 1,2 dos 15).
 * Devolve { draws, suggestions, mean, p95, p99, max, hits, pAtLeast } (`hits` = acertos da execução real; `pAtLeast` = chance de o acaso acertar
 * tantos quanto ela ou mais) ou null sem sugestões, sem gabarito ou sem duração. Vale para o vídeo inteiro (ignora --from/--to).
 */
/** Tempo "só de programa": tira de `t` a parte das telas de espera (`breaks`, em ordem) que vem antes dele. */
function contentTime(t, breaks) {
  let x = t;
  for (const b of breaks) {
    if (t >= b.end) x -= b.end - b.start;
    else if (t > b.start) x -= t - b.start;
  }
  return x;
}

function chanceBaseline(suggestionsRaw, goldRaw, duration, opts = {}) {
  const o = { tolerance: opts.tolerance ?? 5, overlapFraction: opts.overlapFraction ?? 0.5 };
  const draws = Math.max(100, Math.min(200000, Math.round(opts.draws ?? 20000)));
  const goldReal = Array.isArray(goldRaw) && goldRaw[0] && 'index' in goldRaw[0] ? goldRaw : normalizeGold(goldRaw);
  const sugs = Array.isArray(suggestionsRaw) && suggestionsRaw[0] && 'order' in suggestionsRaw[0] ? suggestionsRaw : normalizeSuggestions(suggestionsRaw);
  const durations = sugs.map((s) => s.end - s.start);
  // `exclude` (telas de espera): o sorteio acontece no tempo só de programa, com o gabarito levado para esse tempo; os acertos reais não mudam
  const breaks = (Array.isArray(opts.exclude) ? opts.exclude : [])
    .filter((b) => b && b.end > b.start && b.start < duration).map((b) => ({ start: Math.max(0, b.start), end: Math.min(duration, b.end) }))
    .sort((a, b) => a.start - b.start);
  const gold = breaks.length ? goldReal.map((g) => ({ ...g, start: contentTime(g.start, breaks), end: contentTime(g.end, breaks) })) : goldReal;
  duration = breaks.length ? contentTime(duration, breaks) : duration;
  if (!(duration > 0) || !durations.length || !gold.length) return null;
  let seed = (opts.seed ?? 12345) >>> 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const counts = [];
  for (let d = 0; d < draws; d += 1) {
    const placed = [];
    for (const length of durations) {
      for (let tries = 0; tries < 200; tries += 1) {
        const start = random() * Math.max(0, duration - length);
        if (placed.every((p) => start >= p.end || start + length <= p.start)) { placed.push({ start, end: start + length }); break; }
      }
    }
    counts.push(gold.filter((g) => placed.some((p) => matches(p, g, o))).length);
  }
  counts.sort((a, b) => a - b);
  const at = (q) => counts[Math.min(counts.length - 1, Math.floor(q * counts.length))];
  const hits = goldReal.filter((g) => sugs.some((s) => matches(s, g, o))).length;
  return {
    draws, suggestions: durations.length, ...(breaks.length ? { contentSec: Math.round(duration) } : {}), mean: counts.reduce((n, v) => n + v, 0) / counts.length,
    p95: at(0.95), p99: at(0.99), max: counts[counts.length - 1], hits, pAtLeast: counts.filter((v) => v >= hits).length / counts.length
  };
}

const pct = (x) => (x === null ? 'n/d' : `${Math.round(x * 100)}%`);
const sec = (x) => (x === null ? 'n/d' : `${(Math.round(x * 10) / 10).toLocaleString('pt-BR')} s`);

const clock = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;

function format(r) {
  const lines = [
    ...(r.range ? [`Faixa: ${r.range.from === null ? 'início' : clock(r.range.from)} a ${r.range.to === null ? 'fim' : clock(r.range.to)} (só itens e sugestões que COMEÇAM nela)`] : []),
    `Gabarito: ${r.gold} cortes · Sugestões: ${r.suggestions} · bate = início até ${r.tolerance} s de diferença ou sobreposição >= ${Math.round(r.overlapFraction * 100)}%`,
    `Revocação: ${pct(r.recall)} (${r.recallHits}/${r.gold}) · 1:1: ${pct(r.recallOneToOne)} (${r.pairs}/${r.gold})`,
    `Precisão aproximada: ${pct(r.precisionApprox)} (${r.precisionHits}/${r.suggestions}) · 1:1: ${pct(r.precisionOneToOne)} (${r.pairs}/${r.suggestions})`,
    `Distância média nos pares 1:1: início ${sec(r.meanStartDistanceSec)}, fim ${sec(r.meanEndDistanceSec)}`,
    `Revocação nos "melhores" (relevância >= 0,78 no gabarito): ${pct(r.recallBest.recall)} (${r.recallBest.hits}/${r.recallBest.total})`,
    `Revocação usando só as ${r.topGold.n} sugestões mais relevantes: ${pct(r.topGold.recall)} (${r.topGold.hits}/${r.gold})`
  ];
  if (r.topN) lines.push(`Revocação usando só as ${r.topN.n} mais relevantes: ${pct(r.topN.recall)} (${r.topN.hits}/${r.gold})`);
  if (r.missed.length) lines.push(`Não sugeridos: ${r.missed.map((m) => `#${m.index} ${Math.floor(m.start / 60)}:${String(Math.floor(m.start % 60)).padStart(2, '0')}`).join(', ')}`);
  return lines.join('\n');
}

/** "Acaso (20.000 sorteios, mesmas 18 durações): média 1,25 acertos; p95 3; p99 4; chance de o acaso acertar 3 ou mais: 12%". */
function formatChance(c) {
  if (!c) return 'Acaso: sem sugestões, gabarito ou duração do vídeo para calcular.';
  const p = c.pAtLeast < 0.001 ? '< 0,1%' : `${(Math.round(c.pAtLeast * 1000) / 10).toLocaleString('pt-BR')}%`;
  return `Acaso (${c.draws.toLocaleString('pt-BR')} sorteios, as mesmas ${c.suggestions} durações${c.contentSec ? `, só fora das telas de espera (${Math.round(c.contentSec / 60)} min de programa)` : ''}): média ${(Math.round(c.mean * 100) / 100).toLocaleString('pt-BR')} acertos; p95 ${c.p95}; p99 ${c.p99}; máximo ${c.max}. Chance de o acaso acertar ${c.hits} ou mais: ${p}`;
}

function parseArgs(argv, env) {
  const out = { result: env.BF_EVAL_RESULT || '', gold: env.BF_EVAL_GOLD || '', run: env.BF_EVAL_RUN || '', tolerance: 5, overlap: 0.5, top: 0, from: null, to: null, json: false, chance: 0, draws: 20000, skipBreaks: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--result') out.result = next();
    else if (a === '--gold') out.gold = next();
    else if (a === '--run') out.run = next();
    else if (a === '--tolerance') out.tolerance = Number(next());
    else if (a === '--overlap') out.overlap = Number(next());
    else if (a === '--top') out.top = Number(next());
    else if (a === '--from') out.from = Number(next());
    else if (a === '--to') out.to = Number(next());
    else if (a === '--chance') out.chance = Number(next());
    else if (a === '--draws') out.draws = Number(next());
    else if (a === '--json') out.json = true;
    else if (a === '--skip-breaks') out.skipBreaks = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Argumento desconhecido: ${a}`);
  }
  return out;
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2), process.env); } catch (err) { console.error(err.message); process.exit(2); }
  if (args.help || !args.result || !args.gold) {
    console.log('Uso: node scripts/eval-analysis.js --result <resultado.json> --gold <gabarito.json> [--run <nome>] [--tolerance 5] [--overlap 0.5] [--top N] [--from <seg>] [--to <seg>] [--chance <duração do vídeo em seg>] [--draws N] [--skip-breaks] [--json]\n(ou BF_EVAL_RESULT e BF_EVAL_GOLD)');
    process.exit(args.help ? 0 : 2);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(args.result, 'utf8'));
    const sugs = normalizeSuggestions(raw, args.run);
    const holder = args.run && raw && raw.results ? raw.results[args.run] : raw;
    const exclude = args.skipBreaks && holder && Array.isArray(holder.breaks) ? holder.breaks : [];
    const gold = normalizeGold(JSON.parse(fs.readFileSync(args.gold, 'utf8')));
    if (!gold.length) throw new Error('Gabarito vazio ou sem tempos s/e.');
    const report = evaluate(sugs, gold, { tolerance: args.tolerance, overlapFraction: args.overlap, top: args.top, from: args.from, to: args.to });
    const chance = args.chance > 0 ? chanceBaseline(sugs, gold, args.chance, { tolerance: args.tolerance, overlapFraction: args.overlap, draws: args.draws, exclude }) : undefined;
    if (args.json) console.log(JSON.stringify(chance === undefined ? report : { ...report, chance }, null, 2));
    else console.log(chance === undefined ? format(report) : `${format(report)}\n${formatChance(chance)}`);
  } catch (err) {
    console.error(`Erro: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { evaluate, chanceBaseline, matches, normalizeGold, normalizeSuggestions, pairOneToOne, format, formatChance, parseArgs };

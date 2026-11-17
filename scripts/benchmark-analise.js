#!/usr/bin/env node
'use strict';

/**
 * Benchmark da análise de cortes (Etapa 4, docs/avaliacao.md): compara MOTORES (algoritmo, IA, algoritmo + IA, IA em janelas…) em um conjunto de
 * AMOSTRAS (lives de tipos diferentes), com um gabarito por amostra, e responde se as sugestões ajudam o usuário a achar os momentos que importam.
 *
 *   node scripts/benchmark-analise.js --manifest <manifesto.json> [--budget <sugestões por hora>] [--draws 2000] [--json]
 *
 * Manifesto (os caminhos são relativos à pasta do manifesto; NUNCA ficam no repositório: vídeo, legenda e gabarito são conteúdo do dono):
 *   { "nome": "…", "tolerancia": 5, "sobreposicao": 0.5, "contexto": 0,
 *     "amostras": [ { "id": "live-1", "categoria": "gameplay-chat-ativo", "duracao": 11089, "tipoGabarito": "humano" | "proxy",
 *                     "gabarito": "gold/live-1.json",                       // [{ s, e, r?, t? }] (como scripts/eval-analysis.js)
 *                     "motores": { "algoritmo": "motor/live-1.json", "ia": "ia/live-1.json" } } ] }   // [{ start, end, relevance? }] ou { suggestions, tookMs? }
 *
 * Por motor e por categoria (soma das amostras, "micro"): sugestões e por hora, precisão, revocação e F1 (pareamento 1:1), repetidas, minutos de vídeo a
 * revisar, tempo de análise, revocação x acaso e o GANHO DE TEMPO: para o mesmo tempo de vídeo assistido, quantas vezes mais itens do gabarito a lista mostra do que
 * olhar trechos sem critério (olhar uma fração f do vídeo mostra, em média, f dos itens). Também sai, no JSON, o tempo para achar metade do gabarito. `--budget` corta cada lista nas N sugestões por hora mais relevantes: assim os motores são comparados
 * com o MESMO número de sugestões, porque achar mais candidatos NÃO é ser melhor.
 */

const fs = require('node:fs');
const path = require('node:path');
const { normalizeGold, normalizeSuggestions, chanceBaseline } = require('./eval-analysis');
const { prf, f1Of, duplicity, reviewSeconds, reviewCurve, atBudget, matches } = require('../src/core/analysis/metrics');

const sum = (xs) => xs.reduce((n, x) => n + x, 0);
const ratio = (a, b) => (b > 0 ? a / b : null);

/** Lê um JSON; arquivo faltando ou ilegível vira erro com o caminho. */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(new RegExp('^' + String.fromCharCode(0xFEFF)), '')); } catch (err) { throw new Error(`Não foi possível ler ${file}: ${err.message}`); }
}

/** Avalia UM motor em UMA amostra. */
function evaluateSample(sample, engine, raw, o) {
  const gold = normalizeGold(sample.goldRaw);
  const all = normalizeSuggestions(raw);
  const hours = sample.duration / 3600;
  const sugs = o.budget > 0 ? atBudget(all, Math.round(o.budget * hours)) : all;
  const opts = { tolerance: o.tolerance, overlapFraction: o.overlap };
  const base = prf(sugs, gold, opts);
  const hit = gold.filter((g) => sugs.some((s) => matches(s, g, opts))).length;
  const chance = o.draws > 0 && sugs.length && gold.length ? chanceBaseline(sugs, gold, sample.duration, { ...opts, draws: o.draws }) : null;
  const curve = reviewCurve(sugs, gold, sample.duration, { ...opts, padSec: o.context });
  const tookMs = raw && !Array.isArray(raw) && Number.isFinite(raw.tookMs) ? raw.tookMs : null;
  return {
    id: sample.id, category: sample.category, engine, hours,
    suggestions: sugs.length, gold: gold.length, tp: base.tp, fp: base.fp, fn: base.fn, hitAny: hit,
    duration: sample.duration, chanceHits: chance ? chance.mean : null, repeated: duplicity(sugs).repeated, reviewSec: reviewSeconds(sugs, { padSec: o.context }),
    tookMs, saved50: curve.saved[0.5], manual50: 0.5 * sample.duration
  };
}

/** Soma amostras de um mesmo motor (micro): as razões saem das somas, não da média das razões. */
function aggregate(rows) {
  const tp = sum(rows.map((r) => r.tp));
  const sugs = sum(rows.map((r) => r.suggestions));
  const gold = sum(rows.map((r) => r.gold));
  const precision = ratio(tp, sugs);
  const recall = ratio(tp, gold);
  const hours = sum(rows.map((r) => r.hours));
  const withChance = rows.filter((r) => r.chanceHits !== null);
  const reached = rows.filter((r) => r.saved50);
  const times = rows.map((r) => r.tookMs).filter((x) => x !== null);
  return {
    samples: rows.length, hours, gold, suggestions: sugs, perHour: ratio(sugs, hours), tp, precision, recall, f1: f1Of(precision, recall),
    repeatedRate: ratio(sum(rows.map((r) => r.repeated)), sugs), reviewMinutes: sum(rows.map((r) => r.reviewSec)) / 60,
    recallAny: ratio(sum(rows.map((r) => r.hitAny)), gold),
    recallChance: withChance.length ? ratio(sum(withChance.map((r) => r.chanceHits)), sum(withChance.map((r) => r.gold))) : null,
    analysisMinutes: times.length ? sum(times) / 60000 : null,
    // para chegar a 50% do gabarito: minutos assistindo a lista x minutos percorrendo o vídeo; só conta as amostras em que a lista chega lá
    // ganho de tempo: itens achados por fração do vídeo assistida, contra olhar sem critério (a fração assistida é o que se acharia em média)
    scanLift: ratio(ratio(sum(rows.map((r) => r.hitAny)), gold), ratio(sum(rows.map((r) => r.reviewSec)), sum(rows.map((r) => r.duration)))),
    reviewedShare: ratio(sum(rows.map((r) => r.reviewSec)), sum(rows.map((r) => r.duration))),
    saved50: reached.length ? { samples: reached.length, of: rows.length, listMinutes: sum(reached.map((r) => r.saved50.seconds)) / 60, manualMinutes: sum(reached.map((r) => r.manual50)) / 60 } : null
  };
}

function runBenchmark(manifest, baseDir, options = {}, loader = readJson) {
  const o = {
    tolerance: manifest.tolerancia ?? 5, overlap: manifest.sobreposicao ?? 0.5, context: manifest.contexto ?? 0,
    budget: Number(options.budget) || 0, draws: options.draws ?? 2000
  };
  const samples = (manifest.amostras || []).map((a) => ({
    id: a.id, category: a.categoria || 'sem-categoria', duration: Number(a.duracao), goldType: a.tipoGabarito || 'humano', goldRaw: loader(path.resolve(baseDir, a.gabarito)), engines: a.motores || {}
  }));
  for (const s of samples) if (!(s.duration > 0)) throw new Error(`Amostra "${s.id}": informe a duração em segundos (duracao).`);
  const rows = [];
  for (const s of samples) {
    for (const [engine, file] of Object.entries(s.engines)) rows.push(evaluateSample(s, engine, loader(path.resolve(baseDir, file)), o));
  }
  const engines = [...new Set(rows.map((r) => r.engine))];
  const categories = [...new Set(rows.map((r) => r.category))];
  const out = { nome: manifest.nome || '', options: o, goldTypes: [...new Set(samples.map((s) => s.goldType))], samples: samples.length, perEngine: {}, perCategory: {} };
  for (const e of engines) out.perEngine[e] = aggregate(rows.filter((r) => r.engine === e));
  for (const c of categories) out.perCategory[c] = Object.fromEntries(engines.map((e) => [e, aggregate(rows.filter((r) => r.category === c && r.engine === e))]).filter(([, a]) => a.samples));
  out.rows = rows;
  return out;
}

const pct = (x) => (x === null || x === undefined ? 'n/d' : `${(x * 100).toFixed(1).replace('.', ',')}%`);
const num1 = (x) => (x === null || x === undefined ? 'n/d' : x.toFixed(1).replace('.', ','));

function line(name, a) {
  const saved = a.scanLift ? `${num1(a.scanLift)}× (assiste ${pct(a.reviewedShare)} do vídeo)` : 'n/d';
  const lift = a.recallChance ? `${num1(a.recallAny / a.recallChance)}×` : 'n/d';
  return `  ${name.padEnd(22)} ${String(a.suggestions).padStart(5)} sug. (${num1(a.perHour)}/h)  P ${pct(a.precision).padStart(6)}  R ${pct(a.recall).padStart(6)}  F1 ${pct(a.f1).padStart(6)}  repetidas ${pct(a.repeatedRate).padStart(6)}  revisar ${num1(a.reviewMinutes).padStart(6)} min  R/acaso ${lift.padStart(5)}  ganho de tempo: ${saved}${a.analysisMinutes !== null ? `  análise ${num1(a.analysisMinutes)} min` : ''}`;
}

function format(out) {
  const lines = [`${out.nome || 'Benchmark'}: ${out.samples} amostras, gabarito ${out.goldTypes.join(' + ')}${out.options.budget ? `, ${out.options.budget} sugestões por hora no máximo (mesmo orçamento para todos)` : ''}`];
  lines.push('Todos os motores', ...Object.entries(out.perEngine).map(([e, a]) => line(e, a)));
  for (const [c, engines] of Object.entries(out.perCategory)) lines.push(`Categoria ${c}`, ...Object.entries(engines).map(([e, a]) => line(e, a)));
  lines.push('P = precisão e R = revocação, com pareamento 1:1; F1 = média harmônica; R/acaso = revocação (qualquer sugestão que bate) dividida pelo que o acaso acerta com as mesmas durações; "ganho de tempo" = fração do gabarito que a lista mostra dividida pela fração do vídeo que ela pede para assistir (olhar sem critério daria 1,0×).');
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; };
  const manifestPath = opt('manifest');
  if (!manifestPath || !fs.existsSync(manifestPath)) { console.error('Uso: node scripts/benchmark-analise.js --manifest <manifesto.json> [--budget <sugestões por hora>] [--draws 2000] [--json]'); process.exit(2); }
  const out = runBenchmark(readJson(manifestPath), path.dirname(path.resolve(manifestPath)), { budget: opt('budget'), draws: Number(opt('draws', 2000)) });
  console.log(args.includes('--json') ? JSON.stringify(out, null, 2) : format(out));
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(err.message); process.exit(1); }
}

module.exports = { runBenchmark, evaluateSample, aggregate, format, line };

#!/usr/bin/env node
'use strict';

/**
 * Mede o PRÉ-FILTRO de janelas candidatas (src/core/analysis/candidates.js) contra o público, e quanto texto ele poupa da IA.
 * Sem IA e sem rede: só o que o pré-filtro decide (volume do áudio + risadas da transcrição [+ chat, se houver]).
 *
 *   node scripts/medir-janelas.js --base <pasta> [--source local|algorithm|both] [--coverage 0.2] [--sweep 0.1,0.2,0.3] [--draws 1000] [--json]
 *
 *   --source local      só os sinais locais (volume do áudio + risadas da legenda): o pré-filtro "independente"
 *   --source algorithm  só as sugestões do algoritmo (motor/<id>-auto.json) viram janelas
 *   --source both       (padrão do app) as do algoritmo primeiro e os sinais locais no que sobrar do orçamento
 *
 * A pasta (NUNCA fica no repositório: vídeos, legendas e gráficos são conteúdo de terceiros) tem, por canal (`coringa/`, `flakes/`…):
 *   episodios/<id>.info.json    com o `heatmap` do YouTube ("mais reassistidos": 100 faixas { start_time, end_time, value })
 *   transcricao/<id>.json       { cues: [{ start, end, text }] }
 *   motor/<id>-auto.json        resultado do algoritmo (só para comparar e para a duração)
 * e, em `<pasta>/.bf-cache/`, os `sig-audio-*.json` da análise (o vídeo é achado pela duração do áudio; os arquivos de vídeo podem já ter sido apagados).
 * `gabarito.json` (opcional): { gold: [{ episodio, s, e }] }, os shorts que o canal publicou.
 *
 * O que sai, por canal e no total:
 *   cobertura          fração do vídeo dentro das janelas (é o que corta o texto enviado à IA)
 *   tokens             estimativa de tokens (entrada + saída) do método de blocos x o de janelas, com as MESMAS funções do app (buildWindows / packCandidateBlocks)
 *   nos 20% quentes    janelas cujo trecho está entre as faixas mais reassistidas, e o que o ACASO faria (mesmas durações sorteadas, semente fixa)
 *   picos tocados      dos 5 picos de cada live, quantos uma janela toca, e o acaso
 *   posição média      posição (0 a 100) do trecho no gráfico de reassistidos
 * "sorte" = em quantos dos sorteios o acaso empatou ou ganhou (quanto menor, menos provável que seja sorte).
 */

const fs = require('node:fs');
const path = require('node:path');
const { audioEvents, laughEvents, buildCandidateWindows, windowsFromSuggestions, mergeWindows } = require('../src/core/analysis/candidates');
const { normalizeCues } = require('../src/core/analysis/transcript/format');
const { buildWindows, packCandidateBlocks, estimate } = require('../src/core/analysis/ai/chunking');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

function heatOf(heat, start, end) {
  let sum = 0; let w = 0;
  for (const b of heat) { const ov = overlap(start, end, b.start_time, b.end_time); if (ov > 0) { sum += b.value * ov; w += ov; } }
  return w ? sum / w : 0;
}
const percentile = (sorted, v) => { let lo = 0; let hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; } return (100 * lo) / sorted.length; };

/** Cada live: { canal, id, duration, db, cues, heat, shorts }. O áudio é achado pela duração (os vídeos já não existem). */
function loadLives(base) {
  const audios = [];
  const cacheDir = path.join(base, '.bf-cache');
  for (const f of fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((n) => n.startsWith('sig-audio-')) : []) {
    const d = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8')).data;
    if (d && Array.isArray(d.db)) audios.push({ seconds: d.db.length * (d.windowSec || 0.5), db: d.db, frameSec: d.windowSec || 0.5 });
  }
  const gold = fs.existsSync(path.join(base, 'gabarito.json')) ? (JSON.parse(fs.readFileSync(path.join(base, 'gabarito.json'), 'utf8')).gold || []) : [];
  const lives = [];
  for (const canal of fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(base, e.name, 'motor'))).map((e) => e.name)) {
    for (const file of fs.readdirSync(path.join(base, canal, 'motor')).filter((n) => n.endsWith('-auto.json'))) {
      const id = file.replace('-auto.json', '');
      const res = JSON.parse(fs.readFileSync(path.join(base, canal, 'motor', file), 'utf8'));
      const info = JSON.parse(fs.readFileSync(path.join(base, canal, 'episodios', `${id}.info.json`), 'utf8'));
      const tr = path.join(base, canal, 'transcricao', `${id}.json`);
      if (!fs.existsSync(tr) || !Array.isArray(info.heatmap) || info.heatmap.length < 10) continue;
      const duration = res.source.duration;
      const audio = audios.filter((a) => Math.abs(a.seconds - duration) < 2.5);
      if (audio.length !== 1) { console.error(`aviso: ${canal}/${id}: ${audio.length} áudio(s) com a duração de ${Math.round(duration)} s; pulada`); continue; }
      const { cues } = normalizeCues(JSON.parse(fs.readFileSync(tr, 'utf8')).cues, { duration });
      lives.push({
        canal, id, duration, db: audio[0].db, frameSec: audio[0].frameSec, cues, heat: info.heatmap.slice(1), // a 1ª faixa é o começo do vídeo, sempre inflada
        algo: res.suggestions, shorts: gold.filter((g) => g.episodio === id).map((g) => ({ start: g.s, end: g.e }))
      });
    }
  }
  return lives;
}

function measureLive(live, maxCoverage, source) {
  const events = [...audioEvents(live.db, { frameSec: live.frameSec }), ...laughEvents(live.cues)];
  const local = buildCandidateWindows({ events, duration: live.duration }, { maxCoverage });
  const fromAlgorithm = windowsFromSuggestions(live.algo, live.duration, { maxCoverage });
  const windows = source === 'local' ? local : (source === 'algorithm' ? fromAlgorithm : mergeWindows(fromAlgorithm, local, live.duration, { maxCoverage }));
  const covered = windows.reduce((n, w) => n + (w.to - w.from), 0);
  const classic = estimate(buildWindows(live.cues, live.duration, { windowSec: 35 * 60, maxInputTokens: 24000 }), { candidatesPerBlock: 8 });
  const packed = windows.length ? packCandidateBlocks(windows, live.cues, live.duration, { maxInputTokens: 24000 }) : [];
  const viaWindows = estimate(packed, { candidatesPerBlock: Math.max(1, ...packed.map((b) => b.packed.length)) });
  return { windows, covered, classic, viaWindows, events: events.length };
}

function scoreList(list, live, sorted, p80, peaks) {
  return {
    n: list.length,
    pct: list.reduce((n, s) => n + percentile(sorted, heatOf(live.heat, s.from ?? s.start, s.to ?? s.end)), 0),
    top20: list.filter((s) => heatOf(live.heat, s.from ?? s.start, s.to ?? s.end) >= p80).length,
    peaks: peaks.filter((b) => list.some((s) => overlap(s.from ?? s.start, s.to ?? s.end, b.start_time, b.end_time) > 0)).length,
    shorts: live.shorts.filter((g) => list.some((s) => overlap(s.from ?? s.start, s.to ?? s.end, g.start, g.end) >= 0.5 * Math.min((s.to ?? s.end) - (s.from ?? s.start), g.end - g.start))).length
  };
}

function evaluate(lives, maxCoverage, draws, source) {
  seed = 12345;
  const rows = [];
  for (const live of lives) {
    const m = measureLive(live, maxCoverage, source);
    const sorted = live.heat.map((b) => b.value).sort((a, b) => a - b);
    const p80 = sorted[Math.floor(sorted.length * 0.8)];
    const peaks = live.heat.slice().sort((a, b) => b.value - a.value).slice(0, 5);
    const real = scoreList(m.windows, live, sorted, p80, peaks);
    const runs = [];
    for (let k = 0; k < draws; k += 1) {
      runs.push(scoreList(m.windows.map((w) => { const d = w.to - w.from; const st = rnd() * Math.max(1, live.duration - d); return { from: st, to: st + d }; }), live, sorted, p80, peaks));
    }
    const algoReal = scoreList(live.algo, live, sorted, p80, peaks);
    rows.push({ live, m, real, runs, algo: algoReal, nPeaks: peaks.length });
  }
  return rows;
}

function summarize(rows, draws) {
  const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
  const agg = (f) => Array.from({ length: draws }, (_, k) => rows.reduce((n, r) => n + f(r.runs[k]), 0));
  const luck = (chance, real, higherIsBetter = true) => chance.filter((v) => (higherIsBetter ? v >= real : v <= real)).length / chance.length;
  const nWin = sum((r) => r.real.n);
  const pctReal = sum((r) => r.real.pct) / nWin;
  const pctChance = agg((r) => r.pct).map((v) => v / nWin);
  const topReal = sum((r) => r.real.top20);
  const topChance = agg((r) => r.top20);
  const peakReal = sum((r) => r.real.peaks);
  const peakChance = agg((r) => r.peaks);
  const dur = sum((r) => r.live.duration);
  return {
    lives: rows.length, hours: Math.round((dur / 3600) * 10) / 10, windows: nWin, windowsPerHour: Math.round((nWin / (dur / 3600)) * 10) / 10,
    coverage: Math.round((sum((r) => r.m.covered) / dur) * 1000) / 10,
    tokensClassic: sum((r) => r.m.classic.totalTokens), tokensWindows: sum((r) => r.m.viaWindows.totalTokens),
    callsClassic: sum((r) => r.m.classic.calls), callsWindows: sum((r) => r.m.viaWindows.calls),
    posReal: Math.round(pctReal * 10) / 10, posChance: Math.round(mean(pctChance) * 10) / 10, posLuck: luck(pctChance, pctReal),
    top20Real: Math.round((topReal / nWin) * 1000) / 10, top20Chance: Math.round((mean(topChance) / nWin) * 1000) / 10, top20Luck: luck(topChance, topReal),
    peaksReal: peakReal, peaksTotal: sum((r) => r.nPeaks), peaksChance: Math.round(mean(peakChance) * 10) / 10, peaksLuck: luck(peakChance, peakReal),
    shortsReal: sum((r) => r.real.shorts), shortsTotal: sum((r) => r.live.shorts.length),
    algoPeaks: sum((r) => r.algo.peaks), algoSuggestions: sum((r) => r.algo.n), algoTop20: Math.round((sum((r) => r.algo.top20) / sum((r) => r.algo.n)) * 1000) / 10
  };
}

const pctText = (v) => (v < 0.001 ? 'menos de 0,1%' : `${(v * 100).toFixed(1).replace('.', ',')}%`);

function main() {
  const base = opt('base');
  if (!base || !fs.existsSync(base)) { console.error('Uso: node scripts/medir-janelas.js --base <pasta> [--source local|algorithm|both] [--coverage 0.2] [--sweep 0.1,0.2,0.3] [--draws 1000] [--json]'); process.exit(2); }
  const draws = Number(opt('draws', 1000));
  const lives = loadLives(base);
  if (!lives.length) { console.error('Nenhuma live com áudio em cache, legenda e gráfico em ' + base); process.exit(2); }
  const source = opt('source', 'both');
  const coverages = opt('sweep') ? String(opt('sweep')).split(',').map(Number) : [Number(opt('coverage', 0.2))];
  const out = [];
  for (const cov of coverages) {
    const rows = evaluate(lives, cov, draws, source);
    const channels = [...new Set(lives.map((l) => l.canal))];
    out.push({ maxCoverage: cov, total: summarize(rows, draws), byChannel: Object.fromEntries(channels.map((c) => [c, summarize(rows.filter((r) => r.live.canal === c), draws)])) });
  }
  if (flag('json')) { console.log(JSON.stringify(out, null, 2)); return; }
  for (const o of out) {
    const t = o.total;
    console.log(`\n=== fonte: ${source} | cobertura máxima ${Math.round(o.maxCoverage * 100)}% | ${t.lives} lives, ${t.hours} h ===`);
    console.log(`janelas: ${t.windows} (${t.windowsPerHour} por hora); cobertura real do vídeo: ${t.coverage}%`);
    console.log(`tokens estimados (entrada + saída): blocos ${t.tokensClassic} -> janelas ${t.tokensWindows} (${Math.round((1 - t.tokensWindows / t.tokensClassic) * 100)}% menos); chamadas ${t.callsClassic} -> ${t.callsWindows}`);
    console.log(`nos 20% mais reassistidos: ${t.top20Real}% das janelas (acaso ${t.top20Chance}%, sorte ${pctText(t.top20Luck)})`);
    console.log(`posição média no gráfico: ${t.posReal} (acaso ${t.posChance}, sorte ${pctText(t.posLuck)})`);
    console.log(`picos tocados (5 por live): ${t.peaksReal} de ${t.peaksTotal} (acaso ${t.peaksChance}, sorte ${pctText(t.peaksLuck)}); o algoritmo, com ${t.algoSuggestions} sugestões: ${t.algoPeaks}`);
    if (t.shortsTotal) console.log(`shorts publicados dentro de uma janela: ${t.shortsReal} de ${t.shortsTotal}`);
    for (const [c, s] of Object.entries(o.byChannel)) console.log(`  ${c}: ${s.lives} lives, ${s.windows} janelas, cobertura ${s.coverage}%, tokens -${Math.round((1 - s.tokensWindows / s.tokensClassic) * 100)}%, 20% quentes ${s.top20Real}% (acaso ${s.top20Chance}%), picos ${s.peaksReal}/${s.peaksTotal} (acaso ${s.peaksChance})`);
  }
}

main();

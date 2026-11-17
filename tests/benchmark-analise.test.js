'use strict';

/** scripts/benchmark-analise.js: comparação de motores por categoria com amostras e gabaritos inventados (memória, sem disco). */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runBenchmark, format, aggregate } = require('../scripts/benchmark-analise');

const files = {
  'g1.json': [{ s: 100, e: 130 }, { s: 1000, e: 1030 }, { s: 2000, e: 2030 }, { s: 3000, e: 3030 }],
  'g2.json': [{ s: 500, e: 530 }, { s: 1500, e: 1530 }],
  // motor "preciso": poucas sugestões, quase todas certas; "tudo": muitas, achando mais, mas com muito lixo
  'a1.json': { tookMs: 120000, suggestions: [{ start: 100, end: 130, relevance: 0.9 }, { start: 1000, end: 1030, relevance: 0.8 }, { start: 2500, end: 2530, relevance: 0.2 }] },
  'a2.json': [{ start: 500, end: 530, relevance: 0.9 }, { start: 1500, end: 1530, relevance: 0.7 }],
  't1.json': { tookMs: 600000, suggestions: Array.from({ length: 40 }, (_, i) => ({ start: 100 + i * 90, end: 130 + i * 90, relevance: 1 - i * 0.02 })) },
  't2.json': Array.from({ length: 30 }, (_, i) => ({ start: 20 + i * 60, end: 50 + i * 60, relevance: 0.5 }))
};
const loader = (file) => { const key = path.basename(file); if (!(key in files)) throw new Error(`faltou ${key}`); return files[key]; };
const manifest = {
  nome: 'Teste', tolerancia: 5, sobreposicao: 0.5,
  amostras: [
    { id: 'live-1', categoria: 'gameplay', duracao: 3600, tipoGabarito: 'humano', gabarito: 'g1.json', motores: { preciso: 'a1.json', tudo: 't1.json' } },
    { id: 'live-2', categoria: 'podcast', duracao: 1800, tipoGabarito: 'humano', gabarito: 'g2.json', motores: { preciso: 'a2.json', tudo: 't2.json' } }
  ]
};

test('soma as amostras de cada motor: precisão, revocação e F1 saem das somas (micro), não da média das razões', () => {
  const out = runBenchmark(manifest, '/x', { draws: 0 }, loader);
  const p = out.perEngine.preciso;
  assert.deepEqual([p.samples, p.suggestions, p.gold, p.tp], [2, 5, 6, 4]);
  assert.equal(p.precision, 4 / 5);
  assert.equal(p.recall, 4 / 6);
  assert.equal(Math.round(p.f1 * 1e6) / 1e6, Math.round(((2 * (4 / 5) * (4 / 6)) / (4 / 5 + 4 / 6)) * 1e6) / 1e6);
  assert.equal(p.analysisMinutes, 2, 'tempo de análise vem do tookMs do resultado (só do que informou)');
  const t = out.perEngine.tudo;
  assert.ok(t.suggestions > p.suggestions && t.precision < p.precision, 'achar mais candidatos NÃO é ser melhor: a precisão cai');
});

test('categorias separadas, com o mesmo conjunto de motores em cada uma', () => {
  const out = runBenchmark(manifest, '/x', { draws: 0 }, loader);
  assert.deepEqual(Object.keys(out.perCategory), ['gameplay', 'podcast']);
  assert.deepEqual(Object.keys(out.perCategory.gameplay), ['preciso', 'tudo']);
  assert.equal(out.perCategory.podcast.preciso.recall, 1);
  assert.equal(out.perCategory.gameplay.preciso.gold, 4);
});

test('--budget corta cada lista nas N mais relevantes por hora: motores comparados com o MESMO número de sugestões', () => {
  const out = runBenchmark(manifest, '/x', { budget: 10, draws: 0 }, loader);
  // 10 por hora: live-1 (1 h) = 10 sugestões; live-2 (0,5 h) = 5
  const t = out.perEngine.tudo;
  assert.equal(t.suggestions, 15);
  assert.ok(t.suggestions <= 15 && out.perEngine.preciso.suggestions === 5, 'o motor que já tinha menos sugestões não é cortado');
  assert.ok(Math.abs(t.perHour - 10) < 1e-9);
});

test('ganho de tempo: itens achados por fração do vídeo assistida, contra olhar sem critério; e o tempo para achar 50% fica no JSON', () => {
  const out = runBenchmark(manifest, '/x', { draws: 0 }, loader);
  const s = out.perEngine.preciso.saved50;
  // live-1: 50% (2 de 4) com 2 sugestões de 30 s = 60 s; à mão 1800 s. live-2: 50% (1 de 2) com 1 sugestão = 30 s; à mão 900 s
  assert.deepEqual([s.samples, s.of], [2, 2]);
  assert.equal(s.listMinutes, 1.5);
  assert.equal(s.manualMinutes, 45);
  // o motor preciso mostra 4 de 6 itens assistindo 5 trechos de 30 s = 150 s de 5400 s (2,8% do vídeo): 66,7% / 2,8% = 24×
  assert.ok(Math.abs(out.perEngine.preciso.reviewedShare - 150 / 5400) < 1e-12);
  assert.ok(Math.abs(out.perEngine.preciso.scanLift - (4 / 6) / (150 / 5400)) < 1e-9);
  assert.match(format(out), /ganho de tempo: 24,0× \(assiste 2,8% do vídeo\)/);
});

test('o acaso entra como referência (R/acaso) e a repetição é contada', () => {
  const out = runBenchmark(manifest, '/x', { draws: 300 }, loader);
  const p = out.perEngine.preciso;
  assert.ok(p.recallChance > 0 && p.recallChance < p.recallAny, 'o motor preciso acerta mais que o acaso');
  const text = format(out);
  assert.match(text, /Categoria gameplay/);
  assert.match(text, /R\/acaso/);
  assert.equal(aggregate([]).samples, 0);
});

test('erros claros: duração faltando e arquivo que não existe', () => {
  const bad = { amostras: [{ id: 'x', categoria: 'c', gabarito: 'g1.json', motores: {} }] };
  assert.throws(() => runBenchmark(bad, '/x', {}, loader), /Amostra "x": informe a duração/);
  assert.throws(() => runBenchmark({ amostras: [{ id: 'y', duracao: 100, gabarito: 'nao.json', motores: {} }] }, '/x', {}, loader), /faltou nao\.json/);
});

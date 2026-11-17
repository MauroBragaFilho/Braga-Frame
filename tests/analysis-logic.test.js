'use strict';

/**
 * Lógica pura da aba Análise (renderer/features/analysis/logic.js), direto no Node, sem DOM: o mesmo arquivo que o app carrega.
 * Também confere que as partes da aba estão no index.html, na ordem certa (antes de analysis.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../renderer/features/analysis/logic');
const { analysisScripts } = require('./analysis-scripts');

test('index.html carrega logic e as partes antes de analysis.js, cada uma uma vez', () => {
  const list = analysisScripts();
  assert.equal(list[list.length - 1], 'features/analysis.js');
  assert.equal(list[0], 'features/analysis/logic.js');
  assert.deepEqual([...list].sort(), [...new Set(list)].sort());
  for (const part of ['humor', 'engine', 'results', 'controls', 'provider']) assert.ok(list.includes(`features/analysis/${part}.js`), part);
});

test('clock, eta e plural formatam como a tela mostra', () => {
  assert.equal(L.clock(83), '1:23');
  assert.equal(L.clock(3725), '1:02:05');
  assert.equal(L.eta(5), 'quase pronto');
  assert.equal(L.eta(60), 'cerca de 60 s restantes');
  assert.equal(L.eta(600), 'cerca de 10 min restantes');
  assert.equal(L.plural(1, 'chamada', 'chamadas'), '1 chamada');
  assert.equal(L.plural(7, 'chamada', 'chamadas'), '7 chamadas');
});

test('isCovered: pico dentro, 20% da sugestão ou 50% do menor cobrem; sem sobreposição não', () => {
  const s = { start: 100, end: 130, peak: 110 };
  assert.equal(L.isCovered(s, [{ start: 105, end: 115 }]), true);
  assert.equal(L.isCovered(s, [{ start: 125, end: 200 }]), false);
  assert.equal(L.isCovered(s, [{ start: 126, end: 200 }, { start: 0, end: 50 }]), false);
  assert.equal(L.isCovered(s, [{ start: 124, end: 200 }]), true);
});

test('pendentes e descartadas saem da mais relevante para a menos', () => {
  const list = [{ start: 0, end: 20, relevance: 0.5 }, { start: 100, end: 120, relevance: 0.9 }, { start: 300, end: 320, relevance: 0.7 }];
  const dismissed = [{ start: 300, end: 320 }];
  assert.deepEqual(L.pendingSuggestions(list, [], dismissed).map((s) => s.relevance), [0.9, 0.5]);
  assert.deepEqual(L.dismissedSuggestions(list, [], dismissed).map((s) => s.relevance), [0.7]);
});

test('"Só os melhores" vira quantidade fixa e sem automática; sem ele, nada muda', () => {
  assert.deepEqual(L.applyBestOnly({ bestOnly: true, autoQuantity: true, perHour: 20 }), { bestOnly: true, autoQuantity: false, perHour: L.BEST_ONLY_PER_HOUR });
  const same = { bestOnly: false, autoQuantity: true, perHour: 20 };
  assert.equal(L.applyBestOnly(same), same);
});

test('o resumo do resultado: algoritmo, IA e Algoritmo + IA', () => {
  const counts = { inCuts: 2, dismissed: 1 };
  const algo = L.summaryText({ engine: 'algorithm', suggestions: [1, 2, 3], tookMs: 4000, signals: { audio: { used: true }, chat: { used: false, reason: 'sem chat' } } }, counts);
  assert.match(algo, /3 sugestão\(ões\) encontrada\(s\) · 2 já nos cortes · 1 descartada\(s\) · sinais usados: áudio/);
  assert.match(algo, /ignorados: chat \(sem chat\)/);
  const ai = L.summaryText({ engine: 'ai', suggestions: [1], tookMs: 1000, ai: { provider: 'Groq', model: 'm', calls: 3, promptTokens: 9000, completionTokens: 1000, funnel: { returned: 10, verified: 8, offered: 8, picked: 5 } } }, { inCuts: 0, dismissed: 0 });
  assert.match(ai, /IA: Groq · m · 3 chamadas, ~10 mil tokens · a IA propôs 10 candidatos, 8 passaram na conferência, a escolha final ficou com 5 de 8/);
  const both = L.summaryText({ engine: 'both', suggestions: [1, 2], tookMs: 2000, merge: { both: 1, ai: 1, algorithm: 0 }, signals: {}, review: { sent: 4, dropped: 3, adjusted: 1, unanswered: 0 }, ai: { calls: 2 } }, { inCuts: 0, dismissed: 0 });
  assert.match(both, /1 que os dois acharam, 1 só da IA, 0 só do algoritmo/);
  assert.match(both, /a IA conferiu 4 sugestões do algoritmo, tirou 3 e ajustou o início ou o fim de 1/);
});

test('compactAi e compactReview guardam só contagens e limitam o tamanho', () => {
  const ai = L.compactAi({ provider: 'p', model: 'm', calls: 2, droppedTotal: 3, droppedByReason: { phrase: 3 }, dropped: Array.from({ length: 60 }, (_, i) => ({ reason: 'x', start: i, end: i + 1 })), funnel: { returned: 5, perBlock: [{ from: 0, to: 10, returned: 5, verified: 4 }] } });
  assert.equal(ai.dropped.length, 25);
  assert.equal(ai.funnel.perBlock[0].verified, 4);
  const rv = L.compactReview({ sent: 3, kept: 1, dropped: 2, droppedList: [{ start: 1, end: 2, relevance: 0.5, why: 'x'.repeat(300), extra: 'não vai' }] });
  assert.equal(rv.list[0].why.length, 160);
  assert.equal('extra' in rv.list[0], false);
});

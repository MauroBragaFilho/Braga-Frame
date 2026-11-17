'use strict';

/** Métricas de qualidade (src/core/analysis/metrics.js): precisão/revocação/F1 1:1, duplicidade, tempo de revisão e fator de tempo economizado. */

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/analysis/metrics');

const S = (start, end, relevance) => ({ start, end, relevance });
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test('matches: início até 5 s de diferença ou sobreposição de metade da menor duração', () => {
  assert.equal(M.matches(S(100, 130), S(104, 140)), true, 'início a 4 s');
  assert.equal(M.matches(S(100, 130), S(110, 150)), true, 'sobreposição 20/30 da menor');
  assert.equal(M.matches(S(100, 130), S(125, 200)), false, 'sobreposição de 5 s e início longe');
  assert.equal(M.matches(S(100, 130), S(300, 330)), false);
  assert.equal(M.matches(S(100, 130), S(110, 160), { overlapFraction: 0.9 }), false, 'regra configurável');
});

test('prf: pareamento 1:1; duas sugestões no mesmo item contam uma acerto e um falso positivo', () => {
  const gold = [S(100, 130), S(500, 530), S(900, 930)];
  const sugs = [S(98, 128, 0.9), S(104, 134, 0.8), S(502, 532, 0.7), S(2000, 2030, 0.5)];
  const r = M.prf(sugs, gold);
  assert.deepEqual([r.tp, r.fp, r.fn], [2, 2, 1]);
  near(r.precision, 0.5);
  near(r.recall, 2 / 3);
  near(r.f1, (2 * 0.5 * (2 / 3)) / (0.5 + 2 / 3));
});

test('prf: sem sugestões ou sem gabarito não divide por zero; F1 de 0 e 0 é 0', () => {
  const a = M.prf([], [S(1, 30)]);
  assert.deepEqual([a.precision, a.recall, a.f1, a.fn], [null, 0, null, 1]);
  const b = M.prf([S(1, 30)], []);
  assert.deepEqual([b.precision, b.recall, b.f1], [0, null, null]);
  const c = M.prf([S(500, 530)], [S(1, 30)]);
  assert.deepEqual([c.precision, c.recall, c.f1], [0, 0, 0]);
  assert.equal(M.f1Of(1, 1), 1);
  assert.equal(M.f1Of(null, 1), null);
  assert.deepEqual(M.prf(null, undefined).suggestions, 0, 'entrada ruim vira lista vazia');
});

test('duplicity: a menos relevante que repete um momento da mais relevante é a repetida', () => {
  const sugs = [S(100, 130, 0.9), S(104, 135, 0.6), S(500, 530, 0.8), S(515, 545, 0.7), S(1000, 1030, 0.5)];
  const d = M.duplicity(sugs);
  assert.equal(d.repeated, 2);
  near(d.rate, 0.4);
  assert.deepEqual(M.duplicity([S(1, 30, 1), S(100, 130, 1)]), { repeated: 0, rate: 0 });
  assert.equal(M.duplicity([]).rate, null);
});

test('reviewSeconds: a união dos trechos (sobreposição conta uma vez) e o contexto de cada lado', () => {
  assert.equal(M.reviewSeconds([S(0, 30), S(20, 50), S(100, 130)]), 80);
  assert.equal(M.reviewSeconds([S(100, 130)], { padSec: 15 }), 60);
  assert.equal(M.reviewSeconds([]), 0);
});

test('atBudget: as n mais relevantes; empate fica na ordem de chegada', () => {
  const sugs = [S(1, 30, 0.5), S(100, 130, 0.9), S(200, 230, 0.9), S(300, 330, 0.7)];
  assert.deepEqual(M.atBudget(sugs, 2).map((s) => s.start), [100, 200]);
  assert.equal(M.atBudget(sugs, 0).length, 4);
});

test('reviewCurve: o fator de tempo economizado compara com percorrer o vídeo à mão', () => {
  // vídeo de 3600 s com 4 momentos; a lista tem os 4 acertos no começo da ordem de relevância e mais lixo
  const gold = [S(100, 130), S(1000, 1030), S(2000, 2030), S(3000, 3030)];
  const sugs = [S(100, 130, 0.9), S(1000, 1030, 0.85), S(1500, 1530, 0.8), S(2000, 2030, 0.7), S(3000, 3030, 0.6), S(3300, 3330, 0.5)];
  const c = M.reviewCurve(sugs, gold, 3600);
  assert.equal(c.points.length, 6);
  assert.deepEqual(c.points.map((p) => p.found), [1, 2, 2, 3, 4, 4]);
  // 50% de revocação (2 de 4) com 2 sugestões = 60 s assistidos; à mão seriam 0,5 × 3600 = 1800 s: 30 vezes menos
  assert.equal(c.saved[0.5].seconds, 60);
  assert.equal(c.saved[0.5].suggestions, 2);
  assert.equal(c.saved[0.5].factor, 30);
  // 75% (3 de 4) só na quarta sugestão: 4 trechos de 30 s = 120 s; à mão 2700 s
  assert.equal(c.saved[0.75].seconds, 120);
  near(c.saved[0.75].factor, 22.5);
  assert.equal(c.finalRecall, 1);
  assert.equal(c.totalSeconds, 180);
});

test('reviewCurve: lista que nunca chega ao nível dá null; sem sugestões a revocação final é 0', () => {
  const gold = [S(100, 130), S(1000, 1030)];
  const c = M.reviewCurve([S(100, 130, 1)], gold, 3600);
  assert.equal(c.saved[0.5].factor, 3600 * 0.5 / 30);
  assert.equal(c.saved[0.75], null);
  const empty = M.reviewCurve([], gold, 3600);
  assert.deepEqual([empty.finalRecall, empty.saved[0.5], empty.points.length], [0, null, 0]);
});

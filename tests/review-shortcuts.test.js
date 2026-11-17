'use strict';

/** Atalhos da revisão (src/core/review/shortcuts.js): letras configuráveis sem conflito, ação da tecla, próximo pendente e vizinho. */

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/core/review/shortcuts');

test('padrões: A aprova, R rejeita, V toca o trecho, J e K andam pela lista', () => {
  assert.deepEqual(S.resolveKeys({}), { approve: 'a', reject: 'r', view: 'v', next: 'j', prev: 'k' });
  assert.deepEqual(S.resolveKeys(undefined), S.DEFAULTS);
});

test('normalizeKey: uma letra de a a z; I e O (marcar início e fim) são reservadas; o resto vira null', () => {
  assert.equal(S.normalizeKey('Q'), 'q');
  assert.equal(S.normalizeKey(' d '), 'd');
  for (const bad of ['i', 'O', '', 'ab', '1', ' ', null, undefined, 5]) assert.equal(S.normalizeKey(bad), null, String(bad));
});

test('resolveKeys: letra inválida volta ao padrão da ação; as escolhidas valem', () => {
  assert.deepEqual(S.resolveKeys({ approve: 'x', reject: 'ç', next: 'n', prev: 'p' }), { approve: 'x', reject: 'r', view: 'v', next: 'n', prev: 'p' });
  assert.equal(S.resolveKeys({ approve: 'i' }).approve, 'a', 'reservada');
});

test('resolveKeys: duas ações na mesma tecla — a primeira fica, a outra volta ao padrão; padrão ocupado deixa sem atalho', () => {
  const r = S.resolveKeys({ approve: 'r', reject: 'r' });
  assert.deepEqual([r.approve, r.reject], ['r', null], 'rejeitar queria R, que aprovar já pegou, e o padrão dele (R) também: fica sem atalho');
  const q = S.resolveKeys({ approve: 'x', reject: 'x' });
  assert.deepEqual([q.approve, q.reject], ['x', 'r'], 'a segunda volta ao padrão dela');
  assert.equal(new Set(Object.values(S.resolveKeys({ approve: 'j', reject: 'j', view: 'j', next: 'j', prev: 'j' })).filter(Boolean)).size, Object.values(S.resolveKeys({ approve: 'j', reject: 'j', view: 'j', next: 'j', prev: 'j' })).filter(Boolean).length, 'nunca a mesma tecla em duas ações');
});

test('actionFor: letras (sem diferenciar caixa) e setas fixas; tecla sem ação dá null', () => {
  const keys = S.resolveKeys({});
  assert.equal(S.actionFor('a', keys), 'approve');
  assert.equal(S.actionFor('R', keys), 'reject');
  assert.equal(S.actionFor('v', keys), 'view');
  assert.equal(S.actionFor('J', keys), 'next');
  assert.equal(S.actionFor('ArrowDown', keys), 'next');
  assert.equal(S.actionFor('ArrowUp', keys), 'prev');
  assert.equal(S.actionFor('z', keys), null);
  assert.equal(S.actionFor('Enter', keys), null);
  assert.equal(S.actionFor('r', { ...keys, reject: null }), null, 'ação sem atalho não dispara');
});

test('nextUndecided: o próximo pendente depois do decidido; sem nenhum depois, o primeiro antes; tudo decidido dá null', () => {
  const status = { a: 'pending', b: 'approved', c: 'pending', d: 'rejected', e: 'pending' };
  const of = (id) => status[id];
  const order = ['a', 'b', 'c', 'd', 'e'];
  assert.equal(S.nextUndecided(order, 'a', of), 'c');
  assert.equal(S.nextUndecided(order, 'c', of), 'e');
  assert.equal(S.nextUndecided(order, 'e', of), 'a', 'dá a volta só quando não há mais nenhum depois');
  assert.equal(S.nextUndecided(['a', 'b'], 'a', (id) => (id === 'a' ? 'approved' : 'approved')), null);
  assert.equal(S.nextUndecided([], 'x', of), null);
  assert.equal(S.nextUndecided(order, 'zzz', of), 'a', 'corte fora da lista (sumiu por um filtro): o primeiro pendente');
});

test('neighbor: anda uma posição sem dar a volta; sem corte aberto vai ao primeiro', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(S.neighbor(ids, 'a', 1), 'b');
  assert.equal(S.neighbor(ids, 'c', 1), 'c', 'no fim fica no último');
  assert.equal(S.neighbor(ids, 'a', -1), 'a', 'no começo fica no primeiro');
  assert.equal(S.neighbor(ids, 'zzz', 1), 'a');
  assert.equal(S.neighbor([], 'a', 1), null);
});

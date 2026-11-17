'use strict';

/** scripts/exportar-gabarito.js: o que o usuário decidiu num projeto vira gabarito humano e taxa de aprovação. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('../scripts/exportar-gabarito');

const cut = (start, end, status, origin, title = '') => ({ start, end, status, origin, title });
const PROJECT = {
  source: { duration: 7200 },
  cuts: [
    cut(100, 130, 'approved', 'auto', 'sugestão boa'), cut(500, 530, 'rejected', 'auto'), cut(900, 930, 'rejected', 'auto'), cut(1500, 1530, 'pending', 'auto'),
    cut(2000, 2040, 'approved', 'manual', 'marquei sozinho'), cut(3000, 3030, 'approved', 'manual'), cut(4000, 4030, 'rejected', 'manual'),
    cut(NaN, 5, 'approved', 'manual'), cut(50, 50, 'approved', 'manual')
  ]
};

test('resume por origem e calcula a taxa de aprovação só entre as decididas', () => {
  const r = extract(PROJECT);
  assert.equal(r.total, 7, 'cortes inválidos (sem tempo ou com duração zero) ficam de fora');
  assert.deepEqual(r.summary.auto, { approved: 1, rejected: 2, pending: 1, approvalRate: 1 / 3 });
  assert.deepEqual(r.summary.manual, { approved: 2, rejected: 1, pending: 0, approvalRate: 2 / 3 });
  assert.equal(r.duration, 7200);
});

test('o gabarito são os aprovados; --origin separa o que o usuário marcou sozinho (serve à revocação) do que veio de sugestão (só à precisão)', () => {
  assert.deepEqual(extract(PROJECT).gold.map((g) => g.s), [100, 2000, 3000]);
  const manual = extract(PROJECT, { origin: 'manual' }).gold;
  assert.deepEqual(manual.map((g) => [g.s, g.e, g.o]), [[2000, 2040, 'manual'], [3000, 3030, 'manual']]);
  assert.deepEqual(extract(PROJECT, { origin: 'auto' }).gold.map((g) => g.t), ['sugestão boa']);
});

test('projeto sem decisões: taxa nula, gabarito vazio', () => {
  const r = extract({ cuts: [cut(1, 30, 'pending', 'auto')] });
  assert.equal(r.summary.auto.approvalRate, null);
  assert.deepEqual(r.gold, []);
});

'use strict';

/**
 * Lógica do renderer da aba Análise (sem abrir o Electron): carrega renderer/features/analysis.js num
 * contexto `vm` com um BF mínimo e testa as funções puras e a criação de cortes. A interface de verdade é
 * testada no e2e (tests/e2e/analysis.e2e.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../src/core/projects/model');

const { runAnalysis } = require('./analysis-scripts');

function load({ cuts = [], prefs = {} } = {}) {
  const emitted = [];
  const handlers = new Map();
  const tabs = [];
  const project = model.normalizeProject({ version: 2, id: 'p1', source: { path: 'C:\\v.mp4', duration: 3600 }, cuts });
  const BF = {
    state: { project, info: { duration: 3600, hasAudio: true }, tools: { ffmpeg: 'f', ffprobe: 'p' } },
    util: { el: (tag, attrs, ...children) => ({ tag, attrs, children }) },
    ui: { registerTab: (def) => tabs.push(def), log() {}, toast() {}, refreshTabs() {}, confirm: async () => true },
    bus: { on: (evt, fn) => handlers.set(evt, fn), emit: (evt, data) => emitted.push([evt, data]) },
    hooks: { add() {} },
    on() {},
    api: async () => ({ ok: true }),
    ready: Promise.resolve(),
    prefs: { get: (key, fallback) => (key in prefs ? prefs[key] : fallback) },
    model,
    player: { playRange() {} },
    project: {
      update(mutator, { reason } = {}) { const r = mutator(project); emitted.push(['project:update', { reason }]); return r; }
    }
  };
  const sandbox = { window: { BF }, requestAnimationFrame: (fn) => fn() };
  vm.createContext(sandbox);
  runAnalysis(sandbox);
  return { A: BF.analysis, BF, project, emitted, tabs, handlers };
}

/** Valores criados dentro do vm têm outros protótipos: compara por JSON. */
const plain = (v) => JSON.parse(JSON.stringify(v));
const S = (start, end, over = {}) => ({ id: `${start}_${end}`, start, end, peak: (start + end) / 2, relevance: 0.8, reasons: ['pico de áudio 5σ'], ...over });

test('a aba registra id "analysis" na ordem 60 (tabela 1.4)', () => {
  const { tabs } = load();
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].id, 'analysis');
  assert.equal(tabs[0].order, 60);
  assert.equal(tabs[0].title, 'Análise');
  assert.equal(typeof tabs[0].render, 'function');
  const code = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features', 'analysis.js'), 'utf8');
  assert.match(code, /id: 'analysis',/);
  assert.match(code, /order: 60,/);
});

test('isCovered: corte de qualquer status com pico dentro ou boa sobreposição cobre a sugestão', () => {
  const { A } = load();
  const cut = (start, end, status = 'pending') => ({ start, end, status });
  const s = S(100, 130, { peak: 115 });
  assert.equal(A.isCovered(s, []), false);
  assert.equal(A.isCovered(s, [cut(0, 50)]), false, 'longe');
  assert.equal(A.isCovered(s, [cut(125, 200)]), false, 'sobreposição de 5 s (17%) com o pico fora: nova sugestão');
  assert.equal(A.isCovered(s, [cut(120, 200)]), true, 'sobreposição de 10 s (33%)');
  assert.equal(A.isCovered(s, [cut(110, 112)]), true, 'pico dentro do corte');
  assert.equal(A.isCovered(S(100, 130, { peak: 128 }), [cut(116, 120)]), true, 'corte curto inteiro dentro (>=50% do menor)');
  for (const status of ['pending', 'approved', 'rejected']) assert.equal(A.isCovered(s, [cut(95, 135, status)]), true, `status ${status}`);
  assert.equal(A.isCovered(s, [{ start: 'x', end: null }]), false, 'dados quebrados não derrubam');
  assert.equal(A.isCovered(s, [cut(130, 160)]), false, 'colado, sem sobrepor');
});

test('pendingSuggestions: só as não cobertas, da mais relevante para a menos', () => {
  const { A } = load();
  const list = [S(10, 40, { relevance: 0.6 }), S(100, 130, { relevance: 0.95 }), S(200, 230, { relevance: 0.7 }), S(300, 330, { relevance: 0.8 })];
  const out = A.pendingSuggestions(list, [{ start: 205, end: 225, status: 'rejected' }]);
  assert.deepEqual(plain(out.map((s) => s.start)), [100, 300, 10]);
  assert.deepEqual(plain(A.pendingSuggestions(null, [])), []);
});

test('clock e splitKeywords', () => {
  const { A } = load();
  assert.equal(A.clock(0), '0:00');
  assert.equal(A.clock(75.4), '1:15');
  assert.equal(A.clock(3723), '1:02:03');
  assert.deepEqual(plain(A.splitKeywords(' clip, pog ;omg\n  wtf ,, ')), ['clip', 'pog', 'omg', 'wtf']);
});

test('addSuggestions cria cortes pendentes (origin auto) com relevância e motivos, em ordem cronológica', () => {
  const { A, project, emitted } = load({ cuts: [{ id: 'm1', title: 'Manual', start: 500, end: 520, status: 'approved', origin: 'manual' }] });
  const created = A.addSuggestions([S(300, 330, { relevance: 0.9, reasons: ['pico de áudio 6σ', 'chat 4× a média'] }), S(10, 40, { relevance: 0.6 })]);
  assert.equal(created.length, 2);
  assert.deepEqual(plain(project.cuts.map((c) => c.start)), [10, 300, 500], 'ordem cronológica');
  for (const cut of created) {
    assert.equal(cut.status, 'pending', 'NUNCA aprovado automaticamente');
    assert.equal(cut.origin, 'auto');
    assert.equal(cut.reviewedAt, null);
    assert.equal(cut.revision, 1);
    assert.ok(cut.id && cut.title.startsWith('Sugestão '));
  }
  const big = project.cuts.find((c) => c.start === 300);
  assert.equal(big.relevance, 0.9);
  assert.deepEqual(big.reasons, ['pico de áudio 6σ', 'chat 4× a média']);
  assert.equal(big.title, 'Sugestão 5:00');
  assert.equal(project.cuts.find((c) => c.id === 'm1').status, 'approved', 'cortes existentes não mudam');
  // modelo completo (como qualquer corte)
  assert.deepEqual([big.audio.gainDb, big.subtitles, big.framing, Array.isArray(big.exports)], [0, null, null, true]);

  // eventos: um cuts:changed (com todos os ids) e um decision create por corte
  const changed = emitted.filter(([e]) => e === 'cuts:changed');
  assert.equal(changed.length, 1);
  assert.deepEqual(plain([...changed[0][1].ids].sort()), plain(created.map((c) => c.id).sort()));
  const decisions = emitted.filter(([e]) => e === 'decision').map(([, d]) => d);
  assert.equal(decisions.length, 2);
  for (const d of decisions) {
    assert.equal(d.type, 'create');
    assert.equal(d.before, null);
    assert.equal(d.after.id, d.cutId);
    assert.equal(d.after.origin, 'auto');
    assert.equal(d.after.status, 'pending');
  }
  assert.ok(!emitted.some(([e]) => e === 'cut:selected'), 'adicionar não sequestra a seleção');
  assert.ok(emitted.some(([e, d]) => e === 'project:update' && d.reason === 'analysis:add'));
});

test('addSuggestions não duplica: o que já virou corte (ou foi rejeitado) não volta', () => {
  const { A, project, emitted } = load();
  const s = S(100, 130);
  assert.equal(A.addSuggestions([s]).length, 1);
  assert.equal(A.addSuggestions([s]).length, 0, 'duplo clique / lista velha');
  assert.equal(project.cuts.length, 1);
  // o usuário rejeita; reanálise devolve a mesma região (um pouco deslocada): nada é criado
  project.cuts[0].status = 'rejected';
  assert.equal(A.addSuggestions([S(98, 131)]).length, 0);
  assert.equal(project.cuts.length, 1);
  assert.equal(emitted.filter(([e]) => e === 'decision').length, 1, 'sem decision para o que não foi criado');
  assert.deepEqual(plain(A.addSuggestions([])), []);
});

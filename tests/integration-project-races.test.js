'use strict';

/**
 * Integração do projeto: dados de um corte que outros recursos escrevem (legendas, áudio, exportações) não podem se perder
 * quando a revisão desfaz/refaz/restaura, e eventos 'decision' de outros recursos não podem virar entradas falsas no
 * histórico. (A parte de gravação concorrente no app aberto está em tests/e2e/integration-flow.e2e.js.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../src/core/review/engine');
const history = require('../src/core/history/log');
const model = require('../src/core/projects/model');

function setup(cutFields = []) {
  let tick = 0;
  let seq = 0;
  const project = {
    id: 'proj1',
    source: { path: 'D:\\v.mp4', duration: 100 },
    cuts: cutFields.map((f, i) => model.newCut({ title: `Corte ${i + 1}`, ...f }, { now: '2026-10-21T10:00:00.000Z' }))
  };
  const events = [];
  const engine = createEngine({
    getProject: () => project,
    update: (fn) => fn(project),
    emit: (name, data) => events.push([name, data]),
    now: () => new Date(Date.UTC(2026, 9, 21, 12, 0, ++tick)).toISOString(),
    uid: (p) => `${p}${++seq}`,
    duration: () => 100
  });
  engine.reset(project.id);
  return { project, engine, events, cut: (id) => project.cuts.find((c) => c.id === id) };
}

test('"Salvar corte" (create externo) desfeito e refeito devolve o corte COMO ESTÁ, com legendas, áudio e exportações feitas depois', () => {
  const t = setup([]);
  // o que BF.project.addCut faz: cria o corte e avisa 'decision' create (a revisão guarda no histórico)
  const created = model.newCut({ id: 'novo', title: 'Corte 1', start: 10, end: 20 }, { index: 0 });
  t.project.cuts.push(created);
  t.engine.recordExternal({ cutId: 'novo', type: 'create', before: null, after: JSON.parse(JSON.stringify(created)) });
  t.engine.flushExternal();
  assert.equal(t.engine.groups().length, 1);

  // depois da criação: legenda, ganho de áudio e uma exportação concluída (cada recurso escreve no seu campo)
  const live = t.cut('novo');
  live.subtitles = { enabled: true, mode: 'burn', cues: [{ start: 0, end: 2, text: 'oi' }] };
  live.audio = { ...live.audio, gainDb: 6, history: [{ at: 1, label: 'Ganho +6 dB', before: {}, after: {} }] };
  live.exports.push({ path: 'D:\\Cortes\\a.mp4', start: 10, end: 20, profile: { id: 'vertical-1080-h264' } });

  const undone = t.engine.undo();
  assert.ok(undone);
  assert.equal(t.project.cuts.length, 0, 'desfazer a criação tira o corte');
  const redone = t.engine.redo();
  assert.ok(redone);
  assert.equal(t.project.cuts.length, 1);
  const back = t.cut('novo');
  assert.deepEqual(back.subtitles, { enabled: true, mode: 'burn', cues: [{ start: 0, end: 2, text: 'oi' }] }, 'a legenda voltou');
  assert.equal(back.audio.gainDb, 6, 'o ganho voltou');
  assert.equal(back.audio.history.length, 1);
  assert.equal(back.exports.length, 1, 'a exportação anotada voltou');
});

test('remover e desfazer (lote do usuário) também devolve o corte atual, não uma cópia velha', () => {
  const t = setup([{ id: 'a', start: 10, end: 20 }]);
  const first = t.engine.setStatus('a', 'approved');
  assert.ok(first);
  t.cut('a').subtitles = { enabled: true, mode: 'sidecar', cues: [{ start: 0, end: 1, text: 'x' }] };
  t.engine.remove('a');
  assert.equal(t.project.cuts.length, 0);
  t.engine.undo();
  assert.equal(t.cut('a').subtitles.mode, 'sidecar');
  assert.equal(t.cut('a').status, 'approved');
});

test("'decision' de ÁUDIO e de LEGENDAS (adjust sem tempo de corte) não entra no histórico nem ocupa o Ctrl+Z", () => {
  const t = setup([{ id: 'a', start: 10, end: 20 }]);
  t.engine.setStatus('a', 'approved'); // uma decisão de verdade
  assert.equal(t.engine.groups().length, 1);

  const audio = { cutId: 'a', type: 'adjust', scope: 'audio', before: { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0 }, after: { gainDb: 6, mute: false, fadeInSec: 0, fadeOutSec: 0 } };
  const subs = { cutId: 'a', type: 'adjust', before: { what: 'subtitles', enabled: false }, after: { what: 'subtitles', enabled: true } };
  assert.equal(history.itemFromEvent(audio, t.project.cuts), null);
  assert.equal(history.itemFromEvent(subs, t.project.cuts), null);
  assert.equal(t.engine.recordExternal(audio), false);
  assert.equal(t.engine.recordExternal(subs), false);
  t.engine.flushExternal();
  assert.equal(t.engine.groups().length, 1, 'nenhum grupo novo');
  const undone = t.engine.undo();
  assert.equal(undone.target.label, 'Aprovou “Corte 1”', 'Ctrl+Z desfaz a decisão de verdade, não uma entrada vazia');
  assert.equal(t.cut('a').status, 'pending');

  // o ajuste de TEMPO de outro recurso continua entrando
  const time = { cutId: 'a', type: 'adjust', before: { start: 10, end: 20 }, after: { start: 11, end: 20 } };
  assert.ok(history.itemFromEvent(time, t.project.cuts));
  assert.equal(history.itemFromEvent({ cutId: 'a', type: 'adjust', before: { start: null, end: 20 }, after: { start: null, end: 21 } }, t.project.cuts) !== null, true);
});

test('cortes criados em lote pela análise viram UM grupo ("Criou 3 cortes") e o desfazer devolve todos', () => {
  const t = setup([]);
  for (let i = 0; i < 3; i++) {
    const cut = model.newCut({ id: `s${i}`, title: `Sugestão ${i}`, start: i * 20, end: i * 20 + 10, origin: 'auto', relevance: 0.6 }, { index: i });
    t.project.cuts.push(cut);
    t.engine.recordExternal({ cutId: cut.id, type: 'create', before: null, after: JSON.parse(JSON.stringify(cut)) });
  }
  t.engine.flushExternal();
  assert.equal(t.engine.groups().length, 1);
  assert.equal(t.engine.groups()[0].label, 'Criou 3 cortes');
  t.engine.undo();
  assert.equal(t.project.cuts.length, 0);
  t.engine.redo();
  assert.equal(t.project.cuts.length, 3);
  assert.ok(t.project.cuts.every((c) => c.status === 'pending' && c.origin === 'auto'), 'nada foi aprovado por ninguém');
});

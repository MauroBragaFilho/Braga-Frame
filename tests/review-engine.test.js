'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core/review/core');
const { createEngine } = require('../src/core/review/engine');
const history = require('../src/core/history/log');
const model = require('../src/core/projects/model');

/** Projeto e motor de verdade (só o app/Electron é simulado por funções). Relógio e ids determinísticos. */
function setup(cutFields = []) {
  let tick = 0;
  let seq = 0;
  const project = {
    id: 'proj1',
    source: { path: 'D:\\v.mp4', duration: 100 },
    cuts: cutFields.map((f, i) => model.newCut({ title: `Corte ${i + 1}`, ...f }, { now: '2026-10-21T10:00:00.000Z' }))
  };
  const events = [];
  const persisted = [];
  const engine = createEngine({
    getProject: () => project,
    update: (fn) => fn(project),
    emit: (name, data) => events.push([name, data]),
    now: () => new Date(Date.UTC(2026, 9, 21, 12, 0, ++tick)).toISOString(),
    uid: (p) => `${p}${++seq}`,
    duration: () => 100,
    persist: (id, group) => persisted.push([id, group])
  });
  engine.reset(project.id);
  const decisions = () => events.filter(([n]) => n === 'decision').map(([, d]) => d);
  const cut = (id) => project.cuts.find((c) => c.id === id);
  return { project, engine, events, persisted, decisions, cut };
}

const THREE = [
  { id: 'a', start: 10, end: 20 },
  { id: 'b', start: 30, end: 40, origin: 'auto', relevance: 0.8, reasons: ['pico de áudio'] },
  { id: 'c', start: 50, end: 60 }
];

test('aprovar: grava a revisão, emite cuts:changed uma vez e decision com o contrato, e guarda um grupo', () => {
  const t = setup(THREE);
  const res = t.engine.setStatus('a', 'approved');
  assert.equal(res.group.label, 'Aprovou “Corte 1”');
  const a = t.cut('a');
  assert.equal(a.status, 'approved');
  assert.deepEqual(a.reviewedRange, [10, 20]);
  assert.ok(a.reviewedAt);
  assert.deepEqual(t.events.filter(([n]) => n === 'cuts:changed').map(([, d]) => d), [{ ids: ['a'], from: 'review' }]);
  const [d] = t.decisions();
  assert.deepEqual([d.cutId, d.type, d.before, d.after, d.source], ['a', 'approve', 'pending', 'approved', 'user']);
  assert.equal(d.reviewGroup, res.group.id);
  assert.equal(t.persisted.length, 1);
  assert.equal(t.persisted[0][0], 'proj1');
  assert.equal(t.persisted[0][1].id, res.group.id);
  assert.equal(t.engine.canUndo(), true);
  assert.equal(t.engine.undoLabel(), 'Aprovou “Corte 1”');
});

test('não há decisão nem grupo quando nada muda', () => {
  const t = setup(THREE);
  t.engine.setStatus('a', 'approved');
  const before = t.engine.groups().length;
  assert.equal(t.engine.setStatus('a', 'approved'), null);
  assert.equal(t.engine.setStatus('nao-existe', 'approved'), null);
  assert.equal(t.engine.recategorize('b', ''), null);
  assert.equal(t.engine.groups().length, before);
});

test('desfazer e refazer: restauram o corte, emitem decisões do tipo certo (source undo/redo) e viram grupos', () => {
  const t = setup(THREE);
  t.engine.setStatus('a', 'approved');
  const undone = t.engine.undo();
  assert.equal(undone.target.label, 'Aprovou “Corte 1”');
  assert.equal(t.cut('a').status, 'pending');
  assert.equal(t.cut('a').reviewedAt, null);
  assert.equal(t.cut('a').reviewedRange, null);
  const last = t.decisions().at(-1);
  assert.deepEqual([last.type, last.before, last.after, last.source], ['reset', 'approved', 'pending', 'undo']);
  assert.equal(t.engine.canUndo(), false);
  assert.equal(t.engine.canRedo(), true);
  assert.equal(t.engine.redoLabel(), 'Aprovou “Corte 1”');
  t.engine.redo();
  assert.equal(t.cut('a').status, 'approved');
  assert.equal(t.decisions().at(-1).source, 'redo');
  assert.equal(t.engine.canRedo(), false);
  assert.equal(t.engine.canUndo(), true);
  // o log guarda tudo, em ordem: aprovou, desfez, refez
  assert.deepEqual(t.engine.groups().map((g) => g.source), ['user', 'undo', 'redo']);
  assert.deepEqual(t.engine.groups().map((g) => g.label), ['Aprovou “Corte 1”', 'Desfez: Aprovou “Corte 1”', 'Refez: Aprovou “Corte 1”']);
  assert.equal(t.engine.undo() !== null && t.engine.undo(), null, 'a segunda vez não há mais o que desfazer');
});

test('uma ação nova depois de desfazer apaga o "refazer"', () => {
  const t = setup(THREE);
  t.engine.setStatus('a', 'approved');
  t.engine.undo();
  assert.equal(t.engine.canRedo(), true);
  t.engine.setStatus('b', 'rejected');
  assert.equal(t.engine.canRedo(), false);
  assert.equal(t.engine.redo(), null);
});

test('ajustar tempo de corte revisado: revision +1, vira "alterado"; desfazer limpa o aviso', () => {
  const t = setup(THREE);
  t.engine.setStatus('a', 'approved');
  assert.equal(core.reviewState(t.cut('a')).changed, false);
  const res = t.engine.nudge('a', 'start', 0.1);
  assert.equal(res.ok, true);
  assert.equal(t.cut('a').start, 10.1);
  assert.equal(t.cut('a').revision, 2);
  assert.equal(core.reviewState(t.cut('a')).changed, true);
  assert.equal(t.engine.undoLabel(), 'Ajustou “Corte 1” (início +0,1 s)');
  const d = t.decisions().at(-1);
  assert.deepEqual([d.type, d.before, d.after], ['adjust', { start: 10, end: 20 }, { start: 10.1, end: 20 }]);
  t.engine.undo();
  assert.equal(t.cut('a').start, 10);
  assert.equal(core.reviewState(t.cut('a')).changed, false);
  assert.equal(t.cut('a').revision, 3, 'a revisão só sobe (legendas e exportações dependem disso)');
  // reconfirmar após mudar tira o aviso sem mexer no tempo
  t.engine.nudge('a', 'end', -1);
  assert.equal(core.reviewState(t.cut('a')).changed, true);
  t.engine.markReviewed('a');
  assert.equal(core.reviewState(t.cut('a')).changed, false);
  assert.equal(t.cut('a').end, 19);
  assert.equal(t.engine.undoLabel(), 'Reconfirmou a revisão de “Corte 1”');
});

test('ajustar corte pendente não o marca como alterado; limites do vídeo e tempo inválido', () => {
  const t = setup(THREE);
  t.engine.nudge('c', 'end', 1);
  assert.equal(core.reviewState(t.cut('c')).changed, false);
  const toEnd = t.engine.adjust('c', { end: 150 });
  assert.deepEqual([toEnd.ok, toEnd.clamped, t.cut('c').end], [true, true, 100]);
  const bad = t.engine.adjust('c', { start: 99.99 });
  assert.equal(bad.ok, true, 'start perto do fim: o limite deixa 0,2 s');
  const invalid = t.engine.adjust('c', { start: 'x' });
  assert.equal(invalid.ok, false);
  const before = t.engine.groups().length;
  const nope = t.engine.nudge('c', 'start', Number.NaN);
  assert.equal(nope.ok, false);
  assert.equal(t.engine.groups().length, before, 'tempo inválido não vira decisão');
  assert.equal(t.engine.nudge('zzz', 'start', 1).ok, false);
});

test('ajustar uma borda não mexe na outra: corte parcialmente fora do vídeo mantém o fim, e a mensagem nomeia a borda certa', () => {
  const t = setup([{ id: 'f', start: 70, end: 130, status: 'approved' }]); // fonte atualizada: o fim passa dos 100 s do vídeo
  const res = t.engine.nudge('f', 'start', -1);
  assert.deepEqual([res.ok, res.clamped, res.clampedEdges], [true, false, []], 'o início andou normalmente: nada foi limitado');
  assert.deepEqual([t.cut('f').start, t.cut('f').end], [69, 130], 'o fim continua em 130 (isso é o aviso "Fora da fonte", não algo a corrigir em silêncio)');
  assert.equal(t.engine.undoLabel(), 'Ajustou “Corte 1” (início -1 s)', 'só o início consta no histórico');
  const d = t.decisions().at(-1);
  assert.deepEqual([d.before, d.after], [{ start: 70, end: 130 }, { start: 69, end: 130 }]);
  // limitar de verdade: mexer no fim em direção ao limite do vídeo
  const toEnd = t.engine.nudge('f', 'end', 1);
  assert.deepEqual([toEnd.ok, toEnd.clamped, toEnd.clampedEdges, t.cut('f').start, t.cut('f').end], [true, true, ['end'], 69, 100], 'o fim foi limitado ao vídeo e o início ficou como estava');
  // desfazer devolve os dois exatamente
  t.engine.undo();
  t.engine.undo();
  assert.deepEqual([t.cut('f').start, t.cut('f').end], [70, 130]);
});

test('corte todo fora do vídeo: o fim não colapsa para 0,2 s no final; recusa com a causa e o início pode ser trazido de volta', () => {
  const t = setup([{ id: 'g', start: 200, end: 230 }]);
  const groups = t.engine.groups().length;
  const refused = t.engine.nudge('g', 'end', -1);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /início do corte \(3:20\.0\) já está depois do fim do vídeo \(1:40\.0\)\. Ajuste o início primeiro/);
  assert.deepEqual([t.cut('g').start, t.cut('g').end], [200, 230], 'nada foi empurrado');
  assert.equal(t.engine.groups().length, groups, 'recusa não vira decisão');
  const typed = t.engine.adjust('g', { end: 229 });
  assert.equal(typed.ok, false, 'digitar o fim também recusa');
  // o caminho é trazer o início para dentro do vídeo (a borda pedida é limitada ao vídeo; o fim segue como estava)
  const back = t.engine.nudge('g', 'start', -1);
  assert.deepEqual([back.ok, back.clamped, back.clampedEdges, t.cut('g').start, t.cut('g').end], [true, true, ['start'], 99.8, 230]);
});

test('ajustar o início não arredonda o fim (nem sobe a revisão por isso) e um deslocamento 0/0 em lote não marca o corte aprovado como "alterado"', () => {
  const t = setup([{ id: 'h', start: 10.123, end: 20.4567, status: 'approved' }]);
  t.engine.nudge('h', 'start', 1);
  assert.deepEqual([t.cut('h').start, t.cut('h').end, t.cut('h').revision], [11.12, 20.4567, 2]);
  t.engine.undo();
  assert.deepEqual([t.cut('h').start, t.cut('h').end], [10.123, 20.4567]);
  const revision = t.cut('h').revision;
  const none = t.engine.commitPlan(t.engine.plan('shift', ['h'], { startDelta: 0, endDelta: 0 }));
  assert.equal(none, null, '0/0: nada a aplicar');
  assert.equal(t.cut('h').revision, revision);
  assert.equal(core.reviewState(t.cut('h')).changed, false);
});

test('aprovar e ajustar um corte da análise não o torna "personalizado" (o título "Sugestão m:ss" é automático)', () => {
  const t = setup([{ id: 'a', title: 'Sugestão 0:10', start: 10, end: 30, origin: 'auto', relevance: 0.8 }]);
  const titles = require('../src/core/review/titles');
  assert.equal(titles.isCustomTitle(t.cut('a')), false);
  t.engine.setStatus('a', 'approved');
  t.engine.nudge('a', 'end', 1);
  assert.equal(titles.isCustomTitle(t.cut('a')), false, 'depois de aprovar e ajustar continua automático (trocar por sugestão não pede confirmação)');
  assert.equal(t.cut('a').titleCustom, undefined);
  t.engine.retitle('a', 'Meu título');
  assert.equal(titles.isCustomTitle(t.cut('a')), true, 'só o que o usuário digita é dele');
});

test('lote: prévia não altera nada; aplicar gera UM grupo com uma decision por corte; desfazer volta tudo de uma vez', () => {
  const t = setup(THREE);
  const snapshot = JSON.stringify(t.project.cuts);
  const plan = t.engine.plan('approve', ['a', 'b', 'c']);
  assert.equal(JSON.stringify(t.project.cuts), snapshot);
  assert.equal(t.engine.groups().length, 0);
  assert.equal(plan.counts.changed, 3);

  const res = t.engine.commitPlan(plan);
  assert.equal(res.group.label, 'Aprovou 3 cortes');
  assert.equal(res.group.source, 'batch');
  assert.equal(res.group.items.length, 3);
  assert.deepEqual(t.project.cuts.map((c) => c.status), ['approved', 'approved', 'approved']);
  assert.equal(t.events.filter(([n]) => n === 'cuts:changed').length, 1, 'um aviso só para o lote inteiro');
  assert.equal(t.decisions().length, 3);
  assert.ok(t.decisions().every((d) => d.reviewGroup === res.group.id && d.type === 'approve'));
  assert.equal(t.persisted.length, 1, 'um grupo gravado');

  t.engine.undo();
  assert.deepEqual(t.project.cuts.map((c) => c.status), ['pending', 'pending', 'pending']);
  assert.equal(t.engine.groups().at(-1).label, 'Desfez: Aprovou 3 cortes');
});

test('lote com erro de plano não aplica nada', () => {
  const t = setup(THREE);
  const plan = t.engine.plan('shift', ['a'], { startDelta: 'x' });
  assert.ok(plan.error);
  assert.equal(t.engine.commitPlan(plan), null);
  assert.equal(t.engine.groups().length, 0);
});

test('lote deslocar: aplica só o que muda e respeita os limites; desfazer devolve os tempos', () => {
  const t = setup([{ id: 'a', start: 1, end: 5, status: 'approved' }, { id: 'b', start: 90, end: 99.5 }]);
  const res = t.engine.commitPlan(t.engine.plan('shift', ['a', 'b'], { startDelta: 2, endDelta: 2 }));
  assert.deepEqual([t.cut('a').start, t.cut('a').end], [3, 7]);
  assert.deepEqual([t.cut('b').start, t.cut('b').end], [92, 100]);
  assert.equal(core.reviewState(t.cut('a')).changed, true, 'já revisado: alterado');
  assert.equal(res.group.label, 'Deslocou os tempos de 2 cortes (início +2 s, fim +2 s)');
  t.engine.undo();
  assert.deepEqual([t.cut('a').start, t.cut('a').end, t.cut('b').start, t.cut('b').end], [1, 5, 90, 99.5]);
  assert.equal(core.reviewState(t.cut('a')).changed, false);
});

test('manter um e rejeitar os demais, em lote, e desfazer', () => {
  const t = setup([{ id: 'a', start: 10, end: 20 }, { id: 'b', start: 12, end: 22 }, { id: 'c', start: 13, end: 23 }]);
  t.engine.commitPlan(t.engine.plan('keepOne', ['a', 'b', 'c'], { keepId: 'b' }));
  assert.deepEqual(t.project.cuts.map((c) => c.status), ['rejected', 'pending', 'rejected']);
  assert.equal(t.engine.groups()[0].label, 'Manteve um e rejeitou os demais');
  assert.equal(t.engine.groups()[0].items.length, 2, 'o mantido sem mudança não entra no grupo');
  t.engine.undo();
  assert.deepEqual(t.project.cuts.map((c) => c.status), ['pending', 'pending', 'pending']);
});

test('remover e desfazer: o corte volta inteiro (campos de outros recursos incluídos) e na posição certa', () => {
  const t = setup([
    { id: 'a', start: 10, end: 20 },
    { id: 'b', start: 30, end: 40, subtitles: { enabled: true, cues: [{ start: 30, end: 31, text: 'oi' }] }, exports: [{ path: 'D:\\x.mp4' }], campoFuturo: { x: 1 }, notes: 'importante' },
    { id: 'c', start: 50, end: 60 }
  ]);
  const original = JSON.stringify(t.cut('b'));
  t.engine.remove('b');
  assert.deepEqual(t.project.cuts.map((c) => c.id), ['a', 'c']);
  assert.deepEqual(t.decisions().at(-1).before.id, 'b');
  assert.equal(t.decisions().at(-1).after, null);
  t.engine.undo();
  assert.deepEqual(t.project.cuts.map((c) => c.id), ['a', 'b', 'c']);
  assert.equal(JSON.stringify(t.cut('b')), original);
  assert.equal(t.decisions().at(-1).type, 'create');
  assert.equal(t.decisions().at(-1).source, 'undo');
  t.engine.redo();
  assert.deepEqual(t.project.cuts.map((c) => c.id), ['a', 'c']);
});

test('desfazer quando o corte sumiu (outro recurso o removeu) avisa quantos faltaram e não quebra', () => {
  const t = setup(THREE);
  t.engine.setStatus('a', 'approved');
  t.project.cuts = t.project.cuts.filter((c) => c.id !== 'a');
  const res = t.engine.undo();
  assert.equal(res.missing, 1);
  assert.equal(res.group, null);
  assert.equal(t.engine.canRedo(), true);
});

test('renomear: título digitado é "personalizado"; sugestão clicada não; desfazer devolve título e marca', () => {
  const t = setup(THREE);
  t.engine.retitle('a', '  Ace   na final ');
  assert.equal(t.cut('a').title, 'Ace na final');
  assert.equal(t.cut('a').titleCustom, true);
  t.engine.retitle('a', 'Ace em Valorant', { custom: false });
  assert.equal(t.cut('a').titleCustom, false);
  const d = t.decisions().at(-1);
  assert.deepEqual([d.type, d.before, d.after], ['retitle', 'Ace na final', 'Ace em Valorant']);
  t.engine.undo();
  assert.deepEqual([t.cut('a').title, t.cut('a').titleCustom], ['Ace na final', true]);
  t.engine.undo();
  assert.deepEqual([t.cut('a').title, 'titleCustom' in t.cut('a')], ['Corte 1', false], 'volta a ser título automático');
  assert.equal(t.engine.retitle('a', '   '), null, 'título vazio não vira decisão');
  assert.equal(t.cut('a').title, 'Corte 1');
});

test('sugerir títulos guarda as sugestões e NUNCA troca o título (nem o personalizado); só o clique troca', () => {
  const t = setup([{ id: 'a', start: 3725, end: 3750, category: 'clutch', reasons: ['pico de áudio'], title: 'Meu título', titleCustom: true }]);
  const list = t.engine.suggestTitles('a', { game: 'Valorant' });
  assert.ok(list.length >= 3);
  assert.equal(t.cut('a').title, 'Meu título');
  assert.equal(t.cut('a').titleCustom, true);
  assert.deepEqual(t.cut('a').titleSuggestions, list);
  assert.equal(t.engine.groups().length, 0, 'sugerir não é decisão: sem histórico');
  assert.equal(t.decisions().length, 0);
  // gerar de novo não duplica nem troca nada
  const again = t.engine.suggestTitles('a', { game: 'Valorant' });
  assert.ok(again.length >= list.length);
  assert.equal(new Set(again.map((s) => s.toLowerCase())).size, again.length);
  assert.equal(t.cut('a').title, 'Meu título');
  // clicar numa sugestão é uma decisão do usuário
  t.engine.retitle('a', list[0], { custom: false });
  assert.equal(t.cut('a').title, list[0]);
});

test('categorizar e notas: categoria é decisão; notas não', () => {
  const t = setup(THREE);
  t.engine.recategorize('b', '  Clutch ');
  assert.equal(t.cut('b').category, 'Clutch');
  const d = t.decisions().at(-1);
  assert.deepEqual([d.type, d.before, d.after], ['recategorize', '', 'Clutch']);
  const n = t.decisions().length;
  assert.equal(t.engine.setNotes('b', 'ver depois'), true);
  assert.equal(t.cut('b').notes, 'ver depois');
  assert.equal(t.engine.setNotes('b', 'ver depois'), false);
  assert.equal(t.decisions().length, n);
  assert.equal(t.engine.groups().length, 1);
  t.engine.undo();
  assert.equal(t.cut('b').category, '');
  assert.equal(t.cut('b').notes, 'ver depois', 'desfazer a categoria não mexe nas notas');
});

test('decisões de outros recursos (ex.: "Salvar corte" da base) entram no histórico e podem ser desfeitas', () => {
  const t = setup(THREE);
  const created = model.newCut({ id: 'n1', title: 'Corte 4', start: 70, end: 75 });
  t.project.cuts.push(created);
  t.project.cuts.sort((x, y) => x.start - y.start);
  assert.equal(t.engine.recordExternal({ cutId: 'n1', type: 'create', before: null, after: JSON.parse(JSON.stringify(created)) }), true);
  const group = t.engine.flushExternal();
  assert.equal(group.source, 'external');
  assert.equal(group.label, 'Criou “Corte 4”');
  assert.equal(t.engine.canUndo(), true);
  assert.equal(t.persisted.length, 1, 'também é gravado no histórico em disco');
  // o que o motor emitiu não é registrado duas vezes
  t.engine.setStatus('a', 'approved');
  const own = t.decisions().at(-1);
  assert.equal(t.engine.recordExternal(own), false);
  assert.equal(t.engine.flushExternal(), null);
  assert.equal(t.engine.groups().length, 2);
  t.engine.undo();
  t.engine.undo(); // desfaz a criação
  assert.deepEqual(t.project.cuts.map((c) => c.id), ['a', 'b', 'c']);
  t.engine.redo();
  assert.deepEqual(t.project.cuts.map((c) => c.id), ['a', 'b', 'c', 'n1']);
  // lixo não quebra
  assert.equal(t.engine.recordExternal(null), false);
  assert.equal(t.engine.recordExternal({ cutId: 'x', type: 'estranho' }), false);
  assert.equal(t.engine.recordExternal({ type: 'approve' }), false);
  assert.equal(t.engine.flushExternal(), null);
});

test('decisões externas coladas viram UM grupo (a análise cria dezenas de cortes de uma vez) e desfazem juntas', () => {
  const t = setup(THREE);
  for (let i = 0; i < 4; i++) {
    const created = model.newCut({ id: `n${i}`, title: `Momento ${i + 1}`, start: 70 + i * 10, end: 75 + i * 10, origin: 'auto' });
    t.project.cuts.push(created);
    t.engine.recordExternal({ cutId: created.id, type: 'create', before: null, after: JSON.parse(JSON.stringify(created)) });
  }
  assert.equal(t.engine.groups().length, 0, 'ainda esperando mais decisões coladas');
  // uma ação do usuário fecha o grupo pendente ANTES de se aplicar (a ordem do histórico fica certa)
  t.engine.setStatus('a', 'approved');
  assert.deepEqual(t.engine.groups().map((g) => [g.source, g.label]), [['external', 'Criou 4 cortes'], ['user', 'Aprovou “Corte 1”']]);
  assert.equal(t.engine.groups()[0].items.length, 4);
  t.engine.undo();
  t.engine.undo();
  assert.deepEqual(t.project.cuts.map((c) => c.id), ['a', 'b', 'c'], 'desfazer tira os 4 de uma vez');
  t.engine.redo();
  assert.equal(t.project.cuts.length, 7);
  // tipos misturados
  t.engine.recordExternal({ cutId: 'a', type: 'retitle', before: 'Corte 1', after: 'Novo' });
  t.engine.recordExternal({ cutId: 'b', type: 'recategorize', before: '', after: 'X' });
  assert.equal(t.engine.flushExternal().label, 'Alterou 2 cortes');
});

test('decisões externas esperando quando o projeto muda vão só para o histórico do projeto antigo', () => {
  const t = setup(THREE);
  const created = model.newCut({ id: 'n1', title: 'Corte 4', start: 70, end: 75 });
  t.project.cuts.push(created);
  t.engine.recordExternal({ cutId: 'n1', type: 'create', before: null, after: JSON.parse(JSON.stringify(created)) });
  t.project.id = 'proj2'; // o app já abriu outro projeto
  t.engine.reset('proj2');
  assert.equal(t.engine.groups().length, 0, 'nada vaza para o histórico em memória do projeto novo');
  assert.deepEqual(t.persisted.map(([id, g]) => [id, g.label]), [['proj1', 'Criou “Corte 4”']]);
});

test('histórico: restaurar o estado anterior a uma decisão desfaz ela e as seguintes; restaurar vira grupo e pode ser desfeito', () => {
  const t = setup(THREE);
  t.engine.setStatus('a', 'approved'); // g1
  t.engine.retitle('b', 'Ace');        // g2
  t.engine.nudge('c', 'end', 2);       // g3
  t.engine.recategorize('a', 'Fail'); // g4
  const [g1, g2] = t.engine.groups();
  const before = JSON.stringify(t.project.cuts);

  const plan = t.engine.planRestore(g2.id);
  assert.equal(JSON.stringify(t.project.cuts), before, 'a prévia não altera nada');
  assert.equal(plan.label, 'Restaurar o estado anterior a “Renomeou “Corte 2” para “Ace””');
  assert.deepEqual(plan.items.map((i) => i.cutId).sort(), ['a', 'b', 'c']);
  assert.equal(plan.counts.changed, 3);

  const res = t.engine.restore(plan);
  assert.equal(res.group.source, 'restore');
  assert.equal(t.cut('a').status, 'approved', 'g1 é anterior a g2: continua valendo');
  assert.equal(t.cut('a').category, '');
  assert.equal(t.cut('b').title, 'Corte 2');
  assert.equal(t.cut('c').end, 60);
  assert.equal(t.engine.groups().length, 5, 'restaurar é um grupo novo (o log só cresce)');
  assert.equal(t.engine.undoLabel(), res.group.label);

  // e dá para desfazer a restauração
  t.engine.undo();
  assert.equal(JSON.stringify(t.project.cuts.map((c) => [c.id, c.title, c.status, c.category, c.end])), JSON.stringify(JSON.parse(before).map((c) => [c.id, c.title, c.status, c.category, c.end])));
  // restaurar para antes de g1 volta ao projeto original
  const toStart = t.engine.planRestore(g1.id);
  t.engine.restore(toStart);
  assert.deepEqual(t.project.cuts.map((c) => [c.title, c.status, c.category, c.end]), [['Corte 1', 'pending', '', 20], ['Corte 2', 'pending', '', 40], ['Corte 3', 'pending', '', 60]]);
  assert.equal(t.engine.planRestore('inexistente'), null);
});

test('restaurar traz de volta cortes removidos e remove os criados depois', () => {
  const t = setup(THREE);
  t.engine.remove('b'); // g1
  const created = model.newCut({ id: 'n1', title: 'Corte novo', start: 70, end: 75 });
  t.project.cuts.push(created);
  t.engine.recordExternal({ cutId: 'n1', type: 'create', before: null, after: JSON.parse(JSON.stringify(created)) }); // g2
  t.engine.setStatus('c', 'rejected'); // g3
  const [g1] = t.engine.groups();
  const plan = t.engine.planRestore(g1.id);
  const kinds = Object.fromEntries(plan.items.map((i) => [i.cutId, i.type]));
  assert.deepEqual(kinds, { b: 'create', c: 'multi', n1: 'remove' });
  t.engine.restore(plan);
  assert.deepEqual(t.project.cuts.map((c) => [c.id, c.status]), [['a', 'pending'], ['b', 'pending'], ['c', 'pending']]);
  t.engine.undo(); // desfaz a restauração
  assert.deepEqual(t.project.cuts.map((c) => c.id), ['a', 'c', 'n1']);
  assert.equal(t.cut('c').status, 'rejected');
});

test('restaurar com estado já igual não tem o que fazer', () => {
  const t = setup(THREE);
  t.engine.setStatus('a', 'approved');
  t.engine.undo();
  const [g1] = t.engine.groups();
  const plan = t.engine.planRestore(g1.id);
  assert.equal(plan.items.length, 0);
  assert.equal(t.engine.restore(plan), null);
});

test('loadGroups: histórico do disco entra antes do desta sessão e ignora outro projeto e lixo', () => {
  const t = setup(THREE);
  t.engine.setStatus('a', 'approved');
  const onDisk = [
    { id: 'old1', at: '2026-10-20T10:00:00.000Z', label: 'Aprovou “X”', source: 'user', items: [{ cutId: 'x', type: 'approve', before: { status: 'pending' }, after: { status: 'approved' } }] },
    { id: 'lixo' }, null, 'texto', { id: 'old2', label: 'sem itens' }
  ];
  assert.equal(t.engine.loadGroups(onDisk, 'outro-projeto'), false);
  assert.equal(t.engine.groups().length, 1);
  assert.equal(t.engine.loadGroups(onDisk, 'proj1'), true);
  assert.deepEqual(t.engine.groups().map((g) => g.id).slice(0, 1), ['old1']);
  assert.equal(t.engine.groups().length, 2);
  assert.equal(t.engine.canUndo(), true, 'a pilha de desfazer é só desta sessão');
  assert.equal(t.engine.undoLabel(), 'Aprovou “Corte 1”');
  t.engine.reset('proj1');
  assert.equal(t.engine.groups().length, 0);
  assert.equal(t.engine.canUndo(), false);
});

test('o projeto mantém os cortes em ordem cronológica depois de ajustar o início', () => {
  const t = setup(THREE);
  t.engine.adjust('a', { start: 35, end: 38 });
  assert.deepEqual(t.project.cuts.map((c) => c.id), ['b', 'a', 'c']);
  t.engine.undo();
  assert.deepEqual(t.project.cuts.map((c) => c.id), ['a', 'b', 'c']);
});

test('history.eventsFor: um evento por tipo de mudança, no formato do contrato', () => {
  const ev = history.eventsFor({ cutId: 'a', type: 'multi', before: { status: 'approved', title: 'A', start: 1, end: 2 }, after: { status: 'rejected', title: 'B', start: 1, end: 3 } });
  assert.deepEqual(ev.map((e) => e.type), ['reject', 'retitle', 'adjust']);
  assert.deepEqual(ev[2].before, { start: 1, end: 2 });
  assert.deepEqual(ev[2].after, { start: 1, end: 3 });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../src/core/audio/audioHistory');
const { normalizeCut } = require('../src/core/projects/model');

const ZERO = { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0 };
const fresh = () => normalizeCut({ id: 'c1', start: 0, end: 10 }).audio;
const T0 = Date.parse('2026-10-21T12:00:00.000Z');
const vals = (audio) => H.values(audio);

test('uma mudança vira uma entrada { at, label, before, after } e os valores novos', () => {
  const audio = fresh();
  const r = H.applyChange(audio, { gainDb: 6 }, { now: T0 });
  assert.equal(r.changed, true);
  assert.deepEqual(vals(r.audio), { ...ZERO, gainDb: 6 });
  assert.equal(r.audio.history.length, 1);
  assert.deepEqual(r.audio.history[0], { at: '2026-10-21T12:00:00.000Z', label: 'Ganho +6 dB', before: ZERO, after: { ...ZERO, gainDb: 6 } });
  assert.deepEqual(Object.keys(r.audio.history[0]).sort(), ['after', 'at', 'before', 'label']);
  assert.deepEqual(audio, fresh(), 'a entrada não é modificada');
  assert.equal('redo' in r.audio, false, 'sem redo, o campo nem existe');
});

test('mudança que não muda nada não grava nada', () => {
  const audio = fresh();
  assert.equal(H.applyChange(audio, { gainDb: 0 }, { now: T0 }).changed, false);
  assert.equal(H.applyChange(audio, {}, { now: T0 }).changed, false);
  assert.equal(H.applyChange(audio, { mute: false, fadeInSec: '0' }, { now: T0 }).audio, audio);
  assert.equal(H.undo(audio), null);
  assert.equal(H.redo(audio), null);
  assert.equal(H.canUndo(audio) || H.canRedo(audio), false);
});

test('rótulos em português para cada campo', () => {
  const step = (a, patch, now) => H.applyChange(a, patch, { now, coalesce: false }).audio;
  let a = fresh();
  a = step(a, { gainDb: -3.5 }, T0);
  a = step(a, { mute: true }, T0 + 1);
  a = step(a, { mute: false }, T0 + 2);
  a = step(a, { fadeInSec: 0.5 }, T0 + 3);
  a = step(a, { fadeOutSec: 1.25 }, T0 + 4);
  a = step(a, { fadeInSec: 0 }, T0 + 5);
  a = step(a, { gainDb: 2, fadeOutSec: 0 }, T0 + 6);
  assert.deepEqual(a.history.map((e) => e.label), ['Ganho -3,5 dB', 'Mudo ligado', 'Mudo desligado', 'Fade in 0,5 s', 'Fade out 1,25 s', 'Fade in removido', 'Vários ajustes']);
});

test('desfazer e refazer andam pela pilha e restauram exatamente os valores', () => {
  let a = fresh();
  a = H.applyChange(a, { gainDb: 3 }, { now: T0, coalesce: false }).audio;
  a = H.applyChange(a, { mute: true }, { now: T0 + 5000 }).audio;
  a = H.applyChange(a, { fadeInSec: 1 }, { now: T0 + 10000 }).audio;
  assert.deepEqual(vals(a), { gainDb: 3, mute: true, fadeInSec: 1, fadeOutSec: 0 });
  assert.equal(a.history.length, 3);

  const u1 = H.undo(a);
  assert.deepEqual(vals(u1.audio), { gainDb: 3, mute: true, fadeInSec: 0, fadeOutSec: 0 });
  assert.equal(u1.entry.label, 'Fade in 1 s');
  assert.deepEqual([u1.audio.history.length, u1.audio.redo.length], [2, 1]);
  const u2 = H.undo(u1.audio);
  const u3 = H.undo(u2.audio);
  assert.deepEqual(vals(u3.audio), ZERO, 'tudo desfeito = áudio original');
  assert.deepEqual([u3.audio.history.length, u3.audio.redo.length], [0, 3]);
  assert.equal(H.undo(u3.audio), null);

  const r1 = H.redo(u3.audio);
  assert.deepEqual(vals(r1.audio), { ...ZERO, gainDb: 3 });
  const r2 = H.redo(r1.audio);
  const r3 = H.redo(r2.audio);
  assert.deepEqual(vals(r3.audio), vals(a), 'refazer tudo volta ao estado de antes');
  assert.deepEqual(r3.audio.history, a.history);
  assert.equal('redo' in r3.audio, false);
  assert.equal(H.redo(r3.audio), null);
});

test('uma mudança nova depois de desfazer descarta o que podia ser refeito', () => {
  let a = fresh();
  a = H.applyChange(a, { gainDb: 3 }, { now: T0, coalesce: false }).audio;
  a = H.applyChange(a, { gainDb: 6 }, { now: T0 + 5000 }).audio;
  a = H.undo(a).audio;
  assert.equal(H.canRedo(a), true);
  a = H.applyChange(a, { mute: true }, { now: T0 + 9000 }).audio;
  assert.equal(H.canRedo(a), false);
  assert.equal('redo' in a, false);
  assert.deepEqual(a.history.map((e) => e.label), ['Ganho +3 dB', 'Mudo ligado']);
});

test('mexidas contínuas no mesmo campo viram uma entrada só', () => {
  let a = fresh();
  for (let i = 1; i <= 20; i++) a = H.applyChange(a, { gainDb: i * 0.5 }, { now: T0 + i * 40 }).audio; // arrastando o controle
  assert.equal(a.history.length, 1);
  assert.deepEqual(a.history[0].before, ZERO);
  assert.equal(a.history[0].after.gainDb, 10);
  assert.equal(a.history[0].label, 'Ganho +10 dB');
  // campo diferente = entrada nova
  a = H.applyChange(a, { mute: true }, { now: T0 + 1000 }).audio;
  assert.equal(a.history.length, 2);
  // mesmo campo, mas depois de uma pausa = entrada nova
  a = H.applyChange(a, { gainDb: 12 }, { now: T0 + 10000 }).audio;
  a = H.applyChange(a, { gainDb: 14 }, { now: T0 + 10300 }).audio;
  assert.deepEqual(a.history.map((e) => e.label), ['Ganho +10 dB', 'Mudo ligado', 'Ganho +14 dB']);
  assert.deepEqual(a.history[2].before, { ...ZERO, gainDb: 10, mute: true });
  // um único desfazer volta ao ponto de partida da mexida
  assert.equal(H.undo(a).audio.gainDb, 10);
});

test('mexer e voltar ao ponto de partida na mesma mexida não deixa entrada', () => {
  let a = fresh();
  a = H.applyChange(a, { gainDb: 4 }, { now: T0 }).audio;
  a = H.applyChange(a, { gainDb: 0 }, { now: T0 + 200 }).audio;
  assert.deepEqual([a.history.length, a.gainDb], [0, 0]);
});

test('o histórico guarda no máximo 50 entradas (as mais antigas saem)', () => {
  let a = fresh();
  for (let i = 1; i <= 80; i++) a = H.applyChange(a, { gainDb: (i % 2 ? i : -i) / 10 }, { now: T0 + i * 10000 }).audio;
  assert.equal(a.history.length, 50);
  assert.equal(a.history[49].after.gainDb, -8);
  assert.equal(a.history[0].after.gainDb, Math.round(31 * 10) / 100, 'a entrada 31 virou a mais antiga');
  // desfazer 50 vezes esvazia o histórico sem quebrar, e o redo também respeita o limite
  let b = a;
  for (let i = 0; i < 60; i++) { const u = H.undo(b); if (!u) break; b = u.audio; }
  assert.deepEqual([b.history.length, b.redo.length], [0, 50]);
});

test('restaurar uma entrada leva ao estado em que ela deixou o áudio e também pode ser desfeito', () => {
  let a = fresh();
  a = H.applyChange(a, { gainDb: 3 }, { now: T0, coalesce: false }).audio;
  a = H.applyChange(a, { fadeInSec: 1 }, { now: T0 + 5000 }).audio;
  a = H.applyChange(a, { gainDb: 9, mute: true }, { now: T0 + 10000 }).audio;
  const restored = H.restoreEntry(a, 0, { now: T0 + 20000 });
  assert.equal(restored.changed, true);
  assert.deepEqual(vals(restored.audio), { ...ZERO, gainDb: 3 }, 'estado logo depois da 1ª entrada');
  assert.equal(restored.audio.history.length, 4);
  assert.equal(restored.audio.history[3].label, 'Restaurado: Ganho +3 dB');
  const back = H.undo(restored.audio);
  assert.deepEqual(vals(back.audio), vals(a), 'desfazer a restauração devolve o estado anterior');
  // restaurar o estado em que já estamos não faz nada; índice inválido também não
  assert.equal(H.restoreEntry(restored.audio, 3, { now: T0 + 30000 }).changed, false);
  assert.equal(H.restoreEntry(a, 99).changed, false);
  assert.equal(H.restoreEntry(a, -1).changed, false);
});

test('voltar ao original zera tudo, fica no histórico e dá para desfazer', () => {
  let a = fresh();
  a = H.applyChange(a, { gainDb: -4, fadeOutSec: 2 }, { now: T0 }).audio;
  const r = H.resetToOriginal(a, { now: T0 + 60000 });
  assert.deepEqual(vals(r.audio), ZERO);
  assert.equal(r.audio.history.at(-1).label, 'Voltar ao original');
  assert.equal(H.resetToOriginal(r.audio, { now: T0 + 70000 }).changed, false, 'já está no original');
  assert.deepEqual(vals(H.undo(r.audio).audio), { ...ZERO, gainDb: -4, fadeOutSec: 2 });
});

test('campos desconhecidos de cut.audio são preservados em todas as operações', () => {
  const base = { ...fresh(), observacao: 'não mexer', outro: { a: 1 } };
  const a = H.applyChange(base, { gainDb: 2 }, { now: T0 }).audio;
  assert.equal(a.observacao, 'não mexer');
  assert.deepEqual(a.outro, { a: 1 });
  assert.deepEqual(H.undo(a).audio.outro, { a: 1 });
  assert.deepEqual(H.resetToOriginal(a, { now: T0 + 9000 }).audio.outro, { a: 1 });
});

test('o resultado atravessa o normalizeCut do projeto sem perder nada (redo é preservado)', () => {
  let a = fresh();
  a = H.applyChange(a, { gainDb: 5 }, { now: T0 }).audio;
  a = H.undo(a).audio;
  const cut = normalizeCut({ id: 'c1', start: 0, end: 10, audio: JSON.parse(JSON.stringify(a)) });
  assert.deepEqual(cut.audio.redo, a.redo);
  assert.equal(H.canRedo(cut.audio), true);
  assert.deepEqual(vals(H.redo(cut.audio).audio), { ...ZERO, gainDb: 5 });
});

test('histórico gravado com lixo (editado à mão ou por outra versão) não quebra', () => {
  const dirty = {
    gainDb: 2, mute: false, fadeInSec: 0, fadeOutSec: 0,
    history: [null, 5, 'x', {}, { before: {} }, { at: 'ontem', label: '', before: { gainDb: 1 }, after: { gainDb: 2 } }, { at: '2026-10-21T10:00:00.000Z', label: 'Ok', before: ZERO, after: { gainDb: 1 } }],
    redo: 'nada'
  };
  const entries = H.historyOf(dirty);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].label, 'Ganho +2 dB', 'rótulo ausente é refeito');
  assert.deepEqual(H.redoOf(dirty), []);
  const u = H.undo(dirty);
  assert.deepEqual(vals(u.audio), ZERO, 'desfaz a última entrada válida');
  assert.equal(u.audio.history.length, 1);
  assert.equal(H.applyChange({ history: 'quebrado' }, { gainDb: 1 }, { now: T0 }).audio.history.length, 1);
});

test('valores fora dos limites são levados ao limite ao gravar', () => {
  const r = H.applyChange(fresh(), { gainDb: 500, fadeInSec: -4 }, { now: T0 });
  assert.deepEqual(vals(r.audio), { gainDb: 20, mute: false, fadeInSec: 0, fadeOutSec: 0 });
  assert.equal(r.audio.history[0].after.gainDb, 20);
});

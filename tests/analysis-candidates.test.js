'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { audioEvents, chatEvents, laughEvents, buildCandidateWindows } = require('../src/core/analysis/candidates');

// pseudo-aleatório determinístico
function rng(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }

/** Fala constante em ~-30 dB (±2) durante `seconds`, com picos de +12 dB nos intervalos `loud` [[de, até]]. */
function speechDb(seconds, loud = [], { silent = [] } = {}) {
  const r = rng(7);
  const out = [];
  for (let i = 0; i < seconds * 2; i += 1) {
    const t = i / 2;
    let v = -30 + (r() - 0.5) * 4;
    if (loud.some(([a, b]) => t >= a && t < b)) v += 12;
    if (silent.some(([a, b]) => t >= a && t < b)) v = -90;
    out.push(v);
  }
  return out;
}

const burst = (t0, n) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * 0.5, text: 'kkkk' }));

test('áudio: acha o aumento sustentado depois de fala e ignora fala constante', () => {
  const quiet = audioEvents(speechDb(900));
  assert.equal(quiet.length, 0);
  const ev = audioEvents(speechDb(900, [[600, 608]]));
  assert.equal(ev.length, 1);
  assert.ok(ev[0].t >= 599 && ev[0].t <= 609, `t=${ev[0].t}`);
  assert.ok(ev[0].z >= 1.8);
});

test('áudio: saída de silêncio para fala NÃO é destaque', () => {
  const ev = audioEvents(speechDb(900, [[500, 508]], { silent: [[480, 500]] }));
  assert.equal(ev.length, 0);
});

test('chat: pico de mensagens é deslocado 5 s para trás', () => {
  const base = Array.from({ length: 40 }, (_, i) => ({ t: i * 20, text: 'oi' }));
  const msgs = [...base, ...burst(500, 14)];
  const ev = chatEvents(msgs, 900);
  assert.ok(ev.length >= 1);
  const e = ev[0];
  assert.ok(e.t < 510 && e.t >= 495, `t=${e.t}`);
  // sem deslocamento o evento cairia no pico (~ 504); com -5 s vem antes
  const shifted = chatEvents(msgs, 900, { chatOffsetSec: 0 })[0];
  assert.ok(Math.abs((shifted.t - e.t) - 5) < 0.001);
});

test('chat vazio ou parado não gera evento', () => {
  assert.deepEqual(chatEvents([], 900), []);
  assert.deepEqual(chatEvents(Array.from({ length: 30 }, (_, i) => ({ t: i * 30, text: 'x' })), 900), []);
});

test('janelas: áudio + chat sobrepostos viram uma janela de 45 a 90 s; o evento fica dentro', () => {
  const events = [
    ...audioEvents(speechDb(1800, [[600, 608]])),
    ...chatEvents([...Array.from({ length: 80 }, (_, i) => ({ t: i * 22, text: 'oi' })), ...burst(606, 14)], 1800)
  ];
  const wins = buildCandidateWindows({ events, duration: 1800 });
  assert.equal(wins.length, 1);
  const w = wins[0];
  assert.ok(w.to - w.from >= 45 && w.to - w.from <= 90, `len ${w.to - w.from}`);
  assert.ok(w.from <= 600 && w.to >= 608);
  assert.deepEqual([...w.kinds].sort(), ['audio', 'chat']);
});

test('janelas: evento fraco e isolado não vira janela; forte e isolado vira', () => {
  const weak = [{ t: 100, z: 2.0, kind: 'audio', from: 100, to: 101 }];
  const strong = [{ t: 100, z: 3.5, kind: 'audio', from: 100, to: 101 }];
  assert.equal(buildCandidateWindows({ events: weak, duration: 1000 }).length, 0);
  assert.equal(buildCandidateWindows({ events: strong, duration: 1000 }).length, 1);
});

test('janelas: risadas marcadas contam (duas juntas)', () => {
  const ev = laughEvents([{ start: 50, end: 52, text: '*Risos*', laugh: true }, { start: 60, end: 62, text: '*Risos*', laugh: true }]);
  assert.equal(buildCandidateWindows({ events: ev, duration: 1000 }).length, 1);
});

test('janelas: a cobertura máxima limita quantas vão para a IA', () => {
  const events = Array.from({ length: 40 }, (_, i) => ({ t: 100 + i * 200, z: 4, kind: 'audio', from: 0, to: 1 }));
  const wins = buildCandidateWindows({ events, duration: 8000 }, { maxCoverage: 0.25 });
  const covered = wins.reduce((n, w) => n + (w.to - w.from) + 30, 0);
  assert.ok(covered <= 8000 * 0.25 + 1, `cobertura ${covered}`);
  assert.ok(wins.length >= 3);
});

test('janelas: respeitam o início e o fim do vídeo', () => {
  const wins = buildCandidateWindows({ events: [{ t: 2, z: 5, kind: 'audio', from: 2, to: 3 }, { t: 598, z: 5, kind: 'audio', from: 598, to: 599 }], duration: 600 });
  for (const w of wins) { assert.ok(w.from >= 0); assert.ok(w.to <= 600); assert.ok(w.to - w.from >= 45); }
});

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

const { windowsFromSuggestions, mergeWindows } = require('../src/core/analysis/candidates');

test('windowsFromSuggestions: 45 a 90 s com a premissa antes, as mais relevantes primeiro, até o orçamento de cobertura', () => {
  const sugs = [
    { start: 1000, end: 1030, relevance: 0.9 }, { start: 2000, end: 2025, relevance: 0.5 }, { start: 3000, end: 3040, relevance: 0.7 },
    { start: 4000, end: 4030, relevance: 0.3 }
  ];
  const all = windowsFromSuggestions(sugs, 7200, { maxCoverage: 1 });
  assert.equal(all.length, 4);
  for (const w of all) { assert.ok(w.to - w.from >= 45 && w.to - w.from <= 90, `len ${w.to - w.from}`); assert.deepEqual(w.kinds, ['algorithm']); }
  assert.deepEqual(all.map((w) => w.id), ['w1', 'w2', 'w3', 'w4'], 'em ordem de tempo, ids novos');
  const first = all[0];
  assert.ok(first.from < 1000 && first.to > 1030, 'a janela envolve a sugestão');
  assert.ok(1000 - first.from > first.to - 1030, 'mais folga antes (a premissa) do que depois');
  // orçamento de 2% de 7200 s = 144 s de janela + contexto: cabe só a de maior relevância (e uma segunda não)
  const tight = windowsFromSuggestions(sugs, 7200, { maxCoverage: 0.02 });
  assert.equal(tight.length, 1);
  assert.ok(tight[0].from < 1000 && tight[0].to > 1030, 'ficou a mais relevante (0,9)');
});

test('windowsFromSuggestions: sugestão dentro de janela já escolhida não vira outra; bordas do vídeo; entrada ruim não quebra', () => {
  const near = windowsFromSuggestions([{ start: 500, end: 530, relevance: 0.9 }, { start: 505, end: 533, relevance: 0.8 }], 3600, { maxCoverage: 1 });
  assert.equal(near.length, 1);
  const edge = windowsFromSuggestions([{ start: 2, end: 20, relevance: 1 }, { start: 3590, end: 3599, relevance: 1 }], 3600, { maxCoverage: 1 });
  for (const w of edge) { assert.ok(w.from >= 0 && w.to <= 3600 && w.to - w.from >= 45); }
  assert.deepEqual(windowsFromSuggestions(null, 100), []);
  assert.deepEqual(windowsFromSuggestions([{ start: 'x' }, null, { start: 5, end: 4 }], 100), []);
});

test('mergeWindows: a primeira fonte fica inteira; a segunda só entra sem encostar e dentro do que sobra do orçamento', () => {
  const primary = [{ id: 'a', from: 100, to: 160, score: 1 }];
  const secondary = [
    { id: 'b', from: 150, to: 200, score: 5 }, // encosta na primeira: fora
    { id: 'c', from: 1000, to: 1060, score: 2 },
    { id: 'd', from: 2000, to: 2060, score: 3 }
  ];
  const full = mergeWindows(primary, secondary, 7200, { maxCoverage: 1 });
  assert.deepEqual(full.map((w) => [w.from, w.to]), [[100, 160], [1000, 1060], [2000, 2060]]);
  assert.deepEqual(full.map((w) => w.id), ['w1', 'w2', 'w3']);
  // orçamento para a primeira (90 s com contexto) e mais UMA (60 + 30): a de maior pontuação (d) ganha
  const tight = mergeWindows(primary, secondary, 1000, { maxCoverage: 0.18 });
  assert.deepEqual(tight.map((w) => w.from), [100, 2000]);
});

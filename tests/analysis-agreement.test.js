'use strict';

/**
 * Regras de 16/11/2026 (docs/recursos/analysis.md, "Concordância das pistas, risada do chat e fim do corte"):
 *   - risada escrita num CHAT PEQUENO conta como reação ao que aconteceu segundos antes;
 *   - o corte termina DEPOIS da risada marcada na transcrição, não quando ela começa (combine.js, tailOut);
 *   - na QUANTIDADE AUTOMÁTICA (com o filtro valendo) a detecção fica um degrau mais sensível e uma pista sozinha não basta.
 * Sem ffmpeg: sinais sintéticos e análises só de texto.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const params = require('../src/core/analysis/params');
const { combine } = require('../src/core/analysis/combine');
const { scoreChat, LAUGH_ONE, REACT_BACK_MIN_SEC, REACT_BACK_MAX_SEC } = require('../src/core/analysis/chatSignal');
const { analyzeSource, agreementOf, corroborated } = require('../src/core/analysis/analyze');

test('concordância: conta as FAMÍLIAS de pista (voz, chat, volume, ritmo da fala); imagem e momento calmo não contam', () => {
  assert.equal(agreementOf([]), 0);
  assert.equal(agreementOf(['image:scene', 'image:motion', 'calm:calm']), 0);
  assert.equal(agreementOf(['text:exclaim', 'text:laugh', 'text:meta']), 1, 'três reações de voz são uma família só');
  assert.equal(agreementOf(['text:exclaim', 'audio:level', 'audio:rise']), 2);
  assert.equal(agreementOf(['text:laugh', 'chat:laugh', 'audio:rise', 'text:pace', 'image:scene']), 4);
  assert.equal(corroborated(['text:exclaim', 'image:scene']), false, 'uma pista só');
  assert.equal(corroborated(['text:exclaim', 'audio:level']), true, 'duas famílias');
  assert.equal(corroborated(['text:laugh', 'text:meta']), true, 'duas reações de voz diferentes também se confirmam');
});

test('chat pequeno: a risada escrita pontua os segundos ANTES dela; duas somam; chat grande não usa a regra', () => {
  const P = params.normalizeParams({});
  const th = params.thresholds(3);
  const n = 3600;
  const quiet = [];
  for (let t = 20; t < 3600; t += 90) quiet.push({ t, text: 'boa noite' }); // 40 mensagens numa hora: chat pequeno
  const one = scoreChat({ messages: [...quiet, { t: 1000.4, text: 'KKKKK coitado' }] }, { n, th, params: P });
  assert.equal(one.stats.small, true);
  assert.equal(one.stats.laughMessages, 1);
  assert.equal(one.score[1000 - REACT_BACK_MAX_SEC - 1], 0, 'antes da janela da reação');
  assert.ok(Math.abs(one.score[1000 - REACT_BACK_MAX_SEC] - LAUGH_ONE) < 1e-9);
  assert.ok(Math.abs(one.score[1000 - REACT_BACK_MIN_SEC] - LAUGH_ONE) < 1e-9);
  assert.equal(one.score[1000 - REACT_BACK_MIN_SEC + 1], 0, 'a mensagem chega depois do lance, não junto');
  assert.deepEqual(one.describe(960, 985).map((d) => [d.kind, d.text]), [['laugh', 'o chat riu']]);
  assert.deepEqual(one.describe(500, 530), [], 'longe da risada, nada');

  const two = scoreChat({ messages: [...quiet, { t: 1000, text: 'kkkkkkkk' }, { t: 1012, text: 'hahaha não acredito' }] }, { n, th, params: P });
  assert.ok(two.score[980] > LAUGH_ONE + 0.2, 'duas risadas somam');
  assert.deepEqual(two.describe(960, 985).map((d) => d.text), ['o chat riu (2 mensagens)']);
  for (const text of ['rsrsrs', 'KAKAKAK que isso', 'lol', 'huehue', '\u{1F602}\u{1F602}']) {
    const s = scoreChat({ messages: [...quiet, { t: 2000, text }] }, { n, th, params: P });
    assert.equal(s.stats.laughMessages, 1, text);
  }
  for (const text of ['ok', 'kk', 'ha', 'como assim?', 'clr mó bom']) {
    const s = scoreChat({ messages: [...quiet, { t: 2000, text }] }, { n, th, params: P });
    assert.equal(s.stats.laughMessages, 0, text);
  }

  const busy = [];
  for (let t = 0; t < 3600; t += 4) busy.push({ t, text: t === 1000 ? 'kkkkkk' : 'gg' }); // 900 mensagens numa hora: não é chat pequeno
  const big = scoreChat({ messages: busy }, { n, th, params: P });
  assert.equal(big.stats.small, false);
  assert.equal(big.stats.laughMessages, 0);
  assert.equal(big.describe(960, 985).filter((d) => d.kind === 'laugh').length, 0);
});

/** Sinal sintético com um pico. */
function sig(id, at, h, n = 600) {
  const score = new Float64Array(n);
  for (let k = at - 3; k <= at + 3; k += 1) score[k] = h * (1 - Math.abs(k - at) / 4);
  return { id, score, describe: () => [{ kind: 'laugh', text: 'risada', strength: 1 }] };
}

test('combine: com a reação marcada depois do pico, o fim do corte vai até o fim dela (sem passar da duração máxima nem do espaço livre)', () => {
  const P = params.normalizeParams({ maxSuggestions: 3, weights: { text: 1 }, minDurationSec: 15, maxDurationSec: 60 });
  const signals = [sig('text', 100, 0.9)];
  const plain = combine({ n: 600, duration: 600, signals, params: P })[0];
  assert.ok(plain.end < 112, `sem a regra o corte acaba perto do pico (${plain.end})`);

  const active = new Uint8Array(600);
  for (let k = 104; k < 126; k += 1) if (k % 5 !== 0) active[k] = 1; // risada de 104 a 126 s, com buracos curtos
  const tail = combine({ n: 600, duration: 600, signals, params: P, tailOut: { active, maxSec: 30, gapSec: 4 } })[0];
  assert.ok(tail.end >= 126 && tail.end <= 130, `o fim cobre a risada (${tail.end})`);
  assert.ok(tail.start <= plain.start + 0.01, 'o começo não muda');

  // risada longa demais: só até maxSec além do fim que o corte teria
  const long = new Uint8Array(600);
  for (let k = 104; k < 300; k += 1) long[k] = 1;
  const capped = combine({ n: 600, duration: 600, signals, params: P, tailOut: { active: long, maxSec: 30, gapSec: 4 } })[0];
  assert.ok(capped.end <= plain.end + 30 + P.padAfterSec + 1, `no máximo 30 s a mais (${capped.end})`);
  assert.ok(capped.end - capped.start <= P.maxDurationSec + 1e-9, 'e a duração máxima vale');
  assert.ok(capped.start <= 100, 'o corte continua contendo o pico');

  // reação que começa só bem depois do fim (buraco maior que gapSec): não é deste corte
  const far = new Uint8Array(600);
  for (let k = 125; k < 140; k += 1) far[k] = 1;
  const same = combine({ n: 600, duration: 600, signals, params: P, tailOut: { active: far, maxSec: 30, gapSec: 4 } })[0];
  assert.equal(same.end, plain.end);
});

/** Uma hora de conversa calma com: exclamações em fala rápida (500 s), uma exclamação solta (1500 s) e uma risada longa (2500 s). */
function hour() {
  const calm = ['a gente estava falando sobre o mapa novo', 'tinha bastante coisa para fazer naquela parte', 'depois a gente volta para conferir o resto'];
  const cues = [];
  for (let t = 0; t < 3600; t += 6) cues.push({ start: t, end: t + 5, text: `${calm[(t / 6) % 3]}.` });
  for (let t = 500; t < 520; t += 2) cues.push({ start: t, end: t + 1.8, text: 'Nossa! Não acredito! Que isso!' });
  cues.push({ start: 1500.2, end: 1501.5, text: 'Nossa senhora! Que absurdo!' }, { start: 1502, end: 1503, text: 'Caramba!' });
  cues.push({ start: 2496.2, end: 2499, text: 'olha o que ele fez agora, não acredito!' });
  for (let t = 2500; t < 2520; t += 2) cues.push({ start: t, end: t + 1.9, text: '*Risos*', laugh: true });
  cues.push({ start: 2524.2, end: 2527, text: 'acabamos com a brincadeira deles.' });
  for (let i = 0; i < 40; i += 1) { const t = 30 + i * 85; if ([500, 1500, 2500].every((x) => Math.abs(t - x) > 90)) cues.push({ start: t + 5.2, end: t + 5.9, text: 'Boa!' }); }
  return cues.sort((a, b) => a.start - b.start);
}

test('análise: o corte da risada termina depois dela; na quantidade automática a detecção sobe um degrau e a pista sozinha é descartada', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-agree-'));
  const file = path.join(tmp, 'live.mp4');
  fs.writeFileSync(file, 'só texto');
  try {
    const deps = { ffmpeg: path.join(tmp, 'sem-ffmpeg.exe'), cacheDir: path.join(tmp, 'cache') };
    const run = (extra) => analyzeSource({
      file, duration: 3600, hasAudio: false, transcript: { cues: hour() },
      params: { signals: { audio: false, image: false, chat: false, calm: false, text: true }, sensitivity: 3, ...extra }
    }, deps);
    const at = (r, t) => r.suggestions.find((s) => s.start <= t && s.end >= t);

    const fixed = await run({});
    assert.equal(fixed.filter.on, true);
    assert.ok(!('autoSensitivity' in fixed.filter), 'na quantidade fixa a sensibilidade é a escolhida');
    const laugh = at(fixed, 2497);
    assert.ok(laugh, 'a risada longa vira sugestão');
    assert.ok(laugh.end >= 2520, `e o corte termina depois da risada (${laugh.end}), não quando ela começa`);
    assert.ok(at(fixed, 1501), 'na quantidade fixa a exclamação solta fica');
    assert.equal(at(fixed, 1501).agreement, 1);
    assert.equal(at(fixed, 505).agreement, 2, 'exclamações em fala rápida: voz e ritmo');

    const auto = await run({ autoQuantity: true });
    assert.equal(auto.filter.autoSensitivity, 4, 'um degrau acima da sensibilidade escolhida');
    assert.ok(at(auto, 505), 'duas famílias: fica');
    assert.ok(at(auto, 2497), 'risada e fala sobre o momento: duas reações de voz, fica');
    assert.ok(!at(auto, 1501), 'uma pista só: sai');
    assert.ok(auto.filtered.some((f) => f.start <= 1501 && f.end >= 1501 && f.why === 'uma pista só (sem outra que confirme)'));

    const noFilter = await run({ autoQuantity: true, filterWeak: false });
    assert.ok(!('autoSensitivity' in noFilter.filter), 'sem o filtro, a quantidade automática não mexe na sensibilidade');
    assert.ok(at(noFilter, 1501), 'nem descarta a pista sozinha');
    const top = await run({ autoQuantity: true, sensitivity: 5 });
    assert.ok(!('autoSensitivity' in top.filter), 'na sensibilidade máxima não há degrau acima');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('risada longa: a evidência leva também "laughrun" e se confirma sozinha na quantidade automática; a risada solta não', async () => {
  assert.equal(corroborated(['text:laugh', 'image:scene']), false, 'risada solta: uma pista só');
  assert.equal(corroborated(['text:laugh', 'text:laughrun', 'image:scene']), true, 'crise de riso: confirma sozinha');
  assert.equal(agreementOf(['text:laugh', 'text:laughrun']), 1, 'continua sendo uma família (voz)');

  // combine: um motivo pode trazer tipos extras (`also`), que entram na evidência
  const P = params.normalizeParams({ maxSuggestions: 1, weights: { text: 1 } });
  const score = new Float64Array(600);
  for (let k = 97; k <= 103; k += 1) score[k] = 0.9 * (1 - Math.abs(k - 100) / 4);
  const s = combine({ n: 600, duration: 600, params: P, signals: [{ id: 'text', score, describe: () => [{ kind: 'laugh', text: 'risadas', strength: 1, also: ['laughrun'] }] }] })[0];
  assert.deepEqual(s.evidence, ['text:laugh', 'text:laughrun']);
  assert.deepEqual(s.reasons, ['risadas'], 'o motivo aparece uma vez só');

  // análise só de texto: conversa calma, uma risada longa (1000 s) e uma risada solta (2000 s), sem nenhuma outra reação por perto
  const calm = ['a gente estava falando sobre o mapa novo', 'tinha bastante coisa para fazer naquela parte', 'depois a gente volta para conferir o resto'];
  const cues = [];
  for (let t = 0; t < 3600; t += 6) cues.push({ start: t, end: t + 5, text: `${calm[(t / 6) % 3]}.` });
  for (let t = 1000; t < 1020; t += 2) cues.push({ start: t + 5.1, end: t + 5.9, text: '*Risos*', laugh: true });
  cues.push({ start: 2005.1, end: 2005.9, text: '*Risos*', laugh: true });
  for (let i = 0; i < 40; i += 1) { const t = 30 + i * 85; if ([1000, 2000].every((x) => Math.abs(t - x) > 90)) cues.push({ start: t + 5.2, end: t + 5.9, text: 'Boa!' }); }
  cues.sort((a, b) => a.start - b.start);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-laugh-'));
  const file = path.join(tmp, 'live.mp4');
  fs.writeFileSync(file, 'só texto');
  try {
    const r = await analyzeSource({
      file, duration: 3600, hasAudio: false, transcript: { cues },
      params: { signals: { audio: false, image: false, chat: false, calm: false, text: true }, sensitivity: 3, autoQuantity: true }
    }, { ffmpeg: path.join(tmp, 'sem-ffmpeg.exe'), cacheDir: path.join(tmp, 'cache') });
    const long = r.suggestions.find((x) => x.start <= 1004 && x.end >= 1004);
    assert.ok(long, 'a risada longa fica, mesmo sem outra pista');
    assert.ok(long.evidence.includes('text:laughrun'));
    assert.ok(long.end >= 1024, `e o corte cobre a risada (${long.end})`);
    assert.ok(!r.suggestions.some((x) => x.start <= 2004 && x.end >= 2004), 'a risada solta sai');
    assert.ok(r.filtered.some((f) => f.start <= 2004 && f.end >= 2004 && /uma pista só/.test(f.why)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

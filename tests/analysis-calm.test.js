'use strict';

/**
 * O sinal de MOMENTO CALMO (src/core/analysis/calmSignal.js): trechos tranquilos, sem fala e sem pico, mas vivos (o som e a imagem continuam).
 * Puro, com séries sintéticas (o jogador que só constrói, a cena de história com música baixa, contra a fala animada da live), e com mídia
 * sintética de verdade (ffmpeg): o trecho calmo sai como sugestão e o que NÃO é calmo (pausa muda, tela parada, alguém falando, pico) não.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tools, skipMedia, mkTmp, rmrf, makeMedia } = require('./analysis-fixtures');
const { scoreCalm } = require('../src/core/analysis/calmSignal');
const { thresholds, normalizeParams } = require('../src/core/analysis/params');
const { combine } = require('../src/core/analysis/combine');
const { analyzeSource } = require('../src/core/analysis/analyze');

const N = 300; // segundos
const th = thresholds(3);

/** Volume por janela de 0,5 s: `loud` dB na maior parte (com uma ondulação), `quiet` dB nos trechos [de, até) em segundos. */
function audioSeries({ loud = -22, quiet = -48, calm = [[120, 170]], blips = [], mute = [] } = {}) {
  const db = [];
  for (let i = 0; i < N * 2; i += 1) {
    const t = i / 2;
    let level = loud + 3 * Math.sin(i * 0.7);
    if (calm.some(([a, b]) => t >= a && t < b)) level = quiet + 2 * Math.sin(i * 0.9);
    if (mute.some(([a, b]) => t >= a && t < b)) level = -100;
    if (blips.some(([a, d = 1]) => t >= a && t < a + d)) level = -10;
    db.push(Math.round(level * 100) / 100);
  }
  return { db, windowSec: 0.5 };
}
const motionSeries = (value = 4, frozen = []) => ({ seconds: N, motion: Array.from({ length: N }, (_, k) => (frozen.some(([a, b]) => k >= a && k < b) ? 0 : value)), scene: Array(N).fill(0) });
const score = (extracted, opts = {}) => scoreCalm(extracted, { n: N, th, ...opts });
const hot = (s, a, b) => { for (let k = a; k < b; k += 1) if (!(s.score[k] >= 0.5)) return false; return true; };
const cold = (s, a, b) => { for (let k = a; k < b; k += 1) if (s.score[k] !== 0) return false; return true; };

test('um trecho de som baixo e contínuo no meio da fala animada é calmo; o resto da live não', () => {
  const s = score({ audio: audioSeries(), image: motionSeries() });
  assert.equal(s.id, 'calm');
  assert.ok(hot(s, 130, 160), 'o miolo do trecho calmo pontua');
  assert.ok(cold(s, 0, 100) && cold(s, 190, N), 'a live normal não pontua');
  assert.ok(Math.max(...s.score) <= 0.97, 'a pontuação é logística: nunca chega a 1,0');
  assert.ok(s.stats.calmSeconds >= 30);
});

test('descreve o motivo com a queda em dB e, com transcrição, diz "sem fala"', () => {
  const noText = score({ audio: audioSeries(), image: motionSeries() }).describe(130, 160);
  assert.equal(noText.length, 1);
  assert.match(noText[0].text, /^momento calmo: som baixo e contínuo, sem picos \(2\d dB abaixo do normal\)$/);
  const withText = score({ audio: audioSeries(), image: motionSeries() }, { cues: [{ start: 10, end: 20 }] }).describe(130, 160);
  assert.match(withText[0].text, /sem picos, sem fala \(/);
  assert.deepEqual(score({ audio: audioSeries(), image: motionSeries() }).describe(0, 50), []);
});

test('pausa muda, microfone e jogo mudos (som quase nenhum) NÃO são momento calmo: precisa de som', () => {
  const s = score({ audio: audioSeries({ mute: [[100, 200]], calm: [] }), image: motionSeries() });
  assert.ok(cold(s, 110, 190), 'silêncio digital não é clima');
  const quieter = score({ audio: audioSeries({ quiet: -80, calm: [[120, 170]] }), image: motionSeries() });
  assert.ok(cold(quieter, 130, 160), 'som abaixo do piso de ruído também não');
});

test('tela parada (pausa, menu, carregamento) não é calma, mesmo com música baixa; com imagem em movimento é', () => {
  const frozen = score({ audio: audioSeries(), image: motionSeries(4, [[110, 180]]) });
  assert.ok(cold(frozen, 125, 165));
  const moving = score({ audio: audioSeries(), image: motionSeries(4) });
  assert.ok(hot(moving, 130, 160));
  const noImage = score({ audio: audioSeries(), image: null });
  assert.ok(hot(noImage, 130, 160), 'sem o sinal de imagem o volume decide sozinho');
});

test('um estouro de verdade (3 s) no meio do trecho tira o trecho (o calmo não tem pico), e só a vizinhança; um estalo de 1 s não', () => {
  const s = score({ audio: audioSeries({ blips: [[145, 3]] }), image: motionSeries() });
  assert.ok(cold(s, 142, 150), 'a janela do estouro não é calma');
  assert.ok(hot(s, 125, 132), 'o começo do trecho, longe do estouro, continua');
  const click = score({ audio: audioSeries({ blips: [[145, 1]] }), image: motionSeries() });
  assert.ok(hot(click, 135, 155), 'um estalo isolado (menos de 10% da janela) não desclassifica');
});

test('com transcrição, quem fala (20% ou mais da janela) não é momento calmo; sem fala continua', () => {
  const talking = [{ start: 118, end: 135 }, { start: 140, end: 165 }];
  const withSpeech = score({ audio: audioSeries(), image: motionSeries() }, { cues: talking });
  assert.ok(cold(withSpeech, 130, 160), 'a fala (mesmo baixa) desclassifica');
  const aside = score({ audio: audioSeries(), image: motionSeries() }, { cues: [{ start: 10, end: 30 }] });
  assert.ok(hot(aside, 130, 160), 'fala em outro ponto do vídeo não atrapalha');
  const brief = score({ audio: audioSeries(), image: motionSeries() }, { cues: [{ start: 140, end: 142 }] });
  assert.ok(hot(brief, 130, 160), 'uma frase curta (menos de 20% da janela) não desclassifica');
});

test('a sensibilidade muda quanto abaixo do normal o trecho precisa estar', () => {
  const extracted = { audio: audioSeries({ quiet: -30, calm: [[120, 170]] }), image: motionSeries() }; // só 8 dB abaixo do normal
  const strict = scoreCalm(extracted, { n: N, th: thresholds(1) });
  const lax = scoreCalm(extracted, { n: N, th: thresholds(5) });
  assert.ok(cold(strict, 130, 160) || Math.max(...strict.score.slice(130, 160)) < 0.5, 'sensibilidade 1: 8 dB não bastam');
  assert.ok(Math.max(...lax.score.slice(130, 160)) > Math.max(...strict.score.slice(130, 160)), 'sensibilidade 5 pontua mais o mesmo trecho');
});

test('vídeo todo no mesmo nível: nada é "calmo perto do resto"', () => {
  const s = score({ audio: audioSeries({ calm: [] }), image: motionSeries() });
  assert.ok(cold(s, 0, N));
  assert.equal(s.stats.calmSeconds, 0);
});

test('na combinação o calmo vira sugestão com o motivo, pesa menos que os outros sinais e respeita o peso 0', () => {
  const params = normalizeParams({ minDurationSec: 15, maxDurationSec: 60, padBeforeSec: 3, padAfterSec: 2 });
  const s = score({ audio: audioSeries(), image: motionSeries() });
  const out = combine({ n: N, duration: N, signals: [s], params });
  assert.equal(out.length, 1);
  assert.ok(out[0].start <= 135 && out[0].end >= 155, `cobre o trecho (${out[0].start}-${out[0].end})`);
  assert.match(out[0].reasons[0], /^momento calmo/);
  assert.ok(out[0].relevance <= 0.7 * 0.97 + 1e-9, `peso 0,7: no máximo ${(0.7 * 0.97).toFixed(2)} (veio ${out[0].relevance})`);
  assert.deepEqual(out[0].signals, { calm: out[0].signals.calm });
  const off = combine({ n: N, duration: N, signals: [s], params: normalizeParams({ weights: { calm: 0 } }) });
  assert.deepEqual(off, [], 'peso 0 desliga');
  const strictParams = normalizeParams({ minRelevance: 0.9 });
  assert.deepEqual(combine({ n: N, duration: N, signals: [s], params: strictParams }), [], 'o calmo sozinho nunca passa de uma relevância alta');
});

// ------------------------------------------------------------------ com mídia de verdade (ffmpeg)

const T = { skip: skipMedia };
let tmp;
const files = {};
let seq = 0;

test.before(() => {
  if (skipMedia) return;
  tmp = mkTmp('analysis-calm');
  // 120 s: fundo a -30 dB (a "fala" da live); de 50 a 90 s só um som baixo (-52 dB) e a imagem se mexendo o tempo todo
  const loudQuiet = { baseDb: -30, bursts: [{ at: 50, dur: 40, db: -52 }] };
  files.calm = makeMedia(path.join(tmp, 'calm.mp4'), { seconds: 120, audio: loudQuiet, motion: true });
  // o mesmo som, mas a imagem parada (uma pausa)
  files.frozen = makeMedia(path.join(tmp, 'frozen.mp4'), { seconds: 120, audio: loudQuiet, luma: { base: 60 } });
  // tudo no mesmo nível: nada calmo
  files.flat = makeMedia(path.join(tmp, 'flat.mp4'), { seconds: 120, audio: { baseDb: -30 }, motion: true });
});

test.after(() => { if (tmp) rmrf(tmp); });

const run = (file, { params = {}, transcript = null } = {}) => analyzeSource(
  { file, duration: 120, hasAudio: true, params, chatPath: null, transcript },
  { ffmpeg: tools.ffmpeg, cacheDir: path.join(tmp, `cache-${seq++}`) }
);
const calmOf = (r) => r.suggestions.find((x) => x.reasons.some((t) => t.startsWith('momento calmo')));

test('mídia: o trecho de som baixo e imagem viva vira sugestão "momento calmo" e o sinal aparece como usado', T, async () => {
  const r = await run(files.calm, { params: { signals: { chat: false } } });
  assert.ok(r.usedSignals.includes('calm'));
  assert.equal(r.signals.calm.used, true);
  assert.ok(r.signals.calm.calmSeconds >= 20);
  const s = calmOf(r);
  assert.ok(s, `esperava uma sugestão calma: ${JSON.stringify(r.suggestions.map((x) => [x.start, x.end, x.reasons]))}`);
  assert.ok(s.start <= 62 && s.end >= 78, `cobre o miolo do trecho (${s.start}-${s.end})`);
  assert.ok(s.start >= 40 && s.end <= 100, `e não passa muito dele (${s.start}-${s.end})`);
});

test('mídia: com a imagem parada, sem calma; tudo no mesmo nível, sem calma; calmo desligado, sem calma e dizendo "desligado"', T, async () => {
  assert.equal(calmOf(await run(files.frozen, { params: { signals: { chat: false } } })), undefined, 'pausa não é calma');
  assert.equal(calmOf(await run(files.flat, { params: { signals: { chat: false } } })), undefined, 'nada se destaca por ser calmo');
  const off = await run(files.calm, { params: { signals: { chat: false, calm: false } } });
  assert.equal(calmOf(off), undefined);
  assert.deepEqual([off.signals.calm.used, off.signals.calm.reason], [false, 'desligado']);
  assert.ok(!off.usedSignals.includes('calm'));
});

test('mídia: com transcrição de alguém falando durante o trecho, ele deixa de ser calmo', T, async () => {
  const cues = Array.from({ length: 8 }, (_, i) => ({ start: 50 + i * 5, end: 53 + i * 5, text: 'conversa' }));
  const r = await run(files.calm, { params: { signals: { chat: false } }, transcript: { cues } });
  assert.equal(calmOf(r), undefined, 'a conversa desclassifica o trecho');
});

test('mídia: sem o sinal de áudio o calmo não roda e diz o motivo', T, async () => {
  const r = await run(files.calm, { params: { signals: { audio: false, chat: false } } });
  assert.equal(r.signals.calm.used, false);
  assert.equal(r.signals.calm.reason, 'precisa do áudio');
});

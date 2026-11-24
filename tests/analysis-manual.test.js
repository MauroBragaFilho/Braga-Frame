'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { snapWordsToFrames, exactFps, frameOf, timeOfFrame } = require('../src/core/analysis/wordGrid');
const { buildWordList, splitParts, buildManualPrompt, parseManualResponse, formatTranscript } = require('../src/core/analysis/ai/manual');
const { buildDocument } = require('../src/core/analysis/transcript/format');

const PREFS = { minDurationSec: 5, maxDurationSec: 60, padBeforeSec: 0, padAfterSec: 0, minRelevance: 0, profile: 'conversa' };

/** Transcrição de 40 s: uma frase de 4 palavras por segundo e meio, com palavras de 0,3 s. */
function fixture() {
  const words = [];
  const cues = [];
  let t = 1;
  for (let c = 0; c < 20; c += 1) {
    const text = ['isso', 'foi', `incrivel${c}`, 'mesmo'];
    const start = t;
    text.forEach((w) => { words.push([t, t + 0.3, w]); t += 0.31; });
    cues.push({ start, end: t, text: text.join(' ') });
    t += 1;
  }
  return { words, cues, duration: Math.ceil(t) + 1 };
}

test('exactFps: 29,97 e 23,976 viram as frações exatas; inválido vira 0', () => {
  assert.ok(Math.abs(exactFps(29.97) - 30000 / 1001) < 1e-9);
  assert.ok(Math.abs(exactFps(23.98) - 24000 / 1001) < 1e-9);
  assert.equal(exactFps(60), 60);
  assert.equal(exactFps(0), 0);
  assert.equal(exactFps('x'), 0);
});

test('snapWordsToFrames: tempos em quadros exatos, em ordem, sem sobreposição e com um quadro no mínimo', () => {
  const out = snapWordsToFrames([[0.01, 0.52, 'a'], [0.5, 0.51, 'b'], [0.5, 1.0, 'c']], 30);
  assert.deepEqual(out.map((w) => [w.startFrame, w.endFrame]), [[0, 16], [16, 17], [17, 30]]);
  for (let i = 1; i < out.length; i += 1) assert.ok(out[i].start >= out[i - 1].end);
  assert.equal(out[0].start, 0);
  assert.equal(frameOf(out[2].start, 30), 17);
  assert.equal(timeOfFrame(30, 30), 1);
});

test('snapWordsToFrames sem fps válido só normaliza (sem quadros)', () => {
  const out = snapWordsToFrames([[1, 2, 'x']], 0);
  assert.equal(out[0].startFrame, null);
  assert.equal(out[0].start, 1);
});

test('o documento guarda o fps e as palavras já na grade de quadros', () => {
  const { words, cues, duration } = fixture();
  const doc = buildDocument({ projectId: 'p1', origin: 'generated', source: { path: 'a.mp4', size: 1, duration }, cues, words, fps: 29.97 });
  assert.equal(doc.fps, 29.97);
  const f = 30000 / 1001;
  for (const [s, e] of doc.words) {
    assert.ok(Math.abs(s * f - Math.round(s * f)) < 0.02, `início ${s} fora da grade`);
    assert.ok(e > s);
  }
  const plain = buildDocument({ projectId: 'p1', origin: 'generated', source: { path: 'a.mp4', size: 1, duration }, cues, words });
  assert.equal(plain.fps, undefined);
});

test('buildWordList: IDs de 1 em diante; transcrição importada reparte o tempo da fala (approx)', () => {
  const { words, cues } = fixture();
  const real = buildWordList({ words, cues }, 30);
  assert.equal(real.approx, false);
  assert.equal(real.words[0].id, 1);
  assert.equal(real.words.at(-1).id, words.length);
  const imported = buildWordList({ cues: [{ start: 10, end: 14, text: 'uma fala curta aqui' }, { start: 20, end: 21, text: '*Risos*', laugh: true }] }, 30);
  assert.equal(imported.approx, true);
  assert.equal(imported.words.length, 4);
  assert.ok(imported.words[0].start >= 10 && imported.words.at(-1).end <= 14.1);
});

test('splitParts e o pedido: cada parte traz só os seus IDs e o formato pedido', () => {
  const { words, cues, duration } = fixture();
  const list = buildWordList({ words, cues }, 30).words;
  const parts = splitParts(list, 300);
  assert.equal(parts.length, 1); // 80 palavras cabem numa parte (o mínimo é 300)
  const req = buildManualPrompt({ part: parts[0], parts: 1, meta: { title: 'Teste' }, duration, prefs: PREFS });
  assert.equal(req.firstId, 1);
  assert.equal(req.lastId, 80);
  assert.match(req.text, /start_id/);
  assert.match(req.text, /1:isso 2:foi 3:incrivel0 4:mesmo/);
  assert.match(req.text, /NÃO escreva horários/);
  assert.ok(req.tokens > 100);
  const big = splitParts(Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, start: i, end: i + 0.5, text: 'x' })), 300);
  assert.equal(big.reduce((n, p) => n + p.words.length, 0), 1000);
  assert.ok(big.length >= 3);
});

function ctxOf() {
  const { words, cues, duration } = fixture();
  return { words: buildWordList({ words, cues }, 30).words, cues, duration, fps: 30, prefs: PREFS };
}

test('parseManualResponse: o horário vem das palavras (nunca da IA) e cai num quadro exato', () => {
  const ctx = ctxOf();
  const w = ctx.words;
  const reply = '```json\n' + JSON.stringify({ cuts: [{ start_id: 9, end_id: 28, title: 'Momento bom', category: 'Engraçado', relevance: 0.9, reasons: ['piada'], keywords: ['isso'], start: '99:99', end: '0:00' }] }) + '\n```';
  const out = parseManualResponse(`Claro! Aqui está:\n${reply}\nEspero ter ajudado.`, ctx);
  assert.equal(out.received, 1);
  assert.equal(out.suggestions.length, 1, JSON.stringify(out.dropped));
  const s = out.suggestions[0];
  assert.ok(s.start <= w[8].start + 0.001 && s.start >= w[8].start - 0.5);
  assert.ok(s.end >= w[27].end - 0.001);
  assert.equal(s.title, 'Momento bom');
  assert.ok(Math.abs(s.start * 30 - Math.round(s.start * 30)) < 0.02);
  assert.ok(Math.abs(s.end * 30 - Math.round(s.end * 30)) < 0.02);
});

test('parseManualResponse: ID inexistente, intervalo invertido, sem IDs e curto demais voltam com o motivo', () => {
  const ctx = ctxOf();
  const out = parseManualResponse(JSON.stringify({ cuts: [
    { start_id: 1, end_id: 9999, title: 'a' },
    { start_id: 30, end_id: 10, title: 'b' },
    { title: 'c' },
    { start_id: 5, end_id: 6, title: 'd' }
  ] }), ctx);
  assert.equal(out.suggestions.length, 0);
  assert.deepEqual(out.dropped.map((d) => d.reason), ['id', 'id', 'format', 'time']);
});

test('parseManualResponse: aceita IDs como texto, lista solta, e repetição vira um corte só', () => {
  const ctx = ctxOf();
  const item = { start_id: 'w9', end_id: '28', title: 'x', relevance: '80%' };
  const out = parseManualResponse(JSON.stringify([item, { ...item, title: 'repetido', relevance: 0.1 }]), ctx);
  assert.equal(out.suggestions.length, 1);
  assert.equal(out.suggestions[0].relevance, 0.8);
  assert.equal(out.dropped.at(-1).reason, 'duplicate');
});

test('parseManualResponse: texto sem JSON lança BAD_JSON e corte existente é recusado', () => {
  const ctx = ctxOf();
  assert.throws(() => parseManualResponse('não sei', ctx), (e) => e.code === 'BAD_JSON');
  const reply = JSON.stringify({ cuts: [{ start_id: 9, end_id: 28, title: 'x' }] });
  const out = parseManualResponse(reply, { ...ctx, existing: [{ start: ctx.words[8].start, end: ctx.words[27].end }] });
  assert.equal(out.suggestions.length, 0);
  assert.equal(out.dropped[0].reason, 'existing');
});

test('formatTranscript: uma fala por linha com o tempo', () => {
  assert.equal(formatTranscript({ cues: [{ start: 3, end: 5, text: 'oi' }, { start: 75.5, end: 80, text: 'tchau' }] }), '[0:03] oi\n[1:16] tchau');
});

test('resposta copiada de um chat renderizado (barra no fim da linha, &#x20; e aspas com barra dupla) é lida', () => {
  const { cleanPasted } = require('../src/core/analysis/ai/manual');
  const ctx = ctxOf();
  const obj = { cuts: [
    { start_id: 9, end_id: 28, title: 'Descobriu a arma e se arrependeu', category: 'Engraçado', relevance: 0.91, reasons: ['O desfecho é a rejeição: "Lança-granadas, não gostei."', 'segundo motivo'], keywords: ['arma', 'FPS'], layout: 'jogo' },
    { start_id: 41, end_id: 70, title: 'Zoeira', category: 'Chat/zoeira', relevance: 0.88, reasons: ['piada'], keywords: ['zoeira'], layout: 'conversa' }
  ] };
  const BS = String.fromCharCode(92);
  const dirty = JSON.stringify(obj, null, 2).split('\n')
    .map((l) => l.replace(/^ +/, (m) => '&#x20;'.repeat(m.length)).split(BS + '"').join(BS + BS + '"') + BS)
    .join('\n');
  assert.ok(dirty.includes('&#x20;') && dirty.includes(BS + '\n') && dirty.includes(BS + BS + '"'), 'o texto de teste reproduz a sujeira');
  assert.throws(() => JSON.parse(dirty));
  const out = parseManualResponse(dirty, ctx);
  assert.equal(out.received, 2);
  assert.equal(out.suggestions.length, 2, JSON.stringify(out.dropped));
  assert.ok(out.suggestions[0].reasons[0].includes('"Lança-granadas, não gostei."'));
  assert.equal(out.suggestions[0].layout, 'jogo');
  // JSON limpo não muda
  const clean = JSON.stringify(obj);
  assert.equal(cleanPasted(clean), clean);
  assert.equal(parseManualResponse(clean, ctx).suggestions.length, 2);
  // aspas escapadas normais continuam valendo
  assert.equal(parseManualResponse(JSON.stringify({ cuts: [{ start_id: 9, end_id: 28, title: 'Ele disse "oi"' }] }), ctx).suggestions[0].title, 'Ele disse "oi"');
});

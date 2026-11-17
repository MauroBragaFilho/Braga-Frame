'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWords, packWords, snapToSpeech } = require('../src/core/analysis/words');

// "Eu vou tentar. | (pausa 1 s) | Olha isso aqui, gente! | (pausa 0,5 s) | Que loucura."
const W = normalizeWords([
  [10.0, 10.2, 'Eu'], [10.25, 10.5, 'vou'], [10.55, 11.0, 'tentar.'],
  [12.0, 12.3, 'Olha'], [12.35, 12.7, 'isso'], [12.75, 13.1, 'aqui,'], [13.15, 13.6, 'gente!'],
  [14.1, 14.4, 'Que'], [14.45, 15.2, 'loucura.']
]);

test('normalizeWords descarta lixo, ordena e packWords devolve a forma compacta', () => {
  const out = normalizeWords([[2, 3, 'b'], [1, 2, 'a'], ['x', 3, 'c'], [4, 5, ''], null, { start: 6, end: 5, text: 'd' }]);
  assert.deepEqual(out.map((w) => w.text), ['a', 'b', 'd']);
  assert.equal(out[2].end, 6);
  assert.deepEqual(packWords(out)[0], [1, 2, 'a']);
});

test('início no meio de uma palavra recua para a primeira palavra depois da pausa', () => {
  const r = snapToSpeech(12.5, 14.0, W); // meio de "isso": a frase começa em "Olha" (pausa de 1 s antes)
  assert.ok(r.movedStart);
  assert.ok(r.start <= 12.0 && r.start >= 11.0, `início ${r.start}`);
});

test('início no silêncio vai para a palavra seguinte (com folga de 0,1 s) sem entrar na palavra anterior', () => {
  const r = snapToSpeech(11.4, 13.6, W);
  assert.equal(r.start, 11.9);
});

test('início já em limite de pausa não anda além da folga', () => {
  const r = snapToSpeech(12.0, 13.6, W);
  assert.ok(Math.abs(r.start - 11.9) < 0.001);
});

test('fim no meio de uma palavra estende até o fim da frase + 200 ms', () => {
  const r = snapToSpeech(10.0, 12.9, W); // dentro de "aqui,": a frase acaba em "gente!"
  assert.ok(r.movedEnd);
  assert.equal(r.end, 13.8);
});

test('fim no silêncio depois da frase encosta no fim da última palavra + 200 ms', () => {
  const r = snapToSpeech(10.0, 13.95, W);
  assert.equal(r.end, 13.8);
});

test('o fim nunca invade a palavra seguinte', () => {
  const tight = normalizeWords([[1, 1.5, 'Acabou.'], [1.6, 2.0, 'Outra']]);
  const r = snapToSpeech(0.5, 1.3, tight);
  assert.ok(r.end <= 1.58 + 1e-9 && r.end >= 1.5, `fim ${r.end}`);
});

test('sem palavras os horários ficam como vieram', () => {
  const r = snapToSpeech(5, 9, []);
  assert.deepEqual([r.start, r.end, r.movedStart, r.movedEnd], [5, 9, false, false]);
});

test('frase que não termina perto: só não corta a palavra em andamento', () => {
  const run = normalizeWords(Array.from({ length: 30 }, (_, i) => [i * 0.5, i * 0.5 + 0.45, `p${i}`]));
  const r = snapToSpeech(5, 5.2, run, { maxMoveSec: 1 });
  assert.ok(r.end >= 5.2 && r.end - 5.2 < 1.1);
});

const { buildDocument, readDocument, summarize } = require('../src/core/analysis/transcript/format');
const { transcribeVideo } = require('../src/core/analysis/transcript/transcribe');
const { snapWithin } = require('../src/core/analysis/words');

test('a transcrição guarda as palavras, relê e informa hasWords; sem palavras o documento é o de antes', () => {
  const src = { path: 'C:/v.mp4', size: 1, duration: 60 };
  const cues = [{ start: 1, end: 3, text: 'olá mundo' }];
  const doc = buildDocument({ projectId: 'p', origin: 'generated', source: src, cues, dropped: {}, words: [[1, 1.5, 'olá'], [1.6, 2.2, 'mundo']] });
  assert.deepEqual(doc.words, [[1, 1.5, 'olá'], [1.6, 2.2, 'mundo']]);
  const back = readDocument(JSON.parse(JSON.stringify(doc)));
  assert.equal(back.words.length, 2);
  assert.equal(summarize(back, src).hasWords, true);
  const plain = buildDocument({ projectId: 'p', origin: 'imported', source: src, cues, dropped: {} });
  assert.equal('words' in plain, false);
  assert.equal(summarize(plain, src).hasWords, false);
});

test('transcribeVideo soma as palavras de cada pedaço no tempo do vídeo e as devolve em ordem', async () => {
  const generate = async () => ({ cues: [{ start: 1, end: 3, text: 'a b' }], words: [[1, 1.5, 'a'], [1.6, 2.2, 'b']], device: 'CPU', discarded: [] });
  const out = await transcribeVideo({ input: 'x', duration: 1200, genOptions: {}, chunkSec: 600, generate });
  assert.deepEqual(out.words.map((w) => [w.start, w.text]), [[1, 'a'], [1.6, 'b'], [601, 'a'], [601.6, 'b']]);
});

test('snapWithin respeita a duração: se esticar estoura o máximo, recua o fim para a frase anterior', () => {
  const ws = normalizeWords([[0, 1, 'um.'], [1.1, 2, 'dois'], [2.05, 3, 'três'], [3.05, 4, 'quatro.'], [4.05, 5, 'cinco']]);
  // fim em 2,5 (dentro de "três"): a frase só acaba em "quatro." (4,0); com máximo de 3,5 s a partir de 0 não cabe -> recua para o fim de "um." (+ folga)
  const r = snapWithin(0, 2.5, ws, { minSec: 0.5, maxSec: 3.5, duration: 60 });
  assert.ok(r.end - r.start <= 3.5 + 0.01 && r.end <= 1.1, `fim ${r.end}`);
  for (const w of ws) assert.ok(!(w.start + 1e-3 < r.end && r.end < w.end - 1e-3), `fim ${r.end} corta ${w.text}`);
});

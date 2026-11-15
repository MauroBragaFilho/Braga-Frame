'use strict';

/**
 * Transcrição do vídeo: importador de .srt/.vtt (UTF-8, BOM, UTF-16, Windows-1252, lixo, tamanho), normalização, marcas de risada,
 * repetições em laço, formato versionado, armazenamento (arquivo atômico, rascunho) e resumo. A geração com o Whisper de verdade está em
 * tests/analysis-transcribe.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('./ai-fakes');
const fmt = require('../src/core/analysis/transcript/format');
const { parseSubtitleBuffer, parseTime, SubtitleFileError } = require('../src/core/analysis/transcript/subtitleFile');
const { TranscriptStore } = require('../src/core/analysis/transcript/store');

const SRT = `1
00:00:00,000 --> 00:00:06,500
 E vamos embora galera, galerinha do YouTube

2
00:00:06,500 --> 00:00:10,500
 Já chega dando seu <i>likezinho</i>

3
00:00:12,000 --> 00:00:14,000
 *Risos*

4
00:01:02,250 --> 00:01:05,000
 Olha isso, não acredito
 em segunda linha
`;

test('parseTime: SRT, VTT e curtos', () => {
  assert.equal(parseTime('00:01:02,250'), 62.25);
  assert.equal(parseTime('00:01:02.250'), 62.25);
  assert.equal(parseTime('01:02.5'), 62.5);
  assert.equal(parseTime('1:02:03'), 3723);
  assert.ok(Number.isNaN(parseTime('abc')));
  assert.ok(Number.isNaN(parseTime('')));
});

test('SRT: lê as falas, limpa marcas HTML, junta linhas e marca a risada', () => {
  const r = parseSubtitleBuffer(Buffer.from(SRT, 'utf8'), '.srt', { duration: 120 });
  assert.equal(r.cues.length, 4);
  assert.deepEqual(r.cues[0], { start: 0, end: 6.5, text: 'E vamos embora galera, galerinha do YouTube' });
  assert.equal(r.cues[1].text, 'Já chega dando seu likezinho');
  assert.equal(r.cues[2].laugh, true);
  assert.equal(r.cues[3].text, 'Olha isso, não acredito em segunda linha');
});

test('VTT: cabeçalho, NOTE/STYLE, identificadores, configurações de posição e tempos curtos', () => {
  const vtt = `WEBVTT - legenda

NOTE isto é um comentário
com duas linhas

STYLE
::cue { color: red }

intro
00:00.000 --> 00:04.000 align:start position:10%
<v Braga>Fala um</v Braga>

00:04.000 --> 00:08.500
Fala dois com <c.yellow>cor</c>
`;
  const r = parseSubtitleBuffer(Buffer.from(vtt, 'utf8'), 'vtt');
  assert.deepEqual(r.cues.map((c) => [c.start, c.end, c.text]), [[0, 4, 'Fala um'], [4, 8.5, 'Fala dois com cor']]);
  assert.throws(() => parseSubtitleBuffer(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\noi', 'utf8'), '.vtt'), (e) => e.code === 'BAD_FORMAT');
});

test('codificações: BOM UTF-8, UTF-16 (LE e BE) e Windows-1252', () => {
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SRT, 'utf8')]);
  assert.equal(parseSubtitleBuffer(withBom, '.srt').cues[0].start, 0);
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SRT, 'utf16le')]);
  assert.equal(parseSubtitleBuffer(le, '.srt').cues.length, 4);
  const be = Buffer.from(le);
  for (let i = 2; i + 1 < be.length; i += 2) { const t = be[i]; be[i] = be[i + 1]; be[i + 1] = t; }
  be[0] = 0xfe; be[1] = 0xff;
  assert.equal(parseSubtitleBuffer(be, '.srt').cues[1].text, 'Já chega dando seu likezinho');
  const win = Buffer.from('1\n00:00:01,000 --> 00:00:03,000\nNão é verdade, coração\n', 'latin1');
  assert.equal(parseSubtitleBuffer(win, '.srt').cues[0].text, 'Não é verdade, coração');
});

test('arquivos inválidos: vazio, formato errado, sem falas, grande demais — mensagens em português', () => {
  const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof SubtitleFileError); return e.code; } return null; };
  assert.equal(code(() => parseSubtitleBuffer(Buffer.alloc(0), '.srt')), 'EMPTY');
  assert.equal(code(() => parseSubtitleBuffer(Buffer.from('oi'), '.txt')), 'BAD_FORMAT');
  assert.equal(code(() => parseSubtitleBuffer(Buffer.from('só texto sem tempos\n\noutro bloco'), '.srt')), 'EMPTY');
  assert.equal(code(() => parseSubtitleBuffer(Buffer.alloc(9 * 1024 * 1024, 65), '.srt')), 'TOO_BIG');
  try { parseSubtitleBuffer(Buffer.from('x'), '.srt'); } catch (e) { assert.match(e.message, /Não encontrei nenhuma fala/); }
});

test('normalização: ordem, fim antes do início, fala além do fim do vídeo, texto vazio e laço de repetição', () => {
  const raw = [
    { start: 30, end: 33, text: 'terceira' }, { start: 0, end: 3, text: 'primeira' }, { start: 10, end: 8, text: 'fim antes do início' },
    { start: 500, end: 503, text: 'depois do fim' }, { start: 20, end: 22, text: '   ' }, { start: Number.NaN, end: 2, text: 'nan' },
    ...Array.from({ length: 8 }, (_, i) => ({ start: 40 + i * 2, end: 41.5 + i * 2, text: 'Obrigado.' })),
    { start: 60, end: 62, text: '*Risos*' }, { start: 62, end: 63, text: '*Risos*' }, { start: 63, end: 64, text: '*Risos*' }, { start: 64, end: 65, text: '*Risos*' }, { start: 65, end: 66, text: '*Risos*' }
  ];
  const { cues, dropped } = fmt.normalizeCues(raw, { duration: 120 });
  assert.deepEqual(cues.slice(0, 3).map((c) => c.text), ['primeira', 'fim antes do início', 'terceira']);
  assert.equal(cues[1].end > cues[1].start, true);
  assert.equal(dropped.beyond, 1);
  assert.equal(dropped.invalid, 2);
  assert.equal(cues.filter((c) => c.text === 'Obrigado.').length, fmt.MAX_REPEAT, 'laço de repetição fica só no começo');
  assert.equal(dropped.repeats, 8 - fmt.MAX_REPEAT);
  assert.equal(cues.filter((c) => c.laugh).length, 5, 'risadas seguidas não são laço de reconhecimento');
});

test('marca de risada: só a anotação inteira, não uma fala que cita a palavra', () => {
  assert.equal(fmt.isLaughter('*Risos*'), true);
  assert.equal(fmt.isLaughter('[risos]'), true);
  assert.equal(fmt.isLaughter('(Risada)'), true);
  assert.equal(fmt.isLaughter('*Risos de caixilhas*'), true);
  assert.equal(fmt.isLaughter('risos'), true);
  assert.equal(fmt.isLaughter('ele deu risos de tanto rir da piada que o outro contou aqui'), false);
  assert.equal(fmt.isLaughter('rissole'), false);
});

test('documento versionado: campos, cobertura, estatísticas e releitura normaliza', () => {
  const { cues, dropped } = fmt.normalizeCues([{ start: 0, end: 5, text: 'a' }, { start: 5, end: 7, text: '*Risos*' }, { start: 100, end: 110.5, text: 'b' }], { duration: 120 });
  const doc = fmt.buildDocument({ projectId: 'p1', origin: 'imported', source: { path: 'C:/v.mp4', size: 10, duration: 120 }, cues, dropped, importedFrom: 'x.srt' });
  assert.equal(doc.format, 'bf-transcript-1');
  assert.equal(doc.version, 1);
  assert.equal(doc.coveredSec, 110.5);
  assert.deepEqual(doc.stats, { cues: 3, speechSec: 15.5, laughs: 1, dropped: { invalid: 0, beyond: 0, repeats: 0 } });
  const again = fmt.readDocument(JSON.parse(JSON.stringify(doc)));
  assert.equal(again.stats.cues, 3);
  assert.equal(fmt.readDocument({ ...doc, version: 2 }), null);
  assert.equal(fmt.readDocument({ ...doc, format: 'outra' }), null);
  assert.equal(fmt.readDocument({ ...doc, cues: [] }), null);
  const s = fmt.summarize(doc, { path: 'C:/v.mp4', size: 10, duration: 120 });
  assert.equal(s.exists, true);
  assert.equal(s.stale, false);
  assert.equal(Math.round(s.coverage * 100), 92);
  assert.equal(fmt.summarize(doc, { path: 'C:/outro.mp4', size: 10, duration: 120 }).stale, true);
  assert.equal(fmt.summarize(doc, { path: 'C:/v.mp4', size: 11, duration: 120 }).stale, true);
  assert.equal(fmt.summarize(doc, { path: 'c:\\V.MP4', size: 10, duration: 120.5 }).stale, false, 'caminho sem diferenciar caixa/barra, duração com folga de 1 s');
  assert.deepEqual(fmt.summarize(null), { exists: false });
});

test('cuesInRange: busca binária devolve só as falas que tocam o intervalo', () => {
  const cues = Array.from({ length: 1000 }, (_, i) => ({ start: i * 5, end: i * 5 + 4, text: 'x' }));
  const r = fmt.cuesInRange(cues, 100, 120);
  assert.deepEqual(r.map((c) => c.start), [100, 105, 110, 115, 120]);
  assert.equal(fmt.cuesInRange(cues, 6000, 7000).length, 0);
  assert.equal(fmt.cuesInRange(cues, 4, 4).length, 1);
});

test('armazenamento: grava, lê, rascunho, apaga; id inválido não vira caminho', (t) => {
  const dir = F.tmpDir();
  t.after(() => F.cleanup(dir));
  const store = new TranscriptStore(path.join(dir, 'transcripts'));
  assert.equal(store.get('p1'), null);
  const { cues } = fmt.normalizeCues([{ start: 0, end: 5, text: 'a' }], {});
  store.saveDraft('p1', { source: { path: 'v', size: 1, duration: 10 }, partial: { doneUntil: 5, chunkSec: 600, modelId: 'm', language: 'pt' }, cues });
  assert.equal(store.getDraft('p1').partial.doneUntil, 5);
  store.save('p1', fmt.buildDocument({ projectId: 'p1', origin: 'generated', source: { path: 'v', size: 1, duration: 10 }, cues, dropped: {} }));
  assert.equal(store.getDraft('p1'), null, 'salvar a final limpa o rascunho');
  assert.equal(store.get('p1').cues.length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'transcripts', 'p1.json')));
  assert.equal(fs.readdirSync(path.join(dir, 'transcripts')).filter((n) => n.endsWith('.tmp')).length, 0);
  assert.equal(store.remove('p1'), true);
  assert.equal(store.get('p1'), null);
  for (const bad of ['../x', 'a/b', '', 'a\\b', '.'.repeat(3)]) assert.throws(() => store.get(bad), /inválido/);
  // arquivo estragado vira "ausente" (e é guardado como .corrupt, nunca apagado)
  fs.writeFileSync(path.join(dir, 'transcripts', 'p2.json'), '{ nao é json');
  assert.equal(store.get('p2'), null);
});

test('transcrição real do dono (opcional): BF_TEST_SRT aponta para um .srt; nada dele fica no repositório', { skip: !process.env.BF_TEST_SRT && 'defina BF_TEST_SRT para rodar com a legenda real' }, () => {
  const buffer = fs.readFileSync(process.env.BF_TEST_SRT);
  const r = parseSubtitleBuffer(buffer, path.extname(process.env.BF_TEST_SRT), { duration: 11089.85 });
  assert.ok(r.cues.length > 1000);
  assert.ok(r.cues.some((c) => c.laugh));
  assert.ok(r.cues[r.cues.length - 1].end <= 11089.85 + 0.01);
});

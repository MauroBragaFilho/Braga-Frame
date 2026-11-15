'use strict';

/**
 * Geração de legendas de ponta a ponta com o MOTOR SIMULADO: só o JSON do whisper é combinado (o motor real roda em
 * tests/subtitles-whisper.test.js); o áudio extraído, a detecção de silêncio, o corte do silêncio, o mapa de tempo de volta ao
 * original, as regras anti-alucinação e a montagem das falas são de verdade (ffmpeg de verdade).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./subtitles-helpers');
const halluc = require('../src/core/subtitles/hallucinations');
const { generateSubtitles, probeInput } = require('../src/core/subtitles/generate');

const skip = H.tools.ffmpeg ? false : 'ffmpeg não encontrado';

/** Motor simulado: devolve segmentos combinados (tempos do áudio que o whisper receberia) e as palavras repartidas pelo trecho. */
function stubEngine(segments, language = 'pt') {
  return async () => {
    const words = [];
    segments.forEach((seg, i) => {
      const parts = seg.text.split(/\s+/).filter(Boolean);
      const step = (seg.end - seg.start) / parts.length;
      parts.forEach((word, k) => words.push({ word, start: seg.start + k * step, end: seg.start + (k + 1) * step, p: seg.p, seg: i }));
    });
    return { language, segments: segments.map((s) => ({ ...s })), words, hasTokens: true };
  };
}

const baseOptions = (dir, wav, engine) => ({
  ffmpeg: H.tools.ffmpeg, whisper: process.execPath, modelPath: process.execPath, input: wav, language: 'pt', workRoot: path.join(dir, 'w'), engine
});

test('silêncio cortado, tempos de volta ao original (relativos ao corte), descartes com motivo e revisão', { skip }, async () => {
  const dir = H.tmpDir();
  try {
    // 2 s de silêncio, 2 s de tom, 4 s de silêncio, 2 s de tom = 10 s; sons em 2–4 s e 8–10 s
    const wav = path.join(dir, 'estrutura.wav');
    H.ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=16000',
      '-filter_complex', '[0:a]atrim=0:2[s1];[0:a]atrim=0:4[s2];[s1][1:a][s2][1:a]concat=n=4:v=0:a=1[a]', '-map', '[a]', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    // tempos no áudio sem silêncio: [0, 2,6] = original 1,7–4,3 e [2,6, 4,9] = original 7,7–10,0 (folga de 0,3 s)
    const segments = [
      { start: 0.3, end: 1.5, text: 'Olá pessoal tudo bem', p: 0.9 },                    // fala boa  -> original 2,0–3,2
      { start: 1.6, end: 2.5, text: '[Música]', p: 0.9 },                                // anotação  -> descartada
      { start: 2.7, end: 3.9, text: 'baixa confiança aqui', p: 0.4 },                    // revisar   -> original 7,8–9,0
      { start: 4.0, end: 4.8, text: 'Legendas pela comunidade Amara.org', p: 0.95 },     // crédito   -> descartada
      { start: 4.82, end: 4.9, text: 'xyz', p: 0.1 }                                     // ininteligível -> descartada
    ];
    const base = baseOptions(dir, wav, stubEngine(segments));
    const events = [];
    const full = await generateSubtitles({ ...base, start: 0, end: 10, onProgress: (e) => events.push(e) });
    assert.equal(full.noSpeech, false);
    assert.ok(full.trimmedSec > 4.9 && full.trimmedSec < 5.3, `silêncio cortado antes do motor: ${full.trimmedSec} s`);
    assert.deepEqual(full.cues.map((c) => c.text), ['Olá pessoal tudo bem', 'baixa confiança aqui']);
    const [a, b] = full.cues;
    assert.ok(Math.abs(a.start - 2.0) < 0.02 && Math.abs(a.end - 3.2) < 0.02, `tempo original da fala 1: ${a.start}–${a.end}`);
    assert.ok(Math.abs(b.start - 7.8) < 0.02 && Math.abs(b.end - 9.0) < 0.05, `tempo original da fala 2: ${b.start}–${b.end}`);
    assert.equal(a.needsReview, undefined);
    assert.equal(b.needsReview, true, 'confiança baixa: mantida e marcada para revisão, não escondida');
    assert.deepEqual(full.discarded.map((d) => [d.text, d.reason]), [
      ['[Música]', halluc.REASONS.annotation], ['Legendas pela comunidade Amara.org', halluc.REASONS.known], ['xyz', halluc.REASONS.lowConfidence]
    ], 'tudo que foi descartado fica registrado com o motivo');
    assert.ok(events.some((e) => e.phase === 'silence') && events.at(-1).percent === 100);
    const pct = events.map((e) => e.percent);
    assert.ok(pct.every((x, i) => i === 0 || x >= pct[i - 1]), 'progresso nunca anda para trás');

    // o corte começa em 1 s: o áudio do trecho é 1 s mais curto e tudo continua relativo ao início do corte
    const cut = await generateSubtitles({ ...base, start: 1, end: 10 });
    assert.equal(cut.durationSec, 9);
    assert.ok(cut.cues.length >= 1 && cut.cues.every((c) => c.start >= 0 && c.end <= 9.001), 'tudo dentro do corte');

    // idioma detectado vem do motor
    const auto = await generateSubtitles({ ...base, start: 0, end: 10, language: 'auto', engine: stubEngine(segments, 'en') });
    assert.equal(auto.language, 'en');

    // motor que só devolve anotações: nenhuma fala (e o motivo, não erro)
    const nothing = await generateSubtitles({ ...base, start: 0, end: 10, engine: stubEngine([{ start: 0.2, end: 1, text: '[BLANK_AUDIO]', p: 0.9 }]) });
    assert.deepEqual([nothing.noSpeech, nothing.reason, nothing.cues.length, nothing.discarded.length], [true, 'no-speech', 0, 1]);
    assert.match(nothing.message, /Nenhuma fala detectada/);

    // falha do motor: erro claro, e a pasta de trabalho é apagada
    await assert.rejects(generateSubtitles({ ...base, start: 0, end: 10, engine: async () => { const e = new Error('x'); e.code = 'ENGINE_FAILED'; throw e; } }), (e) => e.code === 'ENGINE_FAILED');
    assert.deepEqual(fs.existsSync(base.workRoot) ? fs.readdirSync(base.workRoot) : [], [], 'nenhuma pasta de trabalho sobrou');
  } finally { H.cleanup(dir); }
});

test('fala dentro de um silêncio detectado (alucinação em trecho mudo) é descartada com motivo', { skip }, async () => {
  const dir = H.tmpDir();
  try {
    // 3 s de tom e 1,2 s de silêncio: o silêncio é curto demais para valer o corte (sai menos de 1,5 s),
    // então o motor simulado vê a linha do tempo original
    const wav = path.join(dir, 'a.wav');
    H.ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=16000',
      '-filter_complex', '[0:a]atrim=0:1.2[s];[1:a][s]concat=n=2:v=0:a=1[a]', '-map', '[a]', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    const segments = [
      { start: 0.2, end: 2.5, text: 'fala de verdade no tom', p: 0.9 },
      { start: 3.3, end: 4.1, text: 'texto em silêncio absoluto', p: 0.9 }
    ];
    const res = await generateSubtitles({ ...baseOptions(dir, wav, stubEngine(segments)), start: 0, end: 4.2 });
    assert.equal(res.trimmedSec, 0, 'silêncio curto demais para valer o corte');
    assert.deepEqual(res.cues.map((c) => c.text), ['fala de verdade no tom']);
    assert.deepEqual(res.discarded.map((d) => d.reason), [halluc.REASONS.silence]);
  } finally { H.cleanup(dir); }
});

test('créditos de legenda decorados são descartados sempre; chamadas comuns ("inscreva-se") só quando é ruído', () => {
  const v = halluc.classifySegments([
    { start: 0, end: 2, text: 'Legendas pela comunidade Amara.org', p: 0.97 },     // crédito: nunca é fala
    { start: 2, end: 4, text: 'Inscreva-se no canal e ative o sininho', p: 0.93 }, // pode ser fala de verdade
    { start: 4, end: 6, text: 'Inscreva-se no canal e ative o sininho', p: 0.35 }  // mas com confiança baixa é suspeito
  ], { speech: [{ start: 0, end: 10 }], silences: [], duration: 10 });
  assert.deepEqual(v.map((x) => x.keep), [false, true, false]);
  assert.equal(v[0].reason, halluc.REASONS.known);
  assert.equal(halluc.hallucinationKind('Legendas pela comunidade Amara.org'), 'certain');
  assert.equal(halluc.hallucinationKind('Obrigado.'), 'common');
  assert.equal(halluc.hallucinationKind('Vamos jogar'), null);
});

test('cancelar durante a geração (motor simulado que espera): CANCELLED e pasta de trabalho apagada', { skip }, async () => {
  const dir = H.tmpDir();
  try {
    const wav = path.join(dir, 'a.wav');
    H.ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    const controller = new AbortController();
    const engine = async ({ signal }) => new Promise((resolve, reject) => {
      setTimeout(() => controller.abort(), 100);
      signal.addEventListener('abort', () => { const e = new Error('cancelado'); e.code = 'CANCELLED'; reject(e); });
    });
    await assert.rejects(generateSubtitles({ ...baseOptions(dir, wav, engine), start: 0, end: 3, signal: controller.signal }), (e) => e.code === 'CANCELLED');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'w')), [], 'nenhuma pasta de trabalho sobrou');
  } finally { H.cleanup(dir); }
});

test('corte fora do vídeo, início negativo ou inválido: a mensagem diz a causa (antes dizia "sem áudio" ou "curto demais")', { skip }, async () => {
  const dir = H.tmpDir();
  try {
    const video = H.makeVideo(path.join(dir, 'cinco.mp4'), [{ tone: 5 }]); // 5 s, com áudio
    const mute = H.makeVideo(path.join(dir, 'mudo.mp4'), [{ tone: 3 }], { noAudio: true }); // sem faixa de áudio
    const engine = stubEngine([]);
    const run = (file, o) => generateSubtitles({ ...baseOptions(dir, file, engine), ...o });
    const fail = async (file, o) => { try { await run(file, o); return null; } catch (e) { return e; } };

    // começa depois do fim do vídeo: o vídeo TEM áudio; o problema é o corte
    const beyond = await fail(video.file, { start: 10, end: 15 });
    assert.equal(beyond.code, 'INVALID_RANGE');
    assert.match(beyond.message, /começa em 10,0 s/);
    assert.match(beyond.message, /vídeo tem só 5,0 s/);
    assert.doesNotMatch(beyond.message, /não tem áudio|curto demais/);
    assert.ok(Math.abs(beyond.details.videoSeconds - 5) < 0.1);
    const atEnd = await fail(video.file, { start: 5, end: 8 });
    assert.equal(atEnd.code, 'INVALID_RANGE', 'exatamente no fim também está fora');

    // início negativo / inválido: mensagens próprias
    const negative = await fail(video.file, { start: -1, end: 3 });
    assert.equal(negative.code, 'INVALID_RANGE');
    assert.match(negative.message, /início do corte não pode ser negativo/);
    assert.doesNotMatch(negative.message, /curto demais/);
    const nan = await fail(video.file, { start: Number.NaN, end: 3 });
    assert.equal(nan.code, 'INVALID_RANGE');
    assert.match(nan.message, /início ou o fim do corte é inválido/);
    assert.match((await fail(video.file, { start: 2, end: 2.1 })).message, /curto demais/, 'o aviso de corte curto continua para quem é curto');

    // o que continua sendo "sem áudio" de verdade
    const noAudio = await run(mute.file, { start: 0, end: 3 });
    assert.deepEqual([noAudio.noSpeech, noAudio.reason], [true, 'no-audio']);
    assert.match(noAudio.message, /não tem áudio/);
    // vídeo sem áudio e corte fora dele: o corte fora é o problema que se mostra
    assert.equal((await fail(mute.file, { start: 10, end: 12 })).code, 'INVALID_RANGE');

    // começa dentro do vídeo mas pega menos de 0,2 s de áudio: não é "sem áudio"
    const sliver = await run(video.file, { start: 4.9, end: 8 });
    assert.deepEqual([sliver.noSpeech, sliver.reason], [true, 'no-speech']);
    assert.match(sliver.message, /menos de 0,2 s/);
    assert.doesNotMatch(sliver.message, /não tem áudio/);

    const info = await probeInput({ ffmpeg: H.tools.ffmpeg, input: video.file });
    assert.ok(Math.abs(info.duration - 5) < 0.1 && info.hasAudio === true);
    assert.equal((await probeInput({ ffmpeg: H.tools.ffmpeg, input: mute.file })).hasAudio, false);
    assert.deepEqual(await probeInput({ ffmpeg: H.tools.ffmpeg, input: path.join(dir, 'nao-existe.mp4') }), { duration: null, hasAudio: false }, 'não conseguir ler o arquivo não quebra');
    assert.deepEqual(fs.existsSync(path.join(dir, 'w')) ? fs.readdirSync(path.join(dir, 'w')) : [], [], 'nenhuma pasta de trabalho sobrou');
  } finally { H.cleanup(dir); }
});

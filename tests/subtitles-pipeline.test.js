'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./subtitles-helpers');
const silence = require('../src/core/subtitles/silence');
const halluc = require('../src/core/subtitles/hallucinations');
const { buildCues } = require('../src/core/subtitles/cueBuilder');
const { parseWhisperCppJson } = require('../src/core/subtitles/whisperOutput');
const { buildWhisperArgs, asciiRelative } = require('../src/core/subtitles/generate');
const S = require('../src/core/subtitles/shared');

const skip = H.tools.ffmpeg ? false : 'ffmpeg não encontrado';

// ---------- silêncio ----------

test('speechFromSilences: trechos com som, folga nas pontas, mesclagem e silêncio até o fim', () => {
  const near = (list, expected) => {
    assert.equal(list.length, expected.length, JSON.stringify(list));
    list.forEach((r, i) => { assert.ok(Math.abs(r.start - expected[i][0]) < 0.002 && Math.abs(r.end - expected[i][1]) < 0.002, `${JSON.stringify(list)} != ${JSON.stringify(expected)}`); });
  };
  near(silence.speechFromSilences([{ start: 0, end: 2 }, { start: 5, end: 8 }], 10, { pad: 0.3 }), [[1.7, 5.3], [7.7, 10]]);
  near(silence.speechFromSilences([{ start: 0, end: 10 }], 10), []);
  near(silence.speechFromSilences([], 10), [[0, 10]]);
  near(silence.speechFromSilences([{ start: 6, end: null }], 10, { pad: 0 }), [[0, 6]], 'silêncio aberto vai até o fim do arquivo');
  near(silence.speechFromSilences([{ start: 2, end: 2.5 }], 10, { pad: 0.3 }), [[0, 10]], 'folgas se encontram: viram um trecho só');
  near(silence.speechFromSilences([], 0), []);
});

test('mapa de tempo: do áudio cortado para o original, nas bordas e no meio', () => {
  const map = silence.makeTimeMap([{ start: 2, end: 4 }, { start: 10, end: 11 }]);
  assert.deepEqual(map, [{ cutStart: 0, cutEnd: 2, origStart: 2, origEnd: 4 }, { cutStart: 2, cutEnd: 3, origStart: 10, origEnd: 11 }]);
  assert.equal(silence.mapToOriginal(map, 0), 2);
  assert.equal(silence.mapToOriginal(map, 1), 3);
  assert.equal(silence.mapToOriginal(map, 2, { edge: 'start' }), 10, 'início de algo na emenda fica no trecho seguinte');
  assert.equal(silence.mapToOriginal(map, 2, { edge: 'end' }), 4, 'fim de algo na emenda fica no trecho anterior');
  assert.equal(silence.mapToOriginal(map, 2.5), 10.5);
  assert.equal(silence.mapToOriginal(map, 99), 11, 'trava no fim');
  assert.equal(silence.mapToOriginal(map, -5), 2, 'trava no início');
  const r = silence.remapResult({ segments: [{ start: 0, end: 1, text: 'a' }, { start: 2.1, end: 2.9, text: 'b' }], words: [{ word: 'a', start: 0, end: 1 }, { word: 'b', start: 2.1, end: 2.9 }] }, map);
  assert.deepEqual(r.segments.map((s) => [s.start, s.end]), [[2, 3], [10.1, 10.9]]);
  assert.deepEqual(r.words.map((s) => [s.start, s.end]), [[2, 3], [10.1, 10.9]]);
});

test('analyzeSilence e buildTrimmedWav com áudio gerado de verdade pelo ffmpeg', { skip }, async () => {
  const dir = H.tmpDir();
  try {
    // 2 s de silêncio, 2 s de tom, 3 s de silêncio, 1 s de tom, 2 s de silêncio = 10 s
    const wav = path.join(dir, 'a.wav');
    H.ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=16000', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1:sample_rate=16000',
      '-filter_complex', '[0:a]atrim=0:2[s1];[0:a]atrim=0:3[s2];[0:a]atrim=0:2[s3];[s1][1:a][s2][2:a][s3]concat=n=5:v=0:a=1[a]', '-map', '[a]', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    assert.ok(Math.abs(silence.wavSeconds(wav) - 10) < 0.05);

    const a = await silence.analyzeSilence(wav, { ffmpeg: H.tools.ffmpeg });
    assert.equal(a.speech.length, 2, JSON.stringify(a.speech));
    // com a folga de 0,3 s: 1,7–4,3 e 6,7–8,3
    assert.ok(Math.abs(a.speech[0].start - 1.7) < 0.1 && Math.abs(a.speech[0].end - 4.3) < 0.1, JSON.stringify(a.speech[0]));
    assert.ok(Math.abs(a.speech[1].start - 6.7) < 0.1 && Math.abs(a.speech[1].end - 8.3) < 0.1, JSON.stringify(a.speech[1]));

    const out = path.join(dir, 'fala.wav');
    const built = await silence.buildTrimmedWav(wav, a.speech, out);
    const kept = a.speech.reduce((n, r) => n + r.end - r.start, 0);
    assert.ok(Math.abs(built.duration - kept) < 0.01);
    assert.ok(Math.abs(silence.wavSeconds(out) - kept) < 0.01, 'o WAV gravado tem a duração dos trechos mantidos');
    assert.ok(Math.abs(silence.mapToOriginal(built.timeMap, built.duration - 0.001) - a.speech[1].end) < 0.01);

    // o mesmo ffmpeg consegue ler o WAV cortado e ele não está em silêncio
    const again = await silence.analyzeSilence(out, { ffmpeg: H.tools.ffmpeg });
    assert.ok(again.speech.length >= 1);
  } finally { H.cleanup(dir); }
});

test('silenceFilter: só números dentro de faixas sensatas entram no -af do ffmpeg (texto vira o padrão: era injeção de filtro)', () => {
  assert.equal(silence.silenceFilter(), 'silencedetect=noise=-50dB:d=1');
  assert.equal(silence.silenceFilter({ noiseDb: -35, minSilence: 0.5 }), 'silencedetect=noise=-35dB:d=0.5');
  const hostile = '-50dB:d=1,ametadata=mode=print:file=ARQUIVO_DO_USUARIO.txt,silencedetect=noise=-50';
  for (const noiseDb of [hostile, '-50', NaN, Infinity, 5, -200, null, undefined, {}, [], '-50dB']) {
    assert.equal(silence.silenceFilter({ noiseDb }), 'silencedetect=noise=-50dB:d=1', `noiseDb ${String(noiseDb).slice(0, 30)}`);
  }
  for (const minSilence of [`1,movie=${'x'}`, '1', NaN, 0, 0.01, 11, -1, {}]) {
    assert.equal(silence.silenceFilter({ minSilence }), 'silencedetect=noise=-50dB:d=1', `minSilence ${String(minSilence)}`);
  }
  assert.deepEqual(silence.LIMITS, { noiseDb: [-90, 0], minSilence: [0.1, 10], pad: [0, 2] });
  assert.match(silence.silenceFilter({ noiseDb: -90, minSilence: 10 }), /^silencedetect=noise=-90dB:d=10$/, 'os limites valem');
});

test('analyzeSilence com limiares hostis: o ffmpeg só vê o filtro silencedetect e não toca em arquivo nenhum', { skip }, async () => {
  const dir = H.tmpDir();
  const cwd = process.cwd();
  try {
    const wav = path.join(dir, 'mudo.wav');
    H.ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3', '-c:a', 'pcm_s16le', wav]);
    const victim = path.join(dir, 'ARQUIVO_DO_USUARIO.txt');
    fs.writeFileSync(victim, 'conteudo importante do usuario');
    process.chdir(dir); // o caminho relativo do filtro injetado cairia aqui
    const hostile = '-50dB:d=1,ametadata=mode=print:file=ARQUIVO_DO_USUARIO.txt,silencedetect=noise=-50';
    const res = await silence.analyzeSilence(wav, { ffmpeg: H.tools.ffmpeg, noiseDb: hostile, minSilence: '1,ametadata=mode=print:file=ARQUIVO_DO_USUARIO.txt' });
    assert.deepEqual(res.speech, [], 'áudio mudo, como sem a injeção');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'conteudo importante do usuario', 'o arquivo do usuário continua intacto');
  } finally { process.chdir(cwd); H.cleanup(dir); }
});

test('analyzeSilence: silêncio digital e ruído quase inaudível não têm fala; fala baixinha tem', { skip }, async () => {
  const dir = H.tmpDir();
  try {
    const mk = (name, src, extra = []) => { const f = path.join(dir, `${name}.wav`); H.ffmpeg(['-f', 'lavfi', '-i', src, ...extra, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', f]); return f; };
    const digital = mk('digital', 'anullsrc=r=16000:cl=mono', ['-t', '6']);
    const faint = mk('faint', 'anoisesrc=d=6:c=pink:r=16000:a=0.0005'); // ~ -66 dB
    // o seno do ffmpeg já nasce a -18 dBFS; com -20 dB fica a -38 dBFS: baixo (como fala distante), mas bem acima do limiar de -50 dB
    const quiet = mk('quiet', 'sine=frequency=300:duration=6:sample_rate=16000', ['-af', 'volume=-20dB']);
    for (const f of [digital, faint]) {
      const r = await silence.analyzeSilence(f, { ffmpeg: H.tools.ffmpeg });
      assert.deepEqual(r.speech, [], `${path.basename(f)} deveria ser silêncio`);
    }
    const r = await silence.analyzeSilence(quiet, { ffmpeg: H.tools.ffmpeg });
    assert.equal(r.speech.length, 1, 'som baixo mas presente NÃO é tratado como silêncio');
  } finally { H.cleanup(dir); }
});

// ---------- regras anti-alucinação ----------

test('isAnnotation: anotações de áudio não são fala', () => {
  for (const t of ['[Música]', ' [MÚSICA] ', '(música)', '[BLANK_AUDIO]', '[ Silence ]', '*risos*', '♪♪', '♪ ♪ ♪', '(risos) [aplausos]', '...', '[Música] ', '{música}']) assert.equal(halluc.isAnnotation(t), true, t);
  for (const t of ['Olá pessoal', 'olá [Música]', 'Eu disse (baixinho) que sim', 'a', '[Música] e então eu falei']) assert.equal(halluc.isAnnotation(t), false, t);
  assert.equal(halluc.isAnnotation(''), true);
});

test('isKnownHallucination: frases de ruído conhecidas, em vários idiomas', () => {
  for (const t of ['Legendas pela comunidade Amara.org', 'Obrigado por assistir!', 'Obrigado.', 'Tchau, tchau!', 'Thanks for watching!', 'Thank you.', 'Subtitles by the Amara.org community', 'Suscríbete', 'Sous-titrage ST\' 501', 'Untertitel der Amara.org-Community', 'Inscreva-se no canal e ative o sininho', 'you']) assert.equal(halluc.isKnownHallucination(t), true, t);
  for (const t of ['Olá pessoal, bem-vindos ao canal', 'Eu quero agradecer a todos vocês por estarem aqui hoje', 'vamos jogar', 'a gente se vê']) assert.equal(halluc.isKnownHallucination(t), false, t);
});

test('classifySegments: descarta o que é ruído (com motivo) e marca revisão, sem esconder fala', () => {
  const speech = [{ start: 0, end: 6 }];
  const seg = (start, end, text, p) => ({ start, end, text, p });
  const v = halluc.classifySegments([
    seg(0, 2, 'Olá pessoal, bem-vindos', 0.9),           // 0 fala boa
    seg(2, 4, 'a gente joga hoje', 0.45),                 // 1 baixa confiança: mantém e revisa
    seg(4, 5, '[Música]', 0.9),                           // 2 anotação
    seg(5, 6, 'Obrigado por assistir!', 0.4),             // 3 frase conhecida com confiança baixa
    seg(6.5, 8, 'Legendas pela comunidade Amara.org', 0.95), // 4 frase conhecida fora de fala
    seg(1, 2, 'blá blá', 0.1),                            // 5 confiança extremamente baixa
    seg(2, 3, 'texto qualquer', 0.9)                      // 6 mantém
  ], { speech, silences: [{ start: 6, end: null }], duration: 10 });
  assert.deepEqual(v.map((x) => x.keep), [true, true, false, false, false, false, true]);
  assert.deepEqual([v[1].review, v[0].review, v[6].review], [true, false, false]);
  assert.equal(v[2].reason, halluc.REASONS.annotation);
  assert.equal(v[3].reason, halluc.REASONS.known);
  assert.equal(v[4].reason, halluc.REASONS.silence, 'dentro de silêncio detectado: sem som nenhum');
  assert.equal(v[5].reason, halluc.REASONS.lowConfidence);
});

test('classifySegments: "Obrigado por assistir!" dito de verdade (dentro de fala, confiança alta) é mantido', () => {
  const v = halluc.classifySegments([{ start: 0, end: 2, text: 'Obrigado por assistir!', p: 0.93 }], { speech: [{ start: 0, end: 3 }], silences: [], duration: 3 });
  assert.deepEqual(v, [{ keep: true, reason: null, review: false }]);
});

test('classifySegments: frase conhecida em trecho sem fala é descartada mesmo com confiança alta', () => {
  const v = halluc.classifySegments([{ start: 0, end: 2, text: 'Obrigado por assistir!', p: 0.95 }], { speech: [{ start: 5, end: 8 }], silences: [], duration: 8 });
  assert.equal(v[0].keep, false);
  assert.equal(v[0].reason, halluc.REASONS.known);
});

test('classifySegments: repetição em laço fica só a primeira, marcada para revisão', () => {
  const same = (i) => ({ start: i, end: i + 1, text: 'e aí pessoal', p: 0.9 });
  const v = halluc.classifySegments([same(0), same(1), same(2), same(3), { start: 4, end: 5, text: 'outra coisa', p: 0.9 }], { speech: [{ start: 0, end: 5 }], silences: [], duration: 5 });
  assert.deepEqual(v.map((x) => x.keep), [true, false, false, false, true]);
  assert.equal(v[0].review, true);
  assert.equal(v[1].reason, halluc.REASONS.repetition);
  // dois iguais seguidos são normais (ex.: "sim, sim")
  const two = halluc.classifySegments([same(0), same(1)], { speech: [{ start: 0, end: 2 }], silences: [], duration: 2 });
  assert.deepEqual(two.map((x) => x.keep), [true, true]);
});

// ---------- palavras -> falas ----------

const word = (w, start, end, p = 0.9, seg = 0) => ({ word: w, start, end, p, seg });

test('buildCues: pausa longa e fim de frase abrem fala nova; limite de caracteres; confiança e trechos de origem', () => {
  const words = [
    word('Olá', 0.1, 0.4), word('pessoal,', 0.4, 0.9), word('bem-vindos', 1.0, 1.6), word('ao', 1.6, 1.7), word('nosso', 1.7, 2.0), word('canal.', 2.0, 2.6),
    word('Hoje', 3.0, 3.3, 0.5, 1), word('vamos', 3.3, 3.6, 0.5, 1), word('jogar', 3.6, 4.0, 0.5, 1),
    word('depois', 6.0, 6.4, 0.9, 2), word('da', 6.4, 6.5, 0.9, 2), word('pausa', 6.5, 7.0, 0.9, 2)
  ];
  const cues = buildCues(words, { lines: 2, maxChars: 22 });
  // "Olá pessoal, bem-vindos ao nosso canal." (38 caracteres) estoura 2 linhas de 22: corta na vírgula
  assert.deepEqual(cues.map((c) => c.text), ['Olá pessoal,', 'bem-vindos ao nosso canal.', 'Hoje vamos jogar', 'depois da pausa']);
  assert.deepEqual(cues.map((c) => c.segs), [[0], [0], [1], [2]]);
  assert.equal(cues[2].p, 0.5);
  assert.ok(cues.every((c, i) => c.end > c.start && (i === 0 || c.start >= cues[i - 1].end)), 'sem sobreposição');
  const tight = buildCues(words.slice(0, 6), { lines: 2, maxChars: 12 });
  assert.ok(tight.length >= 3, 'limite menor, mais falas');
  for (const c of tight) assert.ok(c.text.length <= 24, c.text);
  assert.deepEqual(buildCues([], {}), []);
  assert.deepEqual(buildCues([word('  ', 0, 1)], {}), []);
});

test('buildCues: cada fala fica ao menos 0,5 s e nunca passa de 6 s', () => {
  const quick = buildCues([word('Oi', 1, 1.1)], {});
  assert.ok(quick[0].end - quick[0].start >= 0.5);
  const long = Array.from({ length: 30 }, (_, i) => word(`palavra${i}`, i * 0.5, i * 0.5 + 0.45));
  const cues = buildCues(long, { lines: 2, maxChars: 60 });
  for (const c of cues) assert.ok(c.end - c.start <= 6.6, `fala longa demais: ${c.end - c.start}`);
  assert.ok(cues.length >= 3);
});

// ---------- saída do whisper.cpp ----------

/** JSON no formato do `whisper-cli -ojf` (campos usados). Os bytes de uma letra acentuada podem vir divididos entre tokens. */
function whisperJson(segments) {
  return {
    result: { language: 'pt' },
    transcription: segments.map((s) => ({
      offsets: { from: s.from, to: s.to }, text: s.text,
      tokens: s.tokens.map((t) => ({ text: t[0], p: t[1], offsets: { from: t[2], to: t[3] }, t_dtw: t[4] ?? -1 }))
    }))
  };
}

test('parseWhisperCppJson: palavras a partir dos tokens, confiança, tempos por DTW e tokens especiais descartados', () => {
  const json = whisperJson([{ from: 0, to: 4200, text: ' Olá pessoal, bem-vindos', tokens: [
    ['[_BEG_]', 0.97, 0, 0, -1], [' Olá', 0.62, 110, 300, 36], [' pessoal', 0.67, 300, 1020, 108], [',', 0.72, 1020, 1110, 144], [' bem', 0.95, 1400, 1520, 174], ['-', 0.77, 1520, 1620, 210], ['v', 0.98, 1620, 1680, 210], ['indos', 0.9, 1760, 2020, 214]
  ] }]);
  const r = parseWhisperCppJson(json);
  assert.equal(r.language, 'pt');
  assert.equal(r.hasTokens, true);
  assert.deepEqual(r.words.map((w) => w.word), ['Olá', 'pessoal,', 'bem-vindos']);
  assert.ok(r.words[0].p > 0.6 && r.words[0].p < 0.64);
  assert.ok(r.words.every((w) => w.seg === 0 && w.end >= w.start));
  assert.ok(Math.abs(r.words[0].end - 0.36) < 1e-9, 'fim pelo DTW (centésimos)');
  assert.ok(r.words[1].start >= r.words[0].end - 1e-9, 'início de cada palavra = fim da anterior');
  assert.equal(r.segments.length, 1);
  assert.ok(r.segments[0].p > 0.7 && r.segments[0].p < 0.95);
});

test('parseWhisperCppJson: letra acentuada dividida entre dois tokens (UTF-8) e texto sem tokens', () => {
  // "Olá" = 4F 6C C3 A1; o motor pode dividir o C3 A1 em dois tokens: no arquivo são bytes soltos
  const text = JSON.stringify(whisperJson([{ from: 0, to: 1000, text: ' Ol\u00c3\u00a1', tokens: [[' Ol', 0.9, 0, 400], ['\u00c3', 0.9, 400, 500], ['\u00a1', 0.9, 500, 900]] }]));
  const r = parseWhisperCppJson(Buffer.from(text, 'latin1'));
  assert.deepEqual(r.words.map((w) => w.word), ['Olá']);
  assert.equal(r.segments[0].text, 'Olá');
  const none = parseWhisperCppJson({ transcription: [{ offsets: { from: 0, to: 2000 }, text: ' sem tokens aqui', tokens: [] }] });
  assert.deepEqual(none.words.map((w) => w.word), ['sem', 'tokens', 'aqui']);
  assert.equal(none.hasTokens, false);
  assert.equal(none.words[0].p, null);
  assert.deepEqual(parseWhisperCppJson({ transcription: [] }).words, []);
  assert.deepEqual(parseWhisperCppJson({}).segments, []);
});

// ---------- japonês e chinês: tokens sem espaço ----------

/** O arquivo do motor traz os bytes UTF-8 soltos: cada caractere do JSON é um byte (lido como latin1). */
const raw = (text) => Buffer.from(text, 'utf8').toString('latin1');
const fileBytes = (json) => Buffer.from(JSON.stringify(json), 'latin1');

/** Trecho de 7,65 s em japonês como o whisper.cpp o devolve: só o primeiro token começa com espaço. */
function japaneseJson() {
  const t = (text, p, from, to, dtw) => ({ text: raw(text), p, offsets: { from, to }, t_dtw: dtw });
  const ge = Buffer.from('ゲ', 'utf8'); // E3 82 B2: o caractere vem dividido entre dois tokens
  return {
    result: { language: 'ja' },
    transcription: [{
      offsets: { from: 0, to: 7650 }, text: raw(' こんにちは、みなさん。今日はゲームをします。'),
      tokens: [
        t('[_BEG_]', 0.99, 0, 0, -1),
        t(' こんにちは', 0.9, 0, 900, 90), t('、', 0.8, 900, 1000, 100), t('みな', 0.9, 1000, 1500, 150), t('さん', 0.9, 1500, 2000, 200), t('。', 0.8, 2000, 2100, 205),
        t(' 今日', 0.9, 2500, 3200, 320), t('は', 0.9, 3200, 3400, 340),
        { text: ge.subarray(0, 2).toString('latin1'), p: 0.9, offsets: { from: 3400, to: 3600 }, t_dtw: 360 },
        { text: ge.subarray(2).toString('latin1'), p: 0.9, offsets: { from: 3600, to: 3800 }, t_dtw: 380 },
        t('ー', 0.9, 3800, 4000, 400), t('ム', 0.9, 4000, 4300, 430), t('を', 0.9, 4300, 4500, 450),
        t('し', 0.9, 4500, 4700, 470), t('ます', 0.9, 4700, 5200, 520), t('。', 0.8, 5200, 5300, 525),
        t('[_TT_765]', 0.99, 7650, 7650, -1)
      ]
    }]
  };
}

test('parseWhisperCppJson em japonês: cada pedaço vira uma palavra (com tempo próprio), grudada na anterior; caractere dividido entre tokens fica inteiro', () => {
  const r = parseWhisperCppJson(fileBytes(japaneseJson()));
  assert.equal(r.language, 'ja');
  assert.deepEqual(r.words.map((w) => w.word), ['こんにちは、', 'みな', 'さん。', '今日', 'は', 'ゲ', 'ー', 'ム', 'を', 'し', 'ます。']);
  assert.deepEqual(r.words.map((w) => w.glue === true), [false, true, true, false, true, true, true, true, true, true, true], '"glue": sem espaço antes (token sem espaço); o que abre com espaço não gruda');
  assert.ok(!r.words.some((w) => w.word.includes('�')), 'nenhum caractere quebrado');
  // antes do conserto: UMA palavra com os 38 caracteres e o início tardio (5,6 s) de uma frase que começa em 0
  assert.ok(r.words.length > 1);
  assert.ok(r.words[0].start < 1, `a primeira palavra começa cedo (${r.words[0].start} s)`);
  assert.ok(r.words.every((w, i) => w.end >= w.start && (i === 0 || w.start >= r.words[i - 1].end - 1e-9)), 'tempos em ordem');
  assert.ok(Math.abs(r.words.at(-1).end - 5.2) < 0.01, 'a última palavra termina onde o motor diz');
  // texto com tokens que começam com espaço seguem iguais (inglês/português não mudam)
  const en = parseWhisperCppJson(whisperJson([{ from: 0, to: 1000, text: ' Hello world', tokens: [[' Hello', 0.9, 0, 400, 40], [' world', 0.9, 400, 900, 90]] }]));
  assert.deepEqual(en.words.map((w) => [w.word, w.glue]), [['Hello', undefined], ['world', undefined]]);
});

test('japonês: as falas juntam as palavras sem espaço, respeitam a largura (CJK vale 2) e a primeira aparece no começo', () => {
  const r = parseWhisperCppJson(fileBytes(japaneseJson()));
  const cues = buildCues(r.words, { lines: 2, maxChars: 22 });
  assert.deepEqual(cues.map((c) => c.text), ['こんにちは、みなさん。', '今日はゲームをします。'], 'cortadas no fim da frase, sem espaços no texto');
  assert.ok(cues[0].start < 1, `a primeira fala aparece cedo (${cues[0].start} s), não aos 5,6 s do defeito`);
  assert.ok(cues[1].start >= 2.5 && cues[1].start < 3.3);
  assert.ok(Math.abs(cues[1].end - 5.2) < 0.01);
  const wrapped = S.wrapText(cues[1].text, 22);
  for (const line of wrapped.split('\n')) assert.ok(S.textWidth(line) <= 22);

  // a fala longa sem pontuação respeita 2 linhas de 22 de largura (11 caracteres) e quebra entre caracteres
  const long = Array.from('今日はみんなでゲームをしますよろしくお願いしますそれではさっそく始めましょう', (ch, i) => ({ word: ch, start: i * 0.2, end: i * 0.2 + 0.2, p: 0.9, seg: 0, ...(i > 0 ? { glue: true } : {}) }));
  const cuesLong = buildCues(long, { lines: 2, maxChars: 22 });
  assert.ok(cuesLong.length >= 2, 'não vira uma fala de 36 caracteres numa linha só');
  for (const c of cuesLong) {
    assert.ok(S.textWidth(c.text) <= 44, `${c.text}: ${S.textWidth(c.text)}`);
    assert.ok(S.wrapText(c.text, 22).split('\n').every((l) => S.textWidth(l) <= 22));
    assert.ok(!c.text.includes(' '));
  }
  assert.equal(cuesLong.map((c) => c.text).join(''), long.map((w) => w.word).join(''), 'nenhum caractere se perde');
  assert.ok(cuesLong[0].start < 0.3);
  // o latino mantém o espaço: palavras separadas por espaço no motor continuam separadas
  const latin = buildCues([{ word: 'Hello', start: 0, end: 0.4, p: 0.9, seg: 0 }, { word: 'world', start: 0.4, end: 0.9, p: 0.9, seg: 0 }], {});
  assert.equal(latin[0].text, 'Hello world');
});

test('chinês: tokens sem espaço, pontuação larga e texto sem tokens (só o trecho) também viram palavras', () => {
  const t = (text, p, from, to, dtw) => ({ text: raw(text), p, offsets: { from, to }, t_dtw: dtw });
  const zh = parseWhisperCppJson(fileBytes({
    result: { language: 'zh' },
    transcription: [{ offsets: { from: 0, to: 3000 }, text: raw('大家好，欢迎来到我的频道。'), tokens: [
      t('大家', 0.9, 0, 600, 60), t('好', 0.9, 600, 900, 90), t('，', 0.8, 900, 1000, 100), t('欢迎', 0.9, 1000, 1600, 160), t('来到', 0.9, 1600, 2000, 200), t('我的', 0.9, 2000, 2400, 240), t('频道', 0.9, 2400, 2900, 290), t('。', 0.8, 2900, 3000, 300)
    ] }]
  }));
  assert.deepEqual(zh.words.map((w) => w.word), ['大家', '好，', '欢迎', '来到', '我的', '频道。']);
  assert.equal(buildCues(zh.words, { lines: 2, maxChars: 22 })[0].text, '大家好，欢迎来到我的频道。');
  // sem tokens: o texto do trecho é repartido pela duração, um caractere por vez
  const bare = parseWhisperCppJson({ transcription: [{ offsets: { from: 0, to: 2000 }, text: ' 你好吗', tokens: [] }] });
  assert.deepEqual(bare.words.map((w) => w.word), ['你', '好', '吗']);
  assert.deepEqual(bare.words.map((w) => w.glue === true), [false, true, true]);
  assert.ok(bare.words[0].start === 0 && Math.abs(bare.words[2].end - 2) < 1e-9);
});

// ---------- argumentos do motor ----------

test('buildWhisperArgs e caminhos em ASCII (o whisper-cli não aceita acentos nos argumentos)', () => {
  const args = buildWhisperArgs({ model: '..\\modelo.bin', audio: 'audio.wav', language: 'pt', dtw: 'small', threads: 4 });
  assert.deepEqual(args.slice(0, 6), ['-m', '..\\modelo.bin', '-f', 'audio.wav', '-l', 'pt']);
  for (const flag of ['-ojf', '-pp', '-bs', '-mc', '-dtw', '-nfa']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('-mc') + 1], '0', 'sem contexto do trecho anterior');
  assert.deepEqual([args[args.indexOf('-nth') + 1], args[args.indexOf('-lpt') + 1], args[args.indexOf('-et') + 1]], ['0.6', '-1.0', '2.4'], 'limiares de sem-fala do whisper explícitos');
  assert.ok(!args.includes('-sns'), 'sem -sns (forçava texto inventado com ruído)');
  assert.ok(!buildWhisperArgs({ model: 'm', audio: 'a', language: 'pt', dtw: null, threads: 2 }).includes('-dtw'));
  assert.equal(asciiRelative('C:\\a\\b', 'C:\\a\\c\\m.bin'), '..\\c\\m.bin');
  assert.equal(asciiRelative('C:\\a\\b', 'C:\\a\\ç\\m.bin'), null, 'acento: usa cópia/atalho na pasta de trabalho');
  assert.equal(asciiRelative('C:\\a\\b', 'D:\\outro\\m.bin'), null, 'outra unidade: caminho absoluto, não serve');
});

test('geração com pedidos inválidos falha com mensagem clara, sem tocar em nada', async () => {
  const { generateSubtitles } = require('../src/core/subtitles/generate');
  const dir = H.tmpDir();
  try {
    const ok = { ffmpeg: H.tools.ffmpeg || 'x', whisper: process.execPath, modelPath: process.execPath, input: process.execPath, start: 0, end: 5, workRoot: path.join(dir, 'w') };
    const code = async (o) => { try { await generateSubtitles({ ...ok, ...o }); return 'sem erro'; } catch (e) { return e.code; } };
    assert.equal(await code({ ffmpeg: null }), 'NO_FFMPEG');
    assert.equal(await code({ whisper: path.join(dir, 'nao-existe.exe') }), 'NO_ENGINE');
    assert.equal(await code({ modelPath: path.join(dir, 'nao-existe.bin') }), 'NO_MODEL');
    assert.equal(await code({ input: path.join(dir, 'nao-existe.mp4') }), 'INPUT_MISSING');
    assert.equal(await code({ start: 5, end: 5.1 }), 'INVALID_RANGE');
    assert.equal(await code({ start: -1 }), 'INVALID_RANGE');
    assert.equal(await code({ start: 0, end: 4000 }), 'INVALID_RANGE');
    assert.equal(await code({ language: 'pt-BR!' }), 'INVALID_ARGS');
    const aborted = new AbortController();
    aborted.abort();
    assert.equal(await code({ signal: aborted.signal }), 'CANCELLED');
    assert.equal(fs.existsSync(path.join(dir, 'w')), false, 'nenhuma pasta de trabalho foi criada');
  } finally { H.cleanup(dir); }
});

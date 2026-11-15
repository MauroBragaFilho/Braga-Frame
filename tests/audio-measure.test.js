'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fx = require('./audio-fixtures');
const { measureAudio, parseVolumeDetect, measureArgs, describeReadFailure } = require('../src/core/audio/measure');

const skipMedia = fx.tools.ffmpeg && fx.tools.ffprobe ? false : 'ffmpeg/ffprobe não encontrados';
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: esperado ${expected} ±${tol}, medido ${actual}`);
const measure = (sourcePath, start, end, extra = {}) => measureAudio({ ffmpeg: fx.tools.ffmpeg, sourcePath, start, end, ...extra });
/** A mensagem que vai para a tela é toda em português: nenhuma palavra do texto em inglês do ffmpeg. */
const assertPortuguese = (message) => assert.doesNotMatch(message, /\b(error|invalid|opening|input|file|failed|denied|atom|decoder|stream|found)\b/i, `mensagem com texto em inglês: ${message}`);

test('parseVolumeDetect lê o resultado final (e ignora o n_samples: 0 do início)', () => {
  const text = [
    'Input #0, wav, from \'x.wav\':',
    '  Stream #0:0: Audio: pcm_s16le, 48000 Hz, mono, s16, 768 kb/s',
    '[Parsed_volumedetect_0 @ 0000] n_samples: 0',
    '[Parsed_volumedetect_0 @ 0001] n_samples: 96000',
    '[Parsed_volumedetect_0 @ 0001] mean_volume: -21.1 dB',
    '[Parsed_volumedetect_0 @ 0001] max_volume: -18.1 dB'
  ].join('\n');
  assert.deepEqual(parseVolumeDetect(text), { hasAudio: true, samples: 96000, peakDb: -18.1, meanDb: -21.1 });
  assert.deepEqual(parseVolumeDetect('Input #0, mov\n  Stream #0:0(und): Video: h264'), { hasAudio: false, samples: 0, peakDb: null, meanDb: null });
  assert.equal(parseVolumeDetect('mean_volume: -inf dB\nmax_volume: -inf dB').peakDb, null, 'silêncio absoluto vira null, não NaN');
});

test('os argumentos só leem: nada é gravado e o vídeo é ignorado', () => {
  const args = measureArgs({ sourcePath: 'C:\\v\\a.mp4', start: 1.5, end: 4 });
  assert.deepEqual(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 4), ['-ss', '1.500', '-to', '4.000']);
  assert.ok(args.includes('-vn') && args.includes('volumedetect'));
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2), ['-map', '0:a:0?'], 'a mesma faixa que a exportação usa');
  assert.deepEqual(args.slice(-3), ['-f', 'null', '-'], 'a saída é descartada');
  assert.ok(!args.includes('-y') && !args.includes('-n'), 'não há arquivo de saída para sobrescrever');
});

test('erros de entrada são explicados em português', async () => {
  await assert.rejects(() => measureAudio({ ffmpeg: null, sourcePath: 'x', start: 0, end: 1 }), (e) => e.code === 'NO_FFMPEG' && /FFmpeg não encontrado/.test(e.message) && /PATH/.test(e.message));
  for (const [start, end] of [[2, 2], [3, 1], [-1, 2], [NaN, 2], [0, Infinity]]) {
    await assert.rejects(() => measureAudio({ ffmpeg: 'ffmpeg', sourcePath: 'x', start, end }), (e) => e.code === 'INVALID_RANGE', `${start}-${end}`);
  }
});

test('mede pico e média reais do trecho (somente leitura)', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('audiomeasure');
  try {
    const loud = fx.makeTone(path.join(dir, 'alto.wav'), { seconds: 6, volumeDb: 0 });
    const quiet = fx.makeTone(path.join(dir, 'baixo.wav'), { seconds: 6, volumeDb: -12 });
    const hashes = [fx.sha256(loud), fx.sha256(quiet)];

    const a = await measure(loud, 1, 3);
    assert.equal(a.hasAudio, true);
    near(a.peakDb, fx.SINE_PEAK_DB, 0.2, 'pico');
    near(a.meanDb, fx.SINE_MEAN_DB, 0.2, 'média');
    near(a.samples, 2 * 48000, 480, 'amostras do trecho de 2 s');
    assert.deepEqual([a.start, a.end], [1, 3]);

    const b = await measure(quiet, 1, 3);
    near(b.peakDb - a.peakDb, -12, 0.2, 'o arquivo 12 dB mais baixo mede 12 dB a menos');
    near(b.meanDb - a.meanDb, -12, 0.2, 'média 12 dB menor');

    assert.deepEqual([fx.sha256(loud), fx.sha256(quiet)], hashes, 'as fontes continuam idênticas');
  } finally { fx.removeDir(dir); }
});

test('numa gravação MP4 mede só o áudio e respeita o início e o fim do corte', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('audiomeasure');
  try {
    const video = fx.makeVideo(path.join(dir, 'jogo gravado.mp4'), { seconds: 8, volumeDb: -6 });
    const m = await measure(video, 2, 5);
    assert.equal(m.hasAudio, true);
    near(m.peakDb, fx.SINE_PEAK_DB - 6, 0.7, 'pico depois do AAC');
    near(m.samples, 3 * 48000, 2200, 'amostras de 3 s');
  } finally { fx.removeDir(dir); }
});

test('caminho com espaços e acentos funciona', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('audiomeasure');
  try {
    const sub = path.join(dir, 'Gravações da live é');
    fs.mkdirSync(sub);
    const file = fx.makeTone(path.join(sub, 'partida 01 ção.wav'), { seconds: 3 });
    const m = await measure(file, 0, 2);
    near(m.meanDb, fx.SINE_MEAN_DB, 0.2, 'média');
  } finally { fx.removeDir(dir); }
});

test('fonte sem faixa de áudio: hasAudio false (aviso, não erro)', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('audiomeasure');
  try {
    const mute = fx.makeVideo(path.join(dir, 'sem-audio.mp4'), { seconds: 4, audio: false });
    assert.deepEqual(await measure(mute, 0, 2), { hasAudio: false, samples: 0, peakDb: null, meanDb: null, start: 0, end: 2 });
  } finally { fx.removeDir(dir); }
});

test('trecho depois do fim do áudio: sem amostras (peakDb e meanDb nulos)', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('audiomeasure');
  try {
    const file = fx.makeTone(path.join(dir, 'curto.wav'), { seconds: 3 });
    const m = await measure(file, 50, 60);
    assert.deepEqual([m.hasAudio, m.samples, m.peakDb, m.meanDb], [true, 0, null, null]);
  } finally { fx.removeDir(dir); }
});

test('arquivo que não é mídia vira erro em português, com a causa e o que fazer (o inglês do ffmpeg fica só em details)', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('audiomeasure');
  try {
    const bad = path.join(dir, 'texto.mp4');
    fs.writeFileSync(bad, 'isto não é um vídeo');
    const good = fx.makeVideo(path.join(dir, 'ok.mp4'), { seconds: 6 });
    const bytes = fs.readFileSync(good);
    const truncated = path.join(dir, 'incompleto.mp4'); // gravação interrompida: falta o final do arquivo (e o índice do MP4)
    fs.writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 3)));
    for (const file of [bad, truncated]) {
      await assert.rejects(() => measure(file, 0, 1), (e) => {
        assert.equal(e.code, 'MEASURE_FAILED');
        assert.match(e.message, /^O ffmpeg não conseguiu ler o áudio deste trecho: o arquivo parece corrompido ou incompleto/);
        assert.match(e.message, /Confira se ele abre no player/, 'diz como resolver');
        assertPortuguese(e.message);
        assert.match(e.details.ffmpeg, /Invalid data found/, 'o texto original do ffmpeg continua disponível em details');
        assert.match(e.details.stderr, /moov atom not found|Invalid data found/);
        return true;
      }, path.basename(file));
    }
    await assert.rejects(() => measure(path.join(dir, 'nao-existe.mp4'), 0, 1), (e) => {
      assert.equal(e.code, 'MEASURE_FAILED');
      assert.match(e.message, /o arquivo não foi encontrado .* Reabra o vídeo pelo app/);
      assertPortuguese(e.message);
      return true;
    });
  } finally { fx.removeDir(dir); }
});

test('cada causa provável de falha de leitura tem texto próprio em português', () => {
  const cases = [
    ['C:\\v\\a.mp4: Permission denied', /sem permissão para ler o arquivo, ou ele está em uso/],
    ['C:\\v\\a.mp4: No such file or directory', /o arquivo não foi encontrado/],
    ['[mov,mp4 @ 0000] moov atom not found\nError opening input files: Invalid data found when processing input', /corrompido ou incompleto/],
    ['[aac @ 0000] Truncated packet: the file ended in the middle of a frame', /corrompido ou incompleto/],
    ['Decoder (codec truehd) not found for input stream #0:1', /formato que o ffmpeg não reconhece.*converta o arquivo para MP4 com áudio AAC/],
    ['Unsupported codec with id 94211 for input stream 1', /formato que o ffmpeg não reconhece/],
    ['alguma coisa que ninguém previu', /^O ffmpeg não conseguiu ler o áudio deste trecho\. Confira se o arquivo abre no player e reabra o vídeo no app/]
  ];
  for (const [ffmpegText, expected] of cases) {
    const message = describeReadFailure(ffmpegText);
    assert.match(message, expected, ffmpegText);
    assert.match(message, /^O ffmpeg não conseguiu ler o áudio deste trecho/);
    assertPortuguese(message);
  }
  assert.match(describeReadFailure(''), /abre no player/, 'sem nenhuma saída do ffmpeg também orienta');
});

test('ffmpeg que não inicia: causa e solução em português, sem o "spawn ... ENOENT" do sistema', async () => {
  const missing = path.join(os.tmpdir(), 'bf-nao-existe', 'ffmpeg.exe');
  await assert.rejects(() => measureAudio({ ffmpeg: missing, sourcePath: 'x.mp4', start: 0, end: 2 }), (e) => {
    assert.equal(e.code, 'MEASURE_FAILED');
    assert.match(e.message, /^O ffmpeg não foi encontrado em “.*ffmpeg\.exe” .*Verificar de novo/);
    assert.doesNotMatch(e.message, /spawn|ENOENT/);
    assert.match(e.details.cause, /ENOENT/, 'o detalhe técnico fica em details');
    return true;
  });
});

test('cancelamento e limite de tempo encerram o ffmpeg e explicam', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('audiomeasure');
  try {
    const file = fx.makeTone(path.join(dir, 'a.wav'), { seconds: 4 });
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(() => measure(file, 0, 2, { signal: abort.signal }), (e) => e.code === 'CANCELLED');
    await assert.rejects(() => measure(file, 0, 2, { timeoutMs: 1 }), (e) => e.code === 'MEASURE_TIMEOUT' && /demorou demais/.test(e.message));
    // depois de tudo, uma medição normal continua funcionando
    assert.equal((await measure(file, 0, 2)).hasAudio, true);
  } finally { fx.removeDir(dir); }
});

/** Cabeçalho de um WAV mono de 8 kHz que promete `seconds` segundos de áudio (os dados chegam depois, ou nunca). */
function wavHeader(seconds, rate = 8000) {
  const dataBytes = seconds * rate * 2;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

test('cancelar no meio da medição encerra o ffmpeg de verdade (fonte que para de responder)', { skip: skipMedia || (process.platform === 'win32' ? false : 'a fonte parada usa um named pipe do Windows') }, async () => {
  // O ffmpeg de verdade lê de um named pipe: recebe o cabeçalho de um WAV de 1 hora e 1 segundo de áudio, e o servidor
  // então fica calado. A medição fica presa nessa leitura até alguém cancelar; quando o ffmpeg morre, o pipe é fechado.
  const net = require('node:net');
  const events = [];
  let closed;
  const pipeClosed = new Promise((resolve) => { closed = resolve; });
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => { events.push('pipe fechado'); closed(); });
    events.push('ffmpeg conectou');
    socket.write(Buffer.concat([wavHeader(3600), Buffer.alloc(16000)]));
  });
  const pipe = `\\\\.\\pipe\\bf-audio-test-${process.pid}-${Date.now()}`;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  try {
    const abort = new AbortController();
    const started = Date.now();
    const running = measure(pipe, 0, 3600, { signal: abort.signal, timeoutMs: 60000 }).then((v) => ({ value: v }), (err) => ({ err }));
    const end = Date.now() + 15000;
    while (!events.includes('ffmpeg conectou') && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.includes('ffmpeg conectou'), 'o ffmpeg começou a ler a fonte');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(events.includes('pipe fechado'), false, 'e continua preso na leitura (medição em andamento)');
    abort.abort();
    const outcome = await running;
    assert.equal(outcome.err && outcome.err.code, 'CANCELLED', outcome.value ? `terminou sem cancelar: ${JSON.stringify(outcome.value)}` : String(outcome.err));
    assert.match(outcome.err.message, /cancelada/i);
    await Promise.race([pipeClosed, new Promise((resolve) => setTimeout(resolve, 10000))]);
    assert.ok(events.includes('pipe fechado'), 'o processo do ffmpeg terminou (soltou a fonte)');
    assert.ok(Date.now() - started < 20000);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('com várias faixas de áudio mede a primeira (a mesma que a exportação mapeia)', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('audiomeasure');
  try {
    const file = path.join(dir, 'duas-faixas.mkv');
    // faixa 1: mono a 0 dB; faixa 2: estéreo a -20 dB. A medição precisa seguir a faixa 1 (0:a:0), como a exportação.
    require('node:child_process').execFileSync(fx.tools.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=4',
      '-filter_complex', '[1:a]volume=-20dB,aformat=channel_layouts=stereo[b]', '-map', '0:a', '-map', '[b]', '-c:a', 'pcm_s16le', file
    ], { windowsHide: true });
    const m = await measure(file, 0, 3);
    near(m.peakDb, fx.SINE_PEAK_DB, 0.3, 'pico da primeira faixa');
  } finally { fx.removeDir(dir); }
});

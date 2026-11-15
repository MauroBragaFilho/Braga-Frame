'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fx = require('./audio-fixtures');
const { createContext } = require('../src/ipc/context');
const audioHandler = require('../src/ipc/handlers/audio');

const skipMedia = fx.tools.ffmpeg && fx.tools.ffprobe ? false : 'ffmpeg/ffprobe não encontrados';
const silent = { log() {}, info() {}, warn() {}, error() {} };
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: esperado ${expected} ±${tol}, medido ${actual}`);

/** ctx de verdade (createContext) com o Electron falso; devolve também os eventos de before-quit. */
function makeCtx(userData, tools, handlerModule = audioHandler) {
  const handlers = new Map();
  const quitListeners = [];
  const deps = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: () => userData, getVersion: () => '9.9.9', on: (event, fn) => { if (event === 'before-quit') quitListeners.push(fn); } },
    dialog: {}, shell: {}, getWindow: () => null, logger: silent,
    resolveTools: () => tools
  };
  const ctx = createContext(deps);
  handlerModule.register(ctx);
  return { ctx, call: (channel, payload) => handlers.get(channel)({}, payload), handlers, quitListeners };
}

test('o handler registra só o canal audio:measure (nenhum canal escreve na fonte)', () => {
  const dir = fx.tmpDir('audioipc');
  try {
    const { ctx } = makeCtx(dir, { ffmpeg: null, ffprobe: null });
    assert.deepEqual([...ctx.channels].filter((c) => c.startsWith('audio:')), ['audio:measure']);
  } finally { fx.removeDir(dir); }
});

test('audio:measure valida o pedido e explica o que fazer', async () => {
  const dir = fx.tmpDir('audioipc');
  try {
    const none = makeCtx(path.join(dir, 'u1'), { ffmpeg: null, ffprobe: null });
    let res = await none.call('audio:measure', { sourcePath: path.join(dir, 'x.mp4'), start: 0, end: 2 });
    assert.deepEqual([res.ok, res.code], [false, 'NO_FFMPEG']);
    assert.match(res.message, /Instale o FFmpeg/);

    const real = makeCtx(path.join(dir, 'u2'), { ffmpeg: fx.tools.ffmpeg || 'ffmpeg', ffprobe: fx.tools.ffprobe });
    res = await real.call('audio:measure', { start: 0, end: 2 });
    assert.deepEqual([res.ok, res.code], [false, 'INVALID_PATH']);
    for (const [start, end] of [[2, 2], [5, 1], [-1, 3], ['0', 3], [0, null]]) {
      res = await real.call('audio:measure', { sourcePath: path.join(dir, 'x.mp4'), start, end });
      assert.deepEqual([res.ok, res.code], [false, 'INVALID_RANGE'], `${start}-${end}`);
    }
    res = await real.call('audio:measure', { sourcePath: path.join(dir, 'nao-existe.mp4'), start: 0, end: 2 });
    assert.deepEqual([res.ok, res.code], [false, 'INPUT_MISSING']);
    assert.match(res.message, /não foi encontrado/);
    res = await real.call('audio:measure', { sourcePath: dir, start: 0, end: 2 });
    assert.equal(res.code, 'INPUT_MISSING', 'uma pasta não é uma fonte');
    res = await real.call('audio:measure', { sourcePath: 'http://exemplo.invalid/video.mp4', start: 0, end: 2 });
    assert.equal(res.code, 'INPUT_MISSING', 'só arquivos locais existentes (nada de URL)');
  } finally { fx.removeDir(dir); }
});

test('audio:measure devolve pico e média reais, usa cache e invalida quando o arquivo muda', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('audioipc');
  try {
    const { call } = makeCtx(path.join(dir, 'u'), { ffmpeg: fx.tools.ffmpeg, ffprobe: fx.tools.ffprobe });
    const src = fx.makeTone(path.join(dir, 'fonte.wav'), { seconds: 8, volumeDb: 0 });

    const first = await call('audio:measure', { sourcePath: src, start: 1, end: 4 });
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);
    assert.equal(first.hasAudio, true);
    near(first.peakDb, fx.SINE_PEAK_DB, 0.2, 'pico');
    near(first.meanDb, fx.SINE_MEAN_DB, 0.2, 'média');

    const again = await call('audio:measure', { sourcePath: src, start: 1, end: 4 });
    assert.equal(again.cached, true);
    assert.deepEqual([again.peakDb, again.meanDb], [first.peakDb, first.meanDb]);
    const other = await call('audio:measure', { sourcePath: src, start: 1, end: 5 });
    assert.equal(other.cached, false, 'outro trecho = outra medição');

    // pedidos iguais ao mesmo tempo compartilham a medição
    const [p, q] = await Promise.all([call('audio:measure', { sourcePath: src, start: 2, end: 3 }), call('audio:measure', { sourcePath: src, start: 2, end: 3 })]);
    assert.deepEqual([p.peakDb, p.meanDb], [q.peakDb, q.meanDb]);

    // o arquivo foi trocado por outro, mais baixo (mesmo nome): a medição antiga não vale mais
    fx.makeTone(src, { seconds: 8, volumeDb: -12 });
    const changed = await call('audio:measure', { sourcePath: src, start: 1, end: 4 });
    assert.equal(changed.cached, false);
    near(changed.peakDb - first.peakDb, -12, 0.3, 'nível do arquivo novo');

    // fonte sem áudio: aviso (hasAudio:false), não erro
    const noAudio = fx.makeVideo(path.join(dir, 'sem-audio.mp4'), { seconds: 3, audio: false });
    const res = await call('audio:measure', { sourcePath: noAudio, start: 0, end: 2 });
    assert.deepEqual([res.ok, res.hasAudio, res.peakDb, res.meanDb], [true, false, null, null]);

  } finally { fx.removeDir(dir); }
});

test('medir não altera a fonte (hash igual) nem deixa arquivos pela pasta', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('audioipc');
  try {
    const { call } = makeCtx(path.join(dir, 'u'), { ffmpeg: fx.tools.ffmpeg, ffprobe: fx.tools.ffprobe });
    const media = path.join(dir, 'media');
    fs.mkdirSync(media);
    const src = fx.makeVideo(path.join(media, 'live.mp4'), { seconds: 5, volumeDb: -3 });
    const before = { hash: fx.sha256(src), files: fs.readdirSync(media), stat: fs.statSync(src) };
    for (const [s, e] of [[0, 2], [1, 3], [2, 5]]) assert.equal((await call('audio:measure', { sourcePath: src, start: s, end: e })).ok, true);
    assert.equal(fx.sha256(src), before.hash);
    assert.deepEqual(fs.readdirSync(media), before.files, 'nenhum arquivo novo ao lado da fonte');
    assert.equal(fs.statSync(src).mtimeMs, before.stat.mtimeMs);
  } finally { fx.removeDir(dir); }
});

test('ao fechar o app (before-quit) sem medição em andamento o ouvinte não faz nada e não quebra', () => {
  const dir = fx.tmpDir('audioipc');
  try {
    const { quitListeners } = makeCtx(dir, { ffmpeg: null, ffprobe: null });
    assert.equal(quitListeners.length, 1);
    quitListeners[0]();
  } finally { fx.removeDir(dir); }
});

test('ao fechar o app (before-quit) a medição em andamento é cancelada e o processo do ffmpeg termina', async () => {
  // O "ffmpeg" desta prova é um processo que nunca termina sozinho: a medição fica em andamento sem depender do tempo
  // de decodificação, e dá para conferir que o processo realmente morre (o abort do ffmpeg de verdade, lendo uma
  // fonte parada, está em tests/audio-measure.test.js). Os módulos são carregados de novo para enxergarem o spawn trocado.
  const childProcess = require('node:child_process');
  const realSpawn = childProcess.spawn;
  const spawned = [];
  const closed = [];
  childProcess.spawn = (command, args, options) => {
    const child = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    child.on('close', () => closed.push(child.pid));
    spawned.push(child);
    return child;
  };
  const measurePath = require.resolve('../src/core/audio/measure');
  const handlerPath = require.resolve('../src/ipc/handlers/audio');
  delete require.cache[measurePath];
  delete require.cache[handlerPath];
  const dir = fx.tmpDir('audioipc');
  try {
    const { call, quitListeners } = makeCtx(path.join(dir, 'u'), { ffmpeg: process.execPath, ffprobe: null }, require(handlerPath));
    const source = path.join(dir, 'fonte.wav');
    fs.writeFileSync(source, 'qualquer coisa: quem lê é o processo de mentira');

    const pending = call('audio:measure', { sourcePath: source, start: 0, end: 5 });
    const outcome = pending.then((res) => res, (err) => ({ threw: err }));
    const end = Date.now() + 10000;
    while (!spawned.length && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(spawned.length, 1, 'a medição iniciou o processo');
    assert.equal(spawned[0].exitCode, null, 'e ele continua rodando (a medição está em andamento)');
    const same = call('audio:measure', { sourcePath: source, start: 0, end: 5 }); // pedido igual: divide a mesma medição
    const sameOutcome = same.then((res) => res, (err) => ({ threw: err }));

    quitListeners[0]();

    const orTimeout = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve({ code: 'SEM_RESPOSTA', message: 'a medição não foi cancelada em 10 s' }), 10000))]);
    const res = await orTimeout(outcome);
    const err = res.threw || res;
    assert.equal(err.code, 'CANCELLED', `resposta: ${JSON.stringify(res.message || res)}`);
    const sameRes = await orTimeout(sameOutcome);
    assert.equal((sameRes.threw || sameRes).code, 'CANCELLED', 'quem dividia a medição também é cancelado');
    const waitEnd = Date.now() + 10000;
    while (!closed.length && Date.now() < waitEnd) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(closed, [spawned[0].pid], 'o processo do ffmpeg terminou');
    assert.equal(spawned.length, 1, 'e o pedido repetido não abriu um segundo processo');
    assert.throws(() => process.kill(spawned[0].pid, 0), (e) => e.code === 'ESRCH', 'nenhum processo sobrando');
  } finally {
    childProcess.spawn = realSpawn;
    delete require.cache[measurePath];
    delete require.cache[handlerPath];
    for (const child of spawned) { try { child.kill(); } catch { /* já terminou */ } }
    fx.removeDir(dir);
  }
});

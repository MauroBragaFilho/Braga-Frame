'use strict';

/** Proxy de visualização (src/core/proxy/ProxyManager.js): com ffmpeg falso (progresso, erro, cancelamento, um por vez, limpeza) e com o ffmpeg de verdade. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ProxyManager, ProxyError, buildProxyArgs, explainFailure } = require('../src/core/proxy/ProxyManager');
const fx = require('./export-fixtures');

const { tools, skipMedia } = fx;
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (cond, what = 'a condição', ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await tick(); }
  throw new Error(`tempo esgotado esperando ${what}`);
};

function withDir(fn) {
  return async () => {
    const dir = fx.tmpDir();
    try { await fn(dir); } finally { fx.cleanup(dir); }
  };
}

const makeSource = (dir, name = 'live.mkv') => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'video de mentira');
  return file;
};

/** ffmpeg falso: escreve o arquivo de saída ao terminar (se `write`), emite progresso e sai com `code`. */
function fakeSpawn({ code = 0, write = true, stderr = '', progress = [], hang = false } = {}) {
  const calls = [];
  const spawnFn = (exe, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 0;
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null)); };
    calls.push({ exe, args, child });
    const output = args[args.length - 1];
    setImmediate(() => {
      for (const us of progress) child.stdout.emit('data', `out_time_us=${us}\n`);
      if (hang) return;
      if (stderr) child.stderr.emit('data', stderr);
      if (write && code === 0) fs.writeFileSync(output, Buffer.alloc(4096, 1));
      child.emit('close', code);
    });
    return child;
  };
  return { spawnFn, calls };
}

const manager = (dir, extra = {}) => new ProxyManager({
  dir: path.join(dir, 'proxy'), getTools: () => ({ ffmpeg: 'ffmpeg-falso', ffprobe: 'ffprobe-falso' }),
  keyOf: (file) => path.basename(file).replace(/\W/g, '_'), probe: async () => ({ duration: 100, hasAudio: true }), ...extra
});

const once = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));

test('buildProxyArgs: 720p, H.264, AAC estéreo alinhado, faststart, sem metadados; sem áudio vira -an', () => {
  const args = buildProxyArgs({ input: 'in.mkv', output: 'out.mp4.part' });
  const has = (...seq) => args.join('\u0001').includes(seq.join('\u0001'));
  assert.ok(has('-c:v', 'libx264') && has('-crf', '28') && has('-g', '30'));
  assert.ok(has('-c:a', 'aac', '-b:a', '96k', '-ac', '2'));
  assert.ok(args.includes('aresample=async=1:first_pts=0'));
  assert.ok(has('-movflags', '+faststart') && has('-map_metadata', '-1'));
  assert.ok(args.some((a) => a.startsWith('scale=') && a.includes('min(1280,iw)') && a.includes('min(720,iw)') && a.includes('format=yuv420p')));
  assert.equal(args.at(-1), 'out.mp4.part');
  assert.equal(args[args.indexOf('-i') + 1], 'in.mkv');
  const silent = buildProxyArgs({ input: 'a', output: 'b', withAudio: false });
  assert.ok(silent.includes('-an'));
  assert.ok(!silent.includes('aac'));
});

test('explainFailure: disco cheio, codificador ausente e erro comum com a última linha do ffmpeg', () => {
  assert.equal(explainFailure('Error writing: No space left on device').code, 'NO_DISK_SPACE');
  assert.equal(explainFailure("Unknown encoder 'libx264'").code, 'CODEC_UNSUPPORTED');
  const generic = explainFailure('linha 1\nInvalid data found when processing input\n');
  assert.equal(generic.code, 'PROXY_FAILED');
  assert.match(generic.message, /Invalid data found/);
});

test('ensure valida o pedido: caminho completo, arquivo existente e ffmpeg presente', withDir(async (dir) => {
  const m = manager(dir);
  await assert.rejects(() => m.ensure('relativo.mkv'), (e) => e instanceof ProxyError && e.code === 'INVALID_PATH');
  await assert.rejects(() => m.ensure(path.join(dir, 'nao-existe.mkv')), (e) => e.code === 'INPUT_MISSING');
  const noTools = new ProxyManager({ dir: path.join(dir, 'p'), getTools: () => ({}), keyOf: () => 'k' });
  await assert.rejects(() => noTools.ensure(makeSource(dir)), (e) => e.code === 'NO_FFMPEG' && /FFmpeg/.test(e.message));
}));

test('cria a cópia: progresso pelo tempo do vídeo, grava .part e só depois renomeia; a segunda chamada já vem pronta', withDir(async (dir) => {
  const fake = fakeSpawn({ progress: [10e6, 50e6, 90e6] });
  const m = manager(dir, { spawnFn: fake.spawnFn });
  const file = makeSource(dir);
  const progress = [];
  m.on('progress', (e) => progress.push(Math.round(e.p * 100)));
  const first = await m.ensure(file);
  assert.equal(first.state, 'running');
  const done = await once(m, 'done');
  assert.equal(done.file, file);
  assert.equal(done.proxyPath, path.join(dir, 'proxy', 'live_mkv.mp4'));
  assert.ok(fs.existsSync(done.proxyPath));
  assert.ok(!fs.existsSync(`${done.proxyPath}.part`), 'nunca sobra .part');
  assert.deepEqual(progress.slice(0, 3), [10, 50, 90]);
  assert.equal(progress.at(-1), 100);
  assert.equal(fake.calls[0].args.at(-1), `${done.proxyPath}.part`, 'o ffmpeg grava em .part');
  const again = await m.ensure(file);
  assert.deepEqual([again.state, again.proxyPath], ['ready', done.proxyPath]);
  assert.equal(fake.calls.length, 1, 'cópia pronta: nenhum ffmpeg novo');
  assert.equal(m.status(file).state, 'ready');
}));

test('falha do ffmpeg: evento failed com causa em português e nenhum arquivo (nem .part) fica', withDir(async (dir) => {
  const fake = fakeSpawn({ code: 1, stderr: 'Invalid data found when processing input\n' });
  const m = manager(dir, { spawnFn: fake.spawnFn });
  const file = makeSource(dir);
  await m.ensure(file);
  const failed = await once(m, 'failed');
  assert.equal(failed.code, 'PROXY_FAILED');
  assert.match(failed.message, /cópia leve/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'proxy')), []);
  assert.equal(m.status(file).state, 'none');
  assert.equal(m.job, null);
}));

test('cancelar mata o ffmpeg, emite cancelled e não deixa .part; abrir outro vídeo cancela o anterior (um por vez)', withDir(async (dir) => {
  const fake = fakeSpawn({ hang: true });
  const m = manager(dir, { spawnFn: fake.spawnFn });
  const a = makeSource(dir, 'a.mkv');
  const b = makeSource(dir, 'b.mkv');
  await m.ensure(a);
  await waitFor(() => fake.calls.length === 1);
  const cancelledA = once(m, 'cancelled');
  fs.writeFileSync(`${m.proxyPathFor(a)}.part`, 'parcial');
  await m.ensure(b);
  assert.equal((await cancelledA).file, a);
  assert.equal(fake.calls[0].child.killed, true);
  await waitFor(() => fake.calls.length === 2);
  assert.equal(m.job.file, b);
  assert.ok(!fs.existsSync(`${m.proxyPathFor(a)}.part`));
  const cancelledB = once(m, 'cancelled');
  assert.equal(m.cancel(), true);
  await cancelledB;
  assert.equal(m.cancel(), false, 'nada rodando');
  m.shutdown();
  await assert.rejects(() => m.ensure(a), (e) => e.code === 'CLOSED');
}));

test('limpeza: acima do limite os proxies mais antigos saem; o que acabou de ficar pronto fica', withDir(async (dir) => {
  const fake = fakeSpawn();
  const m = manager(dir, { spawnFn: fake.spawnFn, maxBytes: 9000 });
  fs.mkdirSync(path.join(dir, 'proxy'), { recursive: true });
  const old = path.join(dir, 'proxy', 'antigo.mp4');
  const mid = path.join(dir, 'proxy', 'meio.mp4');
  fs.writeFileSync(old, Buffer.alloc(4096, 1));
  fs.writeFileSync(mid, Buffer.alloc(4096, 1));
  fs.utimesSync(old, new Date(2020, 1, 1), new Date(2020, 1, 1));
  fs.utimesSync(mid, new Date(2021, 1, 1), new Date(2021, 1, 1));
  await m.ensure(makeSource(dir));
  await once(m, 'done'); // 3 x 4096 > 9000: o mais antigo sai
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(mid));
  assert.ok(fs.existsSync(path.join(dir, 'proxy', 'live_mkv.mp4')));
}));

test('com o ffmpeg de verdade: H.264, no máximo 720 de altura (ou largura, se for vertical), AAC estéreo, a MESMA duração do original e nenhum .part', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir();
  try {
    const src = path.join(dir, 'fonte.mp4');
    fx.makeCodedSource(src, { width: 1920, height: 1080, fps: 30, seconds: 4 });
    const m = new ProxyManager({ dir: path.join(dir, 'proxy'), getTools: () => tools });
    const first = await m.ensure(src);
    assert.equal(first.state, 'running');
    const done = await once(m, 'done');
    const info = fx.probeStreams(done.proxyPath);
    const video = info.streams.find((s) => s.codec_type === 'video');
    const audio = info.streams.find((s) => s.codec_type === 'audio');
    assert.equal(video.codec_name, 'h264');
    assert.deepEqual([video.width, video.height], [1280, 720]);
    assert.equal(video.pix_fmt, 'yuv420p');
    assert.equal(audio.codec_name, 'aac');
    assert.equal(audio.channels, 2);
    const original = fx.probeStreams(src);
    assert.ok(Math.abs(Number(info.format.duration) - Number(original.format.duration)) < 0.15, `duração ${info.format.duration} x ${original.format.duration}`);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'proxy')).filter((f) => f.endsWith('.part')), []);
    assert.equal((await m.ensure(src)).state, 'ready');

    // um vídeo vertical: a menor medida é a largura (720)
    const tall = path.join(dir, 'vertical.mp4');
    fx.makeCodedSource(tall, { width: 1080, height: 1920, fps: 30, seconds: 2 });
    await m.ensure(tall);
    const tallDone = await once(m, 'done');
    const tv = fx.probeStreams(tallDone.proxyPath).streams.find((s) => s.codec_type === 'video');
    assert.deepEqual([tv.width, tv.height], [720, 1280]);
  } finally { fx.cleanup(dir); }
});

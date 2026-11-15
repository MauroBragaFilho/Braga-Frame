'use strict';

/**
 * Miniaturas dos projetos (src/core/projects/thumbnails.js). A fila, o prazo, o cancelamento e a falha usam um `spawn` de mentira que
 * imita o ffmpeg (nada de mock do que está sendo testado: o ThumbnailCache é o de verdade); o quadro de verdade, com o ffmpeg do sistema,
 * é conferido no último teste e no e2e da aba Projetos.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ThumbnailCache, thumbTime } = require('../src/core/projects/thumbnails');
const { projectIdFor } = require('../src/core/projects/projectStore');
const { locateTools } = require('../src/core/ffmpeg/locate');

const tools = locateTools();
const ffmpegPath = tools.ffmpeg;
const ffprobePath = tools.ffprobe;
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(400, 1), Buffer.from([0xff, 0xd9])]);

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-thumb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

/** Vídeo "de verdade" só no nome: o ThumbnailCache confere que o arquivo existe e o ffmpeg falso não lê nada. */
function fakeVideo(dir, name = 'live.mp4') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(4096, 5));
  return file;
}

const source = (file, extra = {}) => ({ id: projectIdFor(file), path: file, size: 4096, duration: 3600, ...extra });

/**
 * ffmpeg falso. Cada chamada vira um registro em `calls` ({ args, finish(code?, data?) }); sem `hang` o processo "termina" sozinho no
 * próximo ciclo com o quadro de mentira. `kill()` (cancelar/prazo) encerra como o ffmpeg de verdade: o evento close sai sem código.
 */
function fakeSpawn({ hang = false, exitCode = 0, data = FAKE_JPEG } = {}) {
  const calls = [];
  let running = 0;
  let peak = 0;
  const spawn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 0; // sem pid o runFfmpeg não mexe na prioridade
    let ended = false;
    running += 1;
    peak = Math.max(peak, running);
    const end = (code) => {
      if (ended) return;
      ended = true;
      running -= 1;
      child.stdout.end();
      child.emit('close', code);
    };
    child.kill = () => end(null);
    const record = { cmd, args, finish: (code = exitCode, bytes = data) => { if (ended) return; if (bytes && code === 0) child.stdout.write(bytes); end(code); } };
    calls.push(record);
    if (!hang) setImmediate(() => record.finish());
    return child;
  };
  Object.defineProperties(spawn, { calls: { get: () => calls }, peak: { get: () => peak }, running: { get: () => running } });
  return spawn;
}

const cacheWith = (dir, spawn, extra = {}) => new ThumbnailCache({ dir: path.join(dir, 'thumbs'), getFfmpeg: () => 'ffmpeg-falso', spawn, ...extra });
const ssOf = (args) => Number(args[args.indexOf('-ss') + 1]);

test('thumbTime: 10% da duração entre 5 s e 10 min; vídeo curto usa o meio; sem duração, 5 s', () => {
  assert.equal(thumbTime(3 * 3600), 600, 'live de 3 h: teto de 10 min');
  assert.equal(thumbTime(3600), 360);
  assert.equal(thumbTime(100), 10);
  assert.equal(thumbTime(40), 5, 'piso de 5 s');
  assert.equal(thumbTime(20), 10, 'menos de 30 s: o meio');
  assert.equal(thumbTime(5), 2.5);
  for (const none of [0, -3, NaN, undefined, null, 'x']) assert.equal(thumbTime(none), 5, String(none));
});

test('gera a miniatura uma vez (quadro em 10% do vídeo, 320 px), guarda em <id>.<chave>.jpg e as chamadas seguintes vêm do disco', async (t) => {
  const dir = tmpDir(t);
  const file = fakeVideo(dir);
  const spawn = fakeSpawn();
  const cache = cacheWith(dir, spawn);
  const src = source(file);
  const first = await cache.get(src);
  assert.equal(first.state, 'ready');
  assert.ok(first.url.startsWith('file:') && /\.jpg\?v=\d+$/.test(first.url), first.url);
  assert.equal(fs.readFileSync(first.file).equals(FAKE_JPEG), true, 'o arquivo é o JPEG que o ffmpeg entregou');
  assert.equal(path.basename(first.file).startsWith(`${src.id}.`), true);
  assert.equal(spawn.calls.length, 1);
  const args = spawn.calls[0].args;
  assert.equal(ssOf(args), 360, 'quadro em 10% de 1 h');
  assert.ok(args.includes(file) && args.includes('-frames:v') && args.includes('image2pipe'));
  assert.ok(args.some((a) => /^scale=320:-2/.test(a)), 'largura de 320 px');
  const again = await cache.get(src);
  assert.equal(again.state, 'ready');
  assert.equal(again.url, first.url);
  assert.equal(spawn.calls.length, 1, 'a segunda vez não chama o ffmpeg');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'thumbs')), [path.basename(first.file)], 'nenhum arquivo temporário sobra');
});

test('a chave segue o caminho, o tamanho e a duração: o arquivo mudou, a miniatura é refeita e a antiga sai', async (t) => {
  const dir = tmpDir(t);
  const file = fakeVideo(dir);
  const spawn = fakeSpawn();
  const cache = cacheWith(dir, spawn);
  const a = await cache.get(source(file));
  const b = await cache.get(source(file, { size: 9999 }));
  assert.notEqual(a.file, b.file);
  assert.equal(spawn.calls.length, 2);
  assert.equal(fs.existsSync(a.file), false, 'a miniatura da versão antiga foi removida');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'thumbs')), [path.basename(b.file)]);
  const c = await cache.get(source(file, { size: 9999, duration: 7200 }));
  assert.notEqual(b.file, c.file);
  assert.equal(ssOf(spawn.calls[2].args), 600);
});

test('pedidos iguais ao mesmo tempo viram um só; no máximo `concurrency` ffmpegs juntos e os outros esperam a vez', async (t) => {
  const dir = tmpDir(t);
  const spawn = fakeSpawn({ hang: true });
  const cache = cacheWith(dir, spawn, { concurrency: 2 });
  const sources = ['a', 'b', 'c', 'd', 'e'].map((n) => source(fakeVideo(dir, `${n}.mp4`)));
  const results = sources.map((s) => cache.get(s));
  const twin = cache.get(sources[0]);
  await tick(20);
  assert.equal(spawn.calls.length, 2, 'só duas vagas');
  assert.equal(spawn.running, 2);
  spawn.calls[0].finish();
  await tick(20);
  assert.equal(spawn.calls.length, 3, 'a vaga liberada vai para o próximo da fila');
  for (let i = 0; i < 20 && !(spawn.calls.length === 5 && spawn.running === 0); i += 1) {
    for (const c of spawn.calls) if (!c.done) { c.done = true; c.finish(); }
    await tick(20);
  }
  const all = await Promise.all(results);
  assert.ok(all.every((r) => r.state === 'ready'), JSON.stringify(all.map((r) => r.state)));
  assert.equal((await twin).file, all[0].file, 'o pedido repetido recebeu o mesmo resultado');
  assert.equal(spawn.calls.length, 5, 'um ffmpeg por vídeo (o pedido repetido não gerou outro)');
  assert.ok(spawn.peak <= 2, `no máximo 2 ao mesmo tempo (houve ${spawn.peak})`);
});

test('falha: o instante sem quadro tenta o começo; se também falha vira FAILED e não é repetida por um minuto', async (t) => {
  const dir = tmpDir(t);
  const file = fakeVideo(dir);
  const spawn = fakeSpawn({ exitCode: 1 });
  let clock = 1000;
  const cache = cacheWith(dir, spawn, { now: () => clock });
  const src = source(file);
  const first = await cache.get(src);
  assert.deepEqual(first, { state: 'none', reason: 'FAILED' });
  assert.equal(spawn.calls.length, 2, 'o instante e depois o começo do vídeo');
  assert.deepEqual(spawn.calls.map((c) => ssOf(c.args)), [360, 0]);
  const second = await cache.get(src);
  assert.equal(second.state, 'none');
  assert.equal(spawn.calls.length, 2, 'dentro de um minuto não tenta de novo');
  clock += 61000;
  await cache.get(src);
  assert.equal(spawn.calls.length, 4, 'passado o minuto, tenta de novo');
  // saída que não é JPEG também é falha
  const dir2 = tmpDir(t);
  const bad = fakeSpawn({ data: Buffer.from('isto não é uma imagem'.repeat(30)) });
  const res = await cacheWith(dir2, bad).get(source(fakeVideo(dir2)));
  assert.equal(res.state, 'none');
});

test('prazo estourado: o ffmpeg é encerrado, vira FAILED e a vaga volta para a fila', async (t) => {
  const dir = tmpDir(t);
  const spawn = fakeSpawn({ hang: true });
  const cache = cacheWith(dir, spawn, { timeoutMs: 40, concurrency: 1 });
  const res = await cache.get(source(fakeVideo(dir)));
  assert.deepEqual(res, { state: 'none', reason: 'FAILED' });
  assert.equal(spawn.running, 0, 'o processo foi encerrado');
  assert.equal(cache.active, 0, 'a vaga foi devolvida');
  const next = fakeVideo(dir, 'outro.mp4');
  const pending = cache.get(source(next));
  await tick(10);
  assert.equal(spawn.calls.length >= 2, true, 'o próximo já pôde começar');
  await pending;
});

test('cancel(id): o que está rodando e o que espera resolvem CANCELLED, sem contar como falha do vídeo', async (t) => {
  const dir = tmpDir(t);
  const spawn = fakeSpawn({ hang: true });
  const cache = cacheWith(dir, spawn, { concurrency: 1 });
  const a = source(fakeVideo(dir, 'a.mp4'));
  const b = source(fakeVideo(dir, 'b.mp4'));
  const running = cache.get(a);
  const waiting = cache.get(b);
  await tick(15);
  assert.equal(spawn.calls.length, 1);
  cache.cancel(b.id);
  assert.equal((await waiting).reason, 'CANCELLED', 'quem esperava a vez sai na hora');
  cache.cancel(a.id);
  assert.equal((await running).reason, 'CANCELLED');
  assert.equal(spawn.running, 0);
  // cancelar não envenena o vídeo: um pedido novo gera normalmente
  const ok = fakeSpawn();
  const again = await cacheWith(dir, ok).get(a);
  assert.equal(again.state, 'ready');
});

test('vídeo que sumiu: sem ffmpeg ("missing"), ou com a miniatura que já existia; sem ffmpeg instalado: NO_FFMPEG; id ou caminho inválido', async (t) => {
  const dir = tmpDir(t);
  const file = fakeVideo(dir);
  const spawn = fakeSpawn();
  const cache = cacheWith(dir, spawn);
  const src = source(file);
  const made = await cache.get(src);
  fs.rmSync(file);
  const gone = await cache.get(src);
  assert.equal(gone.state, 'ready', 'a miniatura guardada continua valendo quando o vídeo some');
  assert.equal(gone.file, made.file);
  const changed = await cache.get(source(file, { size: 1 }));
  assert.equal(changed.state, 'ready', 'chave nova com o vídeo inacessível: vale a miniatura mais recente que existe');
  assert.equal(changed.file, made.file);
  const other = source(path.join(dir, 'nunca existiu.mp4'));
  assert.deepEqual(await cache.get(other), { state: 'missing' });
  assert.equal(spawn.calls.length, 1, 'só a primeira geração chamou o ffmpeg');
  const noTool = new ThumbnailCache({ dir: path.join(dir, 'thumbs2'), getFfmpeg: () => null, spawn });
  const f2 = fakeVideo(dir, 'dois.mp4');
  assert.deepEqual(await noTool.get(source(f2)), { state: 'none', reason: 'NO_FFMPEG' });
  for (const bad of [null, {}, { id: 'x', path: file }, { id: src.id }, { id: src.id, path: '' }]) assert.equal((await cache.get(bad)).state, 'none', JSON.stringify(bad));
});

test('com o ffmpeg do sistema: um quadro JPEG de verdade, largura 320 px', { skip: ffmpegPath && ffprobePath ? false : 'ffmpeg/ffprobe não encontrados' }, async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'real.mp4');
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=10:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file], { windowsHide: true });
  const cache = new ThumbnailCache({ dir: path.join(dir, 'thumbs'), getFfmpeg: () => ffmpegPath });
  const res = await cache.get({ id: projectIdFor(file), path: file, size: fs.statSync(file).size, duration: 6 });
  assert.equal(res.state, 'ready', JSON.stringify(res));
  const bytes = fs.readFileSync(res.file);
  assert.ok(bytes.length > 1000 && bytes[0] === 0xff && bytes[1] === 0xd8, 'JPEG de verdade');
  const probe = execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', res.file], { encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(probe, '320,180', 'o quadro de 640x360 vira 320x180');
  // vídeo que o ffmpeg não consegue abrir: FAILED, sem arquivo e sem lançar
  const broken = path.join(dir, 'quebrado.mp4');
  fs.writeFileSync(broken, 'isto não é um vídeo');
  const bad = await cache.get({ id: projectIdFor(broken), path: broken, size: 19, duration: 10 });
  assert.deepEqual(bad, { state: 'none', reason: 'FAILED' });
});

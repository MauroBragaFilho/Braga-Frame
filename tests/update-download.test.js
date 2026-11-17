'use strict';

/**
 * Download e conferência do instalador (src/core/update/download.js) com um servidor HTTP local de verdade e o fetch real: tamanho, SHA-256,
 * redirecionamento para fora do GitHub, Content-Length, espaço em disco, cancelamento e o que NUNCA pode sobrar no disco (um .part ou um arquivo errado).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const D = require('../src/core/update/download');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const NAME = 'braga-frame-0.2.0-windows-x64-setup.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-upd-dl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function serve(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => { requests.push(req.url); handler(req, res, server); });
  return new Promise((resolve) => server.listen(0, () => {
    t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
    resolve({ port: server.address().port, requests, base: `http://127.0.0.1:${server.address().port}` });
  }));
}

const assetFor = (buf, base, over = {}) => ({ name: NAME, url: `${base}/dl/${NAME}`, size: buf.length, sha256: sha(buf), ...over });
const onlyLoopback = (host) => host === '127.0.0.1';
const left = (dir) => fs.readdirSync(dir);

test('baixa, confere tamanho e SHA-256 e entrega o arquivo com o nome final; o progresso só cresce e termina em 100%', async (t) => {
  const dir = tmp(t);
  const buf = crypto.randomBytes(3 * 1024 * 1024);
  const srv = await serve(t, (req, res) => { res.writeHead(200, { 'Content-Length': buf.length }); res.end(buf); });
  const seen = [];
  const res = await D.downloadInstaller({ asset: assetFor(buf, srv.base), dir, allowHost: onlyLoopback, onProgress: (p) => seen.push(p) });
  assert.equal(res.file, path.join(dir, NAME));
  assert.equal(res.sha256, sha(buf));
  assert.ok(buf.equals(fs.readFileSync(res.file)), 'o conteúdo é idêntico');
  assert.deepEqual(left(dir), [NAME], 'nada de .part sobrando');
  assert.deepEqual([seen.at(-1).percent, seen.at(-1).received, seen.at(-1).total], [100, buf.length, buf.length]);
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i].received >= seen[i - 1].received, 'progresso nunca recua');
  assert.equal(await D.hashFile(res.file), sha(buf));
  assert.equal(D.hashFileSync(res.file), sha(buf));
});

test('já existe um instalador com o mesmo nome e um .part velho: os dois dão lugar ao arquivo novo', async (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, NAME), 'velho');
  fs.writeFileSync(path.join(dir, `${NAME}.part`), 'lixo de uma tentativa interrompida');
  const buf = crypto.randomBytes(200 * 1024);
  const srv = await serve(t, (req, res) => { res.writeHead(200, { 'Content-Length': buf.length }); res.end(buf); });
  await D.downloadInstaller({ asset: assetFor(buf, srv.base), dir, allowHost: onlyLoopback });
  assert.ok(buf.equals(fs.readFileSync(path.join(dir, NAME))));
  assert.deepEqual(left(dir), [NAME]);
});

test('SHA-256 que não confere: recusa (HASH) e não deixa arquivo nenhum', async (t) => {
  const dir = tmp(t);
  const real = crypto.randomBytes(100 * 1024);
  const evil = Buffer.from(real);
  evil[500] ^= 0xff; // mesmo tamanho, outro conteúdo
  const srv = await serve(t, (req, res) => { res.writeHead(200, { 'Content-Length': evil.length }); res.end(evil); });
  await assert.rejects(D.downloadInstaller({ asset: assetFor(real, srv.base), dir, allowHost: onlyLoopback }), (e) => e.code === 'HASH' && /SHA-256/.test(e.message) && /Nada foi instalado/.test(e.message));
  assert.deepEqual(left(dir), []);
});

test('tamanho diferente do informado pela Release: pelo Content-Length (antes de baixar) ou passando do esperado (no meio); sempre SIZE e sem sobras', async (t) => {
  const dir = tmp(t);
  const buf = crypto.randomBytes(100 * 1024);
  const bigger = await serve(t, (req, res) => { res.writeHead(200, { 'Content-Length': buf.length + 10 }); res.end(Buffer.concat([buf, Buffer.alloc(10)])); });
  await assert.rejects(D.downloadInstaller({ asset: assetFor(buf, bigger.base), dir, allowHost: onlyLoopback }), (e) => e.code === 'SIZE');
  // sem Content-Length (chunked), mandando MAIS do que o esperado: para quando passa
  const chunked = await serve(t, (req, res) => { res.writeHead(200); res.write(buf); res.write(Buffer.alloc(50 * 1024)); res.end(); });
  await assert.rejects(D.downloadInstaller({ asset: assetFor(buf, chunked.base), dir, allowHost: onlyLoopback }), (e) => e.code === 'SIZE');
  // mandando MENOS (chunked): o final não bate
  const shorter = await serve(t, (req, res) => { res.writeHead(200); res.end(buf.subarray(0, 1000)); });
  await assert.rejects(D.downloadInstaller({ asset: assetFor(buf, shorter.base), dir, allowHost: onlyLoopback }), (e) => e.code === 'SIZE');
  assert.deepEqual(left(dir), []);
});

test('erro do servidor (404, 500) vira HTTP; servidor fora do ar vira NETWORK; nada sobra', async (t) => {
  const dir = tmp(t);
  const buf = crypto.randomBytes(1000);
  for (const status of [404, 500, 503]) {
    const srv = await serve(t, (req, res) => { res.writeHead(status); res.end('x'); });
    await assert.rejects(D.downloadInstaller({ asset: assetFor(buf, srv.base), dir, allowHost: onlyLoopback }), (e) => e.code === 'HTTP', String(status));
  }
  // uma porta que ninguém escuta (aberta e fechada logo em seguida)
  const closedPort = await new Promise((r) => { const s = http.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => r(port)); }); });
  await assert.rejects(D.downloadInstaller({ asset: assetFor(buf, `http://127.0.0.1:${closedPort}`), dir, allowHost: onlyLoopback }), (e) => e.code === 'NETWORK');
  assert.deepEqual(left(dir), []);
});

test('redirecionamento para fora do GitHub é recusado (HOST); redirecionamento dentro do permitido funciona', async (t) => {
  const dir = tmp(t);
  const buf = crypto.randomBytes(50 * 1024);
  const target = await serve(t, (req, res) => { res.writeHead(200, { 'Content-Length': buf.length }); res.end(buf); });
  const outside = await serve(t, (req, res) => { res.writeHead(302, { Location: `http://localhost:${target.port}/blob` }); res.end(); });
  await assert.rejects(D.downloadInstaller({ asset: assetFor(buf, outside.base), dir, allowHost: onlyLoopback }), (e) => e.code === 'HOST' && /não é do GitHub/.test(e.message));
  assert.deepEqual(left(dir), []);
  const inside = await serve(t, (req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${target.port}/blob` }); res.end(); });
  const ok = await D.downloadInstaller({ asset: assetFor(buf, inside.base), dir, allowHost: onlyLoopback });
  assert.equal(ok.sha256, sha(buf));
});

test('o padrão aceita github.com e githubusercontent.com (para onde o GitHub redireciona os downloads) e nada além', () => {
  for (const host of ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']) assert.equal(D.GITHUB_HOST(host), true, host);
  for (const host of ['evil.example', 'githubusercontent.com.evil.example', 'notgithub.com', 'github.com.evil.example', 'xgithubusercontent.com', '']) assert.equal(D.GITHUB_HOST(host), false, host);
});

test('sem espaço em disco: recusa (DISK) ANTES de pedir qualquer coisa ao servidor', async (t) => {
  const dir = tmp(t);
  const buf = crypto.randomBytes(1000);
  const srv = await serve(t, (req, res) => { res.writeHead(200); res.end(buf); });
  await assert.rejects(D.downloadInstaller({ asset: assetFor(buf, srv.base), dir, allowHost: onlyLoopback, free: () => 1000 }), (e) => e.code === 'DISK');
  assert.equal(srv.requests.length, 0);
  const free = await D.downloadInstaller({ asset: assetFor(buf, srv.base), dir, allowHost: onlyLoopback, free: () => null }); // sistema que não informa: não bloqueia
  assert.equal(free.size, 1000);
  assert.ok(D.freeBytes(dir) > 0, 'freeBytes lê o espaço livre de verdade');
});

test('cancelar no meio: CANCELLED, nenhum arquivo, e o servidor percebe a conexão fechada', async (t) => {
  const dir = tmp(t);
  const buf = crypto.randomBytes(2 * 1024 * 1024);
  let closed = false;
  const srv = await serve(t, async (req, res) => {
    res.writeHead(200, { 'Content-Length': buf.length });
    res.on('close', () => { closed = true; });
    for (let i = 0; i < buf.length && !res.destroyed; i += 64 * 1024) { res.write(buf.subarray(i, i + 64 * 1024)); await sleep(30); }
    res.end();
  });
  const controller = new AbortController();
  const job = D.downloadInstaller({ asset: assetFor(buf, srv.base), dir, allowHost: onlyLoopback, signal: controller.signal, onProgress: (p) => { if (p.received > 200 * 1024) controller.abort(); } });
  await assert.rejects(job, (e) => e.code === 'CANCELLED');
  assert.deepEqual(left(dir), []);
  await sleep(300);
  assert.equal(closed, true);
});

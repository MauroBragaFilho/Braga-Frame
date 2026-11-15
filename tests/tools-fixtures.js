'use strict';

/**
 * Utilitários dos testes de ferramentas (tests/tools*.test.js): gera .zip e .tar.gz de verdade
 * (inclusive malformados, para zip-slip) e sobe um servidor HTTP local (node:http).
 * Não é um teste: o nome não termina em ".test.js".
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Pasta temporária própria do teste (apague com cleanup(dir) no finally). */
function tmpDir(prefix = 'bf-tools-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

// ------------------------------------------------------------------ zip

/** @param {{name:string, data?:string|Buffer, store?:boolean}[]} files  (nome terminado em "/" = pasta) */
function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const isDir = f.name.endsWith('/');
    const data = isDir ? Buffer.alloc(0) : Buffer.from(f.data === undefined ? '' : f.data);
    const crc = zlib.crc32(data);
    const deflate = !f.store && !isDir && data.length > 0;
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);           // nomes em UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);            // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((isDir ? 0o40755 : 0o100755) << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);

    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

// ------------------------------------------------------------------ tar.gz

function tarHeader({ name, size = 0, type = '0', mode = 0o755, linkname = '' }) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

/** @param {{name:string, data?:string|Buffer, type?:string, linkname?:string}[]} files  (type '5' = pasta, '2' = link simbólico) */
function makeTarGz(files) {
  const blocks = [];
  for (const f of files) {
    const isDir = f.type === '5' || f.name.endsWith('/');
    const data = isDir || f.type === '2' ? Buffer.alloc(0) : Buffer.from(f.data === undefined ? '' : f.data);
    blocks.push(tarHeader({ name: f.name, size: data.length, type: f.type || (isDir ? '5' : '0'), linkname: f.linkname || '', mode: isDir ? 0o755 : 0o755 }));
    if (data.length) {
      blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

// ------------------------------------------------------------------ servidor

/**
 * Servidor HTTP local em porta livre. `handler(req, res, ctx)` recebe as requisições;
 * ctx.requests acumula { url, method } de tudo que chegou. close() derruba as conexões abertas.
 */
async function startServer(handler) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method });
    handler(req, res, { requests });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    requests,
    url: (p) => `${base}${p}`,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

/** Responde 200 com o buffer inteiro. */
function sendBuffer(res, buf, headers = {}) {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, ...headers });
  res.end(buf);
}

/** Entrada de ferramenta de teste (formato de src/core/tools/entries/README.md) apontando para o servidor local. */
function makeEntry({ base, buf, id = 'demotool', version = '1.0.0', file = 'demo.zip', exe = 'demo.exe', key = 'win32-x64', asset = {}, urlPath = null }) {
  return {
    id,
    label: 'Ferramenta de teste',
    version,
    source: 'oficial: https://exemplo.invalid/projeto (teste local)',
    assets: {
      [key]: { url: `${base}${urlPath || `/${file}`}`, name: file, size: buf.length, sha256: sha256(buf), exe, ...asset }
    }
  };
}

/** Lista recursiva (caminhos relativos com "/"), para conferir que não sobrou lixo. */
function listTree(root) {
  const out = [];
  const walk = (dir, rel) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of items) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
    }
  };
  walk(root, '');
  return out.sort();
}

module.exports = { sha256, tmpDir, cleanup, makeZip, makeTarGz, startServer, sendBuffer, makeEntry, listTree };

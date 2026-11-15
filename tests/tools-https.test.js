'use strict';

/**
 * Caminho HTTPS de produção do ToolInstaller, com um servidor https local e certificado
 * autoassinado gerado na hora com o openssl (se não houver openssl, os testes são pulados).
 *  - sem confiar no certificado: a instalação é recusada (TLS);
 *  - confiando nele (NODE_EXTRA_CA_CERTS num processo filho): instala de verdade, com redirecionamento https -> https.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { ToolInstaller } = require('../src/core/tools/ToolInstaller');
const { tmpDir, cleanup, makeZip, makeEntry, listTree } = require('./tools-fixtures');

const T = { timeout: 60000 };

function makeCertificate(dir) {
  const key = path.join(dir, 'chave.pem');
  const cert = path.join(dir, 'cert.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'
    ], { stdio: 'pipe', windowsHide: true });
  } catch {
    return null;
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert), certPath: cert };
}

async function startHttps(creds, zip) {
  const sockets = new Set();
  const requests = [];
  const server = https.createServer({ key: creds.key, cert: creds.cert }, (req, res) => {
    requests.push(req.url);
    if (req.url === '/start') { res.writeHead(302, { Location: '/arquivos/final.zip' }); return res.end(); }
    res.writeHead(200, { 'Content-Length': zip.length });
    return res.end(zip);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `https://127.0.0.1:${server.address().port}`,
    requests,
    async close() { for (const s of sockets) s.destroy(); await new Promise((resolve) => server.close(resolve)); }
  };
}

const zip = makeZip([{ name: 'demo.exe', data: 'MZ-https' }]);

test('https com certificado que o sistema não conhece: recusa (TLS) e não instala', T, async (t) => {
  const base = tmpDir();
  let srv = null;
  try {
    const creds = makeCertificate(base);
    if (!creds) return t.skip('openssl não encontrado');
    srv = await startHttps(creds, zip);
    const toolsDir = path.join(base, 'tools');
    const inst = new ToolInstaller({ toolsDir, entries: [makeEntry({ base: srv.base, buf: zip })], platform: 'win32', arch: 'x64', attempts: 3, backoffMs: 1 });
    await assert.rejects(inst.install('demotool'), (err) => err.code === 'TLS' && /certificado/.test(err.message));
    assert.deepEqual(srv.requests, [], 'nenhuma requisição HTTP deve ter passado pelo TLS recusado');
    assert.deepEqual(listTree(toolsDir), []);
    return undefined;
  } finally {
    if (srv) await srv.close();
    cleanup(base);
  }
});

test('https de ponta a ponta (processo filho confiando no certificado de teste), com redirecionamento', T, async (t) => {
  const base = tmpDir();
  let srv = null;
  try {
    const creds = makeCertificate(base);
    if (!creds) return t.skip('openssl não encontrado');
    srv = await startHttps(creds, zip);
    const toolsDir = path.join(base, 'tools');
    const entry = makeEntry({ base: srv.base, buf: zip, urlPath: '/start' });

    const script = `
      const { ToolInstaller } = require(${JSON.stringify(path.resolve(__dirname, '../src/core/tools/ToolInstaller'))});
      const { toolsDir, entry } = JSON.parse(process.argv[1]);
      const inst = new ToolInstaller({ toolsDir, entries: [entry], platform: 'win32', arch: 'x64', attempts: 1 });
      inst.install('demotool').then(
        (r) => { console.log(JSON.stringify({ ok: true, exe: r.exe })); },
        (e) => { console.log(JSON.stringify({ ok: false, code: e.code, message: e.message })); }
      );
    `;
    const out = await new Promise((resolve, reject) => {
      execFile(process.execPath, ['-e', script, JSON.stringify({ toolsDir, entry })], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: creds.certPath }, windowsHide: true, timeout: 45000
      }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
    });
    const result = JSON.parse(out.trim().split('\n').pop());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fs.readFileSync(result.exe, 'utf8'), 'MZ-https');
    assert.deepEqual(srv.requests, ['/start', '/arquivos/final.zip']);
    assert.deepEqual(listTree(toolsDir), ['demotool', 'demotool/1.0.0', 'demotool/1.0.0/demo.exe', 'demotool/1.0.0/manifest.json']);
    return undefined;
  } finally {
    if (srv) await srv.close();
    cleanup(base);
  }
});

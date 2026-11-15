'use strict';

/** Peças de baixo nível do ToolInstaller: validação de entradas (zip-slip), links, extração real, processos e redirecionamentos. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assertSafeEntries, assertNoEscapingLinks, nextHop, checkUrl, extractArchive, archiveCommands, runProcess
} = require('../src/core/tools/ToolInstaller');
const { tmpDir, cleanup, makeZip, makeTarGz, listTree } = require('./tools-fixtures');

const T = { timeout: 30000 };
const DEST = path.join(os.tmpdir(), 'bf-destino-so-para-comparar'); // não precisa existir: só se compara caminho

// ------------------------------------------------------------------ nomes de entradas

test('assertSafeEntries aceita nomes normais', () => {
  assert.doesNotThrow(() => assertSafeEntries(['demo.exe', 'lib/', 'lib/a.dll', './x/y.txt', 'pasta com espaço/arquivo ç.txt', 'a..b/c', '...', ''], DEST));
  assert.doesNotThrow(() => assertSafeEntries(['lib/', 'lib/a.dll\r'], DEST));
  assert.doesNotThrow(() => assertSafeEntries(['nome:com-dois-pontos'], DEST, { platform: 'linux' }));
});

test('assertSafeEntries recusa tudo que escapa do destino', () => {
  const bad = [
    '../evil.txt', '..', 'a/../../evil.txt', 'a/b/../../../evil.txt', '..\\evil.txt', 'a\\..\\..\\evil.txt',
    '/abs.txt', '\\abs.txt', 'C:/evil.txt', 'c:evil.txt', 'D:\\evil.txt', 'nul\0.txt'
  ];
  for (const name of bad) {
    assert.throws(() => assertSafeEntries(['ok.txt', name], DEST), { code: 'EXTRACT_UNSAFE' }, JSON.stringify(name));
  }
  // fluxos alternativos do NTFS só fazem sentido no Windows
  assert.throws(() => assertSafeEntries(['arquivo.txt:secreto'], DEST, { platform: 'win32' }), { code: 'EXTRACT_UNSAFE' });
  assert.throws(() => assertSafeEntries(['a/b:c'], DEST, { platform: 'win32' }), { code: 'EXTRACT_UNSAFE' });
});

// ------------------------------------------------------------------ links

test('assertNoEscapingLinks: junção/link para fora é recusado; pasta comum passa e é contada', () => {
  const base = tmpDir();
  try {
    const outside = path.join(base, 'fora');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'segredo.txt'), 's');

    const ok = path.join(base, 'ok');
    fs.mkdirSync(path.join(ok, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(ok, 'a.exe'), 'x');
    fs.writeFileSync(path.join(ok, 'sub', 'b.txt'), 'y');
    assert.equal(assertNoEscapingLinks(ok), 2);

    // junção (não exige privilégio no Windows; no Linux/macOS vira link simbólico) apontando para fora
    fs.symlinkSync(outside, path.join(ok, 'atalho'), 'junction');
    assert.throws(() => assertNoEscapingLinks(ok), { code: 'EXTRACT_UNSAFE' });
    fs.rmSync(path.join(ok, 'atalho'), { recursive: true, force: true });
    assert.ok(fs.existsSync(path.join(outside, 'segredo.txt')), 'o conteúdo de fora não pode ser tocado');

    // link relativo para dentro é aceito (se o sistema deixar criar link de arquivo)
    let created = true;
    try { fs.symlinkSync('a.exe', path.join(ok, 'link-interno'), 'file'); } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES') created = false; else throw err;
    }
    if (created) assert.equal(assertNoEscapingLinks(ok), 3);

    // link relativo que sobe para fora é recusado
    let created2 = true;
    try { fs.symlinkSync(path.join('..', 'fora', 'segredo.txt'), path.join(ok, 'sobe'), 'file'); } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES') created2 = false; else throw err;
    }
    if (created2) assert.throws(() => assertNoEscapingLinks(ok), { code: 'EXTRACT_UNSAFE' });
  } finally { cleanup(base); }
});

// ------------------------------------------------------------------ extração real (tar do sistema)

test('extractArchive extrai zip e tar.gz de verdade', T, async () => {
  const base = tmpDir();
  try {
    const zip = path.join(base, 'a.zip');
    const tgz = path.join(base, 'a.tar.gz');
    fs.writeFileSync(zip, makeZip([{ name: 'x/', }, { name: 'x/a.txt', data: 'zip-a' }, { name: 'b.txt', data: 'zip-b', store: true }]));
    fs.writeFileSync(tgz, makeTarGz([{ name: 'x/', type: '5' }, { name: 'x/a.txt', data: 'tgz-a' }, { name: 'b.txt', data: 'tgz-b' }]));

    const z = path.join(base, 'z');
    const g = path.join(base, 'g');
    await extractArchive('zip', zip, z);
    await extractArchive('tar.gz', tgz, g);
    assert.equal(fs.readFileSync(path.join(z, 'x', 'a.txt'), 'utf8'), 'zip-a');
    assert.equal(fs.readFileSync(path.join(z, 'b.txt'), 'utf8'), 'zip-b');
    assert.equal(fs.readFileSync(path.join(g, 'x', 'a.txt'), 'utf8'), 'tgz-a');
    assert.equal(fs.readFileSync(path.join(g, 'b.txt'), 'utf8'), 'tgz-b');
  } finally { cleanup(base); }
});

test('extractArchive: zip-slip é barrado na lista, antes de qualquer arquivo ser gravado', T, async () => {
  const base = tmpDir();
  try {
    const zip = path.join(base, 'mau.zip');
    fs.writeFileSync(zip, makeZip([{ name: 'bom.txt', data: 'bom' }, { name: '../evil.txt', data: 'mau' }]));
    const dest = path.join(base, 'a', 'b');
    await assert.rejects(extractArchive('zip', zip, dest), { code: 'EXTRACT_UNSAFE' });
    assert.deepEqual(listTree(dest), [], 'nem o arquivo bom foi extraído');
    assert.ok(!listTree(base).some((p) => /evil/.test(p)));
  } finally { cleanup(base); }
});

test('extractArchive: arquivo que não é do tipo declarado dá EXTRACT_FAILED; sinal cancelado dá CANCELLED', T, async () => {
  const base = tmpDir();
  try {
    const file = path.join(base, 'lixo.zip');
    fs.writeFileSync(file, 'nao sou um zip'.repeat(50));
    await assert.rejects(extractArchive('zip', file, path.join(base, 'o1')), { code: 'EXTRACT_FAILED' });
    await assert.rejects(extractArchive('tar.gz', file, path.join(base, 'o2')), { code: 'EXTRACT_FAILED' });

    const zip = path.join(base, 'ok.zip');
    fs.writeFileSync(zip, makeZip([{ name: 'a.txt', data: 'a' }]));
    await assert.rejects(extractArchive('zip', zip, path.join(base, 'o3'), { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  } finally { cleanup(base); }
});

test('archiveCommands escolhe o descompactador certo por sistema e tipo', () => {
  const win = archiveCommands('zip', 'a.zip', 'dest', 'win32');
  assert.match(win.extract.cmd, /tar(\.exe)?$/i);
  assert.deepEqual(win.extract.args, ['-xf', 'a.zip', '-C', 'dest']);
  assert.deepEqual(win.list.args, ['-tf', 'a.zip']);
  const tgz = archiveCommands('tar.gz', 'a.tar.gz', 'dest', 'linux');
  assert.deepEqual(tgz.extract, { cmd: 'tar', args: ['-xzf', 'a.tar.gz', '-C', 'dest'] });
  assert.deepEqual(tgz.list, { cmd: 'tar', args: ['-tzf', 'a.tar.gz'] });
  const linuxZip = archiveCommands('zip', 'a.zip', 'dest', 'linux');
  assert.equal(linuxZip.list.cmd, 'unzip');
  assert.deepEqual(linuxZip.list.args, ['-Z1', 'a.zip']);
  assert.equal(archiveCommands('zip', 'a.zip', 'dest', 'darwin').extract.cmd, 'tar');
});

// ------------------------------------------------------------------ processos

test('runProcess: cancelamento e limite de tempo encerram o processo de verdade', T, async () => {
  const base = tmpDir();
  try {
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const waitFor = async (fn, ms = 30000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
      throw new Error('tempo esgotado esperando a condição');
    };
    // O filho grava o próprio PID e dorme 60 s: se a gente não matar, o teste denuncia.
    const sleeper = (pidFile) => ['-e', 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)', pidFile];
    const readPid = (pidFile) => waitFor(() => { try { return Number(fs.readFileSync(pidFile, 'utf8')) || null; } catch { return null; } });

    // cancelamento por AbortSignal
    const pidA = path.join(base, 'a.pid');
    const controller = new AbortController();
    const p = runProcess(process.execPath, sleeper(pidA), { signal: controller.signal });
    p.catch(() => {});
    const childA = await readPid(pidA);
    assert.equal(alive(childA), true);
    const t0 = Date.now();
    controller.abort();
    await assert.rejects(p, { code: 'CANCELLED' });
    assert.ok(Date.now() - t0 < 10000, 'o cancelamento deveria ser rápido');
    await waitFor(() => !alive(childA));

    // limite de tempo
    const pidB = path.join(base, 'b.pid');
    const q = runProcess(process.execPath, sleeper(pidB), { timeoutMs: 500 });
    q.catch(() => {});
    const childB = await readPid(pidB);
    await assert.rejects(q, (e) => e.code === 'EXTRACT_FAILED' && /Tempo esgotado/.test(e.message));
    await waitFor(() => !alive(childB));
  } finally { cleanup(base); }

  await assert.rejects(runProcess('programa-que-nao-existe-bf', []), { code: 'EXTRACT_UNAVAILABLE' });
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.exit(3)']), (e) => e.code === 'EXTRACT_FAILED' && /código 3/.test(e.message));
  assert.equal(await runProcess(process.execPath, ['-e', 'console.log("oi")'], { capture: true }), 'oi\n');
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.log("x".repeat(5000))'], { capture: true, maxOutput: 100 }), { code: 'EXTRACT_UNSAFE' });
});

// ------------------------------------------------------------------ URLs e redirecionamentos

test('checkUrl: https sempre; http só em loopback e com permissão', () => {
  assert.equal(checkUrl('https://github.com/a/b', false).host, 'github.com');
  assert.throws(() => checkUrl('http://github.com/a', false), { code: 'INSECURE_URL' });
  assert.throws(() => checkUrl('http://github.com/a', true), { code: 'INSECURE_URL' });
  assert.throws(() => checkUrl('http://127.0.0.1:1/a', false), { code: 'INSECURE_URL' });
  assert.equal(checkUrl('http://127.0.0.1:1/a', true).hostname, '127.0.0.1');
  assert.equal(checkUrl('http://localhost:1/a', true).hostname, 'localhost');
  assert.equal(checkUrl('http://[::1]:1/a', true).protocol, 'http:');
  assert.throws(() => checkUrl('ftp://exemplo.com/a', true), { code: 'BAD_URL' });
  assert.throws(() => checkUrl('file:///C:/a.zip', true), { code: 'BAD_URL' });
  assert.throws(() => checkUrl('isso não é url', true), { code: 'BAD_URL' });
});

test('nextHop: segue relativo/absoluto e bloqueia rebaixar https para http', () => {
  assert.equal(nextHop('https://a.com/x/y.zip', '/z.zip').toString(), 'https://a.com/z.zip');
  assert.equal(nextHop('https://a.com/x/y.zip', 'z.zip').toString(), 'https://a.com/x/z.zip');
  assert.equal(nextHop('https://a.com/x', 'https://cdn.b.com/f?token=1').toString(), 'https://cdn.b.com/f?token=1');
  assert.throws(() => nextHop('https://a.com/x', 'http://a.com/y'), { code: 'REDIRECT_DOWNGRADE' });
  assert.throws(() => nextHop('https://a.com/x', 'http://127.0.0.1/y', true), { code: 'REDIRECT_DOWNGRADE' });
  assert.throws(() => nextHop('https://a.com/x', 'ftp://b.com/y'), { code: 'REDIRECT_DOWNGRADE' });
  assert.throws(() => nextHop('http://127.0.0.1:1/x', 'http://exemplo.com/y', true), { code: 'INSECURE_URL' });
  assert.equal(nextHop('http://127.0.0.1:1/x', 'https://exemplo.com/y', true).protocol, 'https:');
});

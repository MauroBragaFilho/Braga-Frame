'use strict';

/**
 * UpdateManager (src/core/update/UpdateManager.js): consulta, download conferido, política de assinatura, instalar agora / ao fechar, adulteração,
 * atualização pendente que sobrevive a reiniciar. Um "GitHub" local de verdade (HTTP), um instalador de mentira e um spawn falso que só REGISTRA o que
 * seria executado (nada de instalar de verdade aqui: isso é o teste do instalador, `npm run test:installer`).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { UpdateManager } = require('../src/core/update/UpdateManager');

const REPO = 'MauroBragaFilho/Braga-Frame';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const nameOf = (v) => `braga-frame-${v}-windows-x64-setup.exe`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOT_SIGNED = { status: 'NotSigned', subject: null };
const SIGNED = { status: 'Valid', subject: 'CN=SignPath Foundation, O=SignPath Foundation' };

/** O "GitHub": a Release mais nova (mutável) e o arquivo dela; `slow` faz o download demorar (para cancelar). */
async function startGithub(t, { version = '0.2.0', size = 2 * 1024 * 1024 } = {}) {
  const gh = { release: null, files: new Map(), hits: [], slow: false, digestOverride: undefined };
  gh.publish = (v, buf = crypto.randomBytes(size)) => {
    gh.files.set(v, buf);
    gh.release = v;
    return buf;
  };
  const server = http.createServer(async (req, res) => {
    gh.hits.push(req.url);
    const v = gh.release;
    if (req.url === `/repos/${REPO}/releases/latest` && v) {
      const buf = gh.files.get(v);
      const asset = { name: nameOf(v), size: buf.length, browser_download_url: `${gh.base}/${REPO}/releases/download/v${v}/${nameOf(v)}` };
      if (gh.digestOverride !== null) asset.digest = gh.digestOverride !== undefined ? gh.digestOverride : `sha256:${sha(buf)}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tag_name: `v${v}`, html_url: `https://github.com/${REPO}/releases/tag/v${v}`, draft: false, prerelease: false, published_at: '2026-11-17T12:00:00Z', assets: [asset] }));
      return;
    }
    const m = new RegExp(`^/${REPO}/releases/download/v([0-9.]+)/`).exec(req.url);
    if (m && gh.files.has(m[1])) {
      const buf = gh.files.get(m[1]);
      res.writeHead(200, { 'Content-Length': buf.length });
      if (!gh.slow) { res.end(buf); return; }
      for (let i = 0; i < buf.length && !res.destroyed; i += 64 * 1024) { res.write(buf.subarray(i, i + 64 * 1024)); await sleep(40); }
      res.end();
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => server.listen(0, r));
  gh.base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  gh.publish(version);
  return gh;
}

function fakeSpawn() {
  const calls = [];
  const impl = (file, args, opts) => {
    const child = new EventEmitter();
    child.unref = () => {};
    calls.push({ file, args, opts, child });
    if (!impl.failWith) process.nextTick(() => child.emit('spawn'));
    else process.nextTick(() => child.emit('error', impl.failWith));
    return child;
  };
  impl.calls = calls;
  return impl;
}

function make(t, gh, over = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bf-upd-mgr-')), 'updates');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const spawnImpl = fakeSpawn();
  const quits = [];
  const states = [];
  const mgr = new UpdateManager({
    currentVersion: '0.1.0', repo: REPO, dir, base: gh.base, allowHost: (h) => h === '127.0.0.1', spawnImpl, quitApp: () => quits.push(1),
    readSignature: async () => NOT_SIGNED, runningSignature: async () => NOT_SIGNED, ...over
  });
  mgr.on('state', (s) => states.push(s));
  return { mgr, dir, spawnImpl, quits, states, phases: () => [...new Set(states.map((s) => s.phase))] };
}

const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

async function ready(t, gh, over) {
  const m = make(t, gh, over);
  assert.equal((await m.mgr.check()).status, 'available');
  assert.deepEqual(await m.mgr.download(), { ok: true });
  return m;
}

test('consulta + download: chega a "ready" com o arquivo conferido, a assinatura em palavras e só o instalador e o pending.json na pasta', async (t) => {
  const gh = await startGithub(t);
  const m = make(t, gh);
  const res = await m.mgr.check();
  assert.deepEqual([res.status, res.latest.version, Boolean(res.latest.asset)], ['available', '0.2.0', true]);
  assert.deepEqual(await m.mgr.download(), { ok: true });
  const snap = m.mgr.snapshot();
  assert.equal(snap.phase, 'ready');
  assert.deepEqual([snap.ready.version, snap.ready.name, snap.ready.sizeBytes, snap.ready.sha256], ['0.2.0', nameOf('0.2.0'), gh.files.get('0.2.0').length, sha(gh.files.get('0.2.0'))]);
  assert.match(snap.ready.signature.text, /Sem assinatura digital.*SHA-256/);
  assert.deepEqual(files(m.dir), [nameOf('0.2.0'), 'pending.json']);
  assert.deepEqual(m.phases(), ['checking', 'idle', 'downloading', 'ready']);
  assert.equal(snap.error, null);
  assert.ok(m.states.some((s) => s.phase === 'downloading' && s.download && s.download.percent >= 0), 'o andamento vai pelo evento');
});

test('sem consulta que ache versão nova, ou Release sem digest: o download é recusado com a causa e nada é gravado', async (t) => {
  const gh = await startGithub(t);
  const m = make(t, gh);
  assert.deepEqual(await m.mgr.download(), { ok: false, code: 'NO_UPDATE' });
  assert.equal(m.mgr.snapshot().error.code, 'NO_UPDATE');
  gh.digestOverride = null; // a Release não traz o digest: não há como conferir o arquivo
  await m.mgr.check({ force: true });
  assert.equal(m.mgr.snapshot().check.latest.asset, null);
  assert.deepEqual(await m.mgr.download(), { ok: false, code: 'NO_ASSET' });
  assert.match(m.mgr.snapshot().error.message, /página da Release/);
  assert.deepEqual(files(m.dir), []);
});

test('arquivo que não bate com o digest da Release: HASH, estado volta a idle e a pasta fica limpa', async (t) => {
  const gh = await startGithub(t);
  gh.digestOverride = `sha256:${'0'.repeat(64)}`;
  const m = make(t, gh);
  await m.mgr.check();
  assert.deepEqual(await m.mgr.download(), { ok: false, code: 'HASH' });
  const snap = m.mgr.snapshot();
  assert.deepEqual([snap.phase, snap.ready, snap.error.code], ['idle', null, 'HASH']);
  assert.match(snap.error.message, /Nada foi instalado/);
  assert.deepEqual(files(m.dir), []);
});

test('assinatura: inválida é recusada, "sem assinatura" com app em uso assinado é rebaixamento, mesmo emissor passa; o arquivo recusado é apagado', async (t) => {
  const gh = await startGithub(t);
  for (const [next, running, code] of [
    [{ status: 'HashMismatch', subject: SIGNED.subject }, NOT_SIGNED, 'INVALID_SIGNATURE'],
    [NOT_SIGNED, SIGNED, 'DOWNGRADE'],
    [{ status: 'Valid', subject: 'CN=Outro Emissor' }, SIGNED, 'SIGNER_CHANGED']
  ]) {
    const m = make(t, gh, { readSignature: async () => next, runningSignature: async () => running });
    await m.mgr.check();
    assert.deepEqual(await m.mgr.download(), { ok: false, code }, code);
    assert.equal(m.mgr.snapshot().phase, 'idle');
    assert.deepEqual(files(m.dir), [], `${code}: nada sobra`);
  }
  const ok = make(t, gh, { readSignature: async () => SIGNED, runningSignature: async () => SIGNED });
  await ok.mgr.check();
  assert.deepEqual(await ok.mgr.download(), { ok: true });
  assert.equal(ok.mgr.snapshot().ready.signature.text, 'Assinatura digital válida (SignPath Foundation).');
});

test('cancelar o download: volta a idle, sem erro e sem arquivo; dá para baixar de novo depois', async (t) => {
  const gh = await startGithub(t, { size: 4 * 1024 * 1024 });
  gh.slow = true;
  const m = make(t, gh);
  await m.mgr.check();
  const job = m.mgr.download();
  await sleep(300);
  assert.equal(m.mgr.snapshot().phase, 'downloading');
  assert.equal(m.mgr.cancel(), true);
  assert.deepEqual(await job, { ok: false, code: 'CANCELLED' });
  const snap = m.mgr.snapshot();
  assert.deepEqual([snap.phase, snap.error, snap.ready], ['idle', null, null]);
  assert.deepEqual(files(m.dir), []);
  assert.equal(m.mgr.cancel(), false, 'nada para cancelar');
  gh.slow = false;
  assert.deepEqual(await m.mgr.download(), { ok: true });
});

test('instalar AGORA: abre o instalador em silêncio com --updated --force-run (ele reabre o app) e só então fecha o app', async (t) => {
  const gh = await startGithub(t);
  const m = await ready(t, gh);
  assert.deepEqual(await m.mgr.install({ when: 'now' }), { installing: true });
  assert.equal(m.spawnImpl.calls.length, 1);
  const call = m.spawnImpl.calls[0];
  assert.equal(call.file, path.join(m.dir, nameOf('0.2.0')));
  assert.deepEqual(call.args, ['/S', '--updated', '--force-run']);
  assert.deepEqual([call.opts.detached, call.opts.stdio, call.opts.windowsHide], [true, 'ignore', true], 'desligado do app, sem janela');
  assert.equal(m.quits.length, 1);
  assert.equal(m.mgr.snapshot().phase, 'installing');
});

test('instalar agora com trabalho em andamento (exportação, análise…): recusa com o motivo, não abre nada e não fecha o app', async (t) => {
  const gh = await startGithub(t);
  const m = await ready(t, gh, { busy: () => 'há exportações em andamento' });
  await assert.rejects(m.mgr.install({ when: 'now' }), (e) => e.code === 'BUSY' && /há exportações em andamento/.test(e.message) && /quando eu fechar/.test(e.message));
  assert.deepEqual([m.spawnImpl.calls.length, m.quits.length, m.mgr.snapshot().phase], [0, 0, 'ready']);
});

test('instalar QUANDO EU FECHAR: só agenda; ao fechar abre o instalador em silêncio (sem reabrir); dá para desfazer', async (t) => {
  const gh = await startGithub(t);
  const m = await ready(t, gh);
  assert.deepEqual(await m.mgr.install({ when: 'quit' }), { scheduled: true });
  assert.equal(m.mgr.snapshot().installOnQuit, true);
  assert.equal(m.spawnImpl.calls.length, 0, 'nada acontece até fechar');
  await m.mgr.install({ when: 'none' });
  assert.equal(m.mgr.onQuit(), false, 'desfeito: fechar não instala');
  assert.equal(m.spawnImpl.calls.length, 0);
  await m.mgr.install({ when: 'quit' });
  assert.equal(m.mgr.onQuit(), true);
  assert.deepEqual(m.spawnImpl.calls.map((c) => c.args), [['/S', '--updated']], 'sem --force-run: o app não reabre sozinho depois de fechado pelo usuário');
  assert.equal(m.quits.length, 0, 'o app já está fechando');
  assert.equal(m.mgr.onQuit(), false, 'uma vez só');
});

test('arquivo adulterado depois da conferência: instalar agora e ao fechar recusam, descartam o arquivo e NÃO executam nada', async (t) => {
  const gh = await startGithub(t);
  const m = await ready(t, gh);
  const file = path.join(m.dir, nameOf('0.2.0'));
  const bytes = fs.readFileSync(file);
  bytes[1000] ^= 0xff;
  fs.writeFileSync(file, bytes);
  await assert.rejects(m.mgr.install({ when: 'now' }), (e) => e.code === 'TAMPERED');
  assert.deepEqual([m.spawnImpl.calls.length, m.quits.length], [0, 0]);
  const snap = m.mgr.snapshot();
  assert.deepEqual([snap.phase, snap.ready, snap.error.code], ['idle', null, 'TAMPERED']);
  assert.deepEqual(files(m.dir), []);

  // o mesmo no instante de fechar (a conferência síncrona)
  await m.mgr.check({ force: true });
  await m.mgr.download();
  await m.mgr.install({ when: 'quit' });
  fs.appendFileSync(path.join(m.dir, nameOf('0.2.0')), 'x');
  assert.equal(m.mgr.onQuit(), false);
  assert.equal(m.spawnImpl.calls.length, 0);
});

test('o instalador não abre (antivírus, arquivo bloqueado): INSTALL_FAILED, o app NÃO fecha e a atualização continua pronta', async (t) => {
  const gh = await startGithub(t);
  const m = await ready(t, gh);
  m.spawnImpl.failWith = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
  await assert.rejects(m.mgr.install({ when: 'now' }), (e) => e.code === 'INSTALL_FAILED' && /continua baixada/.test(e.message));
  assert.deepEqual([m.quits.length, m.mgr.snapshot().phase], [0, 'ready']);
  assert.deepEqual(files(m.dir), [nameOf('0.2.0'), 'pending.json']);
});

test('pedir ao app para fechar falha (ctx.app.quit indisponível): o instalador já está rodando, então não vira erro e fica registrado', async (t) => {
  const gh = await startGithub(t);
  const logs = [];
  const m = await ready(t, gh, { quitApp: () => { throw new TypeError('ctx.app.quit is not a function'); }, log: (level, message) => logs.push([level, message]) });
  assert.deepEqual(await m.mgr.install({ when: 'now' }), { installing: true });
  assert.equal(m.spawnImpl.calls.length, 1);
  assert.equal(m.mgr.snapshot().phase, 'installing');
  assert.ok(logs.some(([l, msg]) => l === 'warn' && /não consegui fechar o app/.test(msg)));
});

test('instalar sem nada baixado: NO_READY', async (t) => {
  const gh = await startGithub(t);
  const m = make(t, gh);
  await assert.rejects(m.mgr.install({ when: 'now' }), (e) => e.code === 'NO_READY');
  await assert.rejects(m.mgr.install({ when: 'quit' }), (e) => e.code === 'NO_READY');
});

test('MODO DE TESTE: instalar só REGISTRA o que seria executado, sem abrir nada nem fechar o app', async (t) => {
  const gh = await startGithub(t);
  const m = await ready(t, gh, { testMode: true });
  const res = await m.mgr.install({ when: 'now' });
  assert.deepEqual(res, { installing: true, test: { executed: false, args: ['/S', '--updated', '--force-run'] } }, 'o resultado diz o que SERIA executado');
  assert.deepEqual([m.spawnImpl.calls.length, m.quits.length], [0, 0]);
  assert.deepEqual(m.mgr.spawned.map((s) => s.args), [['/S', '--updated', '--force-run']]);
});

test('reiniciar o app: a atualização já baixada volta como "ready" sem rede; o que não vale mais é apagado', async (t) => {
  const gh = await startGithub(t);
  const first = await ready(t, gh);
  const again = new UpdateManager({ currentVersion: '0.1.0', repo: REPO, dir: first.dir, base: 'http://127.0.0.1:9', spawnImpl: fakeSpawn() });
  await again.load();
  const snap = again.snapshot();
  assert.deepEqual([snap.phase, snap.ready.version, snap.ready.sha256, snap.check], ['ready', '0.2.0', sha(gh.files.get('0.2.0')), null]);

  // depois de atualizar (a versão em uso já é a baixada ou mais nova): limpa tudo
  const updated = new UpdateManager({ currentVersion: '0.2.0', repo: REPO, dir: first.dir, base: 'http://127.0.0.1:9' });
  await updated.load();
  assert.deepEqual([updated.snapshot().phase, updated.snapshot().ready], ['idle', null]);
  assert.deepEqual(files(first.dir), []);
});

test('reiniciar: arquivo adulterado, nome fora do padrão, caminho com .., JSON ruim ou sobras: nada vira "ready" e a pasta é limpa', async (t) => {
  const gh = await startGithub(t);
  const base = await ready(t, gh);
  const good = JSON.parse(fs.readFileSync(path.join(base.dir, 'pending.json'), 'utf8'));
  const installer = (dir) => path.join(dir, nameOf('0.2.0'));
  const pending = (dir, patch) => fs.writeFileSync(path.join(dir, 'pending.json'), JSON.stringify({ ...good, ...patch }));
  const cases = {
    'tamanho errado': (dir) => fs.appendFileSync(installer(dir), 'x'),
    'conteúdo adulterado': (dir) => { const b = fs.readFileSync(installer(dir)); b[7] ^= 1; fs.writeFileSync(installer(dir), b); },
    'nome fora do padrão': (dir) => pending(dir, { file: 'calc.exe' }),
    'caminho com ..': (dir) => pending(dir, { file: `..\\${nameOf('0.2.0')}` }),
    'JSON ruim': (dir) => fs.writeFileSync(path.join(dir, 'pending.json'), '{ nao é json'),
    'SHA-256 inválido': (dir) => pending(dir, { sha256: 'xyz' }),
    'versão antiga': (dir) => pending(dir, { version: '0.0.9' }),
    'esquema desconhecido': (dir) => pending(dir, { schema: 99 })
  };
  for (const [why, damage] of Object.entries(cases)) {
    const dir = path.join(path.dirname(base.dir), `copia-${why.replace(/\W+/g, '-')}`);
    fs.cpSync(base.dir, dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sobra.part'), 'lixo');
    damage(dir);
    const mgr = new UpdateManager({ currentVersion: '0.1.0', repo: REPO, dir, base: gh.base });
    await mgr.load();
    assert.deepEqual([why, mgr.snapshot().phase, mgr.snapshot().ready], [why, 'idle', null]);
    assert.ok(!files(dir).includes('sobra.part'), `${why}: sobras limpas`);
    assert.ok(!files(dir).includes('pending.json'), `${why}: pending apagado`);
  }
});

test('uma Release MAIS NOVA que a já baixada descarta a antiga; o download seguinte pega a nova', async (t) => {
  const gh = await startGithub(t);
  const m = await ready(t, gh);
  gh.publish('0.3.0');
  const res = await m.mgr.check({ force: true });
  assert.equal(res.latest.version, '0.3.0');
  assert.equal(m.mgr.snapshot().ready, null, 'a 0.2.0 baixada ficou velha');
  assert.deepEqual(files(m.dir), []);
  assert.deepEqual(await m.mgr.download(), { ok: true });
  assert.deepEqual([m.mgr.snapshot().ready.version, files(m.dir)], ['0.3.0', [nameOf('0.3.0'), 'pending.json']]);
});

test('a consulta guarda o resultado sem erro por 6 horas; "force" consulta de novo; erro não fica guardado', async (t) => {
  const gh = await startGithub(t);
  let clock = 1_000_000;
  const m = make(t, gh, { now: () => clock });
  await m.mgr.check();
  assert.equal((await m.mgr.check()).cached, true);
  assert.equal(gh.hits.filter((u) => u.endsWith('/releases/latest')).length, 1);
  await m.mgr.check({ force: true });
  assert.equal(gh.hits.filter((u) => u.endsWith('/releases/latest')).length, 2);
  clock += 6 * 60 * 60 * 1000 + 1;
  assert.equal((await m.mgr.check()).cached, undefined, 'passou das 6 horas');
  const down = make(t, gh, { base: 'http://127.0.0.1:9' });
  assert.equal((await down.mgr.check()).status, 'error');
  assert.equal(down.mgr.snapshot().check, null, 'erro não vira resultado guardado');
});

test('dentro de outro aplicativo (BDS): nada de consulta, download nem leitura da pasta', async (t) => {
  const gh = await startGithub(t);
  const m = make(t, gh, { embedded: true });
  assert.deepEqual(await m.mgr.check({ force: true }), { status: 'disabled', reason: 'embedded', current: '0.1.0' });
  assert.deepEqual(await m.mgr.download(), { ok: false, code: 'EMBEDDED' });
  await m.mgr.load();
  assert.equal(gh.hits.length, 0);
  assert.deepEqual(files(m.dir), []);
});

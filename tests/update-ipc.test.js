'use strict';

/** Canais app:updateCheck e app:updateOpen (src/ipc/handlers/app.js) com um ctx de verdade e um GitHub de mentira. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createContext } = require('../src/ipc/context');
const { register } = require('../src/ipc/handlers/app');
const appInfo = require('../src/appInfo');

const release = (tag = 'v0.2.0', patch = {}) => ({
  tag_name: tag, html_url: `https://github.com/${appInfo.repo}/releases/tag/${tag}`, draft: false, prerelease: false, published_at: '2026-11-17T12:00:00Z', assets: [], ...patch
});

function setup(t, { fetchImpl, host, env = {}, appExtra = {} } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-update-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const handlers = new Map();
  const opened = [];
  const calls = [];
  const sent = [];
  const appEvents = new Map();
  const fetchSpy = fetchImpl ? async (url, opts) => { calls.push(url); return fetchImpl(url, opts); } : undefined;
  const ctx = createContext({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler() {} },
    app: { getVersion: () => '0.1.0', getPath: () => userData, isPackaged: true, on: (name, fn) => appEvents.set(name, fn), quit: () => sent.push(['app-quit']), ...appExtra },
    dialog: {}, shell: { openExternal: async (url) => { opened.push(url); } },
    getWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } }), userDataDir: userData, host,
    env: { ...process.env, ...env },
    fetch: fetchSpy,
    resolveTools: () => ({ ffmpeg: null, ffprobe: null, ytdlp: null, whisper: null, twitchDownloader: null }),
    logger: { info() {}, warn() {}, error() {}, log() {} }
  });
  register(ctx);
  const states = () => sent.filter(([c]) => c === 'update:state').map(([, s]) => s);
  return { ctx, call: (channel, payload) => handlers.get(channel)({}, payload), opened, calls, sent, states, appEvents, userData };
}

const ok = (body, status = 200) => async () => ({ status, ok: status < 300, json: async () => body });

test('app:updateCheck: devolve a versão mais nova com o endereço da Release, e guarda o resultado por 6 horas (force consulta de novo)', async (t) => {
  const s = setup(t, { fetchImpl: ok(release()) });
  const first = await s.call('app:updateCheck', {});
  assert.deepEqual([first.ok, first.status, first.current, first.latest.version, first.cached], [true, 'available', '0.1.0', '0.2.0', undefined]);
  assert.equal(first.url, `https://github.com/${appInfo.repo}/releases/tag/v0.2.0`);
  assert.equal(s.calls.length, 1);
  const again = await s.call('app:updateCheck', {});
  assert.equal(again.cached, true, 'abrir o app de novo não consulta de novo');
  assert.equal(s.calls.length, 1);
  await s.call('app:updateCheck', { force: true });
  assert.equal(s.calls.length, 2, '"Verificar agora" sempre consulta');
  assert.equal(s.calls[0], `https://api.github.com/repos/${appInfo.repo}/releases/latest`);
});

test('app:updateCheck: erro não é guardado (a próxima tentativa consulta); sem Release publicada devolve none', async (t) => {
  let answer = { status: 500, ok: false, json: async () => ({}) };
  const s = setup(t, { fetchImpl: async () => answer });
  const bad = await s.call('app:updateCheck', {});
  assert.deepEqual([bad.ok, bad.status, bad.reason], [true, 'error', 'http'], 'a falha vira resultado, nunca exceção');
  answer = { status: 404, ok: false, json: async () => ({ message: 'Not Found' }) };
  const none = await s.call('app:updateCheck', {});
  assert.equal(none.status, 'none');
  assert.equal(s.calls.length, 2, 'o erro não ficou guardado');
});

test('app:updateCheck: dentro de outro aplicativo (hospedeiro) não consulta nada', async (t) => {
  const s = setup(t, { fetchImpl: ok(release()), host: { embedded: true, name: 'BDS', tool: () => null, whisperModels: null, ai: null } });
  const res = await s.call('app:updateCheck', { force: true });
  assert.deepEqual([res.status, res.reason], ['disabled', 'embedded']);
  assert.equal(s.calls.length, 0);
});

test('app:updateCheck: só em teste (NODE_ENV=test, app não empacotado) o endereço do GitHub pode ser trocado, e só por loopback', async (t) => {
  const prod = setup(t, { fetchImpl: ok(release()), env: { NODE_ENV: 'test', BF_TEST_UPDATE_API: 'http://127.0.0.1:9' } });
  await prod.call('app:updateCheck', {});
  assert.match(prod.calls[0], /^https:\/\/api\.github\.com\//, 'app empacotado ignora a variável');
  const dev = setup(t, { fetchImpl: ok(release()), env: { NODE_ENV: 'test', BF_TEST_UPDATE_API: 'http://127.0.0.1:9' }, appExtra: { isPackaged: false } });
  await dev.call('app:updateCheck', {});
  assert.match(dev.calls[0], /^http:\/\/127\.0\.0\.1:9\/repos\//);
});

test('app:updateOpen: só abre o endereço que o PRÓPRIO app conferiu na última consulta (o renderer não escolhe a URL)', async (t) => {
  const s = setup(t, { fetchImpl: ok(release()) });
  const before = await s.call('app:updateOpen', { url: 'https://evil.example/' });
  assert.deepEqual([before.ok, before.code], [false, 'NO_UPDATE']);
  assert.deepEqual(s.opened, []);
  await s.call('app:updateCheck', {});
  const opened = await s.call('app:updateOpen', { url: 'https://evil.example/' }); // a URL do pedido é ignorada
  assert.equal(opened.opened, true);
  assert.deepEqual(s.opened, [`https://github.com/${appInfo.repo}/releases/tag/v0.2.0`]);
});

test('app:updateOpen: no modo de teste (NODE_ENV=test, app não empacotado) devolve o endereço mas NÃO abre o navegador', async (t) => {
  const s = setup(t, { fetchImpl: ok(release()), env: { NODE_ENV: 'test' }, appExtra: { isPackaged: false } });
  await s.call('app:updateCheck', {});
  const res = await s.call('app:updateOpen', {});
  assert.deepEqual([res.opened, res.test, res.url], [false, true, `https://github.com/${appInfo.repo}/releases/tag/v0.2.0`]);
  assert.deepEqual(s.opened, []);
});

test('app:updateOpen: um html_url de fora do repositório nunca é aberto (o app monta o da tag); sem versão nova não abre nada', async (t) => {
  const evil = setup(t, { fetchImpl: ok(release('v0.2.0', { html_url: 'https://evil.example/baixe-aqui' })) });
  await evil.call('app:updateCheck', {});
  await evil.call('app:updateOpen', {});
  assert.deepEqual(evil.opened, [`https://github.com/${appInfo.repo}/releases/tag/v0.2.0`]);
  const current = setup(t, { fetchImpl: ok(release('v0.1.0')) });
  await current.call('app:updateCheck', {});
  assert.equal((await current.call('app:updateOpen', {})).code, 'NO_UPDATE', 'na versão mais nova não há o que abrir');
  assert.deepEqual(current.opened, []);
});

// ------------------------------------------------------------------ baixar e instalar pelos canais (instalador de mentira; o spawn real nunca roda)

const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Um GitHub de mentira (fetch injetado) com a Release 0.2.0 e o instalador dela; `slow` faz o download demorar. */
function githubWith(buf, { slow = false } = {}) {
  const name = 'braga-frame-0.2.0-windows-x64-setup.exe';
  const downloadUrl = `https://github.com/${appInfo.repo}/releases/download/v0.2.0/${name}`;
  const body = release('v0.2.0', { assets: [{ name, size: buf.length, digest: `sha256:${sha(buf)}`, browser_download_url: downloadUrl }] });
  return async (url, opts) => {
    if (url.endsWith('/releases/latest')) return { status: 200, ok: true, json: async () => body };
    if (url === downloadUrl) {
      async function* chunks() {
        for (let i = 0; i < buf.length; i += 32 * 1024) {
          if (opts.signal && opts.signal.aborted) { const e = new Error('abortado'); e.name = 'AbortError'; throw e; }
          yield buf.subarray(i, i + 32 * 1024);
          if (slow) await sleep(30);
        }
      }
      return { status: 200, ok: true, url: downloadUrl, headers: new Headers({ 'content-length': String(buf.length) }), body: Readable.from(chunks()) };
    }
    return { status: 404, ok: false, json: async () => ({}) };
  };
}

const waitFor = async (cond, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return; await sleep(20); } throw new Error('tempo esgotado'); };

test('app:updateDownload sem consulta antes: devolve started e o estado traz o erro NO_UPDATE (nada baixado)', async (t) => {
  const s = setup(t, { fetchImpl: githubWith(crypto.randomBytes(1000)) });
  assert.deepEqual((await s.call('app:updateDownload', {})).started, true);
  await waitFor(() => s.states().some((x) => x.error && x.error.code === 'NO_UPDATE'));
  assert.equal(fs.existsSync(path.join(s.userData, 'updates')), false);
});

test('fluxo completo pelos canais (produção): consulta, baixa conferindo o SHA-256, fica pronto e "quando eu fechar" instala no evento quit do app', async (t) => {
  const buf = crypto.randomBytes(300 * 1024);
  const s = setup(t, { fetchImpl: githubWith(buf) });
  s.ctx.updates.readSignature = async () => ({ status: 'NotSigned', subject: null });
  s.ctx.updates.runningSignature = async () => ({ status: 'NotSigned', subject: null }); // o app em uso: sem assinatura, como o de hoje (no teste o processo é o node.exe, que é assinado)
  assert.equal((await s.call('app:updateCheck', {})).status, 'available');
  assert.equal((await s.call('app:updateDownload', {})).started, true);
  await waitFor(() => s.states().some((x) => x.phase === 'ready'));
  const state = await s.call('app:updateState', {});
  assert.deepEqual([state.ok, state.phase, state.ready.version, state.ready.sha256], [true, 'ready', '0.2.0', sha(buf)]);
  assert.ok(s.states().some((x) => x.phase === 'downloading'), 'o andamento foi avisado');
  const updatesDir = path.join(s.userData, 'updates');
  assert.deepEqual(fs.readdirSync(updatesDir).sort(), ['braga-frame-0.2.0-windows-x64-setup.exe', 'pending.json']);

  // "quando eu fechar": agenda; o spawn de verdade é trocado por um registro; o evento quit do app dispara a instalação
  const launched = [];
  s.ctx.updates.spawnImpl = (file, args) => { launched.push([path.basename(file), args]); const { EventEmitter } = require('node:events'); const c = new EventEmitter(); c.unref = () => {}; return c; };
  assert.deepEqual((await s.call('app:updateInstall', { when: 'quit' })).scheduled, true);
  assert.deepEqual(launched, [], 'nada até fechar');
  s.appEvents.get('quit')();
  assert.deepEqual(launched, [['braga-frame-0.2.0-windows-x64-setup.exe', ['/S', '--updated']]]);
});

test('app:updateInstall agora: recusa com BUSY enquanto há exportação/análise/legenda (toolUsage); sem nada baixado dá NO_READY; o pedido de "when" inválido vira "agora"', async (t) => {
  const buf = crypto.randomBytes(100 * 1024);
  const s = setup(t, { fetchImpl: githubWith(buf) });
  s.ctx.updates.readSignature = async () => ({ status: 'NotSigned', subject: null });
  s.ctx.updates.runningSignature = async () => ({ status: 'NotSigned', subject: null }); // o app em uso: sem assinatura, como o de hoje (no teste o processo é o node.exe, que é assinado)
  const none = await s.call('app:updateInstall', { when: 'now' });
  assert.deepEqual([none.ok, none.code], [false, 'NO_READY']);
  await s.call('app:updateCheck', {});
  await s.call('app:updateDownload', {});
  await waitFor(() => s.states().some((x) => x.phase === 'ready'));
  const release = s.ctx.toolUsage.register((key) => (key === 'ffmpeg' ? 'há exportações em andamento' : null));
  const busy = await s.call('app:updateInstall', { when: 'now' });
  assert.deepEqual([busy.ok, busy.code], [false, 'BUSY']);
  assert.match(busy.message, /há exportações em andamento/);
  assert.equal(s.sent.some(([c]) => c === 'app-quit'), false, 'o app não fechou');
  release();
  // com o trabalho terminado, qualquer "when" desconhecido é tratado como "agora" (nunca como instalar sem pedir)
  const spawned = [];
  s.ctx.updates.spawnImpl = (file, args) => { spawned.push(args); const { EventEmitter } = require('node:events'); const c = new EventEmitter(); c.unref = () => {}; process.nextTick(() => c.emit('spawn')); return c; };
  const go = await s.call('app:updateInstall', { when: 'qualquer coisa' });
  assert.equal(go.installing, true);
  assert.deepEqual(spawned, [['/S', '--updated', '--force-run']]);
  assert.equal(s.sent.some(([c]) => c === 'app-quit'), true, 'o app fecha para o instalador trabalhar');
});

test('fechar o app cancela um download em andamento (before-quit) e app:updateCancel também', async (t) => {
  const buf = crypto.randomBytes(2 * 1024 * 1024);
  const s = setup(t, { fetchImpl: githubWith(buf, { slow: true }) });
  await s.call('app:updateCheck', {});
  await s.call('app:updateDownload', {});
  await waitFor(() => s.states().some((x) => x.phase === 'downloading'));
  s.appEvents.get('before-quit')();
  await waitFor(() => s.states().at(-1).phase === 'idle');
  assert.equal(fs.existsSync(path.join(s.userData, 'updates', 'braga-frame-0.2.0-windows-x64-setup.exe')), false);
  assert.equal(s.states().at(-1).error, null, 'cancelar não é erro');
  assert.deepEqual((await s.call('app:updateCancel', {})).cancelled, false, 'nada em andamento');
});

test('dentro de outro aplicativo (BDS): os canais respondem, mas não consultam nem baixam', async (t) => {
  const s = setup(t, { fetchImpl: githubWith(crypto.randomBytes(1000)), host: { embedded: true, name: 'BDS', tool: () => null, whisperModels: null, ai: null } });
  assert.deepEqual((await s.call('app:updateCheck', { force: true })).status, 'disabled');
  await s.call('app:updateDownload', {});
  await sleep(100);
  assert.equal(s.calls.length, 0);
  assert.equal((await s.call('app:updateState', {})).phase, 'idle');
});

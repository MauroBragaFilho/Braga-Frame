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
  const fetchSpy = fetchImpl ? async (url, opts) => { calls.push(url); return fetchImpl(url, opts); } : undefined;
  const ctx = createContext({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler() {} },
    app: { getVersion: () => '0.1.0', getPath: () => userData, isPackaged: true, ...appExtra },
    dialog: {}, shell: { openExternal: async (url) => { opened.push(url); } },
    getWindow: () => null, userDataDir: userData, host,
    env: { ...process.env, ...env },
    fetch: fetchSpy,
    resolveTools: () => ({ ffmpeg: null, ffprobe: null, ytdlp: null, whisper: null, twitchDownloader: null }),
    logger: { info() {}, warn() {}, error() {}, log() {} }
  });
  register(ctx);
  return { call: (channel, payload) => handlers.get(channel)({}, payload), opened, calls };
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

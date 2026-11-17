'use strict';

/** Canais proxy:* (src/ipc/handlers/proxy.js) com o ctx de verdade e um ffmpeg falso. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createContext } = require('../src/ipc/context');
const proxyHandler = require('../src/ipc/handlers/proxy');
const fx = require('./export-fixtures');

const silent = { log() {}, info() {}, warn() {}, error() {} };
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (cond, what) => { const end = Date.now() + 8000; while (Date.now() < end) { if (cond()) return; await tick(); } throw new Error(`tempo esgotado esperando ${what}`); };

function makeCtx(userData, tools) {
  const handlers = new Map();
  const sent = [];
  const quit = [];
  const ctx = createContext({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: () => userData, getVersion: () => '9.9.9', on: (event, fn) => { if (event === 'before-quit') quit.push(fn); } },
    dialog: {}, shell: {}, getWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } }), logger: silent,
    resolveTools: () => tools
  });
  proxyHandler.register(ctx);
  return { ctx, call: (channel, payload) => handlers.get(channel)({}, payload), sent, quit };
}

test('registra só os três canais proxy:*', () => {
  const dir = fx.tmpDir();
  try {
    const { ctx } = makeCtx(dir, { ffmpeg: null });
    assert.deepEqual([...ctx.channels].filter((c) => c.startsWith('proxy:')).sort(), ['proxy:cancel', 'proxy:ensure', 'proxy:status']);
  } finally { fx.cleanup(dir); }
});

test('proxy:ensure valida o pedido com mensagens claras (caminho completo, formato, arquivo, FFmpeg)', async () => {
  const dir = fx.tmpDir();
  try {
    const none = makeCtx(path.join(dir, 'u1'), { ffmpeg: null });
    const file = path.join(dir, 'live.mkv');
    fs.writeFileSync(file, 'x');
    let res = await none.call('proxy:ensure', { path: file });
    assert.deepEqual([res.ok, res.code], [false, 'NO_FFMPEG']);
    const real = makeCtx(path.join(dir, 'u2'), { ffmpeg: 'ffmpeg-falso' });
    res = await real.call('proxy:ensure', {});
    assert.deepEqual([res.ok, res.code], [false, 'INVALID_PATH']);
    res = await real.call('proxy:ensure', { path: 'relativo/x.mkv' });
    assert.equal(res.code, 'INVALID_PATH');
    res = await real.call('proxy:ensure', { path: path.join(dir, 'texto.txt') });
    assert.equal(res.code, 'UNSUPPORTED_FORMAT');
    res = await real.call('proxy:ensure', { path: path.join(dir, 'sumiu.mkv') });
    assert.equal(res.code, 'INPUT_MISSING');
    res = await real.call('proxy:ensure', { path: dir + '.mp4' });
    assert.equal(res.code, 'INPUT_MISSING', 'uma pasta (ou nada) com extensão de vídeo não é um vídeo');
    res = await real.call('proxy:status', { path: 'x' });
    assert.equal(res.code, 'INVALID_PATH');
    assert.deepEqual((await real.call('proxy:cancel', {})).cancelled, false);
  } finally { fx.cleanup(dir); }
});

test('com o ffmpeg de verdade: ensure começa, os eventos chegam à janela, status fica pronto e a URL é file://', { skip: fx.skipMedia }, async () => {
  const dir = fx.tmpDir();
  try {
    const src = path.join(dir, 'fonte.mp4');
    fx.makeCodedSource(src, { width: 1280, height: 720, fps: 15, seconds: 3 });
    const t = makeCtx(path.join(dir, 'ud'), fx.tools);
    const res = await t.call('proxy:ensure', { path: src });
    assert.equal(res.ok, true);
    assert.equal(res.state, 'running');
    assert.match(res.url, /^file:\/\/\/.*\.mp4$/);
    await waitFor(() => t.sent.some(([c]) => c === 'proxy:done'), 'o proxy:done');
    const done = t.sent.find(([c]) => c === 'proxy:done')[1];
    assert.equal(done.path, src);
    assert.ok(fs.existsSync(done.proxyPath));
    assert.ok(t.sent.some(([c, p]) => c === 'proxy:progress' && p.path === src && p.p >= 0));
    const status = await t.call('proxy:status', { path: src });
    assert.deepEqual([status.ok, status.state, status.url], [true, 'ready', done.url]);
    for (const fn of t.quit) fn(); // fechar o app não quebra
  } finally { fx.cleanup(dir); }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PRELOAD = path.join(__dirname, '..', 'preload.js');

/** Executa o preload.js com um 'electron' falso e devolve o que ele expôs ao renderer. */
function loadPreload() {
  const exposed = {};
  const invoked = [];
  const listeners = new Map();
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: {
      invoke: (channel, payload) => { invoked.push([channel, payload]); return Promise.resolve({ ok: true }); },
      on: (channel, fn) => { listeners.set(channel, [...(listeners.get(channel) || []), fn]); },
      removeListener: (channel, fn) => { listeners.set(channel, (listeners.get(channel) || []).filter((f) => f !== fn)); }
    },
    webUtils: { getPathForFile: (file) => `real:${file.name}` }
  };
  const requested = [];
  const run = new Function('require', fs.readFileSync(PRELOAD, 'utf8'));
  run((id) => { requested.push(id); return electron; });
  return { exposed, invoked, listeners, requested };
}

test('expõe só window.bf (sem window.corte) e usa apenas o módulo electron', () => {
  const { exposed, requested } = loadPreload();
  assert.deepEqual(Object.keys(exposed), ['bf']);
  assert.deepEqual(Object.keys(exposed.bf).sort(), ['invoke', 'on', 'pathForFile']);
  assert.deepEqual([...new Set(requested)], ['electron']);
});

test('invoke só aceita canais "recurso:acao"', async () => {
  const { exposed, invoked } = loadPreload();
  const { bf } = exposed;
  assert.deepEqual(await bf.invoke('queue:enqueue', { jobs: [] }), { ok: true });
  assert.deepEqual(invoked, [['queue:enqueue', { jobs: [] }]]);
  await bf.invoke('app:info');
  assert.deepEqual(invoked.at(-1), ['app:info', undefined]);

  for (const bad of ['', 'info', 'App:info', 'app:info:x', 'app:in-fo', 'app:', ':info', 'app: info', 'ELECTRON_BROWSER_REQUIRE', '../x:y', 7, null, undefined, {}]) {
    await assert.rejects(() => bf.invoke(bad), /Canal IPC inválido/, String(bad));
  }
  assert.equal(invoked.length, 2, 'nada inválido chega ao processo principal');
});

test('on valida o canal, entrega só o payload e devolve a função de cancelar', () => {
  const { exposed, listeners } = loadPreload();
  const got = [];
  const off = exposed.bf.on('queue:progress', (p) => got.push(p));
  assert.equal(listeners.get('queue:progress').length, 1);
  listeners.get('queue:progress')[0]({ sender: 'x' }, { id: 'j1', p: 0.5 });
  assert.deepEqual(got, [{ id: 'j1', p: 0.5 }]);
  off();
  assert.equal(listeners.get('queue:progress').length, 0);

  assert.throws(() => exposed.bf.on('sem-dois-pontos', () => {}), /Canal IPC inválido/);
  assert.throws(() => exposed.bf.on('queue:progress', 'não é função'), /callback/);
});

test('pathForFile delega ao webUtils', () => {
  const { exposed } = loadPreload();
  assert.equal(exposed.bf.pathForFile({ name: 'a.mp4' }), 'real:a.mp4');
});

test('a janela sem moldura usa só invoke/on: window:* passam, window:changed chega ao renderer e nada além disso é exposto', async () => {
  const { exposed, invoked, listeners } = loadPreload();
  const { bf } = exposed;
  for (const channel of ['window:state', 'window:minimize', 'window:maximize', 'window:fullscreen', 'window:close']) await bf.invoke(channel, channel === 'window:fullscreen' ? { exit: true } : undefined);
  assert.deepEqual(invoked.map(([channel]) => channel), ['window:state', 'window:minimize', 'window:maximize', 'window:fullscreen', 'window:close']);
  const seen = [];
  const off = bf.on('window:changed', (state) => seen.push(state));
  listeners.get('window:changed')[0]({}, { maximized: true, fullscreen: false, minimized: false });
  assert.deepEqual(seen, [{ maximized: true, fullscreen: false, minimized: false }]);
  off();
  assert.deepEqual(Object.keys(bf).sort(), ['invoke', 'on', 'pathForFile'], 'nenhuma API de janela solta (minimize(), close()...) vai para o renderer');
});

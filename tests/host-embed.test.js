'use strict';

/**
 * Protocolo de postMessage entre a ponte do renderer (renderer/bridge.js) e a página do hospedeiro (src/host/bfEmbedHost.js),
 * com janelas falsas ligadas entre si. O teste com o Electron de verdade está em tests/e2e/embed.e2e.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const BfEmbedHost = require('../src/host/bfEmbedHost');

const BRIDGE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'bridge.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 6; i += 1) await tick(); };

/** Janela falsa: addEventListener/dispatch e postMessage que entrega à janela de destino (com origin e source). */
function fakeWindow(name, { search = '', protocol = 'file:' } = {}) {
  const listeners = new Map();
  const win = {
    name, parent: null, posted: [],
    location: { search, protocol, origin: protocol === 'file:' ? 'file://' : 'http://host.local', href: `${protocol}//x/${name}` },
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn)); },
    dispatch(type, event) { for (const fn of [...(listeners.get(type) || [])]) fn(event); },
    count(type) { return (listeners.get(type) || []).length; },
    dispatchEvent(event) { win.dispatch(event.type, event); return true; },
    focus() {}
  };
  return win;
}

function fakeDocument(win) {
  const doc = {
    defaultView: win, dispatched: [],
    documentElement: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } },
    listeners: new Map(),
    addEventListener(type, fn) { doc.listeners.set(type, [...(doc.listeners.get(type) || []), fn]); },
    dispatchEvent(event) { doc.dispatched.push(event); return true; },
    createElement(tag) {
      const el = { tag, attrs: {}, style: {}, removed: false, contentWindow: null, setAttribute(k, v) { this.attrs[k] = v; }, remove() { this.removed = true; }, focus() { this.focused = true; } };
      return el;
    }
  };
  win.document = doc;
  return doc;
}

/**
 * Monta hospedeiro + iframe com a ponte carregada. `calls` registra o que chegou ao `invoke` do hospedeiro (é o que iria ao
 * processo principal). `toHost` = o que o iframe enviou; `toFrame` = o que o hospedeiro enviou.
 */
function build(hostOptions = {}, { frameSearch = '?embedded=1&hostOrigin=null' } = {}) {
  const hostWin = fakeWindow('host', { protocol: 'file:' });
  const hostDoc = fakeDocument(hostWin);
  hostWin.KeyboardEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
  const frameWin = fakeWindow('frame', { search: frameSearch });
  const frameDoc = fakeDocument(frameWin);
  frameWin.Event = class { constructor(type) { this.type = type; } };

  const toHost = [];
  const toFrame = [];
  // o que o hospedeiro enxerga do iframe (iframe.contentWindow) e o que o iframe enxerga do hospedeiro (window.parent)
  const iframeWindow = {
    postMessage: (data) => {
      toFrame.push(data);
      queueMicrotask(() => frameWin.dispatch('message', { source: frameWin.parent, origin: 'null', data }));
    }
  };
  frameWin.parent = {
    postMessage: (data) => {
      toHost.push(data);
      queueMicrotask(() => hostWin.dispatch('message', { source: iframeWindow, origin: 'null', data }));
    }
  };
  hostDoc.createElement = (tag) => ({
    tag, attrs: {}, style: {}, removed: false, contentWindow: iframeWindow,
    setAttribute(k, v) { this.attrs[k] = v; }, remove() { this.removed = true; }, focus() { this.focused = true; }
  });

  const calls = { invoke: [], pick: [], theme: [], errors: [], ready: 0 };
  const pushEvent = { handler: null };
  const container = { ownerDocument: hostDoc, appendChild(el) { this.child = el; } };
  const host = BfEmbedHost.create({
    container, src: 'file:///app/braga-frame/renderer/index.html',
    invoke: async (channel, payload) => { calls.invoke.push([channel, payload]); if (channel === 'x:explode') throw new Error('falhou no main'); return { ok: true, eco: payload }; },
    subscribe: (handler) => { pushEvent.handler = handler; return () => { pushEvent.handler = null; }; },
    pathForFile: async (file) => { calls.pick.push(file.name); return `C:\\Videos\\${file.name}`; },
    theme: () => 'light',
    onThemeChange: (theme) => calls.theme.push(theme),
    onError: (err) => calls.errors.push(err.message),
    onReady: () => { calls.ready += 1; },
    ...hostOptions
  });

  const context = vm.createContext({
    window: frameWin, document: frameDoc, console, URLSearchParams, Promise, setTimeout, clearTimeout,
    Event: frameWin.Event, Object, Error, Number, Map, Set, Array
  });
  vm.runInContext(BRIDGE_SOURCE, context, { filename: 'renderer/bridge.js' });
  const parentRef = frameWin.parent;
  const deliverToFrame = (data, over = {}) => frameWin.dispatch('message', { source: parentRef, origin: 'null', data, ...over });
  return { host, hostWin, hostDoc, frameWin, frameDoc, calls, pushEvent, toHost, toFrame, deliverToFrame, parentRef, iframeWindow };
}

const asJson = (value) => JSON.parse(JSON.stringify(value));

test('a ponte só existe quando não há preload e há um hospedeiro', () => {
  const fresh = (windowObj) => {
    const context = vm.createContext({ window: windowObj, document: fakeDocument(windowObj), console, URLSearchParams, Promise, setTimeout, clearTimeout, Object, Map, Set });
    vm.runInContext(BRIDGE_SOURCE, context);
    return windowObj;
  };
  const own = fakeWindow('own');
  own.parent = own;
  assert.equal(fresh(own).bf, undefined, 'janela própria sem preload: não cria nada (o app.js mostra o aviso)');

  const withPreload = fakeWindow('preloaded');
  withPreload.parent = fakeWindow('outra');
  const real = { invoke() {} };
  withPreload.bf = real;
  assert.equal(fresh(withPreload).bf, real, 'o window.bf do preload nunca é trocado');
  assert.equal(withPreload.parent.posted.length, 0);

  const framed = fakeWindow('framed');
  framed.parent = { postMessage() {} };
  const bridge = fresh(framed).bf;
  assert.deepEqual(Object.keys(bridge).sort(), ['invoke', 'on', 'pathForFile', 'transport']);
  assert.equal(bridge.transport, 'postMessage');
  assert.ok(Object.isFrozen(bridge));
});

test('handshake: o iframe avisa que carregou e o hospedeiro responde com o tema; a URL leva embedded, tema e origem', async () => {
  const t = build();
  await flush();
  assert.equal(t.calls.ready, 1);
  assert.deepEqual(asJson(t.toHost[0]), { source: 'braga-frame', version: 1, kind: 'ready' });
  const init = asJson(t.toFrame[0]);
  assert.deepEqual(init, { source: 'braga-frame', version: 1, kind: 'init', theme: 'light', forwardKeys: false });
  const src = new URL(t.host.iframe.src);
  assert.equal(src.searchParams.get('embedded'), '1');
  assert.equal(src.searchParams.get('theme'), 'light');
  assert.equal(src.searchParams.get('hostOrigin'), 'null');
  assert.equal(t.host.iframe.attrs.sandbox, undefined, 'sem sandbox por padrão');
  assert.equal(build({ sandbox: 'allow-scripts' }).host.iframe.attrs.sandbox, 'allow-scripts', 'mas dá para pedir');
  assert.equal(t.frameDoc.documentElement.getAttribute('data-theme'), 'light', 'tema aplicado mesmo antes de o BF existir');
});

test('invoke: a chamada do iframe chega ao invoke do hospedeiro e a resposta volta para a promessa certa', async () => {
  const t = build();
  const [a, b] = await Promise.all([
    t.frameWin.bf.invoke('tools:status', { x: 1 }),
    t.frameWin.bf.invoke('app:info')
  ]);
  assert.deepEqual(asJson(a), { ok: true, eco: { x: 1 } });
  assert.deepEqual(asJson(b), { ok: true });
  assert.deepEqual(t.calls.invoke.map(([channel]) => channel), ['tools:status', 'app:info']);
  assert.deepEqual(asJson(t.calls.invoke[0][1]), { x: 1 });
  assert.equal(t.calls.invoke[1][1], undefined);
});

test('uma falha do hospedeiro vira rejeição na ponte (e o app.js a transforma em IPC_ERROR)', async () => {
  const t = build();
  await assert.rejects(() => t.frameWin.bf.invoke('x:explode'), /falhou no main/);
  assert.deepEqual(t.calls.errors, ['falhou no main']);
});

test('canais fora do formato nunca saem do iframe nem chegam ao hospedeiro', async () => {
  const t = build();
  await flush();
  for (const bad of ['', 'info', 'App:info', 'app:info:x', 'a:b-c', '../x:y', 5, null, undefined, {}]) {
    await assert.rejects(() => t.frameWin.bf.invoke(bad), /Canal IPC inválido/, String(bad));
    assert.throws(() => t.frameWin.bf.on(bad, () => {}), /Canal IPC inválido/, String(bad));
  }
  assert.equal(t.calls.invoke.length, 0);
  assert.equal(t.toHost.filter((m) => m.kind === 'invoke').length, 0);
  assert.throws(() => t.frameWin.bf.on('a:b', 'não é função'), /função/);
});

test('o hospedeiro revalida o canal e o id de uma mensagem forjada', async () => {
  const t = build();
  await flush();
  const forge = (data) => t.hostWin.dispatch('message', { source: t.iframeWindow, origin: 'null', data });
  forge({ source: 'braga-frame', kind: 'invoke', id: 77, channel: '../../etc:passwd', payload: {} });
  forge({ source: 'braga-frame', kind: 'invoke', id: 78, channel: 'window:close\n', payload: {} });
  forge({ source: 'braga-frame', kind: 'invoke', id: 'abc', channel: 'app:info' });
  forge({ source: 'braga-frame', kind: 'invoke', id: -1, channel: 'app:info' });
  forge({ source: 'braga-frame', kind: 'invoke', id: 1.5, channel: 'app:info' });
  await flush();
  assert.equal(t.calls.invoke.length, 0, 'nada chegou ao processo principal');
  const replies = t.toFrame.filter((m) => m.kind === 'result');
  assert.deepEqual(replies.map((m) => [m.id, m.ok]), [[77, false], [78, false]], 'as de id válido recebem erro; as sem id são descartadas');
  assert.match(replies[0].error, /Canal inválido/);
});

test('mensagens de outra janela, de outra origem ou fora do formato são ignoradas nos dois lados', async () => {
  const t = build();
  await flush();
  const before = t.calls.invoke.length;
  const good = { source: 'braga-frame', kind: 'invoke', id: 5, channel: 'app:info' };
  const intruder = { postMessage() {} };
  t.hostWin.dispatch('message', { source: intruder, origin: 'null', data: good }); // janela errada
  t.hostWin.dispatch('message', { source: t.iframeWindow, origin: 'https://evil.example', data: good }); // origem errada
  for (const data of [null, 'texto', 7, [], { kind: 'invoke', id: 5, channel: 'app:info' }, { source: 'outro', kind: 'invoke', id: 5, channel: 'app:info' }, { source: 'braga-frame', kind: 5 }]) {
    t.hostWin.dispatch('message', { source: t.iframeWindow, origin: 'null', data });
  }
  await flush();
  assert.equal(t.calls.invoke.length, before);

  // lado do iframe: resultado forjado por quem não é o parent, ou com origem errada, não resolve nada
  let resolved = false;
  const pendingCall = t.frameWin.bf.invoke('app:info').then(() => { resolved = true; });
  await tick();
  const sentId = t.toHost.filter((m) => m.kind === 'invoke').at(-1).id;
  t.frameWin.dispatch('message', { source: intruder, origin: 'null', data: { source: 'braga-frame', kind: 'result', id: sentId, ok: true, value: { ok: true, falso: true } } });
  t.frameWin.dispatch('message', { source: t.parentRef, origin: 'https://evil.example', data: { source: 'braga-frame', kind: 'result', id: sentId, ok: true, value: { ok: true, falso: true } } });
  await tick();
  // (a origem acima é "null": a segunda mensagem é recusada por causa de ?hostOrigin=null)
  await pendingCall; // a resposta verdadeira (do hospedeiro) resolve
  assert.equal(resolved, true);
});

test('eventos: só chegam os canais assinados, e cancelar a escuta avisa o hospedeiro', async () => {
  const t = build();
  await flush();
  const got = [];
  const off = t.frameWin.bf.on('queue:update', (p) => got.push(['q', p]));
  const off2 = t.frameWin.bf.on('queue:update', (p) => got.push(['q2', p]));
  await flush();
  assert.equal(t.toHost.filter((m) => m.kind === 'on').length, 1, 'a segunda escuta do mesmo canal não repete o aviso');

  t.pushEvent.handler({ channel: 'queue:update', payload: { n: 1 } });
  t.pushEvent.handler({ channel: 'sources:progress', payload: { n: 2 } }); // não assinado: nem sai do hospedeiro
  await flush();
  assert.deepEqual(asJson(got), [['q', { n: 1 }], ['q2', { n: 1 }]]);
  assert.equal(t.toFrame.filter((m) => m.kind === 'event').length, 1);

  off();
  t.pushEvent.handler({ channel: 'queue:update', payload: { n: 3 } });
  await flush();
  assert.equal(got.length, 3, 'a outra escuta continua');
  off(); off2(); off2(); // idempotente
  assert.equal(t.toHost.filter((m) => m.kind === 'off').length, 1, 'off só quando a última escuta sai');
  t.pushEvent.handler({ channel: 'queue:update', payload: { n: 4 } });
  await flush();
  assert.equal(got.length, 3);
});

test('um ouvinte de evento que lança não impede os outros', async () => {
  const t = build();
  await flush();
  const got = [];
  const original = console.error;
  console.error = () => {};
  try {
    t.frameWin.bf.on('a:b', () => { throw new Error('ouvinte ruim'); });
    t.frameWin.bf.on('a:b', (p) => got.push(p));
    await flush();
    t.pushEvent.handler({ channel: 'a:b', payload: 7 });
    await flush();
  } finally { console.error = original; }
  assert.deepEqual(got, [7]);
});

test('tema: o hospedeiro muda o tema e o usuário muda dentro do app (sem eco)', async () => {
  const t = build();
  await flush();
  let applied = null;
  const emitted = [];
  const handlers = [];
  t.frameWin.BF = { ui: { theme: () => applied || 'light', setTheme: (v) => { applied = v; for (const h of handlers) h({ theme: v }); } }, bus: { on: (name, fn) => { if (name === 'theme:changed') handlers.push(fn); } } };
  t.frameDoc.listeners.get('DOMContentLoaded')[0](); // todos os scripts já rodaram
  t.host.setTheme('dark');
  await flush();
  assert.equal(applied, 'dark');
  assert.equal(t.toHost.some((m) => m.kind === 'theme-changed'), false, 'o que veio do hospedeiro não volta para ele');

  handlers[0]({ theme: 'light' }); // o usuário usa o botão de tema do app
  await flush();
  assert.deepEqual(t.calls.theme, ['light']);
  handlers[0]({ theme: 'dark' });
  await flush();
  assert.deepEqual(t.calls.theme, ['light', 'dark'], 'a volta ao tema anterior também é avisada');
  t.host.setTheme('azul'); // inválido: ignorado
  assert.equal(emitted.length, 0);
});

test('arrastar e soltar: o drop é interceptado, o caminho vem do hospedeiro e só então o vídeo abre', async () => {
  const t = build();
  await flush();
  const opened = [];
  const counts = [];
  t.frameWin.BF = { openSource: (p) => opened.push(p), ui: { toast: (m, k) => opened.push([m, k]), droppedMany: (n) => counts.push(n) } };
  const file = { name: 'live.mp4' };
  const captured = [];
  t.frameWin.dispatchEvent = (e) => { captured.push(e.type); return true; };
  const flags = { prevented: false, stopped: false };
  const event = { type: 'drop', dataTransfer: { types: ['Files'], files: [file] }, preventDefault() { flags.prevented = true; }, stopImmediatePropagation() { flags.stopped = true; } };
  t.frameWin.dispatch('drop', event);
  assert.equal(flags.prevented && flags.stopped, true, 'o shell não chega a ver o drop (ele pediria o caminho de forma síncrona)');
  assert.ok(captured.filter((n) => n === 'dragleave').length >= 4, 'zera o destaque do shell');
  await flush();
  assert.deepEqual(t.calls.pick, ['live.mp4']);
  assert.deepEqual(opened, ['C:\\Videos\\live.mp4']);
  assert.deepEqual(counts, [1], 'o app recebe quantos arquivos vieram (um só: nenhum aviso)');

  // vários arquivos: só o primeiro tem o caminho pedido e abre; o app recebe a contagem para avisar do resto
  t.frameWin.dispatch('drop', { type: 'drop', dataTransfer: { types: ['Files'], files: [{ name: 'a.mp4' }, { name: 'b.mp4' }, { name: 'c.mp4' }] }, preventDefault() {}, stopImmediatePropagation() {} });
  await flush();
  assert.deepEqual(t.calls.pick, ['live.mp4', 'a.mp4']);
  assert.deepEqual(opened, ['C:\\Videos\\live.mp4', 'C:\\Videos\\a.mp4']);
  assert.deepEqual(counts, [1, 3]);

  // soltar algo que não é arquivo não é tocado
  const text = { type: 'drop', dataTransfer: { types: ['text/plain'], files: [] }, preventDefault() { throw new Error('não deveria'); }, stopImmediatePropagation() { throw new Error('não deveria'); } };
  t.frameWin.dispatch('drop', text);
});

test('arrastar e soltar sem pathForFile no hospedeiro: o usuário é avisado e nada abre', async () => {
  const t = build({ pathForFile: undefined });
  await flush();
  const seen = [];
  t.frameWin.BF = { openSource: (p) => seen.push(['abriu', p]), ui: { toast: (m, k) => seen.push([k, m]) } };
  t.frameWin.dispatchEvent = () => true;
  t.frameWin.dispatch('drop', { type: 'drop', dataTransfer: { types: ['Files'], files: [{ name: 'x.mp4' }] }, preventDefault() {}, stopImmediatePropagation() {} });
  await flush();
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'error');
  assert.match(seen[0][1], /Abrir vídeo/);
});

test('teclado: só vai ao hospedeiro se ele pediu (forwardKeys), só com Ctrl/Alt/Meta e uma tecla de verdade', async () => {
  const quiet = build();
  await flush();
  const key = (over) => ({ type: 'keydown', key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, defaultPrevented: false, ...over });
  quiet.frameWin.dispatch('keydown', key());
  await flush();
  assert.equal(quiet.toHost.some((m) => m.kind === 'key'), false, 'sem forwardKeys nada é enviado');

  const t = build({ forwardKeys: true });
  await flush();
  t.frameWin.dispatch('keydown', key());
  t.frameWin.dispatch('keydown', key({ key: 'Control', ctrlKey: true })); // só o modificador
  t.frameWin.dispatch('keydown', key({ ctrlKey: false })); // digitação normal
  t.frameWin.dispatch('keydown', key({ defaultPrevented: true })); // o app já tratou
  await flush();
  const keys = t.toHost.filter((m) => m.kind === 'key');
  assert.equal(keys.length, 1);
  assert.equal(t.hostDoc.dispatched.length, 1);
  assert.equal(t.hostDoc.dispatched[0].key, 'k');
  assert.equal(t.hostDoc.dispatched[0].ctrlKey, true);
});

test('sem init do hospedeiro a tempo, as chamadas pendentes falham com uma mensagem clara', async () => {
  const timers = { fire: null, setTimeout: (fn) => { timers.fire = fn; return 1; }, clearTimeout() {} };
  // hospedeiro mudo: nenhuma resposta
  const hostWin = fakeWindow('host');
  const frameWin = fakeWindow('frame', { search: '?embedded=1' });
  frameWin.parent = { postMessage() {} };
  const context = vm.createContext({ window: frameWin, document: fakeDocument(frameWin), console, URLSearchParams, Promise, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, Event, Object, Error, Map, Set });
  vm.runInContext(BRIDGE_SOURCE, context);
  const pending = frameWin.bf.invoke('app:info');
  assert.equal(typeof timers.fire, 'function');
  timers.fire();
  await assert.rejects(() => pending, /não respondeu/);
  assert.ok(hostWin);
});

test('destroy: tira o iframe, solta o ouvinte de mensagens e a assinatura de eventos; depois disso nada chega', async () => {
  const t = build();
  await flush();
  assert.equal(t.hostWin.count('message'), 1);
  assert.ok(t.pushEvent.handler);
  t.host.destroy();
  assert.equal(t.host.destroyed, true);
  assert.equal(t.host.iframe.removed, true);
  assert.equal(t.host.iframe.src, 'about:blank');
  assert.equal(t.hostWin.count('message'), 0);
  assert.equal(t.pushEvent.handler, null);
  t.host.destroy(); // idempotente
  const before = t.calls.invoke.length;
  t.hostWin.dispatch('message', { source: t.iframeWindow, origin: 'null', data: { source: 'braga-frame', kind: 'invoke', id: 9, channel: 'app:info' } });
  await flush();
  assert.equal(t.calls.invoke.length, before);
});

test('isChannelAllowed restringe o que o iframe pode chamar e assinar', async () => {
  const t = build({ isChannelAllowed: (channel) => !channel.startsWith('tools:') });
  await flush();
  const denied = await t.frameWin.bf.invoke('tools:install', {}).catch((e) => e);
  assert.ok(denied instanceof Error);
  assert.match(denied.message, /não permitido/);
  assert.equal(t.calls.invoke.length, 0);
  assert.deepEqual(asJson(await t.frameWin.bf.invoke('queue:list')), { ok: true });
});

test('create valida as opções; buildFrameUrl e a origem esperada', () => {
  const container = { ownerDocument: fakeDocument(fakeWindow('h')), appendChild() {} };
  assert.throws(() => BfEmbedHost.create({}), /container/);
  assert.throws(() => BfEmbedHost.create({ container }), /src/);
  assert.throws(() => BfEmbedHost.create({ container, src: 'file:///x/index.html' }), /invoke/);
  const url = new URL(BfEmbedHost.buildFrameUrl('file:///D:/BDS/braga-frame/renderer/index.html', { theme: 'dark', hostOrigin: 'null' }));
  assert.equal(url.protocol, 'file:');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['embedded', 'hostOrigin', 'theme']);
  assert.equal(new URL(BfEmbedHost.buildFrameUrl('file:///x/index.html', { theme: 'verde' })).searchParams.has('theme'), false);
  assert.equal(BfEmbedHost.expectedFrameOrigin('file:///x/index.html'), 'null');
  assert.equal(BfEmbedHost.expectedFrameOrigin('http://localhost:5173/index.html'), 'http://localhost:5173');
  assert.equal(BfEmbedHost.expectedFrameOrigin('http://localhost:5173/index.html', 'allow-scripts'), 'null', 'sandbox sem allow-same-origin = origem opaca');
});

test('setVisible(false) pausa o player do Braga Frame; mostrar de novo não faz nada', async () => {
  const t = build();
  await flush();
  const calls = [];
  t.frameWin.BF = { player: { pause: () => calls.push('pause') } };
  t.host.setVisible(true);
  await flush();
  assert.deepEqual(calls, []);
  t.host.setVisible(false);
  await flush();
  assert.deepEqual(calls, ['pause']);
});

test('close(): o iframe grava o projeto antes de sair (nada que ainda espera o salvamento se perde)', async () => {
  const t = build();
  await flush();
  const order = [];
  t.frameWin.BF = {
    player: { pause: () => order.push('pause') },
    project: { flush: () => new Promise((resolve) => setTimeout(() => { order.push('flush'); resolve(true); }, 30)) }
  };
  // o hospedeiro continua atendendo o que o iframe pedir durante o fechamento (o project:save do flush)
  const closing = t.host.close();
  const saved = await closing;
  assert.equal(saved, true);
  assert.deepEqual(order, ['pause', 'flush']);
  assert.equal(t.host.destroyed, true);
  assert.equal(t.host.iframe.removed, true);
  assert.equal(await t.host.close(), true, 'fechar de novo é inofensivo');
});

test('close(): sem resposta do iframe, expira no prazo e remove mesmo assim; com flush que falha, ainda confirma', async () => {
  const mute = build({}, {});
  await flush();
  // o iframe não responde ao prepare-close (a ponte nem recebe a mensagem)
  mute.frameWin.dispatch = () => {};
  assert.equal(await mute.host.close({ timeout: 40 }), false);
  assert.equal(mute.host.destroyed, true);

  const broken = build();
  await flush();
  broken.frameWin.BF = { project: { flush: () => Promise.reject(new Error('disco cheio')) } };
  assert.equal(await broken.host.close(), true, 'a ponte confirma mesmo se o flush falhar (o app mostra o erro por conta própria)');
  assert.equal(broken.host.destroyed, true);
});

test('close() antes de o iframe ficar pronto só destrói', async () => {
  const hostWin = fakeWindow('host');
  const hostDoc = fakeDocument(hostWin);
  hostDoc.createElement = () => ({ attrs: {}, style: {}, removed: false, contentWindow: { postMessage() {} }, setAttribute() {}, remove() { this.removed = true; } });
  const host = BfEmbedHost.create({ container: { ownerDocument: hostDoc, appendChild() {} }, src: 'file:///x/index.html', invoke: async () => ({ ok: true }) });
  assert.equal(host.ready, false);
  assert.equal(await host.close(), true);
  assert.equal(host.destroyed, true);
});

test('o destino do postMessage do iframe: a origem http(s) conhecida quando há; "*" para hospedeiro file:// (origem opaca "null" não é destino válido)', () => {
  const targets = (hostOrigin) => {
    const framed = fakeWindow('framed', { search: hostOrigin === undefined ? '' : `?hostOrigin=${encodeURIComponent(hostOrigin)}` });
    const seen = [];
    framed.parent = { postMessage: (data, target) => seen.push(target) };
    const context = vm.createContext({ window: framed, document: fakeDocument(framed), console, URLSearchParams, Promise, setTimeout, clearTimeout, Object, Map, Set, Error, Number, Array });
    vm.runInContext(BRIDGE_SOURCE, context, { filename: 'renderer/bridge.js' });
    return seen;
  };
  assert.deepEqual([...new Set(targets('null'))], ['*'], 'hospedeiro file://: a origem opaca não vira destino');
  assert.deepEqual([...new Set(targets(undefined))], ['*'], 'sem hostOrigin');
  assert.deepEqual([...new Set(targets('http://127.0.0.1:5173'))], ['http://127.0.0.1:5173'], 'origem http conhecida: só ela recebe');
  assert.deepEqual([...new Set(targets('https://studio.exemplo.com'))], ['https://studio.exemplo.com']);
  assert.deepEqual([...new Set(targets('javascript:alert(1)'))], ['*'], 'valor estranho não vira destino');
});

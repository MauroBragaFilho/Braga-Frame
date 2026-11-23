'use strict';

/**
 * renderer/features/update.js por dentro (DOM de mentira): o estado que o main manda (disponível, baixando, pronta, instalando), a faixa de cada um, o que cada botão
 * pede, "Agora não" por versão, os dois interruptores, "baixar sozinho" e o que acontece ao abrir (inclusive uma atualização já baixada de antes). O cartão da tela
 * Geral é testado em general-ui.test.js; o app inteiro, em tests/e2e/update.e2e.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDocument, makeEl } = require('./prefs-fakedom');
const { extendFakeDom } = require('./fakedom-extra');

extendFakeDom();

const CODE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features', 'update.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const idle = async () => { for (let i = 0; i < 8; i += 1) await tick(); };
const plain = (v) => JSON.parse(JSON.stringify(v));

const ASSET = { name: 'braga-frame-0.2.0-windows-x64-setup.exe', size: 1000, sha256: 'ab'.repeat(32), url: 'https://github.com/x/y/releases/download/v0.2.0/b.exe' };
const AVAILABLE = { status: 'available', current: '0.1.0', latest: { version: '0.2.0', asset: ASSET }, url: 'https://github.com/x/y/releases/tag/v0.2.0' };
const AVAILABLE_NO_ASSET = { ...AVAILABLE, latest: { version: '0.2.0', asset: null } };
const CURRENT = { status: 'current', current: '0.2.0', latest: { version: '0.2.0', asset: null } };
const READY = { version: '0.2.0', tag: 'v0.2.0', name: ASSET.name, sizeBytes: 1000, sha256: ASSET.sha256, signature: { status: 'NotSigned', subject: null, text: 'Sem assinatura digital: a conferência é o SHA-256, que bate com o da Release.' } };
const snap = (over = {}) => ({ phase: 'idle', check: AVAILABLE, download: null, ready: null, error: null, installOnQuit: false, ...over });

function load({ store: initial = {}, embedded = false, routes = {} } = {}) {
  const doc = createDocument();
  const note = doc.register('updateNote');
  const store = new Map(Object.entries(initial));
  const calls = [];
  const emitted = [];
  const timers = [];
  const listeners = new Map();
  const answers = { 'app:updateCheck': { ok: true, ...AVAILABLE }, 'app:updateState': { ok: true, ...snap({ check: null }) }, 'app:updateDownload': { ok: true, started: true }, 'app:updateInstall': { ok: true }, 'app:updateCancel': { ok: true }, 'app:updateOpen': { ok: true }, ...routes };
  const BF = {
    embedded,
    util: { el: makeEl(doc) },
    state: { app: { version: '0.1.0' } },
    local: { get: (key, fallback = null) => (store.has(key) ? store.get(key) : fallback), set: (key, value) => { store.set(key, String(value)); return true; } },
    bus: { emit: (name) => { emitted.push(name); } },
    on: (channel, cb) => { listeners.set(channel, cb); },
    api: async (channel, payload, opts) => { calls.push([channel, payload === undefined ? undefined : plain(payload), opts ? plain(opts) : undefined]); const a = answers[channel]; return typeof a === 'function' ? a() : a; },
    ready: Promise.resolve()
  };
  const context = { window: { BF }, document: doc, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } };
  vm.runInContext(CODE, vm.createContext(context), { filename: 'update.js' });
  const buttons = () => note.querySelectorAll('button').map((b) => b.dataset.act);
  const click = (act) => note.querySelectorAll('button').find((b) => b.dataset.act === act).click();
  const called = (channel) => calls.filter(([c]) => c === channel);
  return { BF, U: BF.update, note, store, calls, emitted, timers, listeners, answers, buttons, click, called, push: (s) => listeners.get('update:state')(s) };
}

test('describe: cada resultado da consulta em palavras, com o tom e se há o que abrir', () => {
  const { U } = load();
  assert.deepEqual(plain(U.describe(null)), { text: '', kind: '', canOpen: false });
  assert.deepEqual(plain(U.describe(AVAILABLE)), { text: 'Nova versão 0.2.0 disponível (você usa a 0.1.0).', kind: 'info', canOpen: true });
  assert.deepEqual(plain(U.describe(CURRENT)), { text: 'Você está na versão mais recente (0.2.0).', kind: 'ok', canOpen: false });
  assert.equal(U.describe({ status: 'none', current: '0.1.0' }).text, 'O projeto ainda não publicou nenhuma versão para comparar.');
  assert.deepEqual(plain(U.describe({ status: 'error', message: 'Sem conexão.' })), { text: 'Sem conexão.', kind: 'warn', canOpen: false });
  assert.equal(U.describe({ status: 'error' }).text, 'Não consegui verificar agora.');
  assert.deepEqual(plain(U.describe({ status: 'disabled' })), { text: '', kind: '', canOpen: false });
});

test('view: o que o cartão mostra em cada momento e quais botões fazem sentido', () => {
  const t = load();
  const v = (s) => { t.U.apply(s); return plain(t.U.view()); };
  assert.deepEqual(v(snap({ check: AVAILABLE })).show, { download: true, install: false, open: true, cancel: false });
  assert.deepEqual(v(snap({ check: AVAILABLE_NO_ASSET })).show, { download: false, install: false, open: true, cancel: false }, 'sem instalador conferível só há a página da Release');
  assert.equal(v(snap({ check: CURRENT })).show.open, false);
  const checking = v(snap({ phase: 'checking' }));
  assert.deepEqual([checking.text, checking.busy], ['Verificando…', true]);
  const dl = v(snap({ phase: 'downloading', download: { received: 400, total: 1000, percent: 40.7 } }));
  assert.deepEqual([dl.text, dl.busy, dl.show.cancel], ['Baixando a versão 0.2.0… 40%', true, true]);
  const rd = v(snap({ phase: 'ready', ready: READY }));
  assert.match(rd.text, /A versão 0\.2\.0 está pronta e verificada \(tamanho e SHA-256 conferidos\)/);
  assert.match(rd.sub, /Sem assinatura digital/);
  assert.deepEqual([rd.show.install, rd.show.open, rd.busy], [true, true, false]);
  assert.match(v(snap({ phase: 'ready', ready: READY, installOnQuit: true })).sub, /instalada quando você fechar o Braga Frame/);
  assert.match(v(snap({ phase: 'installing', ready: READY })).text, /Instalando a versão 0\.2\.0… o Braga Frame vai reiniciar/);
  const err = v(snap({ error: { code: 'HASH', message: 'A atualização foi recusada: o SHA-256 não confere.' } }));
  assert.deepEqual([err.text, err.kind, err.show.download], ['A atualização foi recusada: o SHA-256 não confere.', 'warn', true]);
});

test('a faixa acompanha o estado: nova versão → baixando → pronta (3 escolhas) → instalando; sem nada a fazer fica escondida', async () => {
  const t = load();
  t.push(snap({ check: AVAILABLE }));
  assert.equal(t.note.hidden, false);
  assert.match(t.note.textContent, /Nova versão 0\.2\.0 do Braga Frame disponível \(você usa a 0\.1\.0\)\. Seus projetos continuam como estão\./);
  assert.deepEqual(t.buttons(), ['update-download', 'update-open', 'update-dismiss']);

  t.push(snap({ check: AVAILABLE_NO_ASSET }));
  assert.deepEqual(t.buttons(), ['update-open', 'update-dismiss']);
  assert.equal(t.note.querySelector('[data-act="update-open"]').textContent, 'Ver e baixar');

  t.push(snap({ phase: 'downloading', download: { received: 250, total: 1000, percent: 25 } }));
  assert.match(t.note.textContent, /Baixando a versão 0\.2\.0… 25%/);
  assert.deepEqual(t.buttons(), ['update-cancel']);

  t.push(snap({ phase: 'ready', ready: READY }));
  assert.match(t.note.textContent, /Versão 0\.2\.0 pronta para instalar \(seus projetos continuam como estão\)\./);
  assert.deepEqual(t.buttons(), ['update-install-now', 'update-install-quit', 'update-dismiss']);
  assert.deepEqual(t.note.querySelectorAll('button').map((b) => b.textContent), ['Instalar e reiniciar', 'Instalar quando eu fechar', 'Agora não']);

  t.push(snap({ phase: 'ready', ready: READY, installOnQuit: true }));
  assert.match(t.note.textContent, /será instalada quando você fechar o Braga Frame/);
  assert.deepEqual(t.buttons(), ['update-install-now', 'update-install-none']);

  t.push(snap({ phase: 'installing', ready: READY }));
  assert.match(t.note.textContent, /Instalando a versão 0\.2\.0… o Braga Frame vai reiniciar/);
  assert.deepEqual(t.buttons(), [], 'instalando: nada a clicar');

  for (const s of [snap({ check: CURRENT }), snap({ check: { status: 'none', current: '0.1.0' } }), snap({ check: AVAILABLE, error: { code: 'HASH', message: 'x' } }), snap({ phase: 'checking' })]) {
    t.push(s);
    assert.equal(t.note.hidden, true, JSON.stringify(s.check && s.check.status) + (s.error ? ' com erro' : ''));
  }
});

test('cada botão da faixa pede ao main a coisa certa (e o erro vira aviso, nunca silêncio)', async () => {
  const t = load();
  t.push(snap({ check: AVAILABLE }));
  t.click('update-download');
  t.click('update-open');
  t.push(snap({ phase: 'downloading', download: { received: 1, total: 10, percent: 10 } }));
  t.click('update-cancel');
  t.push(snap({ phase: 'ready', ready: READY }));
  t.click('update-install-now');
  t.click('update-install-quit');
  t.push(snap({ phase: 'ready', ready: READY, installOnQuit: true }));
  t.click('update-install-none');
  await idle();
  assert.deepEqual(t.calls.filter(([c]) => c !== 'app:updateState').map(([c, p, o]) => [c, p, o]), [
    ['app:updateDownload', {}, { toast: true }],
    ['app:updateOpen', {}, { toast: true }],
    ['app:updateCancel', {}, { toast: true }],
    ['app:updateInstall', { when: 'now' }, { toast: true }],
    ['app:updateInstall', { when: 'quit' }, { toast: true }],
    ['app:updateInstall', { when: 'none' }, { toast: true }]
  ]);
});

test('"Agora não" cala a faixa DESTA versão (disponível ou pronta); uma versão mais nova avisa de novo; instalando nunca é calado', () => {
  const t = load();
  t.push(snap({ check: AVAILABLE }));
  t.click('update-dismiss');
  assert.equal(t.note.hidden, true);
  assert.equal(t.store.get('updateDismissed'), '0.2.0');
  t.push(snap({ phase: 'ready', ready: READY }));
  assert.equal(t.note.hidden, true, 'pronta, mas já dispensada');
  t.push(snap({ phase: 'installing', ready: READY }));
  assert.equal(t.note.hidden, false, 'se o usuário mandou instalar, o aviso de que está instalando aparece');
  t.push(snap({ check: { ...AVAILABLE, latest: { version: '0.3.0', asset: ASSET } } }));
  assert.equal(t.note.hidden, false, 'a 0.3.0 é outra');
  assert.match(t.note.textContent, /0\.3\.0/);
  assert.equal(t.U.view().show.download, true, 'o cartão da Geral continua oferecendo a dispensada');
});

test('aviso desligado: a faixa nunca aparece e nada é baixado sozinho; "Verificar agora" funciona; ligar de novo consulta se ainda não há resultado', async () => {
  const t = load({ store: { updateCheck: '0' } });
  assert.equal(t.U.enabled(), false);
  t.push(snap({ check: AVAILABLE }));
  assert.equal(t.note.hidden, true);
  await t.U.check({ force: true });
  assert.equal(t.called('app:updateDownload').length, 0, 'desligado: nem a verificação manual baixa sozinha');
  assert.equal(t.U.view().show.download, true, 'o cartão mostra e deixa baixar quem pediu');
  const fresh = load({ store: { updateCheck: '0' } });
  fresh.U.setEnabled(true);
  await idle();
  assert.equal(fresh.store.get('updateCheck'), '1');
  assert.equal(fresh.called('app:updateCheck').length, 1);
});

test('baixar sozinho: achando versão nova com instalador conferível, começa a baixar (uma vez); desligado, sem instalador, ou já pronta, não', async () => {
  const on = load();
  await on.U.check();
  assert.deepEqual(on.called('app:updateDownload').length, 1);
  assert.deepEqual(on.called('app:updateCheck').map(([, p]) => p.force), [false]);

  const manual = load();
  await manual.U.check({ force: true });
  assert.equal(manual.called('app:updateDownload').length, 1, 'a verificação manual também baixa quando está ligado');

  const off = load({ store: { updateAutoDownload: '0' } });
  await off.U.check();
  assert.equal(off.called('app:updateDownload').length, 0);
  off.U.setAutoDownload(true); // ligar com versão nova já à vista baixa na hora
  await idle();
  assert.equal(off.called('app:updateDownload').length, 1);

  const noAsset = load({ routes: { 'app:updateCheck': { ok: true, ...AVAILABLE_NO_ASSET } } });
  await noAsset.U.check();
  assert.equal(noAsset.called('app:updateDownload').length, 0, 'sem instalador conferível não há o que baixar');

  const already = load();
  already.push(snap({ phase: 'ready', ready: READY }));
  await already.U.check();
  assert.equal(already.called('app:updateDownload').length, 0, 'já está pronta');

  const busy = load();
  busy.push(snap({ phase: 'downloading', download: { received: 1, total: 2, percent: 50 } }));
  await busy.U.check();
  assert.equal(busy.called('app:updateDownload').length, 0, 'já está baixando');
});

test('ao abrir: busca o estado (uma atualização já baixada volta pronta, com a faixa) e agenda UMA consulta para 4 s depois, só com o aviso ligado', async () => {
  const t = load({ routes: { 'app:updateState': { ok: true, ...snap({ phase: 'ready', ready: READY }) } } });
  await idle();
  assert.deepEqual(t.called('app:updateState').length, 1);
  assert.equal(t.note.hidden, false, 'pronta de uma execução anterior: a faixa já aparece');
  assert.deepEqual(t.buttons(), ['update-install-now', 'update-install-quit', 'update-dismiss']);
  assert.equal(t.timers.length, 1);
  assert.equal(t.timers[0].ms, 4000);
  assert.equal(t.called('app:updateCheck').length, 0, 'nada acontece antes do prazo');
  t.timers[0].fn();
  await idle();
  assert.deepEqual(t.called('app:updateCheck').map(([, p]) => p.force), [false]);

  const off = load({ store: { updateCheck: '0' } });
  await idle();
  off.timers[0].fn();
  await idle();
  assert.equal(off.called('app:updateCheck').length, 0, 'desligado: não consulta');

  const embedded = load({ embedded: true });
  await idle();
  assert.deepEqual([embedded.timers.length, embedded.calls.length, embedded.listeners.size], [0, 0, 0], 'dentro do BDS nada é pedido nem ouvido');
});

test('falha na comunicação com o app vira resultado de erro (sem lançar); resposta lixo do main é ignorada', async () => {
  const t = load({ routes: { 'app:updateCheck': { ok: false, message: 'Falha na comunicação com o app.' } } });
  const r = await t.U.check();
  assert.deepEqual([r.status, r.message], ['error', 'Falha na comunicação com o app.']);
  assert.equal(t.note.hidden, true);
  for (const junk of [null, undefined, 5, 'x']) t.U.apply(junk);
  assert.equal(t.U.state.phase, 'idle');
});

test('o evento "idle" que chega depois da resposta da consulta não desfaz o estado: duas consultas seguidas viram uma', async () => {
  let release;
  const t = load({ routes: { 'app:updateCheck': () => new Promise((resolve) => { release = () => resolve({ ok: true, ...AVAILABLE }); }) } });
  t.push(snap({ phase: 'checking', check: null }));
  const second = await t.U.check(); // já verificando: não pede de novo
  assert.equal(second, null);
  assert.equal(t.called('app:updateCheck').length, 0);
  t.push(snap({ phase: 'idle', check: null }));
  const a = t.U.check();
  release();
  await a;
  assert.equal(t.called('app:updateCheck').length, 1);
});

'use strict';

/**
 * renderer/features/update.js por dentro (DOM de mentira): a faixa de versão nova, "Agora não" por versão, o interruptor, o resultado em palavras e a
 * consulta ao abrir. O cartão da tela Geral é testado em general-ui.test.js; o app inteiro, em tests/e2e/update.e2e.js.
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
const idle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };
const plain = (v) => JSON.parse(JSON.stringify(v));

const AVAILABLE = { ok: true, status: 'available', current: '0.1.0', latest: { version: '0.2.0' }, url: 'https://github.com/x/y/releases/tag/v0.2.0' };
const CURRENT = { ok: true, status: 'current', current: '0.2.0', latest: { version: '0.2.0' } };

function load({ store: initial = {}, embedded = false, routes = { 'app:updateCheck': AVAILABLE, 'app:updateOpen': { ok: true } } } = {}) {
  const doc = createDocument();
  const note = doc.register('updateNote');
  const store = new Map(Object.entries(initial));
  const calls = [];
  const emitted = [];
  const timers = [];
  const BF = {
    embedded,
    util: { el: makeEl(doc) },
    state: { app: { version: '0.1.0' } },
    local: { get: (key, fallback = null) => (store.has(key) ? store.get(key) : fallback), set: (key, value) => { store.set(key, String(value)); return true; } },
    bus: { emit: (name) => { emitted.push(name); } },
    api: async (channel, payload, opts) => { calls.push([channel, plain(payload), opts ? plain(opts) : undefined]); const answer = routes[channel]; return typeof answer === 'function' ? answer() : answer; },
    ready: Promise.resolve()
  };
  const context = { window: { BF }, document: doc, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } };
  vm.runInContext(CODE, vm.createContext(context), { filename: 'update.js' });
  return { BF, U: BF.update, note, store, calls, emitted, timers, routes };
}

test('describe: cada resultado em palavras, com o tom e se há o que baixar', () => {
  const { U } = load();
  assert.deepEqual(plain(U.describe(null)), { text: '', kind: '', canOpen: false });
  assert.deepEqual(plain(U.describe(AVAILABLE)), { text: 'Nova versão 0.2.0 disponível (você usa a 0.1.0).', kind: 'info', canOpen: true });
  assert.deepEqual(plain(U.describe(CURRENT)), { text: 'Você está na versão mais recente (0.2.0).', kind: 'ok', canOpen: false });
  assert.deepEqual(plain(U.describe({ status: 'none', current: '0.1.0' })), { text: 'O projeto ainda não publicou nenhuma versão para comparar.', kind: '', canOpen: false });
  assert.deepEqual(plain(U.describe({ status: 'error', message: 'Sem conexão.' })), { text: 'Sem conexão.', kind: 'warn', canOpen: false });
  assert.equal(U.describe({ status: 'error' }).text, 'Não consegui verificar agora.');
  assert.deepEqual(plain(U.describe({ status: 'disabled' })), { text: '', kind: '', canOpen: false });
});

test('versão nova: a faixa aparece com "Ver e baixar" e "Agora não", diz o que o usuário já tem e que os projetos continuam', async () => {
  const t = load();
  await t.U.check();
  assert.equal(t.note.hidden, false);
  assert.deepEqual(t.calls[0], ['app:updateCheck', { force: false }, undefined]);
  const text = t.note.textContent;
  assert.match(text, /Nova versão 0\.2\.0 do Braga Frame disponível \(você usa a 0\.1\.0\)/);
  assert.match(text, /seus projetos continuam como estão/);
  assert.deepEqual(t.note.querySelectorAll('button').map((b) => [b.dataset.act, b.textContent]), [['update-open', 'Ver e baixar'], ['update-dismiss', 'Agora não']]);
  assert.ok(t.emitted.includes('update:changed'), 'a tela Geral é avisada');
});

test('sem versão nova, com erro ou sem versões publicadas a faixa fica escondida', async () => {
  for (const answer of [CURRENT, { ok: true, status: 'none', current: '0.1.0' }, { ok: true, status: 'error', current: '0.1.0', message: 'x' }, { ok: true, status: 'disabled', current: '0.1.0' }]) {
    const t = load({ routes: { 'app:updateCheck': answer } });
    await t.U.check();
    assert.equal(t.note.hidden, true, answer.status);
  }
});

test('"Ver e baixar" pede ao main para abrir a Release (a tela nunca manda o endereço) e mostra o erro se falhar', async () => {
  const t = load();
  await t.U.check();
  t.note.querySelector('[data-act="update-open"]').click();
  await idle();
  assert.deepEqual(t.calls.at(-1), ['app:updateOpen', {}, { toast: true }]);
});

test('"Agora não" esconde o aviso desta versão e não volta a cada abertura; uma versão MAIS NOVA avisa de novo', async () => {
  const t = load();
  await t.U.check();
  t.note.querySelector('[data-act="update-dismiss"]').click();
  assert.equal(t.note.hidden, true);
  assert.equal(t.store.get('updateDismissed'), '0.2.0');
  await t.U.check({ force: true });
  assert.equal(t.note.hidden, true, 'a mesma versão não volta');
  t.routes['app:updateCheck'] = { ...AVAILABLE, latest: { version: '0.3.0' } };
  await t.U.check({ force: true });
  assert.equal(t.note.hidden, false, 'a 0.3.0 é outra');
  assert.match(t.note.textContent, /0\.3\.0/);
  // o cartão da tela Geral ainda deixa baixar a versão dispensada (não depende do "Agora não")
  assert.equal(t.U.describe(t.U.state.result).canOpen, true);
});

test('aviso desligado: a faixa nunca aparece; ligar de novo consulta se ainda não há resultado', async () => {
  const t = load({ store: { updateCheck: '0' } });
  assert.equal(t.U.enabled(), false);
  await t.U.check({ force: true }); // "Verificar agora" funciona mesmo desligado (é o usuário pedindo)
  assert.equal(t.note.hidden, true, 'desligado: nada de faixa');
  assert.equal(t.U.describe(t.U.state.result).canOpen, true, 'mas o cartão mostra o resultado e deixa baixar');
  t.U.setEnabled(true);
  assert.equal(t.store.get('updateCheck'), '1');
  assert.equal(t.note.hidden, false, 'ligado e com versão nova: a faixa aparece');
  t.U.setEnabled(false);
  assert.equal(t.store.get('updateCheck'), '0');
  assert.equal(t.note.hidden, true);
  const fresh = load();
  fresh.U.setEnabled(true);
  await idle();
  assert.equal(fresh.calls.filter(([c]) => c === 'app:updateCheck').length, 1, 'ligar sem resultado ainda consulta');
});

test('falha na comunicação com o app vira resultado de erro (sem lançar); consultas simultâneas viram uma só', async () => {
  const t = load({ routes: { 'app:updateCheck': { ok: false, message: 'Falha na comunicação com o app.' } } });
  const r = await t.U.check();
  assert.deepEqual([r.status, r.message], ['error', 'Falha na comunicação com o app.']);
  assert.equal(t.note.hidden, true);

  let release;
  const slow = load({ routes: { 'app:updateCheck': () => new Promise((resolve) => { release = () => resolve(AVAILABLE); }) } });
  const a = slow.U.check();
  const b = slow.U.check();
  assert.equal(slow.U.state.checking, true);
  release();
  await Promise.all([a, b]);
  assert.equal(slow.calls.filter(([c]) => c === 'app:updateCheck').length, 1);
  assert.equal(slow.U.state.checking, false);
});

test('ao abrir: agenda UMA consulta para alguns segundos depois (não pesa na abertura), só com o aviso ligado e fora de outro aplicativo', async () => {
  const on = load();
  await idle();
  assert.equal(on.timers.length, 1);
  assert.equal(on.timers[0].ms, 4000);
  assert.equal(on.calls.length, 0, 'nada acontece antes do prazo');
  on.timers[0].fn();
  await idle();
  assert.deepEqual(on.calls.map(([c, p]) => [c, p.force]), [['app:updateCheck', false]], 'a consulta de abertura não força (o main reaproveita uma recente)');

  const off = load({ store: { updateCheck: '0' } });
  await idle();
  off.timers[0].fn();
  await idle();
  assert.equal(off.calls.length, 0, 'desligado: não consulta');

  const embedded = load({ embedded: true });
  await idle();
  assert.equal(embedded.timers.length, 0, 'dentro do BDS nem agenda');
});

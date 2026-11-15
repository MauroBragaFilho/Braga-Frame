'use strict';

/**
 * A tela Geral de Configurações por dentro, com o renderer/features/general.js de verdade num DOM de mentira (tests/prefs-fakedom.js): aparência
 * (Escuro/Claro pelo mesmo BF.ui.setTheme do rodapé do menu, desabilitada quando o tema é do Braga Digital Studio), pasta de projetos (o caminho que o
 * app:info informa e "Mostrar na pasta") e o cartão Sobre (nome, versão e frase do app). Nada de idioma, notificações, envio de dados ou links, que o app
 * não tem. O desenho real (CSS, janelinhas de tema, janela) é conferido em tests/e2e/settings.e2e.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDocument, makeEl } = require('./prefs-fakedom');
const { extendFakeDom } = require('./fakedom-extra');

extendFakeDom();

const CODE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features', 'general.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features', 'general.css'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const idle = async () => { for (let i = 0; i < 5; i += 1) await tick(); };
const plain = (v) => JSON.parse(JSON.stringify(v));

function load({ app = { name: 'Braga Frame', tagline: 'Cortes verticais para criadores.', version: '0.1.0', projectsDir: 'C:\\Users\\Ana\\AppData\\Roaming\\braga-frame\\projects' }, theme = 'dark', locked = false, reveal = { ok: true } } = {}) {
  const doc = createDocument();
  const appNode = doc.register('app');
  if (locked) appNode.classList.add('theme-locked');
  const calls = [];
  const toasts = [];
  const handlers = new Map();
  let current = theme;
  let tab = null;
  const BF = {
    state: { app },
    util: { el: makeEl(doc) },
    ui: {
      registerTab: (def) => { tab = def; },
      theme: () => current,
      setTheme: (next) => { current = next; (handlers.get('theme:changed') || []).forEach((fn) => fn({ theme: next })); }
    },
    bus: { on: (name, fn) => { handlers.set(name, [...(handlers.get(name) || []), fn]); return () => {}; } },
    api: async (channel, payload, opts = {}) => {
      calls.push([channel, plain(payload)]);
      if (reveal.ok === false && opts.toast) toasts.push([reveal.message, 'error']);
      return reveal;
    },
    ready: Promise.resolve()
  };
  vm.runInContext(CODE, vm.createContext({ window: { BF }, document: doc }), { filename: 'general.js' });
  const panel = doc.register('general-panel');
  tab.render(panel);
  const q = (selector) => panel.querySelector(selector);
  const all = (selector) => panel.querySelectorAll(selector);
  return { tab, panel, q, all, calls, toasts, BF, setApp: (next) => { BF.state.app = next; tab.onShow(); }, themes: () => all('.gen-theme').map((b) => [b.dataset.theme, b.attrs['aria-checked'], b.disabled]) };
}

test('registra a aba "general" (Geral, ordem 75: a primeira de Configurações) e mostra só o que o app tem', async () => {
  const env = load();
  await idle();
  assert.deepEqual(plain({ id: env.tab.id, title: env.tab.title, order: env.tab.order }), { id: 'general', title: 'Geral', order: 75 });
  assert.deepEqual(env.all('.gen-card h3').map((h) => h.textContent), ['Aparência', 'Pasta de projetos', 'Sobre']);
  const text = env.panel.textContent;
  for (const missing of ['Idioma', 'Notificações', 'Salvar automaticamente', 'Enviar dados', 'Discord', 'GitHub', 'Suporte']) assert.ok(!text.includes(missing), `"${missing}" não existe no app`);
  assert.equal(env.all('.primary').length, 0, 'tela de ajustes: sem ação principal solta');
});

test('aparência: Escuro e Claro, o em uso marcado; clicar troca o tema pelo mesmo BF.ui.setTheme e a marca acompanha', async () => {
  const env = load({ theme: 'dark' });
  await idle();
  assert.deepEqual(env.themes(), [['dark', 'true', false], ['light', 'false', false]]);
  assert.equal(env.q('.gen-themes').attrs.role, 'radiogroup');
  assert.deepEqual(env.all('.gen-theme').map((b) => b.attrs.role), ['radio', 'radio']);
  env.all('.gen-theme')[1].click();
  assert.equal(env.BF.ui.theme(), 'light');
  assert.deepEqual(env.themes(), [['dark', 'false', false], ['light', 'true', false]]);
  env.all('.gen-theme')[0].click();
  assert.deepEqual(env.themes(), [['dark', 'true', false], ['light', 'false', false]]);
});

test('dentro do Braga Digital Studio o tema é dele: as opções ficam desabilitadas e o texto diz por quê', async () => {
  const env = load({ locked: true });
  await idle();
  assert.deepEqual(env.themes(), [['dark', 'true', true], ['light', 'false', true]]);
  assert.equal(env.q('[data-section="appearance"] .gen-note').hidden, false);
  assert.match(env.q('[data-section="appearance"] .gen-note').textContent, /tema é o do Braga Digital Studio/);
  const free = load({ locked: false });
  assert.equal(free.q('[data-section="appearance"] .gen-note').hidden, true);
});

test('pasta de projetos: mostra o caminho do app:info e "Mostrar na pasta" a revela; sem caminho o cartão some', async () => {
  const env = load();
  await idle();
  const dir = 'C:\\Users\\Ana\\AppData\\Roaming\\braga-frame\\projects';
  assert.equal(env.q('.gen-path').value, dir);
  assert.equal(env.q('.gen-path').attrs['aria-label'], 'Pasta de projetos');
  assert.equal(env.q('.gen-folder button').textContent, 'folder_openMostrar na pasta');
  assert.equal(env.q('.gen-folder button').classList.contains('secondary'), true);
  assert.equal(env.all('.gen-folder button').length, 1, 'não há "Alterar": o app não troca a pasta');
  env.q('[data-act="reveal"]').click();
  await idle();
  assert.deepEqual(env.calls, [['shell:reveal', { path: dir }]]);

  const failing = load({ reveal: { ok: false, message: 'Caminho inválido.' } });
  await idle();
  failing.q('[data-act="reveal"]').click();
  await idle();
  assert.deepEqual(failing.toasts, [['Caminho inválido.', 'error']], 'o erro vira aviso');

  const none = load({ app: { name: 'Braga Frame', tagline: '', version: '0.1.0' } });
  await idle();
  assert.equal(none.q('[data-section="folder"]').hidden, true);
});

test('Sobre: nome, versão e a frase do app, e quem desenvolveu; atualiza quando as informações chegam', async () => {
  const env = load();
  await idle();
  assert.equal(env.q('.gen-about-name').textContent, 'Braga Frame');
  assert.equal(env.q('.gen-about-version').textContent, 'Versão 0.1.0');
  assert.equal(env.q('.gen-about-tagline').textContent, 'Cortes verticais para criadores.');
  assert.match(env.q('.gen-credit').textContent, /Desenvolvido por Braga Dev/);
  assert.equal(env.all('.gen-about a').length, 0, 'sem links: o app não tem site, suporte, Discord nem GitHub');

  const late = load({ app: {} });
  await idle();
  assert.equal(late.q('.gen-about-version').hidden, true);
  late.setApp({ name: 'Braga Frame', tagline: 'Outra frase.', version: '2.0.0', projectsDir: 'D:\\p' });
  assert.equal(late.q('.gen-about-version').textContent, 'Versão 2.0.0');
  assert.equal(late.q('.gen-about-tagline').textContent, 'Outra frase.');
  assert.equal(late.q('.gen-path').value, 'D:\\p');
});

test('o CSS cobre as classes da tela e usa só tokens (nada de cor solta)', () => {
  for (const cls of ['gen', 'gen-grid', 'gen-main', 'gen-card', 'gen-themes', 'gen-theme', 'gen-swatch', 'gen-path', 'gen-folder', 'gen-about', 'gen-mark', 'gen-credit']) {
    assert.ok(CSS.includes(`.${cls}`), `falta .${cls} no CSS`);
  }
  assert.doesNotMatch(CSS.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'só tokens');
});

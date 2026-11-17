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

function load({ app = { name: 'Braga Frame', tagline: 'Cortes verticais para criadores.', version: '0.1.0', projectsDir: 'C:\\Users\\Ana\\AppData\\Roaming\\braga-frame\\projects' }, theme = 'dark', locked = false, reveal = { ok: true }, routes = {}, clipboard = null } = {}) {
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
      setTheme: (next) => { current = next; (handlers.get('theme:changed') || []).forEach((fn) => fn({ theme: next })); },
      toast: (message, kind) => { toasts.push([message, kind]); }
    },
    bus: { on: (name, fn) => { handlers.set(name, [...(handlers.get(name) || []), fn]); return () => {}; } },
    api: async (channel, payload, opts = {}) => {
      calls.push([channel, plain(payload)]);
      const answer = routes[channel] || reveal; // `routes`: resposta própria de um canal; os demais seguem `reveal`
      if (answer.ok === false && opts.toast) toasts.push([answer.message, 'error']);
      return answer;
    },
    ready: Promise.resolve()
  };
  vm.runInContext(CODE, vm.createContext({ window: { BF }, document: doc, navigator: clipboard ? { clipboard } : {} }), { filename: 'general.js' });
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
  assert.deepEqual(env.all('.gen-card h3').map((h) => h.textContent), ['Aparência', 'Pasta de projetos', 'Suporte', 'Sobre']);
  const text = env.panel.textContent;
  for (const missing of ['Idioma', 'Notificações', 'Salvar automaticamente', 'Enviar dados', 'Discord', 'GitHub', 'Chat de suporte', 'Atualizações']) assert.ok(!text.includes(missing), `"${missing}" não existe no app`);
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

const REPORT = { ok: true, text: 'Braga Frame 0.1.0\nPlacas de vídeo:\n  GPU de teste', logFile: 'C:\\dados\\logs\\bragaframe.log' };

test('suporte: "Copiar informações" pede o relatório ao app e o põe na área de transferência, sem mostrar a área de texto', async () => {
  const copied = [];
  const env = load({ routes: { 'app:support': REPORT }, clipboard: { writeText: async (text) => { copied.push(text); } } });
  await idle();
  assert.deepEqual(env.all('[data-section="support"] button').map((b) => b.dataset.act), ['copy-support', 'show-log']);
  assert.equal(env.q('.gen-report').hidden, true, 'a área de texto só aparece se o sistema recusar copiar');
  env.q('[data-act="copy-support"]').click();
  await idle();
  assert.deepEqual(env.calls, [['app:support', {}]]);
  assert.deepEqual(copied, [REPORT.text]);
  assert.deepEqual(env.toasts.map((t) => t[1]), ['ok']);
  assert.equal(env.q('.gen-report').hidden, true);
  assert.equal(env.q('[data-act="copy-support"]').disabled, false, 'o botão volta a funcionar');
});

test('suporte: se a área de transferência recusa, o texto fica à vista e selecionado, com o aviso', async () => {
  const env = load({ routes: { 'app:support': REPORT }, clipboard: { writeText: async () => { throw new Error('negado'); } } });
  await idle();
  env.q('[data-act="copy-support"]').click();
  await idle();
  assert.equal(env.q('.gen-report').hidden, false);
  assert.equal(env.q('.gen-report').value, REPORT.text);
  assert.deepEqual(env.toasts.map((t) => t[1]), ['warn']);
  assert.match(env.toasts[0][0], /Ctrl\+C/);
  assert.equal(env.q('[data-act="copy-support"]').disabled, false);
});

test('suporte: falha ao montar o relatório vira aviso de erro e não deixa o botão preso; sem navigator.clipboard também cai na área de texto', async () => {
  const failing = load({ routes: { 'app:support': { ok: false, message: 'Falha ao reunir as informações.' } }, clipboard: { writeText: async () => {} } });
  await idle();
  failing.q('[data-act="copy-support"]').click();
  await idle();
  assert.deepEqual(failing.toasts, [['Falha ao reunir as informações.', 'error']]);
  assert.equal(failing.q('[data-act="copy-support"]').disabled, false);
  assert.equal(failing.q('.gen-report').hidden, true);

  const bare = load({ routes: { 'app:support': REPORT } }); // sem clipboard no ambiente
  await idle();
  bare.q('[data-act="copy-support"]').click();
  await idle();
  assert.equal(bare.q('.gen-report').hidden, false, 'sem área de transferência o texto fica à vista');
});

test('suporte: "Mostrar o registro" mostra o arquivo que o relatório informou; sem arquivo, avisa em vez de falhar', async () => {
  const env = load({ routes: { 'app:support': REPORT } });
  await idle();
  env.q('[data-act="show-log"]').click();
  await idle();
  assert.deepEqual(env.calls, [['app:support', {}], ['shell:reveal', { path: REPORT.logFile }]]);

  const none = load({ routes: { 'app:support': { ok: true, text: 'x', logFile: null } } });
  await idle();
  none.q('[data-act="show-log"]').click();
  await idle();
  assert.deepEqual(none.calls, [['app:support', {}]], 'não pede para mostrar o que não existe');
  assert.deepEqual(none.toasts.map((t) => t[1]), ['warn']);
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

'use strict';

/**
 * A tela Início por dentro, com o renderer/features/home.js de verdade (e o projects.js de verdade, de onde ela empresta o estado, o critério de busca e a
 * busca da aba Projetos) num DOM de mentira (tests/prefs-fakedom.js + tests/fakedom-extra.js): a saudação (carregando, sem projetos, com projetos), os
 * atalhos "Novo projeto" e "Continuar de onde parou", os projetos recentes (só os mais novos, com miniatura, estado e cortes), abrir, o vídeo que sumiu, a
 * busca (resultados de TODOS os projetos, Enter e "Ver todos os resultados" levam a Projetos já com o texto) e as atualizações. O desenho real (CSS,
 * miniatura de verdade, janela) é conferido em tests/e2e/home.e2e.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDocument, makeEl } = require('./prefs-fakedom');
const { extendFakeDom } = require('./fakedom-extra');

extendFakeDom();

const FEATURES = path.join(__dirname, '..', 'renderer', 'features');
const PROJECTS_CODE = fs.readFileSync(path.join(FEATURES, 'projects.js'), 'utf8');
const HOME_CODE = fs.readFileSync(path.join(FEATURES, 'home.js'), 'utf8');
const HOME_CSS = fs.readFileSync(path.join(FEATURES, 'home.css'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const idle = async () => { for (let i = 0; i < 8; i += 1) await tick(); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const proj = (id, name, over = {}) => ({
  id, source: { path: `C:\\lives\\${name}.mp4`, size: 5000, duration: 3600, origin: null }, meta: {}, cutCount: 2, counts: { pending: 1, approved: 1, rejected: 0 },
  exportedCount: 0, updatedAt: iso(60e3), fileMissing: false, ...over
});

/** Cinco projetos (do mais novo ao mais antigo: Minecraft, NFS, OBS, Aula e Quinto; o `project:list` os devolve fora de ordem). */
const FIVE = () => [
  proj('e5', 'Quinto projeto', { updatedAt: iso(12 * 86400e3), cutCount: 1, counts: { pending: 1, approved: 0, rejected: 0 } }),
  proj('a1', 'Minecraft', {
    updatedAt: iso(3600e3), cutCount: 2, counts: { pending: 0, approved: 2, rejected: 0 }, exportedCount: 2,
    source: { path: 'C:\\lives\\Minecraft.mp4', size: 5000, duration: 8040, origin: { type: 'vod', platform: 'youtube', title: 'Minecraft - Sobrevivência EP12', channel: 'MauroBragaFilho' } }
  }),
  proj('b2', 'NFS', {
    updatedAt: iso(26 * 3600e3), cutCount: 3, counts: { pending: 2, approved: 1, rejected: 0 },
    source: { path: 'C:\\lives\\NFS.mp4', size: 5000, duration: 5520, origin: { type: 'vod', platform: 'twitch', title: 'NFS Most Wanted - Gameplay', channel: 'Live do Dia', game: 'NFS' } }
  }),
  proj('c3', '2026-10-20 21-00-00', {
    updatedAt: iso(3 * 86400e3), cutCount: 1, counts: { pending: 0, approved: 1, rejected: 0 },
    source: { path: 'C:\\lives\\2026-10-20 21-00-00.mp4', size: 5000, duration: 600, origin: { type: 'obs' } }
  }),
  proj('d4', 'Aula de música', { updatedAt: iso(9 * 86400e3), cutCount: 0, counts: { pending: 0, approved: 0, rejected: 0 } })
];

/**
 * Carrega projects.js e home.js no mesmo contexto (como no index.html). `api`: respostas por canal (valor ou função); o que não está aqui tem uma
 * resposta padrão (project:list devolve a lista, project:thumbnail "não saiu"). `projectsTab`: monta também a aba Projetos (só os testes que olham
 * para ela; montada, ela pede miniaturas e listas por conta própria e os contadores dos outros testes deixariam de valer).
 */
function load({ list = FIVE(), api = {}, project = null, appName = 'Braga Frame', opened = { ok: true }, projectsTab = false } = {}) {
  const doc = createDocument();
  const tabs = {};
  const calls = [];
  const toasts = [];
  const selected = [];
  const openedWith = [];
  const handlers = new Map(); // nome do evento -> ouvintes, na ordem de registro (projects.js primeiro, home.js por último)
  let current = list;
  const reply = (channel, payload) => {
    const answer = api[channel];
    if (typeof answer === 'function') return answer(payload);
    if (answer !== undefined) return answer;
    if (channel === 'project:list') return { ok: true, projects: current };
    if (channel === 'project:thumbnail') return { ok: true, state: 'none', reason: 'NO_FFMPEG' };
    return { ok: true };
  };
  const BF = {
    state: { project, app: { name: appName, tagline: '', version: '' } },
    util: { el: makeEl(doc) },
    ui: {
      registerTab: (def) => { tabs[def.id] = def; }, toast: (message, kind) => toasts.push([message, kind]), log() {},
      selectTab: (id) => { selected.push(id); return true; }, confirm: async () => true, confirmCheck: async () => ({ checked: true })
    },
    bus: { on: (name, fn) => { handlers.set(name, [...(handlers.get(name) || []), fn]); return () => {}; }, emit() {} },
    api: async (channel, payload, opts = {}) => {
      calls.push([channel, plain(payload)]);
      const res = await reply(channel, payload);
      if (res.ok === false && opts.toast) toasts.push([res.message, 'error']);
      return res;
    },
    openSource: async (file, origin) => { openedWith.push([file, plain(origin)]); return opened; }
  };
  const sandbox = { window: { BF, getComputedStyle: () => ({ overflowY: 'visible' }) }, document: doc, setTimeout, clearTimeout, Date };
  const context = vm.createContext(sandbox);
  vm.runInContext(PROJECTS_CODE, context, { filename: 'projects.js' });
  vm.runInContext(HOME_CODE, context, { filename: 'home.js' });
  const homePanel = doc.register('home-panel');
  homePanel.className = 'tabpanel';
  tabs.home.render(homePanel);
  const projectsPanel = doc.register('projects-panel');
  projectsPanel.className = 'tabpanel';
  if (projectsTab) tabs.projects.render(projectsPanel);
  const q = (selector) => homePanel.querySelector(selector);
  const all = (selector) => homePanel.querySelectorAll(selector);
  return {
    BF, tabs, calls, toasts, selected, openedWith, homePanel, projectsPanel, q, all,
    titles: () => all('.prj-card .prj-title').map((n) => n.textContent),
    type: (text) => { const input = q('[data-act="search"]'); input.value = text; input.dispatch('input'); },
    /** Dispara o evento só no ouvinte da tela Início (o último a se registrar). */
    fire: (name, payload) => handlers.get(name).at(-1)(payload),
    setList: (next) => { current = next; },
    hero: () => ({ title: q('.home-title').textContent, lead: q('.home-lead').textContent }),
    heading: () => q('.home-section-head h3').textContent,
    allButton: () => q('[data-act="all"]'),
    resume: () => q('[data-act="resume"]'),
    count: (channel) => calls.filter(([c]) => c === channel).length,
    thumbCalls: () => calls.filter(([c]) => c === 'project:thumbnail').map(([, p]) => p.id),
    projectsSearch: () => projectsPanel.querySelector('.prj-search').value,
    projectsTitles: () => projectsPanel.querySelectorAll('.prj-card').map((c) => c.querySelector('.prj-title').textContent)
  };
}

// ------------------------------------------------------------------ a tela

test('registra a aba "home" (Início, ordem 1, ícone home) e mostra a saudação, a busca e os atalhos', async () => {
  const env = load();
  assert.deepEqual(plain({ id: env.tabs.home.id, title: env.tabs.home.title, order: env.tabs.home.order, icon: env.tabs.home.icon }), { id: 'home', title: 'Início', order: 1, icon: 'home' });
  await idle();
  assert.equal(env.q('.home-hero').attrs['aria-label'], 'Boas-vindas');
  const search = env.q('[data-act="search"]');
  assert.equal(search.attrs.placeholder, 'Buscar projetos', 'curto: a busca é dos projetos');
  assert.equal(search.attrs['aria-label'], 'Buscar projetos');
  assert.deepEqual(env.all('.home-actions button').map((b) => [b.dataset.act, b.textContent]), [['new', 'addNovo projeto'], ['resume', 'play_arrowContinuar de onde parou']]);
  assert.equal(env.q('[data-act="new"]').classList.contains('primary'), true, 'uma ação principal por tela');
  assert.equal(env.q('[data-act="open-video"]'), null, '"Abrir vídeo" já está no cabeçalho de todas as abas');
});

test('título do Início: diz o que fazer aqui (sem saudação nem exclamação), com e sem projetos', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const env = load({ api: { 'project:list': async () => { await gate; return { ok: true, projects: FIVE() }; } } });
  assert.deepEqual(env.hero(), { title: 'Corte a próxima live', lead: 'Abra um vídeo novo ou continue um projeto: tudo fica salvo neste computador.' });
  assert.equal(env.resume().hidden, true);
  release();
  await idle();
  assert.deepEqual(env.hero(), { title: 'Corte a próxima live', lead: 'Abra um vídeo novo ou continue um projeto: tudo fica salvo neste computador.' });
  assert.doesNotMatch(env.q('.home-title').textContent + env.q('.home-lead').textContent, /Mauro/);

  const empty = load({ list: [], appName: 'Outro Nome' });
  await idle();
  assert.deepEqual(empty.hero(), { title: 'Comece por um vídeo', lead: 'Arraste o arquivo da live ou da gameplay para a janela, ou use Novo projeto.' }, 'o nome vem do app (appInfo), não de um texto fixo');
});

test('"Novo projeto" leva à tela Novo projeto (a aba sources)', async () => {
  const env = load();
  await idle();
  env.q('[data-act="new"]').click();
  assert.deepEqual(env.selected, ['sources']);
});

// ------------------------------------------------------------------ recentes

test('projetos recentes: só os 3 mais novos, do mais novo ao mais antigo, com estado, cortes, origem e quando foi alterado', async () => {
  const env = load();
  await idle();
  assert.equal(env.heading(), 'Projetos recentes');
  assert.deepEqual(env.titles(), ['Minecraft - Sobrevivência EP12', 'NFS Most Wanted - Gameplay', '2026-10-20 21-00-00']);
  const cardText = (id) => {
    const c = env.q(`[data-id="${id}"]`);
    return { sub: c.querySelector('.prj-sub').textContent, chips: c.querySelector('.prj-chips').children.map((n) => n.textContent), when: c.querySelectorAll('.muted')[1].textContent, state: c.dataset.state };
  };
  assert.deepEqual(cardText('a1'), { sub: 'YouTube · MauroBragaFilho · 2 h 14 min', chips: ['Exportado', '2 cortes'], when: 'Alterado há 1 h', state: 'done' });
  assert.deepEqual(cardText('b2'), { sub: 'Twitch · Live do Dia · NFS · 1 h 32 min', chips: ['Em revisão', '3 cortes'], when: 'Alterado ontem', state: 'review' });
  assert.deepEqual(cardText('c3'), { sub: 'OBS · 10 min', chips: ['Pronto para exportar', '1 corte'], when: 'Alterado há 3 dias', state: 'ready' });
  assert.equal(env.allButton().hidden, false);
  assert.equal(env.allButton().textContent, 'Ver todosarrow_forward');
  assert.equal(env.q('[data-id="d4"]'), null, 'o quarto e o quinto só aparecem em Projetos');
});

test('"Ver todos" abre a aba Projetos, sem filtro de estado e sem texto de busca', async () => {
  const env = load({ projectsTab: true });
  await idle();
  env.projectsPanel.querySelector('[data-filter="done"]').click(); // um filtro que ficou da última visita a Projetos
  assert.equal(env.projectsTitles().length, 1);
  env.allButton().click();
  assert.deepEqual(env.selected, ['projects']);
  await idle();
  assert.equal(env.projectsSearch(), '');
  assert.equal(env.projectsTitles().length, 5, 'Projetos mostra todos');
});

test('a miniatura é pedida só dos cartões que aparecem; o quadro que chega troca o ícone, e quem não tem quadro fica com o ícone do tipo de vídeo', async () => {
  const env = load({
    api: { 'project:thumbnail': (payload) => (payload.id === 'a1' ? { ok: true, state: 'ready', url: 'file:///cache/thumbs/a1.x.jpg?v=1' } : { ok: true, state: 'none', reason: 'NO_FFMPEG' }) }
  });
  await idle();
  assert.deepEqual(env.thumbCalls().sort(), ['a1', 'b2', 'c3'], 'os dois que ficaram de fora não pedem miniatura');
  const request = env.calls.find(([c, p]) => c === 'project:thumbnail' && p.id === 'a1')[1];
  assert.deepEqual(request, { id: 'a1', path: 'C:\\lives\\Minecraft.mp4', size: 5000, duration: 8040 });
  const thumb = (id) => env.q(`[data-id="${id}"] .prj-thumb`);
  assert.equal(thumb('a1').querySelector('img').attrs.src, 'file:///cache/thumbs/a1.x.jpg?v=1');
  assert.ok(thumb('a1').classList.contains('has-image'));
  assert.ok(thumb('a1').querySelector('.prj-play'));
  assert.equal(thumb('a1').attrs['aria-label'], 'Abrir o projeto Minecraft - Sobrevivência EP12');
  assert.equal(thumb('b2').querySelector('img'), null);
  assert.equal(thumb('b2').querySelector('.material-symbols-rounded').textContent, 'smart_display', 'VOD');
  assert.equal(thumb('c3').querySelector('.material-symbols-rounded').textContent, 'videocam', 'gravação do OBS');
  // redesenhar (buscar e voltar) não repete o pedido
  env.type('mine');
  env.type('');
  await idle();
  assert.deepEqual(env.thumbCalls().sort(), ['a1', 'b2', 'c3']);
  assert.ok(env.q('[data-id="a1"] .prj-thumb img'), 'o quadro que já chegou aparece de novo sem novo pedido');
});

test('o quadro da miniatura que não carrega (arquivo sumiu) volta ao ícone sem quebrar', async () => {
  const env = load({ api: { 'project:thumbnail': { ok: true, state: 'ready', url: 'file:///some.jpg' } } });
  await idle();
  const thumb = env.q('[data-id="a1"] .prj-thumb');
  thumb.querySelector('img').dispatch('error');
  assert.equal(thumb.querySelector('img'), null);
  assert.equal(thumb.classList.contains('has-image'), false);
  assert.equal(thumb.querySelector('.material-symbols-rounded').textContent, 'smart_display');
});

test('abrir: "Abrir" (e a miniatura) abre o projeto com a origem e segue para Cortes; enquanto abre os botões ficam parados; erro avisa e não sai da tela', async () => {
  let finish;
  const env = load();
  env.BF.openSource = (file, origin) => { env.openedWith.push([file, plain(origin)]); return new Promise((resolve) => { finish = resolve; }); };
  await idle();
  env.q('[data-id="a1"] [data-act="open"]').click();
  assert.deepEqual(env.openedWith, [['C:\\lives\\Minecraft.mp4', { type: 'vod', platform: 'youtube', title: 'Minecraft - Sobrevivência EP12', channel: 'MauroBragaFilho' }]]);
  assert.equal(env.q('[data-id="a1"] [data-act="open"]').textContent, 'Abrindo…');
  assert.ok(env.all('[data-act="open"]').every((b) => b.disabled), 'um de cada vez');
  assert.equal(env.resume().disabled, true);
  finish({ ok: true });
  await idle();
  assert.deepEqual(env.selected, ['cuts']);
  assert.ok(env.all('[data-act="open"]').every((b) => !b.disabled));
  assert.equal(env.resume().disabled, false);

  const failed = load({ opened: { ok: false, message: 'O vídeo não abriu.' } });
  await idle();
  failed.q('[data-id="b2"] .prj-thumb').click();
  await idle();
  assert.deepEqual(failed.toasts, [['O vídeo não abriu.', 'error']]);
  assert.deepEqual(failed.selected, []);
  const canceled = load({ opened: { ok: false, canceled: true } });
  await idle();
  canceled.q('[data-id="b2"] [data-act="open"]').click();
  await idle();
  assert.deepEqual(canceled.toasts, [], 'quem cancelou não recebe aviso');
  assert.deepEqual(canceled.selected, []);
});

test('o projeto que está aberto mostra "Aberto agora" e o botão vira "Continuar"', async () => {
  const env = load({ project: { id: 'a1', source: { path: 'C:\\lives\\Minecraft.mp4' } } });
  await idle();
  const card = env.q('[data-id="a1"]');
  assert.ok(card.querySelector('.prj-chips').children.some((n) => n.textContent === 'Aberto agora'));
  assert.equal(card.querySelector('[data-act="open"]').textContent, 'Continuar');
  assert.equal(env.q('[data-id="b2"] [data-act="open"]').textContent, 'Abrir');
});

// ------------------------------------------------------------------ continuar de onde parou

test('"Continuar de onde parou" abre o projeto mais recente cujo vídeo existe e some quando não há nenhum', async () => {
  const env = load();
  await idle();
  assert.equal(env.resume().hidden, false);
  assert.equal(env.resume().title, 'Abrir “Minecraft - Sobrevivência EP12”');
  env.resume().click();
  await idle();
  assert.equal(env.openedWith[0][0], 'C:\\lives\\Minecraft.mp4');
  assert.deepEqual(env.selected, ['cuts']);

  // o mais recente perdeu o vídeo: vale o próximo
  const second = load({ list: FIVE().map((p) => (p.id === 'a1' ? { ...p, fileMissing: true } : p)) });
  await idle();
  assert.equal(second.resume().hidden, false);
  assert.equal(second.resume().title, 'Abrir “NFS Most Wanted - Gameplay”');
  second.resume().click();
  await idle();
  assert.equal(second.openedWith[0][0], 'C:\\lives\\NFS.mp4');

  // todos sem vídeo ou nenhum projeto: o atalho não aparece
  const none = load({ list: FIVE().map((p) => ({ ...p, fileMissing: true })) });
  await idle();
  assert.equal(none.resume().hidden, true);
  const empty = load({ list: [] });
  await idle();
  assert.equal(empty.resume().hidden, true);
});

test('vídeo que sumiu: o cartão avisa, não pede miniatura nem abre, e leva a Projetos (onde se localiza o vídeo)', async () => {
  const env = load({ list: FIVE().map((p) => (p.id === 'b2' ? { ...p, fileMissing: true } : p)), projectsTab: true });
  await idle();
  const card = env.q('[data-id="b2"]');
  assert.ok(card.querySelector('.prj-chips').children.some((n) => n.textContent === 'Vídeo não encontrado'));
  assert.equal(card.querySelector('.prj-thumb').disabled, true);
  assert.equal(card.querySelector('[data-act="open"]'), null);
  card.querySelector('[data-act="resolve"]').click();
  assert.deepEqual(env.selected, ['projects']);
  await idle();
  assert.equal(env.projectsSearch(), 'NFS Most Wanted - Gameplay');
  assert.deepEqual(env.projectsTitles(), ['NFS Most Wanted - Gameplay']);
});

test('vídeo que sumiu: nenhuma miniatura é pedida para ele', async () => {
  const env = load({ list: FIVE().map((p) => (p.id === 'b2' ? { ...p, fileMissing: true } : p)) });
  await idle();
  assert.deepEqual(env.thumbCalls().sort(), ['a1', 'c3']);
});

// ------------------------------------------------------------------ busca

test('busca: enquanto se digita aparecem os projetos que casam (de TODOS, sem acento nem maiúsculas) e o título vira "Resultados (n)"', async () => {
  const env = load();
  await idle();
  env.type('SOBREVIVENCIA');
  assert.equal(env.heading(), 'Resultados (1)');
  assert.deepEqual(env.titles(), ['Minecraft - Sobrevivência EP12']);
  assert.equal(env.allButton().textContent, 'Ver todos os resultadosarrow_forward');
  env.type('aula'); // o quarto projeto, que não está entre os recentes
  assert.equal(env.heading(), 'Resultados (1)');
  assert.deepEqual(env.titles(), ['Aula de música']);
  env.type('live do dia'); // pelo canal
  assert.deepEqual(env.titles(), ['NFS Most Wanted - Gameplay']);
  env.type('nfs'); // pelo jogo
  assert.deepEqual(env.titles(), ['NFS Most Wanted - Gameplay']);
  env.type('  ');
  assert.equal(env.heading(), 'Projetos recentes', 'só espaços não é busca');
  assert.equal(env.titles().length, 3);
});

test('busca: mostra no máximo 6 resultados mas conta todos; sem resultado diz isso e esconde "Ver todos"; Escape limpa', async () => {
  const many = Array.from({ length: 9 }, (_, i) => proj(`m${i}`, `Maratona ${i}`, { updatedAt: iso((i + 1) * 3600e3) }));
  const env = load({ list: many });
  await idle();
  env.type('maratona');
  assert.equal(env.heading(), 'Resultados (9)');
  assert.equal(env.titles().length, 6);
  assert.deepEqual(env.titles().slice(0, 2), ['Maratona 0', 'Maratona 1'], 'do mais recente ao mais antigo');

  env.type('nada disso existe');
  assert.equal(env.heading(), 'Resultados (0)');
  assert.deepEqual(env.titles(), []);
  assert.equal(env.q('.home-note').textContent, 'Nenhum projeto encontrado para “nada disso existe”.');
  assert.equal(env.allButton().hidden, true);

  const input = env.q('[data-act="search"]');
  input.dispatch('keydown', { key: 'Escape' });
  assert.equal(input.value, '');
  assert.equal(env.heading(), 'Projetos recentes');
  assert.equal(env.titles().length, 3);
  assert.equal(env.allButton().hidden, false);
});

test('Enter na busca e "Ver todos os resultados" abrem a aba Projetos já com o texto (e sem filtro de estado)', async () => {
  const env = load({ projectsTab: true });
  await idle();
  // Projetos estava filtrando por "Exportados": a busca da tela Início não pode ficar escondida por esse filtro
  env.projectsPanel.querySelector('[data-filter="done"]').click();
  env.type('nfs');
  env.q('[data-act="search"]').dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(env.selected, ['projects']);
  await idle();
  assert.equal(env.projectsSearch(), 'nfs');
  assert.deepEqual(env.projectsTitles(), ['NFS Most Wanted - Gameplay']);
  assert.equal(env.projectsPanel.querySelector('[data-filter="all"]').attrs['aria-pressed'], 'true');

  env.type('minecraft');
  env.allButton().click();
  assert.deepEqual(env.selected, ['projects', 'projects']);
  await idle();
  assert.equal(env.projectsSearch(), 'minecraft');
  assert.deepEqual(env.projectsTitles(), ['Minecraft - Sobrevivência EP12']);
  // Enter com o campo vazio também abre Projetos, sem texto
  env.type('');
  env.q('[data-act="search"]').dispatch('keydown', { key: 'Enter' });
  await idle();
  assert.equal(env.projectsSearch(), '');
  assert.equal(env.projectsTitles().length, 5);
});

test('cada visita à tela começa sem busca (a de antes, inclusive a continuada em Projetos, não fica esperando aqui)', async () => {
  const env = load({ projectsTab: true });
  await idle();
  env.type('nfs');
  env.q('[data-act="search"]').dispatch('keydown', { key: 'Enter' }); // vai para Projetos com o texto
  assert.equal(env.heading(), 'Resultados (1)', 'enquanto não sai da tela, a busca continua');
  env.tabs.home.onShow(); // o usuário voltou à Início pelo menu
  await idle();
  assert.equal(env.q('[data-act="search"]').value, '');
  assert.equal(env.heading(), 'Projetos recentes');
  assert.equal(env.titles().length, 3);
});

test('digitar não refaz a tela: o campo e o cartão de boas-vindas são os mesmos (o foco não se perde)', async () => {
  const env = load();
  await idle();
  const input = env.q('[data-act="search"]');
  const hero = env.q('.home-hero');
  input.focus();
  env.type('a');
  env.type('ab');
  env.type('abc');
  assert.equal(env.q('[data-act="search"]'), input);
  assert.equal(env.q('.home-hero'), hero);
  assert.equal(input.doc.activeElement, input);
});

// ------------------------------------------------------------------ vazio, erro e atualizações

test('sem projetos: explica o que aparece aqui, sem "Ver todos" nem atalho de continuar; a busca não quebra', async () => {
  const env = load({ list: [] });
  await idle();
  assert.equal(env.q('.home-empty strong').textContent, 'Nenhum projeto ainda');
  assert.equal(env.allButton().hidden, true);
  assert.equal(env.resume().hidden, true);
  env.type('qualquer coisa');
  assert.equal(env.q('.home-empty strong').textContent, 'Nenhum projeto ainda');
  assert.equal(env.q('[data-act="new"]').disabled, false, 'o atalho para começar continua à mão');
});

test('erro ao listar os projetos: a tela diz o motivo, a saudação continua neutra, os atalhos seguem valendo e a próxima carga que der certo o substitui', async () => {
  let failing = true;
  const env = load({ api: { 'project:list': () => (failing ? { ok: false, message: 'Disco indisponível.' } : { ok: true, projects: FIVE() }) } });
  await idle();
  assert.equal(env.q('.home-note .empty-state strong').textContent, 'Não foi possível listar os projetos');
  assert.equal(env.q('.home-note .empty-state p').textContent, 'Disco indisponível.');
  assert.equal(env.hero().title, 'Corte a próxima live');
  assert.equal(env.allButton().hidden, true);
  assert.equal(env.resume().hidden, true);
  env.q('[data-act="new"]').click();
  assert.deepEqual(env.selected, ['sources']);
  failing = false;
  env.tabs.home.onShow();
  await idle();
  assert.equal(env.q('.home-note'), null);
  assert.equal(env.titles().length, 3);
  assert.equal(env.hero().title, 'Corte a próxima live');
});

test('a lista acompanha: ao voltar à tela, ao abrir um vídeo e, com a tela à vista, quando cortes mudam; escondida, não pede nada', async () => {
  const env = load();
  await idle();
  const start = env.count('project:list');
  env.setList([proj('n1', 'Novinho', { updatedAt: iso(1000) }), ...FIVE()]);
  env.tabs.home.onShow();
  await idle();
  assert.equal(env.count('project:list'), start + 1);
  assert.equal(env.titles()[0], 'Novinho', 'o projeto novo aparece primeiro');
  await env.fire('project:loaded', { project: {} });
  await idle();
  assert.equal(env.count('project:list'), start + 2);

  // project:changed espera um pouco (não pede a cada tecla) e só pede com a tela à vista
  env.homePanel.hidden = true;
  await env.fire('project:changed', { reason: 'review:user' });
  await wait(750);
  assert.equal(env.count('project:list'), start + 2, 'escondida: nada');
  env.homePanel.hidden = false;
  await env.fire('project:changed', { reason: 'review:user' });
  await env.fire('project:changed', { reason: 'review:user' });
  await wait(750);
  assert.equal(env.count('project:list'), start + 3, 'duas alterações seguidas viram um pedido só');
});

test('uma resposta atrasada de uma carga antiga não sobrescreve a mais nova', async () => {
  const releases = [];
  let n = 0;
  const env = load({
    api: {
      'project:list': () => new Promise((resolve) => {
        n += 1;
        const mine = n;
        releases.push(() => resolve({ ok: true, projects: mine === 1 ? [proj('velho', 'Velho')] : FIVE() }));
      })
    }
  });
  env.tabs.home.onShow(); // segunda carga, enquanto a primeira ainda não respondeu
  releases[1](); // a mais nova responde primeiro
  await idle();
  assert.equal(env.titles().length, 3);
  releases[0](); // a antiga chega depois
  await idle();
  assert.equal(env.titles().length, 3, 'a resposta antiga é descartada');
  assert.equal(env.q('[data-id="velho"]'), null);
});

test('o ffmpeg que aparece (tools:changed) refaz o pedido das miniaturas que não saíram', async () => {
  const env = load();
  await idle();
  assert.equal(env.thumbCalls().length, 3);
  await env.fire('tools:changed', { tools: {} });
  await idle();
  assert.equal(env.thumbCalls().length, 6, 'as três sem miniatura pedem de novo');
});

// ------------------------------------------------------------------ estilo

test('o CSS cobre as classes da tela, usa só tokens (nada de cor fixa) e o código não usa estilo inline', () => {
  const used = new Set([...HOME_CODE.matchAll(/class: [`']([^`'$]+)/g)].flatMap((m) => m[1].split(/\s+/)).filter((c) => c.startsWith('home-')));
  assert.ok(used.size >= 8, [...used].join(', '));
  for (const name of used) assert.ok(HOME_CSS.includes(`.${name}`), `classe ${name} sem estilo`);
  assert.doesNotMatch(HOME_CSS, /#[0-9a-fA-F]{3,8}\b/, 'as cores vêm das variáveis de app.css');
  assert.ok(!/style:\s*['"`]/.test(HOME_CODE), 'a CSP do app bloqueia o atributo style');
  assert.doesNotMatch(HOME_CODE, /window\.confirm|window\.prompt|alert\(/);
});

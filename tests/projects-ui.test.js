'use strict';

/**
 * A aba Projetos por dentro, com o renderer/features/projects.js de verdade num DOM de mentira (tests/prefs-fakedom.js): miniaturas
 * (pedidas uma vez por vídeo, com o ícone no lugar enquanto não chegam), ordenar, a lixeira (o texto da confirmação, a caixa "apagar também os
 * arquivos", o que cada resposta do processo principal vira na tela) e o caso do projeto ABERTO: nada é gravado de volta, o player solta o vídeo e a
 * tela recomeça com o aviso guardado. O desenho real (CSS, miniatura de verdade, foco) é conferido em tests/e2e/projects.e2e.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDocument, makeEl } = require('./prefs-fakedom');
const { extendFakeDom } = require('./fakedom-extra');

extendFakeDom(); // o DOM de mentira da aba Preferências ganha o que esta aba usa (seletores com descendentes, classList, closest…)

const CODE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features', 'projects.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const text = (node) => node.textContent;
const plain = (v) => JSON.parse(JSON.stringify(v));

const proj = (id, name, over = {}) => ({
  id, source: { path: `C:\\lives\\${name}.mp4`, size: 5000, duration: 3600, origin: null }, meta: {}, cutCount: 2, counts: { pending: 1, approved: 1, rejected: 0 },
  exportedCount: 0, updatedAt: '2026-10-20T10:00:00.000Z', fileMissing: false, ...over
});

const PLAN = {
  id: 'a1', title: 'Live', unreadable: false, cuts: { total: 4, pending: 1, approved: 2, rejected: 1 }, busy: null,
  data: { files: 4, bytes: 140 }, exports: { files: 2, sidecars: 1, bytes: 3010, missing: 1 },
  download: { video: { name: 'vod baixado.mp4', bytes: 3300000000 }, chat: { name: 'vod.chat.json', bytes: 300 } }, keepsSource: false, sourceName: 'vod baixado.mp4'
};
const RESULT = { projectRemoved: true, removed: { exports: 2, sidecars: 1, video: 1, chat: 1, dataFiles: 5, bytes: 3300003310 }, failed: [], keptSource: false };

function load({ projects = [], api, current = null, confirm, confirmCheck, observer } = {}) {
  const doc = createDocument();
  const el = makeEl(doc);
  const tabs = [];
  const calls = [];
  const toasts = [];
  const logs = [];
  const events = [];
  const selected = [];
  const busHandlers = new Map();
  let list = projects;
  const BF = {
    state: { project: current },
    util: { el },
    ui: {
      registerTab: (def) => tabs.push(def), log: (msg, kind) => logs.push([msg, kind]), toast: (msg, kind) => toasts.push([msg, kind]), selectTab: (id) => { selected.push(id); return true; }, selectWorkTab: () => { selected.push('work'); return true; },
      confirm: async (opts) => { events.push(['confirm', opts]); return confirm === undefined ? true : confirm; },
      confirmCheck: async (opts) => { events.push(['confirmCheck', opts]); return confirmCheck === undefined ? { checked: true } : confirmCheck; }
    },
    bus: { on: (name, fn) => busHandlers.set(name, fn), emit() {} },
    api: async (channel, payload, opts = {}) => { // como o BF.api do app: a resposta { ok:false } vira toast de erro só com { toast: true }
      calls.push([channel, payload]);
      const custom = api ? await api(channel, payload, { setList: (next) => { list = next; } }) : undefined;
      const res = custom !== undefined ? custom : (channel === 'project:list' ? { ok: true, projects: list } : { ok: true });
      if (res.ok === false && opts.toast) toasts.push([res.message, 'error']);
      return res;
    },
    openSource: async () => ({ ok: true }),
    project: { discard: async () => { events.push('discard'); } },
    player: { unload: () => events.push('unload') },
    review: { history: { discard: async (id) => events.push(['history', id]) } },
    flash: (message, kind) => events.push(['flash', message, kind]),
    restart: () => events.push('restart')
  };
  // `observer`: um IntersectionObserver de mentira (sem ele a feature pede todas as miniaturas na hora, como nos outros testes)
  const sandbox = { window: { BF, getComputedStyle: (n) => ({ overflowY: /\bscroller\b/.test(n.className) ? 'auto' : 'visible' }) }, document: doc, setTimeout, clearTimeout, Date };
  if (observer) sandbox.IntersectionObserver = observer;
  vm.runInContext(CODE, vm.createContext(sandbox), { filename: 'projects.js' });
  const tab = tabs[0];
  const container = doc.register('container');
  container.className = 'scroller'; // a área de trabalho que rola
  tab.render(container);
  const q = (selector) => container.querySelector(selector);
  const all = (selector) => container.querySelectorAll(selector);
  const cards = () => all('.prj-card');
  const titles = () => cards().map((c) => text(c.querySelector('.prj-title')));
  return { BF, doc, container, calls, toasts, logs, events, selected, busHandlers, q, all, cards, titles, setList: (next) => { list = next; } };
}

const idle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };

test('cada cartão mostra a miniatura (com o botão de abrir e o play) quando ela chega e o ícone enquanto não chega; o pedido leva id, caminho, tamanho e duração', async () => {
  const projects = [proj('a1', 'primeira'), proj('b2', 'segunda'), proj('c3', 'terceira', { fileMissing: true })];
  const env = load({
    projects,
    api: (channel, payload) => {
      if (channel !== 'project:thumbnail') return undefined;
      if (payload.id === 'a1') return { ok: true, state: 'ready', url: 'file:///cache/thumbs/a1.x.jpg?v=1' };
      if (payload.id === 'b2') return { ok: true, state: 'none', reason: 'NO_FFMPEG' };
      return { ok: true, state: 'missing' };
    }
  });
  await idle();
  const requested = env.calls.filter(([c]) => c === 'project:thumbnail').map(([, p]) => plain(p));
  assert.deepEqual(requested.map((p) => p.id).sort(), ['a1', 'b2', 'c3']);
  assert.deepEqual(requested.find((p) => p.id === 'a1'), { id: 'a1', path: 'C:\\lives\\primeira.mp4', size: 5000, duration: 3600 });
  const thumb = (id) => env.q(`[data-id="${id}"]`).querySelector('.prj-thumb');
  const first = thumb('a1');
  assert.equal(first.querySelector('img').attrs.src, 'file:///cache/thumbs/a1.x.jpg?v=1');
  assert.ok(first.classList.contains('has-image'));
  assert.ok(first.querySelector('.prj-play'), 'o play fica por cima do quadro');
  assert.equal(first.attrs['aria-label'], 'Abrir o projeto primeira');
  assert.equal(first.disabled, false);
  const second = thumb('b2');
  assert.equal(second.querySelector('img'), null);
  assert.ok(second.querySelector('.material-symbols-rounded'), 'sem quadro o ícone do tipo de vídeo fica no lugar');
  assert.equal(second.classList.contains('has-image'), false);
  const third = thumb('c3');
  assert.equal(third.disabled, true, 'vídeo que sumiu não abre pela miniatura');
  assert.equal(third.attrs.title, 'Vídeo não encontrado');
  // abrir pela miniatura é o mesmo que o botão Abrir
  let opened = null;
  env.BF.openSource = async (file) => { opened = file; return { ok: true }; };
  first.click();
  await idle();
  assert.equal(opened, 'C:\\lives\\primeira.mp4');
});

test('a miniatura é pedida uma vez por vídeo: redesenhar (buscar, filtrar, ordenar, voltar à aba) não repete o pedido, e uma falha só é repetida depois de um minuto', async () => {
  const env = load({ projects: [proj('a1', 'primeira'), proj('b2', 'segunda')], api: (channel, payload) => (channel === 'project:thumbnail' ? (payload.id === 'a1' ? { ok: true, state: 'ready', url: 'file:///a1.jpg' } : { ok: true, state: 'none', reason: 'FAILED' }) : undefined) });
  await idle();
  const count = () => env.calls.filter(([c]) => c === 'project:thumbnail').length;
  assert.equal(count(), 2);
  const search = env.q('[data-act="search"]');
  search.value = 'prim';
  search.dispatch('input');
  search.value = '';
  search.dispatch('input');
  env.q('[data-act="sort"]').value = 'name';
  env.q('[data-act="sort"]').dispatch('change');
  env.q('[data-filter="review"]').click();
  await idle();
  assert.equal(count(), 2, 'nada foi pedido de novo');
  assert.ok(env.q('[data-id="a1"] .prj-thumb img'), 'a miniatura que já chegou aparece nos cartões redesenhados sem novo pedido');
  // o ffmpeg apareceu (tools:changed): as que falharam podem ser pedidas de novo
  env.busHandlers.get('tools:changed')({ tools: {} });
  await idle();
  assert.equal(count(), 3, 'só a que não tinha miniatura');
  // um projeto cujo arquivo mudou (outro tamanho) tem outra miniatura
  env.setList([proj('a1', 'primeira', { source: { path: 'C:\\lives\\primeira.mp4', size: 9999, duration: 3600, origin: null } })]);
  await env.busHandlers.get('project:loaded')();
  await idle();
  assert.equal(count(), 4);
});

test('carga preguiçosa: só os cartões que entram na área visível (com folga, na área que rola) pedem a miniatura; ao redesenhar só os que ainda não têm', async () => {
  const observers = [];
  class FakeObserver {
    constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); observers.push(this); }
    observe(node) { this.targets.add(node); }
    unobserve(node) { this.targets.delete(node); }
    disconnect() { this.targets.clear(); }
  }
  const projects = [proj('a1', 'primeira'), proj('b2', 'segunda'), proj('c3', 'terceira')];
  const env = load({ projects, observer: FakeObserver, api: (channel) => (channel === 'project:thumbnail' ? { ok: true, state: 'ready', url: 'file:///x.jpg' } : undefined) });
  await idle();
  const requested = () => env.calls.filter(([c]) => c === 'project:thumbnail').map(([, p]) => p.id);
  assert.deepEqual(requested(), [], 'nenhum cartão aparece ainda: nada é pedido');
  assert.equal(observers.length, 1);
  const observer = observers[0];
  assert.equal(observer.options.rootMargin, '240px');
  assert.ok(observer.options.root && /\bscroller\b/.test(observer.options.root.className), 'a folga vale na área que rola, não na janela (os cartões de baixo ficam cortados por ela)');
  assert.equal(observer.targets.size, 3);
  const card = (id) => env.q(`[data-id="${id}"]`);
  observer.callback([{ isIntersecting: true, target: card('b2') }, { isIntersecting: false, target: card('a1') }]);
  await idle();
  assert.deepEqual(requested(), ['b2']);
  assert.ok(!observer.targets.has(card('b2')) && observer.targets.has(card('a1')), 'quem já foi pedido deixa de ser observado');
  // ordenar redesenha: os cartões novos são observados de novo, menos o que já tem miniatura
  env.q('[data-act="sort"]').value = 'name';
  env.q('[data-act="sort"]').dispatch('change');
  assert.deepEqual(plain([...observer.targets].map((n) => n.dataset.id)).sort(), ['a1', 'c3']);
  assert.ok(env.q('[data-id="b2"] .prj-thumb img'), 'o cartão redesenhado já nasce com a miniatura');
  observer.callback([{ isIntersecting: true, target: card('a1') }, { isIntersecting: true, target: card('c3') }]);
  await idle();
  assert.deepEqual(requested().sort(), ['a1', 'b2', 'c3']);
});

test('o erro ao carregar o quadro (arquivo da miniatura sumiu) volta ao ícone sem quebrar', async () => {
  const env = load({ projects: [proj('a1', 'primeira')], api: (channel) => (channel === 'project:thumbnail' ? { ok: true, state: 'ready', url: 'file:///some.jpg' } : undefined) });
  await idle();
  const thumb = env.q('[data-id="a1"] .prj-thumb');
  const img = thumb.querySelector('img');
  img.dispatch('error');
  assert.equal(thumb.querySelector('img'), null);
  assert.equal(thumb.classList.contains('has-image'), false);
  assert.ok(thumb.querySelector('.material-symbols-rounded'));
});

test('ordenar: mais recentes (padrão), mais antigos, nome, mais cortes e mais longos; a escolha vale com busca e filtro', async () => {
  const projects = [
    proj('a1', 'Zebra', { updatedAt: '2026-10-22T10:00:00.000Z', cutCount: 1, source: { path: 'C:\\x\\Zebra.mp4', size: 1, duration: 100, origin: null } }),
    proj('b2', 'abacaxi', { updatedAt: '2026-10-20T10:00:00.000Z', cutCount: 9, source: { path: 'C:\\x\\abacaxi.mp4', size: 1, duration: 9000, origin: null } }),
    proj('c3', 'Maçã', { updatedAt: '2026-10-21T10:00:00.000Z', cutCount: 5, source: { path: 'C:\\x\\Maçã.mp4', size: 1, duration: 500, origin: null } })
  ];
  const env = load({ projects });
  await idle();
  assert.deepEqual(env.titles(), ['Zebra', 'Maçã', 'abacaxi'], 'padrão: mais recentes primeiro');
  const sort = env.q('[data-act="sort"]');
  assert.deepEqual(plain(sort.children.map((o) => text(o))), ['Mais recentes', 'Mais antigos', 'Nome (A–Z)', 'Mais cortes', 'Mais longos']);
  const pick = (value) => { env.q('[data-act="sort"]').value = value; env.q('[data-act="sort"]').dispatch('change'); return env.titles(); };
  assert.deepEqual(pick('oldest'), ['abacaxi', 'Maçã', 'Zebra']);
  assert.deepEqual(pick('name'), ['abacaxi', 'Maçã', 'Zebra'], 'sem diferenciar maiúscula nem acento');
  assert.deepEqual(pick('cuts'), ['abacaxi', 'Maçã', 'Zebra']);
  assert.deepEqual(pick('long'), ['abacaxi', 'Maçã', 'Zebra']);
  assert.deepEqual(pick('recent'), ['Zebra', 'Maçã', 'abacaxi']);
  const search = env.q('[data-act="search"]');
  pick('name');
  search.value = 'a';
  search.dispatch('input');
  assert.deepEqual(env.titles(), ['abacaxi', 'Maçã', 'Zebra'].filter((n) => /a/i.test(n.normalize('NFD').replace(/[̀-ͯ]/g, ''))));
  assert.equal(env.q('[data-act="sort"]').value, 'name', 'a ordem escolhida continua depois de buscar');
});

test('cada cartão tem a lixeira (ícone, nome acessível com o título do projeto) depois do botão de abrir e da pasta', async () => {
  const env = load({ projects: [proj('a1', 'primeira'), proj('c3', 'terceira', { fileMissing: true })] });
  await idle();
  const normal = env.q('[data-id="a1"]');
  assert.deepEqual(plain(normal.querySelectorAll('.prj-actions button').map((b) => b.dataset.act)), ['open', 'reveal', 'delete']);
  const trash = normal.querySelector('[data-act="delete"]');
  assert.equal(trash.attrs['aria-label'], 'Apagar o projeto primeira');
  assert.equal(trash.attrs.title, 'Apagar o projeto');
  assert.ok(trash.className.split(/\s+/).includes('icon-btn') && trash.className.split(/\s+/).includes('prj-delete'));
  assert.equal(text(trash.querySelector('.material-symbols-rounded')), 'delete');
  const missing = env.q('[data-id="c3"]');
  assert.deepEqual(plain(missing.querySelectorAll('.prj-actions button').map((b) => b.dataset.act)), ['locate', 'delete'], 'vídeo que sumiu também pode ter o projeto apagado');
});

test('deleteDialog: o texto diz o que sai e o que fica; a caixa só existe se há arquivos a apagar e traz contagem e tamanho', () => {
  const { BF } = load();
  const { deleteDialog, fmtBytes } = BF.projects;
  const full = deleteDialog(PLAN, 'Live de teste');
  assert.equal(full.title, 'Apagar “Live de teste”?');
  assert.match(full.message, /O projeto sai da lista e tudo o que o app guardou dele é apagado: os cortes e as decisões, o histórico, a transcrição e a miniatura\./);
  assert.match(full.message, /Isto não pode ser desfeito\.$/);
  assert.doesNotMatch(full.message, /não é apagado/, 'o vídeo baixado sai junto: nada a dizer sobre ficar');
  assert.deepEqual(plain(full.check), { label: 'Apagar também os arquivos do projeto', hint: '2 cortes exportados (e 1 legenda ao lado), o vídeo baixado pelo app (vod baixado.mp4) e o chat baixado · 3,1 GB', checked: true });
  // vídeo do usuário: ele fica e a mensagem diz qual
  const own = deleteDialog({ ...PLAN, download: null, keepsSource: true, sourceName: 'minha gravacao.mp4', exports: { files: 1, sidecars: 0, bytes: 1048576, missing: 0 } }, 'Minha gravação');
  assert.match(own.message, /O vídeo “minha gravacao\.mp4” não é apagado\./);
  assert.deepEqual(plain(own.check), { label: 'Apagar também os arquivos do projeto', hint: '1 corte exportado · 1,0 MB', checked: true });
  // sem arquivo nenhum: sem caixa
  const none = deleteDialog({ ...PLAN, download: null, keepsSource: true, exports: { files: 0, sidecars: 0, bytes: 0, missing: 3 } }, 'x');
  assert.equal(none.check, null);
  // vídeo que já sumiu: não diz que ele "não é apagado"
  assert.doesNotMatch(deleteDialog({ ...PLAN, download: null, keepsSource: true, exports: { files: 0, sidecars: 0, bytes: 0, missing: 0 } }, 'x', { missing: true }).message, /não é apagado/);
  // arquivo do projeto danificado
  assert.match(deleteDialog({ ...PLAN, unreadable: true, download: null, exports: { files: 0, sidecars: 0, bytes: 0, missing: 0 } }, 'x').message, /danificado ou não pôde ser lido: só o que o app guardou dele será apagado/);
  assert.deepEqual(plain(['0', '1023', '1024', '1536', '104857600', '3300000000'].map((n) => fmtBytes(Number(n)))), ['0 B', '1023 B', '1,0 KB', '1,5 KB', '100 MB', '3,1 GB']);
});

test('doneMessage: quanto espaço voltou e, se algum arquivo resistiu, quais (o aviso vira erro)', () => {
  const { doneMessage } = load().BF.projects;
  assert.deepEqual(plain(doneMessage(RESULT)), { text: 'Projeto apagado. Liberou 3,1 GB.', kind: 'ok' });
  assert.deepEqual(plain(doneMessage({ projectRemoved: true, removed: { bytes: 0 }, failed: [] })), { text: 'Projeto apagado.', kind: 'ok' });
  const one = doneMessage({ projectRemoved: true, removed: { bytes: 2048 }, failed: [{ name: 'corte.mp4', message: 'o arquivo está em uso por outro programa (ou sem permissão)' }] });
  assert.equal(one.kind, 'error');
  assert.equal(one.text, 'Projeto apagado. Liberou 2,0 KB. Um arquivo não pôde ser removido (o arquivo está em uso por outro programa (ou sem permissão)): “corte.mp4”. Apague-o à mão.');
  const many = doneMessage({ projectRemoved: true, removed: { bytes: 0 }, failed: ['a', 'b', 'c', 'd'].map((n) => ({ name: `${n}.mp4`, message: 'o disco não respondeu a tempo' })) });
  assert.match(many.text, /4 arquivos não puderam ser removidos \(o disco não respondeu a tempo\): “a\.mp4”, “b\.mp4”, “c\.mp4” e outros\. Apague-os à mão\./);
  assert.match(doneMessage({ projectRemoved: false, removed: { bytes: 0 }, failed: [{ name: 'p.json', message: 'x' }] }).text, /^O projeto não pôde ser apagado por completo\./);
});

test('lixeira: mostra a confirmação com o que sai; recusar não apaga nada; confirmar chama project:delete com a escolha da caixa e atualiza a lista', async () => {
  const projects = [proj('a1', 'primeira'), proj('b2', 'segunda')];
  const env = load({
    projects,
    api: (channel, payload, h) => {
      if (channel === 'project:deletePreview') return { ok: true, plan: { ...PLAN, id: payload.id } };
      if (channel === 'project:delete') { h.setList(projects.filter((p) => p.id !== payload.id)); return { ok: true, result: RESULT }; }
      return undefined;
    },
    confirmCheck: null
  });
  await idle();
  env.q('[data-id="a1"] [data-act="delete"]').click();
  await idle();
  const asked = env.events.find((e) => e[0] === 'confirmCheck')[1];
  assert.equal(asked.title, 'Apagar “primeira”?');
  assert.equal(asked.okLabel, 'Apagar projeto');
  assert.equal(asked.cancelLabel, 'Manter');
  assert.equal(asked.danger, true);
  assert.equal(asked.check.checked, true, 'a caixa já vem marcada');
  assert.equal(env.calls.filter(([c]) => c === 'project:delete').length, 0, 'recusou: nada foi apagado');
  assert.deepEqual(env.titles(), ['primeira', 'segunda']);
  assert.equal(env.q('[data-id="a1"] [data-act="delete"]').disabled, false, 'os botões voltam depois de recusar');

  // confirma com a caixa desmarcada: só o projeto e os dados
  env.events.length = 0;
  env.BF.ui.confirmCheck = async (opts) => { env.events.push(['confirmCheck', opts]); return { checked: false }; };
  env.q('[data-id="a1"] [data-act="delete"]').click();
  await idle();
  const call = env.calls.find(([c]) => c === 'project:delete');
  assert.deepEqual(plain(call[1]), { id: 'a1', files: false });
  assert.deepEqual(env.titles(), ['segunda'], 'a lista foi atualizada');
  assert.deepEqual(plain(env.toasts[env.toasts.length - 1]), ['Projeto apagado. Liberou 3,1 GB.', 'ok']);
  assert.ok(!env.events.includes('discard') && !env.events.includes('restart'), 'não era o projeto aberto: nada de soltar o player nem recarregar');

  // com a caixa marcada
  env.calls.length = 0;
  env.BF.ui.confirmCheck = async () => ({ checked: true });
  env.q('[data-id="b2"] [data-act="delete"]').click();
  await idle();
  assert.deepEqual(plain(env.calls.find(([c]) => c === 'project:delete')[1]), { id: 'b2', files: true });
});

test('sem arquivos a apagar a confirmação é a simples (sem caixa); recusar não apaga; "ocupado" mostra o motivo e não pergunta nada', async () => {
  const plans = {
    a1: { ...PLAN, id: 'a1', exports: { files: 0, sidecars: 0, bytes: 0, missing: 0 }, download: null, keepsSource: true, sourceName: 'primeira.mp4' },
    b2: { ...PLAN, id: 'b2', busy: 'Há uma exportação deste projeto na fila ou em andamento. Cancele-a na aba Exportações antes de apagar o projeto.' }
  };
  const env = load({ projects: [proj('a1', 'primeira'), proj('b2', 'segunda')], api: (channel, payload) => (channel === 'project:deletePreview' ? { ok: true, plan: plans[payload.id] } : undefined), confirm: false });
  await idle();
  env.q('[data-id="a1"] [data-act="delete"]').click();
  await idle();
  assert.equal(env.events.filter((e) => e[0] === 'confirmCheck').length, 0);
  const simple = env.events.find((e) => e[0] === 'confirm')[1];
  assert.match(simple.message, /O vídeo “primeira\.mp4” não é apagado\./);
  assert.equal(env.calls.filter(([c]) => c === 'project:delete').length, 0, 'recusou');
  env.events.length = 0;
  env.q('[data-id="b2"] [data-act="delete"]').click();
  await idle();
  assert.deepEqual(env.events, [], 'ocupado: nem pergunta');
  assert.deepEqual(plain(env.toasts[env.toasts.length - 1]), ['Há uma exportação deste projeto na fila ou em andamento. Cancele-a na aba Exportações antes de apagar o projeto.', 'error']);
  assert.equal(env.calls.filter(([c]) => c === 'project:delete').length, 0);
});

test('erro ao visualizar ou ao apagar: o aviso do processo principal aparece e a lista segue (projeto que não existe mais some dela)', async () => {
  let preview = { ok: false, code: 'PROJECT_NOT_FOUND', message: 'Este projeto não existe mais.' };
  const env = load({
    projects: [proj('a1', 'primeira'), proj('b2', 'segunda')],
    api: (channel, payload, h) => {
      if (channel === 'project:deletePreview') {
        if (!preview.ok) h.setList([proj('b2', 'segunda')]); // o arquivo do projeto já tinha sido apagado por fora
        return preview;
      }
      if (channel === 'project:delete') return { ok: false, code: 'PROJECT_BUSY', message: 'Há uma análise deste vídeo em andamento.' };
      return undefined;
    }
  });
  await idle();
  env.q('[data-id="a1"] [data-act="delete"]').click();
  await idle();
  assert.deepEqual(plain(env.toasts[env.toasts.length - 1]), ['Este projeto não existe mais.', 'error']);
  assert.equal(env.events.length, 0, 'sem confirmação para um projeto que não existe');
  assert.deepEqual(env.titles(), ['segunda'], 'a lista foi atualizada e o projeto sumiu dela');
  preview = { ok: true, plan: { ...PLAN, id: 'b2' } };
  env.q('[data-id="b2"] [data-act="delete"]').click();
  await idle();
  assert.deepEqual(plain(env.toasts[env.toasts.length - 1]), ['Há uma análise deste vídeo em andamento.', 'error']);
  assert.ok(!env.events.includes('restart'), 'projeto fechado: nada a recarregar');
  assert.deepEqual(env.titles(), ['segunda'], 'o projeto que não foi apagado continua na lista');
  assert.equal(env.q('[data-id="b2"] [data-act="delete"]').disabled, false, 'os botões voltam depois do erro');
});

test('apagar o projeto ABERTO: solta o histórico e o salvamento, descarrega o player, apaga e recarrega a tela com o aviso guardado (nada fica na memória para regravar)', async () => {
  const open = { id: 'a1', source: { path: 'C:\\lives\\primeira.mp4' } };
  const env = load({
    projects: [proj('a1', 'primeira')], current: open,
    api: (channel, payload) => {
      if (channel === 'project:deletePreview') return { ok: true, plan: { ...PLAN, id: payload.id } };
      if (channel === 'project:delete') { env.events.push(['delete', payload]); return { ok: true, result: RESULT }; }
      return undefined;
    }
  });
  await idle();
  assert.match(text(env.q('[data-id="a1"]')), /Aberto agora/);
  env.events.length = 0;
  env.q('[data-id="a1"] [data-act="delete"]').click();
  await idle();
  const order = env.events.map((e) => (Array.isArray(e) ? e[0] : e)).filter((e) => e !== 'confirmCheck');
  assert.deepEqual(order, ['history', 'discard', 'unload', 'delete', 'flash', 'restart'], 'primeiro tudo é solto, depois apaga, depois o aviso e a recarga');
  assert.deepEqual(env.events.find((e) => e[0] === 'history'), ['history', 'a1']);
  assert.deepEqual(plain(env.events.find((e) => e[0] === 'flash').slice(1)), ['Projeto apagado. Liberou 3,1 GB.', 'ok']);
  assert.equal(env.toasts.length, 0, 'o toast comum sumiria com a recarga: o aviso vai pela mensagem guardada');
  // a resposta de erro também recarrega (o projeto continua no disco e volta à lista) com o aviso de erro
  const failing = load({
    projects: [proj('a1', 'primeira')], current: open,
    api: (channel, payload) => (channel === 'project:deletePreview' ? { ok: true, plan: { ...PLAN, id: payload.id } } : (channel === 'project:delete' ? { ok: false, code: 'ERROR', message: 'Não deu.' } : undefined))
  });
  await idle();
  failing.events.length = 0;
  failing.q('[data-id="a1"] [data-act="delete"]').click();
  await idle();
  assert.deepEqual(plain(failing.events.filter((e) => Array.isArray(e) && e[0] === 'flash')[0].slice(1)), ['Não deu.', 'error']);
  assert.ok(failing.events.includes('restart'));
});

test('o cabeçalho tem o botão "Novo projeto" (a tela não tem item no menu): a única ação principal, em todos os estados da lista', async () => {
  const env = load({ projects: [proj('a1', 'primeira'), proj('b2', 'segunda')] });
  await idle();
  const button = (e) => e.q('.prj-head [data-act="new"]');
  assert.equal(text(button(env)), 'addNovo projeto');
  assert.ok(button(env).classList.contains('primary'));
  assert.match(text(env.q('.prj-head .prj-intro')), /Os vídeos em que você já trabalhou/);
  button(env).click();
  assert.deepEqual(env.selected, ['sources'], 'abre a tela Novo projeto');
  // os botões dos cartões são de contorno: sobra uma ação principal só
  assert.ok(env.all('[data-act="open"]').length === 2 && env.all('[data-act="open"]').every((b) => b.classList.contains('secondary') && !b.classList.contains('primary')));
  assert.equal(env.all('.primary').length, 1);

  // vazia: o botão do cabeçalho vale (não há outro dentro do estado vazio) e o texto aponta para ele
  const empty = load({ projects: [] });
  await idle();
  assert.ok(button(empty));
  assert.equal(empty.all('.prj-empty button').length, 0);
  assert.match(text(empty.q('.prj-empty')), /Nenhum projeto ainda.*Use Novo projeto para começar\./);
  assert.equal(empty.all('.primary').length, 1);

  // carregando e com erro: o botão está lá, porque começar um projeto não depende da lista
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const loading = load({ api: (channel) => (channel === 'project:list' ? gate.then(() => ({ ok: true, projects: [] })) : undefined) });
  assert.ok(button(loading), 'enquanto a lista carrega');
  release();
  await idle();
  const failing = load({ api: (channel) => (channel === 'project:list' ? { ok: false, message: 'Disco indisponível.' } : undefined) });
  await idle();
  assert.ok(button(failing), 'com a lista com erro');
  button(failing).click();
  assert.deepEqual(failing.selected, ['sources']);
});

test('um cartão de vídeo que sumiu também tem botão de contorno ("Localizar vídeo…")', async () => {
  const env = load({ projects: [proj('a1', 'primeira', { fileMissing: true })] });
  await idle();
  const locate = env.q('[data-act="locate"]');
  assert.ok(locate.classList.contains('secondary') && !locate.classList.contains('primary'));
});

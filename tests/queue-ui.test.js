'use strict';

/**
 * A tela Exportações por dentro, com o renderer/features/queue.js de verdade num DOM de mentira (tests/prefs-fakedom.js + tests/fakedom-extra.js):
 * as pílulas Fila | Concluídos | Falhas com a contagem e uma lista para cada, o estado vazio de cada uma, as ações que só valem numa pílula,
 * o cartão de cada estado e a BARRA DE SAÍDA (perfil e destino do projeto aberto, que são os da aba Exportar, e o limite de exportações ao
 * mesmo tempo). O desenho real (CSS, arrastar, diálogo, exportação de verdade) é conferido em tests/e2e/queue.e2e.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDocument, makeEl } = require('./prefs-fakedom');
const { extendFakeDom, FakeNode } = require('./fakedom-extra');

extendFakeDom();

const CODE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features', 'queue.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const idle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const ACTIVE = ['queued', 'running', 'needsAction', 'interrupted'];

const snapshot = (jobs, extra = {}) => ({
  ok: true, jobs, running: jobs.filter((j) => j.state === 'running').length, paused: false, parallel: 1, active: jobs.filter((j) => ACTIVE.includes(j.state)).length,
  blocked: null, recovery: { pending: false, jobs: [] }, loadWarning: null, saveError: null,
  settings: { parallel: null, retries: 2, recovery: 'ask', onConflict: 'ask', defaultParallel: 1, effectiveParallel: 1 }, ...extra
});

const job = (id, state, extra = {}) => ({
  id, key: `k-${id}`, state, projectId: 'p1', sourcePath: 'D:\\Lives\\live.mp4', baseName: `corte ${id}`,
  cut: { id, title: `Corte ${id}`, start: 10, end: 40, revision: 1 }, profile: { name: 'Vertical 9:16 · 1080p · H.264' },
  finishedAt: ['done', 'failed', 'skipped', 'cancelled'].includes(state) ? `2026-10-21T10:0${id.length}:00.000Z` : undefined, ...extra
});

/** Um conjunto com trabalhos em todas as pílulas: 3 na Fila (1 exportando), 3 em Concluídos (concluído, pulado, cancelado) e 1 falha. */
const MIXED = () => [
  job('r', 'running', { progress: 0.3, output: null }), job('q1', 'queued'), job('q2', 'queued'),
  job('d', 'done', { output: 'D:\\Lives\\Cortes\\corte d.mp4', finishedAt: '2026-10-21T10:10:00.000Z' }),
  job('s', 'skipped', { skippedCode: 'ALREADY_DONE', skippedReason: 'Já exportado.', finishedAt: '2026-10-21T10:20:00.000Z' }),
  job('c', 'cancelled', { cancelReason: 'Cancelado pelo usuário.', finishedAt: '2026-10-21T10:30:00.000Z' }),
  job('f', 'failed', { error: { message: 'O disco ficou cheio.', solution: 'Libere espaço e tente de novo.' }, finishedAt: '2026-10-21T10:40:00.000Z' })
];

const PROJECT = { id: 'p1', source: { path: 'D:\\Lives\\live.mp4' }, cuts: [] };

/** Um exportOut de mentira (a aba Exportar de verdade fica em export.js): o resumo muda quando o teste muda `out`. */
function fakeExportOut() {
  const out = {
    profileId: 'p2',
    profiles: [{ id: 'p1', name: 'Vertical 9:16 · 1080p · H.264' }, { id: 'p2', name: 'Vertical 9:16 · 1440p · H.265 (ajustado)' }],
    dir: 'D:\\Projetos\\Lives de outubro\\Terceira semana\\Cortes de teste\\Cortes'
  };
  const seen = { summary: 0, ensure: 0, choose: [], pick: 0 };
  const api = {
    summary: () => { seen.summary += 1; return out; },
    ensureProfiles: async () => { seen.ensure += 1; },
    chooseProfile: (id) => { seen.choose.push(id); out.profileId = id; },
    pickDir: async () => { seen.pick += 1; out.dir = 'E:\\Novo destino'; return true; }
  };
  return { out, seen, api };
}

function load({ jobs = [], paused = false, project = null, exportOut = undefined } = {}) {
  const doc = createDocument();
  const calls = [];
  const listeners = {};
  const busListeners = {};
  const toasts = [];
  let tab = null;
  const current = snapshot(jobs, { paused });
  const BF = {
    util: { el: makeEl(doc), nameOf: (p) => String(p).split(/[\\/]/).pop() },
    state: { project, tools: {} },
    ui: { registerTab: (def) => { tab = def; }, refreshTabs() {}, log() {}, toast: (message, kind) => toasts.push([message, kind]), confirm: async () => true },
    on: (channel, cb) => { listeners[channel] = cb; return () => {}; },
    bus: { on: (event, cb) => { busListeners[event] = cb; return () => {}; }, emit() {} },
    api: async (channel, payload) => {
      calls.push([channel, plain(payload)]);
      if (channel === 'queue:list') return current;
      if (channel === 'queue:setSettings') { current.settings = { ...current.settings, ...payload }; return { ok: true, settings: current.settings }; }
      return { ok: true };
    },
    project: { cut: () => null, update() {} },
    prefs: { get: (key, fallback) => fallback },
    ready: Promise.resolve()
  };
  if (exportOut) BF.exportOut = exportOut;
  const sandbox = { window: { BF }, document: doc, Element: FakeNode, setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout, console, Date };
  vm.runInContext(CODE, vm.createContext(sandbox), { filename: 'queue.js' });
  const container = doc.register('panel');
  tab.render(container);
  const q = (selector) => container.querySelector(selector);
  const all = (selector) => container.querySelectorAll(selector);
  const pills = () => all('.q-pill').map((p) => p.textContent);
  const lists = () => Object.fromEntries(all('.q-list').map((ul) => [ul.dataset.list, { hidden: ul.hidden, ids: ul.children.map((li) => li.dataset.id) }]));
  const push = (next, extra = {}) => { listeners['queue:update'](snapshot(next, extra)); };
  return { BF, tab, calls, toasts, listeners, busListeners, q, all, pills, lists, push, queue: BF.queue };
}

test('três pílulas com a contagem e uma lista para cada: Fila (executando primeiro), Concluídos (concluído, pulado e cancelado) e Falhas', async () => {
  const env = load({ jobs: MIXED() });
  await idle();
  assert.deepEqual(env.pills(), ['Fila (3)', 'Concluídos (3)', 'Falhas (1)']);
  assert.deepEqual(plain(env.lists()), {
    queue: { hidden: false, ids: ['r', 'q1', 'q2'] },
    done: { hidden: true, ids: ['c', 's', 'd'] },
    failed: { hidden: true, ids: ['f'] }
  }, 'cada lista tem os seus trabalhos (Concluídos do mais recente ao mais antigo) e só a da pílula mostrada fica visível');
  assert.deepEqual(plain(env.all('.q-pill').map((p) => p.attrs['aria-pressed'])), ['true', 'false', 'false']);
  assert.equal(env.q('.q-bar').hidden, false);
  // trocar de pílula mostra só a lista dela e a escolha sobrevive às atualizações da fila
  env.q('[data-tab="done"]').click();
  assert.deepEqual(plain(Object.values(env.lists()).map((l) => l.hidden)), [true, false, true]);
  assert.deepEqual(plain(env.all('.q-pill').map((p) => p.attrs['aria-pressed'])), ['false', 'true', 'false']);
  env.push([...MIXED(), job('q3', 'queued')]);
  assert.deepEqual(env.pills(), ['Fila (4)', 'Concluídos (3)', 'Falhas (1)']);
  assert.equal(env.lists().done.hidden, false, 'a pílula escolhida continua depois de a fila mudar');
  env.q('[data-tab="failed"]').click();
  assert.deepEqual(plain(Object.values(env.lists()).map((l) => l.hidden)), [true, true, false]);
  // um trabalho que muda de estado muda de lista: o que estava exportando termina e passa para Concluídos
  env.push(MIXED().map((j) => (j.id === 'r' ? { ...j, state: 'done', output: 'D:\\x.mp4', finishedAt: '2026-10-21T11:00:00.000Z' } : j)));
  assert.deepEqual(env.pills(), ['Fila (2)', 'Concluídos (4)', 'Falhas (1)']);
  assert.deepEqual(plain(env.lists().done.ids), ['r', 'c', 's', 'd']);
  assert.deepEqual(plain(env.lists().queue.ids), ['q1', 'q2']);
});

test('a pílula de Falhas fica em destaque (cor de alerta) só quando há falha', async () => {
  const env = load({ jobs: MIXED() });
  await idle();
  assert.equal(env.q('[data-tab="failed"]').classList.contains('q-pill-bad'), true);
  env.push(MIXED().filter((j) => j.state !== 'failed'));
  assert.equal(env.q('[data-tab="failed"]').classList.contains('q-pill-bad'), false);
  assert.deepEqual(env.pills(), ['Fila (3)', 'Concluídos (3)', 'Falhas (0)']);
});

test('cada pílula vazia explica o que aparece nela; com trabalhos o estado vazio some', async () => {
  const env = load({ jobs: MIXED().filter((j) => j.state === 'done') });
  await idle();
  const empty = () => ({ hidden: env.q('.q-empty').hidden, title: env.q('.q-empty strong').textContent });
  assert.deepEqual(plain(empty()), { hidden: false, title: 'Nada na fila' }, 'a Fila é a pílula inicial e está vazia');
  assert.match(env.q('.q-empty p').textContent, /Os cortes enviados pela aba Exportar aparecem aqui/);
  env.q('[data-tab="failed"]').click();
  assert.deepEqual(plain(empty()), { hidden: false, title: 'Nenhuma falha' });
  env.q('[data-tab="done"]').click();
  assert.equal(empty().hidden, true, 'Concluídos tem um trabalho');
  env.push([]);
  assert.deepEqual(plain(empty()), { hidden: false, title: 'Nenhuma exportação concluída' });
});

test('sem trabalhos e sem pausa as pílulas nem aparecem; com a fila pausada elas voltam (o "Retomar" mora ao lado)', async () => {
  const env = load({ jobs: [] });
  await idle();
  assert.equal(env.q('.q-bar').hidden, true);
  assert.equal(env.q('.q-empty').hidden, false);
  env.push([], { paused: true });
  assert.equal(env.q('.q-bar').hidden, false);
  assert.equal(env.q('#q-pause').hidden, false);
  assert.equal(env.q('#q-pause').textContent, 'Retomar');
  env.push(MIXED());
  assert.equal(env.q('#q-pause').textContent, 'Pausar fila');
});

test('as ações de cabeçalho seguem a pílula: Cancelar tudo só na Fila com 2 ou mais ativos, Limpar concluídos só em Concluídos, pausar em todas', async () => {
  const env = load({ jobs: MIXED() });
  await idle();
  const flags = () => ({ pause: env.q('#q-pause').hidden, cancelAll: env.q('[data-act="cancel-all"]').hidden, clear: env.q('[data-act="clear"]').hidden });
  assert.deepEqual(plain(flags()), { pause: false, cancelAll: false, clear: true });
  env.q('[data-tab="done"]').click();
  assert.deepEqual(plain(flags()), { pause: false, cancelAll: true, clear: false });
  env.q('[data-tab="failed"]').click();
  assert.deepEqual(plain(flags()), { pause: false, cancelAll: true, clear: true }, 'as falhas ficam até serem tratadas: não há "limpar" para elas');
  env.q('[data-tab="queue"]').click();
  env.push(MIXED().filter((j) => j.id !== 'q1' && j.id !== 'q2'));
  assert.equal(env.q('[data-act="cancel-all"]').hidden, true, 'com um só ativo "Cancelar tudo" nem aparece');
  env.q('[data-tab="done"]').click();
  env.push(MIXED().filter((j) => !['done', 'skipped', 'cancelled'].includes(j.state)));
  assert.equal(env.q('[data-act="clear"]').hidden, true, 'sem nada concluído não há o que limpar');
});

test('cada cartão tem o ícone do estado, o título do corte, a linha do perfil, o selo em texto e as ações do estado', async () => {
  const env = load({ jobs: MIXED() });
  await idle();
  const row = (id) => env.q(`li[data-id="${id}"]`);
  const info = (id) => ({
    state: row(id).dataset.state, icon: row(id).querySelector('.q-lead .material-symbols-rounded').textContent, name: row(id).querySelector('.q-name').textContent,
    chip: row(id).querySelector('.q-chip').textContent, acts: row(id).querySelectorAll('button[data-act]').map((b) => b.dataset.act)
  });
  assert.deepEqual(plain(info('r')), { state: 'running', icon: 'movie', name: 'Corte r', chip: 'Exportando', acts: ['cancel'] });
  assert.deepEqual(plain(info('q1')), { state: 'queued', icon: 'schedule', name: 'Corte q1', chip: 'Na fila', acts: ['remove', 'up', 'down'] });
  assert.deepEqual(plain(info('d')), { state: 'done', icon: 'check_circle', name: 'Corte d', chip: 'Concluído', acts: ['reveal', 'remove'] });
  assert.deepEqual(plain(info('s')), { state: 'skipped', icon: 'skip_next', name: 'Corte s', chip: 'Pulado', acts: ['retry', 'remove'] });
  assert.deepEqual(plain(info('c')), { state: 'cancelled', icon: 'cancel', name: 'Corte c', chip: 'Cancelado', acts: ['retry', 'remove'] });
  assert.deepEqual(plain(info('f')), { state: 'failed', icon: 'error', name: 'Corte f', chip: 'Falhou', acts: ['retry', 'remove'] });
  assert.match(row('q1').querySelector('.q-sub').textContent, /live\.mp4 · 0:10–0:40 · Vertical 9:16 · 1080p · H\.264/);
  assert.match(row('f').textContent, /O disco ficou cheio\./);
  assert.match(row('f').textContent, /Libere espaço e tente de novo\./);
  assert.equal(row('r').querySelector('.q-prog progress').value, '0.3', 'o que está exportando mostra a barra de progresso');
  assert.match(row('r').querySelector('.q-prog-text').textContent, /^30%/);
  // a alça de reordenar só existe no que ainda não começou (o que exporta, termina ou falhou não se reordena)
  assert.deepEqual(plain(['r', 'q1', 'd', 'f'].map((id) => Boolean(row(id).querySelector('.q-reorder')))), [false, true, false, false]);
});

test('os botões do cartão chegam ao processo principal (a tela usa delegação de eventos no painel)', async () => {
  const env = load({ jobs: MIXED() });
  await idle();
  env.calls.length = 0;
  env.q('li[data-id="f"] button[data-act="retry"]').click();
  env.q('li[data-id="q1"] button[data-act="remove"]').click();
  env.q('li[data-id="r"] button[data-act="cancel"]').click();
  await idle();
  const sent = env.calls.filter(([channel]) => channel !== 'queue:list').map(([channel, payload]) => [channel, payload]);
  assert.deepEqual(sent, [['queue:retry', { id: 'f' }], ['queue:remove', { id: 'q1' }], ['queue:cancel', { id: 'r' }]]);
});

test('a barra de saída sem projeto aberto mostra só o limite de fila; perfil e destino são do projeto', async () => {
  const env = load({ jobs: [] });
  await idle();
  const items = env.all('.q-out-item');
  assert.deepEqual(plain(items.map((i) => i.querySelector('.q-out-label').textContent)), ['Perfil de exportação', 'Destino', 'Limite de fila']);
  assert.deepEqual(plain(items.map((i) => i.hidden)), [true, true, false]);
  assert.ok(env.q('#q-parallel'), 'o limite continua aqui, com o id de sempre');
});

test('a barra de saída com projeto aberto: perfil (com ajustes), destino pelo fim do caminho e o botão Alterar', async () => {
  const x = fakeExportOut();
  const env = load({ jobs: MIXED(), project: PROJECT, exportOut: x.api });
  await idle();
  const items = env.all('.q-out-item');
  assert.deepEqual(plain(items.map((i) => i.hidden)), [false, false, false]);
  const select = env.q('#q-profile');
  assert.deepEqual(plain(select.children.map((o) => [o.value, o.textContent])), [['p1', 'Vertical 9:16 · 1080p · H.264'], ['p2', 'Vertical 9:16 · 1440p · H.265 (ajustado)']]);
  assert.equal(select.value, 'p2');
  assert.equal(select.disabled, false);
  const dir = env.q('#q-dir');
  assert.equal(dir.textContent, x.out.dir, 'o texto é o caminho inteiro: quem corta o excesso, pelo começo, é o CSS (o fim, onde está a pasta, sempre aparece)');
  assert.equal(dir.title, x.out.dir, 'e o caminho inteiro também fica na dica');
  assert.equal(dir.querySelector('bdo').attrs.dir, 'ltr', 'o texto segue na ordem normal dentro do bloco que corta pelo começo');
  assert.equal(x.seen.ensure, 1, 'a lista de perfis é pedida uma vez, não a cada redesenho');
  env.push(MIXED());
  env.push(MIXED());
  assert.equal(x.seen.ensure, 1);
  // escolher outro perfil vai para a aba Exportar (a mesma escolha do projeto)
  select.value = 'p1';
  select.dispatch('change');
  assert.deepEqual(x.seen.choose, ['p1']);
  assert.equal(select.value, 'p1');
  // "Alterar…" abre a escolha de pasta e a barra mostra a pasta nova
  env.q('#q-pick-dir').click();
  await idle();
  assert.equal(x.seen.pick, 1);
  assert.equal(dir.textContent, 'E:\\Novo destino');
  assert.equal(dir.title, 'E:\\Novo destino');
});

test('sem a lista de perfis a barra mostra "Carregando…" e o seletor fica desabilitado; quando a lista chega o seletor se enche', async () => {
  const x = fakeExportOut();
  x.out.profiles = [];
  const env = load({ jobs: MIXED(), project: PROJECT, exportOut: x.api });
  await idle();
  const select = env.q('#q-profile');
  assert.deepEqual(plain(select.children.map((o) => o.textContent)), ['Carregando…']);
  assert.equal(select.disabled, true);
  x.out.profiles = [{ id: 'p1', name: 'Vertical 9:16 · 1080p · H.264' }];
  x.out.profileId = 'p1';
  env.busListeners['project:changed']({ reason: 'export:profile' });
  assert.deepEqual(plain(select.children.map((o) => o.textContent)), ['Vertical 9:16 · 1080p · H.264']);
  assert.equal(select.disabled, false);
});

test('a barra acompanha a aba Exportar: só os motivos "export:" do project:changed e a troca de projeto a atualizam', async () => {
  const x = fakeExportOut();
  const env = load({ jobs: MIXED(), project: PROJECT, exportOut: x.api });
  await idle();
  const before = x.seen.summary;
  env.busListeners['project:changed']({ reason: 'cut:decision' });
  env.busListeners['project:changed']({});
  assert.equal(x.seen.summary, before, 'uma decisão de corte não redesenha a barra');
  x.out.profileId = 'p1';
  x.out.dir = 'F:\\Outra pasta';
  env.busListeners['project:changed']({ reason: 'export:dir' });
  assert.equal(env.q('#q-profile').value, 'p1');
  assert.equal(env.q('#q-dir').textContent, 'F:\\Outra pasta');
  // abrir outro projeto pede a lista de novo (ela pode ter mudado) e atualiza a barra
  x.out.dir = 'G:\\Pasta do outro projeto';
  await env.busListeners['project:loaded']({ project: PROJECT });
  await idle();
  assert.equal(env.q('#q-dir').textContent, 'G:\\Pasta do outro projeto');
  assert.equal(x.seen.ensure, 2);
});

test('sem a aba Exportar carregada (nenhum BF.exportOut) a tela não quebra e esconde perfil e destino', async () => {
  const env = load({ jobs: MIXED(), project: PROJECT });
  await idle();
  assert.deepEqual(plain(env.all('.q-out-item').map((i) => i.hidden)), [true, true, false]);
  assert.deepEqual(env.pills(), ['Fila (3)', 'Concluídos (3)', 'Falhas (1)']);
});

test('limite de fila: o seletor mora na barra, grava pelo queue:setSettings e mostra o padrão das Preferências', async () => {
  const env = load({ jobs: MIXED() });
  await idle();
  const select = env.q('#q-parallel');
  assert.equal(select.value, '');
  assert.equal(env.q('#q-parallel option[value=""]').textContent, 'Padrão das Preferências (1)');
  assert.deepEqual(plain(select.children.map((o) => o.value)), ['', '1', '2', '3', '4']);
  env.calls.length = 0;
  select.value = '3';
  select.dispatch('change');
  await idle();
  assert.deepEqual(env.calls.filter(([c]) => c === 'queue:setSettings'), [['queue:setSettings', { parallel: 3 }]]);
  assert.equal(select.value, '3');
  select.value = '';
  select.dispatch('change');
  await idle();
  assert.deepEqual(env.calls.filter(([c]) => c === 'queue:setSettings').pop(), ['queue:setSettings', { parallel: null }], 'voltar ao padrão grava null');
});

test('os Ajustes recolhidos ficam só com o que não está na barra: tentativas, recuperação e arquivo repetido', async () => {
  const env = load({ jobs: [] });
  await idle();
  const details = env.q('details.q-settings');
  assert.equal(details.open, false, 'Ajustes recolhidos');
  assert.deepEqual(plain(details.querySelectorAll('select').map((s) => s.id)), ['q-retries', 'q-recovery', 'q-conflict', 'q-priority', 'q-threads', 'q-minram']);
  assert.deepEqual(plain(details.querySelectorAll('select').map((s) => s.value)), ['2', 'ask', 'ask', 'low', '0', '1024']);
});

test('limites de processamento: prioridade, núcleos e memória mínima gravam pelo queue:setSettings; um valor fora da lista ganha a sua opção', async () => {
  const env = load({ jobs: [] });
  await idle();
  const priority = env.q('#q-priority');
  priority.value = 'normal';
  priority.dispatch('change');
  const threads = env.q('#q-threads');
  threads.value = '4';
  threads.dispatch('change');
  const minRam = env.q('#q-minram');
  minRam.value = '2048';
  minRam.dispatch('change');
  await idle();
  const sent = env.calls.filter(([c]) => c === 'queue:setSettings').map(([, p]) => p);
  assert.deepEqual(plain(sent.slice(-3)), [{ lowPriority: false }, { encodeThreads: 4 }, { minFreeMemoryMb: 2048 }]);
});

test('resourcesText: CPU, memória, placa e o disco mais cheio, na ordem; sem dados vira texto vazio; gbText usa vírgula', () => {
  const q = load({ jobs: [] }).queue;
  assert.equal(q.gbText(6144), '6,0 GB');
  assert.equal(q.gbText(1536), '1,5 GB');
  assert.equal(q.resourcesText(null), '');
  assert.equal(q.resourcesText({}), '');
  assert.equal(q.resourcesText({
    cpu: { percent: 42 }, memory: { freeMb: 6144, totalMb: 16384 }, gpu: { utilPercent: 23, memUsedMb: 1536, memTotalMb: 4096 },
    disks: [{ dir: 'D:/a', freeMb: 122880 }, { dir: 'C:/b', freeMb: 20480 }, { dir: 'X:/c', freeMb: null }]
  }), 'CPU 42% · Memória livre 6,0 GB de 16,0 GB · Placa 23% (1,5 GB de 4,0 GB) · Disco: 20,0 GB livres');
  assert.equal(q.resourcesText({ cpu: { percent: null }, memory: { freeMb: 1024, totalMb: 2048 }, gpu: null, disks: [] }), 'Memória livre 1,0 GB de 2,0 GB');
});

test('exportação esperando por memória: aviso claro (com os dois valores) e some quando a fila libera', async () => {
  const env = load({ jobs: [job('a', 'running'), job('b', 'queued')] });
  await idle();
  env.push([job('a', 'running'), job('b', 'queued')], { throttled: { reason: 'memory', freeMb: 512, minMb: 1024 } });
  await idle();
  assert.match(env.q('.q-notices').textContent, /esperando: só há 0,5 GB de memória livre e o mínimo dos Ajustes é 1,0 GB/);
  env.push([job('a', 'running'), job('b', 'running')], { throttled: null });
  await idle();
  assert.doesNotMatch(env.q('.q-notices').textContent, /memória livre/);
});

test('a tela é só texto e componentes do app: sem HTML montado como texto, sem estilo inline e com os textos do desenho', () => {
  const code = CODE.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.doesNotMatch(code, /setAttribute\(\s*['"]style|\sstyle:\s*['"{]/);
  assert.match(code, /Acompanhe o progresso dos seus cortes e exportações\./);
  for (const label of ['Fila', 'Concluídos', 'Falhas', 'Perfil de exportação', 'Destino', 'Limite de fila']) assert.ok(code.includes(`'${label}'`), `o texto "${label}" da tela`);
});

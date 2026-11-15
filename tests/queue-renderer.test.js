'use strict';

/**
 * Tela Exportações (aba `queue`, renderer/features/queue.js) sem abrir o Electron: o script roda num contexto `vm` com um BF falso
 * (só o que o contrato 1.3 oferece) para conferir o registro da aba, os canais usados, a divisão dos trabalhos nas três pílulas e a
 * lógica de anotar exportações concluídas no projeto. O DOM da tela (pílulas, listas, barra de saída) é conferido em
 * tests/queue-ui.test.js; o desenho real (arrastar, diálogo, CSS) em tests/e2e/queue.e2e.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
/** Objetos criados dentro do vm têm outro Object.prototype: compara só os dados. */
const plain = (value) => JSON.parse(JSON.stringify(value));
const FEATURE = path.join(ROOT, 'renderer', 'features', 'queue.js');
const code = fs.readFileSync(FEATURE, 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'renderer', 'features', 'queue.css'), 'utf8');

/** Carrega a feature com um BF falso; devolve o que ela registrou e fez. */
function load({ project = null, listResponse = { ok: true, jobs: [], running: 0, paused: false, active: 0, recovery: { pending: false, jobs: [] }, settings: null } } = {}) {
  const calls = [];
  const emitted = [];
  const updates = [];
  const listeners = {};
  const busListeners = {};
  const saved = [];
  let tab = null;
  const BF = {
    util: { el: () => ({}), nameOf: (p) => String(p).split(/[\\/]/).pop() },
    state: { project, tools: {} },
    ui: { registerTab: (def) => { tab = def; }, refreshTabs() {}, log() {}, toast() {}, confirm: async () => true },
    on: (channel, cb) => { listeners[channel] = cb; return () => {}; },
    bus: { on: (event, cb) => { busListeners[event] = cb; return () => {}; }, emit: (event, data) => emitted.push([event, data]) },
    api: async (channel, payload) => { calls.push([channel, payload]); return channel === 'queue:list' ? listResponse : { ok: true }; },
    project: {
      cut: (id) => (BF.state.project ? BF.state.project.cuts.find((c) => c.id === id) || null : null),
      update(fn, opts) { updates.push(opts); fn(BF.state.project); saved.push(JSON.parse(JSON.stringify(BF.state.project))); }
    },
    prefs: { get: (key, fallback) => fallback },
    ready: Promise.resolve()
  };
  const context = { window: { BF }, document: { getElementById: () => null, activeElement: null }, setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout, console, Date };
  vm.runInNewContext(code, context, { filename: 'queue.js' });
  return { BF, tab, calls, emitted, updates, listeners, busListeners, saved, queue: BF.queue };
}

const mkProject = (extra = {}) => ({
  id: 'p1', source: { path: 'D:\\Lives\\live.mp4' },
  cuts: [{ id: 'c1', title: 'A', start: 10, end: 40, exports: [] }, { id: 'c2', title: 'B', start: 60, end: 90, exports: [] }],
  ...extra
});
const mkJob = (extra = {}) => ({
  id: 'j1', key: 'k1', state: 'done', projectId: 'p1', sourcePath: 'D:\\Lives\\live.mp4', output: 'D:\\Lives\\Cortes\\live - corte 01 - A.mp4', finishedAt: '2026-10-21T10:00:00.000Z',
  cut: { id: 'c1', title: 'A', start: 10, end: 40, revision: 3 }, profile: { id: 'vertical-1080-h264', width: 1080, height: 1920 }, ...extra
});

// ------------------------------------------------------------------ registro

test('registra a aba "queue" (ordem 30), com o título "Exportações" e o selo da contagem de ativos', () => {
  const { tab, queue } = load();
  assert.equal(tab.id, 'queue');
  assert.equal(tab.title, 'Exportações');
  assert.equal(tab.order, 30);
  assert.equal(typeof tab.render, 'function');
  assert.equal(typeof tab.onShow, 'function');
  assert.equal(tab.badge(), '', 'sem ativos não mostra selo');
  queue.state.active = 3;
  assert.equal(tab.badge(), 3);
});

test('escuta os cinco eventos da fila e usa só canais que o handler registra', () => {
  const { listeners } = load();
  assert.deepEqual(Object.keys(listeners).sort(), ['queue:conflict', 'queue:jobDone', 'queue:progress', 'queue:recovery', 'queue:update']);

  const handler = fs.readFileSync(path.join(ROOT, 'src', 'ipc', 'handlers', 'queue.js'), 'utf8');
  const registered = new Set([...handler.matchAll(/ctx\.handle\('(queue:[a-zA-Z]+)'/g)].map((m) => m[1]));
  const used = new Set([...code.matchAll(/(?:BF\.api|act)\(\s*'(queue:[a-zA-Z]+)'/g)].map((m) => m[1]));
  const events = new Set(['queue:update', 'queue:progress', 'queue:jobDone', 'queue:conflict', 'queue:recovery']);
  for (const channel of used) assert.ok(registered.has(channel) || events.has(channel), `canal ${channel} sem handler`);
  for (const channel of ['queue:list', 'queue:pause', 'queue:resume', 'queue:recover', 'queue:cancel', 'queue:reorder', 'queue:remove', 'queue:retry', 'queue:clearFinished', 'queue:setSettings', 'queue:resolveConflict']) {
    assert.ok(used.has(channel), `a tela usa ${channel}`);
  }
});

test('segue as regras do projeto: sem confirm nativo, HTML inline ou estilo inline; modais pelo BF.ui', () => {
  assert.doesNotMatch(code, /window\.confirm|\balert\(|\bconfirm\(\s*['"`]/, 'sem window.confirm');
  assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|outerHTML/, 'nada de HTML montado como texto');
  assert.doesNotMatch(code, /setAttribute\(\s*['"]style|\sstyle:\s*['"{]/, 'sem style inline (a CSP bloqueia)');
  assert.match(code, /BF\.ui\.confirm/);
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/);
  assert.match(code, /Ajustes/);
  assert.match(code, /<details|'details'/);
});

// ------------------------------------------------------------------ sem projeto

test('sem projeto aberto nada quebra: jobDone e reconciliação são ignorados', async () => {
  const { listeners, queue, emitted, updates } = load({ project: null });
  assert.equal(queue.applyDone(mkJob(), mkJob().output), false);
  assert.doesNotThrow(() => listeners['queue:jobDone']({ job: mkJob(), output: mkJob().output }));
  assert.equal(queue.reconcile([mkJob()]), 0);
  assert.deepEqual(plain(emitted), []);
  assert.deepEqual(plain(updates), []);
});

// ------------------------------------------------------------------ anotar exportações

test('queue:jobDone anota o arquivo em cut.exports (via BF.project.update) e avisa cuts:changed', () => {
  const project = mkProject();
  const { listeners, saved, emitted, updates } = load({ project });
  listeners['queue:jobDone']({ job: mkJob(), output: mkJob().output });
  const entry = project.cuts[0].exports[0];
  assert.deepEqual([entry.path, entry.start, entry.end, entry.jobId, entry.key, entry.revision], [mkJob().output, 10, 40, 'j1', 'k1', 3]);
  assert.deepEqual(plain(entry.profile), { id: 'vertical-1080-h264', width: 1080, height: 1920 });
  assert.equal(entry.at, '2026-10-21T10:00:00.000Z');
  assert.deepEqual(plain(project.cuts[1].exports), [], 'o outro corte não muda');
  assert.deepEqual(plain(updates), [{ reason: 'queue:done' }]);
  assert.equal(saved.length, 1);
  assert.deepEqual(plain(emitted), [['cuts:changed', { ids: ['c1'], from: 'queue:done' }]]);
});

test('anotar é idempotente (mesmo arquivo ou mesmo trabalho não entra duas vezes)', () => {
  const project = mkProject();
  const { queue, updates } = load({ project });
  assert.equal(queue.applyDone(mkJob(), mkJob().output), true);
  assert.equal(queue.applyDone(mkJob(), mkJob().output), false, 'mesmo trabalho');
  assert.equal(queue.applyDone(mkJob({ id: 'outro-id' }), mkJob().output), false, 'mesmo arquivo');
  assert.equal(queue.applyDone(mkJob({ id: 'j2', key: 'k2' }), 'D:\\Lives\\Cortes\\live - corte 01 - A (2).mp4'), true, 'outro arquivo do mesmo corte entra');
  assert.equal(project.cuts[0].exports.length, 2);
  assert.equal(updates.length, 2);
});

test('"Substituir": o trabalho mais novo que gravou o MESMO arquivo atualiza a anotação (o arquivo agora é o dele); um mais antigo não mexe', () => {
  // regressão do teste de sistema: o 1080p foi trocado pelo 1440p H.265 de mesmo nome e a anotação seguia dizendo 1080p
  const project = mkProject();
  const { queue, updates, emitted } = load({ project });
  assert.equal(queue.applyDone(mkJob(), mkJob().output), true);
  const newer = mkJob({ id: 'j2', key: 'k2', finishedAt: '2026-10-21T10:05:00.000Z', profile: { id: 'vertical-1440-h265', width: 1440, height: 2560 } });
  assert.equal(queue.applyDone(newer, newer.output), true, 'o trabalho novo gravou o mesmo arquivo');
  assert.equal(project.cuts[0].exports.length, 1, 'um arquivo, uma anotação');
  const note = project.cuts[0].exports[0];
  assert.deepEqual([note.jobId, note.key, note.at], ['j2', 'k2', '2026-10-21T10:05:00.000Z']);
  assert.deepEqual(plain(note.profile), { id: 'vertical-1440-h265', width: 1440, height: 2560 });
  assert.equal(updates.length, 2);
  assert.deepEqual(plain(emitted.at(-1)), ['cuts:changed', { ids: ['c1'], from: 'queue:done' }]);
  // a reconciliação revê todos os concluídos (o antigo e o novo) a cada abertura: não pode trocar a anotação de lá para cá
  assert.equal(queue.applyDone(mkJob(), mkJob().output), false, 'o trabalho antigo não desfaz o novo');
  assert.equal(queue.applyDone(newer, newer.output), false, 'o mesmo trabalho de novo não faz nada');
  assert.equal(queue.reconcile([mkJob(), newer]), 0);
  assert.equal(updates.length, 2, 'nenhuma gravação a mais');
  assert.equal(project.cuts[0].exports[0].jobId, 'j2');
});

test('só anota no projeto certo e no corte que ainda existe', () => {
  const project = mkProject();
  const { queue } = load({ project });
  assert.equal(queue.applyDone(mkJob({ projectId: 'outro' }), 'x.mp4'), false, 'projeto diferente');
  assert.equal(queue.applyDone(mkJob({ cut: { id: 'removido', start: 1, end: 2 } }), 'y.mp4'), false, 'corte removido do projeto');
  assert.equal(queue.applyDone(mkJob(), ''), false, 'sem arquivo');
  assert.equal(queue.applyDone(null, 'z.mp4'), false);
  assert.deepEqual(plain(project.cuts.map((c) => c.exports)), [[], []]);
  // sem projectId no trabalho, vale o caminho do vídeo (sem diferenciar maiúsculas/barras)
  assert.equal(queue.applyDone(mkJob({ projectId: '', sourcePath: 'd:/lives/LIVE.mp4' }), 'w.mp4'), true);
});

test('ao carregar o projeto confere queue:list e anota o que terminou com a janela fechada', async () => {
  const project = mkProject();
  const jobs = [
    mkJob(),
    mkJob({ id: 'j2', key: 'k2', cut: { id: 'c2', title: 'B', start: 60, end: 90, revision: 1 }, output: 'D:\\Lives\\Cortes\\live - corte 02 - B.mp4' }),
    mkJob({ id: 'j3', state: 'failed', output: null }),
    mkJob({ id: 'j4', state: 'queued', output: null }),
    mkJob({ id: 'j5', projectId: 'outro-projeto', output: 'D:\\Outro\\x.mp4' })
  ];
  const { busListeners, calls } = load({ project, listResponse: { ok: true, jobs, running: 0, paused: false, active: 1, recovery: { pending: false, jobs: [] }, settings: { retries: 2, defaultParallel: 1 } } });
  await busListeners['project:loaded']({ project });
  assert.ok(calls.some(([channel]) => channel === 'queue:list'));
  assert.deepEqual(plain(project.cuts.map((c) => c.exports.map((e) => e.jobId))), [['j1'], ['j2']]);
  await busListeners['project:loaded']({ project }); // abrir de novo não duplica
  assert.deepEqual(plain(project.cuts.map((c) => c.exports.length)), [1, 1]);
});

test('o paralelismo padrão das Preferências é enviado à fila quando difere do que ela tem', async () => {
  const project = mkProject();
  const { BF, busListeners, calls } = load({ project, listResponse: { ok: true, jobs: [], running: 0, paused: false, active: 0, recovery: { pending: false, jobs: [] }, settings: { retries: 2, defaultParallel: 1, parallel: null } } });
  BF.prefs.get = (key, fallback) => (key === 'queue.parallel' ? 3 : fallback);
  await busListeners['project:loaded']({ project });
  await new Promise((r) => setImmediate(r));
  assert.ok(calls.some(([channel, payload]) => channel === 'queue:setSettings' && payload.defaultParallel === 3));
});

// ------------------------------------------------------------------ funções puras

test('fmtEta e clock', () => {
  const { queue } = load();
  assert.equal(queue.fmtEta(0.4), '~1 s');
  assert.equal(queue.fmtEta(45), '~45 s');
  assert.equal(queue.fmtEta(60), '~1 min');
  assert.equal(queue.fmtEta(125), '~2 min 05 s');
  assert.equal(queue.fmtEta(3725), '~1 h 02 min');
  assert.equal(queue.fmtEta(null), '');
  assert.equal(queue.fmtEta(NaN), '');
  assert.equal(queue.clock(75.4), '1:15');
  assert.equal(queue.clock(5), '0:05');
});

test('ordem de exibição da Fila: executando primeiro e o resto na ordem da fila', () => {
  const { queue } = load();
  const j = (id, state, finishedAt) => ({ id, state, finishedAt });
  const active = queue.activeOrder([j('q1', 'queued'), j('r1', 'running'), j('n1', 'needsAction'), j('r2', 'running'), j('d1', 'done'), j('i1', 'interrupted')]);
  assert.deepEqual(plain(active.map((x) => x.id)), ['r1', 'r2', 'q1', 'n1', 'i1']);
});

test('as três pílulas: Fila (esperando ou exportando), Concluídos (concluído, pulado e cancelado) e Falhas, cada uma na sua ordem', () => {
  const { queue } = load();
  const j = (id, state, finishedAt) => ({ id, state, finishedAt });
  const jobs = [
    j('q1', 'queued'), j('r1', 'running'), j('n1', 'needsAction'), j('r2', 'running'), j('i1', 'interrupted'),
    j('a', 'done', '2026-10-21T10:00:00Z'), j('b', 'cancelled', '2026-10-21T12:00:00Z'), j('d', 'skipped', '2026-10-21T11:00:00Z'),
    j('c', 'failed', '2026-10-21T09:00:00Z'), j('f', 'failed', '2026-10-21T13:00:00Z')
  ];
  const groups = queue.groupJobs(jobs);
  assert.deepEqual(plain(groups.queue.map((x) => x.id)), ['r1', 'r2', 'q1', 'n1', 'i1'], 'a Fila mantém a ordem do main, com o que está exportando primeiro');
  assert.deepEqual(plain(groups.done.map((x) => x.id)), ['b', 'd', 'a'], 'Concluídos: do mais recente para o mais antigo');
  assert.deepEqual(plain(groups.failed.map((x) => x.id)), ['f', 'c'], 'Falhas: a mais recente primeiro');
  assert.equal(groups.queue.length + groups.done.length + groups.failed.length, jobs.length, 'todo trabalho cai em alguma pílula');
  assert.deepEqual(plain(jobs.map((x) => x.id)).slice(0, 5), ['q1', 'r1', 'n1', 'r2', 'i1'], 'a lista original não é reordenada');
  for (const [state, group] of Object.entries({ queued: 'queue', running: 'queue', needsAction: 'queue', interrupted: 'queue', done: 'done', skipped: 'done', cancelled: 'done', failed: 'failed', inventado: null })) {
    assert.equal(queue.groupOf({ state }), group, `o estado ${state} cai em ${group}`);
  }
});

// ------------------------------------------------------------------ reordenar pelos botões ↑/↓

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(cond, what, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (cond()) return; await sleep(5); }
  throw new Error(`tempo esgotado esperando ${what}`);
}

/**
 * "Main" simulado: guarda a ordem, aplica `queue:reorder` na ordem em que o pedido CHEGA (com o atraso escolhido para
 * cada chamada) e emite `queue:update` ~40 ms depois, com o retrato do momento da emissão (como o QueueManager faz).
 */
function fakeMain(listeners, BF, delays) {
  let order = ['A', 'B', 'C', 'D', 'E'];
  let timer = null;
  const snapshot = () => ({
    ok: true, running: 0, paused: true, parallel: 1, active: order.length, blocked: null, recovery: { pending: false, jobs: [] },
    loadWarning: null, saveError: null, settings: { parallel: null, retries: 2, recovery: 'ask', onConflict: 'ask', defaultParallel: 1, effectiveParallel: 1 },
    jobs: order.map((id) => ({ id, state: 'queued', baseName: id, sourcePath: 'D:\\Lives\\live.mp4', cut: { id, title: id, start: 0, end: 5 }, profile: {} }))
  });
  const emitSoon = () => { if (!timer) timer = setTimeout(() => { timer = null; listeners['queue:update'](snapshot()); }, 40); };
  const received = [];
  BF.api = async (channel, payload) => {
    if (channel === 'queue:list') return snapshot();
    if (channel === 'queue:reorder') {
      received.push(payload.ids);
      await sleep(delays.shift() ?? 0);
      order = [...payload.ids, ...order.filter((id) => !payload.ids.includes(id))];
      emitSoon();
      return { ok: true, order };
    }
    return { ok: true, settings: snapshot().settings };
  };
  return { snapshot, received, get order() { return order; }, stop: () => clearTimeout(timer) };
}

test('reordenar rápido com ↑/↓: um queue:update atrasado não desfaz a ordem mostrada e nenhum movimento se perde', async () => {
  const { BF, listeners, queue } = load();
  const delays = [];
  const main = fakeMain(listeners, BF, delays);
  try {
    listeners['queue:update'](main.snapshot());
    const ids = () => queue.state.jobs.map((j) => j.id).join('');
    const job = (id) => queue.state.jobs.find((j) => j.id === id);
    assert.equal(ids(), 'ABCDE');

    delays.push(0, 150, 0); // o segundo pedido demora no caminho (máquina carregada)
    const first = queue.move(job('E'), -1);
    assert.equal(ids(), 'ABCED', 'a tela mostra o movimento na hora');
    await sleep(15);
    const second = queue.move(job('E'), -1);
    assert.equal(ids(), 'ABECD');
    await sleep(100); // o queue:update do primeiro pedido (emitido enquanto o segundo ainda não chegou ao main) já chegou aqui
    assert.equal(ids(), 'ABECD', 'o retrato antigo não faz a tela voltar atrás');
    const third = queue.move(job('A'), +1);
    assert.equal(ids(), 'BAECD', 'o terceiro movimento parte da ordem que o usuário está vendo');
    await Promise.all([first, second, third]);

    await until(() => main.order.join('') === 'BAECD' && ids() === 'BAECD', 'main e tela chegarem à ordem final');
    assert.equal(main.received.length, 3);
    assert.deepEqual(main.received.map((r) => r.join('')), ['ABCED', 'ABECD', 'BAECD'], 'cada pedido leva a ordem completa que o usuário via ao clicar');
    await sleep(120); // nenhum update tardio muda a ordem depois
    assert.equal(ids(), 'BAECD');
    assert.equal(main.order.join(''), 'BAECD');
  } finally { main.stop(); }
});

test('reordenar: os pedidos seguem um por vez, na ordem dos cliques (o main nunca recebe o seguinte antes de responder ao anterior)', async () => {
  const { BF, listeners, queue } = load();
  const delays = [];
  const main = fakeMain(listeners, BF, delays);
  try {
    listeners['queue:update'](main.snapshot());
    const job = (id) => queue.state.jobs.find((j) => j.id === id);
    delays.push(80, 0, 0);
    const all = [queue.move(job('B'), +1), queue.move(job('B'), +1), queue.move(job('A'), +1)];
    await sleep(30);
    assert.equal(main.received.length, 1, 'só o primeiro pedido saiu enquanto ele não foi respondido');
    await Promise.all(all);
    // B desce duas vezes (A C B D E, depois A C D B E) e A desce uma (C A D B E)
    await until(() => main.order.join('') === 'CADBE', 'a ordem final chegar ao main');
    assert.equal(main.received.length, 3);
    assert.deepEqual(main.received.map((r) => r.join('')), ['ACBDE', 'ACDBE', 'CADBE']);
  } finally { main.stop(); }
});

test('reordenar: se um pedido falha, a tela volta ao que o main tem (queue:list) em vez de ficar com a ordem otimista', async () => {
  const { BF, listeners, queue } = load();
  const main = fakeMain(listeners, BF, []);
  try {
    const okApi = BF.api;
    BF.api = async (channel, payload) => (channel === 'queue:reorder' ? { ok: false, code: 'INVALID_ARGS', message: 'x' } : okApi(channel, payload));
    listeners['queue:update'](main.snapshot());
    await queue.move(queue.state.jobs.find((j) => j.id === 'E'), -1);
    await until(() => queue.state.jobs.map((j) => j.id).join('') === 'ABCDE', 'voltar à ordem do main');
  } finally { main.stop(); }
});

// ------------------------------------------------------------------ textos sem jargão

test('os textos da aba não têm jargão técnico (nome do programa de vídeo, PATH, variáveis de ambiente, .part)', () => {
  const visible = code.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.replace(/(^|\s)\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(visible, /ffmpeg/i);
  assert.doesNotMatch(visible, /\bPATH\b|CORTE_|\.part\b/); // em maiúsculas: "path" é só o nome de um campo do código
  assert.doesNotMatch(visible, /não é suspenso|não é retomado/);
  assert.match(visible, /recomeça do início/, 'a frase útil continua: a exportação recomeça do início');
});

test('o botão de pausa diz que é da fila (não congela o que já está exportando)', () => {
  assert.match(code, /'Pausar fila'/);
  assert.match(code, /o que já está exportando vai até o fim/);
});

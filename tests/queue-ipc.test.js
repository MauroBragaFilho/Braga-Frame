'use strict';

/**
 * Canais queue:* (src/ipc/handlers/queue.js) com um ctx de verdade (createContext) e Electron falso.
 * O motor de exportação é o executor falso controlável (queue-helpers); a fila, o disco e os eventos são reais.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createContext } = require('../src/ipc/context');
const { loadHandlers } = require('../src/ipc');
const { register, testRunnerFromEnv, TEST_RUNNER_VAR } = require('../src/ipc/handlers/queue');
const h = require('./queue-helpers');

const { waitUntil, makeJob, makeFakeRunner, exportError } = h;
const silent = { log() {}, info() {}, warn() {}, error() {} };

const CHANNELS = [
  'queue:enqueue', 'queue:list', 'queue:pause', 'queue:resume', 'queue:recover', 'queue:cancel', 'queue:reorder', 'queue:remove',
  'queue:retry', 'queue:clearFinished', 'queue:getSettings', 'queue:setSettings', 'queue:resolveConflict'
];

/** ctx com Electron falso; `app.on` guarda os ouvintes para disparar 'before-quit' à mão. */
function setup(base, { overrides = {}, appExtra = {}, userData } = {}) {
  const handlers = new Map();
  const sent = [];
  const quitListeners = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, structuredClone(payload)]) } }; // structuredClone = o que o IPC exige
  const deps = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: () => userData || path.join(base, 'userdata'), getVersion: () => '9.9.9', on: (ev, fn) => { if (ev === 'before-quit') quitListeners.push(fn); }, ...appExtra },
    dialog: {}, shell: {},
    getWindow: () => win,
    logger: silent,
    resolveTools: () => ({ ffmpeg: 'ffmpeg-de-teste', ffprobe: 'ffprobe-de-teste' })
  };
  const ctx = createContext(deps);
  const manager = register(ctx, { backoffMs: 20, abortGraceMs: 300, progressIntervalMs: 0, updateIntervalMs: 3, preflight: false, ...overrides });
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  const events = (channel) => sent.filter(([c]) => c === channel).map(([, p]) => p);
  return { ctx, manager, call, sent, events, handlers, quit: () => quitListeners.forEach((fn) => fn()), userData: ctx.paths.userData };
}

function withEnv(fn) {
  return async () => {
    const base = h.tmpDir('queue-ipc');
    const opened = [];
    const mk = (...args) => { const s = setup(base, ...args); opened.push(s); return s; };
    try { await fn(base, mk); } finally {
      for (const s of opened) s.manager.shutdown();
      await h.sleep(20);
      h.removeDir(base);
    }
  };
}

test('registra os canais do contrato 3.4 (mais queue:recover) e carrega junto dos demais handlers', withEnv(async (base, mk) => {
  const s = mk({ overrides: { runner: makeFakeRunner().runner } });
  for (const channel of CHANNELS) assert.ok(s.handlers.has(channel), channel);
  assert.equal(s.handlers.size, CHANNELS.length, 'nenhum canal fora da lista');

  // pelo carregador real de handlers (sem sobrescritas): carrega sem erro
  const base2 = h.tmpDir('queue-ipc2');
  try {
    const handlers = new Map();
    const ctx = createContext({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, app: { getPath: () => base2, getVersion: () => '1' }, dialog: {}, shell: {}, logger: silent, resolveTools: () => ({}) });
    const res = loadHandlers(ctx);
    assert.deepEqual(res.failed, []);
    assert.ok(res.loaded.includes('queue.js'));
    for (const channel of CHANNELS) assert.ok(handlers.has(channel), `loadHandlers: ${channel}`);
  } finally { await h.sleep(20); h.removeDir(base2); }
}));

test('enqueue -> list -> progresso -> jobDone, com os eventos no renderer e no ctx.bus', withEnv(async (base, mk) => {
  const fake = makeFakeRunner();
  const s = mk({ overrides: { runner: fake.runner } });
  const bus = [];
  for (const ev of ['queue:update', 'queue:progress', 'queue:jobDone']) s.ctx.bus.on(ev, (p) => bus.push([ev, p]));

  const empty = await s.call('queue:list');
  assert.deepEqual([empty.ok, empty.jobs, empty.running, empty.paused, empty.recovery.pending], [true, [], 0, false, false]);
  assert.equal(fs.existsSync(path.join(s.userData, 'queue.json')), false, 'fila vazia não grava nada');

  const res = await s.call('queue:enqueue', { jobs: [makeJob(base, 0), makeJob(base, 1)] });
  assert.equal(res.ok, true);
  assert.equal(res.jobs.length, 2);
  assert.deepEqual(res.jobs.map((j) => j.cut.id), ['cut-0', 'cut-1']);
  assert.deepEqual(res.ids, res.jobs.map((j) => j.id), 'ids na mesma ordem dos jobs enviados');

  await waitUntil(() => fake.calls.length === 1);
  fake.calls[0].progress(0.5);
  await waitUntil(() => s.events('queue:progress').length > 0);
  assert.deepEqual([s.events('queue:progress')[0].id, s.events('queue:progress')[0].p], [res.jobs[0].id, 0.5]);

  fake.calls[0].finish();
  await waitUntil(() => s.events('queue:jobDone').length === 1);
  const done = s.events('queue:jobDone')[0];
  assert.equal(done.output, fake.calls[0].outputPath);
  assert.equal(done.job.id, res.jobs[0].id);
  assert.equal(done.job.projectId, 'p1');
  assert.equal(done.job.state, 'done');
  assert.equal(done.job.cut.start, 10);
  assert.ok(fs.existsSync(done.output));

  await waitUntil(() => fake.calls.length === 2);
  const list = await s.call('queue:list');
  assert.deepEqual(list.jobs.map((j) => j.state), ['done', 'running']);
  assert.equal(list.running, 1);
  assert.equal(list.active, 1);
  const lastUpdate = s.events('queue:update').at(-1);
  assert.deepEqual(Object.keys(lastUpdate).filter((k) => ['jobs', 'running', 'paused'].includes(k)).sort(), ['jobs', 'paused', 'running']);
  assert.ok(bus.some(([ev]) => ev === 'queue:jobDone') && bus.some(([ev]) => ev === 'queue:update'), 'o mesmo evento chega ao ctx.bus');
  fake.calls[1].finish();
}));

test('pausar, retomar, cancelar, reordenar, remover, tentar de novo e limpar pelos canais', withEnv(async (base, mk) => {
  const fake = makeFakeRunner();
  const s = mk({ overrides: { runner: fake.runner } });
  assert.deepEqual(await s.call('queue:pause'), { ok: true, paused: true, interrupting: 0, running: 0 });
  const { jobs } = await s.call('queue:enqueue', { jobs: [makeJob(base, 0), makeJob(base, 1), makeJob(base, 2)] });
  await h.sleep(40);
  assert.equal(fake.calls.length, 0);

  const re = await s.call('queue:reorder', { ids: [jobs[2].id, jobs[0].id, jobs[1].id] });
  assert.deepEqual(re.order, [jobs[2].id, jobs[0].id, jobs[1].id]);
  assert.equal((await s.call('queue:cancel', { id: jobs[1].id })).cancelled, 1);
  assert.equal((await s.call('queue:resume')).paused, false);
  await waitUntil(() => fake.calls.length === 1);
  assert.equal(fake.calls[0].job.id, jobs[2].id, 'a reordenação valeu');

  assert.deepEqual(await s.call('queue:cancel', { id: jobs[2].id }), { ok: true, cancelled: 0, stopping: 1 });
  await waitUntil(() => fake.calls.length === 2);
  const res = await s.call('queue:cancel', { all: true });
  assert.equal(res.ok, true);
  await waitUntil(() => s.manager.jobs.every((j) => j.state === 'cancelled'));

  const retried = await s.call('queue:retry', { id: jobs[0].id });
  assert.equal(retried.ok, true);
  await waitUntil(() => fake.calls.length === 3);
  fake.calls[2].finish();
  await waitUntil(() => s.manager.jobs.find((j) => j.id === jobs[0].id).state === 'done');
  assert.equal((await s.call('queue:remove', { id: jobs[0].id })).removed, true);
  assert.equal((await s.call('queue:clearFinished')).removed, 2);
  assert.deepEqual((await s.call('queue:list')).jobs, []);
}));

test('erros voltam como { ok:false, code, message } em português, com a causa', withEnv(async (base, mk) => {
  const s = mk({ overrides: { runner: makeFakeRunner().runner } });
  const cases = [
    [['queue:enqueue', {}], 'INVALID_JOB', /Informe os trabalhos/],
    [['queue:enqueue', { jobs: [{ cut: {} }] }], 'INVALID_JOB', /Trabalho inválido na posição 1/],
    [['queue:cancel', { id: 'nao-existe' }], 'JOB_NOT_FOUND', /não está mais na fila/],
    [['queue:cancel', {}], 'INVALID_ARGS', /Informe qual trabalho/],
    [['queue:remove', { id: 'nao-existe' }], 'JOB_NOT_FOUND', /não está mais/],
    [['queue:retry', { id: 'nao-existe' }], 'JOB_NOT_FOUND', /não está mais/],
    [['queue:reorder', { ids: 'x' }], 'INVALID_ARGS', /lista de ids/],
    [['queue:resolveConflict', { id: 'nao-existe', action: 'rename' }], 'JOB_NOT_FOUND', /não está mais/],
    [['queue:recover', { action: 'talvez' }], 'INVALID_ACTION', /resume.*discard/],
    [['queue:setSettings', { parallel: 9 }], 'INVALID_SETTINGS', /de 1 a 4/],
    [['queue:setSettings', { retries: 10 }], 'INVALID_SETTINGS', /de 0 a 5/],
    [['queue:setSettings', { onConflict: 'replace' }], 'INVALID_SETTINGS', /arquivo por arquivo/]
  ];
  for (const [[channel, payload], code, message] of cases) {
    const res = await s.call(channel, payload);
    assert.equal(res.ok, false, channel);
    assert.equal(res.code, code, channel);
    assert.match(res.message, message, channel);
  }
  const { jobs } = await s.call('queue:enqueue', { jobs: [makeJob(base, 0)] });
  await waitUntil(() => s.manager.jobs[0].state === 'running');
  assert.equal((await s.call('queue:remove', { id: jobs[0].id })).code, 'JOB_RUNNING');
  assert.equal((await s.call('queue:retry', { id: jobs[0].id })).code, 'NOT_RETRYABLE');
  assert.equal((await s.call('queue:resolveConflict', { id: jobs[0].id, action: 'rename' })).code, 'NOT_WAITING');
}));

test('ajustes: leitura, gravação e validação; o estado fica em userData/queue.json', withEnv(async (base, mk) => {
  const s = mk({ overrides: { runner: makeFakeRunner().runner } });
  const first = await s.call('queue:getSettings');
  assert.deepEqual(first.settings, { parallel: null, retries: 2, recovery: 'ask', onConflict: 'ask', effectiveParallel: 1, defaultParallel: 1 });
  const set = await s.call('queue:setSettings', { parallel: 3, retries: 4, recovery: 'resume', onConflict: 'rename' });
  assert.equal(set.ok, true);
  assert.deepEqual(set.settings, { parallel: 3, retries: 4, recovery: 'resume', onConflict: 'rename', effectiveParallel: 3, defaultParallel: 1 });
  assert.equal((await s.call('queue:setSettings', { parallel: null, defaultParallel: 2 })).settings.effectiveParallel, 2, 'padrão das Preferências');
  await waitUntil(() => fs.existsSync(path.join(s.userData, 'queue.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.userData, 'queue.json'), 'utf8')).settings.retries, 4);
  assert.equal(s.events('queue:update').at(-1) === undefined, false);
  await waitUntil(() => s.events('queue:update').at(-1).settings.effectiveParallel === 2);
}));

test('fechar o app (before-quit) grava, interrompe o que rodava e a próxima abertura pergunta (queue:recovery)', withEnv(async (base, mk) => {
  const fake = makeFakeRunner();
  const userData = path.join(base, 'ud');
  const first = mk({ userData, overrides: { runner: fake.runner } });
  const { jobs } = await first.call('queue:enqueue', { jobs: [makeJob(base, 0), makeJob(base, 1)] });
  await waitUntil(() => fake.calls.length === 1);
  first.quit();
  assert.equal(fake.calls[0].aborted, true, 'o executor foi mandado parar');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'queue.json'), 'utf8')).jobs.map((j) => j.state), ['interrupted', 'queued']);

  const fake2 = makeFakeRunner();
  const second = mk({ userData, overrides: { runner: fake2.runner } });
  const list = await second.call('queue:list');
  assert.deepEqual(list.jobs.map((j) => j.state), ['interrupted', 'queued']);
  assert.equal(list.paused, true);
  assert.deepEqual(list.recovery, { pending: true, jobs: [jobs[0].id] });
  assert.equal(second.events('queue:recovery').length, 1);
  assert.equal(second.events('queue:recovery')[0].jobs[0].id, jobs[0].id);
  await h.sleep(50);
  assert.equal(fake2.calls.length, 0);

  assert.equal((await second.call('queue:resume')).count, 1, 'Retomar com recuperação pendente = recuperar');
  await waitUntil(() => fake2.calls.length === 1);
  assert.equal(fake2.calls[0].job.id, jobs[0].id);
  fake2.calls[0].finish();
}));

test('conflito de nome pelos canais: queue:conflict, resolveConflict e jobDone', withEnv(async (base, mk) => {
  const fake = makeFakeRunner({ autoFinish: 1 });
  const s = mk({ overrides: { runner: fake.runner } });
  const job = makeJob(base, 0);
  fs.mkdirSync(job.outputDir, { recursive: true });
  fs.writeFileSync(path.join(job.outputDir, `${job.baseName}.mp4`), 'do usuário');
  const { jobs } = await s.call('queue:enqueue', { jobs: [job] });
  await waitUntil(() => s.events('queue:conflict').length === 1);
  const ev = s.events('queue:conflict')[0];
  assert.equal(ev.job.id, jobs[0].id);
  assert.equal(ev.job.state, 'needsAction');
  assert.equal(ev.path, path.join(job.outputDir, `${job.baseName}.mp4`));
  assert.equal(fake.calls.length, 0);
  assert.equal((await s.call('queue:resolveConflict', { id: jobs[0].id, action: 'qualquer' })).code, 'INVALID_ACTION');
  assert.equal((await s.call('queue:resolveConflict', { id: jobs[0].id, action: 'rename' })).ok, true);
  await waitUntil(() => s.events('queue:jobDone').length === 1);
  assert.equal(fake.calls[0].job.onConflict, 'rename');
  assert.equal(fs.readFileSync(path.join(job.outputDir, `${job.baseName}.mp4`), 'utf8'), 'do usuário');
}));

test('sem o motor de exportação a fila segura os trabalhos e explica (nada de falha fingida)', withEnv(async (base, mk) => {
  const s = mk({ overrides: { getRunner: () => null } });
  await s.call('queue:enqueue', { jobs: [makeJob(base, 0)] });
  await h.sleep(40);
  const list = await s.call('queue:list');
  assert.deepEqual(list.jobs.map((j) => j.state), ['queued']);
  assert.equal(list.blocked.code, 'RUNNER_UNAVAILABLE');
  await waitUntil(() => s.events('queue:update').at(-1) && s.events('queue:update').at(-1).blocked);
}));

test('o motor real (core/export/jobRunner) é carregado só se existir; um arquivo quebrado vira aviso, não exceção', withEnv(async (base, mk) => {
  const s = mk({ overrides: { getRunner: () => { throw new Error('SyntaxError no jobRunner'); } } });
  await s.call('queue:enqueue', { jobs: [makeJob(base, 0)] });
  await h.sleep(40);
  const list = await s.call('queue:list');
  assert.deepEqual(list.jobs.map((j) => j.state), ['queued']);
  assert.match(list.blocked.message, /SyntaxError no jobRunner/);
}));

test('executor de teste por variável de ambiente: só com NODE_ENV=test e app fora do pacote', () => {
  const dir = h.tmpDir('queue-env');
  try {
    const file = path.join(dir, 'runner.js');
    fs.writeFileSync(file, "exports.runExportJob = async () => ({ output: 'x' });");
    const logs = [];
    const ctxOf = (isPackaged) => ({ app: { isPackaged }, log: (l, m) => logs.push(`${l}: ${m}`) });
    const env = { [TEST_RUNNER_VAR]: file, NODE_ENV: 'test' };

    assert.equal(typeof testRunnerFromEnv(ctxOf(false), env), 'function');
    assert.equal(testRunnerFromEnv(ctxOf(true), env), null, 'empacotado: ignora');
    assert.equal(testRunnerFromEnv(ctxOf(undefined), env), null, 'isPackaged indefinido conta como empacotado');
    assert.equal(testRunnerFromEnv(ctxOf(false), { ...env, NODE_ENV: 'production' }), null);
    assert.equal(testRunnerFromEnv(ctxOf(false), { ...env, NODE_ENV: undefined }), null);
    assert.equal(testRunnerFromEnv(ctxOf(false), { ...env, [TEST_RUNNER_VAR]: 'relativo.js' }), null, 'só caminho absoluto');
    assert.equal(testRunnerFromEnv(ctxOf(false), { ...env, [TEST_RUNNER_VAR]: path.join(dir, 'nao-existe.js') }), null);
    assert.equal(testRunnerFromEnv(ctxOf(false), {}), null);
    assert.ok(logs.some((l) => /ignorada/.test(l)));
  } finally { h.removeDir(dir); }
});

test('os payloads dos eventos atravessam o IPC (clonáveis) mesmo com cortes grandes', withEnv(async (base, mk) => {
  const fake = makeFakeRunner({ autoFinish: 1 });
  const s = mk({ overrides: { runner: fake.runner } }); // o win falso já usa structuredClone: se falhar, o teste quebra
  const job = makeJob(base, 0);
  job.cut.subtitles = { enabled: true, mode: 'burn', cues: Array.from({ length: 300 }, (_, i) => ({ start: i, end: i + 1, text: `fala ${i}` })) };
  await s.call('queue:enqueue', { jobs: [job] });
  await waitUntil(() => s.events('queue:jobDone').length === 1);
  const done = s.events('queue:jobDone')[0];
  assert.equal(done.job.cut.subtitles, undefined, 'o resumo do corte não carrega as legendas');
  assert.equal(fake.calls[0].job.cut.subtitles.cues.length, 300, 'mas o executor recebe o corte completo');
}));

test('falha do executor chega ao renderer com causa e solução', withEnv(async (base, mk) => {
  const fake = makeFakeRunner();
  const s = mk({ overrides: { runner: fake.runner } });
  await s.call('queue:enqueue', { jobs: [makeJob(base, 0)] });
  await waitUntil(() => fake.calls.length === 1);
  fake.calls[0].fail(exportError('NO_DISK_SPACE', 'Faltam 4 GB em D:.'));
  await waitUntil(() => s.events('queue:update').some((u) => u.jobs[0] && u.jobs[0].state === 'failed'));
  const failed = s.events('queue:update').at(-1).jobs[0];
  assert.equal(failed.error.code, 'NO_DISK_SPACE');
  assert.equal(failed.error.message, 'Faltam 4 GB em D:.');
  assert.match(failed.error.solution, /Libere espaço/);
}));

test('queue.json legível mas com trabalho incompleto: o handler da fila carrega do mesmo jeito (canais registrados) e a falha aparece na lista', withEnv(async (base) => {
  const userData = path.join(base, 'ud-incompleto');
  fs.mkdirSync(userData, { recursive: true });
  const source = h.makeSource(base);
  fs.writeFileSync(path.join(userData, 'queue.json'), JSON.stringify({
    version: 1, settings: {}, paused: false, completed: {},
    jobs: [{ id: 'x', state: 'queued', sourcePath: source, baseName: 'a' }, { id: 'y', state: 'queued', sourcePath: source, outputDir: path.join(base, 'Cortes') }]
  }));
  const handlers = new Map();
  const ctx = createContext({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, app: { getPath: () => userData, getVersion: () => '1' }, dialog: {}, shell: {}, logger: silent, resolveTools: () => ({ ffmpeg: 'ffmpeg-de-teste' }) });
  const res = loadHandlers(ctx);
  assert.deepEqual(res.failed, [], 'o handler da fila não pode falhar por causa do arquivo salvo');
  assert.ok(res.loaded.includes('queue.js'));
  for (const channel of CHANNELS) assert.ok(handlers.has(channel), channel);

  const list = await handlers.get('queue:list')({}, {});
  assert.equal(list.ok, true);
  assert.deepEqual(list.jobs.map((j) => [j.id, j.state, j.error && j.error.code]), [['x', 'failed', 'INVALID_STATE'], ['y', 'failed', 'INVALID_STATE']]);
  assert.match(list.jobs[0].error.message, /pasta de destino/);
  assert.match(list.jobs[1].error.message, /nome do arquivo/);
  assert.equal(list.recovery.pending, false);
  assert.equal(list.loadWarning, null, 'o arquivo era legível: nada foi preservado como .corrupt');
  assert.equal((await handlers.get('queue:remove')({}, { id: 'x' })).removed, true);
  await h.sleep(30);
}));

test('ids hostis pelo canal queue:enqueue são trocados e a pasta de fora não é tocada', withEnv(async (base, mk) => {
  const fake = makeFakeRunner({ autoFinish: 1 });
  const s = mk({ overrides: { runner: fake.runner } });
  const precious = path.join(path.dirname(s.ctx.paths.cache), 'MEUS_DOCUMENTOS'); // <cache>/queue/<id> com "../../" cai aqui
  fs.mkdirSync(precious, { recursive: true });
  fs.writeFileSync(path.join(precious, 'importante.txt'), 'não apague');

  const res = await s.call('queue:enqueue', { jobs: [makeJob(base, 0, { id: '../../MEUS_DOCUMENTOS' }), makeJob(base, 1, { id: 'all' })] });
  assert.equal(res.ok, true);
  for (const id of res.ids) assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
  assert.ok(!res.ids.includes('all'));
  await waitUntil(() => s.manager.jobs.every((j) => j.state === 'done'), { timeout: 5000 });
  assert.equal(fs.readFileSync(path.join(precious, 'importante.txt'), 'utf8'), 'não apague');
  assert.ok(fake.calls.every((c) => path.dirname(c.opts.tmpDir) === path.join(s.ctx.paths.cache, 'queue')));
}));

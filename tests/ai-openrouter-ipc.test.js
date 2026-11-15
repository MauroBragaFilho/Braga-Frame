'use strict';

/**
 * Os canais `aiOpenrouter:*` com o ctx de verdade (createContext) e um Electron falso, contra o servidor HTTP local que imita o
 * OpenRouter: a lista de seleção (ordem, cache, offline, interruptor, busca) e os pedidos gratuitos restantes (a chave só no processo
 * principal e nunca em retorno, log nem arquivo). Também: o carregador de handlers o pega sozinho e ele convive com os canais da análise.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createContext } = require('../src/ipc/context');
const { loadHandlers } = require('../src/ipc');
const aiOpenrouter = require('../src/ipc/handlers/aiOpenrouter');
const { ROUTER_ID, ROUTER_LABEL, CACHE_FILE } = require('../src/core/ai/openrouter/catalog');
const F = require('./ai-openrouter-fakes');

function fakeElectron(userData, { packaged = false } = {}) {
  const handlers = new Map();
  const lines = [];
  const logger = { log: (m) => lines.push(['log', m]), info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]), error: (m) => lines.push(['error', m]) };
  const deps = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: () => userData, getVersion: () => '9.9.9', on() {}, isPackaged: packaged },
    dialog: {}, shell: {}, getWindow: () => null, logger
  };
  return { deps, handlers, lines, call: (channel, payload) => handlers.get(channel)({}, payload) };
}

async function setup(t, { routes, options = {}, host, loadAll = false, packaged = false } = {}) {
  const dir = F.tmpDir();
  const mock = await F.startMockOpenRouter(routes || { models: () => ({ json: F.catalogBody() }) });
  t.after(async () => { await mock.close(); F.cleanup(dir); });
  const userData = path.join(dir, 'ud');
  const fe = fakeElectron(userData, { packaged });
  const ctx = createContext({ ...fe.deps, ...(host ? { host } : {}) });
  ctx.aiOpenrouterOptions = { baseUrl: mock.base, safeStorage: F.fakeSafeStorage(), restrict: () => {}, ...options };
  if (loadAll) {
    ctx.analysisAiOptions = { safeStorage: F.fakeSafeStorage(), restrict: () => {}, sleep: async () => {} };
    const res = loadHandlers(ctx);
    assert.deepEqual(res.failed, []);
    assert.ok(res.loaded.includes('aiOpenrouter.js'), 'o carregador pega o arquivo sozinho');
    assert.ok(res.loaded.indexOf('aiOpenrouter.js') < res.loaded.indexOf('analysis.js'), 'carrega antes da análise: ctx.aiOpenrouter já existe quando ela se registra');
  } else {
    aiOpenrouter.register(ctx);
  }
  return { dir, userData, mock, fe, ctx, aiDir: path.join(userData, 'ai') };
}

const ids = (res, group) => res.list.filter((x) => !group || x.group === group).map((x) => x.id);

test('os canais aiOpenrouter:models e aiOpenrouter:limits existem, o serviço fica em ctx.aiOpenrouter e o carregador de handlers o pega junto com os da análise', async (t) => {
  const s = await setup(t, { loadAll: true });
  assert.ok(s.fe.handlers.has('aiOpenrouter:models'));
  assert.ok(s.fe.handlers.has('aiOpenrouter:limits'));
  assert.ok(s.fe.handlers.has('analysis:aiSave'));
  assert.equal(typeof s.ctx.aiOpenrouter.checkModel, 'function');
  assert.equal(typeof s.ctx.aiOpenrouter.runWithFreeFallback, 'function');
  assert.equal(s.ctx.aiOpenrouter.baseUrl, s.mock.base);
  for (const channel of ['aiOpenrouter:models', 'aiOpenrouter:limits']) assert.match(channel, /^[a-z][a-zA-Z0-9]*:[a-zA-Z0-9]+$/, 'formato aceito pelo preload');
});

test('aiOpenrouter:models: roteador primeiro, gratuitos adequados, os demais com o motivo; interruptor ligado por padrão; cache em userData/ai', async (t) => {
  const s = await setup(t);
  const res = await s.fe.call('aiOpenrouter:models');
  assert.equal(res.ok, true);
  assert.equal(res.source, 'rede');
  assert.equal(res.stale, false);
  assert.equal(res.freeOnly, true);
  assert.equal(res.list[0].id, ROUTER_ID);
  assert.equal(res.list[0].name, ROUTER_LABEL);
  assert.equal(ids(res, 'free')[0], 'acme/grande-ctx:free');
  assert.ok(ids(res, 'otherFree').includes('omega/sem-json:free'));
  assert.ok(!res.list.some((x) => x.group === 'paid'));
  assert.ok(res.list.every((x) => x.isFree));
  assert.deepEqual(res.counts, { free: 10, otherFree: 9, paid: 0 });
  assert.match(res.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(res.error, undefined);
  assert.ok(fs.existsSync(path.join(s.aiDir, CACHE_FILE)), 'cache em userData/ai/openrouter-models.json');
  assert.equal(s.mock.calls[0].headers.authorization, undefined);
  // a segunda vem do cache
  const again = await s.fe.call('aiOpenrouter:models', {});
  assert.equal(again.source, 'cache');
  assert.equal(again.fetchedAt, res.fetchedAt);
  assert.equal(s.mock.count('GET', '/api/v1/models'), 1);
  // "Atualizar lista"
  const fresh = await s.fe.call('aiOpenrouter:models', { refresh: true });
  assert.equal(fresh.source, 'rede');
  assert.equal(s.mock.count('GET', '/api/v1/models'), 2);
  // o JSON da resposta é puro (atravessa o IPC)
  assert.deepEqual(JSON.parse(JSON.stringify(fresh)), fresh);
});

test('aiOpenrouter:models: freeOnly:false acrescenta os pagos com o preço por milhão; só o valor false desliga; busca por nome', async (t) => {
  const s = await setup(t);
  const on = await s.fe.call('aiOpenrouter:models', { freeOnly: true });
  const off = await s.fe.call('aiOpenrouter:models', { freeOnly: false });
  assert.equal(off.freeOnly, false);
  assert.deepEqual(off.list.slice(0, on.list.length), on.list);
  const paid = off.list.filter((x) => x.group === 'paid');
  assert.ok(paid.length > 5);
  const cheap = paid.find((x) => x.id === 'vendor/pago-barato');
  assert.deepEqual(cheap.price, { promptPerMillion: 0.3, completionPerMillion: 2.5, variable: false, unknown: false, otherFees: false });
  assert.equal(off.counts.paid, paid.length);
  for (const junk of ['false', 0, null, 'não', {}, undefined]) {
    assert.equal((await s.fe.call('aiOpenrouter:models', { freeOnly: junk })).freeOnly, true, String(junk));
  }
  // busca
  const q = await s.fe.call('aiOpenrouter:models', { query: 'medio' });
  assert.deepEqual(ids(q), [ROUTER_ID, 'acme/medio-a:free', 'zeta/medio-b:free']);
  const qp = await s.fe.call('aiOpenrouter:models', { query: 'vendor caro', freeOnly: false });
  assert.deepEqual(ids(qp), [ROUTER_ID, 'vendor/pago-caro']);
  assert.deepEqual(ids(await s.fe.call('aiOpenrouter:models', { query: 5 })).length > 3, true, 'busca que não é texto é ignorada');
  assert.deepEqual(ids(await s.fe.call('aiOpenrouter:models', { query: 'x'.repeat(5000) })), [ROUTER_ID]);
});

test('aiOpenrouter:models sem internet: usa o último cache e diz a data; sem cache, só o roteador e o motivo (e nenhum erro lançado)', async (t) => {
  const s = await setup(t);
  // sem cache e sem rede (o servidor responde 500)
  let mode = 'down';
  s.mock.routes.models = () => (mode === 'down' ? { status: 503, json: F.errorBody(503, 'fora do ar') } : { json: F.catalogBody() });
  const none = await s.fe.call('aiOpenrouter:models');
  assert.equal(none.ok, true);
  assert.equal(none.source, 'nenhum');
  assert.equal(none.stale, true);
  assert.equal(none.fetchedAt, null);
  assert.equal(none.error.code, 'HTTP');
  assert.deepEqual(ids(none), [ROUTER_ID]);
  assert.equal(none.list[0].name, ROUTER_LABEL);
  // com a rede de volta e depois fora de novo
  mode = 'up';
  const good = await s.fe.call('aiOpenrouter:models', { refresh: true });
  assert.equal(good.source, 'rede');
  mode = 'down';
  await s.mock.close();
  const old = await s.fe.call('aiOpenrouter:models', { refresh: true });
  assert.equal(old.source, 'cache-antigo');
  assert.equal(old.stale, true);
  assert.equal(old.fetchedAt, good.fetchedAt);
  assert.equal(old.error.code, 'NETWORK');
  assert.deepEqual(ids(old, 'free'), ids(good, 'free'), 'a lista segue igual');
});

test('aiOpenrouter:models: payloads estranhos não derrubam o canal', async (t) => {
  const s = await setup(t);
  for (const payload of [undefined, null, 'x', 5, [], { refresh: 'sim', freeOnly: 'talvez', query: { a: 1 } }]) {
    const res = await s.fe.call('aiOpenrouter:models', payload);
    assert.equal(res.ok, true, JSON.stringify(payload));
    assert.equal(res.list[0].id, ROUTER_ID);
  }
});

test('aiOpenrouter:limits: sem chave devolve NO_KEY (sem lançar nem poluir o log); com a chave guardada pela análise, devolve os pedidos que restam e NUNCA a chave', async (t) => {
  const s = await setup(t, {
    loadAll: true,
    routes: { models: () => ({ json: F.catalogBody() }), key: (call) => (call.headers.authorization === `Bearer ${F.KEY}` ? { json: F.keyBody({ used: 12, limit: 50 }) } : F.ERRORS.auth401()) }
  });
  const none = await s.fe.call('aiOpenrouter:limits');
  assert.equal(none.ok, false);
  assert.equal(none.code, 'NO_KEY');
  assert.match(none.message, /chave/);
  assert.equal(s.mock.count('GET', '/api/v1/key'), 0, 'sem chave nem tenta');
  assert.ok(!s.fe.lines.some(([level, m]) => (level === 'warn' || level === 'error') && /aiOpenrouter:limits|NO_KEY|pedidos restantes/.test(m)), 'NO_KEY é normal: não vira aviso no log');

  // a chave é guardada pelo cofre da análise (canal da análise) e este processo a lê do mesmo arquivo
  const saved = await s.fe.call('analysis:aiSave', { provider: 'openrouter', apiKey: F.KEY });
  assert.equal(saved.ok, true);
  const info = await s.fe.call('aiOpenrouter:limits');
  assert.equal(info.ok, true);
  assert.deepEqual(info.freeDaily, { used: 12, limit: 50, remaining: 38 });
  assert.match(info.resetText, /^renova (amanhã )?às \d{2}:\d{2}$/);
  assert.match(info.resetAt, /T00:00:00\.000Z$/);
  assert.equal(s.mock.calls.at(-1).headers.authorization, `Bearer ${F.KEY}`);
  const text = JSON.stringify(info);
  assert.ok(!text.includes(F.KEY) && !text.includes(F.KEY_LABEL), 'a chave (nem o "label" mascarado) volta para a tela');
  assert.equal(info.estimate, undefined, 'sem `calls` não há comparação');
  // com a estimativa da análise ("~N chamadas") a resposta compara com o que resta, sem bloquear
  const ok = await s.fe.call('aiOpenrouter:limits', { calls: 5 });
  assert.deepEqual([ok.estimate.level, ok.freeDaily.remaining], ['ok', 38]);
  assert.match(ok.estimate.message, /cerca de 5 pedidos; restam 38 hoje/);
  const over = await s.fe.call('aiOpenrouter:limits', { calls: 40 });
  assert.equal(over.estimate.level, 'warn');
  assert.match(over.estimate.message, /ela pode parar no meio/);
  for (const calls of ['x', 0, -3, null]) assert.equal((await s.fe.call('aiOpenrouter:limits', { calls })).estimate, undefined, String(calls));
  // pedidos seguidos usam o resultado guardado; refresh consulta de novo
  assert.equal(s.mock.count('GET', '/api/v1/key'), 1);
  await s.fe.call('aiOpenrouter:limits', { refresh: true });
  assert.equal(s.mock.count('GET', '/api/v1/key'), 2);
  // a chave não está em nenhum arquivo em claro, nem em log
  for (const f of F.readAll(s.userData)) assert.ok(!f.text.includes(F.KEY), `chave em claro em ${f.file}`);
  assert.ok(!JSON.stringify(s.fe.lines).includes(F.KEY));
});

test('aiOpenrouter:limits: chave recusada, servidor fora do ar e provedor do hospedeiro (BDS) viram respostas claras, sem a chave', async (t) => {
  const s = await setup(t, { loadAll: true, routes: { key: () => F.ERRORS.auth401() } });
  await s.fe.call('analysis:aiSave', { provider: 'openrouter', apiKey: F.KEY });
  const bad = await s.fe.call('aiOpenrouter:limits', { refresh: true });
  assert.deepEqual([bad.ok, bad.code], [false, 'AUTH']);
  assert.match(bad.message, /recusou a chave/);
  assert.ok(!JSON.stringify(bad).includes(F.KEY));
  s.mock.routes.key = () => F.ERRORS.server503();
  const down = await s.fe.call('aiOpenrouter:limits', { refresh: true });
  assert.deepEqual([down.ok, down.code], [false, 'SERVER']);
  assert.ok(s.fe.lines.some(([level, m]) => level === 'warn' && /pedidos restantes indisponíveis \(SERVER\)/.test(m)), 'falhas de verdade ficam no log, só com o código');
  assert.ok(!JSON.stringify(s.fe.lines).includes(F.KEY));
  // provedor do hospedeiro: a chave é dele
  const host = await setup(t, { host: { embedded: true, name: 'BDS', tool: () => null, whisperModels: null, ai: { describe: () => ({ id: 'x', label: 'X', model: 'm', ready: true }), chat: async () => ({ text: 'ok' }) } } });
  const none = await host.fe.call('aiOpenrouter:limits');
  assert.deepEqual([none.ok, none.code, none.hostManaged], [false, 'NO_KEY', true]);
  assert.equal(host.mock.count('GET', '/api/v1/key'), 0);
  // o catálogo (público) continua disponível no módulo embutido
  assert.equal((await host.fe.call('aiOpenrouter:models')).list[0].id, ROUTER_ID);
});

test('BF_OPENROUTER_BASE_URL (só para testes): vale em desenvolvimento, é ignorada no app instalado e em http:// fora da própria máquina', async (t) => {
  const mock = await F.startMockOpenRouter({ models: () => ({ json: F.catalogBody() }) });
  t.after(() => mock.close());
  const saved = process.env.BF_OPENROUTER_BASE_URL;
  t.after(() => { if (saved === undefined) delete process.env.BF_OPENROUTER_BASE_URL; else process.env.BF_OPENROUTER_BASE_URL = saved; });
  const make = (packaged) => {
    const dir = F.tmpDir();
    t.after(() => F.cleanup(dir));
    const fe = fakeElectron(path.join(dir, 'ud'), { packaged });
    const ctx = createContext(fe.deps);
    ctx.aiOpenrouterOptions = { safeStorage: F.fakeSafeStorage(), restrict: () => {} };
    aiOpenrouter.register(ctx);
    return { ctx, fe };
  };
  delete process.env.BF_OPENROUTER_BASE_URL;
  assert.equal(make(false).ctx.aiOpenrouter.baseUrl, 'https://openrouter.ai/api/v1', 'sem a variável, o endereço oficial');
  process.env.BF_OPENROUTER_BASE_URL = mock.base;
  const dev = make(false);
  assert.equal(dev.ctx.aiOpenrouter.baseUrl, mock.base);
  assert.equal((await dev.fe.call('aiOpenrouter:models')).source, 'rede');
  assert.equal(mock.count('GET', '/api/v1/models'), 1);
  assert.ok(dev.fe.lines.some(([, m]) => /BF_OPENROUTER_BASE_URL ativa/.test(m)), 'avisa no log que é endereço de teste');
  const installed = make(true);
  assert.equal(installed.ctx.aiOpenrouter.baseUrl, 'https://openrouter.ai/api/v1', 'no app instalado a variável não vale');
  assert.ok(installed.fe.lines.some(([, m]) => /ignorada no app instalado/.test(m)));
  for (const bad of ['http://servidor.exemplo/api/v1', 'ftp://127.0.0.1/x', 'lixo', 'https://u:p@openrouter.ai/api/v1']) {
    process.env.BF_OPENROUTER_BASE_URL = bad;
    const r = make(false);
    assert.equal(r.ctx.aiOpenrouter.baseUrl, 'https://openrouter.ai/api/v1', bad);
    assert.ok(r.fe.lines.some(([level, m]) => level === 'warn' && /ignorada/.test(m)), bad);
  }
});

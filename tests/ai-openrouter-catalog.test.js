'use strict';

/**
 * OpenRouter "só com modelos gratuitos", catálogo: o que é gratuito/texto/adequado, a ORDEM da lista (roteador sempre primeiro, gratuitos
 * adequados abaixo, os demais gratuitos com o motivo, pagos só com o interruptor desligado), a busca e o cache (6 h, refresh, sem rede,
 * cache ilegível), contra um servidor HTTP local de verdade que imita o OpenRouter (tests/ai-openrouter-fakes.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  OpenRouterCatalog, ROUTER_ID, ROUTER_LABEL, CACHE_FILE, CACHE_TTL_MS, isFreePricing, parsePrice, slimModel, restoreSlim, decorate, buildModelList, countGroups, formatTokens, formatDay
} = require('../src/core/ai/openrouter/catalog');
const F = require('./ai-openrouter-fakes');

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0); // 23/10/2026 12:00 UTC
const slimAll = (now = NOW) => F.makeCatalogModels(now).map(slimModel).filter(Boolean);
const ids = (list, group) => list.filter((x) => !group || x.group === group).map((x) => x.id);

// ---------- gratuito ----------

test('gratuito = prompt 0 e completion 0 e nenhum outro preço positivo (em qualquer nível); ausente, ilegível ou negativo é pago', () => {
  const free = [
    { prompt: '0', completion: '0' },
    { prompt: 0, completion: 0 },
    { prompt: '0.0', completion: '0.0000000' },
    { prompt: '0', completion: '0', request: '0', image: '0', web_search: '0' },
    { prompt: '0', completion: '0', request: '' }, // vazio = sem tarifa
    { prompt: '0', completion: '0', currency: 'USD' }, // texto que não é preço
    { prompt: '0', completion: '0', overrides: [{ min_prompt_tokens: 100000, utc_start: 100, utc_end: 400, utc_days: ['monday'], prompt: '0', completion: '0' }] }
  ];
  for (const p of free) assert.equal(isFreePricing(p), true, JSON.stringify(p));
  const paid = [
    undefined, null, [], 'grátis', {},
    { prompt: '0' }, { completion: '0' },
    { prompt: '0', completion: '0.000001' },
    { prompt: '0.000001', completion: '0' },
    { prompt: '-1', completion: '-1' },
    { prompt: '0', completion: '-1' },
    { prompt: '', completion: '' }, { prompt: null, completion: null }, { prompt: 'gratis', completion: 'gratis' },
    { prompt: '0', completion: '0', request: '0.01' },
    { prompt: '0', completion: '0', image: '0.002' },
    { prompt: '0', completion: '0', web_search: '0.014' },
    { prompt: '0', completion: '0', internal_reasoning: '0.00001' },
    { prompt: '0', completion: '0', input_cache_read: '0.000000001' },
    { prompt: '0', completion: '0', overrides: [{ min_prompt_tokens: 100000, prompt: '0.000001', completion: '0' }] },
    { prompt: '0', completion: '0', audio: '-1' }
  ];
  for (const p of paid) assert.equal(isFreePricing(p), false, JSON.stringify(p));
  // Number('') e Number(null) valem 0: não podem passar por grátis
  assert.ok(Number.isNaN(parsePrice('')) && Number.isNaN(parsePrice(null)) && Number.isNaN(parsePrice(undefined)) && Number.isNaN(parsePrice('abc')) && Number.isNaN(parsePrice([])));
  assert.equal(parsePrice('0.0000003'), 3e-7);
  assert.equal(parsePrice('1e-7'), 1e-7);
});

test('slimModel: normaliza o modelo do catálogo (contexto, modalidades, JSON, expiração, preço por milhão) e descarta o que não serve', () => {
  const raw = F.rawModel('vendor/x:free', {
    name: 'Vendor: X (free)', ctx: 262144, maxOut: 8192, structured: true, json: false, input: ['text', 'image'], output: ['text'], expires: '2026-10-31T00:00:00Z'
  });
  const s = slimModel(raw);
  assert.deepEqual(s, {
    id: 'vendor/x:free', name: 'Vendor: X (free)', contextLength: 262144, maxOutput: 8192, inputModalities: ['text', 'image'], outputModalities: ['text'],
    supportsJson: true, // só structured_outputs também vale
    expiresAt: '2026-10-31', isFree: true, pricePerMillion: { prompt: 0, completion: 0 }, priceKind: 'fixed'
  });
  const paid = slimModel(F.rawModel('vendor/y', { pricing: { prompt: '0.0000003', completion: '0.0000025' } }));
  assert.deepEqual(paid.pricePerMillion, { prompt: 0.3, completion: 2.5 }, 'preço por MILHÃO de tokens, sem ruído de ponto flutuante');
  assert.equal(paid.isFree, false);
  const variable = slimModel(F.rawModel('openrouter/auto', { pricing: { prompt: '-1', completion: '-1' } }));
  assert.deepEqual([variable.pricePerMillion, variable.priceKind], [null, 'variable'], 'preço variável (-1)');
  assert.deepEqual([slimModel(F.rawModel('x/y', { noPricing: true })).priceKind, slimModel(F.rawModel('x/z', { pricing: { prompt: 'abc', completion: '' } })).priceKind], ['unknown', 'unknown'], 'preço ausente ou ilegível');
  // modalidades pelo texto "a+b->c" quando as listas faltam
  const old = slimModel({ id: 'old/m', architecture: { modality: 'text+image->text' }, pricing: { prompt: '0', completion: '0' } });
  assert.deepEqual([old.inputModalities, old.outputModalities], [['text', 'image'], ['text']]);
  // sem contexto no topo: usa o do provedor
  assert.equal(slimModel({ id: 'a/b', top_provider: { context_length: 123456 } }).contextLength, 123456);
  // lixo
  for (const bad of [null, undefined, 5, 'x', {}, { id: 5 }, { id: '' }, { id: 'tem espaço' }, { id: 'quebra\nlinha' }, { id: 'x'.repeat(201) }]) assert.equal(slimModel(bad), null, JSON.stringify(bad));
  // datas inválidas de expiração viram "não expira"
  for (const exp of ['', 'amanhã', '2026-13-01', '2026-10-32', 20261031, {}]) assert.equal(slimModel(F.rawModel('a/b', { expires: exp })).expiresAt, null, String(exp));
});

// ---------- texto e adequado ----------

test('texto = saída só "text" e entrada com "text"; adequado = texto, contexto >= 60 mil, JSON, não expira em < 14 dias, id fora de /safety|guard|moderation|embed|rerank/', () => {
  const d = (id, o) => decorate(slimModel(F.rawModel(id, { name: id, ...o })), NOW);
  assert.equal(d('a/ok:free').suitable, true);
  assert.equal(d('a/ok:free').isText, true);
  // contexto: 60000 vale, 59999 não
  assert.equal(d('a/c60:free', { ctx: 60000 }).suitable, true);
  const short = d('a/c59:free', { ctx: 59999 });
  assert.equal(short.suitable, false);
  assert.deepEqual(short.reasons.map((r) => r.code), ['short_context']);
  assert.match(short.reasons[0].text, /^contexto curto \(60 mil\)$/);
  // JSON: response_format OU structured_outputs
  assert.equal(d('a/j1:free', { json: true, structured: false }).suitable, true);
  assert.equal(d('a/j2:free', { json: false, structured: true }).suitable, true);
  const noJson = d('a/j3:free', { json: false, structured: false });
  assert.deepEqual(noJson.reasons.map((r) => r.text), ['sem saída em JSON']);
  // id
  for (const id of ['n/guard-x:free', 'n/Safety:free', 'n/content-moderation:free', 'n/embed-1:free', 'n/rerank-2:free', 'n/GUARD:free']) {
    const x = d(id);
    assert.equal(x.suitable, false, id);
    assert.deepEqual(x.reasons.map((r) => r.code), ['safety'], id);
  }
  // áudio/música/imagem na saída, ou sem texto na entrada, não é modelo de conversa (e só esse motivo aparece)
  for (const o of [{ output: ['text', 'audio'] }, { output: ['image', 'text'] }, { output: ['audio'] }, { output: ['text'], input: ['image'] }]) {
    const x = d('a/m:free', { ctx: 8192, json: false, ...o });
    assert.equal(x.isText, false, JSON.stringify(o));
    assert.deepEqual(x.reasons.map((r) => r.code), ['not_text']);
    assert.equal(x.reasons[0].text, 'não é modelo de conversa');
  }
  // modalidades desconhecidas: não dá para afirmar que é texto
  assert.equal(decorate(slimModel({ id: 'a/n', pricing: { prompt: '0', completion: '0' } }), NOW).isText, false);
});

test('expiração: fim do dia indicado (UTC); menos de 14 dias não é adequado; já expirado é marcado', () => {
  const end = (y, m, d) => Date.UTC(y, m - 1, d, 23, 59, 59, 999);
  const model = (expires) => slimModel(F.rawModel('a/e:free', { expires }));
  // faltando exatamente 14 dias: ainda adequado; 1 ms a menos: expira em < 14 dias
  const exactly = decorate(model('2026-11-06'), end(2026, 11, 6) - 14 * F.DAY_MS);
  assert.equal(exactly.suitable, true);
  assert.equal(exactly.expiresInDays, 14);
  const almost = decorate(model('2026-11-06'), end(2026, 11, 6) - 14 * F.DAY_MS + 1);
  assert.equal(almost.suitable, false);
  assert.deepEqual(almost.reasons.map((r) => r.text), ['expira em 06/11']);
  // expirado (inclusive no último milissegundo) e o dia seguinte
  const gone = decorate(model('2026-10-20'), NOW);
  assert.equal(gone.expired, true);
  assert.equal(gone.expiresInDays, 0);
  assert.deepEqual(gone.reasons.map((r) => r.text), ['expirou em 20/10']);
  assert.equal(decorate(model('2026-10-23'), NOW).expired, false, 'vale até o fim do dia');
  assert.equal(decorate(model('2026-10-23'), end(2026, 10, 23)).expired, true);
  // ano diferente do atual aparece na data
  assert.deepEqual(decorate(model('2027-01-05'), end(2026, 12, 25)).reasons.map((r) => r.text), ['expira em 05/01/2027']);
  // sem data: nunca expira
  assert.equal(decorate(slimModel(F.rawModel('a/n:free')), NOW).expiresInDays, null);
  assert.equal(formatDay('2026-10-31', NOW), '31/10');
  assert.equal(formatDay('2027-01-02', NOW), '02/01/2027');
  assert.equal(formatDay('lixo', NOW), '');
});

test('formatTokens: contexto em texto curto ("262 mil", "1 mi")', () => {
  assert.deepEqual([262144, 1048576, 1000000, 1500000, 65536, 8192, 999999, 950000, 200000, 500, 0].map(formatTokens), ['262 mil', '1 mi', '1 mi', '1,5 mi', '66 mil', '8 mil', '1 mi', '1 mi', '200 mil', '500', '']);
});

// ---------- a lista (ORDEM) ----------

test('lista com o interruptor ligado: roteador SEMPRE primeiro, depois os gratuitos adequados (contexto maior primeiro), depois os demais gratuitos com o motivo; nada de pago', () => {
  const list = buildModelList(slimAll(), { now: NOW });
  assert.equal(list[0].id, ROUTER_ID);
  assert.equal(list[0].name, ROUTER_LABEL);
  assert.equal(list[0].group, 'router');
  assert.equal(list.filter((x) => x.id === ROUTER_ID).length, 1, 'o roteador não repete na lista de gratuitos');
  assert.deepEqual(ids(list, 'free'), [
    'acme/grande-ctx:free', // 1.000.000
    'acme/medio-a:free', // 262.144 (empate por nome)
    'zeta/medio-b:free', // 262.144 (só structured_outputs)
    'later/expira-em-60-dias:free', // 200.000
    'fmt/zeros-texto:free', // 100.000
    'fmt/zeros-numero:free', // 99.000
    'fmt/override-zero:free', // 98.000
    'edge/expira-em-15-dias:free', // 90.000
    'beta/pequeno-ok:free', // 65.536
    'edge/ctx-60000:free' // 60.000
  ]);
  // os adequados vêm TODOS antes dos demais gratuitos
  const groups = list.map((x) => x.group);
  const lastFree = groups.lastIndexOf('free');
  const firstOther = groups.indexOf('otherFree');
  assert.ok(lastFree < firstOther, 'adequados antes dos demais');
  assert.deepEqual(groups.slice(0, 1), ['router']);
  assert.ok(!groups.includes('paid'), 'sem pagos com o interruptor ligado');
  // os demais, com o motivo; o expirado por último
  const others = list.filter((x) => x.group === 'otherFree');
  assert.deepEqual(others.map((x) => x.id), [
    'edge/ctx-59999:free', 'imagem/gerador:free', 'musica/lyria-like', 'omega/content-safety:free', 'omega/embed-lite:free', 'omega/expira-logo:free',
    'omega/nemo-guard-x:free', 'omega/sem-json:free', 'omega/expirou:free'
  ]);
  const reason = (id) => others.find((x) => x.id === id).reasons.map((r) => r.text).join(' · ');
  assert.equal(reason('edge/ctx-59999:free'), 'contexto curto (60 mil)');
  assert.equal(reason('omega/sem-json:free'), 'sem saída em JSON');
  assert.equal(reason('omega/expira-logo:free'), 'expira em 30/10');
  assert.equal(reason('omega/expirou:free'), 'expirou em 21/10');
  assert.equal(reason('musica/lyria-like'), 'não é modelo de conversa');
  assert.equal(reason('imagem/gerador:free'), 'não é modelo de conversa');
  assert.equal(reason('omega/nemo-guard-x:free'), 'modelo de segurança, não de análise');
  // armadilhas de preço e pagos NUNCA aparecem entre os gratuitos
  const all = ids(list);
  for (const bad of ['trap/preco-extra:free', 'trap/web-search:free', 'trap/imagem-paga:free', 'trap/override:free', 'trap/so-prompt-gratis', 'trap/sem-preco', 'trap/preco-texto', 'trap/preco-vazio', 'trap/preco-nulo', 'vendor/pago-barato', 'openrouter/auto']) {
    assert.ok(!all.includes(bad), bad);
  }
  assert.ok(list.every((x) => x.isFree), 'tudo na lista com o interruptor ligado é gratuito');
  // nome sem o "(free)" do catálogo
  assert.equal(list.find((x) => x.id === 'acme/grande-ctx:free').name, 'Acme: Grande Contexto');
  assert.deepEqual(countGroups(list), { free: 10, otherFree: 9, paid: 0 });
});

test('lista com o interruptor DESLIGADO: os mesmos grupos e, ao final, os modelos de texto pagos com o preço por milhão de tokens', () => {
  const list = buildModelList(slimAll(), { freeOnly: false, now: NOW });
  const on = buildModelList(slimAll(), { freeOnly: true, now: NOW });
  assert.deepEqual(list.slice(0, on.length), on, 'o começo da lista é o mesmo');
  const paid = list.slice(on.length);
  assert.ok(paid.length > 0 && paid.every((x) => x.group === 'paid' && !x.isFree));
  // adequados primeiro (por nome), depois os que têm motivo
  assert.deepEqual(paid.map((x) => x.id), [
    'openrouter/auto', 'trap/web-search:free', 'trap/override:free', 'trap/imagem-paga:free', 'trap/preco-texto', 'trap/preco-nulo', 'trap/preco-extra:free',
    'trap/preco-vazio', 'trap/sem-preco', 'trap/so-prompt-gratis', 'vendor/pago-barato', 'vendor/pago-caro',
    'vendor/pago-curto' // o único com motivo (contexto curto): depois dos adequados
  ]);
  const by = (id) => paid.find((x) => x.id === id);
  assert.deepEqual(by('vendor/pago-barato').price, { promptPerMillion: 0.3, completionPerMillion: 2.5, variable: false, unknown: false, otherFees: false });
  assert.deepEqual(by('vendor/pago-caro').price, { promptPerMillion: 15, completionPerMillion: 75, variable: false, unknown: false, otherFees: false });
  assert.equal(by('openrouter/auto').price.variable, true, 'preço variável do roteador pago');
  assert.equal(by('trap/sem-preco').price.unknown, true, 'preço que o catálogo não informou não vira "variável"');
  assert.equal(by('trap/preco-extra:free').price.otherFees, true, 'texto a preço zero mas com outra tarifa: pago, e a lista avisa');
  assert.equal(by('vendor/pago-curto').suitable, false);
  assert.ok(!paid.some((x) => x.id === 'vendor/pago-imagem'), 'modelo que gera imagem não é de conversa');
  assert.ok(paid.findIndex((x) => x.id === 'vendor/pago-curto') > paid.findIndex((x) => x.id === 'vendor/pago-caro'), 'adequados antes dos demais');
  assert.equal(countGroups(list).paid, paid.length);
});

test('o interruptor só desliga com o valor false (qualquer outra coisa mantém o modo gratuito)', () => {
  const models = slimAll();
  for (const v of [undefined, true, null, 0, '', 'false', 'não', 1, {}]) {
    assert.equal(buildModelList(models, { freeOnly: v, now: NOW }).some((x) => x.group === 'paid'), false, String(v));
  }
  assert.equal(buildModelList(models, { freeOnly: false, now: NOW }).some((x) => x.group === 'paid'), true);
});

test('sem catálogo: o roteador gratuito está lá do mesmo jeito (e nada é inventado sobre ele)', () => {
  for (const models of [[], null, undefined, 'lixo', [null, 5, {}, { id: 3 }]]) {
    const list = buildModelList(models, { now: NOW });
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], {
      id: ROUTER_ID, name: ROUTER_LABEL, group: 'router', contextLength: null, maxOutput: null, supportsJson: null, expiresAt: null, expiresInDays: null,
      expired: false, isFree: true, isText: true, isRouter: true, suitable: true, reasons: [], price: null
    });
  }
  // com a busca também (o roteador fica sempre no topo)
  assert.equal(buildModelList([], { query: 'qualquer coisa', freeOnly: false, now: NOW })[0].id, ROUTER_ID);
});

test('com catálogo, o item do roteador usa os dados dele (contexto 200 mil, JSON) e continua o primeiro mesmo se vier no meio do catálogo', () => {
  const list = buildModelList(slimAll().reverse(), { now: NOW });
  assert.equal(list[0].id, ROUTER_ID);
  assert.equal(list[0].contextLength, 200000);
  assert.equal(list[0].supportsJson, true);
  assert.equal(list[0].name, ROUTER_LABEL, 'o nome mostrado é o do app, não "Free Models Router"');
});

test('busca: sem acento nem caixa, todas as palavras; o roteador fica no topo; ids repetidos entram uma vez', () => {
  const models = slimAll();
  assert.deepEqual(ids(buildModelList(models, { query: 'medio', now: NOW })), [ROUTER_ID, 'acme/medio-a:free', 'zeta/medio-b:free']);
  assert.deepEqual(ids(buildModelList(models, { query: 'GRÂNDE contexto', now: NOW })), [ROUTER_ID, 'acme/grande-ctx:free']);
  assert.deepEqual(ids(buildModelList(models, { query: 'acme', now: NOW }), 'free'), ['acme/grande-ctx:free', 'acme/medio-a:free']);
  assert.deepEqual(ids(buildModelList(models, { query: 'vendor pago', freeOnly: false, now: NOW })), [ROUTER_ID, 'vendor/pago-barato', 'vendor/pago-caro', 'vendor/pago-curto']);
  assert.deepEqual(ids(buildModelList(models, { query: 'zzz-nada', now: NOW })), [ROUTER_ID]);
  assert.equal(buildModelList(models, { query: 'vendor', now: NOW }).length, 1, 'pagos não aparecem na busca com o interruptor ligado');
  const dup = [...models, ...models];
  assert.equal(buildModelList(dup, { now: NOW }).length, buildModelList(models, { now: NOW }).length);
});

test('restoreSlim reconfere o preço de quem diz ser gratuito (cache editado à mão não vira "grátis")', () => {
  const good = slimModel(F.rawModel('a/b:free'));
  assert.equal(restoreSlim(good).isFree, true);
  assert.equal(restoreSlim({ ...good, pricePerMillion: { prompt: 0.5, completion: 0 } }).isFree, false);
  assert.equal(restoreSlim({ ...good, pricePerMillion: null }).isFree, false);
  assert.equal(restoreSlim({ ...good, isFree: 'sim' }).isFree, false);
  assert.equal(restoreSlim({ id: 'x y' }), null);
  assert.equal(restoreSlim(null), null);
});

// ---------- rede e cache ----------

async function setup(t, { routes } = {}) {
  const dir = F.tmpDir();
  const mock = await F.startMockOpenRouter(routes || {});
  t.after(async () => { await mock.close(); F.cleanup(dir); });
  const clock = { t: NOW };
  const catalog = (extra = {}) => new OpenRouterCatalog({ dir: path.join(dir, 'ai'), baseUrl: mock.base, now: () => clock.t, ...extra });
  return { dir, mock, clock, catalog, file: path.join(dir, 'ai', CACHE_FILE) };
}

test('catálogo: baixa SEM chave (nenhum cabeçalho Authorization), grava o cache de forma atômica e enxuta, e usa o cache por 6 h', async (t) => {
  const s = await setup(t, { routes: { models: () => ({ json: F.catalogBody(NOW) }) } });
  const catalog = s.catalog();
  const first = await catalog.load();
  assert.equal(first.source, 'rede');
  assert.equal(first.stale, false);
  assert.equal(first.fetchedAt, new Date(NOW).toISOString());
  assert.equal(s.mock.count('GET', '/api/v1/models'), 1);
  assert.equal(s.mock.calls[0].headers.authorization, undefined, 'o catálogo é público: sem chave');
  assert.equal(s.mock.calls[0].headers.cookie, undefined);
  // cache
  const disk = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.equal(disk.version, 1);
  assert.equal(disk.baseUrl, s.mock.base);
  assert.equal(disk.fetchedAt, new Date(NOW).toISOString());
  assert.equal(disk.models.length, first.models.length);
  assert.ok(!fs.readFileSync(s.file, 'utf8').includes('Descrição longa'), 'o cache não guarda as descrições');
  assert.deepEqual(fs.readdirSync(path.dirname(s.file)).filter((f) => f.endsWith('.tmp')), [], 'sem sobras da gravação atômica');
  // 5 h 59 min depois: ainda vale (e não vai à rede)
  s.clock.t = NOW + CACHE_TTL_MS - 60000;
  const second = await s.catalog().load();
  assert.equal(second.source, 'cache');
  assert.equal(second.stale, false);
  assert.equal(second.fetchedAt, first.fetchedAt);
  assert.equal(s.mock.count('GET', '/api/v1/models'), 1, 'dentro das 6 h não baixa de novo');
  // exatamente 6 h: ainda vale; 6 h e 1 ms: baixa de novo
  s.clock.t = NOW + CACHE_TTL_MS;
  assert.equal((await s.catalog().load()).source, 'cache');
  s.clock.t = NOW + CACHE_TTL_MS + 1;
  const third = await s.catalog().load();
  assert.equal(third.source, 'rede');
  assert.equal(third.fetchedAt, new Date(NOW + CACHE_TTL_MS + 1).toISOString());
  assert.equal(s.mock.count('GET', '/api/v1/models'), 2);
});

test('catálogo: "Atualizar lista" (refresh) ignora o cache que ainda valia', async (t) => {
  const s = await setup(t);
  const catalog = s.catalog();
  await catalog.load();
  s.clock.t += 5 * 60000;
  const again = await catalog.load({ refresh: true });
  assert.equal(again.source, 'rede');
  assert.equal(again.fetchedAt, new Date(NOW + 5 * 60000).toISOString());
  assert.equal(s.mock.count('GET', '/api/v1/models'), 2);
  assert.equal((await catalog.load()).source, 'cache', 'e o novo cache vale');
  assert.equal(s.mock.count('GET', '/api/v1/models'), 2);
});

test('catálogo: sem internet usa o ÚLTIMO cache (mesmo velho) e diz a data; sem cache nenhum, devolve vazio com o motivo e a lista só tem o roteador', async (t) => {
  const s = await setup(t);
  const catalog = s.catalog();
  const first = await catalog.load();
  await s.mock.close(); // internet "caiu"
  s.clock.t = NOW + 30 * F.DAY_MS; // cache de 30 dias atrás
  const offline = await catalog.load();
  assert.equal(offline.source, 'cache-antigo');
  assert.equal(offline.stale, true);
  assert.equal(offline.fetchedAt, first.fetchedAt, 'a data é a do cache usado');
  assert.equal(offline.error.code, 'NETWORK');
  assert.match(offline.error.message, /internet/);
  assert.equal(offline.models.length, first.models.length);
  // dentro das 6 h, mas com refresh e sem rede: continua usando o cache e avisa que falhou
  s.clock.t = NOW + 60000;
  const refreshed = await s.catalog().load({ refresh: true });
  assert.equal(refreshed.source, 'cache-antigo');
  assert.equal(refreshed.fetchedAt, first.fetchedAt);
  // sem cache nenhum
  fs.rmSync(s.file);
  const none = await s.catalog().load();
  assert.equal(none.source, 'nenhum');
  assert.equal(none.fetchedAt, null);
  assert.deepEqual(none.models, []);
  assert.equal(none.error.code, 'NETWORK');
  const list = buildModelList(none.models, { now: NOW });
  assert.deepEqual(ids(list), [ROUTER_ID]);
});

test('catálogo: resposta ruim (HTTP 500, texto que não é JSON, JSON sem lista, lista vazia) nunca derruba nem apaga o bom cache', async (t) => {
  let mode = 'ok';
  const s = await setup(t, {
    routes: {
      models: () => {
        if (mode === 'http500') return { status: 500, json: F.errorBody(500, 'quebrou') };
        if (mode === 'html') return { text: '<html>ola</html>' };
        if (mode === 'semlista') return { json: { total: 3 } };
        if (mode === 'vazia') return { json: { data: [] } };
        if (mode === 'soLixo') return { json: { data: [null, 5, { id: '' }] } };
        return { json: F.catalogBody(NOW) };
      }
    }
  });
  const good = await s.catalog().load();
  const before = fs.readFileSync(s.file, 'utf8');
  const expected = { http500: 'HTTP', html: 'BAD_FORMAT', semlista: 'BAD_FORMAT', vazia: 'BAD_FORMAT', soLixo: 'BAD_FORMAT' };
  for (const [m, code] of Object.entries(expected)) {
    mode = m;
    const r = await s.catalog().load({ refresh: true });
    assert.equal(r.source, 'cache-antigo', m);
    assert.equal(r.error.code, code, m);
    assert.equal(r.fetchedAt, good.fetchedAt, m);
    assert.equal(fs.readFileSync(s.file, 'utf8'), before, `${m}: o cache bom continua igual`);
  }
  mode = 'http500';
  assert.equal((await s.catalog().load({ refresh: true })).error.status, 500);
});

test('catálogo: cache ilegível, de outra versão, de outro endereço ou com entradas lixo é ignorado sem travar (e o ilegível é guardado como .corrupt)', async (t) => {
  const s = await setup(t);
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  const slim = slimAll();
  const variants = {
    lixo: 'isto não é json {{{',
    array: JSON.stringify([1, 2, 3]),
    versao: JSON.stringify({ version: 99, baseUrl: s.mock.base, fetchedAt: new Date(NOW).toISOString(), models: slim }),
    semModelos: JSON.stringify({ version: 1, baseUrl: s.mock.base, fetchedAt: new Date(NOW).toISOString() }),
    dataRuim: JSON.stringify({ version: 1, baseUrl: s.mock.base, fetchedAt: 'ontem', models: slim }),
    outroEndereco: JSON.stringify({ version: 1, baseUrl: 'https://outro.exemplo/api/v1', fetchedAt: new Date(NOW).toISOString(), models: slim }),
    soLixo: JSON.stringify({ version: 1, baseUrl: s.mock.base, fetchedAt: new Date(NOW).toISOString(), models: [null, 3, { id: '' }, { id: 'a b' }] }),
    futuro: JSON.stringify({ version: 1, baseUrl: s.mock.base, fetchedAt: new Date(NOW + 10 * F.DAY_MS).toISOString(), models: slim })
  };
  let calls = 0;
  for (const [name, content] of Object.entries(variants)) {
    fs.writeFileSync(s.file, content);
    const r = await s.catalog().load();
    calls += 1;
    assert.equal(r.source, 'rede', name);
    assert.equal(s.mock.count('GET', '/api/v1/models'), calls, name);
    assert.ok(r.models.length > 20, name);
    assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf8')).models.length, r.models.length, `${name}: o cache foi refeito`);
  }
  assert.ok(fs.readdirSync(path.dirname(s.file)).some((f) => f.endsWith('.corrupt')), 'o arquivo ilegível foi guardado, não apagado');
  // cache bom com uma entrada ruim no meio: aproveita as boas
  fs.writeFileSync(s.file, JSON.stringify({ version: 1, baseUrl: s.mock.base, fetchedAt: new Date(NOW).toISOString(), models: [slim[0], { id: '' }, slim[1]] }));
  const partial = await s.catalog().load();
  assert.equal(partial.source, 'cache');
  assert.deepEqual(partial.models.map((m) => m.id), [slim[0].id, slim[1].id]);
});

test('catálogo: prazo de 20 s (aqui encurtado) e downloads simultâneos viram um só', async (t) => {
  let hang = true;
  const s = await setup(t, { routes: { models: () => (hang ? { hang: true } : { delayMs: 60, json: F.catalogBody(NOW) }) } });
  const slow = s.catalog({ timeoutMs: 150 });
  const t0 = Date.now();
  const r = await slow.load();
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(r.source, 'nenhum');
  assert.equal(r.error.code, 'TIMEOUT');
  assert.match(r.error.message, /demorou demais/);
  hang = false;
  const catalog = s.catalog();
  const before = s.mock.count('GET', '/api/v1/models');
  const [a, b, c] = await Promise.all([catalog.load(), catalog.load({ refresh: true }), catalog.load()]);
  assert.equal(s.mock.count('GET', '/api/v1/models') - before, 1, 'três pedidos, um download');
  assert.deepEqual([a.source, b.source, c.source], ['rede', 'rede', 'rede']);
  assert.equal(a.fetchedAt, b.fetchedAt);
});

test('catálogo: o prazo padrão é de 20 s e o endereço padrão é o oficial', () => {
  const c = new OpenRouterCatalog({ dir: path.join(F.tmpDir(), 'ai') });
  assert.equal(c.timeoutMs, 20000);
  assert.equal(c.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(c.ttlMs, 6 * 60 * 60 * 1000);
  assert.throws(() => new OpenRouterCatalog({ dir: 'x', baseUrl: 'ftp://x' }), /https/);
  assert.throws(() => new OpenRouterCatalog({ dir: 'x', baseUrl: 'https://u:p@x/v1' }), /usuário/);
  assert.equal(new OpenRouterCatalog({ dir: 'x', baseUrl: 'http://127.0.0.1:9/api/v1///' }).baseUrl, 'http://127.0.0.1:9/api/v1');
  fs.rmSync(path.dirname(path.dirname(c.file)), { recursive: true, force: true });
});

test('catálogo: snapshot() responde na hora, sem rede (nunca carregado -> loaded:false; depois, do cache em disco)', async (t) => {
  const s = await setup(t);
  const empty = s.catalog().snapshot();
  assert.deepEqual(empty, { models: [], fetchedAt: null, loaded: false });
  const first = await s.catalog().load();
  const calls = s.mock.calls.length;
  const fresh = s.catalog().snapshot(); // outra instância, só lê o arquivo
  assert.equal(fresh.loaded, true);
  assert.equal(fresh.models.length, first.models.length);
  assert.equal(fresh.fetchedAt, first.fetchedAt);
  assert.equal(s.mock.calls.length, calls, 'snapshot nunca vai à rede');
});

// ---------- o formato REAL (retrato reduzido do catálogo de 23/10/2026, tests/ai-openrouter-fixtures) ----------

test('retrato REAL do catálogo (23/10/2026, reduzido): roteador + 8 gratuitos adequados + 11 outros gratuitos; preço -1, faixas de preço e ids com "~" tratados', () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'ai-openrouter-fixtures', 'catalogo-2026-10-23.json'), 'utf8'));
  const at = Date.UTC(2026, 9, 23, 13, 31, 0);
  const slim = real.data.map(slimModel);
  assert.ok(slim.every(Boolean), 'todo modelo do catálogo real é aceito (inclusive os ids com "~")');
  assert.ok(slim.some((m) => m.id.startsWith('~')));
  assert.equal(slim.filter((m) => m.isFree).length, 20, '20 modelos com preço zero (17 :free, o roteador e 2 de música)');
  // preço -1 (roteadores pagos) e faixas de preço (overrides) NÃO são grátis
  const variable = slim.filter((m) => m.priceKind === 'variable');
  assert.equal(variable.length, 7);
  assert.ok(variable.every((m) => !m.isFree && m.pricePerMillion === null));
  for (const m of real.data.filter((x) => x.pricing && x.pricing.overrides)) assert.equal(slim.find((s) => s.id === m.id).isFree, false, m.id);
  const list = buildModelList(slim, { now: at });
  assert.equal(list[0].id, ROUTER_ID);
  assert.equal(list[0].contextLength, 200000);
  assert.deepEqual(ids(list, 'free'), [
    'nvidia/nemotron-3.5-super-vl:free', 'dots-studio/dots-3-note-preview:free', 'google/gemma-4-26b-a4b-it:free', 'google/gemma-4-31b-it:free',
    'nvidia/nemotron-3-super-120b-a12b:free', 'recursive/flint-v1.0:free', 'xingchen-agi/xing4.0-29b-a4b:free', 'liquid/lfm-2.5-2.6b:free'
  ]);
  assert.deepEqual(ids(list, 'otherFree'), [
    'cohere/north-mini-code:free', 'google/lyria-3-clip-preview', 'google/lyria-3-pro-preview', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3.5-content-safety:free', 'nvidia/nemotron-3.5-lightning:free', 'poolside/laguna-s-2.1:free',
    'poolside/laguna-xs-2.1:free', 'thinkingmachines/inkling:free', 'thinkingmachines/inkling-small:free'
  ]);
  const reason = (id) => list.find((x) => x.id === id).reasons.map((r) => r.text).join(' · ');
  assert.equal(reason('poolside/laguna-s-2.1:free'), 'expira em 31/10 · sem saída em JSON');
  assert.equal(reason('google/lyria-3-pro-preview'), 'não é modelo de conversa');
  assert.equal(reason('nvidia/nemotron-3.5-content-safety:free'), 'modelo de segurança, não de análise · sem saída em JSON');
  assert.equal(list.find((x) => x.id === 'dots-studio/dots-3-note-preview:free').expiresAt, '2026-12-31');
  assert.equal(list.length, 1 + 8 + 11);
  // com o interruptor desligado: pagos de texto com o preço; os roteadores de preço variável avisam; quem gera imagem fica de fora
  const all = buildModelList(slim, { freeOnly: false, now: at });
  const paid = all.filter((x) => x.group === 'paid');
  const flash = paid.find((x) => x.id === 'google/gemini-2.5-flash');
  assert.deepEqual(flash.price, { promptPerMillion: 0.3, completionPerMillion: 2.5, variable: false, unknown: false, otherFees: false });
  assert.ok(paid.filter((x) => x.price.variable).every((x) => x.isText));
  assert.ok(!paid.some((x) => /image/i.test(JSON.stringify(real.data.find((r) => r.id === x.id).architecture.output_modalities))), 'modelo que gera imagem não entra');
  // todos os gratuitos reais passam no guard e nenhum pago real passa
  const { checkModel } = require('../src/core/ai/openrouter/guard');
  for (const m of slim) assert.equal(checkModel(m.id, { models: slim }).ok, m.isFree || m.id === ROUTER_ID, m.id);
});

'use strict';

/**
 * OpenRouter "só com modelos gratuitos", guard: com o interruptor ligado (padrão) o processo principal só deixa passar o roteador gratuito
 * e ids que o catálogo marca como gratuitos (sem catálogo carregado, só o sufixo ":free"); o resto vira NOT_FREE e nada é enviado.
 * Também: o corpo do pedido nunca leva `models`/`route`/plugin de busca com algo pago.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkModel, classifyModel, isFreeModel, sanitizeRequestBody } = require('../src/core/ai/openrouter/guard');
const { slimModel, ROUTER_ID } = require('../src/core/ai/openrouter/catalog');
const { createOpenRouterService } = require('../src/core/ai/openrouter');
const F = require('./ai-openrouter-fakes');

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const models = () => F.makeCatalogModels(NOW).map(slimModel).filter(Boolean);

test('sem catálogo carregado: só o roteador gratuito e o sufixo ":free" passam; o resto é recusado com NOT_FREE', () => {
  const ok = (id) => checkModel(id, { freeOnly: true, models: null });
  assert.deepEqual(ok(ROUTER_ID), { ok: true, via: 'router' });
  assert.deepEqual(ok('acme/qualquer-coisa:free'), { ok: true, via: 'suffix' });
  for (const id of ['google/gemini-2.5-flash', 'openai/gpt-4o', 'openrouter/auto', 'acme/x:free-trial', 'acme/free', 'free', 'acme/x:freeX', 'FREE:acme']) {
    const r = ok(id);
    assert.equal(r.ok, false, id);
    assert.equal(r.code, 'NOT_FREE', id);
    assert.equal(r.via, 'paid', id);
    assert.ok(r.message.includes(`"${id}"`), 'cita o modelo');
    assert.match(r.message, /não é gratuito/);
    assert.match(r.message, /nada foi enviado e nada foi cobrado/);
    assert.match(r.message, /Usar apenas modelos gratuitos/);
  }
  // [] também é "nunca carregado"
  assert.equal(checkModel('google/gemini-2.5-flash', { models: [] }).ok, false);
  assert.equal(checkModel('x:free', { models: [] }).ok, true);
});

test('com o interruptor ligado por padrão: omitir, null, texto ou qualquer valor que não seja false NÃO desliga o guard', () => {
  for (const freeOnly of [undefined, true, null, 0, '', 'false', 'não', 1]) {
    assert.equal(checkModel('google/gemini-2.5-flash', { freeOnly }).ok, false, String(freeOnly));
  }
  assert.equal(checkModel('google/gemini-2.5-flash').ok, false, 'sem opções = ligado');
  assert.equal(checkModel('google/gemini-2.5-flash', {}).ok, false);
  assert.deepEqual(checkModel('google/gemini-2.5-flash', { freeOnly: false }), { ok: true, via: 'unrestricted' }, 'só false desliga');
  assert.equal(checkModel('qualquer/coisa', { freeOnly: false, models: models() }).ok, true);
});

test('ids inválidos são recusados (vazio, não texto, espaço, quebra de linha, gigante), inclusive porque sem model o OpenRouter usaria o modelo padrão da conta', () => {
  for (const id of [undefined, null, '', ' ', 5, {}, [], 'tem espaço:free', ' acme/x:free', 'acme/x:free ', 'quebra\nde:free', 'x'.repeat(201) + ':free']) {
    const r = checkModel(id, { models: null });
    assert.equal(r.ok, false, JSON.stringify(id));
    assert.equal(r.code, 'NOT_FREE');
    assert.equal(r.via, 'invalid');
    assert.ok(!/\n/.test(r.message), 'a mensagem não herda quebras de linha do id');
  }
  assert.match(checkModel('', {}).message, /Nenhum modelo foi escolhido/);
  assert.equal(isFreeModel('acme/x:free'), true);
  assert.equal(isFreeModel(' acme/x:free'), false);
});

test('com o catálogo carregado: vale o que ele marca como gratuito (inclusive sem o sufixo); pago, armadilha de preço e desconhecido são recusados', () => {
  const m = models();
  const ok = (id) => checkModel(id, { models: m });
  assert.deepEqual(ok(ROUTER_ID), { ok: true, via: 'router' });
  assert.deepEqual(ok('acme/grande-ctx:free'), { ok: true, via: 'catalog' });
  assert.deepEqual(ok('musica/lyria-like'), { ok: true, via: 'catalog' }, 'gratuito sem o sufixo, marcado pelo catálogo');
  assert.equal(ok('fmt/zeros-texto:free').ok, true);
  assert.equal(ok('omega/expirou:free').ok, true, 'o guard cuida de preço; modelo expirado falha no servidor (404) e o app explica');
  for (const id of ['vendor/pago-barato', 'vendor/pago-caro', 'openrouter/auto']) {
    const r = ok(id);
    assert.equal(r.ok, false, id);
    assert.equal(r.via, 'paid', id);
  }
  // tem o sufixo ":free", mas o catálogo diz que cobra (preço por pedido, busca na web, imagem, faixa paga): RECUSADO
  for (const id of ['trap/preco-extra:free', 'trap/web-search:free', 'trap/imagem-paga:free', 'trap/override:free']) {
    const r = ok(id);
    assert.equal(r.ok, false, id);
    assert.equal(r.via, 'paid', id);
  }
  // o catálogo manda mais do que o sufixo: id com ":free" que ele não conhece é recusado e a mensagem manda atualizar a lista
  const unknown = ok('novo/modelo:free');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.via, 'unknown');
  assert.match(unknown.message, /não está na lista de modelos gratuitos/);
  assert.match(unknown.message, /Atualizar lista/);
  assert.equal(ok('outro/nome-qualquer').via, 'unknown');
});

test('variante ":online" (busca na web, cobrada à parte) nunca é gratuita', () => {
  for (const catalog of [null, models()]) {
    for (const id of ['acme/medio-a:free:online', 'acme/x:online', 'acme/x:online:free', `${ROUTER_ID}:online`]) {
      assert.equal(checkModel(id, { models: catalog }).ok, false, id);
    }
  }
  assert.equal(classifyModel('acme/x:free', {}).free, true);
});

test('o roteador gratuito passa mesmo que o catálogo não o liste ou o descreva de outro jeito', () => {
  const withoutRouter = models().filter((x) => x.id !== ROUTER_ID);
  assert.equal(checkModel(ROUTER_ID, { models: withoutRouter }).ok, true);
  const priced = models().map((x) => (x.id === ROUTER_ID ? { ...x, isFree: false } : x));
  assert.equal(checkModel(ROUTER_ID, { models: priced }).ok, true, 'a especificação permite openrouter/free sempre');
});

test('sanitizeRequestBody: nunca sai `models`/`route` com id pago nem o plugin de busca na web; devolve cópia e diz o que tirou', () => {
  const m = models();
  const body = {
    model: 'acme/medio-a:free',
    models: ['acme/medio-a:free', 'vendor/pago-barato', 'acme/grande-ctx:free', 'acme/grande-ctx:free', 'novo/desconhecido:free', 5],
    route: 'fallback',
    plugins: [{ id: 'web' }, { id: 'file-parser' }],
    messages: [{ role: 'user', content: 'oi' }],
    temperature: 0.2
  };
  const snapshot = JSON.parse(JSON.stringify(body));
  const r = sanitizeRequestBody(body, { models: m });
  assert.deepEqual(body, snapshot, 'o corpo original não é alterado');
  assert.deepEqual(r.body.models, ['acme/grande-ctx:free'], 'fica só o gratuito, sem o próprio modelo do pedido nem repetidos');
  assert.equal(r.body.route, 'fallback', 'havendo fallback gratuito, a rota continua');
  assert.deepEqual(r.body.plugins, [{ id: 'file-parser' }]);
  assert.deepEqual(r.body.messages, body.messages);
  assert.equal(r.body.model, 'acme/medio-a:free');
  assert.equal(r.body.temperature, 0.2);
  assert.equal(r.changed, true);
  assert.deepEqual(r.removed.map((x) => `${x.field}:${x.id}`).sort(), ['models:5', 'models:novo/desconhecido:free', 'models:vendor/pago-barato', 'plugins:web'].sort());

  // tudo pago: o campo some (e o "fallback" que dependia dele)
  const allPaid = sanitizeRequestBody({ model: ROUTER_ID, models: ['vendor/pago-caro', 'openrouter/auto'], route: 'fallback' }, { models: m });
  assert.equal('models' in allPaid.body, false);
  assert.equal('route' in allPaid.body, false);
  // `route` como lista também é conferida
  const routeList = sanitizeRequestBody({ model: ROUTER_ID, route: ['acme/medio-a:free', 'vendor/pago-barato'] }, { models: m });
  assert.deepEqual(routeList.body.route, ['acme/medio-a:free']);
  // sem catálogo: só o sufixo e o roteador
  const noCatalog = sanitizeRequestBody({ model: 'a:free', models: ['b:free', 'google/gemini-2.5-flash', ROUTER_ID] }, { models: null });
  assert.deepEqual(noCatalog.body.models, ['b:free', ROUTER_ID]);
  // plugins só com a busca: o campo some
  assert.equal('plugins' in sanitizeRequestBody({ model: ROUTER_ID, plugins: [{ id: 'WEB', max_results: 5 }] }, {}).body, false);
  // corpo limpo: nada muda
  const clean = sanitizeRequestBody({ model: ROUTER_ID, messages: [] }, {});
  assert.equal(clean.changed, false);
  assert.deepEqual(clean.removed, []);
  // interruptor desligado: o corpo segue como veio (cópia)
  const off = sanitizeRequestBody(body, { freeOnly: false, models: m });
  assert.deepEqual(off.body, body);
  assert.notEqual(off.body, body);
  assert.equal(off.changed, false);
  // entrada que não é objeto
  for (const junk of [null, undefined, 'x', 5, []]) assert.deepEqual(sanitizeRequestBody(junk, {}).body, {});
});

test('o serviço junta o guard ao catálogo que está no disco (sem ir à rede) e o fallback usa o mesmo guard', async (t) => {
  const dir = F.tmpDir();
  const mock = await F.startMockOpenRouter({ models: () => ({ json: F.catalogBody(NOW) }) });
  t.after(async () => { await mock.close(); F.cleanup(dir); });
  const svc = createOpenRouterService({ dir, baseUrl: mock.base, now: () => NOW });
  // nunca carregado: sufixo
  assert.equal(svc.checkModel('qualquer/coisa:free').ok, true);
  assert.equal(svc.checkModel('google/gemini-2.5-flash').ok, false);
  assert.equal(svc.checkModel('qualquer/coisa:free', { freeOnly: false }).ok, true);
  // carregado: o catálogo manda
  await svc.modelList();
  const calls = mock.calls.length;
  assert.equal(svc.checkModel('qualquer/coisa:free').ok, false);
  assert.equal(svc.checkModel('trap/preco-extra:free').ok, false);
  assert.equal(svc.checkModel('acme/medio-a:free').ok, true);
  assert.equal(svc.sanitizeBody({ model: ROUTER_ID, models: ['vendor/pago-caro', 'acme/medio-a:free'] }).body.models.join(), 'acme/medio-a:free');
  assert.equal(mock.calls.length, calls, 'o guard nunca vai à rede');
  // outra instância (reinício do app) enxerga o mesmo catálogo pelo cache em disco
  const again = createOpenRouterService({ dir, baseUrl: mock.base, now: () => NOW });
  assert.equal(again.checkModel('trap/web-search:free').ok, false);
  assert.equal(again.checkModel('acme/grande-ctx:free').ok, true);
  assert.equal(mock.calls.length, calls);
});

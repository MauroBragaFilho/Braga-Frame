'use strict';

/**
 * OpenRouter "só com modelos gratuitos", fallback entre modelos gratuitos feito pelo app: tenta o próximo da lista do usuário em 404
 * (indisponível/expirado/política de dados), 429 por minuto ou do provedor e 5xx; NÃO troca em 401/consentimento/chave inválida/saldo/
 * cota do dia; todo id passa pelo guard (nunca um modelo pago); e o modelo que respondeu (campo `model` da resposta) é devolvido.
 * Parte com tentativas simuladas e parte contra o servidor HTTP local de verdade.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { runWithFreeFallback, shouldFallback, answeredModel } = require('../src/core/ai/openrouter/fallback');
const { checkModel } = require('../src/core/ai/openrouter/guard');
const { ROUTER_ID } = require('../src/core/ai/openrouter/catalog');
const { createOpenRouterService } = require('../src/core/ai/openrouter');
const F = require('./ai-openrouter-fakes');

const NOW = Date.UTC(2026, 9, 23, 17, 0, 0);
const chatCalls = (mock) => mock.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/chat/completions');

/** Erro do jeito que o cliente lança (status + corpo + cabeçalhos). */
function httpError(action) {
  const err = new Error(`HTTP ${action.status}`);
  err.status = action.status;
  err.code = action.status === 401 || action.status === 403 ? 'AUTH' : action.status === 404 ? 'MODEL' : action.status === 429 ? 'RATE_LIMIT' : action.status >= 500 ? 'SERVER' : 'BAD_REQUEST';
  err.responseBody = JSON.stringify(action.json);
  err.responseHeaders = action.headers || {};
  return err;
}

/** attempt simulado: cada modelo tem um roteiro (uma resposta ou um erro). Registra a ordem das tentativas. */
function scripted(script) {
  const seen = [];
  const attempt = async (id) => {
    seen.push(id);
    const step = script[id];
    if (step === undefined) throw new Error(`modelo fora do roteiro: ${id}`);
    if (step instanceof Error) throw step;
    return step;
  };
  return { attempt, seen };
}

test('o primeiro modelo responde: nada de troca; devolve o modelo que respondeu (o campo "model" da resposta quando vier)', async () => {
  const { attempt, seen } = scripted({ 'a/um:free': { text: 'ok', model: 'a/um:free' }, 'b/dois:free': { text: 'nunca' } });
  const r = await runWithFreeFallback(['a/um:free', 'b/dois:free'], attempt);
  assert.deepEqual(seen, ['a/um:free']);
  assert.equal(r.value.text, 'ok');
  assert.equal(r.requestedModel, 'a/um:free');
  assert.equal(r.model, 'a/um:free');
  assert.equal(r.switched, false);
  assert.deepEqual(r.attempts, []);
  assert.deepEqual(r.skipped, []);
  // o roteador: o modelo que respondeu é outro, informado pela resposta
  const router = scripted({ [ROUTER_ID]: { text: 'ok', model: 'acme/grande-ctx:free' } });
  const rr = await runWithFreeFallback([ROUTER_ID], router.attempt);
  assert.equal(rr.requestedModel, ROUTER_ID);
  assert.equal(rr.model, 'acme/grande-ctx:free');
  // outros nomes de campo aceitos e, sem nada, o pedido
  assert.equal(answeredModel({ answeredModel: 'x:free', model: 'y' }, 'z'), 'x:free');
  assert.equal(answeredModel({ respondedModel: 'x:free' }, 'z'), 'x:free');
  assert.equal(answeredModel({ text: 'sem modelo' }, 'z'), 'z');
  assert.equal(answeredModel('texto', 'z'), 'z');
  assert.equal(answeredModel(null, 'z'), 'z');
});

test('troca para o PRÓXIMO gratuito em 404 (política de dados, modelo removido), 429 por minuto/do provedor, 5xx, tempo esgotado e resposta inválida', async () => {
  const policy = httpError(F.ERRORS.dataPolicy404());
  const gone = httpError(F.ERRORS.modelGone404());
  const minute = httpError(F.ERRORS.rateLimitMinute(NOW));
  const upstream = httpError(F.ERRORS.upstream429());
  const s503 = httpError(F.ERRORS.server503());
  const s500 = httpError(F.ERRORS.server500());
  const timeout = Object.assign(new Error('O provedor demorou demais para responder.'), { code: 'TIMEOUT' });
  const interrupted = Object.assign(new Error('A conexão com o provedor caiu no meio da resposta.'), { code: 'INTERRUPTED' });
  const garbage = Object.assign(new Error('O provedor respondeu algo que não é uma resposta de chat.'), { code: 'BAD_RESPONSE' });
  for (const [err, code] of [[policy, 'DATA_POLICY'], [gone, 'MODEL'], [minute, 'RATE_LIMIT'], [upstream, 'RATE_LIMIT'], [s503, 'SERVER'], [s500, 'SERVER'], [timeout, 'TIMEOUT'], [interrupted, 'INTERRUPTED'], [garbage, 'BAD_RESPONSE']]) {
    const { attempt, seen } = scripted({ 'a/um:free': err, 'b/dois:free': { text: 'ok', model: 'b/dois:free' } });
    const switches = [];
    const r = await runWithFreeFallback(['a/um:free', 'b/dois:free'], attempt, { onSwitch: (ev) => switches.push(ev) });
    assert.deepEqual(seen, ['a/um:free', 'b/dois:free'], code);
    assert.equal(r.model, 'b/dois:free', code);
    assert.equal(r.switched, true, code);
    assert.equal(r.attempts.length, 1, code);
    assert.equal(r.attempts[0].model, 'a/um:free');
    assert.equal(r.attempts[0].code, code);
    assert.equal(switches.length, 1);
    assert.deepEqual([switches[0].from, switches[0].to, switches[0].index], ['a/um:free', 'b/dois:free', 1]);
    assert.equal(switches[0].reason.code, code);
    assert.ok(switches[0].reason.message.length > 5);
  }
});

test('NÃO troca em 401/403 (chave), consentimento, configuração, 402 (saldo), 429 do DIA, pedido recusado, moderação, rede fora do ar e cancelamento: o erro sobe e o 2º modelo nem é tentado', async () => {
  const code = (c, message = c) => Object.assign(new Error(message), { code: c });
  const stops = [
    httpError(F.ERRORS.auth401()),
    httpError({ status: 403, json: F.errorBody(403, 'forbidden') }),
    httpError({ status: 403, json: F.errorBody(403, 'Input flagged by moderation') }),
    httpError(F.ERRORS.credits402()),
    httpError(F.ERRORS.rateLimitDay(NOW)),
    httpError(F.ERRORS.badRequestContext()),
    code('CONSENT_REQUIRED'), code('NO_KEY'), code('NOT_CONFIGURED'), code('KEY_INSECURE'), code('INVALID_ARGS'), code('NOT_FREE'), code('NETWORK'), code('CANCELLED'), code('QUOTA'),
    new Error('erro qualquer sem código')
  ];
  for (const err of stops) {
    const { attempt, seen } = scripted({ 'a/um:free': err, 'b/dois:free': { text: 'não devia' } });
    await assert.rejects(() => runWithFreeFallback(['a/um:free', 'b/dois:free'], attempt), (e) => {
      assert.equal(e, err, 'sobe o MESMO erro');
      assert.equal(e.fallbackAttempts.length, 1);
      return true;
    }, `${err.code} ${err.status || ''}`);
    assert.deepEqual(seen, ['a/um:free'], `${err.code} ${err.status || ''}: não tentou o segundo`);
  }
  // shouldFallback expõe a decisão e o motivo
  assert.deepEqual(shouldFallback(httpError(F.ERRORS.auth401())).fallback, false);
  assert.equal(shouldFallback(httpError(F.ERRORS.rateLimitDay(NOW))).why, 'QUOTA');
  assert.equal(shouldFallback(httpError(F.ERRORS.dataPolicy404())).fallback, true);
  assert.equal(shouldFallback(null).fallback, false);
});

test('se todos falharem sobe o ÚLTIMO erro com o histórico das tentativas; no 3º modelo a troca continua', async () => {
  const errs = { 'a/um:free': httpError(F.ERRORS.dataPolicy404()), 'b/dois:free': httpError(F.ERRORS.upstream429()), 'c/tres:free': httpError(F.ERRORS.server503()) };
  const { attempt, seen } = scripted(errs);
  const switches = [];
  await assert.rejects(() => runWithFreeFallback(['a/um:free', 'b/dois:free', 'c/tres:free'], attempt, { onSwitch: (ev) => switches.push(`${ev.from}->${ev.to}`) }), (e) => {
    assert.equal(e, errs['c/tres:free']);
    assert.deepEqual(e.fallbackAttempts.map((a) => `${a.model}:${a.code}`), ['a/um:free:DATA_POLICY', 'b/dois:free:RATE_LIMIT', 'c/tres:free:SERVER']);
    return true;
  });
  assert.deepEqual(seen, ['a/um:free', 'b/dois:free', 'c/tres:free']);
  assert.deepEqual(switches, ['a/um:free->b/dois:free', 'b/dois:free->c/tres:free']);
  // um aviso de troca que lança não derruba a análise
  const second = scripted({ 'a/um:free': httpError(F.ERRORS.server500()), 'b/dois:free': { text: 'ok' } });
  const r = await runWithFreeFallback(['a/um:free', 'b/dois:free'], second.attempt, { onSwitch: () => { throw new Error('bug no aviso'); } });
  assert.equal(r.model, 'b/dois:free');
});

test('TODO id passa pelo guard: um modelo PAGO na lista é pulado e nunca é tentado; se não sobrar gratuito, NOT_FREE', async () => {
  const { attempt, seen } = scripted({ 'a/um:free': httpError(F.ERRORS.server500()), 'b/dois:free': { text: 'ok' }, 'google/gemini-2.5-flash': { text: 'PAGO: não podia' } });
  // o pago está no meio: nunca chega à função de pedido
  const r = await runWithFreeFallback(['a/um:free', 'google/gemini-2.5-flash', 'b/dois:free'], attempt);
  assert.deepEqual(seen, ['a/um:free', 'b/dois:free']);
  assert.equal(r.model, 'b/dois:free');
  assert.equal(r.skipped.length, 1);
  assert.deepEqual([r.skipped[0].model, r.skipped[0].code], ['google/gemini-2.5-flash', 'NOT_FREE']);
  assert.match(r.skipped[0].message, /não é gratuito/);
  // o pago é o PRIMEIRO da lista do usuário: pulado, o gratuito responde
  const first = scripted({ 'google/gemini-2.5-flash': { text: 'PAGO' }, 'b/dois:free': { text: 'ok' } });
  assert.equal((await runWithFreeFallback(['google/gemini-2.5-flash', 'b/dois:free'], first.attempt)).model, 'b/dois:free');
  assert.deepEqual(first.seen, ['b/dois:free']);
  // só pagos: NOT_FREE, nada é tentado
  const paid = scripted({ 'google/gemini-2.5-flash': { text: 'PAGO' }, 'openai/gpt-4o': { text: 'PAGO' } });
  await assert.rejects(() => runWithFreeFallback(['google/gemini-2.5-flash', 'openai/gpt-4o'], paid.attempt), (e) => {
    assert.equal(e.code, 'NOT_FREE');
    assert.match(e.message, /não é gratuito/);
    assert.equal(e.fallbackSkipped.length, 2);
    return true;
  });
  assert.deepEqual(paid.seen, []);
  // o guard padrão aceita o roteador e ":free"; um guard próprio manda
  const strict = scripted({ [ROUTER_ID]: { text: 'ok' }, 'x/y:free': { text: 'ok' } });
  assert.equal((await runWithFreeFallback([ROUTER_ID, 'x/y:free'], strict.attempt)).model, ROUTER_ID);
  const custom = scripted({ 'a/um:free': { text: 'x' }, 'b/dois:free': { text: 'ok' } });
  const r2 = await runWithFreeFallback(['a/um:free', 'b/dois:free'], custom.attempt, { guard: (id) => (id === 'a/um:free' ? { ok: false, code: 'NOT_FREE', message: 'recusado pelo guard próprio' } : { ok: true }) });
  assert.equal(r2.model, 'b/dois:free');
  assert.equal(r2.skipped[0].message, 'recusado pelo guard próprio');
});

test('o guard é conferido de novo na hora de cada tentativa (o catálogo pode mudar no meio); sobra o último erro de verdade', async () => {
  let catalogSaysFree = true;
  const guard = (id) => (id === 'b/dois:free' && !catalogSaysFree ? { ok: false, code: 'NOT_FREE', message: 'virou pago' } : { ok: true });
  const err = httpError(F.ERRORS.server503());
  const attempt = async (id) => { if (id === 'a/um:free') { catalogSaysFree = false; throw err; } return { text: 'não devia' }; };
  await assert.rejects(() => runWithFreeFallback(['a/um:free', 'b/dois:free'], attempt, { guard }), (e) => e === err && e.fallbackSkipped.length === 1);
});

test('lista vazia, repetida ou com lixo; cancelamento antes de começar; Pacer recebe a espera do limite por minuto (e só dele)', async () => {
  await assert.rejects(() => runWithFreeFallback([], async () => ({})), (e) => e.code === 'NOT_CONFIGURED');
  await assert.rejects(() => runWithFreeFallback(null, async () => ({})), (e) => e.code === 'NOT_CONFIGURED');
  await assert.rejects(() => runWithFreeFallback(['a/um:free'], null), TypeError);
  const dup = scripted({ 'a/um:free': { text: 'ok' } });
  await runWithFreeFallback(['a/um:free', 'a/um:free', 5, null, '', 'a/um:free'], dup.attempt);
  assert.deepEqual(dup.seen, ['a/um:free']);
  const ctrl = new AbortController();
  ctrl.abort();
  const cancelled = scripted({ 'a/um:free': { text: 'não' } });
  await assert.rejects(() => runWithFreeFallback(['a/um:free'], cancelled.attempt, { signal: ctrl.signal }), (e) => e.code === 'CANCELLED');
  assert.deepEqual(cancelled.seen, []);
  // o contexto da tentativa
  const ctxSeen = [];
  await runWithFreeFallback(['a/um:free', 'b/dois:free'], async (id, ctx) => { ctxSeen.push([id, ctx.index, [...ctx.tried]]); if (id === 'a/um:free') throw httpError(F.ERRORS.server500()); return {}; });
  assert.deepEqual(ctxSeen, [['a/um:free', 0, []], ['b/dois:free', 1, ['a/um:free']]]);
  // Pacer
  const penalties = [];
  const pacer = { penalize: (ms) => penalties.push(ms) };
  await runWithFreeFallback(['a/um:free', 'b/dois:free'], scripted({ 'a/um:free': httpError(F.ERRORS.rateLimitMinute(Date.now())), 'b/dois:free': {} }).attempt, { pacer });
  assert.equal(penalties.length, 1);
  assert.ok(penalties[0] > 0 && penalties[0] <= 30000);
  await runWithFreeFallback(['a/um:free', 'b/dois:free'], scripted({ 'a/um:free': httpError(F.ERRORS.upstream429()), 'b/dois:free': {} }).attempt, { pacer });
  assert.equal(penalties.length, 1, 'limite do provedor de UM modelo não atrasa os outros');
});

// ---------- contra o servidor HTTP local de verdade ----------

async function liveSetup(t, chatRoute) {
  const dir = F.tmpDir();
  const mock = await F.startMockOpenRouter({ models: () => ({ json: F.catalogBody(NOW) }), chat: chatRoute });
  t.after(async () => { await mock.close(); F.cleanup(dir); });
  const svc = createOpenRouterService({ dir, baseUrl: mock.base, now: () => NOW, sleep: async () => {} });
  await svc.modelList(); // o catálogo já está no disco: o guard o usa
  const ask = (id) => F.chat({ base: mock.base, key: F.KEY, model: id });
  return { dir, mock, svc, ask };
}

test('servidor local: 404 de política de dados no primeiro -> o segundo gratuito responde; a chave só vai no cabeçalho; o campo "model" da resposta manda', async (t) => {
  const s = await liveSetup(t, (call) => {
    if (call.body.model === 'acme/medio-a:free') return F.ERRORS.dataPolicy404();
    return { json: F.chatBody('resposta', { answered: call.body.model === ROUTER_ID ? 'acme/grande-ctx:free' : call.body.model }) };
  });
  const switches = [];
  const r = await s.svc.runWithFreeFallback(['acme/medio-a:free', 'zeta/medio-b:free'], s.ask, { onSwitch: (ev) => switches.push(ev) });
  assert.equal(r.model, 'zeta/medio-b:free');
  assert.equal(r.value.text, 'resposta');
  assert.deepEqual(chatCalls(s.mock).map((c) => c.body.model), ['acme/medio-a:free', 'zeta/medio-b:free']);
  assert.ok(chatCalls(s.mock).every((c) => c.headers.authorization === `Bearer ${F.KEY}` && !c.raw.includes(F.KEY) && !c.path.includes(F.KEY)));
  assert.equal(r.attempts[0].code, 'DATA_POLICY');
  assert.match(r.attempts[0].message, /treino ou publicação/);
  assert.ok(!JSON.stringify([r.attempts, r.skipped, switches]).includes(F.KEY));
  // roteador: o modelo que respondeu é o informado pela resposta
  const viaRouter = await s.svc.runWithFreeFallback([ROUTER_ID], s.ask);
  assert.equal(viaRouter.requestedModel, ROUTER_ID);
  assert.equal(viaRouter.model, 'acme/grande-ctx:free');
});

test('servidor local: NUNCA chega ao servidor um modelo pago (nem no meio da lista nem como fallback) e a chave inválida (401) não troca de modelo', async (t) => {
  const s = await liveSetup(t, (call) => (call.body.model === 'acme/medio-a:free' ? F.ERRORS.server503() : { json: F.chatBody('ok', { answered: call.body.model }) }));
  const list = ['acme/medio-a:free', 'vendor/pago-barato', 'trap/preco-extra:free', 'novo/desconhecido:free', 'google/gemini-2.5-flash', 'zeta/medio-b:free'];
  const r = await s.svc.runWithFreeFallback(list, s.ask);
  assert.equal(r.model, 'zeta/medio-b:free');
  const sent = chatCalls(s.mock).map((c) => c.body.model);
  assert.deepEqual(sent, ['acme/medio-a:free', 'zeta/medio-b:free']);
  for (const paid of ['vendor/pago-barato', 'trap/preco-extra:free', 'novo/desconhecido:free', 'google/gemini-2.5-flash']) assert.ok(!sent.includes(paid), `${paid} não pode ter sido enviado`);
  assert.deepEqual(r.skipped.map((x) => x.model), ['vendor/pago-barato', 'trap/preco-extra:free', 'novo/desconhecido:free', 'google/gemini-2.5-flash']);
  // sem catálogo no disco só vale o sufixo; e o corpo do pedido que o app monta passa pelo sanitizador
  const body = s.svc.sanitizeBody({ model: 'acme/medio-a:free', models: ['vendor/pago-barato', 'zeta/medio-b:free'] });
  assert.deepEqual(body.body.models, ['zeta/medio-b:free']);

  // 401: a chave foi recusada -> sobe na hora, sem tentar o segundo
  const bad = await liveSetup(t, () => F.ERRORS.auth401());
  await assert.rejects(() => bad.svc.runWithFreeFallback(['acme/medio-a:free', 'zeta/medio-b:free'], bad.ask), (e) => {
    assert.equal(e.status, 401);
    assert.equal(e.fallbackAttempts.length, 1);
    assert.equal(e.fallbackAttempts[0].code, 'AUTH');
    assert.ok(!JSON.stringify(e.fallbackAttempts).includes(F.KEY), 'o eco da chave no corpo do servidor não vai para o resultado do app');
    return true;
  });
  assert.equal(chatCalls(bad.mock).length, 1, 'só uma tentativa');
});

test('servidor local: 429 por minuto troca de modelo e o Pacer passa a esperar o que o servidor mandou; 429 do DIA e 402 não trocam', async (t) => {
  let phase = 'minute';
  const s = await liveSetup(t, (call) => {
    if (phase === 'minute' && call.body.model === 'acme/medio-a:free') return F.ERRORS.rateLimitMinute(Date.now());
    if (phase === 'day') return F.ERRORS.rateLimitDay(Date.now());
    if (phase === 'credits') return F.ERRORS.credits402();
    return { json: F.chatBody('ok', { answered: call.body.model }) };
  });
  const r = await s.svc.runWithFreeFallback(['acme/medio-a:free', 'zeta/medio-b:free'], s.ask);
  assert.equal(r.model, 'zeta/medio-b:free');
  const waitedMs = s.svc.pacer.nextAt - NOW; // o relógio do serviço é o NOW fixo do teste
  assert.ok(waitedMs >= 25000 && waitedMs <= 31000, `o Pacer foi avisado do que o servidor mandou esperar (X-RateLimit-Reset em ~30 s): ${waitedMs} ms`);
  s.svc.pacer.reset();
  // 429 por minuto SEM Retry-After nem X-RateLimit-*: troca do mesmo jeito, e o Pacer assume a espera padrão de 20 s
  phase = 'noheaders';
  s.mock.routes.chat = (call) => (call.body.model === 'acme/medio-a:free' ? F.ERRORS.rateLimitMinuteNoHeaders() : { json: F.chatBody('ok', { answered: call.body.model }) });
  const bare = await s.svc.runWithFreeFallback(['acme/medio-a:free', 'zeta/medio-b:free'], s.ask);
  assert.equal(bare.model, 'zeta/medio-b:free');
  assert.equal(bare.attempts[0].code, 'RATE_LIMIT');
  assert.equal(s.svc.pacer.nextAt - NOW, 20000, 'espera padrão de 20 s quando o servidor não diz quanto');
  s.svc.pacer.reset();
  s.mock.routes.chat = (call) => {
    if (phase === 'day') return F.ERRORS.rateLimitDay(Date.now());
    if (phase === 'credits') return F.ERRORS.credits402();
    return { json: F.chatBody('ok', { answered: call.body.model }) };
  };
  for (const [name, code] of [['day', 'QUOTA'], ['credits', 'CREDITS']]) {
    phase = name;
    const before = chatCalls(s.mock).length;
    await assert.rejects(() => s.svc.runWithFreeFallback(['acme/medio-a:free', 'zeta/medio-b:free'], s.ask), (e) => e.fallbackAttempts.length === 1 && e.fallbackAttempts[0].code === code, name);
    assert.equal(chatCalls(s.mock).length - before, 1, `${name}: uma tentativa só`);
  }
});

test('o serviço mapeia o erro de uma tentativa em português e nunca deixa a chave passar', async (t) => {
  const s = await liveSetup(t, () => F.ERRORS.dataPolicy404());
  let caught;
  try { await s.ask('acme/medio-a:free'); } catch (e) { caught = e; }
  const info = s.svc.mapError(caught, { model: 'acme/medio-a:free' });
  assert.equal(info.code, 'DATA_POLICY');
  assert.match(info.solution, /Privacy/);
  assert.ok(!JSON.stringify(info).includes(F.KEY));
  // com o interruptor desligado o guard libera modelo pago (escolha explícita do usuário)
  assert.equal(checkModel('google/gemini-2.5-flash', { freeOnly: false }).ok, true);
  const open = scripted({ 'google/gemini-2.5-flash': { text: 'pago, de propósito' } });
  const out = await s.svc.runWithFreeFallback(['google/gemini-2.5-flash'], open.attempt, { freeOnly: false });
  assert.equal(out.model, 'google/gemini-2.5-flash');
});

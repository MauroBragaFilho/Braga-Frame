'use strict';

/**
 * OpenRouter "só com modelos gratuitos" NO CAMINHO REAL do chat (AiRuntime + chatCompletion), contra o servidor HTTP local que imita o
 * OpenRouter (tests/ai-openrouter-fakes.js): modo gratuito ligado por padrão e guardado por provedor, recusa de modelo pago (NOT_FREE) antes de
 * qualquer pedido, corpo sem `models`/`route`/plugin pagos, Pacer de 3 s, fallback só entre gratuitos (429 troca de modelo; 401 e a cota do dia
 * não), erros explicados em português, lista conferida antes da análise, provedor do hospedeiro intacto e a CHAVE nunca em erro, log ou arquivo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AiRuntime } = require('../src/core/ai/runtime');
const { chatCompletion } = require('../src/core/ai/client');
const { classify } = require('../src/core/ai/errors');
const { createOpenRouterService, FREE_MODE_PRIVACY } = require('../src/core/ai/openrouter');
const F = require('./ai-openrouter-fakes');

const msgs = [{ role: 'user', content: 'oi' }];
const chatCalls = (mock) => mock.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/chat/completions');
const sentModels = (mock) => chatCalls(mock).map((c) => c.body.model);

/** Runtime de verdade + serviço do OpenRouter apontando para o servidor local (a espera do Pacer só é anotada, não esperada). */
async function makeRuntime(t, { routes = {}, withService = true, clock = null } = {}) {
  const dir = F.tmpDir('bf-or-rt-');
  const mock = await F.startMockOpenRouter({ models: () => ({ json: F.catalogBody() }), ...routes });
  t.after(async () => { await mock.close(); F.cleanup(dir); });
  const sleeps = [];
  const service = createOpenRouterService({ dir: path.join(dir, 'ai'), baseUrl: mock.base, sleep: async (ms) => { sleeps.push(ms); }, ...(clock ? { now: clock.now } : {}) });
  const runtime = new AiRuntime({ dir: path.join(dir, 'ai'), safeStorage: F.fakeSafeStorage(), restrict: () => {}, openrouter: withService ? service : null });
  service.setKeyProvider(() => runtime.secretFor('openrouter'));
  return { dir, mock, service, runtime, sleeps, cfg: () => JSON.parse(fs.readFileSync(runtime.configFile, 'utf8')) };
}

/** Provedor OpenRouter pronto: modelo, chave, lista de modelos já carregada (o guard usa) e aviso aceito. */
async function ready(s, patch = {}) {
  s.runtime.save({ provider: 'openrouter', apiKey: F.KEY, model: 'openrouter/free', ...patch });
  await s.service.modelList();
  s.runtime.accept(true);
  return s;
}

const noKey = (value, where) => assert.ok(!JSON.stringify(value, Object.getOwnPropertyNames(Object(value))).includes(F.KEY) && !String(value && value.stack).includes(F.KEY), `a chave apareceu (${where})`);
/** O `user_id` da conta (o OpenRouter o repete no corpo dos erros) não está em nenhuma propriedade, na mensagem, na pilha nem no corpo guardado. */
const noUser = (value, where) => {
  const all = `${JSON.stringify(value, Object.getOwnPropertyNames(Object(value)))}|${String(value && value.message)}|${String(value && value.stack)}|${String(value && value.responseBody)}`;
  assert.ok(!all.includes(F.USER_ID) && !/user_[A-Za-z0-9]{8,}/.test(all), `o user_id da conta apareceu (${where})`);
};

// ---------- configuração ----------

test('OpenRouter: provedor escolhido pelo usuário, roteador gratuito como modelo de partida, modo gratuito LIGADO por padrão e guardado por provedor, dica do campo nunca é modelo pago', async (t) => {
  const s = await makeRuntime(t);
  const st0 = s.runtime.state();
  const preset = st0.presets.find((p) => p.id === 'openrouter');
  assert.equal(preset.suggestedModel, 'openrouter/free', 'só a dica do campo, e do roteador gratuito (nunca um modelo pago)');
  assert.equal(preset.freeCapable, true);
  assert.deepEqual(st0.presets.filter((p) => p.freeCapable).map((p) => p.id), ['openrouter']);
  assert.equal(st0.selected, null);

  const st = s.runtime.save({ provider: 'openrouter' });
  assert.equal(st.provider.model, 'openrouter/free', 'o roteador gratuito já vem escolhido (decisão do dono, 23/10/2026); o provedor foi escolha do usuário');
  assert.equal(st.provider.ready, false);
  assert.match(st.provider.reason, /Informe a chave/);
  assert.equal(st.provider.reasonCode, 'NO_KEY');
  assert.equal(st.provider.freeOnly, true, 'ligado por padrão');
  assert.deepEqual(st.provider.fallbackModels, []);
  assert.equal(st.provider.freeCapable, true);
  assert.equal(st.provider.baseUrl, s.mock.base, 'o endereço do OpenRouter é o do serviço (o oficial; só os testes apontam para o servidor local)');
  // o aviso de privacidade ganha o parágrafo dos modelos gratuitos enquanto o modo estiver ligado
  assert.ok(st.provider.privacy.startsWith('O OpenRouter repassa o pedido ao provedor do modelo escolhido'));
  assert.ok(st.provider.privacy.endsWith(FREE_MODE_PRIVACY));
  assert.match(FREE_MODE_PRIVACY, /treino ou publicação, conforme as configurações da sua conta no OpenRouter/);
  const off = s.runtime.save({ freeOnly: false });
  assert.equal(off.provider.freeOnly, false);
  assert.ok(!off.provider.privacy.includes(FREE_MODE_PRIVACY), 'desligado, o parágrafo some');
  assert.equal(s.runtime.save({ freeOnly: true }).provider.freeOnly, true);
  // guardado por provedor: só o OpenRouter tem o campo; os outros recusam
  assert.equal(s.cfg().providers.openrouter.freeOnly, true);
  s.runtime.save({ provider: 'groq', model: 'llama-x' });
  assert.ok(!('freeOnly' in s.cfg().providers.groq) && !('fallbackModels' in s.cfg().providers.groq));
  assert.equal(s.runtime.state().provider.freeCapable, undefined);
  for (const patch of [{ freeOnly: true }, { fallbackModels: ['a:free'] }]) assert.throws(() => s.runtime.save(patch), (e) => e.code === 'INVALID_ARGS' && /só existem no OpenRouter/.test(e.message));
  // voltar ao OpenRouter: o modo continua como estava
  assert.equal(s.runtime.save({ provider: 'openrouter' }).provider.freeOnly, true);
  assert.throws(() => s.runtime.save({ freeOnly: 'talvez' }), (e) => e.code === 'INVALID_ARGS');
  assert.throws(() => s.runtime.save({ freeOnly: 0 }), (e) => e.code === 'INVALID_ARGS');
});

test('OpenRouter: o roteador gratuito é só o modelo de PARTIDA (não é gravado); escolher outro vale, esvaziar volta; nenhum outro provedor tem modelo de partida; o aceite continua valendo', async (t) => {
  const s = await makeRuntime(t);
  s.runtime.save({ provider: 'openrouter', apiKey: F.KEY });
  await s.service.modelList();
  const first = s.runtime.state().provider;
  assert.deepEqual([first.model, first.ready], ['openrouter/free', true], 'com a chave já fica pronto, no roteador gratuito');
  assert.equal(s.cfg().providers.openrouter.model, undefined, 'o padrão não é gravado: só a escolha do usuário');
  assert.equal(s.runtime.save({ model: 'acme/medio-a:free' }).provider.model, 'acme/medio-a:free', 'o modelo escolhido vale no lugar do padrão');
  assert.equal(s.cfg().providers.openrouter.model, 'acme/medio-a:free');
  assert.equal(s.runtime.save({ model: '' }).provider.model, 'openrouter/free', 'esvaziar volta ao roteador');
  // nos outros provedores o modelo continua sendo escolha do usuário
  for (const other of ['gemini', 'groq', 'custom']) assert.equal(s.runtime.save({ provider: other }).provider.model, '', other);
  // o aviso de privacidade segue sendo pedido antes de qualquer envio (o roteador pré-escolhido não dispensa o aceite)
  s.runtime.save({ provider: 'openrouter' });
  await assert.rejects(() => s.runtime.chat({ messages: msgs }), (e) => e.code === 'CONSENT_REQUIRED');
  assert.equal(chatCalls(s.mock).length, 0, 'nada foi enviado');
});

test('OpenRouter: com o modo ligado o modelo precisa ser gratuito para o provedor ficar pronto (NOT_FREE com a explicação); desligado, vale qualquer um', async (t) => {
  const s = await makeRuntime(t);
  s.runtime.save({ provider: 'openrouter', apiKey: F.KEY });
  // sem a lista carregada neste computador só valem o roteador e o sufixo ":free"
  assert.equal(s.runtime.save({ model: 'openrouter/free' }).provider.ready, true);
  assert.equal(s.runtime.save({ model: 'qualquer/coisa:free' }).provider.ready, true);
  const paid = s.runtime.save({ model: 'google/gemini-2.5-flash' }).provider;
  assert.equal(paid.ready, false);
  assert.equal(paid.reasonCode, 'NOT_FREE');
  assert.match(paid.reason, /O modelo "google\/gemini-2\.5-flash" não é gratuito/);
  assert.match(paid.reason, /nada foi enviado e nada foi cobrado/);
  assert.equal(s.mock.calls.length, 0, 'conferir o modelo não vai à rede');
  // com a lista carregada manda o catálogo
  await s.service.modelList();
  assert.equal(s.runtime.save({ model: 'acme/medio-a:free' }).provider.ready, true);
  assert.equal(s.runtime.save({ model: 'musica/lyria-like' }).provider.ready, true, 'gratuito pelo catálogo, sem o sufixo');
  for (const id of ['vendor/pago-barato', 'trap/preco-extra:free', 'trap/web-search:free', 'novo/desconhecido:free', 'openrouter/auto']) {
    const p = s.runtime.save({ model: id }).provider;
    assert.deepEqual([p.ready, p.reasonCode], [false, 'NOT_FREE'], id);
  }
  assert.match(s.runtime.save({ model: 'novo/desconhecido:free' }).provider.reason, /Atualizar lista/);
  // desligar é explícito: aí vale qualquer modelo (e some a recusa)
  const open = s.runtime.save({ model: 'vendor/pago-barato', freeOnly: false }).provider;
  assert.deepEqual([open.ready, open.reason], [true, '']);
  // ligar de novo traz a recusa de volta
  const again = s.runtime.save({ freeOnly: true }).provider;
  assert.deepEqual([again.ready, again.reasonCode], [false, 'NOT_FREE']);
  const back = s.runtime.save({ model: '' }).provider;
  assert.deepEqual([back.model, back.ready], ['openrouter/free', true], 'esvaziar o modelo volta ao roteador gratuito, que passa no guard');
  // sem o serviço do OpenRouter o provedor NÃO fica pronto (falha fechada: nunca cai no comportamento antigo)
  const bare = await makeRuntime(t, { withService: false });
  bare.runtime.save({ provider: 'openrouter', apiKey: F.KEY, model: 'openrouter/free' });
  const p = bare.runtime.state().provider;
  assert.deepEqual([p.ready, p.reasonCode], [false, 'NOT_CONFIGURED']);
  assert.match(p.reason, /modo gratuito do OpenRouter não está disponível/);
  bare.runtime.accept(true);
  await assert.rejects(() => bare.runtime.chat({ messages: msgs }), (e) => e.code === 'NOT_CONFIGURED');
  assert.equal(bare.mock.calls.length, 0);
});

test('modelos de reserva: até 3, só gratuitos com o modo ligado (o que o usuário manda é recusado); ao ligar o modo o que não serve sai; arquivo editado à mão é limpo', async (t) => {
  const s = await makeRuntime(t);
  await ready(s, { model: 'acme/medio-a:free' });
  const st = s.runtime.save({ fallbackModels: ['zeta/medio-b:free', 'openrouter/free', 'zeta/medio-b:free'] });
  assert.deepEqual(st.provider.fallbackModels, ['zeta/medio-b:free', 'openrouter/free'], 'sem repetir, na ordem');
  assert.deepEqual(s.cfg().providers.openrouter.fallbackModels, ['zeta/medio-b:free', 'openrouter/free']);
  assert.throws(() => s.runtime.save({ fallbackModels: ['a:free', 'b:free', 'c:free', 'd:free'] }), (e) => e.code === 'INVALID_ARGS' && /até 3/.test(e.message));
  assert.throws(() => s.runtime.save({ fallbackModels: 'zeta/medio-b:free' }), (e) => e.code === 'INVALID_ARGS');
  assert.throws(() => s.runtime.save({ fallbackModels: ['com espaço'] }), (e) => e.code === 'INVALID_ARGS');
  assert.throws(() => s.runtime.save({ fallbackModels: [5] }), (e) => e.code === 'INVALID_ARGS');
  // um pago na reserva com o modo ligado: recusado, e nada muda
  assert.throws(() => s.runtime.save({ fallbackModels: ['zeta/medio-b:free', 'vendor/pago-barato'] }), (e) => e.code === 'NOT_FREE' && /não é gratuito/.test(e.message));
  assert.deepEqual(s.runtime.state().provider.fallbackModels, ['zeta/medio-b:free', 'openrouter/free']);
  // desligado, a reserva pode ter modelo pago; ligar o modo de novo tira o que não é gratuito
  s.runtime.save({ freeOnly: false });
  assert.deepEqual(s.runtime.save({ fallbackModels: ['vendor/pago-barato', 'zeta/medio-b:free'] }).provider.fallbackModels, ['vendor/pago-barato', 'zeta/medio-b:free']);
  assert.deepEqual(s.runtime.save({ freeOnly: true }).provider.fallbackModels, ['zeta/medio-b:free']);
  assert.deepEqual(s.cfg().providers.openrouter.fallbackModels, ['zeta/medio-b:free']);
  // arquivo editado à mão: lixo, repetidos, demais e um id pago com o modo ligado nunca chegam ao pedido
  const cfg = s.cfg();
  cfg.providers.openrouter.fallbackModels = ['vendor/pago-caro', 5, 'zeta/medio-b:free', 'zeta/medio-b:free', 'x y', 'acme/grande-ctx:free', 'beta/pequeno-ok:free', 'edge/ctx-60000:free'];
  fs.writeFileSync(s.runtime.configFile, JSON.stringify(cfg));
  assert.deepEqual(s.runtime.state().provider.fallbackModels, ['zeta/medio-b:free', 'acme/grande-ctx:free'], 'o pago e o lixo saíram; só 3 cabem (o pago ocupava uma vaga antes de sair)');
  cfg.providers.openrouter.freeOnly = 'não é booleano';
  fs.writeFileSync(s.runtime.configFile, JSON.stringify(cfg));
  assert.equal(s.runtime.state().provider.freeOnly, true, 'só o valor false guardado desliga o modo');
  delete cfg.providers.openrouter.freeOnly;
  fs.writeFileSync(s.runtime.configFile, JSON.stringify(cfg));
  assert.equal(s.runtime.state().provider.freeOnly, true, 'sem o campo vale o padrão: ligado');
});

// ---------- o pedido de verdade ----------

test('chat no OpenRouter: o modelo vai como foi escolhido, a chave só no cabeçalho, o corpo SEM `models`/`route`/plugin pagos e a resposta diz quem respondeu', async (t) => {
  const s = await makeRuntime(t, {
    routes: { chat: (call) => ({ json: F.chatBody('{"cuts":[]}', { answered: call.body.model === 'openrouter/free' ? 'acme/grande-ctx:free' : call.body.model }) }) }
  });
  await ready(s);
  const switches = [];
  const res = await s.runtime.chat({
    system: 'sistema', messages: msgs, maxTokens: 123, temperature: 0.2, jsonMode: true, onSwitch: (ev) => switches.push(ev),
    // campos que alguém poderia pedir: o fallback PAGO do OpenRouter (cobra!), a rota e a busca na web (paga)
    extraBody: { models: ['vendor/pago-barato', 'acme/medio-a:free'], route: 'fallback', plugins: [{ id: 'web' }, { id: 'file-parser' }], provider: { sort: 'throughput' } }
  });
  assert.equal(res.text, '{"cuts":[]}');
  assert.equal(res.answeredModel, 'acme/grande-ctx:free', 'o campo `model` da resposta: quem de fato respondeu (o roteador sorteou)');
  assert.equal(res.requestedModel, 'openrouter/free');
  assert.equal(res.model, 'acme/grande-ctx:free');
  assert.deepEqual(res.provider, { id: 'openrouter', label: 'OpenRouter', model: 'openrouter/free' }, 'provider.model continua sendo o escolhido');
  assert.deepEqual(res.usage, { promptTokens: 100, completionTokens: 20, cost: 0 }, 'o custo que o OpenRouter informa (0 nos gratuitos) acompanha o uso');
  assert.deepEqual(switches, []);
  const call = chatCalls(s.mock)[0];
  assert.equal(call.headers.authorization, `Bearer ${F.KEY}`);
  assert.ok(!call.raw.includes(F.KEY) && !call.path.includes(F.KEY), 'a chave só vai no cabeçalho');
  assert.equal(call.body.model, 'openrouter/free');
  assert.equal(call.body.max_tokens, 123);
  assert.deepEqual(call.body.response_format, { type: 'json_object' });
  assert.deepEqual(call.body.models, ['acme/medio-a:free'], 'do fallback do OpenRouter sobra só o id gratuito: o pago (que COBRARIA) saiu');
  assert.equal(call.body.route, 'fallback', 'havendo fallback gratuito, a rota continua');
  assert.deepEqual(call.body.plugins, [{ id: 'file-parser' }], 'a busca na web (paga) saiu; o resto do que foi pedido fica');
  assert.deepEqual(call.body.provider, { sort: 'throughput' });
  assert.ok(!call.raw.includes('vendor/pago-barato'));
});

test('chat no OpenRouter: com o interruptor DESLIGADO (escolha explícita) o corpo segue como foi pedido e o modelo pago é enviado', async (t) => {
  const s = await makeRuntime(t);
  await ready(s, { model: 'vendor/pago-barato', freeOnly: false });
  const res = await s.runtime.chat({ messages: msgs, extraBody: { models: ['vendor/pago-caro'], route: 'fallback' } });
  assert.equal(res.requestedModel, 'vendor/pago-barato');
  const call = chatCalls(s.mock)[0];
  assert.equal(call.body.model, 'vendor/pago-barato');
  assert.deepEqual(call.body.models, ['vendor/pago-caro'], 'desligado, o corpo não é filtrado');
  assert.equal(call.body.route, 'fallback');
});

test('modelo PAGO com o interruptor ligado: recusado com NOT_FREE ANTES de qualquer pedido, em todos os caminhos (chat, teste de conexão, configuração à mão)', async (t) => {
  const s = await makeRuntime(t);
  await ready(s);
  s.runtime.save({ model: 'vendor/pago-barato' }); // forçado: o modelo é gravado, mas o provedor deixa de ficar pronto
  await assert.rejects(() => s.runtime.chat({ messages: msgs }), (e) => {
    assert.equal(e.code, 'NOT_FREE');
    assert.match(e.message, /O modelo "vendor\/pago-barato" não é gratuito/);
    assert.match(e.message, /Usar apenas modelos gratuitos/);
    assert.equal(classify(e).retry, false, 'a análise não tenta de novo');
    noKey(e, 'NOT_FREE');
    return true;
  });
  await assert.rejects(() => s.runtime.test(), (e) => e.code === 'NOT_FREE');
  await assert.rejects(() => s.runtime.chat({ messages: msgs }, { requireConsent: false }), (e) => e.code === 'NOT_FREE');
  assert.equal(chatCalls(s.mock).length, 0, 'nenhum pedido chegou ao servidor');
  // arquivo editado à mão (modelo pago, interruptor ausente = ligado)
  const cfg = JSON.parse(fs.readFileSync(s.runtime.configFile, 'utf8'));
  cfg.providers.openrouter = { model: 'google/gemini-2.5-pro' };
  fs.writeFileSync(s.runtime.configFile, JSON.stringify(cfg));
  await assert.rejects(() => s.runtime.chat({ messages: msgs }), (e) => e.code === 'NOT_FREE');
  assert.equal(chatCalls(s.mock).length, 0);
  // um modelo gratuito logo em seguida funciona
  s.runtime.save({ model: 'acme/medio-a:free' });
  await s.runtime.chat({ messages: msgs });
  assert.deepEqual(sentModels(s.mock), ['acme/medio-a:free']);
});

test('o aceite de privacidade continua valendo antes de tudo (por provedor, sem prazo): sem ele nenhum pedido sai, mesmo com modelo gratuito', async (t) => {
  const s = await makeRuntime(t);
  s.runtime.save({ provider: 'openrouter', apiKey: F.KEY, model: 'openrouter/free' });
  await s.service.modelList();
  await assert.rejects(() => s.runtime.chat({ messages: msgs }), (e) => e.code === 'CONSENT_REQUIRED');
  assert.equal(chatCalls(s.mock).length, 0);
  s.runtime.accept(true);
  s.runtime.save({ freeOnly: false });
  s.runtime.save({ freeOnly: true });
  assert.equal(s.runtime.state().accepted, true, 'mudar o interruptor não mexe no aceite (é do provedor)');
  const cfg = JSON.parse(fs.readFileSync(s.runtime.configFile, 'utf8'));
  assert.deepEqual(Object.keys(cfg.accepted.openrouter).sort(), ['at', 'baseUrl', 'origin']);
  cfg.accepted.openrouter.at = '2001-01-01T00:00:00.000Z';
  fs.writeFileSync(s.runtime.configFile, JSON.stringify(cfg));
  assert.equal(s.runtime.state().accepted, true, 'sem prazo');
  await s.runtime.chat({ messages: msgs });
  assert.equal(chatCalls(s.mock).length, 1);
  // sem chave: nada sai e o motivo é a chave
  s.runtime.save({ clearKey: true });
  await assert.rejects(() => s.runtime.chat({ messages: msgs }), (e) => e.code === 'NO_KEY');
  assert.equal(chatCalls(s.mock).length, 1);
});

// ---------- fallback entre gratuitos ----------

test('fallback: o modelo escolhido dá 429 por minuto e o app usa a PRÓXIMA reserva gratuita (a ordem do usuário), avisando a troca', async (t) => {
  const s = await makeRuntime(t, {
    routes: { chat: (call) => (call.body.model === 'acme/medio-a:free' ? F.ERRORS.rateLimitMinute(Date.now()) : { json: F.chatBody('ok', { answered: call.body.model }) }) }
  });
  await ready(s, { model: 'acme/medio-a:free', fallbackModels: ['zeta/medio-b:free', 'openrouter/free'] });
  const switches = [];
  const res = await s.runtime.chat({ messages: msgs, onSwitch: (ev) => switches.push(ev) });
  assert.deepEqual(sentModels(s.mock), ['acme/medio-a:free', 'zeta/medio-b:free'], 'tentou o escolhido e, na falha, a 1ª reserva; a 2ª nem foi precisa');
  assert.equal(res.answeredModel, 'zeta/medio-b:free');
  assert.equal(res.requestedModel, 'zeta/medio-b:free');
  assert.equal(res.provider.model, 'acme/medio-a:free');
  assert.equal(switches.length, 1);
  assert.deepEqual([switches[0].from, switches[0].to, switches[0].reason.code], ['acme/medio-a:free', 'zeta/medio-b:free', 'RATE_LIMIT']);
  // 404 por política de dados, 5xx e tempo esgotado também trocam; a ordem das reservas vale
  for (const action of [F.ERRORS.dataPolicy404(), F.ERRORS.server503(), F.ERRORS.upstream429(), F.ERRORS.modelGone404('acme/medio-a:free')]) {
    s.mock.calls.length = 0;
    s.mock.routes.chat = (call) => (call.body.model === 'acme/medio-a:free' || call.body.model === 'zeta/medio-b:free' ? action : { json: F.chatBody('ok', { answered: call.body.model }) });
    const r = await s.runtime.chat({ messages: msgs });
    assert.deepEqual(sentModels(s.mock), ['acme/medio-a:free', 'zeta/medio-b:free', 'openrouter/free'], `status ${action.status}`);
    assert.equal(r.requestedModel, 'openrouter/free');
  }
});

test('roteador gratuito que sorteia um modelo de MODERAÇÃO (medido em rede real): a resposta dele vale como falha, nunca como análise, e a reserva assume', async (t) => {
  const safety = 'nvidia/nemotron-3.5-content-safety:free';
  const isRouter = (call) => call.body.model === 'openrouter/free';
  const s = await makeRuntime(t, {
    routes: { chat: (call) => ({ json: F.chatBody(isRouter(call) ? 'User Safety: unsafe\nSafety Categories: Profanity' : 'ok', { answered: isRouter(call) ? safety : call.body.model }) }) }
  });
  // sem reserva: falha explicada em português; a análise repete o pedido (o roteador pode sortear outro modelo)
  await ready(s, { model: 'openrouter/free' });
  await assert.rejects(s.runtime.chat({ messages: msgs }), (err) => {
    assert.equal(err.code, 'BAD_RESPONSE');
    assert.match(err.message, /sorteou "nvidia\/nemotron-3\.5-content-safety:free", um modelo de moderação que não serve para esta análise/);
    assert.equal(classify(err).retry, true, 'o pedido é repetido pela análise');
    noKey(err, 'erro'); noUser(err, 'erro');
    return true;
  });
  assert.equal(chatCalls(s.mock).length, 1, 'o runtime não repete sozinho: quem repete é a análise');
  // com reserva gratuita: troca para ela e devolve a resposta dela, avisando a troca
  s.mock.calls.length = 0;
  s.runtime.save({ fallbackModels: ['acme/medio-a:free'] });
  const switches = [];
  const res = await s.runtime.chat({ messages: msgs, onSwitch: (ev) => switches.push(ev) });
  assert.deepEqual(sentModels(s.mock), ['openrouter/free', 'acme/medio-a:free']);
  assert.equal(res.answeredModel, 'acme/medio-a:free');
  assert.equal(res.text, 'ok');
  assert.deepEqual([switches[0].from, switches[0].to, switches[0].reason.code], ['openrouter/free', 'acme/medio-a:free', 'BAD_RESPONSE']);
  // um modelo FIXO escolhido pelo usuário que responde por si mesmo não passa por essa regra (a escolha é dele)
  s.mock.calls.length = 0;
  s.runtime.save({ model: 'acme/medio-a:free', fallbackModels: [] });
  assert.equal((await s.runtime.chat({ messages: msgs })).answeredModel, 'acme/medio-a:free');
});

test('fallback: 401 (chave recusada), 402, a cota do DIA, pedido recusado e moderação NÃO trocam de modelo (um pedido só) e o erro chega explicado, sem a chave', async (t) => {
  const s = await makeRuntime(t);
  await ready(s, { model: 'acme/medio-a:free', fallbackModels: ['zeta/medio-b:free'] });
  const cases = [
    [F.ERRORS.auth401(), 'AUTH', /recusou a chave/],
    [F.ERRORS.credits402(), 'CREDITS', /saldo negativo podem receber erros mesmo em modelos gratuitos/],
    [F.ERRORS.rateLimitDay(Date.now()), 'QUOTA', /acabaram.*restam 0 de 50.*renova (amanhã )?às 21:00.*US\$ 10 em créditos.*1\.000/],
    [F.ERRORS.badRequestContext(), 'BAD_REQUEST', /maior do que o contexto/],
    [{ status: 403, json: F.errorBody(403, 'Input flagged by moderation') }, 'MODERATION', /moderação/]
  ];
  for (const [action, code, re] of cases) {
    s.mock.calls.length = 0;
    s.mock.routes.chat = () => action;
    await assert.rejects(() => s.runtime.chat({ messages: msgs }), (e) => {
      assert.equal(e.code, code, `status ${action.status}`);
      assert.match(e.message, re);
      assert.equal(e.status, action.status);
      assert.ok(e.details && typeof e.details.solution === 'string', 'o que fazer vem junto');
      assert.equal(classify(e).retry, false, `${code}: a análise não repete`);
      noKey(e, code);
      assert.ok(!String(e.responseBody).includes(F.KEY), 'o corpo guardado no erro já vem sem a chave');
      return true;
    }, `status ${action.status}`);
    assert.equal(chatCalls(s.mock).length, 1, `status ${action.status}: um pedido só`);
    assert.deepEqual(sentModels(s.mock), ['acme/medio-a:free'], 'a reserva não foi tentada');
  }
});

test('fallback: o modelo que não é gratuito NUNCA vai ao servidor (nem como reserva pelo arquivo, nem como corpo) e esgotar a lista devolve o último erro explicado', async (t) => {
  const s = await makeRuntime(t, { routes: { chat: () => F.ERRORS.server503() } });
  await ready(s, { model: 'acme/medio-a:free', fallbackModels: ['zeta/medio-b:free'] });
  const cfg = s.cfg();
  cfg.providers.openrouter.fallbackModels = ['vendor/pago-barato', 'zeta/medio-b:free'];
  fs.writeFileSync(s.runtime.configFile, JSON.stringify(cfg));
  await assert.rejects(() => s.runtime.chat({ messages: msgs }), (e) => {
    assert.equal(e.code, 'SERVER');
    assert.match(e.message, /está com problema agora \(HTTP 503\)/);
    assert.match(e.message, /Tente de novo em instantes ou escolha outro modelo gratuito/);
    assert.deepEqual(e.details.models.map((m) => m.model), ['acme/medio-a:free', 'zeta/medio-b:free'], 'tentou os dois gratuitos');
    assert.equal(classify(e).retry, true, '5xx continua valendo nova tentativa pela escada da análise');
    return true;
  });
  assert.ok(!sentModels(s.mock).includes('vendor/pago-barato'), 'o pago nunca saiu');
  assert.deepEqual(sentModels(s.mock), ['acme/medio-a:free', 'zeta/medio-b:free']);
});

// ---------- erros explicados no caminho do chat ----------

test('erros explicados: 429 por minuto vira RATE_LIMIT com a espera do servidor; 404 de política de dados e de modelo removido mandam o usuário agir; a chave é retirada do eco do servidor', async (t) => {
  const s = await makeRuntime(t);
  await ready(s, { model: 'acme/medio-a:free' });
  const run = async (action) => { s.mock.routes.chat = () => action; try { await s.runtime.chat({ messages: msgs }); return null; } catch (e) { return e; } };

  const minute = await run(F.ERRORS.rateLimitMinute(Date.now()));
  assert.equal(minute.code, 'RATE_LIMIT');
  assert.ok(minute.retryAfterSec >= 25 && minute.retryAfterSec <= 31, `espera de ~30 s: ${minute.retryAfterSec}`);
  assert.match(minute.message, /20 por minuto/);
  assert.deepEqual(classify(minute), { retry: true, kind: 'rate', retryAfterSec: minute.retryAfterSec });

  const policy = await run(F.ERRORS.dataPolicy404());
  assert.equal(policy.code, 'DATA_POLICY');
  assert.match(policy.message, /podem usar o que você envia para treino ou publicação/);
  assert.match(policy.message, /Privacy na conta do OpenRouter/);
  assert.match(policy.message, /decisão sua: o app não altera a sua conta/);
  assert.equal(classify(policy).retry, false);

  const gone = await run(F.ERRORS.modelGone404('acme/medio-a:free'));
  assert.equal(gone.code, 'MODEL');
  assert.match(gone.message, /Atualize a lista de modelos/);

  const dayLimit = await run(F.ERRORS.rateLimitDay(Date.now()));
  assert.equal(dayLimit.code, 'QUOTA');
  assert.equal(classify(dayLimit).retry, false, 'QUOTA (mesmo com status 429) não é repetida');

  // o servidor ecoa a chave no erro: nada dela sobra
  const echoed = await run({ status: 400, json: F.errorBody(400, `pedido ruim, key=${F.KEY}`) });
  assert.equal(echoed.code, 'BAD_REQUEST');
  for (const e of [minute, policy, gone, dayLimit, echoed]) noKey(e, e.code);
  assert.ok(!JSON.stringify(echoed.details).includes(F.KEY));

  // erros sem status (rede, tempo esgotado) seguem com a mensagem de origem
  s.mock.routes.chat = () => ({ drop: true });
  await assert.rejects(() => s.runtime.chat({ messages: msgs }), (e) => ['NETWORK', 'INTERRUPTED'].includes(e.code) && !/HTTP/.test(e.message));
});

test('Pacer: ~3 s entre os pedidos ao OpenRouter e a espera que o servidor mandar num 429 por minuto vale para o próximo', async (t) => {
  const s = await makeRuntime(t);
  await ready(s);
  await s.runtime.chat({ messages: msgs });
  assert.deepEqual(s.sleeps, [], 'o primeiro sai sem espera');
  await s.runtime.chat({ messages: msgs });
  await s.runtime.chat({ messages: msgs });
  assert.equal(s.sleeps.length, 2);
  assert.ok(s.sleeps[0] > 2500 && s.sleeps[0] <= 3000, `3 s entre o 1º e o 2º pedido: ${s.sleeps}`);
  assert.ok(s.sleeps[1] > 5500 && s.sleeps[1] <= 6000, `em fila (aqui a espera é só anotada): o 3º sai 3 s depois do 2º: ${s.sleeps}`);
  // cancelar antes de esperar: não envia
  const ctrl = new AbortController();
  ctrl.abort();
  const before = chatCalls(s.mock).length;
  await assert.rejects(() => s.runtime.chat({ messages: msgs, signal: ctrl.signal }), (e) => e.code === 'CANCELLED');
  assert.equal(chatCalls(s.mock).length, before);
  // 429 por minuto com a troca de modelo: o Pacer recebe a espera mandada
  s.service.pacer.reset();
  s.mock.routes.chat = (call) => (call.body.model === 'acme/medio-a:free' ? F.ERRORS.rateLimitMinute(Date.now()) : { json: F.chatBody('ok', { answered: call.body.model }) });
  s.runtime.save({ model: 'acme/medio-a:free', fallbackModels: ['zeta/medio-b:free'] });
  await s.runtime.chat({ messages: msgs });
  assert.ok(s.service.pacer.nextAt - Date.now() > 20000, 'o próximo pedido ao OpenRouter espera o que o servidor mandou');
});

// ---------- antes da análise ----------

test('prepare(): confere a lista pública antes da análise (cache de 6 h; sem rede, o último cache ou só o sufixo) e avisa; não faz nada fora do modo gratuito', async (t) => {
  const clock = { t: Date.now(), now() { return this.t; } };
  clock.now = clock.now.bind(clock);
  let down = false;
  const s = await makeRuntime(t, { clock, routes: { models: () => (down ? { drop: true } : { json: F.catalogBody() }) } });
  // fora do modo gratuito ou de outro provedor: nada a conferir
  assert.deepEqual(await s.runtime.prepare(), { checked: false, source: null, fetchedAt: null, warning: null });
  s.runtime.save({ provider: 'groq', model: 'm', apiKey: F.KEY });
  assert.equal((await s.runtime.prepare()).checked, false);
  s.runtime.save({ provider: 'openrouter', apiKey: F.KEY, model: 'openrouter/free', freeOnly: false });
  assert.equal((await s.runtime.prepare()).checked, false);
  assert.equal(s.mock.calls.length, 0);
  // modo gratuito: baixa a lista, depois usa o cache
  s.runtime.save({ freeOnly: true });
  const first = await s.runtime.prepare();
  assert.deepEqual([first.checked, first.source, first.warning], [true, 'rede', null]);
  assert.equal((await s.runtime.prepare()).source, 'cache');
  assert.equal(s.mock.count('GET', '/api/v1/models'), 1);
  assert.equal(s.mock.calls[0].headers.authorization, undefined, 'a lista é pública: sem chave');
  // sem rede e o cache velho: segue com o último e avisa com a data
  clock.t += 7 * 3600000;
  down = true;
  const old = await s.runtime.prepare();
  assert.equal(old.source, 'cache-antigo');
  assert.equal(old.warning.code, 'FREE_LIST_OLD');
  assert.match(old.warning.message, /Sem conexão com o OpenRouter: a conferência dos modelos gratuitos usou a lista de \d{2}\/\d{2} às \d{2}:\d{2}\./);
  // sem rede e sem lista nenhuma: só o roteador e o sufixo ":free" valem, e o aviso diz isso
  fs.rmSync(path.join(s.dir, 'ai', 'openrouter-models.json'));
  const none = await s.runtime.prepare();
  assert.equal(none.source, 'nenhum');
  assert.equal(none.warning.code, 'FREE_LIST_MISSING');
  assert.match(none.warning.message, /só valem o roteador gratuito e os modelos com o sufixo ":free"/);
  // com o hospedeiro (BDS) nada disso existe
  const host = new AiRuntime({ dir: path.join(s.dir, 'host-ai'), safeStorage: F.fakeSafeStorage(), restrict: () => {}, openrouter: s.service, host: { describe: () => ({ id: 'openrouter', label: 'OpenRouter', model: 'm', hasKey: true, ready: true }), chat: async () => ({ text: 'ok', model: 'quem/respondeu:free' }) }, hostName: 'BDS' });
  assert.equal((await host.prepare()).checked, false);
});

// ---------- hospedeiro (BDS) ----------

test('provedor do hospedeiro (BDS) = OpenRouter: o modo gratuito vale também lá (modelo pago recusado antes de enviar, gratuito passa, a cadeia do BDS é filtrada, interruptor daqui); outros provedores do BDS seguem como eram', async (t) => {
  const dir = F.tmpDir('bf-or-host-');
  t.after(() => F.cleanup(dir));
  const mock = await F.startMockOpenRouter();
  t.after(() => mock.close());
  const service = createOpenRouterService({ dir: path.join(dir, 'ai'), baseUrl: mock.base });
  await service.modelList(); // o catálogo (do servidor de teste) fica no computador: o guard decide com ele
  let active = { id: 'openrouter', label: 'OpenRouter', model: 'vendor/pago-barato', hasKey: true, ready: true, serverHost: 'openrouter.ai' };
  const seen = [];
  const host = { describe: () => active, chat: async (params) => { seen.push(params); return { text: 'ok', model: active.model }; } };
  const runtime = new AiRuntime({ dir: path.join(dir, 'ai'), safeStorage: F.fakeSafeStorage(), restrict: () => {}, host, hostName: 'BDS', openrouter: service });

  // 1) o assistente do BDS usa um modelo PAGO do OpenRouter: com o modo ligado (padrão) o provedor não fica pronto e nada vai ao BDS
  let st = runtime.state();
  assert.equal(st.source, 'host');
  assert.deepEqual([st.provider.freeCapable, st.provider.freeOnly, st.provider.ready, st.provider.reasonCode], [true, true, false, 'NOT_FREE']);
  assert.match(st.provider.reason, /vendor\/pago-barato.*não é gratuito.*assistente do BDS usa o OpenRouter.*nada foi enviado e nada foi cobrado.*"openrouter\/free"/);
  assert.ok(st.provider.privacy.endsWith(FREE_MODE_PRIVACY), 'o aviso de privacidade ganha o parágrafo dos modelos gratuitos');
  runtime.accept(true);
  await assert.rejects(() => runtime.chat({ messages: msgs }), (e) => e.code === 'NOT_FREE' && /não é gratuito/.test(e.message));
  assert.equal(seen.length, 0, 'nada foi ao hospedeiro');

  // 2) modelo gratuito: passa; o hospedeiro recebe o filtro da cadeia dele (fallback) e o modelo que respondeu é registrado
  active = { ...active, model: 'acme/medio-a:free' };
  st = runtime.state();
  assert.deepEqual([st.provider.ready, st.provider.freeOnly], [true, true]);
  const res = await runtime.chat({ messages: msgs, jsonMode: true });
  assert.equal(seen.length, 1);
  assert.equal(res.answeredModel, 'acme/medio-a:free');
  assert.equal(typeof seen[0].acceptProvider, 'function');
  const accept = seen[0].acceptProvider;
  assert.deepEqual(
    [accept({ serverHost: 'openrouter.ai', model: 'vendor/pago-barato' }), accept({ serverHost: 'openrouter.ai', model: 'acme/medio-a:free' }), accept({ serverHost: 'api.groq.com', model: 'llama-x' }), accept({ serverHost: '', model: 'x' }), accept(null)],
    [false, true, true, true, true], 'só o OpenRouter pago é recusado na cadeia; outros provedores passam'
  );
  assert.equal(runtime.secretFor('openrouter'), null, 'o Braga Frame nunca tem a chave do BDS');
  assert.equal(chatCalls(mock).length, 0, 'nada foi ao OpenRouter por conta do Braga Frame');

  // 3) o BDS recusa a cadeia inteira (AI_NOT_ALLOWED): chega como NOT_FREE explicado
  host.chat = async () => { throw Object.assign(new Error('recusado'), { code: 'AI_NOT_ALLOWED' }); };
  await assert.rejects(() => runtime.chat({ messages: msgs }), (e) => e.code === 'NOT_FREE' && /assistente do BDS usa o OpenRouter/.test(e.message));
  host.chat = async (params) => { seen.push(params); return { text: 'ok', model: active.model }; };

  // 4) o interruptor é daqui (só ele: o resto continua só leitura) e desligar é explícito: aí vale qualquer modelo e o hospedeiro não recebe filtro
  assert.throws(() => runtime.save({ model: 'x' }), (e) => e.code === 'INVALID_ARGS' && /configurado no BDS/.test(e.message));
  assert.throws(() => runtime.save({ freeOnly: false, model: 'x' }), (e) => e.code === 'INVALID_ARGS' && /configurado no BDS/.test(e.message));
  assert.throws(() => runtime.save({ freeOnly: 'não' }), (e) => e.code === 'INVALID_ARGS');
  active = { ...active, model: 'vendor/pago-barato' };
  const off = runtime.save({ freeOnly: false }).provider;
  assert.deepEqual([off.freeOnly, off.ready, off.reasonCode], [false, true, undefined]);
  assert.ok(!off.privacy.includes(FREE_MODE_PRIVACY), 'desligado, o parágrafo some');
  seen.length = 0;
  await runtime.chat({ messages: msgs });
  assert.equal(seen.length, 1);
  assert.ok(!('acceptProvider' in seen[0]), 'desligado, o hospedeiro não recebe filtro');
  const again = runtime.save({ freeOnly: true }).provider;
  assert.deepEqual([again.freeOnly, again.ready, again.reasonCode], [true, false, 'NOT_FREE'], 'ligar de novo traz a recusa de volta');
  assert.equal(JSON.parse(fs.readFileSync(runtime.configFile, 'utf8')).providers.openrouter.freeOnly, true, 'o interruptor é guardado por provedor (OpenRouter), como no app próprio');

  // 5) a lista pública é conferida antes da análise (nada do usuário sai nesse passo); com o modo desligado ou outro provedor nem isso
  assert.equal((await runtime.prepare()).checked, true);
  runtime.save({ freeOnly: false });
  assert.equal((await runtime.prepare()).checked, false);

  // 6) outro provedor do BDS (Groq): sem modo gratuito, sem interruptor, como era
  active = { id: 'groq', label: 'Groq', model: 'llama-x', hasKey: true, ready: true, serverHost: 'api.groq.com' };
  runtime.accept(true); // o aceite é por provedor ("host:groq" é outro destinatário)
  st = runtime.state();
  assert.deepEqual([st.provider.freeCapable, st.provider.freeOnly, st.provider.ready, st.provider.reasonCode], [undefined, undefined, true, undefined]);
  assert.throws(() => runtime.save({ freeOnly: true }), (e) => e.code === 'INVALID_ARGS' && /só existe quando o provedor do assistente é o OpenRouter/.test(e.message));
  seen.length = 0;
  await runtime.chat({ messages: msgs });
  assert.ok(!('acceptProvider' in seen[0]));
  assert.equal((await runtime.prepare()).checked, false);
});

// ---------- o cliente ----------

test('cliente: `beforeSend` dá a última palavra a CADA tentativa (inclusive a repetida sem response_format), pode barrar o pedido e trocar o corpo; `extraBody` não sobrescreve o essencial', async (t) => {
  const mock = await F.startMockOpenRouter({ chat: (call) => (call.body.response_format ? { status: 400, json: F.errorBody(400, "Unsupported parameter: 'response_format'") } : { json: F.chatBody('{"x":1}', { answered: 'quem/respondeu:free' }) }) });
  t.after(() => mock.close());
  const seen = [];
  const res = await chatCompletion({
    baseUrl: mock.base, apiKey: F.KEY, model: 'acme/medio-a:free', messages: msgs, jsonMode: true, maxTokens: 50,
    extraBody: { model: 'vendor/pago-barato', messages: [], stream: true, models: ['x:free'], route: 'fallback' },
    beforeSend: (body) => { seen.push(JSON.parse(JSON.stringify(body))); const { models, route, ...rest } = body; void models; void route; return rest; }
  });
  assert.equal(res.text, '{"x":1}');
  assert.equal(res.model, 'quem/respondeu:free', 'o campo `model` da resposta');
  assert.equal(seen.length, 2, 'beforeSend rodou na 1ª tentativa e na repetida sem response_format');
  assert.ok(seen[0].response_format && !seen[1].response_format);
  assert.ok(seen.every((b) => b.model === 'acme/medio-a:free' && b.stream === false && b.messages.length === 1), 'extraBody nunca sobrescreve model, messages nem stream');
  for (const call of chatCalls(mock)) assert.ok(!('models' in call.body) && !('route' in call.body), 'o corpo que SAIU é o devolvido por beforeSend');
  // beforeSend lança: o pedido nem sai
  const before = mock.calls.length;
  await assert.rejects(() => chatCompletion({ baseUrl: mock.base, apiKey: F.KEY, model: 'm', messages: msgs, beforeSend: () => { throw Object.assign(new Error('não pode'), { code: 'NOT_FREE' }); } }), (e) => e.code === 'NOT_FREE');
  assert.equal(mock.calls.length, before);
  // sem beforeSend nem extraBody: tudo como antes
  const plain = await chatCompletion({ baseUrl: mock.base, model: 'm', messages: msgs });
  assert.equal(plain.model, 'quem/respondeu:free');
  assert.deepEqual(Object.keys(chatCalls(mock).at(-1).body).sort(), ['messages', 'model', 'stream']);
});

test('cliente: o erro HTTP leva `responseBody` (sem a chave, até ~2 mil caracteres) e só os cabeçalhos de limite de uso; HTTP 200 com corpo { error } é erro', async (t) => {
  const long = 'x'.repeat(5000);
  const mock = await F.startMockOpenRouter({ chat: (call) => {
    if (call.body.model === 'longo') return { status: 500, headers: { 'set-cookie': 'sessao=segredo', 'x-ratelimit-remaining': '3', 'retry-after': '9', 'x-outro': 'nao' }, text: `${long} ${F.KEY}` };
    if (call.body.model === 'ok-com-erro') return { json: { error: { code: 429, message: 'Provider returned error', metadata: { raw: `slow ${F.KEY}`, provider_name: 'Acme Cloud' } } } };
    if (call.body.model === 'ok-com-erro-sem-codigo') return { json: { error: { message: 'quebrou no provedor' } } };
    return F.ERRORS.auth401();
  } });
  t.after(() => mock.close());
  await assert.rejects(() => chatCompletion({ baseUrl: mock.base, apiKey: F.KEY, model: 'longo', messages: msgs }), (e) => {
    assert.equal(e.code, 'SERVER');
    assert.equal(e.status, 500);
    assert.ok(e.responseBody.length <= 2000, `corpo guardado: ${e.responseBody.length}`);
    assert.ok(!e.responseBody.includes(F.KEY));
    assert.deepEqual(e.responseHeaders, { 'retry-after': '9', 'x-ratelimit-remaining': '3' }, 'só os de limite de uso: nada de cookie nem o resto');
    assert.equal(e.retryAfterSec, 9);
    noKey(e, 'erro 500');
    return true;
  });
  await assert.rejects(() => chatCompletion({ baseUrl: mock.base, apiKey: F.KEY, model: 'qualquer', messages: msgs }), (e) => {
    assert.equal(e.code, 'AUTH');
    assert.match(e.responseBody, /Invalid API key/);
    assert.ok(!e.responseBody.includes(F.KEY), 'o eco da chave foi retirado do corpo guardado');
    return true;
  });
  // HTTP 200 com { error } e sem choices: erro HTTP de verdade (status vem de error.code), com o corpo
  await assert.rejects(() => chatCompletion({ baseUrl: mock.base, apiKey: F.KEY, model: 'ok-com-erro', messages: msgs }), (e) => {
    assert.equal(e.code, 'RATE_LIMIT');
    assert.equal(e.status, 429);
    assert.match(e.responseBody, /Acme Cloud/);
    assert.ok(!e.responseBody.includes(F.KEY));
    return true;
  });
  await assert.rejects(() => chatCompletion({ baseUrl: mock.base, apiKey: F.KEY, model: 'ok-com-erro-sem-codigo', messages: msgs }), (e) => e.code === 'SERVER' && e.status === 502 && /quebrou no provedor/.test(e.message));
  // as respostas do OpenRouter que NÃO são erro seguem valendo
  const fine = await F.startMockOpenRouter({ chat: () => ({ json: { choices: [{ message: { content: 'oi' } }] } }) });
  t.after(() => fine.close());
  const ok = await chatCompletion({ baseUrl: fine.base, model: 'm', messages: msgs });
  assert.equal(ok.text, 'oi');
  assert.equal(ok.model, null, 'sem o campo `model` na resposta: null');
});

// ---------- formatos observados em rede real ----------

test('cliente: a resposta observada em rede real (modelo sorteado, usage.cost 0, raciocínio dentro de completion_tokens): só `message.content` vale e `message.reasoning` NUNCA vira resposta', async (t) => {
  const answered = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
  const mock = await F.startMockOpenRouter({
    chat: () => ({ json: F.chatBody('{"ok":true}', { answered, reasoning: 'Preciso pensar. Talvez {"ok":false} seja melhor.', reasoningTokens: 75, completionTokens: 98 }) })
  });
  t.after(() => mock.close());
  const res = await chatCompletion({ baseUrl: mock.base, apiKey: F.KEY, model: 'openrouter/free', messages: msgs, jsonMode: true, maxTokens: 300 });
  assert.equal(res.text, '{"ok":true}', 'o JSON vem só do conteúdo');
  assert.ok(!res.text.includes('pensar') && !JSON.stringify(res).includes('Talvez'), 'o raciocínio não vaza para o resultado');
  assert.equal(res.model, answered, 'o campo `model` difere do pedido (o roteador sorteou)');
  assert.equal(res.finishReason, 'stop');
  assert.deepEqual(res.usage, { promptTokens: 100, completionTokens: 98, cost: 0 }, 'completion_tokens já inclui os 75 do raciocínio');
  assert.equal(chatCalls(mock)[0].body.model, 'openrouter/free');
  assert.deepEqual(chatCalls(mock)[0].body.response_format, { type: 'json_object' });

  // cortado pelo limite de saída enquanto "pensava": sem conteúdo, o raciocínio (mesmo com cara de JSON) NÃO é resposta
  mock.routes.chat = () => ({ json: F.chatBody('', { answered, reasoning: '{"candidates":[{"id":"c1"}]}', reasoningTokens: 300, completionTokens: 300, finishReason: 'length' }) });
  const cut = await chatCompletion({ baseUrl: mock.base, apiKey: F.KEY, model: 'openrouter/free', messages: msgs, jsonMode: true, maxTokens: 300 });
  assert.equal(cut.text, '');
  assert.equal(cut.finishReason, 'length', 'quem chama vê que foi cortada e pede mais espaço');
  // conteúdo nulo (alguns provedores) e em partes (lista de blocos de texto)
  mock.routes.chat = () => ({ json: { ...F.chatBody('x', { answered }), choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: null, reasoning: 'só pensamento' } }] } });
  assert.equal((await chatCompletion({ baseUrl: mock.base, model: 'm', messages: msgs })).text, '');
  mock.routes.chat = () => ({ json: { ...F.chatBody('x', { answered }), choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }], reasoning: 'ignorado' } }] } });
  assert.equal((await chatCompletion({ baseUrl: mock.base, model: 'm', messages: msgs })).text, '{"a":1}');
  // sem `usage.cost` na resposta (outros provedores): o campo não existe
  mock.routes.chat = () => ({ json: { choices: [{ message: { content: 'oi' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } } });
  assert.deepEqual((await chatCompletion({ baseUrl: mock.base, model: 'm', messages: msgs })).usage, { promptTokens: 3, completionTokens: 2 });
});

test('modelo inválido = HTTP 400 "is not a valid model ID" (observado em rede real, não é 404): o cliente diz MODEL, a reserva gratuita é tentada e o user_id da conta não aparece em lugar nenhum', async (t) => {
  // 1) o cliente sozinho (serve a qualquer provedor): MODEL, sem repetir e sem o user_id
  const bad = await F.startMockOpenRouter({ chat: () => F.ERRORS.invalidModel400('x/y') });
  t.after(() => bad.close());
  await assert.rejects(() => chatCompletion({ baseUrl: bad.base, apiKey: F.KEY, model: 'x/y', messages: msgs, jsonMode: true }), (e) => {
    assert.equal(e.code, 'MODEL');
    assert.equal(e.status, 400);
    assert.match(e.message, /não reconhece o modelo/);
    assert.match(e.responseBody, /is not a valid model ID/, 'o corpo guardado ajuda a explicar a falha');
    assert.match(e.responseBody, /"user_id":"•••"/, 'mas o identificador da conta já vem apagado');
    noUser(e, 'erro do cliente');
    noKey(e, 'erro do cliente');
    assert.equal(classify(e).retry, false);
    return true;
  });
  assert.equal(chatCalls(bad).length, 1, 'MODEL não se repete, nem sem response_format');
  // um 400 sobre response_format NÃO é "modelo inválido": continua BAD_REQUEST e repete sem JSON (o que o cliente já fazia)
  const fmt = await F.startMockOpenRouter({ chat: (call) => (call.body.response_format ? { status: 400, json: F.errorBody(400, "Unsupported parameter: 'response_format' for model x/y") } : { json: F.chatBody('ok') }) });
  t.after(() => fmt.close());
  assert.equal((await chatCompletion({ baseUrl: fmt.base, apiKey: F.KEY, model: 'x/y', messages: msgs, jsonMode: true })).text, 'ok');

  // 2) o runtime: com reserva, troca; sem reserva, o erro chega explicado
  const s = await makeRuntime(t, { routes: { chat: (call) => (call.body.model === 'acme/medio-a:free' ? F.ERRORS.invalidModel400(call.body.model) : { json: F.chatBody('ok', { answered: call.body.model }) }) } });
  await ready(s, { model: 'acme/medio-a:free', fallbackModels: ['zeta/medio-b:free'] });
  const switches = [];
  const res = await s.runtime.chat({ messages: msgs, onSwitch: (ev) => switches.push(ev) });
  assert.equal(res.answeredModel, 'zeta/medio-b:free');
  assert.deepEqual(switches.map((ev) => [ev.from, ev.to, ev.reason.code]), [['acme/medio-a:free', 'zeta/medio-b:free', 'MODEL']]);
  noUser(switches, 'evento de troca');
  s.runtime.save({ fallbackModels: [] });
  s.mock.calls.length = 0;
  await assert.rejects(() => s.runtime.chat({ messages: msgs }), (e) => {
    assert.equal(e.code, 'MODEL');
    assert.equal(e.status, 400);
    assert.match(e.message, /O OpenRouter não reconhece "acme\/medio-a:free": o nome pode estar errado ou o modelo foi removido\. Atualize a lista de modelos e escolha outro modelo gratuito\./);
    assert.ok(e.details && /Atualize a lista/.test(e.details.solution));
    assert.equal(classify(e).retry, false);
    noUser(e, 'erro do runtime');
    noKey(e, 'erro do runtime');
    return true;
  });
  assert.equal(chatCalls(s.mock).length, 1);
  // o `user_id` vem em todo corpo de erro do servidor de teste: nenhum erro mapeado pode trazê-lo
  for (const action of [F.ERRORS.auth401(), F.ERRORS.dataPolicy404(), F.ERRORS.rateLimitDay(Date.now()), F.ERRORS.rateLimitMinute(Date.now()), F.ERRORS.upstream429(), F.ERRORS.credits402(), F.ERRORS.server503(), F.ERRORS.badRequestContext()]) {
    s.mock.routes.chat = () => action;
    await assert.rejects(() => s.runtime.chat({ messages: msgs }), (e) => { noUser(e, `status ${action.status}`); noKey(e, `status ${action.status}`); return true; }, `status ${action.status}`);
  }
});

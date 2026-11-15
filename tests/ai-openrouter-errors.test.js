'use strict';

/**
 * OpenRouter "só com modelos gratuitos", erros explicados em português. ATENÇÃO: os corpos de erro usados aqui foram MONTADOS conforme a
 * documentação do OpenRouter (tests/ai-openrouter-fakes.js, ERRORS), não capturados em rede real: a classificação é tolerante e estes
 * testes provam essa tolerância (status + trechos da mensagem + cabeçalhos), não que o OpenRouter use exatamente estas frases.
 * EXCEÇÃO, OBSERVADA em rede real em 23/10/2026: modelo inválido = HTTP 400 `{"error":{"message":"<id> is not a valid model ID","code":400},
 * "user_id":"user_…"}` (`ERRORS.invalidModel400`); o `user_id` da conta nunca pode aparecer em nenhuma mensagem.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { mapOpenRouterError, mapThrownError, fullMessage, redactSecret } = require('../src/core/ai/openrouter/errors');
const F = require('./ai-openrouter-fakes');

const NOW = Date.UTC(2026, 9, 23, 17, 0, 0); // 14:00 em Brasília
const MODEL = 'acme/medio-a:free';

/** Passa um fixture do servidor de teste (status, cabeçalhos, JSON) pelo mapeamento. */
const map = (action, extra = {}) => mapOpenRouterError({ status: action.status, body: action.json !== undefined ? JSON.stringify(action.json) : action.text, headers: action.headers, model: MODEL, now: NOW, apiKey: F.KEY, ...extra });

test('429 por MINUTO: espera e tenta de novo, usando o Retry-After quando houver (senão 20 s)', () => {
  const withHeader = map(F.ERRORS.rateLimitMinute(NOW));
  assert.equal(withHeader.code, 'RATE_LIMIT');
  assert.equal(withHeader.scope, 'minute');
  assert.equal(withHeader.retryable, true);
  assert.equal(withHeader.retryAfterMs, 30000, 'o maior entre Retry-After (7 s) e X-RateLimit-Reset (30 s)');
  assert.equal(withHeader.status, 429);
  assert.match(withHeader.message, /por minuto/);
  assert.match(withHeader.message, /20 por minuto/);
  assert.match(withHeader.solution, /tenta de novo sozinho/);
  const bare = map(F.ERRORS.rateLimitMinuteNoHeaders());
  assert.deepEqual([bare.code, bare.scope, bare.retryable, bare.retryAfterMs], ['RATE_LIMIT', 'minute', true, 20000]);
  // só o cabeçalho de renovação (sem texto): perto = por minuto, longe = do dia
  assert.equal(mapOpenRouterError({ status: 429, body: '', headers: { 'x-ratelimit-reset': String(NOW + 30000) }, now: NOW }).scope, 'minute');
  assert.equal(mapOpenRouterError({ status: 429, body: '', headers: { 'retry-after': '20' }, now: NOW }).scope, 'minute');
});

test('429 do DIA: mostra o que resta, quando renova (horário de Brasília) e que com US$ 10 o limite sobe para 1.000; não adianta esperar nem trocar de modelo', () => {
  const day = map(F.ERRORS.rateLimitDay(NOW));
  assert.equal(day.code, 'QUOTA');
  assert.equal(day.scope, 'day');
  assert.equal(day.retryable, false);
  assert.match(day.message, /pedidos gratuitos de hoje do OpenRouter acabaram/);
  assert.match(day.message, /restam 0 de 50/);
  assert.match(day.solution, /renova às 21:00 \(horário de Brasília/);
  assert.match(day.solution, /US\$ 10 em créditos/);
  assert.match(day.solution, /1\.000 pedidos/);
  assert.equal(day.retryAfterMs, Date.UTC(2026, 9, 24, 0, 0, 0) - NOW, 'até a meia-noite UTC');
  // depois das 21:00 em Brasília a renovação é "amanhã"
  assert.match(map(F.ERRORS.rateLimitDay(NOW), { now: Date.UTC(2026, 9, 24, 1, 0) }).solution, /renova amanhã às 21:00/);
  // limite de 1.000 zerado, só pelos cabeçalhos
  const thousand = mapOpenRouterError({ status: 429, body: '', headers: { 'x-ratelimit-limit': '1000', 'x-ratelimit-remaining': '0' }, now: NOW });
  assert.equal(thousand.code, 'QUOTA');
  assert.match(thousand.message, /restam 0 de 1000/);
  // renovação a horas de distância
  assert.equal(mapOpenRouterError({ status: 429, body: '', headers: { 'x-ratelimit-reset': String(NOW + 3 * 3600000) }, now: NOW }).code, 'QUOTA');
  // com o resultado de GET /key à mão, o texto usa os números dele
  const withInfo = map(F.ERRORS.rateLimitDay(NOW), { keyInfo: { freeDaily: { used: 50, limit: 50, remaining: 0 } } });
  assert.match(withInfo.message, /restam 0 de 50/);
});

test('429 do PROVEDOR do modelo ("upstream"): é limite do modelo, não da conta; vale esperar pouco e/ou trocar de modelo', () => {
  const up = map(F.ERRORS.upstream429());
  assert.equal(up.code, 'RATE_LIMIT');
  assert.equal(up.scope, 'upstream');
  assert.equal(up.retryable, true);
  assert.equal(up.retryAfterMs, 5000);
  assert.match(up.message, /Acme Cloud/);
  assert.match(up.message, /acme\/medio-a:free/);
  assert.match(up.message, /não da sua conta/);
  assert.match(up.solution, /outro modelo gratuito/);
  // mensagem do provedor que fala em "daily" NÃO esgota a cota da conta
  const providerDaily = map({ status: 429, json: F.errorBody(429, 'Provider returned error', { raw: 'daily quota exceeded for this model', provider_name: 'Acme Cloud' }) });
  assert.equal(providerDaily.code, 'RATE_LIMIT');
  assert.equal(providerDaily.scope, 'upstream');
  // 429 sem nenhuma pista: limite de uso genérico, tenta de novo com calma
  const unknown = mapOpenRouterError({ status: 429, body: 'too many requests', now: NOW });
  assert.deepEqual([unknown.code, unknown.retryable, unknown.retryAfterMs, unknown.scope], ['RATE_LIMIT', true, 10000, null]);
});

test('404 por política de dados da conta: explica que modelos gratuitos exigem aceitar provedores que podem treinar, que é decisão do usuário e que o app não altera a conta', () => {
  const policy = map(F.ERRORS.dataPolicy404());
  assert.equal(policy.code, 'DATA_POLICY');
  assert.equal(policy.retryable, false);
  assert.equal(policy.status, 404);
  assert.match(policy.message, /acme\/medio-a:free/);
  assert.match(policy.message, /treino ou publicação/);
  assert.match(policy.solution, /em Privacy na conta do OpenRouter/);
  assert.match(policy.solution, /podem treinar com as entradas/);
  assert.match(policy.solution, /decisão sua/);
  assert.match(policy.solution, /o app não altera a sua conta/);
  assert.match(policy.solution, /Usar apenas modelos gratuitos/);
  // variações de redação
  for (const message of ['No allowed providers are available for the selected model due to your privacy settings', 'No endpoints available matching your guardrail restrictions and data policy', 'Free model publication is disabled: see https://openrouter.ai/settings/privacy']) {
    assert.equal(mapOpenRouterError({ status: 404, body: JSON.stringify(F.errorBody(404, message)), now: NOW }).code, 'DATA_POLICY', message);
  }
});

test('404 de outro tipo: modelo expirado, removido ou indisponível -> mandar atualizar a lista', () => {
  const gone = map(F.ERRORS.modelGone404(MODEL));
  assert.equal(gone.code, 'MODEL');
  assert.equal(gone.retryable, false);
  assert.match(gone.message, /acme\/medio-a:free/);
  assert.match(gone.message, /expirado, sido removido ou estar indisponível/);
  assert.match(gone.solution, /Atualize a lista/);
  // corpo vazio ou ilegível também vira "modelo não encontrado"
  for (const body of [undefined, '', '{', null, '<html>404</html>']) assert.equal(mapOpenRouterError({ status: 404, body, model: MODEL, now: NOW }).code, 'MODEL');
});

test('400 "is not a valid model ID" (OBSERVADO em rede real; não é 404): modelo inválido ou removido -> atualizar a lista, sem o user_id da conta', () => {
  const r = map(F.ERRORS.invalidModel400(MODEL));
  assert.equal(r.code, 'MODEL');
  assert.equal(r.status, 400);
  assert.equal(r.retryable, false);
  assert.match(r.message, /não reconhece "acme\/medio-a:free"/);
  assert.match(r.solution, /Atualize a lista de modelos e escolha outro modelo gratuito/);
  const text = JSON.stringify(r);
  assert.ok(!text.includes(F.USER_ID) && !/user_/.test(text), 'o user_id da conta nunca aparece');
  // variações do texto do servidor
  for (const message of ['x/y is not a valid model ID', 'Invalid model: x/y', 'Unknown model "x/y"', 'No such model: x/y', 'The model `x/y` does not exist', 'model x/y not found']) {
    assert.equal(map({ status: 400, json: F.errorBody(400, message) }).code, 'MODEL', message);
  }
  // um 400 que fala de response_format/JSON, ou do contexto, NÃO é "modelo inválido"
  assert.equal(map({ status: 400, json: F.errorBody(400, 'Model x/y does not support response_format json_object') }).code, 'BAD_REQUEST');
  assert.equal(map(F.ERRORS.badRequestContext()).code, 'BAD_REQUEST');
  assert.equal(map({ status: 400, json: F.errorBody(400, 'messages must not be empty') }).code, 'BAD_REQUEST');
  // o erro que o cliente monta (status + mensagem com um trecho do que o servidor disse) também vira "modelo inválido"
  const viaClient = Object.assign(new Error('O provedor recusou o pedido (HTTP 400). (acme/medio-a:free is not a valid model ID)'), { status: 400, code: 'BAD_REQUEST' });
  assert.equal(mapThrownError(viaClient, { model: MODEL, now: NOW }).code, 'MODEL');
});

test('o user_id da conta (que o OpenRouter repete no corpo dos erros) NUNCA aparece nas mensagens', () => {
  const actions = [
    F.ERRORS.invalidModel400(MODEL), F.ERRORS.auth401(), F.ERRORS.dataPolicy404(), F.ERRORS.modelGone404(MODEL), F.ERRORS.rateLimitDay(NOW), F.ERRORS.rateLimitMinute(NOW),
    F.ERRORS.upstream429(), F.ERRORS.server503(), F.ERRORS.credits402(), F.ERRORS.badRequestContext(),
    { status: 400, json: { error: { message: `falhou para ${F.USER_ID}`, code: 400 }, user_id: F.USER_ID } },
    { status: 418, text: `{"error":{"message":"x"},"user_id":"${F.USER_ID}"}` }
  ];
  for (const action of actions) {
    const text = JSON.stringify(map(action));
    assert.ok(!text.includes(F.USER_ID) && !/user_/.test(text), `${action.status}: ${text}`);
  }
  assert.equal(redactSecret(`{"error":{"message":"x"},"user_id":"${F.USER_ID}"}`), '{"error":{"message":"x"},"user_id":"•••"}');
  assert.equal(redactSecret(`conta ${F.USER_ID} fim`), 'conta ••• fim');
  assert.equal(redactSecret('user_settings_page e user_id continuam'), 'user_settings_page e user_id continuam', 'texto comum não é apagado');
});

test('402 / saldo: contas com saldo negativo podem receber erro até em modelos gratuitos', () => {
  const credits = map(F.ERRORS.credits402());
  assert.equal(credits.code, 'CREDITS');
  assert.equal(credits.retryable, false);
  assert.match(credits.message, /saldo da conta/);
  assert.match(credits.solution, /saldo negativo podem receber erros mesmo em modelos gratuitos/);
  // o texto também vale em outro status 4xx (menos 429)
  assert.equal(mapOpenRouterError({ status: 403, body: JSON.stringify(F.errorBody(403, 'Your account has a negative balance')), now: NOW }).code, 'CREDITS');
  assert.equal(mapOpenRouterError({ status: 429, body: JSON.stringify(F.errorBody(429, 'Insufficient credits')), now: NOW }).code, 'RATE_LIMIT', '429 continua sendo limite');
});

test('401/403 chave, moderação, 400, 5xx e o que não se conhece', () => {
  const auth = map(F.ERRORS.auth401());
  assert.equal(auth.code, 'AUTH');
  assert.match(auth.message, /recusou a chave/);
  assert.equal(map({ status: 403, json: F.errorBody(403, 'Input flagged by moderation', { reasons: ['violence'] }) }).code, 'MODERATION');
  assert.equal(map({ status: 403, json: F.errorBody(403, 'forbidden') }).code, 'AUTH');
  const ctx = map(F.ERRORS.badRequestContext());
  assert.equal(ctx.code, 'BAD_REQUEST');
  assert.match(ctx.message, /maior do que o contexto/);
  assert.match(ctx.solution, /Minutos por bloco/);
  const bad = map({ status: 400, json: F.errorBody(400, 'messages must not be empty') });
  assert.equal(bad.code, 'BAD_REQUEST');
  assert.match(bad.message, /messages must not be empty/);
  for (const action of [F.ERRORS.server503(), F.ERRORS.server500(), { status: 408, text: 'timeout' }, { status: 502, text: 'bad gateway' }]) {
    const e = map(action);
    assert.equal(e.code, 'SERVER', JSON.stringify(action));
    assert.equal(e.retryable, true);
  }
  assert.match(map(F.ERRORS.server503()).message, /provedor Acme Cloud/);
  const odd = mapOpenRouterError({ status: 418, body: 'sou um bule', now: NOW });
  assert.deepEqual([odd.code, odd.retryable], ['UNKNOWN', false]);
  assert.match(odd.message, /HTTP 418/);
  assert.equal(mapOpenRouterError({}).code, 'UNKNOWN', 'sem nada');
  assert.equal(mapOpenRouterError().code, 'UNKNOWN');
});

test('o corpo do erro pode vir como texto, objeto, Buffer ou lixo, e a resposta tem sempre os mesmos campos', () => {
  const fields = ['code', 'message', 'solution', 'retryable', 'retryAfterMs', 'status', 'scope'];
  const base = F.ERRORS.dataPolicy404().json;
  for (const body of [JSON.stringify(base), base, Buffer.from(JSON.stringify(base)), [base], JSON.stringify([base])]) {
    const r = mapOpenRouterError({ status: 404, body, now: NOW });
    assert.equal(r.code, 'DATA_POLICY');
    assert.deepEqual(Object.keys(r).sort(), [...fields].sort());
  }
  for (const body of [undefined, null, 5, true, '', '   ', '{"error":', '[]', '{"error":5}', { error: null }, { error: { message: 5 } }, Symbol.iterator.toString()]) {
    for (const status of [0, 400, 401, 402, 403, 404, 429, 500, 'x', undefined]) {
      const r = mapOpenRouterError({ status, body, now: NOW });
      assert.deepEqual(Object.keys(r).sort(), [...fields].sort());
      assert.equal(typeof r.message, 'string');
      assert.ok(r.message.length > 5);
    }
  }
});

test('a chave NUNCA aparece nas mensagens, mesmo quando o servidor a repete no erro', () => {
  const echoes = [
    F.ERRORS.auth401(),
    { status: 400, json: F.errorBody(400, `bad request, key=${F.KEY}`) },
    { status: 500, json: F.errorBody(500, `boom Bearer ${F.KEY}`, { raw: `trace ${F.KEY}` }) },
    { status: 418, text: `Authorization: Bearer ${F.KEY}` },
    { status: 404, json: F.errorBody(404, `no endpoints for ${F.KEY}`) },
    { status: 429, json: F.errorBody(429, `slow down ${F.KEY}`) }
  ];
  for (const action of echoes) {
    for (const apiKey of [F.KEY, undefined]) {
      const r = map(action, { apiKey });
      const text = JSON.stringify(r);
      assert.ok(!text.includes(F.KEY), `${action.status} (apiKey ${apiKey ? 'conhecida' : 'desconhecida'}): ${text}`);
      assert.ok(!text.includes('sk-or-v1'), `${action.status}: nem pedaço`);
    }
  }
  assert.equal(redactSecret(`falhou ${F.KEY} fim`, F.KEY), 'falhou ••• fim');
  assert.equal(redactSecret('Authorization: Bearer abcdefghijklmnop123', null), 'Authorization: Bearer •••');
  assert.equal(redactSecret(`trecho ${F.KEY_LABEL} aqui`, null).includes('sk-or-v1-bfte'), false);
  assert.equal(redactSecret(undefined), '');
});

test('mapThrownError: usa status, corpo e cabeçalhos guardados no erro; sem eles, o texto da mensagem; erros sem status passam com a mensagem', () => {
  // erro com o formato que a fase 2 pede ao cliente (status, responseBody, responseHeaders, retryAfterSec)
  const rich = Object.assign(new Error('HTTP 429'), { status: 429, code: 'RATE_LIMIT', responseBody: JSON.stringify(F.ERRORS.rateLimitDay(NOW).json), responseHeaders: { 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '0' } });
  assert.equal(mapThrownError(rich, { model: MODEL, now: NOW }).code, 'QUOTA');
  // erro do cliente de hoje: só o status e a mensagem em português com um trecho do que o servidor disse
  const today = Object.assign(new Error('O provedor não encontrou o modelo (ou o endereço). Confira o nome do modelo. (No endpoints found matching your data policy (Free model training). Configure: https://openrouter.ai/settings/privacy)'), { status: 404, code: 'MODEL' });
  assert.equal(mapThrownError(today, { model: MODEL, now: NOW }).code, 'DATA_POLICY');
  const plain404 = Object.assign(new Error('O provedor não encontrou o modelo (ou o endereço). Confira o nome do modelo.'), { status: 404, code: 'MODEL' });
  assert.equal(mapThrownError(plain404, { model: MODEL, now: NOW }).code, 'MODEL');
  // o 429 genérico do cliente de hoje não vira "limite do dia" por engano (a frase dele fala em "cota ou pedidos por minuto")
  const generic429 = Object.assign(new Error('O provedor atingiu o limite de uso (cota ou pedidos por minuto).'), { status: 429, code: 'RATE_LIMIT', retryAfterSec: 12 });
  const g = mapThrownError(generic429, { model: MODEL, now: NOW });
  assert.deepEqual([g.code, g.retryable, g.retryAfterMs], ['RATE_LIMIT', true, 12000]);
  const generic429Day = Object.assign(new Error('O provedor atingiu o limite de uso (cota ou pedidos por minuto). (Rate limit exceeded: free-models-per-day)'), { status: 429, code: 'RATE_LIMIT' });
  assert.equal(mapThrownError(generic429Day, { model: MODEL, now: NOW }).code, 'QUOTA');
  // sem status
  const net = Object.assign(new Error(`Não foi possível falar com o provedor ${F.KEY}`), { code: 'NETWORK' });
  const n = mapThrownError(net, { model: MODEL, apiKey: F.KEY });
  assert.deepEqual([n.code, n.retryable, n.status], ['NETWORK', true, null]);
  assert.ok(!JSON.stringify(n).includes(F.KEY));
  const notFree = mapThrownError(Object.assign(new Error('O modelo "x" não é gratuito.'), { code: 'NOT_FREE' }));
  assert.deepEqual([notFree.code, notFree.retryable, notFree.solution], ['NOT_FREE', false, '']);
  assert.equal(mapThrownError(null), null);
  assert.equal(mapThrownError(new Error('sem nada')).code, 'UNKNOWN');
  // texto pronto para a tela
  assert.equal(fullMessage({ message: 'A.', solution: 'B.' }), 'A. B.');
  assert.equal(fullMessage({ message: 'A.', solution: '' }), 'A.');
  assert.equal(fullMessage(null), '');
});

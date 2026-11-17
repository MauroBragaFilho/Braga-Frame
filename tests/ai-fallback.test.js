'use strict';

/**
 * Reserva entre provedores (src/core/ai/runtime.js): o provedor escolhido falha por limite de uso, cota ou erro do servidor e o app passa
 * ao próximo; o que NÃO troca; o aviso de privacidade de cada um; o limite de tokens por minuto que o provedor informa e os limites
 * efetivos da análise (blocos menores). O provedor escolhido é um servidor HTTP local de verdade; a Groq é um `fetch` falso.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AiRuntime, MAX_FALLBACK_PROVIDERS } = require('../src/core/ai/runtime');
const F = require('./ai-fakes');

const GROQ = 'https://api.groq.com/openai/v1';
const ok = (content = '{"cuts":[]}', headers) => ({ json: F.chatBody(content), ...(headers ? { headers } : {}) });
const msgs = [{ role: 'user', content: 'oi' }];

/** Resposta no formato mínimo que o cliente lê (o fetch falso da Groq). */
function groqReply({ status = 200, content = '{"x":1}', headers = {}, message = 'erro' } = {}) {
  const text = JSON.stringify(status < 400 ? F.chatBody(content) : { error: { message } });
  return { ok: status < 400, status, headers: new Map(Object.entries(headers)), text: async () => text };
}

function runtimeIn(t, over = {}) {
  const dir = F.tmpDir();
  t.after(() => F.cleanup(dir));
  const runtime = new AiRuntime({ dir: path.join(dir, 'ai'), safeStorage: F.fakeSafeStorage(), restrict: () => {}, ...over });
  return { dir, runtime };
}

/** Provedor escolhido = servidor local (Personalizado); reserva = Groq (configurada e aceita), com a resposta dada por `groq(n, corpo)`. */
async function setup(t, { main = () => ok(), groq = () => groqReply() } = {}) {
  const mock = await F.startMockAi(main);
  t.after(() => mock.close());
  const groqCalls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith(GROQ)) {
      const call = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
      groqCalls.push(call);
      return groq(groqCalls.length, call.body);
    }
    return fetch(url, init);
  };
  const clock = { t: 1000000 };
  const { runtime, dir } = runtimeIn(t, { fetchImpl, now: () => clock.t });
  runtime.save({ provider: 'groq', apiKey: F.KEY, model: 'llama-3.3-70b-versatile' });
  runtime.accept(true);
  runtime.save({ provider: 'custom', baseUrl: mock.base, model: 'm', apiKey: F.KEY });
  runtime.accept(true);
  runtime.save({ fallback: ['groq'] });
  return { runtime, mock, groqCalls, clock, dir };
}

test('reserva: o provedor escolhido falha por limite de uso, o app passa ao próximo e as chamadas seguintes vão direto a ele até o resfriamento acabar', async (t) => {
  const s = await setup(t, { main: (call) => (call.n === 1 ? { status: 429, json: { error: { message: 'limite' } }, headers: { 'retry-after': '20' } } : ok('{"de":"principal"}')) });
  const switches = [];
  const first = await s.runtime.chat({ messages: msgs, onSwitch: (e) => switches.push(e) });
  assert.equal(first.provider.id, 'groq');
  assert.equal(first.text, '{"x":1}');
  assert.equal(switches.length, 1);
  assert.deepEqual([switches[0].from, switches[0].to, switches[0].reason.code], ['Personalizado (m)', 'Groq (llama-3.3-70b-versatile)', 'RATE_LIMIT']);
  assert.equal(s.mock.calls.length, 1);
  assert.equal(s.groqCalls.length, 1);
  assert.equal(s.groqCalls[0].headers.authorization, `Bearer ${F.KEY}`, 'a chave de cada provedor vai só para ele');
  assert.equal(s.groqCalls[0].body.model, 'llama-3.3-70b-versatile');
  // o principal está de lado (20 s): a segunda chamada vai direto à Groq, sem tentar o principal nem avisar troca
  const second = await s.runtime.chat({ messages: msgs, onSwitch: (e) => switches.push(e) });
  assert.equal(second.provider.id, 'groq');
  assert.equal(s.mock.calls.length, 1, 'o principal não foi tentado de novo');
  assert.equal(switches.length, 1);
  // passado o resfriamento, o principal volta
  s.clock.t += 21000;
  const third = await s.runtime.chat({ messages: msgs });
  assert.equal(third.provider.id, 'custom');
  assert.equal(third.text, '{"de":"principal"}');
  assert.equal(s.mock.calls.length, 2);
  assert.equal(s.groqCalls.length, 2);
});

test('reserva: erro do servidor, rede e cota também trocam; cada um fica de lado pelo tempo certo', async (t) => {
  for (const [label, action, restMs] of [
    ['erro do servidor', { status: 503, json: { error: { message: 'fora' } } }, 30000],
    ['cota (o provedor mandou esperar 2 h)', { status: 429, json: { error: { message: 'cota' } }, headers: { 'retry-after': '7200' } }, 7200000]
  ]) {
    const s = await setup(t, { main: (call) => (call.n === 1 ? action : ok()) });
    const r = await s.runtime.chat({ messages: msgs });
    assert.equal(r.provider.id, 'groq', label);
    s.clock.t += restMs - 1000;
    await s.runtime.chat({ messages: msgs });
    assert.equal(s.mock.calls.length, 1, `${label}: ainda de lado`);
    s.clock.t += 2000;
    assert.equal((await s.runtime.chat({ messages: msgs })).provider.id, 'custom', `${label}: voltou`);
  }
  // rede: o provedor escolhido nem responde
  const s = await setup(t);
  s.runtime.fetchImpl = async (url) => {
    if (String(url).startsWith(GROQ)) return groqReply();
    throw new Error('sem rede');
  };
  assert.equal((await s.runtime.chat({ messages: msgs })).provider.id, 'groq');
});

test('reserva: chave recusada, modelo inexistente ou pedido recusado no provedor escolhido NÃO trocam (o problema é a configuração)', async (t) => {
  for (const [status, code] of [[401, 'AUTH'], [404, 'MODEL'], [400, 'BAD_REQUEST']]) {
    const s = await setup(t, { main: () => ({ status, json: { error: { message: 'não' } } }) });
    await assert.rejects(() => s.runtime.chat({ messages: msgs }), (e) => e.code === code, String(status));
    assert.equal(s.groqCalls.length, 0, `HTTP ${status}: a reserva não recebeu nada`);
  }
});

test('reserva: sem o aviso de privacidade aceito a Groq não recebe nada; com toda a cadeia falhando vale o erro do primeiro', async (t) => {
  const s = await setup(t, { main: () => ({ status: 500, json: { error: { message: 'principal fora' } } }), groq: () => groqReply({ status: 503, message: 'groq fora' }) });
  s.runtime.accept(false, 'groq');
  assert.equal(s.runtime.state().fallback.providers[0].accepted, false);
  await assert.rejects(() => s.runtime.chat({ messages: msgs }), (e) => e.code === 'SERVER' && /principal fora/.test(e.message));
  assert.equal(s.groqCalls.length, 0, 'sem aceite nada vai à reserva');
  s.runtime.accept(true, 'groq');
  s.clock.t += 60000;
  await assert.rejects(() => s.runtime.chat({ messages: msgs }), (e) => e.code === 'SERVER' && /principal fora/.test(e.message), 'o erro é o do provedor escolhido');
  assert.equal(s.groqCalls.length, 1, 'agora a Groq foi tentada, e falhou também');
  // "Testar conexão" fala só com o provedor escolhido
  const before = s.groqCalls.length;
  await assert.rejects(() => s.runtime.test(), (e) => e.code === 'SERVER');
  assert.equal(s.groqCalls.length, before);
});

test('reserva: se todos estão de lado, tenta na ordem mesmo assim (o resfriamento nunca deixa a análise sem provedor)', async (t) => {
  const s = await setup(t, { main: (call) => (call.n <= 1 ? { status: 503, json: { error: { message: 'fora' } } } : ok('{"de":"principal"}')), groq: (n) => (n === 1 ? groqReply({ status: 503 }) : groqReply()) });
  await assert.rejects(() => s.runtime.chat({ messages: msgs }), (e) => e.code === 'SERVER'); // os dois falham e ficam de lado
  const r = await s.runtime.chat({ messages: msgs });
  assert.equal(r.provider.id, 'custom', 'os dois de lado: tenta na ordem de novo, e o principal respondeu');
});

test('limite por minuto: o app lê o cabeçalho da Groq, guarda e encolhe os limites da análise; limite folgado não muda nada', async (t) => {
  const s = await setup(t, { main: () => ({ status: 500, json: { error: { message: 'x' } } }), groq: () => groqReply({ headers: { 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '7000' } }) });
  const base = s.runtime.limits();
  assert.equal(s.runtime.effectiveLimits().limitedBy, undefined, 'antes de saber o limite nada muda');
  await s.runtime.chat({ messages: msgs });
  const st = s.runtime.state();
  assert.equal(st.fallback.providers[0].tokensPerMinute, 8000);
  assert.deepEqual(st.effectiveLimits, { ...base, maxInputTokens: 5700, maxOutputTokens: 2000, limitedBy: { id: 'groq', label: 'Groq', tokensPerMinute: 8000 } });
  assert.equal(s.runtime.limits().maxInputTokens, 24000, 'os limites do usuário não mudam');
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'ai', 'config.json'), 'utf8')).providers.groq.tpm, 8000, 'o limite fica guardado');
  assert.ok(!JSON.stringify(st).includes(F.KEY));
  // limite folgado: os limites do usuário valem
  s.runtime._learnTpm('groq', 250000);
  assert.equal(s.runtime.effectiveLimits().limitedBy, undefined);
  // limite pequeno demais: a Groq é dispensada, com o motivo na tela, e não limita os blocos
  s.runtime._learnTpm('groq', 3000);
  const small = s.runtime.state();
  assert.equal(small.fallback.providers[0].usable, false);
  assert.match(small.fallback.providers[0].note, /pequeno demais/);
  assert.equal(small.effectiveLimits.limitedBy, undefined);
  s.groqCalls.length = 0;
  await assert.rejects(() => s.runtime.chat({ messages: msgs }), (e) => e.code === 'SERVER');
  assert.equal(s.groqCalls.length, 0, 'um provedor sem limite que sirva não recebe pedido');
  // sem o aviso aceito a reserva não conta para o tamanho dos blocos
  s.runtime._learnTpm('groq', 8000);
  assert.equal(s.runtime.effectiveLimits().maxInputTokens, 5700);
  s.runtime.accept(false, 'groq');
  assert.equal(s.runtime.effectiveLimits().limitedBy, undefined);
  // o limite do provedor ESCOLHIDO também vale
  s.runtime.accept(true, 'groq');
  s.runtime.save({ provider: 'groq' });
  assert.equal(s.runtime.effectiveLimits().limitedBy.id, 'groq');
  // outra chave pode ser de outro plano: o limite guardado é esquecido
  s.runtime.save({ apiKey: `${F.KEY}2` });
  assert.equal(s.runtime.state().provider.tokensPerMinute, null);
});

test('limite por minuto: o 429 também traz os cabeçalhos, e o app aprende com ele', async (t) => {
  const s = await setup(t, { main: () => ({ status: 500, json: { error: { message: 'x' } } }), groq: () => groqReply({ status: 429, headers: { 'x-ratelimit-limit-tokens': '12000', 'retry-after': '30' } }) });
  await assert.rejects(() => s.runtime.chat({ messages: msgs }), (e) => e.code === 'SERVER');
  assert.equal(s.runtime.state().fallback.providers[0].tokensPerMinute, 12000);
  // só quem fala a verdade nos cabeçalhos: um servidor próprio pode repassar os de outro provedor
  s.runtime._learnTpm('custom', 9000);
  assert.equal(s.runtime.state().provider.tokensPerMinute, null);
});

test('limite por minuto: o pedido que não cabe nem sai; a saída encolhe para caber', async (t) => {
  const s = await setup(t, { main: () => ({ status: 500, json: { error: { message: 'x' } } }) });
  s.runtime._learnTpm('groq', 20000);
  const big = [{ role: 'user', content: 'x'.repeat(80000) }]; // ~25 mil tokens
  await assert.rejects(() => s.runtime.chat({ messages: big, maxTokens: 6000 }), (e) => e.code === 'SERVER');
  assert.equal(s.groqCalls.length, 0, 'não cabe no limite da Groq: nem foi enviado');
  s.clock.t += 60000;
  const mid = [{ role: 'user', content: 'x'.repeat(32000) }]; // ~10 mil tokens
  await s.runtime.chat({ messages: mid, maxTokens: 12000 });
  assert.equal(s.groqCalls.length, 1);
  assert.equal(s.groqCalls[0].body.max_tokens, 9700, '20000 - 10000 de entrada - 300 de folga');
});

test('provedores de reserva: validação, ordem, o escolhido sai da lista e o aviso é de cada provedor', async (t) => {
  const { runtime, dir } = runtimeIn(t);
  runtime.save({ provider: 'custom', baseUrl: 'https://servidor.exemplo/v1', model: 'm' });
  assert.throws(() => runtime.save({ fallback: ['xx'] }), (e) => e.code === 'INVALID_ARGS');
  assert.throws(() => runtime.save({ fallback: ['gemini', 'groq', 'openrouter', 'custom'] }), (e) => e.code === 'INVALID_ARGS' && new RegExp(String(MAX_FALLBACK_PROVIDERS)).test(e.message));
  assert.throws(() => runtime.save({ fallback: 'groq' }), (e) => e.code === 'INVALID_ARGS');
  const st = runtime.save({ fallback: ['custom', 'groq', 'gemini'] });
  assert.deepEqual(st.fallback.ids, ['groq', 'gemini'], 'sem o escolhido e sem repetir');
  assert.deepEqual(st.fallback.options.map((o) => o.id), ['gemini', 'groq', 'openrouter']);
  assert.equal(st.fallback.max, 3);
  const [groq] = st.fallback.providers;
  assert.deepEqual([groq.id, groq.ready, groq.accepted], ['groq', false, false]);
  assert.match(groq.reason, /Informe o modelo|Informe a chave/);
  // o aviso de um provedor de reserva é só dele
  assert.throws(() => runtime.accept(true, 'nope'), (e) => e.code === 'INVALID_ARGS');
  runtime.accept(true, 'groq');
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'ai', 'config.json'), 'utf8'));
  assert.deepEqual(Object.keys(cfg.accepted), ['groq']);
  assert.equal(cfg.accepted.groq.origin, 'https://api.groq.com');
  assert.deepEqual(cfg.fallback, ['groq', 'gemini']);
  assert.equal(runtime.state().accepted, false, 'o do provedor escolhido continua pendente');
  runtime.accept(false, 'groq');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'ai', 'config.json'), 'utf8')).accepted), []);
  // o provedor escolhido pode mudar sem perder a lista; o que virou escolhido some da lista mostrada
  runtime.save({ provider: 'groq' });
  assert.deepEqual(runtime.state().fallback.providers.map((p) => p.id), ['gemini']);
  assert.deepEqual(runtime.state().fallback.options.map((o) => o.id), ['gemini', 'openrouter', 'custom']);
  // Personalizado sem endereço não aceita aviso como reserva
  const { runtime: r2 } = runtimeIn(t);
  r2.save({ provider: 'groq' });
  assert.throws(() => r2.accept(true, 'custom'), (e) => e.code === 'NOT_CONFIGURED');
});

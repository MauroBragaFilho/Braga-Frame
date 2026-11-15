'use strict';

/**
 * OpenRouter "só com modelos gratuitos", limites: quantos pedidos gratuitos restam (GET /key), a renovação à meia-noite UTC dita em
 * horário de Brasília, o espaçamento mínimo entre chamadas (Pacer) e a leitura de Retry-After/X-RateLimit-Reset. A CHAVE só vai no
 * cabeçalho do pedido e nunca volta em resultado, erro ou texto.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchKeyInfo, normalizeFreeDaily, describeEstimate, describeReset, nextResetUtc, formatBrasiliaClock, retryDelayMs, getHeader, Pacer, LimitsError
} = require('../src/core/ai/openrouter/limits');
const { createOpenRouterService } = require('../src/core/ai/openrouter');
const F = require('./ai-openrouter-fakes');

const NOW = Date.UTC(2026, 9, 23, 17, 0, 0); // 23/10/2026 17:00 UTC = 14:00 em Brasília

async function mockWith(t, route) {
  const mock = await F.startMockOpenRouter({ key: route });
  t.after(() => mock.close());
  return mock;
}

// ---------- GET /key ----------

test('fetchKeyInfo: GET /key (formato OBSERVADO em rede real) com a chave só no cabeçalho; devolve os pedidos gratuitos de hoje e NADA da chave (nem o "label" mascarado)', async (t) => {
  const expiresAt = '2026-10-24T17:30:00.000Z';
  const mock = await mockWith(t, (call) => (call.headers.authorization === `Bearer ${F.KEY}` ? { json: F.keyBody({ used: 12, limit: 50, expiresAt }) } : F.ERRORS.auth401()));
  const info = await fetchKeyInfo({ baseUrl: mock.base, key: F.KEY, now: () => NOW });
  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assert.equal(call.method, 'GET');
  assert.equal(call.path, '/api/v1/key');
  assert.equal(call.headers.authorization, `Bearer ${F.KEY}`);
  assert.ok(!call.raw.includes(F.KEY) && call.raw === '', 'sem corpo, e a chave não está na URL');
  assert.deepEqual(info.freeDaily, { used: 12, limit: 50, remaining: 38 });
  assert.equal(info.isFreeTier, true);
  assert.equal(info.expiresAt, expiresAt, 'chaves temporárias expiram: expires_at (ISO) vem como expiresAt');
  assert.equal(info.limit, 0.1, 'teto em US$ da CHAVE (ela pode gastar com modelo pago até aí)');
  assert.equal(info.limitRemaining, 0.1);
  assert.equal(info.usage, 0);
  assert.equal(info.usageDaily, 0);
  assert.equal(info.fetchedAt, new Date(NOW).toISOString());
  assert.equal(info.resetAt, '2026-10-24T00:00:00.000Z');
  assert.equal(info.resetText, 'renova às 21:00');
  const text = JSON.stringify(info);
  assert.ok(!text.includes(F.KEY) && !text.includes(F.KEY_LABEL) && !text.includes('sk-or'), 'a chave não volta');
  for (const field of ['label', 'rate_limit', 'rateLimit', 'budgets', 'effective_budget']) assert.ok(!(field in info), `${field} não é repassado`);
});

test('fetchKeyInfo: expires_at só vale se for um instante válido; sem ele (chave comum) é null', async () => {
  const cases = [
    [{ data: { expires_at: '2026-10-24T08:32:11Z', free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } }, '2026-10-24T08:32:11.000Z'],
    [{ data: { expires_at: null, free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } }, null],
    [{ data: { expires_at: 'amanhã', free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } }, null],
    [{ data: { expires_at: 1790000000, free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } }, null],
    [{ data: { free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } }, null]
  ];
  for (const [body, expected] of cases) {
    const mock = await F.startMockOpenRouter({ key: () => ({ json: body }) });
    try {
      const info = await fetchKeyInfo({ baseUrl: mock.base, key: F.KEY, now: () => NOW });
      assert.equal(info.expiresAt, expected, JSON.stringify(body));
    } finally { await mock.close(); }
  }
});

test('fetchKeyInfo é tolerante com o resto do formato (assumido): camelCase, números em texto, raiz sem "data", terceiro número calculado; `rate_limit` (obsoleto) é ignorado', async (t) => {
  const bodies = [
    [{ data: { free_model_daily_requests: { used: '12', limit: '50', remaining: '38' } } }, { used: 12, limit: 50, remaining: 38 }],
    [{ data: { freeModelDailyRequests: { used: 3, limit: 1000 } } }, { used: 3, limit: 1000, remaining: 997 }],
    [{ data: { free_model_daily_requests: { limit: 50, remaining: 10 } } }, { used: 40, limit: 50, remaining: 10 }],
    [{ data: { free_model_daily_requests: { used: 20, remaining: 30 } } }, { used: 20, limit: 50, remaining: 30 }],
    [{ free_model_daily_requests: { used: 1, limit: 50, remaining: 49 } }, { used: 1, limit: 50, remaining: 49 }],
    // o campo antigo dentro de `rate_limit` (obsoleto no OpenRouter) NÃO vale: sem o campo novo, o contador não está disponível
    [{ data: { rate_limit: { free_model_daily_requests: { used: 1, limit: 50, remaining: 49 } } } }, null],
    [{ data: { rate_limit: { free_model_daily_requests: { used: 1, limit: 50, remaining: 49 } }, free_model_daily_requests: { used: 7, limit: 50, remaining: 43 } } }, { used: 7, limit: 50, remaining: 43 }],
    [{ data: { free_model_daily_requests: { used: 60, limit: 50, remaining: -10 } } }, { used: 60, limit: 50, remaining: 0 }],
    // sem o campo, ou sem números suficientes: nada inventado
    [{ data: { usage: 0 } }, null],
    [{ data: { free_model_daily_requests: { used: 5 } } }, null],
    [{ data: { free_model_daily_requests: 'muitos' } }, null],
    [{ data: { free_model_daily_requests: { used: 'x', limit: 'y', remaining: 'z' } } }, null]
  ];
  for (const [body, expected] of bodies) {
    const mock = await F.startMockOpenRouter({ key: () => ({ json: body }) });
    try {
      const info = await fetchKeyInfo({ baseUrl: mock.base, key: F.KEY, now: () => NOW });
      assert.deepEqual(info.freeDaily, expected, JSON.stringify(body));
    } finally { await mock.close(); }
  }
  assert.equal(normalizeFreeDaily(null), null);
  assert.equal(normalizeFreeDaily('x'), null);
  // créditos e plano
  const mock = await F.startMockOpenRouter({ key: () => ({ json: { data: { limit: 10, limit_remaining: 7.5, usage: 2.5, is_free_tier: false, free_model_daily_requests: { used: 0, limit: 1000, remaining: 1000 } } } }) });
  t.after(() => mock.close());
  const rich = await fetchKeyInfo({ baseUrl: mock.base, key: F.KEY, now: () => NOW });
  assert.deepEqual([rich.limit, rich.limitRemaining, rich.usage, rich.isFreeTier], [10, 7.5, 2.5, false]);
});

test('fetchKeyInfo: cada falha vira um código estável, com mensagem em português SEM a chave (mesmo se o servidor ecoar a chave)', async () => {
  const cases = [
    [F.ERRORS.auth401(), 'AUTH', /recusou a chave/],
    [{ status: 403, json: F.errorBody(403, `forbidden ${F.KEY}`) }, 'AUTH', /recusou a chave/],
    [{ status: 429, headers: { 'retry-after': '9' }, json: F.errorBody(429, 'devagar') }, 'RATE_LIMIT', /esperar/],
    [F.ERRORS.server503(), 'SERVER', /problema/],
    [{ status: 502, text: 'bad gateway' }, 'SERVER', /problema/],
    [{ status: 418, json: F.errorBody(418, `bule ${F.KEY}`) }, 'BAD_RESPONSE', /HTTP 418/],
    [{ text: '<html>ola</html>' }, 'BAD_RESPONSE', /não é a informação da chave/],
    [{ json: [1, 2] }, 'BAD_RESPONSE', null],
    [{ text: 'null' }, 'BAD_RESPONSE', null]
  ];
  for (const [action, code, re] of cases) {
    const mock = await F.startMockOpenRouter({ key: () => action });
    try {
      await assert.rejects(() => fetchKeyInfo({ baseUrl: mock.base, key: F.KEY }), (e) => {
        assert.ok(e instanceof LimitsError);
        assert.equal(e.code, code, JSON.stringify(action));
        if (re) assert.match(e.message, re);
        const all = `${e.message}|${JSON.stringify(e)}|${e.stack}`;
        assert.ok(!all.includes(F.KEY), 'a chave não aparece no erro');
        assert.ok(!all.includes('sk-or'), 'nem pedaço dela');
        return true;
      });
    } finally { await mock.close(); }
  }
  const mock = await F.startMockOpenRouter({ key: () => ({ status: 429, headers: { 'retry-after': '9' }, json: {} }) });
  try {
    await assert.rejects(() => fetchKeyInfo({ baseUrl: mock.base, key: F.KEY }), (e) => e.retryAfterMs === 9000);
  } finally { await mock.close(); }
});

test('fetchKeyInfo: sem chave, endereço inseguro, rede fora do ar, tempo esgotado e cancelamento', async (t) => {
  for (const key of [undefined, null, '', '   ', 5]) {
    await assert.rejects(() => fetchKeyInfo({ baseUrl: 'http://127.0.0.1:9/api/v1', key }), (e) => e.code === 'NO_KEY', String(key));
  }
  // a chave nunca vai por http:// a um servidor que não é a própria máquina (e nem chega a fazer o pedido)
  let called = 0;
  const fetchImpl = async () => { called += 1; throw new Error('não devia chamar'); };
  await assert.rejects(() => fetchKeyInfo({ baseUrl: 'http://openrouter.exemplo/api/v1', key: F.KEY, fetchImpl }), (e) => e.code === 'KEY_INSECURE' && !e.message.includes(F.KEY));
  assert.equal(called, 0);
  // porta fechada
  const closed = await F.startMockOpenRouter();
  const base = closed.base;
  await closed.close();
  await assert.rejects(() => fetchKeyInfo({ baseUrl: base, key: F.KEY }), (e) => e.code === 'NETWORK' && !e.message.includes(F.KEY));
  // tempo esgotado
  const hang = await mockWith(t, () => ({ hang: true }));
  await assert.rejects(() => fetchKeyInfo({ baseUrl: hang.base, key: F.KEY, timeoutMs: 120 }), (e) => e.code === 'TIMEOUT');
  // cancelamento no meio e antes de começar
  const ctrl = new AbortController();
  const pending = fetchKeyInfo({ baseUrl: hang.base, key: F.KEY, signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 60);
  await assert.rejects(() => pending, (e) => e.code === 'CANCELLED');
  await assert.rejects(() => fetchKeyInfo({ baseUrl: hang.base, key: F.KEY, signal: ctrl.signal }), (e) => e.code === 'CANCELLED');
  // endereço inválido
  await assert.rejects(() => fetchKeyInfo({ baseUrl: 'isto não é url', key: F.KEY }), (e) => e.code === 'NO_KEY' || e.code === 'KEY_INSECURE' || e.code === 'NETWORK');
});

// ---------- renovação (00:00 UTC) em Brasília ----------

test('a cota diária renova à meia-noite UTC = 21:00 em Brasília ("renova às 21:00" ou "renova amanhã às 21:00")', () => {
  assert.equal(new Date(nextResetUtc(Date.UTC(2026, 9, 23, 14, 30))).toISOString(), '2026-10-24T00:00:00.000Z');
  assert.equal(new Date(nextResetUtc(Date.UTC(2026, 9, 24, 0, 0, 0))).toISOString(), '2026-10-25T00:00:00.000Z', 'exatamente 00:00 UTC: o próximo é o do dia seguinte');
  assert.equal(new Date(nextResetUtc(Date.UTC(2026, 11, 31, 23, 59))).toISOString(), '2027-01-01T00:00:00.000Z', 'virada de ano');
  assert.equal(formatBrasiliaClock(Date.UTC(2026, 9, 24, 0, 0)), '21:00');
  assert.equal(formatBrasiliaClock(Date.UTC(2026, 9, 24, 3, 30)), '00:30');
  // 14:00 em Brasília: renova hoje às 21:00
  assert.deepEqual(describeReset(Date.UTC(2026, 9, 23, 17, 0)), { resetAt: '2026-10-24T00:00:00.000Z', text: 'renova às 21:00' });
  // 22:00 em Brasília (01:00 UTC do dia seguinte): a próxima renovação é amanhã às 21:00
  assert.deepEqual(describeReset(Date.UTC(2026, 9, 24, 1, 0)), { resetAt: '2026-10-25T00:00:00.000Z', text: 'renova amanhã às 21:00' });
  // 21:00 em Brasília em ponto: a de hoje acabou de passar
  assert.equal(describeReset(Date.UTC(2026, 9, 24, 0, 0)).text, 'renova amanhã às 21:00');
  // 00:30 em Brasília (03:30 UTC): ainda é "hoje" no calendário de lá
  assert.equal(describeReset(Date.UTC(2026, 9, 24, 3, 30)).text, 'renova às 21:00');
});

test('sem dados de fuso horário no Intl, o horário de Brasília cai para UTC-3 fixo (sem horário de verão desde 2019)', () => {
  const original = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function broken() { throw new RangeError('sem fuso'); };
  try {
    assert.equal(formatBrasiliaClock(Date.UTC(2026, 9, 24, 0, 0)), '21:00');
    assert.equal(describeReset(Date.UTC(2026, 9, 23, 17, 0)).text, 'renova às 21:00');
    assert.equal(describeReset(Date.UTC(2026, 9, 24, 1, 0)).text, 'renova amanhã às 21:00');
  } finally {
    Intl.DateTimeFormat = original;
  }
});

// ---------- cabeçalhos ----------

test('Retry-After e X-RateLimit-Reset: segundos, data HTTP, instante em ms ou em s; o maior vale; limitado a 24 h', () => {
  const now = Date.UTC(2026, 9, 23, 17, 0, 0);
  const h = (obj) => obj;
  assert.equal(retryDelayMs(h({ 'retry-after': '7' }), now), 7000);
  assert.equal(retryDelayMs(h({ 'Retry-After': '1.2' }), now), 1200);
  assert.equal(retryDelayMs(h({ 'retry-after': new Date(now + 30000).toUTCString() }), now), 30000);
  assert.equal(retryDelayMs(h({ 'retry-after': new Date(now - 30000).toUTCString() }), now), 0);
  assert.equal(retryDelayMs(h({ 'x-ratelimit-reset': String(now + 45000) }), now), 45000, 'instante em ms');
  assert.equal(retryDelayMs(h({ 'x-ratelimit-reset': String((now + 45000) / 1000) }), now), 45000, 'instante em s');
  assert.equal(retryDelayMs(h({ 'x-ratelimit-reset': '12' }), now), 12000, 'segundos até renovar');
  assert.equal(retryDelayMs(h({ 'retry-after': '3', 'x-ratelimit-reset': String(now + 20000) }), now), 20000, 'vale o maior');
  assert.equal(retryDelayMs(h({ 'retry-after': '999999' }), now), 24 * 60 * 60 * 1000, 'no máximo 24 h');
  assert.equal(retryDelayMs(h({ 'retry-after': 'logo' }), now), null);
  assert.equal(retryDelayMs(h({}), now), null);
  assert.equal(retryDelayMs(null, now), null);
  // Headers de verdade, Map e objeto com chaves em maiúsculas
  assert.equal(retryDelayMs(new Headers({ 'Retry-After': '5' }), now), 5000);
  assert.equal(retryDelayMs(new Map([['retry-after', '6']]), now), 6000);
  assert.equal(getHeader({ 'X-RateLimit-Limit': ['50'] }, 'x-ratelimit-limit'), '50');
  assert.equal(getHeader(undefined, 'x'), null);
});

// ---------- Pacer ----------

function fakeClock() {
  const c = { t: 1000000, sleeps: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.sleeps.push(ms); c.t += ms; };
  return c;
}

test('Pacer: espaço mínimo de 3 s entre chamadas (20 por minuto), em fila, com relógio injetável', async () => {
  const c = fakeClock();
  const pacer = new Pacer({ now: c.now, sleep: c.sleep });
  assert.equal(pacer.minGapMs, 3000);
  assert.equal(await pacer.wait(), 0, 'a primeira sai na hora');
  assert.equal(await pacer.wait(), 3000, 'a segunda, logo depois, espera 3 s');
  assert.deepEqual(c.sleeps, [3000]);
  // passou tempo de sobra: sai na hora
  c.t += 10000;
  assert.equal(await pacer.wait(), 0);
  // três ao mesmo tempo saem em fila, uma a cada 3 s
  c.sleeps.length = 0;
  const base = c.t;
  const concurrent = new Pacer({ now: c.now, sleep: async (ms) => { c.sleeps.push(ms); } });
  const waits = await Promise.all([concurrent.wait(), concurrent.wait(), concurrent.wait(), concurrent.wait()]);
  assert.deepEqual(waits, [0, 3000, 6000, 9000]);
  assert.deepEqual(c.sleeps, [3000, 6000, 9000]);
  assert.equal(c.t, base);
  // 20 por minuto: 20 chamadas seguidas levam 19 intervalos de 3 s
  const p20 = new Pacer({ now: c.now, sleep: c.sleep });
  const t0 = c.t;
  for (let i = 0; i < 20; i += 1) await p20.wait();
  assert.equal(c.t - t0, 19 * 3000);
});

test('Pacer: respeita o que o servidor mandou esperar (Retry-After/X-RateLimit-Reset) e pode ser zerado', async () => {
  const c = fakeClock();
  const pacer = new Pacer({ now: c.now, sleep: c.sleep });
  await pacer.wait();
  assert.equal(pacer.noteHeaders({ 'retry-after': '20' }), 20000);
  assert.equal(await pacer.wait(), 20000, 'espera os 20 s, não só os 3 s');
  assert.equal(pacer.noteHeaders({}), null);
  pacer.penalize(-5);
  pacer.penalize(NaN);
  pacer.penalize(15000);
  assert.equal(await pacer.wait(), 15000);
  pacer.reset();
  assert.equal(await pacer.wait(), 0);
});

test('Pacer: cancelar durante a espera rejeita com CANCELLED (relógio de verdade, intervalo curto)', async () => {
  const pacer = new Pacer({ minGapMs: 400 });
  await pacer.wait();
  const ctrl = new AbortController();
  const pending = pacer.wait({ signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 30);
  const t0 = Date.now();
  await assert.rejects(() => pending, (e) => e.code === 'CANCELLED');
  assert.ok(Date.now() - t0 < 300, 'não esperou os 400 ms');
  await assert.rejects(() => pacer.wait({ signal: ctrl.signal }), (e) => e.code === 'CANCELLED', 'já cancelado antes de começar');
});

// ---------- estimativa x o que resta ----------

test('describeEstimate: compara "~N chamadas" com o que resta hoje; avisa, nunca bloqueia', () => {
  const day = (remaining, limit = 50) => ({ used: limit - remaining, limit, remaining });
  assert.equal(describeEstimate(5, day(40)).level, 'ok');
  assert.match(describeEstimate(5, day(40)).message, /cerca de 5 pedidos; restam 40 hoje/);
  assert.equal(describeEstimate(1, day(40)).message, 'A análise usa cerca de 1 pedido; restam 40 hoje.');
  assert.equal(describeEstimate(8, day(10)).level, 'warn', 'passa de 70% do que resta');
  assert.equal(describeEstimate(14, day(9)).level, 'warn');
  assert.match(describeEstimate(14, day(9)).message, /restam 9 hoje: ela pode parar no meio/);
  const zero = describeEstimate(3, day(0));
  assert.equal(zero.level, 'bad');
  assert.match(zero.message, /acabaram.*limite de 50/);
  for (const args of [[0, day(5)], [3, null], [3, undefined], [3, { remaining: 'x' }], [NaN, day(5)]]) assert.equal(describeEstimate(...args).level, 'unknown');
});

// ---------- o serviço usa o cofre só na hora e nunca devolve a chave ----------

test('serviço: keyInfo usa a chave do provedor de chaves só na hora de consultar, junta consultas simultâneas e guarda o resultado por 10 s', async (t) => {
  const dir = F.tmpDir();
  const mock = await F.startMockOpenRouter({ key: (call) => (call.headers.authorization === `Bearer ${F.KEY}` ? { json: F.keyBody() } : F.ERRORS.auth401()) });
  t.after(async () => { await mock.close(); F.cleanup(dir); });
  const clock = { t: NOW };
  let key = null;
  const svc = createOpenRouterService({ dir, baseUrl: mock.base, now: () => clock.t, getKey: () => key });
  // sem chave
  const none = await svc.keyInfo();
  assert.deepEqual([none.ok, none.code], [false, 'NO_KEY']);
  assert.equal(mock.calls.length, 0, 'sem chave nem tenta');
  // cofre do hospedeiro e chave ilegível: motivos diferentes
  const host = createOpenRouterService({ dir, baseUrl: mock.base, getKey: () => ({ key: null, reason: 'host' }) });
  assert.equal((await host.keyInfo()).hostManaged, true);
  const unreadable = createOpenRouterService({ dir, baseUrl: mock.base, getKey: () => ({ key: null, reason: 'unreadable' }) });
  assert.match((await unreadable.keyInfo()).message, /não pôde ser lida/);
  // com chave
  key = F.KEY;
  const [a, b] = await Promise.all([svc.keyInfo(), svc.keyInfo()]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(mock.count('GET', '/api/v1/key'), 1, 'simultâneas viram uma consulta');
  clock.t += 9000;
  await svc.keyInfo();
  assert.equal(mock.count('GET', '/api/v1/key'), 1, 'dentro de 10 s usa o resultado guardado');
  await svc.keyInfo({ refresh: true });
  assert.equal(mock.count('GET', '/api/v1/key'), 2);
  clock.t += 11000;
  await svc.keyInfo();
  assert.equal(mock.count('GET', '/api/v1/key'), 3);
  // trocar a chave invalida o resultado guardado
  key = `${F.KEY}-outra`;
  assert.equal((await svc.keyInfo()).code, 'AUTH');
  assert.ok(!JSON.stringify(await svc.keyInfo()).includes(F.KEY));
  // a chave nunca aparece em retorno nenhum
  key = F.KEY;
  assert.ok(!JSON.stringify([a, b, none]).includes(F.KEY));
  // o provedor de chaves pode ser trocado depois (a análise aponta para o cofre dela)
  svc.setKeyProvider(() => null);
  assert.equal((await svc.keyInfo()).code, 'NO_KEY');
  svc.setKeyProvider(() => { throw new Error(`cofre quebrou com ${F.KEY}`); });
  const broken = await svc.keyInfo();
  assert.equal(broken.code, 'NO_KEY');
  assert.ok(!JSON.stringify(broken).includes(F.KEY));
});

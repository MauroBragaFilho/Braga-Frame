'use strict';

/**
 * A análise por IA com o OpenRouter "só gratuitos" de ponta a ponta pelo IPC (createContext + TODOS os handlers de verdade), contra o servidor
 * HTTP local que imita o OpenRouter: o roteador responde e o modelo que respondeu vai para `result.ai.models`; modelo pago forçado é recusado antes
 * de qualquer pedido (nada chega ao servidor); o corpo enviado nunca leva `models`/`route`; 429 troca para a reserva gratuita, 401 e a cota do dia
 * não; cada erro chega à interface explicado em português; a lista pública é conferida antes da análise; o aviso de privacidade tem o parágrafo
 * dos modelos gratuitos e continua por provedor, sem prazo; no BDS o provedor é o do hospedeiro; e a CHAVE nunca aparece em evento, log ou arquivo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createContext } = require('../src/ipc/context');
const { loadHandlers } = require('../src/ipc');
const { FREE_MODE_PRIVACY } = require('../src/core/ai/openrouter');
const A = require('./ai-fakes');
const F = require('./ai-openrouter-fakes');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeElectron(userData) {
  const handlers = new Map();
  const sent = [];
  const lines = [];
  const logger = { log: (m) => lines.push(m), info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
  const win = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } };
  const deps = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: () => userData, getVersion: () => '9.9.9', on() {}, isPackaged: false },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, shell: {}, getWindow: () => win, logger
  };
  return {
    deps, handlers, sent, lines,
    call: (channel, payload) => handlers.get(channel)({}, payload),
    events: (name) => sent.filter(([channel]) => channel === name).map(([, payload]) => payload)
  };
}

async function waitFor(fn, ms = 15000, what = 'condição') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(15); }
  throw new Error(`Tempo esgotado esperando: ${what}`);
}

const stamp = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')},${String(Math.round((s % 1) * 1000)).padStart(3, '0')}`;
const srtOf = (cues) => cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');
const lastContent = (call) => call.body.messages[call.body.messages.length - 1].content;
const isPick = (call) => lastContent(call).includes('=== CANDIDATOS ===');
const chatCalls = (mock) => mock.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/chat/completions');
const MOMENTS = [{ at: 120, punch: 'o bicho nem dropou couro' }, { at: 300, punch: 'obrigado jogo eu morri afogado' }];

/** Resposta do "OpenRouter" para a análise: dois cortes no bloco e a escolha final; `answered(model, kind)` decide quem "respondeu". */
const analysisRoute = (tr, answered = (model) => model) => (call) => {
  if (isPick(call)) {
    const ids = [...lastContent(call).matchAll(/id=(c\d+)/g)].map((x) => x[1]);
    return { json: F.chatBody(JSON.stringify({ picks: ids.map((id, k) => ({ id, relevance: 0.92 - k * 0.1, title: `Momento final ${k + 1}`, category: 'Hype', reasons: ['escolhido na 2ª passada'] })) }), { answered: answered(call.body.model, 'pick') }) };
  }
  const m = tr.moments;
  return { json: F.chatBody(A.cutsJson([
    { start: m[0].start, end: m[0].end, punchline: m[0].punch, title: 'O rato que não dropou couro', relevance: 0.9 },
    { start: m[1].start, end: m[1].end, punchline: m[1].punch, title: 'Obrigado, jogo', relevance: 0.8 }
  ]), { answered: answered(call.body.model, 'block') }) };
};

/** ctx de verdade com todos os handlers, o servidor local no lugar do OpenRouter e uma transcrição pronta de 20 min. */
async function setup(t, { chat, models, key, host } = {}) {
  const dir = F.tmpDir('bf-or-an-');
  const tr = A.makeTranscript({ minutes: 20, moments: MOMENTS });
  const mock = await F.startMockOpenRouter({
    models: models || (() => ({ json: F.catalogBody() })),
    key: key || ((call) => (call.headers.authorization === `Bearer ${F.KEY}` ? { json: F.keyBody() } : F.ERRORS.auth401())),
    chat: chat || analysisRoute(tr)
  });
  t.after(async () => { await mock.close(); F.cleanup(dir); });
  const video = path.join(dir, 'live.mp4');
  fs.writeFileSync(video, Buffer.alloc(2048, 7));
  const fe = fakeElectron(path.join(dir, 'ud'));
  const ctx = createContext({ ...fe.deps, ...(host ? { host } : {}) });
  ctx.aiOpenrouterOptions = { baseUrl: mock.base, safeStorage: F.fakeSafeStorage(), restrict: () => {}, sleep: async () => {} };
  ctx.analysisAiOptions = { safeStorage: F.fakeSafeStorage(), restrict: () => {}, sleep: async () => {} };
  const res = loadHandlers(ctx);
  assert.deepEqual(res.failed, []);
  const src = { projectId: 'proj1', path: video, size: 2048, duration: tr.duration };
  return { dir, tr, mock, fe, ctx, src, video };
}

async function configure(s, { model = 'openrouter/free', accept = true, extra = {} } = {}) {
  assert.equal((await s.fe.call('analysis:aiSave', { provider: 'openrouter', model, apiKey: F.KEY, ...extra })).ok, true);
  if (accept) assert.equal((await s.fe.call('analysis:aiAccept', { accepted: true })).ok, true);
  const srt = path.join(s.dir, 'live.srt');
  fs.writeFileSync(srt, srtOf(s.tr.cues));
  assert.equal((await s.fe.call('analysis:transcriptImport', { ...s.src, subtitlePath: srt })).ok, true);
}

const startAi = (s, extra = {}) => s.fe.call('analysis:start', {
  engine: 'ai', ...s.src, params: { minDurationSec: 15, maxDurationSec: 60, padBeforeSec: 2, padAfterSec: 1, minRelevance: 0.4, perHour: 20 }, meta: { title: 'Teste' }, existingCuts: [], ...extra
});
const state = async (s) => (await s.fe.call('analysis:aiState')).ai;

/** Roda uma análise e espera o fim (done ou failed). */
async function runToEnd(s) {
  s.fe.sent.length = 0;
  const started = await startAi(s);
  assert.equal(started.ok, true, JSON.stringify(started));
  return waitFor(() => s.fe.events('analysis:done')[0] || s.fe.events('analysis:failed')[0], 20000, 'fim da análise');
}

const noKeyAnywhere = (s, where) => {
  assert.ok(!JSON.stringify(s.fe.sent).includes(F.KEY), `a chave apareceu em um evento (${where})`);
  assert.ok(!JSON.stringify(s.fe.lines).includes(F.KEY), `a chave apareceu no log (${where})`);
  // o `user_id` da conta (o OpenRouter o repete no corpo dos erros: todo erro do servidor de teste o traz) também nunca sai do processo principal
  assert.ok(!JSON.stringify(s.fe.sent).includes(F.USER_ID), `o user_id da conta apareceu em um evento (${where})`);
  assert.ok(!JSON.stringify(s.fe.lines).includes(F.USER_ID), `o user_id da conta apareceu no log (${where})`);
  for (const f of F.readAll(path.join(s.dir, 'ud'))) {
    assert.ok(!f.text.includes(F.KEY), `chave em claro em ${f.file}`);
    assert.ok(!f.text.includes(F.USER_ID), `user_id da conta em ${f.file}`);
  }
};

// ---------- o caminho feliz com o roteador ----------

test('análise com o roteador gratuito: o modelo que respondeu (campo `model`) vai para result.ai.models; corpo sem `models`/`route`; a lista é conferida antes; a chave só no cabeçalho', async (t) => {
  const s = await setup(t);
  s.mock.routes.chat = analysisRoute(s.tr, (model, kind) => (kind === 'block' ? 'acme/grande-ctx:free' : 'zeta/medio-b:free'));
  await configure(s, { accept: false });
  const st0 = await state(s);
  assert.equal(st0.provider.freeCapable, true);
  assert.equal(st0.provider.freeOnly, true, 'ligado por padrão');
  assert.equal(st0.provider.ready, true, 'o roteador gratuito é permitido');
  assert.ok(st0.provider.privacy.endsWith(FREE_MODE_PRIVACY), 'o aviso do OpenRouter traz o parágrafo dos modelos gratuitos');
  assert.equal(st0.accepted, false);
  // sem o aceite nada sai (nem a lista de modelos é pedida pela análise)
  const noConsent = await startAi(s);
  assert.deepEqual([noConsent.ok, noConsent.code], [false, 'CONSENT_REQUIRED']);
  assert.equal(chatCalls(s.mock).length, 0);
  assert.equal((await s.fe.call('analysis:aiAccept', { accepted: true })).ok, true);

  const done = await runToEnd(s);
  assert.equal(done.jobId !== undefined && done.result.engine, 'ai', JSON.stringify(done).slice(0, 300));
  assert.deepEqual(done.result.ai.models, { 'acme/grande-ctx:free': 1, 'zeta/medio-b:free': 1 }, 'quem de fato respondeu, por chamada');
  assert.equal(done.result.ai.model, 'openrouter/free', 'o escolhido continua sendo o roteador');
  assert.equal(done.result.ai.calls, 2);
  assert.equal(done.result.suggestions.length, 2);
  // a lista pública foi conferida ANTES, sem chave; a mensagem de progresso diz isso
  assert.ok(s.mock.count('GET', '/api/v1/models') >= 1);
  assert.ok(s.mock.calls.filter((c) => c.path === '/api/v1/models').every((c) => c.headers.authorization === undefined));
  assert.ok(s.fe.events('analysis:progress').some((p) => p.message === 'Conferindo a lista de modelos gratuitos…'));
  // o que SAIU para o OpenRouter
  const calls = chatCalls(s.mock);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.body.model, 'openrouter/free');
    assert.equal(call.headers.authorization, `Bearer ${F.KEY}`);
    assert.ok(!call.raw.includes(F.KEY) && !call.path.includes(F.KEY));
    assert.ok(!('models' in call.body) && !('route' in call.body) && !('plugins' in call.body), 'nenhum fallback pago nem plugin no corpo');
    assert.deepEqual(call.body.response_format, { type: 'json_object' });
  }
  noKeyAnywhere(s, 'depois da análise');
  // estimativa × pedidos gratuitos que restam: avisa, nunca bloqueia
  const est = (await s.fe.call('analysis:aiEstimate', s.src)).estimate;
  const limits = await s.fe.call('aiOpenrouter:limits', { calls: est.calls });
  assert.equal(limits.ok, true);
  assert.deepEqual(limits.freeDaily, { used: 12, limit: 50, remaining: 38 });
  assert.equal(limits.estimate.level, 'ok');
  assert.match(limits.estimate.message, new RegExp(`cerca de ${est.calls} pedidos; restam 38 hoje`));
  assert.ok(!JSON.stringify(limits).includes(F.KEY) && !JSON.stringify(limits).includes(F.KEY_LABEL));
});

// ---------- modelo pago forçado ----------

test('modelo PAGO forçado com o interruptor ligado: o provedor deixa de ficar pronto, a análise e o teste de conexão recusam com NOT_FREE e NADA chega ao servidor', async (t) => {
  const s = await setup(t);
  await configure(s);
  const forced = await s.fe.call('analysis:aiSave', { model: 'vendor/pago-barato' }); // digitado/forçado por fora da lista
  assert.equal(forced.ok, true);
  assert.deepEqual([forced.ai.provider.ready, forced.ai.provider.reasonCode], [false, 'NOT_FREE']);
  assert.match(forced.ai.provider.reason, /O modelo "vendor\/pago-barato" não é gratuito/);
  assert.equal(forced.ai.ready, false);
  const start = await startAi(s);
  assert.deepEqual([start.ok, start.code], [false, 'NOT_FREE']);
  assert.match(start.message, /nada foi enviado e nada foi cobrado/);
  const test = await s.fe.call('analysis:aiTest');
  assert.deepEqual([test.ok, test.code], [false, 'NOT_FREE']);
  assert.equal(chatCalls(s.mock).length, 0, 'nenhum pedido de conversa chegou ao servidor');
  assert.ok(s.fe.lines.some((l) => /NOT_FREE/.test(l)), 'a recusa fica no log, com o código');
  // modelo gratuito logo depois: funciona; ligar/desligar o interruptor é explícito e guardado
  assert.equal((await s.fe.call('analysis:aiSave', { model: 'acme/medio-a:free' })).ai.provider.ready, true);
  assert.equal((await s.fe.call('analysis:aiSave', { model: 'vendor/pago-barato', freeOnly: false })).ai.provider.ready, true, 'desligado de propósito: vale');
  assert.equal((await s.fe.call('analysis:aiSave', { freeOnly: true })).ai.provider.ready, false);
  assert.equal((await s.fe.call('analysis:aiSave', { freeOnly: 'sim' })).code, 'INVALID_ARGS');
  noKeyAnywhere(s, 'modelo pago forçado');
});

// ---------- fallback ----------

test('fallback: o modelo escolhido dá 429 e a análise segue pela reserva gratuita, avisando a troca (progresso e aviso do resultado) e dizendo quem respondeu', async (t) => {
  const s = await setup(t);
  s.mock.routes.chat = (call) => (call.body.model === 'acme/medio-a:free' ? F.ERRORS.rateLimitMinute(Date.now()) : analysisRoute(s.tr)(call));
  await configure(s, { model: 'acme/medio-a:free' });
  // a lista precisa estar no disco para o guard conhecer os ids (o seletor da tela faz isso ao nascer)
  await s.fe.call('aiOpenrouter:models');
  const saved = await s.fe.call('analysis:aiSave', { fallbackModels: ['zeta/medio-b:free'] });
  assert.deepEqual(saved.ai.provider.fallbackModels, ['zeta/medio-b:free']);
  const refused = await s.fe.call('analysis:aiSave', { fallbackModels: ['zeta/medio-b:free', 'vendor/pago-caro'] });
  assert.deepEqual([refused.ok, refused.code], [false, 'NOT_FREE'], 'reserva paga é recusada');
  assert.deepEqual((await state(s)).provider.fallbackModels, ['zeta/medio-b:free'], 'nada mudou');

  const done = await runToEnd(s);
  assert.equal(done.result.engine, 'ai', JSON.stringify(done).slice(0, 300));
  assert.deepEqual(done.result.ai.models, { 'zeta/medio-b:free': 2 }, 'quem respondeu foi a reserva');
  assert.ok(s.fe.events('analysis:progress').some((p) => /^O modelo acme\/medio-a:free não respondeu \(limite de uso\); tentando zeta\/medio-b:free…$/.test(p.message)), JSON.stringify(s.fe.events('analysis:progress').map((p) => p.message)));
  assert.ok(done.result.warnings.some((w) => w.code === 'AI_MODEL_SWITCHED' && /acme\/medio-a:free \(limite de uso\) → zeta\/medio-b:free/.test(w.message)));
  const sent = chatCalls(s.mock).map((c) => c.body.model);
  assert.ok(sent.includes('acme/medio-a:free') && sent.includes('zeta/medio-b:free'));
  assert.ok(!sent.includes('vendor/pago-caro'));
  noKeyAnywhere(s, 'fallback');
});

test('chave recusada (401): NÃO troca de modelo nem repete; o erro chega à tela explicado e sem a chave', async (t) => {
  const s = await setup(t, { chat: () => F.ERRORS.auth401() });
  await configure(s, { model: 'acme/medio-a:free' });
  await s.fe.call('aiOpenrouter:models');
  await s.fe.call('analysis:aiSave', { fallbackModels: ['zeta/medio-b:free'] });
  const end = await runToEnd(s);
  assert.equal(end.code, 'AUTH');
  assert.equal(end.engine, 'ai');
  assert.match(end.message, /O OpenRouter recusou a chave de API/);
  assert.match(end.message, /Usar o algoritmo|usar o algoritmo/);
  assert.equal(chatCalls(s.mock).length, 1, 'um pedido só: nem a reserva nem nova tentativa');
  assert.ok(!JSON.stringify(end).includes(F.KEY));
  noKeyAnywhere(s, '401');
});

test('429 do DIA, 404 por política de dados, 402 e modelo removido: cada um chega explicado (o que houve e o que fazer), sem repetir à toa e sem a chave', async (t) => {
  const s = await setup(t);
  await configure(s, { model: 'acme/medio-a:free' });
  await s.fe.call('aiOpenrouter:models');
  const cases = [
    [F.ERRORS.rateLimitDay(Date.now()), 'QUOTA', /Os pedidos gratuitos de hoje do OpenRouter acabaram: restam 0 de 50.*renova (amanhã )?às 21:00.*US\$ 10 em créditos.*1\.000 pedidos/s],
    [F.ERRORS.dataPolicy404(), 'DATA_POLICY', /podem usar o que você envia para treino ou publicação.*em Privacy na conta do OpenRouter.*decisão sua: o app não altera a sua conta/s],
    [F.ERRORS.credits402(), 'CREDITS', /saldo negativo podem receber erros mesmo em modelos gratuitos/],
    [F.ERRORS.modelGone404('acme/medio-a:free'), 'MODEL', /Atualize a lista de modelos e escolha outro modelo gratuito/]
  ];
  for (const [action, code, re] of cases) {
    s.mock.calls.length = 0;
    s.mock.routes.chat = () => action;
    const end = await runToEnd(s);
    assert.equal(end.code, code, JSON.stringify(end).slice(0, 200));
    assert.match(end.message, re);
    assert.match(end.message, /Você pode tentar de novo ou usar o algoritmo\./, 'e a tela oferece o algoritmo');
    assert.equal(chatCalls(s.mock).length, 1, `${code}: um pedido só (não repete)`);
    assert.ok(!JSON.stringify(end).includes(F.KEY));
  }
  noKeyAnywhere(s, 'erros explicados');
});

test('429 por minuto: a análise espera e tenta de novo pela escada (o Pacer e o Retry-After), e termina quando o limite libera', async (t) => {
  let n = 0;
  const s = await setup(t);
  const ok = analysisRoute(s.tr);
  s.mock.routes.chat = (call) => { n += 1; return n === 1 ? { status: 429, headers: { 'retry-after': '1' }, json: F.errorBody(429, 'Rate limit exceeded: free-models-per-min.') } : ok(call); };
  await configure(s);
  const done = await runToEnd(s);
  assert.equal(done.result.engine, 'ai', JSON.stringify(done).slice(0, 300));
  assert.equal(done.result.ai.retries, 1);
  assert.ok(chatCalls(s.mock).length >= 3, 'o 1º pedido falhou, depois o bloco e a escolha');
  assert.ok(s.fe.events('analysis:progress').some((p) => /Limite do provedor: nova tentativa em/.test(p.message)));
});

// ---------- lista pública fora do ar ----------

test('sem internet para a lista pública: a análise segue (só o roteador e ":free" valem) e o resultado avisa; sem aceite nada sai', async (t) => {
  const s = await setup(t, { models: () => ({ drop: true }) });
  await configure(s);
  const done = await runToEnd(s);
  assert.equal(done.result.engine, 'ai', JSON.stringify(done).slice(0, 300));
  const warning = done.result.warnings.find((w) => w.code === 'FREE_LIST_MISSING');
  assert.ok(warning, JSON.stringify(done.result.warnings));
  assert.match(warning.message, /só valem o roteador gratuito e os modelos com o sufixo ":free"/);
  // um modelo pago continua recusado mesmo sem a lista (só o sufixo vale)
  await s.fe.call('analysis:aiSave', { model: 'google/gemini-2.5-flash' });
  assert.equal((await startAi(s)).code, 'NOT_FREE');
});

// ---------- hospedeiro (BDS) ----------

test('no módulo embutido (BDS) com o OpenRouter o modo gratuito vale também: lista conferida antes, modelo pago recusado sem nada chegar ao BDS, interruptor daqui; sem chave nem pedido do Braga Frame ao OpenRouter', async (t) => {
  const requests = [];
  const tr = A.makeTranscript({ minutes: 20, moments: MOMENTS });
  let model = 'vendor/pago-barato'; // o que o assistente do BDS está usando (muda ao longo do teste)
  const host = {
    embedded: true, name: 'BDS', tool: () => null, whisperModels: null,
    ai: {
      describe: () => ({ id: 'openrouter', label: 'OpenRouter', model, hasKey: true, ready: true, serverHost: 'openrouter.ai' }),
      chat: async (params) => {
        requests.push(params);
        const call = { body: { model, messages: params.messages } };
        return { text: JSON.parse(JSON.stringify(analysisRoute(tr, () => model)(call).json)).choices[0].message.content, model, usage: { prompt_tokens: 10, completion_tokens: 5 } };
      }
    }
  };
  const s = await setup(t, { host });
  let st = await state(s);
  assert.equal(st.source, 'host');
  assert.equal(st.readOnly, true);
  assert.deepEqual([st.provider.freeCapable, st.provider.freeOnly], [true, true], 'o modo gratuito vale para o OpenRouter do BDS (ligado por padrão)');
  assert.deepEqual([st.provider.ready, st.provider.reasonCode], [false, 'NOT_FREE'], 'o assistente do BDS usa um modelo pago: o provedor não fica pronto');
  assert.match(st.provider.reason, /vendor\/pago-barato.*não é gratuito.*assistente do BDS usa o OpenRouter/);
  // continua só leitura, EXCETO o interruptor do modo gratuito
  assert.deepEqual([(await s.fe.call('analysis:aiSave', { provider: 'openrouter' })).ok, (await s.fe.call('analysis:aiSave', { model: 'x' })).ok, (await s.fe.call('analysis:aiSave', { freeOnly: 'não' })).ok], [false, false, false]);
  const limits = await s.fe.call('aiOpenrouter:limits');
  assert.deepEqual([limits.ok, limits.code, limits.hostManaged], [false, 'NO_KEY', true], 'a chave é do BDS: aqui não dá para consultar os pedidos restantes');
  const srt = path.join(s.dir, 'live.srt');
  fs.writeFileSync(srt, srtOf(s.tr.cues));
  await s.fe.call('analysis:transcriptImport', { ...s.src, subtitlePath: srt });
  await s.fe.call('analysis:aiAccept', { accepted: true });
  // modelo pago do OpenRouter no BDS: a análise é recusada e NADA chega ao BDS
  const refused = await startAi(s);
  assert.deepEqual([refused.ok, refused.code], [false, 'NOT_FREE'], JSON.stringify(refused).slice(0, 300));
  assert.equal(requests.length, 0, 'nada foi ao assistente do BDS');
  // desligar o interruptor é explícito (e daqui): aí vale qualquer modelo; ligar de novo traz a recusa de volta
  st = (await s.fe.call('analysis:aiSave', { freeOnly: false })).ai;
  assert.deepEqual([st.provider.freeOnly, st.provider.ready], [false, true]);
  st = (await s.fe.call('analysis:aiSave', { freeOnly: true })).ai;
  assert.deepEqual([st.provider.freeOnly, st.provider.ready, st.provider.reasonCode], [true, false, 'NOT_FREE']);
  // o assistente passa a um modelo gratuito: a análise roda, a lista pública foi conferida antes e o BDS recebeu o filtro da cadeia dele
  model = 'acme/medio-a:free';
  assert.equal((await state(s)).provider.ready, true);
  const done = await runToEnd(s);
  assert.equal(done.result.engine, 'ai', JSON.stringify(done).slice(0, 300));
  assert.ok(requests.length >= 1);
  assert.ok(requests.every((r) => typeof r.acceptProvider === 'function'), 'o hospedeiro recebe o filtro de provedores (cadeia de fallback)');
  assert.deepEqual(done.result.ai.models, { 'acme/medio-a:free': requests.length }, 'o modelo que o hospedeiro informou também é registrado');
  assert.equal(chatCalls(s.mock).length, 0, 'o Braga Frame não falou com o OpenRouter');
  assert.equal(s.mock.calls.filter((c) => c.path === '/api/v1/models').length, 1, 'só a lista PÚBLICA de modelos foi pedida (sem chave), antes da análise');
  assert.ok(s.mock.calls.filter((c) => c.path === '/api/v1/models').every((c) => c.headers.authorization === undefined));
  assert.equal(s.mock.calls.filter((c) => c.path === '/api/v1/key').length, 0, 'nem pergunta quantos pedidos restam (a chave é do BDS)');
  assert.ok(!fs.existsSync(path.join(s.dir, 'ud', 'ai', 'secrets.json')));
});

// ---------- aceite ----------

test('aceite de privacidade: por provedor e sem prazo; ligar e desligar o interruptor não o mexe; o parágrafo dos modelos gratuitos só aparece com o interruptor ligado', async (t) => {
  const s = await setup(t);
  await configure(s, { accept: false });
  const on = (await state(s)).provider.privacy;
  assert.match(on, /Modelos gratuitos podem usar o que você envia para treino ou publicação/);
  await s.fe.call('analysis:aiAccept', { accepted: true });
  const off = await s.fe.call('analysis:aiSave', { freeOnly: false });
  assert.equal(off.ai.accepted, true, 'o aceite é do provedor: continua');
  assert.ok(!/treino ou publicação/.test(off.ai.provider.privacy));
  assert.equal((await s.fe.call('analysis:aiSave', { freeOnly: true })).ai.accepted, true);
  // outro provedor tem o seu aceite
  await s.fe.call('analysis:aiSave', { provider: 'groq' });
  assert.equal((await state(s)).accepted, false);
  assert.equal((await s.fe.call('analysis:aiSave', { provider: 'openrouter' })).ai.accepted, true, 'voltar ao OpenRouter: o mesmo aceite');
  const cfg = JSON.parse(fs.readFileSync(path.join(s.dir, 'ud', 'ai', 'config.json'), 'utf8'));
  cfg.accepted.openrouter.at = '2001-01-01T00:00:00.000Z';
  fs.writeFileSync(path.join(s.dir, 'ud', 'ai', 'config.json'), JSON.stringify(cfg));
  assert.equal((await state(s)).accepted, true, 'sem prazo');
});

// ---------- formatos observados em rede real ----------

test('modelo que "pensa" (formato observado em rede real): resposta cortada com `message.reasoning` e SEM conteúdo não vira resposta; a nova tentativa pede mais espaço de saída e o JSON só vem de `message.content`', async (t) => {
  const s = await setup(t);
  const thinker = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
  const ok = analysisRoute(s.tr, () => thinker);
  const seen = [];
  s.mock.routes.chat = (call) => {
    seen.push({ max: call.body.max_tokens, pick: isPick(call) });
    // a 1ª chamada: o modelo gastou o limite de saída PENSANDO (o raciocínio até traz um JSON bonito, e falso) e não deu conteúdo
    if (seen.length === 1) {
      return { json: F.chatBody('', {
        answered: thinker, completionTokens: 6000, reasoningTokens: 6000, finishReason: 'length',
        reasoning: JSON.stringify({ candidates: [{ start: 30, end: 80, punchline: 'FALSO', title: 'Veio do raciocínio', relevance: 0.99 }] })
      }) };
    }
    return ok(call);
  };
  await configure(s);
  const done = await runToEnd(s);
  assert.equal(done.result.engine, 'ai', JSON.stringify(done).slice(0, 300));
  assert.equal(seen[0].max, 6000, 'folga para quem pensa: o teto de saída do bloco é folgado');
  assert.equal(seen[1].max, 9600, 'cortada sem JSON: a nova tentativa pede mais espaço (6000 x 1,6)');
  assert.equal(seen[1].pick, false, 'é a mesma chamada do bloco, de novo');
  assert.equal(done.result.ai.retries, 1);
  assert.equal(done.result.suggestions.length, 2);
  assert.ok(!JSON.stringify(done.result).includes('Veio do raciocínio'), 'nada veio do raciocínio');
  assert.deepEqual(Object.keys(done.result.ai.models), [thinker]);
  assert.ok(done.result.ai.completionTokens >= 6000, 'os tokens de raciocínio contam (completion_tokens já os inclui)');
  noKeyAnywhere(s, 'modelo que pensa');
});

test('modelo inválido (HTTP 400 "is not a valid model ID", observado em rede real): vira MODEL explicado, troca para a reserva gratuita quando há, e o user_id da conta nunca sai do processo principal', async (t) => {
  const s = await setup(t);
  const ok = analysisRoute(s.tr);
  s.mock.routes.chat = (call) => (call.body.model === 'acme/medio-a:free' ? F.ERRORS.invalidModel400(call.body.model) : ok(call));
  await configure(s, { model: 'acme/medio-a:free' });
  await s.fe.call('aiOpenrouter:models');
  // sem reserva: falha explicada, um pedido só
  const end = await runToEnd(s);
  assert.equal(end.code, 'MODEL', JSON.stringify(end).slice(0, 300));
  assert.match(end.message, /O OpenRouter não reconhece "acme\/medio-a:free": o nome pode estar errado ou o modelo foi removido\. Atualize a lista de modelos e escolha outro modelo gratuito\./);
  assert.match(end.message, /Você pode tentar de novo ou usar o algoritmo\./);
  assert.equal(chatCalls(s.mock).length, 1, 'o modelo inválido não é repetido');
  noKeyAnywhere(s, 'modelo inválido sem reserva');
  // com reserva: troca e termina
  assert.equal((await s.fe.call('analysis:aiSave', { fallbackModels: ['zeta/medio-b:free'] })).ok, true);
  s.mock.calls.length = 0;
  const done = await runToEnd(s);
  assert.equal(done.result.engine, 'ai', JSON.stringify(done).slice(0, 300));
  assert.deepEqual(done.result.ai.models, { 'zeta/medio-b:free': 2 });
  assert.ok(done.result.warnings.some((w) => w.code === 'AI_MODEL_SWITCHED' && /acme\/medio-a:free \(não encontrado, expirado ou indisponível\) → zeta\/medio-b:free/.test(w.message)), JSON.stringify(done.result.warnings));
  noKeyAnywhere(s, 'modelo inválido com reserva');
});

test('rede de segurança: se o OpenRouter informar custo (usage.cost > 0) com "Usar apenas modelos gratuitos" ligado, a análise avisa; custo 0 (o normal) não avisa; desligado de propósito, custo é esperado', async (t) => {
  const s = await setup(t);
  const base = analysisRoute(s.tr);
  let cost = 0;
  s.mock.routes.chat = (call) => { const r = base(call); r.json.usage.cost = cost; return r; };
  await configure(s);
  const clean = await runToEnd(s);
  assert.equal(clean.result.engine, 'ai', JSON.stringify(clean).slice(0, 300));
  assert.ok(!clean.result.warnings.some((w) => w.code === 'AI_COST_REPORTED'), 'custo 0: sem aviso');
  cost = 0.0012;
  const charged = await runToEnd(s);
  const warning = charged.result.warnings.find((w) => w.code === 'AI_COST_REPORTED');
  assert.ok(warning, JSON.stringify(charged.result.warnings));
  assert.match(warning.message, /O OpenRouter informou custo \(US\$ 0,0024\) em pedidos desta análise, apesar de "Usar apenas modelos gratuitos" estar ligado\. Confira o uso e os créditos no painel do OpenRouter\./);
  await s.fe.call('analysis:aiSave', { freeOnly: false });
  const paidMode = await runToEnd(s);
  assert.ok(!paidMode.result.warnings.some((w) => w.code === 'AI_COST_REPORTED'), 'com o modo desligado de propósito o custo é esperado');
  noKeyAnywhere(s, 'custo informado');
});

'use strict';

/**
 * OpenRouter "só com modelos gratuitos": REDE REAL COM CHAVE, OPT-IN. Fica DESLIGADO por padrão: o conjunto normal nunca depende de internet
 * nem gasta a cota diária de pedidos gratuitos. Para ligar (a chave só é lida do ambiente: nunca é pedida, guardada em arquivo nem impressa):
 *
 *   BF_AI_TEST_KEY=<chave do OpenRouter> [BF_AI_TEST_URL=https://openrouter.ai/api/v1] [BF_AI_TEST_MODEL=<id>:free] node --test tests/ai-openrouter-real.test.js
 *   (PowerShell: $env:BF_AI_TEST_KEY='...'; node --test tests/ai-openrouter-real.test.js)
 *
 *   BF_AI_TEST_KEY    a chave de API do OpenRouter (obrigatória; sem ela o teste é PULADO e a documentação marca "NÃO verificado em rede real")
 *   BF_AI_TEST_URL    a URL base (padrão https://openrouter.ai/api/v1); só vale o OpenRouter (ou um servidor da própria máquina, para ensaiar o teste)
 *   BF_AI_TEST_MODEL  o modelo gratuito fixo da etapa 5 (padrão: o primeiro "adequado" do catálogo ao vivo); precisa ser gratuito
 *
 * ORÇAMENTO: no MÁXIMO 8 pedidos de conversa no total (uma contagem na camada de rede BLOQUEIA o 9º). Pedidos feitos:
 *   - GET /key (antes e depois) e GET /models: não são conversa;
 *   - o modelo inválido (1 pedido), o roteador gratuito (1), o modelo gratuito fixo (1) e a mini-análise (2 pedidos; no pior caso 4, com 2
 *     tentativas por chamada). A trava que recusa um modelo pago real NÃO envia nada (o teste confere a contagem).
 * Tudo com dados SINTÉTICOS (a transcrição é inventada; nada do dono entra aqui). O aceite de privacidade é SIMULADO, só dentro do teste.
 *
 * O que ele confere (em rede real): o contador `free_model_daily_requests` do GET /key; o roteador (o campo `model` da resposta diz quem
 * respondeu; `usage.cost` 0); um modelo `:free` fixo; o erro de modelo inválido (HTTP 400 "is not a valid model ID" => MODEL, sem o `user_id`
 * da conta); a trava recusando um modelo pago REAL sem enviar nada; uma mini-análise pelo caminho real (runtime + manager + IPC).
 * Cada etapa imprime um diagnóstico (modelo que respondeu, tokens, custo, o corpo dos erros já sem chave nem user_id) para conferir os
 * formatos reais. Falhas transitórias do provedor de um modelo (limite do provedor, 5xx, tempo esgotado) pulam só a etapa do modelo fixo.
 *
 * SEGREDO: a chave só vai no cabeçalho Authorization para o OpenRouter. Aqui ela fica numa memória do teste (a etapa direta) e, na
 * mini-análise, no cofre de um perfil TEMPORÁRIO cifrado com uma máscara aleatória que só existe na memória (nenhum arquivo traz a chave
 * em claro; a pasta é apagada no fim). Todo texto impresso passa por `clean` e todo erro é reescrito sem pilha nem eco da chave.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createContext } = require('../src/ipc/context');
const { loadHandlers } = require('../src/ipc');
const { AiRuntime } = require('../src/core/ai/runtime');
const { chatCompletion } = require('../src/core/ai/client');
const A = require('./ai-fakes');
const F = require('./ai-openrouter-fakes');

const KEY = process.env.BF_AI_TEST_KEY || '';
const URL_BASE = (process.env.BF_AI_TEST_URL || 'https://openrouter.ai/api/v1').trim();
const MODEL_ENV = (process.env.BF_AI_TEST_MODEL || '').trim();
const MAX_CHAT_CALLS = 8;
const MOMENTS = [{ at: 120, punch: 'o bicho nem dropou couro' }, { at: 300, punch: 'obrigado jogo eu morri afogado' }];
const TINY = [{ role: 'user', content: 'Responda exatamente com o JSON {"ok":true} e mais nada.' }];

const isLoopback = (h) => /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/.test(String(h).toLowerCase());

function skipReason() {
  if (!KEY) return 'sem BF_AI_TEST_KEY: NÃO verificado em rede real (teste opt-in; veja o cabeçalho do arquivo)';
  let u;
  try { u = new URL(URL_BASE); } catch { return 'BF_AI_TEST_URL inválida'; }
  if (u.protocol !== 'https:' && !isLoopback(u.hostname)) return 'BF_AI_TEST_URL precisa ser https:// (a chave vai nesse endereço)';
  if (u.hostname !== 'openrouter.ai' && !isLoopback(u.hostname)) return 'BF_AI_TEST_URL não é do OpenRouter (este teste é só do OpenRouter; para outro provedor use tests/ai-real-network.test.js)';
  return false;
}

/** Tira a chave, pedaços com cara de chave e o identificador da conta de qualquer texto que vá para a saída. */
const clean = (value) => {
  let out = String(value === undefined || value === null ? '' : value);
  if (KEY.length >= 6) out = out.split(KEY).join('•••');
  return out
    .replace(/sk-or-[A-Za-z0-9._-]{6,}/g, '•••')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer •••')
    .replace(/"user_id"\s*:\s*"[^"]*"/g, '"user_id":"•••"')
    .replace(/\buser_[A-Za-z0-9]{8,}\b/g, '•••');
};

/** Erro novo, sem pilha nem propriedades (nada de eco de cabeçalhos): só a mensagem já limpa e o código. */
function sanitized(err, where) {
  const out = new Error(clean(`${where}: ${err && err.message ? err.message : err}`));
  if (err && typeof err.code === 'string') out.code = err.code;
  out.stack = `Error: ${out.message}`;
  return out;
}

/** `fetch` de verdade com contagem: BLOQUEIA o pedido de conversa que passar do orçamento. */
function makeCountingFetch(max) {
  const real = globalThis.fetch;
  const state = { chat: 0, blocked: 0, calls: [] };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = String(init.method || 'GET').toUpperCase();
    const isChat = method === 'POST' && /\/chat\/completions$/.test(u.pathname);
    if (isChat) {
      if (state.chat >= max) { state.blocked += 1; throw new Error(`orçamento do teste: no máximo ${max} pedidos de conversa`); }
      state.chat += 1;
    }
    const t0 = Date.now();
    const res = await real(url, init);
    state.calls.push({ method, path: u.pathname, status: res.status, ms: Date.now() - t0, chat: isChat });
    return res;
  };
  return { fetchImpl, state };
}

/** safeStorage de teste: "cifra" com uma máscara aleatória que só existe na memória (o arquivo não serve a ninguém sem ela). */
function maskedSafeStorage() {
  const pad = crypto.randomBytes(64);
  const xor = (buf) => Buffer.from(Buffer.from(buf).map((b, i) => b ^ pad[i % pad.length]));
  return { isEncryptionAvailable: () => true, encryptString: (text) => xor(Buffer.from(String(text), 'utf8')), decryptString: (buf) => xor(buf).toString('utf8') };
}

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
  return { deps, sent, lines, call: (channel, payload) => handlers.get(channel)({}, payload), events: (name) => sent.filter(([channel]) => channel === name).map(([, payload]) => payload) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(50); }
  throw new Error(`Tempo esgotado esperando: ${what}`);
}

const stamp = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')},${String(Math.round((s % 1) * 1000)).padStart(3, '0')}`;
const srtOf = (cues) => cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');
const validJson = (text) => { try { JSON.parse(text); return true; } catch { return false; } };
const secs = (ms) => Math.round(ms / 100) / 10;

/** O erro (já sem chave nem user_id) resumido para o diagnóstico: status, código e o começo do corpo, para conferir o formato real. */
const describeError = (err) => clean(`HTTP ${err && err.status !== undefined ? err.status : '-'} ${err && err.code ? err.code : ''}: ${err && err.message ? err.message : err}${err && err.responseBody ? ` | corpo: ${String(err.responseBody).slice(0, 300)}` : ''}`);

test('rede real (opt-in): OpenRouter só gratuitos com chave de teste — /key, roteador, modelo :free fixo, modelo inválido, trava de modelo pago e mini-análise sintética', { skip: skipReason(), timeout: 900000 }, async (t) => {
  const dir = F.tmpDir('bf-or-real-');
  t.after(() => F.cleanup(dir));
  const diag = (message) => t.diagnostic(clean(message));
  const budget = makeCountingFetch(MAX_CHAT_CALLS);
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const out = await fn();
      diag(`✔ ${name} (${secs(Date.now() - t0)} s)`);
      return out;
    } catch (err) { throw sanitized(err, name); }
  };

  // o app de verdade (todos os handlers), com a rede REAL contada e o cofre de chaves cifrado com a máscara aleatória
  const safeStorage = maskedSafeStorage();
  const fe = fakeElectron(path.join(dir, 'ud'));
  const ctx = createContext(fe.deps);
  ctx.aiOpenrouterOptions = { baseUrl: URL_BASE, fetchImpl: budget.fetchImpl, safeStorage, restrict: () => {} };
  ctx.analysisAiOptions = { safeStorage, restrict: () => {}, fetchImpl: budget.fetchImpl };
  const loaded = loadHandlers(ctx);
  assert.deepEqual(loaded.failed, [], 'os handlers carregaram');
  const service = ctx.aiOpenrouter;
  assert.ok(service, 'o serviço do OpenRouter existe');

  let quotaBefore = null;
  let fixedModel = '';
  let paidModel = '';

  await step('1. guarda a chave e escolhe o OpenRouter (o roteador gratuito já vem como modelo, interruptor "só gratuitos" ligado por padrão)', async () => {
    const saved = await fe.call('analysis:aiSave', { provider: 'openrouter', apiKey: KEY });
    assert.equal(saved.ok, true, clean(JSON.stringify(saved)));
    assert.equal(saved.ai.provider.freeOnly, true, 'interruptor ligado por padrão');
    assert.equal(saved.ai.provider.model, 'openrouter/free', 'o roteador gratuito é o modelo de partida (decisão do dono); nenhum modelo pago vem escolhido');
    assert.ok(!JSON.stringify(saved).includes(KEY), 'a chave não volta ao renderer');
  });

  await step('2. GET /key: o contador de pedidos gratuitos de hoje (free_model_daily_requests)', async () => {
    const info = await fe.call('aiOpenrouter:limits', { refresh: true });
    assert.equal(info.ok, true, clean(JSON.stringify(info)));
    assert.ok(info.freeDaily && Number.isFinite(info.freeDaily.limit) && Number.isFinite(info.freeDaily.remaining), 'free_model_daily_requests veio com used/limit/remaining');
    assert.ok(info.freeDaily.remaining >= MAX_CHAT_CALLS, `restam só ${info.freeDaily.remaining} pedidos gratuitos hoje; o teste precisa de até ${MAX_CHAT_CALLS}`);
    const text = JSON.stringify(info);
    assert.ok(!text.includes(KEY) && !/"label"/.test(text), 'a chave e o label mascarado não voltam');
    quotaBefore = info.freeDaily;
    diag(`/key: restam ${info.freeDaily.remaining} de ${info.freeDaily.limit} pedidos gratuitos hoje; chave gratuita: ${info.isFreeTier}; expira em: ${info.expiresAt || 'não expira'}; teto da chave em US$: ${info.limit}; renova: ${info.resetText}`);
  });

  await step('3. catálogo ao vivo: roteador primeiro, um modelo gratuito fixo adequado e um modelo PAGO real para a trava', async () => {
    const free = await fe.call('aiOpenrouter:models', { refresh: true });
    assert.ok(Array.isArray(free.list) && free.list.length > 0, clean(JSON.stringify(free).slice(0, 300)));
    assert.equal(free.list[0].id, 'openrouter/free', 'o roteador gratuito é o primeiro');
    const suitable = free.list.filter((x) => x.group === 'free');
    assert.ok(suitable.length >= 1, 'há ao menos um modelo gratuito adequado à análise');
    fixedModel = MODEL_ENV || suitable[0].id;
    assert.equal(service.checkModel(fixedModel, { freeOnly: true }).ok, true, `BF_AI_TEST_MODEL (${fixedModel}) não é gratuito segundo o catálogo de hoje: o teste só gasta pedidos gratuitos`);
    const all = await fe.call('aiOpenrouter:models', { freeOnly: false });
    const paidItems = all.list.filter((x) => x.group === 'paid');
    const paid = paidItems.find((x) => !/^openrouter\//.test(x.id)) || paidItems[0]; // um modelo pago "de verdade", não o roteador automático
    assert.ok(paid, 'o catálogo tem modelos pagos');
    paidModel = paid.id;
    diag(`catálogo (${free.source}): ${JSON.stringify(free.counts)}; modelo gratuito fixo: ${fixedModel}${MODEL_ENV ? ' (BF_AI_TEST_MODEL)' : ' (o primeiro adequado)'}; modelo pago para a trava: ${paidModel}`);
  });

  await step('4. a trava recusa um modelo PAGO REAL antes de qualquer pedido (nada é enviado)', async () => {
    const before = budget.state.chat;
    const verdict = service.checkModel(paidModel, { freeOnly: true });
    assert.deepEqual([verdict.ok, verdict.code], [false, 'NOT_FREE']);
    const forced = await fe.call('analysis:aiSave', { model: paidModel });
    assert.equal(forced.ok, true);
    assert.deepEqual([forced.ai.provider.ready, forced.ai.provider.reasonCode], [false, 'NOT_FREE']);
    const started = await fe.call('analysis:start', { engine: 'ai', projectId: 'proj-real', path: path.join(dir, 'nada.mp4'), size: 1, duration: 600, params: {}, meta: {}, existingCuts: [] });
    assert.deepEqual([started.ok, started.code], [false, 'NOT_FREE'], 'a análise recusa');
    const tested = await fe.call('analysis:aiTest');
    assert.deepEqual([tested.ok, tested.code], [false, 'NOT_FREE'], 'o teste de conexão recusa');
    assert.equal(budget.state.chat, before, 'nenhum pedido de conversa saiu');
    const restored = await fe.call('analysis:aiSave', { model: 'openrouter/free' });
    assert.equal(restored.ai.provider.ready, true, 'voltando ao roteador gratuito o provedor fica pronto');
    diag(`trava: "${paidModel}" recusado com NOT_FREE na configuração, na análise e no teste de conexão; pedidos de conversa antes e depois: ${before} e ${budget.state.chat}`);
  });

  await step('5. modelo inválido: o erro REAL do OpenRouter vira MODEL e não traz o user_id da conta (1 pedido de conversa)', async () => {
    const before = budget.state.chat;
    const bogus = 'bf-teste-inexistente/modelo-que-nao-existe:free';
    let caught = null;
    try {
      await chatCompletion({ baseUrl: service.baseUrl, apiKey: KEY, model: bogus, messages: TINY, maxTokens: 16, fetchImpl: budget.fetchImpl });
    } catch (err) { caught = err; }
    assert.ok(caught, 'o OpenRouter deveria recusar um modelo que não existe');
    const mapped = service.mapError(caught, { model: bogus });
    diag(`modelo inválido: ${describeError(caught)} -> mapeado: ${mapped.code}`);
    assert.ok([400, 404].includes(caught.status), `status inesperado: ${caught.status}`);
    assert.equal(caught.code, 'MODEL');
    assert.equal(mapped.code, 'MODEL');
    const everything = `${caught.message}|${caught.responseBody}|${JSON.stringify(mapped)}|${caught.stack}`;
    assert.ok(!/user_[A-Za-z0-9]{8,}/.test(everything), 'o user_id da conta não aparece no erro');
    assert.ok(!everything.includes(KEY), 'a chave não aparece no erro');
    assert.equal(budget.state.chat, before + 1, 'um pedido de conversa');
  });

  // a etapa direta (roteador e modelo fixo) usa o runtime de verdade com a chave só na memória do teste (nenhum arquivo a guarda)
  const runtime = new AiRuntime({ dir: path.join(dir, 'direct', 'ai'), safeStorage: null, fetchImpl: budget.fetchImpl, restrict: () => {}, openrouter: service });
  const memory = new Map();
  runtime.secrets = {
    mode: () => 'memory', status: (id) => (memory.has(id) ? 'ok' : 'none'), has: (id) => memory.has(id),
    get: (id) => memory.get(id) || null, set: (id, value) => { memory.set(id, String(value).trim()); }, remove: (id) => memory.delete(id)
  };
  runtime.save({ provider: 'openrouter', model: 'openrouter/free', apiKey: KEY });
  runtime.accept(true); // aceite de privacidade SIMULADO, só dentro do teste (a conversa leva só um pedido sintético)
  const chatOnce = async () => runtime.chat({ system: 'Você responde apenas com JSON válido.', messages: TINY, maxTokens: 600, temperature: 0, jsonMode: true });

  await step('6. roteador gratuito (openrouter/free): responde e o `model` da resposta diz quem respondeu (1 pedido de conversa)', async () => {
    const t0 = Date.now();
    let res;
    try {
      res = await chatOnce();
    } catch (err) {
      // o roteador sorteia: já saiu um modelo de moderação (medido em rede real) e o app o descarta como falha (BAD_RESPONSE); um limite
      // do provedor sorteado também é transitório. Nenhum dos dois é defeito do app: registra e segue (a mini-análise confere o caminho todo).
      if (err && err.code === 'BAD_RESPONSE' && /modelo de moderação/.test(String(err.message))) {
        diag(`roteador: sorteou um modelo de moderação e o app descartou a resposta como falha, como esperado (${describeError(err)}); etapa registrada`);
        return;
      }
      if (['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'INTERRUPTED', 'NETWORK'].includes(err && err.code)) {
        diag(`roteador: o provedor do modelo sorteado não respondeu agora (${describeError(err)}); esta etapa foi PULADA (falha transitória do provedor, não do app)`);
        return;
      }
      throw err;
    }
    assert.equal(res.requestedModel, 'openrouter/free');
    assert.ok(typeof res.answeredModel === 'string' && res.answeredModel, 'a resposta traz o campo `model`');
    assert.ok(!(res.usage.cost > 0), `o roteador gratuito informou custo (US$ ${res.usage.cost})`);
    // conteúdo vazio de um modelo sorteado é só um aviso (a mini-análise confere o caminho todo); não derruba as etapas seguintes
    if (!res.text.trim()) diag(`ATENÇÃO: o roteador respondeu sem conteúdo (finish_reason ${res.finishReason}); modelos que "pensam" às vezes gastam o limite de saída raciocinando`);
    diag(`roteador: respondeu "${res.answeredModel}" (pedido: openrouter/free; diferente: ${res.answeredModel !== 'openrouter/free'}; gratuito pelo catálogo: ${service.checkModel(res.answeredModel, { freeOnly: true }).ok}) em ${secs(Date.now() - t0)} s; finish_reason ${res.finishReason}; tokens ${res.usage.promptTokens}+${res.usage.completionTokens} (a saída inclui o raciocínio); custo US$ ${res.usage.cost}; JSON válido: ${validJson(res.text)}; conteúdo vazio: ${!res.text.trim()}`);
  });

  await step(`7. modelo gratuito fixo (${MODEL_ENV ? 'BF_AI_TEST_MODEL' : 'o primeiro adequado do catálogo'}): responde (1 pedido de conversa)`, async () => {
    runtime.save({ model: fixedModel });
    const t0 = Date.now();
    let res;
    try {
      res = await chatOnce();
    } catch (err) {
      if (['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'INTERRUPTED', 'NETWORK'].includes(err && err.code)) {
        diag(`modelo fixo "${fixedModel}": o provedor do modelo não respondeu agora (${describeError(err)}); esta etapa foi PULADA (falha transitória do provedor, não do app)`);
        return;
      }
      diag(`modelo fixo "${fixedModel}" falhou: ${describeError(err)}`);
      throw err;
    }
    assert.equal(res.requestedModel, fixedModel);
    assert.ok(typeof res.answeredModel === 'string' && res.answeredModel, 'a resposta traz o campo `model`');
    assert.ok(!(res.usage.cost > 0), `o modelo gratuito informou custo (US$ ${res.usage.cost})`);
    diag(`modelo fixo: pedido "${fixedModel}", respondeu "${res.answeredModel}" em ${secs(Date.now() - t0)} s; finish_reason ${res.finishReason}; tokens ${res.usage.promptTokens}+${res.usage.completionTokens}; custo US$ ${res.usage.cost}; JSON válido: ${validJson(res.text)}`);
  });

  await step('8. mini-análise com transcrição SINTÉTICA pelo caminho real (IPC + manager + runtime), com o roteador e a reserva gratuita', async () => {
    const tr = A.makeTranscript({ minutes: 12, moments: MOMENTS });
    const video = path.join(dir, 'sintetico.mp4');
    fs.writeFileSync(video, Buffer.alloc(2048, 7));
    const srt = path.join(dir, 'sintetico.srt');
    fs.writeFileSync(srt, srtOf(tr.cues));
    const src = { projectId: 'proj-real', path: video, size: 2048, duration: tr.duration };
    let r = await fe.call('analysis:aiSave', { provider: 'openrouter', model: 'openrouter/free', fallbackModels: [fixedModel], limits: { attempts: 2 } });
    assert.equal(r.ok, true, clean(JSON.stringify(r)));
    assert.equal(r.ai.provider.ready, true, clean(r.ai.provider.reason));
    r = await fe.call('analysis:aiAccept', { accepted: true }); // aceite SIMULADO, só dentro do teste
    assert.equal(r.ok, true);
    r = await fe.call('analysis:transcriptImport', { ...src, subtitlePath: srt });
    assert.equal(r.ok, true, clean(JSON.stringify(r)));
    const chatBefore = budget.state.chat;
    fe.sent.length = 0;
    const t0 = Date.now();
    const started = await fe.call('analysis:start', {
      engine: 'ai', ...src, params: { minDurationSec: 15, maxDurationSec: 60, padBeforeSec: 2, padAfterSec: 1, minRelevance: 0.4, perHour: 20 },
      meta: { title: 'Teste de rede real (sintético)' }, existingCuts: []
    });
    assert.equal(started.ok, true, clean(JSON.stringify(started)));
    const end = await waitFor(() => fe.events('analysis:done')[0] || fe.events('analysis:failed')[0], 600000, 'fim da análise');
    if (!end.result) throw new Error(`a análise falhou (${end.code}): ${end.message}`);
    const ai = end.result.ai;
    const switched = fe.events('analysis:progress').filter((p) => /não respondeu/.test(p.message)).map((p) => p.message);
    diag(`mini-análise: ${end.result.suggestions.length} sugestão(ões) em ${secs(Date.now() - t0)} s; ${ai.calls} chamada(s) (${budget.state.chat - chatBefore} pedido(s) de conversa na rede), ${ai.retries} nova(s) tentativa(s); tokens ${ai.promptTokens}+${ai.completionTokens}; modelos que responderam: ${JSON.stringify(ai.models)}; avisos: ${JSON.stringify(end.result.warnings.map((w) => w.code))}; trocas de modelo: ${switched.length ? switched.join(' | ') : 'nenhuma'}; descartes: ${JSON.stringify(ai.droppedByReason)}`);
    assert.equal(end.result.engine, 'ai');
    assert.equal(ai.model, 'openrouter/free', 'o escolhido continua sendo o roteador');
    assert.ok(ai.calls >= 1);
    assert.ok(ai.models && Object.keys(ai.models).length >= 1, 'o modelo que de fato respondeu foi registrado (campo `model` da resposta)');
    assert.ok(!end.result.warnings.some((w) => w.code === 'AI_COST_REPORTED'), 'o OpenRouter não informou custo em nenhum pedido');
    assert.ok(!JSON.stringify(end.result).includes(KEY), 'a chave não está no resultado');
  });

  await step('9. GET /key de novo: quanto o teste gastou da cota gratuita', async () => {
    const info = await fe.call('aiOpenrouter:limits', { refresh: true });
    assert.equal(info.ok, true, clean(JSON.stringify(info)));
    diag(`pedidos gratuitos: restavam ${quotaBefore.remaining} e agora restam ${info.freeDaily.remaining} (o teste fez ${budget.state.chat} pedido(s) de conversa na rede; limite do teste: ${MAX_CHAT_CALLS})`);
  });

  // ---- orçamento e segredos ----
  diag(`rede: ${budget.state.calls.map((c) => `${c.method} ${c.path} ${c.status}`).join(' | ')}`);
  assert.equal(budget.state.blocked, 0, `o orçamento de ${MAX_CHAT_CALLS} pedidos de conversa foi estourado (${budget.state.blocked} pedido(s) bloqueado(s))`);
  assert.ok(budget.state.chat <= MAX_CHAT_CALLS);
  assert.ok(!JSON.stringify(fe.sent).includes(KEY), 'a chave apareceu em um evento para a interface');
  assert.ok(!JSON.stringify(fe.lines).includes(KEY), 'a chave apareceu no log');
  assert.ok(!/user_[A-Za-z0-9]{8,}/.test(JSON.stringify(fe.sent) + JSON.stringify(fe.lines)), 'o user_id da conta apareceu em evento ou log');
  for (const f of F.readAll(dir)) assert.ok(!f.text.includes(KEY), `a chave apareceu em um arquivo (${path.basename(f.file)})`);
});

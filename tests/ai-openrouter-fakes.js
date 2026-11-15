'use strict';

/**
 * Utilitários dos testes do OpenRouter "só com modelos gratuitos" (tests/ai-openrouter-*.test.js e tests/e2e/ai-openrouter.e2e.js):
 * um servidor HTTP LOCAL de verdade que imita o OpenRouter (`/api/v1/models` com gratuitos, pagos, expirados, de áudio, sem JSON e com
 * preço extra; `/api/v1/key` com `free_model_daily_requests`; `/api/v1/chat/completions` com 429 com e sem Retry-After, 404 de política de
 * dados, 400 de modelo inválido, 402, 5xx e resposta com `model` diferente do pedido).
 *
 * FORMATOS OBSERVADOS EM REDE REAL (2026-10-23, sondagem do orquestrador com chave de teste de 1 dia e dados sintéticos): `GET /key` (200)
 * com `data.free_model_daily_requests {used,limit,remaining}`, `is_free_tier`, `expires_at`, `limit`/`limit_remaining`, `budgets[]`,
 * `effective_budget`, `usage*`, `rate_limit` (obsoleto) e `label` mascarado; chat 200 com o campo `model` DIFERENTE do pedido ao roteador,
 * `usage.cost` 0, `usage.completion_tokens` INCLUINDO o raciocínio (`completion_tokens_details.reasoning_tokens`) e `message.reasoning`
 * separado de `message.content`; modelo inválido = HTTP 400 `{"error":{"message":"<id> is not a valid model ID","code":400},"user_id":"user_…"}`
 * (NÃO 404). O resto dos corpos de erro (429 por minuto/dia, 404 de política de dados, 402, 5xx) segue a documentação do OpenRouter e NÃO
 * foi conferido em rede real (veja src/core/ai/openrouter/errors.js). Não é um teste: o nome não termina em ".test.js".
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Chave FALSA: os testes provam que ela nunca aparece em retorno, erro, log, tela nem arquivo. */
const KEY = 'sk-or-v1-bftest0123456789abcdefghijklmnopqrstuvwxyz0123456789ab';
/** Trecho mascarado como o OpenRouter devolve em `label`: também nunca pode aparecer. */
const KEY_LABEL = 'sk-or-v1-bfte...89ab';
/** Identificador FALSO da conta (o OpenRouter repete `user_id` no corpo de erros): nunca pode aparecer em erro, log, tela nem arquivo. */
const USER_ID = 'user_2bfTESTaccount0123456789';

const DAY_MS = 24 * 60 * 60 * 1000;

function tmpDir(prefix = 'bf-or-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}

/** 'YYYY-MM-DD' (UTC) de daqui a `days` dias (pode ser negativo). */
function dayFromNow(days, now = Date.now()) {
  return new Date(now + days * DAY_MS).toISOString().slice(0, 10);
}

/** Um modelo no formato do `GET /models` do OpenRouter. */
function rawModel(id, o = {}) {
  const {
    name = id, ctx = 128000, json = true, structured = false, input = ['text'], output = ['text'],
    prompt = '0', completion = '0', pricing, expires = null, maxOut = 8192, noPricing = false, extra = {}
  } = o;
  const supported = ['max_tokens', 'temperature', 'top_p', ...(json ? ['response_format'] : []), ...(structured ? ['structured_outputs'] : [])];
  const model = {
    id,
    canonical_slug: id,
    name,
    created: 1790000000,
    description: 'Descrição longa que o app não precisa guardar. '.repeat(4),
    context_length: ctx,
    architecture: { modality: `${input.join('+')}->${output.join('+')}`, input_modalities: input, output_modalities: output, tokenizer: 'Other', instruct_type: null },
    top_provider: { context_length: ctx, max_completion_tokens: maxOut, is_moderated: false },
    per_request_limits: null,
    supported_parameters: supported,
    default_parameters: {},
    expiration_date: expires,
    ...extra
  };
  if (!noPricing) model.pricing = pricing || { prompt, completion };
  return model;
}

/**
 * O catálogo de teste. Tudo é fictício (nada aqui finge ser um modelo real). `now` fixa as datas de expiração.
 * Ordem esperada com o interruptor ligado: roteador; adequados por contexto (1 mi, 262144 por nome, 65536, 60000, os que expiram >= 14 d);
 * depois os demais gratuitos com o motivo.
 */
function makeCatalogModels(now = Date.now()) {
  return [
    // ---- gratuitos adequados ----
    rawModel('acme/grande-ctx:free', { name: 'Acme: Grande Contexto (free)', ctx: 1000000, json: true, structured: true }),
    rawModel('zeta/medio-b:free', { name: 'Zeta: Medio B (free)', ctx: 262144, json: false, structured: true }),
    rawModel('acme/medio-a:free', { name: 'Acme: Medio A (free)', ctx: 262144 }),
    rawModel('beta/pequeno-ok:free', { name: 'Beta: Pequeno Ok (free)', ctx: 65536 }),
    rawModel('edge/ctx-60000:free', { name: 'Edge: Contexto 60000 (free)', ctx: 60000 }),
    rawModel('later/expira-em-60-dias:free', { name: 'Later: Expira em 60 dias (free)', ctx: 200000, expires: dayFromNow(60, now) }),
    rawModel('edge/expira-em-15-dias:free', { name: 'Edge: Expira em 15 dias (free)', ctx: 90000, expires: dayFromNow(15, now) }),
    // ---- gratuitos NÃO adequados ----
    rawModel('edge/ctx-59999:free', { name: 'Edge: Contexto 59999 (free)', ctx: 59999 }),
    rawModel('omega/sem-json:free', { name: 'Omega: Sem JSON (free)', ctx: 128000, json: false }),
    rawModel('omega/expira-logo:free', { name: 'Omega: Expira logo (free)', ctx: 128000, expires: dayFromNow(7, now) }),
    rawModel('omega/expirou:free', { name: 'Omega: Já expirou (free)', ctx: 128000, expires: dayFromNow(-2, now) }),
    rawModel('omega/nemo-guard-x:free', { name: 'Omega: Guard X (free)', ctx: 128000 }),
    rawModel('omega/content-safety:free', { name: 'Omega: Content Safety (free)', ctx: 128000 }),
    rawModel('omega/embed-lite:free', { name: 'Omega: Embed Lite (free)', ctx: 128000 }),
    rawModel('musica/lyria-like', { name: 'Musica: Lyria Like', ctx: 1000000, output: ['text', 'audio'] }),
    rawModel('imagem/gerador:free', { name: 'Imagem: Gerador (free)', ctx: 128000, output: ['image', 'text'] }),
    // ---- formatos de preço que continuam gratuitos ----
    rawModel('fmt/zeros-texto:free', { name: 'Fmt: Zeros em texto (free)', ctx: 100000, prompt: '0.0', completion: '0.0000000' }),
    rawModel('fmt/zeros-numero:free', { name: 'Fmt: Zeros em número (free)', ctx: 99000, pricing: { prompt: 0, completion: 0 } }),
    rawModel('fmt/override-zero:free', { name: 'Fmt: Faixa com zeros (free)', ctx: 98000, pricing: { prompt: '0', completion: '0', overrides: [{ min_prompt_tokens: 100000, prompt: '0', completion: '0' }] } }),
    // ---- ARMADILHAS: parecem gratuitos e NÃO são ----
    rawModel('trap/preco-extra:free', { name: 'Trap: Preço por pedido (free)', pricing: { prompt: '0', completion: '0', request: '0.01' } }),
    rawModel('trap/web-search:free', { name: 'Trap: Busca na web (free)', pricing: { prompt: '0', completion: '0', web_search: '0.014' } }),
    rawModel('trap/imagem-paga:free', { name: 'Trap: Imagem paga (free)', pricing: { prompt: '0', completion: '0', image: '0.002' } }),
    rawModel('trap/override:free', { name: 'Trap: Faixa paga (free)', pricing: { prompt: '0', completion: '0', overrides: [{ min_prompt_tokens: 100000, prompt: '0.000001', completion: '0.000002' }] } }),
    rawModel('trap/so-prompt-gratis', { name: 'Trap: Só a entrada é grátis', pricing: { prompt: '0', completion: '0.000001' } }),
    rawModel('trap/sem-preco', { name: 'Trap: Sem preço', noPricing: true }),
    rawModel('trap/preco-texto', { name: 'Trap: Preço em texto', pricing: { prompt: 'gratis', completion: 'gratis' } }),
    rawModel('trap/preco-vazio', { name: 'Trap: Preço vazio', pricing: { prompt: '', completion: '' } }),
    rawModel('trap/preco-nulo', { name: 'Trap: Preço nulo', pricing: { prompt: null, completion: null } }),
    // ---- roteadores ----
    rawModel('openrouter/free', { name: 'Free Models Router', ctx: 200000, structured: true, maxOut: null }),
    rawModel('openrouter/auto', { name: 'Auto Router', ctx: 2000000, pricing: { prompt: '-1', completion: '-1' } }),
    // ---- pagos ----
    rawModel('vendor/pago-barato', { name: 'Vendor: Pago Barato', ctx: 1048576, pricing: { prompt: '0.0000003', completion: '0.0000025', image: '0.0000003' } }),
    rawModel('vendor/pago-caro', { name: 'Vendor: Pago Caro', ctx: 200000, pricing: { prompt: '0.000015', completion: '0.000075' } }),
    rawModel('vendor/pago-curto', { name: 'Vendor: Pago Curto', ctx: 8192, json: false, pricing: { prompt: '0.000001', completion: '0.000002' } }),
    rawModel('vendor/pago-imagem', { name: 'Vendor: Gera Imagem', output: ['text', 'image'], pricing: { prompt: '0.000001', completion: '0.000002' } })
  ];
}

const catalogBody = (now = Date.now()) => { const data = makeCatalogModels(now); return { data, total_count: data.length, links: {} }; };

// ---------- corpos de erro (o `user_id` da conta vem em todos: o app não pode deixá-lo escapar) ----------

const errorBody = (code, message, metadata) => ({ error: { code, message, ...(metadata ? { metadata } : {}) }, user_id: USER_ID });
const midnightUtc = (now = Date.now()) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };

const ERRORS = {
  rateLimitMinute: (now = Date.now()) => ({
    status: 429,
    headers: { 'retry-after': '7', 'x-ratelimit-limit': '20', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now + 30000) },
    json: errorBody(429, 'Rate limit exceeded: free-models-per-min. Please retry shortly.', { headers: { 'X-RateLimit-Limit': '20', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(now + 30000) } })
  }),
  rateLimitMinuteNoHeaders: () => ({ status: 429, json: errorBody(429, 'Rate limit exceeded: free-models-per-min.') }),
  rateLimitDay: (now = Date.now()) => ({
    status: 429,
    headers: { 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(midnightUtc(now)) },
    json: errorBody(429, 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', { headers: { 'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(midnightUtc(now)) } })
  }),
  upstream429: () => ({
    status: 429,
    json: errorBody(429, 'Provider returned error', { raw: 'acme/medio-a:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits.', provider_name: 'Acme Cloud' })
  }),
  dataPolicy404: () => ({ status: 404, json: errorBody(404, 'No endpoints found matching your data policy (Free model training). Configure: https://openrouter.ai/settings/privacy') }),
  modelGone404: (id = 'acme/some-model:free') => ({ status: 404, json: errorBody(404, `No endpoints found for ${id}.`) }),
  // OBSERVADO em rede real: modelo inexistente/inválido é HTTP 400 (não 404), com o `user_id` da conta no corpo
  invalidModel400: (id = 'acme/some-model:free') => ({ status: 400, json: { error: { message: `${id} is not a valid model ID`, code: 400 }, user_id: USER_ID } }),
  credits402: () => ({ status: 402, json: errorBody(402, 'Insufficient credits. Add more using https://openrouter.ai/credits') }),
  auth401: () => ({ status: 401, json: errorBody(401, `Invalid API key: ${KEY} (key not found)`) }),
  server503: () => ({ status: 503, json: errorBody(503, 'Provider returned error', { raw: 'upstream connect error', provider_name: 'Acme Cloud' }) }),
  server500: () => ({ status: 500, json: errorBody(500, 'Internal Server Error') }),
  badRequestContext: () => ({ status: 400, json: errorBody(400, "This model's maximum context length is 65536 tokens. However, you requested about 90000 tokens.") })
};

/**
 * Resposta de chat válida no formato observado em rede real. `answered` é o campo `model` (o modelo que respondeu de verdade; com o roteador
 * DIFERE do pedido). `reasoning` simula os modelos que "pensam": o raciocínio vem em `message.reasoning`, SEPARADO de `message.content`, e
 * `usage.completion_tokens` já o INCLUI (`completion_tokens_details.reasoning_tokens`). `cost` é o `usage.cost` em US$ (0 nos gratuitos).
 */
function chatBody(content, { answered = 'fake/answered:free', promptTokens = 100, reasoning = null, reasoningTokens, completionTokens, cost = 0, finishReason = 'stop' } = {}) {
  const thinking = reasoningTokens === undefined ? (reasoning ? 75 : 0) : reasoningTokens;
  const completion = completionTokens === undefined ? 20 + thinking : completionTokens;
  return {
    id: 'gen-test', object: 'chat.completion', model: answered,
    choices: [{ index: 0, message: { role: 'assistant', content, ...(reasoning ? { reasoning } : {}) }, finish_reason: finishReason }],
    usage: {
      prompt_tokens: promptTokens, completion_tokens: completion, total_tokens: promptTokens + completion, cost,
      cost_details: { upstream_inference_cost: cost, upstream_inference_prompt_cost: 0, upstream_inference_completions_cost: cost },
      completion_tokens_details: { reasoning_tokens: thinking }
    }
  };
}

/**
 * Corpo de `GET /key` no formato OBSERVADO em rede real: `data.free_model_daily_requests {used,limit,remaining}`, `is_free_tier`, `expires_at`
 * (chave temporária), teto em US$ da chave (`limit`/`limit_remaining`), `budgets`, `effective_budget`, `usage*`, `rate_limit` (obsoleto) e
 * `label` (trecho mascarado da chave).
 */
function keyBody({ used = 12, limit = 50, remaining, isFreeTier = true, expiresAt = new Date(Date.now() + DAY_MS).toISOString(), extra = {} } = {}) {
  return {
    data: {
      label: KEY_LABEL, limit: 0.1, limit_reset: null, limit_remaining: 0.1, usage: 0, usage_daily: 0, usage_weekly: 0, usage_monthly: 0,
      is_free_tier: isFreeTier, expires_at: expiresAt,
      budgets: [], effective_budget: { limit_usd: 0.1, spend_usd: 0, remaining_usd: 0.1 },
      rate_limit: { requests: -1, interval: '10s', note: 'This field is deprecated and safe to ignore.' },
      free_model_daily_requests: { used, limit, remaining: remaining === undefined ? limit - used : remaining },
      ...extra
    }
  };
}

/**
 * Sobe o servidor. `routes` (todas opcionais, podem ser trocadas depois em `mock.routes`) recebem { n, method, path, headers, body, raw } e
 * devolvem uma ação: { status?, json?, text?, headers?, delayMs? } | { hang:true } | { drop:true }.
 *   routes.models(call)  GET  /api/v1/models            (padrão: catalogBody())
 *   routes.key(call)     GET  /api/v1/key               (padrão: 401 sem a chave certa; senão keyBody())
 *   routes.chat(call)    POST /api/v1/chat/completions  (padrão: 200 com o modelo pedido)
 * Registra tudo em `calls` (com o cabeçalho de autenticação recebido: provas de que /models não leva chave).
 */
async function startMockOpenRouter(routes = {}) {
  const calls = [];
  const sockets = new Set();
  const mock = { routes: { ...routes }, calls };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const url = new URL(req.url, 'http://127.0.0.1');
      const call = { n: calls.length + 1, method: req.method, path: url.pathname, headers: req.headers, body, raw };
      calls.push(call);
      let action;
      try {
        if (req.method === 'GET' && url.pathname === '/api/v1/models') action = await (mock.routes.models ? mock.routes.models(call) : { json: catalogBody() });
        else if (req.method === 'GET' && url.pathname === '/api/v1/key') {
          action = await (mock.routes.key ? mock.routes.key(call) : (call.headers.authorization === `Bearer ${KEY}` ? { json: keyBody() } : ERRORS.auth401()));
        } else if (req.method === 'POST' && url.pathname === '/api/v1/chat/completions') {
          action = await (mock.routes.chat ? mock.routes.chat(call) : { json: chatBody('ok', { answered: body && body.model }) });
        } else action = { status: 404, json: errorBody(404, 'rota desconhecida do servidor de teste') };
      } catch (err) { action = { status: 500, json: errorBody(500, `handler do teste: ${err.message}`) }; }
      action = action || {};
      if (action.hang) return;
      if (action.drop) { req.socket.destroy(); return; }
      if (action.delayMs) await new Promise((r) => setTimeout(r, action.delayMs));
      if (res.destroyed) return;
      const payload = action.text !== undefined ? action.text : JSON.stringify(action.json !== undefined ? action.json : {});
      res.writeHead(action.status || 200, { 'content-type': action.text !== undefined ? 'text/plain' : 'application/json', ...(action.headers || {}) });
      res.end(payload);
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return Object.assign(mock, {
    port,
    base: `http://127.0.0.1:${port}/api/v1`,
    origin: `http://127.0.0.1:${port}`,
    /** Quantos pedidos de cada tipo chegaram. */
    count(method, p) { return calls.filter((c) => c.method === method && c.path === p).length; },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

/**
 * Cliente de chat MÍNIMO para os testes de fallback: faz `POST {base}/chat/completions` e, em erro, lança um erro com o formato que a
 * fase 2 pede ao cliente de verdade (src/core/ai/client.js): `status`, `code`, `retryAfterSec`, `responseBody` (texto) e
 * `responseHeaders` (objeto simples). Devolve { text, model } onde `model` é o campo `model` da resposta.
 */
async function chat({ base, key, model, content = 'oi', signal }) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content }], stream: false }), signal });
  const text = await res.text();
  if (!res.ok) {
    const responseHeaders = Object.fromEntries(res.headers.entries());
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.code = res.status === 401 || res.status === 403 ? 'AUTH' : res.status === 404 ? 'MODEL' : res.status === 429 ? 'RATE_LIMIT' : res.status >= 500 ? 'SERVER' : 'BAD_REQUEST';
    err.responseBody = text;
    err.responseHeaders = responseHeaders;
    const retry = Number(responseHeaders['retry-after']);
    if (Number.isFinite(retry)) err.retryAfterSec = retry;
    throw err;
  }
  const data = JSON.parse(text);
  return { text: data.choices[0].message.content, model: data.model };
}

/** safeStorage de mentira: "cifra" invertendo e somando 1 a cada byte (nunca contém a chave em claro). */
function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(Buffer.from(String(text), 'utf8').map((b) => (b + 1) & 0xff).reverse()),
    decryptString: (buf) => Buffer.from(Buffer.from(buf).reverse().map((b) => (b - 1) & 0xff)).toString('utf8')
  };
}

/** Todos os arquivos (recursivo) de uma pasta, com o conteúdo, para procurar a chave. */
function readAll(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...readAll(p)); else out.push({ file: p, text: fs.readFileSync(p).toString('latin1') });
  }
  return out;
}

/** O valor (qualquer coisa serializável) cita o texto? */
function mentions(value, text) {
  return String(typeof value === 'string' ? value : JSON.stringify(value)).includes(text);
}

module.exports = {
  KEY, KEY_LABEL, USER_ID, DAY_MS, tmpDir, cleanup, dayFromNow, rawModel, makeCatalogModels, catalogBody, ERRORS, errorBody, midnightUtc, chatBody, keyBody,
  startMockOpenRouter, chat, fakeSafeStorage, readAll, mentions
};

'use strict';

/**
 * Catálogo PÚBLICO de modelos do OpenRouter (`GET {baseUrl}/models`, sem chave) e a lista de seleção da interface.
 * Especificação: docs/recursos/openrouter-gratuito.md (seção 2). A lista de modelos gratuitos MUDA com frequência: nada aqui fixa
 * nome de modelo (o único id conhecido é o do roteador gratuito, `openrouter/free`, que a própria documentação do OpenRouter define).
 *
 * Regras (as mesmas da especificação):
 *   - GRATUITO = `pricing.prompt == 0` e `pricing.completion == 0` e nenhum outro preço positivo em `pricing` (imagem, pedido, busca na
 *     web, raciocínio interno, cache, faixas em `overrides`…). Preço ausente, ilegível ou negativo (-1 = preço variável dos roteadores
 *     pagos) NÃO é gratuito: na dúvida, é pago.
 *   - TEXTO = saída só `text` e entrada com `text` (exclui geração de áudio/música/imagem).
 *   - ADEQUADO À ANÁLISE = texto, contexto >= 60 mil, aceita `response_format` ou `structured_outputs`, não expira em menos de 14 dias e
 *     o id não casa com /safety|guard|moderation|embed|rerank/i.
 *   - Cache em `<dir>/openrouter-models.json` (gravação atômica), vale 6 h; `refresh` ignora; sem rede usa o último cache e informa a data;
 *     cache ilegível é ignorado sem travar. O cache guarda só o necessário (não as descrições): o que depende da data de hoje
 *     (adequado, expira em N dias) é recalculado a cada uso.
 *
 * Nada aqui envia chave: o pedido é público e vai SEM o cabeçalho Authorization.
 */

const path = require('node:path');
const { writeJsonAtomic, readJsonFile } = require('../../preferences/atomic');

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const ROUTER_ID = 'openrouter/free';
const ROUTER_LABEL = 'Automático — roteador gratuito';
const CACHE_FILE = 'openrouter-models.json';
const CACHE_VERSION = 1;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20000;
const MAX_BODY_CHARS = 25 * 1024 * 1024;
const MIN_CONTEXT = 60000;
const MIN_DAYS_TO_EXPIRE = 14;
const UNSUITABLE_ID_RE = /safety|guard|moderation|embed|rerank/i;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Chaves de `pricing` (e de `pricing.overrides[]`) que descrevem CONDIÇÃO da faixa, não preço. */
const PRICE_META_KEY_RE = /^(?:min_|max_|utc_)|_tokens$/;

class CatalogError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

/** URL base: http(s), sem usuário/senha/parâmetros, sem barra final. */
function normalizeBase(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { throw new CatalogError('INVALID_ARGS', 'Endereço do OpenRouter inválido.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CatalogError('INVALID_ARGS', 'O endereço do OpenRouter deve começar com https://.');
  if (url.username || url.password || url.search || url.hash) throw new CatalogError('INVALID_ARGS', 'O endereço do OpenRouter não deve ter usuário, parâmetros nem âncora.');
  return url.origin + (url.pathname.replace(/\/+$/, '') || '');
}

// ---------- preços ----------

/** Número de um preço do catálogo (texto ou número). NaN quando ausente/ilegível: `Number('')` e `Number(null)` valem 0 e NÃO podem passar por grátis. */
function parsePrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return NaN;
  return Number(text);
}

/** Existe algum preço positivo (ou variável, negativo) em `obj`, em qualquer nível, ignorando as chaves de condição? */
function hasNonFreePrice(obj, skip = [], depth = 0) {
  if (depth > 4 || obj === null || obj === undefined) return false;
  if (Array.isArray(obj)) return obj.some((entry) => hasNonFreePrice(entry, skip, depth + 1));
  if (typeof obj !== 'object') return false;
  for (const [key, value] of Object.entries(obj)) {
    if (skip.includes(key) || PRICE_META_KEY_RE.test(key)) continue;
    if (value && typeof value === 'object') { if (hasNonFreePrice(value, [], depth + 1)) return true; continue; }
    const n = parsePrice(value);
    if (n > 0 || n < 0) return true; // positivo = pago; negativo = preço variável (roteadores pagos)
  }
  return false;
}

/** O bloco `pricing` de um modelo descreve um modelo GRATUITO? (regra da especificação, seção 2) */
function isFreePricing(pricing) {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return false;
  if (parsePrice(pricing.prompt) !== 0 || parsePrice(pricing.completion) !== 0) return false;
  return !hasNonFreePrice(pricing, ['prompt', 'completion']);
}

/** Preço por MILHÃO de tokens (dólares), sem ruído de ponto flutuante. */
const perMillion = (pricePerToken) => Number((pricePerToken * 1e6).toPrecision(6));

// ---------- modelo ----------

const cleanList = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string').map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 12) : null);

/** Modalidades de entrada/saída (`architecture.input_modalities`/`output_modalities`; cai para `modality: "a+b->c"`). */
function modalitiesOf(architecture) {
  const arch = architecture && typeof architecture === 'object' ? architecture : {};
  let input = cleanList(arch.input_modalities);
  let output = cleanList(arch.output_modalities);
  if ((!input || !output) && typeof arch.modality === 'string') {
    const m = /^(.*)->(.*)$/.exec(arch.modality);
    if (m) { input = input || cleanList(m[1].split('+')); output = output || cleanList(m[2].split('+')); }
  }
  return { input: input || [], output: output || [], known: Boolean(input && output) };
}

const isTextModalities = (m) => m.known && m.output.length === 1 && m.output[0] === 'text' && m.input.includes('text');

/** 'YYYY-MM-DD' de `expiration_date` (aceita data com hora); null se não há data válida. */
function dateOnly(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

const positiveInt = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : 0);

/**
 * Forma enxuta (e independente do dia de hoje) de um modelo do catálogo: é o que vai para o cache. null se não serve.
 * @returns {{ id, name, contextLength, maxOutput, inputModalities, outputModalities, supportsJson, expiresAt, isFree, pricePerMillion }|null}
 */
function slimModel(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const id = raw.id.trim();
  if (!id || id.length > 200 || /[\s\p{Cc}]/u.test(id)) return null;
  const arch = modalitiesOf(raw.architecture);
  const params = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];
  const top = raw.top_provider && typeof raw.top_provider === 'object' ? raw.top_provider : {};
  const pricing = raw.pricing && typeof raw.pricing === 'object' ? raw.pricing : null;
  const prompt = pricing ? parsePrice(pricing.prompt) : NaN;
  const completion = pricing ? parsePrice(pricing.completion) : NaN;
  const variable = !(prompt >= 0) || !(completion >= 0); // ausente, ilegível ou -1 (variável)
  const priceKind = !variable ? 'fixed' : (prompt < 0 || completion < 0 ? 'variable' : 'unknown'); // -1 = depende do modelo que o roteador escolher
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 160) : id,
    contextLength: positiveInt(raw.context_length) || positiveInt(top.context_length),
    maxOutput: positiveInt(top.max_completion_tokens) || null,
    inputModalities: arch.input,
    outputModalities: arch.output,
    supportsJson: params.includes('response_format') || params.includes('structured_outputs'),
    expiresAt: dateOnly(raw.expiration_date),
    isFree: isFreePricing(pricing),
    pricePerMillion: variable ? null : { prompt: perMillion(prompt), completion: perMillion(completion) },
    priceKind
  };
}

/** Confere uma entrada lida do cache (arquivo editável pelo usuário): descarta o que não faz sentido e RECONFERE o preço de quem diz ser gratuito. */
function restoreSlim(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') return null;
  const id = entry.id.trim();
  if (!id || id.length > 200 || /[\s\p{Cc}]/u.test(id)) return null;
  const price = entry.pricePerMillion && typeof entry.pricePerMillion === 'object'
    && Number.isFinite(entry.pricePerMillion.prompt) && Number.isFinite(entry.pricePerMillion.completion)
    && entry.pricePerMillion.prompt >= 0 && entry.pricePerMillion.completion >= 0
    ? { prompt: entry.pricePerMillion.prompt, completion: entry.pricePerMillion.completion } : null;
  return {
    id,
    name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 160) : id,
    contextLength: positiveInt(entry.contextLength),
    maxOutput: positiveInt(entry.maxOutput) || null,
    inputModalities: cleanList(entry.inputModalities) || [],
    outputModalities: cleanList(entry.outputModalities) || [],
    supportsJson: entry.supportsJson === true,
    expiresAt: dateOnly(entry.expiresAt),
    isFree: entry.isFree === true && Boolean(price) && price.prompt === 0 && price.completion === 0, // "gratuito" só com preço zero conferido
    pricePerMillion: price,
    priceKind: price ? 'fixed' : (entry.priceKind === 'variable' ? 'variable' : 'unknown')
  };
}

/** 'dd/mm' (ou 'dd/mm/aaaa' se for de outro ano que o de `nowMs`) a partir de 'YYYY-MM-DD'. */
function formatDay(day, nowMs) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  if (!m) return '';
  const sameYear = Number.isFinite(nowMs) && new Date(nowMs).getUTCFullYear() === Number(m[1]);
  return `${m[3]}/${m[2]}${sameYear ? '' : `/${m[1]}`}`;
}

/** Contexto em texto curto para mensagens ('262 mil', '1 mi'). */
function formatTokens(n) {
  if (!(n > 0)) return '';
  if (n >= 950000) { const mi = Math.round((n / 1000000) * 10) / 10; return `${Number.isInteger(mi) ? mi : String(mi).replace('.', ',')} mi`; }
  if (n >= 1000) return `${Math.round(n / 1000)} mil`;
  return String(n);
}

/**
 * Acrescenta ao modelo enxuto o que depende de HOJE: expira em quantos dias, é texto?, é adequado à análise? e os motivos de não ser.
 * Aceita também um modelo já decorado (usa só os campos enxutos).
 */
function decorate(model, nowMs = Date.now()) {
  if (!model || typeof model !== 'object' || typeof model.id !== 'string') return null;
  const modalities = { input: model.inputModalities || [], output: model.outputModalities || [], known: (model.inputModalities || []).length > 0 && (model.outputModalities || []).length > 0 };
  const isText = isTextModalities(modalities);
  const expiresAt = dateOnly(model.expiresAt);
  let expiresInDays = null;
  let expired = false;
  let expiring = false;
  if (expiresAt) {
    const [y, m, d] = expiresAt.split('-').map(Number);
    const left = Date.UTC(y, m - 1, d, 23, 59, 59, 999) - nowMs; // vale até o fim do dia indicado (UTC)
    expired = left <= 0;
    expiring = left < MIN_DAYS_TO_EXPIRE * DAY_MS;
    expiresInDays = expired ? 0 : Math.ceil(left / DAY_MS);
  }
  const contextLength = positiveInt(model.contextLength);
  const reasons = [];
  if (!isText) {
    reasons.push({ code: 'not_text', text: 'não é modelo de conversa' });
  } else {
    if (UNSUITABLE_ID_RE.test(model.id)) reasons.push({ code: 'safety', text: 'modelo de segurança, não de análise' });
    if (expired) reasons.push({ code: 'expired', text: `expirou em ${formatDay(expiresAt, nowMs)}` });
    else if (expiring) reasons.push({ code: 'expires_soon', text: `expira em ${formatDay(expiresAt, nowMs)}` });
    if (contextLength < MIN_CONTEXT) reasons.push({ code: 'short_context', text: contextLength ? `contexto curto (${formatTokens(contextLength)})` : 'contexto não informado' });
    if (!model.supportsJson) reasons.push({ code: 'no_json', text: 'sem saída em JSON' });
  }
  return {
    id: model.id,
    name: model.name || model.id,
    contextLength,
    maxOutput: positiveInt(model.maxOutput) || null,
    inputModalities: modalities.input,
    outputModalities: modalities.output,
    supportsJson: model.supportsJson === true,
    expiresAt,
    expiresInDays,
    expired,
    isFree: model.isFree === true,
    pricePerMillion: model.pricePerMillion || null,
    priceKind: model.pricePerMillion ? 'fixed' : (model.priceKind === 'variable' ? 'variable' : 'unknown'),
    isText,
    isRouter: /^openrouter\//.test(model.id),
    isFreeRouter: model.id === ROUTER_ID,
    suitable: reasons.length === 0,
    reasons
  };
}

// ---------- a lista da interface ----------

/** Minúsculas e sem acento, para a busca. */
const fold = (text) => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const queryTokens = (query) => fold(query).split(/\s+/).filter(Boolean).slice(0, 8);

/** Nome para mostrar: sem o "(free)" que o catálogo põe no fim do nome dos modelos gratuitos. */
const displayName = (name) => String(name || '').replace(/\s*\((?:free|grátis|gratis)\)\s*$/i, '').trim();

const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }) || a.id.localeCompare(b.id);

function toItem(m, group) {
  const free = m.isFree;
  return {
    id: m.id,
    name: displayName(m.name) || m.id,
    group,
    contextLength: m.contextLength || null,
    maxOutput: m.maxOutput,
    supportsJson: m.supportsJson,
    expiresAt: m.expiresAt,
    expiresInDays: m.expiresInDays,
    expired: m.expired,
    isFree: free,
    isText: m.isText,
    isRouter: m.isRouter,
    suitable: m.suitable,
    reasons: m.reasons,
    // pago: preço por milhão de tokens; `variable` = depende do modelo que o roteador escolher; `unknown` = o catálogo não informou o preço;
    // `otherFees` = texto a preço zero, mas com outras tarifas (por pedido, imagem, busca na web…): NÃO é gratuito
    price: free ? null : {
      promptPerMillion: m.pricePerMillion ? m.pricePerMillion.prompt : null,
      completionPerMillion: m.pricePerMillion ? m.pricePerMillion.completion : null,
      variable: m.priceKind === 'variable',
      unknown: m.priceKind === 'unknown',
      otherFees: Boolean(m.pricePerMillion) && m.pricePerMillion.prompt === 0 && m.pricePerMillion.completion === 0
    }
  };
}

/** O item do roteador gratuito: SEMPRE presente (não precisa do catálogo); usa os dados do catálogo só quando existem. */
function routerItem(fromCatalog) {
  const base = fromCatalog && fromCatalog.id === ROUTER_ID ? toItem(fromCatalog, 'router') : null;
  return {
    id: ROUTER_ID,
    name: ROUTER_LABEL,
    group: 'router',
    contextLength: base ? base.contextLength : null,
    maxOutput: base ? base.maxOutput : null,
    supportsJson: base ? base.supportsJson : null,
    expiresAt: null,
    expiresInDays: null,
    expired: false,
    isFree: true,
    isText: true,
    isRouter: true,
    suitable: true,
    reasons: [],
    price: null
  };
}

/**
 * A lista de seleção, NA ORDEM DA ESPECIFICAÇÃO (decisão do dono):
 *   1. o roteador gratuito (`openrouter/free`, "Automático — roteador gratuito"): sempre o primeiro, mesmo sem catálogo e com busca;
 *   2. os gratuitos ADEQUADOS à análise (contexto maior primeiro; empate por nome);
 *   3. os demais gratuitos, cada um com o motivo (expirados por último);
 *   4. só com `freeOnly === false`: os modelos de texto PAGOS, com o preço por milhão de tokens (adequados primeiro, depois por nome).
 * `freeOnly` só desliga com o valor `false` (qualquer outra coisa mantém o modo gratuito, como no restante do código).
 * `query` filtra por nome/id (sem acento nem caixa; todas as palavras); o roteador fica sempre no topo.
 * @param {Array} models  modelos enxutos (Catalog.load().models) ou decorados
 * @returns {Array<{ id, name, group:'router'|'free'|'otherFree'|'paid', contextLength, maxOutput, supportsJson, expiresAt, expiresInDays, expired, isFree, isText, isRouter, suitable, reasons, price }>}
 */
function buildModelList(models, { freeOnly = true, query = '', now = Date.now() } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const decorated = [];
  const seen = new Set();
  for (const raw of Array.isArray(models) ? models : []) {
    const m = decorate(raw, nowMs);
    if (m && !seen.has(m.id)) { seen.add(m.id); decorated.push(m); }
  }
  const tokens = queryTokens(query);
  const matches = (m) => !tokens.length || tokens.every((t) => fold(`${m.id} ${m.name}`).includes(t));
  const out = [routerItem(decorated.find((m) => m.id === ROUTER_ID))];

  const free = decorated.filter((m) => m.isFree && m.id !== ROUTER_ID && matches(m));
  const suitable = free.filter((m) => m.suitable).sort((a, b) => (b.contextLength - a.contextLength) || byName(a, b));
  const others = free.filter((m) => !m.suitable).sort((a, b) => (Number(a.expired) - Number(b.expired)) || byName(a, b));
  out.push(...suitable.map((m) => toItem(m, 'free')), ...others.map((m) => toItem(m, 'otherFree')));

  if (freeOnly === false) {
    const paid = decorated.filter((m) => !m.isFree && m.isText && matches(m))
      .sort((a, b) => (Number(b.suitable) - Number(a.suitable)) || byName(a, b));
    out.push(...paid.map((m) => toItem(m, 'paid')));
  }
  return out;
}

/** Normaliza UM modelo do catálogo (JSON do OpenRouter) para o formato do app, já com o que depende de hoje (adequado, expira em N dias, motivos). null se não serve. */
const normalizeModel = (raw, nowMs = Date.now()) => decorate(slimModel(raw), nowMs);

/** Contagens da lista para a interface ("Outros gratuitos (11)"). */
function countGroups(list) {
  const counts = { free: 0, otherFree: 0, paid: 0 };
  for (const item of list) if (item.group in counts) counts[item.group] += 1;
  return counts;
}

// ---------- o catálogo (rede + cache) ----------

function readCacheFile(file, baseUrl) {
  let read;
  try { read = readJsonFile(file); } catch { return null; } // sem permissão etc.: como se não houvesse cache
  const doc = read.data;
  if (!doc || doc.version !== CACHE_VERSION || !Array.isArray(doc.models)) return null;
  if (typeof doc.baseUrl === 'string' && doc.baseUrl !== baseUrl) return null; // cache de outro endereço (testes) não vale aqui
  const fetchedAt = Date.parse(doc.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return null;
  const models = doc.models.map(restoreSlim).filter(Boolean);
  return models.length ? { fetchedAt, models } : null;
}

class OpenRouterCatalog {
  /**
   * @param {object} o
   * @param {string} o.dir          pasta `ai` dentro de userData (o cache é `openrouter-models.json`)
   * @param {string} [o.baseUrl]    padrão https://openrouter.ai/api/v1
   * @param {Function} [o.fetchImpl] fetch (testes)
   * @param {()=>number} [o.now]    relógio em ms (testes)
   * @param {number} [o.ttlMs]      validade do cache (padrão 6 h)
   * @param {number} [o.timeoutMs]  prazo do pedido (padrão 20 s)
   */
  constructor({ dir, baseUrl = DEFAULT_BASE_URL, fetchImpl = null, now = Date.now, ttlMs = CACHE_TTL_MS, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
    if (!dir) throw new Error('OpenRouterCatalog: informe a pasta.');
    this.dir = dir;
    this.file = path.join(dir, CACHE_FILE);
    this.baseUrl = normalizeBase(baseUrl);
    this.fetchImpl = fetchImpl;
    this.now = typeof now === 'function' ? now : () => now;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this._memo = null; // { fetchedAt (ms), models } do último carregamento
    this._inflight = null;
  }

  async _download() {
    const impl = this.fetchImpl || globalThis.fetch;
    if (typeof impl !== 'function') throw new CatalogError('NETWORK', 'Este computador não consegue acessar a internet pelo app.');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const slow = () => new CatalogError('TIMEOUT', `O OpenRouter demorou demais para responder (mais de ${Math.round(this.timeoutMs / 1000)} s).`);
    try {
      let res;
      try {
        // pedido público: SEM Authorization
        res = await impl(`${this.baseUrl}/models`, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal });
      } catch {
        throw timedOut ? slow() : new CatalogError('NETWORK', 'Não foi possível baixar a lista de modelos do OpenRouter. Confira a internet.');
      }
      let text;
      try { text = await res.text(); } catch { throw timedOut ? slow() : new CatalogError('NETWORK', 'A conexão caiu no meio do download da lista de modelos.'); }
      if (!res.ok) throw new CatalogError('HTTP', `O OpenRouter respondeu com erro (HTTP ${res.status}) ao pedir a lista de modelos.`, { status: res.status });
      if (text.length > MAX_BODY_CHARS) throw new CatalogError('BAD_FORMAT', 'A lista de modelos do OpenRouter veio grande demais.');
      let data;
      try { data = JSON.parse(text); } catch { throw new CatalogError('BAD_FORMAT', 'A lista de modelos do OpenRouter veio num formato inesperado.'); }
      const raw = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : null);
      if (!raw) throw new CatalogError('BAD_FORMAT', 'A lista de modelos do OpenRouter veio num formato inesperado.');
      const models = [];
      const seen = new Set();
      for (const entry of raw) {
        const slim = slimModel(entry);
        if (slim && !seen.has(slim.id)) { seen.add(slim.id); models.push(slim); }
      }
      if (!models.length) throw new CatalogError('BAD_FORMAT', 'A lista de modelos do OpenRouter veio vazia.');
      return models;
    } finally {
      clearTimeout(timer);
    }
  }

  _store(models, fetchedAtMs) {
    this._memo = { fetchedAt: fetchedAtMs, models };
    try {
      writeJsonAtomic(this.file, { version: CACHE_VERSION, baseUrl: this.baseUrl, fetchedAt: new Date(fetchedAtMs).toISOString(), models }, { compact: true });
      return null;
    } catch (err) {
      return `Não foi possível guardar a lista de modelos neste computador (${err && err.code ? err.code : 'erro de arquivo'}).`;
    }
  }

  /**
   * Carrega a lista: do cache se ele vale (6 h) e não foi pedido `refresh`; senão da rede (e grava o cache). Sem rede usa o último
   * cache, mesmo velho, e diz isso. Nunca lança por falta de rede: o resultado traz `error`.
   * @returns {Promise<{ models: object[], fetchedAt: string|null, source: 'rede'|'cache'|'cache-antigo'|'nenhum', stale: boolean, error?: {code:string,message:string}, warning?: string }>}
   *   source 'cache-antigo' = a rede falhou (ou o cache venceu e não deu para atualizar) e vale o último cache; 'nenhum' = sem rede e sem cache.
   */
  async load({ refresh = false } = {}) {
    const cache = readCacheFile(this.file, this.baseUrl);
    if (cache) this._memo = cache;
    const nowMs = this.now();
    if (cache && !refresh) {
      const age = nowMs - cache.fetchedAt;
      if (age >= -DAY_MS && age <= this.ttlMs) return { models: cache.models, fetchedAt: new Date(cache.fetchedAt).toISOString(), source: 'cache', stale: false };
    }
    if (!this._inflight) {
      // vários pedidos ao mesmo tempo compartilham UM download (e UMA gravação do cache)
      this._inflight = (async () => {
        try {
          const models = await this._download();
          const at = this.now();
          return { models, at, warning: this._store(models, at) };
        } catch (error) {
          return { error };
        } finally {
          this._inflight = null;
        }
      })();
    }
    const got = await this._inflight;
    if (got.models) return { models: got.models, fetchedAt: new Date(got.at).toISOString(), source: 'rede', stale: false, ...(got.warning ? { warning: got.warning } : {}) };
    const error = {
      code: got.error.code || 'NETWORK',
      message: got.error.message || 'Não foi possível baixar a lista de modelos.',
      ...(Number.isFinite(got.error.status) ? { status: got.error.status } : {})
    };
    if (cache) return { models: cache.models, fetchedAt: new Date(cache.fetchedAt).toISOString(), source: 'cache-antigo', stale: true, error };
    return { models: [], fetchedAt: null, source: 'nenhum', stale: true, error };
  }

  /**
   * O que se sabe SEM rede, na hora (memória ou arquivo): { models, fetchedAt, loaded }. Serve ao guard, que roda antes de cada pedido.
   * `loaded: false` = o catálogo nunca foi carregado neste computador.
   */
  snapshot() {
    let memo = this._memo;
    if (!memo) { memo = readCacheFile(this.file, this.baseUrl); if (memo) this._memo = memo; }
    if (!memo) return { models: [], fetchedAt: null, loaded: false };
    return { models: memo.models, fetchedAt: new Date(memo.fetchedAt).toISOString(), loaded: true };
  }
}

module.exports = {
  OpenRouterCatalog, CatalogError, DEFAULT_BASE_URL, ROUTER_ID, ROUTER_LABEL, CACHE_FILE, CACHE_TTL_MS, FETCH_TIMEOUT_MS,
  MIN_CONTEXT, MIN_DAYS_TO_EXPIRE, UNSUITABLE_ID_RE,
  normalizeBase, parsePrice, isFreePricing, slimModel, restoreSlim, decorate, normalizeModel, buildModelList, countGroups, displayName, formatTokens, formatDay
};

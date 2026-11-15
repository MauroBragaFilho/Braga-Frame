'use strict';

/**
 * Limites dos modelos gratuitos do OpenRouter: quantos pedidos gratuitos restam hoje (`GET {baseUrl}/key`), quando renova (00:00 UTC =
 * 21:00 em Brasília), o espaçamento mínimo entre chamadas (20 por minuto => ~3 s) e a leitura de `Retry-After`/`X-RateLimit-Reset`.
 * Especificação: docs/recursos/openrouter-gratuito.md, seção 2 ("Limites e contador").
 *
 * FORMATO OBSERVADO EM REDE REAL (2026-10-23, chave de teste de 1 dia; veja docs/recursos/openrouter-gratuito.md): `GET /api/v1/key` (200)
 * devolve `data.free_model_daily_requests = { used, limit, remaining }` (ex.: 0, 50, 50), mais `is_free_tier` (true), `expires_at` (ISO: chaves
 * temporárias expiram), `limit` / `limit_remaining` (teto em US$ da CHAVE: ela pode gastar com modelo pago até esse teto, por isso a trava
 * "só gratuitos" é real), `budgets[]`, `effective_budget { limit_usd, spend_usd, remaining_usd }`, `usage*`, `rate_limit` (OBSOLETO: ignorado
 * aqui) e `label` (trecho mascarado da chave: descartado). Não vêm `X-RateLimit-*` nem `Retry-After` em respostas 200.
 * Por tolerância (o resto da API pode mudar), aceita-se `free_model_daily_requests` dentro de `data` ou na raiz, em snake_case ou camelCase,
 * e completa-se o terceiro número quando vierem dois. Sem o campo, `freeDaily` é null (a interface diz que o contador não está disponível;
 * nada é inventado).
 *
 * SEGREDO: a chave só vai no cabeçalho Authorization deste pedido. O resultado e os erros NUNCA a trazem; o campo `label` da resposta
 * (um trecho mascarado da própria chave, como "sk-or-v1-abc...xyz") também é descartado.
 */

const { DEFAULT_BASE_URL } = require('./catalog');

const KEY_TIMEOUT_MS = 15000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BRASILIA = 'America/Sao_Paulo';
const BRASILIA_OFFSET_MS = -3 * 60 * 60 * 1000; // sem horário de verão desde 2019; só vale se o Intl não tiver o fuso

class LimitsError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'LimitsError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

const isLoopback = (hostname) => {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\./.test(h) || h.endsWith('.localhost');
};

// ---------- renovação (00:00 UTC) em horário de Brasília ----------

/** O próximo 00:00 UTC depois de `nowMs` (ms desde 1970). */
function nextResetUtc(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Partes de data/hora de `ms` no horário de Brasília: { y, m, d, hh, mm }. */
function brasiliaParts(ms) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: BRASILIA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    if (p.year && p.hour) return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour) % 24, mm: Number(p.minute) };
  } catch { /* sem dados de fuso: cai para o deslocamento fixo */ }
  const t = new Date(ms + BRASILIA_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: t.getUTCHours(), mm: t.getUTCMinutes() };
}

const two = (n) => String(n).padStart(2, '0');

/** "21:00" no horário de Brasília. */
const formatBrasiliaClock = (ms) => { const p = brasiliaParts(ms); return `${two(p.hh)}:${two(p.mm)}`; };

/**
 * "renova às 21:00" (ou "renova amanhã às 21:00" se a renovação cai no dia seguinte ao de hoje em Brasília), em horário de Brasília.
 * @returns {{ resetAt: string (ISO), text: string }}
 */
function describeReset(nowMs = Date.now()) {
  const at = nextResetUtc(nowMs);
  const today = brasiliaParts(nowMs);
  const then = brasiliaParts(at);
  const sameDay = today.y === then.y && today.m === then.m && today.d === then.d;
  return { resetAt: new Date(at).toISOString(), text: `renova ${sameDay ? '' : 'amanhã '}às ${formatBrasiliaClock(at)}` };
}

// ---------- cabeçalhos ----------

/** Lê um cabeçalho de um `Headers`, `Map` ou objeto simples (sem diferenciar maiúsculas). */
function getHeader(headers, name) {
  if (!headers) return null;
  const wanted = String(name).toLowerCase();
  try {
    if (typeof headers.get === 'function') { const v = headers.get(name); return v === undefined || v === null ? null : String(v); }
    for (const [key, value] of Object.entries(headers)) if (String(key).toLowerCase() === wanted && value !== undefined && value !== null) return String(Array.isArray(value) ? value[0] : value);
  } catch { /* cabeçalhos estranhos: como se não houvesse */ }
  return null;
}

/**
 * Quanto esperar (ms) segundo `Retry-After` (segundos ou data HTTP) e `X-RateLimit-Reset` (instante em ms ou em segundos, ou segundos
 * até a renovação). null se nenhum cabeçalho diz. O maior valor vence. Limitado a 24 h.
 */
function retryDelayMs(headers, nowMs = Date.now()) {
  const candidates = [];
  const retryAfter = getHeader(headers, 'retry-after');
  if (retryAfter) {
    const text = retryAfter.trim();
    if (/^\d+(\.\d+)?$/.test(text)) candidates.push(Math.ceil(Number(text) * 1000));
    else { const when = Date.parse(text); if (Number.isFinite(when)) candidates.push(Math.max(0, when - nowMs)); }
  }
  const reset = getHeader(headers, 'x-ratelimit-reset');
  if (reset && /^\d+(\.\d+)?$/.test(reset.trim())) {
    const n = Number(reset);
    if (n > 1e11) candidates.push(Math.max(0, n - nowMs)); // instante em ms
    else if (n > 1e9) candidates.push(Math.max(0, n * 1000 - nowMs)); // instante em s
    else candidates.push(Math.round(n * 1000)); // segundos até renovar
  }
  if (!candidates.length) return null;
  return Math.min(DAY_MS, Math.max(...candidates));
}

// ---------- espaçamento entre chamadas ----------

const sleepMs = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) { reject(Object.assign(new Error('Cancelado.'), { code: 'CANCELLED' })); return; }
  const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('Cancelado.'), { code: 'CANCELLED' })); };
  const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
});

/**
 * Espaçamento mínimo entre chamadas ao OpenRouter (padrão 3 s = 20 por minuto) e respeito ao `Retry-After`. Cada `wait()` reserva o
 * próximo horário livre na hora (as chamadas simultâneas saem em fila, uma a cada `minGapMs`). Relógio e espera injetáveis.
 */
class Pacer {
  constructor({ minGapMs = 3000, now = Date.now, sleep = sleepMs } = {}) {
    this.minGapMs = minGapMs;
    this.now = now;
    this.sleep = sleep;
    this.nextAt = 0;
  }

  /** Resolve quando a chamada pode sair. Devolve quanto esperou (ms). Rejeita com `code:'CANCELLED'` se `signal` abortar. */
  async wait({ signal } = {}) {
    const t = this.now();
    const start = Math.max(t, this.nextAt);
    this.nextAt = start + this.minGapMs;
    const delay = start - t;
    if (delay > 0) await this.sleep(delay, signal);
    return delay;
  }

  /** O servidor mandou esperar `ms`: nada sai antes disso. */
  penalize(ms) {
    if (Number.isFinite(ms) && ms > 0) this.nextAt = Math.max(this.nextAt, this.now() + ms);
  }

  /** Lê `Retry-After`/`X-RateLimit-Reset` de uma resposta e aplica. Devolve o atraso aplicado (ms) ou null. */
  noteHeaders(headers) {
    const delay = retryDelayMs(headers, this.now());
    if (delay) this.penalize(delay);
    return delay;
  }

  reset() { this.nextAt = 0; }
}

// ---------- pedidos restantes (GET /key) ----------

const finite = (v) => {
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/** { used, limit, remaining } de `free_model_daily_requests` (ou null). Completa o número que falta quando vierem dois. */
function normalizeFreeDaily(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let used = finite(raw.used ?? raw.count);
  let limit = finite(raw.limit ?? raw.max);
  let remaining = finite(raw.remaining ?? raw.left);
  if (limit === null && used !== null && remaining !== null) limit = used + remaining;
  if (remaining === null && limit !== null && used !== null) remaining = limit - used;
  if (used === null && limit !== null && remaining !== null) used = limit - remaining;
  if (used === null || limit === null || remaining === null) return null;
  return { used: Math.max(0, used), limit: Math.max(0, limit), remaining: Math.max(0, remaining) };
}

/** Um instante em texto ISO válido (de qualquer formato que o `Date` leia), ou null. */
const isoOrNull = (v) => {
  if (typeof v !== 'string' || !v.trim()) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/**
 * Consulta `GET {baseUrl}/key` e devolve o que interessa, SEM a chave:
 * `{ freeDaily: {used,limit,remaining}|null, limitRemaining, limit, usage, usageDaily, isFreeTier, expiresAt, fetchedAt, resetAt, resetText }`.
 * `expiresAt` (ISO) é quando a chave deixa de valer (só chaves temporárias) ou null. `limit`/`limitRemaining` são o teto em US$ da chave.
 * Erros (LimitsError com `code`): NO_KEY, KEY_INSECURE, AUTH (401/403), RATE_LIMIT (429), SERVER (5xx), NETWORK, TIMEOUT, BAD_RESPONSE, CANCELLED.
 */
async function fetchKeyInfo({ baseUrl = DEFAULT_BASE_URL, key, fetchImpl = null, now = Date.now, timeoutMs = KEY_TIMEOUT_MS, signal = null } = {}) {
  if (typeof key !== 'string' || !key.trim()) throw new LimitsError('NO_KEY', 'Informe a chave de API do OpenRouter para ver quantos pedidos gratuitos restam.');
  const impl = fetchImpl || globalThis.fetch;
  let url;
  try { url = new URL(`${String(baseUrl).replace(/\/+$/, '')}/key`); } catch { throw new LimitsError('NO_KEY', 'O endereço do OpenRouter é inválido.'); }
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    throw new LimitsError('KEY_INSECURE', 'Por segurança, a chave não é enviada por http:// a um servidor que não seja o seu computador. Use um endereço https://.');
  }
  if (signal && signal.aborted) throw new LimitsError('CANCELLED', 'Cancelado.');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    let res;
    try {
      res = await impl(url.toString(), { method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${key.trim()}` }, signal: controller.signal });
    } catch {
      if (signal && signal.aborted) throw new LimitsError('CANCELLED', 'Cancelado.');
      throw timedOut ? new LimitsError('TIMEOUT', 'O OpenRouter demorou demais para informar os pedidos restantes.') : new LimitsError('NETWORK', 'Não foi possível consultar o OpenRouter. Confira a internet.');
    }
    let text;
    try { text = await res.text(); } catch { throw timedOut ? new LimitsError('TIMEOUT', 'O OpenRouter demorou demais para informar os pedidos restantes.') : new LimitsError('NETWORK', 'A conexão com o OpenRouter caiu.'); }
    if (!res.ok) {
      const status = res.status;
      if (status === 401 || status === 403) throw new LimitsError('AUTH', 'O OpenRouter recusou a chave de API. Confira se ela está correta, ativa e dentro da validade.', { status });
      if (status === 429) throw new LimitsError('RATE_LIMIT', 'O OpenRouter pediu para esperar um pouco antes de consultar de novo.', { status, retryAfterMs: retryDelayMs(res.headers, now()) });
      if (status >= 500 || status === 408) throw new LimitsError('SERVER', `O OpenRouter está com problema agora (HTTP ${status}).`, { status });
      throw new LimitsError('BAD_RESPONSE', `O OpenRouter respondeu com erro (HTTP ${status}) ao consultar a chave.`, { status });
    }
    let body;
    try { body = JSON.parse(text); } catch { throw new LimitsError('BAD_RESPONSE', 'O OpenRouter respondeu algo que não é a informação da chave.'); }
    const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
    const data = isObject(body) && isObject(body.data) ? body.data : (isObject(body) ? body : null);
    if (!data) throw new LimitsError('BAD_RESPONSE', 'O OpenRouter respondeu algo que não é a informação da chave.');
    const nowMs = now();
    const reset = describeReset(nowMs);
    return {
      // `rate_limit` é obsoleto no OpenRouter (observado em rede real): só vale `free_model_daily_requests`
      freeDaily: normalizeFreeDaily(data.free_model_daily_requests ?? data.freeModelDailyRequests),
      limitRemaining: finite(data.limit_remaining),
      limit: finite(data.limit),
      usage: finite(data.usage),
      usageDaily: finite(data.usage_daily),
      isFreeTier: typeof data.is_free_tier === 'boolean' ? data.is_free_tier : null,
      expiresAt: isoOrNull(data.expires_at),
      fetchedAt: new Date(nowMs).toISOString(),
      resetAt: reset.resetAt,
      resetText: reset.text
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Compara a estimativa de uma análise ("~N chamadas") com o que resta hoje. Avisa, nunca bloqueia: { level:'ok'|'warn'|'bad'|'unknown', message }.
 */
function describeEstimate(calls, freeDaily) {
  if (!(calls > 0) || !freeDaily || !Number.isFinite(freeDaily.remaining)) return { level: 'unknown', message: '' };
  const { remaining, limit } = freeDaily;
  const many = (n) => `${n} ${n === 1 ? 'pedido' : 'pedidos'}`;
  if (remaining <= 0) return { level: 'bad', message: `Os pedidos gratuitos de hoje acabaram (limite de ${limit}). A análise precisa de cerca de ${many(calls)} e vai falhar até a renovação.` };
  if (calls > remaining) return { level: 'warn', message: `A análise precisa de cerca de ${many(calls)} e restam ${remaining} hoje: ela pode parar no meio.` };
  if (calls > remaining * 0.7) return { level: 'warn', message: `A análise usa cerca de ${many(calls)} dos ${remaining} que restam hoje.` };
  return { level: 'ok', message: `A análise usa cerca de ${many(calls)}; restam ${remaining} hoje.` };
}

module.exports = {
  LimitsError, Pacer, fetchKeyInfo, normalizeFreeDaily, describeEstimate, describeReset, nextResetUtc, formatBrasiliaClock, retryDelayMs, getHeader, sleepMs, KEY_TIMEOUT_MS
};

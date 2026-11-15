'use strict';

/**
 * Erros do OpenRouter explicados em português: o que houve, o que fazer, se vale tentar de novo e quanto esperar.
 * Especificação: docs/recursos/openrouter-gratuito.md, seção 2 ("Erros explicados").
 *
 * FORMATO OBSERVADO EM REDE REAL (2026-10-23, chave de teste de 1 dia; docs/recursos/openrouter-gratuito.md): modelo inexistente ou inválido
 * => HTTP 400 (NÃO 404) com
 *   { "error": { "message": "<id> is not a valid model ID", "code": 400 }, "user_id": "user_…" }
 * O campo `user_id` (identifica a CONTA) nunca é lido, mostrado nem registrado: `redactSecret` o remove de qualquer texto.
 *
 * FORMATO ASSUMIDO PELA DOCUMENTAÇÃO (o resto: NÃO conferido em rede real). O erro vem como
 *   { "error": { "code": 429, "message": "…", "metadata": { "raw": "…", "provider_name": "…", "headers": { "X-RateLimit-Limit": "50",
 *     "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1741305600000" } } } }
 * com os cabeçalhos HTTP `Retry-After` e `X-RateLimit-*` quando houver. Como os textos exatos não foram conferidos, a classificação é
 * TOLERANTE: usa o status HTTP, trechos da mensagem (inclusive o `metadata.raw` do provedor) e os cabeçalhos, nessa ordem de confiança:
 *   - 429 do DIA: mensagem com "per-day"/"daily"/"por dia" ou limite 50/1000 zerado, ou renovação a mais de 10 min;
 *   - 429 por MINUTO: "per-min"/"per minute"/"rpm", ou renovação em menos de 10 min;
 *   - 429 do PROVEDOR do modelo ("upstream", "temporarily rate-limited", "provider returned error"): limite do modelo, não da conta;
 *   - 404 por POLÍTICA DE DADOS: "data policy"/"settings/privacy" (o OpenRouter diz que nenhum provedor atende à política de privacidade
 *     da conta; modelos gratuitos exigem aceitar provedores que podem treinar com as entradas);
 *   - 404 qualquer outro: modelo expirado, removido ou indisponível;
 *   - 400 "is not a valid model ID" (e variações): modelo inválido/removido (mesmo código MODEL do 404: atualize a lista e escolha outro);
 *   - 402: saldo/créditos; 401/403: chave; 400: pedido recusado; 408/5xx: servidor.
 * Também pode haver HTTP 200 com um corpo de erro (falha no meio do provedor): quem chama trata como resposta inválida.
 * Nenhuma mensagem leva a chave nem o `user_id` (o eco do servidor passa por `redactSecret`).
 */

const { getHeader, retryDelayMs, describeReset } = require('./limits');

const DAY_RE = /free[-_ ]models[-_ ]per[-_ ]day|free model requests per day|\bper[-_ ]day\b|requests? per day/i;
const MINUTE_RE = /free[-_ ]models[-_ ]per[-_ ]min|requests? per minute|\bper[-_ ]min(?:ute)?\b|\brpm\b/i;
const UPSTREAM_RE = /upstream|temporarily rate[-\s]?limited|provider returned error|rate[-\s]?limited upstream|overloaded|at capacity/i;
const POLICY_RE = /data policy|settings\/privacy|privacy settings|guardrail|training|publication/i;
const CREDITS_RE = /insufficient (?:credits|funds)|negative balance|add more credits|out of credits|payment required/i;
const CONTEXT_RE = /context (?:length|window)|maximum context|too many tokens|prompt is too long|input is too long|tokens? exceed/i;
const MODERATION_RE = /moderation|flagged|violat/i;
// "<id> is not a valid model ID" (observado em rede real, HTTP 400) e variações; um 400 que fala de response_format/JSON é outra coisa
const INVALID_MODEL_RE = /is not a valid model|invalid model|unknown model|no such model|model[^.]{0,80}(?:does not exist|not found)/i;
const FORMAT_PARAM_RE = /response_format|json_object|json mode|json_schema/i;

/**
 * Tira a chave (e trechos com cara de chave/token) e o identificador da CONTA (`user_id`, "user_…") de um texto que pode ir a log, erro
 * ou tela. O OpenRouter repete o `user_id` no corpo de alguns erros (observado em rede real): ele identifica a conta e nunca é mostrado.
 */
function redactSecret(text, apiKey) {
  let out = String(text === undefined || text === null ? '' : text);
  if (apiKey && String(apiKey).length >= 6) out = out.split(String(apiKey)).join('•••');
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer •••');
  out = out.replace(/sk-or-[A-Za-z0-9._-]{6,}/g, '•••');
  out = out.replace(/\b(?:sk|gsk|AIza|key|or)[-_A-Za-z0-9]{16,}/g, '•••');
  out = out.replace(/"user_id"\s*:\s*"[^"]*"/g, '"user_id":"•••"');
  out = out.replace(/\buser_[A-Za-z0-9]{8,}\b/g, '•••');
  return out;
}

const finite = (v) => {
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

const oneLine = (text, max = 220) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Corpo do erro (texto, objeto ou Buffer) -> { message, metadata, providerRaw, text }. */
function parseBody(body) {
  let raw = '';
  let json = null;
  if (Buffer.isBuffer(body)) raw = body.toString('utf8');
  else if (body && typeof body === 'object') { json = body; try { raw = JSON.stringify(body); } catch { raw = ''; } } else if (body !== undefined && body !== null) raw = String(body);
  if (json === null && raw) { try { json = JSON.parse(raw); } catch { json = null; } }
  const first = Array.isArray(json) ? json[0] : json;
  const err = first && typeof first === 'object' ? (first.error !== undefined ? first.error : first) : null;
  let message = '';
  let metadata = {};
  if (typeof err === 'string') message = err;
  else if (err && typeof err === 'object') {
    message = typeof err.message === 'string' ? err.message : '';
    metadata = err.metadata && typeof err.metadata === 'object' ? err.metadata : {};
  }
  if (!message && json === null) message = raw; // corpo em texto simples (ou a própria mensagem do erro que o cliente montou)
  const providerRaw = metadata.raw === undefined || metadata.raw === null ? '' : (typeof metadata.raw === 'string' ? metadata.raw : (() => { try { return JSON.stringify(metadata.raw); } catch { return ''; } })());
  return { message: String(message), metadata, providerRaw: String(providerRaw), text: `${message} ${providerRaw}` };
}

/** Lê os cabeçalhos HTTP e os que o OpenRouter repete em `metadata.headers`. */
function mergeHeaders(headers, metadata) {
  const inner = metadata && metadata.headers && typeof metadata.headers === 'object' ? metadata.headers : null;
  return { get: (name) => getHeader(headers, name) ?? getHeader(inner, name) };
}

/**
 * Classifica um 429: 'day' (limite diário dos gratuitos), 'minute' (por minuto), 'upstream' (limite do provedor do modelo) ou 'unknown'.
 * Os limites DA CONTA vêm na mensagem do próprio OpenRouter ("free-models-per-day"…); um erro que traz o nome/mensagem do provedor
 * (`metadata.provider_name`/`raw`) é limite do provedor daquele modelo e não esgota os outros.
 */
function scope429(message, text, merged, nowMs, providerError) {
  if (DAY_RE.test(message)) return 'day';
  if (MINUTE_RE.test(message)) return 'minute';
  if (providerError || UPSTREAM_RE.test(text)) return 'upstream';
  const limit = finite(merged.get('x-ratelimit-limit'));
  const remaining = finite(merged.get('x-ratelimit-remaining'));
  if (remaining === 0 && (limit === 50 || limit === 1000)) return 'day';
  const wait = retryDelayMs(merged, nowMs);
  if (wait !== null) return wait > 10 * 60 * 1000 ? 'day' : 'minute';
  return 'unknown';
}

const quoted = (model) => (model ? `"${oneLine(model, 120)}"` : 'o modelo');

/**
 * Explica uma resposta de erro do OpenRouter.
 * @param {object} o
 * @param {number} o.status          status HTTP
 * @param {string|object|Buffer} [o.body]  corpo da resposta (texto ou já lido)
 * @param {object} [o.headers]       cabeçalhos da resposta (Headers, Map ou objeto)
 * @param {string} [o.model]         modelo do pedido (entra na mensagem)
 * @param {{freeDaily?:{used,limit,remaining}}} [o.keyInfo]  resultado de fetchKeyInfo, se houver (completa "quanto resta")
 * @param {number} [o.now]           relógio (ms)
 * @param {string} [o.apiKey]        a chave, só para retirá-la de qualquer eco do servidor
 * @returns {{ code, message, solution, retryable, retryAfterMs, status, scope }}
 *   code: RATE_LIMIT (por minuto ou do provedor; vale esperar), QUOTA (limite do dia; não vale esperar), DATA_POLICY (404 por política de
 *   dados da conta), MODEL (404 expirado/removido/indisponível, ou 400 "is not a valid model ID"), CREDITS (402), AUTH (401/403), MODERATION, BAD_REQUEST, SERVER (408/5xx), UNKNOWN.
 *   retryAfterMs: o que o servidor mandou esperar; sem isso, um padrão para o limite por minuto (20 s) e do provedor (5 s); no limite
 *   do dia, o tempo até a renovação (00:00 UTC); senão null.
 */
function mapOpenRouterError({ status, body, headers, model, keyInfo = null, now = Date.now(), apiKey } = {}) {
  const st = Number.isFinite(Number(status)) ? Number(status) : 0;
  const nowMs = typeof now === 'function' ? now() : now;
  const parsed = parseBody(body);
  const text = redactSecret(parsed.text, apiKey);
  const merged = mergeHeaders(headers, parsed.metadata);
  const serverSaid = oneLine(redactSecret(parsed.message, apiKey));
  const waitHeader = retryDelayMs(merged, nowMs);
  const provider = typeof parsed.metadata.provider_name === 'string' ? oneLine(parsed.metadata.provider_name, 60) : '';
  const out = (code, message, solution, retryable, retryAfterMs, scope = null) => ({ code, message, solution, retryable, retryAfterMs: retryAfterMs === undefined ? null : retryAfterMs, status: st || null, scope });

  if (st === 429) {
    const scope = scope429(redactSecret(parsed.message, apiKey), text, merged, nowMs, Boolean(provider || parsed.providerRaw));
    if (scope === 'day') {
      const reset = describeReset(nowMs);
      const day = (keyInfo && keyInfo.freeDaily) || (() => {
        const limit = finite(merged.get('x-ratelimit-limit'));
        return limit === null ? null : { limit, remaining: finite(merged.get('x-ratelimit-remaining')) ?? 0 };
      })();
      const left = day ? `: restam ${day.remaining} de ${day.limit} pedidos gratuitos hoje` : '';
      return out(
        'QUOTA',
        `Os pedidos gratuitos de hoje do OpenRouter acabaram${left}.`,
        `A cota ${reset.text} (horário de Brasília, 00:00 UTC). Com US$ 10 em créditos no OpenRouter o limite diário sobe para 1.000 pedidos. Você também pode analisar mais tarde.`,
        false, Math.max(0, new Date(reset.resetAt).getTime() - nowMs), 'day'
      );
    }
    if (scope === 'upstream') {
      return out(
        'RATE_LIMIT',
        `O provedor de ${quoted(model)}${provider ? ` (${provider})` : ''} está com muita procura agora. É um limite do provedor do modelo, não da sua conta.`,
        'O app espera um pouco e tenta de novo; se continuar, escolha outro modelo gratuito da lista (o roteador gratuito já troca de modelo sozinho).',
        true, waitHeader ?? 5000, 'upstream'
      );
    }
    return out(
      'RATE_LIMIT',
      scope === 'minute'
        ? 'O OpenRouter limitou os pedidos por minuto (os modelos gratuitos aceitam 20 por minuto).'
        : 'O OpenRouter pediu para esperar um pouco antes de continuar (limite de uso).',
      'Espere alguns instantes: o app tenta de novo sozinho, com um intervalo entre os pedidos. Se isso se repetir, use menos blocos por análise.',
      true, waitHeader ?? (scope === 'minute' ? 20000 : 10000), scope === 'minute' ? 'minute' : null
    );
  }

  if (st === 404) {
    if (POLICY_RE.test(text)) {
      return out(
        'DATA_POLICY',
        `A sua conta do OpenRouter não permite usar ${quoted(model)}: modelos gratuitos podem usar o que você envia para treino ou publicação, e as configurações de privacidade da conta recusam isso.`,
        'Modelos gratuitos exigem, em Privacy na conta do OpenRouter, aceitar provedores gratuitos que podem treinar com as entradas. É decisão sua: o app não altera a sua conta. Se não quiser aceitar, use um modelo pago (desligando "Usar apenas modelos gratuitos").',
        false, null
      );
    }
    return out(
      'MODEL',
      `O OpenRouter não encontrou ${quoted(model)}: ele pode ter expirado, sido removido ou estar indisponível agora.`,
      'Atualize a lista de modelos e escolha outro modelo gratuito.',
      false, null
    );
  }

  if (st === 402 || (CREDITS_RE.test(text) && st >= 400 && st < 500 && st !== 429)) {
    return out(
      'CREDITS',
      'O OpenRouter recusou o pedido por causa do saldo da conta.',
      'Contas com saldo negativo podem receber erros mesmo em modelos gratuitos. Confira os créditos no painel do OpenRouter e, se estiver negativo, adicione créditos.',
      false, null
    );
  }

  if (st === 401) {
    return out('AUTH', 'O OpenRouter recusou a chave de API.', 'Confira se a chave está correta, ativa e dentro da validade (chaves temporárias expiram; veja no painel do OpenRouter, Keys) e cole-a de novo.', false, null);
  }

  if (st === 403) {
    if (MODERATION_RE.test(text)) {
      return out('MODERATION', 'O provedor do modelo recusou o conteúdo enviado (moderação).', 'Tente outro modelo; trechos com conteúdo sensível às vezes são barrados.', false, null);
    }
    return out('AUTH', 'O OpenRouter recusou o acesso desta chave.', 'Confira se a chave está correta, ativa e com permissão para usar este modelo.', false, null);
  }

  if (st === 400 || st === 422) {
    // observado em rede real: modelo inexistente/inválido é HTTP 400 "<id> is not a valid model ID" (não 404); trata como o 404 de modelo
    if (INVALID_MODEL_RE.test(text) && !FORMAT_PARAM_RE.test(text)) {
      return out(
        'MODEL',
        `O OpenRouter não reconhece ${quoted(model)}: o nome pode estar errado ou o modelo foi removido.`,
        'Atualize a lista de modelos e escolha outro modelo gratuito.',
        false, null
      );
    }
    if (CONTEXT_RE.test(text)) {
      return out('BAD_REQUEST', `O texto enviado é maior do que o contexto de ${quoted(model)}.`, 'Escolha um modelo com contexto maior ou reduza os "Minutos por bloco" da análise.', false, null);
    }
    return out('BAD_REQUEST', `O OpenRouter recusou o pedido${serverSaid ? `: ${serverSaid}` : '.'}`, 'Confira o modelo escolhido; se o problema continuar, escolha outro modelo.', false, null);
  }

  if (st === 408 || st >= 500) {
    return out(
      'SERVER',
      `O OpenRouter${provider ? ` (provedor ${provider})` : ''} está com problema agora (HTTP ${st || '5xx'}).`,
      'Tente de novo em instantes ou escolha outro modelo gratuito da lista.',
      true, waitHeader
    );
  }

  return out('UNKNOWN', `O OpenRouter respondeu com um erro inesperado${st ? ` (HTTP ${st})` : ''}${serverSaid ? `: ${serverSaid}` : '.'}`, 'Tente de novo; se continuar, escolha outro modelo.', false, waitHeader);
}

/**
 * Atalho para um erro lançado pelo cliente de chat: usa `status`, o corpo/cabeçalhos guardados no erro (`responseBody`,
 * `responseHeaders`, `retryAfterSec`) ou, na falta deles, o próprio texto da mensagem (que já traz um trecho do que o servidor disse).
 * Erros sem status (rede, tempo esgotado…) e o `NOT_FREE` do guard passam com a mensagem original.
 */
function mapThrownError(err, { model, keyInfo = null, now = Date.now(), apiKey } = {}) {
  if (!err) return null;
  const status = Number.isFinite(Number(err.status)) ? Number(err.status) : null;
  if (status !== null && status > 0) {
    const headers = err.responseHeaders || err.headers || (Number.isFinite(Number(err.retryAfterSec)) ? { 'retry-after': String(err.retryAfterSec) } : null);
    return mapOpenRouterError({ status, body: err.responseBody !== undefined ? err.responseBody : (err.body !== undefined ? err.body : err.message), headers, model, keyInfo, now, apiKey });
  }
  const code = typeof err.code === 'string' && err.code ? err.code : 'UNKNOWN';
  const message = redactSecret(err.message || 'Erro inesperado.', apiKey);
  const transient = ['NETWORK', 'TIMEOUT', 'INTERRUPTED'].includes(code);
  return { code, message, solution: code === 'NOT_FREE' ? '' : (transient ? 'Confira a internet e tente de novo.' : ''), retryable: transient, retryAfterMs: null, status: null, scope: null };
}

/** Mensagem e solução juntas, prontas para a tela. */
const fullMessage = (info) => (info ? [info.message, info.solution].filter(Boolean).join(' ') : '');

module.exports = { mapOpenRouterError, mapThrownError, fullMessage, redactSecret, parseBody, scope429 };

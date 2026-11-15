'use strict';

/**
 * Erro da IA na nuvem. `code` é estável (a interface e a análise decidem o que fazer por ele); `message` está em português e
 * NUNCA traz a chave de API (veja redact em client.js). `details` precisa ser JSON.
 *
 * Códigos: NOT_CONFIGURED, NO_KEY, KEY_INSECURE, CONSENT_REQUIRED, AUTH (401/403), MODEL (404, ou 400 "is not a valid model ID"), RATE_LIMIT (429), QUOTA (429 com espera
 * longa demais), SERVER (5xx), NETWORK, TIMEOUT, INTERRUPTED, BAD_REQUEST (400/422), BAD_RESPONSE (resposta que não é uma resposta de chat),
 * BAD_JSON (a resposta não é o JSON pedido), CANCELLED, TOO_MANY_CALLS, NO_TRANSCRIPT, BUSY, INVALID_ARGS.
 * Do OpenRouter (src/core/ai/openrouter, docs/recursos/openrouter-gratuito.md): NOT_FREE (modelo que não é gratuito com "Usar apenas
 * modelos gratuitos" ligado: o pedido nem sai), DATA_POLICY (404: a política de dados da conta recusa o modelo gratuito), CREDITS (402),
 * MODERATION (403 por moderação) e QUOTA também para o limite DIÁRIO de pedidos gratuitos (429 do dia).
 */
class AiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const cancelled = () => new AiError('CANCELLED', 'Cancelado. Nada foi alterado no projeto.');
const isCancelled = (err) => Boolean(err) && err.code === 'CANCELLED';

/**
 * Esta falha vale uma nova tentativa (mesmo pedido, depois de esperar)? Serve para erros nossos e para os do hospedeiro
 * (BDS), que trazem `status` e/ou `code` no estilo do fetch.
 */
function classify(err) {
  if (!err) return { retry: false, kind: 'unknown' };
  const code = err.code;
  const status = Number.isFinite(err.status) ? err.status : null;
  if (code === 'CANCELLED') return { retry: false, kind: 'cancelled' };
  // a cota do DIA (QUOTA, mesmo com status 429) não melhora esperando nem tentando de novo; vem antes da regra do 429
  if (code === 'QUOTA') return { retry: false, kind: 'quota' };
  if (code === 'NOT_FREE') return { retry: false, kind: 'config' };
  if (code === 'DATA_POLICY' || code === 'CREDITS' || code === 'MODERATION') return { retry: false, kind: 'account' };
  if (code === 'RATE_LIMIT' || status === 429) return { retry: true, kind: 'rate', retryAfterSec: Number.isFinite(err.retryAfterSec) ? err.retryAfterSec : (Number.isFinite(err.retryAfter) ? err.retryAfter : null) };
  if (code === 'AUTH' || status === 401 || status === 403) return { retry: false, kind: 'auth' };
  if (code === 'MODEL' || status === 404) return { retry: false, kind: 'model' };
  if (['NOT_CONFIGURED', 'NO_KEY', 'KEY_INSECURE', 'CONSENT_REQUIRED', 'AI_NOT_CONFIGURED', 'AI_ALL_FAILED', 'INVALID_ARGS'].includes(code)) return { retry: false, kind: 'config' };
  if (code === 'BAD_REQUEST' || (status !== null && status >= 400 && status < 500 && status !== 408)) return { retry: false, kind: 'request' };
  if (['SERVER', 'NETWORK', 'TIMEOUT', 'INTERRUPTED', 'BAD_RESPONSE', 'AI_UNREACHABLE', 'STREAM_ERROR'].includes(code) || (status !== null && (status >= 500 || status === 408))) return { retry: true, kind: 'transient' };
  return { retry: false, kind: 'unknown' };
}

module.exports = { AiError, cancelled, isCancelled, classify };

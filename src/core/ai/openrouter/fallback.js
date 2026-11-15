'use strict';

/**
 * Fallback entre modelos GRATUITOS, feito pelo app (o fallback do próprio OpenRouter, o array `models`, COBRARIA se um id fosse pago):
 * o usuário ordena alguns modelos gratuitos e, quando um falha de um jeito que outro modelo pode resolver, o app tenta o PRÓXIMO da lista
 * dele, um pedido por vez. Especificação: docs/recursos/openrouter-gratuito.md, seção 2 ("Usar apenas modelos gratuitos").
 *
 * Troca de modelo em:   404 (modelo indisponível/expirado/removido, ou recusado pela política de dados da conta), 429 por minuto ou do
 *                       provedor, 5xx/408, tempo esgotado, conexão interrompida e resposta inválida.
 * NÃO troca em:         401/403 (chave), consentimento pendente, configuração, 402 (saldo), 429 do DIA (a cota diária é da conta: outro
 *                       modelo gasta a mesma cota), pedido recusado (400/422), moderação, rede fora do ar e cancelamento.
 * Todo id passa pelo guard (guard.js) antes de ser tentado: um id que não seja gratuito é PULADO, nunca enviado.
 */

const { checkModel } = require('./guard');
const { mapThrownError } = require('./errors');

class FallbackError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'FallbackError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

const SWITCH_CODES = new Set(['MODEL', 'DATA_POLICY', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'INTERRUPTED', 'BAD_RESPONSE']);

/** Este erro vale tentar outro modelo gratuito? { fallback, why, info } (info = mapThrownError). */
function shouldFallback(err, { model, apiKey } = {}) {
  if (!err) return { fallback: false, why: 'sem erro', info: null };
  if (err.code === 'CANCELLED') return { fallback: false, why: 'cancelado', info: null };
  const info = mapThrownError(err, { model, apiKey });
  if (info && SWITCH_CODES.has(info.code)) return { fallback: true, why: info.code, info };
  return { fallback: false, why: info ? info.code : 'UNKNOWN', info };
}

/** O modelo que de fato respondeu: o campo `model` da resposta quando vier; senão o pedido. */
function answeredModel(value, requested) {
  if (value && typeof value === 'object') {
    for (const key of ['answeredModel', 'respondedModel', 'model']) {
      if (typeof value[key] === 'string' && value[key]) return value[key];
    }
  }
  return requested;
}

const cancelledError = () => Object.assign(new Error('Cancelado.'), { code: 'CANCELLED' });

/**
 * Tenta cada modelo gratuito da lista, em ordem, até um responder.
 * @param {string[]} modelIds  a lista ordenada do usuário (pode incluir `openrouter/free`)
 * @param {(modelId:string, ctx:{index:number, tried:string[], signal:AbortSignal|null})=>Promise<any>} attempt  faz UM pedido com esse modelo
 *   (aguardando o Pacer, se usar) e devolve a resposta ou lança o erro do cliente
 * @param {object} [o]
 * @param {(modelId:string)=>{ok:boolean,code?:string,message?:string}} [o.guard]  conferência de cada id; padrão: sufixo `:free`/roteador
 * @param {(ev:{from:string,to:string,reason:{code:string,status:number|null,message:string},index:number})=>void} [o.onSwitch]  aviso de troca
 * @param {AbortSignal} [o.signal]
 * @param {{penalize:Function}} [o.pacer]  se vier, uma espera por minuto mandada pelo servidor é repassada a ele
 * @param {string} [o.apiKey]  só para retirar a chave de mensagens
 * @returns {Promise<{ value:any, requestedModel:string, model:string, switched:boolean, attempts:object[], skipped:object[] }>}
 *   `model` = quem respondeu (campo `model` da resposta quando vier); `attempts` = as falhas anteriores; `skipped` = ids recusados pelo guard.
 * Se todos falharem, lança o ÚLTIMO erro (com `fallbackAttempts` e `fallbackSkipped`); se nenhum id passar pelo guard, lança `NOT_FREE`.
 */
async function runWithFreeFallback(modelIds, attempt, { guard = null, onSwitch = null, signal = null, pacer = null, apiKey } = {}) {
  if (typeof attempt !== 'function') throw new TypeError('runWithFreeFallback: informe a função que faz o pedido.');
  const check = typeof guard === 'function' ? guard : (id) => checkModel(id, { freeOnly: true });
  const ids = [...new Set((Array.isArray(modelIds) ? modelIds : []).filter((id) => typeof id === 'string' && id))];
  if (!ids.length) throw new FallbackError('NOT_CONFIGURED', 'Escolha ao menos um modelo.');

  const skipped = [];
  const skip = (id, verdict) => {
    if (!skipped.some((s) => s.model === id)) skipped.push({ model: id, code: (verdict && verdict.code) || 'NOT_FREE', message: (verdict && verdict.message) || 'O modelo não é gratuito.' });
  };
  const usable = [];
  for (const id of ids) {
    const verdict = check(id);
    if (verdict && verdict.ok) usable.push(id); else skip(id, verdict);
  }
  if (!usable.length) throw new FallbackError('NOT_FREE', skipped[0].message, { fallbackSkipped: skipped });

  const attempts = [];
  let lastError = null;
  for (let i = 0; i < usable.length; i += 1) {
    const id = usable[i];
    if (signal && signal.aborted) throw cancelledError();
    const again = check(id); // o catálogo pode ter mudado desde a conferência inicial
    if (!again || !again.ok) { skip(id, again); continue; }
    try {
      const value = await attempt(id, { index: i, tried: attempts.map((a) => a.model), signal });
      return { value, requestedModel: id, model: answeredModel(value, id), switched: attempts.length > 0 || id !== ids[0], attempts, skipped };
    } catch (err) {
      lastError = err;
      const decision = shouldFallback(err, { model: id, apiKey });
      const reason = {
        model: id,
        code: decision.info ? decision.info.code : (err && err.code) || 'UNKNOWN',
        status: decision.info ? decision.info.status : null,
        message: decision.info ? decision.info.message : String((err && err.message) || '')
      };
      attempts.push(reason);
      const next = usable.slice(i + 1).find((candidate) => { const v = check(candidate); if (v && v.ok) return true; skip(candidate, v); return false; });
      if (!decision.fallback || !next) {
        if (err && typeof err === 'object') { err.fallbackAttempts = attempts; err.fallbackSkipped = skipped; }
        throw err;
      }
      if (pacer && decision.info && decision.info.scope === 'minute' && decision.info.retryAfterMs) pacer.penalize(decision.info.retryAfterMs);
      if (typeof onSwitch === 'function') {
        try { onSwitch({ from: id, to: next, reason, index: i + 1 }); } catch { /* o aviso não pode derrubar a análise */ }
      }
    }
  }
  // os que sobraram foram recusados pelo guard no último instante: vale o último erro de verdade, se houve algum
  if (lastError && typeof lastError === 'object') { lastError.fallbackAttempts = attempts; lastError.fallbackSkipped = skipped; throw lastError; }
  throw new FallbackError('NOT_FREE', skipped.length ? skipped[skipped.length - 1].message : 'Nenhum modelo gratuito disponível.', { fallbackSkipped: skipped, fallbackAttempts: attempts });
}

module.exports = { runWithFreeFallback, shouldFallback, answeredModel, FallbackError, SWITCH_CODES };

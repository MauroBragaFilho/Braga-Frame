'use strict';

/**
 * OpenRouter "só com modelos gratuitos": o serviço que junta o catálogo, o guard, os limites, os erros e o fallback.
 * Um por pasta de dados; o handler `src/ipc/handlers/aiOpenrouter.js` cria o do app e o publica em `ctx.aiOpenrouter`, onde a análise
 * (fase 2) pega o guard, o Pacer, o fallback e o mapeamento de erros. Documentação: docs/recursos/openrouter-gratuito.md.
 *
 * A CHAVE nunca é guardada aqui: quem a fornece é `getKey()`/`setKeyProvider(fn)` (o cofre do app), consultada só na hora de usar, e ela
 * nunca aparece em nenhum retorno.
 */

const crypto = require('node:crypto');
const catalogMod = require('./catalog');
const guardMod = require('./guard');
const limitsMod = require('./limits');
const errorsMod = require('./errors');
const fallbackMod = require('./fallback');

const KEY_INFO_TTL_MS = 10 * 1000; // várias telas pedindo ao mesmo tempo não viram várias consultas

/** "23/10 às 14:32" (horário do computador) a partir de um instante ISO. */
function whenText(iso) {
  const d = new Date(iso);
  if (!iso || !Number.isFinite(d.getTime())) return 'uma data desconhecida';
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getDate())}/${two(d.getMonth() + 1)} às ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Parágrafo que o aviso de privacidade do OpenRouter ganha enquanto o modo gratuito estiver ligado (o aceite continua por provedor e sem prazo). */
const FREE_MODE_PRIVACY = 'Modelos gratuitos podem usar o que você envia para treino ou publicação, conforme as configurações da sua conta no OpenRouter.';

/**
 * @param {object} o
 * @param {string} o.dir            pasta `ai` dentro de userData (cache do catálogo)
 * @param {string} [o.baseUrl]      padrão https://openrouter.ai/api/v1 (testes apontam para um servidor local)
 * @param {Function} [o.fetchImpl]  fetch (testes)
 * @param {()=>number} [o.now]      relógio em ms (testes)
 * @param {(ms:number, signal?:AbortSignal)=>Promise<void>} [o.sleep]  espera do Pacer (testes)
 * @param {()=>(string|null|{key:string|null,reason?:string,message?:string})} [o.getKey]  fornece a chave do OpenRouter, só quando preciso
 * @param {number} [o.timeoutMs]    prazo do catálogo (padrão 20 s)
 * @param {number} [o.keyTimeoutMs] prazo da consulta de limites (padrão 15 s)
 */
function createOpenRouterService({ dir, baseUrl = catalogMod.DEFAULT_BASE_URL, fetchImpl = null, now = Date.now, sleep, getKey = null, timeoutMs, keyTimeoutMs } = {}) {
  const clock = typeof now === 'function' ? now : () => now;
  const catalog = new catalogMod.OpenRouterCatalog({ dir, baseUrl, fetchImpl, now: clock, ...(timeoutMs ? { timeoutMs } : {}) });
  const pacer = new limitsMod.Pacer({ now: clock, ...(sleep ? { sleep } : {}) });
  let keyProvider = typeof getKey === 'function' ? getKey : null;
  let keyCache = null; // { fp, at, value }
  let keyInflight = null;

  /** { key, reason, message } do provedor de chave (aceita texto, null ou objeto). */
  function readKey() {
    if (!keyProvider) return { key: null, reason: 'none' };
    let got;
    try { got = keyProvider(); } catch { return { key: null, reason: 'none' }; }
    if (typeof got === 'string') return { key: got.trim() || null, reason: got.trim() ? 'ok' : 'none' };
    if (got && typeof got === 'object') return { key: typeof got.key === 'string' && got.key.trim() ? got.key.trim() : null, reason: got.reason || (got.key ? 'ok' : 'none'), message: got.message };
    return { key: null, reason: 'none' };
  }

  const fingerprint = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);

  const service = {
    baseUrl: catalog.baseUrl,
    catalog,
    pacer,

    /** Troca a origem da chave (a análise aponta para o cofre do runtime). */
    setKeyProvider(fn) { keyProvider = typeof fn === 'function' ? fn : null; keyCache = null; },

    /**
     * A lista de seleção, pronta para a interface: { list, fetchedAt, source:'rede'|'cache'|'cache-antigo'|'nenhum', stale, error?, warning?, counts, freeOnly }.
     * O roteador gratuito vem sempre em primeiro, mesmo sem catálogo (source 'nenhum').
     */
    async modelList({ refresh = false, freeOnly = true, query = '' } = {}) {
      const loaded = await catalog.load({ refresh: refresh === true });
      const list = catalogMod.buildModelList(loaded.models, { freeOnly, query: typeof query === 'string' ? query.slice(0, 100) : '', now: clock() });
      return {
        list,
        fetchedAt: loaded.fetchedAt,
        source: loaded.source,
        stale: loaded.stale,
        ...(loaded.error ? { error: loaded.error } : {}),
        ...(loaded.warning ? { warning: loaded.warning } : {}),
        counts: catalogMod.countGroups(list),
        freeOnly: freeOnly !== false
      };
    },

    /**
     * Antes de uma análise: confere a lista pública de modelos (vale o cache de 6 h; sem rede, o último cache) para o guard decidir com
     * os dados de hoje. Nada do usuário sai (o catálogo é público) e nunca lança por falta de rede.
     * -> { source, fetchedAt, warning: { code, message } | null } (warning quando a lista usada é velha ou não existe)
     */
    async prepare() {
      const loaded = await catalog.load();
      let warning = null;
      if (loaded.source === 'cache-antigo') {
        warning = { code: 'FREE_LIST_OLD', message: `Sem conexão com o OpenRouter: a conferência dos modelos gratuitos usou a lista de ${whenText(loaded.fetchedAt)}.` };
      } else if (loaded.source === 'nenhum') {
        warning = { code: 'FREE_LIST_MISSING', message: 'Não foi possível baixar a lista de modelos gratuitos do OpenRouter: só valem o roteador gratuito e os modelos com o sufixo ":free".' };
      }
      return { source: loaded.source, fetchedAt: loaded.fetchedAt, warning };
    },

    /** Guard de UM modelo, com o catálogo que já está neste computador (não vai à rede). */
    checkModel(modelId, { freeOnly = true } = {}) {
      return guardMod.checkModel(modelId, { freeOnly, models: catalog.snapshot().models });
    },

    /** Só a frase "o que há de errado com este modelo" (sem a solução), com o catálogo que já está neste computador. */
    explainModel(modelId) {
      return guardMod.explainModel(modelId, { models: catalog.snapshot().models });
    },

    /** Corpo do pedido sem `models`/`route`/plugin de busca pagos (cópia). */
    sanitizeBody(body, { freeOnly = true } = {}) {
      return guardMod.sanitizeRequestBody(body, { freeOnly, models: catalog.snapshot().models });
    },

    /**
     * Quantos pedidos gratuitos restam hoje (usa a chave do cofre; nunca a devolve): `{ ok:true, freeDaily, … , resetText }` ou
     * `{ ok:false, code, message }` (NO_KEY, AUTH, NETWORK, TIMEOUT, RATE_LIMIT, SERVER, BAD_RESPONSE, KEY_INSECURE). `refresh` ignora os últimos 10 s.
     */
    async keyInfo({ refresh = false, signal } = {}) {
      const { key, reason, message } = readKey();
      if (!key) {
        if (reason === 'host') return { ok: false, code: 'NO_KEY', hostManaged: true, message: message || 'A chave fica no aplicativo que hospeda o Braga Frame; aqui não dá para consultar os pedidos restantes.' };
        if (reason === 'unreadable') return { ok: false, code: 'NO_KEY', message: message || 'A chave guardada não pôde ser lida neste computador. Informe a chave de novo.' };
        return { ok: false, code: 'NO_KEY', message: 'Informe a chave de API do OpenRouter para ver quantos pedidos gratuitos restam.' };
      }
      const fp = fingerprint(key);
      if (!refresh && keyCache && keyCache.fp === fp && clock() - keyCache.at < KEY_INFO_TTL_MS) return keyCache.value;
      if (keyInflight && keyInflight.fp === fp) return keyInflight.promise;
      const promise = (async () => {
        try {
          const info = await limitsMod.fetchKeyInfo({ baseUrl: catalog.baseUrl, key, fetchImpl, now: clock, signal, ...(keyTimeoutMs ? { timeoutMs: keyTimeoutMs } : {}) });
          const value = { ok: true, ...info };
          keyCache = { fp, at: clock(), value };
          return value;
        } catch (err) {
          keyCache = null;
          const out = { ok: false, code: err && err.code ? err.code : 'ERROR', message: errorsMod.redactSecret(err && err.message ? err.message : 'Não foi possível consultar o OpenRouter.', key) };
          if (err && Number.isFinite(err.retryAfterMs)) out.retryAfterMs = err.retryAfterMs;
          return out;
        } finally {
          keyInflight = null;
        }
      })();
      keyInflight = { fp, promise };
      return promise;
    },

    /** Explica um erro do cliente de chat em português (code, message, solution, retryable, retryAfterMs). */
    mapError(err, { model, keyInfo = null } = {}) {
      return errorsMod.mapThrownError(err, { model, keyInfo, now: clock(), apiKey: readKey().key || undefined });
    },

    /** Fallback entre modelos gratuitos com o guard do catálogo local e o Pacer deste serviço. */
    runWithFreeFallback(modelIds, attempt, { freeOnly = true, ...rest } = {}) {
      return fallbackMod.runWithFreeFallback(modelIds, attempt, { guard: (id) => service.checkModel(id, { freeOnly }), pacer, ...rest });
    }
  };
  return service;
}

module.exports = {
  createOpenRouterService,
  FREE_MODE_PRIVACY,
  catalog: catalogMod,
  guard: guardMod,
  limits: limitsMod,
  errors: errorsMod,
  fallback: fallbackMod
};

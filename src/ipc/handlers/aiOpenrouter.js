'use strict';

const path = require('node:path');
const { createOpenRouterService } = require('../../core/ai/openrouter');
const { normalizeBase } = require('../../core/ai/openrouter/catalog');
const { describeEstimate } = require('../../core/ai/openrouter/limits');

/**
 * OpenRouter "só com modelos gratuitos" (dono: aiOpenrouter; especificação em docs/recursos/openrouter-gratuito.md). Canais:
 *   aiOpenrouter:models { refresh?, freeOnly?, query? } -> { list, fetchedAt, source, stale, counts, freeOnly, error?, warning? }
 *       A lista de seleção JÁ NA ORDEM da especificação: 1º o roteador gratuito `openrouter/free` ("Automático — roteador gratuito",
 *       sempre presente, mesmo sem catálogo), depois os gratuitos adequados à análise, depois os demais gratuitos (com o motivo) e, só com
 *       `freeOnly:false`, os pagos com o preço por milhão de tokens. `freeOnly` só desliga com o valor `false`. `source`: 'rede' |
 *       'cache' (vale 6 h) | 'cache-antigo' (a rede falhou: vale o último cache, com a data em `fetchedAt`) | 'nenhum' (sem rede e sem cache:
 *       só o roteador, e `error` diz o motivo). O catálogo é PÚBLICO: o pedido não leva chave.
 *   aiOpenrouter:limits { refresh?, calls? } -> { freeDaily:{used,limit,remaining}|null, limitRemaining, isFreeTier, expiresAt (ISO, só chave temporária), resetAt, resetText, estimate?, … }
 *       ou { ok:false, code:'NO_KEY'|'AUTH'|'NETWORK'|…, message }. Usa a chave guardada do provedor "openrouter" SÓ NESTE processo; a
 *       chave nunca volta (nem o `label` mascarado que o OpenRouter devolve). Com `calls` (a estimativa "~N chamadas" da análise) a
 *       resposta traz `estimate: { level:'ok'|'warn'|'bad'|'unknown', message }` comparando com o que resta hoje (avisa, nunca bloqueia).
 *       Com o provedor do hospedeiro (BDS) não há chave aqui: { ok:false, code:'NO_KEY', hostManaged:true }.
 * O serviço fica em `ctx.aiOpenrouter` (catálogo, guard, Pacer, fallback, mapeamento de erros) para a análise usar na fase 2.
 *
 * Só para testes: BF_OPENROUTER_BASE_URL aponta o serviço para um servidor local que imita o OpenRouter (ignorada no app instalado,
 * e só aceita https:// ou um servidor da própria máquina, porque a chave vai nesse endereço). `ctx.aiOpenrouterOptions`
 * ({ baseUrl, fetchImpl, now, sleep, safeStorage, restrict, timeoutMs }) faz o mesmo nos testes unitários.
 */

const PROVIDER_ID = 'openrouter';
const ENV_BASE_URL = 'BF_OPENROUTER_BASE_URL';

function electronSafeStorage() {
  try {
    const electron = require('electron');
    return electron && typeof electron === 'object' ? electron.safeStorage || null : null;
  } catch { return null; }
}

const isLoopback = (hostname) => {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\./.test(h) || h.endsWith('.localhost');
};

/** Endereço de teste vindo do ambiente, se válido e permitido; senão undefined (vale o endereço oficial). */
function baseUrlFromEnv(ctx) {
  const raw = process.env[ENV_BASE_URL];
  if (!raw) return undefined;
  if (ctx.app && ctx.app.isPackaged) {
    ctx.log('warn', `aiOpenrouter: ${ENV_BASE_URL} ignorada no app instalado.`);
    return undefined;
  }
  try {
    const base = normalizeBase(raw);
    const url = new URL(base);
    if (url.protocol === 'http:' && !isLoopback(url.hostname)) throw new Error('http:// só vale para um servidor da própria máquina');
    ctx.log('warn', `aiOpenrouter: ${ENV_BASE_URL} ativa (${url.host}); isto é só para testes.`);
    return base;
  } catch (err) {
    ctx.log('warn', `aiOpenrouter: ${ENV_BASE_URL} ignorada (${err.message}).`);
    return undefined;
  }
}

function register(ctx) {
  const opts = ctx.aiOpenrouterOptions || {};
  const dir = path.join(ctx.paths.userData, 'ai');
  const hostProvidesAi = Boolean(ctx.host && ctx.host.ai);

  // Cofre das chaves: o MESMO arquivo e o mesmo cifrador do runtime da análise (só leitura aqui). A análise pode trocar isto por
  // `ctx.aiOpenrouter.setKeyProvider(...)` apontando para o runtime dela.
  let store = null;
  const secrets = () => {
    if (store) return store;
    try {
      const { SecretStore } = require('../../core/ai/secretStore');
      store = new SecretStore({
        file: path.join(dir, 'secrets.json'),
        safeStorage: opts.safeStorage !== undefined ? opts.safeStorage : electronSafeStorage,
        ...(opts.restrict ? { restrict: opts.restrict } : {})
      });
    } catch (err) {
      ctx.log('warn', `aiOpenrouter: o cofre de chaves não abriu (${err && err.message}).`);
    }
    return store;
  };
  const getKey = () => {
    if (hostProvidesAi) return { key: null, reason: 'host' };
    const vault = secrets();
    if (!vault) return { key: null, reason: 'none' };
    const key = vault.get(PROVIDER_ID);
    if (key) return key;
    return typeof vault.has === 'function' && vault.has(PROVIDER_ID) ? { key: null, reason: 'unreadable' } : { key: null, reason: 'none' };
  };

  const service = createOpenRouterService({
    dir,
    baseUrl: opts.baseUrl || baseUrlFromEnv(ctx),
    fetchImpl: opts.fetchImpl || null,
    now: opts.now,
    sleep: opts.sleep,
    timeoutMs: opts.timeoutMs,
    keyTimeoutMs: opts.keyTimeoutMs,
    getKey
  });
  ctx.aiOpenrouter = service;

  ctx.handle('aiOpenrouter:models', async (payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const res = await service.modelList({ refresh: p.refresh === true, freeOnly: p.freeOnly !== false, query: typeof p.query === 'string' ? p.query : '' });
    if (res.error && res.source === 'nenhum') ctx.log('warn', `aiOpenrouter: lista de modelos indisponível (${res.error.code}).`);
    return res;
  });

  ctx.handle('aiOpenrouter:limits', async (payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const info = await service.keyInfo({ refresh: p.refresh === true });
    if (info.ok) {
      const calls = Math.round(Number(p.calls));
      return calls > 0 ? { ...info, estimate: describeEstimate(calls, info.freeDaily) } : info;
    }
    if (info.code !== 'NO_KEY') ctx.log('warn', `aiOpenrouter: pedidos restantes indisponíveis (${info.code}).`);
    return info; // { ok:false, code, message }: devolvido, não lançado, para não poluir o log com algo normal (sem chave)
  });
}

module.exports = { register, PROVIDER_ID, ENV_BASE_URL };

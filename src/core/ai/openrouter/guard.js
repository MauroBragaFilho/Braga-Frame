'use strict';

/**
 * "Usar apenas modelos gratuitos" GARANTIDO NO CÓDIGO (não só na interface): o processo principal chama `checkModel` antes de CADA pedido
 * ao OpenRouter e `sanitizeRequestBody` no corpo que vai ser enviado. Especificação: docs/recursos/openrouter-gratuito.md, seção 2.
 *
 * Regra (com o interruptor ligado, que é o padrão; só `freeOnly === false` o desliga):
 *   - permitido: o roteador gratuito `openrouter/free`;
 *   - permitido: um id que o catálogo marca como gratuito (preço zero em tudo: veja catalog.js);
 *   - se o catálogo NUNCA foi carregado neste computador: só o sufixo `:free` (variante gratuita de um modelo);
 *   - qualquer outro id é recusado com `NOT_FREE` e uma explicação em português: nada é enviado, nada é cobrado.
 * Um id com o catálogo carregado mas que ele não conhece (digitado à mão, removido, ainda não listado) também é recusado, mesmo com o
 * sufixo `:free`: "atualize a lista" resolve. Variante `:online` (busca na web, cobrada à parte) nunca é gratuita.
 *
 * Nunca se envia o array `models` de fallback do OpenRouter com id pago (ele COBRARIA o fallback): o fallback entre gratuitos é feito pelo
 * app (fallback.js), um pedido por vez, e cada id passa por aqui.
 */

const { ROUTER_ID } = require('./catalog');

const FREE_SUFFIX_RE = /:free$/;
const ONLINE_VARIANT_RE = /:online(?:$|:)/;
const MAX_ID_LENGTH = 200;

/** Nome do modelo para mensagens (sem quebra de linha, sem exagero de tamanho). */
const shown = (id) => String(id).replace(/\p{Cc}+/gu, ' ').trim().slice(0, 120);

/** Mapa id -> gratuito? do catálogo (guardado por lista, para não refazer a cada pedido). null = catálogo nunca carregado. */
const indexCache = new WeakMap();
function freeIndex(models) {
  if (!Array.isArray(models) || !models.length) return null;
  let index = indexCache.get(models);
  if (!index) {
    index = new Map();
    for (const m of models) if (m && typeof m.id === 'string' && !index.has(m.id)) index.set(m.id, m.isFree === true);
    indexCache.set(models, index);
  }
  return index.size ? index : null;
}

/**
 * Este id é gratuito? { free:boolean, via:'router'|'catalog'|'suffix'|'unknown'|'paid'|'invalid' }.
 * @param {string} modelId  exatamente o texto que vai no campo `model` do pedido
 * @param {{ models?: Array }} [o]  modelos do catálogo (`isFree` por id); vazio/ausente = catálogo nunca carregado
 */
function classifyModel(modelId, { models = null } = {}) {
  if (typeof modelId !== 'string' || !modelId || modelId.length > MAX_ID_LENGTH || /[\s\p{Cc}]/u.test(modelId)) return { free: false, via: 'invalid' };
  if (modelId === ROUTER_ID) return { free: true, via: 'router' };
  if (ONLINE_VARIANT_RE.test(modelId)) return { free: false, via: 'paid' };
  const index = freeIndex(models);
  if (index) {
    if (!index.has(modelId)) return { free: false, via: 'unknown' };
    return index.get(modelId) ? { free: true, via: 'catalog' } : { free: false, via: 'paid' };
  }
  return FREE_SUFFIX_RE.test(modelId) ? { free: true, via: 'suffix' } : { free: false, via: 'paid' };
}

const isFreeModel = (modelId, opts) => classifyModel(modelId, opts).free;

/** Só a frase "o que há de errado com este modelo" (sem a solução), para quem monta a própria mensagem (p.ex. o provedor do BDS). */
function explainModel(modelId, { models = null } = {}) {
  const verdict = classifyModel(modelId, { models });
  return (EXPLAIN[verdict.via] || EXPLAIN.paid)(modelId);
}

const EXPLAIN = Object.freeze({
  invalid: (id) => (id ? `O nome do modelo "${shown(id)}" não é válido para o modo gratuito.` : 'Nenhum modelo foi escolhido.'),
  paid: (id) => `O modelo "${shown(id)}" não é gratuito.`,
  unknown: (id) => `O modelo "${shown(id)}" não está na lista de modelos gratuitos do OpenRouter (pode ter sido removido, ter expirado ou ainda não constar na lista).`
});

/**
 * Confere o modelo do pedido. `{ ok:true, via }` ou `{ ok:false, code:'NOT_FREE', message, via }`. Com `freeOnly === false` tudo passa
 * (o usuário desligou o interruptor de propósito e vê o aviso de custo).
 */
function checkModel(modelId, { freeOnly = true, models = null } = {}) {
  if (freeOnly === false) return { ok: true, via: 'unrestricted' };
  const verdict = classifyModel(modelId, { models });
  if (verdict.free) return { ok: true, via: verdict.via };
  const why = (EXPLAIN[verdict.via] || EXPLAIN.paid)(modelId);
  return {
    ok: false,
    code: 'NOT_FREE',
    via: verdict.via,
    message: `${why} Com "Usar apenas modelos gratuitos" ligado o app só usa modelos gratuitos: nada foi enviado e nada foi cobrado. Escolha o roteador gratuito ou um modelo gratuito da lista${verdict.via === 'unknown' ? ' (use "Atualizar lista")' : ''}; só desligue o interruptor se quiser usar modelos pagos, cobrados na sua conta do OpenRouter.`
  };
}

/**
 * Corpo do pedido sem nada que possa gerar cobrança com o modo gratuito ligado. Devolve uma CÓPIA:
 * `{ body, removed: [{ field, id }], changed }`. Remove de `models` (e de `route`, se for uma lista) os ids que não são gratuitos; se a
 * lista fica vazia, tira o campo (e o `route: "fallback"` que dependia dele); tira o plugin de busca na web (`plugins[].id === 'web'`),
 * cobrado à parte. O campo `model` NÃO é alterado aqui: quem chama confere com `checkModel` e recusa.
 * Com `freeOnly === false` devolve o corpo como veio (cópia rasa).
 */
function sanitizeRequestBody(body, { freeOnly = true, models = null } = {}) {
  const out = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {};
  const removed = [];
  if (freeOnly === false) return { body: out, removed, changed: false };

  const keepFree = (field) => {
    if (!Array.isArray(out[field])) return;
    const kept = [];
    for (const id of out[field]) {
      if (isFreeModel(id, { models }) && id !== out.model && !kept.includes(id)) kept.push(id);
      else if (!isFreeModel(id, { models })) removed.push({ field, id: typeof id === 'string' ? shown(id) : String(id) });
    }
    if (kept.length) out[field] = kept; else delete out[field];
  };
  keepFree('models');
  keepFree('route');
  if (typeof out.route === 'string' && !Array.isArray(out.models)) delete out.route; // "fallback" sem lista de fallback não faz nada
  if (Array.isArray(out.plugins)) {
    const plugins = out.plugins.filter((p) => !(p && typeof p === 'object' && String(p.id).toLowerCase() === 'web'));
    if (plugins.length !== out.plugins.length) removed.push({ field: 'plugins', id: 'web' });
    if (plugins.length) out.plugins = plugins; else delete out.plugins;
  }
  return { body: out, removed, changed: removed.length > 0 };
}

module.exports = { checkModel, classifyModel, isFreeModel, explainModel, sanitizeRequestBody, FREE_SUFFIX_RE, ROUTER_ID };

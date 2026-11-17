'use strict';

/**
 * Atalhos de teclado da revisão de cortes (dono: review; docs/recursos/review.md): aprovar, rejeitar, ver o trecho, ir ao próximo e ao anterior,
 * sem tirar a mão do teclado. As letras vêm das preferências (`review.key.*`); `I` e `O` (marcar início e fim) e a barra de espaço são reservados.
 * Universal: CommonJS no Node e `window.BFReview.shortcuts` no renderer (veja core.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) module.exports = factory();
  else { root.BFReview = root.BFReview || {}; root.BFReview.shortcuts = factory(); }
})(globalThis, function () {
  const ACTIONS = Object.freeze(['approve', 'reject', 'view', 'next', 'prev']);
  const DEFAULTS = Object.freeze({ approve: 'a', reject: 'r', view: 'v', next: 'j', prev: 'k' });
  const RESERVED = Object.freeze(['i', 'o']);
  const LABELS = Object.freeze({ approve: 'aprova', reject: 'rejeita', view: 'toca o trecho do corte aberto', next: 'abre o próximo corte', prev: 'abre o corte anterior' });

  /** Uma letra de a a z (minúscula) que não seja reservada; senão null. */
  function normalizeKey(value) {
    const k = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return /^[a-z]$/.test(k) && !RESERVED.includes(k) ? k : null;
  }

  /**
   * As cinco letras em vigor. `raw` = { approve, reject, view, next, prev } (o que as preferências guardam). Letra inválida volta ao padrão da ação;
   * duas ações com a mesma letra: a primeira (na ordem de ACTIONS) fica com ela e a outra tenta o padrão dela; se o padrão também está ocupado, a ação
   * fica sem atalho (null) em vez de disputar a tecla.
   */
  function resolveKeys(raw = {}) {
    const out = {};
    const taken = new Set();
    for (const action of ACTIONS) {
      let key = normalizeKey(raw && raw[action]) || DEFAULTS[action];
      if (taken.has(key)) key = taken.has(DEFAULTS[action]) ? null : DEFAULTS[action];
      out[action] = key;
      if (key) taken.add(key);
    }
    return out;
  }

  /** Qual ação a tecla dispara? ArrowDown/ArrowUp são fixas (próximo/anterior); as letras seguem `keys`. null se nenhuma. */
  function actionFor(eventKey, keys) {
    if (eventKey === 'ArrowDown') return 'next';
    if (eventKey === 'ArrowUp') return 'prev';
    const k = typeof eventKey === 'string' ? eventKey.toLowerCase() : '';
    for (const action of ACTIONS) if (keys && keys[action] && keys[action] === k) return action;
    return null;
  }

  /**
   * Depois de decidir o corte `afterId`, qual abre em seguida? O primeiro PENDENTE que vem depois dele na ordem da lista (`orderedIds`, a que a tela mostra);
   * sem nenhum depois, o primeiro pendente antes dele; sem nenhum, null (tudo decidido). `statusOf(id)` diz o estado atual de cada corte.
   */
  function nextUndecided(orderedIds, afterId, statusOf) {
    const ids = Array.isArray(orderedIds) ? orderedIds : [];
    const at = ids.indexOf(afterId);
    const pending = (id) => id !== afterId && statusOf(id) === 'pending';
    for (let i = at + 1; i < ids.length; i += 1) if (pending(ids[i])) return ids[i];
    for (let i = 0; i < Math.max(0, at); i += 1) if (pending(ids[i])) return ids[i];
    return null;
  }

  /** O corte vizinho (delta +1 ou -1) na ordem da lista, sem dar a volta; sem `currentId` na lista, o primeiro. null se a lista é vazia. */
  function neighbor(orderedIds, currentId, delta) {
    const ids = Array.isArray(orderedIds) ? orderedIds : [];
    if (!ids.length) return null;
    const at = ids.indexOf(currentId);
    if (at < 0) return ids[0];
    return ids[Math.min(ids.length - 1, Math.max(0, at + delta))];
  }

  return { ACTIONS, DEFAULTS, RESERVED, LABELS, normalizeKey, resolveKeys, actionFor, nextUndecided, neighbor };
});

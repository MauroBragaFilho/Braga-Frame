'use strict';

/**
 * Histórico de decisões (dono: review): lógica pura de grupos/itens, inversão (desfazer) e plano de
 * restauração. O estado em si (pilhas, gravação) fica em `review/engine.js`; o arquivo em disco, em
 * `history/store.js`. Universal: CommonJS no Node e `window.BFReview.history` no renderer.
 *
 * Um *grupo* é uma ação do usuário (um clique ou um lote inteiro):
 *   { id, at, label, source: 'user'|'batch'|'undo'|'redo'|'restore'|'external', of?, items: [Item] }
 * e um *item* é a mudança em um corte:
 *   { cutId, cutTitle, type, before, after, cut }
 *   - mudança de campos: type 'approve'|'reject'|'reset'|'recategorize'|'retitle'|'adjust'|'multi', com
 *     before/after = só os campos que mudam (veja core.FIELD_KEYS);
 *   - 'create': before null, after = campos, cut = cópia completa; 'remove': after null, cut = cópia completa.
 * O log nunca é apagado nem reescrito: desfazer e restaurar viram grupos novos.
 */
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) module.exports = factory(require('../review/core'));
  else { root.BFReview = root.BFReview || {}; root.BFReview.history = factory(root.BFReview.core); }
})(globalThis, function (core) {
  const SOURCES = Object.freeze(['user', 'batch', 'undo', 'redo', 'restore', 'external']);
  const STATUS_FIELDS = new Set(['status', 'reviewedAt', 'reviewedRange']);

  /** O item precisa mexer na lista de cortes (não só em campos)? */
  const isStructural = (item) => item.type === 'create' || item.type === 'remove';

  /** Item que desfaz `item` (aplicável como qualquer outro, "para a frente"). */
  function invertItem(item) {
    if (item.type === 'create') return { ...item, type: 'remove', before: item.after, after: null };
    if (item.type === 'remove') return { ...item, type: 'create', before: null, after: item.before };
    return { ...item, before: item.after, after: item.before };
  }

  /** Itens que desfazem uma lista (na ordem inversa). */
  function invertItems(items) {
    return [...items].reverse().map(invertItem);
  }

  /**
   * Eventos 'decision' (contrato 1.3) de um item que foi aplicado: um por tipo de mudança.
   *  - approve/reject/reset: before/after = status; retitle: título; recategorize: categoria;
   *  - adjust: before/after = { start, end };
   *  - create: before null, after = cópia do corte; remove: before = cópia, after null.
   */
  function eventsFor(item) {
    if (item.type === 'create') return [{ cutId: item.cutId, type: 'create', before: null, after: core.clone(item.cut) }];
    if (item.type === 'remove') return [{ cutId: item.cutId, type: 'remove', before: core.clone(item.cut), after: null }];
    const b = item.before || {};
    const a = item.after || {};
    const events = [];
    if ('status' in a) {
      const type = a.status === 'approved' ? 'approve' : a.status === 'rejected' ? 'reject' : 'reset';
      events.push({ cutId: item.cutId, type, before: b.status === undefined ? null : b.status, after: a.status });
    }
    if ('title' in a) events.push({ cutId: item.cutId, type: 'retitle', before: b.title === undefined ? null : b.title, after: a.title });
    if ('category' in a) events.push({ cutId: item.cutId, type: 'recategorize', before: b.category === undefined ? '' : b.category, after: a.category });
    if ('start' in a || 'end' in a) {
      events.push({
        cutId: item.cutId, type: 'adjust',
        before: { start: 'start' in b ? b.start : null, end: 'end' in b ? b.end : null },
        after: { start: 'start' in a ? a.start : null, end: 'end' in a ? a.end : null }
      });
    }
    return events;
  }

  /** Aplica um item "para a frente" na lista de cortes (no lugar). Devolve 'ok' | 'noop' | 'missing'. */
  function applyForward(cuts, item, now) {
    const index = cuts.findIndex((c) => c.id === item.cutId);
    if (item.type === 'create') {
      if (index >= 0) return 'noop';
      cuts.push(core.clone(item.cut));
      return 'ok';
    }
    if (item.type === 'remove') {
      if (index < 0) return 'missing';
      cuts.splice(index, 1);
      return 'ok';
    }
    if (index < 0) return 'missing';
    const cut = cuts[index];
    if (core.matches(cut, item.after || {})) return 'noop';
    core.applyFields(cut, item.after || {}, now);
    return 'ok';
  }

  /**
   * Plano para voltar ao estado de ANTES do grupo `index` (desfaz aquele grupo e todos os seguintes,
   * inclusive desfazer/refazer/restaurar anteriores). Calcula o estado antigo desfazendo os grupos do
   * fim para o começo sobre uma cópia e compara com o estado atual. Devolve itens aplicáveis
   * (mudança de campos 'multi', 'create' para cortes que existiam, 'remove' para os que não existiam).
   */
  function planRestore(cuts, groups, index) {
    const virtual = new Map(cuts.map((c) => [c.id, core.clone(c)]));
    for (let g = groups.length - 1; g >= index; g--) {
      for (const item of invertItems(groups[g].items)) {
        if (item.type === 'create') virtual.set(item.cutId, core.clone(item.cut));
        else if (item.type === 'remove') virtual.delete(item.cutId);
        else if (virtual.has(item.cutId)) core.applyFields(virtual.get(item.cutId), item.after || {}, '');
      }
    }
    const current = new Map(cuts.map((c) => [c.id, c]));
    const order = [...cuts.map((c) => c.id), ...[...virtual.keys()].filter((id) => !current.has(id))];
    const items = [];
    for (const id of order) {
      const now = current.get(id);
      const target = virtual.get(id);
      if (now && !target) {
        items.push({ cutId: id, cutTitle: now.title, type: 'remove', before: core.snapshot(now), after: null, cut: core.clone(now), changed: true });
      } else if (!now && target) {
        items.push({ cutId: id, cutTitle: target.title, type: 'create', before: null, after: core.snapshot(target), cut: target, changed: true });
      } else if (now && target) {
        const before = {};
        const after = {};
        for (const key of core.FIELD_KEYS) {
          const x = now[key] === undefined ? null : now[key];
          const y = target[key] === undefined ? null : target[key];
          if (core.fieldEq(x, y)) continue;
          before[key] = core.clone(x);
          after[key] = core.clone(y);
        }
        if (Object.keys(after).length) items.push({ cutId: id, cutTitle: target.title, type: 'multi', before, after, cut: null, changed: true });
      }
    }
    return items;
  }

  /** Só os campos de um item que a prévia/histórico guarda (descarta marcas de prévia como note/invalid). */
  function stripItem(item) {
    return {
      cutId: item.cutId, cutTitle: item.cutTitle, type: item.type,
      before: item.before === undefined ? null : core.clone(item.before),
      after: item.after === undefined ? null : core.clone(item.after),
      cut: item.cut ? core.clone(item.cut) : null
    };
  }

  const isGroupShape = (g) => g && typeof g === 'object' && typeof g.id === 'string' && Array.isArray(g.items) && typeof g.label === 'string';

  /** Lê o que veio do disco: ignora entradas malformadas (nunca lança). */
  function normalizeGroups(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(isGroupShape).map((g) => ({
      id: g.id,
      at: typeof g.at === 'string' ? g.at : '',
      label: g.label,
      source: SOURCES.includes(g.source) ? g.source : 'user',
      ...(typeof g.of === 'string' ? { of: g.of } : {}),
      items: g.items.filter((i) => i && typeof i === 'object' && typeof i.cutId === 'string' && typeof i.type === 'string')
    }));
  }

  /** Evento 'decision' de outro recurso -> item do histórico (null se não der para entender). `cuts` = cortes atuais. */
  function itemFromEvent(event, cuts) {
    if (!event || typeof event.cutId !== 'string' || typeof event.type !== 'string') return null;
    const id = event.cutId;
    const cut = cuts.find((c) => c.id === id) || null;
    const title = (cut && cut.title) || (event.after && event.after.title) || (event.before && event.before.title) || '';
    const base = { cutId: id, cutTitle: title, cut: null };
    switch (event.type) {
      case 'create':
        if (!event.after || typeof event.after !== 'object') return null;
        return { ...base, cutTitle: event.after.title || title, type: 'create', before: null, after: core.snapshot(event.after), cut: core.clone(event.after) };
      case 'remove':
        if (!event.before || typeof event.before !== 'object') return null;
        return { ...base, cutTitle: event.before.title || title, type: 'remove', before: core.snapshot(event.before), after: null, cut: core.clone(event.before) };
      case 'approve': case 'reject': case 'reset': {
        const after = cut ? core.snapshot(cut, [...STATUS_FIELDS]) : { status: event.after };
        return { ...base, type: event.type, before: { status: event.before }, after };
      }
      case 'retitle': return { ...base, type: 'retitle', before: { title: event.before }, after: { title: event.after } };
      case 'recategorize': return { ...base, type: 'recategorize', before: { category: event.before }, after: { category: event.after } };
      case 'adjust': {
        const b = event.before || {};
        const a = event.after || {};
        // 'adjust' também é usado por Áudio (scope 'audio', ganho/mudo/fades) e Legendas (what 'subtitles'): não são tempo
        // de corte, não mexem nos campos que o histórico desfaz, e viravam uma entrada vazia ("Ajustou …") que ocupava o Ctrl+Z
        if ((typeof event.scope === 'string' && event.scope) || b.what || a.what) return null;
        const isTime = (o) => core.isNum(o.start) || core.isNum(o.end);
        if (!isTime(b) && !isTime(a)) return null;
        return { ...base, type: 'adjust', before: { start: b.start, end: b.end }, after: { start: a.start, end: a.end } };
      }
      default: return null;
    }
  }

  return { SOURCES, isStructural, invertItem, invertItems, eventsFor, applyForward, planRestore, stripItem, normalizeGroups, itemFromEvent };
});

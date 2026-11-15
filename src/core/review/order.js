'use strict';

/**
 * Ordenação e filtros da lista de cortes (dono: review). Universal: CommonJS no Node e
 * `window.BFReview.order` no renderer (veja core.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) module.exports = factory(require('./core'));
  else { root.BFReview = root.BFReview || {}; root.BFReview.order = factory(root.BFReview.core); }
})(globalThis, function (core) {
  const SORTS = Object.freeze(['chrono', 'relevance']);
  const NO_CATEGORY = '__none__';
  const DEFAULT_FILTERS = Object.freeze({ status: 'all', category: '', origin: 'all', changed: false, similar: false });

  function compareChrono(a, b) {
    return (a.start - b.start) || (a.end - b.end) || String(a.id).localeCompare(String(b.id));
  }

  /**
   * `chrono` (padrão): ordem original da live. `relevance`: sugeridos do mais para o menos relevante;
   * cortes sem relevância (manuais) vêm depois, em ordem cronológica. Não altera o array de entrada.
   */
  function sortCuts(cuts, mode = 'chrono') {
    const list = [...cuts];
    if (mode !== 'relevance') return list.sort(compareChrono);
    return list.sort((a, b) => {
      const ra = core.isNum(a.relevance) ? a.relevance : null;
      const rb = core.isNum(b.relevance) ? b.relevance : null;
      if (ra !== null && rb !== null) return (rb - ra) || compareChrono(a, b);
      if (ra !== null) return -1;
      if (rb !== null) return 1;
      return compareChrono(a, b);
    });
  }

  /** Valor válido de ordenação (aceita o que vem das preferências). */
  function normalizeSort(value, fallback = 'chrono') {
    return SORTS.includes(value) ? value : fallback;
  }

  /** Categorias em uso (sem repetir, ordem alfabética pt-BR). */
  function categoriesIn(cuts) {
    return [...new Set(cuts.map((c) => (c.category || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  function countByStatus(cuts) {
    const counts = { all: cuts.length, pending: 0, approved: 0, rejected: 0 };
    for (const cut of cuts) if (cut.status in counts) counts[cut.status] += 1;
    return counts;
  }

  /**
   * Filtra. `filters`: { status: 'all'|'pending'|'approved'|'rejected', category: ''|NO_CATEGORY|nome,
   * origin: 'all'|'auto'|'manual', changed: bool (alterados desde a revisão), similar: bool }.
   * `ctx.similarIds` = Set com os ids que têm corte semelhante.
   */
  function filterCuts(cuts, filters = {}, ctx = {}) {
    const f = { ...DEFAULT_FILTERS, ...filters };
    const similarIds = ctx.similarIds || new Set();
    return cuts.filter((cut) => {
      if (f.status !== 'all' && cut.status !== f.status) return false;
      if (f.origin !== 'all' && (cut.origin === 'auto' ? 'auto' : 'manual') !== f.origin) return false;
      if (f.category === NO_CATEGORY && (cut.category || '').trim()) return false;
      if (f.category && f.category !== NO_CATEGORY && (cut.category || '').trim() !== f.category) return false;
      if (f.changed && !core.reviewState(cut).changed) return false;
      if (f.similar && !similarIds.has(cut.id)) return false;
      return true;
    });
  }

  /** Quantos filtros além do estado estão ligados (para o resumo "Mais filtros (2)"). */
  function activeExtraFilters(filters = {}) {
    const f = { ...DEFAULT_FILTERS, ...filters };
    return [f.category !== '', f.origin !== 'all', f.changed, f.similar].filter(Boolean).length;
  }

  return { SORTS, NO_CATEGORY, DEFAULT_FILTERS, compareChrono, sortCuts, normalizeSort, categoriesIn, countByStatus, filterCuts, activeExtraFilters };
});

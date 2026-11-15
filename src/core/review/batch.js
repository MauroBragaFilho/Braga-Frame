'use strict';

/**
 * Operações sobre cortes como "itens" (dono: review): cada item descreve uma mudança em UM corte
 * ({ cutId, type, before, after, ... }) e serve para a prévia (antes -> depois), para aplicar, para o
 * histórico e para desfazer. Operações em lote (aprovar, rejeitar, redefinir, categorizar, deslocar
 * tempos, remover, manter um) montam um *plano* com um item por corte. Nada aqui altera o projeto:
 * quem aplica é o engine. Universal: CommonJS no Node e `window.BFReview.batch` no renderer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) module.exports = factory(require('./core'));
  else { root.BFReview = root.BFReview || {}; root.BFReview.batch = factory(root.BFReview.core); }
})(globalThis, function (core) {
  const OPS = Object.freeze(['approve', 'reject', 'reset', 'categorize', 'shift', 'remove', 'keepOne']);
  const MAX_CATEGORY = 40;
  const STATUS_FIELDS = ['status', 'reviewedAt', 'reviewedRange'];

  const quote = (t) => `“${t}”`;

  /** Categoria limpa: sem espaços sobrando, no máximo 40 caracteres. */
  function cleanCategory(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CATEGORY);
  }

  function makeItem(cut, type, before, after, extra = {}) {
    return { cutId: cut.id, cutTitle: cut.title, type, before, after, cut: null, changed: true, invalid: false, note: '', ...extra };
  }

  // ---------- construtores de item (uma mudança em um corte) ----------

  /** Aprovar/rejeitar/redefinir. Aprovar de novo um corte "alterado" reconfirma a revisão. */
  function statusItem(cut, status, now) {
    const state = core.reviewState(cut);
    const before = core.snapshot(cut, STATUS_FIELDS);
    const after = status === 'pending'
      ? { status: 'pending', reviewedAt: null, reviewedRange: null }
      : { status, reviewedAt: now, reviewedRange: [cut.start, cut.end] };
    const type = status === 'approved' ? 'approve' : status === 'rejected' ? 'reject' : 'reset';
    const same = cut.status === status;
    const reconfirm = same && state.changed;
    return makeItem(cut, type, before, after, {
      changed: !same || reconfirm,
      note: reconfirm ? 'reconfirma a revisão depois da mudança de tempo' : (same ? 'já está assim' : '')
    });
  }

  function categoryItem(cut, category) {
    const next = cleanCategory(category);
    const same = (cut.category || '') === next;
    return makeItem(cut, 'recategorize', { category: cut.category || '' }, { category: next }, { changed: !same, note: same ? 'já está assim' : '' });
  }

  /** Título novo. `custom` true = digitado pelo usuário; false = veio de uma sugestão clicada. */
  function titleItem(cut, title, { custom = true } = {}) {
    const next = String(title || '').replace(/\s+/g, ' ').trim();
    const same = next === cut.title && (cut.titleCustom === true) === Boolean(custom);
    return makeItem(cut, 'retitle', core.snapshot(cut, ['title', 'titleCustom']), { title: next, titleCustom: Boolean(custom) }, {
      changed: !same && Boolean(next), invalid: !next, note: !next ? 'o título não pode ficar vazio' : ''
    });
  }

  /**
   * Novo início/fim (já validados por clampRange). Marca "alterado" se o corte já estava revisado (o engine aplica).
   * `ctx.edges` = bordas que o usuário pediu para mexer (padrão: as duas); só elas são arredondadas e limitadas ao
   * vídeo, a outra fica exatamente como está.
   */
  function adjustItem(cut, range, ctx = {}) {
    const check = core.clampRange(range.start, range.end, { duration: ctx.duration, edges: ctx.edges });
    const before = { start: cut.start, end: cut.end };
    const after = { start: check.start, end: check.end };
    const same = core.fieldEq(before.start, after.start) && core.fieldEq(before.end, after.end);
    return makeItem(cut, 'adjust', before, after, {
      changed: check.valid && !same,
      invalid: !check.valid,
      clampedEdges: check.clampedEdges || [],
      note: !check.valid ? check.reason : (check.clamped ? 'limitado aos limites do vídeo' : (same ? 'sem mudança' : ''))
    });
  }

  function removeItem(cut) {
    return makeItem(cut, 'remove', core.snapshot(cut), null, { cut: core.clone(cut) });
  }

  // ---------- descrição (prévia e histórico) ----------

  const range = (s) => `${core.fmtTime(s.start)} – ${core.fmtTime(s.end)}`;

  /** { from, to } em texto curto, para a lista "antes -> depois". */
  function describe(item) {
    const b = item.before || {};
    const a = item.after || {};
    if (item.type === 'create') return { from: '—', to: 'novo corte' };
    if (item.type === 'remove') return { from: range(b.start === undefined ? (item.cut || {}) : b), to: 'removido' };
    if (item.type === 'keep') return { from: 'mantido', to: 'mantido' };
    const from = [];
    const to = [];
    if ('status' in a) {
      from.push(core.STATUS_LABEL[b.status] || '—');
      const label = core.STATUS_LABEL[a.status] || '—';
      // "reconfirmado" só vale para o corte "alterado" que de fato será recarimbado; o que já está assim não muda
      if (b.status !== a.status) to.push(label);
      else to.push(item.changed === false ? `${label} (sem mudança)` : `${label} (reconfirmado)`);
    }
    if ('category' in a) { from.push(b.category || 'sem categoria'); to.push(a.category || 'sem categoria'); }
    if ('title' in a) { from.push(quote(b.title)); to.push(quote(a.title)); }
    if ('start' in a || 'end' in a) {
      from.push(range({ start: b.start, end: b.end }));
      to.push(range({ start: 'start' in a ? a.start : b.start, end: 'end' in a ? a.end : b.end }));
    }
    return { from: from.join(' · '), to: to.join(' · ') };
  }

  // ---------- planos em lote ----------

  const NAMES = {
    approve: ['Aprovar', 'Aprovou'],
    reject: ['Rejeitar', 'Rejeitou'],
    reset: ['Redefinir (voltar a pendente)', 'Redefiniu'],
    categorize: ['Categorizar', 'Categorizou'],
    shift: ['Deslocar tempos de', 'Deslocou os tempos de'],
    remove: ['Remover', 'Removeu'],
    keepOne: ['Manter um e rejeitar os demais', 'Manteve um e rejeitou os demais']
  };

  function labelFor(op, count, params, past) {
    const verb = NAMES[op][past ? 1 : 0];
    const n = core.plural(count, 'corte', 'cortes');
    if (op === 'keepOne') return verb;
    if (op === 'categorize') {
      const category = cleanCategory(params.category);
      return category ? `${verb} ${n} como ${quote(category)}` : `${past ? 'Limpou' : 'Limpar'} a categoria de ${n}`;
    }
    if (op === 'shift') {
      const parts = [];
      if (params.startDelta) parts.push(`início ${core.fmtDelta(params.startDelta)}`);
      if (params.endDelta) parts.push(`fim ${core.fmtDelta(params.endDelta)}`);
      return `${verb} ${n}${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }
    return `${verb} ${n}`;
  }

  function summarize(items) {
    const counts = { total: items.length, changed: 0, unchanged: 0, invalid: 0 };
    for (const item of items) {
      if (item.invalid) counts.invalid += 1;
      else if (item.changed) counts.changed += 1;
      else counts.unchanged += 1;
    }
    return counts;
  }

  /**
   * Monta o plano de uma operação sobre `ids` (na ordem cronológica). Não altera nada.
   * `op`: approve | reject | reset | categorize ({category}) | shift ({startDelta, endDelta}, em segundos) |
   * remove | keepOne ({keepId, approveKept}). `ctx`: { now, duration }.
   * Devolve { op, params, label, historyLabel, items, counts, error? } — `error` impede aplicar.
   */
  function planBatch({ cuts, ids, op, params = {}, now = new Date().toISOString(), duration = Infinity }) {
    if (!OPS.includes(op)) throw new Error(`Operação em lote desconhecida: ${op}`);
    const wanted = new Set(ids);
    const chosen = cuts.filter((c) => wanted.has(c.id)).sort((a, b) => (a.start - b.start) || (a.end - b.end));
    let items = [];
    let error = null;

    if (op === 'approve') items = chosen.map((c) => statusItem(c, 'approved', now));
    else if (op === 'reject') items = chosen.map((c) => statusItem(c, 'rejected', now));
    else if (op === 'reset') items = chosen.map((c) => statusItem(c, 'pending', now));
    else if (op === 'categorize') items = chosen.map((c) => categoryItem(c, params.category));
    else if (op === 'remove') items = chosen.map((c) => removeItem(c));
    else if (op === 'shift') {
      const sd = Number(params.startDelta || 0);
      const ed = Number(params.endDelta || 0);
      if (!Number.isFinite(sd) || !Number.isFinite(ed)) error = 'Informe números para deslocar (ex.: 0,5 ou -1).';
      else {
        // só a borda deslocada é arredondada e limitada ao vídeo: deslocar 0 não mexe naquela borda (nem a "arredonda")
        const edges = [...(sd ? ['start'] : []), ...(ed ? ['end'] : [])];
        items = chosen.map((c) => {
          const wasReviewed = core.reviewState(c).reviewed;
          const item = adjustItem(c, { start: c.start + sd, end: c.end + ed }, { duration, edges });
          if (wasReviewed && item.changed) item.note = [item.note, 'já revisado: ficará “alterado desde a revisão”'].filter(Boolean).join('; ');
          return item;
        });
      }
    } else if (op === 'keepOne') {
      const keepId = params.keepId;
      if (!chosen.some((c) => c.id === keepId)) error = 'Escolha qual corte manter.';
      else {
        items = chosen.map((c) => {
          if (c.id !== keepId) return statusItem(c, 'rejected', now);
          if (params.approveKept) return statusItem(c, 'approved', now);
          return makeItem(c, 'keep', null, null, { changed: false, note: 'corte mantido' });
        });
      }
    }
    if (!error && !chosen.length) error = 'Nenhum corte selecionado.';
    const counts = summarize(items);
    return {
      op, params, items, counts, error,
      label: labelFor(op, chosen.length, params, false),
      historyLabel: labelFor(op, chosen.length, params, true)
    };
  }

  return { OPS, MAX_CATEGORY, cleanCategory, statusItem, categoryItem, titleItem, adjustItem, removeItem, describe, planBatch, summarize };
});

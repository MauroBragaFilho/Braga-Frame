'use strict';

/**
 * Motor da revisão (dono: review): aplica mudanças nos cortes de forma única e reversível.
 *
 * Toda mudança de decisão (aprovar, rejeitar, redefinir, categorizar, renomear, ajustar tempo, remover,
 * lote, desfazer, restaurar) passa por `commit(itens, {label, source})`, que:
 *   1. aplica no projeto (via `deps.update`, que salva e avisa o app);
 *   2. grava um *grupo* no histórico (uma ação = um grupo, o lote inteiro fica agrupado);
 *   3. emite 'cuts:changed' (uma vez) e um 'decision' por mudança (contrato 1.3);
 *   4. alimenta as pilhas de desfazer/refazer.
 * Decisões vindas de outros recursos (ex.: "Salvar corte" da base emite 'create') entram em
 * `recordExternal` e também viram grupo (e podem ser desfeitas).
 *
 * Sem DOM nem Electron: recebe tudo por `deps` (testável no Node). Universal: CommonJS no Node e
 * `window.BFReview.engine` no renderer.
 *
 * deps: { getProject(), update(mutatorFn, reason), emit(evento, dados), now?(), uid?(prefixo),
 *         duration?() (duração do vídeo, para limitar tempos), persist?(projectId, grupo) }
 */
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory(require('./core'), require('./batch'), require('./titles'), require('../history/log'));
  } else {
    const R = root.BFReview;
    R.engine = factory(R.core, R.batch, R.titles, R.history);
  }
})(globalThis, function (core, batch, titles, log) {
  const MAX_STACK = 200;
  const MAX_GROUPS_IN_MEMORY = 3000;
  const EXTERNAL_WAIT_MS = 250;
  const quote = (t) => `“${t}”`;
  const VERB = { approve: 'Aprovou', reject: 'Rejeitou', reset: 'Redefiniu' };
  const EXTERNAL_VERB = { create: 'Criou', remove: 'Removeu', approve: 'Aprovou', reject: 'Rejeitou', reset: 'Redefiniu', retitle: 'Renomeou', recategorize: 'Recategorizou', adjust: 'Ajustou' };

  const chrono = (a, b) => (a.start - b.start) || (a.end - b.end) || String(a.id).localeCompare(String(b.id));

  function defaultUid(prefix = '') {
    return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function createEngine(deps) {
    const { getProject, update, emit } = deps;
    const now = deps.now || (() => new Date().toISOString());
    const uid = deps.uid || defaultUid;
    const durationOf = deps.duration || (() => Infinity);

    let projectId = null;
    let groups = []; // log cronológico (inclui desfazer/refazer/restaurar)
    let undoStack = []; // ids de grupos que o usuário pode desfazer
    let redoStack = [];
    const listeners = new Set();
    const notify = () => { for (const fn of [...listeners]) { try { fn(); } catch (err) { if (typeof console !== 'undefined') console.error('Erro ouvindo o motor da revisão:', err); } } };

    const cuts = () => { const p = getProject(); return p ? p.cuts : []; };
    const cutById = (id) => cuts().find((c) => c.id === id) || null;

    // ---------- estado ----------

    /** Começa do zero para o projeto `id` (ao abrir um vídeo): sem histórico em memória e sem pilhas. */
    function reset(id) {
      flushExternal();
      projectId = id || null;
      groups = [];
      undoStack = [];
      redoStack = [];
      notify();
    }

    /** Histórico gravado em disco: entra ANTES do que já foi feito nesta sessão. Ignora se for de outro projeto. */
    function loadGroups(list, forProjectId) {
      if (forProjectId !== undefined && forProjectId !== projectId) return false;
      const known = new Set(groups.map((g) => g.id));
      groups = [...log.normalizeGroups(list).filter((g) => !known.has(g.id)), ...groups].slice(-MAX_GROUPS_IN_MEMORY);
      notify();
      return true;
    }

    // ---------- aplicar ----------

    function record(group, source, project) {
      groups.push(group);
      if (groups.length > MAX_GROUPS_IN_MEMORY) groups = groups.slice(-MAX_GROUPS_IN_MEMORY);
      if (source !== 'undo' && source !== 'redo') {
        undoStack.push(group.id);
        if (undoStack.length > MAX_STACK) undoStack.shift();
        redoStack = [];
      }
      if (typeof deps.persist === 'function') {
        try { deps.persist(project.id, group); } catch (err) { if (typeof console !== 'undefined') console.error('Não foi possível guardar o histórico:', err); }
      }
    }

    /**
     * Aplica `items` como UM grupo. Itens `changed:false`, `invalid` ou do tipo 'keep' são ignorados.
     * Devolve null (nada a fazer / sem projeto) ou { group, missing } — `missing` = cortes que não
     * existem mais (ex.: removidos por outro recurso depois da decisão).
     */
    function commit(items, { label, source = 'user', of } = {}) {
      flushExternal();
      const project = getProject();
      if (!project) return null;
      const stamp = now();
      const wanted = items.filter((i) => !i.invalid && i.type !== 'keep' && i.changed !== false).map(log.stripItem);
      if (!wanted.length) return null;
      // Quem sai do projeto leva a cópia do corte COMO ESTÁ AGORA: o que vier de um evento antigo (ex.: desfazer o "Criou corte"
      // de um corte que já ganhou legendas, ajuste de áudio ou exportações) devolveria o corte do dia em que foi criado.
      for (const item of wanted) {
        if (item.type !== 'remove') continue;
        const live = cutById(item.cutId);
        if (live) item.cut = core.clone(live);
      }
      const applied = [];
      let missing = 0;
      update((p) => {
        for (const item of wanted) {
          const result = log.applyForward(p.cuts, item, stamp);
          if (result === 'ok') applied.push(item);
          else if (result === 'missing') missing += 1;
        }
        p.cuts.sort(chrono);
      }, `review:${source}`);
      if (!applied.length) return { group: null, missing };
      if (source === 'undo' && of) {
        // desfazer uma CRIAÇÃO tira o corte levando a cópia dele de agora; o "refazer" (que reaplica o grupo original) precisa
        // dessa cópia, senão devolveria o corte do dia em que foi criado, sem o que ele ganhou depois
        const original = find(of);
        for (const item of applied) {
          const mate = original && item.type === 'remove' ? original.items.find((i) => i.type === 'create' && i.cutId === item.cutId) : null;
          if (mate && item.cut) mate.cut = core.clone(item.cut);
        }
      }
      const group = { id: uid('g'), at: stamp, label, source, ...(of ? { of } : {}), items: applied };
      record(group, source, project);
      emit('cuts:changed', { ids: [...new Set(applied.map((i) => i.cutId))], from: 'review' });
      for (const item of applied) {
        for (const event of log.eventsFor(item)) emit('decision', { ...event, reviewGroup: group.id, source, label });
      }
      notify();
      return { group, missing };
    }

    // Decisões de outros recursos chegam uma a uma (a análise pode criar dezenas de cortes de uma vez):
    // as que chegam coladas viram UM grupo no histórico ("Criou 12 cortes"), não 12 linhas.
    let externalBuffer = [];
    let externalProjectId = null;
    let externalTimer = null;

    function externalLabel(items) {
      if (items.length === 1) return `${EXTERNAL_VERB[items[0].type] || 'Alterou'} ${quote(items[0].cutTitle)}`;
      const types = new Set(items.map((i) => i.type));
      const verb = types.size === 1 ? (EXTERNAL_VERB[[...types][0]] || 'Alterou') : 'Alterou';
      return `${verb} ${core.plural(new Set(items.map((i) => i.cutId)).size, 'corte', 'cortes')}`;
    }

    /**
     * Fecha o grupo das decisões externas que estavam esperando (o motor faz isso sozinho antes de
     * qualquer ação, desfazer ou restauração, e depois de uma pequena pausa sem novidades).
     * Se o projeto já mudou, o grupo só é gravado no histórico dele em disco.
     */
    function flushExternal() {
      clearTimeout(externalTimer);
      externalTimer = null;
      if (!externalBuffer.length) return null;
      const items = externalBuffer;
      const ownerId = externalProjectId;
      externalBuffer = [];
      const group = { id: uid('g'), at: now(), label: externalLabel(items), source: 'external', items };
      const project = getProject();
      if (project && project.id === ownerId) {
        record(group, 'external', project);
        notify();
      } else if (ownerId && typeof deps.persist === 'function') {
        deps.persist(ownerId, group);
      }
      return group;
    }

    /** 'decision' de outro recurso: entra no histórico (e pode ser desfeita). Ignora as nossas. */
    function recordExternal(event) {
      if (!event || event.reviewGroup) return false;
      const project = getProject();
      if (!project) return false;
      const item = log.itemFromEvent(event, project.cuts);
      if (!item) return false;
      if (externalBuffer.length && externalProjectId !== project.id) flushExternal();
      externalProjectId = project.id;
      externalBuffer.push(log.stripItem(item));
      clearTimeout(externalTimer);
      externalTimer = setTimeout(flushExternal, EXTERNAL_WAIT_MS);
      return true;
    }

    // ---------- desfazer / refazer / restaurar ----------

    const find = (id) => groups.find((g) => g.id === id) || null;

    function undo() {
      flushExternal();
      const id = undoStack.pop();
      if (!id) return null;
      const target = find(id);
      if (!target) { notify(); return null; }
      const result = commit(log.invertItems(target.items), { label: `Desfez: ${target.label}`, source: 'undo', of: id });
      redoStack.push(id);
      notify();
      return { target, group: result && result.group, missing: result ? result.missing : 0 };
    }

    function redo() {
      flushExternal();
      const id = redoStack.pop();
      if (!id) return null;
      const target = find(id);
      if (!target) { notify(); return null; }
      const result = commit(target.items, { label: `Refez: ${target.label}`, source: 'redo', of: id });
      undoStack.push(id);
      notify();
      return { target, group: result && result.group, missing: result ? result.missing : 0 };
    }

    /**
     * Plano para voltar ao estado de ANTES do grupo `groupId` (desfaz ele e tudo que veio depois).
     * Devolve { label, items, counts, group } ou null. Não altera nada: mostre a prévia e chame `restore(plan)`.
     */
    function planRestore(groupId) {
      flushExternal();
      const index = groups.findIndex((g) => g.id === groupId);
      if (index < 0) return null;
      const items = log.planRestore(cuts(), groups, index);
      const group = groups[index];
      return {
        group, items, counts: batch.summarize(items), error: null,
        label: `Restaurar o estado anterior a ${quote(group.label)}`,
        historyLabel: `Restaurou o estado anterior a ${quote(group.label)}`
      };
    }

    function restore(plan) {
      if (!plan || !plan.items.length) return null;
      return commit(plan.items, { label: plan.historyLabel, source: 'restore', of: plan.group.id });
    }

    // ---------- ações sobre cortes ----------

    /** Prévia de uma operação em lote (veja batch.planBatch). */
    function plan(op, ids, params = {}) {
      return batch.planBatch({ cuts: cuts(), ids, op, params, now: now(), duration: durationOf() });
    }

    /** Aplica um plano (depois da confirmação do usuário). */
    function commitPlan(p) {
      if (!p || p.error) return null;
      return commit(p.items, { label: p.historyLabel, source: 'batch' });
    }

    function setStatus(id, status) {
      const cut = cutById(id);
      if (!cut) return null;
      const item = batch.statusItem(cut, status, now());
      const label = item.note.startsWith('reconfirma') ? `Reconfirmou a revisão de ${quote(cut.title)}` : `${VERB[item.type]} ${quote(cut.title)}`;
      return commit([item], { label });
    }

    /** Reafirma a revisão de um corte já aprovado/rejeitado cujo tempo mudou. */
    function markReviewed(id) {
      const cut = cutById(id);
      if (!cut || cut.status === 'pending') return null;
      return setStatus(id, cut.status);
    }

    function retitle(id, title, { custom = true } = {}) {
      const cut = cutById(id);
      if (!cut) return null;
      const item = batch.titleItem(cut, title, { custom });
      return commit([item], { label: `Renomeou ${quote(cut.title)} para ${quote(item.after.title)}` });
    }

    function recategorize(id, category) {
      const cut = cutById(id);
      if (!cut) return null;
      const item = batch.categoryItem(cut, category);
      const next = item.after.category;
      return commit([item], { label: next ? `Categoria de ${quote(cut.title)}: ${next}` : `Limpou a categoria de ${quote(cut.title)}` });
    }

    /**
     * Muda início e/ou fim: `patch` = { start?, end? } (absolutos). Devolve { ok, reason?, clamped, clampedEdges, result }.
     * Só a(s) borda(s) do `patch` é(são) arredondada(s) e limitada(s); a outra continua exatamente como estava.
     * Se o corte já estava revisado ele passa a "alterado desde a revisão".
     */
    function adjust(id, patch) {
      const cut = cutById(id);
      if (!cut) return { ok: false, reason: 'O corte não existe mais.' };
      const range = {
        start: patch.start === undefined ? cut.start : Number(patch.start),
        end: patch.end === undefined ? cut.end : Number(patch.end)
      };
      const edges = ['start', 'end'].filter((edge) => patch[edge] !== undefined);
      const item = batch.adjustItem(cut, range, { duration: durationOf(), edges });
      if (item.invalid) return { ok: false, reason: item.note };
      const parts = [];
      if (!core.fieldEq(item.before.start, item.after.start)) parts.push(`início ${core.fmtDelta(item.after.start - item.before.start)}`);
      if (!core.fieldEq(item.before.end, item.after.end)) parts.push(`fim ${core.fmtDelta(item.after.end - item.before.end)}`);
      const result = commit([item], { label: `Ajustou ${quote(cut.title)}${parts.length ? ` (${parts.join(', ')})` : ''}` });
      return { ok: true, changed: Boolean(result && result.group), clamped: item.note.startsWith('limitado'), clampedEdges: item.clampedEdges, result, start: item.after.start, end: item.after.end };
    }

    /** Move uma borda por um passo (±1 s, ±0,1 s…); a borda para no limite em vez de falhar. */
    function nudge(id, edge, delta) {
      const cut = cutById(id);
      if (!cut) return { ok: false, reason: 'O corte não existe mais.' };
      const next = core.adjustEdge(cut, edge, { delta }, { duration: durationOf() });
      if (!next.valid) return { ok: false, reason: next.reason };
      const out = adjust(id, edge === 'start' ? { start: next.start } : { end: next.end });
      if (!out.ok) return out;
      const clampedEdges = [...new Set([...(out.clampedEdges || []), ...(next.clampedEdges || [])])];
      return { ...out, clamped: out.clamped || next.clamped, clampedEdges };
    }

    function remove(id) {
      const cut = cutById(id);
      if (!cut) return null;
      return commit([batch.removeItem(cut)], { label: `Removeu ${quote(cut.title)}` });
    }

    // ---------- edições que não são decisões (sem histórico) ----------

    /** Notas do corte: não é uma decisão (sem evento nem histórico), só salva. */
    function setNotes(id, text) {
      const cut = cutById(id);
      if (!cut || (cut.notes || '') === text) return false;
      update(() => { cut.notes = text; cut.updatedAt = now(); }, 'review:notes');
      emit('cuts:changed', { ids: [id], from: 'review:inline' });
      return true;
    }

    /**
     * Guarda sugestões de título geradas localmente em `cut.titleSuggestions`. Nunca mexe no título.
     * Devolve a lista completa.
     */
    function suggestTitles(id, ctx = {}) {
      const cut = cutById(id);
      if (!cut) return [];
      const fresh = titles.suggestTitles(cut, ctx);
      if (fresh.length) {
        update(() => { cut.titleSuggestions = titles.mergeSuggestions(cut.titleSuggestions, fresh); cut.updatedAt = now(); }, 'review:suggestions');
        emit('cuts:changed', { ids: [id], from: 'review:inline' });
      }
      return cut.titleSuggestions || [];
    }

    return {
      reset, loadGroups, onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      commit, recordExternal, flushExternal, undo, redo, planRestore, restore, plan, commitPlan,
      setStatus, markReviewed, retitle, recategorize, adjust, nudge, remove, setNotes, suggestTitles,
      groups: () => groups,
      canUndo: () => undoStack.length > 0,
      canRedo: () => redoStack.length > 0,
      undoLabel: () => { const g = find(undoStack[undoStack.length - 1]); return g ? g.label : ''; },
      redoLabel: () => { const g = find(redoStack[redoStack.length - 1]); return g ? g.label : ''; },
      topUndoId: () => undoStack[undoStack.length - 1] || null,
      projectId: () => projectId
    };
  }

  return { MAX_STACK, createEngine };
});

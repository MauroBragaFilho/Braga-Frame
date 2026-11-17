'use strict';

/**
 * Aba "Análise" — Resultados: resumo, lista de sugestões (adicionar, descartar, restaurar, ordem), o que a IA descartou e conferiu.
 * Tirado de features/analysis.js (Etapa 2, 17/11/2026) sem mudar o comportamento. É uma FÁBRICA: analysis.js a chama com o que ela
 * precisa do resto da aba (`A`: estado e funções) e recebe de volta o que ela oferece. Carrega ANTES de analysis.js (renderer/index.html).
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;
  const { isCovered, clock, pct, dismissedSuggestions, usesAi, plural, summaryText } = window.BFAnalysisLogic;

  window.BFAnalysisParts = window.BFAnalysisParts || {};
  window.BFAnalysisParts.results = function (A) {
    const { state } = A;
    const current = (...args) => A.current(...args);
    const dismissedOf = (...args) => A.dismissedOf(...args);
    const visible = (...args) => A.visible(...args);
    const listOrder = (...args) => A.listOrder(...args);
    const inViewOrder = (...args) => A.inViewOrder(...args);
    const addSuggestions = (...args) => A.addSuggestions(...args);
    const dismissSuggestions = (...args) => A.dismissSuggestions(...args);
    const restoreSuggestions = (...args) => A.restoreSuggestions(...args);
    const icon = (...args) => A.icon(...args);

    function renderResults() {
      const ui = state.ui;
      if (!ui.results) return;
      const saved = current();
      const hasRun = Boolean(saved && Array.isArray(saved.suggestions) && saved.runAt);
      ui.results.hidden = !hasRun;
      if (!hasRun) { ui.list.replaceChildren(); ui.dismissedBox.hidden = true; ui.models.hidden = true; return; }
      const cuts = BF.state.project.cuts;
      const dismissed = dismissedOf(saved);
      const list = visible();
      const gone = dismissedSuggestions(saved.suggestions, cuts, dismissed);
      const counts = { inCuts: saved.suggestions.filter((s) => isCovered(s, cuts)).length, dismissed: gone.length };
      ui.summary.textContent = summaryText(saved, counts);
      renderAiModels(saved);
      renderAiDrops(saved);
      renderAiUnpicked(saved);
      renderAiReview(saved);
      ui.addAll.hidden = list.length < 2;
      ui.addAll.textContent = `Adicionar todas (${list.length})`;
      ui.addAll.disabled = state.running;
      ui.dismissAll.hidden = list.length < 2;
      ui.dismissAll.textContent = `Descartar todas (${list.length})`;
      const hasEpisodes = Array.isArray(saved.episodes) && saved.episodes.length > 1;
      ui.orderBox.hidden = list.length < 2;
      ui.orderTime.textContent = hasEpisodes ? 'Ordem dos episódios' : 'Ordem do vídeo';
      ui.order.value = listOrder();
      ui.order.disabled = state.running;
      ui.dismissAll.disabled = state.running;
      ui.empty.hidden = list.length > 0;
      ui.emptyBox.hidden = ui.empty.hidden;
      ui.emptyTitle.textContent = !saved.suggestions.length ? 'Nenhuma sugestão' : counts.dismissed ? 'Nada novo para revisar' : 'Tudo já está nos cortes';
      if (!saved.suggestions.length) {
        ui.empty.textContent = `Nenhum momento passou dos critérios. Aumente a sensibilidade ou a quantidade, ou baixe a relevância mínima nas Preferências.${saved.warnings && saved.warnings.length ? ' Confira também os avisos acima.' : ''}`;
      } else {
        ui.empty.textContent = counts.dismissed
          ? 'Não há mais sugestões para revisar: as outras estão nos cortes ou foram descartadas.'
          : 'Todas as sugestões já estão nos cortes (inclusive as rejeitadas). Revise na aba Cortes.';
      }
      ui.list.replaceChildren(...inViewOrder(list).map((s, index) => row(s, index)));
      // descartadas: seção recolhida, só aparece quando há alguma
      ui.dismissedBox.hidden = gone.length === 0;
      ui.dismissedTitle.textContent = `Descartadas (${gone.length})`;
      ui.restoreAll.hidden = gone.length < 2;
      ui.restoreAll.disabled = state.running;
      ui.dismissedList.replaceChildren(...gone.map((s) => dismissedRow(s)));
    }

    /**
     * "Modelo(s) que responderam: …" (campo `model` de cada resposta). Só aparece quando alguém diferente do modelo escolhido respondeu:
     * com o roteador gratuito do OpenRouter (que sorteia um modelo por pedido) ou depois de uma troca para um modelo de reserva.
     */
    function renderAiModels(saved) {
      const ui = state.ui;
      const ai = usesAi(saved.engine) && saved.ai ? saved.ai : null;
      const entries = ai && ai.models && typeof ai.models === 'object' ? Object.entries(ai.models).filter(([, n]) => n > 0) : [];
      const differs = entries.some(([id]) => id !== ai.model);
      ui.models.hidden = !entries.length || !differs;
      ui.models.textContent = ui.models.hidden ? '' : `Modelo(s) que responderam: ${entries.map(([id, n]) => `${id} (${plural(n, 'chamada', 'chamadas')})`).join(', ')}`;
    }

    /** Seção recolhida com o que a conferência local descartou (só nas análises por IA). */
    function renderAiDrops(saved) {
      const ui = state.ui;
      const dropped = usesAi(saved.engine) && saved.ai && Array.isArray(saved.ai.dropped) ? saved.ai.dropped : [];
      ui.aiDropBox.hidden = !dropped.length;
      if (!dropped.length) return;
      ui.aiDropTitle.textContent = `Descartadas na conferência (${saved.ai.droppedTotal || dropped.length})`;
      ui.aiDropList.replaceChildren(...dropped.map((d) => el('li', { class: 'an-drop' },
        el('span', { class: 'an-time small' }, `${clock(d.start)} → ${clock(d.end)}`),
        el('span', { class: 'muted small' }, `${d.title ? `${d.title} · ` : ''}${d.detail || d.reason}`))));
    }

    /** Seção recolhida com os candidatos que passaram na conferência e que a escolha final da IA deixou de fora (só nas análises por IA). */
    function renderAiUnpicked(saved) {
      const ui = state.ui;
      const list = usesAi(saved.engine) && saved.ai && Array.isArray(saved.ai.unpicked) ? saved.ai.unpicked : [];
      ui.aiUnpickedBox.hidden = !list.length;
      if (!list.length) return;
      const f = saved.ai.funnel || {};
      const total = Number.isFinite(f.offered) && Number.isFinite(f.picked) ? Math.max(list.length, f.offered - f.picked) : list.length;
      ui.aiUnpickedTitle.textContent = `Fora da escolha final da IA (${total})`;
      ui.aiUnpickedList.replaceChildren(...list.map((u) => el('li', { class: 'an-drop' },
        el('span', { class: 'an-time small' }, `${clock(u.start)} → ${clock(u.end)}`),
        el('span', { class: 'muted small' }, `${u.title || 'sem título'}${Number.isFinite(u.relevance) ? ` · relevância ${Math.round(u.relevance * 100)}%` : ''}`))));
    }

    /** Seção recolhida com as sugestões do algoritmo que a IA leu e tirou da lista (modo Algoritmo + IA). */
    function renderAiReview(saved) {
      const ui = state.ui;
      const r = saved.engine === 'both' && saved.review ? saved.review : null;
      const list = r && Array.isArray(r.list) ? r.list : [];
      ui.aiReviewBox.hidden = !list.length;
      if (!list.length) return;
      ui.aiReviewTitle.textContent = `Sugestões do algoritmo que a IA tirou (${Math.max(list.length, r.dropped || 0)})`;
      ui.aiReviewList.replaceChildren(...list.map((d) => el('li', { class: 'an-drop' },
        el('span', { class: 'an-time small' }, `${clock(d.start)} → ${clock(d.end)}`),
        el('span', { class: 'muted small' }, `${d.why || 'sem motivo informado'}${Number.isFinite(d.relevance) ? ` · nota do algoritmo ${Math.round(d.relevance * 100)}%` : ''}`))));
    }

    /** Algoritmo + IA: qual motor achou a sugestão (null nas análises de um motor só). */
    function engineChip(s) {
      if (!Array.isArray(s.engines) || !s.engines.length) return null;
      const both = s.engines.includes('algorithm') && s.engines.includes('ai');
      if (both) return el('li', { class: 'bds-chip bds-chip-accent an-engine-chip', title: 'O algoritmo e a IA acharam este momento' }, 'Algoritmo + IA');
      return s.engines[0] === 'ai'
        ? el('li', { class: 'bds-chip an-engine-chip', title: 'Só a IA achou este momento' }, 'IA')
        : (s.review === 'ai' && s.reviewFrom
          ? el('li', { class: 'bds-chip an-engine-chip', title: `Só o algoritmo achou este momento; a IA leu o trecho, aprovou e acertou o início e o fim (o algoritmo tinha marcado ${clock(s.reviewFrom.start)} a ${clock(s.reviewFrom.end)})` }, 'Algoritmo · IA ajustou')
          : s.review === 'ai'
          ? el('li', { class: 'bds-chip an-engine-chip', title: 'Só o algoritmo achou este momento; a IA leu o trecho e aprovou' }, 'Algoritmo · IA conferiu')
          : el('li', { class: 'bds-chip an-engine-chip', title: 'Só o algoritmo achou este momento' }, 'Algoritmo'));
    }

    function row(s, index) {
      const dur = Math.round(s.end - s.start);
      const label = `${clock(s.start)} a ${clock(s.end)}`;
      return el('li', { class: 'an-item', dataset: { id: s.id, start: String(s.start), end: String(s.end) } },
        el('div', { class: 'an-item-head' },
          el('span', { class: 'an-rank' }, String(index + 1)),
          el('span', { class: 'an-time' }, `${clock(s.start)} → ${clock(s.end)}`),
          el('span', { class: 'an-dur muted small' }, `${dur} s`),
          el('span', { class: 'an-rel bds-chip bds-chip-accent', title: 'Relevância estimada pelas regras (0 a 100%). Não é garantia.', 'aria-label': `Relevância ${pct(s.relevance)}` }, pct(s.relevance))),
        s.title ? el('p', { class: 'an-cut-title' }, s.title) : null,
        (s.category || s.layout || s.theme || s.episode || s.reasons.length || engineChip(s))
          ? el('ul', { class: 'an-reasons' },
            engineChip(s),
            s.episode ? el('li', { class: 'bds-chip bds-chip-info an-episode', title: 'Episódio da live (contado entre as telas de espera)' }, `Episódio ${s.episode}`) : null,
            s.category ? el('li', { class: 'bds-chip bds-chip-info' }, s.category) : null,
            s.theme ? el('li', { class: 'bds-chip bds-chip-accent an-theme', title: 'Tema do perfil do canal' }, `Tema: ${s.theme}`) : null,
            s.layout ? el('li', { class: 'bds-chip' }, s.layout === 'jogo' ? 'Jogo' : 'Conversa') : null,
            s.reasons.map((r) => el('li', { class: `bds-chip${/^revisar/i.test(r) ? ' bds-chip-warn' : ''}` }, r)))
          : null,
        Array.isArray(s.keywords) && s.keywords.length
          ? el('ul', { class: 'an-reasons an-keywords', 'aria-label': 'Palavras-chave' }, s.keywords.map((k) => el('li', { class: 'bds-chip an-keyword', title: 'Palavra-chave sugerida pela IA' }, `#${k}`)))
          : null,
        el('div', { class: 'an-actions' },
          el('button', { type: 'button', class: 'an-view sm', 'aria-label': `Ver trecho de ${label}`, onclick: () => BF.player.playRange(s.start, s.end) }, icon('play_arrow'), 'Ver trecho'),
          el('button', { type: 'button', class: 'an-add secondary sm', 'aria-label': `Adicionar o trecho de ${label} como sugestão`, onclick: () => addOne(s, index) }, icon('add'), 'Adicionar'),
          el('button', { type: 'button', class: 'an-dismiss icon-btn', 'aria-label': `Descartar o trecho de ${label}`, title: 'Esconde esta sugestão sem criar corte; dá para restaurar em "Descartadas".', onclick: () => dismissOne(s, index) }, icon('close'))));
    }

    function dismissedRow(s) {
      const label = `${clock(s.start)} a ${clock(s.end)}`;
      return el('li', { class: 'an-item an-item-dismissed', dataset: { id: s.id, start: String(s.start), end: String(s.end) } },
        el('div', { class: 'an-item-head' },
          el('span', { class: 'an-time' }, `${clock(s.start)} → ${clock(s.end)}`),
          el('span', { class: 'an-dur muted small' }, `${Math.round(s.end - s.start)} s`),
          el('span', { class: 'an-rel muted small' }, pct(s.relevance))),
        el('div', { class: 'an-actions' },
          el('button', { type: 'button', class: 'an-view sm', 'aria-label': `Ver trecho de ${label}`, onclick: () => BF.player.playRange(s.start, s.end) }, icon('play_arrow'), 'Ver trecho'),
          el('button', { type: 'button', class: 'an-restore sm', 'aria-label': `Restaurar o trecho de ${label}`, onclick: () => restoreOne(s) }, icon('undo'), 'Restaurar')));
    }

    function setListOrder(value) {
      const order = value === 'time' ? 'time' : 'relevance';
      if (order === listOrder()) return;
      BF.project.update((project) => {
        project.ext = project.ext || {};
        project.ext.analysis = { ...(project.ext.analysis || {}), listOrder: order };
      }, { reason: 'analysis:order' });
      renderResults();
    }

    function addOne(s, index) {
      const created = addSuggestions([s]);
      if (created.length) BF.ui.log(`Sugestão adicionada como pendente (${clock(s.start)}). Revise na aba Cortes.`, 'ok');
      renderResults();
      focusAfter(index, '.an-add');
    }

    function addAll() {
      const list = visible();
      const created = addSuggestions(list);
      if (created.length) {
        BF.ui.toast(`${created.length} sugestão(ões) adicionada(s) como pendentes. Nada foi aprovado: revise na aba Cortes.`, 'ok');
        BF.ui.log(`${created.length} sugestão(ões) adicionada(s) como pendentes.`, 'ok');
      }
      renderResults();
      focusAfter(0, '.an-add');
    }

    function dismissOne(s, index) {
      if (dismissSuggestions([s])) BF.ui.log(`Sugestão de ${clock(s.start)} descartada (nenhum corte foi criado). Dá para restaurar em "Descartadas".`, 'ok');
      renderResults();
      focusAfter(index, '.an-dismiss');
    }

    function dismissAll() {
      const list = visible();
      if (dismissSuggestions(list)) {
        BF.ui.toast(`${list.length} sugestão(ões) descartada(s). Nenhum corte foi criado; dá para restaurar em "Descartadas".`, 'ok');
        BF.ui.log(`${list.length} sugestão(ões) descartada(s).`, 'ok');
      }
      renderResults();
      focusAfter(0, '.an-dismiss');
    }

    function restoreOne(s) {
      if (restoreSuggestions([s])) BF.ui.log(`Sugestão de ${clock(s.start)} restaurada.`, 'ok');
      renderResults();
      focusAfter(0, '.an-add');
    }

    function restoreAll() {
      const saved = current();
      const list = saved ? dismissedSuggestions(saved.suggestions, BF.state.project.cuts, dismissedOf(saved)) : [];
      if (restoreSuggestions(list)) BF.ui.log(`${list.length} sugestão(ões) restaurada(s).`, 'ok');
      renderResults();
      focusAfter(0, '.an-add');
    }

    /** Depois de agir numa linha, o foco vai para o botão equivalente da linha que ocupou o lugar (ou para o botão mais próximo). */
    function focusAfter(index, selector) {
      const ui = state.ui;
      const buttons = [...ui.list.querySelectorAll(selector)];
      const target = buttons[Math.min(index, buttons.length - 1)] || (ui.addAll.hidden ? ui.run : ui.addAll);
      if (target && !target.disabled) target.focus();
    }

    return { renderResults, setListOrder, addAll, dismissAll, restoreAll };
  };
})();

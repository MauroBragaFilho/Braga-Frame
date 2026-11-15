'use strict';

/**
 * Aba "Cortes": central de revisão (dono: review). A lógica (ordem, filtros, semelhança, títulos, lotes,
 * desfazer, histórico) é pura e fica em src/core/review e src/core/history (carregada aqui por <script>,
 * como o modelo da base); este arquivo só monta a interface. Todas as mudanças passam por
 * `BF.review.engine.commit`, que emite 'cuts:changed' e 'decision' (contrato 1.3) e alimenta o histórico.
 *
 * Também expõe `BF.review` para a timeline (renderer/features/timeline.js): { ready, engine, adjust, select }.
 */
(function () {
  const BF = window.BF;
  const { el, fmt, parseTime, secs } = BF.util;

  const LOGIC = ['review/core', 'review/order', 'review/similarity', 'review/titles', 'review/batch', 'history/log', 'review/engine'];
  const DEFAULT_CATEGORIES = ['Jogada', 'Clutch', 'Engraçado', 'Fail', 'Hype', 'Dica'];
  const HISTORY_PAGE = 30;
  const STATUS_TEXT = { approved: 'aprovado', rejected: 'rejeitado' };
  const SOURCE_TAG = { undo: 'desfeito', redo: 'refeito', restore: 'restauração', external: 'fora da revisão' };
  const OUTSIDE_TOLERANCE = 0.05; // s: mesmo critério da aba Preferências para "corte fora do novo intervalo"

  BF.review = BF.review || {};

  let R = null; // window.BFReview (lógica)
  let engine = null;
  let root = null;
  let started = false;
  const refs = {};

  const view = {
    sort: 'chrono',
    filters: null,
    selected: new Set(), // ids marcados nas caixas (lote)
    anchor: null, // última caixa clicada (shift marca o intervalo)
    active: null, // corte aberto para ajuste (o primeiro, até o usuário escolher outro)
    explicit: false, // o usuário (ou outro recurso) escolheu o corte aberto? só então a linha ganha a classe "selected"
    groupFocus: null, // id do grupo de semelhantes em foco
    preview: null, // { spec, plan, opener }
    historyShown: HISTORY_PAGE,
    droppedHistory: 0,
    advancedOpen: false // o "Avançado" do corte aberto (notas e sugestões de título) fica como o usuário deixou entre redesenhos
  };

  // ---------- carga da lógica ----------

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const node = document.createElement('script');
      node.src = src;
      node.onload = resolve;
      node.onerror = () => reject(new Error(`Não foi possível carregar ${src}`));
      document.head.append(node);
    });
  }

  async function loadLogic() {
    if (!(window.BFReview && window.BFReview.engine)) {
      for (const name of LOGIC) await loadScript(`../src/core/${name}.js`);
    }
    return window.BFReview;
  }

  // ---------- utilidades ----------

  const project = () => BF.state.project;
  const allCuts = () => (project() ? project().cuts : []);
  const cutById = (id) => allCuts().find((c) => c.id === id) || null;
  const plural = (n, one, many) => R.core.plural(n, one, many);

  function categoriesFromPrefs() {
    let list = BF.prefs.get('review.categories', DEFAULT_CATEGORIES);
    if (!Array.isArray(list)) list = DEFAULT_CATEGORIES;
    const names = list.map((c) => (typeof c === 'string' ? c : (c && (c.name || c.label)) || '')).map((c) => String(c).trim()).filter(Boolean);
    return names.length ? names : DEFAULT_CATEGORIES;
  }

  const knownCategories = () => [...new Set([...categoriesFromPrefs(), ...R.order.categoriesIn(allCuts())])];
  const defaultSort = () => R.order.normalizeSort(BF.prefs.get('review.defaultSort', 'chrono'));

  /**
   * O corte passa do fim da fonte enquanto as Preferências guardam um aviso de fonte atualizada que o usuário ainda não
   * dispensou (project.ext.prefs.sourceChange, com dismissed:false)? Só sinaliza: o corte não é alterado nem apagado.
   */
  function outsideSource(cut) {
    const p = project();
    const change = p && p.ext && p.ext.prefs && p.ext.prefs.sourceChange;
    if (!change || change.dismissed) return false;
    const duration = (BF.state.info && BF.state.info.duration) || (p.source && p.source.duration) || 0;
    return duration > 0 && cut.end > duration + OUTSIDE_TOLERANCE;
  }

  function projectContext() {
    const p = project();
    const origin = (p && p.source && p.source.origin) || {};
    return { game: (p && p.meta && p.meta.game) || origin.game || '', channel: (p && p.meta && p.meta.channel) || origin.channel || '' };
  }

  /** Foco que sobrevive ao redesenho: elementos com data-focus, dentro de um corte (ou da barra). */
  function captureFocus() {
    const node = document.activeElement;
    if (!node || !root || !root.contains(node) || !node.dataset || !node.dataset.focus) return null;
    const owner = node.closest('[data-id]');
    const info = { key: node.dataset.focus, id: owner ? owner.dataset.id : null, from: node.selectionStart, to: node.selectionEnd };
    return info;
  }

  const selectorValue = (text) => text.split('\\').join('\\\\').split('"').join('\\"'); // vira parte de um seletor [data-focus="..."]

  function restoreFocus(info) {
    if (!info) return;
    const scope = info.id ? root.querySelector(`[data-id="${CSS.escape(info.id)}"]`) : root;
    const key = selectorValue(info.key);
    const target = scope && scope.querySelector(`[data-focus="${key}"]`);
    if (!target || target.disabled) return;
    target.focus({ preventScroll: true });
    if (info.from !== null && info.from !== undefined && typeof target.setSelectionRange === 'function') {
      try { target.setSelectionRange(info.from, info.to); } catch { /* campo sem seleção */ }
    }
  }

  // Campos de texto do corte (data-focus) cujo valor na tela vem do corte. Se o texto da tela for outro, o usuário está digitando.
  const EDIT_KEYS = new Set(['title', 'category', 'notes', 'time-start', 'time-end']);
  function fieldText(cut, key) {
    if (key === 'title') return cut.title;
    if (key === 'category') return cut.category || '';
    if (key === 'notes') return cut.notes || '';
    return fmt(key === 'time-start' ? cut.start : cut.end);
  }

  /**
   * O campo em que o usuário está digitando (foco no campo e texto que ainda não é o do corte), ou null. Refazer a lista
   * recria os campos: o texto em andamento voltava ao valor do corte ou, pior, o navegador o confirmava no meio da digitação
   * (um título pela metade virava o título do corte e entrava no histórico; um tempo incompleto mudava o corte).
   */
  function editedField() {
    const node = document.activeElement;
    if (!root || !node || !root.contains(node) || !node.dataset || !EDIT_KEYS.has(node.dataset.focus) || typeof node.value !== 'string') return null;
    const owner = node.closest('[data-id]');
    const cut = owner ? cutById(owner.dataset.id) : null;
    return cut && node.value !== fieldText(cut, node.dataset.focus) ? node : null;
  }

  let waitingEdit = null;

  /** Adia o redesenho até o usuário sair do campo (o "change" confirma o texto e agenda o redesenho; sem mudança, agenda aqui). */
  function renderAfterEdit(node) {
    if (waitingEdit === node) return;
    waitingEdit = node;
    node.addEventListener('focusout', () => { waitingEdit = null; scheduleRender(); }, { once: true });
  }

  // Redesenhar no meio de um clique perderia o clique (o botão some entre o mousedown e o mouseup):
  // enquanto o mouse está pressionado o redesenho espera, e sempre roda depois do evento atual.
  let pointerDown = false;
  let renderTimer = null;
  let renderDirty = false;

  function scheduleRender() {
    renderDirty = true;
    if (pointerDown || renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = null; if (!pointerDown && renderDirty) renderNow(); }, 0);
  }

  document.addEventListener('pointerdown', (event) => {
    // os menus "Mais" fecham ao tocar fora deles (pointerdown, não click: nenhum ouvinte de click global na página)
    if (root) for (const menu of root.querySelectorAll('details.more[open]')) if (!menu.contains(event.target)) menu.open = false;
    if (root && root.contains(event.target)) { pointerDown = true; setTimeout(() => { pointerDown = false; if (renderDirty) scheduleRender(); }, 1500); }
  }, true);
  const releasePointer = () => {
    if (!pointerDown) return;
    pointerDown = false;
    if (renderDirty) setTimeout(() => { if (!pointerDown && renderDirty) renderNow(); }, 0);
  };
  document.addEventListener('pointerup', releasePointer, true);
  document.addEventListener('pointercancel', releasePointer, true);

  // ---------- avisos ----------

  /** Aviso com botão "Desfazer" (some sozinho; o botão sai assim que houver uma ação mais nova). */
  function toastUndo(message, group) {
    const host = document.getElementById('toasts');
    if (!host) return;
    let timer = null;
    let off = () => {};
    const remove = () => { clearTimeout(timer); off(); node.remove(); };
    const button = el('button', {
      type: 'button', class: 'toast-action', 'data-focus': 'toast-undo',
      onclick: () => { remove(); doUndo(); }
    }, 'Desfazer');
    const node = el('div', { class: 'toast ok review-toast' }, el('span', { class: 'toast-text' }, message), group ? button : null);
    off = engine.onChange(() => { if (group && engine.topUndoId() !== group.id) button.remove(); });
    timer = setTimeout(remove, 10000);
    host.append(node);
    while (host.children.length > 4) host.firstElementChild.remove();
  }

  /** Resultado de uma ação: mensagem na barra de status e, se pedido, aviso com Desfazer. */
  function announce(result, { toast = false, text } = {}) {
    if (!result || !result.group) return;
    const message = text || `${result.group.label}.`;
    BF.ui.log(message, 'ok');
    if (toast) toastUndo(message, result.group);
  }

  function doUndo() {
    if (!engine) return;
    const res = engine.undo();
    if (!res) { BF.ui.toast('Não há nada para desfazer.'); return; }
    const missing = res.missing ? ` (${plural(res.missing, 'corte não existe mais', 'cortes não existem mais')})` : '';
    BF.ui.log(`Desfeito: ${res.target.label}${missing}.`, 'ok');
  }

  function doRedo() {
    if (!engine) return;
    const res = engine.redo();
    if (!res) { BF.ui.toast('Não há nada para refazer.'); return; }
    BF.ui.log(`Refeito: ${res.target.label}.`, 'ok');
  }

  // ---------- seleção ----------

  function selectCut(id, { seek = true } = {}) {
    const cut = cutById(id);
    if (!cut) return;
    view.active = id;
    view.explicit = true;
    BF.bus.emit('cut:selected', { id });
    if (seek) BF.player.seek(cut.start);
  }

  function togglePick(id, on, shift, visibleIds) {
    if (shift && view.anchor && view.anchor !== id) {
      const a = visibleIds.indexOf(view.anchor);
      const b = visibleIds.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        for (const pid of visibleIds.slice(from, to + 1)) { if (on) view.selected.add(pid); else view.selected.delete(pid); }
        view.anchor = id;
        scheduleRender();
        return;
      }
    }
    if (on) view.selected.add(id); else view.selected.delete(id);
    view.anchor = id;
    scheduleRender();
  }

  // ---------- ações de um corte ----------

  function setStatus(cut, status) {
    const result = engine.setStatus(cut.id, status);
    announce(result);
  }

  function commitTitle(cut, input) {
    const next = input.value.replace(/\s+/g, ' ').trim();
    if (!next) { BF.ui.toast('O título não pode ficar vazio.', 'error'); input.value = cut.title; return; }
    if (next === cut.title && cut.titleCustom === true) return;
    if (next === cut.title && R.titles.isCustomTitle(cut)) return;
    announce(engine.retitle(cut.id, next, { custom: true }));
  }

  async function applySuggestion(cut, text) {
    cut = cutById(cut.id) || cut;
    if (R.titles.isCustomTitle(cut)) {
      const ok = await BF.ui.confirm({
        title: 'Trocar o título?',
        message: `Você escolheu o título “${cut.title}”.\nTrocar por “${text}”? Dá para desfazer.`,
        okLabel: 'Trocar o título'
      });
      if (!ok) return;
    }
    announce(engine.retitle(cut.id, text, { custom: false }));
  }

  function suggestFor(cut) {
    const before = (cut.titleSuggestions || []).length;
    const list = engine.suggestTitles(cut.id, projectContext());
    if (list.length === before) BF.ui.toast('Não há sugestões novas para este corte.');
  }

  function nudge(cut, edge, delta) {
    const res = engine.nudge(cut.id, edge, delta);
    if (!res.ok) { BF.ui.toast(res.reason, 'error'); return; }
    if (res.clamped) BF.ui.log(`${edge === 'start' ? 'Início' : 'Fim'} do corte limitado ao máximo possível.`);
    else if (res.result && res.result.group) BF.ui.log(`${res.result.group.label}.`, 'ok');
    if (res.ok) BF.player.seek(edge === 'start' ? res.start : res.end);
    BF.bus.emit('cut:selected', { id: cut.id }); // a barra de marcação do player mostra os tempos novos
  }

  function setEdgeFromPlayhead(cut, edge) {
    const t = Math.round(BF.player.time() * 100) / 100;
    commitEdge(cut, edge, t);
  }

  function commitEdge(cut, edge, value) {
    const res = engine.adjust(cut.id, edge === 'start' ? { start: value } : { end: value });
    if (!res.ok) { BF.ui.toast(res.reason, 'error'); return false; }
    if (res.result && res.result.group) BF.ui.log(`${res.result.group.label}.`, 'ok');
    BF.bus.emit('cut:selected', { id: cut.id });
    return true;
  }

  async function removeCut(cut) {
    const ok = await BF.ui.confirm({
      title: 'Remover corte',
      message: `Remover "${cut.title}" do projeto? Arquivos já exportados não são apagados.`,
      okLabel: 'Remover',
      danger: true
    });
    if (!ok) return;
    const result = engine.remove(cut.id);
    view.selected.delete(cut.id);
    if (view.active === cut.id) view.active = null;
    announce(result, { toast: true });
  }

  // ---------- chips e linhas ----------

  // O tom de cada indicador vem dos componentes da base (.bds-chip-*); as classes .chip.<tipo> continuam para os testes e o CSS da aba.
  const CHIP_TONE = {
    auto: 'bds-chip-accent', manual: 'bds-chip-info', 'reviewed approved': 'bds-chip-ok', 'reviewed rejected': 'bds-chip-bad',
    changed: 'bds-chip-warn', outside: 'bds-chip-bad'
  };

  function chip(text, kind, title) {
    return el('span', { class: `chip bds-chip ${CHIP_TONE[kind] || ''} ${kind}`.replace(/\s+/g, ' '), title: title || undefined }, text);
  }

  function chipsFor(cut, group) {
    const state = R.core.reviewState(cut);
    const chips = [chip(state.origin === 'auto' ? 'Sugerido' : 'Manual', state.origin === 'auto' ? 'auto' : 'manual', state.origin === 'auto' ? 'Sugerido pela análise automática' : 'Marcado por você')];
    if (state.reviewed) {
      const when = cut.reviewedAt ? ` em ${new Date(cut.reviewedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : '';
      chips.push(chip(`Revisado: ${STATUS_TEXT[cut.status]}`, `reviewed ${cut.status}`, `Revisado${when}`));
    }
    if (state.changed) {
      const [rs, re] = state.reviewedRange;
      chips.push(chip('Alterado', 'changed', `O início ou o fim mudou depois da revisão (era ${fmt(rs)} → ${fmt(re)}). Aprove ou rejeite de novo, ou use “Marcar como revisado”, para confirmar.`));
    }
    if (outsideSource(cut)) {
      const duration = (BF.state.info && BF.state.info.duration) || project().source.duration;
      chips.push(chip('Fora da fonte', 'outside', `A fonte foi atualizada e agora termina em ${fmt(duration)}; este corte termina em ${fmt(cut.end)}. Ele foi mantido (nada é apagado): ajuste o tempo ou rejeite. O aviso some em Preferências, em “Dispensar aviso”.`));
    }
    if (group) {
      chips.push(el('button', {
        type: 'button', class: 'chip bds-chip similar', 'data-focus': 'similar',
        title: `Parecido com ${plural(group.members.length - 1, 'outro corte', 'outros cortes')} (${group.reasons.join(', ')}). Clique para ver o grupo.`,
        onclick: () => { view.groupFocus = group.id; scheduleRender(); }
      }, `Semelhante · ${group.members.length}`));
    }
    if (cut.category) chips.push(chip(cut.category, 'category', 'Categoria'));
    // tema do perfil do canal e palavras-chave que a análise por IA sugeriu (ficam no corte quando a sugestão vira corte)
    if (typeof cut.theme === 'string' && cut.theme) chips.push(chip(`Tema: ${cut.theme}`, 'theme', 'Tema do perfil do canal'));
    if (Array.isArray(cut.keywords)) for (const word of cut.keywords.slice(0, 5)) if (typeof word === 'string' && word) chips.push(chip(`#${word}`, 'keyword', 'Palavra-chave sugerida pela IA'));
    return chips;
  }

  function statusButton(label, cut, status, focusKey) {
    const on = cut.status === status;
    return el('button', {
      type: 'button', class: `sm act-${status === 'approved' ? 'approve' : 'reject'}${on ? ' on' : ''}`, 'aria-pressed': String(on), 'data-focus': focusKey,
      onclick: () => setStatus(cut, status)
    }, label);
  }

  function stepButton(cut, edge, delta, label) {
    const name = edge === 'start' ? 'início' : 'fim';
    return el('button', {
      type: 'button', class: 'step', 'data-focus': `step-${edge}-${delta}`, dataset: { edge, delta: String(delta) },
      'aria-label': `${name} ${delta < 0 ? 'antes' : 'depois'} ${R.core.fmtSeconds(Math.abs(delta))}`,
      onclick: () => nudge(cut, edge, delta)
    }, label);
  }

  function edgeRow(cut, edge) {
    const value = edge === 'start' ? cut.start : cut.end;
    const input = el('input', {
      type: 'text', class: 'time-input', size: '7', value: fmt(value), 'data-focus': `time-${edge}`,
      'aria-label': edge === 'start' ? 'Início do corte' : 'Fim do corte'
    });
    input.addEventListener('change', () => {
      const t = parseTime(input.value);
      if (Number.isNaN(t)) { BF.ui.toast('Use o formato m:ss, h:mm:ss ou segundos (ex.: 1:23.5).', 'error'); input.value = fmt(value); return; }
      if (!commitEdge(cut, edge, Math.round(t * 100) / 100)) input.value = fmt(value);
    });
    return el('div', { class: 'edge-row', dataset: { edge } },
      el('span', { class: 'edge-name' }, edge === 'start' ? 'Início' : 'Fim'),
      stepButton(cut, edge, -1, '-1 s'),
      stepButton(cut, edge, -0.1, '-0,1 s'),
      input,
      stepButton(cut, edge, 0.1, '+0,1 s'),
      stepButton(cut, edge, 1, '+1 s'),
      el('button', {
        type: 'button', class: 'step here', 'data-focus': `here-${edge}`, 'aria-label': `Usar a posição atual do player como ${edge === 'start' ? 'início' : 'fim'}`,
        title: 'Usar a posição atual do player', onclick: () => setEdgeFromPlayhead(cut, edge)
      }, icon('my_location')));
  }

  function editorNode(cut) {
    const state = R.core.reviewState(cut);
    const category = el('input', {
      type: 'text', class: 'cut-category', list: 'cutCategories', value: cut.category || '', placeholder: 'Sem categoria',
      'aria-label': 'Categoria do corte', 'data-focus': 'category'
    });
    category.addEventListener('change', () => announce(engine.recategorize(cut.id, category.value)));

    const notes = el('textarea', { class: 'cut-notes', rows: '2', 'aria-label': 'Notas do corte', placeholder: 'Notas', 'data-focus': 'notes' }, cut.notes || '');
    notes.value = cut.notes || '';
    notes.addEventListener('change', () => engine.setNotes(cut.id, notes.value));

    const suggestions = (cut.titleSuggestions || []).map((text) => el('button', {
      type: 'button', class: 'suggestion sm', title: 'Usar este título', 'data-focus': `sug-${text}`,
      onclick: () => applySuggestion(cut, text)
    }, text));
    const custom = R.titles.isCustomTitle(cut);

    const advanced = el('details', { class: 'advanced', open: view.advancedOpen });
    advanced.addEventListener('toggle', () => { view.advancedOpen = advanced.open; });
    advanced.append(
      el('summary', {}, 'Avançado'),
      el('div', { class: 'advanced-body' },
        el('div', { class: 'titles' },
          el('div', { class: 'titles-head' },
            el('span', { class: 'field-name' }, 'Título'),
            custom ? chip('personalizado', 'custom', 'Você escolheu este título: ele nunca é trocado sem a sua confirmação.') : null,
            el('button', { type: 'button', class: 'link', 'data-focus': 'suggest', onclick: () => suggestFor(cut) }, 'Sugerir títulos')),
          suggestions.length ? el('div', { class: 'suggestions' }, suggestions) : null),
        el('label', { class: 'field' }, el('span', { class: 'field-name' }, 'Notas'), notes)));

    return el('div', { class: 'editor' },
      el('div', { class: 'adjust', role: 'group', 'aria-label': 'Ajuste de tempo' },
        el('span', { class: 'field-name' }, 'Ajuste de tempo'),
        edgeRow(cut, 'start'), edgeRow(cut, 'end'),
        el('p', { class: 'muted small adjust-info' },
          `Duração ${R.core.fmtSeconds(cut.end - cut.start)}`,
          state.changed ? ' · alterado desde a revisão ' : '',
          state.changed ? el('button', { type: 'button', class: 'link', 'data-focus': 'mark-reviewed', onclick: () => announce(engine.markReviewed(cut.id)) }, 'Marcar como revisado') : null)),
      el('label', { class: 'field' }, el('span', { class: 'field-name' }, 'Categoria'), category),
      advanced);
  }

  // ---------- miniatura de cada corte ----------
  //
  // Um quadro do vídeo, tirado neste computador pelo mesmo canal da prévia do enquadramento (export:sourceFrame: ffmpeg do sistema, nada de rede).
  // Só as linhas que aparecem na tela (ou quase) pedem o quadro, no máximo 2 pedidos juntos; o resultado fica em memória até outro vídeo abrir,
  // então redesenhar a lista não pede nada de novo. Se o quadro não sai (sem ffmpeg, vídeo que não abre) a linha segue sem a imagem.
  const thumbCache = new Map(); // `${arquivo}|${instante}` -> dataUrl, ou null quando não saiu
  const thumbQueue = [];
  let thumbActive = 0;
  let thumbObserver = null;
  const THUMB_WIDTH = 192;

  const thumbTime = (cut) => Math.round((cut.start + Math.min(2, (cut.end - cut.start) / 2)) * 10) / 10;
  const thumbKeyOf = (cut) => (project() && project().source ? `${project().source.path}|${thumbTime(cut)}` : '');

  function paintThumbs(key) {
    const url = thumbCache.get(key);
    if (!url || !refs.list) return;
    for (const node of refs.list.querySelectorAll('.cut-thumb')) {
      if (node.dataset.key !== key || node.classList.contains('has-image')) continue;
      node.replaceChildren(el('img', { src: url, alt: '', draggable: 'false' }));
      node.classList.add('has-image');
    }
  }

  async function fetchThumb(job) {
    let url = null;
    try {
      const res = await BF.api('export:sourceFrame', { sourcePath: job.path, timeSec: job.time, maxWidth: THUMB_WIDTH });
      url = res && res.ok && res.dataUrl ? res.dataUrl : null;
    } catch { url = null; }
    thumbCache.set(job.key, url);
    paintThumbs(job.key);
  }

  function pumpThumbs() {
    while (thumbActive < 2 && thumbQueue.length) {
      const job = thumbQueue.shift();
      thumbActive += 1;
      fetchThumb(job).finally(() => { thumbActive -= 1; pumpThumbs(); });
    }
  }

  function wantThumb(node) {
    const key = node.dataset.key;
    const cut = cutById(node.closest('[data-id]') && node.closest('[data-id]').dataset.id);
    if (!key || !cut || !project() || thumbCache.has(key) || thumbQueue.some((job) => job.key === key)) return;
    thumbQueue.push({ key, path: project().source.path, time: thumbTime(cut) });
    pumpThumbs();
  }

  /** O ancestral que rola (o painel da aba): é ele quem esconde as linhas de baixo. */
  function scrollParentOf(node) {
    for (let n = node.parentElement; n; n = n.parentElement) {
      const overflow = window.getComputedStyle(n).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') return n;
    }
    return null;
  }

  function watchThumbs() {
    const nodes = [...refs.list.querySelectorAll('.cut-thumb:not(.has-image)')];
    if (typeof IntersectionObserver !== 'function') { nodes.forEach(wantThumb); return; }
    if (thumbObserver) thumbObserver.disconnect();
    thumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        thumbObserver.unobserve(entry.target);
        wantThumb(entry.target);
      }
    }, { root: scrollParentOf(refs.list), rootMargin: '240px' });
    for (const node of nodes) thumbObserver.observe(node);
  }

  function thumbNode(cut) {
    const key = thumbKeyOf(cut);
    const node = el('div', { class: 'cut-thumb', 'aria-hidden': 'true', dataset: { key } }, icon('movie'));
    if (thumbCache.get(key)) {
      node.replaceChildren(el('img', { src: thumbCache.get(key), alt: '', draggable: 'false' }));
      node.classList.add('has-image');
    }
    return node;
  }

  function rowNode(cut, ctx, { grouped = false } = {}) {
    const state = R.core.reviewState(cut);
    const group = ctx.groupByCut.get(cut.id);
    const picked = view.selected.has(cut.id);
    const exported = R.core.exportState(cut);
    const length = cut.end - cut.start;
    const title = el('input', { type: 'text', class: 'cut-title', value: cut.title, 'aria-label': 'Título do corte', 'data-focus': 'title' });
    title.addEventListener('change', () => commitTitle(cut, title));
    // entrar no campo (mouse ou Tab) abre o corte para ajuste, sem mexer no player: é o caminho do teclado
    title.addEventListener('focus', () => { if (view.active !== cut.id) selectCut(cut.id, { seek: false }); });
    const pick = el('input', {
      type: 'checkbox', class: 'cut-pick', checked: picked, 'aria-label': `Selecionar o corte “${cut.title}”`, 'data-focus': 'pick'
    });
    pick.addEventListener('click', (event) => togglePick(cut.id, pick.checked, event.shiftKey, ctx.visibleIds));

    const li = el('li', {
      class: `cut ${cut.status}${cut.id === view.active && view.explicit ? ' selected' : ''}${picked ? ' picked' : ''}${grouped ? ' in-group' : ''}`,
      dataset: {
        id: cut.id, open: String(cut.id === view.active), origin: state.origin, reviewed: String(state.reviewed), changed: String(state.changed),
        similar: String(Boolean(group)), custom: String(R.titles.isCustomTitle(cut)),
        ...(group ? { group: String(ctx.groups.indexOf(group) % 6) } : {})
      }
    },
    title,
    el('label', { class: 'pick' }, pick),
    thumbNode(cut),
    el('div', { class: 'times' },
      `${fmt(cut.start)} → ${fmt(cut.end)} (${secs(length)})`,
      R.core.isNum(cut.relevance) ? ` · relevância ${Math.round(cut.relevance * 100)}%` : ''),
    el('div', { class: 'chips' }, chipsFor(cut, group)),
    el('div', { class: 'actions' },
      el('button', {
        type: 'button', class: 'sm act-view', 'data-focus': 'view',
        onclick: () => { view.active = cut.id; BF.bus.emit('cut:selected', { id: cut.id }); BF.player.playRange(cut.start, cut.end); }
      }, 'Ver'),
      statusButton('Aprovar', cut, 'approved', 'approve'),
      statusButton('Rejeitar', cut, 'rejected', 'reject'),
      el('details', { class: 'more' },
        el('summary', { class: 'more-icon', 'aria-label': 'Mais ações', title: 'Mais ações' }, el('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true' }, 'more_horiz')),
        el('div', { class: 'more-actions' },
          el('button', { type: 'button', class: 'sm', 'data-focus': 'reset', disabled: cut.status === 'pending', onclick: () => setStatus(cut, 'pending') }, 'Redefinir'),
          el('button', { type: 'button', class: 'sm danger-text', 'data-focus': 'remove', onclick: () => removeCut(cut) }, 'Remover')))),
    exported.last ? exportedNode(cut, exported) : null,
    cut.id === view.active ? editorNode(cut) : null);

    li.addEventListener('click', (event) => {
      if (event.target.closest('button, input, textarea, select, summary, a, label, details')) return;
      selectCut(cut.id);
    });
    return li;
  }

  /** Linha "Exportado": se o início ou o fim mudou depois da exportação, o arquivo não reflete o corte de agora e a linha diz isso. */
  function exportedNode(cut, { last, stale }) {
    const hasTimes = R.core.isNum(last.start) && R.core.isNum(last.end);
    const staleTitle = `O arquivo foi exportado${hasTimes ? ` com o corte em ${fmt(last.start)} → ${fmt(last.end)}` : ' antes de o início ou o fim mudar'}; agora ele está em ${fmt(cut.start)} → ${fmt(cut.end)}. Exporte de novo para o arquivo refletir o corte atual. Clique para mostrar o arquivo na pasta.`;
    return el('button', {
      type: 'button', class: `link exported${stale ? ' stale' : ''}`, dataset: { stale: String(stale) }, title: stale ? staleTitle : 'Mostrar na pasta',
      onclick: () => BF.api('shell:reveal', { path: last.path })
    }, stale ? `Exportado (corte alterado depois): ${last.path}` : `Exportado: ${last.path}`);
  }

  function groupHead(group, ctx) {
    const cutsById = new Map(ctx.all.map((c) => [c.id, c]));
    return el('li', { class: 'group-head', dataset: { group: String(ctx.groups.indexOf(group) % 6), groupId: group.id } },
      el('span', { class: 'group-title' },
        `${plural(group.members.length, 'corte parecido', 'cortes parecidos')} · ${group.reasons.join(', ')}`,
        group.resolved ? chip('resolvido', 'resolved', 'No máximo um corte do grupo não está rejeitado.') : null),
      el('button', { type: 'button', class: 'sm', 'data-focus': `keep-${group.id}`, onclick: () => openKeepOne(group, cutsById) }, 'Manter um…'));
  }

  // ---------- desenho ----------

  function computeView() {
    const all = allCuts();
    const groups = R.similarity.findGroups(all);
    const groupByCut = R.similarity.indexGroups(groups);
    const similarIds = new Set(groupByCut.keys());
    let list = R.order.filterCuts(all, view.filters, { similarIds });
    if (view.groupFocus) {
      const focus = groups.find((g) => g.id === view.groupFocus);
      if (focus) list = list.filter((c) => focus.members.includes(c.id));
      else view.groupFocus = null;
    }
    list = R.order.sortCuts(list, view.sort);
    // sempre há um corte aberto com o ajuste de tempo à vista (o primeiro, até o usuário escolher outro)
    if (!view.active || !all.some((c) => c.id === view.active)) {
      view.active = list.length ? list[0].id : (all.length ? all[0].id : null);
      view.explicit = false;
    }
    return { all, groups, groupByCut, list, visibleIds: list.map((c) => c.id) };
  }

  function renderList(ctx) {
    const nodes = [];
    if (view.groupFocus || view.filters.similar) {
      const seen = new Set();
      for (const cut of ctx.list) {
        const group = ctx.groupByCut.get(cut.id);
        if (!group) { nodes.push(rowNode(cut, ctx)); continue; }
        if (seen.has(group.id)) continue;
        seen.add(group.id);
        nodes.push(groupHead(group, ctx));
        for (const member of ctx.list.filter((c) => ctx.groupByCut.get(c.id) === group)) nodes.push(rowNode(member, ctx, { grouped: true }));
      }
    } else {
      for (const cut of ctx.list) nodes.push(rowNode(cut, ctx));
    }
    refs.list.replaceChildren(...nodes);
    watchThumbs();
  }

  function updateChrome(ctx) {
    const counts = R.order.countByStatus(ctx.all);
    for (const [state, button] of Object.entries(refs.stateChips)) {
      const on = view.filters.status === state;
      button.setAttribute('aria-pressed', String(on));
      button.classList.toggle('on', on);
      button.querySelector('.count').textContent = String(counts[state]);
    }
    refs.sort.value = view.sort;
    const hasTimeline = Boolean(BF.review.timeline && typeof BF.review.timeline.toggle === 'function');
    refs.timeline.disabled = !hasTimeline;
    refs.timeline.title = hasTimeline ? 'Mostrar ou ocultar a timeline detalhada (forma de onda) abaixo do player' : 'A timeline não carregou nesta janela';
    refs.undo.disabled = !engine.canUndo();
    refs.redo.disabled = !engine.canRedo();
    refs.undo.title = engine.canUndo() ? `Desfazer: ${engine.undoLabel()} (Ctrl+Z)` : 'Nada para desfazer';
    refs.redo.title = engine.canRedo() ? `Refazer: ${engine.redoLabel()} (Ctrl+Y)` : 'Nada para refazer';

    // filtros
    const categories = R.order.categoriesIn(ctx.all);
    const wanted = view.filters.category;
    refs.filterCategory.replaceChildren(
      el('option', { value: '' }, 'Todas as categorias'),
      el('option', { value: R.order.NO_CATEGORY }, 'Sem categoria'),
      ...categories.map((name) => el('option', { value: name }, name)));
    refs.filterCategory.value = [...refs.filterCategory.options].some((o) => o.value === wanted) ? wanted : '';
    refs.filterOrigin.value = view.filters.origin;
    refs.filterChanged.checked = view.filters.changed;
    refs.filterSimilar.checked = view.filters.similar;
    const extra = R.order.activeExtraFilters(view.filters);
    refs.filtersSummary.textContent = extra ? `Mais filtros (${extra})` : 'Mais filtros';
    refs.filterClear.hidden = !(extra || view.filters.status !== 'all');
    refs.filterChanged.parentElement.querySelector('.count').textContent = String(ctx.all.filter((c) => R.core.reviewState(c).changed).length);
    refs.filterSimilar.parentElement.querySelector('.count').textContent = String(ctx.groupByCut.size);

    // categorias sugeridas
    refs.datalist.replaceChildren(...knownCategories().map((name) => el('option', { value: name })));

    // grupo em foco
    const focus = view.groupFocus ? ctx.groups.find((g) => g.id === view.groupFocus) : null;
    refs.banner.hidden = !focus;
    if (focus) {
      const cutsById = new Map(ctx.all.map((c) => [c.id, c]));
      refs.banner.replaceChildren(
        el('span', {}, `Grupo de ${plural(focus.members.length, 'corte parecido', 'cortes parecidos')}: ${focus.reasons.join(', ')}.`),
        el('button', { type: 'button', class: 'sm', 'data-focus': 'banner-keep', onclick: () => openKeepOne(focus, cutsById) }, 'Manter um…'),
        el('button', { type: 'button', class: 'link', 'data-focus': 'banner-clear', onclick: () => { view.groupFocus = null; scheduleRender(); } }, 'Mostrar todos'));
    }

    // seleção em lote
    const visible = new Set(ctx.visibleIds);
    for (const id of [...view.selected]) if (!ctx.all.some((c) => c.id === id)) view.selected.delete(id);
    const picked = [...view.selected];
    const hidden = picked.filter((id) => !visible.has(id)).length;
    const visiblePicked = picked.length - hidden;
    refs.selectAll.checked = ctx.visibleIds.length > 0 && visiblePicked === ctx.visibleIds.length;
    refs.selectAll.indeterminate = visiblePicked > 0 && visiblePicked < ctx.visibleIds.length;
    refs.selectAll.disabled = ctx.visibleIds.length === 0;
    refs.selectAllText.textContent = `Selecionar ${view.filters.status === 'all' && !R.order.activeExtraFilters(view.filters) && !view.groupFocus ? 'todos' : 'os filtrados'} (${ctx.visibleIds.length})`;
    refs.selbar.hidden = picked.length === 0;
    refs.selCount.textContent = `${plural(picked.length, 'selecionado', 'selecionados')}${hidden ? ` (${hidden} fora do filtro)` : ''}`;

    refs.empty.hidden = ctx.all.length > 0;
    refs.noMatch.hidden = !(ctx.all.length > 0 && ctx.list.length === 0);
    // sem nenhum corte não há o que filtrar, ordenar ou selecionar: só o estado vazio (e a timeline, que continua útil)
    const none = ctx.all.length === 0;
    refs.statusTabs.hidden = none;
    refs.sort.hidden = none;
    refs.filters.hidden = none;
    refs.selectRow.hidden = none;
  }

  function renderPreview() {
    const open = Boolean(view.preview);
    refs.preview.hidden = !open;
    refs.main.hidden = open;
    if (!open) return;
    const { spec } = view.preview;
    const plan = spec.build();
    view.preview.plan = plan;
    const items = plan.items;
    refs.previewTitle.textContent = `Prévia: ${plan.label}`;
    refs.previewIntro.textContent = spec.intro || '';
    refs.previewIntro.hidden = !spec.intro;
    const c = plan.counts;
    refs.previewSummary.textContent = plan.error
      ? plan.error
      : [`${plural(c.changed, 'corte muda', 'cortes mudam')}`, c.unchanged ? `${c.unchanged} sem mudança` : '', c.invalid ? `${c.invalid} não pode(m) ser aplicado(s)` : ''].filter(Boolean).join(' · ');
    refs.previewSummary.classList.toggle('error', Boolean(plan.error));
    refs.previewList.replaceChildren(...items.map((item) => {
      const d = R.batch.describe(item);
      return el('li', { class: `preview-item ${item.invalid ? 'invalid' : item.changed ? 'changed' : 'same'}`, dataset: { id: item.cutId } },
        el('strong', { class: 'preview-name' }, item.cutTitle),
        el('span', { class: 'preview-change' }, el('span', { class: 'from' }, d.from), ' → ', el('span', { class: 'to' }, d.to)),
        item.note ? el('small', { class: 'preview-note' }, item.note) : null);
    }));
    const apply = c.changed;
    refs.previewConfirm.textContent = spec.confirmLabel ? spec.confirmLabel(apply) : `Aplicar a ${plural(apply, 'corte', 'cortes')}`;
    refs.previewConfirm.disabled = Boolean(plan.error) || apply === 0;
    refs.previewConfirm.className = spec.danger ? 'danger' : 'primary';
  }

  function renderHistory() {
    const groups = engine.groups();
    refs.historySummary.textContent = groups.length ? `Histórico (${groups.length})` : 'Histórico';
    if (!refs.history.open) return;
    const shown = [...groups].reverse().slice(0, view.historyShown);
    refs.historyNote.hidden = !view.droppedHistory;
    refs.historyNote.textContent = view.droppedHistory ? `${plural(view.droppedHistory, 'registro mais antigo foi resumido', 'registros mais antigos foram resumidos')} para o arquivo não crescer sem limite.` : '';
    refs.historyEmpty.hidden = groups.length > 0;
    refs.historyList.replaceChildren(...shown.map((g) => {
      const when = g.at ? new Date(g.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }) : '';
      return el('li', { class: `history-item ${g.source}`, dataset: { group: g.id } },
        el('div', { class: 'history-text' },
          el('span', { class: 'history-label' }, g.label),
          SOURCE_TAG[g.source] ? chip(SOURCE_TAG[g.source], 'tag') : null,
          el('small', { class: 'muted' }, `${when} · ${plural(g.items.length, 'corte', 'cortes')}`)),
        el('button', {
          type: 'button', 'data-focus': `restore-${g.id}`, title: 'Voltar ao estado de antes desta ação (com prévia; dá para desfazer)',
          onclick: (event) => openRestore(g, event.currentTarget)
        }, 'Restaurar'));
    }));
    refs.historyMore.hidden = groups.length <= view.historyShown;
  }

  function renderNow() {
    if (!started || !root) { renderDirty = false; return; }
    const editing = editedField();
    if (editing) { renderDirty = true; renderAfterEdit(editing); return; } // não refaz a lista debaixo de quem está digitando
    renderDirty = false;
    const focus = captureFocus();
    const scroller = root.parentElement;
    const top = scroller ? scroller.scrollTop : 0;
    const ctx = computeView();
    updateChrome(ctx);
    renderList(ctx);
    renderPreview();
    renderHistory();
    BF.ui.refreshTabs();
    if (scroller) scroller.scrollTop = top;
    restoreFocus(focus);
  }

  // ---------- prévia e confirmação ----------

  function openPreview(spec, opener) {
    view.preview = { spec, plan: null, opener: opener || document.activeElement };
    refs.previewControls.replaceChildren(...(spec.controls || []));
    renderPreview();
    refs.preview.scrollIntoView({ block: 'nearest' });
    (spec.danger ? refs.previewCancel : refs.previewConfirm.disabled ? refs.previewCancel : refs.previewConfirm).focus();
  }

  function closePreview({ restore = true } = {}) {
    if (!view.preview) return;
    const { opener } = view.preview;
    view.preview = null;
    renderNow();
    if (restore && opener && opener.isConnected) opener.focus({ preventScroll: true });
  }

  function confirmPreview() {
    if (!view.preview) return;
    const { spec, plan } = view.preview;
    if (!plan || plan.error) return;
    const result = spec.apply(plan);
    view.preview = null;
    renderNow();
    if (result && result.group) {
      const message = `${result.group.label}.${result.missing ? ` ${plural(result.missing, 'corte não existe mais', 'cortes não existem mais')}.` : ''}`;
      BF.ui.log(message, 'ok');
      toastUndo(message, result.group);
    } else {
      BF.ui.toast('Nada mudou.');
    }
  }

  const batchApply = (plan) => engine.commitPlan(plan);

  function openBatch(op, extra = {}, opener) {
    const ids = [...view.selected];
    openPreview({ build: () => engine.plan(op, ids), apply: batchApply, ...extra }, opener);
  }

  function numberField(label, hint) {
    const input = el('input', { type: 'text', inputmode: 'decimal', value: '0', size: '6', class: 'num-input', 'aria-label': label });
    return { input, node: el('label', { class: 'field inline' }, el('span', { class: 'field-name' }, label), input, hint ? el('small', { class: 'muted' }, hint) : null) };
  }

  function openShift(opener) {
    const start = numberField('Início (s)');
    const end = numberField('Fim (s)');
    const parse = (input) => { const t = input.value.trim().replace(',', '.'); return t === '' ? 0 : Number(t); };
    const spec = {
      intro: 'Some segundos ao início e ao fim de cada corte selecionado. Use valores negativos para adiantar (ex.: -0,5). O tempo fica dentro do vídeo; o que ficaria inválido é avisado e não é aplicado.',
      controls: [start.node, end.node],
      build: () => engine.plan('shift', [...view.selected], { startDelta: parse(start.input), endDelta: parse(end.input) }),
      apply: batchApply
    };
    for (const f of [start, end]) f.input.addEventListener('input', renderPreview);
    openPreview(spec, opener);
    start.input.focus();
    start.input.select();
  }

  function openCategorize(opener) {
    const input = el('input', { type: 'text', list: 'cutCategories', class: 'cut-category', placeholder: 'Deixe vazio para limpar', 'aria-label': 'Categoria' });
    input.addEventListener('input', renderPreview);
    openPreview({
      intro: 'A categoria é livre: escreva uma nova ou escolha uma das sugeridas.',
      controls: [el('label', { class: 'field inline' }, el('span', { class: 'field-name' }, 'Categoria'), input)],
      build: () => engine.plan('categorize', [...view.selected], { category: input.value }),
      apply: batchApply
    }, opener);
    input.focus();
  }

  function openKeepOne(group, cutsById, opener) {
    const members = group.members.map((id) => cutsById.get(id)).filter(Boolean);
    const best = R.similarity.bestToKeep(group, cutsById);
    let keepId = best;
    const approve = el('input', { type: 'checkbox', id: 'keepApprove' });
    approve.addEventListener('change', renderPreview);
    const radios = members.map((cut) => {
      const radio = el('input', { type: 'radio', name: 'keepOne', value: cut.id, checked: cut.id === best });
      radio.addEventListener('change', () => { keepId = cut.id; renderPreview(); });
      return el('label', { class: 'keep-choice' }, radio,
        el('span', {}, el('strong', {}, cut.title), ` · ${fmt(cut.start)} → ${fmt(cut.end)}${R.core.isNum(cut.relevance) ? ` · ${Math.round(cut.relevance * 100)}%` : ''}`));
    });
    openPreview({
      intro: 'Os outros cortes do grupo serão rejeitados (continuam no projeto e dá para voltar atrás).',
      controls: [
        el('fieldset', { class: 'keep-choices' }, el('legend', {}, 'Qual corte manter?'), radios),
        el('label', { class: 'keep-approve' }, approve, ' Também aprovar o corte mantido')],
      build: () => engine.plan('keepOne', group.members, { keepId, approveKept: approve.checked }),
      apply: batchApply,
      confirmLabel: (n) => `Rejeitar ${plural(n, 'corte', 'cortes')}`
    }, opener);
  }

  function openRestore(group, opener) {
    const plan = engine.planRestore(group.id);
    if (!plan || !plan.items.length) {
      BF.ui.toast('Nada a restaurar: o projeto já está igual ao que era antes desta ação.');
      return;
    }
    openPreview({
      intro: 'Desfaz esta ação e todas as que vieram depois. A restauração fica registrada no histórico e pode ser desfeita.',
      build: () => engine.planRestore(group.id),
      apply: (p) => engine.restore(p),
      confirmLabel: () => 'Restaurar'
    }, opener);
  }

  // ---------- histórico em disco ----------

  const persist = { pending: new Map(), timer: null, chain: Promise.resolve(), warned: false };

  function queueGroup(projectId, group) {
    if (!persist.pending.has(projectId)) persist.pending.set(projectId, []);
    persist.pending.get(projectId).push(group);
    clearTimeout(persist.timer);
    persist.timer = setTimeout(flushHistory, 150);
  }

  /** Grava o que estiver na fila (resolve quando terminar). Falha vira aviso: as decisões já estão no projeto. */
  function flushHistory() {
    clearTimeout(persist.timer);
    const batches = [...persist.pending.entries()];
    persist.pending.clear();
    for (const [projectId, groups] of batches) {
      persist.chain = persist.chain.then(async () => {
        const res = await BF.api('review:historyAppend', { projectId, groups });
        if (res.ok) {
          view.droppedHistory = res.dropped || 0;
          return;
        }
        persist.pending.set(projectId, [...groups, ...(persist.pending.get(projectId) || [])]); // tenta de novo na próxima ação
        if (!persist.warned) {
          persist.warned = true;
          BF.ui.toast(`Não foi possível gravar o histórico: ${res.message} As decisões continuam salvas no projeto; o histórico será gravado quando for possível.`, 'error', 12000);
        }
      });
    }
    return persist.chain;
  }

  async function loadHistory(projectId) {
    const res = await BF.api('review:historyLoad', { projectId });
    if (!res.ok) {
      BF.ui.toast(`Não foi possível ler o histórico deste vídeo: ${res.message} O histórico novo continua sendo gravado.`, 'error', 10000);
      return;
    }
    if (engine.loadGroups(res.groups, projectId)) {
      view.droppedHistory = res.dropped || 0;
      if (res.recovered) BF.ui.toast('O arquivo de histórico estava ilegível e foi guardado como cópia (.corrupt); o histórico recomeçou.', 'error', 10000);
      scheduleRender();
    }
  }

  // ---------- montagem ----------

  function chipButton(state, label) {
    return el('button', {
      type: 'button', class: 'bds-tab state-chip', dataset: { state }, 'aria-pressed': 'false', 'data-focus': `state-${state}`,
      onclick: () => { view.filters.status = state; scheduleRender(); }
    }, label, ' ', el('span', { class: 'count' }, '0'));
  }

  function checkboxField(text, onChange, focusKey) {
    const input = el('input', { type: 'checkbox', 'data-focus': focusKey });
    input.addEventListener('change', () => onChange(input.checked));
    return { input, node: el('label', { class: 'check' }, input, ' ', text, ' ', el('span', { class: 'count muted' }, '0')) };
  }

  function selectBarButton(label, onClick, focusKey, cls) {
    return el('button', { type: 'button', class: `sm ${cls || ''}`.trim(), 'data-focus': focusKey, onclick: (event) => onClick(event.currentTarget) }, label);
  }

  const icon = (name) => el('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true' }, name);

  function build(container) {
    root = container;
    root.classList.add('cuts-tab');

    refs.stateChips = {
      all: chipButton('all', 'Todos'), pending: chipButton('pending', 'Pendentes'),
      approved: chipButton('approved', 'Aprovados'), rejected: chipButton('rejected', 'Rejeitados')
    };
    refs.statusTabs = el('div', { class: 'bds-tabs state-chips', role: 'group', 'aria-label': 'Filtrar por estado' }, Object.values(refs.stateChips));
    refs.sort = el('select', { class: 'sort', 'aria-label': 'Ordem da lista', 'data-focus': 'sort' },
      el('option', { value: 'chrono' }, 'Ordem da live'), el('option', { value: 'relevance' }, 'Por relevância'));
    refs.sort.addEventListener('change', () => { view.sort = R.order.normalizeSort(refs.sort.value); scheduleRender(); });
    refs.timeline = el('button', { type: 'button', class: 'sm tl-toggle', 'aria-pressed': 'false', 'data-focus': 'timeline', onclick: toggleTimeline }, icon('graphic_eq'), 'Timeline');
    refs.undo = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Desfazer', 'data-focus': 'undo', onclick: doUndo, disabled: true }, icon('undo'));
    refs.redo = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Refazer', 'data-focus': 'redo', onclick: doRedo, disabled: true }, icon('redo'));

    refs.filterCategory = el('select', { 'aria-label': 'Categoria', 'data-focus': 'f-category' });
    refs.filterCategory.addEventListener('change', () => { view.filters.category = refs.filterCategory.value; scheduleRender(); });
    refs.filterOrigin = el('select', { 'aria-label': 'Origem', 'data-focus': 'f-origin' },
      el('option', { value: 'all' }, 'Sugeridos e manuais'), el('option', { value: 'auto' }, 'Só sugeridos'), el('option', { value: 'manual' }, 'Só manuais'));
    refs.filterOrigin.addEventListener('change', () => { view.filters.origin = refs.filterOrigin.value; scheduleRender(); });
    const changed = checkboxField('Alterados desde a revisão', (on) => { view.filters.changed = on; scheduleRender(); }, 'f-changed');
    const similar = checkboxField('Semelhantes (agrupados)', (on) => { view.filters.similar = on; if (!on) view.groupFocus = null; scheduleRender(); }, 'f-similar');
    refs.filterChanged = changed.input;
    refs.filterSimilar = similar.input;
    const clearFilters = () => { view.filters = { ...R.order.DEFAULT_FILTERS }; view.groupFocus = null; scheduleRender(); };
    refs.filterClear = el('button', { type: 'button', class: 'link small', 'data-focus': 'f-clear', onclick: clearFilters }, 'Limpar filtros');
    refs.filtersSummary = el('summary', {}, 'Mais filtros');
    refs.filtersBox = el('details', { class: 'filters' },
      refs.filtersSummary,
      el('div', { class: 'filters-grid' }, refs.filterCategory, refs.filterOrigin, changed.node, similar.node));
    refs.filters = el('div', { class: 'filters-row' }, refs.filtersBox, refs.filterClear);

    refs.banner = el('div', { class: 'group-banner', hidden: true });

    refs.selectAll = el('input', { type: 'checkbox', 'data-focus': 'select-all' });
    refs.selectAll.addEventListener('change', () => {
      const ctx = computeView();
      for (const id of ctx.visibleIds) { if (refs.selectAll.checked) view.selected.add(id); else view.selected.delete(id); }
      scheduleRender();
    });
    refs.selectAllText = el('span', {}, 'Selecionar todos');
    refs.selectRow = el('label', { class: 'selectall check' }, refs.selectAll, ' ', refs.selectAllText);
    refs.selCount = el('strong', { class: 'sel-count' });
    refs.selbar = el('div', { class: 'selbar', role: 'toolbar', 'aria-label': 'Ações em lote', hidden: true },
      el('div', { class: 'sel-info' }, refs.selCount,
        selectBarButton('Limpar', () => { view.selected.clear(); view.anchor = null; scheduleRender(); }, 'batch-clear', 'link')),
      selectBarButton('Aprovar', (b) => openBatch('approve', {}, b), 'batch-approve', 'primary'),
      selectBarButton('Rejeitar', (b) => openBatch('reject', {}, b), 'batch-reject'),
      el('details', { class: 'more' },
        el('summary', { class: 'more-text' }, 'Mais'),
        el('div', { class: 'more-actions' },
          selectBarButton('Redefinir', (b) => openBatch('reset', {}, b), 'batch-reset'),
          selectBarButton('Categorizar…', openCategorize, 'batch-categorize'),
          selectBarButton('Deslocar tempos…', openShift, 'batch-shift'),
          selectBarButton('Remover…', (b) => openBatch('remove', { danger: true, intro: 'Os cortes saem do projeto (arquivos já exportados não são apagados). Dá para desfazer.', confirmLabel: (n) => `Remover ${plural(n, 'corte', 'cortes')}` }, b), 'batch-remove', 'danger-text'))));

    refs.list = el('ul', { id: 'cuts', class: 'cuts' });
    refs.empty = el('div', { id: 'noCuts', class: 'empty-state center' },
      el('span', { class: 'empty-state-icon material-symbols-rounded', 'aria-hidden': 'true' }, 'content_cut'),
      el('div', { class: 'empty-state-text' },
        el('strong', {}, 'Nenhum corte ainda'),
        el('p', {}, 'Marque início e fim no player e clique em “Salvar corte”.')));
    refs.noMatch = el('div', { class: 'empty-state center', hidden: true },
      el('span', { class: 'empty-state-icon material-symbols-rounded', 'aria-hidden': 'true' }, 'filter_alt_off'),
      el('div', { class: 'empty-state-text' },
        el('strong', {}, 'Nenhum corte combina com os filtros'),
        el('p', {}, el('button', { type: 'button', class: 'link', 'data-focus': 'f-clear-empty', onclick: clearFilters }, 'Limpar filtros'))));
    refs.datalist = el('datalist', { id: 'cutCategories' });

    refs.main = el('div', { class: 'cuts-main' },
      refs.statusTabs,
      el('div', { class: 'toolbar' }, refs.sort, el('div', { class: 'toolbar-end' }, refs.timeline, refs.undo, refs.redo)),
      refs.filters,
      refs.selectRow,
      refs.banner,
      refs.selbar,
      refs.list, refs.empty, refs.noMatch);

    // prévia (substitui a lista enquanto aberta)
    refs.previewTitle = el('h3', { id: 'cutsPreviewTitle', tabindex: '-1' });
    refs.previewIntro = el('p', { class: 'muted small', hidden: true });
    refs.previewControls = el('div', { class: 'preview-controls' });
    refs.previewSummary = el('p', { class: 'preview-summary' });
    refs.previewList = el('ul', { class: 'preview-list' });
    refs.previewCancel = el('button', { type: 'button', 'data-focus': 'preview-cancel', onclick: () => closePreview() }, 'Cancelar');
    refs.previewConfirm = el('button', { type: 'button', class: 'primary', 'data-focus': 'preview-confirm', onclick: confirmPreview }, 'Aplicar');
    refs.preview = el('section', { class: 'preview', role: 'region', 'aria-labelledby': 'cutsPreviewTitle', hidden: true },
      refs.previewTitle, refs.previewIntro, refs.previewControls, refs.previewSummary, refs.previewList,
      el('div', { class: 'preview-actions' }, refs.previewCancel, refs.previewConfirm));
    refs.preview.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePreview(); }
    });

    // histórico
    refs.historySummary = el('summary', {}, 'Histórico');
    refs.historyNote = el('p', { class: 'muted small', hidden: true });
    refs.historyEmpty = el('p', { class: 'muted small' }, 'Nenhuma decisão registrada ainda.');
    refs.historyList = el('ul', { class: 'history-list' });
    refs.historyMore = el('button', { type: 'button', class: 'link', hidden: true, onclick: () => { view.historyShown += HISTORY_PAGE; renderHistory(); } }, 'Mostrar mais antigos');
    refs.history = el('details', { class: 'history' }, refs.historySummary, refs.historyNote, refs.historyEmpty, refs.historyList, refs.historyMore);
    refs.history.addEventListener('toggle', renderHistory);

    refs.shortcuts = el('details', { class: 'shortcuts' },
      el('summary', {}, 'Atalhos do teclado'),
      el('ul', {},
        el('li', {}, el('kbd', {}, 'I'), ' / ', el('kbd', {}, 'O'), ': marcam início e fim na barra do player.'),
        el('li', {}, el('kbd', {}, 'Espaço'), ': toca ou pausa (com o foco fora de campos e botões).'),
        el('li', {}, el('kbd', {}, 'Ctrl+Z'), ' / ', el('kbd', {}, 'Ctrl+Y'), ': na aba Cortes, desfaz e refaz a última decisão.'),
        el('li', {}, 'Na timeline: arraste as bordas dos cortes; clique para posicionar; Ctrl + roda para o zoom.')));

    refs.loading = el('p', { class: 'muted' }, 'Carregando a central de revisão…');
    root.append(refs.loading, refs.main, refs.preview, refs.history, refs.shortcuts, refs.datalist);
    refs.main.hidden = true;
    refs.history.hidden = true;
    refs.shortcuts.hidden = true;
  }

  // ---------- timeline (botão) ----------

  function toggleTimeline() {
    const timeline = BF.review.timeline;
    if (timeline && typeof timeline.toggle === 'function') timeline.toggle();
  }

  BF.bus.on('review:timeline', ({ open }) => {
    if (!refs.timeline) return;
    refs.timeline.setAttribute('aria-pressed', String(Boolean(open)));
    refs.timeline.classList.toggle('on', Boolean(open));
  });

  // ---------- teclado ----------

  const TEXT_ENTRY = 'input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, select, [contenteditable=""], [contenteditable="true"]';
  const INTERACTIVE = 'button, a[href], input, textarea, select, summary, video, [role=button], [role=slider], [tabindex]';

  /** A aba Cortes está à vista? (o painel das abas escondidas fica hidden) */
  function tabIsShown() {
    const panel = root && root.closest('[role=tabpanel]');
    return Boolean(panel) && !panel.hidden;
  }

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || !engine || !project() || !started) return;
    if (document.querySelector('.bf-modal')) return;
    const target = event.target instanceof Element ? event.target : document.body;
    const typing = Boolean(target.closest(TEXT_ENTRY));
    const key = event.key;
    const mod = event.ctrlKey || event.metaKey;

    if (mod && !event.altKey && (key === 'z' || key === 'Z' || key === 'y' || key === 'Y')) {
      if (typing) return; // dentro de um campo vale o desfazer do próprio campo
      if (!tabIsShown()) return; // nas outras abas (Áudio, Legendas…) o Ctrl+Z é do desfazer da própria aba, não das decisões da revisão
      event.preventDefault();
      if (key.toLowerCase() === 'y' || event.shiftKey) doRedo(); else doUndo();
      return;
    }
    if (mod || event.altKey || typing) return;
    if (key === 'i' || key === 'I' || key === 'o' || key === 'O') {
      const button = document.getElementById(key.toLowerCase() === 'i' ? 'btnMarkIn' : 'btnMarkOut');
      if (!button || button.disabled) return;
      event.preventDefault();
      button.click();
      BF.ui.log(`${key.toLowerCase() === 'i' ? 'Início' : 'Fim'} marcado em ${fmt(BF.player.time())}.`, 'ok');
    } else if (key === ' ' && !target.closest(INTERACTIVE)) {
      event.preventDefault();
      const video = BF.player.video;
      if (video.paused) { const p = video.play(); if (p && p.catch) p.catch(() => {}); } else BF.player.pause();
    }
  });

  // ---------- início ----------

  function resetForProject(p) {
    thumbCache.clear();
    thumbQueue.length = 0;
    view.filters = { ...R.order.DEFAULT_FILTERS };
    view.sort = defaultSort();
    view.selected.clear();
    view.anchor = null;
    view.active = null;
    view.explicit = false;
    view.groupFocus = null;
    view.historyShown = HISTORY_PAGE;
    view.droppedHistory = 0;
    if (view.preview) { view.preview = null; }
    engine.reset(p ? p.id : null);
    if (p) loadHistory(p.id);
  }

  async function start() {
    R = await loadLogic();
    engine = R.engine.createEngine({
      getProject: project,
      update: (fn, reason) => BF.project.update(fn, { reason }),
      emit: (name, data) => BF.bus.emit(name, data),
      uid: (prefix) => BF.model.uid(prefix),
      duration: () => BF.player.duration() || (project() && project().source.duration) || Infinity,
      persist: (projectId, group) => queueGroup(projectId, group)
    });
    view.filters = { ...R.order.DEFAULT_FILTERS };
    view.sort = defaultSort();
    engine.onChange(() => scheduleRender());

    BF.review.engine = engine;
    BF.review.adjust = (id, patch) => {
      const res = engine.adjust(id, patch);
      if (!res.ok) BF.ui.toast(res.reason, 'error');
      else if (res.result && res.result.group) { BF.ui.log(`${res.result.group.label}.`, 'ok'); BF.bus.emit('cut:selected', { id }); }
      return res;
    };
    BF.review.select = (id, opts) => selectCut(id, opts);
    BF.review.activeId = () => view.active;
    BF.review.history = {
      flush: flushHistory,
      /** Descarta o que ainda não foi gravado do histórico deste projeto (ele vai ser apagado) e espera a gravação que já estava em andamento. */
      async discard(projectId) {
        persist.pending.delete(projectId);
        clearTimeout(persist.timer);
        if (persist.pending.size) persist.timer = setTimeout(flushHistory, 150); // o que é de outro projeto segue o caminho normal
        await persist.chain;
        persist.pending.delete(projectId);
      }
    };

    BF.bus.on('project:loaded', ({ project: p }) => { resetForProject(p); scheduleRender(); });
    BF.bus.on('cuts:changed', () => scheduleRender());
    BF.bus.on('decision', (event) => { engine.recordExternal(event); });
    BF.bus.on('cut:selected', ({ id }) => {
      view.active = id;
      view.explicit = true;
      scheduleRender();
      setTimeout(() => {
        const row = refs.list && refs.list.querySelector(`[data-id="${CSS.escape(id)}"]`);
        if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
      }, 0);
    });
    BF.bus.on('prefs:changed', ({ keys } = {}) => {
      // só interessa o que a revisão lê (review.*); o aprendizado de análise.* etc. não precisa refazer a lista
      if (Array.isArray(keys) && !keys.some((key) => String(key).startsWith('review.'))) return;
      // a ordem padrão só vale ao abrir o vídeo; mudar a preferência com o vídeo aberto também passa a valer na hora
      if (Array.isArray(keys) && keys.includes('review.defaultSort')) view.sort = defaultSort();
      scheduleRender();
    });
    // dispensar/registrar o aviso de fonte atualizada (Preferências) muda o selo "Fora da fonte"
    BF.bus.on('project:changed', ({ reason } = {}) => { if (typeof reason === 'string' && reason.startsWith('prefs:')) scheduleRender(); });
    BF.hooks.add('beforeOpen', async () => { await flushHistory(); return true; });
    window.addEventListener('beforeunload', () => { flushHistory(); });

    started = true;
    refs.loading.hidden = true;
    refs.main.hidden = false;
    refs.history.hidden = false;
    refs.shortcuts.hidden = false;
    if (project()) resetForProject(project());
    renderNow();
  }

  BF.ui.registerTab({
    id: 'cuts',
    title: 'Cortes',
    order: 10,
    badge: () => (project() && project().cuts.length) || '',
    render: build
  });

  /** Resolve quando a lógica carregou e a aba está pronta (com falha, a aba explica e a promessa ainda resolve). */
  BF.review.ready = start().then(() => BF.review, (err) => {
    console.error('Central de revisão:', err);
    if (refs.loading) refs.loading.textContent = `Não foi possível carregar a central de revisão: ${err.message}`;
    return BF.review;
  });
})();

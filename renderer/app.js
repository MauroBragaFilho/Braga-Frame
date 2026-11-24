'use strict';

/**
 * Núcleo do renderer: expõe `window.BF` (contrato em docs/arquitetura.md, seção 1.3).
 * Os recursos (renderer/features/*.js) só usam BF.* e não conhecem uns aos outros.
 */
(function () {
  const bridge = window.bf;
  const $ = (id) => document.getElementById(id);
  const BF = {};

  if (!bridge) {
    document.body.textContent = 'Não foi possível carregar a ponte segura com o app (preload). Reinstale ou reinicie o Braga Frame.';
    return;
  }

  // ---------- utilidades ----------

  // tempos: "m:ss.d" (abaixo de 1 h) e "h:mm:ss.d"; secs() = duração por extenso com vírgula ("6,0 s"). Módulo universal
  // (src/core/projects/timecode.js, testado no Node), carregado antes deste arquivo pelo index.html.
  const { fmt, parseTime, secs } = window.BFTime;

  const { el, debounce, dirOf, nameOf, baseOf, joinPath } = window.BFUtil; // renderer/util.js

  BF.util = { fmt, parseTime, secs, el, debounce, dirOf, nameOf, baseOf, joinPath };

  /**
   * Preferências de interface guardadas no navegador (menu recolhido, tema): BF.local.get(chave, padrão) / set(chave, valor).
   * localStorage pode faltar ou lançar (dados bloqueados, janela privada): nesse caso vale o padrão e nada quebra.
   * Isto é só conveniência de tela; o que importa para o projeto vai por BF.api.
   */
  BF.local = {
    get(key, fallback = null) {
      try { const value = window.localStorage.getItem(`bf.${key}`); return value === null ? fallback : value; } catch { return fallback; }
    },
    set(key, value) {
      try { window.localStorage.setItem(`bf.${key}`, String(value)); return true; } catch { return false; }
    }
  };

  /**
   * Modo embutido: o app roda dentro do Braga Digital Studio (iframe) ou aberto com ?embedded=1. Ele não assume que é dono
   * da janela: o shell esconde marca e controles de janela e o menu vira um trilho de ícones (#app.embedded).
   */
  BF.embedded = (() => {
    try {
      if (new URLSearchParams(window.location.search).get('embedded') === '1') return true;
      return window.parent !== window;
    } catch { return true; } // acesso negado ao parent = está dentro de outra origem
  })();
  $('app').classList.toggle('embedded', BF.embedded);
  // o hospedeiro (BDS) manda no tema: ?themeLocked=1 esconde o botão de tema daqui
  try { $('app').classList.toggle('theme-locked', BF.embedded && new URLSearchParams(window.location.search).get('themeLocked') === '1'); } catch { /* sem query */ }

  // ---------- eventos internos ----------

  const listeners = new Map();
  BF.bus = {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    emit(event, data) {
      for (const fn of [...(listeners.get(event) || [])]) {
        try { fn(data); } catch (err) { console.error(`Erro ouvindo "${event}":`, err); }
      }
    }
  };

  // ---------- ponte com o processo principal ----------

  /** invoke + trata { ok:false }. Devolve sempre o objeto; mostra toast de erro só com { toast: true }. */
  BF.api = async function api(channel, payload, opts = {}) {
    let res;
    try {
      res = await bridge.invoke(channel, payload);
    } catch (err) {
      res = { ok: false, code: 'IPC_ERROR', message: `Falha na comunicação com o app (${channel}): ${err.message}` };
    }
    if (!res || typeof res !== 'object') res = { ok: false, code: 'IPC_ERROR', message: 'Resposta inválida do app.' };
    if (res.ok === false && opts.toast) BF.ui.toast(res.message, 'error');
    return res;
  };
  BF.on = (channel, cb) => bridge.on(channel, cb);

  // ---------- estado ----------

  BF.state = {
    project: null, // projeto v2 em memória: única fonte de verdade no renderer
    info: null, // ffprobe do vídeo aberto
    url: null, // file:// do vídeo aberto
    tools: {}, // { ffmpeg, ffprobe, ytdlp, whisper, twitchDownloader } (caminhos ou null)
    app: { name: 'Braga Frame', tagline: '', version: '' },
    loadErrors: [] // handlers do processo principal que não carregaram
  };
  BF.model = window.BFModel; // newCut / normalizeCut / normalizeProject (mesmo código do processo principal)

  // ---------- ganchos ao abrir vídeo ----------

  const hookMap = new Map();
  BF.hooks = {
    /** Registra `fn(ctx)` (pode ser async) para 'beforeOpen' ou 'afterOpen'. Devolve a função que remove. */
    add(name, fn) {
      if (!hookMap.has(name)) hookMap.set(name, []);
      hookMap.get(name).push(fn);
      return () => { hookMap.set(name, hookMap.get(name).filter((f) => f !== fn)); };
    },
    /** Executa em sequência. Se algum gancho devolver `false`, para e devolve `false` (cancela a abertura). */
    async run(name, ctx) {
      for (const fn of [...(hookMap.get(name) || [])]) {
        let result;
        try { result = await fn(ctx); } catch (err) { console.error(`Erro no gancho "${name}":`, err); continue; }
        if (result === false) return false;
      }
      return true;
    }
  };

  // ---------- interface: status, avisos, modais ----------

  const ui = {};
  BF.ui = ui;

  // Indicador de estado do rodapé do menu (ponto verde/âmbar/vermelho + texto curto). Segue BF.ui.log; as features podem
  // marcar "ocupado" por conta própria com BF.ui.setState({ kind: 'busy', text: 'Exportando…' }) e voltar com { kind: 'ok' }.
  const STATE_TEXT = { ok: 'Pronto', busy: 'Trabalhando…', warn: 'Atenção', error: 'Erro' };
  ui.setState = function setState({ kind = 'ok', text = '', title = '' } = {}) {
    const state = STATE_TEXT[kind] ? kind : 'ok';
    const box = $('toolState');
    box.dataset.kind = state;
    box.title = title;
    $('stateText').textContent = text || STATE_TEXT[state];
  };

  let logTimer = null;
  const LOG_VISIBLE_MS = 7000;

  /** Barra de estado: mostra a mensagem, ajusta o indicador do menu e some sozinha (menos o erro, que fica até a próxima). */
  ui.log = function log(message, kind = '') {
    const node = $('log');
    node.textContent = message;
    node.className = `log ${kind}`.trim();
    node.title = message; // a pílula do cabeçalho corta mensagens longas: o texto inteiro fica na dica
    clearTimeout(logTimer);
    logTimer = null;
    const state = kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'ok';
    ui.setState({ kind: state, title: state === 'ok' ? '' : message });
    if (kind !== 'error' && message) logTimer = setTimeout(() => { node.classList.add('idle'); logTimer = null; }, LOG_VISIBLE_MS);
  };
  // clique na barra de erro descarta o aviso (o texto continua no elemento, só deixa de ocupar a tela)
  $('log').addEventListener('click', () => { $('log').classList.add('idle'); ui.setState({ kind: 'ok' }); });

  ui.toast = function toast(message, kind = '', ms) {
    const root = $('toasts');
    const node = el('div', { class: `toast ${kind}`.trim() }, message);
    const remove = () => { clearTimeout(timer); node.remove(); };
    const timer = setTimeout(remove, ms || (kind === 'error' ? 8000 : 4000));
    node.addEventListener('click', remove);
    root.append(node);
    while (root.children.length > 4) root.firstElementChild.remove();
  };

  /** Soltaram vários arquivos na janela: só o primeiro é aberto (cada vídeo é um projeto). Avisa, para o resto não sumir em silêncio. */
  ui.droppedMany = function droppedMany(count) {
    if (Number(count) > 1) ui.toast(`Cada vídeo é um projeto: abri só o primeiro (${count - 1} ficou de fora). Solte um de cada vez.`, '', 9000);
  };

  let modalSeq = 0;
  let modalChain = Promise.resolve();

  /** Mostra um modal por vez (os pedidos entram numa fila). Resolve com `okValue()` ou `cancelValue`. */
  function showModal({ title, message, okLabel, cancelLabel, danger, field, extra, okValue, cancelValue }) {
    const run = () => new Promise((resolve) => {
      const previous = document.activeElement;
      const n = ++modalSeq;
      const titleId = `bf-modal-title-${n}`;
      const msgId = `bf-modal-msg-${n}`;
      const ok = el('button', { type: 'button', class: danger ? 'danger' : 'primary', dataset: { act: 'ok' } }, okLabel);
      const cancel = el('button', { type: 'button', class: 'secondary', dataset: { act: 'cancel' } }, cancelLabel);
      const dialog = el('div', {
        class: 'bf-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': message ? msgId : undefined
      },
      el('h2', { id: titleId }, title),
      message ? el('p', { id: msgId, class: 'bf-modal-msg' }, message) : null,
      extra || null,
      field ? field.label : null,
      field ? field.input : null,
      el('div', { class: 'bf-modal-actions' }, cancel, ok));
      const backdrop = el('div', { class: 'bf-modal-backdrop' }, dialog);
      let closed = false;

      function close(value) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        $('app').inert = false;
        if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
        resolve(value);
      }

      function onKey(event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close(cancelValue);
        } else if (event.key === 'Enter') {
          // composição de acento / o próprio botão focado responde / numa caixa de marcar o Enter não confirma (o Espaço marca)
          if (event.isComposing || event.target instanceof HTMLButtonElement || (event.target instanceof HTMLInputElement && event.target.type === 'checkbox')) return;
          event.preventDefault();
          close(okValue());
        } else if (event.key === 'Tab') {
          const items = [...dialog.querySelectorAll('input, button')];
          const first = items[0];
          const last = items[items.length - 1];
          if (!dialog.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
          else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }

      ok.addEventListener('click', () => close(okValue()));
      cancel.addEventListener('click', () => close(cancelValue));
      backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close(cancelValue); });
      document.addEventListener('keydown', onKey, true);
      $('app').inert = true;
      $('modalRoot').append(backdrop);
      if (field) { field.input.focus(); field.input.select(); } else (danger ? cancel : ok).focus();
    });
    const result = modalChain.then(run);
    modalChain = result.catch(() => {});
    return result;
  }

  /** Confirmação própria (acessível: foco preso, Esc cancela, Enter confirma). Resolve true/false. */
  ui.confirm = function confirm({ title = 'Confirmar', message = '', okLabel = 'OK', cancelLabel = 'Cancelar', danger = false } = {}) {
    return showModal({ title, message, okLabel, cancelLabel, danger, okValue: () => true, cancelValue: false });
  };

  /**
   * Confirmação com uma caixa de marcar (ex.: "Apagar também os arquivos"). Resolve null se cancelar, senão { checked }.
   * `check` = { label, hint?, checked? } (marcada por padrão).
   */
  ui.confirmCheck = function confirmCheck({ title = 'Confirmar', message = '', okLabel = 'OK', cancelLabel = 'Cancelar', danger = false, check = {} } = {}) {
    const id = `bf-modal-check-${modalSeq + 1}`;
    const input = el('input', { type: 'checkbox', id, class: 'bds-switch', role: 'switch', checked: check.checked !== false });
    const row = el('label', { class: 'bf-modal-check', for: id },
      el('span', { class: 'bf-modal-check-text' }, el('strong', {}, check.label || ''), check.hint ? el('span', { class: 'muted small' }, check.hint) : null),
      input);
    return showModal({ title, message, okLabel, cancelLabel, danger, extra: row, okValue: () => ({ checked: input.checked }), cancelValue: null });
  };

  /** Pede um texto. Resolve com o texto (sem espaços nas pontas) ou null se cancelar. */
  ui.prompt = function prompt({ title = 'Digite', label = '', value = '', okLabel = 'OK', cancelLabel = 'Cancelar' } = {}) {
    const id = `bf-modal-input-${modalSeq + 1}`;
    const input = el('input', { type: 'text', id, class: 'bf-modal-input', value });
    const labelNode = el('label', { for: id }, label);
    return showModal({
      title, okLabel, cancelLabel, field: { label: labelNode, input }, okValue: () => input.value.trim(), cancelValue: null
    });
  };

  // ---------- interface: menu lateral e telas ----------
  //
  // O menu tem poucos itens (src/core/ui/menuLayout.js: Início, Projetos, Cortes, Exportações e Configurações) e cada item abriga uma ou mais
  // telas: as "abas" que as features registram com BF.ui.registerTab. Um item com várias telas (Cortes: Cortes, Análise, Legendas, Áudio e Exportar;
  // Configurações: Preferências e Ferramentas) mostra abas internas em cima do painel; uma tela sem aba própria (Novo projeto) abre por botões e
  // acende o item do dono (Projetos). Os ids das telas não mudam: #tabpanel-<id> é o painel de cada uma e BF.ui.selectTab(id) abre qualquer uma.
  // Botões: o item de uma tela só é #tab-<id> (início, projetos, exportações); o item de várias é #tab-<item> (editor, settings) e as abas
  // internas são #tab-<id> de cada tela (cuts, analysis, subtitles, audio, export, prefs, tools).

  // Ícone padrão (Material Symbols) de cada aba, para quem não passar `icon` em registerTab (vale para o item de menu das telas que o layout não conhece).
  const TAB_ICONS = {
    cuts: 'content_cut', export: 'ios_share', queue: 'queue', subtitles: 'subtitles', audio: 'graphic_eq',
    analysis: 'insights', sources: 'video_library', prefs: 'tune', tools: 'build', projects: 'folder_special', home: 'home'
  };
  // Telas "largas" (painel em largura total, player oculto); as demais são de trabalho com vídeo (player + painel).
  const WIDE_TABS = ['home', 'projects', 'sources', 'queue', 'general', 'prefs', 'tools'];
  const viewKindOf = (def) => (def.view === 'wide' || def.view === 'work' ? def.view : (WIDE_TABS.includes(def.id) ? 'wide' : 'work'));

  const tabs = new Map(); // id da tela -> { def, panel, locked, badgeText }
  let menu = null; // { items: [{ item, button, badge, strip, subs: Map(id da tela -> { button, badge }) }], byTab: Map(id da tela -> item do menu) }
  const lastTab = new Map(); // item com várias telas -> a tela em que o usuário estava nele
  let selectedTab = null;
  let userChoseTab = false;

  const isLocked = (id) => Boolean(tabs.get(id) && tabs.get(id).locked);
  const entryOf = (id) => (menu ? menu.byTab.get(id) || null : null);
  const firstTabId = () => [...tabs.values()].sort((a, b) => a.def.order - b.def.order)[0].def.id;

  /** A tela que o clique no item abre: a última em que o usuário esteve nele (se ainda vale) ou a primeira que pode ser aberta. */
  function entryTarget(entry) {
    const { item } = entry;
    const last = lastTab.get(item.id);
    if (last && item.tabs.includes(last) && !isLocked(last)) return last;
    return item.tabs.find((id) => !isLocked(id)) || item.defaultTab;
  }

  /** Refaz os botões do menu e as abas internas a partir das telas registradas (roda a cada registro). */
  function rebuildMenu() {
    const items = window.BFMenu.plan([...tabs.values()].map(({ def }) => ({ id: def.id, title: def.title, order: def.order, icon: def.icon || TAB_ICONS[def.id] })));
    const entries = [];
    const byTab = new Map();
    const strips = [];
    for (const item of items) {
      const group = item.kind === 'group';
      const id = group ? item.id : item.defaultTab;
      const badge = el('span', { class: 'tab-badge', hidden: true });
      const entry = { item, button: null, badge, strip: null, subs: new Map() };
      entry.button = el('button', {
        type: 'button', class: 'tab-button', role: 'tab', id: `tab-${id}`, 'aria-label': item.title, 'aria-selected': 'false', tabindex: '-1',
        'aria-controls': group ? undefined : `tabpanel-${item.defaultTab}`, dataset: { tab: id }, onclick: () => ui.selectTab(entryTarget(entry))
      }, el('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true' }, item.icon), el('span', { class: 'tab-label' }, item.title), badge);
      if (group) {
        entry.strip = el('div', { class: 'subtabs', role: 'tablist', 'aria-label': item.title, hidden: true, dataset: { group: item.id } });
        for (const tabId of item.tabs) {
          const subBadge = el('span', { class: 'tab-badge', hidden: true });
          const button = el('button', {
            type: 'button', class: 'subtab', role: 'tab', id: `tab-${tabId}`, 'aria-controls': `tabpanel-${tabId}`, 'aria-selected': 'false', tabindex: '-1',
            dataset: { tab: tabId }, onclick: () => ui.selectTab(tabId)
          }, el('span', { class: 'subtab-label' }, tabs.get(tabId).def.title), subBadge);
          entry.strip.append(button);
          entry.subs.set(tabId, { button, badge: subBadge });
        }
        strips.push(entry.strip);
      }
      entries.push(entry);
      for (const tabId of [...item.tabs, ...item.hidden]) byTab.set(tabId, entry);
    }
    menu = { items: entries, byTab };
    $('tabBar').replaceChildren(...entries.map((entry) => entry.button));
    $('subTabs').replaceChildren(...strips);
  }

  /** O que sobe das telas de dentro para o item do menu: só o que pede atenção ("!" vale mais que "…"); as contagens ficam na aba interna. */
  function bubbled(ids) {
    const texts = ids.map((id) => (tabs.get(id) ? tabs.get(id).badgeText : ''));
    if (texts.includes('!')) return '!';
    return texts.includes('…') ? '…' : '';
  }

  const setBadge = (node, text) => {
    if (node.textContent !== text) node.textContent = text;
    node.hidden = !text;
  };

  function refreshTabs() {
    for (const tab of tabs.values()) {
      let text = '';
      if (typeof tab.def.badge === 'function') {
        try { text = String(tab.def.badge() ?? ''); } catch { text = ''; }
      }
      tab.badgeText = text;
    }
    if (!menu) return;
    for (const entry of menu.items) {
      const { item } = entry;
      if (item.kind === 'group') {
        for (const [id, sub] of entry.subs) setBadge(sub.badge, tabs.get(id).badgeText);
        setBadge(entry.badge, bubbled(item.tabs));
      } else {
        setBadge(entry.badge, tabs.get(item.defaultTab).badgeText || bubbled(item.hidden));
      }
    }
  }
  ui.refreshTabs = refreshTabs;

  /** Acende o item do menu da tela aberta, mostra as abas internas dele (e só dele) e marca a aba interna ativa. */
  function syncMenu() {
    if (!menu) return;
    const active = entryOf(selectedTab);
    for (const entry of menu.items) {
      const on = entry === active;
      entry.button.setAttribute('aria-selected', String(on));
      entry.button.classList.toggle('active', on);
      entry.button.tabIndex = on ? 0 : -1;
      if (!entry.strip) continue;
      entry.strip.hidden = !on;
      entry.button.setAttribute('aria-controls', `tabpanel-${on && entry.item.tabs.includes(selectedTab) ? selectedTab : entryTarget(entry)}`);
      for (const [id, sub] of entry.subs) {
        const here = on && id === selectedTab;
        sub.button.setAttribute('aria-selected', String(here));
        sub.button.classList.toggle('active', here);
        sub.button.tabIndex = here ? 0 : -1;
      }
    }
    const app = $('app');
    app.dataset.activeMenu = active ? active.item.id : '';
    app.classList.toggle('has-subtabs', Boolean(active && active.strip));
  }

  /** Leva o foco ao botão da tela: a aba interna, ou o item do menu quando a tela é a única do item. */
  function focusTab(id) {
    const entry = entryOf(id);
    if (!entry) return;
    const sub = entry.subs.get(id);
    (sub ? sub.button : entry.button).focus();
  }

  // As telas dividem UM painel que rola: sem isto, a rolagem de uma aba passava para a seguinte (a Análise e o Exportar abriam no meio da página).
  // Cada tela lembra onde estava e abre no topo da primeira vez; trocar de projeto zera a lembrança.
  const tabScroll = new Map();
  BF.bus.on('project:loaded', () => tabScroll.clear());

  function activateTab(id, focus) {
    const target = tabs.get(id);
    if (!target) return false;
    const scroller = $('tabPanels');
    const changing = selectedTab !== id;
    if (changing && selectedTab && tabs.has(selectedTab) && scroller) tabScroll.set(selectedTab, scroller.scrollTop);
    selectedTab = id;
    for (const tab of tabs.values()) tab.panel.hidden = tab !== target;
    if (changing && scroller) scroller.scrollTop = tabScroll.get(id) || 0;
    const entry = entryOf(id);
    if (entry && entry.strip && entry.item.tabs.includes(id)) lastTab.set(entry.item.id, id);
    syncMenu();
    // o layout (duas colunas ou largura total) e o título do cabeçalho seguem a tela aberta; num item com abas internas o cabeçalho leva o nome do item
    const app = $('app');
    const title = entry && entry.strip ? entry.item.title : target.def.title;
    app.dataset.viewKind = viewKindOf(target.def);
    app.dataset.activeTab = id;
    $('pageTitle').textContent = title;
    BF.bus.emit('tab:changed', { id, title, view: app.dataset.viewKind, menu: entry ? entry.item.id : id });
    if (focus) focusTab(id);
    if (typeof target.def.onShow === 'function') {
      try { target.def.onShow(); } catch (err) { console.error(`Erro ao mostrar a aba "${id}":`, err); }
    }
    refreshTabs();
    return true;
  }

  /** Mostra a tela `id` (escolha explícita: a partir daí abas novas não tomam o lugar dela). */
  ui.selectTab = function selectTab(id, { focus = false } = {}) {
    if (isLocked(id)) return false; // tela que exige projeto, sem projeto aberto
    const found = activateTab(id, focus);
    if (found) userChoseTab = true;
    return found;
  };

  /**
   * Abre a tela de trabalho de um vídeo recém-aberto: a Análise (primeiro passo de quem começa) quando o projeto ainda não tem cortes,
   * e os Cortes quando já tem (quem volta a um projeto quer ver o que já fez).
   */
  ui.selectWorkTab = function selectWorkTab() {
    const project = BF.state && BF.state.project;
    return ui.selectTab(project && Array.isArray(project.cuts) && project.cuts.length ? 'cuts' : 'analysis');
  };

  /**
   * Registra uma tela: { id, title, order, render(container), onShow?(), badge?(), icon?, view? }.
   * Onde ela aparece no menu vem de src/core/ui/menuLayout.js (item do menu ou aba interna); `title` é o texto do botão, `badge` o selo
   * (contagem, "…" ou "!"), `view` = 'wide' | 'work' força o tipo de tela (padrão: home/projects/sources/queue/prefs/tools são largas, as outras de
   * trabalho). Uma tela que o layout não conhece ganha um item de menu próprio, na posição do `order` e com o `icon` (padrão por id em TAB_ICONS;
   * sem nenhum, "circle").
   */
  ui.registerTab = function registerTab(def) {
    if (!def || typeof def.id !== 'string' || typeof def.render !== 'function') {
      throw new Error('registerTab: informe { id, title, order, render(container) }.');
    }
    if (tabs.has(def.id)) throw new Error(`registerTab: a aba "${def.id}" já foi registrada.`);
    const full = { order: 100, title: def.id, ...def };
    const panel = el('section', {
      class: 'tabpanel', role: 'tabpanel', id: `tabpanel-${full.id}`, 'aria-label': full.title, hidden: true, dataset: { tab: full.id }
    });
    tabs.set(full.id, { def: full, panel, locked: false, badgeText: '' });
    $('tabPanels').append(panel);
    try {
      full.render(panel);
    } catch (err) {
      console.error(`Erro ao montar a aba "${full.id}":`, err);
      panel.replaceChildren(el('p', { class: 'muted' }, `Não foi possível montar a aba "${full.title}": ${err.message}`));
    }
    rebuildMenu();
    if (!userChoseTab) activateTab(firstTabId(), false); // sem escolha do usuário, vale a primeira por ordem
    else { syncMenu(); refreshTabs(); }
    applyProjectMode();
  };

  // Sem projeto aberto só estas telas funcionam; as demais ficam desabilitadas (o painel continua visível).
  const FREE_TABS = ['home', 'projects', 'sources', 'queue', 'general', 'prefs', 'tools']; // 1ª = tela inicial quando não há projeto aberto
  const LOCKED_TITLE = 'Abra um vídeo para usar esta aba';
  function applyProjectMode() {
    const has = Boolean(BF.state.project);
    const rail = $('app').classList.contains('collapsed') || $('app').classList.contains('embedded');
    $('app').classList.toggle('no-project', !has);
    for (const tab of tabs.values()) tab.locked = !has && !FREE_TABS.includes(tab.def.id);
    if (menu) {
      for (const entry of menu.items) {
        const locked = entry.item.tabs.every(isLocked); // o item só some do alcance quando nenhuma das telas dele pode abrir
        entry.button.disabled = locked;
        entry.button.title = locked ? LOCKED_TITLE : (rail ? entry.item.title : ''); // no trilho de ícones o título aparece como dica
        for (const [id, sub] of entry.subs) {
          sub.button.disabled = isLocked(id);
          sub.button.title = isLocked(id) ? LOCKED_TITLE : '';
        }
      }
    }
    const current = tabs.get(selectedTab);
    if (!has && (!current || current.locked)) {
      const fallback = FREE_TABS.find((id) => tabs.has(id));
      if (fallback) activateTab(fallback, false);
    } else if (has && !userChoseTab && tabs.has('cuts')) {
      activateTab('cuts', false);
    }
  }
  ui.applyProjectMode = applyProjectMode;

  // Teclado no menu: ↑/↓ (e ←/→) andam pelos itens, Home e End vão ao primeiro e ao último. Só os itens utilizáveis entram na volta: sem projeto,
  // o item Cortes desabilitado seria um vizinho "morto" e travaria o foco.
  $('tabBar').addEventListener('keydown', (event) => {
    if (!menu) return;
    const list = menu.items.filter((entry) => !entry.button.disabled);
    if (!list.length) return;
    const index = list.indexOf(entryOf(selectedTab));
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % list.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + list.length) % list.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = list.length - 1;
    if (next < 0) return;
    event.preventDefault();
    ui.selectTab(entryTarget(list[next]));
    list[next].button.focus();
  });

  // Teclado nas abas internas: ←/→ andam pelas abas do item, Home e End vão à primeira e à última (as desabilitadas ficam de fora).
  $('subTabs').addEventListener('keydown', (event) => {
    const entry = entryOf(selectedTab);
    if (!entry || !entry.strip || !entry.strip.contains(event.target)) return;
    const list = entry.item.tabs.filter((id) => !isLocked(id));
    if (!list.length) return;
    const index = list.indexOf(selectedTab);
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % list.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + list.length) % list.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = list.length - 1;
    if (next < 0) return;
    event.preventDefault();
    ui.selectTab(list[next], { focus: true });
  });

  // ---------- player ----------

  const video = $('video');
  let rangeEnd = null;
  let rangeFrame = 0;
  const UNPLAYABLE_MESSAGE = 'Este vídeo não toca no player do app (o formato ou o codec não é suportado aqui). Dá para marcar os tempos digitando e exportar normalmente: o corte e a exportação não dependem do player.';

  function stopRange() {
    rangeEnd = null;
    cancelAnimationFrame(rangeFrame);
  }

  /** Para a prévia no fim do trecho (checado a cada quadro de tela e também no timeupdate). */
  function checkRange() {
    if (rangeEnd === null) return;
    if (video.currentTime >= rangeEnd) {
      stopRange();
      video.pause();
      return;
    }
    rangeFrame = requestAnimationFrame(checkRange);
  }

  BF.player = {
    video,
    unplayableMessage: UNPLAYABLE_MESSAGE,
    /** Carrega o vídeo (file://). */
    load(url) {
      stopRange();
      video.src = url;
    },
    seek(sec) {
      const max = Number.isFinite(video.duration) ? video.duration : Infinity;
      video.currentTime = Math.min(Math.max(0, sec), max);
    },
    /** true se o player tem um vídeo carregado que o Chromium consegue tocar (formato como .ts e .flv costuma falhar). */
    canPlay() { return Boolean(video.getAttribute('src')) && !video.error; },
    /** Toca só do início ao fim do trecho e pausa. Devolve false (e avisa) se o player não consegue tocar este vídeo. */
    playRange(start, end) {
      stopRange();
      if (!BF.player.canPlay()) { ui.toast(UNPLAYABLE_MESSAGE, 'error', 8000); return false; }
      rangeEnd = end;
      video.currentTime = start;
      const started = video.play();
      if (started && typeof started.catch === 'function') {
        started.catch((err) => {
          if (err && err.name === 'AbortError') return; // outro trecho, pausa ou troca de vídeo no meio: normal
          stopRange();
          ui.toast(UNPLAYABLE_MESSAGE, 'error', 8000);
        });
      }
      rangeFrame = requestAnimationFrame(checkRange);
      return true;
    },
    pause() { stopRange(); video.pause(); },
    /** Solta o vídeo: o arquivo fica livre para ser apagado (o Windows não apaga um arquivo que o player está lendo). */
    unload() {
      stopRange();
      video.pause();
      video.removeAttribute('src');
      video.load();
    },
    time() { return video.currentTime || 0; },
    duration() { return Number.isFinite(video.duration) ? video.duration : (BF.state.info?.duration || 0); },
    onTime(cb) { return BF.bus.on('player:time', ({ time }) => cb(time)); }
  };
  video.addEventListener('timeupdate', () => {
    if (rangeEnd !== null && video.currentTime >= rangeEnd) { stopRange(); video.pause(); }
    BF.bus.emit('player:time', { time: video.currentTime });
  });
  video.addEventListener('seeked', () => BF.bus.emit('player:time', { time: video.currentTime }));
  // pausa feita pelo usuário durante a prévia cancela o "parar no fim"
  video.addEventListener('pause', () => { if (rangeEnd !== null) stopRange(); });
  video.addEventListener('error', () => {
    if (!video.getAttribute('src')) return;
    // features/proxy.js: em vez de só avisar, cria uma cópia leve para o player (devolve true quando cuida do assunto)
    if (typeof BF.player.onUnplayable === 'function' && BF.player.onUnplayable()) return;
    ui.toast(UNPLAYABLE_MESSAGE, 'error', 10000);
  });

  // ---------- projeto ----------

  const SAVE_DELAY_MS = 300;
  const SAVE_RETRY_MS = [1500, 4000, 10000]; // depois de uma falha de gravação: tenta de novo sozinho (a última espera se repete)
  let dirty = false;
  let discarded = false; // o projeto aberto está sendo apagado: nada mais é gravado até abrir outro vídeo (veja BF.project.discard)
  let saveChain = Promise.resolve(true);
  let retryTimer = null;
  let failures = 0; // gravações seguidas que falharam (o aviso aparece só na primeira, para não encher a tela)

  /** "Não foi possível salvar o projeto: …" sem repetir o prefixo quando o processo principal já o trouxe. */
  function saveErrorText(message) {
    return /^Não foi possível salvar/.test(message) ? message : `Não foi possível salvar o projeto: ${message}`;
  }

  function writeNow() {
    if (discarded || !dirty || !BF.state.project) return saveChain;
    dirty = false;
    const snapshot = JSON.parse(JSON.stringify(BF.state.project));
    saveChain = saveChain.then(async () => {
      const res = await BF.api('project:save', { project: snapshot });
      if (!res.ok) {
        dirty = true;
        const text = saveErrorText(res.message);
        ui.log(text, 'error');
        if (failures === 0) ui.toast(text, 'error');
        // a edição continua só na memória: tenta de novo sozinho (antes ficava esperando a próxima edição, que podia nunca vir)
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { retryTimer = null; writeNow(); }, SAVE_RETRY_MS[Math.min(failures, SAVE_RETRY_MS.length - 1)]);
        failures += 1;
        return false;
      }
      clearTimeout(retryTimer);
      retryTimer = null;
      if (failures > 0) { failures = 0; ui.log('Projeto salvo.', 'ok'); ui.toast('Projeto salvo: a gravação voltou a funcionar.', 'ok'); }
      if (BF.state.project && BF.state.project.id === res.project.id) BF.state.project.updatedAt = res.project.updatedAt;
      return true;
    });
    return saveChain;
  }
  const scheduleSave = debounce(writeNow, SAVE_DELAY_MS);

  BF.project = {
    /**
     * Muta o projeto em memória (`mutatorFn(project)` altera no lugar), avisa os recursos
     * ('project:changed') e agenda o salvamento. Devolve o que o mutador devolver.
     */
    update(mutatorFn, { reason = 'update' } = {}) {
      const project = BF.state.project;
      if (!project) return undefined;
      const result = mutatorFn(project);
      if (!discarded) { dirty = true; scheduleSave(); }
      BF.bus.emit('project:changed', { reason });
      return result;
    },
    /** Grava agora o que estiver pendente. Resolve true se tudo foi salvo. */
    flush() {
      scheduleSave.cancel();
      return writeNow();
    },
    /**
     * Para de gravar este projeto SEM salvar o que estiver pendente (ele está sendo apagado): cancela o salvamento agendado e as novas tentativas e
     * espera a gravação que já estava em andamento terminar (para ela não recriar o arquivo depois de apagado). Até abrir outro vídeo, nada é gravado.
     */
    async discard() {
      discarded = true;
      dirty = false;
      scheduleSave.cancel();
      clearTimeout(retryTimer);
      retryTimer = null;
      await saveChain;
    },
    cut(id) {
      return BF.state.project ? BF.state.project.cuts.find((c) => c.id === id) || null : null;
    },
    /** Cria um corte manual completo, mantém a ordem cronológica e emite create/cuts:changed/cut:selected. */
    addCut(fields = {}) {
      let created = null;
      BF.project.update((project) => {
        created = BF.model.newCut({ title: `Corte ${project.cuts.length + 1}`, ...fields }, { index: project.cuts.length });
        project.cuts.push(created);
        project.cuts.sort((a, b) => a.start - b.start);
      }, { reason: 'cut:create' });
      BF.bus.emit('cuts:changed', { ids: [created.id] });
      BF.bus.emit('decision', { cutId: created.id, type: 'create', before: null, after: JSON.parse(JSON.stringify(created)) });
      BF.bus.emit('cut:selected', { id: created.id });
      return created;
    }
  };
  window.addEventListener('beforeunload', () => { BF.project.flush(); });

  // ---------- preferências (substituído por features/prefs.js) ----------

  BF.prefs = {
    get(key, fallback) { return fallback; },
    resolve() { return {}; },
    explain() { return null; }
  };

  // ---------- abrir vídeo ----------

  let opening = false;

  /** Aviso de projeto corrompido (source:open devolve `recovered`): diz o que aconteceu, o que foi recuperado e onde ficou o arquivo. */
  function recoveryMessage(recovered) {
    const kept = `O arquivo danificado foi guardado, sem apagar, em "${recovered.file}".`;
    if (recovered.restoredFromBackup) {
      const when = recovered.backupAt ? ` (de ${new Date(recovered.backupAt).toLocaleString('pt-BR')})` : '';
      return `O arquivo do projeto deste vídeo estava danificado. Recuperamos a última cópia boa${when}: o que foi alterado depois dela pode ter se perdido. ${kept}`;
    }
    return `O arquivo do projeto deste vídeo estava danificado e não havia cópia para recuperar: ele começou como um projeto novo, sem cortes. ${kept} Não o apague: se precisar dos cortes antigos, ele é a única fonte.`;
  }

  /** Abre (ou cria) o projeto do vídeo. Passa pelos ganchos 'beforeOpen' e 'afterOpen'. */
  BF.openSource = async function openSource(path, origin = null) {
    if (opening) return { ok: false, code: 'BUSY', message: 'Já existe um vídeo sendo aberto.' };
    opening = true;
    let touched = false;
    const offTouched = BF.bus.on('project:changed', () => { touched = true; });
    try {
      const ctx = { path, origin, info: null };
      if ((await BF.hooks.run('beforeOpen', ctx)) === false) return { ok: false, code: 'CANCELLED', message: 'Abertura cancelada.', canceled: true };
      // nada do projeto anterior pode se perder: se a gravação falhar, não troca de vídeo sem o usuário saber
      if (BF.state.project && !(await BF.project.flush())) {
        const proceed = await ui.confirm({
          title: 'Não foi possível salvar o projeto atual',
          message: 'As últimas alterações deste projeto ainda não foram gravadas (o app continua tentando). Se abrir o outro vídeo agora, elas podem se perder. Abrir mesmo assim?',
          okLabel: 'Abrir mesmo assim', cancelLabel: 'Continuar neste vídeo', danger: true
        });
        if (!proceed) return { ok: false, code: 'SAVE_FAILED', message: 'Abertura cancelada: o projeto atual ainda não foi salvo.', canceled: true };
      }
      touched = false; // só vale o que mudar a partir daqui
      const res = await BF.api('source:open', { path: ctx.path, origin: ctx.origin });
      if (!res.ok) {
        ui.log(res.message, 'error');
        ui.toast(res.message, 'error');
        return res;
      }
      // edição feita enquanto o vídeo abria (uma exportação que termina, uma legenda que fica pronta, um clique):
      //  - outro vídeo: grava o projeto antigo agora, antes de ele sair da memória;
      //  - o MESMO vídeo (mesmo id): a memória é mais nova que o disco que o source:open leu; fica com a da memória
      //    (só atualiza os dados medidos do arquivo), senão a edição se perdia.
      const previous = BF.state.project;
      let project = res.project;
      if (touched && previous) {
        if (previous.id === project.id) {
          const { size, duration, width, height } = project.source;
          previous.source = { ...previous.source, size, duration, width, height };
          project = previous;
          dirty = true;
          scheduleSave();
        } else if (!(await BF.project.flush())) {
          ui.toast(`As últimas alterações de "${nameOf(previous.source.path)}" não puderam ser gravadas. O app continua tentando; não feche antes de aparecer "Projeto salvo".`, 'error', 12000);
        }
      }
      discarded = false;
      BF.state.project = project;
      BF.state.info = res.info;
      BF.state.url = res.url;
      BF.player.load(res.url);
      BF.bus.emit('project:loaded', { project, restored: res.restored });
      ui.log(res.restored ? `Projeto reaberto com ${project.cuts.length} corte(s).` : 'Projeto criado para este vídeo.', 'ok');
      if (res.recovered) {
        const text = recoveryMessage(res.recovered);
        ui.log(text, 'error');
        ui.toast(text, 'error', 25000);
      }
      for (const warning of res.warnings || []) ui.toast(warning.message, '', 15000);
      await BF.hooks.run('afterOpen', { ...ctx, info: res.info, project, restored: res.restored });
      return res;
    } finally {
      offTouched();
      opening = false;
    }
  };

  // ---------- início ----------

  BF.bus.on('project:changed', refreshTabs);
  BF.bus.on('cuts:changed', refreshTabs);
  BF.bus.on('project:loaded', refreshTabs);
  BF.bus.on('project:loaded', applyProjectMode);

  /** Resolve quando as informações do app (nome, ferramentas) foram carregadas. */
  BF.ready = (async () => {
    const res = await BF.api('app:info');
    if (res.ok) {
      BF.state.app = { name: res.name, tagline: res.tagline, version: res.version, projectsDir: res.projectsDir || '' };
      BF.state.tools = res.tools || {};
      BF.state.loadErrors = res.loadErrors || [];
    } else {
      ui.log(res.message, 'error');
    }
    BF.on('tools:changed', ({ tools }) => {
      BF.state.tools = tools;
      BF.bus.emit('tools:changed', { tools });
    });
    return BF.state;
  })();

  // ---------- recarregar a tela ----------

  /** Recarrega a tela: volta ao estado de "sem vídeo aberto", sem nada do projeto anterior na memória (usada depois de apagar o projeto aberto). */
  BF.restart = function restart() {
    window.location.reload();
  };

  /** Guarda um aviso para aparecer depois de recarregar a tela (o toast de agora sumiria com ela). Aparece uma vez. */
  BF.flash = function flash(text, kind = '') {
    BF.local.set('flash', JSON.stringify({ text: String(text), kind }));
  };
  BF.ready.then(() => {
    const raw = BF.local.get('flash', '');
    if (!raw) return;
    BF.local.set('flash', '');
    try {
      const { text, kind } = JSON.parse(raw);
      if (!text) return;
      const tone = kind === 'error' || kind === 'ok' ? kind : '';
      ui.toast(String(text), tone, 9000);
      ui.log(String(text), tone);
    } catch { /* aviso ilegível: descarta */ }
  });

  // ---------- pedidos de abrir vídeo vindos de fora ----------

  // Linha de comando (`BragaFrame.exe "vídeo.mp4"`, inclusive de uma segunda instância) e programa hospedeiro (Braga Digital
  // Studio): o processo principal guarda o pedido e avisa com 'app:openRequest'; aqui se busca o que está pendente (uma vez
  // só por pedido) assim que a interface terminou de carregar e a cada aviso. Veja src/host/openRequests.js.
  const pageLoaded = new Promise((resolve) => {
    if (document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve, { once: true });
  });
  let takingRequests = false;
  let takeAgain = false;

  async function openRequested(path) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const res = await BF.openSource(path);
      if (res.code !== 'BUSY') return res;
      await new Promise((resolve) => setTimeout(resolve, 250)); // já abrindo outro vídeo: espera terminar
    }
    return null;
  }

  async function takeOpenRequests() {
    if (takingRequests) { takeAgain = true; return; }
    takingRequests = true;
    try {
      await Promise.all([BF.ready, pageLoaded]);
      do {
        takeAgain = false;
        const res = await BF.api('app:takeOpenRequest');
        if (!res.ok) break;
        for (const item of res.requests || []) {
          if (item.error) {
            ui.log(item.error.message, 'error');
            ui.toast(item.error.message, 'error', 12000);
          } else if (item.path) {
            await openRequested(item.path);
          }
        }
      } while (takeAgain);
    } finally {
      takingRequests = false;
    }
  }
  BF.on('app:openRequest', () => { takeOpenRequests(); });
  takeOpenRequests();

  window.BF = BF;
})();

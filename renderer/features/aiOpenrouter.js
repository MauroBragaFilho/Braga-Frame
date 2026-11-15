'use strict';

/**
 * OpenRouter "só com modelos gratuitos" (renderer; esta feature NÃO tem aba): os dois componentes que o cartão do provedor de IA usa.
 * Registra só `window.BF.aiOpenRouter`. Especificação: docs/recursos/openrouter-gratuito.md.
 *
 *   BF.aiOpenRouter.createModelPicker({ value, freeOnly, onChange(modelId), onFreeOnlyChange(bool) }) -> elemento
 *       Lista de seleção de modelos. A lista chega pronta do processo principal (canal aiOpenrouter:models) NA ORDEM da especificação:
 *       1º "Automático — roteador gratuito" (openrouter/free; aparece na hora, sem depender do catálogo), "Modelos gratuitos" (os
 *       adequados à análise), "Outros gratuitos" (recolhido, esmaecido, com o motivo) e, só com o interruptor desligado, "Pagos" com o
 *       preço por milhão de tokens e o aviso de custo. NADA vem selecionado até o usuário escolher (value vazio = nenhum selecionado).
 *       O elemento ganha `element.bfPicker = { setValue(id), setFreeOnly(bool), setDisabled(bool), refresh(), reload(), focus(), state() }`.
 *   BF.aiOpenRouter.createLimitsChip() -> elemento
 *       Selo "Restam N de L pedidos gratuitos hoje · renova às 21:00" (canal aiOpenrouter:limits). Some sem chave. `element.refresh()`.
 *
 * A chave de API nunca passa por aqui: o processo principal consulta o OpenRouter com ela e devolve só os números.
 * Só tokens e componentes de renderer/app.css (.bds-switch, .bds-chip, .empty-state, details/summary, botões .sm).
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;

  const ROUTER_ID = 'openrouter/free';
  const SEARCH_DELAY_MS = 250;
  const LIMITS_REFRESH_MS = 2 * 60 * 1000;
  const EXPIRY_WARN_DAYS = 14;

  // ---------- formatação (funções puras, também expostas em BF.aiOpenRouter.format) ----------

  const two = (n) => String(n).padStart(2, '0');

  /** Tamanho do contexto em texto curto: 262144 -> "262 mil"; 1048576 -> "1 mi". */
  function formatContext(n) {
    if (!(n > 0)) return '';
    if (n >= 950000) {
      const mi = Math.round((n / 1000000) * 10) / 10;
      return `${Number.isInteger(mi) ? mi : String(mi).replace('.', ',')} mi`;
    }
    if (n >= 1000) return `${Math.round(n / 1000)} mil`;
    return String(n);
  }

  /** 'YYYY-MM-DD' -> "31/10" (com o ano se for de outro ano). */
  function formatDay(day, now = Date.now()) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    if (!m) return '';
    return `${m[3]}/${m[2]}${new Date(now).getFullYear() === Number(m[1]) ? '' : `/${m[1]}`}`;
  }

  /** Instante ISO -> "23/10 às 14:32" no horário do computador. */
  function formatWhen(iso, now = Date.now()) {
    const d = new Date(iso);
    if (!iso || !Number.isFinite(d.getTime())) return '';
    const sameYear = d.getFullYear() === new Date(now).getFullYear();
    return `${two(d.getDate())}/${two(d.getMonth() + 1)}${sameYear ? '' : `/${d.getFullYear()}`} às ${two(d.getHours())}:${two(d.getMinutes())}`;
  }

  /** Dólares por milhão de tokens: 0.3 -> "US$ 0,30"; 0.075 -> "US$ 0,075"; 15 -> "US$ 15,00". */
  function formatMoney(value) {
    const text = Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    return `US$ ${text}`;
  }

  /** Linha de preço de um modelo pago. */
  function formatPrice(price) {
    if (!price) return '';
    if (price.variable) return 'Preço variável: depende do modelo que o roteador escolher';
    if (price.unknown) return 'Preço não informado pelo OpenRouter';
    const base = `Entrada ${formatMoney(price.promptPerMillion)} · saída ${formatMoney(price.completionPerMillion)} por milhão de tokens`;
    return price.otherFees ? `${base}, mais outras tarifas (por pedido, imagem ou busca na web)` : base;
  }

  /** Selos de uma linha: { text, kind } com kind '' | 'accent' | 'info' | 'warn'. */
  function badgesOf(item, now = Date.now()) {
    if (item.group === 'router') return [{ text: 'Automático', kind: 'accent' }];
    const out = [];
    if (item.contextLength) out.push({ text: `contexto ${formatContext(item.contextLength)}`, kind: '' });
    if (item.supportsJson) out.push({ text: 'JSON', kind: 'info' });
    const explained = (item.reasons || []).some((r) => r.code === 'expires_soon' || r.code === 'expired');
    if (item.expiresAt && !item.expired && !explained) {
      out.push({ text: `expira ${formatDay(item.expiresAt, now)}`, kind: item.expiresInDays !== null && item.expiresInDays < EXPIRY_WARN_DAYS ? 'warn' : '' });
    }
    return out;
  }

  const icon = (name) => el('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true' }, name);
  const chip = (text, kind) => el('span', { class: `bds-chip${kind ? ` bds-chip-${kind}` : ''}` }, text);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // ---------- o seletor de modelos ----------

  let pickerSeq = 0;

  function createModelPicker({ value = '', freeOnly = true, onChange = null, onFreeOnlyChange = null } = {}) {
    const uid = ++pickerSeq;
    let optionSeq = 0;
    const state = {
      value: typeof value === 'string' ? value : '',
      freeOnly: freeOnly !== false,
      query: '',
      data: null, // última resposta de aiOpenrouter:models
      error: null, // texto, se o canal falhou
      loading: true,
      seq: 0,
      othersOpen: false,
      paidOpen: true,
      disabled: false // travado (uma análise está usando o provedor): nada se escolhe nem se liga/desliga
    };
    const ui = {};

    // ----- esqueleto fixo -----
    const switchId = `bforSwitch${uid}`;
    ui.switch = el('input', {
      type: 'checkbox', id: switchId, class: 'bds-switch', role: 'switch', checked: state.freeOnly,
      onchange: () => setFreeOnly(ui.switch.checked, { notify: true })
    });
    ui.switchHint = el('span', { class: 'bfor-switch-hint small' });
    ui.refresh = el('button', { type: 'button', class: 'sm bfor-refresh', onclick: () => load({ refresh: true }) }, icon('refresh'), el('span', { class: 'bfor-refresh-label' }, 'Atualizar lista'));
    ui.status = el('p', { class: 'bfor-status small', role: 'status' });
    ui.cost = el('p', { class: 'bfor-note bfor-note-warn bfor-cost small', hidden: true }, 'Modelos pagos são cobrados na sua conta do OpenRouter, pelo preço por milhão de tokens mostrado em cada um. Confira antes de escolher.');
    ui.search = el('input', {
      type: 'search', class: 'bfor-search', placeholder: 'Buscar pelo nome do modelo', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Buscar modelo',
      oninput: () => searchSoon()
    });
    ui.searchRow = el('div', { class: 'bfor-search-row', hidden: true }, ui.search);
    ui.valueNote = el('p', { class: 'bfor-note bfor-note-warn bfor-value-note small', role: 'status', hidden: true });

    const listbox = (label, extra = {}) => el('div', { class: 'bfor-listbox', role: 'listbox', tabindex: '0', 'aria-label': label, ...extra });
    ui.main = listbox('Modelos do OpenRouter', { dataset: { list: 'main' } });
    ui.othersList = listbox('Outros modelos gratuitos', { dataset: { list: 'others' } });
    ui.paidList = listbox('Modelos pagos do OpenRouter', { dataset: { list: 'paid' } });
    ui.othersTitle = el('summary', {}, 'Outros gratuitos');
    ui.othersFold = el('details', { class: 'bfor-fold', hidden: true, ontoggle: () => { state.othersOpen = ui.othersFold.open; } },
      ui.othersTitle,
      el('p', { class: 'muted small bfor-fold-note' }, 'Não servem bem à análise (ou nem são modelos de conversa), mas dá para escolher. O motivo aparece em cada um.'),
      ui.othersList);
    ui.paidTitle = el('summary', {}, 'Pagos');
    ui.paidFold = el('details', { class: 'bfor-fold', open: true, hidden: true, ontoggle: () => { state.paidOpen = ui.paidFold.open; } },
      ui.paidTitle, ui.paidList);
    ui.routerHint = el('p', { class: 'bfor-note bfor-router-hint small', hidden: true }, 'O roteador troca de modelo a cada pedido, então o formato e a qualidade das respostas variam (às vezes sai um modelo de moderação, que o app descarta) e novas tentativas gastam o limite do dia. Para análises, um modelo fixo costuma render mais; o roteador é a opção prática.');

    const root = el('div', { class: 'bfor-picker', dataset: { state: 'loading' } },
      el('div', { class: 'bfor-head' },
        el('label', { class: 'bfor-switch-row', for: switchId },
          el('span', { class: 'bfor-switch-text' }, el('strong', {}, 'Usar apenas modelos gratuitos'), ui.switchHint),
          ui.switch),
        el('div', { class: 'bfor-bar' }, ui.status, ui.refresh)),
      ui.cost,
      ui.searchRow,
      ui.valueNote,
      ui.main,
      ui.routerHint,
      ui.othersFold,
      ui.paidFold);

    // ----- nós da lista -----

    function optionNode(item, { dim = false } = {}) {
      const id = `bfor${uid}-o${++optionSeq}`;
      const selected = state.value !== '' && state.value === item.id;
      const badges = badgesOf(item);
      const reasons = (item.reasons || []).map((r) => r.text).join(' · ');
      const subtitle = item.group === 'router' ? 'O OpenRouter sorteia um modelo gratuito a cada pedido.' : item.id;
      return el('div', {
        class: `bfor-opt${dim ? ' is-dim' : ''}${item.expired ? ' is-disabled' : ''}`,
        role: 'option', id, title: item.group === 'router' ? ROUTER_ID : undefined, 'aria-selected': String(selected), 'aria-disabled': item.expired ? 'true' : undefined,
        dataset: { model: item.id, group: item.group },
        onclick: () => choose(item, id)
      },
      el('span', { class: 'bfor-mark', 'aria-hidden': 'true' }),
      el('span', { class: 'bfor-opt-body' },
        el('span', { class: 'bfor-opt-top' },
          el('span', { class: 'bfor-name' }, item.name),
          badges.length ? el('span', { class: 'bfor-badges' }, badges.map((b) => chip(b.text, b.kind))) : null),
        el('span', { class: 'bfor-sub small' }, subtitle),
        reasons ? el('span', { class: 'bfor-reasons small' }, reasons) : null,
        item.group === 'paid' && item.price ? el('span', { class: 'bfor-price small' }, formatPrice(item.price)) : null));
    }

    function groupNode(title, children) {
      const titleId = `bfor${uid}-g${++optionSeq}`;
      return el('div', { class: 'bfor-group', role: 'group', 'aria-labelledby': titleId },
        el('div', { class: 'bfor-group-title', id: titleId }, title),
        children);
    }

    function note(iconName, title, text) {
      return el('div', { class: 'empty-state bfor-empty' },
        el('span', { class: 'empty-state-icon material-symbols-rounded', 'aria-hidden': 'true' }, iconName),
        el('div', { class: 'empty-state-text' }, el('strong', {}, title), el('p', {}, text)));
    }

    // ----- desenho -----

    function render() {
      const data = state.data;
      const items = data && Array.isArray(data.list) ? data.list : [];
      const router = items.find((x) => x.group === 'router') || { id: ROUTER_ID, name: 'Automático — roteador gratuito', group: 'router', isFree: true, reasons: [] };
      const free = items.filter((x) => x.group === 'free');
      const others = items.filter((x) => x.group === 'otherFree');
      const paid = items.filter((x) => x.group === 'paid');
      const offline = Boolean(data) && data.source === 'nenhum';
      const hadFocus = root.contains(document.activeElement) ? document.activeElement : null;
      const activeModel = hadFocus && hadFocus.getAttribute ? activeModelOf(hadFocus) : null;

      root.dataset.state = state.loading && !data ? 'loading' : (offline || state.error ? 'error' : 'ready');
      root.setAttribute('aria-busy', String(state.loading));
      ui.switch.checked = state.freeOnly;
      ui.switchHint.textContent = state.freeOnly ? 'Os modelos pagos ficam escondidos e são recusados.' : 'Desligado: a lista inclui modelos pagos.';
      ui.cost.hidden = state.freeOnly;
      ui.searchRow.hidden = state.freeOnly;
      ui.refresh.disabled = state.loading || state.disabled;
      ui.switch.disabled = state.disabled;
      ui.search.disabled = state.disabled;
      root.classList.toggle('is-disabled', state.disabled);
      root.inert = state.disabled;
      ui.refresh.classList.toggle('is-loading', state.loading);
      ui.refresh.querySelector('.bfor-refresh-label').textContent = state.loading && data ? 'Atualizando…' : 'Atualizar lista';

      // linha de estado: data da lista, falta de conexão ou erro
      const status = ui.status;
      status.className = 'bfor-status small';
      let statusIcon = 'schedule';
      let statusText = '';
      if (state.loading && !data) {
        statusIcon = 'hourglass_top';
        statusText = 'Carregando a lista de modelos…';
      } else if (state.error) {
        status.classList.add('is-bad');
        statusIcon = 'error';
        statusText = state.error;
      } else if (data && data.source === 'nenhum') {
        status.classList.add('is-warn');
        statusIcon = 'cloud_off';
        statusText = data.error && data.error.message ? data.error.message : 'Não foi possível baixar a lista de modelos.';
      } else if (data && data.source === 'cache-antigo') {
        status.classList.add('is-warn');
        statusIcon = 'cloud_off';
        statusText = `Sem conexão com o OpenRouter: mostrando a lista de ${formatWhen(data.fetchedAt)}.`;
      } else if (data) {
        statusText = `Lista de ${formatWhen(data.fetchedAt)}`;
      }
      status.replaceChildren(icon(statusIcon), el('span', {}, statusText));
      status.title = data && data.error ? data.error.message : '';

      // grupo "Modelos gratuitos" (dentro da lista principal, logo abaixo do roteador)
      let freeContent;
      if (state.loading && !data) {
        freeContent = el('div', { class: 'bfor-loading', role: 'status' }, el('progress', { 'aria-label': 'Carregando a lista de modelos' }), el('span', { class: 'muted small' }, 'Carregando os modelos gratuitos…'));
      } else if (offline || (state.error && !data)) {
        freeContent = note('cloud_off', 'Lista indisponível', 'O roteador gratuito acima funciona sem a lista. Quando a conexão voltar, use "Atualizar lista".');
      } else if (!free.length) {
        freeContent = state.query
          ? note('search_off', 'Nenhum modelo encontrado', `Nada na lista combina com "${state.query}".`)
          : note('inbox', 'Nenhum modelo gratuito adequado', 'Hoje não há modelo gratuito que atenda à análise. Use o roteador acima ou veja "Outros gratuitos".');
      } else {
        freeContent = free.map((item) => optionNode(item));
      }
      ui.main.replaceChildren(optionNode(router), groupNode('Modelos gratuitos', freeContent));

      ui.othersFold.hidden = !others.length;
      ui.othersFold.open = state.othersOpen;
      ui.othersTitle.textContent = `Outros gratuitos (${others.length})`;
      ui.othersList.replaceChildren(...others.map((item) => optionNode(item, { dim: true })));

      ui.paidFold.hidden = state.freeOnly || (!paid.length && !state.query);
      ui.paidFold.open = state.paidOpen;
      ui.paidTitle.textContent = `Pagos (${paid.length})`;
      ui.paidList.replaceChildren(...(paid.length ? paid.map((item) => optionNode(item)) : [note('search_off', 'Nenhum modelo pago encontrado', state.query ? `Nada na lista combina com "${state.query}".` : 'A lista não trouxe modelos pagos.')]));

      // aviso: o modelo guardado não está mais na lista (expirou, foi removido, ou é pago com o interruptor ligado)
      const known = items.some((x) => x.id === state.value);
      const mustWarn = Boolean(state.value) && Boolean(data) && !offline && !state.query && !known;
      ui.valueNote.hidden = !mustWarn;
      if (mustWarn) {
        ui.valueNote.textContent = `O modelo escolhido (${state.value}) não está na lista${state.freeOnly ? ' de modelos gratuitos' : ''} agora. Escolha outro ou use "Atualizar lista".`;
      }
      ui.routerHint.hidden = state.value !== ROUTER_ID;
      restoreActive(activeModel, hadFocus);
    }

    // ----- teclado e foco (listbox com aria-activedescendant) -----

    const byId = (id) => (id ? root.querySelector(`[id="${id}"]`) : null);
    const enabledOptions = (box) => [...box.querySelectorAll('[role="option"]:not([aria-disabled="true"])')];

    function activeModelOf(node) {
      const box = node.closest ? node.closest('[role="listbox"]') : null;
      if (!box) return null;
      const option = byId(box.getAttribute('aria-activedescendant'));
      return option ? { box: box.dataset.list, model: option.dataset.model } : null;
    }

    function setActive(box, option, { scroll = true } = {}) {
      for (const node of box.querySelectorAll('.is-active')) node.classList.remove('is-active');
      if (!option) { box.removeAttribute('aria-activedescendant'); return; }
      option.classList.add('is-active');
      box.setAttribute('aria-activedescendant', option.id);
      if (scroll && typeof option.scrollIntoView === 'function') option.scrollIntoView({ block: 'nearest' });
    }

    function restoreActive(previous, hadFocus) {
      if (!previous) return;
      const box = { main: ui.main, others: ui.othersList, paid: ui.paidList }[previous.box];
      if (!box) return;
      const option = [...box.querySelectorAll('[role="option"]')].find((o) => o.dataset.model === previous.model) || enabledOptions(box)[0];
      setActive(box, option, { scroll: false });
      if (hadFocus && hadFocus.isConnected === false && typeof box.focus === 'function') box.focus({ preventScroll: true });
    }

    let typed = '';
    let typedAt = 0;

    function onKeyDown(event) {
      const box = event.currentTarget;
      const options = enabledOptions(box);
      if (!options.length) return;
      const current = options.findIndex((o) => o.id === box.getAttribute('aria-activedescendant'));
      let next = current;
      if (event.key === 'ArrowDown') next = Math.min(options.length - 1, current + 1);
      else if (event.key === 'ArrowUp') next = Math.max(0, current < 0 ? 0 : current - 1);
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = options.length - 1;
      else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (current >= 0) options[current].click();
        return;
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // digitar o começo do nome vai para o próximo modelo que começa assim
        const now = Date.now();
        typed = now - typedAt > 700 ? event.key.toLowerCase() : typed + event.key.toLowerCase();
        typedAt = now;
        const start = typed.length === 1 ? current + 1 : Math.max(0, current);
        const ordered = [...options.slice(start), ...options.slice(0, start)];
        const hit = ordered.find((o) => o.querySelector('.bfor-name').textContent.toLowerCase().startsWith(typed));
        if (hit) { setActive(box, hit); event.preventDefault(); }
        return;
      } else return;
      event.preventDefault();
      setActive(box, options[Math.max(0, next)]);
    }

    function onFocus(event) {
      const box = event.currentTarget;
      if (byId(box.getAttribute('aria-activedescendant'))) return;
      const options = enabledOptions(box);
      setActive(box, options.find((o) => o.getAttribute('aria-selected') === 'true') || options[0], { scroll: false });
    }

    for (const box of [ui.main, ui.othersList, ui.paidList]) {
      box.addEventListener('keydown', onKeyDown);
      box.addEventListener('focus', onFocus);
    }

    // ----- ações -----

    function choose(item, optionId) {
      if (item.expired || state.disabled) return;
      const node = byId(optionId);
      const box = node ? node.closest('[role="listbox"]') : null;
      if (box) { box.focus({ preventScroll: true }); setActive(box, node, { scroll: false }); }
      if (state.value === item.id) return;
      state.value = item.id;
      for (const option of root.querySelectorAll('[role="option"]')) option.setAttribute('aria-selected', String(option.dataset.model === item.id));
      ui.valueNote.hidden = true;
      ui.routerHint.hidden = item.id !== ROUTER_ID;
      if (typeof onChange === 'function') {
        try { onChange(item.id); } catch (err) { console.error('aiOpenRouter: onChange falhou', err); }
      }
    }

    function setFreeOnly(next, { notify = false } = {}) {
      const wanted = next !== false;
      if (wanted === state.freeOnly && !notify) return;
      state.freeOnly = wanted;
      if (wanted) { state.query = ''; ui.search.value = ''; }
      load();
      if (notify && typeof onFreeOnlyChange === 'function') {
        try { onFreeOnlyChange(wanted); } catch (err) { console.error('aiOpenRouter: onFreeOnlyChange falhou', err); }
      }
    }

    function setValue(next) {
      state.value = typeof next === 'string' ? next : '';
      for (const option of root.querySelectorAll('[role="option"]')) option.setAttribute('aria-selected', String(state.value !== '' && option.dataset.model === state.value));
      render();
    }

    const searchSoon = BF.util.debounce(() => {
      const query = ui.search.value.trim();
      if (query === state.query) return;
      state.query = query;
      load();
    }, SEARCH_DELAY_MS);

    async function load({ refresh = false } = {}) {
      const seq = ++state.seq;
      state.loading = true;
      render();
      const res = await BF.api('aiOpenrouter:models', { refresh, freeOnly: state.freeOnly, query: state.query });
      if (seq !== state.seq) return; // chegou depois de outra consulta mais nova
      state.loading = false;
      if (res && res.ok !== false && Array.isArray(res.list)) {
        state.data = res;
        state.error = null;
      } else {
        state.error = (res && res.message) || 'Não foi possível carregar a lista de modelos.';
      }
      render();
    }

    root.bfPicker = {
      setValue,
      setFreeOnly: (next) => setFreeOnly(next, { notify: false }),
      refresh: () => load({ refresh: true }),
      reload: () => load(),
      setDisabled: (flag) => { const next = Boolean(flag); if (next !== state.disabled) { state.disabled = next; render(); } },
      focus: () => ui.main.focus(),
      state: () => ({ value: state.value, freeOnly: state.freeOnly, query: state.query, loading: state.loading, disabled: state.disabled, source: state.data ? state.data.source : null })
    };

    render();
    load();
    return root;
  }

  // ---------- o selo de pedidos gratuitos restantes ----------

  function createLimitsChip({ refreshMs = LIMITS_REFRESH_MS } = {}) {
    const badge = el('span', { class: 'bds-chip' });
    const root = el('div', { class: 'bfor-limits', role: 'status', 'aria-live': 'polite', hidden: true }, badge);
    let timer = null;
    let wasConnected = false;
    let idleTicks = 0;
    let seq = 0;

    const count = (n) => Number(n).toLocaleString('pt-BR');

    function paint(res) {
      if (!res || (res.ok === false && res.code === 'NO_KEY')) { root.hidden = true; return; }
      root.hidden = false;
      root.title = '';
      if (res.ok === false) {
        badge.className = 'bds-chip bds-chip-warn';
        badge.replaceChildren(icon('info'), res.code === 'AUTH' ? 'O OpenRouter recusou a chave' : 'Pedidos gratuitos restantes indisponíveis');
        root.title = res.message || '';
        return;
      }
      const day = res.freeDaily;
      if (!day) {
        badge.className = 'bds-chip';
        badge.replaceChildren(icon('info'), 'O OpenRouter não informou o contador de pedidos gratuitos');
        return;
      }
      const left = day.remaining;
      const kind = left <= 0 ? 'bad' : (day.limit > 0 && left / day.limit <= 0.2 ? 'warn' : 'ok');
      badge.className = `bds-chip bds-chip-${kind}`;
      const text = left <= 0
        ? `Acabaram os ${count(day.limit)} pedidos gratuitos de hoje`
        : `${left === 1 ? 'Resta' : 'Restam'} ${count(left)} de ${count(day.limit)} ${left === 1 ? 'pedido gratuito' : 'pedidos gratuitos'} hoje`;
      badge.replaceChildren(icon(left <= 0 ? 'block' : 'bolt'), `${text}${res.resetText ? ` · ${res.resetText}` : ''}`);
      // chaves temporárias expiram (o OpenRouter informa `expires_at`): o horário vai na dica do selo, sem poluir a tela
      const expires = res.expiresAt ? formatWhen(res.expiresAt) : '';
      root.title = `Contagem do OpenRouter, com o dia em UTC. Com US$ 10 em créditos o limite diário sobe para 1.000 pedidos.${expires ? ` Esta chave expira em ${expires}.` : ''}`;
    }

    async function refresh({ force = false } = {}) {
      const mine = ++seq;
      const res = await BF.api('aiOpenrouter:limits', force ? { refresh: true } : {});
      if (mine === seq) paint(res);
      return res;
    }

    function stop() { if (timer !== null) { clearInterval(timer); timer = null; } }

    timer = setInterval(() => {
      if (!root.isConnected) { idleTicks += 1; if (wasConnected || idleTicks >= 3) stop(); return; }
      wasConnected = true;
      refresh();
    }, refreshMs);
    refresh();

    root.refresh = refresh;
    root.destroy = stop;
    return root;
  }

  BF.aiOpenRouter = {
    ROUTER_ID,
    createModelPicker,
    createLimitsChip,
    format: { context: formatContext, day: formatDay, when: formatWhen, money: formatMoney, price: formatPrice, badges: badgesOf, plural }
  };
})();

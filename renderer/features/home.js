'use strict';

/**
 * Tela "Início" (aba `home`; tela larga, funciona sem vídeo aberto e é a aba inicial): boas-vindas, atalhos e os projetos recentes.
 *   - Boas-vindas: "Bem-vindo de volta!" (ou "Bem-vindo ao <nome do app>!" enquanto não há nenhum projeto). O app não tem perfil de usuário,
 *     então a saudação não leva nome.
 *   - Busca: enquanto se digita, mostra os projetos que casam (título, canal ou jogo: o mesmo critério da aba Projetos, de onde vem
 *     BF.projects.matchesQuery); Enter (ou "Ver todos os resultados") abre a aba Projetos já com o texto.
 *   - Atalhos: "Novo projeto" (a tela de escolher de onde vem o vídeo) e "Continuar de onde parou" (o projeto mais recente cujo vídeo ainda existe).
 *     "Abrir vídeo" já mora no cabeçalho de todas as abas e por isso não se repete aqui.
 *   - Projetos recentes: os mais recentes, com miniatura, estado e número de cortes; "Abrir" (ou "Continuar", se já é o projeto aberto) retoma
 *     de onde parou e leva para Cortes. "Ver todos" abre a aba Projetos, onde ficam filtros, ordem, "Localizar vídeo…" e a lixeira.
 * Dados: project:list e project:thumbnail (os mesmos da aba Projetos, que carrega antes deste arquivo e empresta os pequenos auxiliares).
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;

  const RECENT = 3; // projetos mostrados sem busca (cabem na janela padrão sem rolar, junto com as boas-vindas)
  const RESULTS = 6; // resultados mostrados com busca
  const RETRY_MS = 60000; // miniatura que não saiu só é pedida de novo depois disto

  const S = { list: null, error: null, query: '', busyId: null, thumbs: new Map() };
  let root = null;
  let box = {};
  let seq = 0;

  const icon = (name, cls) => el('span', { class: `material-symbols-rounded${cls ? ` ${cls}` : ''}`, 'aria-hidden': 'true' }, name);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const lib = () => BF.projects; // stateOf, nameOf, duration, ago, matchesQuery, typeIcon, thumbKey, search (features/projects.js)
  const appName = () => (BF.state.app && BF.state.app.name) || 'Braga Frame';
  const byUpdated = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  const TAGLINE = 'Seus projetos, cortes e exportações em um só lugar.';

  /** A saudação e a frase embaixo dela, conforme o que já existe. */
  function greeting() {
    if (S.list === null) return { title: 'Bem-vindo!', text: TAGLINE };
    if (!S.list.length) return { title: `Bem-vindo ao ${appName()}!`, text: 'Comece trazendo um vídeo: arraste o arquivo para a janela ou use Novo projeto.' };
    return { title: 'Bem-vindo de volta!', text: TAGLINE };
  }

  /** O que a lista mostra agora: os recentes, ou os resultados da busca (de TODOS os projetos). */
  function shown() {
    const all = [...(S.list || [])].sort(byUpdated);
    const query = S.query.trim();
    if (!query) return { searching: false, total: all.length, items: all.slice(0, RECENT) };
    const found = all.filter((p) => lib().matchesQuery(p, query));
    return { searching: true, total: found.length, items: found.slice(0, RESULTS) };
  }

  // ---------- miniaturas ----------

  const thumbKey = (p) => lib().thumbKey(p);

  function thumbImage(p, url) {
    const img = el('img', { src: url, alt: '', draggable: 'false' });
    img.addEventListener('error', () => { // o arquivo da miniatura sumiu: volta ao ícone e deixa a próxima rodada pedir de novo
      S.thumbs.delete(thumbKey(p));
      const node = img.parentElement;
      if (node) { node.classList.remove('has-image'); node.replaceChildren(icon(lib().typeIcon(p))); }
    });
    return img;
  }

  const playMark = () => el('span', { class: 'prj-play', 'aria-hidden': 'true' }, icon('play_arrow'));

  function paintThumb(p) {
    const info = S.thumbs.get(thumbKey(p));
    const card = box.list && box.list.querySelector(`[data-id="${p.id}"]`);
    const node = card && card.querySelector('.prj-thumb');
    if (!node || !info || info.state !== 'ready') return;
    node.replaceChildren(thumbImage(p, info.url), playMark());
    node.classList.add('has-image');
  }

  async function fetchThumb(p) {
    const res = await BF.api('project:thumbnail', { id: p.id, path: p.source.path, size: p.source.size || 0, duration: p.source.duration || 0 });
    S.thumbs.set(thumbKey(p), res.ok && res.state === 'ready' ? { state: 'ready', url: res.url } : { state: res.ok ? res.state : 'none', at: Date.now() });
    paintThumb(p);
  }

  /** Pede a miniatura dos cartões que aparecem agora (poucos: no máximo RESULTS); o processo principal enfileira e reaproveita o que já tem. */
  function wantThumbs(list) {
    for (const p of list) {
      const known = S.thumbs.get(thumbKey(p));
      if (known && (known.state === 'ready' || known.state === 'loading' || Date.now() - (known.at || 0) < RETRY_MS)) continue;
      S.thumbs.set(thumbKey(p), { state: 'loading' });
      fetchThumb(p).catch(() => {});
    }
  }

  function thumbNode(p) {
    const info = S.thumbs.get(thumbKey(p));
    const ready = info && info.state === 'ready';
    return el('button', {
      type: 'button', class: `prj-thumb${ready ? ' has-image' : ''}`, dataset: { act: 'thumb' }, disabled: Boolean(p.fileMissing || S.busyId),
      title: p.fileMissing ? 'Vídeo não encontrado' : 'Abrir o projeto', 'aria-label': `Abrir o projeto ${lib().nameOf(p)}`,
      onclick: () => openProject(p)
    }, ready ? [thumbImage(p, info.url), playMark()] : [icon(lib().typeIcon(p))]);
  }

  // ---------- ações ----------

  async function openProject(p) {
    if (S.busyId || p.fileMissing) return;
    S.busyId = p.id;
    drawList();
    const res = await BF.openSource(p.source.path, p.source.origin || null);
    S.busyId = null;
    if (res && res.ok === false && !res.canceled) BF.ui.toast(res.message || 'Não foi possível abrir o projeto.', 'error');
    else if (res && res.ok !== false) BF.ui.selectTab('cuts');
    drawList();
  }

  /** O projeto que "Continuar de onde parou" abre: o mais recente cujo vídeo ainda existe. */
  const resumable = () => [...(S.list || [])].sort(byUpdated).find((p) => !p.fileMissing) || null;

  function resume() {
    const p = resumable();
    if (p) openProject(p);
  }

  /** Abre a aba Projetos com o texto da busca (ou sem ele). */
  function showAll(query = S.query) {
    lib().search(String(query || '').trim());
    BF.ui.selectTab('projects');
  }

  function clearSearch() {
    S.query = '';
    if (box.search) box.search.value = '';
    drawList();
  }

  // ---------- desenho ----------

  function source(o) {
    if (o.type === 'vod') return o.platform === 'twitch' ? 'Twitch' : (o.platform === 'youtube' ? 'YouTube' : '');
    return o.type === 'obs' ? 'OBS' : '';
  }

  function card(p) {
    const st = lib().stateOf(p);
    const o = (p.source && p.source.origin) || {};
    const name = lib().nameOf(p);
    const current = Boolean(BF.state.project && BF.state.project.source && BF.state.project.source.path === p.source.path);
    const subtitle = [source(o), o.channel || (p.meta && p.meta.channel), o.game || (p.meta && p.meta.game), lib().duration(p.source && p.source.duration)].filter(Boolean).join(' · ');
    const openLabel = S.busyId === p.id ? 'Abrindo…' : (current ? 'Continuar' : 'Abrir');
    return el('li', { class: `prj-card${p.fileMissing ? ' missing' : ''}`, dataset: { id: p.id, state: st.id } },
      thumbNode(p),
      el('div', { class: 'prj-info' },
        el('div', { class: 'prj-title', title: name }, name),
        subtitle ? el('div', { class: 'muted small prj-sub' }, subtitle) : null,
        el('div', { class: 'prj-chips' },
          el('span', { class: `bds-chip ${st.tone}`, title: st.hint }, st.label),
          p.cutCount ? el('span', { class: 'bds-chip' }, plural(p.cutCount, 'corte', 'cortes')) : null,
          current ? el('span', { class: 'bds-chip bds-chip-accent' }, 'Aberto agora') : null,
          p.fileMissing ? el('span', { class: 'bds-chip bds-chip-bad', title: p.source.path }, 'Vídeo não encontrado') : null),
        el('div', { class: 'muted small' }, `Alterado ${lib().ago(p.updatedAt)}`)),
      el('div', { class: 'prj-actions' },
        p.fileMissing
          ? el('button', { type: 'button', class: 'secondary sm', dataset: { act: 'resolve' }, title: 'Em Projetos dá para localizar o vídeo', onclick: () => showAll(name) }, 'Ver em Projetos')
          : el('button', { type: 'button', class: 'secondary sm', dataset: { act: 'open' }, disabled: Boolean(S.busyId), onclick: () => openProject(p) }, openLabel)));
  }

  /** A saudação muda (carregando, sem projetos, com projetos) e o atalho de continuar some ou aparece: só o necessário é trocado, para o campo de busca não perder o foco. */
  function drawHero() {
    if (!box.title) return;
    const hello = greeting();
    if (box.title.textContent !== hello.title) box.title.textContent = hello.title;
    if (box.lead.textContent !== hello.text) box.lead.textContent = hello.text;
    const next = resumable();
    box.resume.hidden = !next;
    box.resume.title = next ? `Abrir “${lib().nameOf(next)}”` : '';
    box.resume.disabled = Boolean(S.busyId);
  }

  function drawList() {
    if (!box.list) return;
    drawHero();
    if (S.error) {
      box.all.hidden = true;
      box.heading.textContent = 'Projetos recentes';
      box.list.replaceChildren(el('li', { class: 'home-note' }, el('div', { class: 'empty-state' }, icon('error', 'empty-state-icon'),
        el('div', { class: 'empty-state-text' }, el('strong', {}, 'Não foi possível listar os projetos'), el('p', {}, S.error)))));
      return;
    }
    if (S.list === null) {
      box.all.hidden = true;
      box.heading.textContent = 'Projetos recentes';
      box.list.replaceChildren(el('li', { class: 'muted home-note' }, 'Carregando…'));
      return;
    }
    if (!S.list.length) {
      box.all.hidden = true;
      box.heading.textContent = 'Projetos recentes';
      box.list.replaceChildren(el('li', { class: 'home-note' }, el('div', { class: 'empty-state home-empty' }, icon('folder_special', 'empty-state-icon'),
        el('div', { class: 'empty-state-text' },
          el('strong', {}, 'Nenhum projeto ainda'),
          el('p', {}, 'Cada vídeo que você abrir vira um projeto, e ele aparece aqui para você continuar depois.')))));
      return;
    }
    const view = shown();
    box.heading.textContent = view.searching ? `Resultados (${view.total})` : 'Projetos recentes';
    box.all.hidden = view.searching && view.total === 0;
    box.allLabel.textContent = view.searching ? 'Ver todos os resultados' : 'Ver todos';
    const cards = view.items.map(card);
    box.list.replaceChildren(...(cards.length ? cards : [el('li', { class: 'muted home-note' }, `Nenhum projeto encontrado para “${S.query.trim()}”.`)]));
    wantThumbs(view.items.filter((p) => !p.fileMissing));
  }

  const draw = drawList; // a saudação e o atalho acompanham a lista: drawList os atualiza

  function build() {
    box.title = el('h2', { class: 'home-title' }, greeting().title);
    box.lead = el('p', { class: 'home-lead' }, greeting().text);
    box.search = el('input', {
      type: 'text', class: 'home-search-input', placeholder: 'Buscar por título, canal ou jogo…', 'aria-label': 'Buscar projetos', autocomplete: 'off', spellcheck: 'false',
      dataset: { act: 'search' },
      oninput: (event) => { S.query = event.target.value; drawList(); },
      onkeydown: (event) => {
        if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); showAll(); }
        else if (event.key === 'Escape' && S.query) { event.preventDefault(); clearSearch(); }
      }
    });
    box.resume = el('button', { type: 'button', class: 'secondary', dataset: { act: 'resume' }, hidden: true, onclick: resume }, icon('play_arrow'), 'Continuar de onde parou');
    box.heading = el('h3', {}, 'Projetos recentes');
    box.allLabel = el('span', {}, 'Ver todos');
    box.all = el('button', { type: 'button', class: 'link home-all', dataset: { act: 'all' }, onclick: () => showAll() }, box.allLabel, icon('arrow_forward'));
    box.list = el('ul', { class: 'prj-list' });
    return el('div', { class: 'home' },
      el('section', { class: 'home-hero', 'aria-label': 'Boas-vindas' },
        el('div', { class: 'home-hero-text' }, box.title, box.lead),
        el('div', { class: 'home-search' }, icon('search', 'home-search-icon'), box.search),
        el('div', { class: 'home-actions' },
          el('button', { type: 'button', class: 'primary', dataset: { act: 'new' }, onclick: () => BF.ui.selectTab('sources') }, icon('add'), 'Novo projeto'),
          box.resume)),
      el('section', { class: 'home-recent', 'aria-label': 'Projetos recentes' },
        el('div', { class: 'home-section-head' }, box.heading, box.all),
        box.list));
  }

  async function refresh() {
    const mine = ++seq;
    const res = await BF.api('project:list', {});
    if (mine !== seq) return;
    if (!res.ok) { S.error = res.message || 'Erro desconhecido.'; S.list = null; } else { S.error = null; S.list = res.projects || []; }
    draw();
  }

  BF.ui.registerTab({
    id: 'home',
    title: 'Início',
    order: 1, // a primeira do menu e a que abre sem vídeo
    icon: 'home',
    render(container) {
      root = build();
      container.append(root);
      draw();
      refresh();
    },
    onShow() { // cada visita começa limpa: a busca de antes (inclusive a que foi continuada em Projetos) não fica esperando aqui
      S.query = '';
      if (box.search) box.search.value = '';
      refresh();
    }
  });

  // abrir um vídeo cria ou muda um projeto; cortes decididos mudam os números: a lista acompanha quando está à vista, sem pedir a cada alteração
  let timer = null;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { const panel = root && root.closest('.tabpanel'); if (panel && !panel.hidden) refresh(); }, 600);
  };
  BF.bus.on('project:loaded', () => refresh());
  BF.bus.on('project:changed', later);
  BF.bus.on('tools:changed', () => { // o ffmpeg apareceu (ou mudou): as miniaturas que falharam por falta dele podem ser pedidas de novo
    for (const [key, info] of S.thumbs) if (info.state !== 'ready' && info.state !== 'loading') S.thumbs.delete(key);
    if (box.list && S.list) drawList();
  });

  BF.home = { refresh, state: S, greeting, shown };
})();

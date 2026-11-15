'use strict';

/**
 * Aba "Projetos" (tela larga, funciona sem vídeo aberto): lista os vídeos que já têm projeto, para o usuário saber o que já foi feito e retomar
 * com um clique, em vez de procurar o arquivo. Cada cartão mostra a MINIATURA do vídeo (um quadro tirado neste computador), o estado (Novo, Em
 * revisão, Pronto para exportar, Exportado), os números de cortes, a data da última alteração e avisa se o arquivo do vídeo foi movido ou apagado
 * (com "Localizar vídeo…" para reaproveitar os cortes no arquivo novo). A LIXEIRA apaga o projeto: a confirmação diz o que sai; com a caixa marcada
 * (padrão) saem também os cortes exportados e o vídeo e o chat que o PRÓPRIO app baixou. O vídeo que o usuário trouxe nunca é apagado.
 * Dados: project:list (resumo; o projeto completo só é lido ao abrir), project:thumbnail, project:deletePreview e project:delete.
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;

  const S = { list: null, error: null, query: '', filter: 'all', sort: 'recent', busyId: null, thumbs: new Map() };
  let root = null;
  let box = {};
  let seq = 0;

  const icon = (name, cls) => el('span', { class: `material-symbols-rounded${cls ? ` ${cls}` : ''}`, 'aria-hidden': 'true' }, name);
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const joinList = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`);

  function nameOf(p) {
    const o = p.source && p.source.origin;
    if (o && o.title) return o.title;
    const file = String((p.source && p.source.path) || '').split(/[\\/]/).pop() || 'Vídeo';
    return file.replace(/\.[^.]+$/, '').replace(/\s*\[[\w-]{6,}\]$/, '');
  }

  function duration(sec) {
    const s = Math.round(Number(sec) || 0);
    if (!s) return '';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
  }

  function ago(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const min = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (min < 1) return 'agora mesmo';
    if (min < 60) return `há ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `há ${h} h`;
    const d = Math.round(h / 24);
    if (d < 30) return d === 1 ? 'ontem' : `há ${d} dias`;
    return new Date(t).toLocaleDateString('pt-BR');
  }

  /** "340 MB", "1,2 GB" (vírgula decimal, uma casa abaixo de 100). */
  function fmtBytes(n) {
    const b = Math.max(0, Number(n) || 0);
    if (b < 1024) return `${Math.round(b)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = b / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
    return `${value.toFixed(value >= 100 ? 0 : 1).replace('.', ',')} ${units[i]}`;
  }

  /** Estado do trabalho no vídeo, em uma expressão. */
  function stateOf(p) {
    const c = p.counts || { pending: 0, approved: 0, rejected: 0 };
    const exported = p.exportedCount || 0;
    if (!p.cutCount) return { id: 'new', label: 'Novo', tone: '', hint: 'Ainda sem cortes.' };
    if (exported >= p.cutCount) return { id: 'done', label: 'Exportado', tone: 'bds-chip-ok', hint: 'Todos os cortes já foram exportados.' };
    if (c.pending > 0) return { id: 'review', label: 'Em revisão', tone: 'bds-chip-info', hint: `${plural(c.pending, 'corte espera', 'cortes esperam')} decisão.` };
    if (c.approved > 0 && exported < c.approved) return { id: 'ready', label: 'Pronto para exportar', tone: 'bds-chip-warn', hint: `${plural(c.approved - exported, 'aprovado ainda sem exportar', 'aprovados ainda sem exportar')}.` };
    if (c.approved > 0) return { id: 'done', label: 'Exportado', tone: 'bds-chip-ok', hint: 'Todos os aprovados já foram exportados.' };
    return { id: 'review', label: 'Em revisão', tone: 'bds-chip-info', hint: 'Todos os cortes foram rejeitados.' };
  }

  const FILTERS = [['all', 'Todos'], ['review', 'Em revisão'], ['ready', 'Para exportar'], ['done', 'Exportados']];
  const SORTS = [['recent', 'Mais recentes'], ['oldest', 'Mais antigos'], ['name', 'Nome (A–Z)'], ['cuts', 'Mais cortes'], ['long', 'Mais longos']];

  function matchesFilter(p) {
    if (S.filter === 'all') return true;
    const id = stateOf(p).id;
    return S.filter === 'review' ? (id === 'review' || id === 'new') : id === S.filter;
  }

  const byUpdated = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  const SORTERS = {
    recent: byUpdated,
    oldest: (a, b) => -byUpdated(a, b),
    name: (a, b) => nameOf(a).localeCompare(nameOf(b), 'pt-BR', { sensitivity: 'base', numeric: true }) || byUpdated(a, b),
    cuts: (a, b) => ((b.cutCount || 0) - (a.cutCount || 0)) || byUpdated(a, b),
    long: (a, b) => ((Number(b.source && b.source.duration) || 0) - (Number(a.source && a.source.duration) || 0)) || byUpdated(a, b)
  };

  /** O projeto casa com o texto da busca (título, canal, jogo ou caminho do vídeo; sem acento nem maiúsculas)? Texto vazio casa com todos. */
  function matchesQuery(p, query) {
    const q = norm(query);
    if (!q) return true;
    const o = (p.source && p.source.origin) || {};
    return norm([nameOf(p), o.channel, o.game, p.meta && p.meta.game, p.meta && p.meta.channel, p.source && p.source.path].join(' ')).includes(q);
  }

  function visible() {
    const list = (S.list || []).filter((p) => matchesFilter(p) && matchesQuery(p, S.query));
    return list.sort(SORTERS[S.sort] || SORTERS.recent);
  }

  // ---------- miniaturas ----------

  const thumbKey = (p) => `${p.id}:${(p.source && p.source.size) || 0}:${Math.round((p.source && p.source.duration) || 0)}`;
  const RETRY_MS = 60000; // miniatura que não saiu (ffmpeg ausente, vídeo que não abre) só é pedida de novo depois disto
  const thumbQueue = [];
  let thumbActive = 0;

  function paintThumb(p) {
    const info = S.thumbs.get(thumbKey(p));
    const card = box.list && box.list.querySelector(`[data-id="${p.id}"]`);
    const node = card && card.querySelector('.prj-thumb');
    if (!node || !info || info.state !== 'ready') return;
    node.replaceChildren(thumbImage(p, info.url), playMark(p));
    node.classList.add('has-image');
  }

  async function fetchThumb(p) {
    const key = thumbKey(p);
    const res = await BF.api('project:thumbnail', { id: p.id, path: p.source.path, size: p.source.size || 0, duration: p.source.duration || 0 });
    S.thumbs.set(key, res.ok && res.state === 'ready' ? { state: 'ready', url: res.url } : { state: res.ok ? res.state : 'none', at: Date.now() });
    paintThumb(p);
  }

  function pumpThumbs() {
    while (thumbActive < 3 && thumbQueue.length) {
      const p = thumbQueue.shift();
      thumbActive += 1;
      fetchThumb(p).catch(() => {}).finally(() => { thumbActive -= 1; pumpThumbs(); });
    }
  }

  /** Pede a miniatura dos projetos que ainda não têm (um por vez no processo principal; aqui no máximo 3 pedidos juntos). */
  function wantThumbs(list) {
    for (const p of list) {
      const known = S.thumbs.get(thumbKey(p));
      if (known && (known.state === 'ready' || known.state === 'loading' || Date.now() - (known.at || 0) < RETRY_MS)) continue;
      S.thumbs.set(thumbKey(p), { state: 'loading' });
      thumbQueue.push(p);
    }
    pumpThumbs();
  }

  /** O ancestral que rola (a área de trabalho). É ele, e não a janela, quem esconde os cartões de baixo: a margem de antecipação tem de ser dele. */
  function scrollParentOf(node) {
    for (let n = node.parentElement; n; n = n.parentElement) {
      const overflow = window.getComputedStyle(n).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') return n;
    }
    return null;
  }

  // só os cartões que aparecem na tela (ou quase) pedem a miniatura; sem IntersectionObserver (testes) todos pedem
  let observer = null;
  function watch(card, p) {
    if (typeof IntersectionObserver !== 'function') { wantThumbs([p]); return; }
    if (!observer) {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          const found = (S.list || []).find((x) => x.id === entry.target.dataset.id);
          if (found) wantThumbs([found]);
        }
      }, { root: scrollParentOf(card), rootMargin: '240px' });
    }
    observer.observe(card);
  }

  const typeIcon = (p) => {
    const o = (p.source && p.source.origin) || {};
    return o.type === 'vod' ? 'smart_display' : (o.type === 'obs' ? 'videocam' : 'movie');
  };

  function thumbImage(p, url) {
    const img = el('img', { src: url, alt: '', draggable: 'false' });
    img.addEventListener('error', () => { // arquivo da miniatura sumiu: volta ao ícone e deixa a próxima rodada pedir de novo
      S.thumbs.delete(thumbKey(p));
      const node = img.parentElement;
      if (node) { node.classList.remove('has-image'); node.replaceChildren(icon(typeIcon(p))); }
    });
    return img;
  }

  const playMark = () => el('span', { class: 'prj-play', 'aria-hidden': 'true' }, icon('play_arrow'));

  function thumbNode(p) {
    const info = S.thumbs.get(thumbKey(p));
    const ready = info && info.state === 'ready';
    return el('button', {
      type: 'button', class: `prj-thumb${ready ? ' has-image' : ''}`, dataset: { act: 'thumb' }, disabled: Boolean(p.fileMissing || S.busyId),
      title: p.fileMissing ? 'Vídeo não encontrado' : 'Abrir o projeto', 'aria-label': `Abrir o projeto ${nameOf(p)}`,
      onclick: () => openProject(p)
    }, ready ? [thumbImage(p, info.url), playMark(p)] : [icon(typeIcon(p))]);
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

  async function locate(p) {
    const pick = await BF.api('source:pick', {}, { toast: true });
    if (!pick.ok || pick.canceled) return;
    const ok = await BF.ui.confirm({
      title: 'Usar este arquivo?',
      message: `Os cortes e decisões de “${nameOf(p)}” serão copiados para o arquivo escolhido. O projeto antigo continua guardado.`,
      okLabel: 'Usar este arquivo'
    });
    if (!ok) return;
    const res = await BF.api('project:adopt', { fromId: p.id, path: pick.path, origin: p.source.origin || null }, { toast: true });
    if (res.ok) {
      await refresh();
      await BF.openSource(pick.path, p.source.origin || null);
      BF.ui.selectTab('cuts');
    }
  }

  const reveal = (p) => BF.api('shell:reveal', { path: p.source.path });

  // ---------- apagar ----------

  /**
   * O texto da confirmação a partir do plano que o processo principal devolveu (project:deletePreview): { title, message, check }.
   * `check` (a caixa "Apagar também os arquivos do projeto") só existe quando há arquivos a apagar; null caso contrário.
   */
  function deleteDialog(plan, name, { missing = false } = {}) {
    const lines = [];
    if (plan.unreadable) lines.push('O arquivo deste projeto está danificado ou não pôde ser lido: só o que o app guardou dele será apagado.');
    else lines.push('O projeto sai da lista e tudo o que o app guardou dele é apagado: os cortes e as decisões, o histórico, a transcrição e a miniatura.');
    if (plan.keepsSource && plan.sourceName && !missing) lines.push(`O vídeo “${plan.sourceName}” não é apagado.`);
    lines.push('Isto não pode ser desfeito.');
    const parts = [];
    const exports = plan.exports || { files: 0, sidecars: 0, bytes: 0 };
    if (exports.files) parts.push(`${plural(exports.files, 'corte exportado', 'cortes exportados')}${exports.sidecars ? ` (e ${plural(exports.sidecars, 'legenda', 'legendas')} ao lado)` : ''}`);
    const video = plan.download && plan.download.video;
    const chat = plan.download && plan.download.chat;
    if (video) parts.push(`o vídeo baixado pelo app (${video.name})`);
    if (chat) parts.push('o chat baixado');
    const bytes = (exports.bytes || 0) + (video ? video.bytes : 0) + (chat ? chat.bytes : 0);
    return {
      title: `Apagar “${name}”?`,
      message: lines.join('\n\n'),
      check: parts.length ? { label: 'Apagar também os arquivos do projeto', hint: `${joinList(parts)} · ${fmtBytes(bytes)}`, checked: true } : null
    };
  }

  /** O aviso depois de apagar: { text, kind }. Quanto espaço voltou e, se algum arquivo resistiu, quais (o usuário apaga à mão). */
  function doneMessage(result) {
    const freed = result.removed && result.removed.bytes > 0 ? ` Liberou ${fmtBytes(result.removed.bytes)}.` : '';
    const failed = Array.isArray(result.failed) ? result.failed : [];
    let text = result.projectRemoved ? `Projeto apagado.${freed}` : `O projeto não pôde ser apagado por completo.${freed}`;
    if (failed.length) {
      const names = failed.slice(0, 3).map((f) => `“${f.name}”`).join(', ');
      text += ` ${failed.length === 1 ? 'Um arquivo não pôde ser removido' : `${failed.length} arquivos não puderam ser removidos`} (${failed[0].message}): ${names}${failed.length > 3 ? ' e outros' : ''}. Apague-${failed.length === 1 ? 'o' : 'os'} à mão.`;
    }
    return { text, kind: result.projectRemoved && !failed.length ? 'ok' : 'error' };
  }

  async function remove(p) {
    if (S.busyId) return;
    S.busyId = p.id;
    drawList();
    try {
      const preview = await BF.api('project:deletePreview', { id: p.id }, { toast: true });
      if (!preview.ok) return;
      const plan = preview.plan;
      if (plan.busy) { BF.ui.toast(plan.busy, 'error', 10000); return; }
      const dialog = deleteDialog(plan, nameOf(p), { missing: Boolean(p.fileMissing) });
      let withFiles = false;
      if (dialog.check) {
        const choice = await BF.ui.confirmCheck({ title: dialog.title, message: dialog.message, okLabel: 'Apagar projeto', cancelLabel: 'Manter', danger: true, check: dialog.check });
        if (!choice) return;
        withFiles = choice.checked;
      } else if (!(await BF.ui.confirm({ title: dialog.title, message: dialog.message, okLabel: 'Apagar projeto', cancelLabel: 'Manter', danger: true }))) {
        return;
      }
      // o projeto aberto está na memória, no player e na fila de gravação: tudo isso é solto ANTES de apagar (o Windows não apaga o vídeo que o
      // player lê, e uma gravação pendente recriaria o arquivo do projeto)
      const current = Boolean(BF.state.project && BF.state.project.id === p.id);
      if (current) {
        if (BF.review && BF.review.history && typeof BF.review.history.discard === 'function') await BF.review.history.discard(p.id);
        await BF.project.discard();
        BF.player.unload();
      }
      const res = await BF.api('project:delete', { id: p.id, files: withFiles });
      const message = res.ok ? doneMessage(res.result) : { text: res.message || 'Não foi possível apagar o projeto.', kind: 'error' };
      BF.ui.log(message.text, message.kind);
      if (current) { // a tela recomeça sem vídeo aberto (o projeto apagado não pode ficar na memória); o aviso espera a tela voltar
        BF.flash(message.text, message.kind);
        BF.restart();
        return;
      }
      BF.ui.toast(message.text, message.kind, message.kind === 'error' ? 12000 : 6000);
      S.thumbs.delete(thumbKey(p));
    } finally {
      S.busyId = null;
      await refresh();
    }
  }

  // ---------- desenho ----------

  function card(p) {
    const st = stateOf(p);
    const c = p.counts || {};
    const o = (p.source && p.source.origin) || {};
    const current = Boolean(BF.state.project && BF.state.project.source && BF.state.project.source.path === p.source.path);
    const subtitle = [o.channel || (p.meta && p.meta.channel), o.game || (p.meta && p.meta.game), duration(p.source && p.source.duration)].filter(Boolean).join(' · ');
    const chips = [
      c.pending ? el('span', { class: 'bds-chip' }, plural(c.pending, 'pendente', 'pendentes')) : null,
      c.approved ? el('span', { class: 'bds-chip bds-chip-ok' }, plural(c.approved, 'aprovado', 'aprovados')) : null,
      c.rejected ? el('span', { class: 'bds-chip' }, plural(c.rejected, 'rejeitado', 'rejeitados')) : null,
      p.exportedCount ? el('span', { class: 'bds-chip bds-chip-ok' }, plural(p.exportedCount, 'exportado', 'exportados')) : null
    ].filter(Boolean);
    const openLabel = S.busyId === p.id ? 'Abrindo…' : (current ? 'Continuar' : 'Abrir');
    const li = el('li', { class: `prj-card${p.fileMissing ? ' missing' : ''}`, dataset: { id: p.id, state: st.id } },
      thumbNode(p),
      el('div', { class: 'prj-info' },
        el('div', { class: 'prj-title', title: nameOf(p) }, nameOf(p)),
        subtitle ? el('div', { class: 'muted small prj-sub' }, subtitle) : null,
        el('div', { class: 'prj-chips' },
          el('span', { class: `bds-chip ${st.tone}`, title: st.hint }, st.label),
          current ? el('span', { class: 'bds-chip bds-chip-accent' }, 'Aberto agora') : null,
          p.fileMissing ? el('span', { class: 'bds-chip bds-chip-bad', title: p.source.path }, 'Vídeo não encontrado') : null,
          ...chips),
        el('div', { class: 'muted small' }, `Alterado ${ago(p.updatedAt)}`)),
      el('div', { class: 'prj-actions' },
        p.fileMissing
          ? el('button', { type: 'button', class: 'secondary sm', dataset: { act: 'locate' }, onclick: () => locate(p) }, 'Localizar vídeo…')
          : el('button', { type: 'button', class: 'secondary sm', dataset: { act: 'open' }, disabled: Boolean(S.busyId), onclick: () => openProject(p) }, openLabel),
        p.fileMissing ? null : el('button', { type: 'button', class: 'icon-btn', title: 'Mostrar o vídeo na pasta', 'aria-label': 'Mostrar o vídeo na pasta', dataset: { act: 'reveal' }, onclick: () => reveal(p) }, icon('folder_open')),
        el('button', {
          type: 'button', class: 'icon-btn prj-delete', title: 'Apagar o projeto', 'aria-label': `Apagar o projeto ${nameOf(p)}`, dataset: { act: 'delete' },
          disabled: Boolean(S.busyId), onclick: () => remove(p)
        }, icon('delete'))));
    return li;
  }

  function draw() {
    if (!root) return;
    if (S.error) {
      root.replaceChildren(box.head, el('div', { class: 'empty-state' }, icon('error', 'empty-state-icon'),
        el('div', { class: 'empty-state-text' }, el('strong', {}, 'Não foi possível listar os projetos'), el('p', {}, S.error))));
      return;
    }
    if (S.list === null) { root.replaceChildren(box.head, el('p', { class: 'muted' }, 'Carregando…')); return; }
    if (!S.list.length) {
      root.replaceChildren(box.head, el('div', { class: 'empty-state prj-empty' }, icon('folder_special', 'empty-state-icon'),
        el('div', { class: 'empty-state-text' },
          el('strong', {}, 'Nenhum projeto ainda'),
          el('p', {}, 'Cada vídeo que você abrir vira um projeto, e ele aparece aqui para você continuar depois. Use Novo projeto para começar.'))));
      return;
    }
    const search = el('input', { type: 'text', class: 'prj-search', placeholder: 'Buscar por título, canal ou jogo', value: S.query, 'aria-label': 'Buscar projetos', dataset: { act: 'search' } });
    search.addEventListener('input', () => { S.query = search.value; drawList(); });
    const tabs = el('div', { class: 'bds-tabs', role: 'group', 'aria-label': 'Filtrar por estado' },
      FILTERS.map(([id, label]) => el('button', { type: 'button', class: 'bds-tab', 'aria-pressed': String(S.filter === id), dataset: { filter: id }, onclick: () => { S.filter = id; draw(); } }, label)));
    const sort = el('select', { class: 'prj-sort', 'aria-label': 'Ordenar projetos', dataset: { act: 'sort' } },
      SORTS.map(([id, label]) => el('option', { value: id }, label)));
    sort.value = S.sort;
    sort.addEventListener('change', () => { S.sort = sort.value; drawList(); });
    box.count = el('p', { class: 'muted small prj-count' });
    box.list = el('ul', { class: 'prj-list' });
    root.replaceChildren(box.head, el('div', { class: 'prj-toolbar' }, search, tabs, sort), box.count, box.list);
    drawList();
  }

  function drawList() {
    if (!box.list || !S.list) return;
    const list = visible();
    if (observer) observer.disconnect(); // os cartões abaixo são novos: observa de novo
    const cards = list.map(card);
    box.list.replaceChildren(...(cards.length ? cards : [el('li', { class: 'muted prj-none' }, 'Nenhum projeto com esse filtro.')]));
    box.count.textContent = list.length === S.list.length ? plural(S.list.length, 'projeto', 'projetos') : `${list.length} de ${plural(S.list.length, 'projeto', 'projetos')}`;
    cards.forEach((node, i) => {
      const info = S.thumbs.get(thumbKey(list[i]));
      if (!info || info.state !== 'ready') watch(node, list[i]);
    });
  }

  async function refresh() {
    const mine = ++seq;
    const res = await BF.api('project:list', {});
    if (mine !== seq) return;
    if (!res.ok) { S.error = res.message || 'Erro desconhecido.'; S.list = null; } else { S.error = null; S.list = res.projects || []; }
    draw();
  }

  /** A busca da tela Início termina aqui: a lista de Projetos passa a mostrar este texto (sem filtro de estado) na próxima vez que aparecer. */
  function search(query) {
    S.query = String(query || '');
    S.filter = 'all';
    if (root && S.list) draw();
  }

  // stateOf, nameOf, duration, ago, matchesQuery e typeIcon também servem à tela Início (features/home.js), para os cartões serem os mesmos
  BF.projects = { refresh, search, stateOf, nameOf, duration, ago, matchesQuery, typeIcon, fmtBytes, deleteDialog, doneMessage, thumbKey };

  BF.ui.registerTab({
    id: 'projects',
    title: 'Projetos',
    order: 5,
    render(container) {
      box = {};
      box.head = el('div', { class: 'prj-head' },
        el('p', { class: 'prj-intro' }, 'Os vídeos em que você já trabalhou. Abra um para continuar de onde parou.'),
        el('button', { type: 'button', class: 'primary', dataset: { act: 'new' }, onclick: () => BF.ui.selectTab('sources') }, icon('add'), 'Novo projeto'));
      root = el('div', { class: 'projects' });
      container.append(root);
      draw();
      refresh();
    },
    onShow() { refresh(); }
  });

  // cortes criados ou decididos mudam os números: atualiza a lista quando ela está visível, sem pedir a cada tecla
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
})();

'use strict';

/**
 * Casca do app (dono: base): cabeçalho (título, vídeo aberto, "Abrir vídeo" e controles da janela), menu lateral
 * (recolher e tema), aviso de ferramentas ausentes, abrir/arrastar vídeo e a barra de marcação (início/fim, prévia e
 * "Salvar corte") abaixo do player.
 */
(function () {
  const BF = window.BF;
  const { el, fmt, parseTime, secs, nameOf } = BF.util;
  const $ = (id) => document.getElementById(id);

  // ---------- ferramentas ----------

  function renderToolsWarning() {
    const missing = ['ffmpeg', 'ffprobe'].filter((tool) => !BF.state.tools[tool]);
    const box = $('toolsWarn');
    box.hidden = missing.length === 0;
    if (!missing.length) { box.replaceChildren(); return; }
    box.replaceChildren(
      el('span', {}, `Não encontrado: ${missing.join(', ')}. Sem isso não é possível abrir ou exportar vídeos. Instale o FFmpeg com o botão ao lado, ou por conta própria e então clique em Verificar de novo (se mexeu no PATH, reabra o app).`),
      el('button', { type: 'button', class: 'primary sm', dataset: { act: 'install-ffmpeg' }, onclick: installFfmpeg }, 'Instalar o FFmpeg'),
      el('button', { type: 'button', onclick: recheckTools }, 'Verificar de novo')
    );
  }

  /** "Instalar o FFmpeg" do aviso: a aba Ferramentas faz o trabalho (confirmação, progresso, erros); sem ela (não deveria acontecer), só abre a aba. */
  async function installFfmpeg() {
    if (BF.tools && BF.tools.installFfmpeg) await BF.tools.installFfmpeg();
    else BF.ui.selectTab('tools');
  }

  async function recheckTools() {
    const res = await BF.api('app:refreshTools', {}, { toast: true });
    if (!res.ok) return;
    BF.state.tools = res.tools;
    renderToolsWarning();
    if (res.tools.ffmpeg && res.tools.ffprobe) BF.ui.toast('FFmpeg encontrado.', 'ok');
    else BF.ui.toast('O FFmpeg ainda não foi encontrado.', 'error');
  }

  // ---------- menu lateral: recolher (lembra a escolha), tema claro/escuro, janela estreita ----------

  const app = $('app');
  const sidebarButton = $('sidebarToggleBtn');
  const compactQuery = window.matchMedia('(max-width: 1000px)'); // janela pequena: o menu vira trilho de ícones sozinho
  let userCollapsed = BF.local.get('sidebarCollapsed', '0') === '1';

  function applyRail() {
    const forced = BF.embedded || compactQuery.matches;
    const collapsed = userCollapsed || forced;
    app.classList.toggle('collapsed', collapsed && !BF.embedded);
    sidebarButton.hidden = forced; // o botão só vale quando a escolha é do usuário
    sidebarButton.setAttribute('aria-expanded', String(!collapsed));
    sidebarButton.title = collapsed ? 'Expandir menu' : 'Recolher menu';
    sidebarButton.setAttribute('aria-label', sidebarButton.title);
    sidebarButton.firstElementChild.textContent = collapsed ? 'menu' : 'menu_open';
    $('brand').title = userCollapsed && !forced ? 'Expandir menu' : '';
    BF.ui.applyProjectMode(); // as dicas das abas mudam no trilho de ícones
  }

  /** Recolhe/expande o menu lateral e guarda a escolha. */
  BF.ui.setSidebarCollapsed = function setSidebarCollapsed(value) {
    userCollapsed = Boolean(value);
    BF.local.set('sidebarCollapsed', userCollapsed ? '1' : '0');
    applyRail();
  };
  sidebarButton.addEventListener('click', () => BF.ui.setSidebarCollapsed(true));
  // recolhido, a marca vira o botão de expandir (como no BDS)
  $('brand').addEventListener('click', (event) => { if (userCollapsed && !sidebarButton.contains(event.target)) BF.ui.setSidebarCollapsed(false); });
  compactQuery.addEventListener('change', applyRail);

  const themeButton = $('btnTheme');
  function showTheme(theme) {
    const toLight = theme !== 'light'; // o botão oferece o tema que NÃO está em uso
    themeButton.firstElementChild.textContent = toLight ? 'light_mode' : 'dark_mode';
    themeButton.querySelector('.sidebar-link-label').textContent = toLight ? 'Tema claro' : 'Tema escuro';
    themeButton.setAttribute('aria-label', toLight ? 'Usar tema claro' : 'Usar tema escuro');
    themeButton.title = toLight ? 'Usar tema claro' : 'Usar tema escuro';
  }
  /** Troca o tema ('dark' | 'light') e guarda a escolha. */
  BF.ui.setTheme = function setTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    BF.local.set('theme', next);
    showTheme(next);
    BF.bus.emit('theme:changed', { theme: next });
  };
  BF.ui.theme = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
  themeButton.addEventListener('click', () => BF.ui.setTheme(BF.ui.theme() === 'light' ? 'dark' : 'light'));
  showTheme(BF.ui.theme());
  applyRail();

  // ---------- controles da janela (sem moldura): window:* no processo principal ----------

  function showWindowState(state) {
    const max = $('win-max');
    max.firstElementChild.textContent = state.maximized ? 'filter_none' : 'check_box_outline_blank';
    max.title = state.maximized ? 'Restaurar' : 'Maximizar';
    max.setAttribute('aria-label', max.title);
    const full = $('win-full');
    full.firstElementChild.textContent = state.fullscreen ? 'fullscreen_exit' : 'fullscreen';
    full.title = state.fullscreen ? 'Sair da tela cheia' : 'Tela cheia';
    full.setAttribute('aria-label', full.title);
    app.dataset.windowState = state.fullscreen ? 'fullscreen' : state.maximized ? 'maximized' : 'normal';
  }

  if (!BF.embedded) {
    const act = (channel, payload) => BF.api(channel, payload).then((res) => { if (res.ok && 'maximized' in res) showWindowState(res); });
    $('win-min').addEventListener('click', () => act('window:minimize'));
    $('win-max').addEventListener('click', () => act('window:maximize'));
    $('win-full').addEventListener('click', () => act('window:fullscreen'));
    $('win-close').addEventListener('click', () => act('window:close'));
    BF.on('window:changed', showWindowState);
    act('window:state');
    document.addEventListener('keydown', (event) => {
      if (event.key === 'F11') { event.preventDefault(); act('window:fullscreen'); }
      else if (event.key === 'Escape' && app.dataset.windowState === 'fullscreen' && !document.querySelector('.bf-modal')) act('window:fullscreen', { exit: true });
    });
  }

  BF.ready.then(() => {
    $('appName').textContent = BF.state.app.name;
    document.title = BF.state.app.name;
    renderToolsWarning();
    for (const failure of BF.state.loadErrors) {
      BF.ui.toast(`Parte do app não carregou (${failure.file}): ${failure.message}`, 'error', 15000);
    }
  });
  BF.bus.on('tools:changed', renderToolsWarning);

  // ---------- abrir vídeo ----------

  $('btnOpen').addEventListener('click', async () => {
    const res = await BF.api('source:pick', {}, { toast: true });
    if (res.ok && !res.canceled) BF.openSource(res.path);
  });

  let dragDepth = 0;
  const hasFiles = (event) => Boolean(event.dataTransfer) && [...event.dataTransfer.types].includes('Files');
  const setDragging = (on) => $('app').classList.toggle('drag', on);
  window.addEventListener('dragenter', (event) => { if (hasFiles(event)) { event.preventDefault(); dragDepth += 1; setDragging(true); } });
  window.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) setDragging(false); });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    setDragging(false);
    const files = event.dataTransfer && event.dataTransfer.files;
    const file = files && files[0];
    if (!file) return;
    BF.openSource(window.bf.pathForFile(file));
    BF.ui.droppedMany(files.length);
  });

  BF.bus.on('project:loaded', ({ project }) => {
    $('workspace').hidden = false;
    // o nome do projeto (o título da transmissão ou o nome do arquivo sem a pasta): o caminho inteiro só na dica, ao passar o mouse
    const origin = project.source.origin;
    $('sourceName').replaceChildren(el('bdi', {}, (origin && origin.title) || nameOf(project.source.path)));
    $('sourceName').title = project.source.path;
    $('headerDivider').hidden = false;
    document.title = `${nameOf(project.source.path)} — ${BF.state.app.name}`;
    $('inInput').value = fmt(0);
    // duração 0 = o arquivo não informa (veja source:open / DURATION_UNKNOWN): sugere 15 s em vez de um fim igual ao início
    $('outInput').value = fmt(BF.state.info.duration > 0 ? Math.min(15, BF.state.info.duration) : 15);
    updateRange();
  });

  // ---------- editor: o projeto aberto, o estado dele e o atalho para exportar ----------

  /** O resumo que a lista de Projetos usa para dar nome e estado a um projeto (os mesmos nomes e estados da Início e de Projetos). */
  function summaryOf(project) {
    const cuts = project.cuts || [];
    const counts = { pending: 0, approved: 0, rejected: 0 };
    for (const cut of cuts) if (cut.status in counts) counts[cut.status] += 1;
    return { source: project.source, meta: project.meta, cutCount: cuts.length, counts, exportedCount: cuts.filter((cut) => Array.isArray(cut.exports) && cut.exports.length > 0).length };
  }

  /**
   * No item Cortes do menu o cabeçalho troca o caminho do arquivo por "Projetos › nome do projeto" e o estado dele (Novo, Em revisão, Pronto para
   * exportar, Exportado) e ganha o botão "Exportar" (um atalho para a aba Exportar: a única ação principal; "Abrir vídeo" fica de contorno).
   * O app salva sozinho: não há botão "Salvar".
   */
  function refreshEditorHeader() {
    const project = BF.state.project;
    const editor = Boolean(project) && app.dataset.activeMenu === 'editor';
    $('crumbs').hidden = !editor;
    app.classList.toggle('has-crumbs', editor);
    const shortcut = editor && app.dataset.activeTab !== 'export';
    $('btnExport').hidden = !shortcut;
    $('btnOpen').classList.toggle('primary', !shortcut);
    $('btnOpen').classList.toggle('secondary', shortcut);
    if (!editor) return;
    const summary = summaryOf(project);
    const projects = BF.projects;
    $('crumbName').textContent = projects && projects.nameOf ? projects.nameOf(summary) : nameOf(project.source.path);
    $('crumbName').title = project.source.path;
    const chip = $('crumbState');
    const state = projects && projects.stateOf ? projects.stateOf(summary) : null;
    chip.hidden = !state;
    if (state) {
      chip.className = `bds-chip crumb-state ${state.tone}`.trim();
      chip.textContent = state.label;
      chip.title = state.hint;
    }
  }
  $('crumbBack').addEventListener('click', () => BF.ui.selectTab('projects'));
  $('btnExport').addEventListener('click', () => BF.ui.selectTab('export'));
  for (const event of ['tab:changed', 'project:loaded', 'project:changed', 'cuts:changed']) BF.bus.on(event, refreshEditorHeader);

  // ---------- rede de segurança ao trocar de vídeo ----------

  // BF.openSource grava o projeto aberto (flush) ANTES do source:open, e o projeto novo só assume depois da resposta (algumas
  // centenas de ms). O que for editado no projeto antigo nessa janela (uma exportação que termina, uma legenda que fica pronta,
  // um clique) ficaria só na memória e se perderia quando o projeto novo toma o lugar. Por isso o projeto que estava aberto é
  // lembrado quando a abertura começa e, se mudou desde então e foi trocado por outro, é gravado de novo (idempotente; o app.js
  // continua sendo quem grava o projeto novo).
  let leaving = null;
  BF.hooks.add('beforeOpen', () => {
    if (leaving) leaving.off();
    leaving = null;
    const project = BF.state.project;
    if (!project) return true;
    const state = { project, touched: false, off: () => {} };
    state.off = BF.bus.on('project:changed', () => { if (BF.state.project === project) state.touched = true; });
    leaving = state;
    return true;
  });
  BF.bus.on('project:loaded', () => {
    const state = leaving;
    leaving = null;
    if (!state) return;
    state.off();
    const now = BF.state.project;
    if (state.touched && now && now !== state.project && now.id !== state.project.id) {
      BF.api('project:save', { project: JSON.parse(JSON.stringify(state.project)) });
    }
  });

  // ---------- marcação e prévia ----------

  function range() {
    return { start: parseTime($('inInput').value), end: parseTime($('outInput').value) };
  }

  function rangeProblem() {
    const info = BF.state.info;
    if (!info) return 'Abra um vídeo para marcar cortes.';
    const { start, end } = range();
    if (Number.isNaN(start) || Number.isNaN(end)) return 'Use o formato m:ss, h:mm:ss ou segundos (ex.: 1:23.5).';
    if (end <= start) return 'O fim precisa ser maior que o início.';
    // duração 0 = o arquivo não informa a duração: não há limite para conferir (o aviso foi dado ao abrir)
    if (info.duration > 0 && end > info.duration + 0.05) return 'O fim passa da duração do vídeo.';
    return null;
  }

  function updateRange() {
    const problem = rangeProblem();
    const { start, end } = range();
    const info = BF.state.info;
    const total = info && info.duration > 0 ? `Vídeo: ${fmt(info.duration)}.` : 'Duração do vídeo desconhecida (o arquivo não informa): o fim não é conferido.';
    $('rangeInfo').textContent = problem || `Trecho de ${fmt(end - start)} (${secs(end - start)}). ${total}`;
    $('btnAddCut').disabled = Boolean(problem);
    // "Ver trecho" depende do player: formatos que o Chromium não toca (.ts, .flv…) deixam o botão desabilitado COM o motivo
    const playable = !info || BF.player.canPlay();
    $('btnPreview').disabled = Boolean(problem) || !playable;
    $('btnPreview').title = playable ? '' : BF.player.unplayableMessage;
  }
  BF.player.video.addEventListener('error', updateRange);
  BF.player.video.addEventListener('loadstart', updateRange);

  $('btnMarkIn').addEventListener('click', () => { $('inInput').value = fmt(BF.player.time()); updateRange(); });
  $('btnMarkOut').addEventListener('click', () => { $('outInput').value = fmt(BF.player.time()); updateRange(); });
  $('inInput').addEventListener('input', updateRange);
  $('outInput').addEventListener('input', updateRange);
  $('btnPreview').addEventListener('click', () => { const { start, end } = range(); BF.player.playRange(start, end); });

  $('btnAddCut').addEventListener('click', () => {
    const { start, end } = range();
    BF.project.addCut({ start, end });
    BF.ui.log('Corte salvo.', 'ok');
  });

  // escolher um corte na lista leva o início/fim dele para a barra de marcação
  BF.bus.on('cut:selected', ({ id }) => {
    const cut = BF.project.cut(id);
    if (!cut) return;
    $('inInput').value = fmt(cut.start);
    $('outInput').value = fmt(cut.end);
    updateRange();
  });

  updateRange();
})();

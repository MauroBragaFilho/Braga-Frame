'use strict';

/**
 * Tela "Novo projeto" (aba `sources`, a antiga Fontes; dono: sources): de onde vem o vídeo. Quatro cartões de escolha ("Como deseja
 * adicionar o seu vídeo?") e, embaixo, só o painel do escolhido:
 *   - Arquivos locais: arrastar e soltar (a janela inteira é a área de soltar) ou clicar para escolher o arquivo; abre o projeto.
 *   - YouTube e Twitch: o link de UM vídeo ou VOD (playlist e clipe não são aceitos): metadados, qualidade, download com
 *     progresso/cancelar/retomar, chat opcional. "Abrir como projeto" cria o projeto com origin { type:'vod', … } e preenche jogo/canal e o chat.
 *     Colar um link da outra plataforma troca o cartão sozinho.
 *   - Gravações do OBS: a pasta vem da configuração real do OBS (ou é escolhida à mão); lista por data, com duração, e avisa de
 *     arquivo ainda em gravação. "Abrir" cria o projeto com origin { type:'obs' }.
 * Fora dos cartões: o chat do projeto aberto (anexado ou para baixar depois) e o Avançado (recolhido): cookies do navegador (com a
 * explicação de privacidade) e a situação das ferramentas. Quando um projeto abre estando nesta tela, o app segue para a aba Cortes.
 * Funciona SEM projeto aberto (BF.state.project === null). Só usa BF.*; canais sources:* do processo principal (e source:pick da base).
 * Ganchos: beforeOpen preenche o origin de um arquivo já conhecido (VOD baixado aqui ou gravação numa pasta do OBS);
 * afterOpen preenche meta.game/meta.channel (se vazios) e anexa o chat do VOD.
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;

  const BROWSERS = [['chrome', 'Chrome'], ['edge', 'Edge'], ['firefox', 'Firefox'], ['brave', 'Brave'], ['opera', 'Opera'], ['vivaldi', 'Vivaldi'], ['chromium', 'Chromium']];
  const RELOAD_WHILE_RECORDING_MS = 6000;
  const VISIBLE_RECORDINGS = 6;

  /** Os cartões de escolha: [id, ícone, título, explicação]. As explicações dizem só o que a tela aceita de verdade. */
  const KINDS = [
    ['files', 'video_file', 'Arquivos locais', 'Do seu computador'],
    ['youtube', 'smart_display', 'YouTube', 'Link de um vídeo ou live'],
    ['twitch', 'live_tv', 'Twitch', 'Link de um VOD'],
    ['obs', 'videocam', 'Gravações do OBS', 'Da pasta de gravações']
  ];
  const VOD_KINDS = ['youtube', 'twitch'];
  /** O texto do painel do link, por plataforma. */
  const VOD_TEXT = {
    youtube: {
      title: 'Vídeo do YouTube',
      lead: 'Cole o link de UM vídeo ou de uma live já encerrada (youtube.com/watch?v=… ou youtube.com/live/…). Playlists não são aceitas.',
      placeholder: 'https://www.youtube.com/watch?v=…',
      label: 'Vídeo do YouTube'
    },
    twitch: {
      title: 'VOD da Twitch',
      lead: 'Cole o link de um VOD já encerrado (twitch.tv/videos/…). Clipes e transmissões ao vivo não são aceitos.',
      placeholder: 'https://www.twitch.tv/videos/…',
      label: 'VOD da Twitch'
    }
  };

  const S = {
    ready: false,
    loadError: null,
    tools: null,
    settings: { obsFolder: null, downloadDir: null, cookiesBrowser: '' },
    downloadDir: '',
    source: 'files', // o cartão escolhido: 'files' | 'youtube' | 'twitch' | 'obs'
    obs: { detect: null, listing: null, folder: null, loading: false, error: null, projects: new Map(), seq: 0, timer: null, showAll: false },
    vod: { stage: 'idle', url: '', data: null, quality: 'best', withChat: true, error: null, note: '', partial: null, disk: null, progress: null, result: null, queryId: null },
    chat: { busy: false, adopted: false, check: null, error: null, note: '', progress: null }
  };

  let root = null;
  const box = { choices: null, files: null, obs: null, vod: null, chat: null, adv: null };
  let urlInput = null;
  let activeTab = null; // a aba mostrada agora (BF.bus 'tab:changed'): decide se abrir um vídeo leva para Cortes
  const known = new Map(); // caminho normalizado -> { kind, origin, chat, meta } (o que sabemos do arquivo que vai abrir)

  // ---------- formatação ----------

  const norm = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = n < 1 ? 0 : Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const value = n / 1024 ** i;
    return `${value.toLocaleString('pt-BR', { maximumFractionDigits: value >= 100 || i === 0 ? 0 : 1 })} ${units[i]}`;
  }

  /** 3725 -> "1:02:05"; 65 -> "1:05". */
  function fmtDuration(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '—';
    const total = Math.round(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  function fmtEta(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return '';
    if (sec < 90) return `${Math.max(1, Math.round(sec))} s`;
    if (sec < 5400) return `${Math.round(sec / 60)} min`;
    return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtTime = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const fmtDate = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;

  /** "Hoje", "Ontem" ou dd/mm/aaaa. */
  function dayLabel(date, now = new Date()) {
    const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((day(now) - day(date)) / 86400000);
    if (diff === 0) return 'Hoje';
    if (diff === 1) return 'Ontem';
    return fmtDate(date);
  }

  function fmtWhen(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : `${fmtDate(d)} ${fmtTime(d)}`;
  }

  /** Agrupa as gravações por dia, mantendo a ordem (mais recente primeiro). */
  function groupByDay(files, now = new Date()) {
    const groups = [];
    for (const file of files) {
      const date = new Date(file.startedAt);
      const label = dayLabel(date, now);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.files.push(file);
      else groups.push({ label, files: [file] });
    }
    return groups;
  }

  // ---------- pequenos componentes ----------

  const icon = (name, cls = '') => el('span', { class: `material-symbols-rounded${cls ? ` ${cls}` : ''}`, 'aria-hidden': 'true' }, name);

  /** Aviso em cartão com ícone por severidade (o ícone vem do CSS: o texto do aviso fica só com a mensagem). */
  function note(kind, ...children) {
    return el('div', { class: `src-note ${kind}`, role: kind === 'block' || kind === 'error' ? 'alert' : undefined }, el('div', { class: 'src-note-body' }, ...children));
  }

  /** Botões: `primary` (um por região), `link` (texto) ou, por padrão, um botão compacto de contorno. */
  function button(label, onclick, { primary = false, disabled = false, title, act, link = false } = {}) {
    return el('button', { type: 'button', class: link ? 'link' : primary ? 'primary' : 'secondary sm', onclick, disabled, title, dataset: act ? { act } : undefined }, label);
  }

  const platformName = (platform) => (platform === 'twitch' ? 'Twitch' : platform === 'youtube' ? 'YouTube' : '');

  const YOUTUBE_HOST = /^(?:www\.|m\.|music\.)?youtube\.com$|^youtu\.be$|^(?:www\.)?youtube-nocookie\.com$/i;
  const TWITCH_HOST = /^(?:www\.|m\.)?twitch\.tv$/i;

  /** 'youtube' | 'twitch' pelo endereço colado, ou null. Só serve para trocar o cartão: quem confere o link de verdade é o processo principal. */
  function platformOfUrl(text) {
    const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^/@?#]*@)?([^/:?#]+)/i.exec(String(text || '').trim());
    const host = match ? match[1] : '';
    if (YOUTUBE_HOST.test(host)) return 'youtube';
    if (TWITCH_HOST.test(host)) return 'twitch';
    return null;
  }

  // ---------- cartões de escolha: de onde vem o vídeo ----------

  const rememberedKind = () => {
    try {
      const kind = BF.local ? BF.local.get('sourceKind', '') : '';
      return KINDS.some(([id]) => id === kind) ? kind : '';
    } catch { return ''; }
  };

  /** O cartão do download em andamento (ele mostra "Baixando"): a plataforma do vídeo, ou a do link, ou o cartão que está aberto. */
  function busyKind() {
    if (S.vod.stage !== 'running') return null;
    const platform = (S.vod.data && S.vod.data.meta && S.vod.data.meta.platform) || (S.vod.progress && S.vod.progress.platform) || platformOfUrl(S.vod.url);
    return VOD_KINDS.includes(platform) ? platform : (VOD_KINDS.includes(S.source) ? S.source : 'youtube');
  }

  /** Mostra o painel do cartão escolhido (e só ele) e o texto do painel do link da plataforma. */
  function renderChoices() {
    if (!box.choices) return;
    const busy = busyKind();
    for (const [id] of KINDS) {
      box.cards[id].setAttribute('aria-pressed', String(S.source === id));
      box.badges[id].hidden = busy !== id;
    }
    box.files.hidden = S.source !== 'files';
    box.vod.hidden = !VOD_KINDS.includes(S.source);
    box.obs.hidden = S.source !== 'obs';
    const text = VOD_TEXT[S.source] || VOD_TEXT.youtube;
    if (box.vodTitle.textContent !== text.title) box.vodTitle.textContent = text.title;
    if (box.vodLead.textContent !== text.lead) box.vodLead.textContent = text.lead;
    if (urlInput && urlInput.placeholder !== text.placeholder) urlInput.placeholder = text.placeholder;
    box.vod.setAttribute('aria-label', text.label);
    const iconName = KINDS.find(([id]) => id === (VOD_TEXT[S.source] ? S.source : 'youtube'))[1];
    if (box.vodIcon.textContent !== iconName) box.vodIcon.textContent = iconName;
  }

  /** Escolhe o cartão (a escolha fica guardada para a próxima vez). */
  function selectSource(kind) {
    if (!KINDS.some(([id]) => id === kind) || S.source === kind) return;
    S.source = kind;
    try { if (BF.local) BF.local.set('sourceKind', kind); } catch { /* sem armazenamento: vale só nesta sessão */ }
    renderChoices();
  }

  /** Colou o link do outro site: o cartão acompanha (a ferramenta que vale é a do link, não a do cartão que estava aberto). */
  function followPlatform() {
    const platform = platformOfUrl(S.vod.url);
    if (platform && VOD_KINDS.includes(S.source) && platform !== S.source) selectSource(platform);
  }

  function buildChoices() {
    box.cards = {};
    box.badges = {};
    const cards = KINDS.map(([id, iconName, title, hint]) => {
      box.badges[id] = el('span', { class: 'bds-chip bds-chip-accent src-choice-badge', hidden: true }, 'Baixando');
      box.cards[id] = el('button', { type: 'button', class: 'src-choice', 'aria-pressed': 'false', dataset: { act: 'source', key: id, source: id }, onclick: () => selectSource(id) },
        el('span', { class: 'src-choice-icon' }, icon(iconName)),
        el('span', { class: 'src-choice-text' }, el('strong', {}, title), el('span', { class: 'muted small' }, hint)),
        box.badges[id]);
      return box.cards[id];
    });
    box.choices = el('div', { class: 'src-choices', role: 'group', 'aria-label': 'De onde vem o vídeo' }, cards);
  }

  // ---------- arquivos locais ----------

  /** Escolhe o arquivo no diálogo do sistema e abre o projeto; soltar o arquivo na janela faz o mesmo (veja shell.js e bridge.js). */
  async function pickFile() {
    const res = await BF.api('source:pick', {}, { toast: true });
    if (!res.ok || res.canceled) return;
    const opened = await BF.openSource(res.path);
    if (opened && opened.ok) BF.ui.selectTab('cuts');
  }

  function buildFilesSection() {
    box.files.replaceChildren(
      el('button', { type: 'button', class: 'src-drop', dataset: { act: 'pick-file' }, onclick: pickFile },
        icon('cloud_upload', 'src-drop-icon'),
        el('strong', { class: 'src-drop-title' }, 'Arraste e solte o vídeo aqui'),
        el('span', { class: 'src-drop-sub' }, 'ou clique para escolher o arquivo'),
        el('span', { class: 'src-drop-formats muted small' }, 'MP4, MKV, MOV, WebM, AVI, FLV ou TS')),
      el('p', { class: 'src-hint-text muted small' }, 'Cada vídeo é um projeto: solte um de cada vez. Soltar vale em qualquer parte da janela.'));
  }

  /** Atributos de um alvo de foco SEM ação (aviso de espera, barra de progresso, cartão do resultado): o teclado pousa nele
   * quando o botão que ele usava deixa de existir, e o Tab seguinte já chega aos botões do novo estado. */
  const stageProps = () => ({ tabindex: '-1', dataset: { focus: 'stage' } });

  /**
   * Redesenha uma seção sem o teclado perder o lugar. O foco volta ao mesmo elemento (mesmo "data-act" e, nas listas, o
   * mesmo "data-key"); se ele deixou de existir ou foi desabilitado, vai para `fallback()` (um alvo seguro, sem ação) em vez
   * de cair no topo da página. Quem não estava com o foco aqui dentro não é incomodado.
   */
  function keepFocus(draw, fallback) {
    const active = document.activeElement;
    const inside = Boolean(root && active && active !== document.body && root.contains(active));
    const act = inside && active.dataset ? active.dataset.act : null;
    const key = inside && active.dataset ? active.dataset.key : undefined;
    draw();
    if (!inside) return;
    const now = document.activeElement;
    if (now && now !== document.body && root.contains(now) && !now.disabled) return; // o foco ficou onde estava
    let target = null;
    if (act) {
      const same = [...root.querySelectorAll('[data-act]')].filter((node) => node.dataset.act === act);
      target = same.find((node) => node.dataset.key === key) || null;
    }
    if (!target || target.disabled) target = fallback ? fallback() : null;
    if (target && !target.disabled) target.focus();
  }

  const goTools = () => BF.ui.selectTab('tools');

  function toolsHint(text) {
    return el('div', { class: 'src-hint src-note warn' }, el('span', { class: 'src-note-body' }, text), button('Abrir Ferramentas', goTools, { act: 'tools' }));
  }

  // ---------- carga ----------

  async function loadState() {
    const res = await BF.api('sources:state');
    if (!res.ok) { S.loadError = res.message; return false; }
    S.loadError = null;
    S.tools = res.tools;
    S.settings = res.settings;
    S.downloadDir = res.downloadDir;
    if (res.job) adoptJob(res.job);
    return true;
  }

  /**
   * O processo principal informa o trabalho em andamento (um por vez). Se esta tela não o conhece, a janela foi recarregada
   * no meio dele e quem iniciou já não está aqui para receber o resultado: o evento final é que o encerra. Cada tipo de
   * trabalho vai para a SUA seção: um download de chat não pode virar "Download em andamento" na seção do vídeo (o estado
   * nunca voltava a "idle" e o campo do link ficava desabilitado até reiniciar o app).
   */
  function adoptJob(job) {
    if (job.kind === 'chat') {
      if (S.chat.busy) return; // foi esta tela que iniciou: a própria resposta encerra
      S.chat.busy = true;
      S.chat.adopted = true;
      S.chat.progress = job;
      return;
    }
    if (S.vod.stage === 'running') return;
    S.vod.stage = 'running';
    S.vod.progress = job;
    S.vod.adopted = true;
    if (VOD_KINDS.includes(job.platform)) S.source = job.platform; // o download em andamento aparece no cartão da plataforma dele
  }

  async function refresh() {
    if (!root) return;
    await loadState();
    renderAll();
    loadObs();
    if (S.vod.stage === 'ready' && S.vod.data) loadPartial();
    checkProjectChat();
  }

  // ---------- 1. OBS ----------

  async function loadObs({ keepFolder = true } = {}) {
    const seq = ++S.obs.seq;
    clearTimeout(S.obs.timer);
    S.obs.loading = true;
    S.obs.error = null;
    renderObs();
    const det = await BF.api('sources:obsDetect');
    if (seq !== S.obs.seq) return;
    S.obs.detect = det.ok ? det : null;
    if (!det.ok) S.obs.error = det.message;
    if (!keepFolder) S.obs.folder = null;
    if (S.obs.folder && !isKnownFolder(S.obs.folder)) S.obs.folder = null;
    const folder = S.obs.folder || (det.ok ? det.selected : null);
    if (!folder) {
      S.obs.listing = null;
      S.obs.loading = false;
      renderObs();
      return;
    }
    const list = await BF.api('sources:obsList', { folder });
    if (seq !== S.obs.seq) return;
    S.obs.loading = false;
    if (list.ok) { S.obs.listing = list; S.obs.error = null; } else { S.obs.listing = null; S.obs.error = list.message; }
    // projetos já criados (para mostrar "N cortes" ao lado da gravação)
    const projects = await BF.api('project:list');
    if (seq !== S.obs.seq) return;
    S.obs.projects = new Map();
    if (projects.ok) for (const p of projects.projects) S.obs.projects.set(norm(p.source.path), p);
    renderObs();
    scheduleObsReload();
  }

  function isKnownFolder(folder) {
    const det = S.obs.detect;
    return Boolean(det) && (norm(det.manual) === norm(folder) || det.folders.some((f) => norm(f.folder) === norm(folder)));
  }

  /** Com um arquivo em gravação, confere de novo a cada poucos segundos enquanto a aba está aberta. */
  function scheduleObsReload() {
    clearTimeout(S.obs.timer);
    const recording = S.obs.listing && S.obs.listing.recording > 0;
    if (!recording || !root) return;
    S.obs.timer = setTimeout(() => {
      const panel = root.closest('.tabpanel');
      if (panel && !panel.hidden) loadObs();
      else scheduleObsReload();
    }, RELOAD_WHILE_RECORDING_MS);
  }

  /** A lista veio só com a duração das mais recentes: pede (em lotes) a das que o usuário acabou de abrir. */
  async function completeDurations() {
    const listing = S.obs.listing;
    if (!listing) return;
    const pending = listing.files.filter((f) => f.durationPending).map((f) => f.path);
    for (let i = 0; i < pending.length; i += 50) {
      const res = await BF.api('sources:probe', { paths: pending.slice(i, i + 50) });
      if (S.obs.listing !== listing) return; // trocou de pasta no meio do caminho
      if (!res.ok) break;
      for (const file of listing.files) {
        if (Object.hasOwn(res.durations, file.path)) { file.durationSec = res.durations[file.path]; file.durationPending = false; }
      }
      renderObs();
    }
  }

  async function pickObsFolder() {
    const res = await BF.api('sources:pickFolder', { purpose: 'obs' }, { toast: true });
    if (!res.ok || res.canceled) return;
    S.settings = res.settings;
    S.obs.folder = null;
    loadObs();
  }

  async function openRecording(file) {
    if (file.recording) {
      const sure = await BF.ui.confirm({
        title: 'Esta gravação ainda está em andamento',
        message: 'O OBS ainda está escrevendo este arquivo. Se você abrir agora, o vídeo estará incompleto (só até este momento) e o projeto guardará essa duração. O ideal é esperar a gravação terminar.',
        okLabel: 'Abrir mesmo assim',
        cancelLabel: 'Esperar'
      });
      if (!sure) return;
    }
    const res = await BF.openSource(file.path, { type: 'obs' });
    if (res && res.ok) BF.ui.selectTab('cuts');
  }

  /** Cabeçalho do cartão: ícone, título e as duas ações (a pasta é a principal enquanto não há uma). */
  function obsHeader(needsFolder) {
    // "Atualizar" não é desabilitado enquanto carrega: pedir de novo só recomeça a leitura, e o botão desabilitado fazia o teclado perder o lugar
    const refreshing = S.obs.loading;
    const refresh = el('button', {
      type: 'button', class: `icon-btn${refreshing ? ' is-spinning' : ''}`, title: refreshing ? 'Atualizando…' : 'Atualizar a lista', 'aria-label': refreshing ? 'Atualizando…' : 'Atualizar',
      dataset: { act: 'obs-refresh' }, onclick: () => loadObs({ keepFolder: true })
    }, icon('refresh'));
    const pick = el('button', { type: 'button', class: needsFolder ? 'primary sm' : 'secondary sm', dataset: { act: 'obs-pick' }, onclick: pickObsFolder }, 'Trocar pasta…');
    return el('div', { class: 'src-head' },
      el('span', { class: 'src-head-icon' }, icon('videocam')),
      el('h2', {}, 'Gravações do OBS'),
      el('div', { class: 'src-actions' }, pick, refresh));
  }

  function folderLine() {
    const det = S.obs.detect;
    const listing = S.obs.listing;
    if (!det) return null;
    const folder = (listing && listing.folder) || S.obs.folder || det.selected;
    if (!folder) return null;
    let why;
    const prof = det.folders.find((f) => norm(f.folder) === norm(folder));
    if (norm(det.manual) === norm(folder)) why = 'escolhida por você';
    else if (prof) why = `perfil “${prof.profile}” do OBS, modo ${prof.mode === 'advanced' ? 'avançado' : 'simples'}`;
    else why = 'escolhida nesta sessão';

    const choices = [];
    const access = (exists) => (exists === false ? ' (não existe)' : exists === null ? ' (não consegui acessar)' : '');
    for (const f of det.folders) choices.push({ folder: f.folder, label: `Perfil ${f.profile}${f.active ? ' (ativo)' : ''} — ${f.folder}${access(f.exists)}` });
    if (det.manual && !choices.some((c) => norm(c.folder) === norm(det.manual))) choices.push({ folder: det.manual, label: `Escolhida por você — ${det.manual}${access(det.manualExists)}` });
    if (choices.length > 1) {
      const select = el('select', {
        'aria-label': 'Pasta de gravações', dataset: { act: 'obs-folder' },
        onchange: (event) => { S.obs.folder = event.target.value; loadObs(); }
      }, choices.map((c) => el('option', { value: c.folder, selected: norm(c.folder) === norm(folder) }, c.label)));
      return el('div', { class: 'src-folder' }, icon('folder_open', 'src-folder-icon'), el('span', { class: 'src-folder-label' }, 'Pasta'), select);
    }
    return el('div', { class: 'src-folder' },
      icon('folder_open', 'src-folder-icon'),
      el('span', { class: 'src-path', title: folder }, folder),
      el('span', { class: 'bds-chip src-why-chip' }, why));
  }

  function fileRow(file) {
    const project = S.obs.projects.get(norm(file.path));
    const started = new Date(file.startedAt);
    return el('li', { class: `src-file bds-list-item${file.recording ? ' recording' : ''}`, dataset: { path: file.path } },
      el('span', { class: 'src-icon' }, icon(file.recording ? 'fiber_manual_record' : 'movie')),
      el('span', { class: 'src-namebox' },
        el('span', { class: 'src-nameline' },
          el('span', { class: 'src-name', title: file.name }, file.name),
          file.recording ? el('span', { class: 'src-tag rec bds-chip bds-chip-warn', title: 'O arquivo ainda está crescendo' }, 'gravando') : null,
          project && project.cutCount > 0 ? el('span', { class: 'src-tag bds-chip', title: 'Já existe um projeto com cortes para este vídeo' }, `${project.cutCount} corte${project.cutCount === 1 ? '' : 's'}`) : null),
        el('span', { class: 'src-sub muted' }, el('span', { class: 'src-time' }, fmtTime(started)), el('span', { class: 'src-size' }, fmtBytes(file.size)))),
      el('span', { class: 'src-dur' }, file.recording ? '—' : (file.durationPending ? '…' : (file.durationSec === null ? '?' : fmtDuration(file.durationSec)))),
      // data-key: cada linha tem o seu botão; o redesenho periódico (gravação em andamento) devolve o foco à MESMA linha, não à primeira
      el('button', { type: 'button', class: 'secondary sm', dataset: { act: 'open-recording', key: file.path }, 'aria-label': `Abrir ${file.name}`, onclick: () => openRecording(file) }, 'Abrir'));
  }

  // se a linha em foco deixou de existir (a lista mudou), o foco vai para "Atualizar" (inofensivo) em vez de cair no topo da página
  function renderObs() { keepFocus(drawObs, () => (box.obs ? box.obs.querySelector('[data-act="obs-refresh"]') : null)); }

  /** Linhas fantasma enquanto a lista carrega (discretas; o texto fica só para quem usa leitor de tela). */
  function skeleton(text) {
    return el('div', { class: 'src-skeleton', role: 'status', 'aria-live': 'polite' },
      el('span', { class: 'sr-only' }, text),
      [0, 1, 2].map(() => el('div', { class: 'src-skel', 'aria-hidden': 'true' })));
  }

  function drawObs() {
    if (!box.obs) return;
    const det = S.obs.detect;
    const listing = S.obs.listing;
    const noFolder = S.ready && !S.obs.loading && !listing && !S.obs.folder && !(det && (det.selected || det.manual));
    const parts = [obsHeader(noFolder)];
    if (!S.ready) {
      parts.push(skeleton('Carregando…'));
    } else if (det && !det.found && !det.manual) {
      parts.push(note('warn', det.reason || 'Não encontrei a configuração do OBS neste computador.'));
      parts.push(el('p', { class: 'src-hint-text muted small' }, 'Escolha a pasta onde as suas gravações ficam e elas aparecem aqui.'));
    } else {
      const line = folderLine();
      if (line) parts.push(line);
      if (S.obs.error) parts.push(note('error', S.obs.error));
      if (listing && listing.error) parts.push(note('error', listing.error, ' Use “Trocar pasta…” para escolher outra.'));
      if (det && det.found) {
        const notes = det.profiles.filter((p) => p.note).map((p) => `${p.name}: ${p.note}`);
        if (notes.length) parts.push(el('p', { class: 'src-hint-text muted small' }, notes.join(' ')));
        if (!det.selected && !S.obs.folder && !S.obs.loading) {
          const gone = det.profiles.filter((p) => p.folder && p.exists === false).map((p) => p.folder);
          const silent = det.profiles.filter((p) => p.folder && p.exists === null).map((p) => p.folder); // rede fora do ar, unidade desconectada…
          const said = [];
          if (gone.length) said.push(`O OBS está configurado para gravar em ${gone.join(' e em ')}, mas ${gone.length > 1 ? 'essas pastas não existem' : 'essa pasta não existe'} neste computador.`);
          if (silent.length) said.push(`Não consegui acessar ${silent.join(' nem ')} agora: o compartilhamento de rede pode estar fora do ar ou a unidade desconectada. Confira a conexão e use “Atualizar”.`);
          parts.push(note('warn', said.length ? said.join(' ') : 'Os perfis do OBS não têm pasta de gravação configurada.'));
          parts.push(el('p', { class: 'src-hint-text muted small' }, 'Escolha a pasta onde as suas gravações ficam e elas aparecem aqui.'));
        }
      }
      if (S.obs.loading && !listing) parts.push(skeleton('Procurando gravações…'));
      if (listing && !listing.error) {
        if (listing.recording > 0) {
          parts.push(note('warn', listing.recording === 1 ? 'O OBS está gravando agora. Esse arquivo só deve ser aberto quando a gravação terminar.' : `O OBS está gravando ${listing.recording} arquivos agora. Eles só devem ser abertos quando terminarem.`));
        }
        if (listing.files.length === 0) {
          parts.push(el('div', { class: 'empty-state src-empty' },
            icon('video_library', 'empty-state-icon'),
            el('div', { class: 'empty-state-text' },
              el('strong', {}, 'Nenhuma gravação nesta pasta ainda'),
              el('p', {}, 'Procuro arquivos mp4, mkv, mov, flv e ts.'))));
        } else {
          const visible = S.obs.showAll ? listing.files : listing.files.slice(0, VISIBLE_RECORDINGS);
          for (const group of groupByDay(visible)) {
            parts.push(el('h3', { class: 'src-day' }, group.label));
            parts.push(el('ul', { class: 'src-files bds-list' }, group.files.map(fileRow)));
          }
          if (listing.files.length > VISIBLE_RECORDINGS) {
            parts.push(el('div', { class: 'src-actions' }, button(S.obs.showAll ? 'Mostrar só as mais recentes' : `Mostrar todas (${listing.files.length})`, () => { S.obs.showAll = !S.obs.showAll; renderObs(); if (S.obs.showAll) completeDurations(); }, { link: true, act: 'obs-more' })));
          }
          if (listing.truncated && S.obs.showAll) parts.push(el('p', { class: 'muted small' }, `Mostrando as ${listing.files.length} mais recentes de ${listing.total}.`));
        }
      }
    }
    box.obs.setAttribute('aria-busy', S.obs.loading ? 'true' : 'false');
    box.obs.replaceChildren(...parts.filter(Boolean));
  }

  // ---------- 2. VOD por link ----------

  const ytReady = () => Boolean(S.tools && S.tools.ytdlp.found);
  const twitchToolReady = () => Boolean(S.tools && S.tools.twitchDownloader.found);

  let querySeq = 0;

  async function fetchMeta() {
    if (S.vod.stage === 'fetching' || S.vod.stage === 'running') return; // o campo só fica "somente leitura" nesses estados: Enter não dispara outra consulta
    followPlatform();
    const url = S.vod.url.trim();
    if (!url) { S.vod.error = { message: 'Cole o link do vídeo (YouTube ou Twitch) e clique em Buscar.' }; S.vod.stage = 'error'; renderVod(); return; }
    querySeq += 1;
    const queryId = `q${Date.now().toString(36)}-${querySeq}`; // permite cancelar só esta consulta (sources:cancel { queryId })
    S.vod.queryId = queryId;
    S.vod.stage = 'fetching';
    S.vod.error = null;
    S.vod.note = '';
    S.vod.result = null;
    renderVod();
    const res = await BF.api('sources:fetchVod', { url, refresh: true, queryId });
    if (S.vod.stage !== 'fetching' || S.vod.queryId !== queryId) return;
    S.vod.queryId = null;
    if (!res.ok && res.code === 'CANCELLED') {
      S.vod.stage = 'idle';
      S.vod.data = null;
      S.vod.note = 'Consulta cancelada.';
      renderVod();
      return;
    }
    if (!res.ok) { S.vod.stage = 'error'; S.vod.error = res; renderVod(); return; }
    S.vod.data = res;
    S.vod.quality = initialQuality(res.qualities);
    S.vod.withChat = res.chat.available !== false;
    S.vod.stage = 'ready';
    S.vod.partial = null;
    S.vod.disk = null;
    renderVod();
    loadPartial();
  }

  async function cancelFetch() {
    const queryId = S.vod.queryId;
    if (!queryId) return;
    await BF.api('sources:cancel', { queryId });
  }

  /** Quanto já foi baixado (para "Retomar") e se o espaço livre da pasta de destino dá para o vídeo, ANTES de o usuário clicar em Baixar. */
  async function loadPartial() {
    const d = S.vod.data;
    if (!d) return;
    const quality = S.vod.quality;
    const dir = S.downloadDir;
    const res = await BF.api('sources:partial', { url: d.meta.url, dir, quality });
    if (!S.vod.data || S.vod.data !== d || S.vod.quality !== quality || S.downloadDir !== dir) return; // trocou de vídeo, qualidade ou pasta no meio do caminho
    S.vod.partial = res.ok && (res.bytes > 0 || res.otherBytes > 0) ? res : null;
    S.vod.disk = res.ok && res.disk ? res.disk : null;
    if (S.vod.stage === 'ready') renderVod();
  }

  function chatPlan() {
    const d = S.vod.data;
    if (!d) return { enabled: false, note: '' };
    if (d.chat.available === false) return { enabled: false, note: d.chat.note };
    if (d.meta.platform === 'twitch' && !twitchToolReady()) {
      return { enabled: false, note: 'Para baixar o chat da Twitch, instale o TwitchDownloaderCLI na aba Ferramentas.', tool: true };
    }
    if (d.meta.platform === 'youtube' && !ytReady()) return { enabled: false, note: '' };
    return { enabled: true, note: d.chat.note };
  }

  async function pickDownloadDir() {
    const res = await BF.api('sources:pickFolder', { purpose: 'download' }, { toast: true });
    if (!res.ok || res.canceled) return;
    S.settings = res.settings;
    S.downloadDir = res.path;
    S.vod.partial = null;
    S.vod.disk = null; // o espaço livre era o da pasta anterior
    renderVod();
    loadPartial();
  }

  // ---------- qualidade: lembrar a última escolha e confirmar downloads grandes ----------

  /** Downloads acima disto pedem uma confirmação antes de começar. */
  const BIG_DOWNLOAD_BYTES = 5 * 1024 ** 3;

  /** A última qualidade usada, se este vídeo a tem; senão a mais próxima abaixo dela; senão a melhor. */
  function initialQuality(qualities) {
    const last = (S.settings && S.settings.lastQuality) || '';
    const list = Array.isArray(qualities) ? qualities : [];
    if (!last || !list.length) return 'best';
    if (list.some((q) => q.id === last)) return last;
    const want = last === 'best' ? Infinity : Number(last.slice(1));
    const below = list.filter((q) => q.height && q.height <= want).sort((a, b) => b.height - a.height)[0];
    return below ? below.id : 'best';
  }

  async function rememberQuality(id) {
    if (!id || (S.settings && S.settings.lastQuality === id)) return;
    const res = await BF.api('sources:setSettings', { lastQuality: id });
    if (res.ok) S.settings = res.settings;
  }

  async function startDownload() {
    const d = S.vod.data;
    if (!d) return;
    const picked = d.qualities.find((q) => q.id === S.vod.quality);
    if (picked && picked.estBytes > BIG_DOWNLOAD_BYTES) {
      const ok = await BF.ui.confirm({
        title: 'Download grande',
        message: `Na qualidade ${picked.label} este vídeo tem cerca de ${fmtBytes(picked.estBytes)}. Ele será baixado inteiro. Continuar?`,
        okLabel: 'Baixar', cancelLabel: 'Escolher outra qualidade'
      });
      if (!ok) return;
    }
    rememberQuality(S.vod.quality);
    const plan = chatPlan();
    S.vod.stage = 'running';
    S.vod.error = null;
    S.vod.note = '';
    S.vod.progress = { phase: 'prepare', message: 'Preparando…', percent: null };
    renderVod();
    BF.ui.refreshTabs();
    const res = await BF.api('sources:download', { url: d.meta.url, quality: S.vod.quality, dir: S.downloadDir, withChat: S.vod.withChat && plan.enabled });
    S.vod.progress = null;
    if (res.ok) {
      S.vod.stage = 'done';
      S.vod.result = res;
      BF.ui.toast('Download concluído.', 'ok');
    } else if (res.code === 'CANCELLED') {
      S.vod.stage = 'ready';
      S.vod.note = res.message;
      loadPartial();
    } else {
      S.vod.stage = 'error';
      S.vod.error = res;
      loadPartial();
    }
    renderVod();
    BF.ui.refreshTabs();
  }

  async function cancelJob() {
    const res = await BF.api('sources:cancel', {});
    if (res.ok && !res.cancelled) BF.ui.toast('Não há nada em andamento para cancelar.', '');
  }

  async function discardPartial() {
    const d = S.vod.data;
    const sure = await BF.ui.confirm({
      title: 'Descartar o download anterior?',
      message: `Os ${fmtBytes(S.vod.partial ? S.vod.partial.bytes + (S.vod.partial.otherBytes || 0) : 0)} já baixados deste vídeo (em qualquer qualidade) serão apagados e o download recomeça do zero. Seus outros arquivos não são tocados.`,
      okLabel: 'Descartar', danger: true
    });
    if (!sure) return;
    const res = await BF.api('sources:discardPartial', { url: d.meta.url, dir: S.downloadDir }, { toast: true });
    if (res.ok) { S.vod.partial = null; S.vod.note = ''; renderVod(); }
  }

  /** Abre o VOD baixado como projeto: origem completa, jogo/canal e chat entram pelo gancho afterOpen. */
  async function openDownloaded() {
    const r = S.vod.result;
    if (!r) return;
    known.set(norm(r.path), { kind: 'vod', origin: r.origin, chat: r.chat, meta: { game: r.meta.game, channel: r.meta.channel } });
    const res = await BF.openSource(r.path, r.origin);
    if (res && res.ok) BF.ui.selectTab('cuts');
  }

  function metaLine(meta) {
    const bits = [];
    if (meta.channel) bits.push(meta.channel);
    if (meta.game) bits.push(meta.game);
    else if (meta.categories && meta.categories[0]) bits.push(meta.categories[0]);
    if (meta.duration) bits.push(fmtDuration(meta.duration));
    if (meta.uploadDate) { const [y, m, d] = meta.uploadDate.split('-'); bits.push(`${d}/${m}/${y}`); }
    return bits.join(' · ');
  }

  /** Cabeçalho de um cartão de vídeo: bloco de ícone (as miniaturas do site não carregam: a CSP só aceita imagens do app), título e linha de detalhes. */
  function cardHead(iconName, title, meta, tail) {
    return el('div', { class: 'src-card-head' },
      el('span', { class: 'src-thumb' }, icon(iconName)),
      el('div', { class: 'src-card-info' },
        el('div', { class: 'src-title' }, title),
        meta ? el('div', { class: 'muted small' }, meta) : null),
      tail || null);
  }

  /** Linha de ajuste: título e descrição à esquerda, controle à direita (como as Configurações do BDS). */
  function row(title, hint, control, { label = true } = {}) {
    return el(label ? 'label' : 'div', { class: 'src-row' },
      el('span', { class: 'src-row-text' }, el('span', { class: 'src-row-title' }, title), hint ? el('span', { class: 'src-row-hint' }, hint) : null),
      control);
  }

  function vodCard() {
    const d = S.vod.data;
    const blockers = d.warnings.filter((w) => w.level === 'block');
    const warns = d.warnings.filter((w) => w.level !== 'block');
    const plan = chatPlan();
    const busy = S.vod.stage === 'running';
    const canDownload = ytReady() && blockers.length === 0 && !busy;

    const quality = el('select', {
      'aria-label': 'Qualidade', disabled: busy, dataset: { act: 'quality' },
      onchange: (event) => { S.vod.quality = event.target.value; rememberQuality(S.vod.quality); loadPartial(); }
    }, d.qualities.length
      ? d.qualities.map((q) => el('option', { value: q.id, selected: q.id === S.vod.quality }, q.label + (q.estBytes ? ` · ~${fmtBytes(q.estBytes)}` : '')))
      : [el('option', { value: 'best' }, 'Melhor disponível')]);

    const chatSwitch = el('input', {
      type: 'checkbox', role: 'switch', class: 'bds-switch', checked: S.vod.withChat && plan.enabled, disabled: !plan.enabled || busy,
      dataset: { act: 'with-chat' }, onchange: (event) => { S.vod.withChat = event.target.checked; }
    });

    const partial = S.vod.partial && S.vod.partial.bytes > 0 ? S.vod.partial : null;
    const otherOnly = S.vod.partial && !partial ? S.vod.partial : null;
    const disk = S.vod.disk;
    const platform = platformName(d.meta.platform);
    const picked = d.qualities.find((q) => q.id === S.vod.quality);
    const estimate = picked && picked.estBytes ? picked.estBytes : 0;
    return el('div', { class: 'src-card', ...stageProps() },
      cardHead('play_circle', d.meta.title, metaLine(d.meta), platform ? el('span', { class: 'bds-chip src-platform' }, platform) : null),
      blockers.map((w) => note('block', w.message)),
      warns.map((w) => note('warn', w.message)),
      !ytReady() ? toolsHint('O yt-dlp não está instalado.') : null,
      el('div', { class: 'src-rows' },
        row('Qualidade do download', estimate ? `Tamanho estimado: cerca de ${fmtBytes(estimate)}${estimate > BIG_DOWNLOAD_BYTES ? ' (download grande)' : ''}. A qualidade escolhida fica como padrão da próxima vez.` : 'A qualidade escolhida fica como padrão da próxima vez.', quality),
        row('Salvar em', el('span', { class: 'src-path', title: S.downloadDir }, S.downloadDir), button('Trocar…', pickDownloadDir, { disabled: busy, act: 'download-dir' }), { label: false }),
        row('Baixar também o chat', plan.note || null, chatSwitch)),
      plan.tool ? el('div', { class: 'src-actions' }, button('Abrir Ferramentas', goTools, { act: 'tools-chat', link: true })) : null,
      // espaço livre x tamanho do vídeo, avisado AQUI (antes de baixar), quando ainda dá para trocar a pasta ou a qualidade; só avisa, não bloqueia
      disk && disk.level === 'low' ? note('warn', disk.message) : null,
      disk && disk.level === 'block' ? note('error', disk.message) : null,
      partial ? note('info', S.vod.note ? `${S.vod.note} (${fmtBytes(partial.bytes)} guardados.) ` : `Há ${fmtBytes(partial.bytes)} de um download anterior deste vídeo. Ele continua de onde parou. `, button('Descartar', discardPartial, { link: true, act: 'discard' })) : null,
      otherOnly ? note('info', `Há ${fmtBytes(otherOnly.otherBytes)} de downloads anteriores deste vídeo em outra qualidade; eles não servem para esta e continuam guardados. `, button('Descartar', discardPartial, { link: true, act: 'discard' })) : null,
      S.vod.note && !partial ? note('info', S.vod.note) : null,
      el('div', { class: 'src-actions end' }, button(partial ? 'Retomar download' : 'Baixar', startDownload, { primary: true, disabled: !canDownload, act: 'download' })));
  }

  /** Durante o download a tela fica enxuta: só o vídeo, a barra e o botão de cancelar. */
  function runningCard() {
    const d = S.vod.data;
    const title = d ? d.meta.title : ((S.vod.progress && S.vod.progress.title) || 'Download em andamento');
    return el('div', { class: 'src-card running' },
      cardHead('downloading', title, d ? metaLine(d.meta) : ''),
      progressBlock());
  }

  function progressBlock() {
    const ev = S.vod.progress || { phase: 'prepare', message: 'Preparando…', percent: null };
    const bar = el('progress', { max: '100', value: ev.percent !== null && ev.percent !== undefined ? Math.floor(ev.percent) : undefined, 'aria-label': 'Progresso do download', dataset: { role: 'bar' } });
    const text = el('span', { class: 'muted small', 'aria-live': 'off', dataset: { role: 'text' } }, progressLine(ev));
    return el('div', { class: 'src-progress', tabindex: '-1', dataset: { phase: ev.phase, focus: 'stage' } },
      bar, text, button('Cancelar', cancelJob, { act: 'cancel' }));
  }

  function progressLine(ev) {
    if (ev.phase === 'merge') return 'Juntando vídeo e áudio…';
    if (ev.phase === 'finishing') return 'Guardando o arquivo…';
    if (ev.phase === 'chat') return ev.message || 'Baixando o chat…';
    if (ev.phase === 'prepare') return ev.message || 'Preparando…';
    const parts = [];
    if (ev.percent !== null && ev.percent !== undefined) parts.push(`${Math.floor(ev.percent)}%`);
    if (ev.downloaded) parts.push(ev.total ? `${fmtBytes(ev.downloaded)} de ${fmtBytes(ev.total)}` : fmtBytes(ev.downloaded));
    if (ev.speed) parts.push(`${fmtBytes(ev.speed)}/s`);
    const eta = fmtEta(ev.eta);
    if (eta) parts.push(`faltam ${eta}`);
    const text = parts.join(' · ') || ev.message || 'Baixando…';
    return ev.resumed ? `Retomado · ${text}` : text;
  }

  /** Atualiza a barra sem redesenhar a seção (chega várias vezes por segundo). */
  function updateProgress(ev) {
    S.vod.progress = ev;
    const holder = box.vod && box.vod.querySelector('.src-progress');
    if (!holder) return;
    holder.dataset.phase = ev.phase;
    const bar = holder.querySelector('progress');
    if (ev.percent !== null && ev.percent !== undefined) bar.value = Math.floor(ev.percent); else bar.removeAttribute('value');
    holder.querySelector('[data-role="text"]').textContent = progressLine(ev);
  }

  function doneBlock() {
    const r = S.vod.result;
    return el('div', { class: 'src-card ok', ...stageProps() },
      el('div', { class: 'src-card-head' },
        el('span', { class: 'src-thumb ok' }, icon('check_circle')),
        el('div', { class: 'src-card-info' },
          el('div', { class: 'src-title' }, 'Download concluído'),
          el('div', { class: 'src-path', title: r.path }, r.path),
          el('div', { class: 'muted small' }, `${fmtBytes(r.bytes)}${r.resumed ? ' · retomado de um download anterior' : ''}`))),
      r.chat ? note('info', `Chat baixado: ${r.chat.count.toLocaleString('pt-BR')} mensagens.`) : null,
      r.chatNote ? note('warn', r.chatNote) : null,
      // o aviso de pouco espaço já foi dado ANTES de baixar (cartão do vídeo); depois do fim ele não ajuda mais
      (r.warnings || []).filter((w) => w.code !== 'LOW_DISK').map((w) => note('warn', w.message)),
      el('div', { class: 'src-actions' },
        button('Abrir como projeto', openDownloaded, { primary: true, act: 'open-vod' }),
        button('Mostrar na pasta', () => BF.api('shell:reveal', { path: r.path }), { act: 'reveal' }),
        button('Baixar outro', () => { S.vod.stage = 'idle'; S.vod.data = null; S.vod.result = null; S.vod.url = ''; renderVod(); if (urlInput) urlInput.value = ''; }, { act: 'another', link: true })));
  }

  function errorBlock() {
    const e = S.vod.error || {};
    const details = e.details || {};
    const retry = S.vod.url.trim();
    return el('div', { class: 'src-card bad', ...stageProps() },
      note('error', e.message || 'Não foi possível concluir.'),
      details.dependsOnAccess ? el('p', { class: 'muted small' }, 'Isso depende de acesso, permissões ou disponibilidade da fonte: nem sempre dá para resolver pelo app.') : null,
      details.raw ? el('details', { class: 'src-tech' }, el('summary', {}, 'Detalhe técnico'), el('p', { class: 'small' }, details.raw)) : null,
      el('div', { class: 'src-actions' },
        retry ? el('button', { type: 'button', class: 'primary sm', dataset: { act: 'retry' }, onclick: fetchMeta }, 'Tentar de novo') : null,
        S.vod.data ? button('Voltar', () => { S.vod.stage = 'ready'; S.vod.error = null; renderVod(); }, { act: 'back' }) : null));
  }

  const vodStageTarget = () => (box.vod ? box.vod.querySelector('[data-focus="stage"]') : null);

  // o selo "Baixando" do cartão acompanha a etapa do download (iniciar, terminar, cancelar): por isso os cartões são redesenhados junto
  function renderVod() { renderChoices(); keepFocus(drawVod, vodStageTarget); }

  function drawVod() {
    if (!box.vod) return;
    const stage = S.vod.stage;
    const busy = stage === 'running' || stage === 'fetching';
    // somente leitura (e não "desabilitado"): o campo desabilitado perde o foco e o teclado voltava ao topo da página
    if (urlInput) { urlInput.readOnly = busy; urlInput.setAttribute('aria-busy', busy ? 'true' : 'false'); }
    if (box.vodButton) {
      box.vodButton.disabled = busy || !ytReady();
      box.vodButton.textContent = stage === 'fetching' ? 'Buscando…' : 'Buscar';
      // um destaque só: depois da busca, ele passa para o botão do cartão (Baixar, Abrir como projeto, Tentar de novo)
      box.vodButton.classList.toggle('primary', stage === 'idle');
      box.vodButton.classList.toggle('secondary', stage !== 'idle');
    }
    const parts = [];
    if (S.ready && !ytReady()) parts.push(toolsHint('O yt-dlp (programa que baixa os vídeos) não está instalado. Ele vem da página oficial do projeto, com tamanho e SHA-256 conferidos.'));
    if (S.tools && S.tools.ytdlp.found && S.tools.ytdlp.outdated) parts.push(toolsHint(`O yt-dlp deste computador é antigo (versão ${S.tools.ytdlp.version}, de ${S.tools.ytdlp.ageDays} dias atrás). O YouTube muda com frequência e versões velhas costumam dar erro 403. ${S.tools.ytdlp.hostProvided ? `Atualize o yt-dlp pelo ${S.tools.ytdlp.hostName || 'aplicativo que abriu o Braga Frame'}: ele é o dono dessa ferramenta e o Braga Frame não guarda outra cópia.` : 'Instale o yt-dlp oficial na aba Ferramentas.'}`));
    if (S.tools && S.tools.ytdlp.found && !S.tools.ffmpeg.found) parts.push(note('warn', 'O FFmpeg não foi encontrado: ele é necessário para juntar vídeo e áudio. Veja a aba Ferramentas.'));
    if (stage === 'idle' && S.vod.note) parts.push(note('info', S.vod.note));
    if (stage === 'fetching') {
      parts.push(el('div', { class: 'src-wait', ...stageProps() },
        el('span', { class: 'src-thumb src-skel-box', 'aria-hidden': 'true' }),
        el('div', { class: 'src-wait-text' },
          el('p', { class: 'muted', 'aria-live': 'polite' }, 'Consultando o vídeo…'),
          el('span', { class: 'src-skel-line', 'aria-hidden': 'true' })),
        button('Cancelar', cancelFetch, { act: 'cancel-fetch' })));
    }
    if (stage === 'error') parts.push(errorBlock());
    if (stage === 'ready' && S.vod.data) parts.push(vodCard());
    if (stage === 'running') parts.push(runningCard());
    if (stage === 'done' && S.vod.result) parts.push(doneBlock());
    box.vodBody.replaceChildren(...parts);
    box.vod.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function buildVodSection() {
    urlInput = el('input', {
      type: 'text', class: 'src-url', placeholder: VOD_TEXT.youtube.placeholder,
      'aria-label': 'Link do vídeo', spellcheck: 'false', autocomplete: 'off', value: S.vod.url,
      oninput: (event) => { S.vod.url = event.target.value; followPlatform(); },
      onkeydown: (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); fetchMeta(); } }
    });
    box.vodButton = el('button', { type: 'button', class: 'primary', dataset: { act: 'fetch' }, onclick: fetchMeta }, 'Buscar');
    box.vodBody = el('div', { class: 'src-body' });
    // título, ícone e explicação mudam com o cartão (YouTube ou Twitch); veja renderChoices
    box.vodIcon = icon('smart_display');
    box.vodTitle = el('h2', {}, VOD_TEXT.youtube.title);
    box.vodLead = el('p', { class: 'src-lead muted' }, VOD_TEXT.youtube.lead);
    box.vod.replaceChildren(
      el('div', { class: 'src-head' },
        el('span', { class: 'src-head-icon' }, box.vodIcon),
        box.vodTitle),
      box.vodLead,
      el('div', { class: 'src-urlrow' }, icon('link', 'src-url-icon'), urlInput, box.vodButton),
      el('details', { class: 'src-why' },
        el('summary', {}, 'O que pode não funcionar'),
        el('p', { class: 'muted small' }, 'Baixar depende de acesso, permissões e disponibilidade da fonte: vídeos privados, só para membros ou inscritos, com restrição de idade ou de região e VODs que a Twitch já apagou podem não estar disponíveis.')),
      box.vodBody);
  }

  // ---------- 3. chat do projeto ----------

  function projectOrigin() {
    const p = BF.state.project;
    return p && p.source && p.source.origin ? p.source.origin : null;
  }

  async function checkProjectChat() {
    const p = BF.state.project;
    S.chat.check = null;
    if (p && p.chat && p.chat.path) {
      const res = await BF.api('sources:chatCheck', { path: p.chat.path });
      if (BF.state.project === p) S.chat.check = res.ok ? res : { exists: false, reason: res.message };
    }
    renderChat();
  }

  async function downloadProjectChat() {
    const p = BF.state.project;
    const origin = projectOrigin();
    if (!p || !origin || !origin.url) return;
    S.chat.busy = true;
    S.chat.error = null;
    S.chat.note = '';
    S.chat.progress = { phase: 'chat', message: 'Baixando o chat…' };
    renderChat();
    BF.ui.refreshTabs();
    const res = await BF.api('sources:chat', { url: origin.url });
    S.chat.busy = false;
    S.chat.progress = null;
    if (res.ok) {
      if (BF.state.project && BF.state.project.id === p.id) {
        BF.project.update((project) => { project.chat = res.chat; }, { reason: 'sources:chat' });
        S.chat.check = { exists: true, count: res.chat.count, platform: res.chat.platform };
        BF.ui.toast(`Chat baixado: ${res.chat.count.toLocaleString('pt-BR')} mensagens.`, 'ok');
      } else {
        S.chat.note = 'O chat foi baixado, mas outro projeto foi aberto no meio do caminho. Abra o projeto de novo e use “Baixar chat”.';
      }
    } else if (res.code === 'CANCELLED') {
      S.chat.note = 'Download do chat cancelado.';
    } else {
      S.chat.error = res;
    }
    renderChat();
    BF.ui.refreshTabs();
  }

  function renderChat() { keepFocus(drawChat, () => (box.chat ? box.chat.querySelector('[data-focus="stage"]') : null)); }

  function drawChat() {
    if (!box.chat) return;
    const p = BF.state.project;
    box.chat.hidden = !p;
    if (!p) { box.chat.replaceChildren(); return; }
    const origin = projectOrigin();
    const vod = Boolean(origin && origin.type === 'vod' && origin.url);
    const title = el('h2', {}, 'Chat do projeto');
    const parts = [el('div', { class: 'src-head' }, el('span', { class: 'src-head-icon' }, icon('forum')), title)];
    if (p.chat && p.chat.path) {
      const check = S.chat.check;
      if (!check) parts.push(skeleton('Conferindo o chat…'));
      else if (check.exists) parts.push(el('p', {}, `Chat anexado: ${check.count.toLocaleString('pt-BR')} mensagens${p.chat.fetchedAt ? `, baixado em ${fmtWhen(p.chat.fetchedAt)}` : ''}. A aba Análise usa o ritmo do chat para achar momentos.`));
      else parts.push(note('warn', `O arquivo do chat não foi encontrado (${check.reason || 'foi apagado ou movido'}). ${vod ? 'Baixe de novo abaixo.' : ''}`));
    }
    const missing = !p.chat || (S.chat.check && !S.chat.check.exists);
    if (missing && vod) {
      const twitch = origin.platform === 'twitch';
      const blocked = twitch ? !twitchToolReady() : !ytReady();
      if (!p.chat) parts.push(el('p', { class: 'muted' }, 'Este projeto vem de um VOD e ainda não tem o chat. Ele ajuda a Análise a achar momentos.'));
      if (blocked) parts.push(toolsHint(twitch ? 'Para baixar o chat da Twitch, instale o TwitchDownloaderCLI.' : 'Para baixar o chat do YouTube, instale o yt-dlp.'));
      if (S.chat.busy) {
        parts.push(el('div', { class: 'src-progress', ...stageProps() }, el('progress', { max: '100', 'aria-label': 'Baixando o chat' }), el('span', { class: 'muted small' }, 'Baixando o chat…'), button('Cancelar', cancelJob, { act: 'cancel-chat' })));
      } else {
        parts.push(el('div', { class: 'src-actions' }, button('Baixar chat', downloadProjectChat, { primary: true, disabled: blocked, act: 'download-chat' })));
      }
    } else if (!p.chat) {
      parts.push(el('p', { class: 'muted' }, origin && origin.type === 'obs' ? 'Gravações do OBS não têm chat para baixar.' : 'Este vídeo não veio de um VOD, então não há chat para baixar.'));
    }
    if (S.chat.error) {
      parts.push(note('error', S.chat.error.message));
      if (S.chat.error.details && S.chat.error.details.dependsOnAccess) parts.push(el('p', { class: 'muted small' }, 'Isso depende de acesso, permissões ou disponibilidade da fonte.'));
    }
    if (S.chat.note) parts.push(note('info', S.chat.note));
    // alvo de foco da seção (veja keepFocus): a barra de progresso enquanto baixa; sem ela, o título
    if (!parts.some((node) => node && node.dataset && node.dataset.focus === 'stage')) {
      title.setAttribute('tabindex', '-1');
      title.dataset.focus = 'stage';
    }
    box.chat.replaceChildren(...parts);
  }

  // ---------- 4. avançado ----------

  async function setCookies(value) {
    const res = await BF.api('sources:setSettings', { cookiesBrowser: value }, { toast: true });
    if (res.ok) { S.settings = res.settings; renderAdvanced(); } else renderAdvanced();
  }

  function toolLine(label, state) {
    return el('li', {}, el('span', { class: `bds-chip src-tool ${state.ok ? 'bds-chip-ok' : 'bds-chip-warn'}` }, `${label}: ${state.text}`));
  }

  function renderAdvanced() {
    if (!box.adv) return;
    const t = S.tools;
    const select = el('select', { 'aria-label': 'Navegador para os cookies', dataset: { act: 'cookies' }, onchange: (event) => setCookies(event.target.value) },
      el('option', { value: '', selected: !S.settings.cookiesBrowser }, 'Não usar (padrão)'),
      BROWSERS.map(([id, label]) => el('option', { value: id, selected: S.settings.cookiesBrowser === id }, label)));
    const lines = [];
    if (t) {
      lines.push(toolLine('yt-dlp', { ok: t.ytdlp.found, text: t.ytdlp.found ? (t.ytdlp.version ? `versão ${t.ytdlp.version}` : 'encontrado') : 'não instalado' }));
      lines.push(toolLine('TwitchDownloaderCLI (chat da Twitch)', { ok: t.twitchDownloader.found, text: t.twitchDownloader.found ? 'encontrado' : 'não instalado' }));
      const js = t.jsRuntime;
      lines.push(toolLine('Deno (recomendado para o YouTube)', { ok: js.found, text: js.found ? (js.origin === 'app' ? 'instalado pelo app' : 'do sistema') : 'não instalado' }));
      lines.push(toolLine('FFmpeg', { ok: t.ffmpeg.found, text: t.ffmpeg.found ? 'encontrado' : 'não encontrado' }));
    }
    box.adv.replaceChildren(
      el('summary', {}, 'Avançado'),
      el('div', { class: 'src-adv' },
        row('Usar cookies do navegador', 'Só para vídeos que exigem login (membros, inscritos, restrição de idade) ou quando o YouTube pede para confirmar que você não é um robô.', select),
        el('details', { class: 'src-privacy' },
          el('summary', {}, 'Como isso funciona'),
          el('p', { class: 'muted small' }, 'O yt-dlp lê, neste computador, os cookies do navegador escolhido e os envia somente ao site do vídeo; isso dá a ele acesso à sua sessão, então use só com contas suas. O Braga Frame não guarda nem copia esses cookies. Se der erro de leitura, feche o navegador e tente de novo. Deixe em “Não usar” para vídeos públicos.')),
        t ? el('div', { class: 'src-adv-tools' },
          el('span', { class: 'src-row-title' }, 'Ferramentas'),
          el('ul', { class: 'src-tools' }, lines)) : null,
        el('div', { class: 'src-actions' }, button('Abrir Ferramentas', goTools, { act: 'tools-adv' }))));
  }

  // ---------- montagem ----------

  function renderAll() {
    renderChoices();
    renderObs();
    renderVod();
    renderChat();
    renderAdvanced();
  }

  BF.ui.registerTab({
    id: 'sources',
    title: 'Novo projeto',
    order: 6, // logo depois de Projetos: é de lá que se começa um projeto novo
    icon: 'add_circle',
    badge: () => (S.vod.stage === 'running' || S.chat.busy ? '…' : ''),
    render(container) {
      root = el('div', { class: 'sources' }, el('h2', { class: 'src-question' }, 'Como deseja adicionar o seu vídeo?'));
      buildChoices();
      box.files = el('section', { class: 'src-section panel', dataset: { section: 'files' }, 'aria-label': 'Arquivos locais' });
      box.vod = el('section', { class: 'src-section panel', dataset: { section: 'vod' }, 'aria-label': VOD_TEXT.youtube.label });
      box.obs = el('section', { class: 'src-section panel', dataset: { section: 'obs' }, 'aria-label': 'Gravações do OBS' });
      box.chat = el('section', { class: 'src-section panel', dataset: { section: 'chat' }, 'aria-label': 'Chat do projeto', hidden: true });
      box.adv = el('details', { class: 'src-section src-advanced', dataset: { section: 'advanced' } });
      root.append(box.choices, box.files, box.vod, box.obs, box.chat, box.adv);
      container.append(root);
      buildFilesSection();
      buildVodSection();
      S.source = rememberedKind() || 'files';
      renderAll();
      BF.ready.then(() => refresh().then(() => { S.ready = true; renderAll(); }));
    },
    onShow() { if (S.ready) refresh(); }
  });

  // ---------- eventos ----------

  BF.on('sources:progress', (ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'chat') {
      if (!S.chat.busy) return;
      S.chat.progress = ev;
      const final = ev.phase === 'done' || ev.phase === 'cancelled' || ev.phase === 'error';
      if (final && S.chat.adopted) { // ninguém está esperando a resposta (a janela foi recarregada no meio): o evento final encerra
        S.chat.busy = false;
        S.chat.adopted = false;
        S.chat.progress = null;
        S.chat.note = ev.phase === 'done'
          ? 'O download do chat terminou, mas esta tela não recebeu o resultado. Use “Baixar chat” para anexá-lo ao projeto.'
          : (ev.message || 'O download do chat terminou.');
        renderChat();
        BF.ui.refreshTabs();
        return;
      }
      const text = box.chat && box.chat.querySelector('.src-progress .muted');
      if (text) text.textContent = ev.message || 'Baixando o chat…';
      return;
    }
    if (S.vod.stage === 'running') {
      if (ev.phase === 'done' || ev.phase === 'cancelled' || ev.phase === 'error') {
        S.vod.progress = ev;
        if (S.vod.adopted) { // ninguém está esperando a resposta: encerra aqui
          S.vod.adopted = false;
          S.vod.stage = 'idle';
          BF.ui.toast(ev.phase === 'done' ? 'Download concluído. O vídeo está na pasta de destino.' : (ev.message || 'O download terminou.'), ev.phase === 'done' ? 'ok' : 'error');
          renderVod();
          BF.ui.refreshTabs();
        }
        return; // quem iniciou recebe a resposta pelo próprio pedido
      }
      updateProgress(ev);
    }
  });

  BF.bus.on('tools:changed', () => { if (root) refresh(); });
  BF.bus.on('tab:changed', ({ id } = {}) => { activeTab = id || null; });
  BF.bus.on('project:loaded', () => { S.chat.error = null; S.chat.note = ''; if (root) { checkProjectChat(); loadObs(); } });
  BF.bus.on('project:changed', ({ reason } = {}) => { if (root && (reason === 'sources:chat' || reason === 'sources:attach')) renderChat(); });

  // ---------- ganchos de abertura ----------

  /** Antes de abrir: se o arquivo é um VOD baixado aqui ou uma gravação numa pasta do OBS, preenche a origem. */
  BF.hooks.add('beforeOpen', async (ctx) => {
    if (!ctx || !ctx.path) return;
    if (ctx.origin) return; // quem abriu já informou (botões desta aba)
    const res = await BF.api('sources:originFor', { path: ctx.path });
    if (res.ok && res.known) {
      ctx.origin = res.origin;
      known.set(norm(ctx.path), { kind: res.kind, origin: res.origin, chat: res.chat, meta: res.meta });
    }
  });

  /** Abrir um vídeo estando nesta tela (arrastar, "Abrir vídeo", escolher o arquivo…) leva direto para a aba Cortes: o projeto já está pronto. */
  function leaveForCuts() {
    if (activeTab === 'sources') BF.ui.selectTab('cuts');
  }

  /** Depois de abrir: segue para Cortes (se estava aqui), preenche jogo/canal (só se vazios) e anexa o chat do VOD (se o arquivo existe). */
  BF.hooks.add('afterOpen', async (ctx) => {
    leaveForCuts();
    await attachKnown(ctx);
  });

  async function attachKnown(ctx) {
    if (!ctx || !ctx.path) return;
    const info = known.get(norm(ctx.path));
    known.delete(norm(ctx.path));
    if (!info || info.kind !== 'vod') return;
    const project = BF.state.project;
    if (!project || norm(project.source.path) !== norm(ctx.path)) return;
    const wantMeta = (info.meta.game && !project.meta.game) || (info.meta.channel && !project.meta.channel);
    let chat = null;
    if (info.chat && info.chat.path && !project.chat) {
      const check = await BF.api('sources:chatCheck', { path: info.chat.path });
      if (check.ok && check.exists) chat = info.chat;
    }
    if (!wantMeta && !chat) return;
    if (BF.state.project !== project) return; // outro vídeo abriu durante a conferência do chat: nada deste VOD vale para ele
    BF.project.update((p) => {
      if (info.meta.game && !p.meta.game) p.meta.game = info.meta.game;
      if (info.meta.channel && !p.meta.channel) p.meta.channel = info.meta.channel;
      if (chat && !p.chat) p.chat = chat;
    }, { reason: 'sources:attach' });
    S.chat.check = null;
    checkProjectChat();
  }

  BF.sources = {
    state: S,
    format: { fmtBytes, fmtDuration, fmtEta, dayLabel, groupByDay, progressLine, metaLine },
    refresh,
    loadState,
    fetchMeta,
    startDownload,
    downloadProjectChat,
    openRecording,
    pickFile,
    selectSource,
    platformOfUrl,
    known
  };
})();

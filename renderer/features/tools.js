'use strict';

/**
 * Aba "Ferramentas" (dono: base). Duas partes, cada uma num cartão:
 *  - FFmpeg e FFprobe, que vêm do sistema (com a versão detectada e, se faltarem, como instalar);
 *  - as ferramentas oficiais que o app instala sozinho (as entradas de src/core/tools/entries): estado em selo,
 *    versão, origem resumida (o endereço completo fica em "Detalhes"), um único destaque por linha (Instalar, ou
 *    Atualizar só quando há versão nova; Remover é um ícone discreto), barra de progresso e erros explicados.
 * Os dados vêm de tools:status; o progresso, de tools:progress; as mudanças, de tools:changed (que o
 * app.js repassa para o BF.bus). Sem nenhuma entrada no registro, só as ferramentas do sistema aparecem.
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;

  let root = null;            // container da aba
  let data = null;            // última resposta de tools:status
  let loadError = null;
  let loadSeq = 0;
  let rechecking = false;
  const progress = new Map(); // id -> último evento de tools:progress
  const errors = new Map();   // id -> mensagem de erro da última tentativa
  const notes = new Map();    // id -> aviso neutro (ex.: "Instalação cancelada.")
  const installing = new Set();
  const cancelling = new Set();
  const removing = new Set();
  const openDetails = new Set();

  const TOOL_ICONS = { ytdlp: 'download', deno: 'terminal', twitchdownloader: 'forum', whisper: 'subtitles', 'whisper-cuda': 'memory', ffmpeg: 'movie', ffprobe: 'analytics' };

  // ---------- formatação ----------

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const value = n / 1024 ** i;
    return `${value.toLocaleString('pt-BR', { maximumFractionDigits: value >= 100 || i === 0 ? 0 : 1 })} ${units[i]}`;
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  }

  function progressText(ev) {
    if (!ev) return 'Preparando…';
    if (ev.phase === 'download' && ev.received > 0) {
      const pct = ev.total ? Math.min(100, Math.floor((ev.received / ev.total) * 100)) : 0;
      const speed = ev.speedBps > 0 ? ` · ${fmtBytes(ev.speedBps)}/s` : '';
      return `Baixando… ${pct}% · ${fmtBytes(ev.received)} de ${fmtBytes(ev.total)}${speed}`;
    }
    return ev.message || 'Preparando…';
  }

  /** "yt-dlp (VODs do YouTube e da Twitch)" -> { name: 'yt-dlp', what: 'VODs do YouTube e da Twitch' }. */
  function splitLabel(label) {
    const m = /^(.*?)\s*\((.+)\)\s*$/.exec(String(label || ''));
    return m ? { name: m[1], what: m[2] } : { name: String(label || ''), what: '' };
  }

  /** "oficial: https://github.com/yt-dlp/yt-dlp/releases/tag/1" -> { text: 'GitHub oficial · yt-dlp/yt-dlp', url } (o link completo vai em "Detalhes"). */
  function originOf(t) {
    const raw = String(t.source || '');
    const m = /(https?:\/\/\S+)/.exec(raw);
    let url = null;
    try { url = m ? new URL(m[1]) : null; } catch { url = null; }
    if (!url) return { text: raw.replace(/^oficial:\s*/i, ''), url: m ? m[1] : '' };
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname) || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.test');
    if (local) return { text: 'Servidor local de teste', url: url.href };
    const official = /^oficial/i.test(raw) ? 'oficial' : 'da origem';
    if (url.hostname === 'github.com') {
      const [owner, repo] = url.pathname.split('/').filter(Boolean);
      return { text: `GitHub ${official}${owner && repo ? ` · ${owner}/${repo}` : ''}`, url: url.href };
    }
    return { text: `Site ${official} · ${url.hostname}`, url: url.href };
  }

  // ---------- carga ----------

  let gpuLine = '';  // "Placa NVIDIA GeForce GTX 1650 · 4 GB — a transcrição pode usar a placa" (vazio = sem placa ou sem resposta)
  const BIG_DOWNLOAD = 200 * 1024 * 1024;

  async function load() {
    const seq = ++loadSeq;
    const hardware = BF.api('subtitles:hardware'); // não segura a lista: a consulta da placa pode demorar um pouco
    const res = await BF.api('tools:status');
    if (seq !== loadSeq) return; // chegou resposta velha
    if (res.ok) { data = res; loadError = null; } else { loadError = res.message; }
    render();
    const hw = await hardware;
    if (seq !== loadSeq) return;
    const line = hw && hw.ok && hw.gpu && hw.gpu.name
      ? `Placa ${hw.gpu.summary || hw.gpu.name}${hw.gpu.available ? ' — a transcrição pode usar a placa.' : ` — ${hw.gpu.reason}`}`
      : '';
    if (line !== gpuLine) { gpuLine = line; render(); }
  }

  // ---------- desenho ----------

  const icon = (name) => el('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true' }, name);
  const chip = (text, kind, extra = '') => el('span', { class: `bds-chip${kind ? ` bds-chip-${kind}` : ''}${extra ? ` ${extra}` : ''}` }, text);

  /** act/toolId vão em data-*: o teclado volta ao mesmo botão depois de redesenhar e os testes o encontram. */
  function button(label, act, toolId, { primary = false, disabled = false, onClick } = {}) {
    return el('button', { type: 'button', class: primary ? 'primary sm' : 'secondary sm', dataset: { act, tool: toolId }, disabled, onclick: onClick }, label);
  }

  /** Ação discreta: só o ícone (o nome fica no title e no aria-label). */
  function iconButton(name, label, act, toolId, { disabled = false, onClick } = {}) {
    return el('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, dataset: { act, tool: toolId }, disabled, onclick: onClick }, icon(name));
  }

  function ffmpegHelp(platform) {
    let steps;
    if (platform === 'win32') {
      steps = [
        'Baixe uma versão para Windows em ffmpeg.org/download.html (página oficial do projeto).',
        'Extraia e adicione a pasta "bin" ao PATH do Windows (ou aponte CORTE_FFMPEG e CORTE_FFPROBE para os dois programas).',
        'Reabra o Braga Frame (o PATH só vale para programas abertos depois). Se os programas já estão numa pasta do PATH, basta clicar em Verificar de novo.'
      ];
    } else if (platform === 'darwin') {
      steps = ['Instale pelo Homebrew: brew install ffmpeg.', 'Reabra o Braga Frame ou clique em Verificar de novo.'];
    } else {
      steps = ['Instale pelo gerenciador de pacotes da sua distribuição (por exemplo: sudo apt install ffmpeg).', 'Clique em Verificar de novo.'];
    }
    return el('div', { class: 'tool-help', role: 'note' },
      icon('info'),
      el('div', { class: 'tool-help-body' },
        el('strong', {}, 'Como instalar o FFmpeg'),
        el('p', {}, 'O FFmpeg vem do seu computador: o projeto FFmpeg não publica programas prontos, então o Braga Frame não baixa esta ferramenta.'),
        el('p', {}, 'Para instalar:'),
        el('ol', {}, steps.map((s) => el('li', {}, s)))));
  }

  function systemRow(item) {
    const found = Boolean(item.found);
    return el('li', { class: 'tool sys', dataset: { tool: item.id, state: found ? 'found' : 'absent' } },
      el('div', { class: 'tool-top' },
        el('span', { class: 'tool-icon' }, icon(TOOL_ICONS[item.id] || 'build')),
        el('div', { class: 'tool-main' },
          el('div', { class: 'tool-head' }, el('span', { class: 'tool-name' }, item.label)),
          found ? el('div', { class: 'tool-meta tool-path', title: item.path }, item.path) : el('div', { class: 'tool-meta' }, 'Precisa estar instalado no computador.')),
        found && item.origin === 'host'
          ? chip(item.version ? `Fornecido pelo ${hostLabel()} · versão ${item.version}` : `Fornecido pelo ${hostLabel()}`, 'ok', 'tool-status')
          : found
          ? chip(item.version ? `Encontrado · versão ${item.version}` : 'Encontrado', 'ok', 'tool-status')
          : chip('Não encontrado', 'bad', 'tool-status')));
  }

  const FINAL_PHASES = ['done', 'cancelled', 'error'];
  /** Há uma instalação rodando (iniciada aqui ou por outro caminho): evento de progresso ainda não final. */
  const running = (id) => progress.has(id) && !FINAL_PHASES.includes(progress.get(id).phase);

  function toolState(t) {
    if (!t.available) return 'unavailable';
    if (t.busy || installing.has(t.id) || running(t.id)) return 'busy';
    if (t.installed) return 'installed';
    if (t.outdated) return 'outdated';
    if (t.active.origin === 'host') return 'host';
    return t.active.origin === 'system' ? 'system' : 'missing';
  }

  const hostLabel = () => (data && data.host && data.host.name) || 'aplicativo';

  /** Texto e cor do selo de estado. */
  const STATE_CHIP = {
    unavailable: () => ['Indisponível', 'bad'],
    busy: () => ['Instalando…', 'accent'],
    installed: (t) => [`Instalado · versão ${t.installedVersion}`, 'ok'],
    outdated: (t) => [`Nova versão ${t.version}`, 'warn'],
    host: () => [`Fornecida pelo ${hostLabel()}`, 'ok'],
    system: () => ['Usando a do sistema', 'info'],
    missing: () => ['Não instalado', '']
  };

  function actions(t, state) {
    const id = t.id;
    if (state === 'busy') {
      const stopping = cancelling.has(id);
      return [button(stopping ? 'Cancelando…' : 'Cancelar', 'cancel', id, { disabled: stopping, onClick: () => cancel(t) })];
    }
    const wait = removing.has(id);
    if (state === 'host') return []; // vem do hospedeiro (somente leitura): atualizar ou trocar é por lá
    if (state === 'unavailable') return [button('Instalar', 'install', id, { primary: true, disabled: true })];
    const removeBtn = iconButton('delete', wait ? 'Removendo…' : `Remover ${splitLabel(t.label).name}`, 'remove', id, { disabled: wait, onClick: () => remove(t) });
    if (state === 'installed') return [removeBtn];
    if (state === 'outdated') return [button('Atualizar', 'install', id, { primary: true, disabled: wait, onClick: () => install(t) }), removeBtn];
    return [button('Instalar', 'install', id, { primary: true, onClick: () => install(t) })]; // system | missing
  }

  function progressBox(t) {
    const ev = progress.get(t.id);
    const known = ev && ev.phase === 'download' && ev.received > 0 && Number.isFinite(ev.percent);
    return el('div', { class: 'tool-progress' },
      el('progress', { max: '100', value: known ? Math.round(ev.percent) : undefined, 'aria-label': `Progresso da instalação de ${t.label}` }),
      el('span', { class: 'tool-progress-text muted small', 'aria-live': 'off' }, progressText(ev)));
  }

  function toolRow(t) {
    const state = toolState(t);
    const { name, what } = splitLabel(t.label);
    const origin = originOf(t);
    const wait = removing.has(t.id);
    const [chipText, chipKind] = wait ? ['Removendo…', 'accent'] : STATE_CHIP[state](t);

    const meta = [];
    if (state === 'unavailable') meta.push(t.unavailableReason);
    else if (what) meta.push(what);
    if (state === 'system') meta.push(`Do sistema: ${t.active.path}`);
    if (state === 'host') meta.push(`${t.active.path}${t.active.version ? ` · versão ${t.active.version}` : ''}`, `Para atualizar, use o ${hostLabel()}: o Braga Frame não guarda outra cópia.`);
    if (state === 'outdated') meta.push(`Instalada: versão ${t.installedVersion} · nova: ${t.version} · download de ${fmtBytes(t.sizeBytes)}`);
    else if (state === 'host') { /* sem download daqui */ } else if (state === 'missing' || state === 'system') meta.push(`Versão ${t.version} · download de ${fmtBytes(t.sizeBytes)}`);

    if (t.sizeBytes >= BIG_DOWNLOAD && (state === 'missing' || state === 'system' || state === 'outdated')) {
      meta.push(`Download grande: só é baixado quando você instala, e ocupa bem mais que isso no disco depois de extraído.`);
    }

    const details = [];
    if (t.installed && t.active.path) details.push(el('div', {}, `Em uso: ${t.active.path}`));
    if (t.installed && t.installedAt) details.push(el('div', {}, `Instalado em ${fmtDate(t.installedAt)}`));
    details.push(el('div', {}, `Origem: ${t.source}`));

    return el('li', { class: 'tool', dataset: { tool: t.id, state }, 'aria-busy': state === 'busy' ? 'true' : undefined },
      el('div', { class: 'tool-top' },
        el('span', { class: 'tool-icon' }, icon(TOOL_ICONS[t.id] || 'build')),
        el('div', { class: 'tool-main' },
          el('div', { class: 'tool-head' },
            el('span', { class: 'tool-name' }, name),
            t.test ? chip('teste local', 'warn', 'tool-tag') : null),
          meta.filter(Boolean).map((line) => el('div', { class: 'tool-meta' }, line)),
          state === 'host' ? null : el('div', { class: 'tool-meta tool-origin', title: origin.url || t.source }, icon('verified'), origin.text)),
        chip(chipText, chipKind, 'tool-status'),
        el('div', { class: 'tool-actions' }, actions(t, state))),
      state === 'busy' ? progressBox(t) : null,
      errors.has(t.id) ? el('p', { class: 'tool-error', role: 'alert' }, icon('error'), el('span', {}, errors.get(t.id))) : null,
      notes.has(t.id) ? el('p', { class: 'tool-meta' }, notes.get(t.id)) : null,
      el('details', {
        class: 'tool-details', open: openDetails.has(t.id),
        ontoggle: (event) => { if (event.target.open) openDetails.add(t.id); else openDetails.delete(t.id); }
      }, el('summary', {}, 'Detalhes'), details));
  }

  /** Cartão de uma seção: ícone vermelho, título, ação opcional e a lista. */
  function section(iconName, title, action, ...body) {
    return el('section', { class: 'tools-section panel' },
      el('div', { class: 'tools-head' },
        el('span', { class: 'tools-head-icon' }, icon(iconName)),
        el('h2', {}, title),
        action || null),
      body);
  }

  function skeleton() {
    return el('div', { class: 'tools-skeleton', role: 'status', 'aria-busy': 'true' },
      el('span', { class: 'sr-only' }, 'Lendo as ferramentas…'),
      [0, 1].map(() => el('div', { class: 'tool-skel', 'aria-hidden': 'true' })));
  }

  function build() {
    const intro = el('p', { class: 'tools-intro' }, 'Programas externos que o Braga Frame usa. Os que o app instala vêm só da página oficial de cada projeto, com tamanho e SHA-256 conferidos.',
      gpuLine ? el('span', { class: 'tools-gpu muted small', dataset: { gpu: 'line' } }, ` ${gpuLine}`) : null);
    if (!data) {
      if (loadError) {
        return [intro, el('div', { class: 'empty-state tools-error', role: 'alert' },
          el('span', { class: 'empty-state-icon material-symbols-rounded', 'aria-hidden': 'true' }, 'error'),
          el('div', { class: 'empty-state-text' },
            el('strong', {}, 'Não foi possível ler as ferramentas'),
            el('p', {}, loadError),
            el('div', { class: 'tools-error-actions' }, button('Tentar de novo', 'reload', 'system', { onClick: load }))))];
      }
      return [intro, section('build', 'Ferramentas', null, skeleton())];
    }
    const missing = data.system.filter((s) => !s.found);
    return [
      intro,
      section('computer', 'No seu computador',
        button(rechecking ? 'Verificando…' : 'Verificar de novo', 'recheck', 'system', { disabled: rechecking, onClick: recheck }),
        el('ul', { class: 'tool-list' }, data.system.map(systemRow)),
        missing.length ? ffmpegHelp(data.platform) : null),
      data.tools.length
        ? section('inventory_2', data.host && data.host.embedded ? `Do ${hostLabel()} e instaladas pelo app` : 'Instaladas pelo app', null, el('ul', { class: 'tool-list' }, data.tools.map(toolRow)))
        : null
    ];
  }

  /** Guarda qual botão está em foco para devolvê-lo depois de redesenhar (teclado não perde o lugar). */
  function captureFocus() {
    const active = document.activeElement;
    if (!root || !active || !root.contains(active) || !active.dataset || !active.dataset.tool) return null;
    return { tool: active.dataset.tool, act: active.dataset.act };
  }

  function restoreFocus(focus) {
    if (!focus) return;
    const buttons = [...root.querySelectorAll('button')].filter((b) => b.dataset.tool === focus.tool && !b.disabled);
    const target = buttons.find((b) => b.dataset.act === focus.act) || buttons[0];
    if (target) target.focus();
  }

  function render() {
    if (!root) return;
    const focus = captureFocus();
    root.replaceChildren(...build().filter(Boolean));
    restoreFocus(focus);
    BF.ui.refreshTabs();
  }

  function rowFor(id) {
    return root ? [...root.querySelectorAll('li.tool')].find((li) => li.dataset.tool === id) || null : null;
  }

  /** Progresso chega várias vezes por segundo: atualiza só a barra da linha em vez de redesenhar tudo. */
  function onProgress(ev) {
    if (!ev || typeof ev.id !== 'string') return;
    progress.set(ev.id, ev);
    if (!data) return;
    const row = rowFor(ev.id);
    const bar = row && row.querySelector('progress');
    if (FINAL_PHASES.includes(ev.phase)) {
      if (!installing.has(ev.id)) { progress.delete(ev.id); load(); } // instalação iniciada por outro caminho terminou
      return;
    }
    if (!bar) { render(); return; } // instalação iniciada por outro caminho: mostra a linha com a barra
    if (ev.phase === 'download' && ev.received > 0 && Number.isFinite(ev.percent)) bar.value = Math.round(ev.percent);
    else bar.removeAttribute('value'); // sem percentual (extraindo, instalando): barra indeterminada
    const text = row.querySelector('.tool-progress-text');
    if (text) text.textContent = progressText(ev);
  }

  // ---------- ações ----------

  async function install(t) {
    if (t.sizeBytes >= BIG_DOWNLOAD) {
      const ok = await BF.ui.confirm({
        title: `Baixar ${splitLabel(t.label).name}?`,
        message: `É um download grande: ${fmtBytes(t.sizeBytes)} (ocupa mais no disco depois de extraído). Vem só da página oficial do projeto, com tamanho e SHA-256 conferidos, e você pode cancelar durante o download.`,
        okLabel: 'Baixar'
      });
      if (!ok) return;
    }
    errors.delete(t.id);
    notes.delete(t.id);
    progress.delete(t.id);
    cancelling.delete(t.id);
    installing.add(t.id);
    render();
    const res = await BF.api('tools:install', { id: t.id });
    installing.delete(t.id);
    cancelling.delete(t.id);
    progress.delete(t.id);
    if (res.ok) {
      BF.ui.toast(res.alreadyInstalled ? `${t.label} já estava instalado.` : `${t.label} instalado.`, 'ok');
    } else if (res.code === 'CANCELLED') {
      notes.set(t.id, 'Instalação cancelada. Nada foi alterado.');
    } else {
      errors.set(t.id, res.message);
      BF.ui.log(`${t.label}: ${res.message}`, 'error');
    }
    await load();
  }

  async function cancel(t) {
    cancelling.add(t.id);
    render();
    const res = await BF.api('tools:cancel', { id: t.id });
    if (!res.ok) {
      cancelling.delete(t.id);
      errors.set(t.id, res.message);
      render();
    }
    // ok: a chamada de tools:install volta com CANCELLED e redesenha a linha
  }

  async function remove(t) {
    const sure = await BF.ui.confirm({
      title: `Remover ${t.label}?`,
      message: 'O app apaga a versão que ele instalou. Se houver uma no sistema, ele volta a usá-la.',
      okLabel: 'Remover',
      danger: true
    });
    if (!sure) return;
    errors.delete(t.id);
    notes.delete(t.id);
    removing.add(t.id);
    render();
    const res = await BF.api('tools:remove', { id: t.id });
    removing.delete(t.id);
    if (res.ok) BF.ui.toast(res.removed ? `${t.label} removido.` : `${t.label} não estava instalado.`, 'ok');
    else { errors.set(t.id, res.message); BF.ui.log(`${t.label}: ${res.message}`, 'error'); }
    await load();
  }

  async function recheck() {
    rechecking = true;
    render();
    const res = await BF.api('app:refreshTools', {}, { toast: true });
    rechecking = false;
    if (res.ok) {
      const both = Boolean(res.tools.ffmpeg && res.tools.ffprobe);
      BF.ui.toast(both ? 'FFmpeg e FFprobe encontrados.' : 'O FFmpeg ainda não foi encontrado.', both ? 'ok' : 'error');
    }
    await load(); // se algo mudou, o main também manda tools:changed (o app.js repassa ao BF.bus)
  }

  // ---------- registro ----------

  BF.ui.registerTab({
    id: 'tools',
    title: 'Ferramentas',
    order: 90,
    badge: () => (BF.state.tools.ffmpeg && BF.state.tools.ffprobe ? '' : '!'),
    render(container) {
      root = el('div', { class: 'tools' }, ...build().filter(Boolean));
      container.append(root);
    },
    onShow() { load(); }
  });

  BF.on('tools:progress', onProgress);
  BF.bus.on('tools:changed', load);
})();

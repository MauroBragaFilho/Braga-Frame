'use strict';

/**
 * Aba "Legendas" (dono: subtitles). Por corte: legenda automática opcional (Whisper), revisão do texto, sincronia,
 * aparência e entrega (incorporada ao vídeo e/ou arquivo separado). A prévia é um texto HTML sobre o player,
 * sincronizado com o tempo dele, no tamanho e na posição que a exportação usa.
 *
 * Dados: `cut.subtitles` = { enabled, basedOn:{start,end,revision}, cues:[{start,end,text,needsReview?}], style, mode, … }
 * com tempos das falas RELATIVOS ao início do corte (contrato 2.2; veja docs/recursos/subtitles.md).
 * A lógica pura (estilo, divisão/junção de falas, rebase ao mudar o intervalo do corte) é a de
 * src/core/subtitles/shared.js, a mesma que o processo principal usa na exportação; ela é carregada por <script>
 * (window.BFSubtitles), pois o index.html é da base.
 */
(function () {
  const BF = window.BF;
  const { el, fmt } = BF.util;

  // ---------- núcleo compartilhado ----------

  let S = window.BFSubtitles || null;
  let coreError = null;
  if (!S) {
    const script = document.createElement('script');
    script.src = '../src/core/subtitles/shared.js';
    script.onload = () => { S = window.BFSubtitles; start(); };
    script.onerror = () => { coreError = 'Não foi possível carregar o módulo de legendas. Reinstale ou reinicie o Braga Frame.'; render(); };
    document.head.append(script);
  }

  // ---------- estado ----------

  let root = null;               // container da aba (o painel)
  let status = null;             // resposta de subtitles:status
  let statusError = null;
  let statusSeq = 0;
  let selectedId = null;         // corte escolhido (cut:selected ou o seletor da aba)
  let gen = null;                // geração em andamento: { cutId, projectId, percent, message, range }
  let engineBusy = false;
  let engineProgress = null;     // último tools:progress do whisper
  let cudaBusy = false;          // instalando o motor com placa NVIDIA (whisper-cuda)
  let cudaProgress = null;
  let engineOpen = false;        // seção "Motor" (avançado) aberta
  const modelBusy = new Set();
  const modelProgress = new Map(); // modelId -> último subtitles:modelProgress
  const errors = new Map();      // 'engine' | 'model:<id>' | 'gen' | 'import' -> mensagem
  const notes = new Map();       // cutId -> [{ kind, key, text, items? }] avisos do último resultado (só nesta sessão)
  const undoStacks = new Map();  // cutId -> [{ cues, basedOn }]
  let styleOpen = false;         // seção Aparência aberta: a prévia mostra um exemplo quando não há fala no ar
  let moreOpen = false;
  let pendingFocus = null;       // data-fid a focar depois de redesenhar
  let progressBar = null;        // elementos da barra da geração (atualizados sem redesenhar a aba)
  let progressText = null;
  let rowEls = [];               // linhas da lista de falas, para destacar a que está no ar
  let styleSnapshot = null;      // estilo antes de uma sequência de ajustes (para o 'decision')

  const UNDO_LIMIT = 30;
  const LANG_DEFAULT = 'pt';

  // ---------- utilidades ----------

  const project = () => BF.state.project;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const round3 = (n) => Math.round(n * 1000) / 1000;
  const durationOf = (cut) => Math.max(0, cut.end - cut.start);
  const fmtSec = (s) => `${(Math.round(s * 10) / 10).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const stamp = (cut) => { cut.updatedAt = new Date().toISOString(); };

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const value = n / 1024 ** i;
    return `${value.toLocaleString('pt-BR', { maximumFractionDigits: value >= 100 || i === 0 ? 0 : 1 })} ${units[i]}`;
  }

  function cutsList() {
    return project() ? [...project().cuts].sort((a, b) => a.start - b.start) : [];
  }

  /** Corte da aba: o escolhido; sem escolha, o único corte do projeto (se houver só um). */
  function currentCut() {
    const cuts = cutsList();
    const chosen = cuts.find((c) => c.id === selectedId);
    if (chosen) return chosen;
    return cuts.length === 1 ? cuts[0] : null;
  }

  const subsOf = (cut) => (cut && cut.subtitles && typeof cut.subtitles === 'object' ? cut.subtitles : null);
  const cuesOf = (cut) => (subsOf(cut) && Array.isArray(subsOf(cut).cues) ? subsOf(cut).cues : []);

  // Última escolha de idioma e modelo neste computador: conveniência por usuário (localStorage pode falhar; a aba funciona sem ele).
  const REMEMBER_KEY = 'bf.subtitles.choices';
  function remembered() {
    try { return JSON.parse(window.localStorage.getItem(REMEMBER_KEY)) || {}; } catch { return {}; }
  }
  function remember(patch) {
    const next = { ...remembered(), ...patch };
    try { window.localStorage.setItem(REMEMBER_KEY, JSON.stringify(next)); } catch { /* sem armazenamento: só não lembra */ }
  }

  /**
   * Idioma e modelo da geração: o escolhido neste projeto (project.ext.subtitles), senão o último usado neste computador,
   * senão o padrão (Português; o modelo padrão se estiver instalado, ou algum que já esteja instalado).
   */
  function choices() {
    const ext = (project() && project().ext && project().ext.subtitles) || {};
    const last = remembered();
    const language = ext.language || last.language || LANG_DEFAULT;
    const engine = ['auto', 'gpu', 'cpu'].includes(ext.engine) ? ext.engine : (['auto', 'gpu', 'cpu'].includes(last.engine) ? last.engine : 'auto');
    if (ext.modelId) return { language, modelId: ext.modelId, engine };
    const models = (status && status.models) || [];
    const preferred = [last.modelId, status && status.defaultModel, 'medium', 'large-v3-turbo', 'base', 'tiny'].filter(Boolean);
    const installed = preferred.find((id) => models.some((m) => m.id === id && m.installed));
    return { language, modelId: installed || last.modelId || (status && status.defaultModel) || 'small', engine };
  }

  function saveExt(patch) {
    BF.project.update((p) => { p.ext.subtitles = { ...(p.ext.subtitles || {}), ...patch }; }, { reason: 'subtitles:prefs' });
    if (patch.language || patch.modelId || patch.engine) remember({ ...(patch.language ? { language: patch.language } : {}), ...(patch.modelId ? { modelId: patch.modelId } : {}), ...(patch.engine ? { engine: patch.engine } : {}) });
  }

  /**
   * Ligada/desligada, estilo, entrega e formato com que a legenda de um corte NASCE: o último estilo/entrega usados neste
   * projeto (project.ext.subtitles), senão as Preferências (subtitles.enabled, subtitles.style, subtitles.mode), senão o
   * padrão. A aba mostra isto enquanto o corte ainda não tem legenda, para a tela e o que será gravado serem a mesma coisa
   * (e acompanharem uma mudança nas Preferências).
   */
  function defaultSubs() {
    const ext = (project() && project().ext && project().ext.subtitles) || {};
    return {
      enabled: BF.prefs.get('subtitles.enabled', false) === true,
      style: S.normalizeStyle(ext.style || BF.prefs.get('subtitles.style', null)),
      mode: S.normalizeMode(ext.mode || BF.prefs.get('subtitles.mode', 'burn')),
      sidecarFormat: ext.sidecarFormat === 'ass' ? 'ass' : 'srt'
    };
  }
  const enabledOf = (cut) => (subsOf(cut) ? Boolean(subsOf(cut).enabled) : defaultSubs().enabled);
  const styleOf = (cut) => (subsOf(cut) ? S.normalizeStyle(subsOf(cut).style) : defaultSubs().style);
  const modeOf = (cut) => (subsOf(cut) ? S.normalizeMode(subsOf(cut).mode) : defaultSubs().mode);

  /** Cria `cut.subtitles` se não existir (dentro de um BF.project.update), com o estilo e a entrega usados por último. */
  function ensureSubs(cut) {
    if (!cut.subtitles || typeof cut.subtitles !== 'object') {
      cut.subtitles = { basedOn: S.rangeOf(cut), cues: [], ...defaultSubs() };
    }
    return cut.subtitles;
  }

  function pushUndo(cut) {
    const subs = subsOf(cut);
    const stack = undoStacks.get(cut.id) || [];
    stack.push({ cues: clone(cuesOf(cut)), basedOn: subs && subs.basedOn ? clone(subs.basedOn) : null });
    while (stack.length > UNDO_LIMIT) stack.shift();
    undoStacks.set(cut.id, stack);
  }

  /**
   * Altera `cut.subtitles` pelo BF.project.update. `fn(subs)` muta no lugar.
   * opts: undo (guarda o estado para "Desfazer"), emit (avisa 'cuts:changed'), rerender, reason.
   */
  function mutate(cut, fn, { undo = true, emit = true, rerender = true, reason = 'subtitles:edit' } = {}) {
    if (undo) pushUndo(cut);
    BF.project.update(() => {
      fn(ensureSubs(cut));
      stamp(cut);
    }, { reason });
    if (emit) BF.bus.emit('cuts:changed', { ids: [cut.id], from: 'subtitles' });
    if (rerender) render(); else { tick(); BF.ui.refreshTabs(); }
  }

  /** 'decision' do tipo 'adjust' (a mudança é do usuário e fica no histórico). `what` distingue de ajuste de tempo do corte. */
  function emitAdjust(cut, before, after) {
    BF.bus.emit('decision', { cutId: cut.id, type: 'adjust', before: { what: 'subtitles', ...before }, after: { what: 'subtitles', ...after } });
  }

  function totalReview() {
    const p = project();
    if (!p || !S) return 0;
    return p.cuts.reduce((n, c) => (subsOf(c) && subsOf(c).enabled ? n + S.needsReviewCount(subsOf(c)) : n), 0);
  }

  function addNote(cutId, note) {
    notes.set(cutId, [...(notes.get(cutId) || []).filter((n) => n.key !== note.key), note]);
  }

  // ---------- acompanhar o intervalo do corte ----------

  /**
   * Falas de cortes cujo intervalo mudou acompanham o novo intervalo; o que foi afetado vai para revisão.
   * Também deixa as falas em ordem e com tempos limpos (assim os índices da lista valem para tudo).
   */
  function reconcileAll() {
    const p = project();
    if (!p || !S) return;
    const touched = [];
    for (const cut of p.cuts) {
      if (!subsOf(cut)) continue;
      const r = S.rebaseSubtitles(cut.subtitles, cut);
      const tidy = S.cleanCues(r.subtitles.cues);
      const tidyChanged = JSON.stringify(tidy) !== JSON.stringify(r.subtitles.cues);
      if (r.changed || tidyChanged) touched.push({ cut, r, tidy });
    }
    if (!touched.length) return;
    BF.project.update(() => {
      for (const { cut, r, tidy } of touched) { cut.subtitles = { ...r.subtitles, cues: tidy }; stamp(cut); }
    }, { reason: 'subtitles:rebase' });
    BF.bus.emit('cuts:changed', { ids: touched.map((t) => t.cut.id), from: 'subtitles' });
    for (const { cut, r } of touched) {
      if (!r.clipped && !r.outside) continue;
      const parts = [];
      if (r.clipped) parts.push(plural(r.clipped, 'fala passa do início ou do fim', 'falas passam do início ou do fim'));
      if (r.outside) parts.push(plural(r.outside, 'fala ficou fora do corte', 'falas ficaram fora do corte'));
      const text = `O intervalo do corte mudou: ${parts.join(' e ')}. Marquei para revisão; nada foi apagado nem recortado (se o corte voltar, as falas voltam).`;
      addNote(cut.id, { kind: 'warn', key: 'rebase', text });
      BF.ui.toast(`Legendas de "${cut.title}": ${text}`, '', 7000);
    }
  }

  // ---------- carga ----------

  async function loadStatus() {
    const seq = ++statusSeq;
    const res = await BF.api('subtitles:status');
    if (seq !== statusSeq) return;
    if (res.ok) { status = res; statusError = null; } else { statusError = res.message; }
    render();
    // a detecção da placa ainda estava rodando: espera por ela e redesenha com o resultado (uma vez)
    if (res.ok && res.hardware && res.hardware.pending) {
      await BF.api('subtitles:hardware');
      if (seq === statusSeq) {
        const again = await BF.api('subtitles:status');
        if (seq === statusSeq && again.ok) { status = again; render(); }
      }
    }
  }

  // ---------- campos ----------

  const icon = (name) => el('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true' }, name);

  const iconBtn = (label, glyph, onClick, extra = {}) => el('button', {
    type: 'button', class: `cue-btn icon-btn${extra.danger ? ' danger-ish' : ''}`, 'aria-label': label, title: label, onclick: onClick, disabled: extra.disabled === true, dataset: extra.dataset
  }, icon(glyph));

  /** Aviso com ícone: `kind` 'info' | 'warn' | 'error' (warn e error também levam as classes que os testes e o CSS conhecem). */
  const NOTE_ICONS = { info: 'info', warn: 'warning', error: 'error' };
  function noteBox(kind, body, attrs = {}) {
    const cls = `subs-note ${kind}${kind === 'warn' ? ' subs-warn' : ''}${kind === 'error' ? ' subs-error' : ''}`;
    return el('div', { class: cls, ...attrs }, icon(NOTE_ICONS[kind] || 'info'), el('div', { class: 'subs-note-body small' }, body));
  }

  /** Campo de seleção: rótulo à esquerda e o seletor à direita (ou rótulo em cima com `stack`). */
  function selectField(label, value, options, onChange, fid, { stack = false } = {}) {
    const select = el('select', { 'aria-label': label, dataset: { fid } },
      options.map((o) => el('option', { value: o.value, selected: o.value === value, disabled: o.disabled === true }, o.label)));
    select.addEventListener('change', () => onChange(select.value));
    return el('label', { class: `subs-field${stack ? ' stack' : ' row'}` }, el('span', { class: 'subs-field-label' }, label), select);
  }

  /** Interruptor com título e explicação curta (o <input> é o próprio .bds-switch). */
  function switchRow(title, hint, input) {
    input.classList.add('bds-switch');
    input.setAttribute('role', 'switch');
    return el('label', { class: 'subs-switch' },
      el('span', { class: 'subs-switch-text' }, el('strong', {}, title), hint ? el('span', { class: 'small' }, hint) : null),
      input);
  }

  function rangeField(label, value, { min, max, step = 1, format = String }, onInput, onChange, fid) {
    const out = el('output', { class: 'subs-range-out' }, format(value));
    const input = el('input', { type: 'range', min, max, step, value, 'aria-label': label, dataset: { fid } });
    input.addEventListener('input', () => { out.textContent = format(Number(input.value)); onInput(Number(input.value)); });
    input.addEventListener('change', () => onChange(Number(input.value)));
    return el('label', { class: 'subs-field subs-range' },
      el('span', { class: 'subs-range-head' }, el('span', { class: 'subs-field-label' }, label), out), input);
  }

  function colorField(label, value, onInput, onChange, fid) {
    const input = el('input', { type: 'color', value: value.toLowerCase(), 'aria-label': label, dataset: { fid } });
    input.addEventListener('input', () => onInput(input.value));
    input.addEventListener('change', () => onChange(input.value));
    return el('label', { class: 'subs-field row subs-color' }, el('span', { class: 'subs-field-label' }, label), input);
  }

  function cutPicker(cuts, cut) {
    const select = el('select', { class: 'subs-cut', 'aria-label': 'Corte a legendar', dataset: { fid: 'cut' } },
      !cut ? el('option', { value: '', selected: true }, 'Escolha um corte…') : null,
      cuts.map((c) => el('option', { value: c.id, selected: Boolean(cut) && c.id === cut.id }, `${c.title} · ${fmt(c.start)} → ${fmt(c.end)}`)));
    select.addEventListener('change', () => {
      if (!select.value) return;
      selectedId = select.value;
      BF.bus.emit('cut:selected', { id: selectedId });
    });
    return select;
  }

  /** Estado vazio (ícone + título + explicação). `center` para blocos que ocupam a área toda. */
  function emptyState(glyph, title, text, { center = false, attrs = {} } = {}) {
    return el('div', { class: `empty-state subs-empty${center ? ' center' : ''}`, ...attrs },
      el('span', { class: 'empty-state-icon material-symbols-rounded', 'aria-hidden': 'true' }, glyph),
      el('div', { class: 'empty-state-text' }, el('strong', {}, title), text ? el('p', {}, text) : null));
  }

  // ---------- o que falta (motor e modelo) ----------

  function progressMessage(ev) {
    if (!ev) return 'Preparando…';
    if (ev.phase === 'download' && ev.received > 0) {
      const pct = ev.total ? Math.min(100, Math.floor((ev.received / ev.total) * 100)) : 0;
      const speed = ev.speedBps > 0 ? ` · ${fmtBytes(ev.speedBps)}/s` : '';
      return `Baixando… ${pct}% · ${fmtBytes(ev.received)} de ${fmtBytes(ev.total)}${speed}`;
    }
    return ev.message || 'Preparando…';
  }

  /** Barra de download (percentual real quando o download informa; indeterminada nas outras fases). */
  function downloadBox(ev, label, kind, modelId) {
    const known = Boolean(ev) && ev.phase === 'download' && Number.isFinite(ev.percent) && ev.received > 0;
    return el('div', { class: 'subs-progress', dataset: { kind, model: modelId } },
      el('progress', { max: '100', value: known ? Math.round(ev.percent) : undefined, 'aria-label': label }),
      el('span', { class: 'muted small' }, progressMessage(ev)));
  }

  function updateDownloadBox(kind, modelId, ev) {
    if (!root) return;
    const node = [...root.querySelectorAll('.subs-progress')].find((n) => n.dataset.kind === kind && (kind !== 'model' || n.dataset.model === modelId));
    if (!node) return;
    const bar = node.querySelector('progress');
    if (ev.phase === 'download' && Number.isFinite(ev.percent) && ev.received > 0) bar.value = Math.round(ev.percent);
    else bar.removeAttribute('value');
    node.querySelector('span').textContent = progressMessage(ev);
  }

  function needRow({ key, name, detail, chip, warn, progress, error, actions }) {
    return el('li', { class: 'subs-need bds-list-item', dataset: { need: key } },
      el('div', { class: 'subs-need-head' },
        el('div', { class: 'subs-need-title' }, el('span', { class: 'subs-need-name' }, name), chip || null),
        detail ? el('span', { class: 'muted small' }, detail) : null),
      warn ? el('p', { class: 'subs-warn small' }, warn) : null,
      progress || null,
      error ? el('p', { class: 'subs-error small', role: 'alert' }, error) : null,
      actions ? el('div', { class: 'subs-need-actions' }, actions) : null);
  }

  function setupBlock() {
    if (!status) return null;
    const { modelId } = choices();
    const model = status.models.find((m) => m.id === modelId) || status.models[0];
    const rows = [];
    let primaryUsed = false; // um só destaque primário na região: a primeira ação possível; as outras ficam secundárias
    const action = (attrs, text, extra = {}) => {
      const primary = !primaryUsed && !extra.cancel && !attrs.disabled;
      if (primary) primaryUsed = true;
      return el('button', { type: 'button', ...attrs, class: primary ? 'primary sm' : 'secondary sm' }, text);
    };
    const chip = (kind, text) => el('span', { class: `bds-chip bds-chip-${kind}` }, text);

    if (!status.engine.installed) {
      const e = status.engine;
      rows.push(needRow({
        key: 'engine',
        name: 'Motor de transcrição (Whisper)',
        detail: e.available ? `${fmtBytes(e.sizeBytes)} · fonte oficial` : '',
        chip: engineBusy ? chip('info', 'Instalando…') : chip(e.available ? 'warn' : 'bad', e.available ? 'Falta instalar' : 'Indisponível'),
        warn: e.available ? null : `${e.unavailableReason} Sem ele não há legenda automática; você ainda pode escrever ou importar a legenda.`,
        progress: engineBusy ? downloadBox(engineProgress, 'Instalando o motor de transcrição', 'engine') : null,
        error: errors.get('engine'),
        actions: engineBusy
          ? action({ dataset: { act: 'cancel-engine' }, onclick: cancelEngine }, 'Cancelar', { cancel: true })
          : action({ dataset: { act: 'install-engine' }, disabled: !e.available, onclick: installEngine }, 'Instalar')
      }));
    }

    if (model && !model.installed) {
      const busy = modelBusy.has(model.id);
      rows.push(needRow({
        key: 'model',
        name: `Modelo ${model.label}`,
        detail: `${fmtBytes(model.sizeBytes)} · ${model.description}${status.modelsManagedByHost ? ` · o download é feito e guardado pelo ${status.hostName || 'aplicativo'}` : ''}`,
        chip: busy ? chip('info', 'Baixando…') : chip('warn', 'Falta baixar'),
        progress: busy ? downloadBox(modelProgress.get(model.id), `Baixando o modelo ${model.label}`, 'model', model.id) : null,
        error: errors.get(`model:${model.id}`),
        actions: busy
          ? action({ dataset: { act: 'cancel-model' }, onclick: () => cancelModel(model.id) }, 'Cancelar', { cancel: true })
          : action({ dataset: { act: 'install-model' }, onclick: () => installModel(model.id) }, 'Baixar')
      }));
    }

    if (!status.ffmpeg.found) {
      rows.push(needRow({ key: 'ffmpeg', name: 'FFmpeg', chip: chip('bad', 'Não encontrado'), warn: 'O FFmpeg é preciso para ler o áudio. Veja a aba Ferramentas.' }));
    }
    if (!rows.length) return null;
    return el('section', { class: 'panel subs-setup', 'aria-label': 'O que falta para a legenda automática' },
      el('div', { class: 'subs-card-head' },
        el('h3', { class: 'panel-title' }, 'Antes de gerar'),
        el('span', { class: 'muted small' }, 'Só na primeira vez')),
      el('ul', { class: 'subs-needs bds-list' }, rows));
  }

  async function installEngine() {
    engineBusy = true;
    engineProgress = null;
    errors.delete('engine');
    render();
    const res = await BF.api('tools:install', { id: 'whisper' });
    engineBusy = false;
    engineProgress = null;
    if (res.ok) BF.ui.toast('Motor de transcrição instalado.', 'ok');
    else if (res.code !== 'CANCELLED') errors.set('engine', res.message);
    await loadStatus();
  }

  async function cancelEngine() {
    await BF.api('tools:cancel', { id: 'whisper' });
  }

  async function installCuda() {
    const size = status && status.engine.cuda ? status.engine.cuda.sizeBytes : 0;
    const ok = await BF.ui.confirm({
      title: 'Baixar o motor para placa NVIDIA?',
      message: `É um download grande: ${fmtBytes(size)} (ocupa mais no disco depois de extraído). Vem só da página oficial do whisper.cpp, com tamanho e SHA-256 conferidos, e você pode cancelar durante o download. Sem ele a transcrição continua funcionando no processador.`,
      okLabel: 'Baixar'
    });
    if (!ok) return;
    cudaBusy = true;
    cudaProgress = null;
    engineOpen = true;
    errors.delete('cuda');
    render();
    const res = await BF.api('tools:install', { id: 'whisper-cuda' });
    cudaBusy = false;
    cudaProgress = null;
    if (res.ok) BF.ui.toast('Motor para placa NVIDIA instalado.', 'ok');
    else if (res.code !== 'CANCELLED') errors.set('cuda', res.message);
    await loadStatus();
  }

  async function cancelCuda() {
    await BF.api('tools:cancel', { id: 'whisper-cuda' });
  }

  /** "GPU NVIDIA GeForce GTX 1650 · 4 GB — a transcrição pode usar a placa." (ou o motivo de não poder) */
  function hardwareHint() {
    const hw = status && status.hardware;
    if (!hw || !hw.gpu || !hw.gpu.name) return null;
    if (!hw.gpu.available) return { kind: 'muted', text: `GPU ${hw.gpu.summary || hw.gpu.name} — ${hw.gpu.reason}` };
    const e = status.engine;
    if (e.installed && e.kind === 'cuda' && e.origin === 'host') return { kind: 'ok', text: `GPU ${hw.gpu.summary} — a transcrição usa a placa (motor do ${e.hostName || 'aplicativo'}).` };
    if (hw.canUseGpu) return { kind: 'ok', text: `GPU ${hw.gpu.summary} — a transcrição pode usar a placa.` };
    return { kind: 'muted', text: `GPU ${hw.gpu.summary} — a transcrição pode usar a placa; falta o motor com aceleração (ajustes do motor).` };
  }

  /** Nome curto do motor em uso: "motor do BDS · GPU", "motor do app · CPU"... */
  function engineSummary() {
    const e = status && status.engine;
    if (!e || !e.installed) return '';
    const who = e.origin === 'host' ? `motor do ${e.hostName || 'aplicativo'}` : 'motor do app';
    return `${who} · ${e.kind === 'cuda' ? 'GPU' : 'CPU'}`;
  }

  /** Ajuste avançado (recolhido): Automático / Placa (GPU) / Processador (CPU) e o motor com placa NVIDIA. */
  function engineSection(engine, modelId) {
    const e = status.engine;
    const hw = status.hardware || {};
    const cuda = e.cuda || {};
    const hasCuda = cuda.installed;
    const rows = [];
    rows.push(selectField('Motor', engine, [
      { value: 'auto', label: 'Automático (placa se der, senão processador)' },
      { value: 'gpu', label: hasCuda ? 'Placa (GPU)' : 'Placa (GPU) — motor não instalado', disabled: !hasCuda },
      { value: 'cpu', label: 'Processador (CPU)' }
    ], (v) => { saveExt({ engine: v }); render(); }, 'engine', { stack: true }));
    const info = [];
    if (e.installed) info.push(engineSummary());
    if (hasCuda && e.origin !== 'host') info.push(`motor com placa NVIDIA instalado (${cuda.version})`);
    if (info.length) rows.push(el('p', { class: 'muted small', dataset: { engine: 'summary' } }, info.join(' · ')));
    if (hw.gpuFailure) rows.push(el('p', { class: 'subs-warn small', dataset: { engine: 'failure' } }, `A placa falhou antes (${hw.gpuFailure}): o modo automático usa o processador. Escolha “Placa (GPU)” para tentar de novo.`));
    const model = status.models.find((m) => m.id === modelId);
    if (hasCuda && model && model.gpuFit && (model.gpuFit.level === 'no' || model.gpuFit.level === 'tight') && engine !== 'cpu') {
      rows.push(el('p', { class: 'subs-warn small', dataset: { engine: 'memory' } }, model.gpuFit.message));
    }
    if (hw.gpu && hw.gpu.available && cuda.available && !hasCuda) {
      rows.push(el('div', { class: 'subs-cuda', dataset: { engine: 'cuda' } },
        el('p', { class: 'small' }, el('strong', {}, 'Motor com placa NVIDIA'), ` · ${fmtBytes(cuda.sizeBytes)} · fonte oficial`),
        el('p', { class: 'muted small' }, 'Download grande: só é baixado se você pedir, e é opcional (o processador continua funcionando).'),
        cudaBusy ? downloadBox(cudaProgress, 'Instalando o motor com placa NVIDIA', 'cuda') : null,
        errors.has('cuda') ? el('p', { class: 'subs-error small', role: 'alert' }, errors.get('cuda')) : null,
        cudaBusy
          ? el('button', { type: 'button', class: 'secondary sm', dataset: { act: 'cancel-cuda' }, onclick: cancelCuda }, 'Cancelar')
          : el('button', { type: 'button', class: 'secondary sm', dataset: { act: 'install-cuda' }, onclick: installCuda }, `Baixar (${fmtBytes(cuda.sizeBytes)})`)));
    }
    return el('details', { class: 'subs-details-inner subs-engine', dataset: { section: 'engine' }, open: engineOpen, ontoggle: (event) => { engineOpen = event.target.open; } },
      el('summary', {}, 'Motor de transcrição'), el('div', { class: 'subs-engine-body' }, rows));
  }

  async function installModel(id) {
    modelBusy.add(id);
    modelProgress.delete(id);
    errors.delete(`model:${id}`);
    render();
    const res = await BF.api('subtitles:installModel', { id });
    modelBusy.delete(id);
    modelProgress.delete(id);
    if (res.ok) BF.ui.toast('Modelo instalado.', 'ok');
    else if (res.code !== 'CANCELLED') errors.set(`model:${id}`, res.message);
    await loadStatus();
  }

  async function cancelModel(id) {
    await BF.api('subtitles:cancelModel', { id });
  }

  BF.on('tools:progress', (ev) => {
    if (!ev) return;
    if (ev.id === 'whisper-cuda') {
      cudaProgress = ev;
      if (cudaBusy) updateDownloadBox('cuda', null, ev);
      return;
    }
    if (ev.id !== 'whisper') return;
    engineProgress = ev;
    if (engineBusy) updateDownloadBox('engine', null, ev);
  });
  BF.on('subtitles:modelProgress', (ev) => {
    if (!ev || typeof ev.id !== 'string') return;
    modelProgress.set(ev.id, ev);
    if (modelBusy.has(ev.id)) updateDownloadBox('model', ev.id, ev);
  });
  BF.bus.on('tools:changed', () => { if (root) loadStatus(); });

  // ---------- geração ----------

  function canGenerate() {
    if (!status) return { ok: false, why: 'Carregando…' };
    if (!status.ffmpeg.found) return { ok: false, why: 'O FFmpeg não foi encontrado.' };
    if (!status.engine.installed) return { ok: false, why: 'Instale o motor de transcrição.' };
    const { modelId } = choices();
    const model = status.models.find((m) => m.id === modelId);
    if (!model || !model.installed) return { ok: false, why: 'Baixe o modelo escolhido.' };
    if (gen) return { ok: false, why: 'Já existe uma legenda sendo gerada.' };
    return { ok: true, why: '' };
  }

  function generationRow(cut) {
    if (gen && gen.cutId === cut.id) {
      const bar = el('progress', { max: '100', value: Math.round(gen.percent), 'aria-label': 'Progresso da legenda automática' });
      const text = el('span', { class: 'muted small' }, gen.message);
      progressBar = bar;
      progressText = text;
      return el('div', { class: 'subs-gen busy', dataset: { state: 'busy' } },
        el('div', { class: 'subs-progress' }, bar, text),
        el('button', { type: 'button', class: 'secondary sm', dataset: { act: 'cancel-generate' }, onclick: cancelGenerate }, 'Cancelar'));
    }
    const can = canGenerate();
    const { language, modelId, engine } = choices();
    const hint = hardwareHint();
    const langs = (status && status.languages) || [{ code: LANG_DEFAULT, label: 'Português' }];
    const models = (status && status.models) || [];
    const hasCues = cuesOf(cut).length > 0;
    // destaque primário só quando faz sentido: gerar a primeira vez e dá para gerar. Com falas (gerar de novo) ou sem o que falta, fica secundário.
    const primary = can.ok && !hasCues;
    return el('div', { class: 'subs-gen', dataset: { state: 'idle' } },
      el('div', { class: 'subs-gen-opts' },
        selectField('Idioma', language, langs.map((l) => ({ value: l.code, label: l.label })), (v) => { saveExt({ language: v }); render(); }, 'language', { stack: true }),
        selectField('Modelo', modelId, models.map((m) => ({ value: m.id, label: `${m.label}${m.installed ? ' ✓' : ` · ${fmtBytes(m.sizeBytes)}`}` })), (v) => { saveExt({ modelId: v }); render(); }, 'model', { stack: true })),
      el('button', {
        type: 'button', class: primary ? 'primary' : 'secondary', dataset: { act: 'generate' }, disabled: !can.ok, title: can.ok ? '' : can.why, onclick: () => generate(cut)
      }, icon('auto_awesome'), hasCues ? 'Gerar de novo' : 'Gerar legenda automática'),
      !can.ok && status ? el('p', { class: 'muted small subs-gen-why' }, can.why) : null,
      hint ? el('p', { class: `small subs-gpu${hint.kind === 'ok' ? '' : ' muted'}`, dataset: { gpu: 'hint' } }, icon('memory'), hint.text) : null,
      status && status.engine.installed ? engineSection(engine, modelId) : null);
  }

  async function confirmReplace(cut, title) {
    const n = cuesOf(cut).length;
    if (!n) return true;
    return BF.ui.confirm({
      title,
      message: `As ${plural(n, 'fala', 'falas')} atuais (com as suas edições) serão substituídas. Logo depois você pode voltar com "Desfazer".`,
      okLabel: 'Substituir',
      danger: true
    });
  }

  async function generate(cut) {
    if (gen || !project() || !canGenerate().ok) return;
    if (!(await confirmReplace(cut, 'Gerar a legenda de novo?'))) return;
    const p = project();
    const { language, modelId, engine } = choices();
    const range = S.rangeOf(cut);
    const style = styleOf(cut);
    saveExt({ language, modelId });
    errors.delete('gen');
    notes.delete(cut.id);
    const job = { cutId: cut.id, projectId: p.id, range }; // o que vale para ESTA geração, mesmo que a aba troque de projeto no meio
    gen = { ...job, percent: 0, message: 'Preparando…' };
    render();
    const res = await BF.api('subtitles:generate', {
      cutId: cut.id, input: p.source.path, start: cut.start, end: cut.end, language, modelId, maxChars: style.maxCharsPerLine, engine
    });
    if (gen && gen.cutId === job.cutId) gen = null;
    progressBar = null;
    progressText = null;
    if (!res.ok) {
      if (res.code === 'CANCELLED') addNote(cut.id, { kind: 'info', key: 'gen', text: 'Geração cancelada. Nada foi alterado.' });
      else errors.set('gen', res.message);
      render();
      return;
    }
    const target = project() && project().id === job.projectId ? BF.project.cut(cut.id) : null;
    if (!target) {
      BF.ui.toast('A legenda ficou pronta, mas o corte não está mais aberto; nada foi aplicado.', 'error');
      render();
      return;
    }
    mutate(target, (subs) => {
      subs.cues = S.cleanCues(res.cues);
      subs.basedOn = job.range; // intervalo para o qual as falas foram geradas; se o corte mudou nesse meio tempo, o rebase abaixo acompanha
      if (res.cues.length) subs.enabled = true;
      subs.generated = {
        at: new Date().toISOString(), language: res.language || language, model: res.modelId, modelLabel: res.modelLabel,
        start: job.range.start, end: job.range.end, noSpeech: Boolean(res.noSpeech)
      };
      const rebased = S.rebaseSubtitles(subs, target);
      if (rebased.changed) Object.assign(subs, rebased.subtitles);
    }, { reason: 'subtitles:generate', rerender: false });
    if (res.noSpeech) addNote(cut.id, { kind: 'info', key: 'nospeech', text: res.message });
    if (res.transcribeMs > 0) {
      const where = res.device === 'GPU' ? `na placa${res.deviceName ? ` (${res.deviceName})` : ''}` : 'no processador';
      const speed = res.speed ? ` · ${res.speed.toLocaleString('pt-BR')}× o tempo real` : '';
      addNote(cut.id, { kind: 'info', key: 'device', text: `Transcrito ${where} em ${fmtSec(res.transcribeMs / 1000)}${speed}.` });
    }
    if (res.fellBack) addNote(cut.id, { kind: 'warn', key: 'gpufail', text: `A placa falhou: usando o processador. A legenda saiu do mesmo jeito${res.fallbackReason ? ` (motivo: ${res.fallbackReason})` : ''}. Nas próximas vezes o modo automático não insiste na placa.` });
    else if (res.deviceNote) addNote(cut.id, { kind: 'warn', key: 'devicenote', text: res.deviceNote });
    if (res.memoryAdvice && !res.fellBack) addNote(cut.id, { kind: 'info', key: 'gpumemory', text: res.memoryAdvice });
    if (res.discarded && res.discarded.length) {
      addNote(cut.id, { kind: 'info', key: 'discarded', text: `${plural(res.discarded.length, 'trecho foi descartado', 'trechos foram descartados')} por parecer(em) ruído, não fala.`, items: res.discarded });
    }
    BF.ui.log(res.noSpeech ? res.message : `Legenda gerada: ${plural(res.cues.length, 'fala', 'falas')}.`, res.noSpeech ? '' : 'ok');
    render();
  }

  async function cancelGenerate() {
    if (gen) await BF.api('subtitles:cancel', { cutId: gen.cutId });
  }

  BF.on('subtitles:progress', (ev) => {
    if (!gen || !ev || ev.cutId !== gen.cutId) return;
    gen.percent = ev.percent;
    gen.message = ev.message || gen.message;
    if (progressBar && progressBar.isConnected) progressBar.value = Math.round(ev.percent);
    if (progressText && progressText.isConnected) progressText.textContent = gen.message;
  });

  // ---------- avisos ----------

  function noticeBlock(cut) {
    const subs = subsOf(cut);
    const out = [];
    const dur = durationOf(cut);
    const mine = notes.get(cut.id) || [];
    if (errors.has('gen')) out.push(noteBox('error', errors.get('gen'), { role: 'alert' }));
    if (errors.has('import')) out.push(noteBox('error', errors.get('import'), { role: 'alert' }));
    if (subs && subs.generated && subs.generated.noSpeech && !cuesOf(cut).length && !mine.some((n) => n.key === 'nospeech')) {
      out.push(noteBox('info', 'Nenhuma fala foi detectada neste trecho na última geração automática.', { dataset: { note: 'nospeech' } }));
    }
    const review = subs ? S.needsReviewCount(subs) : 0;
    if (review) out.push(noteBox('warn', `${plural(review, 'fala para revisar', 'falas para revisar')} (marcadas como “revisar”). Elas entram no vídeo mesmo assim; revise antes de exportar.`, { dataset: { note: 'review' } }));
    const partial = cuesOf(cut).filter((c) => S.rangeState(c, dur) === 'partial').length;
    if (partial) out.push(noteBox('info', `${plural(partial, 'fala passa', 'falas passam')} do início ou do fim do corte: só a parte de dentro aparece no vídeo.`, { dataset: { note: 'partial' } }));
    const outside = cuesOf(cut).filter((c) => S.rangeState(c, dur) === 'outside').length;
    if (outside) out.push(noteBox('warn', `${plural(outside, 'fala está fora do corte', 'falas estão fora do corte')} e não entra(m) no vídeo.`, { dataset: { note: 'outside' } }));
    const g = subs && subs.generated;
    if (g && Number.isFinite(g.start) && Number.isFinite(g.end) && !g.noSpeech) {
      const parts = [];
      if (cut.start < g.start - 0.25) parts.push(`${fmtSec(g.start - cut.start)} no início`);
      if (cut.end > g.end + 0.25) parts.push(`${fmtSec(cut.end - g.end)} no fim`);
      if (parts.length) out.push(noteBox('info', `O corte ganhou ${parts.join(' e ')} depois da legenda automática: esse trecho está sem transcrição. Gere de novo se houver fala nele.`, { dataset: { note: 'uncovered' } }));
    }
    for (const n of mine) {
      out.push(noteBox(n.kind === 'warn' ? 'warn' : 'info', [
        el('p', {}, n.text),
        n.items && n.items.length ? el('details', { class: 'subs-details-inner' },
          el('summary', {}, 'Ver o que foi descartado'),
          el('ul', { class: 'subs-discarded' }, n.items.map((it) => el('li', { class: 'small' },
            `${S.fmtClock(it.start)}: “${it.text}” `, el('span', { class: 'muted' }, `(${it.reason})`))))) : null
      ], { dataset: { note: n.key } }));
    }
    return out;
  }

  // ---------- lista de falas ----------

  /** Posição do cursor no texto (só vale se o usuário clicou ou focou o campo e o cursor não está nas pontas). */
  function caretOf(textarea) {
    if (!textarea || textarea.dataset.touched !== '1') return NaN;
    const at = textarea.selectionStart;
    return at > 0 && at < textarea.value.length ? at : NaN;
  }

  const playerRel = (cut) => BF.player.time() - cut.start;

  function autoGrow(textarea) {
    textarea.style.height = 'auto';
    const border = textarea.offsetHeight - textarea.clientHeight; // box-sizing: border-box
    const wanted = textarea.scrollHeight + border;
    textarea.style.height = `${Math.min(wanted, 160)}px`;
    textarea.style.overflowY = wanted > 160 ? 'auto' : 'hidden';
  }

  /** Atualiza classes, etiquetas e campos de tempo de uma linha sem trocar os elementos (não perde o clique em andamento). */
  function refreshRow(row, cut, i) {
    const cue = cuesOf(cut)[i];
    if (!cue) return;
    const state = S.rangeState(cue, durationOf(cut));
    row.classList.toggle('review', Boolean(cue.needsReview));
    row.classList.toggle('outside', state === 'outside');
    row.classList.toggle('partial', state === 'partial');
    row.dataset.state = state;
    const inputs = row.querySelectorAll('.cue-time');
    inputs[0].value = S.fmtClock(cue.start);
    inputs[1].value = S.fmtClock(cue.end);
    const tag = row.querySelector('.cue-tag');
    const label = state === 'outside' ? 'fora do corte' : state === 'partial' ? 'parte fora' : '';
    if (label && tag) tag.textContent = label;
    else if (label) row.querySelector('.cue-times').after(el('span', { class: 'cue-tag bds-chip bds-chip-warn' }, label));
    else if (tag) tag.remove();
    const flag = row.querySelector('[data-act="reviewed"]');
    if (flag && !cue.needsReview) flag.remove();
  }

  function cueRow(cut, cue, i) {
    const dur = durationOf(cut);
    const state = S.rangeState(cue, dur);
    const last = i === cuesOf(cut).length - 1;
    const text = el('textarea', { class: 'cue-text', rows: 1, value: cue.text, 'aria-label': `Texto da fala ${i + 1}`, spellcheck: 'true', lang: 'pt-BR', dataset: { fid: `cue${i}t` } });
    const editStart = el('input', { type: 'text', class: 'cue-time', value: S.fmtClock(cue.start), size: 7, 'aria-label': `Início da fala ${i + 1}`, dataset: { fid: `cue${i}s` } });
    const editEnd = el('input', { type: 'text', class: 'cue-time', value: S.fmtClock(cue.end), size: 7, 'aria-label': `Fim da fala ${i + 1}`, dataset: { fid: `cue${i}e` } });
    let row = null;

    let undoPushed = false;
    text.addEventListener('focus', () => { text.dataset.touched = '1'; });
    text.addEventListener('mouseup', () => { text.dataset.touched = '1'; });
    text.addEventListener('input', () => {
      if (!undoPushed) { pushUndo(cut); undoPushed = true; }
      BF.project.update(() => {
        const c = cuesOf(cut)[i];
        if (!c) return;
        c.text = text.value;
        delete c.needsReview; // quem editou o texto revisou a fala
        stamp(cut);
      }, { reason: 'subtitles:text' });
      refreshRow(row, cut, i);
      autoGrow(text);
      tick();
      BF.ui.refreshTabs();
    });
    text.addEventListener('change', () => { undoPushed = false; BF.bus.emit('cuts:changed', { ids: [cut.id], from: 'subtitles' }); });

    const commitTimes = () => {
      const current = cuesOf(cut)[i];
      const a = S.parseClock(editStart.value);
      const b = S.parseClock(editEnd.value);
      if (!current) return;
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        BF.ui.toast('Use o formato m:ss.cc ou segundos (ex.: 1:23.45).', 'error');
        editStart.value = S.fmtClock(current.start);
        editEnd.value = S.fmtClock(current.end);
        return;
      }
      const start = round3(Math.min(a, b));
      const end = round3(Math.max(a, b));
      if (start === current.start && end === current.end) { refreshRow(row, cut, i); return; }
      pushUndo(cut);
      let sameOrder = true;
      BF.project.update(() => {
        const list = cuesOf(cut);
        list[i].start = start;
        list[i].end = end;
        delete list[i].needsReview;
        const sorted = S.cleanCues(list);
        sameOrder = sorted.every((c, k) => c.start === list[k].start && c.end === list[k].end && c.text === list[k].text);
        subsOf(cut).cues = sorted;
        stamp(cut);
      }, { reason: 'subtitles:time' });
      BF.bus.emit('cuts:changed', { ids: [cut.id], from: 'subtitles' });
      if (sameOrder) { refreshRow(row, cut, i); tick(); BF.ui.refreshTabs(); } else render();
    };
    editStart.addEventListener('change', commitTimes);
    editEnd.addEventListener('change', commitTimes);

    const flag = cue.needsReview ? el('button', {
      type: 'button', class: 'cue-flag bds-chip bds-chip-warn', dataset: { act: 'reviewed' }, title: 'Marcada para revisão. Clique para marcar como revisada.', 'aria-label': 'Fala marcada para revisão: marcar como revisada',
      onclick: () => {
        pushUndo(cut);
        BF.project.update(() => { const c = cuesOf(cut)[i]; if (c) delete c.needsReview; stamp(cut); }, { reason: 'subtitles:reviewed' });
        BF.bus.emit('cuts:changed', { ids: [cut.id], from: 'subtitles' });
        refreshRow(row, cut, i);
        BF.ui.refreshTabs();
      }
    }, icon('flag'), 'Revisar') : null;

    const playCue = () => {
      const c = cuesOf(cut)[i];
      if (!c) return;
      BF.player.playRange(cut.start + Math.max(0, c.start), cut.start + Math.min(dur, Math.max(c.end, c.start + 0.2)));
    };

    row = el('li', { class: `cue${cue.needsReview ? ' review' : ''}${state !== 'inside' ? ` ${state}` : ''}`, dataset: { cue: String(i), state } },
      el('div', { class: 'cue-head' },
        el('span', { class: 'cue-times' }, editStart, el('span', { class: 'cue-arrow', 'aria-hidden': 'true' }, '→'), editEnd),
        state !== 'inside' ? el('span', { class: 'cue-tag bds-chip bds-chip-warn' }, state === 'outside' ? 'fora do corte' : 'parte fora') : null,
        flag,
        el('span', { class: 'cue-actions' },
          iconBtn('Ver esta fala no player', 'play_arrow', playCue, { disabled: state === 'outside', dataset: { act: 'play' } }),
          iconBtn('Dividir a fala (no cursor do texto ou no ponto do player)', 'content_cut', () => splitAt(cut, i, text), { dataset: { act: 'split' } }),
          iconBtn('Juntar com a fala seguinte', 'call_merge', () => mergeWithNext(cut, i), { disabled: last, dataset: { act: 'merge' } }),
          iconBtn('Excluir a fala', 'delete', () => removeAt(cut, i), { danger: true, dataset: { act: 'delete' } }))),
      text);
    requestAnimationFrame(() => autoGrow(text));
    return row;
  }

  function splitAt(cut, i, textarea) {
    const cues = cuesOf(cut);
    const rel = playerRel(cut);
    const cue = cues[i];
    const time = cue && rel > cue.start && rel < cue.end ? rel : undefined;
    const caret = caretOf(textarea);
    const r = S.splitCue(cues, i, { time, charIndex: Number.isFinite(caret) ? caret : undefined });
    if (!r.ok) { BF.ui.toast(r.message, 'error'); return; }
    pendingFocus = `cue${i + 1}t`;
    mutate(cut, (subs) => { subs.cues = r.cues; }, { reason: 'subtitles:split' });
  }

  function mergeWithNext(cut, i) {
    const r = S.mergeCues(cuesOf(cut), i);
    if (!r.ok) { BF.ui.toast(r.message, 'error'); return; }
    pendingFocus = `cue${i}t`;
    mutate(cut, (subs) => { subs.cues = r.cues; }, { reason: 'subtitles:merge' });
  }

  function removeAt(cut, i) {
    const r = S.removeCue(cuesOf(cut), i);
    if (r.ok) mutate(cut, (subs) => { subs.cues = r.cues; }, { reason: 'subtitles:remove' });
  }

  function addNew(cut) {
    const dur = durationOf(cut);
    const rel = playerRel(cut);
    const cues = cuesOf(cut);
    const lastEnd = cues.length ? Math.max(...cues.map((c) => c.end)) : 0;
    const at = rel >= 0 && rel < dur ? rel : Math.min(lastEnd, Math.max(0, dur - 0.5));
    const r = S.addCue(cues, { at, length: 2, duration: dur });
    pendingFocus = `cue${r.index}t`;
    mutate(cut, (subs) => { subs.cues = r.cues; subs.enabled = true; }, { reason: 'subtitles:add' });
  }

  function shiftAll(cut, delta) {
    if (!cuesOf(cut).length) return;
    mutate(cut, (subs) => { subs.cues = S.shiftCues(subs.cues, delta); }, { reason: 'subtitles:shift' });
    emitAdjust(cut, { action: 'shift', seconds: 0 }, { action: 'shift', seconds: delta });
  }

  function undo(cut) {
    const snap = (undoStacks.get(cut.id) || []).pop();
    if (!snap) return;
    BF.project.update(() => {
      const subs = ensureSubs(cut);
      subs.cues = snap.cues;
      if (snap.basedOn) subs.basedOn = snap.basedOn;
      stamp(cut);
    }, { reason: 'subtitles:undo' });
    BF.bus.emit('cuts:changed', { ids: [cut.id], from: 'subtitles' });
    reconcileAll(); // se o intervalo do corte mudou depois do estado guardado, as falas acompanham de novo
    render();
  }

  // ---------- bloco principal do corte ----------

  function deliveryOptions() {
    const burnOk = !status || status.burnIn.supported;
    return [
      { value: 'burn', label: 'Incorporada ao vídeo', disabled: !burnOk },
      { value: 'sidecar', label: 'Arquivo separado' },
      { value: 'both', label: 'Incorporada e arquivo separado', disabled: !burnOk }
    ];
  }

  function deliverySummary(subs) {
    const mode = subs ? S.normalizeMode(subs.mode) : defaultSubs().mode;
    const ext = subs ? S.sidecarFormatOf(subs) : defaultSubs().sidecarFormat;
    if (mode === 'burn') return 'Na exportação: a legenda fica gravada no vídeo.';
    if (mode === 'sidecar') return `Na exportação: arquivo .${ext} ao lado do vídeo (o vídeo sai sem legenda gravada).`;
    return `Na exportação: legenda gravada no vídeo e arquivo .${ext} ao lado.`;
  }

  function setEnabled(cut, enabled) {
    const before = enabledOf(cut);
    if (before === enabled) return;
    mutate(cut, (subs) => { subs.enabled = enabled; }, { undo: false, reason: 'subtitles:enabled' });
    emitAdjust(cut, { enabled: before }, { enabled });
  }

  function setMode(cut, mode) {
    const before = modeOf(cut);
    mutate(cut, (subs) => { subs.mode = mode; }, { undo: false, reason: 'subtitles:mode' });
    saveExt({ mode });
    emitAdjust(cut, { mode: before }, { mode });
  }

  /** Dois cartões: "Legenda" (ligar e entrega) e "Falas" (gerar, avisos, lista e ferramentas). */
  function mainBlock(cut) {
    const subs = subsOf(cut);
    const enabled = enabledOf(cut);
    const mode = modeOf(cut);
    const burnBad = Boolean(status) && !status.burnIn.supported && (mode === 'burn' || mode === 'both');
    const cues = cuesOf(cut);
    const stack = undoStacks.get(cut.id) || [];

    const toggle = switchRow('Legendar este corte', 'A legenda entra na exportação deste corte.',
      el('input', { type: 'checkbox', checked: enabled, dataset: { fid: 'enabled' }, onchange: (event) => setEnabled(cut, event.target.checked) }));

    rowEls = [];
    const list = cues.length
      ? el('ol', { class: 'cues', 'aria-label': 'Falas da legenda' }, cues.map((c, i) => { const r = cueRow(cut, c, i); rowEls[i] = r; return r; }))
      : emptyState('subtitles', 'Nenhuma fala ainda', 'Gere a legenda automática ou adicione as falas à mão.', { attrs: { dataset: { empty: 'cues' } } });

    const delivery = el('section', { class: 'panel subs-main' },
      toggle,
      el('div', { class: 'subs-top' }, selectField('Entrega', mode, deliveryOptions(), (v) => setMode(cut, v), 'mode')),
      burnBad
        ? noteBox('warn', `${status.burnIn.reason} A exportação desta legenda vai falhar até você escolher "Arquivo separado".`, { role: 'alert' })
        : el('p', { class: 'muted small subs-summary', dataset: { note: 'summary' } }, deliverySummary(subs)));

    // sem falas (ou gerando): gerar vem primeiro; com falas a lista é o foco e "gerar de novo" fica no fim do cartão
    const genRow = generationRow(cut);
    const genOnTop = cues.length === 0 || Boolean(gen && gen.cutId === cut.id);
    const falas = el('section', { class: 'panel subs-falas' },
      el('div', { class: 'subs-card-head' },
        el('h3', { class: 'panel-title' }, cues.length ? `Falas (${cues.length})` : 'Falas'),
        el('button', { type: 'button', class: 'subs-undo sm', dataset: { act: 'undo' }, disabled: stack.length === 0, title: 'Desfaz a última alteração nas falas', onclick: () => undo(cut) }, icon('undo'), 'Desfazer')),
      ...(genOnTop ? [genRow] : []),
      ...noticeBlock(cut),
      list,
      el('div', { class: 'subs-tools' },
        el('button', { type: 'button', class: 'secondary sm', dataset: { act: 'add' }, onclick: () => addNew(cut) }, icon('add'), 'Adicionar fala'),
        cues.length ? el('div', { class: 'subs-sync', role: 'group', 'aria-label': 'Deslocar todas as falas' },
          el('span', { class: 'muted small' }, 'Sincronia'),
          ...[[-1, '−1 s'], [-0.1, '−0,1 s'], [0.1, '+0,1 s'], [1, '+1 s']].map(([d, label]) => el('button', {
            type: 'button', class: 'subs-shift sm', dataset: { act: 'shift', delta: String(d) },
            title: `${d < 0 ? 'Adianta' : 'Atrasa'} todas as falas em ${label.replace(/[−+]/, '')}`, onclick: () => shiftAll(cut, d)
          }, label))) : null),
      ...(genOnTop ? [] : [el('div', { class: 'subs-gen-foot' }, genRow)]));
    return [delivery, falas];
  }

  // ---------- aparência e mais opções ----------

  function setStyle(cut, patch, final) {
    if (!styleSnapshot || styleSnapshot.cutId !== cut.id) styleSnapshot = { cutId: cut.id, style: clone(styleOf(cut)) };
    mutate(cut, (subs) => { subs.style = S.normalizeStyle({ ...S.normalizeStyle(subs.style), ...patch }); }, { undo: false, emit: final, rerender: false, reason: 'subtitles:style' });
    if (!final) return;
    const style = styleOf(cut);
    saveExt({ style });
    if (JSON.stringify(style) !== JSON.stringify(styleSnapshot.style)) emitAdjust(cut, { style: styleSnapshot.style }, { style });
    styleSnapshot = null;
  }

  function styleDetails(cut) {
    const style = styleOf(cut);
    const fonts = (status && status.fonts) || [];
    const fontOptions = fonts.filter((f) => f.available).map((f) => ({ value: f.name, label: f.name }));
    if (!fontOptions.some((o) => o.value === style.fontFamily)) fontOptions.unshift({ value: style.fontFamily, label: fonts.length ? `${style.fontFamily} (não encontrada)` : style.fontFamily });
    const bg = style.background;
    const upd = (patch) => setStyle(cut, patch, false);
    const fin = (patch) => setStyle(cut, patch, true);
    const group = (title, ...children) => el('div', { class: 'subs-group' }, el('h4', { class: 'subs-group-title' }, title), ...children);
    return el('details', { class: 'subs-details', dataset: { section: 'style' }, open: styleOpen, ontoggle: (event) => { styleOpen = event.target.open; lastPaint = ''; tick(); } },
      el('summary', {}, 'Aparência'),
      el('div', { class: 'subs-form' },
        group('Texto',
          selectField('Fonte', style.fontFamily, fontOptions, (v) => fin({ fontFamily: v }), 'font'),
          rangeField('Tamanho', style.fontSize, { min: 20, max: 140 }, (v) => upd({ fontSize: v }), (v) => fin({ fontSize: v }), 'size'),
          colorField('Cor do texto', style.color, (v) => upd({ color: v }), (v) => fin({ color: v }), 'color'),
          switchRow('Negrito', '', el('input', { type: 'checkbox', checked: style.bold, dataset: { fid: 'bold' }, onchange: (event) => fin({ bold: event.target.checked }) }))),
        group('Contorno',
          colorField('Cor do contorno', style.outlineColor, (v) => upd({ outlineColor: v }), (v) => fin({ outlineColor: v }), 'outline-color'),
          rangeField('Espessura', style.outlineWidth, { min: 0, max: 16, step: 0.5, format: (v) => String(v).replace('.', ',') }, (v) => upd({ outlineWidth: v }), (v) => fin({ outlineWidth: v }), 'outline')),
        group('Fundo',
          selectField('Fundo', bg, [{ value: 'none', label: 'Nenhum' }, { value: 'shadow', label: 'Sombra' }, { value: 'box', label: 'Caixa' }], (v) => { fin({ background: v }); render(); }, 'bg'),
          bg !== 'none' ? colorField(bg === 'box' ? 'Cor da caixa' : 'Cor da sombra', style.backgroundColor, (v) => upd({ backgroundColor: v }), (v) => fin({ backgroundColor: v }), 'bg-color') : null,
          bg !== 'none' ? rangeField('Opacidade', Math.round(style.backgroundOpacity * 100), { min: 0, max: 100, step: 5, format: (v) => `${v}%` }, (v) => upd({ backgroundOpacity: v / 100 }), (v) => fin({ backgroundOpacity: v / 100 }), 'bg-opacity') : null),
        group('Posição',
          selectField('Posição', style.position, [{ value: 'bottom', label: 'Inferior' }, { value: 'center', label: 'Centro' }, { value: 'top', label: 'Superior' }], (v) => fin({ position: v }), 'position'),
          rangeField('Caracteres por linha', style.maxCharsPerLine, { min: 8, max: 60 }, (v) => upd({ maxCharsPerLine: v }), (v) => fin({ maxCharsPerLine: v }), 'chars'))),
      el('p', { class: 'muted small subs-hint' }, 'A prévia aparece sobre o player. O tamanho vale para um quadro de 1080 px de lado menor e acompanha a resolução da exportação.'));
  }

  async function importFile(cut) {
    errors.delete('import');
    const res = await BF.api('subtitles:importFile', { defaultDir: BF.util.dirOf(project().source.path) });
    if (!res.ok) { errors.set('import', res.message); render(); return; }
    if (res.canceled) return;
    const imported = S.importCuesForCut(res.cues, cut);
    if (!imported.cues.length) {
      errors.set('import', `Nenhuma fala de "${res.name}" cai dentro deste corte (${fmt(cut.start)} → ${fmt(cut.end)}). O arquivo é lido como tempo do vídeo inteiro.`);
      render();
      return;
    }
    if (!(await confirmReplace(cut, 'Trocar a legenda deste corte pela do arquivo?'))) return;
    mutate(cut, (subs) => {
      subs.cues = imported.cues;
      subs.basedOn = S.rangeOf(cut);
      subs.enabled = true;
      delete subs.generated;
    }, { reason: 'subtitles:import', rerender: false });
    notes.delete(cut.id);
    const clipped = imported.clipped ? `; ${plural(imported.clipped, 'cortada na borda do corte', 'cortadas na borda do corte')} e marcada(s) para revisão` : '';
    addNote(cut.id, { kind: 'info', key: 'import', text: `${plural(imported.cues.length, 'fala importada', 'falas importadas')} de "${res.name}"${clipped}.` });
    render();
  }

  async function applyStyleToAll(cut) {
    const targets = project().cuts.filter((c) => c.id !== cut.id);
    if (!targets.length) { BF.ui.toast('Este é o único corte do projeto.'); return; }
    const sure = await BF.ui.confirm({
      title: 'Usar esta aparência em todos os cortes?',
      message: `A fonte, as cores, a posição e o tamanho de ${plural(targets.length, 'outro corte', 'outros cortes')} passam a ser os deste corte. As falas não mudam.`,
      okLabel: 'Aplicar'
    });
    if (!sure) return;
    const style = styleOf(cut);
    BF.project.update((proj) => {
      for (const c of proj.cuts) {
        if (c.id === cut.id) continue;
        ensureSubs(c).style = clone(style);
        stamp(c);
      }
    }, { reason: 'subtitles:style-all' });
    BF.bus.emit('cuts:changed', { ids: targets.map((c) => c.id), from: 'subtitles' });
    BF.ui.toast('Aparência aplicada a todos os cortes.', 'ok');
  }

  /** Guarda a aparência deste corte como a preferência `subtitles.style` (a que um corte novo, de um projeto novo, usa). */
  async function saveStyleAsDefault(cut) {
    const res = await BF.prefs.set('subtitles.style', styleOf(cut));
    if (res.ok) BF.ui.toast('Esta aparência vai ser a padrão das legendas dos próximos vídeos (Preferências > Legendas).', 'ok');
    else BF.ui.toast(res.message || 'Não foi possível guardar a aparência como padrão.', 'error');
  }

  function moreDetails(cut) {
    const format = subsOf(cut) ? S.sidecarFormatOf(subsOf(cut)) : defaultSubs().sidecarFormat;
    return el('details', { class: 'subs-details', dataset: { section: 'more' }, open: moreOpen, ontoggle: (event) => { moreOpen = event.target.open; } },
      el('summary', {}, 'Mais opções'),
      el('div', { class: 'subs-form' },
        selectField('Arquivo separado', format, [{ value: 'srt', label: 'SRT (texto simples)' }, { value: 'ass', label: 'ASS (com a aparência)' }], (v) => {
          mutate(cut, (s) => { s.sidecarFormat = v; }, { undo: false, reason: 'subtitles:format' });
          saveExt({ sidecarFormat: v });
        }, 'sidecar'),
        el('div', { class: 'subs-more-actions' },
          el('button', { type: 'button', class: 'sm', dataset: { act: 'import' }, onclick: () => importFile(cut) }, icon('upload_file'), 'Usar uma legenda existente (.srt ou .ass)'),
          el('button', { type: 'button', class: 'sm', dataset: { act: 'style-all' }, onclick: () => applyStyleToAll(cut) }, icon('content_copy'), 'Usar esta aparência em todos os cortes'),
          el('button', { type: 'button', class: 'sm', dataset: { act: 'style-default' }, onclick: () => saveStyleAsDefault(cut) }, icon('bookmark'), 'Usar esta aparência nos próximos vídeos')),
        el('p', { class: 'muted small' }, 'Uma legenda existente é lida como tempo do vídeo inteiro: só entram as falas que caem dentro do corte.'),
        installedModels()));
  }

  /** Modelos baixados, com a opção de remover (liberar espaço). O motor se remove na aba Ferramentas. */
  function installedModels() {
    const installed = ((status && status.models) || []).filter((m) => m.installed);
    if (!installed.length) return null;
    return el('div', { class: 'subs-models' },
      el('h4', { class: 'subs-group-title' }, 'Modelos baixados'),
      el('ul', { class: 'subs-model-list bds-list' }, installed.map((m) => el('li', { class: 'subs-model-row bds-list-item', dataset: { model: m.id } },
        el('span', { class: 'subs-model-name' }, `${m.label} · ${fmtBytes(m.installedSizeBytes)}`),
        m.managedByHost
          ? el('span', { class: 'bds-chip bds-chip-ok', title: 'Para remover, use as configurações de quem fornece o modelo.' }, `Fornecido pelo ${m.hostName || 'aplicativo'}`)
          : el('button', { type: 'button', class: 'secondary danger sm', dataset: { act: 'remove-model', model: m.id }, onclick: () => removeModel(m) }, 'Remover')))));
  }

  async function removeModel(model) {
    const sure = await BF.ui.confirm({
      title: `Remover o modelo ${model.label}?`,
      message: `O arquivo (${fmtBytes(model.installedSizeBytes)}) é apagado do computador. Dá para baixar de novo quando precisar.`,
      okLabel: 'Remover',
      danger: true
    });
    if (!sure) return;
    const res = await BF.api('subtitles:removeModel', { id: model.id });
    if (res.ok) BF.ui.toast(`Modelo ${model.label} removido.`, 'ok');
    else BF.ui.toast(res.message, 'error');
    await loadStatus();
  }

  // ---------- montagem ----------

  function build() {
    if (coreError) return [noteBox('error', coreError)];
    if (!S) return [el('p', { class: 'muted' }, 'Carregando…')];
    if (!project()) return [emptyState('movie', 'Abra um vídeo', 'Depois é só escolher um corte para legendar.', { center: true })];
    const cuts = cutsList();
    if (!cuts.length) return [emptyState('content_cut', 'Nenhum corte ainda', 'Marque um trecho no player e use “Salvar corte” para poder legendá-lo.', { center: true })];
    const cut = currentCut();
    const nodes = [cutPicker(cuts, cut)];
    if (statusError) nodes.push(noteBox('error', `Não foi possível ler a situação das legendas: ${statusError}`, { role: 'alert' }));
    if (!cut) {
      nodes.push(emptyState('subtitles', 'Escolha um corte', 'Aqui você vê, cria e edita a legenda dele.', { center: true }));
      return nodes;
    }
    nodes.push(setupBlock(), ...mainBlock(cut), el('section', { class: 'panel subs-adv' }, styleDetails(cut), moreDetails(cut)));
    return nodes.filter(Boolean);
  }

  function captureFocus() {
    const active = document.activeElement;
    if (!root || !active || !root.contains(active) || !active.dataset || !active.dataset.fid) return null;
    return { fid: active.dataset.fid, start: active.selectionStart, end: active.selectionEnd };
  }

  function restoreFocus(focus) {
    const fid = pendingFocus || (focus && focus.fid);
    if (!fid) return;
    const target = [...root.querySelectorAll('[data-fid]')].find((n) => n.dataset.fid === fid);
    pendingFocus = null;
    if (!target) return;
    target.focus();
    if (focus && fid === focus.fid && typeof target.setSelectionRange === 'function' && focus.start !== null && focus.start !== undefined) {
      try { target.setSelectionRange(focus.start, focus.end); } catch { /* campo sem seleção */ }
    }
  }

  function render() {
    if (!root) return;
    const focus = captureFocus();
    progressBar = null;
    progressText = null;
    rowEls = [];
    root.replaceChildren(...build());
    restoreFocus(focus);
    BF.ui.refreshTabs();
    tick();
  }

  // ---------- prévia sobre o player ----------

  const overlay = el('div', { class: 'sub-overlay', 'aria-hidden': 'true', hidden: true });
  const frameEl = el('div', { class: 'sub-frame' });
  const textEl = el('div', { class: 'sub-text' });
  frameEl.append(textEl);
  overlay.append(frameEl);
  document.body.append(overlay);
  let lastPaint = '';

  /** Tamanho do quadro de saída (só a proporção importa para a prévia): perfil do projeto, senão 1080x1920. */
  function outputSize() {
    const p = project();
    const id = (p && p.profileId) || '';
    const custom = ((p && p.customProfiles) || []).find((c) => c && c.id === id && c.width > 0 && c.height > 0);
    if (custom) return { w: custom.width, h: custom.height };
    const m = /^(vertical|horizontal)-(\d{3,4})/.exec(id);
    if (m) {
      const res = Number(m[2]);
      return m[1] === 'vertical' ? { w: res, h: Math.round((res * 16) / 9) } : { w: Math.round((res * 16) / 9), h: res };
    }
    return { w: 1080, h: 1920 };
  }

  function panelVisible() {
    const panel = root && root.closest('.tabpanel');
    return Boolean(panel) && !panel.hidden;
  }

  /** Cor "#rrggbb" + opacidade -> "rgba(r, g, b, a)". */
  function rgba(hex, opacity) {
    const h = hex.replace('#', '');
    return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${opacity})`;
  }

  /** Fator que leva o "tamanho" do ASS (altura da linha) ao font-size do CSS (em). Medido contra o libass (Arial). */
  const CSS_FONT_FACTOR = 0.89;

  function paintText(style, text, frameW, frameH, out) {
    const unit = Math.min(frameW, frameH) / 1080; // pixel de referência -> pixel de tela
    const fontPx = style.fontSize * unit * CSS_FONT_FACTOR;
    textEl.replaceChildren(...S.wrapText(text, style.maxCharsPerLine).split('\n').map((line) => el('span', { class: 'sub-line' }, line || ' ')));
    const t = textEl.style;
    t.fontFamily = `"${style.fontFamily}", sans-serif`;
    t.fontWeight = style.bold ? '700' : '400';
    t.fontSize = `${fontPx}px`;
    t.lineHeight = '1.15';
    t.color = style.color;
    t.setProperty('-webkit-text-stroke', `${style.outlineWidth * unit * 2}px ${style.outlineColor}`);
    t.setProperty('paint-order', 'stroke fill');
    t.textShadow = style.background === 'shadow' ? `${fontPx * 0.05}px ${fontPx * 0.05}px 0 ${rgba(style.backgroundColor, style.backgroundOpacity)}` : 'none';
    t.left = '0';
    t.right = '0';
    t.paddingLeft = `${frameW * 0.06}px`;
    t.paddingRight = `${frameW * 0.06}px`;
    const margin = S.marginFor(style.position, out.w, out.h) * (frameH / out.h);
    t.top = style.position === 'top' ? `${margin}px` : style.position === 'center' ? '50%' : 'auto';
    t.bottom = style.position === 'bottom' ? `${margin}px` : 'auto';
    t.transform = style.position === 'center' ? 'translateY(-50%)' : 'none';
    for (const line of textEl.children) {
      const ls = line.style;
      if (style.background === 'box') {
        ls.background = rgba(style.backgroundColor, style.backgroundOpacity);
        ls.padding = `${fontPx * 0.08}px ${fontPx * 0.3}px`;
      } else {
        ls.background = 'transparent';
        ls.padding = '0';
      }
    }
  }

  /** Atualiza a prévia (posição, texto da fala no ar) e o destaque da fala na lista. Barato: roda a cada quadro tocando. */
  function tick() {
    const video = BF.player.video;
    const cut = S ? currentCut() : null;
    const subs = subsOf(cut);
    const cues = cuesOf(cut);
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const wantsText = Boolean(subs && subs.enabled && cues.length);
    const wantsGuide = panelVisible();
    if (!S || !cut || !vw || !vh || (!wantsText && !wantsGuide)) { overlay.hidden = true; markActive(-1); return; }

    const rect = video.getBoundingClientRect();
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const dispW = vw * scale;
    const dispH = vh * scale;
    const out = outputSize();
    const ratio = out.w / out.h;
    let frameH = dispH;
    let frameW = frameH * ratio;
    if (frameW > dispW) { frameW = dispW; frameH = frameW / ratio; }
    if (!(frameW > 20 && frameH > 20)) { overlay.hidden = true; return; }
    const left = rect.left + (rect.width - frameW) / 2;
    const top = rect.top + (rect.height - frameH) / 2;

    const rel = BF.player.time() - cut.start;
    const inCut = rel >= 0 && rel < durationOf(cut);
    const idx = wantsText && inCut ? S.cueAt(cues, rel) : -1;
    markActive(idx);

    let text = idx >= 0 ? cues[idx].text : '';
    const sample = !text.trim() && styleOpen && wantsGuide;
    if (sample) text = (cues.find((c) => c.text.trim()) || { text: 'Exemplo de legenda' }).text;
    text = text.trim();

    const style = styleOf(cut);
    const key = `${left}|${top}|${frameW}|${frameH}|${text}|${JSON.stringify(style)}|${out.w}x${out.h}`;
    overlay.hidden = false;
    frameEl.classList.toggle('guide', wantsGuide);
    frameEl.classList.toggle('sample', sample);
    if (key === lastPaint) return;
    lastPaint = key;
    const fs = frameEl.style;
    fs.left = `${left}px`;
    fs.top = `${top}px`;
    fs.width = `${frameW}px`;
    fs.height = `${frameH}px`;
    if (text) paintText(style, text, frameW, frameH, out);
    textEl.hidden = !text;
  }

  function markActive(idx) {
    rowEls.forEach((row, i) => {
      if (!row || !row.isConnected) return;
      const active = i === idx;
      if (row.classList.contains('active') === active) return;
      row.classList.toggle('active', active);
      const editing = root && root.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (active && !editing && !BF.player.video.paused) row.scrollIntoView({ block: 'nearest' });
    });
  }

  let raf = 0;
  function loop() {
    tick();
    raf = BF.player.video.paused ? 0 : requestAnimationFrame(loop);
  }
  BF.player.video.addEventListener('play', () => { if (!raf) raf = requestAnimationFrame(loop); });
  for (const evt of ['pause', 'seeked', 'timeupdate', 'loadedmetadata', 'resize']) BF.player.video.addEventListener(evt, tick);
  window.addEventListener('resize', tick);
  if (typeof ResizeObserver === 'function') new ResizeObserver(tick).observe(BF.player.video);
  setInterval(tick, 500);

  // ---------- registro ----------

  function start() {
    reconcileAll();
    render();
  }

  BF.ui.registerTab({
    id: 'subtitles',
    title: 'Legendas',
    order: 40,
    badge: () => { const n = totalReview(); return n ? String(n) : ''; },
    render(container) {
      root = el('div', { class: 'subs' }, el('p', { class: 'muted' }, 'Carregando…'));
      container.append(root);
      if (S) start();
    },
    onShow() {
      reconcileAll();
      loadStatus();
      tick();
    }
  });

  BF.bus.on('project:loaded', () => {
    selectedId = null;
    if (gen) BF.api('subtitles:cancel', { cutId: gen.cutId }); // o resultado não teria onde ser aplicado: libera o computador
    gen = null;
    notes.clear();
    undoStacks.clear();
    errors.clear();
    lastPaint = '';
    if (!S) return;
    reconcileAll();
    render();
  });
  BF.bus.on('cuts:changed', (data) => {
    if (!S || (data && data.from === 'subtitles')) return;
    reconcileAll();
    render();
  });
  BF.bus.on('cut:selected', ({ id }) => {
    selectedId = id;
    lastPaint = '';
    if (S) render();
  });
  BF.bus.on('player:time', tick);
  // Preferências de legenda (estilo e entrega) mudaram: um corte que ainda não tem legenda mostra (e nasce com) os valores novos
  BF.bus.on('prefs:changed', ({ keys } = {}) => {
    if (!S || (Array.isArray(keys) && !keys.some((k) => String(k).startsWith('subtitles.')))) return;
    lastPaint = '';
    render();
  });
})();

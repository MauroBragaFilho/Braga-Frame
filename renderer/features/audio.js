'use strict';

/**
 * Aba "Áudio" (dono: audio): ajustes MANUAIS de áudio do corte selecionado — ganho em dB, mudo e fades —
 * e nada além disso (sem normalização, redução de ruído, compressor ou "melhoria" automática).
 *
 *  - Não destrutivo: o áudio da fonte nunca é tocado. Os ajustes ficam em cut.audio e só valem na exportação
 *    (o filtro vem de src/core/audio/audioFilter.js, a mesma regra que esta aba usa na prévia).
 *  - Prévia real: alternar "Original" × "Ajustado" ouvindo o trecho no player. O áudio do <video> passa por um
 *    GainNode da Web Audio API (ganho, mudo e fades de verdade, agendados no relógio do áudio); o arquivo nunca muda.
 *  - Histórico por corte (cut.audio.history, até 50 entradas), desfazer/refazer, restaurar uma entrada e
 *    "Voltar ao original" (src/core/audio/audioHistory.js).
 *  - Informações úteis e NÃO impeditivas: medição do trecho (audio:measure, volumedetect) e avisos (possível
 *    distorção quando ganho + pico passa de 0 dB; fonte sem faixa de áudio). Avisos nunca corrigem nada sozinhos.
 *  - Cada mudança emite BF.bus 'decision' { cutId, type: 'adjust', scope: 'audio', before, after } com os quatro
 *    valores (gainDb, mute, fadeInSec, fadeOutSec) antes e depois.
 *  - A aba só age quando está à vista: a prévia só soa ajustada e o ffmpeg só mede com a aba Áudio aberta (nas outras
 *    abas o player toca o áudio original e nada é medido), e Ctrl+Z / Ctrl+Y valem para o ajuste de áudio.
 *
 * Expõe BF.audioPreview { state(), level(), setMode(mode), nodes() } (usado pelos testes e útil a quem precisar
 * do mesmo MediaElementSource: um <video> só aceita um).
 */
(function () {
  const BF = window.BF;
  const { el, fmt } = BF.util;

  const RULE_SCRIPTS = ['../src/core/audio/audioFilter.js', '../src/core/audio/audioHistory.js'];
  const GRACE_SEC = 0.3; // depois do fim do corte a prévia ainda segura o último valor (evita um estalo)
  const SMOOTH_SEC = 0.015; // rampa curta ao trocar de valor no meio do som
  const MEASURE_DELAY_MS = 250;
  const MEASURE_CACHE_MAX = 300;
  const FLASH_MS = 6000;

  let AF = null; // window.BFAudioFilter  (limites, filtro, envelope)
  let AH = null; // window.BFAudioHistory (histórico, desfazer/refazer)
  let ui = null; // elementos da aba
  let panel = null; // painel da aba (o app o esconde quando outra aba está aberta)

  const idleMeasure = () => ({ status: 'idle', key: null, data: null, message: '' });
  /** A aba está à vista? Fora dela o player toca o áudio original e o ffmpeg não é chamado. */
  const isVisible = () => Boolean(panel) && !panel.hidden;

  const state = {
    ready: false,
    rulesError: null,
    selectedId: null,
    mode: 'adjusted', // o que o player toca: 'original' | 'adjusted'
    drag: null, // valor em arrasto (só na prévia, ainda não gravado), ex.: { gainDb: 3.2 }
    typing: false,
    measure: idleMeasure(), // { status, key (corte+trecho a que se refere), data, message }
    graph: null, // { ctx, source, gain, analyser, buffer, anchor }
    graphError: null
  };
  const measureCache = new Map();
  let measureSeq = 0;
  let flashTimer = null;

  // ---------- formatação (pt-BR) ----------

  const ptNum = (n, decimals = 1) => n.toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const ptDb = (n) => `${ptNum(n, 1)} dB`;
  const ptSigned = (n) => `${n > 0 ? '+' : ''}${ptNum(n, 1)}`;
  const ptClock = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) || d.getTime() === 0 ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  /** Texto digitado -> número (aceita vírgula); null se não for um número. */
  function parseNumber(text) {
    const t = String(text).trim().replace(',', '.');
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

  // ---------- regras (arquivos universais do núcleo) ----------

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const node = document.createElement('script');
      node.src = new URL(src, document.baseURI).href;
      node.onload = resolve;
      node.onerror = () => reject(new Error(`não foi possível carregar ${src}`));
      document.head.append(node);
    });
  }

  async function loadRules() {
    if (!window.BFAudioFilter) await loadScript(RULE_SCRIPTS[0]);
    if (!window.BFAudioHistory) await loadScript(RULE_SCRIPTS[1]);
    AF = window.BFAudioFilter;
    AH = window.BFAudioHistory;
  }

  // ---------- estado derivado ----------

  const currentCut = () => (state.selectedId ? BF.project.cut(state.selectedId) : null);
  const sortedCuts = () => (BF.state.project ? [...BF.state.project.cuts].sort((a, b) => a.start - b.start) : []);
  const durationOf = (cut) => Math.max(0, cut.end - cut.start);

  /** Valores em vigor para o corte (com o arrasto em andamento, que ainda não foi gravado). */
  function liveAudio(cut) {
    const stored = AF.normalizeAudio(cut.audio);
    return state.drag ? AF.normalizeAudio({ ...stored, ...state.drag }) : stored;
  }

  const isNeutral = (cut) => AF.resolveAudio(liveAudio(cut), { duration: durationOf(cut) }).neutral;
  const sourceHasAudio = () => !(BF.state.info && BF.state.info.hasAudio === false);

  // ---------- prévia: Web Audio (GainNode ligado ao elemento de vídeo) ----------

  /**
   * Liga o áudio do <video> a um GainNode (e a um AnalyserNode, só para medir o que sai). A ligação é feita uma
   * vez e não pode ser desfeita: o elemento passa a soar pelo grafo. Sem Web Audio, a prévia com ajuste fica
   * indisponível (a exportação continua aplicando os ajustes).
   */
  function ensureGraph() {
    if (state.graph) return state.graph;
    if (state.graphError) return null;
    let ctx = null;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('este ambiente não tem Web Audio.');
      ctx = new Ctx();
      const source = ctx.createMediaElementSource(BF.player.video);
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(gain);
      gain.connect(analyser);
      analyser.connect(ctx.destination);
      state.graph = { ctx, source, gain, analyser, buffer: new Float32Array(analyser.fftSize), anchor: null };
    } catch (err) {
      if (ctx && typeof ctx.close === 'function') ctx.close().catch(() => {});
      state.graphError = err && err.message ? err.message : String(err);
      console.warn('Prévia de áudio com ajuste indisponível:', state.graphError);
      if (ui) { refresh(); }
      return null;
    }
    schedule();
    return state.graph;
  }

  /** Vai ao valor novo; se ele difere do que está soando, com uma rampa curta (trocar de modo ou de valor sem estalo). */
  function setSmooth(param, previous, value, time) {
    if (Math.abs(previous - value) > 0.01) {
      param.setValueAtTime(previous, time);
      param.linearRampToValueAtTime(value, time + SMOOTH_SEC);
    } else {
      param.setValueAtTime(value, time);
    }
  }

  /**
   * Agenda o ganho do GainNode a partir da posição atual do player. Dentro do corte vale o envelope dos
   * ajustes (ganho/mudo vezes as rampas dos fades); fora dele, no modo "Original" e com outra aba aberta, o som passa
   * como está (quem revisa na aba Cortes ouve o áudio da fonte, nunca um corte mudo sem saber).
   * Tudo é agendado no relógio do áudio (não depende de timers nem de quadros de tela).
   */
  function schedule() {
    const g = state.graph;
    if (!g) return;
    const video = BF.player.video;
    const param = g.gain.gain;
    const now = g.ctx.currentTime;
    const previous = param.value;
    param.cancelScheduledValues(now);
    g.anchor = null;
    g.visible = isVisible();
    const cut = currentCut();
    if (!AF || !cut || state.mode !== 'adjusted' || !g.visible) {
      setSmooth(param, previous, 1, now);
      return;
    }

    const resolved = AF.resolveAudio(liveAudio(cut), { duration: durationOf(cut) });
    const rate = video.playbackRate > 0 ? video.playbackRate : 1;
    const mediaTime = video.currentTime || 0;
    g.anchor = { media: mediaTime, ctxTime: now, rate };
    const plan = AF.previewPlan(resolved, { start: cut.start, end: cut.end, mediaTime, rate, now, graceSec: GRACE_SEC });
    plan.forEach((step, index) => {
      if (index === 0 && step.op === 'set') setSmooth(param, previous, step.value, step.time);
      else if (step.op === 'ramp') param.linearRampToValueAtTime(step.value, step.time);
      else param.setValueAtTime(step.value, step.time);
    });
  }

  /** O vídeo e o relógio do áudio andam juntos; se saírem do passo (mais de ~0,1 s), agenda de novo. */
  function checkDrift() {
    const g = state.graph;
    const video = BF.player.video;
    if (!g) return;
    if (g.visible !== isVisible()) { schedule(); return; } // trocou de aba com o som tocando: volta ao áudio original (ou ao ajustado)
    if (!g.anchor || video.paused) return;
    const expected = g.anchor.media + (g.ctx.currentTime - g.anchor.ctxTime) * g.anchor.rate;
    if (Math.abs(video.currentTime - expected) > 0.12) schedule();
  }

  /** Nível (dBFS) do que está saindo agora, depois do ganho: { rmsDb, peakDb } ou null sem prévia ligada. */
  function level() {
    const g = state.graph;
    if (!g) return null;
    g.analyser.getFloatTimeDomainData(g.buffer);
    let sum = 0;
    let peak = 0;
    for (const x of g.buffer) { sum += x * x; peak = Math.max(peak, Math.abs(x)); }
    const toDb = (lin) => (lin > 0 ? Math.max(-120, 20 * Math.log10(lin)) : -120);
    return { rmsDb: toDb(Math.sqrt(sum / g.buffer.length)), peakDb: toDb(peak) };
  }

  function setMode(mode) {
    if (mode !== 'original' && mode !== 'adjusted') return;
    state.mode = mode;
    schedule();
    refresh();
  }

  const isPlayingCut = (cut) => {
    const video = BF.player.video;
    return Boolean(cut) && !video.paused && video.currentTime >= cut.start - 0.15 && video.currentTime <= cut.end + 0.15;
  };

  async function togglePlay() {
    const cut = currentCut();
    if (!cut) return;
    if (isPlayingCut(cut)) { BF.player.pause(); return; }
    const g = ensureGraph();
    if (g && g.ctx.state === 'suspended') {
      try { await g.ctx.resume(); } catch { /* sem dispositivo de áudio: o player toca do mesmo jeito */ }
    }
    BF.player.seek(cut.start); // o ganho do início já fica agendado antes de o som começar
    schedule();
    BF.player.playRange(cut.start, cut.end);
  }

  // ---------- gravação dos ajustes ----------

  function flash(text) {
    if (!ui) return;
    clearTimeout(flashTimer);
    ui.flash.textContent = text;
    ui.flash.hidden = !text;
    if (text) flashTimer = setTimeout(() => { ui.flash.hidden = true; ui.flash.textContent = ''; }, FLASH_MS);
  }

  /** Texto da barra de status: o que ACONTECEU (desfazer mostra o ajuste desfeito, não o valor de antes). */
  function statusText(res, verb) {
    if (!res.entry) return 'Áudio do corte: ajuste desfeito.';
    if (verb === 'undo') return `Desfeito: ${res.entry.label}.`;
    if (verb === 'redo') return `Refeito: ${res.entry.label}.`;
    if (verb === 'restore') return `${res.entry.label}.`; // o rótulo já começa com "Restaurado:"
    return `Áudio do corte: ${res.entry.label}.`;
  }

  /** Grava o resultado de uma operação do histórico no corte, avisa os outros recursos e redesenha. */
  function apply(cut, res, verb = 'change') {
    state.drag = null;
    state.typing = false;
    if (!res || !res.changed) { refresh(); schedule(); return false; }
    BF.project.update(() => {
      cut.audio = res.audio;
      cut.updatedAt = new Date().toISOString();
    }, { reason: 'audio:adjust' });
    BF.bus.emit('cuts:changed', { ids: [cut.id], from: 'audio:adjust' });
    BF.bus.emit('decision', { cutId: cut.id, type: 'adjust', scope: 'audio', before: res.before, after: res.after });
    BF.ui.log(statusText(res, verb), 'ok');
    if (!AF.resolveAudio(res.audio, { duration: durationOf(cut) }).neutral) ensureGraph();
    refresh();
    schedule();
    return true;
  }

  function commit(patch) {
    const cut = currentCut();
    if (!cut) return false;
    return apply(cut, AH.applyChange(cut.audio, patch, { now: Date.now() }));
  }

  function undo() { flash(''); const cut = currentCut(); if (cut) apply(cut, AH.undo(cut.audio), 'undo'); }
  function redo() { flash(''); const cut = currentCut(); if (cut) apply(cut, AH.redo(cut.audio), 'redo'); }
  function reset() { flash(''); const cut = currentCut(); if (cut) apply(cut, AH.resetToOriginal(cut.audio, { now: Date.now() })); }
  function restore(index) { flash(''); const cut = currentCut(); if (cut) apply(cut, AH.restoreEntry(cut.audio, index, { now: Date.now() }), 'restore'); }

  // ---------- medição do trecho (informativa) ----------

  const measureKey = (cut) => `${BF.state.project.source.path}|${cut.start.toFixed(3)}|${cut.end.toFixed(3)}`;

  /**
   * Põe o estado da medição em dia com o corte de agora, na hora e sem esperar o ffmpeg: o que veio de outro corte
   * ou de outro trecho deixa de valer, e qualquer resposta que ainda esteja a caminho passa a ser ignorada. Só mede
   * com a aba Áudio à vista. Devolve true quando ainda falta pedir a medição ao ffmpeg.
   */
  function primeMeasure() {
    measureSeq += 1;
    const cut = currentCut();
    if (!cut || !BF.state.project || !isVisible()) { state.measure = idleMeasure(); return false; }
    const key = measureKey(cut);
    if (measureCache.has(key)) { state.measure = { status: 'ok', key, data: measureCache.get(key), message: '' }; return false; }
    if (!BF.state.tools.ffmpeg) {
      state.measure = { status: 'unavailable', key, data: null, message: 'Medição indisponível: o FFmpeg não foi encontrado. Instale-o e use “Verificar de novo” no aviso do topo.' };
      return false;
    }
    state.measure = { status: 'loading', key, data: null, message: '' };
    return true;
  }

  async function runMeasure() {
    const needsRequest = primeMeasure();
    renderNotes();
    if (!needsRequest) return;
    const seq = measureSeq;
    const { key } = state.measure;
    const cut = currentCut();
    const sourcePath = BF.state.project.source.path;
    const res = await BF.api('audio:measure', { sourcePath, start: cut.start, end: cut.end });
    if (res.ok) {
      if (measureCache.size >= MEASURE_CACHE_MAX) measureCache.delete(measureCache.keys().next().value);
      measureCache.set(key, res); // vale para este trecho mesmo que o usuário já esteja em outro corte
    }
    if (seq !== measureSeq) return; // resposta velha: o corte, o trecho ou a aba mudaram enquanto o ffmpeg trabalhava
    state.measure = res.ok
      ? { status: 'ok', key, data: res, message: '' }
      : { status: 'error', key, data: null, message: `Não foi possível medir o trecho: ${res.message}` };
    renderNotes();
  }

  const scheduleMeasure = BF.util.debounce(runMeasure, MEASURE_DELAY_MS);

  /** Corte, trecho ou aba mudaram: atualiza o estado já (nada de medição velha na tela) e pede ao ffmpeg só o que falta. */
  function measureSoon() {
    if (primeMeasure()) scheduleMeasure();
    else scheduleMeasure.cancel();
  }

  // ---------- desenho ----------

  function buildUi(container) {
    const icon = (name) => el('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true' }, name);
    const numberInput = (id, label, unit, attrs) => {
      const input = el('input', { type: 'number', id, step: '0.1', ...attrs });
      return { input, wrap: el('div', { class: 'audio-field' }, el('label', { for: id }, label), el('span', { class: 'audio-num' }, input, el('span', { class: 'audio-unit' }, unit))) };
    };

    const select = el('select', { id: 'audioCut', 'aria-label': 'Corte a ajustar' });
    const seg = (mode, text) => el('button', { type: 'button', class: 'bds-tab', dataset: { mode }, 'aria-pressed': 'false', onclick: () => setMode(mode) }, text);
    const gainNum = numberInput('audioGainNum', 'Ganho', 'dB', { min: String(-30), max: String(20) });
    const gain = el('input', { type: 'range', id: 'audioGain', min: '-30', max: '20', step: '0.1', 'aria-label': 'Ganho em dB (controle deslizante)' });
    const mute = el('input', { type: 'checkbox', id: 'audioMute', class: 'bds-switch', role: 'switch' });
    const fadeIn = numberInput('audioFadeIn', 'Fade in', 's', { min: '0', max: '0' });
    const fadeOut = numberInput('audioFadeOut', 'Fade out', 's', { min: '0', max: '0' });

    ui = {
      error: el('p', { class: 'audio-note warn', role: 'alert', hidden: true }),
      pickRow: el('div', { class: 'audio-pick', hidden: true }, el('label', { for: 'audioCut', class: 'sr-only' }, 'Corte'), select),
      select,
      emptyTitle: el('strong', {}),
      emptyText: el('p', {}),
      body: el('div', { class: 'audio-body', hidden: true }),
      meta: el('p', { class: 'audio-meta muted small' }),
      notes: el('ul', { class: 'audio-notes', 'aria-live': 'polite' }),
      segOriginal: seg('original', 'Original'),
      segAdjusted: seg('adjusted', 'Ajustado'),
      play: el('button', { type: 'button', class: 'primary', id: 'audioPlay', onclick: togglePlay }, 'Ouvir trecho'),
      same: el('p', { class: 'audio-same muted small', hidden: true }, 'Sem ajustes ainda: Original e Ajustado soam iguais.'),
      gain, gainNum: gainNum.input,
      mute,
      fadeIn: fadeIn.input, fadeOut: fadeOut.input,
      fadeHint: el('p', { class: 'audio-hint muted small' }),
      flash: el('p', { class: 'audio-flash small', role: 'status', hidden: true }),
      measure: el('p', { class: 'audio-measure small', 'aria-live': 'polite' }),
      undo: el('button', { type: 'button', class: 'sm', id: 'audioUndo', onclick: undo }, icon('undo'), 'Desfazer'),
      redo: el('button', { type: 'button', class: 'sm', id: 'audioRedo', onclick: redo }, icon('redo'), 'Refazer'),
      reset: el('button', { type: 'button', class: 'secondary sm', id: 'audioReset', onclick: reset }, 'Voltar ao original'),
      historySummary: el('summary', {}, 'Histórico'),
      historyList: el('ol', { class: 'audio-history-list' }),
      historyEmpty: el('p', { class: 'muted small' }, 'Nenhuma mudança neste corte ainda.'),
      filterText: el('code', { class: 'audio-filter' }),
      selectSig: null
    };
    ui.empty = el('div', { class: 'audio-empty empty-state center', hidden: true },
      el('span', { class: 'empty-state-icon material-symbols-rounded', 'aria-hidden': 'true' }, 'graphic_eq'),
      el('div', { class: 'empty-state-text' }, ui.emptyTitle, ui.emptyText));

    ui.segOriginal.id = 'audioModeOriginal';
    ui.segAdjusted.id = 'audioModeAdjusted';

    // ganho: o controle deslizante toca ao vivo (input) e só grava ao soltar (change)
    ui.gain.addEventListener('input', () => {
      state.drag = { gainDb: Number(ui.gain.value) };
      ui.gainNum.value = String(Number(ui.gain.value));
      refreshLive();
    });
    ui.gain.addEventListener('change', () => { flash(''); commit({ gainDb: Number(ui.gain.value) }); });
    for (const input of [ui.gainNum, ui.fadeIn, ui.fadeOut]) {
      input.addEventListener('input', () => { state.typing = true; });
      input.addEventListener('blur', () => { state.typing = false; });
    }
    ui.gainNum.addEventListener('change', () => {
      state.typing = false;
      flash('');
      const n = parseNumber(ui.gainNum.value);
      if (n === null) { flash('Digite o ganho em dB, por exemplo 3 ou -2,5.'); refresh(); return; }
      const clamped = Math.min(AF.LIMITS.gainMaxDb, Math.max(AF.LIMITS.gainMinDb, n));
      if (clamped !== n) flash(`O ganho vai de ${AF.LIMITS.gainMinDb} a +${AF.LIMITS.gainMaxDb} dB; usei ${ptSigned(clamped)} dB.`);
      commit({ gainDb: clamped });
    });
    ui.mute.addEventListener('change', () => { flash(''); commit({ mute: ui.mute.checked }); });
    const fadeChange = (input, field, name) => () => {
      state.typing = false;
      flash('');
      const cut = currentCut();
      if (!cut) return;
      const n = parseNumber(input.value);
      if (n === null || n < 0) { flash(`Digite o ${name} em segundos, por exemplo 0,5.`); refresh(); return; }
      const max = AF.maxFadeSec(durationOf(cut));
      const clamped = Math.min(n, max);
      if (clamped !== n) flash(`O ${name} é limitado à metade do corte: usei ${ptNum(clamped, 2)} s.`);
      commit({ [field]: clamped });
    };
    ui.fadeIn.addEventListener('change', fadeChange(ui.fadeIn, 'fadeInSec', 'fade in'));
    ui.fadeOut.addEventListener('change', fadeChange(ui.fadeOut, 'fadeOutSec', 'fade out'));
    ui.select.addEventListener('change', () => { if (ui.select.value) BF.bus.emit('cut:selected', { id: ui.select.value }); });

    ui.body.append(
      ui.meta,
      ui.notes,
      el('section', { class: 'panel audio-listen' },
        el('div', { class: 'audio-compare' },
          el('div', { class: 'bds-tabs audio-seg', role: 'group', 'aria-label': 'Ouvir como' }, ui.segOriginal, ui.segAdjusted),
          ui.play),
        ui.same),
      el('section', { class: 'panel audio-controls' },
        el('h3', { class: 'panel-title' }, 'Ajustes'),
        el('div', { class: 'audio-gain' }, gainNum.wrap, ui.gain, el('div', { class: 'audio-scale muted small' }, el('span', {}, '-30 dB'), el('span', {}, '+20 dB'))),
        el('label', { class: 'audio-check', for: 'audioMute' },
          el('span', { class: 'audio-check-text' }, el('strong', {}, 'Mudo'), el('span', { class: 'small' }, 'Silencia este corte na exportação')),
          ui.mute),
        el('div', { class: 'audio-fades' }, fadeIn.wrap, fadeOut.wrap),
        ui.fadeHint,
        ui.flash,
        ui.measure,
        el('div', { class: 'audio-actions' },
          el('div', { class: 'audio-history-actions' }, ui.undo, ui.redo),
          ui.reset)),
      el('section', { class: 'panel audio-more' },
        el('details', { class: 'audio-details audio-history' }, ui.historySummary, ui.historyList, ui.historyEmpty),
        el('details', { class: 'audio-details audio-export' },
          el('summary', {}, 'Como será exportado'),
          el('p', { class: 'muted small' }, 'Filtro de áudio do FFmpeg gerado a partir destes ajustes. O arquivo original nunca é alterado.'),
          ui.filterText)));

    container.append(el('div', { class: 'audio' }, ui.error, ui.pickRow, ui.empty, ui.body));
  }

  /** Atualiza só o que muda enquanto o controle está sendo arrastado (sem gravar nada). */
  function refreshLive() {
    const cut = currentCut();
    if (!cut || !state.ready) return;
    schedule();
    renderNotes();
    renderSummary(cut);
  }

  function setValue(input, value) {
    if (document.activeElement === input && state.typing) return; // não atrapalha quem está digitando
    if (Number(input.value) !== value || input.value === '') input.value = String(value);
  }

  function renderSummary(cut) {
    const live = liveAudio(cut);
    const resolved = AF.resolveAudio(live, { duration: durationOf(cut) });
    ui.same.hidden = !resolved.neutral;
    ui.body.classList.toggle('is-muted', live.mute);
  }

  /** Avisos (não impeditivos) e a linha de medição do trecho. */
  function renderNotes() {
    if (!ui || !state.ready) return;
    const cut = currentCut();
    if (!cut) return;
    const live = liveAudio(cut);
    const resolved = AF.resolveAudio(live, { duration: durationOf(cut) });
    const notes = [];
    const m = state.measure;
    const mine = m.key !== null && m.key === measureKey(cut); // a medição guardada é a deste corte e deste trecho?
    const data = mine && m.status === 'ok' ? m.data : null;

    if (!sourceHasAudio() || (data && data.hasAudio === false)) {
      notes.push({ kind: 'warn', text: 'Este vídeo não tem faixa de áudio, então os ajustes não têm efeito na exportação.' });
    }
    if (mine && (m.status === 'unavailable' || m.status === 'error')) notes.push({ kind: 'info', text: m.message });
    if (data && data.hasAudio && data.samples === 0) notes.push({ kind: 'info', text: 'O trecho não tem amostras de áudio para medir (fica depois do fim do áudio).' });
    if (data && data.hasAudio && Number.isFinite(data.peakDb) && !live.mute) {
      const predicted = data.peakDb + live.gainDb;
      if (Math.round(predicted * 10) / 10 > 0) {
        notes.push({ kind: 'warn', text: `Atenção: com ${ptSigned(live.gainDb)} dB o pico do trecho chega a ${ptSigned(predicted)} dB, acima de 0 dB. O som pode distorcer (estourar). O app não corrige isso sozinho: reduza o ganho se quiser evitar.` });
      }
    }
    for (const w of resolved.warnings) notes.push({ kind: 'info', text: w.message });
    if (state.graphError) notes.push({ kind: 'info', text: `A prévia com ajuste não está disponível (${state.graphError}). A exportação aplica os ajustes normalmente.` });

    ui.notes.replaceChildren(...notes.map((n) => el('li', { class: `audio-note ${n.kind}` }, n.text)));
    ui.notes.hidden = notes.length === 0;

    let line = '';
    if (mine && m.status === 'loading') line = 'Medindo o trecho…';
    else if (data && data.hasAudio && Number.isFinite(data.peakDb)) {
      line = data.peakDb <= -90 ? 'Trecho original: silêncio.' : `Trecho original: pico ${ptDb(data.peakDb)} · média ${ptDb(data.meanDb)}`;
      if (!live.mute && data.peakDb > -90 && Math.abs(live.gainDb) >= AF.GAIN_EPSILON_DB) line += ` · com o ajuste: pico até ${ptDb(data.peakDb + live.gainDb)}`;
    }
    ui.measure.textContent = line;
    ui.measure.hidden = !line;
  }

  function renderHistory(cut) {
    const entries = AH.historyOf(cut.audio);
    ui.historySummary.textContent = entries.length ? `Histórico (${entries.length})` : 'Histórico';
    ui.historyEmpty.hidden = entries.length > 0;
    ui.historyList.hidden = entries.length === 0;
    ui.historyList.replaceChildren(...entries.map((entry, index) => el('li', { dataset: { index: String(index) } },
      el('span', { class: 'audio-h-time muted small' }, ptClock(entry.at)),
      el('span', { class: 'audio-h-label' }, entry.label),
      el('button', {
        type: 'button', class: 'audio-restore sm', title: 'Volta o áudio deste corte ao estado em que esta mudança o deixou',
        onclick: () => restore(index)
      }, 'Restaurar'))).reverse());
  }

  function updateSelect(cuts, cut) {
    const sig = cuts.map((c) => `${c.id}|${c.title}|${c.start}|${c.end}`).join(';');
    if (sig !== ui.selectSig) {
      ui.selectSig = sig;
      ui.select.replaceChildren(
        el('option', { value: '' }, 'Escolha um corte…'),
        ...cuts.map((c, i) => el('option', { value: c.id }, `${i + 1}. ${c.title} (${fmt(c.start)} → ${fmt(c.end)})`)));
    }
    ui.select.value = cut ? cut.id : '';
  }

  function updatePlayButton() {
    if (!ui) return;
    ui.play.textContent = isPlayingCut(currentCut()) ? 'Parar' : 'Ouvir trecho';
  }

  function setEmpty(title, text) {
    ui.emptyTitle.textContent = title;
    ui.emptyText.textContent = text;
    ui.emptyText.hidden = !text;
  }

  function refresh() {
    if (!ui) return;
    ui.error.hidden = !state.rulesError;
    if (state.rulesError) {
      ui.error.textContent = `Não foi possível carregar as regras de áudio (${state.rulesError}). Reinicie o app; se continuar, reinstale.`;
      ui.pickRow.hidden = true; ui.empty.hidden = true; ui.body.hidden = true;
      return;
    }
    if (!state.ready) {
      ui.empty.hidden = false;
      setEmpty('Carregando…', '');
      ui.body.hidden = true;
      return;
    }
    const cuts = sortedCuts();
    if (state.selectedId && !currentCut()) state.selectedId = null; // o corte foi removido
    const cut = currentCut();
    updateSelect(cuts, cut);
    ui.pickRow.hidden = cuts.length === 0;
    ui.empty.hidden = Boolean(cut);
    ui.body.hidden = !cut;
    if (!cut) {
      if (cuts.length) setEmpty('Escolha um corte', 'Na lista acima ou na aba Cortes. Os ajustes não alteram o vídeo original: valem só na exportação.');
      else setEmpty('Este projeto ainda não tem cortes', 'Marque início e fim no player e use “Salvar corte”; depois volte aqui para ajustar o áudio dele.');
      return;
    }

    const live = liveAudio(cut);
    const duration = durationOf(cut);
    const maxFade = AF.maxFadeSec(duration);
    ui.meta.textContent = `Trecho de ${fmt(cut.start)} a ${fmt(cut.end)} · ${ptNum(duration, 1)} s`;
    setValue(ui.gain, live.gainDb);
    setValue(ui.gainNum, live.gainDb);
    ui.mute.checked = live.mute;
    ui.fadeIn.max = String(maxFade);
    ui.fadeOut.max = String(maxFade);
    setValue(ui.fadeIn, live.fadeInSec);
    setValue(ui.fadeOut, live.fadeOutSec);
    ui.fadeHint.textContent = maxFade > 0 ? `Cada fade pode ter até ${ptNum(maxFade, 2)} s (metade do corte).` : 'O corte é curto demais para ter fades.';

    for (const [button, mode] of [[ui.segOriginal, 'original'], [ui.segAdjusted, 'adjusted']]) {
      const on = state.mode === mode;
      button.setAttribute('aria-pressed', String(on));
      button.classList.toggle('active', on);
      button.disabled = Boolean(state.graphError);
      button.title = state.graphError ? 'A prévia com ajuste não está disponível neste computador.' : '';
    }
    updatePlayButton();

    const canUndo = AH.canUndo(cut.audio);
    const canRedo = AH.canRedo(cut.audio);
    const entries = AH.historyOf(cut.audio);
    const redoEntries = AH.redoOf(cut.audio);
    ui.undo.disabled = !canUndo;
    ui.redo.disabled = !canRedo;
    ui.undo.title = canUndo ? `Desfazer: ${entries[entries.length - 1].label}` : 'Nada para desfazer';
    ui.redo.title = canRedo ? `Refazer: ${redoEntries[redoEntries.length - 1].label}` : 'Nada para refazer';
    ui.reset.disabled = AH.sameValues(AH.values(cut.audio), AH.values({})) && !state.drag; // já está no original

    const filter = AF.buildAudioFilter(live, { duration });
    ui.filterText.textContent = filter || 'Nenhum filtro: o áudio do corte sai como na fonte.';

    renderHistory(cut);
    renderSummary(cut);
    renderNotes();
  }

  // ---------- eventos do app ----------

  /** Tudo o que depende de a aba estar à vista: prévia ajustada, medição e desenho. */
  function sync() {
    if (!state.ready) return;
    const cut = currentCut();
    if (cut && isVisible() && !isNeutral(cut)) ensureGraph(); // quem abre um corte já ajustado espera ouvi-lo ajustado
    measureSoon();
    refresh();
    schedule();
  }

  function select(id) {
    flash('');
    state.selectedId = id;
    state.drag = null;
    state.typing = false;
    sync();
  }

  BF.bus.on('cut:selected', ({ id }) => { if (state.ready) select(id); else state.selectedId = id; });

  BF.bus.on('cuts:changed', (data) => {
    if (data && data.from === 'audio:adjust') return;
    measureSoon();
    refresh();
    schedule();
  });

  BF.bus.on('project:loaded', () => {
    state.selectedId = null;
    state.drag = null;
    measureSeq += 1;
    state.measure = idleMeasure();
    scheduleMeasure.cancel();
    refresh();
    schedule();
  });

  BF.bus.on('tools:changed', () => { if (state.selectedId) { measureSoon(); refresh(); } });

  // Atalhos: com a aba Áudio à vista, Ctrl+Z / Ctrl+Y (ou Ctrl+Shift+Z) desfazem e refazem o ajuste de áudio, e não
  // as decisões da revisão (o atalho da aba Cortes respeita defaultPrevented). Em campo de texto vale o desfazer do campo.
  function isTextEntry(node) {
    if (!node || typeof node.tagName !== 'string') return false;
    const tag = node.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') return !['checkbox', 'radio', 'button', 'range', 'submit', 'reset', 'file', 'image', 'color'].includes(String(node.type || 'text').toLowerCase());
    return Boolean(node.isContentEditable);
  }

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || !state.ready || !isVisible() || !BF.state.project) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (key !== 'z' && key !== 'y') return;
    if (document.querySelector('.bf-modal') || isTextEntry(event.target)) return;
    event.preventDefault();
    const again = key === 'y' || event.shiftKey;
    const cut = currentCut();
    if (!cut || !(again ? AH.canRedo(cut.audio) : AH.canUndo(cut.audio))) {
      BF.ui.log(again ? 'Nada para refazer no áudio deste corte.' : 'Nada para desfazer no áudio deste corte.');
      return;
    }
    if (again) redo(); else undo();
  }, true);

  const video = BF.player.video;
  for (const name of ['seeking', 'seeked', 'playing', 'ratechange', 'emptied']) video.addEventListener(name, schedule);
  video.addEventListener('pause', schedule);
  for (const name of ['play', 'pause', 'seeked', 'emptied']) video.addEventListener(name, updatePlayButton);
  video.addEventListener('timeupdate', checkDrift);

  BF.audioPreview = {
    /** Estado da prévia: se o áudio do player passa por um GainNode e qual é o ganho agora. */
    state() {
      const g = state.graph;
      return {
        mode: state.mode,
        usesGainNode: Boolean(g),
        contextState: g ? g.ctx.state : null,
        gain: g ? g.gain.gain.value : null,
        error: state.graphError,
        videoVolume: BF.player.video.volume
      };
    },
    level,
    setMode,
    /** Os nós da Web Audio (ou null): quem precisar do áudio do player deve reutilizá-los. */
    nodes() { return state.graph ? { context: state.graph.ctx, source: state.graph.source, gain: state.graph.gain, analyser: state.graph.analyser } : null; }
  };

  // ---------- registro ----------

  BF.ui.registerTab({
    id: 'audio',
    title: 'Áudio',
    order: 50,
    render(container) {
      panel = container;
      buildUi(container);
      refresh();
      // o app esconde o painel ao trocar de aba (não há aviso de "saiu"): o som volta ao original na hora, mesmo parado
      if (typeof MutationObserver === 'function') {
        new MutationObserver(() => { if (state.graph && state.graph.visible !== isVisible()) schedule(); }).observe(container, { attributes: true, attributeFilter: ['hidden'] });
      }
    },
    onShow() {
      if (state.ready) sync(); else refresh();
    }
  });

  loadRules().then(() => {
    state.ready = true;
    sync();
  }, (err) => {
    state.rulesError = err.message;
    refresh();
  });
})();

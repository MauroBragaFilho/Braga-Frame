'use strict';

/**
 * Timeline detalhada OPCIONAL (dono: review), desenhada em #timelineSlot abaixo do player. Mostra a forma
 * de onda REAL do áudio (calculada pelo processo principal com o ffmpeg: IPC review:waveform), os cortes
 * como regiões cujas bordas se arrastam (manuais em azul, sugeridos na cor de destaque, rejeitados em cinza; as cores vêm dos tokens do tema), a
 * cabeça de reprodução e, embaixo, uma visão geral do vídeo todo para rolar. Clique para posicionar o
 * player; Ctrl + roda faz zoom, a roda sozinha rola. Arrastar uma borda muda o corte pelo mesmo caminho
 * dos botões de ajuste (BF.review.adjust: histórico, "alterado desde a revisão" e desfazer valem igual).
 * Quem liga e desliga é o botão "Timeline" da aba Cortes (BF.review.timeline.toggle()).
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;
  const slot = document.getElementById('timelineSlot');
  BF.review = BF.review || {};
  if (!slot) {
    BF.ui.toast('Elemento #timelineSlot não encontrado.', 'error');
    return;
  }

  const MAIN_H = 124;
  const LABEL_ALPHA = 0.8; // opacidade da etiqueta do corte (a cor do token sobre o fundo)
  const OVERVIEW_H = 36;
  const RULER_H = 16;
  const LANE_H = 13;
  const LANES = 3;
  const EDGE_HIT = 7; // px
  const MIN_SPAN = 1; // s
  const OVERVIEW_BUCKETS = 1600;
  const NICE_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

  const S = {
    open: false,
    status: 'idle', // idle | loading | ready | error
    error: '',
    errorCode: '',
    partial: false,
    progress: 0,
    sourcePath: null,
    overview: null, // { peaks, start, secPerBucket, duration }
    detail: null, // { peaks, start, end, secPerBucket }
    view: { start: 0, span: 60 },
    selected: null,
    drag: null, // { type: 'edge'|'scrub'|'overview', ... }
    playhead: 0,
    colors: null, // cores em CSS (rgb(...)) lidas dos tokens do tema
    rgb: null, // as mesmas cores em [r, g, b]
    seq: 0,
    detailSeq: 0
  };
  const dom = {};

  const project = () => BF.state.project;
  const minLength = () => (window.BFReview && window.BFReview.core ? window.BFReview.core.MIN_LENGTH : 0.2);
  const duration = () => (project() ? (BF.player.duration() || project().source.duration || 0) : 0);
  const round2 = (n) => Math.round(n * 100) / 100;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function clock(sec, step) {
    const t = Math.max(0, sec);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const body = step < 1 ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${body}` : `${m}:${body}`;
  }

  // ---------- geometria ----------

  const width = () => dom.main ? dom.main.clientWidth : 0;
  const xOf = (t) => ((t - S.view.start) / S.view.span) * width();
  const tOf = (x) => S.view.start + (x / width()) * S.view.span;

  function clampView() {
    const total = duration() || S.view.span;
    S.view.span = clamp(S.view.span, Math.min(MIN_SPAN, total), Math.max(total, MIN_SPAN));
    S.view.start = clamp(S.view.start, 0, Math.max(0, total - S.view.span));
  }

  function fitRange(start, end, pad = 0.3) {
    const len = Math.max(end - start, minLength());
    S.view.span = Math.max(MIN_SPAN * 2, len * (1 + pad * 2));
    S.view.start = start - len * pad;
    clampView();
  }

  function fitCut(cut) {
    fitRange(cut.start, cut.end);
    scheduleDetail();
    draw();
  }

  function zoomAt(factor, anchorTime) {
    const anchorRatio = (anchorTime - S.view.start) / S.view.span;
    S.view.span /= factor;
    clampView();
    S.view.start = anchorTime - anchorRatio * S.view.span;
    clampView();
    scheduleDetail();
    draw();
  }

  function showCut(cut) {
    // sem mexer no zoom: só rola até o corte caber (e aproxima se o zoom atual for pequeno demais)
    const len = cut.end - cut.start;
    if (len * 1.1 > S.view.span) { fitCut(cut); return; }
    if (cut.start < S.view.start || cut.end > S.view.start + S.view.span) {
      S.view.start = cut.start - (S.view.span - len) / 2;
      clampView();
      scheduleDetail();
      draw();
    }
  }

  // ---------- dados da forma de onda ----------

  /** Valor (0..255) do pico no instante t: usa o detalhe se cobrir, senão a visão geral. */
  function peakAt(t, t1 = t) {
    const src = pickSource(t, t1);
    return src ? sampleMax(src, t, t1) : 0;
  }

  function pickSource(t0, t1) {
    const need = Math.max(1e-6, (t1 - t0));
    const d = S.detail;
    if (d && t0 >= d.start && t1 <= d.end && d.secPerBucket <= Math.max(need, S.overview ? S.overview.secPerBucket : Infinity)) return d;
    return S.overview;
  }

  function sampleMax(src, t0, t1) {
    const sec = src.secPerBucket || 1;
    const a = Math.floor((t0 - src.start) / sec);
    const b = Math.max(a + 1, Math.ceil((t1 - src.start) / sec));
    let max = 0;
    for (let i = Math.max(0, a); i < b && i < src.peaks.length; i++) if (src.peaks[i] > max) max = src.peaks[i];
    return max;
  }

  async function loadOverview() {
    const p = project();
    if (!p) return;
    const seq = ++S.seq;
    S.sourcePath = p.source.path;
    S.status = 'loading';
    S.progress = 0;
    S.error = '';
    S.errorCode = '';
    S.overview = null;
    S.detail = null;
    updateBar();
    draw();
    const res = await BF.api('review:waveform', { sourcePath: p.source.path, buckets: OVERVIEW_BUCKETS, durationHint: duration() });
    if (seq !== S.seq || !S.open) return;
    if (!res.ok) {
      S.status = 'error';
      S.error = res.message;
      S.errorCode = res.code;
    } else {
      S.status = 'ready';
      S.partial = Boolean(res.partial);
      S.overview = { peaks: res.peaks, start: res.start, secPerBucket: res.secPerBucket, duration: res.duration };
      scheduleDetail();
    }
    updateBar();
    draw();
  }

  let detailTimer = null;
  function scheduleDetail() {
    clearTimeout(detailTimer);
    detailTimer = setTimeout(loadDetail, 160);
  }

  async function loadDetail() {
    if (!S.open || S.status !== 'ready' || !S.overview) return;
    const w = width();
    if (!w) return;
    const wantedSec = S.view.span / w; // segundos por pixel
    if (wantedSec >= S.overview.secPerBucket * 0.9) { S.detail = null; draw(); return; } // a visão geral já basta
    const d = S.detail;
    if (d && S.view.start >= d.start && S.view.start + S.view.span <= d.end && d.secPerBucket <= wantedSec * 1.2) return;
    const pad = S.view.span * 0.5;
    const a = Math.max(0, S.view.start - pad);
    const b = Math.min(duration() || a + S.view.span * 2, S.view.start + S.view.span + pad);
    const seq = ++S.detailSeq;
    const buckets = Math.min(8000, Math.max(50, Math.round(((b - a) / S.view.span) * w * 1.25)));
    const res = await BF.api('review:waveform', { sourcePath: S.sourcePath, buckets, start: a, end: b });
    if (seq !== S.detailSeq || !S.open || !res.ok) return;
    S.detail = { peaks: res.peaks, start: res.start, end: res.end, secPerBucket: res.secPerBucket };
    draw();
  }

  BF.on('review:waveformProgress', ({ sourcePath, p }) => {
    if (!S.open || sourcePath !== S.sourcePath || S.status !== 'loading') return;
    S.progress = p;
    updateBar();
  });

  // ---------- regiões ----------

  function visibleCuts() {
    const p = project();
    if (!p) return [];
    const end = S.view.start + S.view.span;
    return p.cuts.filter((c) => c.end >= S.view.start && c.start <= end);
  }

  /** Tempo mostrado de um corte (a borda arrastada usa o valor provisório). */
  function timesOf(cut) {
    const d = S.drag;
    if (d && d.type === 'edge' && d.cutId === cut.id) {
      return d.edge === 'start' ? { start: d.time, end: cut.end } : { start: cut.start, end: d.time };
    }
    return { start: cut.start, end: cut.end };
  }

  /** Faixas das etiquetas: cortes que se sobrepõem ficam em linhas diferentes. */
  function assignLanes(cuts) {
    const ends = [];
    const lanes = new Map();
    for (const cut of [...cuts].sort((a, b) => a.start - b.start)) {
      const t = timesOf(cut);
      let lane = ends.findIndex((e) => e <= t.start);
      if (lane < 0) lane = ends.length < LANES ? ends.length : LANES - 1;
      ends[lane] = t.end;
      lanes.set(cut.id, lane);
    }
    return lanes;
  }

  /** Cor da região (tokens do tema): manual = --status-info, sugerido = --accent-solid, rejeitado = --muted. */
  function regionColor(cut) {
    if (cut.status === 'rejected') return S.colors.rejected;
    return cut.origin === 'auto' ? S.colors.auto : S.colors.manual;
  }

  /** Branco ou preto, o que ler melhor sobre `rgb` (já misturado com o fundo). */
  function inkOn(rgb) {
    const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const lum = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
    return lum > 0.34 ? '#000' : '#fff';
  }

  const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] * t + b[i] * (1 - t)));
  const css = (rgb) => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;

  // ---------- desenho ----------

  function prepare(canvas, w, h) {
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }

  function drawWave(ctx, w, top, h, t0, span, source) {
    const mid = top + h / 2;
    const amp = h / 2 - 2;
    ctx.fillStyle = S.colors.wave;
    ctx.beginPath();
    const px = window.devicePixelRatio || 1;
    const step = 1 / px;
    for (let x = 0; x < w; x += step) {
      const a = t0 + (x / w) * span;
      const b = a + (step / w) * span;
      const v = source(a, b) / 255;
      const half = Math.max(0.5, Math.pow(v, 0.6) * amp);
      ctx.rect(x, mid - half, step, half * 2);
    }
    ctx.fill();
  }

  function drawRuler(ctx, w) {
    const stepSec = NICE_STEPS.find((s) => (s / S.view.span) * w >= 70) || NICE_STEPS[NICE_STEPS.length - 1];
    ctx.fillStyle = S.colors.rulerBg;
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = S.colors.line;
    ctx.fillStyle = S.colors.muted;
    ctx.font = '500 10px Inter, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.beginPath();
    for (let t = Math.ceil(S.view.start / stepSec) * stepSec; t <= S.view.start + S.view.span; t += stepSec) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.moveTo(x, RULER_H - 5);
      ctx.lineTo(x, RULER_H);
      ctx.fillText(clock(t, stepSec), x + 3, RULER_H / 2);
    }
    ctx.stroke();
  }

  function drawRegions(ctx, w, h) {
    const cuts = visibleCuts();
    const lanes = assignLanes(cuts);
    const wave0 = RULER_H + LANES * LANE_H + 2;
    for (const cut of cuts) {
      const t = timesOf(cut);
      const x0 = xOf(t.start);
      const x1 = xOf(t.end);
      const selected = cut.id === S.selected;
      const color = regionColor(cut);
      ctx.fillStyle = color;
      ctx.globalAlpha = selected ? 0.34 : 0.2;
      ctx.fillRect(x0, RULER_H, Math.max(1, x1 - x0), h - RULER_H);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = selected ? S.colors.ink : color;
      ctx.lineWidth = selected ? 2 : 1;
      ctx.strokeRect(Math.round(x0) + 0.5, RULER_H + 0.5, Math.max(1, Math.round(x1 - x0)), h - RULER_H - 1);
      if (cut.status === 'approved') {
        ctx.fillStyle = S.colors.ok;
        ctx.fillRect(x0, h - 3, Math.max(1, x1 - x0), 3);
      }
      // etiqueta com o título (texto claro ou escuro, conforme a cor da etiqueta sobre o fundo do tema)
      const ly = RULER_H + (lanes.get(cut.id) || 0) * LANE_H;
      ctx.fillStyle = color;
      ctx.globalAlpha = selected ? 1 : LABEL_ALPHA;
      ctx.fillRect(Math.max(0, x0), ly, Math.max(2, Math.min(x1, w) - Math.max(0, x0)), LANE_H - 1);
      ctx.globalAlpha = 1;
      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.max(0, x0), ly, Math.max(2, Math.min(x1, w) - Math.max(0, x0)), LANE_H - 1);
      ctx.clip();
      ctx.fillStyle = inkOn(selected ? labelRgb(cut) : mix(labelRgb(cut), S.rgb.bg, LABEL_ALPHA));
      ctx.font = '600 10px Inter, "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(cut.title, Math.max(0, x0) + 4, ly + LANE_H / 2);
      ctx.restore();
      if (selected) {
        ctx.fillStyle = S.colors.ink;
        for (const x of [x0, x1]) ctx.fillRect(Math.round(x) - 2, wave0, 4, h - wave0 - 6);
      }
    }
    // dica do tempo ao arrastar uma borda
    const d = S.drag;
    if (d && d.type === 'edge') {
      const text = clock(d.time, 0.1);
      const x = clamp(xOf(d.time), 20, w - 30);
      ctx.font = '600 11px Inter, "Segoe UI", sans-serif';
      const tw = ctx.measureText(text).width + 10;
      ctx.fillStyle = S.colors.ink;
      ctx.fillRect(x - tw / 2, h - 22, tw, 16);
      ctx.fillStyle = S.colors.inkOn;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x - tw / 2 + 5, h - 14);
    }
  }

  function drawMain() {
    const w = width();
    if (!w || !dom.main) return;
    const ctx = prepare(dom.main, w, MAIN_H);
    ctx.fillStyle = S.colors.bg;
    ctx.fillRect(0, 0, w, MAIN_H);
    const waveTop = RULER_H + LANES * LANE_H + 2;
    if (S.overview) {
      drawWave(ctx, w, waveTop, MAIN_H - waveTop - 2, S.view.start, S.view.span, (a, b) => peakAt(a, b));
    } else {
      ctx.strokeStyle = S.colors.line;
      ctx.beginPath();
      const y = waveTop + (MAIN_H - waveTop) / 2;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    drawRegions(ctx, w, MAIN_H);
    drawRuler(ctx, w);
    // mensagem sobre o desenho
    const message = S.status === 'loading' ? `Calculando a forma de onda… ${Math.round(S.progress * 100)}%`
      : S.status === 'error' ? S.error : '';
    if (message) {
      ctx.font = '500 12px Inter, "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillStyle = S.colors.muted;
      const lines = wrapText(ctx, message, w - 40, 3);
      lines.forEach((line, i) => ctx.fillText(line, w / 2, waveTop + (MAIN_H - waveTop) / 2 + (i - (lines.length - 1) / 2) * 15));
      ctx.textAlign = 'start';
    }
  }

  function wrapText(ctx, text, maxWidth, maxLines) {
    const words = String(text).split(' ');
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word; } else line = test;
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] += '…'; }
    return lines;
  }

  function drawOverview() {
    const canvas = dom.overview;
    const w = canvas ? canvas.clientWidth : 0;
    if (!w) return;
    const total = duration() || 1;
    const ctx = prepare(canvas, w, OVERVIEW_H);
    ctx.fillStyle = S.colors.bg;
    ctx.fillRect(0, 0, w, OVERVIEW_H);
    if (S.overview) {
      const src = S.overview;
      drawWave(ctx, w, 0, OVERVIEW_H, 0, total, (a, b) => sampleMax(src, a, b));
    }
    for (const cut of project() ? project().cuts : []) {
      ctx.fillStyle = regionColor(cut);
      ctx.globalAlpha = cut.id === S.selected ? 0.9 : 0.55;
      const x = (cut.start / total) * w;
      ctx.fillRect(x, OVERVIEW_H - 8, Math.max(2, ((cut.end - cut.start) / total) * w), 8);
    }
    ctx.globalAlpha = 1;
    const vx = (S.view.start / total) * w;
    const vw = Math.max(4, (S.view.span / total) * w);
    ctx.fillStyle = S.colors.ink;
    ctx.globalAlpha = 0.14;
    ctx.fillRect(vx, 0, vw, OVERVIEW_H);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = S.colors.ink;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx + 0.5, 0.5, vw - 1, OVERVIEW_H - 1);
    ctx.lineWidth = 1;
    ctx.fillStyle = S.colors.head;
    ctx.fillRect(Math.round((S.playhead / total) * w), 0, 1, OVERVIEW_H);
  }

  function drawHead() {
    const w = width();
    if (!w || !dom.head) return;
    const ctx = prepare(dom.head, w, MAIN_H);
    const x = xOf(S.playhead);
    if (x < -2 || x > w + 2) return;
    ctx.strokeStyle = S.colors.head;
    ctx.fillStyle = S.colors.head;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, MAIN_H);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x, 7);
    ctx.fill();
    ctx.lineWidth = 1;
  }

  let drawFrame = 0;
  function draw() {
    if (!S.open || drawFrame) return;
    drawFrame = requestAnimationFrame(() => {
      drawFrame = 0;
      if (!S.open) return;
      drawMain();
      drawOverview();
      drawHead();
    });
  }

  function drawHeadOnly() {
    if (!S.open) return;
    drawHead();
    drawOverview();
  }

  // ---------- barra da timeline ----------

  function updateBar() {
    if (!dom.info) return;
    let text = '';
    let kind = '';
    if (S.status === 'loading') { text = `Calculando a forma de onda (${Math.round(S.progress * 100)}%)…`; kind = 'busy'; }
    else if (S.status === 'error') { text = 'Sem forma de onda'; kind = 'error'; }
    else if (S.partial) { text = 'Forma de onda incompleta (o áudio tem um trecho ilegível)'; kind = 'warn'; }
    else if (S.status === 'ready') text = 'Arraste as bordas dos cortes · clique para posicionar o player';
    dom.info.textContent = text;
    dom.info.className = `tl-info ${kind}`;
    dom.retry.hidden = !(S.status === 'error' && S.errorCode !== 'NO_AUDIO' && S.errorCode !== 'NO_FFMPEG');
    dom.canvasWrap.setAttribute('aria-label', `Timeline: forma de onda e cortes. ${S.status === 'error' ? S.error : ''}`);
  }

  // ---------- interação ----------

  function localX(event, canvas) {
    return event.clientX - canvas.getBoundingClientRect().left;
  }

  /** O que há sob o ponteiro: borda de corte, etiqueta de corte ou nada (posicionar). */
  function hitTest(x, y) {
    const cuts = visibleCuts();
    const lanes = assignLanes(cuts);
    const edges = [];
    for (const cut of cuts) {
      const t = timesOf(cut);
      for (const edge of ['start', 'end']) {
        const dist = Math.abs(xOf(edge === 'start' ? t.start : t.end) - x);
        if (dist <= EDGE_HIT && y > RULER_H) edges.push({ cut, edge, dist, selected: cut.id === S.selected });
      }
    }
    if (edges.length) {
      edges.sort((a, b) => (b.selected - a.selected) || (a.dist - b.dist));
      return { type: 'edge', cut: edges[0].cut, edge: edges[0].edge };
    }
    for (const cut of [...cuts].reverse()) {
      const t = timesOf(cut);
      const ly = RULER_H + (lanes.get(cut.id) || 0) * LANE_H;
      if (y >= ly && y < ly + LANE_H && x >= xOf(t.start) && x <= xOf(t.end)) return { type: 'label', cut };
    }
    return { type: 'seek' };
  }

  function seekTo(t) {
    const total = duration();
    const target = clamp(t, 0, total || t);
    BF.player.seek(target);
    S.playhead = target;
    drawHeadOnly();
  }

  function onMainDown(event) {
    if (event.button !== 0 || !project()) return;
    const x = localX(event, dom.main);
    const y = event.clientY - dom.main.getBoundingClientRect().top;
    const hit = hitTest(x, y);
    dom.main.setPointerCapture(event.pointerId);
    if (hit.type === 'edge') {
      const cut = hit.cut;
      S.drag = { type: 'edge', cutId: cut.id, edge: hit.edge, origin: cut[hit.edge], time: cut[hit.edge], x0: x, moved: false };
      if (S.selected !== cut.id) { S.selected = cut.id; BF.bus.emit('cut:selected', { id: cut.id }); }
      draw();
    } else if (hit.type === 'label') {
      S.drag = null;
      if (BF.review.select) BF.review.select(hit.cut.id, { seek: false });
      seekTo(tOf(x));
    } else {
      S.drag = { type: 'scrub' };
      seekTo(tOf(x));
    }
  }

  function onMainMove(event) {
    const x = localX(event, dom.main);
    const y = event.clientY - dom.main.getBoundingClientRect().top;
    const d = S.drag;
    if (!d) {
      const hit = hitTest(x, y);
      dom.main.style.cursor = hit.type === 'edge' ? 'ew-resize' : hit.type === 'label' ? 'pointer' : 'crosshair';
      return;
    }
    if (d.type === 'scrub') { seekTo(tOf(x)); return; }
    if (d.type === 'edge') {
      const cut = BF.project.cut(d.cutId);
      if (!cut) return;
      const total = duration() || Infinity;
      let t = round2(tOf(x));
      t = d.edge === 'start' ? clamp(t, 0, cut.end - minLength()) : clamp(t, cut.start + minLength(), total);
      if (Math.abs(x - d.x0) > 2) d.moved = true;
      d.time = t;
      draw();
    }
  }

  function onMainUp(event) {
    const d = S.drag;
    S.drag = null;
    try { dom.main.releasePointerCapture(event.pointerId); } catch { /* já liberado */ }
    if (d && d.type === 'edge' && d.moved && d.time !== d.origin && BF.review.adjust) {
      BF.review.adjust(d.cutId, { [d.edge]: d.time });
    }
    draw();
  }

  function onMainCancel() {
    S.drag = null;
    draw();
  }

  function onWheel(event) {
    event.preventDefault();
    const x = localX(event, dom.main);
    if (event.ctrlKey || event.metaKey) {
      zoomAt(event.deltaY < 0 ? 1.25 : 0.8, tOf(x));
    } else {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      S.view.start += (delta > 0 ? 1 : -1) * S.view.span * 0.15;
      clampView();
      scheduleDetail();
      draw();
    }
  }

  function overviewMove(event) {
    const total = duration();
    const w = dom.overview.clientWidth;
    if (!total || !w) return;
    S.view.start = (localX(event, dom.overview) / w) * total - S.view.span / 2;
    clampView();
    scheduleDetail();
    draw();
  }

  function onOverviewDown(event) {
    if (event.button !== 0) return;
    dom.overview.setPointerCapture(event.pointerId);
    S.drag = { type: 'overview' };
    overviewMove(event);
  }

  function onOverviewMove(event) {
    if (S.drag && S.drag.type === 'overview') overviewMove(event);
  }

  function onOverviewUp(event) {
    if (S.drag && S.drag.type === 'overview') S.drag = null;
    try { dom.overview.releasePointerCapture(event.pointerId); } catch { /* já liberado */ }
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && S.drag && S.drag.type === 'edge') {
      event.preventDefault();
      S.drag = null;
      draw();
    }
  });

  // ---------- montagem ----------

  function button(label, title, onClick, extra = {}) {
    return el('button', { type: 'button', class: `tl-btn sm${label.length === 1 ? ' tl-zoom' : ''}`, title, 'aria-label': title, onclick: onClick, ...extra }, label);
  }

  /** Qualquer cor CSS (inclusive color-mix) vira [r, g, b]: o canvas resolve o valor. */
  let probe = null;
  function toRgb(value, fallback) {
    if (!probe) { const c = document.createElement('canvas'); c.width = 1; c.height = 1; probe = c.getContext('2d', { willReadFrequently: true }); }
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000';
    probe.fillStyle = value || fallback;
    probe.fillRect(0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  }

  /** Lê as cores dos tokens do tema (app.css) agora: o tema escuro e o claro desenham com as cores certas. */
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name) => cs.getPropertyValue(name).trim();
    const rgb = {
      bg: toRgb(v('--bg'), '#000'), card: toRgb(v('--card'), '#1c1c1c'), line: toRgb(v('--line'), '#333'), muted: toRgb(v('--muted'), '#a1a1a1'),
      text: toRgb(v('--text'), '#fff'), manual: toRgb(v('--status-info'), '#64b5f6'), auto: toRgb(v('--accent-solid'), '#eb0000'),
      rejected: toRgb(v('--muted'), '#a1a1a1'), ok: toRgb(v('--status-ok'), '#66bb6a')
    };
    S.rgb = rgb;
    S.colors = {
      bg: css(rgb.bg), line: css(rgb.line), muted: css(rgb.muted), rulerBg: css(rgb.card),
      manual: css(rgb.manual), auto: css(rgb.auto), rejected: css(rgb.rejected), ok: css(rgb.ok),
      ink: css(rgb.text), inkOn: css(rgb.bg), head: css(rgb.text),
      wave: css(mix(rgb.text, rgb.bg, 0.5))
    };
  }

  const labelRgb = (cut) => (cut.status === 'rejected' ? S.rgb.rejected : cut.origin === 'auto' ? S.rgb.auto : S.rgb.manual);

  function mount() {
    readColors();
    dom.main = el('canvas', { class: 'tl-main', height: String(MAIN_H) });
    dom.head = el('canvas', { class: 'tl-head', height: String(MAIN_H), 'aria-hidden': 'true' });
    dom.overview = el('canvas', { class: 'tl-overview', height: String(OVERVIEW_H), title: 'Visão geral do vídeo: clique ou arraste para rolar a timeline' });
    dom.canvasWrap = el('div', { class: 'tl-stage', role: 'img', 'aria-label': 'Timeline: forma de onda e cortes' }, dom.main, dom.head);
    dom.info = el('span', { class: 'tl-info' });
    dom.retry = el('button', { type: 'button', class: 'link', hidden: true, onclick: loadOverview }, 'Tentar de novo');
    dom.root = el('div', { class: 'tl' },
      el('div', { class: 'tl-bar' },
        button('−', 'Menos zoom', () => zoomAt(0.8, S.view.start + S.view.span / 2)),
        button('+', 'Mais zoom (Ctrl + roda do mouse)', () => zoomAt(1.25, S.view.start + S.view.span / 2)),
        button('Tudo', 'Mostrar o vídeo inteiro', () => { S.view.start = 0; S.view.span = duration() || 60; clampView(); scheduleDetail(); draw(); }),
        button('Corte', 'Aproximar o corte selecionado', () => { const cut = S.selected && BF.project.cut(S.selected); if (cut) fitCut(cut); else BF.ui.toast('Selecione um corte na lista para aproximar.'); }),
        el('span', { class: 'tl-legend', 'aria-hidden': 'true' },
          el('i', { class: 'dot manual' }), ' manual ', el('i', { class: 'dot auto' }), ' sugerido ', el('i', { class: 'dot rejected' }), ' rejeitado')),
      dom.canvasWrap, dom.overview,
      el('div', { class: 'tl-meta' }, dom.info, dom.retry));
    slot.replaceChildren(dom.root);

    dom.main.addEventListener('pointerdown', onMainDown);
    dom.main.addEventListener('pointermove', onMainMove);
    dom.main.addEventListener('pointerup', onMainUp);
    dom.main.addEventListener('pointercancel', onMainCancel);
    dom.main.addEventListener('wheel', onWheel, { passive: false });
    dom.overview.addEventListener('pointerdown', onOverviewDown);
    dom.overview.addEventListener('pointermove', onOverviewMove);
    dom.overview.addEventListener('pointerup', onOverviewUp);
    dom.overview.addEventListener('pointercancel', onOverviewUp);
    if (typeof ResizeObserver === 'function') {
      dom.observer = new ResizeObserver(() => { clampView(); draw(); scheduleDetail(); });
      dom.observer.observe(slot);
    }
  }

  function unmount() {
    if (dom.observer) { dom.observer.disconnect(); dom.observer = null; }
    slot.replaceChildren();
    for (const key of Object.keys(dom)) delete dom[key];
  }

  function initialView() {
    const p = project();
    if (!p) return;
    const total = duration() || 60;
    const selected = S.selected && BF.project.cut(S.selected);
    const first = selected || p.cuts[0];
    if (first) fitRange(first.start, first.end);
    else { S.view.start = 0; S.view.span = Math.min(total, 60); clampView(); }
  }

  function open() {
    if (S.open || !project()) return;
    S.open = true;
    S.selected = BF.review.activeId ? BF.review.activeId() : S.selected;
    S.playhead = BF.player.time();
    mount();
    initialView();
    updateBar();
    BF.bus.emit('review:timeline', { open: true });
    if (!S.overview || S.sourcePath !== project().source.path) loadOverview(); else { S.status = 'ready'; scheduleDetail(); }
    draw();
  }

  function close() {
    if (!S.open) return;
    S.open = false;
    if (S.status === 'loading' && S.sourcePath) BF.api('review:waveformCancel', { sourcePath: S.sourcePath });
    if (S.status === 'loading') { S.status = 'idle'; S.overview = null; S.seq += 1; }
    cancelAnimationFrame(drawFrame);
    drawFrame = 0;
    unmount();
    BF.bus.emit('review:timeline', { open: false });
  }

  function toggle() {
    if (S.open) close();
    else if (project()) open();
    else BF.ui.toast('Abra um vídeo para usar a timeline.');
  }

  // ---------- ligações com o app ----------

  BF.bus.on('player:time', ({ time }) => {
    S.playhead = time;
    if (!S.open) return;
    // durante a reprodução a janela acompanha a cabeça
    if (!BF.player.video.paused && !S.drag && (time > S.view.start + S.view.span * 0.92 || time < S.view.start)) {
      S.view.start = time - S.view.span * 0.1;
      clampView();
      scheduleDetail();
      draw();
    } else drawHeadOnly();
  });

  // a cabeça anda suave enquanto toca (timeupdate vem só ~4x por segundo)
  let headFrame = 0;
  function followPlayhead() {
    headFrame = 0;
    if (!S.open || BF.player.video.paused) return;
    S.playhead = BF.player.time();
    drawHeadOnly();
    headFrame = requestAnimationFrame(followPlayhead);
  }
  BF.player.video.addEventListener('play', () => { if (S.open && !headFrame) headFrame = requestAnimationFrame(followPlayhead); });

  BF.bus.on('cut:selected', ({ id }) => {
    S.selected = id;
    if (!S.open) return;
    const cut = BF.project.cut(id);
    if (cut && !S.drag) showCut(cut);
    draw();
  });
  BF.bus.on('cuts:changed', () => { if (S.open) draw(); });
  BF.bus.on('theme:changed', () => { readColors(); if (S.open) draw(); });
  BF.bus.on('project:loaded', () => {
    S.selected = null;
    S.overview = null;
    S.detail = null;
    S.status = 'idle';
    S.sourcePath = null;
    S.seq += 1;
    if (S.open) {
      S.playhead = 0;
      initialView();
      loadOverview();
    }
  });

  // ---------- API para a aba Cortes (e para testes) ----------

  BF.review.timeline = {
    toggle, open, close,
    isOpen: () => S.open,
    /** Estado para depuração e testes: nada aqui altera a timeline. */
    info() {
      const rect = dom.main ? dom.main.getBoundingClientRect() : null;
      return {
        open: S.open, status: S.status, error: S.error, errorCode: S.errorCode,
        view: { ...S.view }, duration: duration(), playhead: S.playhead, selected: S.selected,
        overviewBuckets: S.overview ? S.overview.peaks.length : 0,
        detailBuckets: S.detail ? S.detail.peaks.length : 0,
        canvas: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
        peakAt: (t) => peakAt(t, t + 0.05),
        /** Paleta em uso ([r, g, b] lida dos tokens do tema) e a opacidade das etiquetas: os testes conferem os pixels com ela. */
        palette: S.rgb ? { manual: S.rgb.manual, auto: S.rgb.auto, rejected: S.rgb.rejected, bg: S.rgb.bg, labelAlpha: LABEL_ALPHA } : null
      };
    },
    /** Coordenadas (tela) de uma borda de corte, para os testes arrastarem com o mouse de verdade. */
    edgePoint(cutId, edge) {
      const cut = BF.project.cut(cutId);
      if (!cut || !dom.main) return null;
      const rect = dom.main.getBoundingClientRect();
      return { x: rect.left + xOf(cut[edge]), y: rect.top + RULER_H + LANES * LANE_H + 30, secPerPx: S.view.span / width() };
    },
    timeToX: (t) => (dom.main ? dom.main.getBoundingClientRect().left + xOf(t) : null)
  };
})();

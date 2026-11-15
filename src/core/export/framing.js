'use strict';

/**
 * Enquadramento (contrato 3.2 de docs/arquitetura.md): como o vídeo da fonte vira o quadro de saída
 * do perfil (vertical, horizontal ou qualquer largura x altura).
 *
 *   Framing = { mode: 'center'|'blur'|'stack'|'custom',
 *               focusX: 0..1, focusY: 0..1, zoom: 1..3,
 *               blur: { strength },
 *               stack: { webcamRect:{x,y,w,h}, gameRect:{x,y,w,h}, webcamHeightPct, webcamPosition:'top'|'bottom' },
 *               custom: { x,y,w,h } }              // retângulos em fração (0..1) da fonte
 *
 *  - center: recorte que preenche o quadro (focusX/focusY escolhem a janela; zoom aproxima);
 *  - blur: a imagem inteira da gameplay sobre um fundo desfocado do próprio vídeo;
 *  - stack: webcam e gameplay empilhadas (retângulos da fonte; a webcam ocupa webcamHeightPct % da altura);
 *  - custom: um retângulo livre da fonte, escalado para o quadro.
 *
 * `resolveFraming(cut, profile, projectDefaults)` junta as camadas na ordem
 *   padrão do app < enquadramento do perfil < padrão do projeto < enquadramento do corte
 * e nunca modifica nenhuma delas: ajustar um corte não altera o perfil nem o padrão do projeto.
 */

(function () {
  const MODES = Object.freeze(['center', 'blur', 'stack', 'custom']);
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 3;
  const BLUR_MIN = 1;
  const BLUR_MAX = 80;
  const STACK_PCT_MIN = 10;
  const STACK_PCT_MAX = 60;
  const MIN_RECT = 0.02;

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /** Número finito (aceita texto numérico); senão undefined. */
  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function defaultFraming() {
    return {
      mode: 'center',
      focusX: 0.5,
      focusY: 0.5,
      zoom: 1,
      blur: { strength: 30 },
      stack: {
        webcamRect: { x: 0, y: 0.7, w: 0.25, h: 0.3 },
        gameRect: { x: 0, y: 0, w: 1, h: 1 },
        webcamHeightPct: 35,
        webcamPosition: 'top'
      },
      custom: { x: 0, y: 0, w: 1, h: 1 }
    };
  }

  /** Retângulo válido dentro de 0..1 (w/h mínimos; x/y puxados para caber), ou null se faltar algum campo. */
  function cleanRect(r) {
    if (!isObj(r)) return null;
    const [x, y, w, h] = [num(r.x), num(r.y), num(r.w), num(r.h)];
    if ([x, y, w, h].some((v) => v === undefined)) return null;
    const cw = clamp(w, MIN_RECT, 1);
    const ch = clamp(h, MIN_RECT, 1);
    return { x: clamp(x, 0, 1 - cw), y: clamp(y, 0, 1 - ch), w: cw, h: ch };
  }

  /** Só o que está presente e é válido (valores fora da faixa são ajustados). Nada de padrões. */
  function sanitizePartial(input) {
    const out = {};
    if (!isObj(input)) return out;
    if (MODES.includes(input.mode)) out.mode = input.mode;
    for (const [key, lo, hi] of [['focusX', 0, 1], ['focusY', 0, 1], ['zoom', ZOOM_MIN, ZOOM_MAX]]) {
      const v = num(input[key]);
      if (v !== undefined) out[key] = clamp(v, lo, hi);
    }
    if (isObj(input.blur)) {
      const s = num(input.blur.strength);
      if (s !== undefined) out.blur = { strength: clamp(s, BLUR_MIN, BLUR_MAX) };
    }
    if (isObj(input.stack)) {
      const stack = {};
      const cam = cleanRect(input.stack.webcamRect);
      const game = cleanRect(input.stack.gameRect);
      if (cam) stack.webcamRect = cam;
      if (game) stack.gameRect = game;
      const pct = num(input.stack.webcamHeightPct);
      if (pct !== undefined) stack.webcamHeightPct = clamp(pct, STACK_PCT_MIN, STACK_PCT_MAX);
      if (input.stack.webcamPosition === 'top' || input.stack.webcamPosition === 'bottom') stack.webcamPosition = input.stack.webcamPosition;
      if (Object.keys(stack).length) out.stack = stack;
    }
    const custom = cleanRect(input.custom);
    if (custom) out.custom = custom;
    return out;
  }

  /** Junta `over` sobre `base` (ambos parciais já limpos): blur/stack por campo; retângulos inteiros. */
  function mergePartial(base, over) {
    const out = { ...base, ...over };
    if (base.blur || over.blur) out.blur = { ...base.blur, ...over.blur };
    if (base.stack || over.stack) out.stack = { ...base.stack, ...over.stack };
    return out;
  }

  /** Completa um parcial com os padrões. */
  function complete(partial) {
    const d = defaultFraming();
    return {
      mode: partial.mode || d.mode,
      focusX: partial.focusX ?? d.focusX,
      focusY: partial.focusY ?? d.focusY,
      zoom: partial.zoom ?? d.zoom,
      blur: { ...d.blur, ...partial.blur },
      stack: { ...d.stack, ...partial.stack },
      custom: partial.custom || d.custom
    };
  }

  /**
   * Normaliza um enquadramento. Padrão: completo (todos os campos, dentro das faixas).
   * Com `{ partial: true }`: só os campos presentes e válidos (para guardar ajustes do corte).
   */
  function normalizeFraming(input, { partial = false } = {}) {
    const clean = sanitizePartial(input);
    return partial ? clean : complete(clean);
  }

  /** O corte tem ajuste próprio de enquadramento? */
  function isCustomized(cut) {
    return Boolean(cut && isObj(cut.framing) && Object.keys(sanitizePartial(cut.framing)).length > 0);
  }

  /**
   * Junta camadas PARCIAIS na ordem dada (a última vence), campo a campo em `blur` e `stack`, sem alterar nenhuma delas.
   * Devolve um parcial (use `normalizeFraming(parcial)` para completar). Camada ausente ou inválida é ignorada.
   */
  function mergeLayers(...layers) {
    let merged = {};
    for (const layer of layers) merged = mergePartial(merged, sanitizePartial(layer));
    return merged;
  }

  /**
   * Enquadramento efetivo (completo) de um corte: padrão do app < perfil < padrão do projeto < corte.
   * Não altera `cut`, `profile` nem `projectDefaults`.
   */
  function resolveFraming(cut, profile, projectDefaults) {
    let merged = {};
    for (const layer of [profile && profile.framing, projectDefaults, cut && cut.framing]) {
      merged = mergePartial(merged, sanitizePartial(layer));
    }
    return complete(merged);
  }

  // ---------- filtro de vídeo ----------

  /** Número sem notação científica e sem zeros inúteis (vai dentro de expressões do ffmpeg). */
  function n(v) {
    return String(Number(Number(v).toFixed(6)));
  }

  const even = (v) => Math.max(2, Math.round(v / 2) * 2);

  /** Retângulo da fonte (fração) como filtro `crop` com medidas pares e dentro do quadro. */
  function cropRect(r, inLabel, outLabel) {
    return `${inLabel}crop=w='min(iw,round(iw*${n(r.w)}/2)*2)':h='min(ih,round(ih*${n(r.h)}/2)*2)'`
      + `:x='min(iw-ow,round(iw*${n(r.x)}/2)*2)':y='min(ih-oh,round(ih*${n(r.y)}/2)*2)'${outLabel}`;
  }

  /** Preenche (cobre) um quadro W x H com o que estiver no rótulo de entrada, cortando o excesso no centro. */
  function coverBox(inLabel, W, H, outLabel) {
    return `${inLabel}scale=w=${W}:h=${H}:force_original_aspect_ratio=increase:force_divisible_by=2:flags=lanczos,crop=${W}:${H}${outLabel}`;
  }

  function centerGraph(f, W, H, inL, outL) {
    const s = `max(${W}/iw,${H}/ih)*${n(f.zoom)}`;
    return `${inL}scale=w='round(iw*${s}/2)*2':h='round(ih*${s}/2)*2':flags=lanczos,`
      + `crop=${W}:${H}:x='(iw-ow)*${n(f.focusX)}':y='(ih-oh)*${n(f.focusY)}'${outL}`;
  }

  function blurGraph(f, W, H, inL, outL) {
    // fundo: o próprio vídeo preenchendo o quadro, desfocado em 1/4 da resolução (muito mais rápido) e ampliado
    const bw = even(W / 4);
    const bh = even(H / 4);
    const sigma = Math.max(0.5, (f.blur.strength * (W / 1080)) / 4);
    const s = `min(${W}/iw,${H}/ih)*${n(f.zoom)}`;
    return [
      `${inL}split=2[blur_bg0][blur_fg0]`,
      `[blur_bg0]scale=w=${bw}:h=${bh}:force_original_aspect_ratio=increase:force_divisible_by=2,`
        + `crop=${bw}:${bh}:x='(iw-ow)*${n(f.focusX)}':y='(ih-oh)*${n(f.focusY)}',gblur=sigma=${n(sigma)}:steps=2,`
        + `scale=w=${W}:h=${H}:flags=bicubic[blur_bg]`,
      // primeiro plano: a imagem inteira cabendo no quadro (com zoom, recortada pela janela focusX/focusY)
      `[blur_fg0]scale=w='round(iw*${s}/2)*2':h='round(ih*${s}/2)*2':flags=lanczos,`
        + `crop=w='min(iw,${W})':h='min(ih,${H})':x='(iw-ow)*${n(f.focusX)}':y='(ih-oh)*${n(f.focusY)}'[blur_fg]`,
      `[blur_bg][blur_fg]overlay=x='(${W}-w)/2':y='(${H}-h)/2'${outL}`
    ].join(';');
  }

  /** Altura da faixa da webcam (par) e da gameplay no modo stack. */
  function stackHeights(f, H) {
    if (H < 4) return { cam: 0, game: H }; // não cabem duas faixas: vira o recorte central
    const cam = clamp(even((H * f.stack.webcamHeightPct) / 100), 2, H - 2);
    return { cam, game: H - cam };
  }

  function stackGraph(f, W, H, inL, outL) {
    const { cam, game } = stackHeights(f, H);
    const parts = [
      `${inL}split=2[stk_a][stk_b]`,
      `${cropRect(f.stack.gameRect, '[stk_a]', '[stk_g0]')}`,
      coverBox('[stk_g0]', W, game, '[stk_game]'),
      `${cropRect(f.stack.webcamRect, '[stk_b]', '[stk_c0]')}`,
      coverBox('[stk_c0]', W, cam, '[stk_cam]')
    ];
    const order = f.stack.webcamPosition === 'bottom' ? '[stk_game][stk_cam]' : '[stk_cam][stk_game]';
    parts.push(`${order}vstack=inputs=2${outL}`);
    return parts.join(';');
  }

  function customGraph(f, W, H, inL, outL) {
    return `${cropRect(f.custom, inL, '[cus_0]')};${coverBox('[cus_0]', W, H, outL)}`;
  }

  /**
   * Monta o grafo de filtros (para -filter_complex) que leva a entrada `[0:v]` ao quadro `[vout]`
   * do perfil: fps (se o perfil fixar) -> enquadramento -> sar 1 -> filtros extras (ex.: legenda
   * queimada, já na resolução de saída) -> yuv420p. O MESMO grafo serve à exportação e à prévia.
   *
   * @param {{framing:object, profile:{width:number,height:number,fps?:string|number}, postFilters?:string[], inLabel?:string, outLabel?:string}} opts
   */
  function buildVideoGraph({ framing, profile, postFilters = [], inLabel = '[0:v]', outLabel = '[vout]' }) {
    const f = normalizeFraming(framing);
    const W = profile.width;
    const H = profile.height;
    const parts = [];
    let source = inLabel;
    if (profile.fps && profile.fps !== 'source' && Number.isFinite(Number(profile.fps))) {
      parts.push(`${inLabel}fps=${n(profile.fps)}[bf_src]`);
      source = '[bf_src]';
    }
    const mode = f.mode === 'stack' && H < 4 ? 'center' : f.mode;
    const build = { center: centerGraph, blur: blurGraph, stack: stackGraph, custom: customGraph }[mode];
    parts.push(build(f, W, H, source, '[bf_framed]'));
    const post = postFilters.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    parts.push(`[bf_framed]${['setsar=1', ...post, 'format=yuv420p'].join(',')}${outLabel}`);
    return parts.join(';');
  }

  /**
   * Maior fator de ampliação da fonte para o quadro (>1 = o vídeo é esticado e não ganha detalhe).
   * null se as medidas da fonte não são conhecidas.
   */
  function framingUpscale({ framing, profile, sourceInfo }) {
    const sw = sourceInfo && Number(sourceInfo.width);
    const sh = sourceInfo && Number(sourceInfo.height);
    if (!(sw > 0) || !(sh > 0)) return null;
    const f = normalizeFraming(framing);
    const W = profile.width;
    const H = profile.height;
    const cover = (w, h, rect) => Math.max(w / (rect.w * sw), h / (rect.h * sh));
    switch (f.mode) {
      case 'blur': return Math.min(W / sw, H / sh) * f.zoom;
      case 'custom': return cover(W, H, f.custom);
      case 'stack': {
        const { cam, game } = stackHeights(f, H);
        if (!cam) return Math.max(W / sw, H / sh) * f.zoom;
        return Math.max(cover(W, cam, f.stack.webcamRect), cover(W, game, f.stack.gameRect));
      }
      default: return Math.max(W / sw, H / sh) * f.zoom;
    }
  }

  /**
   * Janela da fonte (frações) que aparece no quadro nos modos center e blur com zoom: útil para a
   * interface desenhar a sobreposição e para conferir o filtro em testes.
   */
  function centerWindow({ framing, profile, sourceInfo }) {
    const f = normalizeFraming(framing);
    const sw = sourceInfo.width;
    const sh = sourceInfo.height;
    const W = profile.width;
    const H = profile.height;
    const base = f.mode === 'blur' ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
    const scale = base * f.zoom;
    const w = Math.min(1, W / (sw * scale));
    const h = Math.min(1, H / (sh * scale));
    return { x: f.focusX * (1 - w), y: f.focusY * (1 - h), w, h };
  }

  const api = {
    MODES, ZOOM_MIN, ZOOM_MAX, BLUR_MIN, BLUR_MAX, STACK_PCT_MIN, STACK_PCT_MAX, MIN_RECT,
    defaultFraming, normalizeFraming, resolveFraming, mergeLayers, isCustomized, buildVideoGraph, framingUpscale, centerWindow, stackHeights
  };
  // Universal: CommonJS no processo principal e `window.BFFraming` no renderer (a aba Exportar usa as MESMAS regras da exportação)
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else globalThis.BFFraming = api;
})();

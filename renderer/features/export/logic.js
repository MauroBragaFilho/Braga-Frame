'use strict';

/**
 * Aba "Exportar" — constantes, escalas e funções puras (bitrate, agrupamento de avisos, regras de enquadramento herdadas de BFFraming/BFLayouts).
 * Tirado de features/export.js (Etapa 2, 17/11/2026) sem mudar o comportamento.
 * Carrega ANTES de export.js (renderer/index.html).
 */
(function () {
  const DEFAULT_PROFILE_ID = 'vertical-1080-h264';

  const DEFAULT_TEMPLATE = '{fonte} - corte {n} - {titulo}';

  const MODES = [['center', 'Centro'], ['blur', 'Fundo desfocado'], ['stack', 'Webcam + jogo'], ['custom', 'Livre']];

  const MODE_HINT = {
    center: 'Recorta o vídeo e preenche a tela. Arraste o retângulo para escolher a parte que aparece.',
    blur: 'Mostra a gameplay inteira sobre um fundo desfocado do próprio vídeo.',
    stack: 'Empilha a webcam e a gameplay. Arraste cada retângulo para escolher a parte do vídeo.',
    custom: 'Escolha a área do vídeo que ocupa a tela: arraste o retângulo; o canto muda o tamanho.'
  };

  const ENCODER_LABEL = { auto: 'Automático', software: 'Software (CPU)', nvenc: 'Placa NVIDIA (NVENC)' };

  const OVERRIDE_KEYS = ['width', 'height', 'codec', 'bitrateKbps', 'encoder', 'fps'];

  const MIN_RECT = 0.04;

  const FR = window.BFFraming;

  const LAY = window.BFLayouts;

  const clone = (v) => JSON.parse(JSON.stringify(v));

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /** Junta camadas parciais (a última vence) e completa com os padrões. */
  const mergeLayers = (...layers) => FR.mergeLayers(...layers);

  const complete = (partial) => FR.normalizeFraming(partial);

  /** Janela da fonte (frações) que aparece no quadro nos modos center e blur. */
  const windowOf = (f, profile, sw, sh) => FR.centerWindow({ framing: f, profile, sourceInfo: { width: sw, height: sh } });

  const stackHeights = (f, profile) => FR.stackHeights(f, profile.height);

  // chaves de preferência dos layouts (herdadas por canal > jogo > geral)
  const PREF = { conversa: 'export.layout.conversa', jogo: 'export.layout.jogo', refs: 'export.layout.refs' };

  const LAYOUT_TARGET = /^layout:(conversa|jogo)$/;

  const PREF_LABEL = { channel: 'canal', game: 'jogo' };

  const REF_B64 = /^[A-Za-z0-9+/]{3072}$/; // miniatura 64x36 em tons de cinza (2304 bytes) em base64

  const REF_MAX = 4;

  // bitrate: barra deslizante em escala logarítmica (de 0,5 a 150 Mbps), com passos "redondos"
  const BR_MIN = 500;

  const BR_MAX = 150000;

  const BR_STEPS = 1000;

  function niceKbps(raw) {
    const step = raw < 2000 ? 100 : raw < 10000 ? 500 : raw < 30000 ? 1000 : raw < 80000 ? 2500 : 5000;
    return clamp(Math.round(raw / step) * step, BR_MIN, BR_MAX);
  }

  const sliderToKbps = (v) => niceKbps(BR_MIN * (BR_MAX / BR_MIN) ** (Number(v) / BR_STEPS));

  const kbpsToSlider = (k) => Math.round((Math.log(clamp(k, BR_MIN, BR_MAX) / BR_MIN) / Math.log(BR_MAX / BR_MIN)) * BR_STEPS);

  const mbpsText = (k) => `${String(Number((k / 1000).toFixed(1))).replace('.', ',')} Mbps`;

  /** Agrupa mensagens iguais de vários cortes: [{ code, message, solution, titles }]. */
  function groupIssues(reports, kind) {
    const map = new Map();
    for (const r of reports) {
      for (const item of r[kind]) {
        const key = `${item.code}|${item.message}`;
        if (!map.has(key)) map.set(key, { code: item.code, message: item.message, solution: item.solution, titles: [] });
        map.get(key).titles.push(r.title);
      }
    }
    return [...map.values()];
  }

  window.BFExportLogic = { DEFAULT_PROFILE_ID, DEFAULT_TEMPLATE, MODES, MODE_HINT, ENCODER_LABEL, OVERRIDE_KEYS, MIN_RECT, FR, LAY, clone, clamp, isObj, mergeLayers, complete, windowOf, stackHeights, PREF, LAYOUT_TARGET, PREF_LABEL, REF_B64, REF_MAX, BR_MIN, BR_MAX, BR_STEPS, niceKbps, sliderToKbps, kbpsToSlider, mbpsText, groupIssues };
})();

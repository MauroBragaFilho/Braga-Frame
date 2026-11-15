'use strict';

/**
 * Layouts do canal: o enquadramento que o exportador aplica a um corte a partir do LAYOUT dele (Conversa | Jogo).
 *
 * Fonte única de verdade da PRECEDÊNCIA (usada pelo processo principal ao montar os Jobs e pela aba Exportar para mostrar
 * a prévia e a origem de cada corte; por isso este arquivo é "universal": CommonJS no main e `window.BFLayouts` no renderer):
 *
 *   enquadramento explícito do corte (cut.framing)
 *     > enquadramento do layout do corte (a escolha do usuário para o corte; senão a sugestão, se o interruptor está ligado)
 *       > padrão do projeto / do perfil / do app
 *
 * O resolvedor devolve também a ORIGEM do enquadramento ('personalizado', 'sugerido: Jogo', 'escolhido: Conversa' ou 'padrão'),
 * que o Job grava em `framingSource` (auditoria). Nenhuma camada é alterada por outra: ajustar um corte nunca muda o perfil nem
 * os presets, e mudar um preset nunca mexe no perfil.
 *
 * Fontes da sugestão de layout de um corte, da mais forte para a mais fraca (Interruptor ligado):
 *   1. detector local (src/core/export/layoutDetector.js), se há resultado VÁLIDO (as referências e o intervalo do corte não mudaram);
 *   2. `cut.layout` que a análise guarda (palpite de uma IA que só lê o texto: aparece como 'palpite da IA');
 *   3. nenhuma: o corte segue o padrão.
 * O usuário manda em tudo: `cut.layoutChoice` ('conversa' | 'jogo' | 'padrao') vale mesmo com o interruptor desligado.
 */
(function () {
  const F = typeof module === 'object' && module && module.exports ? require('./framing') : globalThis.BFFraming;

  const LAYOUTS = Object.freeze(['conversa', 'jogo']);
  const LABELS = Object.freeze({ conversa: 'Conversa', jogo: 'Jogo' });
  const CHOICES = Object.freeze(['conversa', 'jogo', 'padrao']);
  /** Origens de um enquadramento. */
  const KINDS = Object.freeze(['custom', 'chosen', 'suggested', 'default']);

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined));

  // ---------- presets ----------

  /**
   * Presets de fábrica. Medidos em quadros reais da live de teste (OBS 2560x1440, 16:9; veja docs/recursos/exportEngine.md):
   *  - Conversa: a câmera ocupa a tela toda, o chat fica à direita (a partir de 77% da largura) e o rosto de 53% a 68%. Uma janela
   *    9:16 com foco horizontal de 0,63 cobre de 43% a 75% da largura (rosto inteiro, sem chat e sem QR code).
   *  - Jogo: a câmera é uma caixa 16:9 no canto superior esquerdo (783x440 px: 30,6% x 30,6% da tela) e o jogo ocupa o resto.
   *    O retângulo da câmera entra 3 px para dentro da borda (a câmera inteira, sem pegar o jogo ao lado) e a faixa dela (31%
   *    da altura) tem quase a proporção da câmera; o jogo começa logo depois da câmera para ela não aparecer de novo na faixa de baixo.
   */
  function defaultPresets() {
    return {
      conversa: { framing: { mode: 'center', focusX: 0.63, focusY: 0.5, zoom: 1 }, ref: { w: 2560, h: 1440 } },
      jogo: {
        framing: {
          mode: 'stack',
          stack: {
            webcamRect: { x: 0, y: 0, w: 0.3047, h: 0.3028 },
            gameRect: { x: 0.306, y: 0, w: 0.459, h: 1 },
            webcamHeightPct: 31,
            webcamPosition: 'top'
          }
        },
        ref: { w: 2560, h: 1440 }
      }
    };
  }

  function cleanRef(ref) {
    if (!isObj(ref)) return null;
    const w = num(ref.w);
    const h = num(ref.h);
    return w > 0 && h > 0 ? { w: Math.round(w), h: Math.round(h) } : null;
  }

  /** Retângulo como veio (sem ajustar para caber), só se todos os campos são números. */
  function rawRect(r) {
    if (!isObj(r)) return null;
    const [x, y, w, h] = [num(r.x), num(r.y), num(r.w), num(r.h)];
    return [x, y, w, h].some((v) => v === undefined) ? null : { x, y, w, h };
  }

  /**
   * Preset guardado (no projeto ou nas preferências) -> { framing (parcial limpo), ref, camera (retângulo da câmera como veio) }
   * ou null se não traz nada aproveitável.
   */
  function normalizePreset(raw) {
    if (!isObj(raw)) return null;
    const framing = F.normalizeFraming(raw.framing, { partial: true });
    const ref = cleanRef(raw.ref);
    const camera = rawRect(isObj(raw.framing) && isObj(raw.framing.stack) ? raw.framing.stack.webcamRect : null);
    if (!Object.keys(framing).length && !ref) return null;
    return { framing, ref, camera };
  }

  /**
   * Presets em vigor: fábrica < herdado das preferências (canal > jogo > geral, já resolvido por quem chama) < deste projeto.
   * `inherited` e `project`: { conversa?, jogo? } com presets guardados; `scopes`: { conversa?, jogo? } com o texto de onde veio o
   * herdado ('canal X', 'jogo Y', 'geral'). Cada resultado: { framing (parcial), ref, camera, from, own }.
   */
  function composePresets({ inherited, project, scopes } = {}) {
    const app = defaultPresets();
    const out = {};
    for (const layout of LAYOUTS) {
      const base = normalizePreset(app[layout]);
      const inh = normalizePreset(inherited && inherited[layout]);
      const own = normalizePreset(project && project[layout]);
      out[layout] = {
        framing: F.mergeLayers(base.framing, inh && inh.framing, own && own.framing),
        ref: (own && own.ref) || (inh && inh.ref) || base.ref,
        camera: (own && own.camera) || (inh && inh.camera) || base.camera,
        from: own ? 'projeto' : (inh ? ((scopes && scopes[layout]) || 'canal') : 'app'),
        own: Boolean(own)
      };
    }
    return out;
  }

  /**
   * Presets em vigor recebidos de fora (a aba Exportar manda o resultado de composePresets): confere cada um e descarta o que não
   * presta, para um pedido malformado nunca quebrar a montagem dos Jobs. Layout sem preset aproveitável fica de fora.
   */
  function readPresets(raw) {
    if (!isObj(raw)) return null;
    const out = {};
    for (const layout of LAYOUTS) {
      const preset = normalizePreset(raw[layout]);
      if (!preset) continue;
      // o retângulo da câmera "como foi guardado" (antes de o enquadramento encostá-lo na borda) viaja à parte, para o QC avisar
      const camera = rawRect(raw[layout].camera) || preset.camera;
      out[layout] = { ...preset, camera, from: typeof raw[layout].from === 'string' && raw[layout].from ? raw[layout].from.slice(0, 80) : 'app', own: raw[layout].own === true };
    }
    return Object.keys(out).length ? out : null;
  }

  /** Um preset pronto para guardar (sem `from`/`own`): { framing, ref }. */
  function presetForStorage(preset) {
    return { framing: clone(preset.framing), ref: clone(preset.ref) };
  }

  // ---------- sugestão e escolha do layout de um corte ----------

  /** FNV-1a de 32 bits em texto hexadecimal (identifica o conjunto de quadros de referência; não é criptografia). */
  function fnv1a(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  /** Identificação do conjunto de referências { conversa:[texto], jogo:[texto] }: muda se qualquer quadro entrar, sair ou trocar. */
  function refsDigest(refs) {
    return fnv1a(LAYOUTS.map((layout) => (refs && Array.isArray(refs[layout]) ? refs[layout] : []).join(',')).join('|'));
  }

  /** Chave de uma detecção: vale só para estas referências e este intervalo do corte. */
  function detectorKey({ refsDigest: digest, start, end }) {
    return `${digest}:${Number(start).toFixed(2)}-${Number(end).toFixed(2)}`;
  }

  /**
   * Estado do resultado do detector local num corte: 'none' (nunca rodou), 'stale' (as referências ou o intervalo mudaram),
   * 'uncertain' (rodou e não teve certeza) ou 'valid' (decidiu).
   */
  function localState(cut, localKey) {
    const local = cut && cut.layoutLocal;
    if (!isObj(local) || typeof local.key !== 'string') return 'none';
    if (typeof localKey !== 'function' || local.key !== localKey(cut)) return 'stale';
    return LAYOUTS.includes(local.layout) ? 'valid' : 'uncertain';
  }

  /**
   * Layout SUGERIDO para o corte: { layout, via: 'detector'|'ia', confidence? } ou null.
   * Detector local (resultado válido) > palpite da IA (`cut.layout`) > nada. Com o interruptor desligado, nada é sugerido.
   */
  function suggestionOf(cut, { useSuggested = true, localKey } = {}) {
    if (!useSuggested || !isObj(cut)) return null;
    if (localState(cut, localKey) === 'valid') return { layout: cut.layoutLocal.layout, via: 'detector', confidence: num(cut.layoutLocal.confidence) };
    if (LAYOUTS.includes(cut.layout)) return { layout: cut.layout, via: 'ia' };
    return null;
  }

  /**
   * Layout em vigor no corte: a escolha do usuário (`layoutChoice`) vence a sugestão.
   * { layout|null, kind: 'chosen'|'suggested'|'default', via?, confidence?, suggestion }
   * `suggestion` é sempre a sugestão (mesmo quando a escolha do usuário a substituiu), para a tela explicar.
   */
  function layoutOfCut(cut, opts = {}) {
    const suggestion = suggestionOf(cut, opts);
    const choice = isObj(cut) ? cut.layoutChoice : null;
    if (choice === 'padrao') return { layout: null, kind: 'default', suggestion };
    if (LAYOUTS.includes(choice)) return { layout: choice, kind: 'chosen', suggestion };
    if (suggestion) return { layout: suggestion.layout, kind: 'suggested', via: suggestion.via, confidence: suggestion.confidence, suggestion };
    return { layout: null, kind: 'default', suggestion };
  }

  // ---------- resolvedor com precedência e origem ----------

  const KIND_LABEL = { custom: () => 'personalizado', default: () => 'padrão', suggested: (l) => `sugerido: ${LABELS[l]}`, chosen: (l) => `escolhido: ${LABELS[l]}` };

  /** Texto curto da origem: 'personalizado' | 'sugerido: Jogo' | 'escolhido: Conversa' | 'padrão'. */
  function originLabel(origin) {
    return origin && KIND_LABEL[origin.kind] ? KIND_LABEL[origin.kind](origin.layout) : 'padrão';
  }

  /**
   * Enquadramento efetivo (completo) de um corte e de onde ele vem.
   *
   * @param {object} p
   * @param {object} p.cut             corte (usa `framing`, `layout`, `layoutLocal`, `layoutChoice`)
   * @param {object} [p.profile]       perfil (camada `profile.framing`)
   * @param {object} [p.projectFraming] padrão do projeto (parcial ou completo)
   * @param {object} [p.presets]       presets em vigor (composePresets); sem eles nenhum layout se aplica
   * @param {boolean} [p.useSuggested] aplica a sugestão (padrão: ligado)
   * @param {Function} [p.localKey]    cut -> chave esperada do resultado do detector local
   * @returns {{ framing: object, origin: { kind, layout, via, base, label, preset, camera, confidence } }}
   */
  function resolveCutFraming({ cut, profile, projectFraming, presets, useSuggested = true, localKey } = {}) {
    const picked = layoutOfCut(cut, { useSuggested, localKey });
    const preset = picked.layout && presets && presets[picked.layout] ? presets[picked.layout] : null;
    const layout = preset ? picked.layout : null;
    const kind = preset ? picked.kind : 'default';
    const framing = F.resolveFraming(cut, profile, F.mergeLayers(projectFraming, preset && preset.framing));
    const custom = F.isCustomized(cut);
    const origin = {
      kind: custom ? 'custom' : kind,
      layout,
      via: kind === 'suggested' ? picked.via : null,
      base: custom && layout ? kind : null,
      preset: preset ? { from: preset.from || 'app', ref: clone(preset.ref) || null } : null,
      camera: preset && framing.mode === 'stack' ? clone(preset.camera) || null : null,
      confidence: kind === 'suggested' && picked.via === 'detector' && picked.confidence !== undefined ? picked.confidence : null
    };
    origin.label = originLabel(origin);
    return { framing, origin };
  }

  /** O que o Job guarda de uma origem (auditoria): sem a câmera crua, só o necessário para entender e conferir. */
  function sourceOfJob(origin) {
    return {
      kind: origin.kind, layout: origin.layout, via: origin.via, base: origin.base, label: origin.label,
      preset: clone(origin.preset), camera: clone(origin.camera), confidence: origin.confidence
    };
  }

  // ---------- conferência do retângulo da câmera ----------

  const ASPECT_TOLERANCE = 0.03; // diferença relativa de proporção entre a fonte e a referência do preset
  const MIN_CAMERA_PX = [240, 135]; // abaixo disto a câmera fica muito pequena na fonte
  const EDGE_TOLERANCE = 0.002;

  const ratioText = (w, h) => {
    const r = w / h;
    const known = [[16 / 9, '16:9'], [4 / 3, '4:3'], [21 / 9, '21:9'], [16 / 10, '16:10'], [9 / 16, '9:16'], [1, '1:1']].find(([v]) => Math.abs(r / v - 1) < 0.015);
    return known ? known[1] : r.toFixed(2).replace('.', ',');
  };
  const pct = (v) => `${Math.round(v * 1000) / 10}`.replace('.', ',');

  /**
   * Avisos (nunca bloqueios) sobre o retângulo da câmera de um layout de "webcam + jogo": ele sai da fonte, a fonte tem outra
   * proporção da usada para definir o layout, ou a fonte é pequena demais para a câmera. É conta com as medidas conhecidas:
   * NÃO procura a câmera na imagem. Só vale quando o enquadramento do corte vem de um layout e está no modo "stack".
   * @returns {{ code: 'outside'|'aspect'|'small', message: string }[]}
   */
  function cameraProblems({ framing, origin, sourceInfo } = {}) {
    if (!origin || !origin.preset || !origin.layout || !isObj(framing) || framing.mode !== 'stack') return [];
    const name = LABELS[origin.layout] || 'do layout';
    const out = [];
    const cam = origin.camera;
    if (cam) {
      const sides = [];
      if (cam.x < -EDGE_TOLERANCE) sides.push('esquerda');
      if (cam.y < -EDGE_TOLERANCE) sides.push('de cima');
      if (cam.x + cam.w > 1 + EDGE_TOLERANCE) sides.push('direita');
      if (cam.y + cam.h > 1 + EDGE_TOLERANCE) sides.push('de baixo');
      if (sides.length) {
        out.push({
          code: 'outside',
          message: `O retângulo da câmera do layout ${name} (de ${pct(cam.x)}% a ${pct(cam.x + cam.w)}% da largura e de ${pct(cam.y)}% a ${pct(cam.y + cam.h)}% da altura) passa da borda ${sides.join(' e da borda ')} do vídeo: ele será encostado na borda e pode cortar a câmera. Ajuste o retângulo em "Layouts do canal".`
        });
      }
    }
    const sw = sourceInfo && Number(sourceInfo.width);
    const sh = sourceInfo && Number(sourceInfo.height);
    if (sw > 0 && sh > 0) {
      const ref = origin.preset.ref;
      if (ref && Math.abs((sw / sh) / (ref.w / ref.h) - 1) > ASPECT_TOLERANCE) {
        out.push({
          code: 'aspect',
          message: `O layout ${name} foi definido para vídeos ${ratioText(ref.w, ref.h)} (${ref.w}×${ref.h}) e este vídeo tem ${sw}×${sh} (${ratioText(sw, sh)}): a câmera pode não estar na região escolhida. Confira a prévia em "Layouts do canal" e ajuste o retângulo da câmera se precisar.`
        });
      }
      const rect = framing.stack && framing.stack.webcamRect;
      if (rect) {
        const px = [Math.round(rect.w * sw), Math.round(rect.h * sh)];
        if (px[0] < MIN_CAMERA_PX[0] || px[1] < MIN_CAMERA_PX[1]) {
          out.push({
            code: 'small',
            message: `Neste vídeo (${sw}×${sh}) a câmera do layout ${name} ocupa só ${px[0]}×${px[1]} pixels: ela vai aparecer muito ampliada e borrada na faixa de cima.`
          });
        }
      }
    }
    return out;
  }

  const api = {
    LAYOUTS, LABELS, CHOICES, KINDS,
    defaultPresets, normalizePreset, composePresets, readPresets, presetForStorage,
    refsDigest, detectorKey, localState, suggestionOf, layoutOfCut,
    resolveCutFraming, originLabel, sourceOfJob, cameraProblems
  };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else globalThis.BFLayouts = api;
})();

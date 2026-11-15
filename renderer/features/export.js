'use strict';

/**
 * Aba "Exportar" (dono: exportEngine). Escolhe perfil e enquadramento, mostra a prévia real, confere a
 * qualidade (QC) e envia os cortes para a FILA (queue:enqueue). Exportar aqui só gera arquivos locais:
 * quem publica é o usuário, manualmente.
 *
 * Dados no projeto (project.ext.export): { profileId, overrides:{[perfil]:{...}}, framing (padrão do projeto,
 * parcial), nameTemplate, useSuggestedLayout (interruptor; ligado quando ausente), layouts:{ conversa?, jogo? } (presets
 * deste projeto: { framing parcial, ref }), layoutRefs:{ conversa:[…], jogo:[…] } (quadros de referência do detector) }.
 * O enquadramento de um corte fica em cut.framing (parcial) e o layout escolhido para ele em cut.layoutChoice; ajustar um
 * corte nunca altera o perfil, o padrão do projeto nem os presets. A precedência (corte > layout do corte > padrão) e a
 * origem mostrada em cada corte vêm de src/core/export/layouts.js, o MESMO código que monta os Jobs no processo principal.
 * Perfis (embutidos e do usuário) vêm do processo principal.
 * Detalhes e contratos: docs/recursos/exportEngine.md.
 */
(function () {
  const BF = window.BF;
  const { el, debounce, fmt, dirOf, joinPath } = BF.util;

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

  // ---------- enquadramento e layouts: as MESMAS regras do processo principal (src/core/export/framing.js e layouts.js) ----------

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

  // ---------- estado ----------

  const S = {
    profiles: [], profilesError: null, profilesWarning: null, profilesLoading: false,
    target: 'default', // 'default' (padrão do projeto), 'layout:conversa' | 'layout:jogo' (preset) ou o id do corte cujo enquadramento está sendo editado
    stackPart: 'webcam', // qual retângulo do modo stack a sobreposição edita
    draft: null, // camada própria em edição (arrasto/slider em andamento), ainda não gravada
    sel: { off: new Set(), extra: new Set() }, // cortes desmarcados / marcados à mão (padrão: os aprovados)
    frameT: null, frameFor: null,
    src: { key: '', url: '', w: 0, h: 0, error: '', seq: 0 },
    prev: { key: '', seq: 0, error: '' },
    qc: { jobs: [], reports: [], pending: false, error: '', seq: 0, ready: false },
    busy: false, message: null, // { kind:'ok'|'error', text }
    encoders: null, encodersAsked: false,
    detect: { running: false, done: 0, total: 0, message: null, seq: 0 } // detector local de layout (quadros de referência)
  };
  let ui = null; // elementos (criados em render)
  let root = null;

  const project = () => BF.state.project;
  const ext = () => (project() && project().ext && project().ext.export) || {};
  const visible = () => Boolean(root) && !root.hidden;

  function updateExt(mutator, reason) {
    BF.project.update((p) => {
      if (!isObj(p.ext)) p.ext = {};
      if (!isObj(p.ext.export)) p.ext.export = {};
      mutator(p.ext.export, p);
    }, { reason });
  }

  // ---------- layouts do canal ----------

  /** Interruptor "Usar o enquadramento sugerido pela análise" (ligado por padrão). */
  const useSuggested = () => ext().useSuggestedLayout !== false;

  const PREF_LABEL = { channel: 'canal', game: 'jogo' };

  /** Preset herdado das preferências (canal > jogo > geral) de um layout: { value, from } (sem preferência: value null). */
  function inheritedPreset(layout) {
    const value = BF.prefs.get(PREF[layout], null);
    if (!isObj(value)) return { value: null, from: '' };
    const why = BF.prefs.explain(PREF[layout]);
    const from = why && PREF_LABEL[why.scope] ? `${PREF_LABEL[why.scope]} ${why.scopeName}` : 'geral';
    return { value, from };
  }

  /** Presets em vigor: fábrica < herdado das preferências < deste projeto (sem a camada do projeto com { withProject: false }). */
  function presetsEffective({ withProject = true } = {}) {
    const inherited = {};
    const scopes = {};
    for (const layout of LAY.LAYOUTS) {
      const found = inheritedPreset(layout);
      if (found.value) { inherited[layout] = found.value; scopes[layout] = found.from; }
    }
    return LAY.composePresets({ inherited, project: withProject ? ext().layouts : null, scopes });
  }

  const REF_B64 = /^[A-Za-z0-9+/]{3072}$/; // miniatura 64x36 em tons de cinza (2304 bytes) em base64
  const REF_MAX = 4;

  /** Quadros de referência do detector: os do projeto (se tem algum) ou os herdados das preferências. Cada um é texto base64 (64x36 cinza). */
  function refsEffective() {
    const clean = (list) => (Array.isArray(list) ? list.filter((t) => typeof t === 'string' && REF_B64.test(t)).slice(0, REF_MAX) : []);
    const own = ext().layoutRefs;
    const ownRefs = { conversa: clean(own && own.conversa), jogo: clean(own && own.jogo) };
    if (ownRefs.conversa.length || ownRefs.jogo.length) return { refs: ownRefs, inherited: false };
    const inh = BF.prefs.get(PREF.refs, null);
    return { refs: { conversa: clean(inh && inh.conversa), jogo: clean(inh && inh.jogo) }, inherited: Boolean(inh) };
  }

  /** Tudo o que decide o layout de um corte neste momento (calculado uma vez por redesenho). */
  function layoutCtx() {
    const digest = LAY.refsDigest(refsEffective().refs);
    return {
      useSuggested: useSuggested(),
      presets: presetsEffective(),
      refsDigest: digest,
      localKey: (cut) => LAY.detectorKey({ refsDigest: digest, start: cut.start, end: cut.end })
    };
  }

  /** Padrão do projeto que vale para os cortes: preferência de modo < perfil < padrão do projeto (o mesmo que vai no pedido ao main). */
  function projectDefaults() {
    const base = baseProfile();
    return mergeLayers(modePref(), base && base.framing, ext().framing || {});
  }

  /** Enquadramento efetivo de um corte e a origem dele, pela precedência de layouts.js (a mesma dos Jobs). */
  function resolveCut(cut, lc = layoutCtx()) {
    return LAY.resolveCutFraming({ cut, profile: baseProfile(), projectFraming: projectDefaults(), presets: lc.presets, useSuggested: lc.useSuggested, localKey: lc.localKey });
  }

  // ---------- perfil ----------

  function chosenProfileId() {
    const p = project();
    if (!p) return DEFAULT_PROFILE_ID;
    const id = ext().profileId || BF.prefs.get('export.profileId', p.profileId || DEFAULT_PROFILE_ID);
    if (!S.profiles.length || S.profiles.some((x) => x.id === id)) return id;
    return DEFAULT_PROFILE_ID;
  }

  const baseProfile = () => S.profiles.find((x) => x.id === chosenProfileId()) || null;
  const overridesOf = (id) => (ext().overrides && ext().overrides[id]) || {};

  /** As medidas ajustadas mudaram a proporção do perfil-base (por exemplo, o 9:16 virou 16:9)? */
  const ratioChanged = (base, now) => Math.abs((now.width / now.height) / (base.width / base.height) - 1) > 0.01;

  /**
   * Perfil em uso: o escolhido com os ajustes feitos nos Detalhes (valem para este projeto). Se as medidas mudaram a proporção,
   * ele deixa de se chamar como o perfil-base (que prometia 9:16 ou 16:9) e passa a "Personalizado (largura×altura)".
   */
  function effectiveProfile() {
    const base = baseProfile();
    if (!base) return null;
    const o = overridesOf(base.id);
    if (!Object.keys(o).length) return base;
    const merged = { ...base, ...o };
    return { ...merged, name: ratioChanged(base, merged) ? `Personalizado (${merged.width}×${merged.height})` : `${base.name} (ajustado)` };
  }

  /** Remove os ajustes de um perfil (e o objeto `overrides`, se ficar vazio). */
  function dropOverrides(e, id) {
    if (!isObj(e.overrides)) return;
    delete e.overrides[id];
    if (!Object.keys(e.overrides).length) delete e.overrides;
  }

  function setOverride(key, value) {
    const base = baseProfile();
    if (!base || !OVERRIDE_KEYS.includes(key)) return;
    updateExt((e) => {
      if (!isObj(e.overrides)) e.overrides = {};
      const o = { ...(e.overrides[base.id] || {}) };
      if (value === base[key]) delete o[key]; else o[key] = value;
      if (Object.keys(o).length) e.overrides[base.id] = o; else dropOverrides(e, base.id);
    }, 'export:profile');
    onProfileChanged();
  }

  function chooseProfile(id) {
    updateExt((e) => { e.profileId = id; }, 'export:profile');
    BF.project.update((p) => { p.profileId = id; }, { reason: 'export:profile' });
    onProfileChanged();
  }

  function onProfileChanged() {
    syncProfile();
    syncFraming();
    schedulePreview();
    scheduleQc();
  }

  let profilesRequest = null; // o pedido em andamento (a tela Exportações espera por ele em BF.exportOut.ensureProfiles)
  function loadProfiles(force) {
    if (S.profilesLoading) return profilesRequest;
    if (S.profiles.length && !force) return Promise.resolve();
    S.profilesLoading = true;
    profilesRequest = (async () => {
      const res = await BF.api('export:listProfiles');
      S.profilesLoading = false;
      if (res.ok) { S.profiles = res.profiles; S.profilesError = null; S.profilesWarning = res.warning || null; } else { S.profilesError = res.message; }
      syncAll();
      schedulePreview();
      scheduleQc();
    })();
    return profilesRequest;
  }

  async function loadEncoders() {
    if (S.encodersAsked || !BF.state.tools.ffmpeg) return;
    S.encodersAsked = true;
    const res = await BF.api('export:encoders', {});
    S.encoders = res.ok && res.detection ? res.detection : null;
    syncProfile();
  }

  async function recheckEncoders() {
    if (!BF.state.tools.ffmpeg) return;
    S.encoders = null;
    syncProfile();
    const res = await BF.api('export:encoders', { force: true }, { toast: true });
    S.encoders = res.ok && res.detection ? res.detection : null;
    syncProfile();
  }

  function encoderHint(profile) {
    if (!BF.state.tools.ffmpeg) return '';
    if (!S.encoders) return 'Verificando a placa de vídeo…';
    const hw = S.encoders.nvenc[profile.codec];
    const name = profile.codec === 'h265' ? 'H.265' : 'H.264';
    if (hw && hw.available) return `Placa NVIDIA disponível para ${name}: o Automático usa a placa (mais rápido).`;
    return `Placa NVIDIA indisponível para ${name}${hw && hw.reason ? ` (${hw.reason})` : ''}: o Automático usa o processador.`;
  }

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

  // ---------- cortes ----------

  /** Cortes que podem ser exportados (sem os rejeitados), em ordem cronológica. */
  const listCuts = () => (project() ? [...project().cuts].filter((c) => c.status !== 'rejected').sort((a, b) => a.start - b.start) : []);
  const isChecked = (cut) => (S.sel.extra.has(cut.id) ? true : S.sel.off.has(cut.id) ? false : cut.status === 'approved');
  const checkedCuts = () => listCuts().filter(isChecked);
  const numberOf = (cut) => {
    const all = [...project().cuts].sort((a, b) => a.start - b.start);
    return String(all.findIndex((c) => c.id === cut.id) + 1).padStart(Math.max(2, String(all.length).length), '0');
  };
  /** O corte tem ajuste próprio de enquadramento (campos válidos em cut.framing)? */
  const customized = (cut) => FR.isCustomized(cut);
  /** Layout (conversa | jogo) cujo preset está sendo editado, ou null. */
  const targetLayout = () => { const m = LAYOUT_TARGET.exec(S.target); return m ? m[1] : null; };
  /** Tamanho da fonte em que o preset está sendo medido (o QC compara com o de outros vídeos). */
  const currentRef = () => { const { w, h } = sourceSize(); return { w, h }; };

  function setChecked(cut, on) {
    S.sel.extra.delete(cut.id);
    S.sel.off.delete(cut.id);
    if (on && cut.status !== 'approved') S.sel.extra.add(cut.id);
    if (!on && cut.status === 'approved') S.sel.off.add(cut.id);
    syncCuts();
    syncAction();
    scheduleSource();
    schedulePreview();
    scheduleQc();
  }

  // ---------- enquadramento: camadas, edição e rascunho ----------

  /** Camada própria do alvo: o padrão do projeto, o preset do layout (neste projeto) ou o enquadramento do corte. */
  function ownLayer() {
    if (S.draft) return S.draft;
    const layout = targetLayout();
    if (layout) return clone((ext().layouts && ext().layouts[layout] && ext().layouts[layout].framing) || {});
    if (S.target === 'default') return clone(ext().framing || {});
    const cut = BF.project.cut(S.target);
    return clone((cut && cut.framing) || {});
  }

  const modePref = () => ({ mode: BF.prefs.get('export.framing.mode', 'center') });

  /**
   * Enquadramento efetivo do alvo em edição (completo), pela MESMA precedência dos Jobs:
   * app < preferência < perfil < padrão do projeto < layout do corte (preset) < corte.
   */
  function effectiveFraming() {
    const base = baseProfile();
    const layout = targetLayout();
    if (layout) {
      // o que um corte com este layout recebe: a camada do preset (fábrica, preferências e este projeto) por cima do padrão do projeto
      return complete(mergeLayers(projectDefaults(), presetsEffective({ withProject: false })[layout].framing, ownLayer()));
    }
    if (S.target === 'default') return complete(mergeLayers(modePref(), base && base.framing, ownLayer()));
    const cut = BF.project.cut(S.target);
    if (!cut) return complete(projectDefaults());
    return resolveCut({ ...cut, framing: ownLayer() }).framing;
  }

  function hasOwnFraming() {
    const layout = targetLayout();
    if (layout) return Boolean(ext().layouts && ext().layouts[layout]);
    if (S.target === 'default') return Object.keys(ext().framing || {}).length > 0;
    const cut = BF.project.cut(S.target);
    return Boolean(cut && (customized(cut) || cut.layoutChoice));
  }

  /** Aplica uma mudança na camada própria do alvo. `commit` grava no projeto (fim do arrasto, slider solto). */
  function editFraming(mutator, { commit }) {
    const own = S.draft || ownLayer();
    mutator(own, effectiveFraming());
    S.draft = own;
    if (commit) commitDraft();
    else { syncOverlay(); schedulePreview(); }
  }

  function commitDraft() {
    if (!S.draft) return;
    const own = S.draft;
    S.draft = null;
    const empty = Object.keys(own).length === 0;
    const layout = targetLayout();
    if (layout) {
      const ref = currentRef();
      updateExt((e) => {
        if (!isObj(e.layouts)) e.layouts = {};
        if (empty) delete e.layouts[layout]; else e.layouts[layout] = { framing: own, ref };
        if (!Object.keys(e.layouts).length) delete e.layouts;
      }, 'export:layout');
    } else if (S.target === 'default') {
      updateExt((e) => { if (empty) delete e.framing; else e.framing = own; }, 'export:framing');
    } else {
      const cut = BF.project.cut(S.target);
      if (!cut) return;
      BF.project.update(() => { cut.framing = empty ? null : own; cut.updatedAt = new Date().toISOString(); }, { reason: 'export:framing' });
      BF.bus.emit('cuts:changed', { ids: [cut.id], from: 'export:framing' });
    }
    afterFramingChange();
  }

  /** Redesenha o que depende do enquadramento (modos, chips dos cortes, layouts) e pede nova prévia e conferência. */
  function afterFramingChange() {
    syncFraming();
    syncCuts();
    syncLayouts();
    schedulePreview();
    scheduleQc();
  }

  /**
   * "Restaurar": no padrão do projeto, limpa o ajuste; num preset, volta ao padrão do canal (ou do app); num corte, descarta o
   * enquadramento próprio e a escolha de layout, voltando ao que a análise sugere (ou ao padrão).
   */
  function restoreFraming() {
    S.draft = null;
    const layout = targetLayout();
    if (layout) {
      updateExt((e) => {
        if (isObj(e.layouts)) delete e.layouts[layout];
        if (isObj(e.layouts) && !Object.keys(e.layouts).length) delete e.layouts;
      }, 'export:layout');
    } else if (S.target === 'default') {
      updateExt((e) => { delete e.framing; }, 'export:framing');
    } else {
      const cut = BF.project.cut(S.target);
      if (cut) {
        BF.project.update(() => { cut.framing = null; delete cut.layoutChoice; cut.updatedAt = new Date().toISOString(); }, { reason: 'export:framing' });
        BF.bus.emit('cuts:changed', { ids: [cut.id], from: 'export:framing' });
      }
    }
    afterFramingChange();
  }

  function setTarget(target) {
    if (S.draft) commitDraft();
    S.target = target;
    S.frameT = null;
    syncFraming();
    syncCuts();
    syncLayouts();
    scheduleSource();
    schedulePreview();
    // o editor fica acima da lista: ao escolher um preset lá embaixo, mostra o editor
    if (targetLayout() && ui.frame && ui.frame.scrollIntoView) ui.frame.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ---------- quadro de referência e prévia ----------

  /** Corte cujo quadro mostra a prévia: o alvo; num preset, o primeiro corte com esse layout; senão o primeiro marcado. */
  function previewCut() {
    const layout = targetLayout();
    if (layout) {
      const lc = layoutCtx();
      const has = (c) => LAY.layoutOfCut(c, { useSuggested: lc.useSuggested, localKey: lc.localKey }).layout === layout;
      return checkedCuts().find(has) || listCuts().find(has) || null;
    }
    if (S.target !== 'default') {
      const cut = BF.project.cut(S.target);
      if (cut) return cut;
      S.target = 'default';
    }
    return checkedCuts()[0] || listCuts()[0] || null;
  }

  function previewRange() {
    const info = BF.state.info;
    // um preset vale para o vídeo todo: a barra percorre o vídeo (o tempo inicial vem de um corte com esse layout ou do player)
    if (targetLayout()) return { start: 0, end: info ? info.duration : 0, id: S.target, label: 'Vídeo' };
    const cut = previewCut();
    if (cut) return { start: cut.start, end: cut.end, id: cut.id, label: `Corte ${numberOf(cut)}` };
    return { start: 0, end: info ? info.duration : 0, id: null, label: 'Vídeo' };
  }

  function frameTime() {
    const r = previewRange();
    if (S.frameFor !== r.id) { S.frameFor = r.id; S.frameT = null; }
    if (S.frameT === null || S.frameT < r.start || S.frameT > r.end) {
      const layout = targetLayout();
      const sample = layout ? previewCut() : null;
      if (sample) S.frameT = (sample.start + sample.end) / 2;
      else if (r.id && !layout) S.frameT = (r.start + r.end) / 2;
      else S.frameT = clamp(BF.player.time(), 0, Math.max(0, r.end - 0.1));
    }
    return Math.max(0, S.frameT);
  }

  const sourceSize = () => {
    const p = project();
    const i = BF.state.info;
    return { w: (i && i.width) || (p && p.source.width) || 1920, h: (i && i.height) || (p && p.source.height) || 1080 };
  };

  const scheduleSource = debounce(() => loadSourceFrame(), 180);
  const schedulePreview = debounce(() => loadPreview(), 260);
  const scheduleQc = debounce(() => refreshQc(), 450);

  async function loadSourceFrame() {
    const p = project();
    if (!p || !visible()) return;
    if (!BF.state.tools.ffmpeg) return;
    const t = frameTime();
    const key = `${p.source.path}|${t.toFixed(2)}`;
    if (S.src.key === key && S.src.url) return;
    const seq = ++S.src.seq;
    const res = await BF.api('export:sourceFrame', { sourcePath: p.source.path, timeSec: t, maxWidth: 640, key: 'export-src' });
    if (seq !== S.src.seq || project() !== p) return;
    if (!res.ok) {
      if (res.code === 'SUPERSEDED') return;
      S.src = { ...S.src, key: '', error: res.message, seq };
    } else {
      S.src = { key, url: res.dataUrl, w: res.width, h: res.height, error: '', seq };
    }
    syncStage();
  }

  async function loadPreview() {
    const p = project();
    const profile = effectiveProfile();
    if (!p || !profile || !visible()) return;
    if (!BF.state.tools.ffmpeg) return;
    const t = frameTime();
    const framing = effectiveFraming();
    const key = JSON.stringify([p.source.path, t.toFixed(2), profile.width, profile.height, profile.fps, framing]);
    if (S.prev.key === key && ui.prevImg.src) return;
    const seq = ++S.prev.seq;
    ui.stage.classList.add('is-loading');
    const res = await BF.api('export:framePreview', { sourcePath: p.source.path, timeSec: t, profile, framing, maxSide: 560, key: 'export-prev' });
    if (seq !== S.prev.seq || project() !== p) return;
    ui.stage.classList.remove('is-loading');
    if (!res.ok) {
      if (res.code === 'SUPERSEDED') return;
      S.prev = { key: '', seq, error: res.message };
    } else {
      S.prev = { key, seq, error: '' };
      ui.prevImg.src = res.dataUrl;
    }
    syncStage();
  }

  // ---------- controle de qualidade e Jobs ----------

  function prepareRequest(cutIds) {
    const p = project();
    const lc = layoutCtx();
    return {
      project: { id: p.id, source: p.source, cuts: p.cuts },
      info: BF.state.info,
      cutIds,
      profile: effectiveProfile(),
      framing: projectDefaults(),
      layouts: { useSuggested: lc.useSuggested, presets: lc.presets, refsDigest: lc.refsDigest },
      outputDir: outputDir(),
      nameTemplate: ext().nameTemplate || DEFAULT_TEMPLATE
    };
  }

  const defaultDir = () => joinPath(dirOf(project().source.path), 'Cortes');
  const outputDir = () => project().exportDir || defaultDir();

  async function refreshQc() {
    const p = project();
    if (!p || !visible()) return;
    const cuts = checkedCuts();
    const profile = effectiveProfile();
    if (!profile || !cuts.length || !BF.state.tools.ffmpeg) {
      S.qc = { ...S.qc, jobs: [], reports: [], pending: false, error: '', ready: true, seq: S.qc.seq + 1 };
      syncQc();
      syncAction();
      return;
    }
    const seq = ++S.qc.seq;
    S.qc.pending = true;
    S.message = null;
    syncMessage();
    syncAction();
    const res = await BF.api('export:prepare', prepareRequest(cuts.map((c) => c.id)));
    if (seq !== S.qc.seq || project() !== p) return;
    S.qc = { jobs: res.ok ? res.jobs : [], reports: res.ok ? res.reports : [], pending: false, error: res.ok ? '' : res.message, seq, ready: true };
    syncQc();
    syncAction();
  }

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

  // ---------- enviar para a fila ----------

  async function enqueue() {
    if (S.busy) return;
    const p = project();
    const cuts = checkedCuts();
    if (!p || !cuts.length) return;
    S.busy = true;
    S.message = null;
    syncAction();
    try {
      if (S.draft) commitDraft();
      await BF.project.flush();
      const prep = await BF.api('export:prepare', prepareRequest(cuts.map((c) => c.id)));
      if (!prep.ok) { S.message = { kind: 'error', text: prep.message }; return; }
      const bad = new Set(prep.reports.filter((r) => r.errors.length).map((r) => r.jobId));
      const jobs = prep.jobs.filter((j) => !bad.has(j.id));
      if (!jobs.length) {
        S.message = { kind: 'error', text: 'Nenhum corte pode ser exportado: veja os erros acima, corrija e tente de novo.' };
        return;
      }
      const res = await BF.api('queue:enqueue', { jobs });
      if (!res.ok) {
        const missing = res.code === 'IPC_ERROR';
        S.message = {
          kind: 'error',
          text: missing
            ? 'A fila de exportação não está disponível nesta versão do app, então nada foi enviado. Atualize ou reinstale o Braga Frame.'
            : `A fila não aceitou os cortes: ${res.message} Nada foi enviado.`
        };
        return;
      }
      const views = Array.isArray(res.jobs) ? res.jobs : [];
      const skipped = views.filter((j) => j.state === 'skipped').length;
      const sent = jobs.length - skipped;
      const parts = [`${sent} corte(s) na fila`];
      if (skipped) parts.push(`${skipped} já estava(m) na fila ou exportado(s)`);
      if (bad.size) parts.push(`${bad.size} com erro ficou(aram) de fora`);
      BF.ui.toast(`${parts.join('; ')}.`, 'ok');
      S.message = { kind: 'ok', text: `${parts.join('; ')}.` };
      BF.ui.selectTab('queue');
    } finally {
      S.busy = false;
      syncAction();
      syncMessage();
    }
  }

  // ---------- saída do projeto aberto (também mostrada e alterada na barra da tela Exportações) ----------

  /** Escolhe a pasta de destino do projeto aberto. Resolve true se a pasta mudou. */
  async function pickOutputDir() {
    if (!project()) return false;
    const res = await BF.api('export:pickDir', {}, { toast: true });
    if (!res.ok || res.canceled) return false;
    BF.project.update((p) => { p.exportDir = res.path; }, { reason: 'export:dir' });
    syncDest();
    scheduleQc();
    return true;
  }

  /**
   * O que a barra de saída da tela Exportações mostra do PROJETO ABERTO (null sem projeto): o perfil escolhido, os perfis
   * disponíveis (o escolhido leva o nome com "(ajustado)" quando há ajustes nos Detalhes) e a pasta de destino.
   * `profiles` fica vazia até a lista chegar do processo principal (veja ensureProfiles).
   */
  function outputSummary() {
    if (!project()) return null;
    const chosen = chosenProfileId();
    const effective = effectiveProfile();
    return {
      profileId: chosen,
      profiles: S.profiles.map((x) => ({ id: x.id, name: effective && x.id === chosen ? effective.name : x.name })),
      dir: outputDir()
    };
  }

  // ---------- Detalhes: perfis do usuário ----------

  async function saveProfileAs() {
    const profile = effectiveProfile();
    if (!profile) return;
    const base = baseProfile();
    const suggestion = base && !base.builtin ? base.name : '';
    const name = await BF.ui.prompt({ title: 'Salvar como meu perfil', label: 'Nome do perfil', value: suggestion, okLabel: 'Salvar' });
    if (!name) return;
    const existing = S.profiles.find((x) => !x.builtin && x.name.toLowerCase() === name.toLowerCase());
    if (existing && !(await BF.ui.confirm({ title: 'Substituir perfil?', message: `Já existe o perfil "${existing.name}". Substituir pelos valores atuais?`, okLabel: 'Substituir' }))) return;
    const payload = { name, width: profile.width, height: profile.height, codec: profile.codec, bitrateKbps: profile.bitrateKbps, encoder: profile.encoder, fps: profile.fps };
    if (existing) payload.id = existing.id;
    if (Object.keys(ext().framing || {}).length) payload.framing = ext().framing;
    const res = await BF.api('export:saveProfile', { profile: payload }, { toast: true });
    if (!res.ok) return;
    S.profiles = res.profiles;
    S.profilesWarning = null;
    if (base) updateExt((e) => dropOverrides(e, base.id), 'export:profile');
    chooseProfile(res.profile.id);
    BF.ui.toast(`Perfil "${name}" salvo. Ele aparece em todos os projetos.`, 'ok');
  }

  async function deleteProfile() {
    const base = baseProfile();
    if (!base || base.builtin) return;
    const ok = await BF.ui.confirm({ title: 'Excluir perfil', message: `Excluir o perfil "${base.name}"? Os arquivos já exportados não mudam.`, okLabel: 'Excluir', danger: true });
    if (!ok) return;
    const res = await BF.api('export:deleteProfile', { id: base.id }, { toast: true });
    if (!res.ok) return;
    S.profiles = res.profiles;
    S.profilesWarning = null;
    chooseProfile(DEFAULT_PROFILE_ID);
  }

  function resetOverrides() {
    const base = baseProfile();
    if (!base) return;
    updateExt((e) => dropOverrides(e, base.id), 'export:profile');
    onProfileChanged();
  }

  // ---------- sincronização da interface ----------

  /** Campo com rótulo em cima. `label` pode ser [texto, <strong>valor</strong>]: o valor fica à direita, alinhado (barras deslizantes). */
  const field = (label, control, cls) => el('label', { class: `exp-field${cls ? ` ${cls}` : ''}` },
    Array.isArray(label)
      ? el('span', { class: 'exp-label exp-label-row' }, el('span', {}, String(label[0]).trim()), label[1])
      : el('span', { class: 'exp-label' }, label),
    control);
  const icon = (name) => el('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true' }, name);

  function syncAll() {
    if (!ui) return;
    const has = Boolean(project());
    ui.empty.hidden = has;
    ui.main.hidden = !has;
    if (!has) return;
    syncProfile();
    syncFraming();
    syncCuts();
    syncLayouts();
    syncDest();
    syncQc();
    syncAction();
    syncMessage();
  }

  function syncProfile() {
    if (!ui || !project()) return;
    ui.profileError.hidden = !S.profilesError;
    ui.profileError.textContent = S.profilesError ? `Não foi possível carregar os perfis: ${S.profilesError}` : '';
    ui.profileWarn.hidden = !S.profilesWarning;
    ui.profileWarn.textContent = S.profilesWarning || '';
    const chosen = chosenProfileId();
    const groups = [['Vertical 9:16', (p) => p.builtin && p.kind === 'vertical'], ['Horizontal 16:9', (p) => p.builtin && p.kind === 'horizontal'], ['Meus perfis', (p) => !p.builtin]];
    const wanted = JSON.stringify(S.profiles.map((p) => [p.id, p.name]));
    if (ui.profile.dataset.sig !== wanted) {
      ui.profile.replaceChildren(...groups.map(([label, test]) => {
        const items = S.profiles.filter(test);
        return items.length ? el('optgroup', { label }, items.map((p) => el('option', { value: p.id }, p.name))) : null;
      }));
      ui.profile.dataset.sig = wanted;
    }
    ui.profile.disabled = !S.profiles.length;
    if (S.profiles.length) ui.profile.value = chosen;

    const profile = effectiveProfile();
    if (!profile) { ui.summary.textContent = 'Detalhes'; return; }
    const o = overridesOf(profile.id || chosen);
    const adjusted = Object.keys(o).length > 0;
    ui.summary.textContent = `Detalhes · ${profile.width}×${profile.height} · ${profile.codec === 'h265' ? 'H.265' : 'H.264'} · ${mbpsText(profile.bitrateKbps)}${adjusted ? ' · ajustado' : ''}`;
    const base = baseProfile();
    if (document.activeElement !== ui.width) ui.width.value = String(profile.width);
    if (document.activeElement !== ui.height) ui.height.value = String(profile.height);
    ui.codec.value = profile.codec;
    ui.bitrate.value = String(kbpsToSlider(profile.bitrateKbps));
    ui.bitrateLabel.textContent = mbpsText(profile.bitrateKbps);
    ui.encoder.value = profile.encoder || 'auto';
    const fpsValue = profile.fps === 'source' || !profile.fps ? 'source' : String(profile.fps);
    if (![...ui.fps.options].some((opt) => opt.value === fpsValue)) ui.fps.append(el('option', { value: fpsValue }, `${fpsValue} quadros/s`));
    ui.fps.value = fpsValue;
    ui.encoderHint.textContent = encoderHint(profile);
    ui.encoderRecheck.hidden = !BF.state.tools.ffmpeg;
    ui.reset.hidden = !adjusted;
    ui.del.hidden = !(base && !base.builtin);
    const hints = [];
    if (base && adjusted && ratioChanged(base, profile)) hints.push(`As medidas ajustadas (${profile.width}×${profile.height}) mudaram a proporção deste perfil; em Detalhes, "Voltar aos valores do perfil" desfaz.`);
    if (base && base.framing) hints.push('Este perfil traz um enquadramento inicial, usado quando o projeto não define o seu.');
    ui.profileHint.textContent = hints.join(' ');
    ui.saveHint.textContent = Object.keys(ext().framing || {}).length ? 'O perfil guarda também o enquadramento padrão deste projeto.' : '';
  }

  function syncFraming() {
    if (!ui || !project()) return;
    const f = effectiveFraming();
    for (const btn of ui.modeButtons) btn.setAttribute('aria-pressed', String(btn.dataset.mode === f.mode));
    ui.hint.textContent = MODE_HINT[f.mode];
    const layout = targetLayout();
    const cut = !layout && S.target !== 'default' ? BF.project.cut(S.target) : null;
    const lc = layoutCtx();
    ui.restore.hidden = !hasOwnFraming();
    ui.restore.textContent = restoreLabel(layout, cut, lc);
    ui.targetLabel.textContent = layout ? `Layout ${LAY.LABELS[layout]} · vale para os cortes com esse layout`
      : cut ? `Só o corte ${numberOf(cut)} · ${cut.title}`
        : 'Padrão do projeto (vale para todos os cortes sem ajuste próprio)';
    ui.playerFrame.hidden = !layout;
    ui.cutLayout.hidden = !cut;
    if (cut) syncCutLayout(cut, lc);
    ui.ctlCenter.hidden = f.mode !== 'center';
    ui.ctlBlur.hidden = f.mode !== 'blur';
    ui.ctlStack.hidden = f.mode !== 'stack';
    ui.zoom.value = String(f.zoom);
    ui.zoomLabel.textContent = `${f.zoom.toFixed(2).replace('.', ',')}×`;
    ui.zoomB.value = String(f.zoom);
    ui.zoomBLabel.textContent = `${f.zoom.toFixed(2).replace('.', ',')}×`;
    ui.focusX.value = String(Math.round(f.focusX * 100));
    ui.focusXB.value = String(Math.round(f.focusX * 100));
    ui.focusY.value = String(Math.round(f.focusY * 100));
    ui.blur.value = String(f.blur.strength);
    ui.pct.value = String(f.stack.webcamHeightPct);
    ui.pctLabel.textContent = `${Math.round(f.stack.webcamHeightPct)}%`;
    for (const btn of ui.posButtons) btn.setAttribute('aria-pressed', String(btn.dataset.pos === f.stack.webcamPosition));
    for (const btn of ui.partButtons) btn.setAttribute('aria-pressed', String(btn.dataset.part === S.stackPart));
    // posição vertical só faz diferença quando há folga vertical (zoom ou fonte mais estreita)
    const profile = effectiveProfile();
    const size = sourceSize();
    const win = profile ? windowOf(f, profile, size.w, size.h) : { w: 1, h: 1 };
    ui.focusYField.hidden = win.h > 0.995;
    ui.focusXField.hidden = win.w > 0.995;
    ui.focusXBField.hidden = win.w > 0.995;
    syncStage();
  }

  function syncStage() {
    if (!ui) return;
    const profile = effectiveProfile();
    const range = previewRange();
    if (profile) {
      ui.prevBox.style.aspectRatio = `${profile.width} / ${profile.height}`;
      ui.stage.dataset.orient = profile.height > profile.width ? 'vertical' : profile.height < profile.width ? 'horizontal' : 'square';
    }
    const size = sourceSize();
    ui.srcBox.style.aspectRatio = `${size.w} / ${size.h}`;
    if (S.src.url && ui.srcImg.getAttribute('src') !== S.src.url) ui.srcImg.src = S.src.url;
    ui.srcImg.hidden = !S.src.url;
    ui.prevImg.hidden = !ui.prevImg.getAttribute('src');
    ui.stageNote.textContent = S.src.error || S.prev.error || (!BF.state.tools.ffmpeg ? 'Sem o FFmpeg não há prévia.' : '');
    ui.stageNote.hidden = !ui.stageNote.textContent;
    ui.timeRow.hidden = !(range.end > range.start);
    if (range.end > range.start) {
      const t = frameTime();
      ui.time.min = String(range.start);
      ui.time.max = String(range.end);
      ui.time.value = String(t);
      ui.timeLabel.textContent = `${range.label} · ${fmt(t)}`;
    }
    syncOverlay();
  }

  /** Retângulos arrastáveis sobre o quadro da fonte (frações da fonte). */
  function overlayRects() {
    const profile = effectiveProfile();
    if (!profile) return [];
    const f = effectiveFraming();
    const size = sourceSize();
    if (f.mode === 'center' || f.mode === 'blur') {
      const w = windowOf(f, profile, size.w, size.h);
      if (w.w > 0.995 && w.h > 0.995) return [];
      return [{ id: 'window', rect: w, kind: 'window', label: 'Parte do vídeo que aparece' }];
    }
    if (f.mode === 'custom') return [{ id: 'custom', rect: f.custom, kind: 'rect', label: 'Área do vídeo' }];
    const { cam, game } = stackHeights(f, profile);
    return [
      { id: 'webcam', rect: f.stack.webcamRect, kind: 'rect', label: 'Webcam', aspect: profile.width / Math.max(2, cam), active: S.stackPart === 'webcam' },
      { id: 'game', rect: f.stack.gameRect, kind: 'rect', label: 'Gameplay', aspect: profile.width / Math.max(2, game), active: S.stackPart === 'game' }
    ];
  }

  /**
   * Atualiza a sobreposição. Se os retângulos são os mesmos, só mexe nas caixas (um arrasto em andamento não
   * pode perder o elemento); senão refaz, devolvendo o foco do teclado ao mesmo retângulo.
   */
  function syncOverlay() {
    if (!ui) return;
    const items = overlayRects();
    const signature = JSON.stringify(items.map((i) => [i.id, i.active, i.aspect]));
    if (ui.overlay.dataset.sig === signature && ui.overlay.children.length === items.length) {
      items.forEach((item, index) => {
        const node = ui.overlay.children[index];
        node.rectItem.rect = item.rect;
        setBox(node, item.rect);
      });
      return;
    }
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.rect : null;
    ui.overlay.replaceChildren(...items.map((item) => overlayNode(item)));
    ui.overlay.dataset.sig = signature;
    if (focused) {
      const again = ui.overlay.querySelector(`[data-rect="${focused}"]`);
      if (again) again.focus();
    }
  }

  function setBox(node, r) {
    node.style.left = `${r.x * 100}%`;
    node.style.top = `${r.y * 100}%`;
    node.style.width = `${r.w * 100}%`;
    node.style.height = `${r.h * 100}%`;
  }

  function overlayNode(item) {
    const profile = effectiveProfile();
    const size = sourceSize();
    const aspectFor = item.aspect || (profile ? profile.width / profile.height : 1);
    const node = el('div', {
      class: `exp-rect ${item.id}${item.active === false ? ' dim' : ''}`, tabindex: '0', role: 'group', 'aria-label': `${item.label}: arraste ou use as setas`,
      dataset: { rect: item.id }
    }, el('span', { class: 'exp-rect-tag' }, item.label));
    setBox(node, item.rect);
    node.rectItem = item;
    const handle = item.kind === 'rect' ? el('span', { class: 'exp-handle', 'aria-hidden': 'true', dataset: { handle: item.id } }) : null;
    if (handle) node.append(handle);

    const apply = (r, commit) => {
      if (item.id === 'window') {
        const f = effectiveFraming();
        const w = windowOf(f, profile, size.w, size.h);
        editFraming((own) => {
          if (w.w < 1) own.focusX = clamp(r.x / (1 - w.w), 0, 1);
          if (w.h < 1) own.focusY = clamp(r.y / (1 - w.h), 0, 1);
        }, { commit });
      } else if (item.id === 'custom') {
        editFraming((own) => { own.custom = { x: r.x, y: r.y, w: r.w, h: r.h }; }, { commit });
      } else {
        const key = item.id === 'webcam' ? 'webcamRect' : 'gameRect';
        editFraming((own) => { own.stack = { ...(own.stack || {}), [key]: { x: r.x, y: r.y, w: r.w, h: r.h } }; }, { commit });
      }
    };

    node.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (item.id === 'webcam' || item.id === 'game') { S.stackPart = item.id; for (const b of ui.partButtons) b.setAttribute('aria-pressed', String(b.dataset.part === S.stackPart)); }
      event.preventDefault();
      const resizing = event.target === handle;
      const box = ui.srcBox.getBoundingClientRect();
      const start = { ...item.rect };
      const x0 = event.clientX;
      const y0 = event.clientY;
      node.setPointerCapture(event.pointerId);
      const move = (e) => {
        const dx = (e.clientX - x0) / box.width;
        const dy = (e.clientY - y0) / box.height;
        let r;
        if (resizing) r = fitRect(start.x, start.y, start.w + dx, aspectFor, size);
        else r = { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
        setBox(node, r);
        item.rect = r;
        apply(r, false);
      };
      const up = () => {
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
        node.removeEventListener('pointercancel', up);
        apply(item.rect, true);
      };
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', up);
      node.addEventListener('pointercancel', up);
    });

    node.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 0.05 : 0.01;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      if (!delta) return;
      event.preventDefault();
      const r = { ...item.rect, x: clamp(item.rect.x + delta[0], 0, 1 - item.rect.w), y: clamp(item.rect.y + delta[1], 0, 1 - item.rect.h) };
      item.rect = r;
      apply(r, true);
    });
    return node;
  }

  /** Retângulo com a proporção do quadro de saída (em pixels da fonte), com largura w, cabendo na fonte. */
  function fitRect(x, y, w, aspect, size) {
    const hOf = (width) => (width * size.w) / (size.h * aspect);
    let width = clamp(w, MIN_RECT, 1 - x);
    let height = hOf(width);
    if (y + height > 1) { height = 1 - y; width = (height * size.h * aspect) / size.w; }
    if (height < MIN_RECT) { height = MIN_RECT; width = (height * size.h * aspect) / size.w; }
    return { x, y, w: Math.min(width, 1 - x), h: Math.min(height, 1 - y) };
  }

  /** Refaz a lista de cortes sem tirar o foco do teclado do controle em que o usuário estava. */
  function syncCuts() {
    if (!ui || !project()) return;
    const active = document.activeElement;
    const row = active && active.closest ? active.closest('#exp-cuts li') : null;
    const memo = row ? { id: row.dataset.id || 'default', tag: active.tagName } : null;
    renderCuts();
    if (memo) {
      const again = ui.cutsList.querySelector(memo.id === 'default' ? 'li.exp-cut-default' : `li[data-id="${memo.id}"]`);
      const control = again && again.querySelector(memo.tag === 'INPUT' ? 'input' : 'button');
      if (control) control.focus();
    }
  }

  /** Texto do link "Restaurar" conforme o alvo: padrão do projeto, preset de layout ou corte. */
  function restoreLabel(layout, cut, lc) {
    if (layout) {
      const from = presetsEffective({ withProject: false })[layout].from;
      return `Voltar ao padrão ${from === 'app' ? 'do app' : from === 'geral' ? 'geral' : from.startsWith('jogo') ? 'do jogo' : 'do canal'}`;
    }
    if (cut && LAY.suggestionOf(cut, { useSuggested: lc.useSuggested, localKey: lc.localKey })) return 'Restaurar para o sugerido';
    return 'Restaurar padrão';
  }

  /** De onde vem o layout sugerido, em poucas palavras (linha de apoio do corte). */
  function provenance(cut, origin, lc) {
    if (origin.via === 'ia') return ' · palpite da IA';
    if (origin.via === 'detector') return ' · detectado pela imagem';
    if (origin.kind !== 'chosen' && lc.useSuggested && LAY.localState(cut, lc.localKey) === 'uncertain') return ' · layout incerto';
    return '';
  }

  /** Explicação da origem do enquadramento do corte (dica do chip e nota do painel). */
  function originNote(cut, lc) {
    const { origin } = resolveCut(cut, lc);
    const name = (l) => LAY.LABELS[l];
    const suggestion = LAY.suggestionOf(cut, { useSuggested: true, localKey: lc.localKey }); // ignora o interruptor: serve para explicar
    const state = LAY.localState(cut, lc.localKey);
    const via = (v, conf) => (v === 'detector'
      ? `detectado pela imagem${Number.isFinite(conf) ? ` (${Math.round(conf * 100)}% de confiança)` : ''}`
      : 'palpite da IA: ela só lê o texto, não vê a imagem');
    const parts = [];
    if (origin.kind === 'custom') {
      parts.push('Enquadramento personalizado só deste corte.');
      if (origin.layout) parts.push(`Parte do layout ${name(origin.layout)} (${origin.base === 'chosen' ? 'escolhido por você' : via(origin.via, origin.confidence)}).`);
    } else if (origin.kind === 'suggested') {
      parts.push(`Layout ${name(origin.layout)} sugerido: ${via(origin.via, origin.confidence)}.`);
    } else if (origin.kind === 'chosen') {
      parts.push(`Layout ${name(origin.layout)} escolhido por você.`);
      if (suggestion && suggestion.layout !== origin.layout) parts.push(`A análise sugeria ${name(suggestion.layout)}.`);
    } else if (cut.layoutChoice === 'padrao') {
      parts.push(`Você escolheu o padrão para este corte.${suggestion ? ` A análise sugeria ${name(suggestion.layout)}.` : ''}`);
    } else if (!lc.useSuggested && suggestion) {
      parts.push(`A análise sugeriu ${name(suggestion.layout)}, mas "Usar o enquadramento sugerido pela análise" está desligado: vale o padrão do projeto.`);
    } else {
      parts.push('Sem layout sugerido: vale o padrão do projeto.');
    }
    if (lc.useSuggested && state === 'uncertain') parts.push('O detector não teve certeza do layout deste corte (a imagem não se parece com os quadros de referência).');
    if (state === 'stale') parts.push('A detecção pela imagem ficou desatualizada (mudaram as referências ou o trecho do corte): detecte de novo.');
    return parts.join(' ');
  }

  /** Chip com a origem do enquadramento: 'sugerido: Jogo', 'escolhido: Conversa', 'personalizado' ou 'padrão'. */
  function originChip(cut, origin, lc) {
    const variant = { custom: 'bds-chip-accent exp-badge', suggested: 'bds-chip-info', chosen: 'bds-chip-ok', default: '' }[origin.kind];
    return el('span', { class: `bds-chip exp-origin${variant ? ` ${variant}` : ''}`, dataset: { origin: origin.kind, layout: origin.layout || '' }, title: originNote(cut, lc) }, origin.label);
  }

  /** Seletor do layout do corte (Conversa | Jogo | Padrão) e a nota de onde vem o enquadramento. */
  function syncCutLayout(cut, lc) {
    const picked = LAY.layoutOfCut(cut, { useSuggested: lc.useSuggested, localKey: lc.localKey });
    const current = picked.layout || 'padrao';
    for (const btn of ui.cutLayoutButtons) btn.setAttribute('aria-pressed', String(btn.dataset.layout === current));
    ui.originNote.textContent = originNote(cut, lc);
  }

  /**
   * Define o layout de cortes. `choice`: 'conversa' | 'jogo' | 'padrao'. Escolher o que já valeria sem escolha (a sugestão, ou
   * o padrão quando nada é sugerido) só tira a escolha anterior: o corte volta a seguir a sugestão. Não mexe no enquadramento
   * próprio do corte (ele continua valendo por cima do layout).
   */
  function setCutLayout(ids, choice) {
    const lc = layoutCtx();
    let changed = 0;
    BF.project.update(() => {
      for (const id of ids) {
        const cut = BF.project.cut(id);
        if (!cut) continue;
        const without = LAY.layoutOfCut({ ...cut, layoutChoice: null }, { useSuggested: lc.useSuggested, localKey: lc.localKey }).layout || 'padrao';
        const before = cut.layoutChoice || null;
        const next = choice === without ? null : choice;
        if (next === before) continue;
        if (next) cut.layoutChoice = next; else delete cut.layoutChoice;
        cut.updatedAt = new Date().toISOString();
        changed += 1;
      }
    }, { reason: 'export:layout' });
    if (changed) BF.bus.emit('cuts:changed', { ids, from: 'export:framing' });
    afterFramingChange();
    return changed;
  }

  /** "Voltar ao sugerido" em lote: descarta a escolha de layout e o enquadramento próprio dos cortes (com confirmação se houver ajustes). */
  async function restoreCutsToSuggested(ids) {
    const withOwn = ids.map((id) => BF.project.cut(id)).filter((c) => c && (customized(c) || c.layoutChoice));
    if (!withOwn.length) return 0;
    const lost = withOwn.filter(customized).length;
    if (lost && !(await BF.ui.confirm({
      title: 'Voltar ao sugerido?',
      message: `${lost} ${lost === 1 ? 'corte tem' : 'cortes têm'} enquadramento personalizado, que será descartado. A escolha de layout também volta ao que a análise sugere.`,
      okLabel: 'Voltar ao sugerido', danger: true
    }))) return null; // cancelou: nada muda e nada é dito
    BF.project.update(() => {
      for (const c of withOwn) { const cut = BF.project.cut(c.id); if (cut) { cut.framing = null; delete cut.layoutChoice; cut.updatedAt = new Date().toISOString(); } }
    }, { reason: 'export:layout' });
    BF.bus.emit('cuts:changed', { ids: withOwn.map((c) => c.id), from: 'export:framing' });
    afterFramingChange();
    return withOwn.length;
  }

  async function bulkLayout(value) {
    const ids = checkedCuts().map((c) => c.id);
    ui.bulk.value = '';
    if (!ids.length) return;
    if (value === 'sugerido') {
      const n = await restoreCutsToSuggested(ids);
      if (n === null) return;
      BF.ui.toast(n ? `${n} ${n === 1 ? 'corte voltou' : 'cortes voltaram'} ao sugerido.` : 'Os cortes selecionados já seguem o sugerido.', 'ok');
      return;
    }
    const n = setCutLayout(ids, value);
    const label = value === 'padrao' ? 'o padrão' : `o layout ${LAY.LABELS[value]}`;
    BF.ui.toast(n ? `${n} ${n === 1 ? 'corte agora usa' : 'cortes agora usam'} ${label}.` : `Os cortes selecionados já usam ${label}.`, 'ok');
  }

  function renderCuts() {
    const cuts = listCuts();
    const lc = layoutCtx();
    const checked = cuts.filter(isChecked).length;
    ui.cutsHead.textContent = cuts.length ? `Cortes a exportar · ${checked} de ${cuts.length}` : 'Cortes a exportar';
    ui.cutsEmpty.hidden = cuts.length > 0;
    ui.cutsList.hidden = cuts.length === 0;
    const rows = [el('li', { class: `exp-cut exp-cut-default${S.target === 'default' ? ' on' : ''}` },
      el('button', { type: 'button', class: 'exp-cut-main', dataset: { target: 'default' }, 'aria-pressed': String(S.target === 'default'), onclick: () => setTarget('default') },
        el('span', { class: 'exp-cut-title' }, 'Padrão do projeto'),
        el('span', { class: 'exp-cut-sub' }, 'enquadramento de todos os cortes')))];
    for (const cut of cuts) {
      const on = isChecked(cut);
      const { origin } = resolveCut(cut, lc);
      rows.push(el('li', { class: `exp-cut${S.target === cut.id ? ' on' : ''}${on ? '' : ' off'}`, dataset: { id: cut.id } },
        el('input', { type: 'checkbox', checked: on, 'aria-label': `Exportar o corte ${numberOf(cut)}`, onchange: (e) => setChecked(cut, e.target.checked) }),
        el('button', { type: 'button', class: 'exp-cut-main', 'aria-pressed': String(S.target === cut.id), title: 'Ajustar o enquadramento e o layout só deste corte', onclick: () => setTarget(cut.id) },
          el('span', { class: 'exp-cut-title' }, `${numberOf(cut)} · ${cut.title}`),
          el('span', { class: 'exp-cut-sub' }, `${fmt(cut.end - cut.start)}${cut.status === 'approved' ? '' : ' · pendente'}${provenance(cut, origin, lc)}`)),
        originChip(cut, origin, lc)));
    }
    ui.cutsList.replaceChildren(...rows);
    ui.bulkRow.hidden = cuts.length === 0;
    ui.bulk.disabled = checked === 0;
    ui.bulk.title = checked === 0 ? 'Marque os cortes que quer ajustar' : '';
  }

  function syncDest() {
    if (!ui || !project()) return;
    ui.dir.textContent = outputDir();
    ui.dir.title = outputDir();
    if (document.activeElement !== ui.template) ui.template.value = ext().nameTemplate || DEFAULT_TEMPLATE;
    const first = S.qc.jobs[0];
    ui.example.textContent = first ? `Exemplo: ${first.baseName}.mp4` : '';
  }

  function syncQc() {
    if (!ui || !project()) return;
    const errors = groupIssues(S.qc.reports, 'errors');
    const warnings = groupIssues(S.qc.reports, 'warnings');
    const total = S.qc.reports.length;
    const who = (titles) => (total > 1 ? el('span', { class: 'exp-issue-who' }, titles.length === total ? ' (todos os cortes)' : ` (${titles.length} de ${total}: ${titles.slice(0, 3).join(', ')}${titles.length > 3 ? '…' : ''})`) : null);
    ui.qcErrors.replaceChildren(...errors.map((e) => el('li', { class: 'exp-issue error', dataset: { code: e.code } },
      el('strong', {}, 'Não vai exportar: '), e.message, who(e.titles),
      e.solution ? el('span', { class: 'exp-issue-fix' }, ` Como resolver: ${e.solution}`) : null)));
    ui.qcWarnList.replaceChildren(...warnings.map((w) => el('li', { class: 'exp-issue warn', dataset: { code: w.code } }, w.message, who(w.titles))));
    ui.qcWarn.hidden = warnings.length === 0;
    ui.qcWarnSummary.textContent = `${warnings.length} aviso${warnings.length === 1 ? '' : 's'} (não impedem a exportação)`;
    ui.qcError.hidden = !S.qc.error;
    ui.qcError.textContent = S.qc.error ? `Não foi possível conferir os cortes: ${S.qc.error}` : '';
    let status = '';
    if (!checkedCuts().length) status = '';
    else if (S.qc.pending && !S.qc.ready) status = 'Conferindo…';
    else if (S.qc.ready && total) {
      const bad = S.qc.reports.filter((r) => r.errors.length).length;
      if (bad) status = `${bad} de ${total} corte(s) com erro não serão exportados.`;
      else status = warnings.length ? 'Tudo pronto para exportar.' : 'Tudo pronto: nenhum problema encontrado.';
    }
    ui.qcStatus.textContent = status;
    const bad = S.qc.reports.some((r) => r.errors.length);
    ui.qcStatus.classList.toggle('bad', bad);
    ui.qcStatus.classList.toggle('ok', !bad && S.qc.ready && !S.qc.pending && total > 0);
    ui.qcStatus.classList.toggle('busy', S.qc.pending && !S.qc.ready);
    ui.qcStatus.hidden = !status;
    syncDest();
  }

  function syncAction() {
    if (!ui || !project()) return;
    const ready = S.qc.ready && !S.qc.pending;
    const okCount = ready ? S.qc.reports.filter((r) => !r.errors.length).length : checkedCuts().length;
    let reason = '';
    if (!effectiveProfile()) reason = S.profilesError ? 'Os perfis de exportação não carregaram: reinicie o app.' : 'Carregando os perfis…';
    else if (!BF.state.tools.ffmpeg) reason = 'FFmpeg não encontrado: instale-o e use "Verificar de novo" no aviso do topo (ou veja a aba Ferramentas).';
    else if (!checkedCuts().length) reason = listCuts().length ? 'Marque pelo menos um corte para exportar.' : 'Aprove cortes na aba Cortes para exportar.';
    else if (S.qc.error) reason = 'A conferência falhou: veja a mensagem acima.';
    else if (ready && okCount === 0) reason = 'Todos os cortes marcados têm erro: corrija os problemas acima.';
    ui.enqueue.textContent = okCount > 0 ? `Adicionar à fila (${okCount})` : 'Adicionar à fila';
    ui.enqueue.disabled = S.busy || Boolean(reason);
    ui.enqueueWhy.textContent = reason;
    ui.enqueueWhy.hidden = !reason;
  }

  function syncMessage() {
    if (!ui) return;
    ui.msg.hidden = !S.message;
    ui.msg.className = `exp-msg${S.message ? ` ${S.message.kind}` : ''}`;
    ui.msg.textContent = S.message ? S.message.text : '';
  }

  // ---------- layouts do canal: interruptor, presets, padrão do canal e detecção pela imagem ----------

  const LAYOUT_SUB = { conversa: 'Câmera em tela cheia (com o chat): recorte vertical no rosto', jogo: 'Webcam em cima e o jogo embaixo' };

  /** De onde vem um preset, em texto curto ('app', 'projeto', 'geral', 'canal X', 'jogo Y'). */
  function fromText(from) {
    if (from === 'app') return 'padrão do app';
    if (from === 'projeto') return 'deste projeto';
    if (from === 'geral') return 'padrão geral';
    return `padrão do ${from}`;
  }

  /** JSON com as chaves em ordem (compara valores sem depender da ordem em que foram montados). */
  const canon = (v) => JSON.stringify(v, (k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

  /** Frase sob o interruptor: quantos cortes têm layout sugerido e por quem. */
  function suggestNote(lc) {
    const cuts = listCuts();
    let byAi = 0;
    let byImage = 0;
    for (const c of cuts) {
      const s = LAY.suggestionOf(c, { useSuggested: true, localKey: lc.localKey });
      if (s) { if (s.via === 'detector') byImage += 1; else byAi += 1; }
    }
    if (!byAi && !byImage) {
      return 'Nenhum corte tem layout sugerido ainda. A análise por IA indica Conversa ou Jogo em cada corte; "Detectar o layout pela imagem" (em Layouts do canal) faz o mesmo olhando o vídeo.';
    }
    const who = [byAi ? `${byAi} pela IA` : '', byImage ? `${byImage} pela imagem` : ''].filter(Boolean).join(', ');
    return `${byAi + byImage} de ${cuts.length} cortes têm layout sugerido (${who}). ${byAi ? 'O palpite da IA vem só do texto: ela não vê a imagem. ' : ''}Você pode trocar o layout de cada corte.`;
  }

  /** Onde salvar o padrão: canal, jogo ou geral (canal e jogo vêm do projeto aberto). */
  function layoutScopes() {
    const names = BF.prefs.scope();
    return [
      ['channel', names.channel ? `Canal: ${names.channel}` : 'Canal (defina em Preferências)', Boolean(names.channel)],
      ['game', names.game ? `Jogo: ${names.game}` : 'Jogo (defina em Preferências)', Boolean(names.game)],
      ['general', 'Geral (todos os vídeos)', true]
    ];
  }

  function syncLayouts() {
    if (!ui || !project()) return;
    const lc = layoutCtx();
    ui.suggest.checked = lc.useSuggested;
    ui.suggestNote.textContent = suggestNote(lc);
    const cuts = listCuts();
    for (const row of ui.layoutRows) {
      const on = S.target === `layout:${row.layout}`;
      const using = cuts.filter((c) => LAY.layoutOfCut(c, { useSuggested: lc.useSuggested, localKey: lc.localKey }).layout === row.layout).length;
      row.li.classList.toggle('on', on);
      row.main.setAttribute('aria-pressed', String(on));
      row.sub.textContent = `${LAYOUT_SUB[row.layout]} · ${fromText(lc.presets[row.layout].from)}`;
      row.count.textContent = using ? `${using} ${using === 1 ? 'corte' : 'cortes'}` : '';
      row.count.hidden = !using;
    }
    const scopes = layoutScopes();
    const signature = JSON.stringify(scopes);
    if (ui.layoutScope.dataset.sig !== signature) {
      const keep = ui.layoutScope.value;
      ui.layoutScope.replaceChildren(...scopes.map(([value, label, ok]) => el('option', { value, disabled: !ok }, label)));
      ui.layoutScope.dataset.sig = signature;
      // a escolha do usuário vale enquanto existir; sem escolha, o mais específico disponível (canal, depois jogo, depois geral)
      const chosen = ui.layoutScope.dataset.touched ? scopes.find(([value, , ok]) => ok && value === keep) : null;
      ui.layoutScope.value = (chosen || scopes.find(([, , ok]) => ok))[0];
    }
    const profile = effectiveProfile();
    ui.layoutsNote.hidden = !(profile && profile.height <= profile.width);
    syncRefs();
    syncDetect(lc);
  }

  /** "Salvar como padrão": grava os presets (e os quadros de referência) nas preferências do escopo; novos projetos do mesmo canal herdam. */
  async function saveLayoutsAsDefault() {
    const scope = ui.layoutScope.value;
    if (!scope || ui.layoutSave.disabled) return;
    ui.layoutSave.disabled = true;
    try {
      const before = presetsEffective();
      for (const layout of LAY.LAYOUTS) {
        const res = await BF.prefs.set(PREF[layout], LAY.presetForStorage(before[layout]), scope);
        if (!res.ok) { BF.ui.toast(res.message || 'Não foi possível salvar o padrão dos layouts.', 'error'); return; }
      }
      const refs = refsEffective();
      if (!refs.inherited && (refs.refs.conversa.length || refs.refs.jogo.length)) {
        const res = await BF.prefs.set(PREF.refs, refs.refs, scope);
        if (!res.ok) { BF.ui.toast(res.message || 'Não foi possível salvar os quadros de referência.', 'error'); return; }
      }
      // se o padrão herdado agora é o que o projeto já tinha, o projeto passa a herdá-lo (sem ajuste próprio)
      const inherited = presetsEffective({ withProject: false });
      updateExt((e) => {
        if (!isObj(e.layouts)) return;
        for (const layout of LAY.LAYOUTS) {
          if (canon(inherited[layout].framing) === canon(before[layout].framing) && canon(inherited[layout].ref) === canon(before[layout].ref)) delete e.layouts[layout];
        }
        if (!Object.keys(e.layouts).length) delete e.layouts;
      }, 'export:layout');
      const where = layoutScopes().find(([value]) => value === scope);
      BF.ui.toast(`Layouts salvos como padrão (${where ? where[1] : scope}). Novos projetos começam com eles.`, 'ok');
      afterFramingChange();
    } finally {
      ui.layoutSave.disabled = false;
    }
  }

  // ----- quadros de referência e detecção -----

  /** Miniatura 64x36 (texto base64 de tons de cinza) desenhada num canvas. */
  function refThumb(b64, label, onRemove) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const canvas = el('canvas', { width: '64', height: '36', class: 'exp-ref-canvas', role: 'img', 'aria-label': label });
    const g = canvas.getContext('2d');
    const image = g.createImageData(64, 36);
    for (let i = 0; i < 2304; i++) {
      image.data[i * 4] = bytes[i];
      image.data[i * 4 + 1] = bytes[i];
      image.data[i * 4 + 2] = bytes[i];
      image.data[i * 4 + 3] = 255;
    }
    g.putImageData(image, 0, 0);
    return el('span', { class: 'exp-ref' }, canvas,
      el('button', { type: 'button', class: 'icon-btn exp-ref-del', title: 'Remover este quadro', 'aria-label': `Remover este quadro de ${label}`, onclick: onRemove }, icon('close')));
  }

  function syncRefs() {
    const { refs, inherited } = refsEffective();
    for (const group of ui.refGroups) {
      const list = refs[group.layout];
      const signature = list.join('|');
      if (group.thumbs.dataset.sig !== signature) {
        group.thumbs.replaceChildren(...list.map((b64, index) => refThumb(b64, `referência ${index + 1} de ${LAY.LABELS[group.layout]}`, () => removeRef(group.layout, index))));
        group.thumbs.dataset.sig = signature;
      }
      const missing = Math.max(0, 2 - list.length);
      group.count.textContent = `${list.length} de ${REF_MAX} quadros${missing ? ` · falta${missing > 1 ? 'm' : ''} ${missing} para detectar` : ''}${inherited && list.length ? ' · do padrão salvo' : ''}`;
      group.add.disabled = list.length >= REF_MAX || !BF.state.tools.ffmpeg;
    }
  }

  /** Grava os quadros de referência no projeto (as detecções antigas deixam de valer sozinhas: a chave delas inclui as referências). */
  function saveRefs(refs) {
    updateExt((e) => { e.layoutRefs = { conversa: refs.conversa, jogo: refs.jogo }; }, 'export:refs');
    afterFramingChange();
  }

  async function addRef(layout) {
    const p = project();
    if (!p || !BF.state.tools.ffmpeg) return;
    const res = await BF.api('export:layoutRef', { sourcePath: p.source.path, timeSec: BF.player.time() }, { toast: true });
    if (!res.ok || project() !== p) return;
    const refs = refsEffective().refs;
    if (refs[layout].length >= REF_MAX) { BF.ui.toast(`Já são ${REF_MAX} quadros de ${LAY.LABELS[layout]}: remova um antes.`, 'error'); return; }
    if (Object.values(refs).some((list) => list.includes(res.thumb))) { BF.ui.toast('Este quadro já é uma referência. Mova o player para outro momento.', 'error'); return; }
    saveRefs({ ...refs, [layout]: [...refs[layout], res.thumb] });
  }

  function removeRef(layout, index) {
    const refs = refsEffective().refs;
    saveRefs({ ...refs, [layout]: refs[layout].filter((_, i) => i !== index) });
  }

  function syncDetect(lc = layoutCtx()) {
    const d = S.detect;
    const { refs } = refsEffective();
    const ready = refs.conversa.length >= 2 && refs.jogo.length >= 2;
    const cuts = listCuts();
    ui.detectRun.disabled = d.running || !ready || !cuts.length || !BF.state.tools.ffmpeg;
    ui.detectRun.textContent = d.running ? `Detectando… ${d.done} de ${d.total}` : 'Detectar o layout dos cortes';
    ui.detectCancel.hidden = !d.running;
    let text = '';
    let kind = '';
    if (d.message) { text = d.message.text; kind = d.message.kind; }
    else if (!ready) text = 'Escolha pelo menos 2 quadros de cada layout.';
    else if (!cuts.length) text = 'Sem cortes para detectar.';
    else {
      const states = { valid: 0, uncertain: 0, stale: 0, none: 0 };
      for (const c of cuts) states[LAY.localState(c, lc.localKey)] += 1;
      const parts = [];
      if (states.valid) parts.push(`${states.valid} detectado${states.valid === 1 ? '' : 's'}`);
      if (states.uncertain) parts.push(`${states.uncertain} incerto${states.uncertain === 1 ? '' : 's'}`);
      if (states.stale) parts.push(`${states.stale} desatualizado${states.stale === 1 ? '' : 's'}`);
      text = parts.length ? `${parts.join(' · ')} de ${cuts.length} cortes. Incerto e sem detecção valem o palpite da IA, ou o padrão.` : `Ainda não detectado em nenhum dos ${cuts.length} cortes.`;
    }
    ui.detectStatus.textContent = text;
    ui.detectStatus.className = `small ${kind === 'error' ? 'exp-msg error' : 'muted'}`;
  }

  async function runDetect() {
    const p = project();
    if (!p || S.detect.running) return;
    const cuts = listCuts();
    const { refs } = refsEffective();
    if (!cuts.length || refs.conversa.length < 2 || refs.jogo.length < 2) return;
    if (S.draft) commitDraft();
    const seq = S.detect.seq + 1;
    S.detect = { running: true, done: 0, total: cuts.length, message: null, seq };
    syncDetect();
    const res = await BF.api('export:detectLayouts', { sourcePath: p.source.path, cuts: cuts.map((c) => ({ id: c.id, start: c.start, end: c.end })), refs });
    if (seq !== S.detect.seq || project() !== p) return;
    S.detect = { running: false, done: 0, total: 0, message: null, seq };
    if (!res.ok) {
      S.detect.message = { kind: res.code === 'CANCELLED' ? 'info' : 'error', text: res.code === 'CANCELLED' ? 'Detecção cancelada. Nada foi alterado.' : res.message };
      syncDetect();
      return;
    }
    BF.project.update(() => {
      for (const r of res.results) {
        const cut = BF.project.cut(r.cutId);
        if (cut) cut.layoutLocal = { layout: r.layout, confidence: r.confidence, reason: r.reason, key: r.key, at: r.at, samples: r.samples };
      }
    }, { reason: 'export:detect' });
    BF.bus.emit('cuts:changed', { ids: res.results.map((r) => r.cutId), from: 'export:framing' });
    const found = res.results.filter((r) => r.layout).length;
    BF.ui.toast(`Layout detectado em ${found} de ${res.results.length} cortes${found < res.results.length ? '; os outros ficaram incertos' : ''}.`, 'ok');
    afterFramingChange();
  }

  function cancelDetect() {
    if (!S.detect.running) return;
    S.detect.seq += 1;
    S.detect = { running: false, done: 0, total: 0, message: { kind: 'info', text: 'Detecção cancelada. Nada foi alterado.' }, seq: S.detect.seq };
    BF.api('export:detectCancel', {});
    syncDetect();
  }

  /** Mostra na prévia o quadro em que o player está agora (útil para conferir um preset num momento de Conversa ou de Jogo). */
  function usePlayerFrame() {
    const r = previewRange();
    S.frameT = clamp(BF.player.time(), r.start, Math.max(r.start, r.end - 0.1));
    syncStage();
    scheduleSource();
    schedulePreview();
  }

  // ---------- montagem da interface ----------

  function build() {
    const u = {};
    u.empty = el('div', { class: 'empty-state center exp-empty' },
      el('span', { class: 'empty-state-icon material-symbols-rounded', 'aria-hidden': 'true' }, 'ios_share'),
      el('div', { class: 'empty-state-text' },
        el('strong', {}, 'Nada para exportar ainda'),
        el('p', {}, 'Abra um vídeo e aprove cortes para escolher o formato e enviar para a fila.')));

    // perfil
    u.profile = el('select', { id: 'exp-profile', 'aria-label': 'Perfil de exportação' });
    u.profileError = el('p', { class: 'exp-msg error', hidden: true });
    u.profileWarn = el('p', { class: 'exp-msg warn', id: 'exp-profile-warn', hidden: true });
    u.profileHint = el('p', { class: 'muted small', id: 'exp-profile-hint' });
    u.summary = el('summary', {}, 'Detalhes');
    u.width = el('input', { id: 'exp-width', type: 'number', min: '2', max: '7680', step: '2', inputmode: 'numeric' });
    u.height = el('input', { id: 'exp-height', type: 'number', min: '2', max: '7680', step: '2', inputmode: 'numeric' });
    u.sizeError = el('p', { class: 'exp-msg error', hidden: true });
    u.codec = el('select', { id: 'exp-codec' }, el('option', { value: 'h264' }, 'H.264 (mais compatível)'), el('option', { value: 'h265' }, 'H.265 (arquivo menor)'));
    u.bitrate = el('input', { id: 'exp-bitrate', type: 'range', min: '0', max: String(BR_STEPS), step: '1', 'aria-label': 'Bitrate' });
    u.bitrateLabel = el('strong', { id: 'exp-bitrate-label' }, '10 Mbps');
    u.encoder = el('select', { id: 'exp-encoder' }, Object.entries(ENCODER_LABEL).map(([value, label]) => el('option', { value }, label)));
    u.encoderHint = el('p', { class: 'muted small', id: 'exp-encoder-hint' });
    u.encoderRecheck = el('button', { type: 'button', id: 'exp-encoder-recheck', class: 'link', onclick: recheckEncoders }, 'Testar a placa de novo');
    u.fps = el('select', { id: 'exp-fps' }, el('option', { value: 'source' }, 'Igual ao vídeo'), el('option', { value: '30' }, '30 quadros/s'), el('option', { value: '60' }, '60 quadros/s'));
    u.reset = el('button', { type: 'button', id: 'exp-reset-profile', class: 'link', hidden: true }, 'Voltar aos valores do perfil');
    u.save = el('button', { type: 'button', id: 'exp-save-profile', class: 'sm' }, 'Salvar como meu perfil…');
    u.del = el('button', { type: 'button', id: 'exp-delete-profile', class: 'link danger-text', hidden: true }, 'Excluir este perfil');
    u.saveHint = el('p', { class: 'muted small' });

    // enquadramento
    u.modeButtons = MODES.map(([mode, label]) => el('button', { type: 'button', class: 'bds-tab', dataset: { mode }, 'aria-pressed': 'false', onclick: () => setMode(mode) }, label));
    u.hint = el('p', { class: 'muted small exp-hint' });
    u.targetLabel = el('p', { class: 'exp-target' });
    u.restore = el('button', { type: 'button', id: 'exp-restore', class: 'link', hidden: true }, 'Restaurar padrão');
    u.suggest = el('input', { id: 'exp-suggest', type: 'checkbox', role: 'switch', class: 'bds-switch', 'aria-labelledby': 'exp-suggest-label', checked: true });
    u.suggestNote = el('p', { class: 'muted small', id: 'exp-suggest-note' });
    u.suggestRow = el('div', { class: 'exp-suggest' },
      el('div', { class: 'exp-suggest-text' }, el('span', { class: 'exp-suggest-label', id: 'exp-suggest-label' }, 'Usar o enquadramento sugerido pela análise'), u.suggestNote),
      el('label', { class: 'exp-switch' }, u.suggest));
    u.cutLayoutButtons = [['conversa', 'Conversa'], ['jogo', 'Jogo'], ['padrao', 'Padrão']].map(([layout, label]) => el('button', {
      type: 'button', class: 'bds-tab', dataset: { layout }, 'aria-pressed': 'false',
      onclick: () => { const cut = BF.project.cut(S.target); if (cut) setCutLayout([cut.id], layout); }
    }, label));
    u.originNote = el('p', { class: 'muted small', id: 'exp-origin-note' });
    u.cutLayout = el('div', { class: 'exp-cut-layout', id: 'exp-cut-layout', hidden: true },
      el('span', { class: 'exp-cap' }, 'Layout deste corte'),
      el('div', { class: 'bds-tabs exp-seg', role: 'group', 'aria-label': 'Layout deste corte' }, u.cutLayoutButtons),
      u.originNote);
    u.playerFrame = el('button', { type: 'button', id: 'exp-use-player', class: 'link', hidden: true, title: 'Mostra o quadro em que o player está agora' }, 'Usar o quadro do player');
    u.srcImg = el('img', { id: 'exp-src-img', alt: 'Quadro do vídeo de origem', draggable: 'false', hidden: true });
    u.overlay = el('div', { class: 'exp-overlay' });
    u.srcBox = el('div', { class: 'exp-box exp-src' }, u.srcImg, u.overlay);
    u.prevImg = el('img', { id: 'exp-prev-img', alt: 'Prévia do enquadramento final', draggable: 'false', hidden: true });
    u.prevBox = el('div', { class: 'exp-box exp-prev' }, u.prevImg);
    u.stage = el('div', { class: 'exp-stage' }, el('div', { class: 'exp-col' }, el('span', { class: 'exp-cap' }, 'Vídeo de origem'), u.srcBox), el('div', { class: 'exp-col' }, el('span', { class: 'exp-cap' }, 'Como vai ficar'), u.prevBox));
    u.stageNote = el('p', { class: 'exp-msg error', hidden: true });
    u.time = el('input', { id: 'exp-time', type: 'range', min: '0', max: '1', step: '0.1', 'aria-label': 'Quadro da prévia' });
    u.timeLabel = el('span', { class: 'muted small' });
    u.timeRow = el('div', { class: 'exp-time' }, u.time, u.timeLabel, u.playerFrame);

    u.zoom = el('input', { id: 'exp-zoom', type: 'range', min: '1', max: '3', step: '0.05', 'aria-label': 'Zoom' });
    u.zoomLabel = el('strong', {});
    u.focusX = el('input', { id: 'exp-focusx', type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'Posição horizontal' });
    u.focusY = el('input', { id: 'exp-focusy', type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'Posição vertical' });
    u.focusXField = field('Posição horizontal', u.focusX);
    u.focusYField = field('Posição vertical', u.focusY);
    u.ctlCenter = el('div', { class: 'exp-ctl' }, field(['Zoom ', u.zoomLabel], u.zoom), u.focusXField, u.focusYField);

    u.blur = el('input', { id: 'exp-blur', type: 'range', min: '1', max: '80', step: '1', 'aria-label': 'Intensidade do desfoque' });
    u.zoomB = el('input', { id: 'exp-zoom-blur', type: 'range', min: '1', max: '3', step: '0.05', 'aria-label': 'Zoom da gameplay' });
    u.zoomBLabel = el('strong', {});
    u.focusXB = el('input', { id: 'exp-focusx-blur', type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'Posição horizontal' });
    u.focusXBField = field('Posição horizontal', u.focusXB);
    u.ctlBlur = el('div', { class: 'exp-ctl' }, field('Intensidade do desfoque', u.blur), field(['Zoom na gameplay ', u.zoomBLabel], u.zoomB), u.focusXBField);

    u.pct = el('input', { id: 'exp-pct', type: 'range', min: '10', max: '60', step: '1', 'aria-label': 'Altura da webcam' });
    u.pctLabel = el('strong', {});
    u.posButtons = [['top', 'Webcam em cima'], ['bottom', 'Webcam embaixo']].map(([pos, label]) => el('button', { type: 'button', class: 'bds-tab', dataset: { pos }, 'aria-pressed': 'false', onclick: () => editFraming((own) => { own.stack = { ...(own.stack || {}), webcamPosition: pos }; }, { commit: true }) }, label));
    u.partButtons = [['webcam', 'Ajustar webcam'], ['game', 'Ajustar gameplay']].map(([part, label]) => el('button', { type: 'button', class: 'bds-tab', dataset: { part }, 'aria-pressed': 'false', onclick: () => { S.stackPart = part; syncFraming(); } }, label));
    u.ctlStack = el('div', { class: 'exp-ctl' }, el('div', { class: 'bds-tabs exp-seg' }, u.partButtons), el('div', { class: 'bds-tabs exp-seg' }, u.posButtons), field(['Altura da webcam ', u.pctLabel], u.pct));

    // cortes
    u.cutsHead = el('h3', { class: 'exp-h' }, 'Cortes a exportar');
    u.cutsEmpty = el('p', { class: 'muted small', id: 'exp-cuts-empty' }, 'Nenhum corte ainda. Marque início e fim, salve o corte e aprove-o na aba Cortes.');
    u.cutsList = el('ul', { class: 'exp-cuts', id: 'exp-cuts' });
    u.bulk = el('select', { id: 'exp-bulk-layout', 'aria-label': 'Definir layout dos cortes selecionados' },
      el('option', { value: '' }, 'Definir layout dos selecionados…'),
      el('option', { value: 'conversa' }, 'Layout Conversa'),
      el('option', { value: 'jogo' }, 'Layout Jogo'),
      el('option', { value: 'padrao' }, 'Padrão (sem layout)'),
      el('option', { value: 'sugerido' }, 'Voltar ao sugerido'));
    u.bulkRow = el('div', { class: 'exp-bulk', hidden: true }, u.bulk);

    // layouts do canal
    u.layoutRows = LAY.LAYOUTS.map((layout) => {
      const sub = el('span', { class: 'exp-cut-sub' });
      const count = el('span', { class: 'bds-chip', hidden: true });
      const main = el('button', { type: 'button', class: 'exp-cut-main', dataset: { target: `layout:${layout}` }, 'aria-pressed': 'false', title: 'Ajustar este layout com a prévia real', onclick: () => setTarget(`layout:${layout}`) },
        el('span', { class: 'exp-cut-title' }, LAY.LABELS[layout]), sub);
      return { layout, sub, count, main, li: el('li', { class: 'exp-cut exp-layout-row', dataset: { layout } }, main, count) };
    });
    u.layoutsNote = el('p', { class: 'muted small', id: 'exp-layouts-note', hidden: true }, 'Estes layouts foram feitos para o formato vertical 9:16: em um perfil horizontal a prévia pode não fazer sentido.');
    u.layoutScope = el('select', { id: 'exp-layout-scope', 'aria-label': 'Onde salvar o padrão dos layouts' });
    u.layoutSave = el('button', { type: 'button', id: 'exp-layout-save', class: 'sm' }, 'Salvar como padrão');
    u.refGroups = LAY.LAYOUTS.map((layout) => {
      const thumbs = el('div', { class: 'exp-refs', dataset: { layout } });
      const count = el('span', { class: 'muted small' });
      const add = el('button', { type: 'button', class: 'sm', id: `exp-ref-add-${layout}`, dataset: { layout }, onclick: () => addRef(layout) }, 'Usar o quadro atual do player');
      return { layout, thumbs, count, add, node: el('div', { class: 'exp-ref-group', dataset: { layout } }, el('div', { class: 'exp-ref-head' }, el('strong', {}, LAY.LABELS[layout]), count), thumbs, add) };
    });
    u.detectRun = el('button', { type: 'button', id: 'exp-detect-run', class: 'sm', disabled: true }, 'Detectar o layout dos cortes');
    u.detectCancel = el('button', { type: 'button', id: 'exp-detect-cancel', class: 'link', hidden: true }, 'Cancelar');
    u.detectStatus = el('p', { class: 'muted small', id: 'exp-detect-status' });
    u.detectBox = el('details', { class: 'exp-details exp-detect', id: 'exp-detect' }, el('summary', {}, 'Detectar o layout pela imagem'),
      el('div', { class: 'exp-body' },
        el('p', { class: 'muted small' }, 'A análise por IA só lê o texto. Para olhar a imagem, escolha de 2 a 4 quadros de cada layout, de momentos diferentes: leve o player até um momento de Conversa (ou de Jogo) e use o botão. Na dúvida o detector não decide.'),
        u.refGroups.map((g) => g.node),
        el('div', { class: 'exp-actions' }, u.detectRun, u.detectCancel), u.detectStatus));
    u.layouts = el('details', { class: 'exp-details', id: 'exp-layouts' }, el('summary', {}, 'Layouts do canal'),
      el('div', { class: 'exp-body' },
        el('p', { class: 'muted small' }, 'Dois enquadramentos prontos, aplicados aos cortes com esse layout. Escolha um para ajustar acima, com a prévia real.'),
        el('ul', { class: 'exp-cuts exp-layout-list', id: 'exp-layout-list' }, u.layoutRows.map((r) => r.li)),
        u.layoutsNote,
        el('div', { class: 'exp-layout-save' }, u.layoutScope, u.layoutSave),
        el('p', { class: 'muted small' }, 'Novos projetos do mesmo canal, jogo ou geral começam com estes layouts. Para remover um padrão salvo, use Limpar em Preferências, Mais ajustes.'),
        u.detectBox));

    // destino
    u.dir = el('span', { id: 'exp-dir', class: 'exp-dir' });
    u.pick = el('button', { type: 'button', id: 'exp-pick-dir', class: 'sm' }, 'Alterar…');
    u.template = el('input', { id: 'exp-template', type: 'text', spellcheck: 'false', 'aria-label': 'Modelo do nome do arquivo' });
    u.example = el('p', { class: 'muted small', id: 'exp-example' });

    // QC e ação
    u.qcStatus = el('p', { class: 'exp-qc-status', id: 'exp-qc-status' });
    u.qcError = el('p', { class: 'exp-msg error', hidden: true });
    u.qcErrors = el('ul', { class: 'exp-issues' });
    u.qcWarnList = el('ul', { class: 'exp-issues' });
    u.qcWarnSummary = el('summary', {});
    u.qcWarn = el('details', { class: 'exp-details exp-warns', hidden: true }, u.qcWarnSummary, el('div', { class: 'exp-body' }, u.qcWarnList));
    u.qc = el('div', { id: 'exp-qc', class: 'exp-qc' }, u.qcErrors, u.qcWarn);
    u.enqueue = el('button', { type: 'button', id: 'exp-enqueue', class: 'primary', disabled: true }, 'Adicionar à fila');
    u.enqueueWhy = el('p', { class: 'muted small', id: 'exp-enqueue-why', hidden: true });
    u.msg = el('p', { id: 'exp-msg', class: 'exp-msg', hidden: true });

    u.frame = el('div', { class: 'panel exp-frame' },
      el('div', { class: 'exp-target-row' }, u.targetLabel, u.restore),
      u.cutLayout, u.stage, u.stageNote, u.timeRow, u.ctlCenter, u.ctlBlur, u.ctlStack);

    u.main = el('div', { class: 'exp-main', hidden: true },
      el('section', { class: 'exp-sec' },
        field('Perfil', u.profile, 'exp-profile-field'), u.profileError, u.profileWarn, u.profileHint,
        el('details', { class: 'exp-details', id: 'exp-details' }, u.summary,
          el('div', { class: 'exp-body' },
            el('div', { class: 'exp-grid' }, field('Largura (px)', u.width), field('Altura (px)', u.height)),
            u.sizeError,
            field('Codec', u.codec),
            field(['Bitrate ', u.bitrateLabel], u.bitrate),
            field('Codificador', u.encoder), u.encoderHint, u.encoderRecheck,
            field('Quadros por segundo', u.fps),
            el('div', { class: 'exp-actions' }, u.save, u.reset, u.del), u.saveHint))),
      el('section', { class: 'exp-sec' },
        el('h3', { class: 'exp-h' }, 'Enquadramento'),
        u.suggestRow,
        el('div', { class: 'bds-tabs exp-seg exp-modes', role: 'group', 'aria-label': 'Modo de enquadramento' }, u.modeButtons),
        u.hint,
        u.frame,
        u.layouts),
      el('section', { class: 'exp-sec' }, u.cutsHead, u.bulkRow, u.cutsEmpty, u.cutsList),
      el('section', { class: 'exp-sec' },
        el('h3', { class: 'exp-h' }, 'Destino'),
        el('div', { class: 'exp-dir-row' }, icon('folder'), u.dir, u.pick),
        el('details', { class: 'exp-details' }, el('summary', {}, 'Nome do arquivo'),
          el('div', { class: 'exp-body' }, field('Modelo ({fonte}, {n}, {titulo}, {perfil})', u.template), u.example))),
      el('section', { class: 'exp-sec exp-qc-sec' },
        el('h3', { class: 'exp-h' }, 'Conferência'),
        u.qcStatus, u.qcError, u.qc),
      el('div', { class: 'exp-foot' }, u.msg, u.enqueueWhy, u.enqueue,
        el('p', { class: 'exp-note' }, 'Exportação gera arquivos locais; publique manualmente.')));
    return u;
  }

  function setMode(mode) {
    editFraming((own) => { own.mode = mode; }, { commit: true });
  }

  function wire() {
    ui.profile.addEventListener('change', () => chooseProfile(ui.profile.value));
    ui.codec.addEventListener('change', () => setOverride('codec', ui.codec.value));
    ui.encoder.addEventListener('change', () => setOverride('encoder', ui.encoder.value));
    ui.fps.addEventListener('change', () => setOverride('fps', ui.fps.value === 'source' ? 'source' : Number(ui.fps.value)));
    ui.bitrate.addEventListener('input', () => { ui.bitrateLabel.textContent = mbpsText(sliderToKbps(ui.bitrate.value)); });
    ui.bitrate.addEventListener('change', () => setOverride('bitrateKbps', sliderToKbps(ui.bitrate.value)));
    for (const input of [ui.width, ui.height]) {
      input.addEventListener('change', () => {
        const w = Number(ui.width.value);
        const h = Number(ui.height.value);
        const bad = [w, h].some((v) => !Number.isInteger(v) || v < 2 || v > 7680 || v % 2 !== 0);
        ui.sizeError.hidden = !bad;
        ui.sizeError.textContent = bad ? 'Largura e altura precisam ser números inteiros pares entre 2 e 7680.' : '';
        if (bad) return;
        setOverride(input === ui.width ? 'width' : 'height', input === ui.width ? w : h);
      });
    }
    ui.save.addEventListener('click', saveProfileAs);
    ui.del.addEventListener('click', deleteProfile);
    ui.reset.addEventListener('click', resetOverrides);
    ui.restore.addEventListener('click', restoreFraming);
    ui.suggest.addEventListener('change', () => {
      updateExt((e) => { e.useSuggestedLayout = ui.suggest.checked; }, 'export:layout');
      afterFramingChange();
    });
    ui.bulk.addEventListener('change', () => { if (ui.bulk.value) bulkLayout(ui.bulk.value); });
    ui.layoutScope.addEventListener('change', () => { ui.layoutScope.dataset.touched = '1'; });
    ui.layoutSave.addEventListener('click', saveLayoutsAsDefault);
    ui.detectRun.addEventListener('click', runDetect);
    ui.detectCancel.addEventListener('click', cancelDetect);
    ui.playerFrame.addEventListener('click', usePlayerFrame);

    const slider = (input, apply, label) => {
      input.addEventListener('input', () => { editFraming((own, cur) => apply(own, Number(input.value), cur), { commit: false }); if (label) label(); });
      input.addEventListener('change', () => commitDraft());
    };
    slider(ui.zoom, (own, v) => { own.zoom = v; }, () => { ui.zoomLabel.textContent = `${Number(ui.zoom.value).toFixed(2).replace('.', ',')}×`; });
    slider(ui.zoomB, (own, v) => { own.zoom = v; }, () => { ui.zoomBLabel.textContent = `${Number(ui.zoomB.value).toFixed(2).replace('.', ',')}×`; });
    slider(ui.focusX, (own, v) => { own.focusX = v / 100; });
    slider(ui.focusXB, (own, v) => { own.focusX = v / 100; });
    slider(ui.focusY, (own, v) => { own.focusY = v / 100; });
    slider(ui.blur, (own, v) => { own.blur = { strength: v }; });
    slider(ui.pct, (own, v) => { own.stack = { ...(own.stack || {}), webcamHeightPct: v }; }, () => { ui.pctLabel.textContent = `${Math.round(Number(ui.pct.value))}%`; });

    ui.time.addEventListener('input', () => { S.frameT = Number(ui.time.value); ui.timeLabel.textContent = `${previewRange().label} · ${fmt(S.frameT)}`; scheduleSource(); schedulePreview(); });

    ui.pick.addEventListener('click', pickOutputDir);
    ui.template.addEventListener('change', () => {
      const value = ui.template.value.trim();
      updateExt((e) => { if (!value || value === DEFAULT_TEMPLATE) delete e.nameTemplate; else e.nameTemplate = value; }, 'export:name');
      scheduleQc();
    });
    ui.enqueue.addEventListener('click', enqueue);
  }

  // ---------- registro da aba e eventos ----------

  function onData() {
    if (!ui) return;
    if (S.target !== 'default' && !targetLayout() && !BF.project.cut(S.target)) S.target = 'default';
    syncCuts();
    syncLayouts();
    syncAction();
    BF.ui.refreshTabs();
    if (!visible()) return;
    scheduleSource();
    schedulePreview();
    scheduleQc();
  }
  const onDataSoon = debounce(onData, 80);

  function resetForProject() {
    S.target = 'default';
    S.stackPart = 'webcam';
    S.draft = null;
    S.sel = { off: new Set(), extra: new Set() };
    S.frameT = null;
    S.frameFor = null;
    S.src = { key: '', url: '', w: 0, h: 0, error: '', seq: S.src.seq + 1 };
    S.prev = { key: '', seq: S.prev.seq + 1, error: '' };
    S.qc = { jobs: [], reports: [], pending: false, error: '', seq: S.qc.seq + 1, ready: false };
    S.message = null;
    S.detect = { running: false, done: 0, total: 0, message: null, seq: S.detect.seq + 1 };
    if (ui) { ui.srcImg.removeAttribute('src'); ui.prevImg.removeAttribute('src'); delete ui.layoutScope.dataset.touched; delete ui.layoutScope.dataset.sig; }
  }

  // a tela Exportações (renderer/features/queue.js) usa estas quatro funções na barra de saída; o resto da aba continua só aqui
  BF.exportOut = { summary: outputSummary, ensureProfiles: () => loadProfiles(false), chooseProfile, pickDir: pickOutputDir };

  BF.ui.registerTab({
    id: 'export',
    title: 'Exportar',
    order: 20,
    badge: () => (project() ? project().cuts.filter((c) => c.status === 'approved').length : 0) || '',
    render(container) {
      root = container;
      container.classList.add('exp');
      ui = build();
      container.append(ui.empty, ui.main);
      wire();
      syncAll();
    },
    onShow() {
      if (!ui) return;
      loadProfiles(false);
      loadEncoders();
      syncAll();
      if (project()) { scheduleSource(); schedulePreview(); scheduleQc(); }
    }
  });

  BF.bus.on('project:loaded', () => {
    resetForProject();
    syncAll();
    if (visible()) { loadProfiles(false); loadEncoders(); scheduleSource(); schedulePreview(); scheduleQc(); }
  });
  BF.bus.on('cuts:changed', (data) => { if (!data || data.from !== 'export:framing') onDataSoon(); });
  BF.bus.on('project:changed', (data) => { if (!data || !String(data.reason).startsWith('export:')) onDataSoon(); });
  BF.bus.on('tools:changed', () => { S.encodersAsked = false; S.encoders = null; if (visible()) loadEncoders(); syncAll(); schedulePreview(); scheduleQc(); });
  // Preferências: o perfil e o modo de enquadramento padrão só valem para o projeto que ainda não escolheu o seu;
  // mudar a preferência com o projeto aberto atualiza a aba (a escolha do projeto, se existir, continua mandando)
  BF.bus.on('prefs:changed', ({ keys } = {}) => {
    if (!ui || !project()) return;
    const wants = (key) => !Array.isArray(keys) || keys.includes(key);
    if (wants('export.profileId') && !ext().profileId) onProfileChanged();
    else if (wants('export.framing.mode')) { syncFraming(); schedulePreview(); scheduleQc(); }
    // layouts herdados (canal > jogo > geral) e quadros de referência: mudam os presets e a detecção deste projeto
    if (Object.values(PREF).some((key) => wants(key))) afterFramingChange();
  });
  // progresso da detecção pela imagem (vem do processo principal)
  BF.on('export:detectProgress', ({ done, total } = {}) => {
    if (!S.detect.running) return;
    S.detect.done = Number(done) || 0;
    S.detect.total = Number(total) || S.detect.total;
    if (ui) syncDetect();
  });
  BF.ready.then(() => { syncAll(); });
})();

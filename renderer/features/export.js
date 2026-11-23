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

  const { el, debounce, fmt } = BF.util;

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

  const { DEFAULT_TEMPLATE, MODES, ENCODER_LABEL, FR, LAY, isObj, PREF, LAYOUT_TARGET, BR_STEPS, sliderToKbps, mbpsText } = window.BFExportLogic;

  // ---------- partes (features/export/*.js): cada uma recebe `A` e devolve o que oferece ----------
  const P = window.BFExportParts;
  const A = {
    S,
    project: (...args) => project(...args),
    ext: (...args) => ext(...args),
    updateExt: (...args) => updateExt(...args),
    schedulePreview: (...args) => schedulePreview(...args),
    scheduleQc: (...args) => scheduleQc(...args),
    syncAll: (...args) => syncAll(...args),
    syncProfile: (...args) => syncProfile(...args),
    syncFraming: (...args) => syncFraming(...args),
    get ui() { return ui; },
    useSuggested: (...args) => useSuggested(...args),
    baseProfile: (...args) => baseProfile(...args),
    customized: (...args) => customized(...args),
    targetLayout: (...args) => targetLayout(...args),
    currentRef: (...args) => currentRef(...args),
    scheduleSource: (...args) => scheduleSource(...args),
    syncOverlay: (...args) => syncOverlay(...args),
    syncCuts: (...args) => syncCuts(...args),
    syncLayouts: (...args) => syncLayouts(...args),
    visible: (...args) => visible(...args),
    layoutCtx: (...args) => layoutCtx(...args),
    projectDefaults: (...args) => projectDefaults(...args),
    chosenProfileId: (...args) => chosenProfileId(...args),
    effectiveProfile: (...args) => effectiveProfile(...args),
    dropOverrides: (...args) => dropOverrides(...args),
    chooseProfile: (...args) => chooseProfile(...args),
    onProfileChanged: (...args) => onProfileChanged(...args),
    listCuts: (...args) => listCuts(...args),
    checkedCuts: (...args) => checkedCuts(...args),
    numberOf: (...args) => numberOf(...args),
    effectiveFraming: (...args) => effectiveFraming(...args),
    commitDraft: (...args) => commitDraft(...args),
    syncStage: (...args) => syncStage(...args),
    syncDest: (...args) => syncDest(...args),
    syncQc: (...args) => syncQc(...args),
    syncAction: (...args) => syncAction(...args),
    syncMessage: (...args) => syncMessage(...args),
    presetsEffective: (...args) => presetsEffective(...args),
    resolveCut: (...args) => resolveCut(...args),
    overridesOf: (...args) => overridesOf(...args),
    ratioChanged: (...args) => ratioChanged(...args),
    encoderHint: (...args) => encoderHint(...args),
    isChecked: (...args) => isChecked(...args),
    setChecked: (...args) => setChecked(...args),
    hasOwnFraming: (...args) => hasOwnFraming(...args),
    editFraming: (...args) => editFraming(...args),
    afterFramingChange: (...args) => afterFramingChange(...args),
    setTarget: (...args) => setTarget(...args),
    previewRange: (...args) => previewRange(...args),
    frameTime: (...args) => frameTime(...args),
    sourceSize: (...args) => sourceSize(...args),
    outputDir: (...args) => outputDir(...args),
    refsEffective: (...args) => refsEffective(...args),
    icon: (...args) => icon(...args)
  };
  const { chosenProfileId, baseProfile, overridesOf, ratioChanged, effectiveProfile, dropOverrides, setOverride, chooseProfile, onProfileChanged, loadProfiles, loadEncoders, recheckEncoders, encoderHint, listCuts, isChecked } = P.profile(A);
  const { presetsEffective, refsEffective, layoutCtx, projectDefaults, resolveCut, effectiveFraming, hasOwnFraming, editFraming, commitDraft, afterFramingChange, restoreFraming, setTarget } = P.framing(A);
  const { previewRange, frameTime, sourceSize, scheduleSource, schedulePreview, scheduleQc, outputDir, enqueue, enqueueCuts, pickOutputDir, outputSummary, saveProfileAs, deleteProfile, resetOverrides } = P.preview(A);
  const { field, icon, syncAll, syncProfile, syncFraming, syncStage, syncOverlay, syncCuts, setCutLayout, bulkLayout, syncDest, syncQc, syncAction, syncMessage } = P.view(A);
  const { syncLayouts, saveLayoutsAsDefault, addRef, syncDetect, runDetect, cancelDetect, usePlayerFrame } = P.layouts(A);

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
  BF.exportOut = { summary: outputSummary, ensureProfiles: () => loadProfiles(false), chooseProfile, pickDir: pickOutputDir, enqueueCuts };

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

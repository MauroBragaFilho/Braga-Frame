'use strict';

/**
 * Aba "Exportar" — layouts do canal e enquadramento (camadas, edição, rascunho, restaurar).
 * Tirado de features/export.js (Etapa 2, 17/11/2026) sem mudar o comportamento. É uma FÁBRICA: export.js a chama com o que ela precisa do resto da aba (`A`) e recebe de volta o que ela oferece.
 * Carrega ANTES de export.js (renderer/index.html).
 */
(function () {
  const BF = window.BF;
  const { LAY, clone, isObj, mergeLayers, complete, PREF, PREF_LABEL, REF_B64, REF_MAX } = window.BFExportLogic;

  window.BFExportParts = window.BFExportParts || {};
  window.BFExportParts.framing = function (A) {
    const { S } = A;
    const ext = (...args) => A.ext(...args);
    const updateExt = (...args) => A.updateExt(...args);
    const useSuggested = (...args) => A.useSuggested(...args);
    const baseProfile = (...args) => A.baseProfile(...args);
    const customized = (...args) => A.customized(...args);
    const targetLayout = (...args) => A.targetLayout(...args);
    const currentRef = (...args) => A.currentRef(...args);
    const scheduleSource = (...args) => A.scheduleSource(...args);
    const schedulePreview = (...args) => A.schedulePreview(...args);
    const scheduleQc = (...args) => A.scheduleQc(...args);
    const syncFraming = (...args) => A.syncFraming(...args);
    const syncOverlay = (...args) => A.syncOverlay(...args);
    const syncCuts = (...args) => A.syncCuts(...args);
    const syncLayouts = (...args) => A.syncLayouts(...args);

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
      if (targetLayout() && A.ui.frame && A.ui.frame.scrollIntoView) A.ui.frame.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    return { presetsEffective, refsEffective, layoutCtx, projectDefaults, resolveCut, effectiveFraming, hasOwnFraming, editFraming, commitDraft, afterFramingChange, restoreFraming, setTarget };
  };
})();

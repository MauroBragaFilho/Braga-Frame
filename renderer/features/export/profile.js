'use strict';

/**
 * Aba "Exportar" — perfil de exportação (escolha, ajustes, codificadores, bitrate).
 * Tirado de features/export.js (Etapa 2, 17/11/2026) sem mudar o comportamento. É uma FÁBRICA: export.js a chama com o que ela precisa do resto da aba (`A`) e recebe de volta o que ela oferece.
 * Carrega ANTES de export.js (renderer/index.html).
 */
(function () {
  const BF = window.BF;
  const { DEFAULT_PROFILE_ID, OVERRIDE_KEYS, isObj } = window.BFExportLogic;

  window.BFExportParts = window.BFExportParts || {};
  window.BFExportParts.profile = function (A) {
    const { S } = A;
    const project = (...args) => A.project(...args);
    const ext = (...args) => A.ext(...args);
    const updateExt = (...args) => A.updateExt(...args);
    const schedulePreview = (...args) => A.schedulePreview(...args);
    const scheduleQc = (...args) => A.scheduleQc(...args);
    const syncAll = (...args) => A.syncAll(...args);
    const syncProfile = (...args) => A.syncProfile(...args);
    const syncFraming = (...args) => A.syncFraming(...args);

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

    /** Cortes que podem ser exportados (sem os rejeitados), em ordem cronológica. */
    const listCuts = () => (project() ? [...project().cuts].filter((c) => c.status !== 'rejected').sort((a, b) => a.start - b.start) : []);

    const isChecked = (cut) => (S.sel.extra.has(cut.id) ? true : S.sel.off.has(cut.id) ? false : cut.status === 'approved');

    return { chosenProfileId, baseProfile, overridesOf, ratioChanged, effectiveProfile, dropOverrides, setOverride, chooseProfile, onProfileChanged, loadProfiles, loadEncoders, recheckEncoders, encoderHint, listCuts, isChecked };
  };
})();

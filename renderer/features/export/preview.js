'use strict';

/**
 * Aba "Exportar" — quadro de referência, prévia, controle de qualidade, envio para a fila, pasta de saída e perfis do usuário.
 * Tirado de features/export.js (Etapa 2, 17/11/2026) sem mudar o comportamento. É uma FÁBRICA: export.js a chama com o que ela precisa do resto da aba (`A`) e recebe de volta o que ela oferece.
 * Carrega ANTES de export.js (renderer/index.html).
 */
(function () {
  const BF = window.BF;
  const { debounce, dirOf, joinPath } = BF.util;
  const { DEFAULT_PROFILE_ID, DEFAULT_TEMPLATE, LAY, clamp } = window.BFExportLogic;

  window.BFExportParts = window.BFExportParts || {};
  window.BFExportParts.preview = function (A) {
    const { S } = A;
    const project = (...args) => A.project(...args);
    const ext = (...args) => A.ext(...args);
    const visible = (...args) => A.visible(...args);
    const updateExt = (...args) => A.updateExt(...args);
    const layoutCtx = (...args) => A.layoutCtx(...args);
    const projectDefaults = (...args) => A.projectDefaults(...args);
    const chosenProfileId = (...args) => A.chosenProfileId(...args);
    const baseProfile = (...args) => A.baseProfile(...args);
    const effectiveProfile = (...args) => A.effectiveProfile(...args);
    const dropOverrides = (...args) => A.dropOverrides(...args);
    const chooseProfile = (...args) => A.chooseProfile(...args);
    const onProfileChanged = (...args) => A.onProfileChanged(...args);
    const listCuts = (...args) => A.listCuts(...args);
    const checkedCuts = (...args) => A.checkedCuts(...args);
    const numberOf = (...args) => A.numberOf(...args);
    const targetLayout = (...args) => A.targetLayout(...args);
    const effectiveFraming = (...args) => A.effectiveFraming(...args);
    const commitDraft = (...args) => A.commitDraft(...args);
    const syncStage = (...args) => A.syncStage(...args);
    const syncDest = (...args) => A.syncDest(...args);
    const syncQc = (...args) => A.syncQc(...args);
    const syncAction = (...args) => A.syncAction(...args);
    const syncMessage = (...args) => A.syncMessage(...args);

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
      if (S.prev.key === key && A.ui.prevImg.src) return;
      const seq = ++S.prev.seq;
      A.ui.stage.classList.add('is-loading');
      const res = await BF.api('export:framePreview', { sourcePath: p.source.path, timeSec: t, profile, framing, maxSide: 560, key: 'export-prev' });
      if (seq !== S.prev.seq || project() !== p) return;
      A.ui.stage.classList.remove('is-loading');
      if (!res.ok) {
        if (res.code === 'SUPERSEDED') return;
        S.prev = { key: '', seq, error: res.message };
      } else {
        S.prev = { key, seq, error: '' };
        A.ui.prevImg.src = res.dataUrl;
      }
      syncStage();
    }

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

    return { previewRange, frameTime, sourceSize, scheduleSource, schedulePreview, scheduleQc, outputDir, enqueue, pickOutputDir, outputSummary, saveProfileAs, deleteProfile, resetOverrides };
  };
})();

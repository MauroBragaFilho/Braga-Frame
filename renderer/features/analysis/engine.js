'use strict';

/**
 * Aba "Análise" — Motor da análise (Algoritmo | IA | Algoritmo + IA) e transcrição do vídeo (gerar, importar, cancelar, retomar).
 * Tirado de features/analysis.js (Etapa 2, 17/11/2026) sem mudar o comportamento. É uma FÁBRICA: analysis.js a chama com o que ela
 * precisa do resto da aba (`A`: estado e funções) e recebe de volta o que ela oferece. Carrega ANTES de analysis.js (renderer/index.html).
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;
  const { ENGINES, ENGINE_IDS, usesAi, hms, plural } = window.BFAnalysisLogic;

  window.BFAnalysisParts = window.BFAnalysisParts || {};
  window.BFAnalysisParts.engine = function (A) {
    const { state } = A;
    const settings = (...args) => A.settings(...args);
    const engineChoice = (...args) => A.engineChoice(...args);
    const saveSettings = (...args) => A.saveSettings(...args);
    const run = (...args) => A.run(...args);
    const readControls = (...args) => A.readControls(...args);
    const renderNotice = (...args) => A.renderNotice(...args);
    const renderResults = (...args) => A.renderResults(...args);
    const refreshEstimate = (...args) => A.refreshEstimate(...args);
    const renderAll = (...args) => A.renderAll(...args);

    /** Modelo e idioma que o usuário escolheu na aba Legendas para este vídeo (sem escolha, o padrão do app). */
    function whisperChoice(project) {
      const sub = (project.ext && project.ext.subtitles) || {};
      return {
        ...(typeof sub.modelId === 'string' && sub.modelId ? { modelId: sub.modelId } : {}),
        ...(typeof sub.language === 'string' && sub.language ? { language: sub.language } : {})
      };
    }

    async function refreshTranscript() {
      const project = BF.state.project;
      if (!project) { state.transcript = null; state.tengine = null; renderAll(); return; }
      const res = await BF.api('analysis:transcriptStatus', {
        projectId: project.id, path: project.source.path, size: project.source.size || 0, duration: project.source.duration || 0, ...whisperChoice(project)
      });
      if (BF.state.project !== project) return;
      state.transcript = res.ok && res.transcript ? res.transcript : null;
      state.tengine = res.ok && res.engine ? res.engine : null;
      if (res.ok && res.running && res.running.projectId === project.id && !state.tjob) {
        state.tjob = { id: res.running.jobId, p: res.running.p || 0, message: res.running.message || 'Transcrevendo…', doneUntil: res.running.doneUntil || 0 };
      }
      renderAll();
      refreshEstimate();
    }

    /** Salva o motor escolhido neste projeto (a escolha automática vale enquanto o usuário não escolher). */
    function setEngine(id) {
      if (!BF.state.project || state.running || !ENGINE_IDS.includes(id)) return;
      saveSettings({ ...readControls(), engine: id });
      renderAll();
      renderResults();
      refreshEstimate();
    }

    // ---------- transcrição do vídeo ----------
    /** Falta o motor ou o modelo, e o módulo de transcrição sabe instalar: o botão "Transcrever" instala (uma confirmação) e segue sozinho. */
    const canInstallFirst = (eng) => Boolean(BF.transcription && eng && !eng.ready && eng.needs && (eng.needs.engine || eng.needs.model));

    async function generateTranscript() {
      const project = BF.state.project;
      if (!project || state.tjob || state.tstarting || state.running) return;
      if (canInstallFirst(state.tengine)) {
        const done = await BF.transcription.install({ modelId: (state.tengine && state.tengine.modelId) || null });
        if (!done) return;
        await refreshTranscript();
        if (!(state.tengine && state.tengine.ready) || BF.state.project !== project) return;
      }
      state.tstarting = true;
      state.notice = null;
      renderAll();
      const res = await BF.api('analysis:transcriptGenerate', {
        projectId: project.id, path: project.source.path, size: project.source.size || 0, duration: project.source.duration || 0, ...whisperChoice(project)
      });
      state.tstarting = false;
      if (!res.ok) {
        state.notice = { kind: 'error', text: res.message };
        BF.ui.log(res.message, 'error');
        renderAll();
        return;
      }
      state.tjob = { id: res.jobId, p: 0, message: 'Preparando…', doneUntil: 0, projectId: project.id };
      for (const item of state.tearly.splice(0)) handleTranscriptEvent(item.type, item.payload);
      renderAll();
    }

    async function cancelTranscript() {
      if (state.tjob) await BF.api('analysis:transcriptCancel', { jobId: state.tjob.id });
    }

    /** "Instalar a transcrição": o cartão da aba Ferramentas instala o motor e o modelo que este vídeo usa e, no fim, devolve o usuário à Análise. */
    async function installTranscription() {
      if (!BF.transcription) return;
      await BF.transcription.install({ modelId: (state.tengine && state.tengine.modelId) || null });
      refreshTranscript();
    }

    async function importTranscript() {
      const project = BF.state.project;
      if (!project || state.tjob) return;
      const res = await BF.api('analysis:transcriptImport', {
        projectId: project.id, path: project.source.path, size: project.source.size || 0, duration: project.source.duration || 0,
        defaultDir: BF.util.dirOf ? BF.util.dirOf(project.source.path) : undefined
      });
      if (!res.ok) { state.notice = { kind: 'error', text: res.message }; renderNotice(); return; }
      if (res.canceled) return;
      state.notice = res.warnings && res.warnings.length ? { kind: 'info', text: res.warnings.join(' ') } : null;
      BF.ui.toast('Transcrição importada.', 'ok');
      await refreshTranscript();
    }

    async function removeTranscript() {
      const project = BF.state.project;
      if (!project) return;
      const ok = await BF.ui.confirm({ title: 'Remover a transcrição?', message: 'A transcrição guardada deste vídeo será apagada do app (o arquivo de legenda original, se houve importação, não é tocado). A análise por IA vai pedir uma nova.', okLabel: 'Remover', cancelLabel: 'Manter', danger: true });
      if (!ok) return;
      await BF.api('analysis:transcriptRemove', { projectId: project.id });
      await refreshTranscript();
    }

    function handleTranscriptEvent(type, payload) {
      if (!state.tjob || payload.jobId !== state.tjob.id) {
        if (state.tstarting) state.tearly.push({ type, payload });
        return;
      }
      if (type === 'progress') {
        state.tjob = { ...state.tjob, p: payload.p, message: payload.message, doneUntil: payload.doneUntil };
        renderTranscript();
      } else if (type === 'done') {
        state.tjob = null;
        BF.ui.toast(payload.deviceNote ? `Transcrição pronta. ${payload.deviceNote}` : 'Transcrição pronta.', 'ok');
        refreshTranscript();
      } else if (type === 'failed') {
        state.tjob = null;
        state.notice = payload.code === 'CANCELLED'
          ? { kind: 'info', text: payload.message }
          : { kind: 'error', text: payload.message };
        if (payload.code !== 'CANCELLED') BF.ui.log(payload.message, 'error');
        refreshTranscript();
      }
    }

    BF.on('analysis:transcriptProgress', (ev) => handleTranscriptEvent('progress', ev));

    BF.on('analysis:transcriptDone', (ev) => handleTranscriptEvent('done', ev));

    BF.on('analysis:transcriptFailed', (ev) => handleTranscriptEvent('failed', ev));

    /** A IA falhou: troca para o algoritmo e analisa (a escolha fica salva neste projeto). */
    async function useAlgorithm() {
      state.notice = null;
      saveSettings({ ...readControls(), engine: 'algorithm' });
      renderAll();
      await run({ engine: 'algorithm' });
    }

    // ---------- desenho: motor, transcrição, provedor ----------
    function buildEngine() {
      const ui = state.ui;
      ui.engineButtons = {};
      const buttons = ENGINES.map((e) => {
        const button = el('button', { type: 'button', id: `anEngine-${e.id}`, class: 'bds-tab', role: 'tab', 'aria-selected': 'false', dataset: { engine: e.id }, onclick: () => setEngine(e.id) }, e.label);
        ui.engineButtons[e.id] = button;
        return button;
      });
      ui.engineHint = el('p', { class: 'muted small', id: 'anEngineHint' });
      ui.engineBar = el('div', { class: 'an-engine', id: 'anEngine' },
        el('h3', { class: 'panel-title' }, 'Motor da análise'),
        el('div', { class: 'bds-tabs', role: 'tablist', 'aria-label': 'Motor da análise' }, buttons),
        ui.engineHint);
    }

    function renderEngine() {
      const ui = state.ui;
      if (!ui.engineBar) return;
      const eng = engineChoice();
      const auto = !settings().engine;
      for (const e of ENGINES) {
        const button = ui.engineButtons[e.id];
        button.setAttribute('aria-selected', String(e.id === eng));
        button.classList.toggle('active', e.id === eng);
        button.disabled = state.running;
      }
      ui.engineHint.textContent = `${ENGINES.find((e) => e.id === eng).hint}${auto ? ' (escolhido automaticamente)' : ''}`;
      ui.signalsBlock.hidden = eng === 'ai' || eng === 'chat';
      ui.sensRow.hidden = eng === 'ai' || eng === 'chat';
      ui.advanced.hidden = eng === 'ai' || eng === 'chat';
      ui.aiRoot.hidden = !usesAi(eng);
      ui.intro.textContent = eng === 'chat'
        ? 'Sem chave de API: o app monta o pedido com a transcrição, você cola no GPT, no Qwen ou em outro chat e traz a resposta. O app confere cada trecho antes de virar sugestão. Sugestão não é garantia: revise cada trecho.'
        : eng === 'ai'
        ? 'A IA lê a transcrição do vídeo e sugere os melhores momentos. O app confere cada horário e cada frase antes de virar sugestão. Sugestão não é garantia: revise cada trecho.'
        : eng === 'both'
          ? 'Roda o algoritmo (neste computador) e depois a IA (na nuvem, com a transcrição), e junta as duas listas: o momento que os dois acharam aparece uma vez só, no topo. Leva o tempo dos dois. Sugestão não é garantia: revise cada trecho.'
          : 'Procura volume acima do normal de fala, mudanças de imagem, agitação do chat e, com a transcrição, risadas, exclamações e ritmo de fala. São regras simples, não inteligência artificial: sugestão não é garantia — revise cada trecho.';
    }

    function renderTranscript() {
      const ui = state.ui;
      if (!ui.tCard) return;
      const t = state.transcript;
      const eng = state.tengine;
      const running = Boolean(state.tjob) || state.tstarting;
      ui.tProgressBox.hidden = !running;
      if (running) {
        const job = state.tjob || { p: 0, message: 'Preparando…', doneUntil: 0 };
        const p = Math.min(1, Math.max(0, job.p));
        ui.tProgress.value = p;
        const total = (BF.state.project && BF.state.project.source.duration) || 0;
        ui.tProgressText.textContent = `${job.message}${total ? ` · ${hms(job.doneUntil)} de ${hms(total)}` : ''}`;
        ui.tCancel.disabled = state.tstarting && !state.tjob;
      }
      const ai = usesAi(engineChoice());
      let chip = [ai ? 'Ausente' : 'Opcional', 'bds-chip bds-chip-warn'];
      let line = ai
        ? 'Sem transcrição. A IA precisa do texto do vídeo: gere com o Whisper (neste computador) ou importe uma legenda .srt/.vtt.'
        : 'Sem transcrição. Com o texto das falas o algoritmo também procura risadas, exclamações e ritmo de fala: gere com o Whisper (neste computador) ou importe uma legenda .srt/.vtt.';
      let sub = '';
      if (t && t.exists) {
        const pctCovered = t.coverage == null ? null : Math.round(t.coverage * 100);
        chip = t.stale ? ['De outro arquivo', 'bds-chip bds-chip-warn'] : (t.origin === 'imported' ? ['Importada', 'bds-chip bds-chip-info'] : ['Gerada', 'bds-chip bds-chip-ok']);
        line = t.stale
          ? 'Esta transcrição foi feita para outro arquivo de vídeo. Gere ou importe a deste vídeo.'
          : `Cobre ${hms(t.coveredSec)}${t.duration ? ` de ${hms(t.duration)} (${pctCovered}%)` : ''} · ${plural(t.cues, 'fala', 'falas')}${t.laughs ? ` · ${plural(t.laughs, 'risada', 'risadas')}` : ''}`;
        if (t.origin === 'imported') sub = `Importada${t.importedFrom ? ` de ${t.importedFrom}` : ''}.`;
        else sub = `Gerada pelo Whisper${t.engine && t.engine.modelLabel ? ` (${t.engine.modelLabel}${t.engine.deviceLabel ? `, ${t.engine.deviceLabel}` : ''})` : ''}.`;
        if (!t.stale && pctCovered !== null && pctCovered < 90) sub = `${sub} Cobre só ${pctCovered}% do vídeo: o texto não ajuda no que vem depois.`;
      } else if (t && t.draft) {
        chip = ['Incompleta', 'bds-chip bds-chip-warn'];
        line = `Há uma transcrição pela metade (até ${hms(t.draft.doneUntil)}). O botão continua de onde parou.`;
      }
      if (eng && !eng.ready && !running) sub = sub ? `${sub} ${eng.reason}` : eng.reason;
      ui.tChip.className = chip[1];
      ui.tChip.textContent = chip[0];
      ui.tLine.textContent = line;
      ui.tSub.textContent = sub;
      ui.tSub.hidden = !sub;
      const has = Boolean(t && t.exists && !t.stale);
      // falta o motor ou o modelo (o FFmpeg tem o próprio aviso no topo): o mesmo botão instala tudo (uma confirmação) e já transcreve
      const installFirst = canInstallFirst(eng);
      ui.tGenerate.textContent = installFirst ? 'Instalar e transcrever o vídeo' : (t && t.draft && !has ? 'Continuar a transcrição' : (has ? 'Transcrever de novo' : 'Transcrever o vídeo'));
      ui.tGenerate.disabled = running || state.running || !BF.state.project || !(eng && (eng.ready || installFirst));
      ui.tGenerate.title = installFirst ? 'Baixa o que falta (motor e modelo, só na primeira vez) e transcreve em seguida.' : (eng && !eng.ready ? eng.reason : '');
      ui.tInstall.hidden = true; // o botão de instalar separado deu lugar ao "Instalar e transcrever"
      ui.tGenerate.classList.toggle('primary', false); // o destaque primário da tela é "Analisar"; este botão fica secundário
      ui.tImport.disabled = running || state.running || !BF.state.project;
      ui.tCopy.hidden = !has;
      ui.tCopy.disabled = running || state.running;
      A.renderManual();
      ui.tRemove.hidden = !(t && t.exists);
      ui.tRemove.disabled = running || state.running;
    }

    return { refreshTranscript, generateTranscript, cancelTranscript, installTranscription, importTranscript, removeTranscript, useAlgorithm, buildEngine, renderEngine, renderTranscript };
  };
})();

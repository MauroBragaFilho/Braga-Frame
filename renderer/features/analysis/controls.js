'use strict';

/**
 * Aba "Análise" — Controles do algoritmo e a execução na tela: ajustes, ajustes avançados, dicas, botão de rodar, progresso e avisos.
 * Tirado de features/analysis.js (Etapa 2, 17/11/2026) sem mudar o comportamento. É uma FÁBRICA: analysis.js a chama com o que ela
 * precisa do resto da aba (`A`: estado e funções) e recebe de volta o que ela oferece. Carrega ANTES de analysis.js (renderer/index.html).
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;
  const { SIGNALS, TEXT_WEIGHTS, PROFILES, SENSITIVITY_LABELS, eta, remainingSec, stageRemainingSec, pct, num, usesAi, usesAlgorithm, BEST_ONLY_PER_HOUR, splitKeywords } = window.BFAnalysisLogic;

  window.BFAnalysisParts = window.BFAnalysisParts || {};
  window.BFAnalysisParts.controls = function (A) {
    const { state } = A;
    const current = (...args) => A.current(...args);
    const settings = (...args) => A.settings(...args);
    const engineChoice = (...args) => A.engineChoice(...args);
    const aiBlockers = (...args) => A.aiBlockers(...args);
    const saveSettings = (...args) => A.saveSettings(...args);
    const prefValues = (...args) => A.prefValues(...args);
    const limitedPrefs = (...args) => A.limitedPrefs(...args);
    const run = (...args) => A.run(...args);
    const renderResults = (...args) => A.renderResults(...args);
    const refreshEstimate = (...args) => A.refreshEstimate(...args);
    const openModelList = (...args) => A.openModelList(...args);
    const renderSkill = (...args) => A.renderSkill(...args);
    const useAlgorithm = (...args) => A.useAlgorithm(...args);
    const renderHumor = (...args) => A.renderHumor(...args);
    const renderTranscript = (...args) => A.renderTranscript(...args);

    // Redesenha uma vez só por rajada de eventos. Com timer (e não requestAnimationFrame): numa janela escondida ou coberta por outra o
    // navegador suspende o requestAnimationFrame e a lista ficaria desatualizada até a janela reaparecer.
    let renderQueued = false;

    function scheduleResults() {
      if (renderQueued) return;
      renderQueued = true;
      setTimeout(() => { renderQueued = false; renderResults(); renderHints(); BF.ui.refreshTabs(); }, 0);
    }

    const icon = (name) => el('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true' }, name);

    function field(label, input, hint, wide) {
      return el('label', { class: `an-field${wide ? ' an-field-wide' : ''}` }, el('span', { class: 'an-field-label' }, label), input, hint ? el('span', { class: 'muted small' }, hint) : null);
    }

    /** Linha com título, explicação curta e interruptor (o <input> é o próprio .bds-switch). */
    function switchRow(className, forId, title, hintNode, input) {
      return el('label', { class: className, for: forId },
        el('span', { class: 'an-signal-text' }, el('strong', {}, title), hintNode),
        input);
    }

    function buildControls() {
      const ui = state.ui;
      ui.signalBoxes = {};
      ui.signalHints = {};
      const signalRows = SIGNALS.map((sig) => {
        const box = el('input', { type: 'checkbox', id: `anSignal-${sig.id}`, class: 'bds-switch', role: 'switch', dataset: { signal: sig.id }, onchange: onControlChange });
        const hint = el('span', { class: 'an-signal-hint small', id: `anHint-${sig.id}` });
        ui.signalBoxes[sig.id] = box;
        ui.signalHints[sig.id] = hint;
        return switchRow('an-signal', `anSignal-${sig.id}`, sig.label, hint, box);
      });

      ui.profile = el('select', { id: 'anProfile', onchange: onControlChange },
        PROFILES.map((p) => el('option', { value: p.id }, p.label)));
      ui.profileHint = el('span', { class: 'muted small', id: 'anProfileHint' });
      // live com vários programas (segments.js): a tela de espera fica fora e cada episódio ganha pelo menos uma sugestão
      ui.episodes = el('input', { type: 'checkbox', id: 'anEpisodes', class: 'bds-switch', role: 'switch', onchange: onControlChange });
      // quantidade automática (sem teto por hora) e o filtro de ideias fracas (params.js)
      ui.autoQty = el('input', { type: 'checkbox', id: 'anAutoQty', class: 'bds-switch', role: 'switch', onchange: () => { if (ui.autoQty.checked) ui.bestOnly.checked = false; onControlChange(); } });
      // "Só os melhores" (lista curta, quantidade fixa): ligar um desliga o outro
      ui.bestOnly = el('input', { type: 'checkbox', id: 'anBestOnly', class: 'bds-switch', role: 'switch', onchange: () => { if (ui.bestOnly.checked) ui.autoQty.checked = false; onControlChange(); } });
      ui.filterWeak = el('input', { type: 'checkbox', id: 'anFilterWeak', class: 'bds-switch', role: 'switch', onchange: onControlChange });
      // modo Algoritmo + IA: a IA lê a fala de cada sugestão que só o algoritmo achou e diz se vale um corte (merge.js tira as recusadas)
      ui.aiReview = el('input', { type: 'checkbox', id: 'anAiReview', class: 'bds-switch', role: 'switch', onchange: onControlChange });
      ui.aiReviewRow = switchRow('an-switch-row an-ai-review', 'anAiReview', 'IA confere o algoritmo',
        el('span', { class: 'small' }, 'No modo Algoritmo + IA, a IA lê a fala de cada sugestão que só o algoritmo achou e tira as que não valem um corte. Gasta de 1 a 3 chamadas a mais.'), ui.aiReview);
      // modo janelas candidatas: um filtro local (volume do áudio, picos de chat e risadas) marca onde pode haver corte e a IA lê só esses trechos
      ui.aiWindows = el('input', { type: 'checkbox', id: 'anAiWindows', class: 'bds-switch', role: 'switch', onchange: () => { onControlChange(); refreshEstimate(); } });
      ui.aiWindowsRow = switchRow('an-switch-row an-ai-windows', 'anAiWindows', 'Enviar só os trechos candidatos',
        el('span', { class: 'small' }, 'Um filtro no seu computador (volume, picos de chat e risadas) marca onde pode haver corte e a IA lê só esses trechos, com 15 s de contexto: menos texto enviado, menos chamadas e menos erro de limite. O volume não é enviado. Sem sinais suficientes, usa o método de sempre.'), ui.aiWindows);
      ui.sensitivity = el('input', { type: 'range', id: 'anSensitivity', min: '1', max: '5', step: '1', onchange: onControlChange, oninput: syncOutputs });
      ui.sensitivityOut = el('output', { for: 'anSensitivity', class: 'an-out' });
      ui.perHour = el('input', { type: 'range', id: 'anPerHour', min: '1', max: '20', step: '1', onchange: onControlChange, oninput: syncOutputs });
      ui.perHourOut = el('output', { for: 'anPerHour', class: 'an-out' });

      ui.weights = {};
      const weightFields = SIGNALS.map((sig) => {
        const input = el('input', { type: 'number', id: `anWeight-${sig.id}`, min: '0', max: '2', step: '0.1', onchange: onControlChange });
        ui.weights[sig.id] = input;
        return field(sig.label, input);
      });
      ui.textWeights = {};
      const textWeightFields = TEXT_WEIGHTS.map((feat) => {
        const input = el('input', { type: 'number', id: `anTextWeight-${feat.id}`, min: '0', max: '2', step: '0.1', onchange: onControlChange });
        ui.textWeights[feat.id] = input;
        return field(feat.label, input);
      });
      ui.keywords = el('input', { type: 'text', id: 'anKeywords', placeholder: 'clip, pog, omg…', onchange: onControlChange });
      ui.lag = el('input', { type: 'number', id: 'anChatLag', min: '0', max: '60', step: '1', onchange: onControlChange });
      ui.win = el('input', { type: 'number', id: 'anChatWindow', min: '2', max: '60', step: '1', onchange: onControlChange });
      ui.fast = el('input', { type: 'checkbox', id: 'anImageFast', class: 'bds-switch', role: 'switch', onchange: onControlChange });
      ui.prefsNote = el('p', { class: 'an-prefs muted small', id: 'anPrefsNote' });
      ui.reset = el('button', { type: 'button', id: 'anReset', class: 'sm', onclick: resetSettings }, 'Restaurar padrões');
      ui.fresh = el('button', { type: 'button', id: 'anFresh', class: 'secondary sm', onclick: () => run({ fresh: true }) }, 'Analisar de novo, sem usar o guardado');
      // ajustes travados enquanto a análise roda (os sinais são tratados em renderHints)
      ui.lockables = [ui.profile, ui.episodes, ui.autoQty, ui.bestOnly, ui.filterWeak, ui.aiReview, ui.aiWindows, ui.sensitivity, ui.perHour, ...SIGNALS.map((sig) => ui.weights[sig.id]), ...TEXT_WEIGHTS.map((feat) => ui.textWeights[feat.id]), ui.keywords, ui.lag, ui.win, ui.fast, ui.reset];

      ui.signalsBlock = el('div', { class: 'an-block', id: 'anSignals' },
        el('h3', { class: 'panel-title' }, 'O que procurar'),
        el('label', { class: 'an-field an-profile', for: 'anProfile' }, el('span', { class: 'an-field-label' }, 'Tipo de vídeo'), ui.profile, ui.profileHint),
        switchRow('an-switch-row an-episodes', 'anEpisodes', 'Separar por episódios',
          el('span', { class: 'small', id: 'anEpisodesHint' }, 'Pula as telas de espera ("Voltamos em instantes") e dá pelo menos uma sugestão a cada episódio da live.'), ui.episodes),
        el('div', { class: 'an-signals' }, signalRows));
      ui.sensRow = el('label', { class: 'an-slider', for: 'anSensitivity', id: 'anSensRow' },
        el('span', { class: 'an-slider-head' }, el('span', { class: 'an-slider-label' }, 'Sensibilidade'), ui.sensitivityOut), ui.sensitivity);
      ui.advanced = el('details', { class: 'an-advanced', id: 'anAdvanced' },
          el('summary', {}, 'Ajustes avançados'),
          el('div', { class: 'an-adv-body' },
            el('div', { class: 'an-adv-group' },
              el('h4', { class: 'an-group-title' }, 'Peso de cada sinal'),
              el('div', { class: 'an-adv-grid an-adv-two' }, weightFields)),
            el('div', { class: 'an-adv-group' },
              el('h4', { class: 'an-group-title' }, 'Pistas da transcrição'),
              el('div', { class: 'an-adv-grid' }, textWeightFields),
              el('p', { class: 'muted small' }, 'Cada pista vale de 0 (desliga) a 2. Só contam quando o vídeo tem transcrição. A estrutura só existe no tipo Conversa ou podcast.')),
            el('div', { class: 'an-adv-group' },
              el('h4', { class: 'an-group-title' }, 'Chat'),
              field('Palavras-chave do chat', ui.keywords, 'separadas por vírgula; vazio = não usar', true),
              el('div', { class: 'an-adv-grid an-adv-two' }, field('Atraso (s)', ui.lag), field('Janela (s)', ui.win)),
              el('p', { class: 'muted small' }, 'O atraso conta que o público reage depois do lance.')),
            el('div', { class: 'an-adv-group' },
              el('h4', { class: 'an-group-title' }, 'Imagem'),
              switchRow('an-switch-row', 'anImageFast', 'Modo rápido', el('span', { class: 'small' }, 'Só quadros-chave; mais grosseiro'), ui.fast)),
            ui.prefsNote,
            el('div', { class: 'an-adv-actions' }, ui.reset, ui.fresh),
            el('p', { class: 'muted small' }, 'Analisar de novo lê o vídeo outra vez e ignora o resultado já calculado (útil depois de uma falha).')));
      return el('section', { class: 'an-controls', 'aria-label': 'Ajustes da análise' },
        ui.signalsBlock,
        el('div', { class: 'an-sliders' },
          ui.sensRow,
          el('label', { class: 'an-slider', for: 'anPerHour' },
            el('span', { class: 'an-slider-head' }, el('span', { class: 'an-slider-label' }, 'Quantidade'), ui.perHourOut), ui.perHour),
          switchRow('an-switch-row an-best-only', 'anBestOnly', 'Só os melhores',
            el('span', { class: 'small' }, `Lista curta: ficam só as sugestões de nota mais alta (${BEST_ONLY_PER_HOUR} por hora). É o oposto da quantidade automática: menos cortes para revisar, e bem menos sugestão fraca.`), ui.bestOnly),
          switchRow('an-switch-row an-auto-qty', 'anAutoQty', 'Quantidade automática',
            el('span', { class: 'small' }, 'Sem teto por hora. Com o filtro abaixo valendo, a busca fica um degrau mais sensível e só entra a reação confirmada por outra pista (mais cortes para revisar).'), ui.autoQty),
          switchRow('an-switch-row an-filter-weak', 'anFilterWeak', 'Descartar ideias fracas',
            el('span', { class: 'small' }, 'Com transcrição, tira o que não tem reação de voz (riso, exclamação, comentário) nem do chat (num chat pequeno, a risada escrita conta).'), ui.filterWeak),
          ui.aiReviewRow, ui.aiWindowsRow),
        ui.runArea,
        ui.advanced);
    }

    function fillControls() {
      const ui = state.ui;
      const s = settings();
      for (const sig of SIGNALS) ui.signalBoxes[sig.id].checked = Boolean(s.signals[sig.id]);
      ui.profile.value = s.profile;
      ui.profileHint.textContent = (PROFILES.find((p) => p.id === s.profile) || PROFILES[0]).hint;
      ui.episodes.checked = Boolean(s.episodes);
      ui.autoQty.checked = Boolean(s.autoQuantity);
      ui.bestOnly.checked = Boolean(s.bestOnly);
      ui.filterWeak.checked = Boolean(s.filterWeak);
      ui.aiReview.checked = s.aiReview !== false;
      ui.aiWindows.checked = s.aiWindows === true;
      ui.sensitivity.value = String(s.sensitivity);
      ui.perHour.value = String(s.perHour);
      for (const sig of SIGNALS) ui.weights[sig.id].value = String(s.weights[sig.id]);
      for (const feat of TEXT_WEIGHTS) ui.textWeights[feat.id].value = String(s.textWeights[feat.id]);
      ui.keywords.value = s.chat.keywords.join(', ');
      ui.lag.value = String(s.chat.lagSec);
      ui.win.value = String(s.chat.windowSec);
      ui.fast.checked = Boolean(s.image.fast);
      syncOutputs();
      renderHints();
    }

    function syncOutputs() {
      const ui = state.ui;
      if (!ui.sensitivity) return;
      ui.sensitivityOut.textContent = SENSITIVITY_LABELS[Math.min(4, Math.max(0, Number(ui.sensitivity.value) - 1))];
      const hours = BF.state.info && BF.state.info.duration ? BF.state.info.duration / 3600 : 0;
      const per = Number(ui.perHour.value);
      const total = hours ? Math.min(300, Math.max(3, Math.round(per * hours))) : null;
      if (ui.bestOnly && ui.bestOnly.checked) {
        const best = hours ? Math.min(300, Math.max(3, Math.round(BEST_ONLY_PER_HOUR * hours))) : null;
        ui.perHourOut.textContent = `só os melhores: ${BEST_ONLY_PER_HOUR} por hora${best ? ` (até ${best} neste vídeo)` : ''}`;
      } else if (ui.autoQty && ui.autoQty.checked) {
        // automática: a trava de segurança de params.js (30 por hora); o que decide é a relevância mínima e o filtro
        const cap = hours ? Math.min(300, Math.max(3, Math.ceil(30 * hours))) : null;
        ui.perHourOut.textContent = `automática${cap ? ` (até ${cap} neste vídeo)` : ''}`;
      } else {
        ui.perHourOut.textContent = `${per} por hora${total ? ` (até ${total} neste vídeo)` : ''}`;
      }
      ui.perHour.disabled = Boolean(state.running) || Boolean(ui.autoQty && ui.autoQty.checked) || Boolean(ui.bestOnly && ui.bestOnly.checked);
    }

    function readControls() {
      const ui = state.ui;
      const base = settings();
      return {
        signals: Object.fromEntries(SIGNALS.map((sig) => [sig.id, ui.signalBoxes[sig.id].checked])),
        profile: PROFILES.some((p) => p.id === ui.profile.value) ? ui.profile.value : base.profile,
        episodes: ui.episodes.checked,
        autoQuantity: ui.autoQty.checked,
        bestOnly: ui.bestOnly.checked,
        filterWeak: ui.filterWeak.checked,
        aiReview: ui.aiReview.checked,
        aiWindows: ui.aiWindows.checked,
        sensitivity: num(ui.sensitivity.value, base.sensitivity),
        perHour: num(ui.perHour.value, base.perHour),
        weights: Object.fromEntries(SIGNALS.map((sig) => [sig.id, Math.min(2, Math.max(0, num(ui.weights[sig.id].value, base.weights[sig.id])))])),
        textWeights: Object.fromEntries(TEXT_WEIGHTS.map((feat) => [feat.id, Math.min(2, Math.max(0, num(ui.textWeights[feat.id].value, base.textWeights[feat.id])))])),
        chat: {
          keywords: splitKeywords(ui.keywords.value),
          lagSec: Math.min(60, Math.max(0, num(ui.lag.value, base.chat.lagSec))),
          windowSec: Math.min(60, Math.max(2, num(ui.win.value, base.chat.windowSec)))
        },
        image: { fast: ui.fast.checked },
        engine: base.engine
      };
    }

    function onControlChange() {
      if (!BF.state.project) return;
      saveSettings(readControls());
      fillControls(); // mostra o valor que vale: um número fora da faixa foi limitado ao gravar e o campo não pode continuar dizendo outro
      renderRun(); // a dica de vídeo longo e o botão Analisar dependem dos ajustes
    }

    function resetSettings() {
      if (!BF.state.project) return;
      BF.project.update((project) => {
        project.ext = project.ext || {};
        const rest = { ...(project.ext.analysis || {}) };
        delete rest.settings;
        project.ext.analysis = rest;
      }, { reason: 'analysis:settings' });
      fillControls();
    }

    /** O que este vídeo não tem: faixa de áudio, chat baixado e transcrição (sinal ausente é ignorado, e a tela diz isso). */
    function missingSignals() {
      const project = BF.state.project;
      const info = BF.state.info;
      const t = state.transcript;
      return {
        noAudio: Boolean(info) && info.hasAudio === false,
        noChat: !project || !project.chat || !project.chat.path,
        noText: !t || !t.exists || Boolean(t.stale)
      };
    }

    /** Sinais ligados que este vídeo pode mesmo fornecer. Sem nenhum, analisar não faria nada. */
    function usableSignals() {
      const ui = state.ui;
      if (!ui.signalBoxes) return [];
      const { noAudio, noChat, noText } = missingSignals();
      return SIGNALS.filter((sig) => ui.signalBoxes[sig.id].checked && !(sig.id === 'audio' && noAudio) && !(sig.id === 'chat' && noChat) && !(sig.id === 'text' && noText) && !(sig.id === 'calm' && (noAudio || !ui.signalBoxes.audio.checked))).map((sig) => sig.id);
    }

    /** Explicações do que está disponível neste vídeo (sinal ausente é ignorado, e a tela diz isso). */
    function renderHints() {
      const ui = state.ui;
      if (!ui.signalHints) return;
      const { noAudio, noChat, noText } = missingSignals();
      for (const sig of SIGNALS) {
        let text = sig.hint;
        let off = false;
        if (sig.id === 'audio' && noAudio) { text = 'este vídeo não tem áudio: será ignorado'; off = true; }
        if (sig.id === 'calm' && (noAudio || !ui.signalBoxes.audio.checked)) { text = noAudio ? 'precisa do áudio do vídeo: será ignorado' : 'precisa do sinal de Áudio ligado: será ignorado'; off = true; }
        if (sig.id === 'chat' && noChat) { text = 'sem chat baixado (aba Novo projeto): será ignorado'; off = true; }
        if (sig.id === 'text' && noText) { text = 'sem transcrição deste vídeo (gere ou importe acima): será ignorado'; off = true; }
        ui.signalHints[sig.id].textContent = text;
        ui.signalBoxes[sig.id].disabled = off || state.running;
        ui.signalHints[sig.id].classList.toggle('an-off', off);
      }
      const p = prefValues();
      const limited = limitedPrefs();
      ui.prefsNote.textContent = `Margens e durações vêm das Preferências: ${p.padBeforeSec} s antes, ${p.padAfterSec} s depois, entre ${p.minDurationSec} e ${p.maxDurationSec} s, relevância mínima ${pct(p.minRelevance)}.${limited.length ? ` Atenção: ${limited.join('; ')}, então a análise usa o valor limitado.` : ''}`;
      syncOutputs();
    }

    function renderRun() {
      const ui = state.ui;
      if (!ui.run) return;
      const ffmpegMissing = !BF.state.tools.ffmpeg || !BF.state.tools.ffprobe;
      const noProject = !BF.state.project;
      const noSignal = !noProject && !usableSignals().length;
      const eng = engineChoice();
      const ai = usesAi(eng);
      const algo = usesAlgorithm(eng);
      const blockers = ai ? aiBlockers() : null;
      ui.run.disabled = state.running || noProject || (ai && !blockers.ok) || (algo && (ffmpegMissing || noSignal));
      ui.fresh.disabled = ui.run.disabled;
      ui.run.textContent = state.running ? 'Analisando…' : 'Analisar';
      ui.cancel.hidden = !state.running;
      ui.cancel.disabled = state.starting;
      ui.progressBox.hidden = !state.running;
      if (state.running) {
        const p = state.progress ? Math.min(1, Math.max(0, state.progress.p)) : 0;
        ui.progress.value = p;
        // tempo restante: pela etapa em andamento quando o processo principal a informa (stageP); senão, pela barra inteira, como antes
        const byStage = Boolean(state.stages);
        const left = byStage ? stageRemainingSec(state.stages) : remainingSec(p, state.startedAt);
        const after = byStage && state.progress && state.progress.phase === 'algorithm' ? ' (depois vem a IA)' : '';
        ui.progressText.textContent = `${state.progress ? state.progress.message : 'Preparando…'} ${Math.round(p * 100)}%${left !== null ? ` · ${eta(Math.round(left))}${byStage ? ' nesta etapa' : ''}${after}` : ''}`;
      }
      ui.ffmpegWarn.hidden = !algo || !ffmpegMissing;
      ui.signalWarn.hidden = !algo || !noSignal || state.running;
      if (ui.aiWindowsRow) ui.aiWindowsRow.hidden = !ai;
      if (ui.aiReviewRow) ui.aiReviewRow.hidden = !(algo && ai); // a conferência só existe quando os dois motores rodam
      ui.aiWarn.hidden = !ai || noProject || blockers.ok || state.running;
      if (ai && !ui.aiWarn.hidden) ui.aiWarn.textContent = blockers.why.join(' ');
      // vídeo longo: avisa que a imagem demora e que existe o modo rápido (nos ajustes avançados)
      const long = algo && Boolean(BF.state.info) && BF.state.info.duration > 3600 && !(ui.fast && ui.fast.checked);
      ui.longWarn.hidden = !long || state.running;
      // durante a análise os ajustes ficam travados (os sinais são tratados em renderHints)
      for (const control of ui.lockables) control.disabled = state.running;
      if ((ui.autoQty && ui.autoQty.checked) || (ui.bestOnly && ui.bestOnly.checked)) ui.perHour.disabled = true; // quantidade automática ou "só os melhores": o controle por hora não vale
      for (const button of Object.values(ui.engineButtons || {})) button.disabled = state.running;
      if (ui.tGenerate) renderTranscript();
      if (ui.aiLockables) for (const node of ui.aiLockables) node.disabled = state.running;
      if (ui.hCard) renderHumor(); // o perfil de humor também trava durante a análise
      if (ui.skillBox) renderSkill(); // e o guia de cortes
      if (ui.orPicker) ui.orPicker.bfPicker.setDisabled(state.running); // o seletor do OpenRouter também trava durante a análise
      renderHints();
      renderNotice();
      BF.ui.refreshTabs(); // o selo da aba mostra "…" enquanto analisa
    }

    function renderNotice() {
      const ui = state.ui;
      if (!ui.notice) return;
      const saved = current(); // avisos de uma análise de outro vídeo não valem aqui
      const items = [];
      if (state.notice && state.notice.fallback) {
        items.push(el('div', { class: 'an-note an-error', role: 'alert', id: 'anFallback' },
          el('span', { class: 'an-note-text' }, state.notice.text),
          // modelo recusado (nome errado, aposentado ou indisponível para a chave): a lista do provedor resolve
          state.notice.modelHelp ? el('button', { type: 'button', id: 'anModelHelp', class: 'sm', onclick: () => openModelList() }, 'Ver modelos disponíveis') : null,
          el('button', { type: 'button', id: 'anUseAlgorithm', class: 'sm', onclick: useAlgorithm }, 'Usar o algoritmo')));
      } else if (state.notice) items.push(el('p', { class: `an-note ${state.notice.kind === 'error' ? 'an-error' : ''}`, role: state.notice.kind === 'error' ? 'alert' : undefined }, state.notice.text));
      if (!state.running && saved && saved.warnings) {
        for (const w of saved.warnings) items.push(el('p', { class: 'an-note an-warn' }, `Aviso: ${w.message}`));
      }
      ui.notice.replaceChildren(...items);
    }

    return { scheduleResults, icon, field, switchRow, buildControls, fillControls, readControls, usableSignals, renderHints, renderRun, renderNotice };
  };
})();

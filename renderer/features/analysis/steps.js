'use strict';

/**
 * Aba "Análise" — o seletor de passos: Transcrição · Método · Ajustes · Sugestões. Fábrica como engine.js: analysis.js a chama com `A`.
 * Cada passo é uma seção da tela; só a do passo escolhido aparece (classe `an-section-on`, NÃO o atributo `hidden`: os elementos continuam
 * existindo e valendo para o resto da aba). Cada botão traz um selo de estado, para dar para ver de relance o que falta. O botão Analisar
 * (rodapé fixo) fica fora das seções e vale em qualquer passo.
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;
  const { ENGINES, usesAi, usesChat } = window.BFAnalysisLogic;

  window.BFAnalysisParts = window.BFAnalysisParts || {};
  window.BFAnalysisParts.steps = function (A) {
    const { state } = A;

    const STEPS = [
      { id: 'transcript', label: 'Transcrição', icon: 'subtitles' },
      { id: 'method', label: 'Método', icon: 'tune' },
      { id: 'settings', label: 'Ajustes', icon: 'instant_mix' },
      { id: 'results', label: 'Sugestões', icon: 'auto_awesome' }
    ];

    /** Cria o seletor e as quatro seções com o conteúdo dado: { transcript, method, settings, results } -> lista de nós de cada uma. */
    function buildSteps(content) {
      const ui = state.ui;
      ui.stepButtons = {};
      ui.stepBadges = {};
      ui.sections = {};
      const buttons = STEPS.map((step, i) => {
        const badge = el('span', { class: 'an-step-badge', id: `anStepBadge-${step.id}` });
        const button = el('button', {
          type: 'button', id: `anStep-${step.id}`, class: 'an-step', role: 'tab', 'aria-selected': 'false', 'aria-controls': `anSection-${step.id}`,
          dataset: { step: step.id }, onclick: () => showStep(step.id)
        }, el('span', { class: 'an-step-num', 'aria-hidden': 'true' }, String(i + 1)), el('span', { class: 'an-step-label' }, step.label), badge);
        ui.stepButtons[step.id] = button;
        ui.stepBadges[step.id] = badge;
        return button;
      });
      ui.steps = el('div', { class: 'an-steps', id: 'anSteps', role: 'tablist', 'aria-label': 'Passos da análise' }, buttons);
      ui.resultsEmpty = el('p', { class: 'an-note an-info small', id: 'anResultsEmpty' }, 'Ainda não há sugestões. Escolha o método, confira os ajustes e use Analisar (ou cole a resposta de uma IA de chat no passo Método).');
      for (const step of STEPS) {
        const nodes = content[step.id] || [];
        ui.sections[step.id] = el('section', { class: 'an-section', id: `anSection-${step.id}`, role: 'tabpanel', 'aria-label': step.label }, ...(step.id === 'results' ? [ui.resultsEmpty, ...nodes] : nodes));
      }
      return { nav: ui.steps, sections: STEPS.map((s) => ui.sections[s.id]) };
    }

    const visibleCount = () => A.visible().length;

    /** O passo em que a tela abre para este vídeo: Sugestões se já há, senão Transcrição se falta, senão Método. */
    function initialStep() {
      if (visibleCount() > 0) return 'results';
      const t = state.transcript;
      if (t && !(t.exists && !t.stale)) return 'transcript';
      return 'method';
    }

    function showStep(id) {
      if (!STEPS.some((s) => s.id === id)) return;
      state.step = id;
      state.stepSet = true;
      renderSteps();
    }

    function renderSteps() {
      const ui = state.ui;
      if (!ui.steps) return;
      const project = BF.state.project;
      const key = project ? project.id : null;
      if (state.stepFor !== key) { state.stepFor = key; state.stepSet = false; state.step = 'method'; }
      // o passo inicial só vale quando já se sabe se há transcrição (a leitura é assíncrona)
      if (!state.stepSet && (state.transcript !== null || visibleCount() > 0)) { state.step = initialStep(); state.stepSet = true; }
      const step = state.step || 'method';
      for (const s of STEPS) {
        const on = s.id === step;
        ui.stepButtons[s.id].setAttribute('aria-selected', String(on));
        ui.stepButtons[s.id].classList.toggle('active', on);
        ui.stepButtons[s.id].tabIndex = on ? 0 : -1;
        ui.sections[s.id].classList.toggle('an-section-on', on);
      }
      // selos de estado
      const t = state.transcript;
      const hasT = Boolean(t && t.exists && !t.stale);
      const tRunning = Boolean(state.tjob) || state.tstarting;
      const engine = A.engineChoice();
      const badge = (id, text, kind) => {
        const b = ui.stepBadges[id];
        b.textContent = text;
        b.className = `an-step-badge${kind ? ` an-step-${kind}` : ''}`;
        b.hidden = !text;
      };
      badge('transcript', tRunning ? 'em andamento' : (hasT ? 'pronta' : (usesAi(engine) || usesChat(engine) ? 'falta' : 'opcional')), tRunning ? 'info' : (hasT ? 'ok' : (usesAi(engine) || usesChat(engine) ? 'warn' : '')));
      const eng = ENGINES.find((e) => e.id === engine);
      badge('method', eng ? eng.label : '', '');
      badge('settings', '', '');
      const count = visibleCount();
      badge('results', state.running ? 'analisando…' : (count ? String(count) : ''), state.running ? 'info' : (count ? 'ok' : ''));
      // a lista só aparece com resultado: sem ele, o aviso explica o que fazer
      ui.resultsEmpty.hidden = !ui.results || !ui.results.hidden;
    }

    /** Teclado do seletor: ←/→ andam entre os passos, Home e End vão às pontas. */
    function onStepKey(event) {
      const ids = STEPS.map((s) => s.id);
      const at = ids.indexOf(state.step || 'method');
      let next = -1;
      if (event.key === 'ArrowRight') next = (at + 1) % ids.length;
      else if (event.key === 'ArrowLeft') next = (at - 1 + ids.length) % ids.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = ids.length - 1;
      if (next < 0) return;
      event.preventDefault();
      showStep(ids[next]);
      state.ui.stepButtons[ids[next]].focus();
    }

    return { buildSteps, renderSteps, showStep, onStepKey };
  };
})();

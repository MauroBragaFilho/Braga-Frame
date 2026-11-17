'use strict';

/**
 * Aba "Análise" — Perfil de humor do canal: o cartão (critérios, bordões, palavras de reação, exemplos) e o perfil em vigor (canal > jogo > geral).
 * Tirado de features/analysis.js (Etapa 2, 17/11/2026) sem mudar o comportamento. É uma FÁBRICA: analysis.js a chama com o que ela
 * precisa do resto da aba (`A`: estado e funções) e recebe de volta o que ela oferece. Carrega ANTES de analysis.js (renderer/index.html).
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;
  const H = window.BFHumor;
  const { plural, humorSummary } = window.BFAnalysisLogic;

  window.BFAnalysisParts = window.BFAnalysisParts || {};
  window.BFAnalysisParts.humor = function (A) {
    const { state } = A;
    const field = (...args) => A.field(...args);
    const switchRow = (...args) => A.switchRow(...args);
    const refreshEstimate = (...args) => A.refreshEstimate(...args);

    const HUMOR_KEY = 'analysis.humor';

    const SCOPE_WORD = { channel: 'canal', game: 'jogo' };

    /** Perfil de humor em vigor para este vídeo (canal > jogo > geral), já limpo; null quando não há ou está vazio. */
    function humorProfile() {
      const saved = BF.prefs.get(HUMOR_KEY, null);
      if (!saved || typeof saved !== 'object') return null;
      const profile = H.normalizeProfile(saved);
      return H.isEmpty(profile) ? null : profile;
    }

    /** O que o ALGORITMO usa do perfil: bordões e palavras de reação (listas vazias sem perfil). */
    const humorLists = () => H.forAlgorithm(humorProfile());

    /** De onde vem o perfil em vigor: { scope: 'channel'|'game'|'general', name }; null sem perfil. */
    function humorOrigin() {
      if (!humorProfile()) return null;
      const why = BF.prefs.explain(HUMOR_KEY);
      if (!why || why.source === 'default') return null;
      return { scope: why.scope === 'channel' || why.scope === 'game' ? why.scope : 'general', name: why.scopeName || '' };
    }

    const originText = (origin) => (origin.scope === 'general' ? 'todos os vídeos' : `${SCOPE_WORD[origin.scope]} ${origin.name}`.trim());

    // ---------- desenho: perfil de humor do canal ----------

    /** Rascunho da tela como perfil limpo (o que seria salvo). */
    const humorDraft = () => H.normalizeProfile({
      criteria: state.ui.hCriteria.value, catchphrases: state.ui.hPhrases.value, reactions: state.ui.hReactions.value, themes: state.ui.hThemes.value, examples: state.ui.hExamples.checked
    });

    /** Onde o perfil pode ser salvo: o canal e o jogo do projeto aberto (se têm nome) ou todos os vídeos. */
    function humorScopes() {
      // a aba monta antes de features/prefs.js carregar: nesse instante BF.prefs é só o esboço de app.js (sem `scope`)
      const names = typeof BF.prefs.scope === 'function' ? BF.prefs.scope() : { game: '', channel: '' };
      return [
        ['channel', names.channel ? `Canal: ${names.channel}` : 'Canal (defina em Preferências)', Boolean(names.channel)],
        ['game', names.game ? `Jogo: ${names.game}` : 'Jogo (defina em Preferências)', Boolean(names.game)],
        ['general', 'Todos os vídeos', true]
      ];
    }

    function fillHumor(profile) {
      const ui = state.ui;
      const p = profile || H.normalizeProfile(null);
      const set = (node, value) => { if (node.value !== value) node.value = value; }; // não mexe no cursor de quem está digitando
      set(ui.hCriteria, p.criteria);
      set(ui.hPhrases, H.listText(p.catchphrases));
      set(ui.hReactions, H.listText(p.reactions));
      set(ui.hThemes, H.listText(p.themes));
      ui.hExamples.checked = p.examples;
    }

    function onHumorEdit() {
      state.hDirty = true;
      renderHumor();
    }

    function exampleItem(example, kind) {
      const meta = [`${example.durationSec} s`, example.category, example.exported ? 'exportado' : ''].filter(Boolean).join(' · ');
      return el('li', { class: 'an-drop an-ex' },
        el('span', { class: 'an-ex-head' },
          el('strong', {}, example.title || 'Sem título'),
          el('span', { class: `bds-chip ${kind === 'approved' ? 'bds-chip-ok' : 'bds-chip-warn'}` }, kind === 'approved' ? 'aprovado' : 'rejeitado')),
        el('span', { class: 'muted small' }, meta),
        el('span', { class: 'small an-ex-text' }, `“${example.text}”`));
    }

    function buildHumor() {
      const ui = state.ui;
      ui.hChip = el('span', { class: 'bds-chip', id: 'anHChip' });
      ui.hLine = el('p', { class: 'small', id: 'anHLine' });
      ui.hConfigTitle = el('summary', {}, 'Definir o perfil');
      ui.hCriteria = el('textarea', {
        id: 'anHCriteria', rows: '4', maxlength: String(H.LIMITS.criteria), spellcheck: 'true', oninput: onHumorEdit,
        placeholder: 'Ex.: humor seco e inesperado; reação exagerada a um erro bobo; não gosto de grito sem graça nem de explicação longa.'
      });
      ui.hCount = el('span', { class: 'muted small an-count', id: 'anHCount' });
      ui.hPhrases = el('input', { type: 'text', id: 'anHPhrases', placeholder: 'bora, beco moleque, que isso…', autocomplete: 'off', spellcheck: 'false', oninput: onHumorEdit });
      ui.hReactions = el('input', { type: 'text', id: 'anHReactions', placeholder: 'eita, tenso, sinistro…', autocomplete: 'off', spellcheck: 'false', oninput: onHumorEdit });
      ui.hThemes = el('input', { type: 'text', id: 'anHThemes', placeholder: 'piadas, cenas de história, jogadas…', autocomplete: 'off', spellcheck: 'false', oninput: onHumorEdit });
      ui.hExamples = el('input', { type: 'checkbox', id: 'anHExamples', class: 'bds-switch', role: 'switch', onchange: onHumorEdit });
      ui.hExamplesHint = el('span', { class: 'small', id: 'anHExamplesHint' });
      ui.hExamplesNote = el('p', { class: 'muted small', id: 'anHExamplesNote' });
      ui.hExamplesList = el('ul', { class: 'an-droplist', id: 'anHExamplesList' });
      ui.hExamplesBox = el('details', { class: 'an-sub', id: 'anHExamplesBox', ontoggle: () => { if (ui.hExamplesBox.open) refreshHumorExamples(); } },
        el('summary', {}, 'Ver os exemplos que iriam'), ui.hExamplesNote, ui.hExamplesList);
      ui.hScope = el('select', { id: 'anHScope', 'aria-label': 'Onde salvar o perfil de humor', onchange: () => { ui.hScope.dataset.touched = '1'; } });
      ui.hSave = el('button', { type: 'button', id: 'anHSave', class: 'primary sm', onclick: saveHumor }, 'Salvar');
      ui.hClear = el('button', { type: 'button', id: 'anHClear', class: 'secondary sm', onclick: clearHumor }, 'Limpar');
      ui.hStatus = el('p', { class: 'muted small', id: 'anHStatus', role: 'status' });
      ui.hLockables = [ui.hCriteria, ui.hPhrases, ui.hReactions, ui.hThemes, ui.hExamples, ui.hScope, ui.hSave, ui.hClear];
      ui.hConfig = el('details', { class: 'an-config', id: 'anHConfig' },
        ui.hConfigTitle,
        el('div', { class: 'an-adv-body' },
          el('label', { class: 'an-field an-field-wide' },
            el('span', { class: 'an-split' }, el('span', { class: 'an-field-label' }, 'Critérios (para a IA)'), ui.hCount),
            ui.hCriteria,
            el('span', { class: 'muted small' }, 'O que faz um corte ser bom no seu canal, com as suas palavras.')),
          field('Bordões do canal', ui.hPhrases, 'Separados por vírgula. O algoritmo dá peso às falas que os contêm e a IA os recebe.', true),
          field('Palavras e reações', ui.hReactions, 'Separadas por vírgula. Contam como exclamação no algoritmo.', true),
          field('Temas do canal', ui.hThemes, 'Separados por vírgula. Só a IA usa: ela prefere esses assuntos, distribui os cortes entre eles e marca o tema de cada um.', true),
          switchRow('an-switch-row', 'anHExamples', 'Mostrar à IA cortes que aprovei e rejeitei', ui.hExamplesHint, ui.hExamples),
          ui.hExamplesBox,
          el('div', { class: 'an-adv-actions' }, field('Salvar para', ui.hScope), ui.hSave, ui.hClear),
          ui.hStatus));
      ui.hCard = el('div', { class: 'an-card an-humor', id: 'anHumor' },
        el('div', { class: 'an-split' }, el('strong', {}, 'Perfil de humor do canal'), ui.hChip),
        ui.hLine,
        ui.hConfig);
    }

    function renderHumor() {
      const ui = state.ui;
      if (!ui.hCard) return;
      const profile = humorProfile();
      const origin = humorOrigin();
      ui.hChip.className = `bds-chip${profile ? ' bds-chip-ok' : ''}`;
      ui.hChip.textContent = profile ? 'Em uso' : 'Não definido';
      ui.hLine.textContent = profile
        ? `${humorSummary(profile)}${origin ? ` · salvo para ${originText(origin)}` : ''}`
        : 'Diga o que é um bom corte do seu canal: a IA recebe os critérios e o algoritmo conta os bordões e as reações.';
      ui.hConfigTitle.textContent = profile ? 'Editar o perfil' : 'Definir o perfil';
      // o rascunho de quem está editando nunca é sobrescrito; fora disso a tela mostra o perfil em vigor
      if (!state.hDirty && !ui.hCard.contains(document.activeElement)) fillHumor(profile);
      const draft = humorDraft();
      const changed = JSON.stringify(draft) !== JSON.stringify(profile || H.normalizeProfile(null));
      ui.hCount.textContent = `${ui.hCriteria.value.length}/${H.LIMITS.criteria}`;
      // onde salvar: a escolha do usuário vale enquanto existir; sem escolha, onde o perfil em vigor está salvo ou o mais específico disponível
      const scopes = humorScopes();
      const signature = JSON.stringify([scopes, origin ? origin.scope : '']);
      if (ui.hScope.dataset.sig !== signature) {
        const keep = ui.hScope.value;
        ui.hScope.replaceChildren(...scopes.map(([value, label, ok]) => el('option', { value, disabled: !ok }, label)));
        ui.hScope.dataset.sig = signature;
        const chosen = ui.hScope.dataset.touched ? scopes.find(([value, , ok]) => ok && value === keep) : null;
        const where = origin ? scopes.find(([value, , ok]) => ok && value === origin.scope) : null;
        ui.hScope.value = (chosen || where || scopes.find(([, , ok]) => ok))[0];
      }
      // exemplos: o que a IA receberia (lista consultada ao abrir a caixa)
      const on = ui.hExamples.checked;
      ui.hExamplesHint.textContent = on
        ? `A IA recebe até ${H.LIMITS.examplesPositive} cortes aprovados e ${H.LIMITS.examplesNegative} rejeitados deste canal (só o texto da fala, até ${H.LIMITS.exampleChars} caracteres cada).`
        : 'A IA recebe só os critérios e as listas.';
      ui.hExamplesBox.hidden = !on;
      const ex = state.hExamples;
      if (!ex) {
        ui.hExamplesNote.textContent = 'Consultando os cortes do canal…';
        ui.hExamplesList.replaceChildren();
      } else {
        const total = ex.approved.length + ex.rejected.length;
        ui.hExamplesNote.textContent = total
          ? `${plural(ex.approved.length, 'aprovado', 'aprovados')} e ${plural(ex.rejected.length, 'rejeitado', 'rejeitados')}, de ${plural(ex.projects, 'projeto', 'projetos')} do canal. É exatamente isto que a IA recebe como exemplo.`
          : 'Ainda não há cortes aprovados ou rejeitados, com transcrição guardada, nos projetos deste canal.';
        ui.hExamplesList.replaceChildren(...ex.approved.map((e) => exampleItem(e, 'approved')), ...ex.rejected.map((e) => exampleItem(e, 'rejected')));
      }
      // botões e aviso
      for (const node of ui.hLockables) node.disabled = state.running;
      ui.hSave.hidden = !changed; // "Salvar" só aparece quando há o que salvar
      ui.hSave.disabled = state.running || H.isEmpty(draft);
      ui.hClear.hidden = !origin;
      if (state.hDirty && changed) ui.hStatus.textContent = H.isEmpty(draft) ? 'Escreva ao menos um critério, um bordão ou uma palavra de reação para salvar.' : 'Alterações ainda não salvas.';
      else ui.hStatus.textContent = origin ? `Vale para as próximas análises ${origin.scope === 'general' ? 'de todos os vídeos' : `dos vídeos do ${originText(origin)}`}.` : '';
    }

    /** Consulta os cortes aprovados/rejeitados do canal que iriam como exemplo (nada é enviado). */
    let examplesSeq = 0;

    async function refreshHumorExamples() {
      const seq = ++examplesSeq;
      const project = BF.state.project;
      state.hExamples = null;
      renderHumor();
      if (!project) return;
      const res = await BF.api('analysis:humorExamples', { projectId: project.id });
      if (seq !== examplesSeq || BF.state.project !== project) return; // chegou depois de a situação mudar
      state.hExamples = res.ok && res.examples ? res.examples : { approved: [], rejected: [], projects: 0 };
      renderHumor();
    }

    async function saveHumor() {
      const ui = state.ui;
      const draft = humorDraft();
      if (state.running || H.isEmpty(draft)) return;
      ui.hSave.disabled = true;
      const res = await BF.prefs.set(HUMOR_KEY, draft, ui.hScope.value);
      if (!res.ok) {
        BF.ui.toast(res.message || 'Não foi possível salvar o perfil de humor.', 'error');
        renderHumor();
        return;
      }
      state.hDirty = false;
      BF.ui.toast('Perfil de humor salvo. A próxima análise já o usa.', 'ok');
      fillHumor(humorProfile());
      renderHumor();
      ui.hConfigTitle.focus(); // o botão Salvar some depois de salvar: o foco vai para o título da seção
      refreshEstimate();
      if (ui.hExamplesBox.open) refreshHumorExamples();
    }

    async function clearHumor() {
      const origin = humorOrigin();
      if (!origin || state.running) return;
      const ok = await BF.ui.confirm({
        title: 'Limpar o perfil de humor?',
        message: `O perfil salvo para ${originText(origin)} será removido. Se houver um perfil mais geral, ele passa a valer; senão as análises voltam a usar só os critérios do app.`,
        okLabel: 'Limpar', cancelLabel: 'Manter', danger: true
      });
      if (!ok) return;
      const res = await BF.prefs.unset(HUMOR_KEY, origin.scope);
      if (!res.ok) { BF.ui.toast(res.message || 'Não foi possível limpar o perfil de humor.', 'error'); return; }
      state.hDirty = false;
      BF.ui.toast('Perfil de humor removido.', 'ok');
      fillHumor(humorProfile());
      renderHumor();
      state.ui.hConfigTitle.focus(); // o botão Limpar some depois de limpar: o foco vai para o título da seção
      refreshEstimate();
      if (state.ui.hExamplesBox.open) refreshHumorExamples();
    }

    return { HUMOR_KEY, humorProfile, humorLists, buildHumor, renderHumor, refreshHumorExamples };
  };
})();

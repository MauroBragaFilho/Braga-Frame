'use strict';

/**
 * Aba "Análise" — Provedor de IA na nuvem: chave, modelo, aviso de privacidade, limites, provedores de reserva, OpenRouter (modelos gratuitos), guia de cortes e a estimativa antes de rodar.
 * Tirado de features/analysis.js (Etapa 2, 17/11/2026) sem mudar o comportamento. É uma FÁBRICA: analysis.js a chama com o que ela
 * precisa do resto da aba (`A`: estado e funções) e recebe de volta o que ela oferece. Carrega ANTES de analysis.js (renderer/index.html).
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;
  const { num, usesAi, plural } = window.BFAnalysisLogic;

  window.BFAnalysisParts = window.BFAnalysisParts || {};
  window.BFAnalysisParts.provider = function (A) {
    const { state } = A;
    const engineChoice = (...args) => A.engineChoice(...args);
    const humorProfile = (...args) => A.humorProfile(...args);
    const ensureConsent = (...args) => A.ensureConsent(...args);
    const icon = (...args) => A.icon(...args);
    const field = (...args) => A.field(...args);
    const switchRow = (...args) => A.switchRow(...args);
    const generateTranscript = (...args) => A.generateTranscript(...args);
    const cancelTranscript = (...args) => A.cancelTranscript(...args);
    const installTranscription = (...args) => A.installTranscription(...args);
    const importTranscript = (...args) => A.importTranscript(...args);
    const removeTranscript = (...args) => A.removeTranscript(...args);
    const renderTranscript = (...args) => A.renderTranscript(...args);
    const renderAll = (...args) => A.renderAll(...args);

    async function refreshAi() {
      const res = await BF.api('analysis:aiState');
      state.ai = res.ok && res.ai ? res.ai : null;
      renderAll();
    }

    /** O provedor em uso é o OpenRouter do Braga Frame (não o do hospedeiro) e os componentes dele estão carregados? */
    const isOpenRouterLocal = (ai) => Boolean(BF.aiOpenRouter && ai && ai.source === 'local' && ai.provider && ai.provider.id === 'openrouter');

    /** O pedido vai gastar os pedidos GRATUITOS do dia? (modo gratuito ligado, ou o modelo é o roteador gratuito / `:free`) */
    const usesFreeRequests = (ai) => isOpenRouterLocal(ai) && (ai.provider.freeOnly !== false || ai.provider.model === 'openrouter/free' || /:free$/.test(String(ai.provider.model || '')));

    let estimateSeq = 0;

    async function refreshEstimate() {
      const seq = ++estimateSeq;
      const project = BF.state.project;
      state.estimate = null;
      state.orFree = null;
      if (!project || !usesAi(engineChoice()) || !state.ai || !state.ai.ready || !state.transcript || !state.transcript.exists || state.transcript.stale) { renderAi(); return; }
      const profile = humorProfile();
      const res = await BF.api('analysis:aiEstimate', {
        projectId: project.id, path: project.source.path, size: project.source.size || 0, duration: project.source.duration || 0,
        params: {}, chatPath: project.chat && project.chat.path ? project.chat.path : null, ...(profile ? { profile } : {}),
        ...(state.ui && state.ui.aiWindows && state.ui.aiWindows.checked ? { aiWindows: true } : {})
      });
      if (seq !== estimateSeq || BF.state.project !== project) return; // chegou depois de a situação mudar
      state.estimate = res.ok && res.estimate ? res.estimate : null;
      renderAi();
      // OpenRouter: compara a estimativa com os pedidos gratuitos que restam hoje (a chave fica no processo principal). Avisa; não bloqueia.
      if (state.estimate && usesFreeRequests(state.ai)) {
        const free = await BF.api('aiOpenrouter:limits', { calls: state.estimate.calls });
        if (seq !== estimateSeq || BF.state.project !== project) return;
        state.orFree = free.ok && free.estimate && free.estimate.message ? free.estimate : null;
        renderAi();
      }
    }

    async function saveAi(patch) {
      const res = await BF.api('analysis:aiSave', patch);
      if (!res.ok) {
        BF.ui.toast(res.message || 'Não foi possível salvar a configuração da IA.', 'error');
        await refreshAi();
        return false;
      }
      state.ai = res.ai || state.ai;
      state.test = null;
      renderAll();
      refreshEstimate();
      // a chave (ou o provedor) mudou: o selo de pedidos gratuitos do OpenRouter consulta de novo (some sem chave)
      if (state.ui.orChip && (patch.apiKey !== undefined || patch.clearKey === true || patch.provider !== undefined)) state.ui.orChip.refresh({ force: true });
      return true;
    }

    async function saveKey() {
      const ui = state.ui;
      const value = ui.cfgKey.value;
      ui.cfgKey.value = ''; // a chave nunca fica na tela
      if (!value.trim()) return;
      if (await saveAi({ apiKey: value })) BF.ui.toast('Chave guardada neste computador.', 'ok');
    }

    async function clearKey() {
      const ok = await BF.ui.confirm({ title: 'Remover a chave?', message: 'A chave guardada neste computador será apagada. Você precisará informá-la de novo para usar este provedor.', okLabel: 'Remover', cancelLabel: 'Manter', danger: true });
      if (ok) await saveAi({ clearKey: true });
    }

    async function changeBaseUrl() {
      const ui = state.ui;
      const value = ui.cfgBaseUrl.value.trim();
      const p = state.ai && state.ai.provider;
      if (p && (p.hasKey || state.ai.accepted) && value !== p.baseUrl) {
        let otherServer = true;
        try { otherServer = new URL(value).origin !== new URL(p.baseUrl).origin; } catch { otherServer = true; }
        const ok = await BF.ui.confirm({
          title: 'Trocar o endereço?',
          message: [
            'Outro endereço é outro destinatário: o aviso de privacidade precisa ser aceito de novo.',
            p.hasKey && otherServer ? 'A chave guardada também é apagada (ela nunca é reenviada a um servidor novo).' : ''
          ].filter(Boolean).join('\n\n'),
          okLabel: 'Trocar', cancelLabel: 'Manter', danger: true
        });
        if (!ok) { renderAi(); return; }
      }
      await saveAi({ baseUrl: value });
    }

    /** Busca no provedor a lista de modelos que a chave guardada pode usar (o processo principal faz o pedido; a chave não passa por aqui). */
    async function loadModels() {
      state.modelsBusy = true;
      state.modelsMsg = { kind: 'muted', text: 'Buscando os modelos no provedor…' };
      renderAi();
      const res = await BF.api('analysis:aiModels');
      state.modelsBusy = false;
      if (!res.ok) {
        state.models = null;
        state.modelsMsg = { kind: 'bad', text: res.message || 'Não foi possível buscar a lista de modelos.' };
      } else {
        const list = Array.isArray(res.models) ? res.models : [];
        state.models = { provider: res.provider, list };
        state.modelsMsg = list.length
          ? { kind: 'good', text: `${plural(list.length, 'modelo disponível', 'modelos disponíveis')} neste provedor${res.hidden ? (res.hidden === 1 ? ' (1 outro, de embedding, voz ou imagem, ficou de fora)' : ` (${res.hidden} outros, de embedding, voz ou imagem, ficaram de fora)`) : ''}. Escolha na lista.` }
          : { kind: 'muted', text: 'O provedor não informou nenhum modelo de conversa. Digite o nome do modelo.' };
      }
      renderAi();
    }

    function pickModel() {
      const id = state.ui.cfgModelPick.value;
      if (!id) return;
      state.ui.cfgModel.value = id;
      saveAi({ model: id });
    }

    /** Do aviso de "modelo recusado": abre o cartão do provedor e busca a lista. */
    async function openModelList() {
      const ui = state.ui;
      ui.aiConfig.open = true;
      try { ui.cfgModelField.scrollIntoView({ block: 'center' }); } catch { /* sem rolagem no ambiente de teste */ }
      await loadModels();
    }

    // ---------- guia de cortes (skill): o texto que ensina a IA a escolher ----------

    /** Busca o guia em uso (o do usuário ou o padrão do app). Só ao abrir a caixa: nada é pedido antes. */
    async function loadSkill() {
      const res = await BF.api('analysis:aiSkill');
      if (res.ok && res.skill) { state.skill = res.skill; state.skillDraft = false; state.skillMsg = null; }
      else state.skillMsg = { ok: false, text: res.message || 'Não foi possível ler o guia de cortes.' };
      renderSkill();
    }

    async function saveSkill() {
      const ui = state.ui;
      if (!state.skill || state.running) return;
      const res = await BF.api('analysis:aiSkillSave', { text: ui.skillText.value });
      if (res.ok && res.skill) {
        state.skill = res.skill;
        state.skillDraft = false;
        state.skillMsg = { ok: true, text: res.skill.source === 'custom' ? 'Guia salvo. Vale a partir da próxima análise.' : 'O texto é igual ao guia do app: continua valendo o padrão.' };
        refreshEstimate();
      } else state.skillMsg = { ok: false, text: res.message || 'Não foi possível salvar o guia.' };
      renderSkill();
    }

    async function resetSkill() {
      if (!state.skill || state.running) return;
      const ok = await BF.ui.confirm({ title: 'Restaurar o guia do app?', message: 'O seu guia de cortes será apagado e volta a valer o guia padrão do app.', okLabel: 'Restaurar o padrão', cancelLabel: 'Cancelar' });
      if (!ok) return;
      const res = await BF.api('analysis:aiSkillReset');
      if (res.ok && res.skill) {
        state.skill = res.skill;
        state.skillDraft = false;
        state.skillMsg = { ok: true, text: 'Voltou a valer o guia padrão do app.' };
        refreshEstimate();
      } else state.skillMsg = { ok: false, text: res.message || 'Não foi possível restaurar o guia.' };
      renderSkill();
    }

    function renderSkill() {
      const ui = state.ui;
      if (!ui.skillBox) return;
      const s = state.skill;
      const custom = Boolean(s) && s.source === 'custom';
      ui.skillChip.hidden = !s;
      ui.skillChip.textContent = custom ? 'Personalizado' : 'Padrão';
      ui.skillChip.className = `bds-chip${custom ? ' bds-chip-accent' : ''}`;
      if (s && !state.skillDraft && ui.skillText.value !== s.text) ui.skillText.value = s.text; // o que a pessoa está digitando não é sobrescrito
      const edited = Boolean(s) && ui.skillText.value !== s.text;
      const n = ui.skillText.value.length;
      ui.skillInfo.textContent = !s
        ? 'Carregando o guia…'
        : `${custom ? 'O seu guia' : 'Guia padrão do app'} · ${n.toLocaleString('pt-BR')} caracteres (cerca de ${Math.ceil(n / 3.2).toLocaleString('pt-BR')} tokens em cada chamada; máximo de ${s.maxChars.toLocaleString('pt-BR')} caracteres)${edited ? ' · alterado, ainda não salvo' : ''}`;
      ui.skillText.disabled = state.running || !s;
      ui.skillSave.disabled = state.running || !s || !edited;
      ui.skillReset.disabled = state.running || !custom;
      ui.skillOut.textContent = state.skillMsg ? state.skillMsg.text : '';
      ui.skillOut.className = `small${state.skillMsg && state.skillMsg.ok === false ? ' an-error' : ''}`;
    }

    async function testConnection() {
      const ui = state.ui;
      ui.cfgTest.disabled = true;
      state.test = { ok: null, text: 'Testando…' };
      renderAi();
      const res = await BF.api('analysis:aiTest');
      state.test = res.ok ? { ok: true, text: res.message || 'Conexão ok.' } : { ok: false, text: res.message || 'A conexão falhou.' };
      renderAi();
    }

    async function toggleAccept() {
      const ui = state.ui;
      if (ui.cfgAccept.checked) {
        ui.cfgAccept.checked = false; // só marca depois de o usuário ler e aceitar o aviso
        await ensureConsent();
        renderAi();
        return;
      }
      const res = await BF.api('analysis:aiAccept', { accepted: false });
      if (res.ok && res.ai) state.ai = res.ai;
      renderAll();
    }

    const fmtN = (n) => Number(n).toLocaleString('pt-BR');

    /** Grava os provedores de reserva, na ordem dos três campos (sem repetir). */
    function saveFallback() {
      const ids = [];
      for (const select of state.ui.fbSelects) if (select.value && !ids.includes(select.value)) ids.push(select.value);
      saveAi({ fallback: ids });
    }

    /** O aviso de privacidade de um provedor de reserva: sem ele, nada é enviado a esse provedor. */
    async function acceptFallback(provider) {
      if (await ensureConsent(provider)) renderAll();
    }

    /** Os provedores de reserva: os três campos, o que falta em cada um e o aviso de blocos menores. */
    function renderProviderFallback(ai, host) {
      const ui = state.ui;
      const fb = ai && !host ? ai.fallback : null;
      ui.fbBox.hidden = !fb;
      if (!fb) return;
      const options = Array.isArray(fb.options) ? fb.options : [];
      const chosen = (Array.isArray(fb.ids) ? fb.ids : []).filter((id) => id !== ai.selected);
      const key = options.map((o) => o.id).join();
      ui.fbSelects.forEach((select, i) => {
        if (select.dataset.key !== key) { // só refaz as opções quando mudam (redesenhar com a lista aberta a fecharia)
          select.replaceChildren(el('option', { value: '' }, 'Nenhum'), ...options.map((o) => el('option', { value: o.id }, o.label)));
          select.dataset.key = key;
        }
        select.value = chosen[i] && options.some((o) => o.id === chosen[i]) ? chosen[i] : '';
      });
      ui.fbList.replaceChildren(...(fb.providers || []).map((q) => {
        let chip = ['bds-chip-ok', 'Pronto'];
        if (!q.ready) chip = ['bds-chip-warn', 'Falta configurar'];
        else if (!q.usable) chip = ['bds-chip-warn', 'Limite baixo'];
        else if (!q.accepted) chip = ['bds-chip-warn', 'Aviso pendente'];
        const limit = q.tokensPerMinute ? `${fmtN(q.tokensPerMinute)} tokens por minuto` : 'limite por minuto ainda não conhecido (use "Testar conexão" nele)';
        const detail = [q.model ? `${q.label} · ${q.model}` : q.label, limit, !q.ready ? q.reason : '', q.note].filter(Boolean).join(' · ');
        return el('li', { class: 'an-fb-item' },
          el('span', { class: `bds-chip ${chip[0]}` }, chip[1]),
          el('span', { class: 'small' }, detail),
          q.ready && q.usable && !q.accepted ? el('button', { type: 'button', class: 'sm an-fb-accept', onclick: () => acceptFallback(q) }, 'Aceitar aviso') : null);
      }));
      const eff = ai.effectiveLimits;
      const lim = eff && eff.limitedBy;
      ui.fbNote.hidden = !lim;
      ui.fbNote.textContent = lim
        ? `Blocos menores: o limite de ${fmtN(lim.tokensPerMinute)} tokens por minuto de ${lim.label} faz a análise usar até ~${fmtN(eff.maxInputTokens)} tokens por chamada (o seu limite é ${fmtN(ai.limits.maxInputTokens)}). Isso gera mais chamadas: confira a estimativa antes de analisar, e aumente "Chamadas por análise" se precisar. Tirar ${lim.label} das reservas volta aos blocos de sempre.`
        : '';
    }

    function changeLimit(key, input) {
      const n = num(input.value, null);
      if (n === null) { renderAi(); return; }
      saveAi({ limits: { [key]: n } });
    }

    // ---------- OpenRouter: seletor de modelos, selo de pedidos gratuitos e modelos de reserva ----------

    /** O modelo em texto para a tela: o roteador gratuito tem nome próprio. */
    function modelLabel(p) {
      return p.id === 'openrouter' && p.model === 'openrouter/free' ? 'Automático — roteador gratuito' : p.model;
    }

    /** Cria (uma vez) o seletor de modelos e o selo de limites do OpenRouter. O seletor busca a lista pública ao nascer; nada sai antes da escolha do usuário. */
    function buildOpenRouter(p) {
      const ui = state.ui;
      ui.orPicker = BF.aiOpenRouter.createModelPicker({
        value: p.model || '',
        freeOnly: p.freeOnly !== false,
        onChange: (id) => { saveAi({ model: id }).then((ok) => { if (ok && ui.orChip) ui.orChip.refresh(); }); },
        onFreeOnlyChange: (on) => { saveAi({ freeOnly: on }); }
      });
      ui.orPickerHost.append(ui.orPicker);
      ui.orChip = BF.aiOpenRouter.createLimitsChip();
      ui.orChipHost.append(ui.orChip);
    }

    /** Mostra ou esconde o que é do OpenRouter e mantém o seletor igual ao que o processo principal guardou (sem recriá-lo). */
    function renderOpenRouter(ai, p) {
      const ui = state.ui;
      const on = isOpenRouterLocal(ai);
      ui.cfgModelField.hidden = on; // o campo de texto livre fica para os outros provedores
      ui.orBlock.hidden = !on;
      ui.orChipHost.hidden = !on;
      if (!on) return;
      if (!ui.orPicker) buildOpenRouter(p);
      const picker = ui.orPicker.bfPicker;
      const now = picker.state();
      if (now.value !== (p.model || '')) picker.setValue(p.model || '');
      if (now.freeOnly !== (p.freeOnly !== false)) picker.setFreeOnly(p.freeOnly !== false);
      picker.setDisabled(state.running);
      renderFallback();
    }

    /** Os modelos que a reserva oferece: o roteador gratuito e os gratuitos adequados da lista pública (a mesma do seletor). */
    async function loadReserveChoices() {
      const res = await BF.api('aiOpenrouter:models', { freeOnly: true });
      if (!res.ok || !Array.isArray(res.list)) return;
      state.orChoices = res.list.filter((x) => x.group === 'router' || x.group === 'free').map((x) => ({ id: x.id, name: x.name }));
      renderFallback();
    }

    /** "Modelos de reserva": até 3 selects ordenados, só com modelos gratuitos; um modelo não aparece duas vezes nem repete o principal. */
    function renderFallback() {
      const ui = state.ui;
      const p = state.ai && state.ai.provider;
      if (!ui.orReserve || !p) return;
      const saved = Array.isArray(p.fallbackModels) ? p.fallbackModels : [];
      const choices = state.orChoices || [];
      const known = new Set(choices.map((c) => c.id));
      const options = [...choices, ...saved.filter((id) => !known.has(id)).map((id) => ({ id, name: `${id} (fora da lista)` }))];
      const key = options.map((o) => o.id).join('|');
      ui.orReserve.forEach((select, i) => {
        if (select.dataset.key !== key) { // só refaz as opções quando mudam (redesenhar com a lista aberta a fecharia)
          select.replaceChildren(el('option', { value: '' }, 'Nenhuma'), ...options.map((o) => el('option', { value: o.id }, o.name)));
          select.dataset.key = key;
        }
        select.value = saved[i] || '';
        for (const option of select.children) option.disabled = option.value !== '' && (option.value === p.model || saved.some((id, j) => j !== i && id === option.value));
      });
      ui.orReserveTitle.textContent = saved.length ? `Modelos de reserva (${saved.length})` : 'Modelos de reserva';
    }

    /** Guarda a reserva na ordem dos selects (sem repetir). O processo principal recusa o que não é gratuito. */
    function saveReserve() {
      const ids = [];
      for (const select of state.ui.orReserve) if (select.value && !ids.includes(select.value)) ids.push(select.value);
      saveAi({ fallbackModels: ids });
    }

    function buildAi() {
      const ui = state.ui;
      // --- transcrição
      ui.tChip = el('span', { class: 'bds-chip', id: 'anTChip' });
      ui.tLine = el('p', { class: 'small', id: 'anTLine' });
      ui.tSub = el('p', { class: 'muted small', id: 'anTSub' });
      ui.tProgress = el('progress', { max: '1', value: '0', 'aria-label': 'Progresso da transcrição' });
      ui.tProgressText = el('span', { class: 'muted small', id: 'anTProgressText' });
      ui.tCancel = el('button', { type: 'button', id: 'anTCancel', class: 'sm', onclick: cancelTranscript }, 'Cancelar');
      ui.tProgressBox = el('div', { class: 'an-tprogress', id: 'anTProgress', hidden: true }, ui.tProgress, el('div', { class: 'an-split' }, ui.tProgressText, ui.tCancel));
      ui.tInstall = el('button', { type: 'button', id: 'anTInstall', class: 'sm', hidden: true, onclick: installTranscription }, icon('download'), 'Instalar a transcrição');
      ui.tGenerate = el('button', { type: 'button', id: 'anTGenerate', class: 'sm', onclick: generateTranscript }, 'Transcrever o vídeo');
      ui.tImport = el('button', { type: 'button', id: 'anTImport', class: 'sm', onclick: importTranscript }, icon('upload_file'), 'Importar legenda…');
      ui.tRemove = el('button', { type: 'button', id: 'anTRemove', class: 'icon-btn', 'aria-label': 'Remover a transcrição guardada', title: 'Remover a transcrição guardada', onclick: removeTranscript }, icon('delete'));
      ui.tCopy = el('button', { type: 'button', id: 'anTCopy', class: 'sm', onclick: () => A.copyTranscript() }, icon('content_copy'), 'Copiar transcrição');
      ui.tCard = el('div', { class: 'an-card', id: 'anTranscript' },
        el('div', { class: 'an-split' }, el('strong', {}, 'Transcrição do vídeo'), ui.tChip),
        ui.tLine, ui.tSub, ui.tProgressBox,
        el('div', { class: 'an-card-actions' }, ui.tInstall, ui.tGenerate, ui.tImport, ui.tCopy, ui.tRemove));

      // --- provedor
      ui.pChip = el('span', { class: 'bds-chip', id: 'anPChip' });
      ui.pLine = el('p', { class: 'small', id: 'anProvider' });
      ui.estLine = el('p', { class: 'muted small', id: 'anEstimate' });

      ui.cfgProvider = el('select', { id: 'anCfgProvider', 'aria-label': 'Provedor de IA', onchange: () => { if (ui.cfgProvider.value) saveAi({ provider: ui.cfgProvider.value }); } });
      ui.cfgBaseUrl = el('input', { type: 'url', id: 'anCfgUrl', placeholder: 'https://servidor/v1', autocomplete: 'off', spellcheck: 'false', onchange: changeBaseUrl });
      ui.cfgBaseUrlField = field('Endereço do servidor', ui.cfgBaseUrl, 'compatível com a API de chat da OpenAI; http:// só para este computador ou a sua rede local', true);
      ui.cfgLanNote = el('p', { class: 'an-note an-warn an-field-wide', id: 'anCfgLanNote', hidden: true });
      ui.cfgModelList = el('datalist', { id: 'anCfgModelList' });
      ui.cfgModel = el('input', { type: 'text', id: 'anCfgModel', list: 'anCfgModelList', placeholder: 'nome do modelo', autocomplete: 'off', spellcheck: 'false', onchange: () => saveAi({ model: ui.cfgModel.value }) });
      ui.cfgKey = el('input', { type: 'password', id: 'anCfgKey', placeholder: 'Cole a chave de API', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Chave de API', onchange: saveKey });
      ui.cfgKeySave = el('button', { type: 'button', id: 'anCfgKeySave', class: 'sm', onclick: saveKey }, 'Guardar chave');
      ui.cfgKeyState = el('span', { class: 'bds-chip', id: 'anCfgKeyState' });
      ui.cfgKeyClear = el('button', { type: 'button', id: 'anCfgKeyClear', class: 'link sm', onclick: clearKey }, 'Remover');
      ui.cfgEnc = el('p', { class: 'muted small', id: 'anCfgEnc' });
      ui.cfgTest = el('button', { type: 'button', id: 'anCfgTest', class: 'sm', onclick: testConnection }, 'Testar conexão');
      ui.cfgTestOut = el('p', { class: 'small', id: 'anCfgTestOut', role: 'status' });
      ui.cfgAccept = el('input', { type: 'checkbox', id: 'anCfgAccept', class: 'bds-switch', role: 'switch', onchange: toggleAccept });
      ui.cfgHostNote = el('p', { class: 'small', id: 'anCfgHost' });
      // com o provedor do hospedeiro (BDS) = OpenRouter vale o mesmo modo gratuito do app próprio: o único ajuste que se faz aqui (o resto é do BDS)
      ui.hostFree = el('input', { type: 'checkbox', id: 'anHostFree', class: 'bds-switch', role: 'switch', onchange: () => saveAi({ freeOnly: ui.hostFree.checked }) });
      ui.hostFreeBox = el('div', { id: 'anHostFreeBox', hidden: true },
        switchRow('an-switch-row', 'anHostFree', 'Usar apenas modelos gratuitos',
          el('span', { class: 'small' }, 'O modelo do assistente precisa ser gratuito: um modelo pago do OpenRouter é recusado antes de qualquer envio'), ui.hostFree));
      // --- OpenRouter (só no provedor local OpenRouter, com os componentes de renderer/features/aiOpenrouter.js): o seletor de modelos (criado UMA
      // vez, porque ele busca a lista ao nascer), o selo de pedidos gratuitos restantes e os "Modelos de reserva" (fallback entre gratuitos)
      // a lista de modelos que a CHAVE pode usar (GET /models no processo principal, onde a chave fica): botão, seletor e o que aconteceu
      ui.cfgModelsBtn = el('button', { type: 'button', id: 'anCfgModels', class: 'sm', onclick: () => loadModels() }, 'Ver modelos disponíveis');
      ui.cfgModelPick = el('select', { id: 'anCfgModelPick', 'aria-label': 'Modelos disponíveis', hidden: true, onchange: pickModel });
      ui.cfgModelsOut = el('p', { class: 'small', id: 'anCfgModelsOut', role: 'status' });
      ui.cfgModel.setAttribute('aria-label', 'Modelo');
      ui.cfgModelField = el('div', { class: 'an-field an-field-wide', id: 'anCfgModelField' },
        el('span', { class: 'an-field-label' }, 'Modelo'),
        el('div', { class: 'an-keyrow' }, ui.cfgModel, ui.cfgModelsBtn),
        ui.cfgModelPick,
        el('span', { class: 'muted small' }, 'você escolhe o modelo; "Ver modelos disponíveis" lista os que a sua chave pode usar'),
        ui.cfgModelsOut);
      ui.orChipHost = el('div', { class: 'an-or-chip', id: 'anOrLimits', hidden: true });
      ui.orPickerHost = el('div', { class: 'an-or-picker', id: 'anOrPicker' });
      ui.orReserve = [1, 2, 3].map((n) => el('select', { id: `anOrReserve${n}`, 'aria-label': `${n}ª reserva`, onchange: saveReserve }));
      ui.orReserveTitle = el('summary', {}, 'Modelos de reserva');
      ui.orReserveBox = el('details', { class: 'an-or-reserve', id: 'anOrReserveBox', ontoggle: () => { if (ui.orReserveBox.open) loadReserveChoices(); } },
        ui.orReserveTitle,
        el('div', { class: 'an-or-reserve-body' },
          el('p', { class: 'muted small' }, 'Se o modelo escolhido falhar (indisponível, limite de uso ou erro do provedor), o app tenta estes, na ordem. Só modelos gratuitos.'),
          el('div', { class: 'an-or-reserve-list' }, ui.orReserve.map((select, i) => field(`${i + 1}ª reserva`, select)))));
      ui.orBlock = el('div', { class: 'an-field an-field-wide an-or', id: 'anOrBlock', hidden: true },
        el('span', { class: 'an-field-label' }, 'Modelo'), ui.orPickerHost, ui.orReserveBox);
      ui.estFree = el('p', { class: 'small', id: 'anEstimateFree', hidden: true });
      // provedores de reserva (src/core/ai/runtime.js, _chatChain): se o escolhido falhar por limite de uso ou erro do servidor, o app passa ao próximo
      ui.fbSelects = [1, 2, 3].map((n) => el('select', { id: `anFallback${n}`, 'aria-label': `${n}ª reserva`, onchange: saveFallback }));
      ui.fbList = el('ul', { class: 'an-fb-list', id: 'anFallbackList' });
      ui.fbNote = el('p', { class: 'small an-caution', id: 'anFallbackNote', hidden: true });
      ui.fbBox = el('div', { class: 'an-adv-group', id: 'anFallbackBox', hidden: true },
        el('h4', { class: 'an-group-title' }, 'Provedores de reserva'),
        el('p', { class: 'muted small' }, 'Se o provedor escolhido falhar por limite de uso, cota ou erro do servidor, o app passa ao próximo, na ordem, e avisa na análise. Chave recusada não troca. Cada reserva precisa estar configurada e com o aviso de privacidade aceito (sem o aceite, nada é enviado a ela). Para configurar um provedor, escolha-o em "Provedor" acima, informe a chave e o modelo, use "Testar conexão" (ela descobre o limite por minuto) e volte ao provedor principal.'),
        el('div', { class: 'an-adv-grid an-adv-two' }, ui.fbSelects.map((select, i) => field(`${i + 1}ª reserva`, select))),
        ui.fbList, ui.fbNote);
      ui.cfgTpm = el('p', { class: 'muted small', id: 'anCfgTpm', hidden: true });
      ui.limits = {};
      const limitFields = [
        ['maxCalls', 'Chamadas por análise (máx.)'], ['maxInputTokens', 'Tokens por chamada (máx.)'],
        ['windowMinutes', 'Minutos por bloco'], ['attempts', 'Tentativas por chamada']
      ].map(([key, label]) => {
        const input = el('input', { type: 'number', id: `anLimit-${key}`, step: '1', onchange: () => changeLimit(key, input) });
        ui.limits[key] = input;
        return field(label, input);
      });
      ui.cfgLocal = el('div', { class: 'an-adv-group', id: 'anCfgLocal' },
        field('Provedor', ui.cfgProvider),
        ui.cfgBaseUrlField,
        ui.cfgLanNote,
        ui.cfgModelField,
        ui.orBlock,
        ui.cfgModelList,
        el('div', { class: 'an-field an-field-wide' },
          el('span', { class: 'an-field-label' }, 'Chave de API'),
          el('div', { class: 'an-keyrow' }, ui.cfgKey, ui.cfgKeySave),
          el('div', { class: 'an-split' }, ui.cfgKeyState, ui.cfgKeyClear),
          ui.cfgEnc));
      ui.aiConfig = el('details', { class: 'an-config', id: 'anAiConfig' },
        el('summary', {}, 'Provedor, chave e limites'),
        el('div', { class: 'an-adv-body' },
          ui.cfgLocal,
          ui.cfgHostNote,
          ui.hostFreeBox,
          el('div', { class: 'an-adv-actions' }, ui.cfgTest, ui.cfgTestOut),
          ui.cfgTpm,
          switchRow('an-switch-row', 'anCfgAccept', 'Aviso de privacidade aceito', el('span', { class: 'small' }, 'Sem o aceite, nada é enviado. Vale até você revogar'), ui.cfgAccept),
          ui.fbBox,
          el('div', { class: 'an-adv-group' },
            el('h4', { class: 'an-group-title' }, 'Limites'),
            el('div', { class: 'an-adv-grid an-adv-two' }, limitFields),
            el('p', { class: 'muted small' }, 'A tela mostra a estimativa antes de analisar; passar do limite de chamadas bloqueia a análise.'))));
      // guia de cortes (skill): o texto que ensina a IA a escolher; o do usuário vale no lugar do padrão do app
      ui.skillChip = el('span', { class: 'bds-chip', id: 'anSkillChip', hidden: true });
      ui.skillText = el('textarea', { id: 'anSkillText', rows: '14', spellcheck: 'true', 'aria-label': 'Texto do guia de cortes', oninput: () => { state.skillDraft = true; state.skillMsg = null; renderSkill(); } });
      ui.skillText.disabled = true;
      ui.skillInfo = el('p', { class: 'muted small', id: 'anSkillInfo' });
      ui.skillOut = el('p', { class: 'small', id: 'anSkillOut', role: 'status' });
      ui.skillSave = el('button', { type: 'button', id: 'anSkillSave', class: 'sm', onclick: saveSkill }, 'Salvar guia');
      ui.skillReset = el('button', { type: 'button', id: 'anSkillReset', class: 'sm', onclick: resetSkill }, 'Restaurar o padrão');
      ui.skillSave.disabled = true;
      ui.skillReset.disabled = true;
      ui.skillBox = el('details', { class: 'an-config an-skill', id: 'anSkillBox', ontoggle: () => { if (ui.skillBox.open && !state.skill) loadSkill(); } },
        el('summary', {}, 'Guia de cortes ', ui.skillChip),
        el('div', { class: 'an-adv-body' },
          el('p', { class: 'small' }, 'O texto que ensina a IA a escolher os cortes: o que vale, onde começar e terminar, o que descartar. Vai em cada chamada, para qualquer provedor. Adapte ao seu canal: exemplos do que você gosta e do que não gosta ajudam.'),
          ui.skillText, ui.skillInfo,
          el('div', { class: 'an-adv-actions' }, ui.skillSave, ui.skillReset, ui.skillOut)));
      ui.aiLockables = [ui.cfgProvider, ui.cfgBaseUrl, ui.cfgModel, ui.cfgModelsBtn, ui.cfgModelPick, ui.cfgKey, ui.cfgKeySave, ui.cfgKeyClear, ui.cfgAccept, ui.hostFree, ...ui.orReserve, ...ui.fbSelects, ...Object.values(ui.limits)];
      ui.pCard = el('div', { class: 'an-card', id: 'anProviderCard' },
        el('div', { class: 'an-split' }, el('strong', {}, 'Provedor de IA'), ui.pChip),
        ui.pLine, ui.orChipHost, ui.estLine, ui.estFree, ui.aiConfig); // o guia de cortes (ui.skillBox) fica no passo Ajustes, junto do perfil do canal
      ui.aiRoot = el('div', { class: 'an-ai', id: 'anAi', hidden: true }, ui.pCard);
    }

    function renderAi() {
      const ui = state.ui;
      if (!ui.pCard) return;
      renderTranscript();
      const ai = state.ai;
      const p = ai && ai.provider ? ai.provider : null;
      const host = Boolean(ai && ai.source === 'host');
      ui.cfgLocal.hidden = host || !ai;
      ui.cfgHostNote.hidden = !host;
      ui.hostFreeBox.hidden = !(host && p && p.freeCapable);
      if (host && p && p.freeCapable) ui.hostFree.checked = p.freeOnly !== false;
      ui.cfgTest.disabled = !p || !p.ready || state.running;
      if (!ai || !p) {
        ui.pChip.className = 'bds-chip';
        ui.pChip.textContent = '…';
        ui.pLine.textContent = 'Carregando a configuração da IA…';
        ui.estLine.textContent = '';
        ui.estLine.hidden = true;
        ui.estFree.hidden = true;
        return;
      }
      // resumo
      const none = !host && !p.id;
      if (host) {
        ui.pLine.textContent = p.ready ? `Usando o provedor do ${ai.hostName || 'aplicativo'}: ${p.label}${p.model ? ` · ${p.model}` : ''}` : (p.reason || `Configure o provedor de IA no ${ai.hostName || 'aplicativo'}.`);
        ui.cfgHostNote.textContent = p.ready
          ? `A chave e a requisição ficam com o ${ai.hostName || 'aplicativo'}: o Braga Frame não recebe nem guarda a chave. Para trocar de provedor, use as configurações do ${ai.hostName || 'aplicativo'}.`
          : (p.reason || '');
      } else if (none) {
        ui.pLine.textContent = 'Escolha o provedor e o modelo de IA. Nada é enviado antes de você escolher, informar a chave e aceitar o aviso de privacidade.';
      } else {
        const spare = ai.fallback && Array.isArray(ai.fallback.providers) ? ai.fallback.providers.filter((q) => q.ready && q.accepted && q.usable).map((q) => q.label) : [];
        ui.pLine.textContent = p.ready ? `${p.label} · ${modelLabel(p)}${spare.length ? ` · reserva: ${spare.join(', ')}` : ''}` : `${p.label}: ${p.reason}`;
      }
      const ready = p.ready;
      ui.pChip.className = `bds-chip ${ready ? (ai.accepted ? 'bds-chip-ok' : 'bds-chip-warn') : 'bds-chip-warn'}`;
      ui.pChip.textContent = !ready ? 'Falta configurar' : (ai.accepted ? 'Pronto' : 'Aviso pendente');
      const est = state.estimate;
      ui.estLine.hidden = !est;
      if (est) {
        ui.estLine.textContent = est.exceedsLimit
          ? `Estimativa: ${est.label}. Passa do limite de ${est.limit} chamadas: aumente em "Provedor, chave e limites" ou use o algoritmo.`
          : `Estimativa: ${est.label}. Nada é enviado antes de você confirmar o aviso de privacidade.`;
        const wi = est.windowsInfo;
        if (wi && wi.mode === 'candidates') ui.estLine.textContent += ` Só os trechos candidatos: ${wi.windows} janelas, cerca de ${wi.savedPercent}% menos texto que o método de sempre.`;
        else if (wi && wi.fallback && wi.reason) ui.estLine.textContent += ` ${wi.reason}`;
        if (est.limitedBy) ui.estLine.textContent += ` Blocos menores para caber no limite por minuto de ${est.limitedBy.label}.`;
      }
      // OpenRouter: a estimativa comparada com os pedidos gratuitos que restam hoje (avisa; não bloqueia)
      const free = state.orFree;
      ui.estFree.hidden = !free || !est || !usesFreeRequests(ai);
      if (!ui.estFree.hidden) {
        ui.estFree.textContent = free.message;
        ui.estFree.className = `small ${free.level === 'bad' ? 'an-bad' : (free.level === 'warn' ? 'an-caution' : 'muted')}`;
      }
      // campos (o que o usuário está digitando não é sobrescrito)
      const typing = (node) => document.activeElement === node;
      const presetKey = (ai.presets || []).map((x) => x.id).join();
      if (ui.presetKey !== presetKey) { // só refaz as opções quando mudam (redesenhar com a lista aberta a fecharia)
        // sem provedor escolhido a lista começa em "Escolha um provedor…" (opção que não dá para escolher de volta)
        ui.cfgProvider.replaceChildren(el('option', { value: '', disabled: true }, 'Escolha um provedor…'), ...(ai.presets || []).map((x) => el('option', { value: x.id }, x.label)));
        ui.presetKey = presetKey;
      }
      if (ui.cfgProvider.value !== (ai.selected || '')) ui.cfgProvider.value = ai.selected || '';
      ui.cfgBaseUrlField.hidden = ai.selected !== 'custom';
      // servidor http:// em outra máquina da rede local: a chave vai sem criptografia, e a tela diz isso junto do endereço
      ui.cfgLanNote.hidden = !(ai.selected === 'custom' && p.localNetwork);
      ui.cfgLanNote.textContent = ui.cfgLanNote.hidden ? '' : 'Este endereço usa http:// na rede local: a chave e o conteúdo vão sem criptografia. Use só numa rede em que você confia.';
      if (!typing(ui.cfgBaseUrl)) ui.cfgBaseUrl.value = p.baseUrl || '';
      if (!typing(ui.cfgModel)) ui.cfgModel.value = p.model || '';
      // o modelo é escolha do usuário: o campo começa vazio e a lista só SUGERE um nome (se o provedor tiver sugestão)
      const suggested = p.suggestedModel || '';
      ui.cfgModel.placeholder = none ? 'escolha o provedor primeiro' : (suggested ? `ex.: ${suggested}` : 'nome do modelo');
      // a lista buscada vale só para o provedor em que foi buscada (trocar de provedor ou de chave pede outra)
      if (state.models && state.models.provider !== ai.selected) { state.models = null; state.modelsMsg = null; }
      const live = state.models ? state.models.list : [];
      ui.cfgModelList.replaceChildren(...[...new Set([...(suggested ? [suggested] : []), ...live])].map((id) => el('option', { value: id })));
      ui.cfgModelPick.hidden = !live.length;
      if (live.length) {
        const key = live.join('|') + '#' + (p.model || '');
        if (ui.cfgModelPick.dataset.key !== key) {
          ui.cfgModelPick.replaceChildren(el('option', { value: '' }, `Escolha um dos ${live.length} modelos…`),
            ...live.map((id) => el('option', { value: id }, id === p.model ? `${id} (em uso)` : id)));
          ui.cfgModelPick.dataset.key = key;
        }
        ui.cfgModelPick.value = live.includes(p.model) ? p.model : '';
      }
      ui.cfgModelsBtn.hidden = Boolean(p.freeCapable) || Boolean(host);
      ui.cfgModelsBtn.disabled = none || state.running || Boolean(state.modelsBusy);
      ui.cfgModelsOut.textContent = state.modelsMsg ? state.modelsMsg.text : '';
      ui.cfgModelsOut.className = `small ${state.modelsMsg && state.modelsMsg.kind === 'bad' ? 'an-bad' : (state.modelsMsg && state.modelsMsg.kind === 'good' ? 'an-good' : 'muted')}`;
      ui.cfgKey.placeholder = none ? 'escolha o provedor primeiro' : (p.hasKey ? 'Colar uma chave nova para trocar' : (p.keyRequired ? 'Cole a chave de API' : 'Chave (opcional neste servidor)'));
      ui.cfgKeyState.className = `bds-chip ${p.hasKey ? (p.keyStatus === 'unreadable' ? 'bds-chip-warn' : 'bds-chip-ok') : ''}`;
      ui.cfgKeyState.textContent = p.hasKey ? (p.keyStatus === 'unreadable' ? 'Chave ilegível: informe de novo' : 'Chave guardada neste computador') : 'Nenhuma chave guardada';
      ui.cfgKeyClear.hidden = !p.hasKey;
      ui.cfgEnc.textContent = ai.encryptionNote || '';
      // chave guardada SEM cifra (o sistema não oferece cifragem): o dono aceitou o risco, mas a tela avisa em destaque; cifrada pelo sistema é só uma nota
      ui.cfgEnc.className = ai.encryption === 'file' ? 'an-note an-warn small' : 'muted small';
      ui.cfgEnc.hidden = !ai.encryptionNote;
      ui.cfgAccept.checked = Boolean(ai.accepted);
      if (state.test) {
        ui.cfgTestOut.textContent = state.test.text;
        ui.cfgTestOut.className = `small ${state.test.ok === false ? 'an-bad' : (state.test.ok ? 'an-good' : 'muted')}`;
      } else {
        ui.cfgTestOut.textContent = '';
      }
      for (const key of Object.keys(ui.limits)) {
        if (!typing(ui.limits[key]) && ai.limits) ui.limits[key].value = String(ai.limits[key]);
      }
      renderOpenRouter(ai, p);
      ui.cfgTpm.hidden = host || none || !p.tokensPerMinute;
      ui.cfgTpm.textContent = ui.cfgTpm.hidden ? '' : `Limite informado pelo provedor: ${fmtN(p.tokensPerMinute)} tokens por minuto.`;
      renderProviderFallback(ai, host);
      for (const node of ui.aiLockables) node.disabled = state.running;
      if (none) for (const node of [ui.cfgModel, ui.cfgKey, ui.cfgKeySave, ui.cfgAccept]) node.disabled = true; // sem provedor escolhido não há o que configurar
      if (host) ui.cfgAccept.disabled = state.running;
      // sem provedor pronto o cartão de configuração já vem aberto
      if (!ready && !state.autoOpened && usesAi(engineChoice())) { ui.aiConfig.open = true; state.autoOpened = true; }
    }

    return { refreshAi, refreshEstimate, openModelList, renderSkill, buildAi, renderAi };
  };
})();

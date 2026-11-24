'use strict';

/**
 * Aba "Análise" — "Usar uma IA de chat (sem chave)" e "Copiar transcrição". Fábrica como engine.js: analysis.js a chama com `A`.
 * Fluxo: o app monta o pedido (transcrição com ID e tempo por palavra), a pessoa o cola no GPT, Qwen ou outro chat e cola a resposta
 * de volta; o processo principal lê só os IDs de palavra e confere tudo (src/core/analysis/ai/manual.js). Nada sai do computador por aqui:
 * quem envia o texto para a IA é a própria pessoa, no chat que ela escolher.
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;
  const { sameSource, plural, hms, usesChat } = window.BFAnalysisLogic;

  window.BFAnalysisParts = window.BFAnalysisParts || {};
  window.BFAnalysisParts.manual = function (A) {
    const { state } = A;
    const REASON_LABEL = {
      id: 'ID de palavra inválido', format: 'item fora do formato', time: 'horário inválido', range: 'fora do vídeo', nospeech: 'sem fala nesse trecho',
      punchline: 'o final do trecho não existe na transcrição', duration: 'duração fora do permitido', existing: 'já coberto por um corte', duplicate: 'repete outro corte melhor',
      relevance: 'relevância abaixo do mínimo', window: 'fora do trecho'
    };

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    }

    const sourceInfo = (project) => ({
      projectId: project.id, path: project.source.path, size: project.source.size || 0, duration: project.source.duration || (BF.state.info && BF.state.info.duration) || 0
    });

    // ---------- copiar toda a transcrição ----------
    async function copyTranscript() {
      const project = BF.state.project;
      if (!project) return;
      const res = await BF.api('analysis:transcriptText', sourceInfo(project));
      if (!res.ok) { state.notice = { kind: 'error', text: res.message }; A.renderNotice(); return; }
      const ok = await copyText(res.text);
      BF.ui.toast(ok ? `Transcrição copiada (${plural(res.cues, 'fala', 'falas')}).` : 'Não consegui copiar para a área de transferência.', ok ? 'ok' : 'error');
    }

    // ---------- pedido para a IA ----------
    function setMsg(text, kind = 'info') {
      const ui = state.ui;
      ui.mMsg.textContent = text;
      ui.mMsg.className = `small an-note${kind === 'error' ? ' an-warn' : ''}`;
      ui.mMsg.hidden = !text;
    }

    async function buildRequest() {
      const project = BF.state.project;
      if (!project) return;
      const ui = state.ui;
      ui.mBuild.disabled = true;
      setMsg('Montando o pedido…');
      const payload = A.aiPayload(project, A.readControls());
      const res = await BF.api('analysis:manualPrompt', { ...payload, wordsPerPart: Number(ui.mSize.value) || 800 });
      ui.mBuild.disabled = false;
      if (!res.ok) { state.manual = { parts: null }; setMsg(res.message, 'error'); renderManual(); return; }
      state.manual = { parts: res.parts, approx: res.approx, fps: res.fps, words: res.words };
      setMsg('');
      renderManual();
      if (res.parts.length === 1) await copyPart(0);
    }

    /** Acima disto alguns chats (o ChatGPT gratuito, por exemplo) recusam a mensagem: "A mensagem enviada era longa demais". */
    const LONG_CHARS = 20000;
    const kChars = (n) => `${Math.round(n / 1000)} mil caracteres`;

    /** Parte 1 (ou qualquer parte, com "um chat novo para cada parte"): o pedido completo. As outras: só a continuação, para o MESMO chat. */
    function textOf(part, index) {
      const separate = Boolean(state.ui.mSeparate && state.ui.mSeparate.checked);
      return index > 0 && !separate && part.short ? { text: part.short, chars: part.shortChars, follow: true } : { text: part.text, chars: part.chars, follow: false };
    }

    async function copyPart(index) {
      const part = state.manual && state.manual.parts && state.manual.parts[index];
      if (!part) return;
      const pick = textOf(part, index);
      const ok = await copyText(pick.text);
      const total = state.manual.parts.length;
      const long = pick.chars > LONG_CHARS ? ` Está grande (${kChars(pick.chars)}): se o chat recusar por tamanho, escolha partes menores.` : '';
      setMsg(ok
        ? `${pick.follow ? 'Continuação' : 'Pedido'}${total > 1 ? ` da parte ${index + 1} de ${total}` : ''} copiado (${kChars(pick.chars)}).${pick.follow ? ' Cole no MESMO chat da parte anterior.' : ' Cole no chat da IA'}${pick.follow ? '' : ', espere a resposta'} e cole a resposta na caixa abaixo.${long}`
        : 'Não consegui copiar para a área de transferência. Tente de novo.', ok ? (long ? 'error' : 'info') : 'error');
    }

    // ---------- resposta da IA ----------
    async function readReply() {
      const project = BF.state.project;
      const ui = state.ui;
      if (!project) return;
      const text = ui.mReply.value.trim();
      if (!text) { setMsg('Cole primeiro a resposta da IA na caixa.', 'error'); return; }
      ui.mRead.disabled = true;
      const payload = A.aiPayload(project, A.readControls());
      const res = await BF.api('analysis:manualParse', { ...payload, text });
      ui.mRead.disabled = false;
      if (!res.ok) { setMsg(res.message, 'error'); return; }
      const added = storeSuggestions(res.suggestions);
      const lost = res.dropped.length;
      const why = {};
      for (const d of res.dropped) why[d.reason] = (why[d.reason] || 0) + 1;
      const reasons = Object.entries(why).map(([r, n]) => `${n} ${REASON_LABEL[r] || r}`).join(', ');
      setMsg(`${plural(res.received, 'corte', 'cortes')} na resposta: ${added} na lista de sugestões${lost ? `, ${lost} descartado(s) (${reasons})` : ''}.${res.salvaged ? ' A resposta veio cortada; só os itens completos foram aproveitados.' : ''}${added ? ' Confira e use Adicionar.' : ''}`, added ? 'info' : 'error');
      if (added) { ui.mReply.value = ''; BF.ui.toast(`${plural(added, 'sugestão', 'sugestões')} da IA de chat na lista.`, 'ok'); A.showStep('results'); }
      BF.ui.log(`IA de chat: ${added} sugestão(ões) lida(s) da resposta colada, ${lost} descartada(s).`, added ? 'ok' : 'info');
    }

    /** As sugestões entram na MESMA lista da análise (pendentes, nunca aprovadas), junto das que já estavam. Devolve quantas são novas. */
    function storeSuggestions(list) {
      let added = 0;
      BF.project.update((project) => {
        project.ext = project.ext || {};
        const prev = project.ext.analysis || {};
        const same = sameSource(prev.source, project.source);
        const keep = same && Array.isArray(prev.suggestions) ? prev.suggestions : [];
        const ids = new Set(keep.map((s) => s.id));
        const fresh = list.filter((s) => !ids.has(s.id)).map((s) => ({
          id: s.id, start: s.start, end: s.end, peak: s.peak, relevance: s.relevance, reasons: s.reasons,
          engines: ['ai'],
          ...(s.title ? { title: s.title } : {}), ...(s.category ? { category: s.category } : {}),
          ...(s.layout ? { layout: s.layout } : {}), ...(Array.isArray(s.flags) && s.flags.length ? { flags: s.flags } : {}),
          ...(s.theme ? { theme: s.theme } : {}), ...(Array.isArray(s.keywords) && s.keywords.length ? { keywords: s.keywords } : {})
        }));
        added = fresh.length;
        project.ext.analysis = {
          ...prev,
          source: { path: project.source.path, size: project.source.size || 0, duration: project.source.duration || 0 },
          dismissed: same && Array.isArray(prev.dismissed) ? prev.dismissed : [],
          runAt: new Date().toISOString(),
          engine: same && prev.engine ? prev.engine : 'ai',
          warnings: same && Array.isArray(prev.warnings) ? prev.warnings : [],
          suggestions: [...keep, ...fresh]
        };
      }, { reason: 'analysis:manual' });
      BF.ui.refreshTabs();
      A.renderResults();
      return added;
    }

    // ---------- desenho ----------
    function buildManual() {
      const ui = state.ui;
      ui.mSize = el('select', { id: 'anMSize', 'aria-label': 'Tamanho de cada parte do pedido', onchange: () => { state.manual = null; renderManual(); } },
        el('option', { value: '400' }, 'Partes pequenas (~400 palavras, ~14 mil caracteres)'),
        el('option', { value: '800', selected: true }, 'Partes médias (~800 palavras, ~18 mil caracteres)'),
        el('option', { value: '1500' }, 'Partes grandes (~1.500 palavras, ~25 mil caracteres)'),
        el('option', { value: '3000' }, 'Partes enormes (~3.000 palavras, ~40 mil caracteres)'));
      ui.mSeparate = el('input', { type: 'checkbox', id: 'anMSeparate', class: 'bds-switch', role: 'switch', onchange: renderManual });
      ui.mSeparateRow = el('label', { class: 'an-switch-row small', for: 'anMSeparate' }, ui.mSeparate,
        el('span', {}, 'Cada parte em um chat novo (pedido completo em todas). Desligado, só a primeira leva o guia e as outras são curtas, para o mesmo chat.'));
      ui.mBuild = el('button', { type: 'button', id: 'anMBuild', class: 'sm', onclick: buildRequest }, A.icon('content_copy'), 'Copiar pedido para a IA');
      ui.mParts = el('div', { class: 'an-card-actions', id: 'anMParts', hidden: true });
      ui.mReply = el('textarea', { id: 'anMReply', rows: '5', placeholder: 'Cole aqui a resposta da IA (o JSON com "cuts")', spellcheck: 'false', 'aria-label': 'Resposta da IA' });
      ui.mRead = el('button', { type: 'button', id: 'anMRead', class: 'sm', onclick: readReply }, A.icon('input'), 'Ler resposta e criar sugestões');
      ui.mMsg = el('p', { class: 'small an-note', id: 'anMMsg', role: 'status', hidden: true });
      ui.mNote = el('p', { class: 'muted small', id: 'anMNote' });
      ui.mCard = el('div', { class: 'an-card', id: 'anManual', hidden: true },
        el('strong', {}, 'IA de chat (sem chave)'),
        el('p', { class: 'muted small' }, 'Copie o pedido, cole no GPT, Qwen ou outro chat e traga a resposta de volta. A IA devolve só números de palavras: o horário vem da transcrição, no quadro exato do vídeo. Você é quem envia o texto, no chat que escolher.'),
        el('div', { class: 'an-card-actions' }, ui.mSize, ui.mBuild),
        ui.mSeparateRow, ui.mNote, ui.mParts, ui.mReply,
        el('div', { class: 'an-card-actions' }, ui.mRead), ui.mMsg);
    }

    function renderManual() {
      const ui = state.ui;
      if (!ui.mCard) return;
      const t = state.transcript;
      const has = Boolean(t && t.exists && !t.stale);
      const busy = Boolean(state.tjob) || state.tstarting || state.running;
      ui.mCard.hidden = !usesChat(A.engineChoice()); // só no motor "IA de chat"; sem transcrição os botões ficam parados e a nota diz o que fazer
      ui.mBuild.disabled = busy || !has;
      ui.mRead.disabled = busy || !has;
      ui.mSize.disabled = busy;
      ui.mSeparate.disabled = busy; // durante a análise todos os campos da aba ficam travados
      const m = state.manual;
      ui.mParts.replaceChildren();
      ui.mSeparateRow.hidden = !(m && m.parts && m.parts.length > 1);
      ui.mParts.hidden = !(m && m.parts && m.parts.length > 1);
      if (m && m.parts && m.parts.length > 1) {
        m.parts.forEach((part, i) => ui.mParts.append(el('button', { type: 'button', class: 'sm', onclick: () => copyPart(i) }, `Copiar parte ${i + 1} (${hms(part.from)}–${hms(part.to)}) · ${kChars(textOf(part, i).chars)}`)));
      }
      ui.mNote.textContent = m && m.parts
        ? `${plural(m.words, 'palavra', 'palavras')} em ${plural(m.parts.length, 'parte', 'partes')}${m.fps ? ` · ${String(Math.round(m.fps * 100) / 100).replace('.', ',')} quadros/s` : ''}${m.approx ? ' · legenda importada: o tempo por palavra é aproximado' : ''}. Para vídeos longos, cole uma parte por vez e leia cada resposta antes de colar a próxima.`
        : '';
      if (!has) ui.mNote.textContent = 'Gere ou importe a transcrição no passo Transcrição para montar o pedido.';
      ui.mNote.hidden = !ui.mNote.textContent;
    }

    return { buildManual, renderManual, copyTranscript };
  };
})();

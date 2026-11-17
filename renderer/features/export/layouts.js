'use strict';

/**
 * Aba "Exportar" — layouts do canal na tela (interruptor, presets, padrão do canal, quadros de referência e detecção pela imagem).
 * Tirado de features/export.js (Etapa 2, 17/11/2026) sem mudar o comportamento. É uma FÁBRICA: export.js a chama com o que ela precisa do resto da aba (`A`) e recebe de volta o que ela oferece.
 * Carrega ANTES de export.js (renderer/index.html).
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;
  const { LAY, clamp, isObj, PREF, REF_MAX } = window.BFExportLogic;

  window.BFExportParts = window.BFExportParts || {};
  window.BFExportParts.layouts = function (A) {
    const { S } = A;
    const project = (...args) => A.project(...args);
    const updateExt = (...args) => A.updateExt(...args);
    const presetsEffective = (...args) => A.presetsEffective(...args);
    const refsEffective = (...args) => A.refsEffective(...args);
    const layoutCtx = (...args) => A.layoutCtx(...args);
    const effectiveProfile = (...args) => A.effectiveProfile(...args);
    const listCuts = (...args) => A.listCuts(...args);
    const commitDraft = (...args) => A.commitDraft(...args);
    const afterFramingChange = (...args) => A.afterFramingChange(...args);
    const previewRange = (...args) => A.previewRange(...args);
    const scheduleSource = (...args) => A.scheduleSource(...args);
    const schedulePreview = (...args) => A.schedulePreview(...args);
    const icon = (...args) => A.icon(...args);
    const syncStage = (...args) => A.syncStage(...args);

    const LAYOUT_SUB = { conversa: 'Câmera em tela cheia (com o chat): recorte vertical no rosto', jogo: 'Webcam em cima e o jogo embaixo' };

    /** De onde vem um preset, em texto curto ('app', 'projeto', 'geral', 'canal X', 'jogo Y'). */
    function fromText(from) {
      if (from === 'app') return 'padrão do app';
      if (from === 'projeto') return 'deste projeto';
      if (from === 'geral') return 'padrão geral';
      return `padrão do ${from}`;
    }

    /** JSON com as chaves em ordem (compara valores sem depender da ordem em que foram montados). */
    const canon = (v) => JSON.stringify(v, (k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

    /** Frase sob o interruptor: quantos cortes têm layout sugerido e por quem. */
    function suggestNote(lc) {
      const cuts = listCuts();
      let byAi = 0;
      let byImage = 0;
      for (const c of cuts) {
        const s = LAY.suggestionOf(c, { useSuggested: true, localKey: lc.localKey });
        if (s) { if (s.via === 'detector') byImage += 1; else byAi += 1; }
      }
      if (!byAi && !byImage) {
        return 'Nenhum corte tem layout sugerido ainda. A análise por IA indica Conversa ou Jogo em cada corte; "Detectar o layout pela imagem" (em Layouts do canal) faz o mesmo olhando o vídeo.';
      }
      const who = [byAi ? `${byAi} pela IA` : '', byImage ? `${byImage} pela imagem` : ''].filter(Boolean).join(', ');
      return `${byAi + byImage} de ${cuts.length} cortes têm layout sugerido (${who}). ${byAi ? 'O palpite da IA vem só do texto: ela não vê a imagem. ' : ''}Você pode trocar o layout de cada corte.`;
    }

    /** Onde salvar o padrão: canal, jogo ou geral (canal e jogo vêm do projeto aberto). */
    function layoutScopes() {
      const names = BF.prefs.scope();
      return [
        ['channel', names.channel ? `Canal: ${names.channel}` : 'Canal (defina em Preferências)', Boolean(names.channel)],
        ['game', names.game ? `Jogo: ${names.game}` : 'Jogo (defina em Preferências)', Boolean(names.game)],
        ['general', 'Geral (todos os vídeos)', true]
      ];
    }

    function syncLayouts() {
      if (!A.ui || !project()) return;
      const lc = layoutCtx();
      A.ui.suggest.checked = lc.useSuggested;
      A.ui.suggestNote.textContent = suggestNote(lc);
      const cuts = listCuts();
      for (const row of A.ui.layoutRows) {
        const on = S.target === `layout:${row.layout}`;
        const using = cuts.filter((c) => LAY.layoutOfCut(c, { useSuggested: lc.useSuggested, localKey: lc.localKey }).layout === row.layout).length;
        row.li.classList.toggle('on', on);
        row.main.setAttribute('aria-pressed', String(on));
        row.sub.textContent = `${LAYOUT_SUB[row.layout]} · ${fromText(lc.presets[row.layout].from)}`;
        row.count.textContent = using ? `${using} ${using === 1 ? 'corte' : 'cortes'}` : '';
        row.count.hidden = !using;
      }
      const scopes = layoutScopes();
      const signature = JSON.stringify(scopes);
      if (A.ui.layoutScope.dataset.sig !== signature) {
        const keep = A.ui.layoutScope.value;
        A.ui.layoutScope.replaceChildren(...scopes.map(([value, label, ok]) => el('option', { value, disabled: !ok }, label)));
        A.ui.layoutScope.dataset.sig = signature;
        // a escolha do usuário vale enquanto existir; sem escolha, o mais específico disponível (canal, depois jogo, depois geral)
        const chosen = A.ui.layoutScope.dataset.touched ? scopes.find(([value, , ok]) => ok && value === keep) : null;
        A.ui.layoutScope.value = (chosen || scopes.find(([, , ok]) => ok))[0];
      }
      const profile = effectiveProfile();
      A.ui.layoutsNote.hidden = !(profile && profile.height <= profile.width);
      syncRefs();
      syncDetect(lc);
    }

    /** "Salvar como padrão": grava os presets (e os quadros de referência) nas preferências do escopo; novos projetos do mesmo canal herdam. */
    async function saveLayoutsAsDefault() {
      const scope = A.ui.layoutScope.value;
      if (!scope || A.ui.layoutSave.disabled) return;
      A.ui.layoutSave.disabled = true;
      try {
        const before = presetsEffective();
        for (const layout of LAY.LAYOUTS) {
          const res = await BF.prefs.set(PREF[layout], LAY.presetForStorage(before[layout]), scope);
          if (!res.ok) { BF.ui.toast(res.message || 'Não foi possível salvar o padrão dos layouts.', 'error'); return; }
        }
        const refs = refsEffective();
        if (!refs.inherited && (refs.refs.conversa.length || refs.refs.jogo.length)) {
          const res = await BF.prefs.set(PREF.refs, refs.refs, scope);
          if (!res.ok) { BF.ui.toast(res.message || 'Não foi possível salvar os quadros de referência.', 'error'); return; }
        }
        // se o padrão herdado agora é o que o projeto já tinha, o projeto passa a herdá-lo (sem ajuste próprio)
        const inherited = presetsEffective({ withProject: false });
        updateExt((e) => {
          if (!isObj(e.layouts)) return;
          for (const layout of LAY.LAYOUTS) {
            if (canon(inherited[layout].framing) === canon(before[layout].framing) && canon(inherited[layout].ref) === canon(before[layout].ref)) delete e.layouts[layout];
          }
          if (!Object.keys(e.layouts).length) delete e.layouts;
        }, 'export:layout');
        const where = layoutScopes().find(([value]) => value === scope);
        BF.ui.toast(`Layouts salvos como padrão (${where ? where[1] : scope}). Novos projetos começam com eles.`, 'ok');
        afterFramingChange();
      } finally {
        A.ui.layoutSave.disabled = false;
      }
    }

    // ----- quadros de referência e detecção -----

    /** Miniatura 64x36 (texto base64 de tons de cinza) desenhada num canvas. */
    function refThumb(b64, label, onRemove) {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const canvas = el('canvas', { width: '64', height: '36', class: 'exp-ref-canvas', role: 'img', 'aria-label': label });
      const g = canvas.getContext('2d');
      const image = g.createImageData(64, 36);
      for (let i = 0; i < 2304; i++) {
        image.data[i * 4] = bytes[i];
        image.data[i * 4 + 1] = bytes[i];
        image.data[i * 4 + 2] = bytes[i];
        image.data[i * 4 + 3] = 255;
      }
      g.putImageData(image, 0, 0);
      return el('span', { class: 'exp-ref' }, canvas,
        el('button', { type: 'button', class: 'icon-btn exp-ref-del', title: 'Remover este quadro', 'aria-label': `Remover este quadro de ${label}`, onclick: onRemove }, icon('close')));
    }

    function syncRefs() {
      const { refs, inherited } = refsEffective();
      for (const group of A.ui.refGroups) {
        const list = refs[group.layout];
        const signature = list.join('|');
        if (group.thumbs.dataset.sig !== signature) {
          group.thumbs.replaceChildren(...list.map((b64, index) => refThumb(b64, `referência ${index + 1} de ${LAY.LABELS[group.layout]}`, () => removeRef(group.layout, index))));
          group.thumbs.dataset.sig = signature;
        }
        const missing = Math.max(0, 2 - list.length);
        group.count.textContent = `${list.length} de ${REF_MAX} quadros${missing ? ` · falta${missing > 1 ? 'm' : ''} ${missing} para detectar` : ''}${inherited && list.length ? ' · do padrão salvo' : ''}`;
        group.add.disabled = list.length >= REF_MAX || !BF.state.tools.ffmpeg;
      }
    }

    /** Grava os quadros de referência no projeto (as detecções antigas deixam de valer sozinhas: a chave delas inclui as referências). */
    function saveRefs(refs) {
      updateExt((e) => { e.layoutRefs = { conversa: refs.conversa, jogo: refs.jogo }; }, 'export:refs');
      afterFramingChange();
    }

    async function addRef(layout) {
      const p = project();
      if (!p || !BF.state.tools.ffmpeg) return;
      const res = await BF.api('export:layoutRef', { sourcePath: p.source.path, timeSec: BF.player.time() }, { toast: true });
      if (!res.ok || project() !== p) return;
      const refs = refsEffective().refs;
      if (refs[layout].length >= REF_MAX) { BF.ui.toast(`Já são ${REF_MAX} quadros de ${LAY.LABELS[layout]}: remova um antes.`, 'error'); return; }
      if (Object.values(refs).some((list) => list.includes(res.thumb))) { BF.ui.toast('Este quadro já é uma referência. Mova o player para outro momento.', 'error'); return; }
      saveRefs({ ...refs, [layout]: [...refs[layout], res.thumb] });
    }

    function removeRef(layout, index) {
      const refs = refsEffective().refs;
      saveRefs({ ...refs, [layout]: refs[layout].filter((_, i) => i !== index) });
    }

    function syncDetect(lc = layoutCtx()) {
      const d = S.detect;
      const { refs } = refsEffective();
      const ready = refs.conversa.length >= 2 && refs.jogo.length >= 2;
      const cuts = listCuts();
      A.ui.detectRun.disabled = d.running || !ready || !cuts.length || !BF.state.tools.ffmpeg;
      A.ui.detectRun.textContent = d.running ? `Detectando… ${d.done} de ${d.total}` : 'Detectar o layout dos cortes';
      A.ui.detectCancel.hidden = !d.running;
      let text = '';
      let kind = '';
      if (d.message) { text = d.message.text; kind = d.message.kind; }
      else if (!ready) text = 'Escolha pelo menos 2 quadros de cada layout.';
      else if (!cuts.length) text = 'Sem cortes para detectar.';
      else {
        const states = { valid: 0, uncertain: 0, stale: 0, none: 0 };
        for (const c of cuts) states[LAY.localState(c, lc.localKey)] += 1;
        const parts = [];
        if (states.valid) parts.push(`${states.valid} detectado${states.valid === 1 ? '' : 's'}`);
        if (states.uncertain) parts.push(`${states.uncertain} incerto${states.uncertain === 1 ? '' : 's'}`);
        if (states.stale) parts.push(`${states.stale} desatualizado${states.stale === 1 ? '' : 's'}`);
        text = parts.length ? `${parts.join(' · ')} de ${cuts.length} cortes. Incerto e sem detecção valem o palpite da IA, ou o padrão.` : `Ainda não detectado em nenhum dos ${cuts.length} cortes.`;
      }
      A.ui.detectStatus.textContent = text;
      A.ui.detectStatus.className = `small ${kind === 'error' ? 'exp-msg error' : 'muted'}`;
    }

    async function runDetect() {
      const p = project();
      if (!p || S.detect.running) return;
      const cuts = listCuts();
      const { refs } = refsEffective();
      if (!cuts.length || refs.conversa.length < 2 || refs.jogo.length < 2) return;
      if (S.draft) commitDraft();
      const seq = S.detect.seq + 1;
      S.detect = { running: true, done: 0, total: cuts.length, message: null, seq };
      syncDetect();
      const res = await BF.api('export:detectLayouts', { sourcePath: p.source.path, cuts: cuts.map((c) => ({ id: c.id, start: c.start, end: c.end })), refs });
      if (seq !== S.detect.seq || project() !== p) return;
      S.detect = { running: false, done: 0, total: 0, message: null, seq };
      if (!res.ok) {
        S.detect.message = { kind: res.code === 'CANCELLED' ? 'info' : 'error', text: res.code === 'CANCELLED' ? 'Detecção cancelada. Nada foi alterado.' : res.message };
        syncDetect();
        return;
      }
      BF.project.update(() => {
        for (const r of res.results) {
          const cut = BF.project.cut(r.cutId);
          if (cut) cut.layoutLocal = { layout: r.layout, confidence: r.confidence, reason: r.reason, key: r.key, at: r.at, samples: r.samples };
        }
      }, { reason: 'export:detect' });
      BF.bus.emit('cuts:changed', { ids: res.results.map((r) => r.cutId), from: 'export:framing' });
      const found = res.results.filter((r) => r.layout).length;
      BF.ui.toast(`Layout detectado em ${found} de ${res.results.length} cortes${found < res.results.length ? '; os outros ficaram incertos' : ''}.`, 'ok');
      afterFramingChange();
    }

    function cancelDetect() {
      if (!S.detect.running) return;
      S.detect.seq += 1;
      S.detect = { running: false, done: 0, total: 0, message: { kind: 'info', text: 'Detecção cancelada. Nada foi alterado.' }, seq: S.detect.seq };
      BF.api('export:detectCancel', {});
      syncDetect();
    }

    /** Mostra na prévia o quadro em que o player está agora (útil para conferir um preset num momento de Conversa ou de Jogo). */
    function usePlayerFrame() {
      const r = previewRange();
      S.frameT = clamp(BF.player.time(), r.start, Math.max(r.start, r.end - 0.1));
      syncStage();
      scheduleSource();
      schedulePreview();
    }

    return { syncLayouts, saveLayoutsAsDefault, addRef, syncDetect, runDetect, cancelDetect, usePlayerFrame };
  };
})();

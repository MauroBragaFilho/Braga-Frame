'use strict';

/**
 * Aba "Exportar" — sincronização da interface (perfil, enquadramento, palco, cortes, destino, QC, ação, mensagem).
 * Tirado de features/export.js (Etapa 2, 17/11/2026) sem mudar o comportamento. É uma FÁBRICA: export.js a chama com o que ela precisa do resto da aba (`A`) e recebe de volta o que ela oferece.
 * Carrega ANTES de export.js (renderer/index.html).
 */
(function () {
  const BF = window.BF;
  const { el, fmt } = BF.util;
  const { DEFAULT_TEMPLATE, MODE_HINT, MIN_RECT, LAY, clamp, windowOf, stackHeights, kbpsToSlider, mbpsText, groupIssues } = window.BFExportLogic;

  window.BFExportParts = window.BFExportParts || {};
  window.BFExportParts.view = function (A) {
    const { S } = A;
    const project = (...args) => A.project(...args);
    const ext = (...args) => A.ext(...args);
    const presetsEffective = (...args) => A.presetsEffective(...args);
    const layoutCtx = (...args) => A.layoutCtx(...args);
    const resolveCut = (...args) => A.resolveCut(...args);
    const chosenProfileId = (...args) => A.chosenProfileId(...args);
    const baseProfile = (...args) => A.baseProfile(...args);
    const overridesOf = (...args) => A.overridesOf(...args);
    const ratioChanged = (...args) => A.ratioChanged(...args);
    const effectiveProfile = (...args) => A.effectiveProfile(...args);
    const encoderHint = (...args) => A.encoderHint(...args);
    const listCuts = (...args) => A.listCuts(...args);
    const isChecked = (...args) => A.isChecked(...args);
    const checkedCuts = (...args) => A.checkedCuts(...args);
    const numberOf = (...args) => A.numberOf(...args);
    const customized = (...args) => A.customized(...args);
    const targetLayout = (...args) => A.targetLayout(...args);
    const setChecked = (...args) => A.setChecked(...args);
    const effectiveFraming = (...args) => A.effectiveFraming(...args);
    const hasOwnFraming = (...args) => A.hasOwnFraming(...args);
    const editFraming = (...args) => A.editFraming(...args);
    const afterFramingChange = (...args) => A.afterFramingChange(...args);
    const setTarget = (...args) => A.setTarget(...args);
    const previewRange = (...args) => A.previewRange(...args);
    const frameTime = (...args) => A.frameTime(...args);
    const sourceSize = (...args) => A.sourceSize(...args);
    const outputDir = (...args) => A.outputDir(...args);
    const syncLayouts = (...args) => A.syncLayouts(...args);

    /** Campo com rótulo em cima. `label` pode ser [texto, <strong>valor</strong>]: o valor fica à direita, alinhado (barras deslizantes). */
    const field = (label, control, cls) => el('label', { class: `exp-field${cls ? ` ${cls}` : ''}` },
      Array.isArray(label)
        ? el('span', { class: 'exp-label exp-label-row' }, el('span', {}, String(label[0]).trim()), label[1])
        : el('span', { class: 'exp-label' }, label),
      control);

    const icon = (name) => el('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true' }, name);

    function syncAll() {
      if (!A.ui) return;
      const has = Boolean(project());
      A.ui.empty.hidden = has;
      A.ui.main.hidden = !has;
      if (!has) return;
      syncProfile();
      syncFraming();
      syncCuts();
      syncLayouts();
      syncDest();
      syncQc();
      syncAction();
      syncMessage();
    }

    function syncProfile() {
      if (!A.ui || !project()) return;
      A.ui.profileError.hidden = !S.profilesError;
      A.ui.profileError.textContent = S.profilesError ? `Não foi possível carregar os perfis: ${S.profilesError}` : '';
      A.ui.profileWarn.hidden = !S.profilesWarning;
      A.ui.profileWarn.textContent = S.profilesWarning || '';
      const chosen = chosenProfileId();
      const groups = [['Vertical 9:16', (p) => p.builtin && p.kind === 'vertical'], ['Horizontal 16:9', (p) => p.builtin && p.kind === 'horizontal'], ['Meus perfis', (p) => !p.builtin]];
      const wanted = JSON.stringify(S.profiles.map((p) => [p.id, p.name]));
      if (A.ui.profile.dataset.sig !== wanted) {
        A.ui.profile.replaceChildren(...groups.map(([label, test]) => {
          const items = S.profiles.filter(test);
          return items.length ? el('optgroup', { label }, items.map((p) => el('option', { value: p.id }, p.name))) : null;
        }));
        A.ui.profile.dataset.sig = wanted;
      }
      A.ui.profile.disabled = !S.profiles.length;
      if (S.profiles.length) A.ui.profile.value = chosen;

      const profile = effectiveProfile();
      if (!profile) { A.ui.summary.textContent = 'Detalhes'; return; }
      const o = overridesOf(profile.id || chosen);
      const adjusted = Object.keys(o).length > 0;
      A.ui.summary.textContent = `Detalhes · ${profile.width}×${profile.height} · ${profile.codec === 'h265' ? 'H.265' : 'H.264'} · ${mbpsText(profile.bitrateKbps)}${adjusted ? ' · ajustado' : ''}`;
      const base = baseProfile();
      if (document.activeElement !== A.ui.width) A.ui.width.value = String(profile.width);
      if (document.activeElement !== A.ui.height) A.ui.height.value = String(profile.height);
      A.ui.codec.value = profile.codec;
      A.ui.bitrate.value = String(kbpsToSlider(profile.bitrateKbps));
      A.ui.bitrateLabel.textContent = mbpsText(profile.bitrateKbps);
      A.ui.encoder.value = profile.encoder || 'auto';
      const fpsValue = profile.fps === 'source' || !profile.fps ? 'source' : String(profile.fps);
      if (![...A.ui.fps.options].some((opt) => opt.value === fpsValue)) A.ui.fps.append(el('option', { value: fpsValue }, `${fpsValue} quadros/s`));
      A.ui.fps.value = fpsValue;
      A.ui.encoderHint.textContent = encoderHint(profile);
      A.ui.encoderRecheck.hidden = !BF.state.tools.ffmpeg;
      A.ui.reset.hidden = !adjusted;
      A.ui.del.hidden = !(base && !base.builtin);
      const hints = [];
      if (base && adjusted && ratioChanged(base, profile)) hints.push(`As medidas ajustadas (${profile.width}×${profile.height}) mudaram a proporção deste perfil; em Detalhes, "Voltar aos valores do perfil" desfaz.`);
      if (base && base.framing) hints.push('Este perfil traz um enquadramento inicial, usado quando o projeto não define o seu.');
      A.ui.profileHint.textContent = hints.join(' ');
      A.ui.saveHint.textContent = Object.keys(ext().framing || {}).length ? 'O perfil guarda também o enquadramento padrão deste projeto.' : '';
    }

    function syncFraming() {
      if (!A.ui || !project()) return;
      const f = effectiveFraming();
      for (const btn of A.ui.modeButtons) btn.setAttribute('aria-pressed', String(btn.dataset.mode === f.mode));
      A.ui.hint.textContent = MODE_HINT[f.mode];
      const layout = targetLayout();
      const cut = !layout && S.target !== 'default' ? BF.project.cut(S.target) : null;
      const lc = layoutCtx();
      A.ui.restore.hidden = !hasOwnFraming();
      A.ui.restore.textContent = restoreLabel(layout, cut, lc);
      A.ui.targetLabel.textContent = layout ? `Layout ${LAY.LABELS[layout]} · vale para os cortes com esse layout`
        : cut ? `Só o corte ${numberOf(cut)} · ${cut.title}`
          : 'Padrão do projeto (vale para todos os cortes sem ajuste próprio)';
      A.ui.playerFrame.hidden = !layout;
      A.ui.cutLayout.hidden = !cut;
      if (cut) syncCutLayout(cut, lc);
      A.ui.ctlCenter.hidden = f.mode !== 'center';
      A.ui.ctlBlur.hidden = f.mode !== 'blur';
      A.ui.ctlStack.hidden = f.mode !== 'stack';
      A.ui.zoom.value = String(f.zoom);
      A.ui.zoomLabel.textContent = `${f.zoom.toFixed(2).replace('.', ',')}×`;
      A.ui.zoomB.value = String(f.zoom);
      A.ui.zoomBLabel.textContent = `${f.zoom.toFixed(2).replace('.', ',')}×`;
      A.ui.focusX.value = String(Math.round(f.focusX * 100));
      A.ui.focusXB.value = String(Math.round(f.focusX * 100));
      A.ui.focusY.value = String(Math.round(f.focusY * 100));
      A.ui.blur.value = String(f.blur.strength);
      A.ui.pct.value = String(f.stack.webcamHeightPct);
      A.ui.pctLabel.textContent = `${Math.round(f.stack.webcamHeightPct)}%`;
      for (const btn of A.ui.posButtons) btn.setAttribute('aria-pressed', String(btn.dataset.pos === f.stack.webcamPosition));
      for (const btn of A.ui.partButtons) btn.setAttribute('aria-pressed', String(btn.dataset.part === S.stackPart));
      // posição vertical só faz diferença quando há folga vertical (zoom ou fonte mais estreita)
      const profile = effectiveProfile();
      const size = sourceSize();
      const win = profile ? windowOf(f, profile, size.w, size.h) : { w: 1, h: 1 };
      A.ui.focusYField.hidden = win.h > 0.995;
      A.ui.focusXField.hidden = win.w > 0.995;
      A.ui.focusXBField.hidden = win.w > 0.995;
      syncStage();
    }

    function syncStage() {
      if (!A.ui) return;
      const profile = effectiveProfile();
      const range = previewRange();
      if (profile) {
        A.ui.prevBox.style.aspectRatio = `${profile.width} / ${profile.height}`;
        A.ui.stage.dataset.orient = profile.height > profile.width ? 'vertical' : profile.height < profile.width ? 'horizontal' : 'square';
      }
      const size = sourceSize();
      A.ui.srcBox.style.aspectRatio = `${size.w} / ${size.h}`;
      if (S.src.url && A.ui.srcImg.getAttribute('src') !== S.src.url) A.ui.srcImg.src = S.src.url;
      A.ui.srcImg.hidden = !S.src.url;
      A.ui.prevImg.hidden = !A.ui.prevImg.getAttribute('src');
      A.ui.stageNote.textContent = S.src.error || S.prev.error || (!BF.state.tools.ffmpeg ? 'Sem o FFmpeg não há prévia.' : '');
      A.ui.stageNote.hidden = !A.ui.stageNote.textContent;
      A.ui.timeRow.hidden = !(range.end > range.start);
      if (range.end > range.start) {
        const t = frameTime();
        A.ui.time.min = String(range.start);
        A.ui.time.max = String(range.end);
        A.ui.time.value = String(t);
        A.ui.timeLabel.textContent = `${range.label} · ${fmt(t)}`;
      }
      syncOverlay();
    }

    /** Retângulos arrastáveis sobre o quadro da fonte (frações da fonte). */
    function overlayRects() {
      const profile = effectiveProfile();
      if (!profile) return [];
      const f = effectiveFraming();
      const size = sourceSize();
      if (f.mode === 'center' || f.mode === 'blur') {
        const w = windowOf(f, profile, size.w, size.h);
        if (w.w > 0.995 && w.h > 0.995) return [];
        return [{ id: 'window', rect: w, kind: 'window', label: 'Parte do vídeo que aparece' }];
      }
      if (f.mode === 'custom') return [{ id: 'custom', rect: f.custom, kind: 'rect', label: 'Área do vídeo' }];
      const { cam, game } = stackHeights(f, profile);
      return [
        { id: 'webcam', rect: f.stack.webcamRect, kind: 'rect', label: 'Webcam', aspect: profile.width / Math.max(2, cam), active: S.stackPart === 'webcam' },
        { id: 'game', rect: f.stack.gameRect, kind: 'rect', label: 'Gameplay', aspect: profile.width / Math.max(2, game), active: S.stackPart === 'game' }
      ];
    }

    /**
     * Atualiza a sobreposição. Se os retângulos são os mesmos, só mexe nas caixas (um arrasto em andamento não
     * pode perder o elemento); senão refaz, devolvendo o foco do teclado ao mesmo retângulo.
     */
    function syncOverlay() {
      if (!A.ui) return;
      const items = overlayRects();
      const signature = JSON.stringify(items.map((i) => [i.id, i.active, i.aspect]));
      if (A.ui.overlay.dataset.sig === signature && A.ui.overlay.children.length === items.length) {
        items.forEach((item, index) => {
          const node = A.ui.overlay.children[index];
          node.rectItem.rect = item.rect;
          setBox(node, item.rect);
        });
        return;
      }
      const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.rect : null;
      A.ui.overlay.replaceChildren(...items.map((item) => overlayNode(item)));
      A.ui.overlay.dataset.sig = signature;
      if (focused) {
        const again = A.ui.overlay.querySelector(`[data-rect="${focused}"]`);
        if (again) again.focus();
      }
    }

    function setBox(node, r) {
      node.style.left = `${r.x * 100}%`;
      node.style.top = `${r.y * 100}%`;
      node.style.width = `${r.w * 100}%`;
      node.style.height = `${r.h * 100}%`;
    }

    function overlayNode(item) {
      const profile = effectiveProfile();
      const size = sourceSize();
      const aspectFor = item.aspect || (profile ? profile.width / profile.height : 1);
      const node = el('div', {
        class: `exp-rect ${item.id}${item.active === false ? ' dim' : ''}`, tabindex: '0', role: 'group', 'aria-label': `${item.label}: arraste ou use as setas`,
        dataset: { rect: item.id }
      }, el('span', { class: 'exp-rect-tag' }, item.label));
      setBox(node, item.rect);
      node.rectItem = item;
      const handle = item.kind === 'rect' ? el('span', { class: 'exp-handle', 'aria-hidden': 'true', dataset: { handle: item.id } }) : null;
      if (handle) node.append(handle);

      const apply = (r, commit) => {
        if (item.id === 'window') {
          const f = effectiveFraming();
          const w = windowOf(f, profile, size.w, size.h);
          editFraming((own) => {
            if (w.w < 1) own.focusX = clamp(r.x / (1 - w.w), 0, 1);
            if (w.h < 1) own.focusY = clamp(r.y / (1 - w.h), 0, 1);
          }, { commit });
        } else if (item.id === 'custom') {
          editFraming((own) => { own.custom = { x: r.x, y: r.y, w: r.w, h: r.h }; }, { commit });
        } else {
          const key = item.id === 'webcam' ? 'webcamRect' : 'gameRect';
          editFraming((own) => { own.stack = { ...(own.stack || {}), [key]: { x: r.x, y: r.y, w: r.w, h: r.h } }; }, { commit });
        }
      };

      node.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        if (item.id === 'webcam' || item.id === 'game') { S.stackPart = item.id; for (const b of A.ui.partButtons) b.setAttribute('aria-pressed', String(b.dataset.part === S.stackPart)); }
        event.preventDefault();
        const resizing = event.target === handle;
        const box = A.ui.srcBox.getBoundingClientRect();
        const start = { ...item.rect };
        const x0 = event.clientX;
        const y0 = event.clientY;
        node.setPointerCapture(event.pointerId);
        const move = (e) => {
          const dx = (e.clientX - x0) / box.width;
          const dy = (e.clientY - y0) / box.height;
          let r;
          if (resizing) r = fitRect(start.x, start.y, start.w + dx, aspectFor, size);
          else r = { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
          setBox(node, r);
          item.rect = r;
          apply(r, false);
        };
        const up = () => {
          node.removeEventListener('pointermove', move);
          node.removeEventListener('pointerup', up);
          node.removeEventListener('pointercancel', up);
          apply(item.rect, true);
        };
        node.addEventListener('pointermove', move);
        node.addEventListener('pointerup', up);
        node.addEventListener('pointercancel', up);
      });

      node.addEventListener('keydown', (event) => {
        const step = event.shiftKey ? 0.05 : 0.01;
        const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
        if (!delta) return;
        event.preventDefault();
        const r = { ...item.rect, x: clamp(item.rect.x + delta[0], 0, 1 - item.rect.w), y: clamp(item.rect.y + delta[1], 0, 1 - item.rect.h) };
        item.rect = r;
        apply(r, true);
      });
      return node;
    }

    /** Retângulo com a proporção do quadro de saída (em pixels da fonte), com largura w, cabendo na fonte. */
    function fitRect(x, y, w, aspect, size) {
      const hOf = (width) => (width * size.w) / (size.h * aspect);
      let width = clamp(w, MIN_RECT, 1 - x);
      let height = hOf(width);
      if (y + height > 1) { height = 1 - y; width = (height * size.h * aspect) / size.w; }
      if (height < MIN_RECT) { height = MIN_RECT; width = (height * size.h * aspect) / size.w; }
      return { x, y, w: Math.min(width, 1 - x), h: Math.min(height, 1 - y) };
    }

    /** Refaz a lista de cortes sem tirar o foco do teclado do controle em que o usuário estava. */
    function syncCuts() {
      if (!A.ui || !project()) return;
      const active = document.activeElement;
      const row = active && active.closest ? active.closest('#exp-cuts li') : null;
      const memo = row ? { id: row.dataset.id || 'default', tag: active.tagName } : null;
      renderCuts();
      if (memo) {
        const again = A.ui.cutsList.querySelector(memo.id === 'default' ? 'li.exp-cut-default' : `li[data-id="${memo.id}"]`);
        const control = again && again.querySelector(memo.tag === 'INPUT' ? 'input' : 'button');
        if (control) control.focus();
      }
    }

    /** Texto do link "Restaurar" conforme o alvo: padrão do projeto, preset de layout ou corte. */
    function restoreLabel(layout, cut, lc) {
      if (layout) {
        const from = presetsEffective({ withProject: false })[layout].from;
        return `Voltar ao padrão ${from === 'app' ? 'do app' : from === 'geral' ? 'geral' : from.startsWith('jogo') ? 'do jogo' : 'do canal'}`;
      }
      if (cut && LAY.suggestionOf(cut, { useSuggested: lc.useSuggested, localKey: lc.localKey })) return 'Restaurar para o sugerido';
      return 'Restaurar padrão';
    }

    /** De onde vem o layout sugerido, em poucas palavras (linha de apoio do corte). */
    function provenance(cut, origin, lc) {
      if (origin.via === 'ia') return ' · palpite da IA';
      if (origin.via === 'detector') return ' · detectado pela imagem';
      if (origin.kind !== 'chosen' && lc.useSuggested && LAY.localState(cut, lc.localKey) === 'uncertain') return ' · layout incerto';
      return '';
    }

    /** Explicação da origem do enquadramento do corte (dica do chip e nota do painel). */
    function originNote(cut, lc) {
      const { origin } = resolveCut(cut, lc);
      const name = (l) => LAY.LABELS[l];
      const suggestion = LAY.suggestionOf(cut, { useSuggested: true, localKey: lc.localKey }); // ignora o interruptor: serve para explicar
      const state = LAY.localState(cut, lc.localKey);
      const via = (v, conf) => (v === 'detector'
        ? `detectado pela imagem${Number.isFinite(conf) ? ` (${Math.round(conf * 100)}% de confiança)` : ''}`
        : 'palpite da IA: ela só lê o texto, não vê a imagem');
      const parts = [];
      if (origin.kind === 'custom') {
        parts.push('Enquadramento personalizado só deste corte.');
        if (origin.layout) parts.push(`Parte do layout ${name(origin.layout)} (${origin.base === 'chosen' ? 'escolhido por você' : via(origin.via, origin.confidence)}).`);
      } else if (origin.kind === 'suggested') {
        parts.push(`Layout ${name(origin.layout)} sugerido: ${via(origin.via, origin.confidence)}.`);
      } else if (origin.kind === 'chosen') {
        parts.push(`Layout ${name(origin.layout)} escolhido por você.`);
        if (suggestion && suggestion.layout !== origin.layout) parts.push(`A análise sugeria ${name(suggestion.layout)}.`);
      } else if (cut.layoutChoice === 'padrao') {
        parts.push(`Você escolheu o padrão para este corte.${suggestion ? ` A análise sugeria ${name(suggestion.layout)}.` : ''}`);
      } else if (!lc.useSuggested && suggestion) {
        parts.push(`A análise sugeriu ${name(suggestion.layout)}, mas "Usar o enquadramento sugerido pela análise" está desligado: vale o padrão do projeto.`);
      } else {
        parts.push('Sem layout sugerido: vale o padrão do projeto.');
      }
      if (lc.useSuggested && state === 'uncertain') parts.push('O detector não teve certeza do layout deste corte (a imagem não se parece com os quadros de referência).');
      if (state === 'stale') parts.push('A detecção pela imagem ficou desatualizada (mudaram as referências ou o trecho do corte): detecte de novo.');
      return parts.join(' ');
    }

    /** Chip com a origem do enquadramento: 'sugerido: Jogo', 'escolhido: Conversa', 'personalizado' ou 'padrão'. */
    function originChip(cut, origin, lc) {
      const variant = { custom: 'bds-chip-accent exp-badge', suggested: 'bds-chip-info', chosen: 'bds-chip-ok', default: '' }[origin.kind];
      return el('span', { class: `bds-chip exp-origin${variant ? ` ${variant}` : ''}`, dataset: { origin: origin.kind, layout: origin.layout || '' }, title: originNote(cut, lc) }, origin.label);
    }

    /** Seletor do layout do corte (Conversa | Jogo | Padrão) e a nota de onde vem o enquadramento. */
    function syncCutLayout(cut, lc) {
      const picked = LAY.layoutOfCut(cut, { useSuggested: lc.useSuggested, localKey: lc.localKey });
      const current = picked.layout || 'padrao';
      for (const btn of A.ui.cutLayoutButtons) btn.setAttribute('aria-pressed', String(btn.dataset.layout === current));
      A.ui.originNote.textContent = originNote(cut, lc);
    }

    /**
     * Define o layout de cortes. `choice`: 'conversa' | 'jogo' | 'padrao'. Escolher o que já valeria sem escolha (a sugestão, ou
     * o padrão quando nada é sugerido) só tira a escolha anterior: o corte volta a seguir a sugestão. Não mexe no enquadramento
     * próprio do corte (ele continua valendo por cima do layout).
     */
    function setCutLayout(ids, choice) {
      const lc = layoutCtx();
      let changed = 0;
      BF.project.update(() => {
        for (const id of ids) {
          const cut = BF.project.cut(id);
          if (!cut) continue;
          const without = LAY.layoutOfCut({ ...cut, layoutChoice: null }, { useSuggested: lc.useSuggested, localKey: lc.localKey }).layout || 'padrao';
          const before = cut.layoutChoice || null;
          const next = choice === without ? null : choice;
          if (next === before) continue;
          if (next) cut.layoutChoice = next; else delete cut.layoutChoice;
          cut.updatedAt = new Date().toISOString();
          changed += 1;
        }
      }, { reason: 'export:layout' });
      if (changed) BF.bus.emit('cuts:changed', { ids, from: 'export:framing' });
      afterFramingChange();
      return changed;
    }

    /** "Voltar ao sugerido" em lote: descarta a escolha de layout e o enquadramento próprio dos cortes (com confirmação se houver ajustes). */
    async function restoreCutsToSuggested(ids) {
      const withOwn = ids.map((id) => BF.project.cut(id)).filter((c) => c && (customized(c) || c.layoutChoice));
      if (!withOwn.length) return 0;
      const lost = withOwn.filter(customized).length;
      if (lost && !(await BF.ui.confirm({
        title: 'Voltar ao sugerido?',
        message: `${lost} ${lost === 1 ? 'corte tem' : 'cortes têm'} enquadramento personalizado, que será descartado. A escolha de layout também volta ao que a análise sugere.`,
        okLabel: 'Voltar ao sugerido', danger: true
      }))) return null; // cancelou: nada muda e nada é dito
      BF.project.update(() => {
        for (const c of withOwn) { const cut = BF.project.cut(c.id); if (cut) { cut.framing = null; delete cut.layoutChoice; cut.updatedAt = new Date().toISOString(); } }
      }, { reason: 'export:layout' });
      BF.bus.emit('cuts:changed', { ids: withOwn.map((c) => c.id), from: 'export:framing' });
      afterFramingChange();
      return withOwn.length;
    }

    async function bulkLayout(value) {
      const ids = checkedCuts().map((c) => c.id);
      A.ui.bulk.value = '';
      if (!ids.length) return;
      if (value === 'sugerido') {
        const n = await restoreCutsToSuggested(ids);
        if (n === null) return;
        BF.ui.toast(n ? `${n} ${n === 1 ? 'corte voltou' : 'cortes voltaram'} ao sugerido.` : 'Os cortes selecionados já seguem o sugerido.', 'ok');
        return;
      }
      const n = setCutLayout(ids, value);
      const label = value === 'padrao' ? 'o padrão' : `o layout ${LAY.LABELS[value]}`;
      BF.ui.toast(n ? `${n} ${n === 1 ? 'corte agora usa' : 'cortes agora usam'} ${label}.` : `Os cortes selecionados já usam ${label}.`, 'ok');
    }

    function renderCuts() {
      const cuts = listCuts();
      const lc = layoutCtx();
      const checked = cuts.filter(isChecked).length;
      A.ui.cutsHead.textContent = cuts.length ? `Cortes a exportar · ${checked} de ${cuts.length}` : 'Cortes a exportar';
      A.ui.cutsEmpty.hidden = cuts.length > 0;
      A.ui.cutsList.hidden = cuts.length === 0;
      const rows = [el('li', { class: `exp-cut exp-cut-default${S.target === 'default' ? ' on' : ''}` },
        el('button', { type: 'button', class: 'exp-cut-main', dataset: { target: 'default' }, 'aria-pressed': String(S.target === 'default'), onclick: () => setTarget('default') },
          el('span', { class: 'exp-cut-title' }, 'Padrão do projeto'),
          el('span', { class: 'exp-cut-sub' }, 'enquadramento de todos os cortes')))];
      for (const cut of cuts) {
        const on = isChecked(cut);
        const { origin } = resolveCut(cut, lc);
        rows.push(el('li', { class: `exp-cut${S.target === cut.id ? ' on' : ''}${on ? '' : ' off'}`, dataset: { id: cut.id } },
          el('input', { type: 'checkbox', checked: on, 'aria-label': `Exportar o corte ${numberOf(cut)}`, onchange: (e) => setChecked(cut, e.target.checked) }),
          el('button', { type: 'button', class: 'exp-cut-main', 'aria-pressed': String(S.target === cut.id), title: 'Ajustar o enquadramento e o layout só deste corte', onclick: () => setTarget(cut.id) },
            el('span', { class: 'exp-cut-title' }, `${numberOf(cut)} · ${cut.title}`),
            el('span', { class: 'exp-cut-sub' }, `${fmt(cut.end - cut.start)}${cut.status === 'approved' ? '' : ' · pendente'}${provenance(cut, origin, lc)}`)),
          originChip(cut, origin, lc)));
      }
      A.ui.cutsList.replaceChildren(...rows);
      A.ui.bulkRow.hidden = cuts.length === 0;
      A.ui.bulk.disabled = checked === 0;
      A.ui.bulk.title = checked === 0 ? 'Marque os cortes que quer ajustar' : '';
    }

    function syncDest() {
      if (!A.ui || !project()) return;
      A.ui.dir.textContent = outputDir();
      A.ui.dir.title = outputDir();
      if (document.activeElement !== A.ui.template) A.ui.template.value = ext().nameTemplate || DEFAULT_TEMPLATE;
      const first = S.qc.jobs[0];
      A.ui.example.textContent = first ? `Exemplo: ${first.baseName}.mp4` : '';
    }

    function syncQc() {
      if (!A.ui || !project()) return;
      const errors = groupIssues(S.qc.reports, 'errors');
      const warnings = groupIssues(S.qc.reports, 'warnings');
      const total = S.qc.reports.length;
      const who = (titles) => (total > 1 ? el('span', { class: 'exp-issue-who' }, titles.length === total ? ' (todos os cortes)' : ` (${titles.length} de ${total}: ${titles.slice(0, 3).join(', ')}${titles.length > 3 ? '…' : ''})`) : null);
      A.ui.qcErrors.replaceChildren(...errors.map((e) => el('li', { class: 'exp-issue error', dataset: { code: e.code } },
        el('strong', {}, 'Não vai exportar: '), e.message, who(e.titles),
        e.solution ? el('span', { class: 'exp-issue-fix' }, ` Como resolver: ${e.solution}`) : null)));
      A.ui.qcWarnList.replaceChildren(...warnings.map((w) => el('li', { class: 'exp-issue warn', dataset: { code: w.code } }, w.message, who(w.titles))));
      A.ui.qcWarn.hidden = warnings.length === 0;
      A.ui.qcWarnSummary.textContent = `${warnings.length} aviso${warnings.length === 1 ? '' : 's'} (não impedem a exportação)`;
      A.ui.qcError.hidden = !S.qc.error;
      A.ui.qcError.textContent = S.qc.error ? `Não foi possível conferir os cortes: ${S.qc.error}` : '';
      let status = '';
      if (!checkedCuts().length) status = '';
      else if (S.qc.pending && !S.qc.ready) status = 'Conferindo…';
      else if (S.qc.ready && total) {
        const bad = S.qc.reports.filter((r) => r.errors.length).length;
        if (bad) status = `${bad} de ${total} corte(s) com erro não serão exportados.`;
        else status = warnings.length ? 'Tudo pronto para exportar.' : 'Tudo pronto: nenhum problema encontrado.';
      }
      A.ui.qcStatus.textContent = status;
      const bad = S.qc.reports.some((r) => r.errors.length);
      A.ui.qcStatus.classList.toggle('bad', bad);
      A.ui.qcStatus.classList.toggle('ok', !bad && S.qc.ready && !S.qc.pending && total > 0);
      A.ui.qcStatus.classList.toggle('busy', S.qc.pending && !S.qc.ready);
      A.ui.qcStatus.hidden = !status;
      syncDest();
    }

    function syncAction() {
      if (!A.ui || !project()) return;
      const ready = S.qc.ready && !S.qc.pending;
      const okCount = ready ? S.qc.reports.filter((r) => !r.errors.length).length : checkedCuts().length;
      let reason = '';
      if (!effectiveProfile()) reason = S.profilesError ? 'Os perfis de exportação não carregaram: reinicie o app.' : 'Carregando os perfis…';
      else if (!BF.state.tools.ffmpeg) reason = 'FFmpeg não encontrado: instale-o e use "Verificar de novo" no aviso do topo (ou veja a aba Ferramentas).';
      else if (!checkedCuts().length) reason = listCuts().length ? 'Marque pelo menos um corte para exportar.' : 'Aprove cortes na aba Cortes para exportar.';
      else if (S.qc.error) reason = 'A conferência falhou: veja a mensagem acima.';
      else if (ready && okCount === 0) reason = 'Todos os cortes marcados têm erro: corrija os problemas acima.';
      A.ui.enqueue.textContent = okCount > 0 ? `Adicionar à fila (${okCount})` : 'Adicionar à fila';
      A.ui.enqueue.disabled = S.busy || Boolean(reason);
      A.ui.enqueueWhy.textContent = reason;
      A.ui.enqueueWhy.hidden = !reason;
    }

    function syncMessage() {
      if (!A.ui) return;
      A.ui.msg.hidden = !S.message;
      A.ui.msg.className = `exp-msg${S.message ? ` ${S.message.kind}` : ''}`;
      A.ui.msg.textContent = S.message ? S.message.text : '';
    }

    return { field, icon, syncAll, syncProfile, syncFraming, syncStage, syncOverlay, syncCuts, setCutLayout, bulkLayout, syncDest, syncQc, syncAction, syncMessage };
  };
})();

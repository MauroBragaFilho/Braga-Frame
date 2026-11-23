'use strict';

/**
 * Transcrição (Whisper): o lugar para instalar o que a legenda automática e a transcrição do vídeo precisam (dono: subtitles).
 *
 * Antes, o motor ficava na aba Ferramentas e o modelo só aparecia na aba Legendas, que exige um vídeo com um corte escolhido: quem começava
 * sem nada não conseguia instalar a transcrição. Aqui há um cartão único (o mesmo desenho do módulo de transcrição do BDS), na aba
 * Ferramentas, que não depende de projeto nenhum:
 *  - UM botão ("Instalar a transcrição") baixa o motor e o modelo recomendado, um depois do outro, com UMA confirmação que diz o tamanho
 *    total e de onde vem; sem o modelo, "Baixar o modelo"; com tudo pronto, o estado e "Remover o motor";
 *  - a lista de modelos (Baixar, Cancelar, Remover; tamanho de cada um);
 *  - a aceleração pela placa NVIDIA (opcional), com o aviso de que as bibliotecas da NVIDIA têm licença própria.
 * Os outros lugares só chamam `BF.transcription.install()` (aviso da aba Legendas sem corte, cartão da transcrição da aba Análise): ele
 * pergunta, leva à aba Ferramentas para o progresso aparecer e, no fim, devolve o usuário à tela de onde ele veio.
 *
 * Dados: subtitles:status (motor, modelos, placa); instalar: tools:install (motor e aceleração) e subtitles:installModel; progresso:
 * tools:progress e subtitles:modelProgress. Avisa com `transcription:updated` (o status chegou) e `transcription:changed` (o que está
 * instalado mudou: a Análise e as Legendas se atualizam). Módulo embutido: se o motor ou os modelos vêm do hospedeiro (BDS), o cartão
 * mostra "Fornecido pelo …" e não oferece o que é dele.
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;

  const ENGINE = 'whisper';
  const CUDA = 'whisper-cuda';
  const BIG_DOWNLOAD = 200 * 1024 * 1024;
  const FINAL_PHASES = ['done', 'cancelled', 'error'];

  let status = null;            // última resposta de subtitles:status
  let loadError = null;
  let loadSeq = 0;
  let lastSignature = null;
  let cardEl = null;
  let flow = null;              // instalação guiada: { steps, index, key, cancelled }
  const progress = new Map();   // 'engine' | 'cuda' | 'model:<id>' -> último evento de progresso
  const installing = new Set(); // chaves cujo download foi pedido por esta tela
  const cancelling = new Set();
  const removing = new Set();
  const errors = new Map();     // chave (ou 'flow') -> mensagem de erro
  const notes = new Map();      // chave (ou 'flow') -> aviso neutro (ex.: "Instalação cancelada.")

  // ---------- formatação ----------

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const value = n / 1024 ** i;
    return `${value.toLocaleString('pt-BR', { maximumFractionDigits: value >= 100 || i === 0 ? 0 : 1 })} ${units[i]}`;
  }

  function progressText(ev) {
    if (!ev) return 'Preparando…';
    if (ev.phase === 'download' && ev.received > 0) {
      const pct = ev.total ? Math.min(100, Math.floor((ev.received / ev.total) * 100)) : 0;
      const speed = ev.speedBps > 0 ? ` · ${fmtBytes(ev.speedBps)}/s` : '';
      return `Baixando… ${pct}% · ${fmtBytes(ev.received)} de ${fmtBytes(ev.total)}${speed}`;
    }
    return ev.message || 'Preparando…';
  }

  const hostName = () => (status && status.hostName) || 'aplicativo';
  const modelKey = (id) => `model:${id}`;
  const modelOf = (key) => (status && status.models.find((m) => modelKey(m.id) === key)) || null;

  // ---------- carga ----------

  const signature = () => (status
    ? JSON.stringify([status.engine.installed, status.engine.origin, status.engine.kind, Boolean(status.engine.cuda && status.engine.cuda.installed), status.models.filter((m) => m.installed).map((m) => m.id)])
    : null);

  async function load() {
    const seq = ++loadSeq;
    let res = await BF.api('subtitles:status');
    if (seq !== loadSeq) return status;
    // a detecção da placa ainda estava rodando: espera por ela e pergunta de novo (uma vez), como a aba Legendas
    if (res.ok && res.hardware && res.hardware.pending) {
      await BF.api('subtitles:hardware');
      if (seq !== loadSeq) return status;
      const again = await BF.api('subtitles:status');
      if (seq !== loadSeq) return status;
      if (again.ok) res = again;
    }
    if (res.ok) { status = res; loadError = null; } else { loadError = res.message || 'Não foi possível ler a situação da transcrição.'; }
    render();
    BF.bus.emit('transcription:updated');
    const sig = signature();
    if (lastSignature !== null && sig !== lastSignature) BF.bus.emit('transcription:changed');
    if (sig !== null) lastSignature = sig;
    return status;
  }

  // ---------- estado ----------

  const isRunning = (key) => installing.has(key)
    || (progress.has(key) && !FINAL_PHASES.includes(progress.get(key).phase))
    || Boolean(modelOf(key) && modelOf(key).busy);
  const anyRunning = () => Boolean(flow) || isRunning('engine') || isRunning('cuda') || (status ? status.models.some((m) => isRunning(modelKey(m.id))) : false);

  /** unavailable (sem pacote do motor neste sistema) | missing (sem motor) | no-model (motor sem nenhum modelo) | ready. */
  function phaseOf() {
    const e = status.engine;
    if (!e.installed) return e.available ? 'missing' : 'unavailable';
    return status.models.some((m) => m.installed) ? 'ready' : 'no-model';
  }

  /**
   * O que falta baixar. `modelId` pedido (a Análise sabe qual modelo o projeto usa): esse modelo. Sem pedido: o recomendado, e só se nenhum modelo
   * estiver baixado. -> { engine: boolean, model: item do status|null, bytes }
   */
  function planOf(modelId = null) {
    const e = status.engine;
    const installedModels = status.models.filter((m) => m.installed);
    const wanted = modelId
      ? status.models.find((m) => m.id === modelId) || null
      : (installedModels.length ? null : (status.models.find((m) => m.id === status.defaultModel) || status.models[0] || null));
    const engine = !e.installed && e.available;
    const model = wanted && !wanted.installed ? wanted : null;
    return { engine, model, bytes: (engine ? e.sizeBytes : 0) + (model ? model.sizeBytes : 0) };
  }

  const currentTab = () => {
    const app = document.getElementById('app');
    return app && app.dataset ? app.dataset.activeTab || null : null;
  };

  // ---------- desenho ----------

  const icon = (name) => el('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true' }, name);
  const chip = (text, kind, extra = '') => el('span', { class: `bds-chip${kind ? ` bds-chip-${kind}` : ''}${extra ? ` ${extra}` : ''}` }, text);

  /** act/model vão em data-*: o teclado volta ao mesmo botão depois de redesenhar e os testes o encontram. */
  function button(label, act, { model, primary = false, disabled = false, onClick, glyph } = {}) {
    return el('button', { type: 'button', class: primary ? 'primary sm' : 'secondary sm', dataset: { act, ...(model ? { model } : {}) }, disabled, onclick: onClick }, glyph ? icon(glyph) : null, label);
  }

  function iconButton(glyph, label, act, { model, disabled = false, onClick } = {}) {
    return el('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, dataset: { act, ...(model ? { model } : {}) }, disabled, onclick: onClick }, icon(glyph));
  }

  function progressBox(key, label) {
    const ev = progress.get(key);
    const known = ev && ev.phase === 'download' && ev.received > 0 && Number.isFinite(ev.percent);
    return el('div', { class: 'tr-progress', dataset: { key } },
      el('progress', { max: '100', value: known ? Math.round(ev.percent) : undefined, 'aria-label': label }),
      el('span', { class: 'tr-progress-text muted small', 'aria-live': 'off' }, progressText(ev)));
  }

  const errorLine = (key) => (errors.has(key) ? el('p', { class: 'tr-error', role: 'alert' }, icon('error'), el('span', {}, errors.get(key))) : null);
  const noteLine = (key) => (notes.has(key) ? el('p', { class: 'tr-note muted small' }, notes.get(key)) : null);

  function head(phase) {
    let text; let kind;
    if (anyRunning()) [text, kind] = ['Instalando…', 'accent'];
    else if (phase === 'unavailable') [text, kind] = ['Indisponível', 'bad'];
    else if (phase === 'missing') [text, kind] = ['Não instalada', ''];
    else if (phase === 'no-model') [text, kind] = ['Falta um modelo', 'warn'];
    else [text, kind] = ['Pronta', 'ok'];
    return el('div', { class: 'tools-head' },
      el('span', { class: 'tools-head-icon' }, icon('subtitles')),
      el('h2', {}, 'Transcrição (legendas automáticas)'),
      chip(text, kind, 'tr-status'));
  }

  function describePlan(plan) {
    const e = status.engine;
    const parts = [];
    if (plan.engine) parts.push(`o motor (${fmtBytes(e.sizeBytes)})`);
    if (plan.model) parts.push(`o modelo ${plan.model.label} (${fmtBytes(plan.model.sizeBytes)})`);
    if (!parts.length) return '';
    const what = parts.join(' e ');
    return `Baixa ${what}${parts.length === 2 ? `, ${fmtBytes(plan.bytes)} no total` : ''}, só desta vez. Fonte oficial, com tamanho e SHA-256 conferidos; dá para cancelar.`;
  }

  /** O que o motor é, em palavras: "motor do app · processador". */
  function engineSummary() {
    const e = status.engine;
    const who = e.origin === 'host' ? `motor do ${hostName()}` : (e.origin === 'system' ? 'motor do sistema' : 'motor do app');
    return `${who} · ${e.kind === 'cuda' ? 'pode usar a placa' : 'processador'}`;
  }

  function flowBlock() {
    const step = flow.steps[flow.index];
    const stopping = cancelling.has(flow.key);
    return el('div', { class: 'tr-main busy', dataset: { block: 'flow' } },
      el('div', { class: 'tr-main-text' },
        el('strong', {}, 'Instalando a transcrição…'),
        el('span', { class: 'muted' }, `Passo ${flow.index + 1} de ${flow.steps.length} · ${step.label}`)),
      el('div', { class: 'tr-main-actions' },
        button(stopping ? 'Cancelando…' : 'Cancelar', 'cancel-flow', { disabled: stopping, onClick: cancelFlow })),
      progressBox(flow.key, `Progresso: ${step.label}`));
  }

  function mainBlock(phase) {
    const e = status.engine;
    if (flow) return flowBlock();
    // o motor está sendo instalado por outro caminho (a aba Legendas, por exemplo): mostra o andamento e deixa cancelar
    if (isRunning('engine')) {
      return el('div', { class: 'tr-main busy', dataset: { block: 'engine' } },
        el('div', { class: 'tr-main-text' }, el('strong', {}, 'Instalando o motor de transcrição…')),
        el('div', { class: 'tr-main-actions' }, button(cancelling.has('engine') ? 'Cancelando…' : 'Cancelar', 'cancel-engine', { disabled: cancelling.has('engine'), onClick: () => cancelKey('engine') })),
        progressBox('engine', 'Progresso: motor de transcrição'));
    }
    const wait = removing.has('engine');
    const idle = anyRunning();
    if (phase === 'unavailable') {
      return el('div', { class: 'tr-main', dataset: { block: 'unavailable' } },
        el('div', { class: 'tr-main-text' },
          el('strong', {}, 'Indisponível neste sistema'),
          el('span', { class: 'muted' }, `${e.unavailableReason || ''} Sem ele não há legenda automática; você ainda pode escrever ou importar a legenda.`.trim())));
    }
    if (phase === 'missing' || phase === 'no-model') {
      const plan = planOf();
      const model = plan.model;
      const label = phase === 'missing' ? 'Instalar a transcrição' : `Baixar o modelo ${model ? model.label : ''}`.trim();
      return el('div', { class: 'tr-main', dataset: { block: phase } },
        el('div', { class: 'tr-main-text' },
          el('strong', {}, phase === 'missing' ? 'Instale para começar' : 'Falta um modelo'),
          el('span', { class: 'muted' }, phase === 'missing' ? describePlan(plan) : `O motor está instalado. ${describePlan(plan)}`.trim())),
        el('div', { class: 'tr-main-actions' },
          button(label, 'install-all', { primary: true, disabled: idle || wait || (!plan.engine && !plan.model), onClick: () => install() }),
          // motor instalado e sem modelo: dá para tirar o motor também (o app só apaga o que ele mesmo instalou)
          phase === 'no-model' && e.origin === 'app' ? button(wait ? 'Removendo…' : 'Remover o motor', 'remove-engine', { disabled: idle || wait, glyph: 'delete', onClick: removeEngine }) : null),
        errorLine('flow'), noteLine('flow'), errorLine('engine'));
    }
    const installed = status.models.filter((m) => m.installed);
    const removable = e.origin === 'app';
    return el('div', { class: 'tr-main', dataset: { block: 'ready' } },
      el('div', { class: 'tr-main-text' },
        el('strong', {}, 'Pronta para transcrever'),
        el('span', { class: 'muted' }, `${engineSummary()} · ${installed.length === 1 ? '1 modelo baixado' : `${installed.length} modelos baixados`}`)),
      removable
        ? el('div', { class: 'tr-main-actions' }, button(wait ? 'Removendo…' : 'Remover o motor', 'remove-engine', { disabled: idle || wait, glyph: 'delete', onClick: removeEngine }))
        : null,
      errorLine('flow'), noteLine('flow'), errorLine('engine'));
  }

  function modelRow(m) {
    const key = modelKey(m.id);
    const running = isRunning(key);
    const inFlow = Boolean(flow) && flow.key === key; // o andamento aparece no bloco principal
    const stopping = cancelling.has(key);
    const wait = removing.has(key);
    const locked = Boolean(flow);
    let actions;
    if (running) {
      actions = inFlow
        ? [chip('Baixando…', 'accent')]
        : [button(stopping ? 'Cancelando…' : 'Cancelar', 'cancel-model', { model: m.id, disabled: stopping, onClick: () => cancelKey(key) })];
    } else if (m.installed) {
      actions = [chip(m.managedByHost ? `Fornecido pelo ${m.hostName || hostName()}` : 'Baixado', 'ok')];
      if (!m.managedByHost) actions.push(iconButton('delete', wait ? 'Removendo…' : `Remover o modelo ${m.label}`, 'remove-model', { model: m.id, disabled: locked || wait, onClick: () => removeModel(m) }));
    } else {
      actions = [button('Baixar', 'install-model', { model: m.id, disabled: locked, onClick: () => installModel(m) })];
    }
    return el('li', { class: 'tr-model', dataset: { model: m.id, state: running ? 'busy' : (m.installed ? 'installed' : 'missing') } },
      el('div', { class: 'tr-model-main' },
        el('span', { class: 'tr-model-name' }, m.label, m.recommended ? chip('Recomendado', 'info', 'tr-tag') : null),
        el('span', { class: 'tr-model-desc muted' }, m.description)),
      el('span', { class: 'tr-model-size muted' }, fmtBytes(m.installed ? (m.installedSizeBytes || m.sizeBytes) : m.sizeBytes)),
      el('div', { class: 'tr-model-actions' }, actions),
      running && !inFlow ? progressBox(key, `Progresso: modelo ${m.label}`) : null,
      errorLine(key), noteLine(key));
  }

  function modelsBlock() {
    return el('div', { class: 'tr-section', dataset: { section: 'models' } },
      el('h3', { class: 'tr-subtitle' }, 'Modelos'),
      el('ul', { class: 'tr-models' }, status.models.map(modelRow)),
      status.modelsManagedByHost ? el('p', { class: 'muted small' }, `Os modelos são baixados e guardados pelo ${hostName()}.`) : null);
  }

  /** Aceleração pela placa NVIDIA: só com placa utilizável (ou já instalada, para poder remover). */
  function cudaBlock() {
    const e = status.engine;
    const cuda = e.cuda || {};
    const gpu = status.hardware && status.hardware.gpu;
    if (!cuda.installed && !(cuda.available && gpu && gpu.available)) return null;
    const running = isRunning('cuda');
    const idle = anyRunning();
    let body;
    if (running) {
      body = [
        el('div', { class: 'tr-main-text' }, el('strong', {}, 'Baixando a aceleração pela placa NVIDIA…')),
        el('div', { class: 'tr-main-actions' }, button(cancelling.has('cuda') ? 'Cancelando…' : 'Cancelar', 'cancel-cuda', { disabled: cancelling.has('cuda'), onClick: () => cancelKey('cuda') })),
        progressBox('cuda', 'Progresso: aceleração pela placa NVIDIA')];
    } else if (cuda.installed) {
      body = [
        el('div', { class: 'tr-main-text' }, el('strong', {}, 'Aceleração pela placa NVIDIA ativa'), el('span', { class: 'muted' }, gpu && gpu.summary ? `${gpu.summary} — a transcrição usa a placa.` : 'A transcrição usa a placa.')),
        !cuda.fromApp || cuda.managedByHost ? null : el('div', { class: 'tr-main-actions' }, iconButton('delete', removing.has('cuda') ? 'Removendo…' : 'Remover a aceleração pela placa NVIDIA', 'remove-cuda', { disabled: idle || removing.has('cuda'), onClick: removeCuda }))];
    } else {
      body = [
        el('div', { class: 'tr-main-text' },
          el('strong', {}, 'Aceleração pela placa NVIDIA'),
          el('span', { class: 'muted' }, `${gpu.summary || 'Placa NVIDIA'} — deixa a transcrição bem mais rápida. Download grande (${fmtBytes(cuda.sizeBytes)}), opcional: sem ele a transcrição continua no processador.`)),
        el('div', { class: 'tr-main-actions' }, button(`Baixar (${fmtBytes(cuda.sizeBytes)})`, 'install-cuda', { disabled: idle, onClick: installCuda }))];
    }
    return el('div', { class: `tr-main tr-cuda${running ? ' busy' : ''}`, dataset: { block: 'cuda' } }, body, errorLine('cuda'), noteLine('cuda'));
  }

  function skeleton() {
    return el('div', { class: 'tools-skeleton', role: 'status', 'aria-busy': 'true' },
      el('span', { class: 'sr-only' }, 'Lendo a situação da transcrição…'),
      el('div', { class: 'tool-skel', 'aria-hidden': 'true' }));
  }

  function build() {
    if (!status) {
      return [
        el('div', { class: 'tools-head' }, el('span', { class: 'tools-head-icon' }, icon('subtitles')), el('h2', {}, 'Transcrição (legendas automáticas)')),
        skeleton()
      ];
    }
    const phase = phaseOf();
    return [
      head(phase),
      el('p', { class: 'tr-intro muted' }, 'Gera as legendas e o texto das falas no seu computador: o áudio não sai daqui. Precisa do motor (Whisper) e de um modelo; é só na primeira vez.'),
      mainBlock(phase),
      modelsBlock(),
      cudaBlock()
    ].filter(Boolean);
  }

  /** Guarda qual botão está em foco para devolvê-lo depois de redesenhar (o teclado não perde o lugar). */
  function captureFocus() {
    const active = document.activeElement;
    if (!cardEl || !active || !cardEl.contains(active) || !active.dataset || !active.dataset.act) return null;
    return { act: active.dataset.act, model: active.dataset.model || null };
  }

  function restoreFocus(focus) {
    if (!focus) return;
    const enabled = [...cardEl.querySelectorAll('button')].filter((b) => !b.disabled);
    // o mesmo botão; se ele deixou de existir (o "Instalar" virou "Cancelar", o "Baixar" virou "Remover"), o que assume o lugar dele:
    // o da mesma linha de modelo ou, no bloco principal, o primeiro botão do cartão
    const target = enabled.find((b) => b.dataset.act === focus.act && (b.dataset.model || null) === focus.model)
      || (focus.model ? enabled.find((b) => b.dataset.model === focus.model) : enabled.find((b) => b.dataset.act === focus.act) || enabled[0]);
    if (target) target.focus();
  }

  function render() {
    if (!cardEl) return;
    const focus = captureFocus();
    cardEl.dataset.state = status ? (anyRunning() ? 'busy' : phaseOf()) : 'loading';
    if (cardEl.setAttribute) cardEl.setAttribute('aria-busy', status ? 'false' : 'true');
    cardEl.replaceChildren(...build());
    restoreFocus(focus);
  }

  /** O cartão da aba Ferramentas (o mesmo elemento sempre; ele se redesenha sozinho). */
  function card() {
    if (!cardEl) {
      cardEl = el('section', { class: 'tools-section panel tr-card', dataset: { card: 'transcription' } });
      render();
    }
    return cardEl;
  }

  /** O andamento chega várias vezes por segundo: atualiza só as barras em vez de redesenhar o cartão. */
  function updateBars(key, ev) {
    if (!cardEl) return false;
    const boxes = [...cardEl.querySelectorAll('.tr-progress')].filter((n) => n.dataset.key === key);
    if (!boxes.length) return false;
    for (const box of boxes) {
      const bar = box.querySelector('progress');
      if (bar) {
        if (ev.phase === 'download' && ev.received > 0 && Number.isFinite(ev.percent)) bar.value = Math.round(ev.percent);
        else bar.removeAttribute('value'); // sem percentual (conferindo, extraindo): barra indeterminada
      }
      const text = box.querySelector('.tr-progress-text');
      if (text) text.textContent = progressText(ev);
    }
    return true;
  }

  function onProgress(key, ev) {
    progress.set(key, ev);
    if (FINAL_PHASES.includes(ev.phase)) {
      if (!installing.has(key)) { progress.delete(key); cancelling.delete(key); load(); } // instalação iniciada por outro caminho terminou
      return;
    }
    if (!updateBars(key, ev)) render(); // iniciada por outro caminho: mostra o bloco com a barra
  }

  // ---------- ações ----------

  /** Uma instalação de verdade: mantém os registros desta tela e devolve a resposta do processo principal. */
  async function run(key, channel, payload, { quiet = false } = {}) {
    errors.delete(key);
    notes.delete(key);
    progress.delete(key);
    cancelling.delete(key);
    installing.add(key);
    render();
    const res = await BF.api(channel, payload);
    installing.delete(key);
    cancelling.delete(key);
    progress.delete(key);
    if (!quiet) {
      if (res.ok) {
        const done = key === 'engine' ? 'Motor de transcrição instalado.' : (key === 'cuda' ? 'Aceleração pela placa NVIDIA instalada.' : `Modelo ${(modelOf(key) || {}).label || ''} baixado.`);
        BF.ui.toast(done, 'ok');
      } else if (res.code === 'CANCELLED') notes.set(key, 'Download cancelado. Nada foi alterado.');
      else { errors.set(key, res.message); BF.ui.log(`Transcrição: ${res.message}`, 'error'); }
    }
    return res;
  }

  const runEngine = (opts) => run('engine', 'tools:install', { id: ENGINE }, opts);
  const runModel = (m, opts) => run(modelKey(m.id), 'subtitles:installModel', { id: m.id }, opts);

  function confirmText(plan) {
    const parts = [];
    if (plan.engine) parts.push(`o motor Whisper (${fmtBytes(status.engine.sizeBytes)}, da página oficial do whisper.cpp no GitHub)`);
    if (plan.model) parts.push(`o modelo ${plan.model.label} (${fmtBytes(plan.model.sizeBytes)}, do repositório oficial do whisper.cpp no Hugging Face)`);
    const list = parts.join(' e ');
    return `Para gerar legendas e transcrições o Braga Frame precisa baixar ${list}${parts.length === 2 ? `: ${fmtBytes(plan.bytes)} no total` : ''}. Depois disso tudo roda no seu computador. Os arquivos vêm só desses endereços, com tamanho e SHA-256 conferidos, e você pode cancelar durante o download.`;
  }

  async function runFlow(plan) {
    const steps = [];
    if (plan.engine) steps.push({ key: 'engine', label: 'Motor de transcrição (Whisper)' });
    if (plan.model) steps.push({ key: modelKey(plan.model.id), label: `Modelo ${plan.model.label}`, model: plan.model });
    flow = { steps, index: 0, key: steps[0].key, cancelled: false };
    errors.delete('flow');
    notes.delete('flow');
    render();
    let complete = true;
    for (let i = 0; i < steps.length; i += 1) {
      if (flow.cancelled) { complete = false; notes.set('flow', 'Instalação cancelada. O que já foi baixado e conferido continua instalado.'); break; }
      flow.index = i;
      flow.key = steps[i].key;
      render();
      const res = steps[i].model ? await runModel(steps[i].model, { quiet: true }) : await runEngine({ quiet: true });
      if (!res.ok) {
        complete = false;
        if (res.code === 'CANCELLED') notes.set('flow', 'Instalação cancelada. O que já foi baixado e conferido continua instalado.');
        else { errors.set('flow', res.message); BF.ui.log(`Transcrição: ${res.message}`, 'error'); }
        break;
      }
    }
    flow = null;
    await load();
    if (complete) BF.ui.toast('Transcrição pronta para usar.', 'ok');
    return complete;
  }

  /**
   * Instala o que falta da transcrição: pergunta uma vez (tamanho total e origem), leva à aba Ferramentas (onde o andamento aparece) e baixa o motor e,
   * em seguida, o modelo. `modelId`: o modelo que quem chamou precisa (a Análise usa o do projeto); sem ele, o recomendado, se nenhum estiver baixado.
   * No fim, se o usuário continua na aba Ferramentas, volta para a tela de onde saiu. Resolve true se a transcrição ficou pronta.
   */
  async function install({ modelId = null } = {}) {
    if (flow) return false;
    const origin = currentTab();
    await load();
    if (!status) { BF.ui.toast(loadError || 'Não foi possível ler a situação da transcrição.', 'error'); return false; }
    // sem pacote do motor para este sistema, baixar só o modelo não adianta
    if (!status.engine.installed && !status.engine.available) {
      BF.ui.toast(status.engine.unavailableReason || 'O motor de transcrição não está disponível neste sistema.', 'error');
      return false;
    }
    const plan = planOf(modelId);
    if (!plan.engine && !plan.model) return true; // já está tudo instalado
    const ok = await BF.ui.confirm({ title: 'Instalar a transcrição?', message: confirmText(plan), okLabel: 'Baixar e instalar' });
    if (!ok) return false;
    BF.ui.selectTab('tools');
    const done = await runFlow(plan);
    if (done && origin && origin !== 'tools' && currentTab() === 'tools') BF.ui.selectTab(origin);
    return done;
  }

  async function cancelKey(key) {
    cancelling.add(key);
    render();
    let res;
    if (key === 'engine') res = await BF.api('tools:cancel', { id: ENGINE });
    else if (key === 'cuda') res = await BF.api('tools:cancel', { id: CUDA });
    else res = await BF.api('subtitles:cancelModel', { id: key.slice('model:'.length) });
    if (!res.ok) {
      cancelling.delete(key);
      errors.set(key === 'engine' ? 'flow' : key, res.message);
      render();
    }
    // ok: a chamada de instalação volta com CANCELLED e redesenha
  }

  async function cancelFlow() {
    if (!flow) return;
    flow.cancelled = true; // o que ainda não começou não começa
    await cancelKey(flow.key);
  }

  async function installModel(m) {
    if (m.sizeBytes >= BIG_DOWNLOAD) {
      const ok = await BF.ui.confirm({
        title: `Baixar o modelo ${m.label}?`,
        message: `É um download grande: ${fmtBytes(m.sizeBytes)}. Vem só do repositório oficial do whisper.cpp (Hugging Face), com tamanho e SHA-256 conferidos, e você pode cancelar durante o download.`,
        okLabel: 'Baixar'
      });
      if (!ok) return;
    }
    await runModel(m);
    await load();
  }

  /** Remoção (motor, modelo, aceleração): confirma, pede ao processo principal e redesenha; o erro (ex.: "em uso") aparece no cartão. */
  async function removeWith(key, { title, message, channel, payload, done, errorKey = key }) {
    const sure = await BF.ui.confirm({ title, message, okLabel: 'Remover', danger: true });
    if (!sure) return;
    errors.delete(errorKey);
    notes.delete(errorKey);
    removing.add(key);
    render();
    const res = await BF.api(channel, payload);
    removing.delete(key);
    if (res.ok) BF.ui.toast(done, 'ok');
    else { errors.set(errorKey, res.message); BF.ui.log(`Transcrição: ${res.message}`, 'error'); }
    await load();
  }

  const removeEngine = () => removeWith('engine', {
    title: 'Remover o motor de transcrição?',
    message: 'O app apaga o motor que ele instalou. Os modelos baixados e a aceleração pela placa NVIDIA continuam no disco, e dá para instalar o motor de novo quando quiser.',
    channel: 'tools:remove', payload: { id: ENGINE }, done: 'Motor de transcrição removido.', errorKey: 'flow'
  });

  function removeModel(m) {
    const installed = status.models.filter((x) => x.installed);
    const last = installed.length === 1;
    return removeWith(modelKey(m.id), {
      title: `Remover o modelo ${m.label}?`,
      message: `O arquivo (${fmtBytes(m.installedSizeBytes || m.sizeBytes)}) é apagado do computador. Dá para baixar de novo quando precisar.${last ? ' É o único modelo baixado: a transcrição só volta a funcionar depois que você baixar um modelo.' : ''}`,
      channel: 'subtitles:removeModel', payload: { id: m.id }, done: `Modelo ${m.label} removido.`
    });
  }

  async function installCuda() {
    const size = status && status.engine.cuda ? status.engine.cuda.sizeBytes : 0;
    const ok = await BF.ui.confirm({
      title: 'Baixar a aceleração pela placa NVIDIA?',
      message: `É um download grande: ${fmtBytes(size)} (ocupa mais no disco depois de extraído) e é opcional: sem ele a transcrição continua funcionando no processador. Vem da página oficial do whisper.cpp, com tamanho e SHA-256 conferidos, e você pode cancelar durante o download. O pacote inclui bibliotecas da NVIDIA (CUDA), que têm licença própria: ao baixar, você concorda com os termos da NVIDIA.`,
      okLabel: 'Baixar e aceitar'
    });
    if (!ok) return;
    await run('cuda', 'tools:install', { id: CUDA });
    await load();
  }

  const removeCuda = () => removeWith('cuda', {
    title: 'Remover a aceleração pela placa NVIDIA?',
    message: 'A transcrição continua funcionando, mas no processador (bem mais devagar nos modelos grandes). Dá para baixar de novo quando quiser.',
    channel: 'tools:remove', payload: { id: CUDA }, done: 'Aceleração pela placa NVIDIA removida.'
  });

  // ---------- eventos ----------

  BF.on('tools:progress', (ev) => {
    if (!ev || typeof ev.id !== 'string') return;
    if (ev.id === ENGINE) onProgress('engine', ev);
    else if (ev.id === CUDA) onProgress('cuda', ev);
  });
  BF.on('subtitles:modelProgress', (ev) => {
    if (ev && typeof ev.id === 'string') onProgress(modelKey(ev.id), ev);
  });
  BF.bus.on('tools:changed', () => { if (cardEl) load(); });

  BF.transcription = {
    card, load, install, planOf: (modelId) => (status ? planOf(modelId) : null),
    /** Para quem redesenha a aba que hospeda o cartão (tools.js): guarda e devolve o foco do teclado de dentro dele. */
    captureFocus,
    restoreFocus,
    /** Já leu a situação (com sucesso) pelo menos uma vez? */
    loaded: () => Boolean(status),
    /** A leitura falhou e nunca deu certo (a aba Ferramentas volta a mostrar o motor como uma ferramenta comum). */
    failed: () => !status && loadError !== null
  };
})();

'use strict';

/**
 * Tela "Exportações" (aba `queue`, dono: queue). Mostra a fila de exportação do processo principal (src/core/queue) em três
 * pílulas com a contagem: FILA (esperando ou exportando; reordenar arrastando ou com ↑↓), CONCLUÍDOS (exportados, pulados e
 * cancelados) e FALHAS (com o motivo, o que fazer e "Tentar de novo"). Cada trabalho é um cartão: ícone do estado, título do corte,
 * perfil, selo de estado, barra de progresso com % e tempo restante e as ações do estado. No alto: pausar/retomar a fila, limpar
 * concluídos e cancelar tudo. Embaixo da lista fica a barra de SAÍDA: o perfil e o destino do projeto aberto (os mesmos da aba
 * Exportar, que continua sendo onde se prepara a exportação) e o limite de exportações ao mesmo tempo. Também: aviso de recuperação
 * depois de uma queda, diálogo de conflito de nome e Ajustes recolhidos.
 *
 * Funciona sem projeto aberto (sem ele a barra mostra só o limite). Quando um trabalho termina (`queue:jobDone`), anota a exportação
 * no corte (`cut.exports`) via BF.project.update se o projeto carregado for o do trabalho; ao carregar um projeto, confere
 * `queue:list` e anota o que terminou enquanto ele não estava aberto. O contrato dos canais está em docs/recursos/queue.md.
 */
(function () {
  const BF = window.BF;
  const { el, nameOf } = BF.util;

  const STATE_LABEL = {
    queued: 'Na fila', running: 'Exportando', paused: 'Pausado', done: 'Concluído', failed: 'Falhou',
    interrupted: 'Interrompido', cancelled: 'Cancelado', skipped: 'Pulado', needsAction: 'Precisa de você'
  };
  /** Cor do selo de cada estado (o texto do selo sempre diz o estado; a cor só reforça). */
  const STATE_KIND = {
    queued: '', running: 'accent', paused: 'info', done: 'ok', failed: 'bad',
    interrupted: 'warn', cancelled: '', skipped: '', needsAction: 'warn'
  };
  /** Ícone do cartão de cada estado (Material Symbols). */
  const STATE_ICON = {
    queued: 'schedule', running: 'movie', paused: 'pause_circle', done: 'check_circle', failed: 'error',
    interrupted: 'pause_circle', cancelled: 'cancel', skipped: 'skip_next', needsAction: 'warning'
  };
  const REORDERABLE = ['queued', 'interrupted', 'needsAction'];
  const ACTIVE = ['queued', 'running', 'needsAction', 'interrupted'];
  /** As três pílulas e os estados que cada uma mostra. Concluídos também junta o que terminou sem arquivo e sem erro (pulado, cancelado). */
  const TAB_KEYS = ['queue', 'done', 'failed'];
  const TAB_LABEL = { queue: 'Fila', done: 'Concluídos', failed: 'Falhas' };
  const GROUPS = { queue: ACTIVE, done: ['done', 'skipped', 'cancelled'], failed: ['failed'] };
  /** O que a pílula mostra quando está vazia: [título, explicação]. */
  const EMPTY = {
    queue: ['Nada na fila', 'Os cortes enviados pela aba Exportar aparecem aqui, com progresso e tempo restante.'],
    done: ['Nenhuma exportação concluída', 'Os arquivos exportados aparecem aqui, com atalho para abrir a pasta.'],
    failed: ['Nenhuma falha', 'Se uma exportação falhar, o motivo e o que fazer aparecem aqui.']
  };

  // ---------- funções puras (também em BF.queue, para teste) ----------

  const clock = (sec) => {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  /** "~45 s", "~2 min 05 s", "~1 h 10 min". */
  function fmtEta(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '';
    const s = Math.max(1, Math.round(sec));
    if (s < 60) return `~${s} s`;
    if (s < 3600) return `~${Math.floor(s / 60)} min${s % 60 ? ` ${String(s % 60).padStart(2, '0')} s` : ''}`;
    return `~${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
  }

  const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  const sameProject = (project, job) => Boolean(project && ((job.projectId && project.id === job.projectId) || (!job.projectId && norm(project.source && project.source.path) === norm(job.sourcePath))));

  /**
   * Anota a exportação concluída no corte do projeto carregado. Idempotente (mesmo arquivo ou mesmo trabalho
   * não entra duas vezes). Devolve true se alterou o projeto.
   */
  function applyDone(job, output) {
    const project = BF.state.project;
    if (!job || !output || !sameProject(project, job) || !job.cut) return false;
    const cut = BF.project.cut(job.cut.id);
    if (!cut) return false;
    if (cut.exports.some((e) => e.jobId && e.jobId === job.id)) return false;
    const at = job.finishedAt || new Date().toISOString();
    // Outro trabalho gravou o MESMO arquivo depois (o usuário escolheu "Substituir"): o arquivo agora é o do trabalho novo, então a
    // anotação passa a descrevê-lo (perfil, intervalo, chave). Um trabalho mais antigo ou sem data não mexe numa anotação existente
    // (é o que impede a reconciliação, que revê todos os concluídos, de ficar trocando a anotação a cada abertura do projeto).
    const sameFile = cut.exports.find((e) => e.path === output);
    if (sameFile && !(job.finishedAt && String(job.finishedAt) > String(sameFile.at || ''))) return false;
    const entry = {
      path: output, at, start: job.cut.start, end: job.cut.end,
      profile: job.profile, jobId: job.id, key: job.key, revision: job.cut.revision
    };
    BF.project.update(() => {
      if (sameFile) Object.assign(sameFile, entry);
      else cut.exports.push(entry);
    }, { reason: 'queue:done' });
    BF.bus.emit('cuts:changed', { ids: [cut.id], from: 'queue:done' });
    return true;
  }

  /** Anota no projeto carregado tudo o que a fila concluiu enquanto ele não estava aberto. */
  function reconcile(jobs) {
    let changed = 0;
    for (const job of jobs || []) if (job.state === 'done' && applyDone(job, job.output)) changed += 1;
    return changed;
  }

  /** Ordem de exibição da Fila: executando primeiro; o resto na ordem da fila. */
  function activeOrder(jobs) {
    const active = jobs.filter((j) => ACTIVE.includes(j.state));
    return [...active.filter((j) => j.state === 'running'), ...active.filter((j) => j.state !== 'running')];
  }

  /** Em qual pílula cai o trabalho: 'queue', 'done' ou 'failed' (null se o estado for desconhecido). */
  function groupOf(job) {
    return TAB_KEYS.find((key) => GROUPS[key].includes(job.state)) || null;
  }

  /** Os trabalhos de cada pílula, na ordem em que aparecem: a Fila como o main a guarda (executando primeiro); as outras, do mais recente ao mais antigo. */
  function groupJobs(jobs) {
    const newestFirst = (list) => list.sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')));
    return {
      queue: activeOrder(jobs),
      done: newestFirst(jobs.filter((j) => GROUPS.done.includes(j.state))),
      failed: newestFirst(jobs.filter((j) => GROUPS.failed.includes(j.state)))
    };
  }

  // ---------- estado ----------

  const state = {
    jobs: [], running: 0, paused: false, parallel: 1, active: 0, blocked: null, throttled: null,
    recovery: { pending: false, jobs: [] }, loadWarning: null, saveError: null, settings: null,
    loaded: false, error: null,
    progress: new Map(), // id -> { p, etaSec }
    prev: new Map(), // id -> estado anterior (para avisar quando algo falha)
    burst: { done: 0, failed: 0, skipped: 0, cancelled: 0 }, // desde que a fila começou a trabalhar
    dragId: null,
    dismissedConflicts: new Set(),
    conflictQueue: [],
    conflictJobs: new Map(),
    conflictOpen: false,
    noticeHidden: new Set(),
    tab: 'queue', // a pílula mostrada: 'queue' | 'done' | 'failed'
    ui: null
  };

  function applySnapshot(s) {
    if (!s || !Array.isArray(s.jobs)) return;
    const before = state.prev;
    const nextPrev = new Map();
    for (const job of s.jobs) {
      const was = before.get(job.id);
      if (was && was !== job.state) noteTransition(job, was);
      nextPrev.set(job.id, job.state);
      if (job.state !== 'running') state.progress.delete(job.id);
      else if (Number.isFinite(job.progress) && !state.progress.has(job.id)) state.progress.set(job.id, { p: job.progress, etaSec: job.etaSec });
    }
    state.prev = nextPrev;
    state.jobs = s.jobs;
    for (const key of ['running', 'paused', 'parallel', 'active', 'blocked', 'throttled', 'recovery', 'loadWarning', 'saveError', 'settings']) {
      if (s[key] !== undefined) state[key] = s[key];
    }
    if (!state.recovery) state.recovery = { pending: false, jobs: [] };
    state.loaded = true;
    state.error = null;
    for (const job of state.jobs) if (job.state !== 'needsAction') state.dismissedConflicts.delete(job.id);
    if (!state.active && Object.values(state.burst).some(Boolean)) announceFinished();
  }

  /** Avisos de quem mudou de estado (só depois da primeira carga; a abertura do app não dispara avisos). */
  function noteTransition(job, was) {
    const title = (job.cut && job.cut.title) || job.baseName;
    if (job.state === 'done') state.burst.done += 1;
    else if (job.state === 'skipped') state.burst.skipped += 1;
    else if (job.state === 'cancelled') state.burst.cancelled += 1;
    else if (job.state === 'failed') {
      state.burst.failed += 1;
      const msg = `Falha ao exportar “${title}”: ${job.error ? job.error.message : 'erro desconhecido'}`;
      BF.ui.log(msg, 'error');
    } else if (job.state === 'running' && was === 'queued' && job.runs > 1 && job.lastError) {
      BF.ui.log(`Tentando de novo “${title}” (tentativa ${job.runs} de ${(state.settings ? state.settings.retries : 2) + 1}).`);
    }
  }

  function announceFinished() {
    const { done, failed, skipped, cancelled } = state.burst;
    state.burst = { done: 0, failed: 0, skipped: 0, cancelled: 0 };
    if (!done && !failed && !skipped) return;
    const parts = [`${done} exportado(s)`];
    if (skipped) parts.push(`${skipped} pulado(s)`);
    if (failed) parts.push(`${failed} com falha`);
    if (cancelled) parts.push(`${cancelled} cancelado(s)`);
    BF.ui.toast(`Fila concluída: ${parts.join(', ')}.`, failed ? 'error' : 'ok');
  }

  async function refresh() {
    const res = await BF.api('queue:list');
    if (res.ok) { if (!reorderPending) applySnapshot(res); } // com movimentos a caminho a tela já mostra a ordem certa (veja "Reordenar")
    else { state.error = res.message; state.loaded = true; }
    render();
    return res;
  }

  // ---------- ações ----------

  const jobTitle = (job) => (job.cut && job.cut.title) || job.baseName || 'corte';

  async function act(channel, payload, { quiet = false } = {}) {
    const res = await BF.api(channel, payload, { toast: !quiet });
    if (!res.ok) await refresh(); // o que a tela mostra pode estar velho
    return res;
  }

  async function togglePause() {
    if (state.paused) {
      const res = await act('queue:resume', {});
      if (res.ok) BF.ui.log('Fila retomada.', 'ok');
    } else {
      await act('queue:pause', {});
    }
  }

  async function interruptCurrent() {
    const sure = await BF.ui.confirm({
      title: 'Interromper as exportações em andamento?',
      message: 'Cada exportação em andamento é encerrada, volta para a fila e recomeça do início quando você retomar. Nenhum arquivo pela metade é deixado na pasta.',
      okLabel: 'Interromper', cancelLabel: 'Deixar terminar', danger: true
    });
    if (sure) await act('queue:pause', { interrupt: true });
  }

  async function cancelAll() {
    const n = state.jobs.filter((j) => ACTIVE.includes(j.state)).length;
    if (!n) return;
    const sure = await BF.ui.confirm({
      title: `Cancelar ${n} trabalho(s) da fila?`,
      message: 'As exportações em andamento são encerradas e o que estava na fila não será exportado. Arquivos que já foram exportados não são apagados.',
      okLabel: 'Cancelar tudo', cancelLabel: 'Voltar', danger: true
    });
    if (sure) await act('queue:cancel', { all: true });
  }

  async function recover(action) {
    const res = await act('queue:recover', { action });
    if (res.ok) BF.ui.log(action === 'resume' ? 'Exportações interrompidas voltaram à fila.' : 'Exportações interrompidas descartadas.', 'ok');
  }

  async function reveal(job) {
    const target = job.output || job.conflictPath;
    if (target) await BF.api('shell:reveal', { path: target }, { toast: true });
  }

  // ---------- reordenar ----------
  // Cada movimento (↑/↓ ou arrastar) mostra a ordem nova na hora e manda a lista completa ao main. Os pedidos saem UM POR VEZ
  // (o main os aplica na ordem em que chegam) e cada movimento parte da ordem que o usuário está vendo. Enquanto algum pedido
  // está a caminho, os queue:update que chegam são descartados: eles mostram uma ordem ANTERIOR ao último movimento e
  // desfariam a tela (o movimento seguinte partiria de uma base velha e se perderia). Ao terminar, um queue:list traz a
  // ordem final do main.
  let reorderChain = Promise.resolve();
  let reorderPending = 0;

  async function move(job, delta) {
    const ids = reorderableIds();
    const i = ids.indexOf(job.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const sent = sendOrder(ids); // a ordem nova já está na tela quando esta chamada devolve a promessa
    const row = rowFor(job.id);
    const button = row && row.querySelector(`[data-act="${delta < 0 ? 'up' : 'down'}"]`);
    if (button) button.focus(); // o teclado não perde o lugar
    await sent;
  }

  function reorderableIds() {
    return activeOrder(state.jobs).filter((j) => REORDERABLE.includes(j.state)).map((j) => j.id);
  }

  function sendOrder(ids) {
    // mostra já a nova ordem; o main confirma e o último pedido da sequência recarrega a lista
    const rank = new Map(ids.map((id, i) => [id, i]));
    const slots = state.jobs.map((j, i) => (rank.has(j.id) ? i : -1)).filter((i) => i >= 0);
    const ordered = [...state.jobs.filter((j) => rank.has(j.id))].sort((a, b) => rank.get(a.id) - rank.get(b.id));
    const next = [...state.jobs];
    slots.forEach((slot, i) => { next[slot] = ordered[i]; });
    state.jobs = next;
    reorderPending += 1;
    render();
    const run = async () => {
      try {
        await act('queue:reorder', { ids });
      } finally {
        reorderPending -= 1;
        if (reorderPending === 0) await refresh();
      }
    };
    const request = reorderChain.then(run);
    reorderChain = request.catch(() => {}); // um pedido que falha não trava os seguintes
    return request;
  }

  async function removeJob(job) {
    await act('queue:remove', { id: job.id });
  }

  async function retryJob(job) {
    const res = await act('queue:retry', { id: job.id });
    if (res.ok && state.paused) BF.ui.toast('A fila está pausada: o trabalho começa quando você retomar.', '');
  }

  async function clearFinished() {
    await act('queue:clearFinished', {});
  }

  async function saveSetting(patch) {
    const res = await BF.api('queue:setSettings', patch, { toast: true });
    if (res.ok) state.settings = res.settings;
    else await refresh();
    renderSettings();
  }

  /** O paralelismo "padrão" segue a preferência queue.parallel (BF.prefs, que já aplica jogo/canal). */
  function syncPreferredParallel() {
    const raw = Number(BF.prefs.get('queue.parallel', 1));
    const wanted = Math.min(4, Math.max(1, Number.isInteger(raw) ? raw : 1));
    if (state.settings && state.settings.defaultParallel === wanted) return;
    BF.api('queue:setSettings', { defaultParallel: wanted }).then((res) => { if (res.ok) { state.settings = res.settings; renderSettings(); } });
  }

  // ---------- diálogo de conflito de nome ----------

  const pendingConflicts = () => state.jobs.filter((j) => j.state === 'needsAction');

  function pumpConflicts() {
    if (state.conflictOpen || !state.conflictQueue.length) return;
    if (document.getElementById('modalRoot').children.length) { setTimeout(pumpConflicts, 400); return; } // outro modal na frente
    while (state.conflictQueue.length) {
      const id = state.conflictQueue.shift();
      const known = state.jobs.find((j) => j.id === id);
      // o evento queue:conflict chega antes do queue:update: vale o trabalho que veio no evento
      const job = state.conflictJobs.get(id) || known;
      state.conflictJobs.delete(id);
      if (job && job.state === 'needsAction' && !state.dismissedConflicts.has(id)) { openConflict(job); return; }
    }
  }

  let pumpTimer = null;
  function queueConflict(job, { force = false } = {}) {
    if (!job || !job.id) return;
    if (force) state.dismissedConflicts.delete(job.id);
    state.conflictJobs.set(job.id, job);
    if (!state.conflictQueue.includes(job.id)) state.conflictQueue.push(job.id);
    // vários conflitos costumam chegar juntos: um instante para juntá-los antes de perguntar (e oferecer "fazer o mesmo com os outros")
    clearTimeout(pumpTimer);
    pumpTimer = setTimeout(pumpConflicts, force ? 0 : 150);
  }

  /** Quantos OUTROS trabalhos esperam decisão (os do último queue:update e os avisados por queue:conflict). */
  function otherConflicts(job) {
    const ids = new Set(pendingConflicts().map((j) => j.id));
    for (const id of state.conflictQueue) ids.add(id);
    ids.delete(job.id);
    return ids.size;
  }

  /** Pergunta o que fazer com o nome repetido. Resolve { action, all } ou null (decidir depois). */
  function askConflict(job, others) {
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const fileName = nameOf(job.conflictPath || `${job.baseName}.mp4`);
      const folder = job.outputDir;
      const titleId = 'q-conflict-title';
      const msgId = 'q-conflict-msg';
      const all = others > 0 ? el('input', { type: 'checkbox', id: 'q-conflict-all' }) : null;
      const dialog = el('div', { class: 'bf-modal q-conflict', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': msgId },
        el('div', { class: 'q-conflict-head' }, icon('file_copy', 'q-conflict-icon'), el('h2', { id: titleId }, 'Já existe um arquivo com este nome')),
        el('p', { id: msgId, class: 'bf-modal-msg' }, `“${fileName}” já está em ${folder}.\nNada será sobrescrito sem a sua escolha. Corte: ${jobTitle(job)}.`),
        all ? el('label', { class: 'q-check', for: 'q-conflict-all' }, all, el('span', {}, `Fazer o mesmo com os outros ${others} (exceto substituir)`)) : null,
        el('div', { class: 'bf-modal-actions q-conflict-actions' },
          el('button', { type: 'button', class: 'secondary', dataset: { act: 'skip' } }, 'Pular'),
          el('button', { type: 'button', class: 'secondary danger', dataset: { act: 'replace' } }, 'Substituir…'),
          el('button', { type: 'button', class: 'primary', dataset: { act: 'rename' } }, 'Salvar com outro nome')),
        el('p', { class: 'muted small q-conflict-hint' }, 'Esc: decidir depois (o trabalho fica esperando na fila).'));
      const backdrop = el('div', { class: 'bf-modal-backdrop q-conflict-backdrop' }, dialog);
      let closed = false;
      const close = (value) => {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        document.getElementById('app').inert = false;
        if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
        resolve(value);
      };
      const choose = (action) => close({ action, all: Boolean(all && all.checked) });
      function onKey(event) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(null); }
        else if (event.key === 'Tab') {
          const items = [...dialog.querySelectorAll('input, button')];
          const first = items[0];
          const last = items[items.length - 1];
          if (!dialog.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
          else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }
      for (const button of dialog.querySelectorAll('button[data-act]')) button.addEventListener('click', () => choose(button.dataset.act));
      backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close(null); });
      document.addEventListener('keydown', onKey, true);
      document.getElementById('app').inert = true;
      document.getElementById('modalRoot').append(backdrop);
      dialog.querySelector('[data-act="rename"]').focus();
    });
  }

  async function openConflict(job) {
    state.conflictOpen = true;
    try {
      for (;;) {
        const choice = await askConflict(job, otherConflicts(job));
        if (!choice) { // Esc: decidir depois (de todos os que esperam; o aviso "Resolver…" reabre)
          for (const j of pendingConflicts()) state.dismissedConflicts.add(j.id);
          for (const id of state.conflictQueue) state.dismissedConflicts.add(id);
          state.dismissedConflicts.add(job.id);
          state.conflictQueue = [];
          render();
          return;
        }
        if (choice.action === 'replace') {
          const sure = await BF.ui.confirm({
            title: 'Substituir o arquivo existente?',
            message: `“${nameOf(job.conflictPath || job.baseName)}” será trocado pelo novo corte, mas só quando a exportação terminar com sucesso. Se algo falhar, o arquivo atual continua intacto.`,
            okLabel: 'Substituir', cancelLabel: 'Voltar', danger: true
          });
          if (!sure) continue; // volta ao diálogo de escolha
        }
        const targets = choice.all && choice.action !== 'replace' ? pendingConflicts().map((j) => j.id) : [job.id];
        for (const id of targets) {
          const res = await BF.api('queue:resolveConflict', { id, action: choice.action }, { toast: true });
          if (!res.ok) break;
        }
        return;
      }
    } finally {
      state.conflictOpen = false;
      setTimeout(pumpConflicts, 0);
    }
  }

  // ---------- desenho ----------

  const rows = new Map(); // id -> { li, sig }

  function rowFor(id) {
    const entry = rows.get(id);
    return entry ? entry.li : null;
  }

  function sourceLine(job) {
    const profile = job.profile || {};
    const label = profile.name || (profile.width && profile.height ? `${profile.width}×${profile.height}` : '');
    const cut = job.cut || {};
    const span = Number.isFinite(cut.start) && Number.isFinite(cut.end) ? `${clock(cut.start)}–${clock(cut.end)}` : '';
    return [nameOf(job.sourcePath || ''), span, label].filter(Boolean).join(' · ');
  }

  function progressInfo(job) {
    const live = state.progress.get(job.id);
    const p = live ? live.p : job.progress;
    const eta = live && live.etaSec !== undefined && live.etaSec !== null ? live.etaSec : job.etaSec;
    return { p: Number.isFinite(p) ? p : 0, eta };
  }

  function progressText(job) {
    if (job.stopping) return job.stopping === 'cancel' ? 'Cancelando…' : 'Interrompendo…';
    if (job.phase === 'preflight') return 'Verificando antes de exportar…';
    const { p, eta } = progressInfo(job);
    const left = Number.isFinite(eta) ? fmtEta(eta) : '';
    return `${Math.round(p * 100)}%${left ? ` · faltam ${left}` : ''}`;
  }

  function retryNote(job) {
    const total = (state.settings ? state.settings.retries : 2) + 1;
    const secs = Math.max(0, Math.ceil((job.retryAt - Date.now()) / 1000));
    return `Falhou por um motivo passageiro (${job.error ? job.error.message : 'erro'}). Nova tentativa em ${secs} s (tentativa ${job.runs + 1} de ${total}).`;
  }

  function noteFor(job) {
    switch (job.state) {
      case 'failed': return null; // o bloco de erro cuida
      case 'queued': return job.retryAt && job.retryAt > Date.now() ? retryNote(job) : null;
      case 'needsAction': return `O arquivo “${nameOf(job.conflictPath || job.baseName)}” já existe na pasta de destino. Escolha o que fazer; nada é sobrescrito sem a sua escolha.`;
      case 'interrupted': return job.interruptedBy === 'pause'
        ? 'Interrompido por você. Volta à fila ao retomar e a exportação recomeça do início.'
        : 'O app foi fechado com este trabalho em andamento. A exportação recomeça do início quando ele voltar à fila.';
      case 'cancelled': return job.cancelReason || 'Cancelado.';
      case 'skipped': return job.skippedReason || 'Pulado.';
      case 'done': return job.output ? nameOf(job.output) : 'Concluído.';
      default: return null;
    }
  }

  const icon = (name, cls = '') => el('span', { class: `material-symbols-rounded${cls ? ` ${cls}` : ''}`, 'aria-hidden': 'true' }, name);

  function errorBlock(job) {
    const err = job.error;
    if (job.state !== 'failed' || !err) return null;
    return el('div', { class: 'q-error', role: 'group', 'aria-label': 'Motivo da falha' },
      icon('error'),
      el('div', { class: 'q-error-body' },
        el('p', { class: 'q-error-msg' }, err.message),
        err.solution ? el('p', { class: 'q-error-fix' }, err.solution) : null,
        err.technical ? el('details', { class: 'q-tech' }, el('summary', {}, 'Detalhes técnicos'), el('pre', {}, err.technical)) : null));
  }

  function warningsBlock(job) {
    const list = Array.isArray(job.warnings) ? job.warnings : [];
    if (!list.length || !['done', 'running', 'failed', 'skipped', 'cancelled'].includes(job.state)) return null;
    return el('details', { class: 'q-warns' },
      el('summary', {}, `${list.length} aviso(s)`),
      el('ul', {}, list.map((w) => el('li', {}, w.message))));
  }

  /** Ação com texto (`.sm`): a principal do estado (`primary`, só onde o trabalho pede uma decisão) ou secundária. */
  function button(label, action, job, { primary = false, disabled = false, title, aria } = {}) {
    return el('button', {
      type: 'button', class: primary ? 'primary sm' : 'secondary sm', disabled, title,
      'aria-label': aria || `${label}: ${jobTitle(job)}`, dataset: { act: action, id: job.id }
    }, label);
  }

  /** Ação discreta, só o ícone (o nome fica no title e no aria-label). */
  function iconButton(name, label, action, job, { disabled = false, aria } = {}) {
    return el('button', {
      type: 'button', class: 'icon-btn', disabled, title: label,
      'aria-label': aria || `${label}: ${jobTitle(job)}`, dataset: { act: action, id: job.id }
    }, icon(name));
  }

  function actionsFor(job) {
    const out = [];
    const stopping = Boolean(job.stopping);
    switch (job.state) {
      case 'running':
        out.push(button(stopping ? 'Parando…' : 'Cancelar', 'cancel', job, { disabled: stopping, aria: `Cancelar a exportação de ${jobTitle(job)}` }));
        break;
      case 'queued':
        out.push(iconButton('delete', 'Remover da fila', 'remove', job, { aria: `Remover ${jobTitle(job)} da fila` }));
        break;
      case 'needsAction':
        out.push(button('Resolver…', 'resolve', job), iconButton('close', 'Cancelar', 'cancel', job)); // o destaque fica no aviso do topo ("Resolver…")
        break;
      case 'interrupted':
        out.push(button('Voltar à fila', 'retry', job, { primary: true, title: 'O trabalho recomeça do início' }), iconButton('close', 'Cancelar', 'cancel', job));
        break;
      case 'failed':
        out.push(button('Tentar de novo', 'retry', job, { primary: true }), iconButton('delete', 'Remover', 'remove', job));
        break;
      case 'cancelled':
        out.push(button('Tentar de novo', 'retry', job), iconButton('delete', 'Remover', 'remove', job));
        break;
      case 'skipped':
        if (job.skippedCode === 'ALREADY_DONE') out.push(button('Exportar de novo', 'retry', job, { title: 'Refaz o trabalho, mesmo já tendo sido exportado' }));
        else if (job.skippedCode !== 'ALREADY_QUEUED') out.push(button('Tentar de novo', 'retry', job));
        if (job.output) out.push(iconButton('folder_open', 'Mostrar na pasta', 'reveal', job));
        out.push(iconButton('delete', 'Remover', 'remove', job));
        break;
      case 'done':
        out.push(iconButton('folder_open', 'Mostrar na pasta', 'reveal', job), iconButton('delete', 'Remover', 'remove', job));
        break;
      default:
        break;
    }
    return out;
  }

  function moveButtons(job, index, total) {
    return [
      el('button', { type: 'button', class: 'icon-btn q-move', disabled: index === 0, dataset: { act: 'up', id: job.id }, 'aria-label': `Subir ${jobTitle(job)} na fila`, title: 'Subir na fila' }, icon('keyboard_arrow_up')),
      el('button', { type: 'button', class: 'icon-btn q-move', disabled: index === total - 1, dataset: { act: 'down', id: job.id }, 'aria-label': `Descer ${jobTitle(job)} na fila`, title: 'Descer na fila' }, icon('keyboard_arrow_down'))
    ];
  }

  /** Tudo que aparece na linha, menos o andamento (que muda várias vezes por segundo e é atualizado à parte). */
  function signature(job, index, total) {
    return JSON.stringify([
      job.state, job.phase, job.stopping, job.retryAt, job.runs, job.error && job.error.message, job.skippedReason, job.cancelReason,
      (job.warnings || []).length, job.output, job.conflictPath, job.interruptedBy, jobTitle(job), job.sourcePath, job.profile && job.profile.name,
      index, total
    ]);
  }

  function buildRow(job, index, total) {
    const reorder = REORDERABLE.includes(job.state);
    const note = noteFor(job);
    const showProgress = job.state === 'running';
    const { p } = progressInfo(job);
    const li = el('li', {
      class: `q-job${job.state === 'running' ? ' q-live' : ''}`, dataset: { id: job.id, state: job.state },
      draggable: reorder ? 'true' : undefined
    },
    el('div', { class: 'q-main' },
      el('span', { class: 'q-lead', 'aria-hidden': 'true' }, icon(STATE_ICON[job.state] || 'movie')),
      el('div', { class: 'q-title' },
        el('strong', { class: 'q-name' }, jobTitle(job)),
        el('span', { class: 'q-sub' }, sourceLine(job))),
      el('span', { class: `q-chip bds-chip${STATE_KIND[job.state] ? ` bds-chip-${STATE_KIND[job.state]}` : ''}`, dataset: { state: job.state } }, STATE_LABEL[job.state] || job.state),
      el('div', { class: 'q-actions' }, actionsFor(job)),
      reorder ? el('div', { class: 'q-reorder', title: 'Arraste para mudar a ordem' }, icon('drag_indicator', 'q-grip'), moveButtons(job, index, total)) : null),
    showProgress ? el('div', { class: 'q-prog' },
      el('progress', { max: '1', value: job.phase === 'preflight' || job.stopping ? undefined : String(p), 'aria-label': `Progresso de ${jobTitle(job)}` }),
      el('span', { class: 'q-prog-text', dataset: { role: 'progress-text' } }, progressText(job))) : null,
    note ? el('p', { class: 'q-note', dataset: { role: job.state === 'queued' && job.retryAt ? 'retry' : 'note' } }, note) : null,
    errorBlock(job),
    warningsBlock(job));
    if (li.draggable) {
      li.addEventListener('dragstart', (event) => {
        state.dragId = job.id;
        li.classList.add('q-dragging');
        if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', job.id); }
      });
      li.addEventListener('dragend', () => { state.dragId = null; clearDropMarks(); li.classList.remove('q-dragging'); });
    }
    if (reorder) {
      li.addEventListener('dragover', (event) => {
        if (!state.dragId || state.dragId === job.id) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        const before = dropBefore(li, event);
        clearDropMarks();
        li.classList.add(before ? 'q-drop-before' : 'q-drop-after');
      });
      li.addEventListener('dragleave', () => li.classList.remove('q-drop-before', 'q-drop-after'));
      li.addEventListener('drop', (event) => {
        event.preventDefault();
        const dragged = state.dragId;
        const before = dropBefore(li, event);
        clearDropMarks();
        state.dragId = null;
        if (dragged && dragged !== job.id) dropOn(dragged, job.id, before);
      });
    }
    return li;
  }

  const dropBefore = (li, event) => {
    const box = li.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2;
  };

  function clearDropMarks() {
    if (!state.ui) return;
    for (const li of state.ui.lists.queue.querySelectorAll('.q-drop-before, .q-drop-after')) li.classList.remove('q-drop-before', 'q-drop-after');
  }

  function dropOn(draggedId, targetId, before) {
    const ids = reorderableIds().filter((id) => id !== draggedId);
    const at = ids.indexOf(targetId);
    if (at < 0) return;
    ids.splice(before ? at : at + 1, 0, draggedId);
    sendOrder(ids);
  }

  /** Atualiza a lista em `ul` reaproveitando as linhas que não mudaram (foco, rolagem e dragging ficam intactos). */
  function syncList(ul, jobs) {
    const wanted = [];
    jobs.forEach((job, index) => {
      const sig = signature(job, index, jobs.length);
      let entry = rows.get(job.id);
      if (!entry || entry.sig !== sig) {
        const hadFocus = entry && entry.li.contains(document.activeElement) ? document.activeElement.dataset.act : null;
        const li = buildRow(job, index, jobs.length);
        if (entry) entry.li.replaceWith(li);
        entry = { li, sig, job };
        rows.set(job.id, entry);
        if (hadFocus) {
          const target = li.querySelector(`[data-act="${hadFocus}"]:not(:disabled)`) || li.querySelector('button:not(:disabled)');
          if (target) target.focus();
        }
      }
      entry.job = job;
      wanted.push(entry.li);
    });
    for (const [id, entry] of [...rows]) {
      if (!jobs.some((j) => j.id === id) && ul.contains(entry.li)) { entry.li.remove(); rows.delete(id); }
    }
    wanted.forEach((li, i) => { if (ul.children[i] !== li) ul.insertBefore(li, ul.children[i] || null); });
  }

  const NOTICE_ICON = { error: 'error', warn: 'warning', info: 'info' };

  function notice(kind, text, ...actions) {
    return el('div', { class: `q-notice q-${kind}`, role: kind === 'error' || kind === 'warn' ? 'alert' : 'status' },
      icon(NOTICE_ICON[kind] || 'info'),
      el('div', { class: 'q-notice-body' },
        el('p', {}, text),
        actions.length ? el('div', { class: 'q-notice-actions' }, actions) : null));
  }

  function noticeButton(label, onclick, primary = false, act) {
    return el('button', { type: 'button', class: primary ? 'primary sm' : 'secondary sm', onclick, dataset: { act } }, label);
  }

  function renderNotices() {
    const out = [];
    if (state.error) out.push(notice('error', `Não foi possível ler a fila: ${state.error}`, noticeButton('Tentar de novo', refresh, false, 'reload')));
    if (state.blocked) out.push(notice('warn', state.blocked.message));
    if (state.throttled && state.throttled.reason === 'memory') {
      out.push(notice('info', `Uma exportação está esperando: só há ${gbText(state.throttled.freeMb)} de memória livre e o mínimo dos Ajustes é ${gbText(state.throttled.minMb)}. Ela começa sozinha quando a memória voltar.`));
    }
    if (state.recovery.pending) {
      const n = state.recovery.jobs.length;
      out.push(notice('warn',
        `A fila foi interrompida quando o app fechou: ${n} exportação(ões) pararam no meio e recomeçam do início. A fila está em espera.`,
        noticeButton('Retomar', () => recover('resume'), true, 'recover-resume'),
        noticeButton('Descartar', () => recover('discard'), false, 'recover-discard')));
    }
    const waiting = pendingConflicts();
    if (waiting.length && !state.recovery.pending) {
      out.push(notice('info',
        `${waiting.length} exportação(ões) esperam a sua decisão: o arquivo já existe na pasta de destino.`,
        noticeButton('Resolver…', () => waiting.forEach((j) => queueConflict(j, { force: true })), true, 'resolve-first')));
    }
    if (state.loadWarning && !state.noticeHidden.has('load')) {
      out.push(notice('warn', state.loadWarning, noticeButton('Entendi', () => { state.noticeHidden.add('load'); render(); }, false, 'dismiss-load')));
    }
    if (state.saveError) out.push(notice('error', state.saveError));
    return out;
  }

  function summaryText() {
    const running = state.jobs.filter((j) => j.state === 'running').length;
    const queued = state.jobs.filter((j) => j.state === 'queued' || j.state === 'interrupted').length;
    const waiting = pendingConflicts().length;
    const parts = [];
    if (running) parts.push(`Exportando ${running}`);
    if (queued) parts.push(`Na fila ${queued}`);
    if (waiting) parts.push(`Esperando você ${waiting}`);
    if (!parts.length) return state.jobs.length ? 'Nada em andamento.' : '';
    return parts.join(' · ');
  }

  function render() {
    const ui = state.ui;
    if (!ui) { BF.ui.refreshTabs(); return; }
    BF.ui.refreshTabs();
    const notices = renderNotices();
    const noticeSig = notices.map((n) => n.className + n.textContent).join('|');
    if (noticeSig !== ui.noticeSig) { ui.noticeSig = noticeSig; ui.notices.replaceChildren(...notices); } // não recria (e não tira o foco) se nada mudou

    const groups = groupJobs(state.jobs);
    const active = groups.queue;
    const running = active.filter((j) => j.state === 'running').length;
    const hasActive = active.length > 0;

    // as pílulas só aparecem quando há algo (ou a fila está pausada: o "Retomar" mora ao lado delas)
    ui.bar.hidden = !state.jobs.length && !state.paused;
    for (const key of TAB_KEYS) {
      const pill = ui.pills[key];
      pill.textContent = `${TAB_LABEL[key]} (${groups[key].length})`;
      pill.setAttribute('aria-pressed', String(state.tab === key));
      pill.classList.toggle('q-pill-bad', key === 'failed' && groups.failed.length > 0);
    }
    const [emptyTitle, emptyText] = EMPTY[state.tab];
    if (ui.emptyTitle.textContent !== emptyTitle) ui.emptyTitle.textContent = emptyTitle;
    if (ui.emptyText.textContent !== emptyText) ui.emptyText.textContent = emptyText;
    ui.empty.hidden = !state.loaded || groups[state.tab].length > 0;
    ui.loading.hidden = state.loaded;

    ui.summary.textContent = state.tab === 'queue' ? summaryText() : '';
    syncResources();
    ui.pause.hidden = !hasActive && !state.paused;
    // Pausar é da FILA (não inicia novos); não congela o que já está exportando, e o rótulo e a dica dizem isso.
    // O destaque (pílula cheia) só vai para "Retomar" quando o aviso de recuperação não oferece o seu próprio "Retomar".
    ui.pause.textContent = state.paused ? 'Retomar' : 'Pausar fila';
    ui.pause.title = state.paused ? 'Volta a iniciar os trabalhos da fila.' : 'Nada novo começa; o que já está exportando vai até o fim.';
    const highlight = state.paused && !state.recovery.pending;
    ui.pause.classList.toggle('primary', highlight);
    ui.pause.classList.toggle('secondary', !highlight);
    ui.pause.setAttribute('aria-pressed', String(state.paused));
    ui.pausedNote.hidden = !state.paused || state.recovery.pending;
    ui.interrupt.hidden = !(state.paused && running > 0);
    ui.pausedText.textContent = running > 0
      ? `Fila pausada: nada novo começa. ${running} exportação(ões) em andamento vão até o fim.`
      : 'Fila pausada: nada começa até você retomar.';

    ui.cancelAll.hidden = state.tab !== 'queue' || active.length < 2;
    ui.clear.hidden = state.tab !== 'done' || !groups.done.length; // só limpa o que terminou sem erro: as falhas ficam até serem tratadas
    for (const key of TAB_KEYS) {
      ui.lists[key].hidden = state.tab !== key;
      syncList(ui.lists[key], groups[key]);
    }

    renderSettings();
    renderOutput();
    tick();
  }

  /** Mostra a pílula `key` (a escolha vale até o app fechar). */
  function setTab(key) {
    if (!TAB_KEYS.includes(key) || state.tab === key) return;
    state.tab = key;
    render();
  }

  // ---------- recursos do computador (CPU, memória, placa e disco), só enquanto algo exporta ----------

  /** 6144 -> "6,0 GB". */
  function gbText(mb) {
    const n = Number(mb);
    return Number.isFinite(n) ? `${(n / 1024).toFixed(1).replace('.', ',')} GB` : '?';
  }

  /** O que a linha de recursos mostra: "CPU 42% · Memória livre 6,1 de 15,9 GB · Placa 23% (1,4 de 4,0 GB) · Disco: 120,0 GB livres" ('' sem dados). */
  function resourcesText(r) {
    if (!r || typeof r !== 'object') return '';
    const parts = [];
    if (r.cpu && Number.isFinite(r.cpu.percent)) parts.push(`CPU ${r.cpu.percent}%`);
    if (r.memory && Number.isFinite(r.memory.freeMb)) parts.push(`Memória livre ${gbText(r.memory.freeMb)} de ${gbText(r.memory.totalMb)}`);
    if (r.gpu && Number.isFinite(r.gpu.utilPercent)) parts.push(`Placa ${r.gpu.utilPercent}% (${gbText(r.gpu.memUsedMb)} de ${gbText(r.gpu.memTotalMb)})`);
    const free = (r.disks || []).map((d) => d.freeMb).filter(Number.isFinite);
    if (free.length) parts.push(`Disco: ${gbText(Math.min(...free))} livres`);
    return parts.join(' · ');
  }

  let resourcesTimer = null;
  let resourcesSeq = 0;
  async function pollResources() {
    const seq = ++resourcesSeq;
    const res = await BF.api('queue:resources', {});
    const ui = state.ui;
    if (!ui || seq !== resourcesSeq || !resourcesTimer) return; // chegou depois de parar
    const text = res.ok ? resourcesText(res.resources) : '';
    ui.resources.textContent = text;
    ui.resources.hidden = !text;
  }

  /** A linha de recursos só é pedida (a cada 3 s) com a aba à vista e alguma exportação rodando. */
  function syncResources() {
    const ui = state.ui;
    if (!ui) return;
    const panel = typeof document !== 'undefined' ? document.getElementById('tabpanel-queue') : null;
    const should = state.running > 0 && Boolean(panel) && !panel.hidden;
    if (should && !resourcesTimer) { resourcesTimer = setInterval(pollResources, 3000); pollResources(); }
    else if (!should && resourcesTimer) { clearInterval(resourcesTimer); resourcesTimer = null; ui.resources.hidden = true; }
  }

  // ---------- Ajustes (montados uma vez; só os valores são atualizados, para não fechar um menu aberto) ----------

  function field(label, control, hint) {
    return el('label', { class: 'q-field' },
      el('span', { class: 'q-field-text' }, el('span', { class: 'q-field-label' }, label), hint ? el('span', { class: 'q-hint' }, hint) : null),
      control);
  }

  const selectOf = (id, options, onchange) => el('select', { id, onchange }, options.map(([value, text]) => el('option', { value }, text)));

  function buildSettings() {
    const retries = selectOf('q-retries', [0, 1, 2, 3, 4, 5].map((n) => [String(n), n === 0 ? 'Não tentar de novo' : `${n} tentativa(s)`]),
      () => saveSetting({ retries: Number(retries.value) }));
    const recovery = selectOf('q-recovery', [['ask', 'Perguntar'], ['resume', 'Retomar sozinho'], ['discard', 'Descartar']],
      () => saveSetting({ recovery: recovery.value }));
    const conflict = selectOf('q-conflict', [['ask', 'Perguntar'], ['rename', 'Salvar com outro nome'], ['skip', 'Pular'], ['fail', 'Marcar como falha']],
      () => saveSetting({ onConflict: conflict.value }));
    const priority = selectOf('q-priority', [['low', 'Baixa (o computador continua rápido)'], ['normal', 'Normal']],
      () => saveSetting({ lowPriority: priority.value === 'low' }));
    const threads = selectOf('q-threads', [['0', 'Automático'], ...[1, 2, 4, 6, 8, 12, 16].map((n) => [String(n), `${n} núcleo${n === 1 ? '' : 's'}`])],
      () => saveSetting({ encodeThreads: Number(threads.value) }));
    const minRam = selectOf('q-minram', [['0', 'Não olhar'], ...[512, 1024, 2048, 4096].map((n) => [String(n), gbText(n)])],
      () => saveSetting({ minFreeMemoryMb: Number(minRam.value) }));
    const node = el('details', { class: 'q-settings' },
      el('summary', {}, 'Ajustes'),
      el('div', { class: 'q-settings-body' },
        field('Tentativas automáticas', retries, 'Só em falhas passageiras (disco ocupado, exportação que caiu). Espera crescente entre elas.'),
        field('Se o app fechar com exportações em andamento', recovery, 'Elas recomeçam do início.'),
        field('Se o arquivo já existir', conflict, 'Substituir só é oferecido arquivo por arquivo, nunca como padrão.'),
        field('Prioridade da exportação', priority, 'Baixa deixa o resto do computador responsivo enquanto exporta; a velocidade quase não muda.'),
        field('Núcleos do processador por exportação', threads, 'Automático usa o que o programa achar melhor. Limite para sobrar processador para outras coisas.'),
        field('Memória livre mínima para começar outra', minRam, 'Com menos memória livre que isto, uma exportação nova espera enquanto outra roda. A primeira nunca espera.')));
    return { node, retries, recovery, conflict, priority, threads, minRam };
  }

  function renderSettings() {
    const ui = state.ui;
    if (!ui || !state.settings) return;
    const s = state.settings;
    const set = (control, value) => { if (control.value !== value && document.activeElement !== control) control.value = value; };
    set(ui.parallel, s.parallel === null || s.parallel === undefined ? '' : String(s.parallel));
    ui.parallel.querySelector('option[value=""]').textContent = `Padrão das Preferências (${s.defaultParallel || 1})`;
    set(ui.settings.retries, String(s.retries));
    set(ui.settings.recovery, s.recovery);
    set(ui.settings.conflict, s.onConflict);
    set(ui.settings.priority, s.lowPriority === false ? 'normal' : 'low');
    const optionFor = (select, value) => { // um valor guardado que não está na lista (ajuste pela API) ganha a sua opção
      if (!select.querySelector(`option[value="${value}"]`)) select.append(el('option', { value }, select === ui.settings.minRam ? gbText(Number(value)) : `${value} núcleos`));
      set(select, value);
    };
    optionFor(ui.settings.threads, String(s.encodeThreads ?? 0));
    optionFor(ui.settings.minRam, String(s.minFreeMemoryMb ?? 1024));
  }

  // ---------- barra de saída: perfil e destino do projeto aberto (os da aba Exportar) e o limite da fila ----------

  /** Um bloco da barra: ícone, rótulo pequeno e o controle. */
  function outItem(iconName, label, ...content) {
    return el('div', { class: 'q-out-item' },
      icon(iconName, 'q-out-icon'),
      el('div', { class: 'q-out-body' }, el('span', { class: 'q-out-label' }, label), ...content));
  }

  function buildOutput(ui) {
    ui.profile = selectOf('q-profile', [['', 'Carregando…']], () => {
      if (BF.exportOut && ui.profile.value) BF.exportOut.chooseProfile(ui.profile.value);
      renderOutput();
    });
    ui.profile.setAttribute('aria-label', 'Perfil de exportação das próximas exportações');
    // o caminho é cortado pelo COMEÇO (a pasta de destino está no fim): o bloco corre da direita para a esquerda e o texto, em <bdo dir="ltr">, segue na ordem normal
    ui.dirText = el('bdo', { dir: 'ltr' });
    ui.dir = el('span', { class: 'q-out-dir', id: 'q-dir' }, ui.dirText);
    ui.pickDir = el('button', {
      type: 'button', id: 'q-pick-dir', class: 'sm', 'aria-label': 'Alterar a pasta de destino',
      onclick: async () => { if (BF.exportOut && await BF.exportOut.pickDir()) renderOutput(); }
    }, 'Alterar…');
    ui.parallel = selectOf('q-parallel', [['', 'Padrão das Preferências'], ['1', '1 por vez'], ['2', '2 ao mesmo tempo'], ['3', '3 ao mesmo tempo'], ['4', '4 ao mesmo tempo']],
      () => saveSetting({ parallel: ui.parallel.value === '' ? null : Number(ui.parallel.value) }));
    ui.parallel.setAttribute('aria-label', 'Exportações ao mesmo tempo');
    ui.outProfile = outItem('tune', 'Perfil de exportação', ui.profile);
    ui.outDir = outItem('folder', 'Destino', el('div', { class: 'q-out-row' }, ui.dir, ui.pickDir));
    ui.outLimit = outItem('stacks', 'Limite de fila', ui.parallel);
    ui.outProfile.hidden = true;
    ui.outDir.hidden = true;
    ui.out = el('div', { class: 'q-out', role: 'group', 'aria-label': 'Configurações de saída' }, ui.outProfile, ui.outDir, ui.outLimit);
  }

  /** Pede a lista de perfis (uma vez por projeto aberto: se ela não chegar, o seletor fica em "Carregando…" em vez de pedir a cada redesenho). */
  function askProfiles() {
    const ui = state.ui;
    if (!ui || !BF.exportOut || !BF.state.project) return;
    ui.profilesAsked = true;
    BF.exportOut.ensureProfiles().then(() => renderOutput());
  }

  /** Atualiza o perfil e o destino (só com projeto aberto: valem para as próximas exportações dele) sem recriar o que o usuário está usando. */
  function renderOutput() {
    const ui = state.ui;
    if (!ui) return;
    const out = BF.exportOut ? BF.exportOut.summary() : null;
    ui.outProfile.hidden = !out;
    ui.outDir.hidden = !out;
    if (!out) { ui.profilesAsked = false; return; }
    if (!ui.profilesAsked) askProfiles();
    const options = out.profiles.length ? out.profiles : [{ id: '', name: 'Carregando…' }];
    const sig = options.map((o) => `${o.id}\u0001${o.name}`).join('\u0002');
    if (sig !== ui.profileSig) {
      ui.profileSig = sig;
      ui.profile.replaceChildren(...options.map((o) => el('option', { value: o.id }, o.name)));
    }
    ui.profile.disabled = !out.profiles.length;
    if (out.profiles.length && ui.profile.value !== out.profileId && document.activeElement !== ui.profile) ui.profile.value = out.profileId;
    if (ui.dirText.textContent !== out.dir) ui.dirText.textContent = out.dir;
    ui.dir.title = out.dir;
  }

  // ---------- contagem regressiva das tentativas ----------

  let timer = null;
  function tick() {
    const waiting = state.jobs.some((j) => j.state === 'queued' && j.retryAt && j.retryAt > Date.now());
    if (!waiting) { clearInterval(timer); timer = null; return; }
    if (!timer) timer = setInterval(tick, 1000);
    for (const job of state.jobs) {
      if (job.state !== 'queued' || !job.retryAt) continue;
      const li = rowFor(job.id);
      const p = li && li.querySelector('[data-role="retry"]');
      if (p) p.textContent = retryNote(job);
    }
  }

  // ---------- progresso ao vivo ----------

  function onProgress(ev) {
    if (!ev || typeof ev.id !== 'string') return;
    state.progress.set(ev.id, { p: ev.p, etaSec: ev.etaSec });
    const li = rowFor(ev.id);
    if (!li) return;
    const bar = li.querySelector('progress');
    const job = state.jobs.find((j) => j.id === ev.id);
    if (bar && job && job.phase !== 'preflight' && !job.stopping) bar.value = ev.p; // na verificação/parada a barra fica indeterminada
    const text = li.querySelector('[data-role="progress-text"]');
    if (text && job) text.textContent = progressText(job);
  }

  // ---------- montagem da aba ----------

  function buildPanel() {
    const ui = {};
    ui.loading = el('div', { class: 'q-loading', role: 'status', 'aria-busy': 'true' },
      el('span', { class: 'sr-only' }, 'Carregando a fila…'),
      [0, 1].map(() => el('div', { class: 'q-skel', 'aria-hidden': 'true' })));
    ui.notices = el('div', { class: 'q-notices' });
    ui.summary = el('p', { class: 'q-summary', 'aria-live': 'polite' });
    ui.pause = el('button', { type: 'button', id: 'q-pause', class: 'secondary', onclick: togglePause, hidden: true, dataset: { act: 'pause' } }, 'Pausar fila');
    ui.pausedText = el('span', {});
    ui.interrupt = el('button', { type: 'button', class: 'link', onclick: interruptCurrent, hidden: true, dataset: { act: 'interrupt' } }, 'Interromper os atuais');
    ui.pausedNote = el('p', { class: 'q-paused', hidden: true }, ui.pausedText, ' ', ui.interrupt);
    ui.resources = el('p', { class: 'q-resources small muted', id: 'q-resources', hidden: true });
    ui.emptyTitle = el('strong', {}, EMPTY.queue[0]);
    ui.emptyText = el('p', {}, EMPTY.queue[1]);
    ui.empty = el('div', { class: 'empty-state center q-empty', hidden: true },
      icon('playlist_add', 'empty-state-icon'),
      el('div', { class: 'empty-state-text' }, ui.emptyTitle, ui.emptyText));

    ui.cancelAll = el('button', { type: 'button', class: 'secondary danger', onclick: cancelAll, hidden: true, dataset: { act: 'cancel-all' } }, 'Cancelar tudo');
    ui.clear = el('button', { type: 'button', class: 'secondary', onclick: clearFinished, hidden: true, dataset: { act: 'clear' } }, 'Limpar concluídos');
    ui.pills = {};
    for (const key of TAB_KEYS) {
      ui.pills[key] = el('button', { type: 'button', class: 'bds-tab q-pill', 'aria-pressed': String(key === state.tab), dataset: { tab: key }, onclick: () => setTab(key) }, `${TAB_LABEL[key]} (0)`);
    }
    ui.bar = el('div', { class: 'q-bar', hidden: true },
      el('div', { class: 'bds-tabs q-tabs', role: 'group', 'aria-label': 'Estado das exportações' }, TAB_KEYS.map((key) => ui.pills[key])),
      el('div', { class: 'q-bar-actions' }, ui.clear, ui.cancelAll, ui.pause));
    ui.lists = {};
    for (const key of TAB_KEYS) ui.lists[key] = el('ul', { class: 'q-list', 'aria-label': TAB_LABEL[key], dataset: { list: key }, hidden: key !== state.tab });

    buildOutput(ui);
    ui.settings = buildSettings();
    ui.root = el('div', { class: 'q' },
      el('p', { class: 'q-intro' }, 'Acompanhe o progresso dos seus cortes e exportações.'),
      ui.notices,
      el('section', { class: 'q-panel panel', 'aria-label': 'Exportações' },
        ui.bar, ui.summary, ui.resources, ui.pausedNote, ui.loading, ui.empty, TAB_KEYS.map((key) => ui.lists[key]), ui.out),
      ui.settings.node);

    ui.root.addEventListener('click', onClick);
    return ui;
  }

  function onClick(event) {
    const target = event.target instanceof Element ? event.target.closest('button[data-act][data-id]') : null;
    if (!target) return;
    const job = state.jobs.find((j) => j.id === target.dataset.id);
    if (!job) return;
    switch (target.dataset.act) {
      case 'cancel': act('queue:cancel', { id: job.id }); break;
      case 'remove': removeJob(job); break;
      case 'retry': retryJob(job); break;
      case 'reveal': reveal(job); break;
      case 'resolve': queueConflict(job, { force: true }); break;
      case 'up': move(job, -1); break;
      case 'down': move(job, +1); break;
      default: break;
    }
  }

  BF.ui.registerTab({
    id: 'queue',
    title: 'Exportações',
    order: 30,
    badge: () => state.active || '',
    render(container) {
      state.ui = buildPanel();
      container.append(state.ui.root);
      render();
    },
    onShow() { refresh(); syncPreferredParallel(); renderOutput(); syncResources(); }
  });

  // ---------- ligação com o processo principal e com o app ----------

  BF.on('queue:update', (snapshot) => {
    if (reorderPending > 0) return; // veja "Reordenar": o retrato pode ser anterior ao último movimento; o fim da sequência recarrega
    applySnapshot(snapshot);
    render();
  });
  BF.on('queue:progress', onProgress);
  BF.on('queue:jobDone', ({ job, output }) => {
    applyDone(job, output);
    BF.ui.log(`Exportado: ${nameOf(output || '')}`, 'ok');
  });
  BF.on('queue:conflict', ({ job }) => queueConflict(job));
  BF.on('queue:recovery', () => { refresh(); });

  // um corte voltou (desfazer a remoção, refazer, restaurar) com a cópia de antes de uma exportação que terminou nesse meio
  // tempo: a exportação concluída é anotada de novo (idempotente) em vez de se perder da lista do corte
  BF.bus.on('cuts:changed', ({ from } = {}) => {
    if (typeof from === 'string' && from.startsWith('review') && state.jobs.some((j) => j.state === 'done')) reconcile(state.jobs);
  });

  // mudou `queue.parallel` nas Preferências (ou o jogo/canal do projeto que decide qual valor vale): a fila acompanha na hora
  BF.bus.on('prefs:changed', ({ keys } = {}) => {
    if (!Array.isArray(keys) || keys.includes('queue.parallel')) syncPreferredParallel();
  });

  // o perfil e o destino da barra de saída são os do projeto aberto: trocar de projeto ou mudá-los na aba Exportar atualiza a barra
  BF.bus.on('project:changed', ({ reason } = {}) => {
    if (typeof reason === 'string' && reason.startsWith('export:')) renderOutput();
  });

  BF.bus.on('project:loaded', async () => {
    if (state.ui) state.ui.profilesAsked = false;
    renderOutput();
    const res = await refresh();
    if (res.ok) reconcile(state.jobs);
    syncPreferredParallel();
  });
  BF.ready.then(async () => {
    const res = await refresh();
    if (res.ok) reconcile(state.jobs);
    syncPreferredParallel();
  });

  BF.queue = { state, resourcesText, gbText, fmtEta, clock, applyDone, reconcile, activeOrder, groupOf, groupJobs, setTab, sameProject, refresh, move, sendOrder, renderOutput };
})();

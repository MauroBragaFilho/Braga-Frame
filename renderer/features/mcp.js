'use strict';

/**
 * Agentes de IA (MCP), do lado da janela (dono: base). Duas partes:
 *
 *  1. As OPERAÇÕES que o servidor MCP (src/mcp) pede à janela, porque o projeto aberto, a revisão de cortes, a análise e a exportação vivem aqui (só o
 *     renderer grava o projeto). O servidor manda o evento `mcp:request` { id, op, args } e espera a resposta em `mcp:reply` (BF.api). Cada operação
 *     confere TUDO antes de perturbar o usuário (sem projeto aberto, corte que não existe, intervalo fora do vídeo: erro direto, sem janela) e só então,
 *     se `args.ask`, mostra a confirmação ("O agente X pede para…"); recusar devolve `{ declined: true }` e nada muda. Com `ask` falso (o usuário
 *     dispensou a confirmação nas configurações) faz direto e AVISA com um aviso na tela. As decisões passam pelo mesmo motor de revisão da aba Cortes
 *     (BF.review.engine), então entram no histórico e dá para desfazer (Ctrl+Z). Nada apaga corte, projeto ou arquivo.
 *  2. O cartão "Agentes de IA (MCP)" da tela Geral (`BF.mcp.card()`): liga e desliga o servidor, copia a configuração pronta para o agente
 *     (Antigravity, HTTP, comando), gera um token novo e dispensa a confirmação. O token NUNCA passa por aqui: o processo principal o põe na área de
 *     transferência.
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;

  class OpError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  // ---------- auxiliares ----------

  const r1 = (n) => Math.round(Number(n) * 10) / 10;

  function clock(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const who = (a) => (typeof a.agent === 'string' && a.agent ? a.agent : 'Um agente de IA');

  function project() {
    const p = BF.state.project;
    if (!p) throw new OpError('NO_PROJECT', 'Nenhum projeto aberto no app: use project_open (ou peça ao usuário para abrir um vídeo).');
    return p;
  }

  const titleOf = (p) => (p.source && p.source.origin && p.source.origin.title) || (BF.util.baseOf ? BF.util.baseOf(p.source.path) : p.source.path) || 'Vídeo';
  const durationOf = (p) => Number(p.source && p.source.duration) || Number(BF.state.info && BF.state.info.duration) || 0;

  const cutView = (c) => ({ id: c.id, title: c.title, start: r1(c.start), end: r1(c.end), status: c.status });

  function counts(cuts) {
    const out = { total: cuts.length, pending: 0, approved: 0, rejected: 0 };
    for (const c of cuts) if (out[c.status] !== undefined) out[c.status] += 1;
    return out;
  }

  function engine() {
    if (!BF.review || !BF.review.engine) throw new OpError('NOT_READY', 'A revisão de cortes ainda não carregou: tente de novo em instantes.');
    return BF.review.engine;
  }

  /** "• “Título” (0:10–0:40)" para até 6 cortes (o resto vira "e mais N"). */
  function listCuts(cuts) {
    const lines = cuts.slice(0, 6).map((c) => `• “${c.title}” (${clock(c.start)}–${clock(c.end)})`);
    if (cuts.length > 6) lines.push(`… e mais ${cuts.length - 6}`);
    return lines.join('\n');
  }

  /** A confirmação ("O agente X pede para…"): `true` se o usuário aceitou (ou se ele dispensou a confirmação: `ask` falso). */
  async function approved(a, { title, message, okLabel }) {
    if (a.ask !== true) return true;
    return BF.ui.confirm({ title, message, okLabel });
  }

  /** Com a confirmação dispensada o usuário ainda vê o que o agente fez (aviso na tela e linha no registro). */
  function notice(a, text) {
    BF.ui.toast(`${who(a)}: ${text}`, 'ok');
    if (BF.ui.log) BF.ui.log(`${who(a)}: ${text}`, 'ok');
  }

  const DECIDE = {
    approved: { op: 'approve', verb: 'aprovar', title: 'Aprovar', ok: 'Aprovar', done: 'aprovou' },
    rejected: { op: 'reject', verb: 'rejeitar', title: 'Rejeitar', ok: 'Rejeitar', done: 'rejeitou' },
    pending: { op: 'reset', verb: 'voltar para pendente', title: 'Redefinir', ok: 'Redefinir', done: 'redefiniu' }
  };

  // ---------- operações ----------

  const OPS = {
    /** O projeto aberto agora (ou null). */
    context() {
      const p = BF.state.project;
      if (!p) return null;
      let profile = null;
      try {
        const sum = BF.exportOut && BF.exportOut.summary ? BF.exportOut.summary() : null;
        const chosen = sum && sum.profiles.find((x) => x.id === sum.profileId);
        profile = chosen ? chosen.name : null;
      } catch { profile = null; }
      return { id: p.id, title: titleOf(p), durationSec: r1(durationOf(p)), cuts: counts(p.cuts), exportProfile: profile };
    },

    /** Grava o que estiver pendente (para o servidor ler o projeto do disco já atualizado). */
    async flush() {
      if (!BF.state.project) return { saved: true };
      return { saved: Boolean(await BF.project.flush()) };
    },

    /** Confirmação genérica (o servidor a usa nas ações que ele mesmo executa, como a transcrição). */
    async confirm(a) {
      const ok = await BF.ui.confirm({ title: String(a.title || 'Confirmar'), message: String(a.message || ''), okLabel: String(a.okLabel || 'OK') });
      return { accepted: ok === true };
    },

    /** A transcrição começou por fora da aba Análise: ela relê o andamento (e passa a acompanhar o trabalho). */
    refresh_transcript() {
      BF.bus.emit('transcription:changed');
      return {};
    },

    async open_project(a) {
      if (typeof a.path !== 'string' || !a.path) throw new OpError('INVALID_ARGS', 'Informe o projeto.');
      const title = String(a.title || 'o projeto');
      if (!(await approved(a, {
        title: 'Abrir outro projeto?',
        message: `${who(a)} pede para abrir “${title}”. O vídeo que está na tela vai ser trocado (o projeto atual continua salvo).`,
        okLabel: 'Abrir'
      }))) return { declined: true };
      const res = await BF.openSource(a.path);
      if (!res || res.ok === false) throw new OpError((res && res.code) || 'OPEN_FAILED', (res && res.message) || 'Não foi possível abrir o vídeo.');
      if (a.ask !== true) notice(a, `abriu “${title}”.`);
      return { opened: true };
    },

    async cut_create(a) {
      const p = project();
      const start = Number(a.start);
      const end = Number(a.end);
      const duration = durationOf(p);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || !(end > start)) throw new OpError('INVALID_RANGE', 'O fim do corte precisa ser maior que o início.');
      if (end - start < 1) throw new OpError('INVALID_RANGE', 'O corte precisa ter pelo menos 1 segundo.');
      if (duration > 0 && end > duration + 0.5) throw new OpError('OUT_OF_RANGE', `O fim passa da duração do vídeo (${clock(duration)}).`);
      const title = typeof a.title === 'string' && a.title.trim() ? a.title.trim() : null;
      if (!(await approved(a, {
        title: 'Criar um corte?',
        message: `${who(a)} pede para criar o corte${title ? ` “${title}”` : ''} de ${clock(start)} a ${clock(end)} (${r1(end - start)} s) no vídeo aberto, “${titleOf(p)}”. Ele nasce pendente: você decide se aprova.`,
        okLabel: 'Criar o corte'
      }))) return { declined: true };
      const created = BF.project.addCut({ start, end, status: 'pending', ...(title ? { title } : {}) });
      if (a.ask !== true) notice(a, `criou o corte “${created.title}”.`);
      return { created: cutView(created) };
    },

    async cut_decide(a) {
      const p = project();
      const rule = DECIDE[a.status];
      if (!rule) throw new OpError('INVALID_ARGS', 'O status deve ser approved, rejected ou pending.');
      const ids = Array.isArray(a.cutIds) ? a.cutIds : [];
      const found = ids.map((id) => p.cuts.find((c) => c.id === id)).filter(Boolean);
      const missing = ids.filter((id) => !p.cuts.some((c) => c.id === id));
      if (!found.length) throw new OpError('CUT_NOT_FOUND', 'Nenhum dos cortes informados existe no projeto aberto (veja project_get).');
      const eng = engine();
      const todo = found.filter((c) => c.status !== a.status);
      if (!todo.length) return { changed: 0, unchanged: found.length, missing, cuts: found.map(cutView) };
      if (!(await approved(a, {
        title: `${rule.title} ${plural(todo.length, 'corte', 'cortes')}?`,
        message: `${who(a)} pede para ${rule.verb}:\n${listCuts(todo)}\nDá para desfazer com Ctrl+Z na aba Cortes.`,
        okLabel: rule.ok
      }))) return { declined: true };
      // em lote: UM passo no histórico (um Ctrl+Z desfaz tudo o que o agente decidiu nesta chamada)
      const planned = eng.plan(rule.op, todo.map((c) => c.id));
      if (!planned || planned.error || !planned.items.length) throw new OpError('NOTHING_TO_DO', (planned && planned.error) || 'Nada a alterar nesses cortes.');
      eng.commitPlan(planned);
      if (a.ask !== true) notice(a, `${rule.done} ${plural(todo.length, 'corte', 'cortes')}.`);
      return { changed: todo.length, unchanged: found.length - todo.length, missing, cuts: found.map((c) => cutView(p.cuts.find((x) => x.id === c.id) || c)) };
    },

    async cut_edit(a) {
      const p = project();
      const cut = p.cuts.find((c) => c.id === a.cutId);
      if (!cut) throw new OpError('CUT_NOT_FOUND', 'Esse corte não existe no projeto aberto (veja project_get).');
      const eng = engine();
      const patch = {};
      if (a.start !== undefined) patch.start = Number(a.start);
      if (a.end !== undefined) patch.end = Number(a.end);
      const range = Object.keys(patch).length > 0;
      const title = typeof a.title === 'string' && a.title.trim() ? a.title.trim() : null;
      if (!range && !title) throw new OpError('INVALID_ARGS', 'Informe o que mudar: title, start e/ou end.');
      const duration = durationOf(p);
      const end = patch.end === undefined ? cut.end : patch.end;
      const start = patch.start === undefined ? cut.start : patch.start;
      if (!(end > start)) throw new OpError('INVALID_RANGE', 'O fim do corte precisa ser maior que o início.');
      if (range && duration > 0 && end > duration + 0.5) throw new OpError('OUT_OF_RANGE', `O fim passa da duração do vídeo (${clock(duration)}).`);
      const was = cut.title; // o título de ANTES (o objeto é o mesmo do projeto e muda quando o novo é aplicado)
      const parts = [];
      if (title) parts.push(`título “${title}”`);
      if (range) parts.push(`${clock(start)} a ${clock(end)}`);
      if (!(await approved(a, {
        title: 'Alterar o corte?',
        message: `${who(a)} pede para alterar “${cut.title}” (${clock(cut.start)}–${clock(cut.end)}): ${parts.join(' e ')}. Dá para desfazer com Ctrl+Z na aba Cortes.`,
        okLabel: 'Alterar'
      }))) return { declined: true };
      if (range) {
        const res = eng.adjust(cut.id, patch); // primeiro o que pode falhar: se falhar nada mudou
        if (!res.ok) throw new OpError('INVALID_RANGE', res.reason || 'O intervalo não é válido.');
      }
      if (title) eng.retitle(cut.id, title, { custom: true });
      if (a.ask !== true) notice(a, `alterou “${was}”.`);
      return { cut: cutView(p.cuts.find((c) => c.id === cut.id) || cut) };
    },

    /** O andamento da análise do projeto aberto e as sugestões ainda não transformadas em corte (as 30 de maior relevância). */
    analysis_state() {
      const p = BF.state.project;
      if (!p || !BF.analysis || !BF.analysis.mcpState) return null;
      const s = BF.analysis.mcpState();
      if (!s) return null;
      const top = s.suggestions.slice().sort((x, y) => (y.relevance || 0) - (x.relevance || 0)).slice(0, 30);
      return {
        id: p.id,
        running: s.running,
        progress: s.progress && Number.isFinite(s.progress.p) ? Math.round(s.progress.p * 100) / 100 : null,
        lastRunAt: s.lastRunAt,
        suggestionCount: s.suggestions.length,
        suggestions: top.map((x) => ({
          id: x.id, start: r1(x.start), end: r1(x.end), relevance: Math.round((x.relevance || 0) * 100) / 100,
          ...(Array.isArray(x.reasons) && x.reasons.length ? { reasons: x.reasons.slice(0, 4).map(String) } : {}),
          ...(x.title ? { title: String(x.title) } : {})
        }))
      };
    },

    async analysis_run(a) {
      const p = project();
      if (!BF.analysis || !BF.analysis.runLocal) throw new OpError('NOT_READY', 'A análise ainda não carregou: tente de novo em instantes.');
      if (!(await approved(a, {
        title: 'Procurar momentos interessantes?',
        message: `${who(a)} pede para analisar “${titleOf(p)}” atrás de momentos interessantes. É a análise local (algoritmo), no seu computador: nada é enviado para fora. Ela leva alguns minutos e você acompanha na aba Análise.`,
        okLabel: 'Analisar'
      }))) return { declined: true };
      const res = await BF.analysis.runLocal();
      if (!res.ok) throw new OpError('ANALYSIS_NOT_STARTED', res.reason);
      if (a.ask !== true) notice(a, 'começou a análise.');
      return { started: true, note: 'Acompanhe com analysis_status e, quando terminar, use analysis_add_cuts.' };
    },

    async analysis_add_cuts(a) {
      project();
      if (!BF.analysis || !BF.analysis.mcpState) throw new OpError('NOT_READY', 'A análise ainda não carregou: tente de novo em instantes.');
      const full = BF.analysis.mcpState().suggestions;
      let pick;
      if (Array.isArray(a.suggestionIds)) pick = full.filter((s) => a.suggestionIds.includes(s.id));
      else pick = full.slice().sort((x, y) => (y.relevance || 0) - (x.relevance || 0)).slice(0, Math.min(20, Number(a.top) || 0));
      if (!pick.length) {
        throw new OpError('NO_SUGGESTIONS', full.length ? 'Nenhuma das sugestões informadas está pendente (veja analysis_status).' : 'Não há sugestões pendentes: rode analysis_run e espere terminar.');
      }
      if (!(await approved(a, {
        title: `Criar ${plural(pick.length, 'corte', 'cortes')} a partir da análise?`,
        message: `${who(a)} pede para transformar ${plural(pick.length, 'sugestão', 'sugestões')} da análise em cortes pendentes (nenhum é aprovado):\n${listCuts(pick.map((s) => ({ title: s.title || `Sugestão ${clock(s.start)}`, start: s.start, end: s.end })))}`,
        okLabel: 'Criar os cortes'
      }))) return { declined: true };
      const created = BF.analysis.addSuggestions(pick);
      if (a.ask !== true) notice(a, `criou ${plural(created.length, 'corte', 'cortes')} a partir da análise.`);
      return { created: created.map(cutView), alreadyCovered: pick.length - created.length };
    },

    async export_enqueue(a) {
      const p = project();
      if (!BF.exportOut || !BF.exportOut.enqueueCuts) throw new OpError('NOT_READY', 'A exportação ainda não carregou: tente de novo em instantes.');
      const wanted = Array.isArray(a.cutIds) ? p.cuts.filter((c) => a.cutIds.includes(c.id)) : p.cuts.filter((c) => c.status === 'approved');
      const targets = wanted.filter((c) => c.status === 'approved');
      const notApproved = wanted.filter((c) => c.status !== 'approved').map((c) => c.id);
      if (!targets.length) {
        throw new OpError('NO_APPROVED_CUTS', Array.isArray(a.cutIds) ? 'Nenhum dos cortes informados está aprovado: só cortes aprovados vão para a fila (veja cut_decide).' : 'Não há cortes aprovados neste projeto: aprove antes (cut_decide).');
      }
      let dest = '';
      try {
        await BF.exportOut.ensureProfiles();
        const sum = BF.exportOut.summary();
        const chosen = sum && sum.profiles.find((x) => x.id === sum.profileId);
        dest = sum ? ` Perfil: ${chosen ? chosen.name : 'padrão'}. Pasta de destino: ${sum.dir}.` : '';
      } catch { dest = ''; }
      if (!(await approved(a, {
        title: `Enviar ${plural(targets.length, 'corte', 'cortes')} para a fila?`,
        message: `${who(a)} pede para exportar:\n${listCuts(targets)}\n${dest.trim()} A exportação roda em segundo plano e você acompanha na aba Exportações.`.replace(/\n\n/g, '\n'),
        okLabel: 'Enviar para a fila'
      }))) return { declined: true };
      const res = await BF.exportOut.enqueueCuts(targets.map((c) => c.id));
      if (!res.ok) throw new OpError('EXPORT_FAILED', `${res.message}${Array.isArray(res.failed) && res.failed.length ? ` (${res.failed.map((f) => (f.reasons || []).join('; ')).join(' | ')})` : ''}`);
      if (a.ask !== true) notice(a, `mandou ${plural(res.sent, 'corte', 'cortes')} para a fila de exportação.`);
      return { queued: res.sent, alreadyQueuedOrExported: res.skipped, rejectedByQualityCheck: res.failed || [], notApproved };
    }
  };

  /** Atende um pedido do servidor e responde por `mcp:reply` (sempre: sucesso, recusa ou erro em português). */
  async function handle(request) {
    if (!request || typeof request.id !== 'string' || typeof request.op !== 'string') return;
    let reply;
    try {
      const fn = Object.hasOwn(OPS, request.op) ? OPS[request.op] : null;
      if (!fn) throw new OpError('UNKNOWN_OP', `Operação desconhecida: ${request.op}.`);
      const result = await fn(request.args && typeof request.args === 'object' ? request.args : {});
      reply = { id: request.id, ok: true, result: result === undefined ? null : result };
    } catch (err) {
      reply = { id: request.id, ok: false, code: (err && err.code) || 'ERROR', message: (err && err.message) || 'A operação falhou no app.' };
    }
    await BF.api('mcp:reply', reply);
  }

  // ---------- cartão em Configurações > Geral ----------

  const icon = (name) => el('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true' }, name);
  const KINDS = [
    ['antigravity', 'Copiar para o Antigravity', 'content_copy'],
    ['http', 'Copiar para Claude e outros (HTTP)', 'content_copy'],
    ['stdio', 'Copiar como comando (stdio)', 'terminal']
  ];

  let status = null;
  let cardEl = null;
  let busy = false;
  let message = null; // { kind: 'error'|'ok', text }
  const ui = {};

  function describe() {
    if (!status) return 'Lendo a situação…';
    if (!status.running) return status.enabled ? 'Ligado, mas o servidor não abriu.' : 'Desligado. Nenhum agente consegue se conectar.';
    const parts = [`Ligado em 127.0.0.1:${status.port}`];
    parts.push(status.client ? `último agente: ${status.client}` : 'nenhum agente conectou ainda');
    parts.push(plural(status.calls, 'chamada', 'chamadas'));
    return parts.join(' · ');
  }

  function draw() {
    if (!cardEl || !ui.sw) return;
    cardEl.hidden = Boolean(status && status.available === false); // módulo embutido: o hospedeiro tem o servidor MCP dele
    const on = Boolean(status && status.running);
    ui.sw.checked = on;
    ui.sw.disabled = busy || !status || status.available === false;
    ui.status.textContent = describe();
    ui.status.dataset.kind = on ? 'ok' : '';
    ui.error.textContent = (message && message.text) || (status && status.error) || '';
    ui.error.hidden = !ui.error.textContent;
    ui.error.dataset.kind = message && message.kind === 'ok' ? 'ok' : 'error';
    ui.running.hidden = !on;
    ui.auto.checked = Boolean(status && status.autoConfirm);
    ui.auto.disabled = busy || !on;
    ui.autoWarn.hidden = !(on && status.autoConfirm);
    for (const b of ui.copyButtons) b.disabled = busy || !on;
    ui.token.disabled = busy || !on;
  }

  async function run(fn, okText) {
    busy = true;
    message = null;
    draw();
    try {
      const res = await fn();
      if (res && res.ok === false) message = { kind: 'error', text: res.message };
      else {
        if (res && res.running !== undefined) status = res;
        if (okText) { message = { kind: 'ok', text: okText }; BF.ui.toast(okText, 'ok'); }
      }
    } finally {
      busy = false;
      draw();
    }
  }

  async function refresh() {
    const res = await BF.api('mcp:status');
    if (res.ok) status = res;
    else message = { kind: 'error', text: res.message };
    draw();
  }

  async function toggle() {
    const enable = ui.sw.checked;
    await run(() => BF.api('mcp:setEnabled', { enabled: enable }));
    if (!enable) message = null;
    draw();
  }

  async function setAuto() {
    const want = ui.auto.checked;
    if (want) {
      const ok = await BF.ui.confirm({
        title: 'Não pedir confirmação ao agente?',
        message: 'Com isto ligado, o agente de IA conectado pode abrir projetos, criar, aprovar e rejeitar cortes, transcrever, analisar e mandar cortes para a fila de exportação SEM perguntar antes. Você ainda vê um aviso de cada coisa que ele faz, e ele continua sem poder apagar nada nem ler suas chaves. Ligue só se confia no agente.',
        okLabel: 'Não pedir confirmação'
      });
      if (!ok) { ui.auto.checked = false; return; }
    }
    await run(() => BF.api('mcp:setOptions', { autoConfirm: want }));
  }

  async function newToken() {
    const ok = await BF.ui.confirm({
      title: 'Gerar um token novo?',
      message: 'Quem usava o token atual perde o acesso e precisa da configuração nova. Depois de gerar, copie a configuração de novo e cole no agente.',
      okLabel: 'Gerar novo token'
    });
    if (!ok) return;
    await run(() => BF.api('mcp:regenerateToken'), 'Token novo gerado. Copie a configuração de novo no agente.');
  }

  async function copy(kind) {
    await run(() => BF.api('mcp:copyConfig', { kind }), 'Configuração copiada. Cole no arquivo de configuração do agente (ela tem o token: não compartilhe).');
  }

  function build() {
    ui.sw = el('input', { type: 'checkbox', id: 'genMcpSwitch', class: 'bds-switch', role: 'switch', onchange: toggle });
    ui.status = el('p', { class: 'gen-update-status small', role: 'status' });
    ui.error = el('p', { class: 'gen-mcp-message small', role: 'alert', hidden: true });
    ui.copyButtons = KINDS.map(([kind, label, glyph]) => el('button', { type: 'button', class: 'secondary sm', dataset: { act: `copy-${kind}` }, onclick: () => copy(kind) }, icon(glyph), label));
    ui.token = el('button', { type: 'button', class: 'secondary sm', dataset: { act: 'new-token' }, onclick: newToken }, icon('key'), 'Gerar novo token');
    ui.auto = el('input', { type: 'checkbox', id: 'genMcpAutoSwitch', class: 'bds-switch', role: 'switch', onchange: setAuto });
    ui.autoWarn = el('p', { class: 'gen-mcp-warn small', hidden: true }, 'A confirmação está dispensada: o agente age sem perguntar. Você vê um aviso de cada coisa que ele faz.');
    ui.running = el('div', { class: 'gen-mcp-running', hidden: true },
      el('div', { class: 'gen-actions' }, ui.copyButtons),
      el('details', { class: 'gen-mcp-how' },
        el('summary', {}, 'Como conectar'),
        el('ol', {},
          el('li', {}, 'Clique em um dos botões de copiar (a configuração leva o token, que é a senha: não compartilhe).'),
          el('li', {}, 'Cole no arquivo de configuração de MCP do seu agente. No Antigravity: painel do agente > MCP Servers > View raw config. Em outros agentes, o formato "HTTP" ou o "comando (stdio)", conforme o que ele aceita.'),
          el('li', {}, 'Reinicie ou atualize a lista de servidores do agente. O Braga Frame precisa estar aberto enquanto o agente trabalha.'))),
      el('label', { class: 'gen-switch-row', for: 'genMcpAutoSwitch' }, ui.auto, el('span', {}, 'Não pedir confirmação das ações do agente')),
      ui.autoWarn,
      el('div', { class: 'gen-actions' }, ui.token));
    return el('section', { class: 'card gen-card', dataset: { section: 'mcp' } },
      el('h3', {}, 'Agentes de IA (MCP)'),
      el('p', { class: 'muted small gen-note' }, 'Deixe um agente de IA (Antigravity, Claude e outros que falam MCP) ler os seus projetos e ajudar a revisar cortes, neste computador. Fica desligado até você ligar, só aceita conexões daqui e exige um token. O que ele pode fazer é uma lista fixa: ler projetos, cortes e transcrição, e, pedindo a sua confirmação aqui, abrir projetos, criar e decidir cortes, transcrever, analisar e mandar cortes para a fila de exportação. Ele não apaga nada e nunca vê as suas chaves.'),
      el('label', { class: 'gen-switch-row', for: 'genMcpSwitch' }, ui.sw, el('span', {}, 'Conectar agentes (MCP)')),
      ui.status, ui.error, ui.running);
  }

  /** O cartão da tela Geral (o mesmo elemento sempre; ele se atualiza sozinho). Escondido onde não há servidor (módulo embutido). */
  function card() {
    if (!cardEl) {
      cardEl = build();
      draw();
      refresh();
    }
    return cardEl;
  }

  BF.on('mcp:request', handle);
  BF.on('mcp:state', (s) => { if (s && typeof s === 'object') { status = s; draw(); } });

  BF.mcp = { card, refresh, handle, ops: OPS };
})();

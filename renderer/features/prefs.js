'use strict';

/**
 * Aba "Preferências" (dono: prefs) e o `BF.prefs` de verdade.
 *
 *  - BF.prefs.get(key, fallback) é síncrono e lê um cache carregado de `prefs:resolve` {game, channel} ao abrir
 *    um vídeo e a cada edição; explain(key) diz de onde veio o valor; o evento 'prefs:changed' avisa os outros.
 *  - Aprendizado: o evento 'decision' vira observações (prefs:observe); nada aprendido vale sem evidência
 *    mínima e tudo aparece na aba (consultar, editar, desativar, desfazer).
 *  - Ganchos de abertura: antes de abrir um vídeo, pergunta se é uma live já analisada (nunca abre sem
 *    confirmar) e mostra o que mudou quando a fonte de um projeto existente foi regravada/cresceu.
 * Funciona sem projeto aberto (as preferências gerais e o histórico continuam editáveis).
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;

  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const clean = (s) => String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
  const norm = (s) => clean(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const plural = (n, one, many) => (n === 1 ? one : many);
  const OUTSIDE_TOLERANCE = 0.05;
  const OBSERVE_DELAY_MS = 400;
  const VERIFY_OPEN_MS = 6000;

  const S = {
    schema: null, // { keys, groups, profiles, minEvidence }
    profiles: null, // perfis de exportação (embutidos + do usuário) de export:listProfiles; null = vale a lista do esquema
    schemaError: '',
    notices: [], // avisos do processo principal (arquivos ilegíveis que foram preservados e recomeçados)
    cache: { loaded: false, scope: { game: '', channel: '' }, values: {}, details: {}, warnings: [], learning: { enabled: true, minEvidence: 5 } },
    data: { list: null, learned: null, history: [], names: { games: [], channels: [] } },
    view: { type: 'general', name: '' }, // escopo que a lista edita
    unseen: 0, // preferências aprendidas novas que o usuário ainda não viu
    root: null,
    refs: {},
    refreshSeq: 0
  };

  const defOf = (key) => (S.schema ? S.schema.keys.find((d) => d.key === key) : null);

  /** Perfis que o seletor de `export.profileId` oferece: os de export:listProfiles (inclui os do usuário, 'user-…'), senão os do esquema. */
  const profileChoices = () => S.profiles || (S.schema && S.schema.profiles) || [];

  /** Relê os perfis de exportação (o usuário pode ter criado ou excluído um depois que a aba abriu). Falha: fica a lista anterior. */
  async function loadProfiles() {
    const res = await BF.api('export:listProfiles');
    if (res.ok && Array.isArray(res.profiles)) S.profiles = res.profiles.filter((p) => p && typeof p.id === 'string').map((p) => ({ id: p.id, name: String(p.name || p.id) }));
  }

  // ---------- jogo e canal do projeto ----------

  function projectNames(project) {
    if (!project) return { game: '', channel: '' };
    const origin = (project.source && project.source.origin) || {};
    const meta = project.meta || {};
    return { game: clean(meta.game || origin.game), channel: clean(meta.channel || origin.channel) };
  }
  const currentNames = () => projectNames(BF.state.project);
  const namesKey = (n) => `${norm(n.game)}|${norm(n.channel)}`;

  // ---------- cache de BF.prefs ----------

  let reloadSeq = 0;

  /** Recarrega o cache do escopo (jogo/canal) e avisa 'prefs:changed' se algum valor mudou. */
  async function reload(names = currentNames(), reason = 'reload') {
    const seq = ++reloadSeq;
    const res = await BF.api('prefs:resolve', names);
    if (seq !== reloadSeq || !res.ok) return false;
    const before = S.cache.values;
    S.cache = { loaded: true, scope: names, values: res.values, details: res.details, warnings: res.warnings || [], learning: res.learning };
    const keys = Object.keys(res.values).filter((k) => !same(before[k], res.values[k]));
    if (keys.length) BF.bus.emit('prefs:changed', { reason, keys });
    BF.ui.refreshTabs();
    return true;
  }

  async function loadSchema() {
    if (S.schema) return S.schema;
    const res = await BF.api('prefs:schema');
    if (res.ok) {
      S.schema = res;
      S.schemaError = '';
      S.notices = res.notices || [];
      for (const notice of S.notices) BF.ui.toast(notice.message, 'error', 20000); // arquivo de preferências recuperado: o usuário precisa saber
    } else {
      S.schemaError = res.message || 'erro desconhecido';
    }
    return S.schema;
  }

  /** Escopo { type, name } a partir de 'general' | 'game' | 'channel' (usa o jogo/canal do projeto) ou de um objeto. */
  function scopeFrom(scope) {
    if (scope && typeof scope === 'object') return scope;
    if (scope === 'game' || scope === 'channel') return { type: scope, name: currentNames()[scope] };
    return { type: 'general' };
  }

  Object.assign(BF.prefs, {
    /** Valor em vigor (síncrono). Sem preferência do usuário/aprendida, vale o `fallback` de quem pergunta. */
    get(key, fallback) {
      const d = S.cache.details[key];
      if (d && d.source !== 'default') return clone(d.value);
      if (fallback !== undefined) return fallback;
      return d ? clone(d.value) : fallback;
    },
    /** Todos os valores em vigor { chave: valor } (inclui os padrões do app). */
    resolve() {
      return clone(S.cache.values);
    },
    /** De onde vem o valor: { value, scope: 'channel'|'game'|'general'|'default', source: 'explicit'|'learned'|'default', scopeName, label, evidence }. */
    explain(key) {
      const d = S.cache.details[key];
      if (!d) return null;
      return { value: clone(d.value), scope: d.scope, source: d.source, scopeName: d.scopeName || '', label: d.label, evidence: d.evidence || '' };
    },
    /** Grava uma preferência do usuário. scope: 'general' (padrão) | 'game' | 'channel' (do projeto aberto) | { type, name }. */
    async set(key, value, scope = 'general') {
      const target = scopeFrom(scope);
      if (target.type !== 'general' && !clean(target.name)) return { ok: false, code: 'NO_SCOPE', message: 'Defina o jogo ou o canal do projeto na aba Preferências antes.' };
      const res = await BF.api('prefs:set', { scope: target, key, value });
      if (res.ok) await afterEdit();
      return res;
    },
    /** Remove a preferência do usuário num escopo (a chave volta a herdar). */
    async unset(key, scope = 'general') {
      const target = scopeFrom(scope);
      if (target.type !== 'general' && !clean(target.name)) return { ok: false, code: 'NO_SCOPE', message: 'Defina o jogo ou o canal do projeto na aba Preferências antes.' };
      const res = await BF.api('prefs:unset', { scope: target, key });
      if (res.ok) await afterEdit();
      return res;
    },
    /** Escopo (jogo/canal) a que o cache se refere. */
    scope() {
      return { ...S.cache.scope };
    },
    reload: () => reload(currentNames(), 'manual'),
    ready: Promise.resolve()
  });

  BF.prefs.ready = (async () => {
    await loadSchema();
    await reload(currentNames(), 'start');
  })();

  async function afterEdit() {
    await reload(currentNames(), 'edit');
    await refreshAll();
  }

  // ---------- aprendizado: observar decisões ----------

  const observing = { project: null, ids: new Set(), resync: new Set(), timer: null };

  /**
   * Perfil usado numa exportação concluída. A fila grava em `cut.exports[].profile` o perfil efetivo do trabalho
   * (objeto com `id`, como o exportEngine monta); o contrato também aceita o id em texto.
   */
  function profileOf(project, cut) {
    const last = cut && Array.isArray(cut.exports) && cut.exports.length ? cut.exports[cut.exports.length - 1] : null;
    const fromExport = last && (typeof last.profile === 'string' ? last.profile : (last.profile && typeof last.profile.id === 'string' ? last.profile.id : null));
    const ext = (project.ext && project.ext.export) || {};
    return fromExport || ext.profileId || project.profileId || null;
  }

  const hasTimes = (o) => Boolean(o) && typeof o === 'object' && (Number.isFinite(o.start) || Number.isFinite(o.end));

  /**
   * O evento 'decision' (contrato 1.3) é uma decisão do USUÁRIO sobre o corte? Devolve
   *   'learn'  - sim: o estado do corte entra no aprendizado;
   *   'resync' - desfazer/refazer/restaurar: não é decisão nova, mas o que foi desfeito não pode continuar contando
   *              (só corrige cortes que já estavam observados; nunca cria evidência);
   *   null     - não conta: ajuste de áudio (scope 'audio'), de legendas (what 'subtitles'), título, e cortes
   *              sugeridos (origin 'auto') que a análise criou em lote.
   */
  function classifyDecision(ev) {
    if (!ev || typeof ev !== 'object' || typeof ev.cutId !== 'string' || !ev.cutId) return null;
    if (ev.source === 'undo' || ev.source === 'redo' || ev.source === 'restore') return 'resync';
    switch (ev.type) {
      case 'approve': case 'reject': case 'reset': case 'recategorize': case 'remove':
        return 'learn';
      case 'create':
        return ev.after && ev.after.origin === 'auto' ? null : 'learn';
      case 'adjust': {
        // só o ajuste de TEMPO do corte (before/after = { start, end }); áudio e legendas também usam 'adjust'
        if (typeof ev.scope === 'string' && ev.scope) return null;
        if ((ev.before && ev.before.what) || (ev.after && ev.after.what)) return null;
        return hasTimes(ev.before) || hasTimes(ev.after) ? 'learn' : null;
      }
      default:
        return null; // retitle e o que vier a existir: não muda nada do que se aprende
    }
  }

  /** Estado de um corte que importa ao aprendizado (null = removido). */
  function stateOf(project, cut) {
    if (!cut) return null;
    return {
      status: cut.status, duration: cut.end - cut.start, category: cut.category || '',
      relevance: typeof cut.relevance === 'number' ? cut.relevance : null, origin: cut.origin, profileId: profileOf(project, cut)
    };
  }

  /** Envia agora as decisões pendentes do projeto aberto. */
  async function flushObserve() {
    clearTimeout(observing.timer);
    observing.timer = null;
    const project = BF.state.project;
    const learn = [...observing.ids];
    const resync = [...observing.resync].filter((id) => !observing.ids.has(id)); // decisão do usuário na mesma janela vale mais
    observing.ids.clear();
    observing.resync.clear();
    if (!project || project.id !== observing.project || (!learn.length && !resync.length)) return;
    const names = currentNames();
    const send = async (ids, onlyKnown) => {
      if (!ids.length) return;
      const cuts = ids.map((id) => ({ id, state: stateOf(project, BF.project.cut(id)) }));
      const res = await BF.api('prefs:observe', { projectId: project.id, game: names.game, channel: names.channel, cuts, ...(onlyKnown ? { onlyKnown: true } : {}) });
      if (res.ok && res.changes && res.changes.length) await onLearned(res.changes);
    };
    await send(learn, false);
    await send(resync, true);
  }

  if (typeof window.addEventListener === 'function') window.addEventListener('beforeunload', () => { flushObserve(); }); // a chamada IPC sai na hora, antes de a janela fechar

  BF.bus.on('decision', (ev) => {
    const project = BF.state.project;
    if (!project || !S.cache.learning.enabled) return;
    const kind = classifyDecision(ev);
    if (!kind) return;
    if (observing.project && observing.project !== project.id) flushObserve();
    observing.project = project.id;
    (kind === 'learn' ? observing.ids : observing.resync).add(ev.cutId);
    clearTimeout(observing.timer);
    observing.timer = setTimeout(flushObserve, OBSERVE_DELAY_MS);
  });

  /**
   * Algo passou a valer (ou mudou) por aprendizado: atualiza o cache e avisa de forma visível. O aviso (toast e contador da
   * aba) é só do que é NOVO ou mudou de forma relevante (`notify`, decidido no processo principal); a mediana que anda um
   * pouco a cada corte novo atualiza o valor e o histórico sem um aviso por decisão.
   */
  async function onLearned(changes) {
    const news = changes.filter((c) => c.notify !== false);
    if (news.length) {
      if (!panelVisible()) S.unseen += news.length;
      const labels = [...new Set(news.map((c) => c.label))];
      if (news.length === 1) BF.ui.toast(`Preferência aprendida: ${news[0].text}. Veja e ajuste em Preferências.`, 'ok', 9000);
      else BF.ui.toast(`${news.length} preferências aprendidas (${labels.slice(0, 3).join(', ')}${labels.length > 3 ? ', …' : ''}). Veja e ajuste em Preferências.`, 'ok', 9000);
    }
    await reload(currentNames(), 'learned');
    if (panelVisible()) await refreshAll();
    BF.ui.refreshTabs();
  }

  const panelVisible = () => Boolean(S.root && S.root.closest('.tabpanel') && !S.root.closest('.tabpanel').hidden);

  // ---------- abrir vídeo: correspondência e comparação ----------

  const afterNotes = new Map(); // caminho -> o que gravar no projeto depois de aberto

  /** Modal com várias saídas (o da base só tem duas). Esc cancela; Tab fica preso no diálogo. */
  function choose({ title, message, actions, cancelValue }) {
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const titleId = 'prefs-modal-title';
      const msgId = 'prefs-modal-msg';
      const buttons = actions.map((a) => el('button', {
        type: 'button', class: a.primary ? 'primary' : 'secondary', dataset: { act: a.act }, onclick: () => close(a.value)
      }, a.label));
      const dialog = el('div', { class: 'bf-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': msgId },
        el('h2', { id: titleId }, title),
        el('p', { id: msgId, class: 'bf-modal-msg' }, message),
        el('div', { class: 'bf-modal-actions prefs-choose-actions' }, buttons));
      const backdrop = el('div', { class: 'bf-modal-backdrop' }, dialog);
      const app = document.getElementById('app');
      const modalRoot = document.getElementById('modalRoot');
      let closed = false;

      function close(value) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        if (!modalRoot.querySelector('.bf-modal-backdrop')) app.inert = false;
        if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
        resolve(value);
      }
      function onKey(event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close(cancelValue);
        } else if (event.key === 'Tab') {
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (!dialog.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
          else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }
      backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close(cancelValue); });
      document.addEventListener('keydown', onKey, true);
      app.inert = true;
      modalRoot.append(backdrop);
      (buttons.find((_, i) => actions[i].primary) || buttons[0]).focus();
    });
  }

  /**
   * Origem do arquivo que vai abrir: a que o gancho beforeOpen da aba Novo projeto (sources) já pôs em `ctx.origin` (o index.html carrega
   * sources.js antes deste arquivo, então o gancho dela roda primeiro) ou, se ela não pôs (ordem trocada, aba que não
   * carregou), a consulta direta a `sources:originFor` (VOD baixado pelo app ou gravação numa pasta do OBS). Aqui a
   * origem só é usada para comparar/perguntar: quem a grava em `ctx.origin` (e guarda o chat e o jogo/canal para o
   * afterOpen) é o gancho da aba Novo projeto (sources), para esse trabalho não depender de quem chegou primeiro.
   */
  async function knownOrigin(ctx) {
    if (ctx.origin) return ctx.origin;
    const res = await BF.api('sources:originFor', { path: ctx.path });
    return res.ok && res.known && res.origin ? res.origin : null;
  }

  /** O que gravar em project.ext.prefs.sourceChange a partir da comparação de prefs:inspect (a mesma forma nos dois caminhos). */
  function sourceChangeOf(compare) {
    return {
      at: new Date().toISOString(), direction: compare.direction,
      before: { duration: compare.duration.before, size: compare.size.before },
      after: { duration: compare.duration.after, size: compare.size.after },
      dismissed: false
    };
  }

  function matchMessage(match) {
    const lead = match.level === 'weak' ? 'Pode ser a live' : 'Parece a live';
    const where = match.project.sourcePath ? `\nProjeto existente: ${match.project.sourcePath}${match.project.sourceExists === false ? ' (o arquivo não está mais nesse lugar)' : ''}` : '';
    // este arquivo não é igual ao analisado (VOD que cresceu, outra qualidade, mais curto): a diferença vem ANTES da escolha
    const lines = match.compare && Array.isArray(match.compare.lines) ? match.compare.lines : [];
    const differences = lines.length ? ['', 'Este arquivo é diferente do que foi analisado:', ...lines.map((line) => `• ${line}`), ''] : [];
    return [
      `${lead} “${match.label}”, já analisada (${match.cutCount} ${plural(match.cutCount, 'corte', 'cortes')}).`,
      `Motivo: ${match.reasons.join('; ')}.${where}`,
      ...differences,
      'Abrir o existente copia os cortes e as decisões para este arquivo; o projeto original não é alterado. “Criar novo” começa do zero.'
    ].join('\n');
  }

  async function beforeOpen(ctx) {
    afterNotes.delete(ctx.path);
    await flushObserve(); // as decisões do projeto que está aberto não se perdem
    const origin = await knownOrigin(ctx);
    const res = await BF.api('prefs:inspect', { path: ctx.path, origin });
    if (!res.ok || !res.exists) return true; // sem informação não bloqueia: o source:open explica o problema real
    let scope = res.scope;

    if (res.compare) {
      const ok = await BF.ui.confirm({ title: res.compare.title, message: res.compare.message, okLabel: 'Atualizar e abrir', cancelLabel: 'Cancelar' });
      if (!ok) return false;
      afterNotes.set(ctx.path, { sourceChange: sourceChangeOf(res.compare) });
    } else if (res.matches.length) {
      const match = res.matches[0];
      const choice = await choose({
        title: 'Esta live já foi analisada?',
        message: matchMessage(match),
        cancelValue: 'cancel',
        actions: [
          { act: 'cancel', label: 'Cancelar', value: 'cancel' },
          { act: 'new', label: 'Criar novo', value: 'new' },
          { act: 'ok', label: 'Abrir o projeto existente', value: 'open', primary: true }
        ]
      });
      if (choice === 'cancel') return false;
      if (choice === 'open') {
        const adopted = await BF.api('project:adopt', { fromId: match.project.id, path: ctx.path, origin: ctx.origin || origin });
        if (!adopted.ok) {
          BF.ui.toast(adopted.message, 'error', 10000);
          return false;
        }
        // histórico de decisões do projeto de origem acompanha os cortes (melhor esforço; é do recurso de revisão)
        BF.api('review:historyCopy', { fromProjectId: match.project.id, toProjectId: adopted.project.id });
        afterNotes.set(ctx.path, {
          adoptedFrom: { projectId: match.project.id, sourcePath: match.project.sourcePath, label: match.label, level: match.level, at: new Date().toISOString() },
          // o arquivo novo difere do analisado: os cortes que passam do fim ficam sinalizados (nunca apagados), como na fonte atualizada
          ...(match.compare ? { sourceChange: sourceChangeOf(match.compare) } : {})
        });
        const adoptedNames = projectNames(adopted.project);
        scope = { game: adoptedNames.game || scope.game, channel: adoptedNames.channel || scope.channel };
      } else {
        afterNotes.set(ctx.path, { match: { decision: 'new', candidates: res.matches.map((m) => m.project.id), at: new Date().toISOString() } });
      }
    }
    await reload(scope, 'beforeOpen'); // as preferências do projeto que vai abrir já valem quando ele aparecer
    // se a abertura não chegar a acontecer (outro gancho cancelou, o arquivo falhou), o cache volta ao projeto que está aberto
    const verify = setTimeout(() => { if (namesKey(currentNames()) !== namesKey(S.cache.scope)) reload(currentNames(), 'verify'); }, VERIFY_OPEN_MS);
    if (verify && typeof verify.unref === 'function') verify.unref();
    return true;
  }

  async function afterOpen(ctx) {
    const note = afterNotes.get(ctx.path);
    afterNotes.delete(ctx.path);
    if (!note || !BF.state.project) return;
    BF.project.update((project) => {
      const prefs = { ...((project.ext && project.ext.prefs) || {}) };
      if (note.adoptedFrom) {
        delete prefs.sourceChange; // vieram do projeto de origem e não valem para este arquivo
        delete prefs.match;
        prefs.adoptedFrom = note.adoptedFrom;
      }
      if (note.match) prefs.match = note.match;
      if (note.sourceChange) prefs.sourceChange = note.sourceChange;
      project.ext = { ...(project.ext || {}), prefs };
    }, { reason: 'prefs:open' });
    const outside = note.sourceChange ? outsideCuts().length : 0;
    const outsideText = `${outside} ${plural(outside, 'corte ficou', 'cortes ficaram')} fora do novo intervalo: mantidos e sinalizados na aba Preferências.`;
    if (note.adoptedFrom) {
      const copied = `Cortes e decisões copiados de “${note.adoptedFrom.label}”. O projeto original continua como estava.`;
      BF.ui.toast(outside ? `${copied} ${outsideText}` : copied, outside ? 'error' : 'ok', outside ? 9000 : 8000);
    } else if (note.sourceChange) {
      BF.ui.toast(outside ? `Fonte atualizada. ${outsideText}` : 'Fonte atualizada. Decisões e ajustes foram mantidos.', outside ? 'error' : 'ok', 9000);
    }
    renderNotice();
    BF.ui.refreshTabs();
  }

  BF.hooks.add('beforeOpen', beforeOpen);
  BF.hooks.add('afterOpen', afterOpen);

  // ---------- projeto aberto ----------

  BF.bus.on('project:loaded', () => {
    observing.ids.clear();
    observing.resync.clear();
    observing.project = null;
    if (S.view.type !== 'general') S.view = { type: S.view.type, name: currentNames()[S.view.type] || '' }; // o escopo editado acompanha o novo projeto
    reload(currentNames(), 'project').then(() => { if (panelVisible()) refreshAll(); else renderNotice(); });
  });

  BF.bus.on('project:changed', () => {
    if (namesKey(currentNames()) !== namesKey(S.cache.scope)) reload(currentNames(), 'meta').then(() => { if (panelVisible()) refreshAll(); });
    else renderNotice();
  });

  // ---------- cortes fora do intervalo da fonte ----------

  function outsideCuts() {
    const project = BF.state.project;
    if (!project || !project.ext || !project.ext.prefs || !project.ext.prefs.sourceChange || project.ext.prefs.sourceChange.dismissed) return [];
    const duration = (BF.state.info && BF.state.info.duration) || (project.source && project.source.duration) || 0;
    if (!duration) return [];
    return project.cuts.filter((c) => c.end > duration + OUTSIDE_TOLERANCE);
  }

  // ---------- formatação ----------

  function fmtClock(sec) {
    const total = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
  const fmtNumber = (n) => String(Math.round(n * 100) / 100).replace('.', ',');

  function fmtValue(def, value) {
    if (!def || value === null || value === undefined) return 'padrão do app';
    switch (def.type) {
      case 'ratio': return `${Math.round(value * 100)}%`;
      case 'seconds': return `${fmtNumber(value)} s`;
      case 'bool': return value ? 'ligado' : 'desligado';
      case 'enum': { const hit = def.options.find((o) => o[0] === value); return hit ? hit[1] : String(value); }
      case 'list': return Array.isArray(value) ? value.join(', ') : String(value);
      case 'profile': { const hit = profileChoices().find((p) => p.id === value); return hit ? hit.name : String(value); }
      case 'object': return def.valueText || 'definido na aba Legendas';
      default: return String(value);
    }
  }

  // ---------- controles ----------

  const icon = (name, cls = '') => el('span', { class: `material-symbols-rounded${cls ? ` ${cls}` : ''}`, 'aria-hidden': 'true' }, name);
  const GROUP_ICONS = { export: 'ios_share', analysis: 'insights', review: 'rate_review', queue: 'queue', subtitles: 'subtitles' };

  /** Título de um cartão: ícone vermelho + texto (o h3 é o título da seção; h4, o de um grupo). */
  function cardTitle(tag, iconName, text) {
    return el('div', { class: 'prefs-title' }, icon(iconName, 'prefs-title-icon'), el(tag, {}, text));
  }

  /** Controle simples para uma chave. `commit(valor)` é chamado só quando o usuário conclui a edição. */
  function makeControl(def, value, { commit, disabled = false, focusKey }) {
    const common = { 'aria-label': def.label, dataset: { focus: focusKey }, disabled };
    switch (def.type) {
      case 'profile':
      case 'enum': {
        const options = def.type === 'enum' ? def.options.map(([id, name]) => ({ id, name })) : [...profileChoices()];
        if (value && !options.some((o) => o.id === value)) options.unshift({ id: value, name: `${value} (não encontrado)` });
        const select = el('select', { ...common, class: 'prefs-input' }, options.map((o) => el('option', { value: o.id }, o.name)));
        select.value = value;
        select.addEventListener('change', () => commit(select.value));
        return select;
      }
      case 'bool': {
        const box = el('input', { ...common, type: 'checkbox', role: 'switch', class: 'bds-switch', checked: Boolean(value) });
        box.addEventListener('change', () => commit(box.checked));
        return el('label', { class: 'prefs-switch' }, box);
      }
      case 'ratio':
      case 'seconds':
      case 'int': {
        const ratio = def.type === 'ratio';
        const min = ratio ? 0 : def.min;
        const max = ratio ? 100 : def.max;
        const shown = value === null || value === undefined ? '' : (ratio ? Math.round(value * 100) : value);
        const input = el('input', { ...common, class: 'prefs-number', type: 'number', min, max, step: def.type === 'seconds' ? 0.5 : (ratio ? 5 : 1), value: shown });
        input.addEventListener('change', () => {
          if (input.value === '') { input.value = shown; return; }
          commit(ratio ? Number(input.value) / 100 : Number(input.value));
        });
        // a unidade fica dentro do campo (como "s" e "%"), sem texto solto ao lado
        return el('span', { class: 'prefs-unit' }, input, ratio ? el('span', { class: 'prefs-unit-suffix' }, '%') : (def.type === 'seconds' ? el('span', { class: 'prefs-unit-suffix' }, 's') : null));
      }
      case 'list': {
        const input = el('input', { ...common, class: 'prefs-input prefs-wide', type: 'text', value: Array.isArray(value) ? value.join(', ') : '', placeholder: 'item 1, item 2' });
        input.addEventListener('change', () => commit(input.value));
        return input;
      }
      default:
        return value === null || value === undefined ? null : el('span', { class: 'muted small' }, fmtValue(def, value));
    }
  }

  // ---------- dados da tela ----------

  function viewScope() {
    return S.view.type === 'general' ? { type: 'general' } : { type: S.view.type, name: clean(S.view.name) };
  }
  const viewScopeValid = () => S.view.type === 'general' || Boolean(clean(S.view.name));

  async function refreshAll() {
    if (!S.root) return;
    const seq = ++S.refreshSeq;
    await loadSchema();
    const names = currentNames();
    const learnedNames = { game: names.game, channel: names.channel };
    if (S.view.type === 'game' && clean(S.view.name)) learnedNames.game = clean(S.view.name);
    if (S.view.type === 'channel' && clean(S.view.name)) learnedNames.channel = clean(S.view.name);
    const [list, learned, history, known] = await Promise.all([
      viewScopeValid() ? BF.api('prefs:list', { scope: viewScope() }) : Promise.resolve(null),
      BF.api('prefs:learned', learnedNames),
      BF.api('prefs:history', { limit: 30 }),
      BF.api('prefs:names'),
      loadProfiles()
    ]);
    if (seq !== S.refreshSeq) return;
    S.data.list = list && list.ok ? list : null;
    S.data.learned = learned.ok ? learned : null;
    S.data.history = history.ok ? history.entries : [];
    S.data.names = known.ok ? known : { games: [], channels: [] };
    renderAll();
  }

  function focusKeep(fn) {
    const active = document.activeElement;
    const key = active && S.root && S.root.contains(active) && active.dataset ? active.dataset.focus : null;
    fn();
    if (!key) return;
    const target = S.root.querySelector(`[data-focus="${key.split('\\').join('\\\\').split('"').join('\\"')}"]`);
    if (target && !target.disabled) target.focus({ preventScroll: true });
  }

  function renderAll() {
    if (!S.root) return;
    if (!S.schema) {
      for (const node of Object.values(S.refs)) if (node && typeof node.replaceChildren === 'function') node.replaceChildren();
      S.refs.project.append(el('div', { class: 'empty-state prefs-error', role: 'alert' },
        icon('error', 'empty-state-icon'),
        el('div', { class: 'empty-state-text' },
          el('strong', {}, 'Preferências indisponíveis'),
          el('p', {}, `Não foi possível carregar as preferências: ${S.schemaError || 'o recurso não respondeu'}. Reinicie o app; se continuar, o aviso do topo mostra qual parte não carregou.`))));
      return;
    }
    focusKeep(() => {
      renderNotice();
      renderProject();
      renderList();
      renderLearned();
      renderHistory();
      renderAdvanced();
    });
    BF.ui.refreshTabs();
  }

  // ---------- seção: aviso de fonte atualizada ----------

  function renderNotice() {
    const box = S.refs.notice;
    if (!box) return;
    const project = BF.state.project;
    const change = project && project.ext && project.ext.prefs && project.ext.prefs.sourceChange;
    if (!change || change.dismissed) { box.hidden = true; box.replaceChildren(); return; }
    const outside = outsideCuts();
    const dir = change.direction === 'longer' ? 'mais longa' : (change.direction === 'shorter' ? 'mais curta' : 'com outro tamanho');
    box.hidden = false;
    box.replaceChildren(...[
      icon('warning', 'prefs-notice-icon'),
      el('div', { class: 'prefs-notice-body' },
        el('p', { class: 'prefs-notice-title' }, `Fonte atualizada${change.at ? ` em ${fmtDate(change.at)}` : ''}: ${dir}.`),
        el('p', { class: 'muted small' }, `Duração ${fmtClock(change.before.duration)} → ${fmtClock(change.after.duration)}. Suas decisões e ajustes foram mantidos.`),
        outside.length
          ? el('div', { class: 'prefs-outside' },
            el('p', { class: 'small' }, `${outside.length} ${plural(outside.length, 'corte está fora do novo intervalo', 'cortes estão fora do novo intervalo')} (não apagados). Ajuste o tempo ou rejeite se não servirem mais.`),
            el('ul', {}, outside.map((c) => el('li', {},
              el('span', {}, `${c.title} · ${fmtClock(c.start)}–${fmtClock(c.end)}`),
              el('button', { type: 'button', class: 'link', onclick: () => showCut(c.id) }, 'Ver'))))
          )
          : null),
      el('button', { type: 'button', class: 'secondary sm', onclick: dismissNotice }, 'Dispensar aviso')
    ].filter(Boolean));
  }

  function showCut(id) {
    BF.ui.selectTab('cuts');
    BF.bus.emit('cut:selected', { id });
  }

  function dismissNotice() {
    BF.project.update((project) => {
      const prefs = (project.ext && project.ext.prefs) || {};
      if (prefs.sourceChange) project.ext = { ...project.ext, prefs: { ...prefs, sourceChange: { ...prefs.sourceChange, dismissed: true } } };
    }, { reason: 'prefs:dismiss' });
    renderNotice();
    BF.ui.refreshTabs();
  }

  // ---------- seção: este projeto ----------

  function renderProject() {
    const box = S.refs.project;
    const project = BF.state.project;
    const heading = cardTitle('h3', 'folder_special', 'Este projeto');
    const warnings = S.notices.map((n) => el('p', { class: 'prefs-warn small' }, n.message));
    if (!project) {
      box.replaceChildren(heading, ...warnings, el('p', { class: 'muted small' }, 'Abra um vídeo para definir o jogo e o canal do projeto. Até lá você edita as preferências gerais, ou as de um jogo/canal pelo seletor abaixo.'));
      return;
    }
    const origin = (project.source && project.source.origin) || {};
    const meta = project.meta || {};
    const field = (label, kind, listId, detected) => {
      const input = el('input', {
        type: 'text', class: 'prefs-input', list: listId, value: meta[kind] || '', maxlength: 120,
        placeholder: detected ? `Detectado: ${detected}` : (kind === 'game' ? 'ex.: Valorant' : 'ex.: nome do canal'),
        dataset: { focus: `meta-${kind}` }
      });
      input.addEventListener('change', () => {
        const value = clean(input.value);
        if (value === clean(meta[kind])) return;
        BF.project.update((p) => { p.meta = { ...(p.meta || {}), [kind]: value }; }, { reason: 'prefs:meta' });
      });
      return el('label', { class: 'prefs-field' }, el('span', {}, label), input);
    };
    box.replaceChildren(
      heading,
      ...warnings,
      el('div', { class: 'prefs-fields' }, field('Jogo', 'game', 'prefsGames', origin.game), field('Canal', 'channel', 'prefsChannels', origin.channel)),
      el('datalist', { id: 'prefsGames' }, S.data.names.games.map((n) => el('option', { value: n }))),
      el('datalist', { id: 'prefsChannels' }, S.data.names.channels.map((n) => el('option', { value: n }))),
      el('p', { class: 'muted small' }, 'Definem quais preferências valem aqui: canal, depois jogo, depois geral (a mais específica vence).')
    );
  }

  // ---------- seção: lista de preferências ----------

  /** Selo de origem (.bds-chip): padrão, geral, jogo, canal ou aprendida. `kind`: 'default' | 'explicit' | 'learned' | ''. */
  function pill(text, kind) {
    const tone = kind === 'explicit' ? ' bds-chip-accent' : (kind === 'learned' ? ' bds-chip-ok' : '');
    return el('span', { class: `prefs-pill bds-chip${tone}${kind ? ` ${kind}` : ''}` }, text);
  }

  function originPill(detail) {
    if (!detail) return null;
    const kind = detail.source === 'learned' ? 'learned' : (detail.source === 'default' ? 'default' : 'explicit');
    const pillNode = pill(detail.label, kind);
    if (detail.evidence) pillNode.title = detail.evidence;
    return pillNode;
  }

  async function saveValue(def, value) {
    const res = await BF.api('prefs:set', { scope: viewScope(), key: def.key, value }, { toast: true });
    if (res.ok) await afterEdit();
    else await refreshAll(); // volta o controle ao valor que vale
  }

  async function clearValue(def) {
    const res = await BF.api('prefs:unset', { scope: viewScope(), key: def.key }, { toast: true });
    if (res.ok) await afterEdit();
  }

  function prefRow(def) {
    const list = S.data.list;
    const explicit = list && Object.prototype.hasOwnProperty.call(list.values, def.key);
    const inherited = list && list.inherited[def.key];
    const shown = explicit ? list.values[def.key] : (inherited ? inherited.value : def.default);
    const effective = BF.state.project ? S.cache.details[def.key] : inherited;
    const row = el('div', { class: `prefs-row${explicit ? '' : ' inherited'}`, dataset: { key: def.key } });
    const controls = el('div', { class: 'prefs-controls' },
      makeControl(def, shown, { commit: (v) => saveValue(def, v), disabled: !viewScopeValid(), focusKey: `pref-${def.key}` }));
    // título + selo de origem (+ "Limpar") à esquerda; só o controle fica à direita
    row.append(el('div', { class: 'prefs-label' },
      el('div', { class: 'prefs-label-head' },
        el('span', { class: 'prefs-label-title' }, def.label),
        originPill(effective),
        explicit ? el('button', { type: 'button', class: 'link prefs-clear', title: 'Remove o valor deste escopo; volta a herdar', dataset: { focus: `clear-${def.key}` }, onclick: () => clearValue(def) }, 'Limpar') : null),
      def.hint ? el('span', { class: 'prefs-label-hint' }, def.hint) : null), controls);
    if (explicit && BF.state.project && effective) {
      const wanted = S.view;
      const shadowed = effective.source !== 'explicit' || effective.scope !== wanted.type || (wanted.type !== 'general' && norm(effective.scopeName) !== norm(wanted.name));
      if (shadowed) row.append(el('p', { class: 'prefs-shadow muted small' }, `Neste projeto vale ${effective.label}: ${fmtValue(def, effective.value)}.`));
    }
    return row;
  }

  function renderScopeBar() {
    const names = currentNames();
    const labels = [['general', 'Geral'], ['game', 'Jogo'], ['channel', 'Canal']];
    const buttons = labels.map(([type, text]) => el('button', {
      type: 'button', class: 'bds-tab prefs-seg', role: 'tab', 'aria-selected': String(S.view.type === type), dataset: { focus: `scope-${type}`, scope: type },
      onclick: () => {
        if (S.view.type === type) return;
        S.view = { type, name: type === 'general' ? '' : (names[type] || S.view.name || '') };
        refreshAll();
      }
    }, text));
    const bar = el('div', { class: 'prefs-scope' }, el('div', { class: 'bds-tabs prefs-segs', role: 'tablist', 'aria-label': 'Escopo das preferências' }, buttons));
    if (S.view.type !== 'general') {
      const kind = S.view.type;
      const known = kind === 'game' ? S.data.names.games : S.data.names.channels;
      const input = el('input', {
        type: 'text', class: 'prefs-input', list: `prefsScope-${kind}`, value: S.view.name, maxlength: 120,
        placeholder: kind === 'game' ? 'Nome do jogo' : 'Nome do canal', 'aria-label': kind === 'game' ? 'Nome do jogo' : 'Nome do canal', dataset: { focus: 'scope-name' }
      });
      input.addEventListener('change', () => { S.view = { type: kind, name: clean(input.value) }; refreshAll(); });
      bar.append(input, el('datalist', { id: `prefsScope-${kind}` }, known.map((n) => el('option', { value: n }))));
    }
    return bar;
  }

  function scopeHint() {
    const names = currentNames();
    const { type, name } = S.view;
    if (type === 'general') return 'Valem para todos os vídeos, quando nada mais específico existe.';
    if (!clean(name)) return `Escolha ou digite o nome ${type === 'game' ? 'do jogo' : 'do canal'} para editar as preferências dele.`;
    const mine = norm(names[type]);
    if (BF.state.project && mine && mine !== norm(name)) return `Estas preferências valem para ${type === 'game' ? 'o jogo' : 'o canal'} “${clean(name)}”, não para o projeto aberto (${names[type]}).`;
    return `Valem para vídeos ${type === 'game' ? 'do jogo' : 'do canal'} “${clean(name)}”; ganham das gerais.`;
  }

  /** Um cartão por grupo (Exportação, Análise…), com as linhas título+descrição / controle. */
  function groupCard(group, rows) {
    return el('div', { class: 'prefs-group panel' }, cardTitle('h4', GROUP_ICONS[group.id] || 'tune', group.label), el('div', { class: 'prefs-rows' }, rows.map(prefRow)));
  }

  function renderList() {
    const box = S.refs.list;
    const groups = S.schema.groups;
    const keys = S.schema.keys;
    const scopeCard = el('div', { class: 'prefs-scopecard panel' },
      cardTitle('h3', 'tune', 'Onde estas preferências valem'),
      renderScopeBar(),
      el('p', { class: 'muted small' }, scopeHint()));
    const nodes = [scopeCard];
    for (const warning of S.cache.warnings) nodes.push(el('p', { class: 'prefs-warn small' }, warning.message));
    if (!viewScopeValid()) { box.replaceChildren(...nodes); return; }
    const main = keys.filter((k) => !k.advanced);
    const extra = keys.filter((k) => k.advanced);
    for (const group of groups) {
      const rows = main.filter((k) => k.group === group.id);
      if (rows.length) nodes.push(groupCard(group, rows));
    }
    const open = Boolean(S.refs.moreOpen);
    const details = el('details', { class: 'prefs-more', open }, el('summary', {}, 'Mais ajustes'),
      el('div', { class: 'prefs-more-body' }, groups.map((group) => {
        const rows = extra.filter((k) => k.group === group.id);
        return rows.length ? groupCard(group, rows) : null;
      })));
    details.addEventListener('toggle', () => { S.refs.moreOpen = details.open; });
    nodes.push(details);
    box.replaceChildren(...nodes);
  }

  // ---------- seção: aprendidas ----------

  async function learnedPatch(id, patch) {
    const res = await BF.api('prefs:learnedSet', { id, ...patch }, { toast: true });
    if (res.ok) await afterEdit();
    else await refreshAll();
  }

  async function setLearning(patch) {
    const res = await BF.api('prefs:learning', patch, { toast: true });
    if (res.ok) {
      if (res.changes && res.changes.length) await onLearned(res.changes);
      await afterEdit();
    } else {
      await refreshAll();
    }
  }

  function learnedCard(item) {
    const def = defOf(item.key);
    const inactive = item.state !== 'active';
    const stateText = { active: 'em vigor', disabled: 'desativada', paused: 'pausada' }[item.state];
    const toggle = el('input', {
      type: 'checkbox', role: 'switch', class: 'bds-switch', checked: item.enabled, disabled: item.state === 'paused', 'aria-label': `Usar a preferência aprendida: ${item.label}`, dataset: { focus: `learned-on-${item.id}` }
    });
    toggle.addEventListener('change', () => learnedPatch(item.id, { enabled: toggle.checked }));
    const scopeText = item.scope.type === 'general' ? 'geral' : `${item.scope.type === 'game' ? 'jogo' : 'canal'} ${item.scope.name}`;
    return el('li', { class: `prefs-learned${inactive ? ' off' : ''}`, dataset: { id: item.id, state: item.state } },
      el('div', { class: 'prefs-learned-head' },
        toggle,
        el('div', { class: 'prefs-learned-title' },
          el('span', { class: 'prefs-learned-name' }, item.label),
          el('span', { class: 'prefs-chips' },
            pill('aprendida', 'learned'), pill(scopeText), item.edited ? pill('editada', 'explicit') : null, pill(stateText, inactive ? 'default' : ''))),
        el('div', { class: 'prefs-controls' },
          makeControl(def, item.value, { commit: (v) => learnedPatch(item.id, { value: v }), disabled: item.state === 'paused', focusKey: `learned-${item.id}` }))),
      item.edited ? el('div', { class: 'prefs-learned-restore' }, el('button', { type: 'button', class: 'link', dataset: { focus: `restore-${item.id}` }, onclick: () => learnedPatch(item.id, { restore: true }) }, `Voltar ao aprendido (${fmtValue(def, item.computed)})`)) : null,
      el('p', { class: 'prefs-evidence muted small' }, `${item.evidence}.`));
  }

  function renderLearned() {
    const box = S.refs.learned;
    const data = S.data.learned;
    const enabled = data ? data.enabled : S.cache.learning.enabled;
    const toggle = el('input', { type: 'checkbox', role: 'switch', class: 'bds-switch', id: 'prefsLearnOn', checked: enabled, dataset: { focus: 'learning-on' } });
    toggle.addEventListener('change', () => setLearning({ enabled: toggle.checked }));
    const nodes = [
      cardTitle('h3', 'psychology', 'Aprendido com suas decisões'),
      el('label', { class: 'prefs-row prefs-learn-toggle', for: 'prefsLearnOn' },
        el('div', { class: 'prefs-label' },
          el('span', { class: 'prefs-label-title' }, 'Aprender com minhas decisões'),
          el('span', { class: 'prefs-label-hint' }, enabled
            ? `Observa o que você aprova, rejeita e categoriza. Nada vale antes de ${data ? data.minEvidence : S.cache.learning.minEvidence} cortes de evidência, e tudo pode ser editado, desativado ou desfeito aqui.`
            : 'Desligado: nada novo é observado e nenhuma preferência aprendida vale. O que já foi aprendido continua guardado abaixo.')),
        el('div', { class: 'prefs-controls' }, toggle))
    ];
    if (data) {
      const shown = data.items.filter((i) => i.state !== 'waiting');
      const waiting = data.items.filter((i) => i.state === 'waiting');
      if (shown.length) nodes.push(el('ul', { class: 'prefs-learned-list' }, shown.map(learnedCard)));
      else if (enabled) {
        nodes.push(el('div', { class: 'empty-state prefs-empty' },
          icon('psychology', 'empty-state-icon'),
          el('div', { class: 'empty-state-text' },
            el('strong', {}, 'Nada aprendido ainda'),
            el('p', {}, data.observed ? 'Ainda sem evidência suficiente para propor algo.' : 'Ainda nada aprendido: aprove ou rejeite alguns cortes.'))));
      }
      if (waiting.length) {
        nodes.push(el('details', { class: 'prefs-waiting' },
          el('summary', {}, `${waiting.length} ${plural(waiting.length, 'sugestão aguarda', 'sugestões aguardam')} mais decisões`),
          el('ul', {}, waiting.map((i) => el('li', { class: 'muted small' }, `${i.label}: ${i.n} de ${i.needed} — ${i.evidence}`)))));
      }
    }
    box.replaceChildren(...nodes);
  }

  // ---------- seção: histórico ----------

  async function revert(entry) {
    const ok = await BF.ui.confirm({ title: 'Desfazer alteração', message: `${entry.label}\n\nIsto volta ao que valia antes dessa mudança.`, okLabel: 'Desfazer' });
    if (!ok) return;
    const res = await BF.api('prefs:revert', { id: entry.id }, { toast: true });
    if (res.ok) await afterEdit();
    else await refreshAll();
  }

  function renderHistory() {
    const box = S.refs.history;
    const entries = S.data.history;
    const open = box.open;
    box.replaceChildren(
      el('summary', {}, `Histórico de mudanças${entries.length ? ` (${entries.length})` : ''}`),
      entries.length
        ? el('ul', { class: 'prefs-history' }, entries.map((e) => el('li', { dataset: { id: e.id } },
          el('span', { class: 'prefs-history-text' }, el('span', { class: 'muted small prefs-history-date' }, `${fmtDate(e.at)} `), e.label),
          e.revertible ? el('button', { type: 'button', class: 'link', dataset: { focus: `revert-${e.id}` }, onclick: () => revert(e) }, 'Desfazer') : el('span', { class: 'muted small' }, e.revertedAt ? 'desfeita' : ''))))
        : el('p', { class: 'muted small prefs-history-empty' }, 'Nenhuma mudança ainda.')
    );
    box.open = open;
  }

  // ---------- seção: avançado ----------

  async function forget() {
    const ok = await BF.ui.confirm({
      title: 'Esquecer o que foi aprendido',
      message: 'Apaga as observações guardadas (durações, categorias, rejeições) e o estado das preferências aprendidas. Suas preferências definidas à mão não mudam. Isto não pode ser desfeito.',
      okLabel: 'Esquecer', danger: true
    });
    if (!ok) return;
    const res = await BF.api('prefs:forget', {}, { toast: true });
    if (res.ok) { BF.ui.toast('Aprendizado apagado.', 'ok'); await afterEdit(); }
  }

  function renderAdvanced() {
    const box = S.refs.advanced;
    const open = box.open;
    const minEv = S.data.learned ? S.data.learned.minEvidence : S.cache.learning.minEvidence;
    const limits = S.schema.minEvidence;
    const input = el('input', { type: 'number', class: 'prefs-number', min: limits.min, max: limits.max, step: 1, value: minEv, 'aria-label': 'Evidência mínima para aprender', dataset: { focus: 'min-evidence' } });
    input.addEventListener('change', () => setLearning({ minEvidence: Number(input.value) }));
    box.replaceChildren(
      el('summary', {}, 'Avançado'),
      el('div', { class: 'prefs-rows' },
        el('div', { class: 'prefs-row' },
          el('div', { class: 'prefs-label' }, el('span', { class: 'prefs-label-title' }, 'Evidência mínima para aprender'), el('span', { class: 'prefs-label-hint' }, `Cortes decididos antes de uma sugestão valer (${limits.min} a ${limits.max}; padrão ${limits.default}).`)),
          el('div', { class: 'prefs-controls' }, el('span', { class: 'prefs-unit' }, input, el('span', { class: 'prefs-unit-suffix' }, 'cortes')))),
        el('div', { class: 'prefs-row' },
          el('div', { class: 'prefs-label' }, el('span', { class: 'prefs-label-title' }, 'Esquecer o que foi aprendido'), el('span', { class: 'prefs-label-hint' }, 'Apaga as observações guardadas no computador.')),
          el('div', { class: 'prefs-controls' }, el('button', { type: 'button', class: 'secondary danger sm', onclick: forget }, 'Esquecer…'))))
    );
    box.open = open;
  }

  // ---------- aba ----------

  BF.ui.registerTab({
    id: 'prefs',
    title: 'Preferências',
    order: 80,
    badge: () => (outsideCuts().length ? '!' : (S.unseen ? String(S.unseen) : '')),
    onShow() {
      S.unseen = 0;
      refreshAll();
    },
    render(container) {
      S.root = container;
      container.classList.add('prefs');
      S.refs.notice = el('section', { class: 'prefs-notice', hidden: true, 'aria-live': 'polite' });
      S.refs.project = el('section', { class: 'prefs-section prefs-card panel' });
      S.refs.list = el('section', { class: 'prefs-section prefs-list' },
        el('div', { class: 'prefs-skeleton', role: 'status', 'aria-busy': 'true' }, el('span', { class: 'sr-only' }, 'Carregando as preferências…'), [0, 1].map(() => el('div', { class: 'prefs-skel', 'aria-hidden': 'true' }))));
      S.refs.learned = el('section', { class: 'prefs-section prefs-card panel' });
      S.refs.history = el('details', { class: 'prefs-section prefs-details' });
      S.refs.advanced = el('details', { class: 'prefs-section prefs-details' });
      container.append(el('p', { class: 'prefs-intro' }, 'Os padrões do Braga Frame para análise, revisão, exportação e fila. Valem para todos os vídeos, ou só para um jogo ou canal.'),
        S.refs.notice, S.refs.project, S.refs.list, S.refs.learned, S.refs.history, S.refs.advanced);
      refreshAll();
    }
  });
})();

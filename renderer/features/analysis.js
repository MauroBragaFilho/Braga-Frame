'use strict';

/**
 * Aba "Análise" (dono: analysis): procura trechos prováveis de bons cortes com dois motores. O ALGORITMO usa REGRAS simples (volume
 * acima do normal de fala, mudança de cena/movimento da imagem, velocidade/palavras-chave do chat e, quando há transcrição, risadas,
 * exclamações, ritmo de fala e repetição); a IA NA NUVEM (provedor compatível com a OpenAI escolhido pelo usuário, sem nenhum
 * pré-selecionado) lê a TRANSCRIÇÃO do vídeo, e o app confere tudo localmente. Sugestão não é garantia: o usuário revisa
 * tudo. Os trechos viram cortes `origin:'auto'` sempre PENDENTES. Nada vai para a nuvem antes de o usuário aceitar o aviso de privacidade.
 *
 * PERFIL DE HUMOR DO CANAL (cartão abaixo da transcrição; regras em src/core/analysis/humor.js, window.BFHumor): o que é um bom corte do canal.
 * Fica nas Preferências (analysis.humor, herdado canal > jogo > geral): a IA recebe os critérios, as listas e, se o usuário deixar, trechos de cortes
 * aprovados e rejeitados; o algoritmo conta os bordões e as palavras de reação. Não é guardado no projeto.
 *
 * Dados no projeto: `project.analysis.lastRun` (contrato 2.1) e `project.ext.analysis`
 * ({ settings, suggestions, signals, warnings, runAt, ... }). Quem grava é o renderer (BF.project.update).
 * Eventos emitidos ao adicionar: 'cuts:changed' e 'decision' type 'create' (um por corte).
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;

  // ---------- funções puras: veja features/analysis/logic.js (window.BFAnalysisLogic) ----------
  const { PROFILES, isCovered, clock, remainingSec, stageRemainingSec, pct, num, pendingSuggestions, dismissedSuggestions, sameSource, MAX_DISMISSED, ENGINE_IDS, usesAi, usesAlgorithm, usesChat, applyBestOnly, splitKeywords, compactReview, compactAi } = window.BFAnalysisLogic;

  // ---------- estado ----------
  const state = {
    defaults: null, // resposta de analysis:defaults
    running: false,
    starting: false,
    job: null, // { id, projectId }
    progress: null, // { p, message }
    startedAt: 0, // Date.now() do início da análise (para estimar o tempo restante)
    notice: null, // { kind: 'error'|'info', text }
    early: [], // eventos que chegaram antes da resposta de analysis:start
    stages: null, // { etapa: { startedAt, p0, p } } da análise em andamento (eventos com stageP), para o tempo restante; null = sem essa informação
    skill: null, // o guia de cortes em uso (analysis:aiSkill), pedido ao abrir a caixa "Guia de cortes"
    skillDraft: false, // a pessoa está editando o guia (o texto dela não é sobrescrito)
    skillMsg: null, // { ok, text } da última ação no guia
    ui: {}, // nós principais
    ai: null, // estado da IA (analysis:aiState): provedor, modelo, chave guardada?, aceite… NUNCA traz a chave
    transcript: null, // resumo da transcrição do vídeo (analysis:transcriptStatus)
    tengine: null, // o motor de transcrição (Whisper) está pronto?
    tjob: null, // transcrição em andamento { id, p, message, doneUntil }
    tstarting: false,
    step: 'method', // passo da tela (steps.js): transcript, method, settings ou results
    stepSet: false, // o passo inicial deste vídeo já foi escolhido?
    stepFor: null, // id do projeto a que o passo se refere
    manual: null, // pedido para a IA de chat montado { parts, approx, fps, words } (analysis:manualPrompt)
    estimate: null, // estimativa da análise por IA { label, calls, exceedsLimit, limit }
    hDirty: false, // o usuário editou o perfil de humor e ainda não salvou (a tela não sobrescreve o rascunho)
    hExamples: null, // exemplos do perfil que iriam à IA { approved, rejected, projects } (analysis:humorExamples); null = ainda não consultado
    orFree: null, // OpenRouter: a estimativa comparada com os pedidos gratuitos que restam hoje { level, message } (avisa; não bloqueia)
    orChoices: null, // OpenRouter: roteador e modelos gratuitos que a lista de "Modelos de reserva" oferece [{ id, name }]
    test: null, // resultado do "Testar conexão" { ok, text }
    tearly: [], // eventos da transcrição que chegaram antes da resposta de transcriptGenerate
    lastEngine: null, // motor da última execução (para oferecer o algoritmo quando a IA falha)
    autoOpened: false // o cartão de configuração da IA já foi aberto sozinho uma vez
  };

  const stored = () => (BF.state.project && BF.state.project.ext && BF.state.project.ext.analysis) || null;

  /** Resultado guardado, só se for deste vídeo (ver sameSource); os ajustes (`settings`) valem de qualquer forma e vêm de stored(). */
  const current = () => {
    const saved = stored();
    return saved && sameSource(saved.source, BF.state.project.source) ? saved : null;
  };

  const dismissedOf = (saved) => (saved && Array.isArray(saved.dismissed) ? saved.dismissed : []);

  const visible = () => {
    const saved = current();
    return saved ? pendingSuggestions(saved.suggestions, BF.state.project.cuts, dismissedOf(saved)) : [];
  };

  /**
   * Ordem da lista na tela (só a exibição: "Adicionar todas" e o resto continuam na ordem de relevância). 'relevance' (padrão) ou
   * 'time' (ordem do vídeo; numa live com episódios, a ordem dos episódios). Fica no projeto, em `ext.analysis.listOrder`.
   */
  const listOrder = () => (stored() && stored().listOrder === 'time' ? 'time' : 'relevance');

  const inViewOrder = (list) => (listOrder() === 'time' ? [...list].sort((a, b) => a.start - b.start || b.relevance - a.relevance) : list);

  function defaultSettings() {
    const d = state.defaults ? state.defaults.defaults : null;
    const fromPrefs = BF.prefs.get('analysis.keywords', null);
    return {
      signals: { audio: true, image: true, chat: true, text: true, calm: true },
      sensitivity: d ? d.sensitivity : 3,
      perHour: d ? d.perHour : 6,
      weights: d ? { ...d.weights } : { audio: 0.8, image: 0.6, chat: 1, text: 1, calm: 0.7 },
      profile: d && d.profile ? d.profile : 'gameplay',
      episodes: d && typeof d.episodes === 'boolean' ? d.episodes : true,
      autoQuantity: d && typeof d.autoQuantity === 'boolean' ? d.autoQuantity : false,
      bestOnly: false,
      filterWeak: d && typeof d.filterWeak === 'boolean' ? d.filterWeak : true,
      aiReview: true, // modo Algoritmo + IA: a IA confere as sugestões que só o algoritmo achou
      aiWindows: false, // IA vê só os trechos candidatos (áudio, chat, risadas) em vez da transcrição inteira
      textWeights: d && d.textWeights ? { ...d.textWeights } : { laugh: 1, exclaim: 1, pace: 1, repeat: 1, meta: 1, humor: 1, structure: 1 },
      chat: {
        keywords: Array.isArray(fromPrefs) ? fromPrefs.map(String) : (d ? [...d.chat.keywords] : []),
        lagSec: d ? d.chat.lagSec : 6,
        windowSec: d ? d.chat.windowSec : 10
      },
      image: { fast: false }
    };
  }

  /** Ajustes deste vídeo: o que o usuário salvou por cima dos padrões. */
  function settings() {
    const base = defaultSettings();
    const saved = (stored() && stored().settings) || {};
    return {
      signals: { ...base.signals, ...(saved.signals || {}) },
      sensitivity: num(saved.sensitivity, base.sensitivity),
      perHour: num(saved.perHour, base.perHour),
      weights: { ...base.weights, ...(saved.weights || {}) },
      profile: PROFILES.some((p) => p.id === saved.profile) ? saved.profile : base.profile,
      episodes: typeof saved.episodes === 'boolean' ? saved.episodes : base.episodes,
      // "Só os melhores" e a quantidade automática são opostos: se os dois vierem marcados, vale o mais exigente
      autoQuantity: saved.bestOnly === true ? false : (typeof saved.autoQuantity === 'boolean' ? saved.autoQuantity : base.autoQuantity),
      bestOnly: saved.bestOnly === true,
      filterWeak: typeof saved.filterWeak === 'boolean' ? saved.filterWeak : base.filterWeak,
      aiReview: typeof saved.aiReview === 'boolean' ? saved.aiReview : base.aiReview,
      aiWindows: saved.aiWindows === true,
      textWeights: { ...base.textWeights, ...(saved.textWeights || {}) },
      chat: { ...base.chat, ...(saved.chat || {}), keywords: Array.isArray(saved.chat && saved.chat.keywords) ? saved.chat.keywords : base.chat.keywords },
      image: { ...base.image, ...(saved.image || {}) },
      engine: ENGINE_IDS.includes(saved.engine) ? saved.engine : null // null = escolha automática (veja engineChoice)
    };
  }

  /**
   * Motor em uso. A escolha do usuário vale; sem escolha: Algoritmo + IA se há provedor configurado COM o aviso de privacidade aceito (na
   * gameplay medida, os dois juntos acharam mais momentos bons que cada um sozinho), senão o algoritmo (que roda sem nada configurado e sem
   * enviar nada para fora).
   */
  function engineChoice() {
    const saved = settings().engine;
    if (saved) return saved;
    return state.ai && state.ai.ready && state.ai.accepted ? 'both' : 'algorithm';
  }

  /** A análise por IA pode começar? { ok, why } — `why` explica o que falta, em português. */
  function aiBlockers() {
    const why = [];
    if (!BF.state.project) return { ok: false, why: ['Abra um vídeo.'] };
    if (!state.ai) why.push('Carregando a configuração da IA…');
    else if (!state.ai.ready) why.push(state.ai.provider && state.ai.provider.reason ? state.ai.provider.reason : 'Configure o provedor de IA.');
    if (state.tjob || state.tstarting) why.push('A transcrição ainda está sendo gerada.');
    else if (!state.transcript || !state.transcript.exists) why.push('A IA precisa da transcrição do vídeo: gere ou importe uma.');
    else if (state.transcript.stale) why.push('A transcrição é de outro arquivo de vídeo: gere ou importe de novo.');
    if (state.estimate && state.estimate.exceedsLimit) why.push(`Esta análise passa do limite de ${state.estimate.limit} chamadas: aumente o limite em "Provedor, chave e limites" ou use o algoritmo.`);
    return { ok: why.length === 0, why };
  }

  /**
   * Guarda os ajustes deste vídeo. As palavras-chave só vão para o projeto quando DIFEREM das que valem agora (Preferências
   * ou padrão do app): gravar a lista igual congelaria o valor e uma mudança posterior nas Preferências nunca chegaria aqui.
   */
  function saveSettings(next) {
    const base = defaultSettings();
    const sameKeywords = JSON.stringify(next.chat.keywords) === JSON.stringify(base.chat.keywords);
    let stored = next;
    if (sameKeywords) {
      const chat = { ...next.chat };
      delete chat.keywords;
      stored = { ...next, chat };
    }
    BF.project.update((project) => {
      project.ext = project.ext || {};
      project.ext.analysis = { ...(project.ext.analysis || {}), settings: stored };
    }, { reason: 'analysis:settings' });
  }

  /** Margens e durações vêm das preferências (BF.prefs); sem elas valem os padrões do contrato. */
  function prefValues() {
    const ranges = (state.defaults && state.defaults.ranges) || {};
    // a análise limita cada valor à própria faixa (params.js); mostrar e enviar o valor já limitado evita a tela dizer uma coisa e a análise usar outra
    const get = (key, fallback) => {
      const value = num(BF.prefs.get(key, fallback), fallback);
      const range = ranges[key.slice('analysis.'.length)];
      return Array.isArray(range) ? Math.min(range[1], Math.max(range[0], value)) : value;
    };
    return {
      padBeforeSec: get('analysis.padBeforeSec', 3),
      padAfterSec: get('analysis.padAfterSec', 2),
      minDurationSec: get('analysis.minDurationSec', 15),
      maxDurationSec: get('analysis.maxDurationSec', 60),
      minRelevance: get('analysis.minRelevance', 0.5)
    };
  }

  /** Preferências cujo valor a análise precisou limitar (fora da faixa que ela aceita), para a tela avisar. */
  function limitedPrefs() {
    const ranges = (state.defaults && state.defaults.ranges) || {};
    const out = [];
    for (const key of ['padBeforeSec', 'padAfterSec', 'minDurationSec', 'maxDurationSec', 'minRelevance']) {
      const raw = num(BF.prefs.get(`analysis.${key}`, undefined), null);
      const range = ranges[key];
      if (raw !== null && Array.isArray(range) && (raw < range[0] || raw > range[1])) out.push(`${key === 'minRelevance' ? pct(raw) : `${raw} s`} fica fora do que a análise aceita (${key === 'minRelevance' ? `${pct(range[0])} a ${pct(range[1])}` : `${range[0]} a ${range[1]} s`})`);
    }
    return out;
  }

  // ---------- cortes ----------

  /** Cria os cortes (pendentes, origin 'auto') de uma vez e avisa 'cuts:changed' e 'decision' create. */
  function addSuggestions(list) {
    const project = BF.state.project;
    if (!project || !list.length) return [];
    const fresh = list.filter((s) => !isCovered(s, project.cuts)); // duplo clique ou lista velha
    if (!fresh.length) return [];
    const created = [];
    BF.project.update((p) => {
      for (const s of fresh) {
        const cut = BF.model.newCut({
          title: s.title || `Sugestão ${clock(s.start)}`,
          start: s.start,
          end: s.end,
          status: 'pending', // nunca aprovado automaticamente
          origin: 'auto',
          relevance: s.relevance,
          reasons: s.reasons,
          ...(s.category ? { category: s.category } : {}),
          ...(s.layout ? { layout: s.layout } : {}), // 'conversa' | 'jogo' (a IA indica o enquadramento; o usuário ajusta por corte)
          ...(s.theme ? { theme: s.theme } : {}), ...(Array.isArray(s.keywords) && s.keywords.length ? { keywords: s.keywords } : {}), // tema do perfil e palavras-chave (só a IA)
          ...(Array.isArray(s.flags) && s.flags.length ? { flags: s.flags } : {})
        }, { index: p.cuts.length });
        p.cuts.push(cut);
        created.push(cut);
      }
      p.cuts.sort((a, b) => a.start - b.start);
    }, { reason: 'analysis:add' });
    BF.bus.emit('cuts:changed', { ids: created.map((c) => c.id), from: 'analysis' });
    for (const cut of created) {
      BF.bus.emit('decision', { cutId: cut.id, type: 'create', before: null, after: JSON.parse(JSON.stringify(cut)) });
    }
    return created;
  }

  // ---------- descartar ----------

  /**
   * Descarta sugestões SEM criar corte: elas somem da lista (e do selo da aba) e não voltam em novas análises do mesmo vídeo.
   * Ficam guardadas em ext.analysis.dismissed e podem ser restauradas na seção "Descartadas".
   */
  function dismissSuggestions(list) {
    if (!current() || !list.length) return 0;
    const at = new Date().toISOString();
    BF.project.update((project) => {
      const entry = project.ext.analysis;
      entry.dismissed = [...dismissedOf(entry), ...list.map((s) => ({ start: s.start, end: s.end, peak: s.peak, at }))].slice(-MAX_DISMISSED);
    }, { reason: 'analysis:dismiss' });
    return list.length;
  }

  /** Desfaz o descarte de sugestões. Um descarte antigo que cobria também outra sugestão ainda descartada é mantido para ela. */
  function restoreSuggestions(list) {
    if (!current() || !list.length) return 0;
    BF.project.update((project) => {
      const entry = project.ext.analysis;
      const stillDismissed = dismissedSuggestions(entry.suggestions, project.cuts, dismissedOf(entry)).filter((s) => !list.some((x) => x.id === s.id));
      const kept = dismissedOf(entry).filter((d) => !list.some((s) => isCovered(s, [d])));
      const at = new Date().toISOString();
      for (const s of stillDismissed) if (!isCovered(s, kept)) kept.push({ start: s.start, end: s.end, peak: s.peak, at });
      entry.dismissed = kept;
    }, { reason: 'analysis:restore' });
    return list.length;
  }

  // ---------- execução ----------

  /** Aviso de privacidade ANTES do primeiro envio ao provedor (lembrado por provedor). true = pode enviar. */
  async function ensureConsent(target = null) {
    // `target`: um provedor de RESERVA (state.ai.fallback.providers); sem ele, o provedor escolhido
    if (!target && state.ai && state.ai.accepted) return true;
    if (!state.ai || !state.ai.provider) return false;
    const p = target || state.ai.provider;
    const where = p.source === 'host'
      ? `o provedor configurado no ${p.hostName || 'aplicativo'} (${p.label}${p.model ? `, ${p.model}` : ''})`
      : `${p.label}${p.host ? ` (${p.host})` : ''}`;
    const custom = p.id === 'custom';
    const ok = await BF.ui.confirm({
      title: 'Enviar trechos para a IA?',
      message: [
        'A IA vai receber trechos da transcrição deste vídeo, as mensagens do chat do mesmo período e o título, o canal e o jogo. O vídeo e o áudio nunca saem do seu computador.',
        'O guia de cortes (as instruções de como escolher, em "Guia de cortes") vai em cada chamada; se você escreveu o seu, vai o seu texto.',
        humorProfile() ? 'O perfil de humor do canal também vai: os critérios e as listas que você escreveu e, se a opção de exemplos estiver ligada, trechos da fala de alguns cortes que você aprovou e rejeitou antes (a lista do que seria enviado aparece em "Perfil de humor do canal").' : '',
        `Quem recebe: ${where}.`,
        'Alguns planos gratuitos usam o que é enviado para treinar modelos; confira os termos do seu plano.',
        p.privacy || '',
        custom
          ? 'O aviso fica aceito para este provedor e este endereço até você revogar (se mudar o endereço, ele é pedido de novo). Não tem prazo.'
          : 'O aviso fica aceito para este provedor até você revogar. Não tem prazo.'
      ].filter(Boolean).join('\n\n'),
      okLabel: 'Aceitar e continuar',
      cancelLabel: 'Agora não'
    });
    if (!ok) return false;
    const res = await BF.api('analysis:aiAccept', { accepted: true, ...(target ? { provider: target.id } : {}) });
    if (!res.ok || !res.ai) { BF.ui.toast(res.message || 'Não foi possível guardar o aceite.', 'error'); return false; }
    state.ai = res.ai;
    renderAll();
    return true;
  }

  /** O que a análise por IA manda ao processo principal (a chave nunca passa por aqui: quem a guarda é o processo principal). */
  function aiPayload(project, chosen = null) {
    const origin = project.source.origin || {};
    const profile = humorProfile(); // perfil de humor do canal (critérios, listas e a opção de exemplos); o processo principal escolhe os exemplos
    return {
      engine: 'ai',
      ...(chosen && chosen.aiWindows ? { aiWindows: true } : {}),
      ...(profile ? { profile } : {}),
      projectId: project.id,
      path: project.source.path,
      size: project.source.size || 0,
      duration: project.source.duration || (BF.state.info && BF.state.info.duration) || 0,
      params: { ...chosen, ...prefValues(), chat: { ...chosen.chat } },
      chatPath: project.chat && project.chat.path ? project.chat.path : null,
      meta: {
        title: origin.title || (BF.util.baseOf ? BF.util.baseOf(project.source.path) : project.source.path),
        channel: (project.meta && project.meta.channel) || origin.channel || '',
        game: (project.meta && project.meta.game) || origin.game || ''
      },
      existingCuts: project.cuts.map((c) => ({ start: c.start, end: c.end })) // inclusive os rejeitados: a IA não repete o que já existe
    };
  }

  /** `fresh`: ignora o resultado e os sinais já guardados (cache) e lê o vídeo de novo. `engine`: força o motor desta execução. */
  async function run({ fresh = false, engine = null } = {}) {
    const project = BF.state.project;
    const useEngine = engine || engineChoice();
    if (!project || state.running || state.starting || usesChat(useEngine)) return; // a IA de chat não tem Analisar: o pedido é copiado e a resposta colada
    if ((usesAi(useEngine) && !aiBlockers().ok) || (usesAlgorithm(useEngine) && !usableSignals().length)) return;
    const controls = readControls();
    const chosen = applyBestOnly(controls); // "Só os melhores" vira quantidade fixa no pedido; o ajuste guardado continua o da tela
    if (usesAi(useEngine) && !(await ensureConsent())) return;
    saveSettings(controls);
    state.notice = null;
    state.starting = true;
    state.running = true;
    state.startedAt = Date.now();
    state.lastEngine = useEngine;
    state.progress = { p: 0, message: 'Preparando…' };
    state.stages = null;
    renderRun();
    let payload;
    if (useEngine === 'ai') {
      payload = aiPayload(project, chosen);
    } else {
      const params = {
        ...chosen,
        ...prefValues(),
        humor: humorLists(), // bordões e palavras de reação do perfil do canal (as Preferências, não o projeto)
        chat: { ...chosen.chat }
      };
      const usable = chosen.signals.chat && project.chat && project.chat.path;
      payload = {
        path: project.source.path, params, chatPath: usable ? project.chat.path : null,
        // o processo principal procura a transcrição deste vídeo (userData/transcripts) e a confere com o arquivo
        projectId: project.id, size: project.source.size || 0, duration: project.source.duration || (BF.state.info && BF.state.info.duration) || 0,
        ...(fresh ? { fresh: true } : {})
      };
      if (useEngine === 'both') {
        // Algoritmo + IA: o pedido do algoritmo mais o que a IA precisa (metadados, cortes que já existem, perfil do canal)
        const extra = aiPayload(project, chosen);
        payload = { ...payload, engine: 'both', meta: extra.meta, existingCuts: extra.existingCuts, ...(extra.profile ? { profile: extra.profile } : {}), ...(chosen.aiWindows ? { aiWindows: true } : {}), review: chosen.aiReview !== false };
      }
    }
    const res = await BF.api('analysis:start', payload);
    state.starting = false;
    if (!res.ok) {
      state.running = false;
      state.progress = null;
      state.notice = { kind: 'error', text: res.message, ...(usesAi(useEngine) ? { fallback: true, modelHelp: res.code === 'MODEL' } : {}) };
      BF.ui.log(res.message, 'error');
      renderRun();
      renderResults();
      return;
    }
    state.job = { id: res.jobId, projectId: project.id };
    const queued = state.early.splice(0);
    for (const item of queued) handleEvent(item.type, item.payload);
    renderRun();
  }

  async function cancel() {
    if (!state.job) return;
    await BF.api('analysis:cancel', { jobId: state.job.id });
  }

  function finish() {
    state.running = false;
    state.job = null;
    state.progress = null;
    state.stages = null;
  }

  function onProgress(ev) {
    if (typeof ev.stageP === 'number' && ev.stage) {
      const sp = Math.min(1, Math.max(0, ev.stageP));
      const stages = state.stages || {};
      if (!stages[ev.stage]) {
        // etapa nova: as que já estavam no fim saem da conta (a última atualização delas pode ter parado em 99%)
        for (const [name, s] of Object.entries(stages)) if (s.p >= 0.9) delete stages[name];
        stages[ev.stage] = { startedAt: Date.now(), p0: sp, p: sp };
      } else stages[ev.stage].p = Math.max(stages[ev.stage].p, sp);
      state.stages = stages;
    }
    state.progress = { p: ev.p, message: ev.message, phase: ev.phase || null };
    renderRun();
  }

  function onDone({ result }) {
    const sameProject = BF.state.project && state.job && BF.state.project.id === state.job.projectId;
    finish();
    if (!sameProject) { renderRun(); return; }
    BF.project.update((project) => {
      project.analysis = project.analysis || {};
      // o perfil de humor do canal (humor) fica nas Preferências: o projeto guarda os parâmetros desta execução SEM as listas dele
      const usedParams = { ...(result.params || {}) };
      delete usedParams.humor;
      project.analysis.lastRun = { at: result.at, signals: result.usedSignals, params: usedParams, count: result.suggestions.length };
      project.ext = project.ext || {};
      const previous = project.ext.analysis || {};
      project.ext.analysis = {
        ...previous,
        // identidade da fonte: o resultado só vale para este vídeo (ver sameSource); descartadas de outro vídeo não valem aqui
        source: { path: project.source.path, size: project.source.size || 0, duration: project.source.duration || 0 },
        dismissed: sameSource(previous.source, project.source) ? dismissedOf(previous) : [],
        runAt: result.at,
        fromCache: result.fromCache,
        tookMs: result.tookMs,
        limit: result.limit,
        engine: usesAi(result.engine) ? result.engine : 'algorithm',
        ai: usesAi(result.engine) && result.ai ? compactAi(result.ai) : undefined,
        // Algoritmo + IA: o que a IA conferiu das sugestões do algoritmo e o que tirou (some quando a análise não teve conferência)
        review: result.engine === 'both' && result.review ? compactReview(result.review) : undefined,
        // Algoritmo + IA: quantas sugestões os dois acharam, só a IA e só o algoritmo (e se uma parte falhou)
        ...(result.merge ? { merge: { both: result.merge.both || 0, ai: result.merge.ai || 0, algorithm: result.merge.algorithm || 0, ...(result.merge.aiFailed ? { aiFailed: true } : {}), ...(result.merge.algorithmFailed ? { algorithmFailed: true } : {}) } } : {}),
        signals: result.signals,
        warnings: result.warnings,
        // episódios e telas de espera achados (só o algoritmo acha; vazio quando a live não tem espera ou a opção está desligada)
        episodes: Array.isArray(result.episodes) ? result.episodes.map((e) => ({ start: e.start, end: e.end })) : [],
        breaks: Array.isArray(result.breaks) ? result.breaks.map((b) => ({ start: b.start, end: b.end })) : [],
        // o filtro de ideias fracas: se valeu nesta análise e quantas descartou (a lista completa fica no resultado, não no projeto)
        ...(result.filter ? { filter: { on: Boolean(result.filter.on), discarded: Number(result.filter.discarded) || 0 } } : {}),
        suggestions: result.suggestions.map((s) => ({
          id: s.id, start: s.start, end: s.end, peak: s.peak, relevance: s.relevance, reasons: s.reasons,
          ...(Number.isInteger(s.episode) ? { episode: s.episode } : {}),
          ...(Array.isArray(s.engines) && s.engines.length ? { engines: s.engines.filter((e) => e === 'algorithm' || e === 'ai') } : {}),
          ...(s.review === 'ai' ? { review: 'ai' } : {}),
          ...(s.reviewFrom && Number.isFinite(s.reviewFrom.start) && Number.isFinite(s.reviewFrom.end) ? { reviewFrom: { start: s.reviewFrom.start, end: s.reviewFrom.end } } : {}),
          ...(s.title ? { title: s.title } : {}), ...(s.category ? { category: s.category } : {}),
          ...(s.layout ? { layout: s.layout } : {}), ...(Array.isArray(s.flags) && s.flags.length ? { flags: s.flags } : {}),
          ...(s.theme ? { theme: s.theme } : {}), ...(Array.isArray(s.keywords) && s.keywords.length ? { keywords: s.keywords } : {})
        }))
      };
    }, { reason: 'analysis:result' });
    const shown = visible().length;
    BF.ui.log(`Análise concluída: ${result.suggestions.length} sugestão(ões)${shown !== result.suggestions.length ? `, ${shown} nova(s)` : ''}. Sugestão não é garantia: revise.`, 'ok');
    BF.ui.refreshTabs();
    renderRun();
    showStep('results'); // a análise terminou: o resultado é o que a pessoa quer ver
    renderResults();
  }

  function onFailed({ code, message }) {
    finish();
    const wasAi = usesAi(state.lastEngine);
    state.notice = code === 'CANCELLED' ? { kind: 'info', text: 'Análise cancelada. Nada foi alterado no projeto.' } : { kind: 'error', text: message, ...(wasAi ? { fallback: true, modelHelp: code === 'MODEL' } : {}) };
    if (code !== 'CANCELLED') BF.ui.log(message, 'error');
    renderRun();
    renderResults();
  }

  function handleEvent(type, payload) {
    if (!state.job || payload.jobId !== state.job.id) {
      if (state.starting) state.early.push({ type, payload }); // chegou antes da resposta de start
      return;
    }
    if (type === 'progress') onProgress(payload);
    else if (type === 'done') onDone(payload);
    else if (type === 'failed') onFailed(payload);
  }

  BF.on('analysis:progress', (ev) => handleEvent('progress', ev));

  BF.on('analysis:done', (ev) => handleEvent('done', ev));

  BF.on('analysis:failed', (ev) => handleEvent('failed', ev));

  function renderAll() {
    renderEngine();
    renderAi();
    renderHumor();
    renderRun();
    renderSteps();
  }

  function buildRoot() {
    const ui = state.ui;
    ui.run = el('button', { type: 'button', id: 'anRun', class: 'primary', onclick: () => run() }, 'Analisar');
    ui.cancel = el('button', { type: 'button', id: 'anCancel', class: 'secondary', hidden: true, onclick: cancel }, 'Cancelar');
    ui.progress = el('progress', { max: '1', value: '0', 'aria-label': 'Progresso da análise' });
    ui.progressText = el('span', { class: 'muted small', id: 'anProgressText', 'aria-live': 'off' });
    ui.progressBox = el('div', { class: 'an-progress', hidden: true }, ui.progress, ui.progressText);
    ui.ffmpegWarn = el('p', { class: 'an-note an-warn', hidden: true, id: 'anFfmpegWarn' }, 'FFmpeg não encontrado: instale-o pela aba Ferramentas e use "Verificar de novo" para poder analisar.');
    ui.signalWarn = el('p', { class: 'an-note an-warn', hidden: true, id: 'anSignalWarn' }, 'Nenhum sinal utilizável: ligue ao menos um sinal que este vídeo tenha (áudio, imagem ou chat baixado na aba Novo projeto) para poder analisar.');
    ui.aiWarn = el('p', { class: 'an-note an-warn', hidden: true, id: 'anAiWarn' });
    ui.longWarn = el('p', { class: 'an-note an-info small', hidden: true, id: 'anLongWarn' }, 'Vídeo longo: analisar a imagem pode levar vários minutos. O modo rápido (em Ajustes avançados) é bem mais ágil e mais grosseiro.');
    ui.notice = el('div', { class: 'an-notices', id: 'anNotice', role: 'status' });
    ui.runArea = el('div', { class: 'an-run-area' },
      el('div', { class: 'an-runbar' }, ui.run, ui.cancel),
      ui.progressBox,
      ui.signalWarn,
      ui.aiWarn,
      ui.longWarn,
      ui.ffmpegWarn);
    ui.controlsRoot = buildControls();
    buildEngine();
    buildAi();
    buildManual();
    buildHumor();

    ui.summary = el('p', { class: 'an-summary muted small', id: 'anSummary' });
    ui.models = el('p', { class: 'an-models muted small', id: 'anModels', hidden: true });
    ui.addAll = el('button', { type: 'button', id: 'anAddAll', class: 'primary sm', hidden: true, onclick: addAll }, 'Adicionar todas');
    ui.dismissAll = el('button', { type: 'button', id: 'anDismissAll', class: 'sm', hidden: true, onclick: dismissAll }, 'Descartar todas');
    ui.orderTime = el('option', { value: 'time' }, 'Ordem do vídeo');
    ui.order = el('select', { id: 'anOrder', onchange: () => setListOrder(ui.order.value) },
      el('option', { value: 'relevance' }, 'Mais relevantes primeiro'), ui.orderTime);
    ui.orderBox = el('label', { class: 'an-order', for: 'anOrder', hidden: true }, el('span', { class: 'muted small' }, 'Ordem'), ui.order);
    ui.empty = el('p', { id: 'anEmpty' });
    ui.emptyTitle = el('strong', {}, 'Nenhuma sugestão');
    ui.emptyBox = el('div', { class: 'empty-state an-empty' },
      el('span', { class: 'empty-state-icon material-symbols-rounded', 'aria-hidden': 'true' }, 'insights'),
      el('div', { class: 'empty-state-text' }, ui.emptyTitle, ui.empty));
    ui.list = el('ol', { class: 'an-list', id: 'anList' });
    // descartadas: recolhidas; só aparecem quando há alguma
    ui.dismissedTitle = el('summary', {}, 'Descartadas');
    ui.restoreAll = el('button', { type: 'button', id: 'anRestoreAll', class: 'sm', hidden: true, onclick: restoreAll }, 'Restaurar todas');
    ui.dismissedList = el('ol', { class: 'an-list', id: 'anDismissedList' });
    ui.dismissedBox = el('details', { class: 'an-dismissed', id: 'anDismissed', hidden: true }, ui.dismissedTitle,
      el('p', { class: 'muted small' }, 'Sugestões que você descartou. Elas não viram corte e não voltam em novas análises deste vídeo, a menos que você as restaure.'),
      ui.dismissedList, ui.restoreAll);
    ui.aiDropTitle = el('summary', {}, 'Descartadas na conferência');
    ui.aiDropList = el('ul', { class: 'an-droplist' });
    ui.aiDropBox = el('details', { class: 'an-dismissed', id: 'anAiDrops', hidden: true }, ui.aiDropTitle,
      el('p', { class: 'muted small' }, 'Sugestões da IA que a conferência local recusou (horário fora do vídeo, desfecho que não existe na transcrição, corte repetido…). Nada disso virou sugestão.'),
      ui.aiDropList);
    ui.aiUnpickedTitle = el('summary', {}, 'Fora da escolha final da IA');
    ui.aiUnpickedList = el('ul', { class: 'an-droplist' });
    ui.aiUnpickedBox = el('details', { class: 'an-dismissed', id: 'anAiUnpicked', hidden: true }, ui.aiUnpickedTitle,
      el('p', { class: 'muted small' }, 'Momentos que a IA achou nos blocos e que passaram na conferência, mas que ela mesma deixou de fora ao escolher os melhores. Não viraram sugestão.'),
      ui.aiUnpickedList);
    ui.aiReviewTitle = el('summary', {}, 'Sugestões do algoritmo que a IA tirou');
    ui.aiReviewList = el('ul', { class: 'an-droplist' });
    ui.aiReviewBox = el('details', { class: 'an-dismissed', id: 'anAiReviewDrops', hidden: true }, ui.aiReviewTitle,
      el('p', { class: 'muted small' }, 'Sugestões que só o algoritmo achou e que a IA, lendo a fala do trecho, disse que não valem um corte. Não estão na lista. Para vê-las, desligue "IA confere o algoritmo" e analise de novo.'),
      ui.aiReviewList);
    ui.results = el('section', { class: 'an-results', id: 'anResults', 'aria-label': 'Sugestões', hidden: true },
      el('div', { class: 'an-results-head' }, el('h3', { class: 'panel-title' }, 'Sugestões'), el('div', { class: 'an-bulk' }, ui.addAll, ui.dismissAll)),
      ui.summary, ui.models, ui.emptyBox, ui.orderBox, ui.list, ui.dismissedBox, ui.aiDropBox, ui.aiUnpickedBox, ui.aiReviewBox);

    ui.intro = el('p', { class: 'muted small an-intro', id: 'anIntro' });
    // quatro passos (steps.js): só o escolhido aparece; o botão Analisar (rodapé fixo) vale em qualquer um
    const stepsUi = buildSteps({
      transcript: [ui.tCard],
      method: [ui.engineBar, ui.aiRoot, ui.mCard],
      settings: [ui.controlsRoot, el('h3', { class: 'panel-title an-style-title' }, 'Estilo do canal'), ui.hCard, ui.skillBox],
      results: [ui.results]
    });
    ui.steps.addEventListener('keydown', onStepKey);
    return el('div', { class: 'an', id: 'analysis' },
      ui.intro,
      el('section', { class: 'panel an-setup' }, stepsUi.nav, ui.notice, ...stepsUi.sections, ui.runArea));
  }

  // ---------- partes (features/analysis/*.js): cada uma recebe `A` e devolve o que oferece ----------
  const P = window.BFAnalysisParts;
  const A = {
    state,
    field: (...args) => field(...args),
    switchRow: (...args) => switchRow(...args),
    refreshEstimate: (...args) => refreshEstimate(...args),
    engineChoice: (...args) => engineChoice(...args),
    humorProfile: (...args) => humorProfile(...args),
    ensureConsent: (...args) => ensureConsent(...args),
    icon: (...args) => icon(...args),
    generateTranscript: (...args) => generateTranscript(...args),
    cancelTranscript: (...args) => cancelTranscript(...args),
    installTranscription: (...args) => installTranscription(...args),
    importTranscript: (...args) => importTranscript(...args),
    removeTranscript: (...args) => removeTranscript(...args),
    renderTranscript: (...args) => renderTranscript(...args),
    showStep: (...args) => showStep(...args),
    renderSteps: (...args) => renderSteps(...args),
    aiPayload: (...args) => aiPayload(...args),
    copyTranscript: (...args) => copyTranscript(...args),
    renderManual: (...args) => renderManual(...args),
    renderAll: (...args) => renderAll(...args),
    settings: (...args) => settings(...args),
    saveSettings: (...args) => saveSettings(...args),
    run: (...args) => run(...args),
    readControls: (...args) => readControls(...args),
    renderNotice: (...args) => renderNotice(...args),
    renderResults: (...args) => renderResults(...args),
    current: (...args) => current(...args),
    aiBlockers: (...args) => aiBlockers(...args),
    prefValues: (...args) => prefValues(...args),
    limitedPrefs: (...args) => limitedPrefs(...args),
    openModelList: (...args) => openModelList(...args),
    renderSkill: (...args) => renderSkill(...args),
    useAlgorithm: (...args) => useAlgorithm(...args),
    renderHumor: (...args) => renderHumor(...args),
    dismissedOf: (...args) => dismissedOf(...args),
    visible: (...args) => visible(...args),
    listOrder: (...args) => listOrder(...args),
    inViewOrder: (...args) => inViewOrder(...args),
    addSuggestions: (...args) => addSuggestions(...args),
    dismissSuggestions: (...args) => dismissSuggestions(...args),
    restoreSuggestions: (...args) => restoreSuggestions(...args)
  };
  const { HUMOR_KEY, humorProfile, humorLists, buildHumor, renderHumor, refreshHumorExamples } = P.humor(A);
  const { refreshTranscript, generateTranscript, cancelTranscript, installTranscription, importTranscript, removeTranscript, useAlgorithm, buildEngine, renderEngine, renderTranscript } = P.engine(A);
  const { buildManual, renderManual, copyTranscript } = P.manual(A);
  const { buildSteps, renderSteps, showStep, onStepKey } = P.steps(A);
  const { renderResults: renderResultsList, setListOrder, addAll, dismissAll, restoreAll } = P.results(A);
  /** A lista de sugestões e o seletor de passos (a contagem do selo) se atualizam juntos. */
  function renderResults() {
    renderResultsList();
    renderSteps();
  }
  const { scheduleResults, icon, field, switchRow, buildControls, fillControls, readControls, usableSignals, renderHints, renderRun, renderNotice } = P.controls(A);
  const { refreshAi, refreshEstimate, openModelList, renderSkill, buildAi, renderAi } = P.provider(A);

  // ---------- integração com o app ----------
  function syncFromProject() {
    if (!state.ui.run) return;
    fillControls();
    renderAll();
    renderResults();
  }

  /** Estado que vem do processo principal (provedor de IA e transcrição): consultado ao abrir a aba e ao trocar de vídeo. */
  function refreshRemote() {
    refreshAi();
    refreshTranscript();
  }

  async function resumeIfRunning() {
    const res = await BF.api('analysis:status');
    if (!res.ok || !res.running || !BF.state.project) return;
    if (BF.state.project.source.path !== res.running.path) return;
    state.job = { id: res.running.jobId, projectId: BF.state.project.id };
    state.lastEngine = usesAi(res.running.engine) ? res.running.engine : 'algorithm';
    state.running = true;
    state.startedAt = Number(res.running.startedAt) || 0; // sem a hora de início real a estimativa de tempo restante sairia absurda
    state.progress = { p: res.running.p, message: res.running.message || 'Analisando…' };
    renderRun();
  }

  BF.ui.registerTab({
    id: 'analysis',
    title: 'Análise',
    order: 60,
    badge: () => (state.running ? '…' : visible().length || ''),
    render(container) {
      container.append(buildRoot());
      syncFromProject();
      BF.api('analysis:defaults').then((res) => {
        if (res.ok) { state.defaults = res; syncFromProject(); }
      });
      refreshRemote();
    },
    onShow() {
      syncFromProject();
      if (!state.running) resumeIfRunning();
      refreshRemote();
    }
  });

  BF.bus.on('project:loaded', () => {
    if (state.running && !(state.job && BF.state.project && BF.state.project.id === state.job.projectId)) finish();
    state.notice = null;
    state.tjob = null;
    state.transcript = null;
    state.estimate = null;
    state.hDirty = false; // o rascunho do perfil de humor era do vídeo anterior
    state.hExamples = null;
    syncFromProject();
    BF.ui.refreshTabs();
    if (state.ui.run) {
      refreshRemote();
      if (state.ui.hExamplesBox && state.ui.hExamplesBox.open) refreshHumorExamples();
    }
  });

  BF.bus.on('cuts:changed', scheduleResults);

  BF.bus.on('project:changed', (ev) => { if (!ev || ev.reason !== 'analysis:settings') scheduleResults(); });

  BF.bus.on('tools:changed', () => { renderRun(); refreshTranscript(); });
  BF.bus.on('transcription:changed', () => refreshTranscript()); // um modelo (ou o motor) foi instalado ou removido pelo cartão da aba Ferramentas

  // Preferências de análise (margens, durações, relevância mínima, palavras-chave) mudaram: a tela mostra os valores novos
  // (a execução sempre lê as preferências na hora, em prefValues). Se o usuário está digitando num ajuste, só a nota é atualizada.
  BF.bus.on('prefs:changed', ({ keys } = {}) => {
    if (!state.ui.run) return;
    if (Array.isArray(keys) && !keys.some((k) => String(k).startsWith('analysis.'))) return;
    const typing = state.ui.controlsRoot && state.ui.controlsRoot.contains(document.activeElement);
    if (typing) renderHints(); else fillControls();
    // o perfil de humor mudou (salvo aqui, em Preferências ou ao trocar de canal): a tela e a estimativa acompanham
    if (!Array.isArray(keys) || keys.includes(HUMOR_KEY)) {
      renderHumor();
      refreshEstimate();
      if (state.ui.hExamplesBox && state.ui.hExamplesBox.open) refreshHumorExamples();
    }
  });

  BF.ready.then(() => renderAll());

  // abrir outro vídeo com a análise rodando: pergunta antes (cancelar é o caminho seguro)
  BF.hooks.add('beforeOpen', async () => {
    if (!state.running) return true;
    const ok = await BF.ui.confirm({
      title: 'Análise em andamento',
      message: 'Uma análise está rodando para o vídeo atual. Abrir outro vídeo cancela a análise.',
      okLabel: 'Cancelar a análise e abrir',
      cancelLabel: 'Continuar analisando'
    });
    if (!ok) return false;
    await cancel();
    return true;
  });

  /**
   * Para o MCP (src/mcp, renderer/features/mcp.js): roda a análise SÓ com o algoritmo local (nada vai para fora do computador, mesmo que o usuário tenha uma IA
   * configurada). Resolve { ok } quando começou, ou { ok:false, reason } em português.
   */
  async function runLocal() {
    if (!BF.state.project) return { ok: false, reason: 'Nenhum projeto aberto.' };
    if (state.running || state.starting) return { ok: false, reason: 'Já existe uma análise em andamento.' };
    if (!state.ui.run) { BF.ui.selectTab('analysis'); await new Promise((resolve) => setTimeout(resolve, 0)); } // a aba ainda não foi desenhada: os controles são dela
    if (!usableSignals().length) return { ok: false, reason: 'Este vídeo não tem sinal para analisar (sem áudio, imagem ou chat utilizáveis).' };
    await run({ engine: 'algorithm' });
    return state.running || state.starting ? { ok: true } : { ok: false, reason: (state.notice && state.notice.text) || 'A análise não começou.' };
  }

  /** O andamento da análise do projeto aberto e as sugestões que ainda não viraram corte (para o MCP). */
  function mcpState() {
    const project = BF.state.project;
    if (!project) return null;
    const saved = current();
    return {
      running: Boolean(state.running || state.starting),
      progress: state.progress ? { p: state.progress.p, message: state.progress.message } : null,
      lastRunAt: saved && saved.runAt ? saved.runAt : null,
      suggestions: visible()
    };
  }

  BF.analysis = { runLocal, mcpState, engineChoice, isCovered, pendingSuggestions, dismissedSuggestions, sameSource, remainingSec, stageRemainingSec, clock, addSuggestions, dismissSuggestions, restoreSuggestions, splitKeywords, humorProfile };
})();

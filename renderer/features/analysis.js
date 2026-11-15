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
  const H = window.BFHumor;

  // ---------- funções puras (também expostas em BF.analysis para teste) ----------

  const SIGNALS = [
    { id: 'audio', label: 'Áudio', hint: 'volume acima do normal de fala' },
    { id: 'image', label: 'Imagem', hint: 'mudanças de cena e movimento' },
    { id: 'chat', label: 'Chat', hint: 'velocidade das mensagens e palavras-chave' },
    { id: 'text', label: 'Texto', hint: 'risadas, exclamações, ritmo de fala e repetição na transcrição' },
    { id: 'calm', label: 'Momentos calmos', hint: 'trechos tranquilos, sem fala e sem pico, onde o jogo e o som seguem (construir, explorar, cenas de história); têm cota própria, além da Quantidade' }
  ];
  /** Pistas da transcrição e o peso de cada uma (Ajustes avançados; 0 desliga a pista). */
  const TEXT_WEIGHTS = [
    { id: 'laugh', label: 'Risadas' },
    { id: 'exclaim', label: 'Exclamações' },
    { id: 'pace', label: 'Ritmo de fala' },
    { id: 'repeat', label: 'Repetição' },
    { id: 'meta', label: 'Sobre o momento' },
    { id: 'humor', label: 'Expressões do canal' },
    { id: 'structure', label: 'Estrutura (conversa)' }
  ];
  /** Tipo de vídeo (perfil da análise, params.js): muda como as pistas são lidas. */
  const PROFILES = [
    { id: 'gameplay', label: 'Gameplay ou live de jogo', hint: 'Exclamações, risadas, bordões e mudanças de cena na tela.' },
    { id: 'conversa', label: 'Conversa ou podcast', hint: 'Bordões e laços ("obrigado você"), conselhos e histórias; ignora as trocas de câmera e corta em frase completa, com 30 a 75 s.' }
  ];
  const SENSITIVITY_LABELS = ['muito baixa', 'baixa', 'média', 'alta', 'muito alta'];

  function overlapSec(a0, a1, b0, b1) {
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  }

  /**
   * A sugestão já está coberta por algum corte (de qualquer status, inclusive rejeitado)? Sim se o pico cai
   * dentro do corte, se a sobreposição passa de 20% da sugestão ou de 50% do menor dos dois.
   */
  function isCovered(suggestion, cuts) {
    const len = Math.max(0.001, suggestion.end - suggestion.start);
    for (const cut of cuts || []) {
      if (typeof cut.start !== 'number' || typeof cut.end !== 'number') continue;
      const ov = overlapSec(suggestion.start, suggestion.end, cut.start, cut.end);
      if (ov <= 0) continue;
      if (typeof suggestion.peak === 'number' && suggestion.peak >= cut.start && suggestion.peak <= cut.end) return true;
      if (ov / len >= 0.2) return true;
      if (ov / Math.max(0.001, Math.min(len, cut.end - cut.start)) >= 0.5) return true;
    }
    return false;
  }

  /** "1:23" ou "1:02:03". */
  function clock(sec) {
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const two = (v) => String(v).padStart(2, '0');
    return h ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
  }

  /** Estimativa de tempo restante em texto curto. */
  function eta(sec) {
    if (sec < 10) return 'quase pronto';
    if (sec < 90) return `cerca de ${Math.round(sec / 10) * 10} s restantes`;
    return `cerca de ${Math.round(sec / 60)} min restantes`;
  }

  /**
   * Segundos que faltam, pela proporção feita (p, 0..1) e a hora de início (ms). null quando não dá para estimar:
   * sem hora de início conhecida (0 / ausente), início no futuro ou progresso ainda muito baixo (< 5%) / completo.
   */
  function remainingSec(p, startedAt, now = Date.now()) {
    if (!(startedAt > 0) || !(p >= 0.05 && p < 1)) return null;
    const elapsed = (now - startedAt) / 1000;
    return elapsed > 0 ? (elapsed * (1 - p)) / p : null;
  }

  const pct = (rel) => `${Math.round((rel || 0) * 100)}%`;
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : fallback));

  /**
   * Sugestões ainda por revisar: as que não estão cobertas por nenhum corte nem por uma sugestão descartada
   * (`dismissed` = [{ start, end, peak }], tratadas como cortes só para essa comparação), da mais relevante para a menos.
   */
  function pendingSuggestions(saved, cuts, dismissed) {
    return (saved || []).filter((s) => !isCovered(s, cuts) && !isCovered(s, dismissed)).sort((a, b) => b.relevance - a.relevance);
  }

  /** Sugestões descartadas que a análise guardada ainda traz (e que não viraram corte), da mais relevante para a menos. */
  function dismissedSuggestions(saved, cuts, dismissed) {
    return (saved || []).filter((s) => !isCovered(s, cuts) && isCovered(s, dismissed)).sort((a, b) => b.relevance - a.relevance);
  }

  /**
   * O resultado guardado foi calculado para ESTA fonte? `saved` = ext.analysis.source ({ path, size, duration }, gravado junto do
   * resultado). O `project:adopt` copia o `ext` inteiro para o vídeo novo; sem esta conferência as sugestões do vídeo antigo
   * apareceriam como se fossem do novo. Sem identidade gravada (resultado de uma versão antiga), não vale.
   */
  function sameSource(saved, source) {
    if (!saved || !source || !saved.path || !source.path) return false;
    const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
    if (norm(saved.path) !== norm(source.path)) return false;
    if (saved.size > 0 && source.size > 0 && saved.size !== source.size) return false;
    if (saved.duration > 0 && source.duration > 0 && Math.abs(saved.duration - source.duration) > 1) return false;
    return true;
  }

  const MAX_DISMISSED = 300;

  const ENGINES = [
    { id: 'algorithm', label: 'Algoritmo', hint: 'regras simples sobre áudio, imagem, chat e a transcrição; roda neste computador' },
    { id: 'ai', label: 'IA na nuvem', hint: 'lê a transcrição e escolhe os melhores momentos' }
  ];

  /** Duração em texto curto: 3:04:10 (ou 4:10). */
  const hms = (sec) => clock(sec);

  /** "1 chamada", "7 chamadas". */
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function splitKeywords(text) {
    return String(text).split(/[,;\n]/).map((w) => w.trim()).filter(Boolean);
  }

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
    ui: {}, // nós principais
    ai: null, // estado da IA (analysis:aiState): provedor, modelo, chave guardada?, aceite… NUNCA traz a chave
    transcript: null, // resumo da transcrição do vídeo (analysis:transcriptStatus)
    tengine: null, // o motor de transcrição (Whisper) está pronto?
    tjob: null, // transcrição em andamento { id, p, message, doneUntil }
    tstarting: false,
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
      textWeights: { ...base.textWeights, ...(saved.textWeights || {}) },
      chat: { ...base.chat, ...(saved.chat || {}), keywords: Array.isArray(saved.chat && saved.chat.keywords) ? saved.chat.keywords : base.chat.keywords },
      image: { ...base.image, ...(saved.image || {}) },
      engine: saved.engine === 'ai' || saved.engine === 'algorithm' ? saved.engine : null // null = escolha automática (veja engineChoice)
    };
  }

  /**
   * Motor em uso. A escolha do usuário vale; sem escolha: IA se há provedor configurado COM o aviso de privacidade aceito, senão o
   * algoritmo (que roda sem nada configurado e sem enviar nada para fora).
   */
  function engineChoice() {
    const saved = settings().engine;
    if (saved) return saved;
    return state.ai && state.ai.ready && state.ai.accepted ? 'ai' : 'algorithm';
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

  // ---------- perfil de humor do canal ----------

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

  /** "critérios · 2 bordões · 3 palavras de reação". */
  function humorSummary(profile) {
    const bits = [];
    if (profile.criteria) bits.push('critérios');
    if (profile.catchphrases.length) bits.push(plural(profile.catchphrases.length, 'bordão', 'bordões'));
    if (profile.reactions.length) bits.push(plural(profile.reactions.length, 'palavra de reação', 'palavras de reação'));
    if (profile.themes.length) bits.push(plural(profile.themes.length, 'tema', 'temas'));
    return bits.join(' · ');
  }

  /** O que foi enviado à IA do perfil (contagens guardadas no resultado): "critérios · 2 bordões · 3 exemplos aprovados e 1 rejeitado". */
  function humorSentText(sent) {
    const bits = [];
    if (sent.criteria) bits.push('critérios');
    if (sent.catchphrases) bits.push(plural(sent.catchphrases, 'bordão', 'bordões'));
    if (sent.reactions) bits.push(plural(sent.reactions, 'palavra de reação', 'palavras de reação'));
    if (sent.themes) bits.push(plural(sent.themes, 'tema', 'temas'));
    const ex = sent.examples || {};
    if (ex.approved || ex.rejected) bits.push(`${plural(ex.approved || 0, 'exemplo aprovado', 'exemplos aprovados')} e ${plural(ex.rejected || 0, 'rejeitado', 'rejeitados')}`);
    return bits.join(' · ');
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
  async function ensureConsent() {
    if (state.ai && state.ai.accepted) return true;
    if (!state.ai || !state.ai.provider) return false;
    const p = state.ai.provider;
    const where = p.source === 'host'
      ? `o provedor configurado no ${p.hostName || 'aplicativo'} (${p.label}${p.model ? `, ${p.model}` : ''})`
      : `${p.label}${p.host ? ` (${p.host})` : ''}`;
    const custom = p.id === 'custom';
    const ok = await BF.ui.confirm({
      title: 'Enviar trechos para a IA?',
      message: [
        'A IA vai receber trechos da transcrição deste vídeo, as mensagens do chat do mesmo período e o título, o canal e o jogo. O vídeo e o áudio nunca saem do seu computador.',
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
    const res = await BF.api('analysis:aiAccept', { accepted: true });
    if (!res.ok || !res.ai) { BF.ui.toast(res.message || 'Não foi possível guardar o aceite.', 'error'); return false; }
    state.ai = res.ai;
    renderAll();
    return true;
  }

  /** O que a análise por IA manda ao processo principal (a chave nunca passa por aqui: quem a guarda é o processo principal). */
  function aiPayload(project, chosen) {
    const origin = project.source.origin || {};
    const profile = humorProfile(); // perfil de humor do canal (critérios, listas e a opção de exemplos); o processo principal escolhe os exemplos
    return {
      engine: 'ai',
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
    if (!project || state.running || state.starting) return;
    if (useEngine === 'ai' ? !aiBlockers().ok : !usableSignals().length) return;
    const chosen = readControls();
    if (useEngine === 'ai' && !(await ensureConsent())) return;
    saveSettings(chosen);
    state.notice = null;
    state.starting = true;
    state.running = true;
    state.startedAt = Date.now();
    state.lastEngine = useEngine;
    state.progress = { p: 0, message: 'Preparando…' };
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
    }
    const res = await BF.api('analysis:start', payload);
    state.starting = false;
    if (!res.ok) {
      state.running = false;
      state.progress = null;
      state.notice = { kind: 'error', text: res.message, ...(useEngine === 'ai' ? { fallback: true } : {}) };
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
  }

  function onProgress(ev) {
    state.progress = { p: ev.p, message: ev.message };
    renderRun();
  }

  /** O que fica no projeto da execução por IA: contagens e os descartes (sem texto da transcrição). */
  function compactAi(ai) {
    return {
      provider: ai.provider, model: ai.model, blocks: ai.blocks, failedBlocks: ai.failedBlocks, calls: ai.calls, retries: ai.retries,
      promptTokens: ai.promptTokens, completionTokens: ai.completionTokens, pickUsed: ai.pickUsed, droppedTotal: ai.droppedTotal,
      ...(ai.models && typeof ai.models === 'object' ? { models: ai.models } : {}), // quem de fato respondeu: { modelo: chamadas }
      ...(ai.profile && typeof ai.profile === 'object' ? { profile: ai.profile } : {}), // só contagens do perfil de humor enviado (o texto não fica no projeto)
      droppedByReason: ai.droppedByReason, dropped: Array.isArray(ai.dropped) ? ai.dropped.slice(0, 25).map((d) => ({ reason: d.reason, detail: d.detail, start: d.start, end: d.end, title: d.title })) : []
    };
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
        engine: result.engine === 'ai' ? 'ai' : 'algorithm',
        ai: result.engine === 'ai' && result.ai ? compactAi(result.ai) : undefined,
        signals: result.signals,
        warnings: result.warnings,
        // episódios e telas de espera achados (só o algoritmo acha; vazio quando a live não tem espera ou a opção está desligada)
        episodes: Array.isArray(result.episodes) ? result.episodes.map((e) => ({ start: e.start, end: e.end })) : [],
        breaks: Array.isArray(result.breaks) ? result.breaks.map((b) => ({ start: b.start, end: b.end })) : [],
        suggestions: result.suggestions.map((s) => ({
          id: s.id, start: s.start, end: s.end, peak: s.peak, relevance: s.relevance, reasons: s.reasons,
          ...(Number.isInteger(s.episode) ? { episode: s.episode } : {}),
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
    renderResults();
  }

  function onFailed({ code, message }) {
    finish();
    const wasAi = state.lastEngine === 'ai';
    state.notice = code === 'CANCELLED' ? { kind: 'info', text: 'Análise cancelada. Nada foi alterado no projeto.' } : { kind: 'error', text: message, ...(wasAi ? { fallback: true } : {}) };
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

  // ---------- desenho ----------

  // Redesenha uma vez só por rajada de eventos. Com timer (e não requestAnimationFrame): numa janela escondida ou coberta por outra o
  // navegador suspende o requestAnimationFrame e a lista ficaria desatualizada até a janela reaparecer.
  let renderQueued = false;
  function scheduleResults() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => { renderQueued = false; renderResults(); renderHints(); BF.ui.refreshTabs(); }, 0);
  }

  const icon = (name) => el('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true' }, name);

  function field(label, input, hint, wide) {
    return el('label', { class: `an-field${wide ? ' an-field-wide' : ''}` }, el('span', { class: 'an-field-label' }, label), input, hint ? el('span', { class: 'muted small' }, hint) : null);
  }

  /** Linha com título, explicação curta e interruptor (o <input> é o próprio .bds-switch). */
  function switchRow(className, forId, title, hintNode, input) {
    return el('label', { class: className, for: forId },
      el('span', { class: 'an-signal-text' }, el('strong', {}, title), hintNode),
      input);
  }

  function buildControls() {
    const ui = state.ui;
    ui.signalBoxes = {};
    ui.signalHints = {};
    const signalRows = SIGNALS.map((sig) => {
      const box = el('input', { type: 'checkbox', id: `anSignal-${sig.id}`, class: 'bds-switch', role: 'switch', dataset: { signal: sig.id }, onchange: onControlChange });
      const hint = el('span', { class: 'an-signal-hint small', id: `anHint-${sig.id}` });
      ui.signalBoxes[sig.id] = box;
      ui.signalHints[sig.id] = hint;
      return switchRow('an-signal', `anSignal-${sig.id}`, sig.label, hint, box);
    });

    ui.profile = el('select', { id: 'anProfile', onchange: onControlChange },
      PROFILES.map((p) => el('option', { value: p.id }, p.label)));
    ui.profileHint = el('span', { class: 'muted small', id: 'anProfileHint' });
    // live com vários programas (segments.js): a tela de espera fica fora e cada episódio ganha pelo menos uma sugestão
    ui.episodes = el('input', { type: 'checkbox', id: 'anEpisodes', class: 'bds-switch', role: 'switch', onchange: onControlChange });
    ui.sensitivity = el('input', { type: 'range', id: 'anSensitivity', min: '1', max: '5', step: '1', onchange: onControlChange, oninput: syncOutputs });
    ui.sensitivityOut = el('output', { for: 'anSensitivity', class: 'an-out' });
    ui.perHour = el('input', { type: 'range', id: 'anPerHour', min: '1', max: '20', step: '1', onchange: onControlChange, oninput: syncOutputs });
    ui.perHourOut = el('output', { for: 'anPerHour', class: 'an-out' });

    ui.weights = {};
    const weightFields = SIGNALS.map((sig) => {
      const input = el('input', { type: 'number', id: `anWeight-${sig.id}`, min: '0', max: '2', step: '0.1', onchange: onControlChange });
      ui.weights[sig.id] = input;
      return field(sig.label, input);
    });
    ui.textWeights = {};
    const textWeightFields = TEXT_WEIGHTS.map((feat) => {
      const input = el('input', { type: 'number', id: `anTextWeight-${feat.id}`, min: '0', max: '2', step: '0.1', onchange: onControlChange });
      ui.textWeights[feat.id] = input;
      return field(feat.label, input);
    });
    ui.keywords = el('input', { type: 'text', id: 'anKeywords', placeholder: 'clip, pog, omg…', onchange: onControlChange });
    ui.lag = el('input', { type: 'number', id: 'anChatLag', min: '0', max: '60', step: '1', onchange: onControlChange });
    ui.win = el('input', { type: 'number', id: 'anChatWindow', min: '2', max: '60', step: '1', onchange: onControlChange });
    ui.fast = el('input', { type: 'checkbox', id: 'anImageFast', class: 'bds-switch', role: 'switch', onchange: onControlChange });
    ui.prefsNote = el('p', { class: 'an-prefs muted small', id: 'anPrefsNote' });
    ui.reset = el('button', { type: 'button', id: 'anReset', class: 'sm', onclick: resetSettings }, 'Restaurar padrões');
    ui.fresh = el('button', { type: 'button', id: 'anFresh', class: 'secondary sm', onclick: () => run({ fresh: true }) }, 'Analisar de novo, sem usar o guardado');
    // ajustes travados enquanto a análise roda (os sinais são tratados em renderHints)
    ui.lockables = [ui.profile, ui.episodes, ui.sensitivity, ui.perHour, ...SIGNALS.map((sig) => ui.weights[sig.id]), ...TEXT_WEIGHTS.map((feat) => ui.textWeights[feat.id]), ui.keywords, ui.lag, ui.win, ui.fast, ui.reset];

    ui.signalsBlock = el('div', { class: 'an-block', id: 'anSignals' },
      el('h3', { class: 'panel-title' }, 'O que procurar'),
      el('label', { class: 'an-field an-profile', for: 'anProfile' }, el('span', { class: 'an-field-label' }, 'Tipo de vídeo'), ui.profile, ui.profileHint),
      switchRow('an-switch-row an-episodes', 'anEpisodes', 'Separar por episódios',
        el('span', { class: 'small', id: 'anEpisodesHint' }, 'Pula as telas de espera ("Voltamos em instantes") e dá pelo menos uma sugestão a cada episódio da live.'), ui.episodes),
      el('div', { class: 'an-signals' }, signalRows));
    ui.sensRow = el('label', { class: 'an-slider', for: 'anSensitivity', id: 'anSensRow' },
      el('span', { class: 'an-slider-head' }, el('span', { class: 'an-slider-label' }, 'Sensibilidade'), ui.sensitivityOut), ui.sensitivity);
    ui.advanced = el('details', { class: 'an-advanced', id: 'anAdvanced' },
        el('summary', {}, 'Ajustes avançados'),
        el('div', { class: 'an-adv-body' },
          el('div', { class: 'an-adv-group' },
            el('h4', { class: 'an-group-title' }, 'Peso de cada sinal'),
            el('div', { class: 'an-adv-grid an-adv-two' }, weightFields)),
          el('div', { class: 'an-adv-group' },
            el('h4', { class: 'an-group-title' }, 'Pistas da transcrição'),
            el('div', { class: 'an-adv-grid' }, textWeightFields),
            el('p', { class: 'muted small' }, 'Cada pista vale de 0 (desliga) a 2. Só contam quando o vídeo tem transcrição. A estrutura só existe no tipo Conversa ou podcast.')),
          el('div', { class: 'an-adv-group' },
            el('h4', { class: 'an-group-title' }, 'Chat'),
            field('Palavras-chave do chat', ui.keywords, 'separadas por vírgula; vazio = não usar', true),
            el('div', { class: 'an-adv-grid an-adv-two' }, field('Atraso (s)', ui.lag), field('Janela (s)', ui.win)),
            el('p', { class: 'muted small' }, 'O atraso conta que o público reage depois do lance.')),
          el('div', { class: 'an-adv-group' },
            el('h4', { class: 'an-group-title' }, 'Imagem'),
            switchRow('an-switch-row', 'anImageFast', 'Modo rápido', el('span', { class: 'small' }, 'Só quadros-chave; mais grosseiro'), ui.fast)),
          ui.prefsNote,
          el('div', { class: 'an-adv-actions' }, ui.reset, ui.fresh),
          el('p', { class: 'muted small' }, 'Analisar de novo lê o vídeo outra vez e ignora o resultado já calculado (útil depois de uma falha).')));
    return el('section', { class: 'an-controls', 'aria-label': 'Ajustes da análise' },
      ui.signalsBlock,
      el('div', { class: 'an-sliders' },
        ui.sensRow,
        el('label', { class: 'an-slider', for: 'anPerHour' },
          el('span', { class: 'an-slider-head' }, el('span', { class: 'an-slider-label' }, 'Quantidade'), ui.perHourOut), ui.perHour)),
      ui.runArea,
      ui.advanced);
  }

  function fillControls() {
    const ui = state.ui;
    const s = settings();
    for (const sig of SIGNALS) ui.signalBoxes[sig.id].checked = Boolean(s.signals[sig.id]);
    ui.profile.value = s.profile;
    ui.profileHint.textContent = (PROFILES.find((p) => p.id === s.profile) || PROFILES[0]).hint;
    ui.episodes.checked = Boolean(s.episodes);
    ui.sensitivity.value = String(s.sensitivity);
    ui.perHour.value = String(s.perHour);
    for (const sig of SIGNALS) ui.weights[sig.id].value = String(s.weights[sig.id]);
    for (const feat of TEXT_WEIGHTS) ui.textWeights[feat.id].value = String(s.textWeights[feat.id]);
    ui.keywords.value = s.chat.keywords.join(', ');
    ui.lag.value = String(s.chat.lagSec);
    ui.win.value = String(s.chat.windowSec);
    ui.fast.checked = Boolean(s.image.fast);
    syncOutputs();
    renderHints();
  }

  function syncOutputs() {
    const ui = state.ui;
    if (!ui.sensitivity) return;
    ui.sensitivityOut.textContent = SENSITIVITY_LABELS[Math.min(4, Math.max(0, Number(ui.sensitivity.value) - 1))];
    const hours = BF.state.info && BF.state.info.duration ? BF.state.info.duration / 3600 : 0;
    const per = Number(ui.perHour.value);
    const total = hours ? Math.min(300, Math.max(3, Math.round(per * hours))) : null;
    ui.perHourOut.textContent = `${per} por hora${total ? ` (até ${total} neste vídeo)` : ''}`;
  }

  function readControls() {
    const ui = state.ui;
    const base = settings();
    return {
      signals: Object.fromEntries(SIGNALS.map((sig) => [sig.id, ui.signalBoxes[sig.id].checked])),
      profile: PROFILES.some((p) => p.id === ui.profile.value) ? ui.profile.value : base.profile,
      episodes: ui.episodes.checked,
      sensitivity: num(ui.sensitivity.value, base.sensitivity),
      perHour: num(ui.perHour.value, base.perHour),
      weights: Object.fromEntries(SIGNALS.map((sig) => [sig.id, Math.min(2, Math.max(0, num(ui.weights[sig.id].value, base.weights[sig.id])))])),
      textWeights: Object.fromEntries(TEXT_WEIGHTS.map((feat) => [feat.id, Math.min(2, Math.max(0, num(ui.textWeights[feat.id].value, base.textWeights[feat.id])))])),
      chat: {
        keywords: splitKeywords(ui.keywords.value),
        lagSec: Math.min(60, Math.max(0, num(ui.lag.value, base.chat.lagSec))),
        windowSec: Math.min(60, Math.max(2, num(ui.win.value, base.chat.windowSec)))
      },
      image: { fast: ui.fast.checked },
      engine: base.engine
    };
  }

  function onControlChange() {
    if (!BF.state.project) return;
    saveSettings(readControls());
    fillControls(); // mostra o valor que vale: um número fora da faixa foi limitado ao gravar e o campo não pode continuar dizendo outro
    renderRun(); // a dica de vídeo longo e o botão Analisar dependem dos ajustes
  }

  function resetSettings() {
    if (!BF.state.project) return;
    BF.project.update((project) => {
      project.ext = project.ext || {};
      const rest = { ...(project.ext.analysis || {}) };
      delete rest.settings;
      project.ext.analysis = rest;
    }, { reason: 'analysis:settings' });
    fillControls();
  }

  /** O que este vídeo não tem: faixa de áudio, chat baixado e transcrição (sinal ausente é ignorado, e a tela diz isso). */
  function missingSignals() {
    const project = BF.state.project;
    const info = BF.state.info;
    const t = state.transcript;
    return {
      noAudio: Boolean(info) && info.hasAudio === false,
      noChat: !project || !project.chat || !project.chat.path,
      noText: !t || !t.exists || Boolean(t.stale)
    };
  }

  /** Sinais ligados que este vídeo pode mesmo fornecer. Sem nenhum, analisar não faria nada. */
  function usableSignals() {
    const ui = state.ui;
    if (!ui.signalBoxes) return [];
    const { noAudio, noChat, noText } = missingSignals();
    return SIGNALS.filter((sig) => ui.signalBoxes[sig.id].checked && !(sig.id === 'audio' && noAudio) && !(sig.id === 'chat' && noChat) && !(sig.id === 'text' && noText) && !(sig.id === 'calm' && (noAudio || !ui.signalBoxes.audio.checked))).map((sig) => sig.id);
  }

  /** Explicações do que está disponível neste vídeo (sinal ausente é ignorado, e a tela diz isso). */
  function renderHints() {
    const ui = state.ui;
    if (!ui.signalHints) return;
    const { noAudio, noChat, noText } = missingSignals();
    for (const sig of SIGNALS) {
      let text = sig.hint;
      let off = false;
      if (sig.id === 'audio' && noAudio) { text = 'este vídeo não tem áudio: será ignorado'; off = true; }
      if (sig.id === 'calm' && (noAudio || !ui.signalBoxes.audio.checked)) { text = noAudio ? 'precisa do áudio do vídeo: será ignorado' : 'precisa do sinal de Áudio ligado: será ignorado'; off = true; }
      if (sig.id === 'chat' && noChat) { text = 'sem chat baixado (aba Novo projeto): será ignorado'; off = true; }
      if (sig.id === 'text' && noText) { text = 'sem transcrição deste vídeo (gere ou importe acima): será ignorado'; off = true; }
      ui.signalHints[sig.id].textContent = text;
      ui.signalBoxes[sig.id].disabled = off || state.running;
      ui.signalHints[sig.id].classList.toggle('an-off', off);
    }
    const p = prefValues();
    const limited = limitedPrefs();
    ui.prefsNote.textContent = `Margens e durações vêm das Preferências: ${p.padBeforeSec} s antes, ${p.padAfterSec} s depois, entre ${p.minDurationSec} e ${p.maxDurationSec} s, relevância mínima ${pct(p.minRelevance)}.${limited.length ? ` Atenção: ${limited.join('; ')}, então a análise usa o valor limitado.` : ''}`;
    syncOutputs();
  }

  function renderRun() {
    const ui = state.ui;
    if (!ui.run) return;
    const ffmpegMissing = !BF.state.tools.ffmpeg || !BF.state.tools.ffprobe;
    const noProject = !BF.state.project;
    const noSignal = !noProject && !usableSignals().length;
    const ai = engineChoice() === 'ai';
    const blockers = ai ? aiBlockers() : null;
    ui.run.disabled = state.running || noProject || (ai ? !blockers.ok : (ffmpegMissing || noSignal));
    ui.fresh.disabled = ui.run.disabled;
    ui.run.textContent = state.running ? 'Analisando…' : 'Analisar';
    ui.cancel.hidden = !state.running;
    ui.cancel.disabled = state.starting;
    ui.progressBox.hidden = !state.running;
    if (state.running) {
      const p = state.progress ? Math.min(1, Math.max(0, state.progress.p)) : 0;
      ui.progress.value = p;
      const left = remainingSec(p, state.startedAt);
      ui.progressText.textContent = `${state.progress ? state.progress.message : 'Preparando…'} ${Math.round(p * 100)}%${left !== null ? ` · ${eta(Math.round(left))}` : ''}`;
    }
    ui.ffmpegWarn.hidden = ai || !ffmpegMissing;
    ui.signalWarn.hidden = ai || !noSignal || state.running;
    ui.aiWarn.hidden = !ai || noProject || blockers.ok || state.running;
    if (ai && !ui.aiWarn.hidden) ui.aiWarn.textContent = blockers.why.join(' ');
    // vídeo longo: avisa que a imagem demora e que existe o modo rápido (nos ajustes avançados)
    const long = !ai && Boolean(BF.state.info) && BF.state.info.duration > 3600 && !(ui.fast && ui.fast.checked);
    ui.longWarn.hidden = !long || state.running;
    // durante a análise os ajustes ficam travados (os sinais são tratados em renderHints)
    for (const control of ui.lockables) control.disabled = state.running;
    for (const button of Object.values(ui.engineButtons || {})) button.disabled = state.running;
    if (ui.tGenerate) renderTranscript();
    if (ui.aiLockables) for (const node of ui.aiLockables) node.disabled = state.running;
    if (ui.hCard) renderHumor(); // o perfil de humor também trava durante a análise
    if (ui.orPicker) ui.orPicker.bfPicker.setDisabled(state.running); // o seletor do OpenRouter também trava durante a análise
    renderHints();
    renderNotice();
    BF.ui.refreshTabs(); // o selo da aba mostra "…" enquanto analisa
  }

  function renderNotice() {
    const ui = state.ui;
    if (!ui.notice) return;
    const saved = current(); // avisos de uma análise de outro vídeo não valem aqui
    const items = [];
    if (state.notice && state.notice.fallback) {
      items.push(el('div', { class: 'an-note an-error', role: 'alert', id: 'anFallback' },
        el('span', { class: 'an-note-text' }, state.notice.text),
        el('button', { type: 'button', id: 'anUseAlgorithm', class: 'sm', onclick: useAlgorithm }, 'Usar o algoritmo')));
    } else if (state.notice) items.push(el('p', { class: `an-note ${state.notice.kind === 'error' ? 'an-error' : ''}`, role: state.notice.kind === 'error' ? 'alert' : undefined }, state.notice.text));
    if (!state.running && saved && saved.warnings) {
      for (const w of saved.warnings) items.push(el('p', { class: 'an-note an-warn' }, `Aviso: ${w.message}`));
    }
    ui.notice.replaceChildren(...items);
  }

  function aiSummaryText(saved, counts) {
    const ai = saved.ai || {};
    const parts = [`${saved.suggestions.length} sugestão(ões) encontrada(s)`];
    if (counts.inCuts) parts.push(`${counts.inCuts} já nos cortes`);
    if (counts.dismissed) parts.push(`${counts.dismissed} descartada(s)`);
    parts.push(`IA: ${[ai.provider, ai.model].filter(Boolean).join(' · ') || 'provedor'}`);
    if (ai.calls) parts.push(`${plural(ai.calls, 'chamada', 'chamadas')}, ~${Math.max(1, Math.round(((ai.promptTokens || 0) + (ai.completionTokens || 0)) / 1000)).toLocaleString('pt-BR')} mil tokens`);
    if (ai.profile) parts.push(`perfil do canal enviado: ${humorSentText(ai.profile)}`);
    if (ai.failedBlocks) parts.push(`${plural(ai.failedBlocks, 'bloco falhou', 'blocos falharam')}`);
    if (ai.droppedTotal) parts.push(`${ai.droppedTotal} descartada(s) na conferência local`);
    parts.push(`calculado em ${Math.max(1, Math.round((saved.tookMs || 0) / 1000))} s`);
    return parts.join(' · ');
  }

  function summaryText(saved, counts) {
    if (saved.engine === 'ai') return aiSummaryText(saved, counts);
    const used = SIGNALS.filter((sig) => saved.signals && saved.signals[sig.id] && saved.signals[sig.id].used).map((sig) => sig.label.toLowerCase());
    const ignored = SIGNALS.filter((sig) => saved.signals && saved.signals[sig.id] && !saved.signals[sig.id].used)
      .map((sig) => `${sig.label.toLowerCase()} (${saved.signals[sig.id].reason || 'ignorado'})`);
    const parts = [`${saved.suggestions.length} sugestão(ões) encontrada(s)`];
    if (counts.inCuts) parts.push(`${counts.inCuts} já nos cortes`);
    if (counts.dismissed) parts.push(`${counts.dismissed} descartada(s)`);
    parts.push(`sinais usados: ${used.join(', ') || 'nenhum'}`);
    const humorHits = saved.signals && saved.signals.text ? saved.signals.text.humorHits : undefined;
    if (typeof humorHits === 'number') parts.push(`perfil do canal: ${plural(humorHits, 'expressão achada', 'expressões achadas')} na fala`);
    const episodes = Array.isArray(saved.episodes) ? saved.episodes.length : 0;
    const waitMin = Array.isArray(saved.breaks) ? Math.round(saved.breaks.reduce((sum, b) => sum + (b.end - b.start), 0) / 60) : 0;
    if (episodes > 1) parts.push(`${episodes} episódios`);
    if (Array.isArray(saved.breaks) && saved.breaks.length) parts.push(`telas de espera puladas (${waitMin < 1 ? 'menos de 1' : waitMin} min)`);
    if (ignored.length) parts.push(`ignorados: ${ignored.join('; ')}`);
    const secs = Math.max(1, Math.round((saved.tookMs || 0) / 1000));
    parts.push(saved.fromCache ? 'resultado do cache' : `calculado em ${secs} s`);
    return parts.join(' · ');
  }

  function renderResults() {
    const ui = state.ui;
    if (!ui.results) return;
    const saved = current();
    const hasRun = Boolean(saved && Array.isArray(saved.suggestions) && saved.runAt);
    ui.results.hidden = !hasRun;
    if (!hasRun) { ui.list.replaceChildren(); ui.dismissedBox.hidden = true; ui.models.hidden = true; return; }
    const cuts = BF.state.project.cuts;
    const dismissed = dismissedOf(saved);
    const list = visible();
    const gone = dismissedSuggestions(saved.suggestions, cuts, dismissed);
    const counts = { inCuts: saved.suggestions.filter((s) => isCovered(s, cuts)).length, dismissed: gone.length };
    ui.summary.textContent = summaryText(saved, counts);
    renderAiModels(saved);
    renderAiDrops(saved);
    ui.addAll.hidden = list.length < 2;
    ui.addAll.textContent = `Adicionar todas (${list.length})`;
    ui.addAll.disabled = state.running;
    ui.dismissAll.hidden = list.length < 2;
    ui.dismissAll.textContent = `Descartar todas (${list.length})`;
    const hasEpisodes = Array.isArray(saved.episodes) && saved.episodes.length > 1;
    ui.orderBox.hidden = list.length < 2;
    ui.orderTime.textContent = hasEpisodes ? 'Ordem dos episódios' : 'Ordem do vídeo';
    ui.order.value = listOrder();
    ui.order.disabled = state.running;
    ui.dismissAll.disabled = state.running;
    ui.empty.hidden = list.length > 0;
    ui.emptyBox.hidden = ui.empty.hidden;
    ui.emptyTitle.textContent = !saved.suggestions.length ? 'Nenhuma sugestão' : counts.dismissed ? 'Nada novo para revisar' : 'Tudo já está nos cortes';
    if (!saved.suggestions.length) {
      ui.empty.textContent = `Nenhum momento passou dos critérios. Aumente a sensibilidade ou a quantidade, ou baixe a relevância mínima nas Preferências.${saved.warnings && saved.warnings.length ? ' Confira também os avisos acima.' : ''}`;
    } else {
      ui.empty.textContent = counts.dismissed
        ? 'Não há mais sugestões para revisar: as outras estão nos cortes ou foram descartadas.'
        : 'Todas as sugestões já estão nos cortes (inclusive as rejeitadas). Revise na aba Cortes.';
    }
    ui.list.replaceChildren(...inViewOrder(list).map((s, index) => row(s, index)));
    // descartadas: seção recolhida, só aparece quando há alguma
    ui.dismissedBox.hidden = gone.length === 0;
    ui.dismissedTitle.textContent = `Descartadas (${gone.length})`;
    ui.restoreAll.hidden = gone.length < 2;
    ui.restoreAll.disabled = state.running;
    ui.dismissedList.replaceChildren(...gone.map((s) => dismissedRow(s)));
  }

  /**
   * "Modelo(s) que responderam: …" (campo `model` de cada resposta). Só aparece quando alguém diferente do modelo escolhido respondeu:
   * com o roteador gratuito do OpenRouter (que sorteia um modelo por pedido) ou depois de uma troca para um modelo de reserva.
   */
  function renderAiModels(saved) {
    const ui = state.ui;
    const ai = saved.engine === 'ai' && saved.ai ? saved.ai : null;
    const entries = ai && ai.models && typeof ai.models === 'object' ? Object.entries(ai.models).filter(([, n]) => n > 0) : [];
    const differs = entries.some(([id]) => id !== ai.model);
    ui.models.hidden = !entries.length || !differs;
    ui.models.textContent = ui.models.hidden ? '' : `Modelo(s) que responderam: ${entries.map(([id, n]) => `${id} (${plural(n, 'chamada', 'chamadas')})`).join(', ')}`;
  }

  /** Seção recolhida com o que a conferência local descartou (só nas análises por IA). */
  function renderAiDrops(saved) {
    const ui = state.ui;
    const dropped = saved.engine === 'ai' && saved.ai && Array.isArray(saved.ai.dropped) ? saved.ai.dropped : [];
    ui.aiDropBox.hidden = !dropped.length;
    if (!dropped.length) return;
    ui.aiDropTitle.textContent = `Descartadas na conferência (${saved.ai.droppedTotal || dropped.length})`;
    ui.aiDropList.replaceChildren(...dropped.map((d) => el('li', { class: 'an-drop' },
      el('span', { class: 'an-time small' }, `${clock(d.start)} → ${clock(d.end)}`),
      el('span', { class: 'muted small' }, `${d.title ? `${d.title} · ` : ''}${d.detail || d.reason}`))));
  }

  function row(s, index) {
    const dur = Math.round(s.end - s.start);
    const label = `${clock(s.start)} a ${clock(s.end)}`;
    return el('li', { class: 'an-item', dataset: { id: s.id, start: String(s.start), end: String(s.end) } },
      el('div', { class: 'an-item-head' },
        el('span', { class: 'an-rank' }, String(index + 1)),
        el('span', { class: 'an-time' }, `${clock(s.start)} → ${clock(s.end)}`),
        el('span', { class: 'an-dur muted small' }, `${dur} s`),
        el('span', { class: 'an-rel bds-chip bds-chip-accent', title: 'Relevância estimada pelas regras (0 a 100%). Não é garantia.', 'aria-label': `Relevância ${pct(s.relevance)}` }, pct(s.relevance))),
      s.title ? el('p', { class: 'an-cut-title' }, s.title) : null,
      (s.category || s.layout || s.theme || s.episode || s.reasons.length)
        ? el('ul', { class: 'an-reasons' },
          s.episode ? el('li', { class: 'bds-chip bds-chip-info an-episode', title: 'Episódio da live (contado entre as telas de espera)' }, `Episódio ${s.episode}`) : null,
          s.category ? el('li', { class: 'bds-chip bds-chip-info' }, s.category) : null,
          s.theme ? el('li', { class: 'bds-chip bds-chip-accent an-theme', title: 'Tema do perfil do canal' }, `Tema: ${s.theme}`) : null,
          s.layout ? el('li', { class: 'bds-chip' }, s.layout === 'jogo' ? 'Jogo' : 'Conversa') : null,
          s.reasons.map((r) => el('li', { class: `bds-chip${/^revisar/i.test(r) ? ' bds-chip-warn' : ''}` }, r)))
        : null,
      Array.isArray(s.keywords) && s.keywords.length
        ? el('ul', { class: 'an-reasons an-keywords', 'aria-label': 'Palavras-chave' }, s.keywords.map((k) => el('li', { class: 'bds-chip an-keyword', title: 'Palavra-chave sugerida pela IA' }, `#${k}`)))
        : null,
      el('div', { class: 'an-actions' },
        el('button', { type: 'button', class: 'an-view sm', 'aria-label': `Ver trecho de ${label}`, onclick: () => BF.player.playRange(s.start, s.end) }, icon('play_arrow'), 'Ver trecho'),
        el('button', { type: 'button', class: 'an-add secondary sm', 'aria-label': `Adicionar o trecho de ${label} como sugestão`, onclick: () => addOne(s, index) }, icon('add'), 'Adicionar'),
        el('button', { type: 'button', class: 'an-dismiss icon-btn', 'aria-label': `Descartar o trecho de ${label}`, title: 'Esconde esta sugestão sem criar corte; dá para restaurar em "Descartadas".', onclick: () => dismissOne(s, index) }, icon('close'))));
  }

  function dismissedRow(s) {
    const label = `${clock(s.start)} a ${clock(s.end)}`;
    return el('li', { class: 'an-item an-item-dismissed', dataset: { id: s.id, start: String(s.start), end: String(s.end) } },
      el('div', { class: 'an-item-head' },
        el('span', { class: 'an-time' }, `${clock(s.start)} → ${clock(s.end)}`),
        el('span', { class: 'an-dur muted small' }, `${Math.round(s.end - s.start)} s`),
        el('span', { class: 'an-rel muted small' }, pct(s.relevance))),
      el('div', { class: 'an-actions' },
        el('button', { type: 'button', class: 'an-view sm', 'aria-label': `Ver trecho de ${label}`, onclick: () => BF.player.playRange(s.start, s.end) }, icon('play_arrow'), 'Ver trecho'),
        el('button', { type: 'button', class: 'an-restore sm', 'aria-label': `Restaurar o trecho de ${label}`, onclick: () => restoreOne(s) }, icon('undo'), 'Restaurar')));
  }

  function setListOrder(value) {
    const order = value === 'time' ? 'time' : 'relevance';
    if (order === listOrder()) return;
    BF.project.update((project) => {
      project.ext = project.ext || {};
      project.ext.analysis = { ...(project.ext.analysis || {}), listOrder: order };
    }, { reason: 'analysis:order' });
    renderResults();
  }

  function addOne(s, index) {
    const created = addSuggestions([s]);
    if (created.length) BF.ui.log(`Sugestão adicionada como pendente (${clock(s.start)}). Revise na aba Cortes.`, 'ok');
    renderResults();
    focusAfter(index, '.an-add');
  }

  function addAll() {
    const list = visible();
    const created = addSuggestions(list);
    if (created.length) {
      BF.ui.toast(`${created.length} sugestão(ões) adicionada(s) como pendentes. Nada foi aprovado: revise na aba Cortes.`, 'ok');
      BF.ui.log(`${created.length} sugestão(ões) adicionada(s) como pendentes.`, 'ok');
    }
    renderResults();
    focusAfter(0, '.an-add');
  }

  function dismissOne(s, index) {
    if (dismissSuggestions([s])) BF.ui.log(`Sugestão de ${clock(s.start)} descartada (nenhum corte foi criado). Dá para restaurar em "Descartadas".`, 'ok');
    renderResults();
    focusAfter(index, '.an-dismiss');
  }

  function dismissAll() {
    const list = visible();
    if (dismissSuggestions(list)) {
      BF.ui.toast(`${list.length} sugestão(ões) descartada(s). Nenhum corte foi criado; dá para restaurar em "Descartadas".`, 'ok');
      BF.ui.log(`${list.length} sugestão(ões) descartada(s).`, 'ok');
    }
    renderResults();
    focusAfter(0, '.an-dismiss');
  }

  function restoreOne(s) {
    if (restoreSuggestions([s])) BF.ui.log(`Sugestão de ${clock(s.start)} restaurada.`, 'ok');
    renderResults();
    focusAfter(0, '.an-add');
  }

  function restoreAll() {
    const saved = current();
    const list = saved ? dismissedSuggestions(saved.suggestions, BF.state.project.cuts, dismissedOf(saved)) : [];
    if (restoreSuggestions(list)) BF.ui.log(`${list.length} sugestão(ões) restaurada(s).`, 'ok');
    renderResults();
    focusAfter(0, '.an-add');
  }

  /** Depois de agir numa linha, o foco vai para o botão equivalente da linha que ocupou o lugar (ou para o botão mais próximo). */
  function focusAfter(index, selector) {
    const ui = state.ui;
    const buttons = [...ui.list.querySelectorAll(selector)];
    const target = buttons[Math.min(index, buttons.length - 1)] || (ui.addAll.hidden ? ui.run : ui.addAll);
    if (target && !target.disabled) target.focus();
  }

  // ---------- motor da análise e IA na nuvem ----------

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
    if (!project || engineChoice() !== 'ai' || !state.ai || !state.ai.ready || !state.transcript || !state.transcript.exists || state.transcript.stale) { renderAi(); return; }
    const profile = humorProfile();
    const res = await BF.api('analysis:aiEstimate', {
      projectId: project.id, path: project.source.path, size: project.source.size || 0, duration: project.source.duration || 0,
      params: {}, chatPath: project.chat && project.chat.path ? project.chat.path : null, ...(profile ? { profile } : {})
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

  /** Modelo e idioma que o usuário escolheu na aba Legendas para este vídeo (sem escolha, o padrão do app). */
  function whisperChoice(project) {
    const sub = (project.ext && project.ext.subtitles) || {};
    return {
      ...(typeof sub.modelId === 'string' && sub.modelId ? { modelId: sub.modelId } : {}),
      ...(typeof sub.language === 'string' && sub.language ? { language: sub.language } : {})
    };
  }

  async function refreshTranscript() {
    const project = BF.state.project;
    if (!project) { state.transcript = null; state.tengine = null; renderAll(); return; }
    const res = await BF.api('analysis:transcriptStatus', {
      projectId: project.id, path: project.source.path, size: project.source.size || 0, duration: project.source.duration || 0, ...whisperChoice(project)
    });
    if (BF.state.project !== project) return;
    state.transcript = res.ok && res.transcript ? res.transcript : null;
    state.tengine = res.ok && res.engine ? res.engine : null;
    if (res.ok && res.running && res.running.projectId === project.id && !state.tjob) {
      state.tjob = { id: res.running.jobId, p: res.running.p || 0, message: res.running.message || 'Transcrevendo…', doneUntil: res.running.doneUntil || 0 };
    }
    renderAll();
    refreshEstimate();
  }

  /** Salva o motor escolhido neste projeto (a escolha automática vale enquanto o usuário não escolher). */
  function setEngine(id) {
    if (!BF.state.project || state.running || (id !== 'ai' && id !== 'algorithm')) return;
    saveSettings({ ...readControls(), engine: id });
    renderAll();
    renderResults();
    refreshEstimate();
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

  function changeLimit(key, input) {
    const n = num(input.value, null);
    if (n === null) { renderAi(); return; }
    saveAi({ limits: { [key]: n } });
  }

  // ---------- transcrição do vídeo ----------

  async function generateTranscript() {
    const project = BF.state.project;
    if (!project || state.tjob || state.tstarting || state.running) return;
    state.tstarting = true;
    state.notice = null;
    renderAll();
    const res = await BF.api('analysis:transcriptGenerate', {
      projectId: project.id, path: project.source.path, size: project.source.size || 0, duration: project.source.duration || 0, ...whisperChoice(project)
    });
    state.tstarting = false;
    if (!res.ok) {
      state.notice = { kind: 'error', text: res.message };
      BF.ui.log(res.message, 'error');
      renderAll();
      return;
    }
    state.tjob = { id: res.jobId, p: 0, message: 'Preparando…', doneUntil: 0, projectId: project.id };
    for (const item of state.tearly.splice(0)) handleTranscriptEvent(item.type, item.payload);
    renderAll();
  }

  async function cancelTranscript() {
    if (state.tjob) await BF.api('analysis:transcriptCancel', { jobId: state.tjob.id });
  }

  async function importTranscript() {
    const project = BF.state.project;
    if (!project || state.tjob) return;
    const res = await BF.api('analysis:transcriptImport', {
      projectId: project.id, path: project.source.path, size: project.source.size || 0, duration: project.source.duration || 0,
      defaultDir: BF.util.dirOf ? BF.util.dirOf(project.source.path) : undefined
    });
    if (!res.ok) { state.notice = { kind: 'error', text: res.message }; renderNotice(); return; }
    if (res.canceled) return;
    state.notice = res.warnings && res.warnings.length ? { kind: 'info', text: res.warnings.join(' ') } : null;
    BF.ui.toast('Transcrição importada.', 'ok');
    await refreshTranscript();
  }

  async function removeTranscript() {
    const project = BF.state.project;
    if (!project) return;
    const ok = await BF.ui.confirm({ title: 'Remover a transcrição?', message: 'A transcrição guardada deste vídeo será apagada do app (o arquivo de legenda original, se houve importação, não é tocado). A análise por IA vai pedir uma nova.', okLabel: 'Remover', cancelLabel: 'Manter', danger: true });
    if (!ok) return;
    await BF.api('analysis:transcriptRemove', { projectId: project.id });
    await refreshTranscript();
  }

  function handleTranscriptEvent(type, payload) {
    if (!state.tjob || payload.jobId !== state.tjob.id) {
      if (state.tstarting) state.tearly.push({ type, payload });
      return;
    }
    if (type === 'progress') {
      state.tjob = { ...state.tjob, p: payload.p, message: payload.message, doneUntil: payload.doneUntil };
      renderTranscript();
    } else if (type === 'done') {
      state.tjob = null;
      BF.ui.toast(payload.deviceNote ? `Transcrição pronta. ${payload.deviceNote}` : 'Transcrição pronta.', 'ok');
      refreshTranscript();
    } else if (type === 'failed') {
      state.tjob = null;
      state.notice = payload.code === 'CANCELLED'
        ? { kind: 'info', text: payload.message }
        : { kind: 'error', text: payload.message };
      if (payload.code !== 'CANCELLED') BF.ui.log(payload.message, 'error');
      refreshTranscript();
    }
  }
  BF.on('analysis:transcriptProgress', (ev) => handleTranscriptEvent('progress', ev));
  BF.on('analysis:transcriptDone', (ev) => handleTranscriptEvent('done', ev));
  BF.on('analysis:transcriptFailed', (ev) => handleTranscriptEvent('failed', ev));

  /** A IA falhou: troca para o algoritmo e analisa (a escolha fica salva neste projeto). */
  async function useAlgorithm() {
    state.notice = null;
    saveSettings({ ...readControls(), engine: 'algorithm' });
    renderAll();
    await run({ engine: 'algorithm' });
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

  // ---------- desenho: motor, transcrição, provedor ----------

  function buildEngine() {
    const ui = state.ui;
    ui.engineButtons = {};
    const buttons = ENGINES.map((e) => {
      const button = el('button', { type: 'button', id: `anEngine-${e.id}`, class: 'bds-tab', role: 'tab', 'aria-selected': 'false', dataset: { engine: e.id }, onclick: () => setEngine(e.id) }, e.label);
      ui.engineButtons[e.id] = button;
      return button;
    });
    ui.engineHint = el('p', { class: 'muted small', id: 'anEngineHint' });
    ui.engineBar = el('div', { class: 'an-engine', id: 'anEngine' },
      el('h3', { class: 'panel-title' }, 'Motor da análise'),
      el('div', { class: 'bds-tabs', role: 'tablist', 'aria-label': 'Motor da análise' }, buttons),
      ui.engineHint);
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
    ui.tGenerate = el('button', { type: 'button', id: 'anTGenerate', class: 'sm', onclick: generateTranscript }, 'Transcrever o vídeo');
    ui.tImport = el('button', { type: 'button', id: 'anTImport', class: 'sm', onclick: importTranscript }, icon('upload_file'), 'Importar legenda…');
    ui.tRemove = el('button', { type: 'button', id: 'anTRemove', class: 'icon-btn', 'aria-label': 'Remover a transcrição guardada', title: 'Remover a transcrição guardada', onclick: removeTranscript }, icon('delete'));
    ui.tCard = el('div', { class: 'an-card', id: 'anTranscript' },
      el('div', { class: 'an-split' }, el('strong', {}, 'Transcrição do vídeo'), ui.tChip),
      ui.tLine, ui.tSub, ui.tProgressBox,
      el('div', { class: 'an-card-actions' }, ui.tGenerate, ui.tImport, ui.tRemove));

    // --- provedor
    ui.pChip = el('span', { class: 'bds-chip', id: 'anPChip' });
    ui.pLine = el('p', { class: 'small', id: 'anProvider' });
    ui.estLine = el('p', { class: 'muted small', id: 'anEstimate' });

    ui.cfgProvider = el('select', { id: 'anCfgProvider', 'aria-label': 'Provedor de IA', onchange: () => { if (ui.cfgProvider.value) saveAi({ provider: ui.cfgProvider.value }); } });
    ui.cfgBaseUrl = el('input', { type: 'url', id: 'anCfgUrl', placeholder: 'https://servidor/v1', autocomplete: 'off', spellcheck: 'false', onchange: changeBaseUrl });
    ui.cfgBaseUrlField = field('Endereço do servidor', ui.cfgBaseUrl, 'compatível com a API de chat da OpenAI', true);
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
    ui.cfgModelField = field('Modelo', ui.cfgModel, 'você escolhe o modelo; a lista só sugere um nome', true);
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
        switchRow('an-switch-row', 'anCfgAccept', 'Aviso de privacidade aceito', el('span', { class: 'small' }, 'Sem o aceite, nada é enviado. Vale até você revogar'), ui.cfgAccept),
        el('div', { class: 'an-adv-group' },
          el('h4', { class: 'an-group-title' }, 'Limites'),
          el('div', { class: 'an-adv-grid an-adv-two' }, limitFields),
          el('p', { class: 'muted small' }, 'A tela mostra a estimativa antes de analisar; passar do limite de chamadas bloqueia a análise.'))));
    ui.aiLockables = [ui.cfgProvider, ui.cfgBaseUrl, ui.cfgModel, ui.cfgKey, ui.cfgKeySave, ui.cfgKeyClear, ui.cfgAccept, ui.hostFree, ...ui.orReserve, ...Object.values(ui.limits)];
    ui.pCard = el('div', { class: 'an-card', id: 'anProviderCard' },
      el('div', { class: 'an-split' }, el('strong', {}, 'Provedor de IA'), ui.pChip),
      ui.pLine, ui.orChipHost, ui.estLine, ui.estFree, ui.aiConfig);
    ui.aiRoot = el('div', { class: 'an-ai', id: 'anAi', hidden: true }, ui.pCard);
  }

  function renderEngine() {
    const ui = state.ui;
    if (!ui.engineBar) return;
    const eng = engineChoice();
    const auto = !settings().engine;
    for (const e of ENGINES) {
      const button = ui.engineButtons[e.id];
      button.setAttribute('aria-selected', String(e.id === eng));
      button.classList.toggle('active', e.id === eng);
      button.disabled = state.running;
    }
    ui.engineHint.textContent = `${ENGINES.find((e) => e.id === eng).hint}${auto ? ' (escolhido automaticamente)' : ''}`;
    ui.signalsBlock.hidden = eng === 'ai';
    ui.sensRow.hidden = eng === 'ai';
    ui.advanced.hidden = eng === 'ai';
    ui.aiRoot.hidden = eng !== 'ai';
    ui.intro.textContent = eng === 'ai'
      ? 'A IA lê a transcrição do vídeo e sugere os melhores momentos. O app confere cada horário e cada frase antes de virar sugestão. Sugestão não é garantia: revise cada trecho.'
      : 'Procura volume acima do normal de fala, mudanças de imagem, agitação do chat e, com a transcrição, risadas, exclamações e ritmo de fala. São regras simples, não inteligência artificial: sugestão não é garantia — revise cada trecho.';
  }

  function renderTranscript() {
    const ui = state.ui;
    if (!ui.tCard) return;
    const t = state.transcript;
    const eng = state.tengine;
    const running = Boolean(state.tjob) || state.tstarting;
    ui.tProgressBox.hidden = !running;
    if (running) {
      const job = state.tjob || { p: 0, message: 'Preparando…', doneUntil: 0 };
      const p = Math.min(1, Math.max(0, job.p));
      ui.tProgress.value = p;
      const total = (BF.state.project && BF.state.project.source.duration) || 0;
      ui.tProgressText.textContent = `${job.message}${total ? ` · ${hms(job.doneUntil)} de ${hms(total)}` : ''}`;
      ui.tCancel.disabled = state.tstarting && !state.tjob;
    }
    const ai = engineChoice() === 'ai';
    let chip = [ai ? 'Ausente' : 'Opcional', 'bds-chip bds-chip-warn'];
    let line = ai
      ? 'Sem transcrição. A IA precisa do texto do vídeo: gere com o Whisper (neste computador) ou importe uma legenda .srt/.vtt.'
      : 'Sem transcrição. Com o texto das falas o algoritmo também procura risadas, exclamações e ritmo de fala: gere com o Whisper (neste computador) ou importe uma legenda .srt/.vtt.';
    let sub = '';
    if (t && t.exists) {
      const pctCovered = t.coverage == null ? null : Math.round(t.coverage * 100);
      chip = t.stale ? ['De outro arquivo', 'bds-chip bds-chip-warn'] : (t.origin === 'imported' ? ['Importada', 'bds-chip bds-chip-info'] : ['Gerada', 'bds-chip bds-chip-ok']);
      line = t.stale
        ? 'Esta transcrição foi feita para outro arquivo de vídeo. Gere ou importe a deste vídeo.'
        : `Cobre ${hms(t.coveredSec)}${t.duration ? ` de ${hms(t.duration)} (${pctCovered}%)` : ''} · ${plural(t.cues, 'fala', 'falas')}${t.laughs ? ` · ${plural(t.laughs, 'risada', 'risadas')}` : ''}`;
      if (t.origin === 'imported') sub = `Importada${t.importedFrom ? ` de ${t.importedFrom}` : ''}.`;
      else sub = `Gerada pelo Whisper${t.engine && t.engine.modelLabel ? ` (${t.engine.modelLabel}${t.engine.deviceLabel ? `, ${t.engine.deviceLabel}` : ''})` : ''}.`;
      if (!t.stale && pctCovered !== null && pctCovered < 90) sub = `${sub} Cobre só ${pctCovered}% do vídeo: o texto não ajuda no que vem depois.`;
    } else if (t && t.draft) {
      chip = ['Incompleta', 'bds-chip bds-chip-warn'];
      line = `Há uma transcrição pela metade (até ${hms(t.draft.doneUntil)}). O botão continua de onde parou.`;
    }
    if (eng && !eng.ready && !running) sub = sub ? `${sub} ${eng.reason}` : eng.reason;
    ui.tChip.className = chip[1];
    ui.tChip.textContent = chip[0];
    ui.tLine.textContent = line;
    ui.tSub.textContent = sub;
    ui.tSub.hidden = !sub;
    const has = Boolean(t && t.exists && !t.stale);
    ui.tGenerate.textContent = t && t.draft && !has ? 'Continuar a transcrição' : (has ? 'Transcrever de novo' : 'Transcrever o vídeo');
    ui.tGenerate.disabled = running || state.running || !BF.state.project || !(eng && eng.ready);
    ui.tGenerate.title = eng && !eng.ready ? eng.reason : '';
    ui.tImport.disabled = running || state.running || !BF.state.project;
    ui.tRemove.hidden = !(t && t.exists);
    ui.tRemove.disabled = running || state.running;
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
      ui.pLine.textContent = p.ready ? `${p.label} · ${modelLabel(p)}` : `${p.label}: ${p.reason}`;
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
    if (!typing(ui.cfgBaseUrl)) ui.cfgBaseUrl.value = p.baseUrl || '';
    if (!typing(ui.cfgModel)) ui.cfgModel.value = p.model || '';
    // o modelo é escolha do usuário: o campo começa vazio e a lista só SUGERE um nome (se o provedor tiver sugestão)
    const suggested = p.suggestedModel || '';
    ui.cfgModel.placeholder = none ? 'escolha o provedor primeiro' : (suggested ? `ex.: ${suggested}` : 'nome do modelo');
    ui.cfgModelList.replaceChildren(...(suggested ? [el('option', { value: suggested })] : []));
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
    for (const node of ui.aiLockables) node.disabled = state.running;
    if (none) for (const node of [ui.cfgModel, ui.cfgKey, ui.cfgKeySave, ui.cfgAccept]) node.disabled = true; // sem provedor escolhido não há o que configurar
    if (host) ui.cfgAccept.disabled = state.running;
    // sem provedor pronto o cartão de configuração já vem aberto
    if (!ready && !state.autoOpened && engineChoice() === 'ai') { ui.aiConfig.open = true; state.autoOpened = true; }
  }

  function renderAll() {
    renderEngine();
    renderAi();
    renderHumor();
    renderRun();
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
    ui.results = el('section', { class: 'an-results', id: 'anResults', 'aria-label': 'Sugestões', hidden: true },
      el('div', { class: 'an-results-head' }, el('h3', { class: 'panel-title' }, 'Sugestões'), el('div', { class: 'an-bulk' }, ui.addAll, ui.dismissAll)),
      ui.summary, ui.models, ui.emptyBox, ui.orderBox, ui.list, ui.dismissedBox, ui.aiDropBox);

    ui.intro = el('p', { class: 'muted small an-intro', id: 'anIntro' });
    return el('div', { class: 'an', id: 'analysis' },
      ui.intro,
      el('section', { class: 'panel an-setup' }, ui.engineBar, ui.tCard, ui.hCard, ui.aiRoot, ui.controlsRoot),
      ui.notice,
      ui.results);
  }

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
    state.lastEngine = res.running.engine === 'ai' ? 'ai' : 'algorithm';
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

  BF.analysis = { engineChoice, isCovered, pendingSuggestions, dismissedSuggestions, sameSource, remainingSec, clock, addSuggestions, dismissSuggestions, restoreSuggestions, splitKeywords, humorProfile };
})();

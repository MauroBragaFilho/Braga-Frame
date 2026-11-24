'use strict';

/**
 * Aba "Análise": LÓGICA PURA (sem DOM, sem estado, sem BF.api): sinais e motores, estimativas de tempo, o que já está coberto por um corte,
 * as sugestões pendentes e descartadas, e os textos de resumo do resultado. Foi tirada de features/analysis.js (Etapa 2, 17/11/2026) sem
 * mudar o comportamento. Carrega ANTES de analysis.js (veja renderer/index.html) e vira `window.BFAnalysisLogic`; em Node,
 * `require` devolve o mesmo objeto (tests/analysis-logic.test.js).
 */
(function (root) {
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

  /**
   * Segundos que faltam para as ETAPAS em andamento terminarem, pelo ritmo de cada uma. `stages` = { nome: { startedAt, p0, p } }: quando a
   * etapa foi vista pela primeira vez, quanto dela já estava feito ali e quanto está feito agora (0..1). Com mais de uma em andamento (áudio e
   * imagem ao mesmo tempo), vale a que demora mais. null = cedo demais para estimar (menos de 5 s ou de 2% andados) ou nada em andamento.
   * A conta pela barra inteira (remainingSec) mistura etapas de ritmos diferentes e fazia o tempo restante SUBIR durante a etapa lenta.
   */
  function stageRemainingSec(stages, now = Date.now()) {
    let worst = null;
    for (const s of Object.values(stages || {})) {
      if (!(s.p < 1)) continue;
      const elapsed = (now - s.startedAt) / 1000;
      const done = s.p - s.p0;
      if (!(elapsed >= 5) || !(done >= 0.02)) return null;
      const left = (elapsed * (1 - s.p)) / done;
      if (worst === null || left > worst) worst = left;
    }
    return worst;
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
    { id: 'ai', label: 'IA na nuvem', hint: 'lê a transcrição e escolhe os melhores momentos' },
    { id: 'both', label: 'Algoritmo + IA', hint: 'roda os dois e junta as listas: o que os dois acharam vem primeiro (mais cortes; leva o tempo dos dois)' },
    { id: 'chat', label: 'IA de chat', hint: 'sem chave: você copia o pedido, cola no GPT, Qwen ou outro chat e traz a resposta de volta' }
  ];
  const ENGINE_IDS = ENGINES.map((e) => e.id);

  /** O motor usa a IA na nuvem? ('ai' e 'both') */
  const usesAi = (eng) => eng === 'ai' || eng === 'both';
  /** O motor usa o algoritmo? ('algorithm' e 'both') */
  const usesAlgorithm = (eng) => eng === 'algorithm' || eng === 'both';
  /** O motor é a IA de chat (copiar e colar, sem Analisar)? */
  const usesChat = (eng) => eng === 'chat';

  /** Duração em texto curto: 3:04:10 (ou 4:10). */
  const hms = (sec) => clock(sec);

  /** "1 chamada", "7 chamadas". */
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // "Só os melhores": lista curta, só as sugestões de nota mais alta. É um atalho para a quantidade FIXA abaixo, sem a quantidade
  // automática (pedido do dono, 16/11/2026: recomendar só quando o corte for bom ou forte). Medido numa live de 4 h com Algoritmo + IA:
  // a lista caiu de 80 para 28 sugestões e as que batem com um corte forte ou bom passaram de 39% para 79% (docs/recursos/analysis.md).
  const BEST_ONLY_PER_HOUR = 4;
  /** O que vai no pedido de análise: com "Só os melhores" ligado, quantidade fixa e sem automática; o ajuste guardado continua o da tela. */
  const applyBestOnly = (s) => (s && s.bestOnly ? { ...s, autoQuantity: false, perHour: BEST_ONLY_PER_HOUR } : s);

  function splitKeywords(text) {
    return String(text).split(/[,;\n]/).map((w) => w.trim()).filter(Boolean);
  }

  /** O caminho dos candidatos da IA, só com números: devolvidos pelo modelo, aprovados na conferência, sem repetição, enviados à escolha final, escolhidos e entregues. */
  function compactFunnel(f) {
    const n = (v) => (Number.isFinite(v) ? v : null);
    return {
      returned: n(f.returned), verified: n(f.verified), unique: n(f.unique), offered: n(f.offered), picked: n(f.picked), final: n(f.final),
      perBlock: Array.isArray(f.perBlock) ? f.perBlock.slice(0, 60).map((b) => ({ from: n(b.from), to: n(b.to), returned: n(b.returned), verified: n(b.verified) })) : []
    };
  }

  /** Conferência da IA sobre as sugestões do algoritmo: contagens e a lista do que ela tirou (horário, nota do algoritmo e o motivo dela). */
  function compactReview(r) {
    const n = (v) => (Number.isFinite(v) ? v : 0);
    const list = Array.isArray(r.droppedList) ? r.droppedList : [];
    return {
      sent: n(r.sent), kept: n(r.kept), dropped: n(r.dropped), unanswered: n(r.unanswered), adjusted: n(r.adjusted),
      list: list.slice(0, 150).map((d) => ({ start: d.start, end: d.end, relevance: d.relevance, why: typeof d.why === 'string' ? d.why.slice(0, 160) : '' }))
    };
  }

  /** O que fica no projeto da execução por IA: contagens, os descartes e o que a escolha final deixou de fora (sem texto da transcrição). */
  function compactAi(ai) {
    return {
      provider: ai.provider, model: ai.model, blocks: ai.blocks, failedBlocks: ai.failedBlocks, calls: ai.calls, retries: ai.retries,
      promptTokens: ai.promptTokens, completionTokens: ai.completionTokens, pickUsed: ai.pickUsed, droppedTotal: ai.droppedTotal,
      ...(ai.models && typeof ai.models === 'object' ? { models: ai.models } : {}), // quem de fato respondeu: { modelo: chamadas }
      ...(ai.profile && typeof ai.profile === 'object' ? { profile: ai.profile } : {}), // só contagens do perfil de humor enviado (o texto não fica no projeto)
      ...(ai.skill && ai.skill.custom ? { skill: { custom: true } } : {}), // a análise usou o guia de cortes do usuário (e não o padrão do app)
      ...(ai.funnel && typeof ai.funnel === 'object' ? { funnel: compactFunnel(ai.funnel) } : {}), // quantos candidatos em cada etapa
      ...(Array.isArray(ai.unpicked) && ai.unpicked.length ? { unpicked: ai.unpicked.slice(0, 40).map((u) => ({ start: u.start, end: u.end, title: u.title, relevance: u.relevance })) } : {}),
      droppedByReason: ai.droppedByReason, dropped: Array.isArray(ai.dropped) ? ai.dropped.slice(0, 25).map((d) => ({ reason: d.reason, detail: d.detail, start: d.start, end: d.end, title: d.title })) : []
    };
  }

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

  /** "a IA propôs 42 candidatos, 38 passaram na conferência, a escolha final ficou com 17 de 38" ('' nas análises antigas, sem a contagem). */
  function funnelText(ai) {
    const f = ai && ai.funnel;
    if (!f || !Number.isFinite(f.returned)) return '';
    const parts = [`a IA propôs ${plural(f.returned, 'candidato', 'candidatos')}`];
    if (Number.isFinite(f.verified) && f.verified !== f.returned) parts.push(`${f.verified} ${f.verified === 1 ? 'passou' : 'passaram'} na conferência`);
    if (Number.isFinite(f.picked) && Number.isFinite(f.offered) && f.picked < f.offered) parts.push(`a escolha final ficou com ${f.picked} de ${f.offered}`);
    return parts.join(', ');
  }

  function aiSummaryText(saved, counts) {
    const ai = saved.ai || {};
    const parts = [`${saved.suggestions.length} sugestão(ões) encontrada(s)`];
    if (counts.inCuts) parts.push(`${counts.inCuts} já nos cortes`);
    if (counts.dismissed) parts.push(`${counts.dismissed} descartada(s)`);
    parts.push(`IA: ${[ai.provider, ai.model].filter(Boolean).join(' · ') || 'provedor'}`);
    if (ai.calls) parts.push(`${plural(ai.calls, 'chamada', 'chamadas')}, ~${Math.max(1, Math.round(((ai.promptTokens || 0) + (ai.completionTokens || 0)) / 1000)).toLocaleString('pt-BR')} mil tokens`);
    if (funnelText(ai)) parts.push(funnelText(ai));
    if (ai.profile) parts.push(`perfil do canal enviado: ${humorSentText(ai.profile)}`);
    if (ai.skill && ai.skill.custom) parts.push('com o seu guia de cortes');
    if (ai.failedBlocks) parts.push(`${plural(ai.failedBlocks, 'bloco falhou', 'blocos falharam')}`);
    if (ai.droppedTotal) parts.push(`${ai.droppedTotal} descartada(s) na conferência local`);
    parts.push(`calculado em ${Math.max(1, Math.round((saved.tookMs || 0) / 1000))} s`);
    return parts.join(' · ');
  }

  /** Episódios, telas de espera e ideias fracas descartadas (só o algoritmo acha). */
  function algorithmExtras(saved) {
    const parts = [];
    const episodes = Array.isArray(saved.episodes) ? saved.episodes.length : 0;
    const waitMin = Array.isArray(saved.breaks) ? Math.round(saved.breaks.reduce((sum, b) => sum + (b.end - b.start), 0) / 60) : 0;
    if (episodes > 1) parts.push(`${episodes} episódios`);
    if (Array.isArray(saved.breaks) && saved.breaks.length) parts.push(`telas de espera puladas (${waitMin < 1 ? 'menos de 1' : waitMin} min)`);
    if (saved.filter && saved.filter.on && saved.filter.discarded > 0) parts.push(plural(saved.filter.discarded, 'ideia fraca descartada', 'ideias fracas descartadas'));
    return parts;
  }

  /** "a IA conferiu 63 sugestões do algoritmo e tirou 41 (3 sem resposta)"; com ajuste: "…, tirou 41 e ajustou o início ou o fim de 12". */
  function reviewText(r) {
    const tail = r.unanswered ? ` (${r.unanswered} sem resposta)` : '';
    const head = `a IA conferiu ${plural(r.sent, 'sugestão', 'sugestões')} do algoritmo`;
    return r.adjusted
      ? `${head}, tirou ${r.dropped} e ajustou o início ou o fim de ${r.adjusted}${tail}`
      : `${head} e tirou ${r.dropped}${tail}`;
  }

  /** Resumo do modo Algoritmo + IA: de onde veio cada sugestão, o que o algoritmo usou e o que a IA gastou. */
  function bothSummaryText(saved, counts) {
    const m = saved.merge || {};
    const ai = saved.ai || null;
    const parts = [`${saved.suggestions.length} sugestão(ões) encontrada(s): ${m.both || 0} que os dois acharam, ${m.ai || 0} só da IA, ${m.algorithm || 0} só do algoritmo`];
    if (counts.inCuts) parts.push(`${counts.inCuts} já nos cortes`);
    if (counts.dismissed) parts.push(`${counts.dismissed} descartada(s)`);
    const used = SIGNALS.filter((sig) => saved.signals && saved.signals[sig.id] && saved.signals[sig.id].used).map((sig) => sig.label.toLowerCase());
    if (!m.algorithmFailed) parts.push(`sinais do algoritmo: ${used.join(', ') || 'nenhum'}`);
    parts.push(...algorithmExtras(saved));
    if (ai) {
      parts.push(`IA: ${[ai.provider, ai.model].filter(Boolean).join(' · ') || 'provedor'}`);
      if (ai.calls) parts.push(`${plural(ai.calls, 'chamada', 'chamadas')}, ~${Math.max(1, Math.round(((ai.promptTokens || 0) + (ai.completionTokens || 0)) / 1000)).toLocaleString('pt-BR')} mil tokens`);
      if (funnelText(ai)) parts.push(funnelText(ai));
      if (saved.review && saved.review.sent) parts.push(reviewText(saved.review));
      if (ai.skill && ai.skill.custom) parts.push('com o seu guia de cortes');
      if (ai.failedBlocks) parts.push(`${plural(ai.failedBlocks, 'bloco falhou', 'blocos falharam')}`);
      if (ai.droppedTotal) parts.push(`${ai.droppedTotal} descartada(s) na conferência local`);
    }
    parts.push(`calculado em ${Math.max(1, Math.round((saved.tookMs || 0) / 1000))} s`);
    return parts.join(' · ');
  }

  function summaryText(saved, counts) {
    if (saved.engine === 'ai') return aiSummaryText(saved, counts);
    if (saved.engine === 'both') return bothSummaryText(saved, counts);
    const used = SIGNALS.filter((sig) => saved.signals && saved.signals[sig.id] && saved.signals[sig.id].used).map((sig) => sig.label.toLowerCase());
    const ignored = SIGNALS.filter((sig) => saved.signals && saved.signals[sig.id] && !saved.signals[sig.id].used)
      .map((sig) => `${sig.label.toLowerCase()} (${saved.signals[sig.id].reason || 'ignorado'})`);
    const parts = [`${saved.suggestions.length} sugestão(ões) encontrada(s)`];
    if (counts.inCuts) parts.push(`${counts.inCuts} já nos cortes`);
    if (counts.dismissed) parts.push(`${counts.dismissed} descartada(s)`);
    parts.push(`sinais usados: ${used.join(', ') || 'nenhum'}`);
    const humorHits = saved.signals && saved.signals.text ? saved.signals.text.humorHits : undefined;
    if (typeof humorHits === 'number') parts.push(`perfil do canal: ${plural(humorHits, 'expressão achada', 'expressões achadas')} na fala`);
    parts.push(...algorithmExtras(saved));
    if (ignored.length) parts.push(`ignorados: ${ignored.join('; ')}`);
    const secs = Math.max(1, Math.round((saved.tookMs || 0) / 1000));
    parts.push(saved.fromCache ? 'resultado do cache' : `calculado em ${secs} s`);
    return parts.join(' · ');
  }

  const api = {
    SIGNALS,
    TEXT_WEIGHTS,
    PROFILES,
    SENSITIVITY_LABELS,
    overlapSec,
    isCovered,
    clock,
    eta,
    remainingSec,
    stageRemainingSec,
    pct,
    num,
    pendingSuggestions,
    dismissedSuggestions,
    sameSource,
    MAX_DISMISSED,
    ENGINES,
    ENGINE_IDS,
    usesAi,
    usesAlgorithm,
    usesChat,
    hms,
    plural,
    BEST_ONLY_PER_HOUR,
    applyBestOnly,
    splitKeywords,
    compactFunnel,
    compactReview,
    compactAi,
    humorSummary,
    humorSentText,
    funnelText,
    aiSummaryText,
    algorithmExtras,
    reviewText,
    bothSummaryText,
    summaryText
  };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.BFAnalysisLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);

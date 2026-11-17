'use strict';

/**
 * Análise por IA na nuvem, em DUAS PASSADAS (docs/recursos/analise-ia.md):
 *   1ª  candidatos por BLOCO de transcrição (padrão 35 min, 90 s de sobreposição, teto de tokens por chamada);
 *   2ª  UMA chamada de escolha/ordenação sobre os candidatos já CONFERIDOS (só resumos e horários, nunca o texto inteiro);
 * com a CONFERÊNCIA LOCAL (verify.js) entre as duas: o que a IA inventa (horário, desfecho) é descartado antes de virar sugestão.
 *
 * Falhas: cada chamada tem tentativas limitadas com espera (429 respeita Retry-After, 5xx/rede recuam em escada, JSON inválido
 * pede de novo); erro de chave/modelo/aceite/cota para na hora; um bloco que esgota as tentativas é pulado (até 2 blocos) e a análise
 * segue com os outros, avisando; sem nenhum bloco, falha com mensagem clara (a interface oferece usar o algoritmo).
 * Cancelamento por AbortSignal em qualquer ponto (inclusive durante a espera entre tentativas).
 *
 * CONFERÊNCIA (modo Algoritmo + IA, `request.review`): depois das duas passadas, as sugestões do ALGORITMO que a IA não tinha sugerido
 * vão para ela em lotes, só com o horário e a fala de cada trecho (com a de antes e a de depois), e ela diz se cada uma vale um corte e
 * onde ele deve começar e terminar (o detector pega a reação e perde a premissa). Os horários novos são conferidos aqui (reviewBounds) e
 * saem no veredito, em `review`; quem tira da lista e aplica as bordas é a junção (merge.js). Falha, resposta cortada ou limite de chamadas nunca derrubam a análise nem apagam
 * sugestão: o que ficou sem resposta continua na lista, com aviso.
 */

const { AiError, cancelled, classify } = require('../../ai/errors');
const { normalizeParams, suggestionLimit } = require('../params');
const { SYSTEM_PROMPT, systemPrompt, buildWindowsMessage, buildBlockMessage, buildPickMessage, buildReviewMessage, profileBlock, profileSummary, JSON_NUDGE, estimateTokens, clock } = require('./prompt');
const { normalizeProfile, isEmpty: isEmptyProfile, fold } = require('../humor');
const { normalizeExamples } = require('./humorExamples');
const { buildWindows, packCandidateBlocks, estimate, chatLinesFor, cueLine, OVERHEAD_TOKENS } = require('./chunking');
const { parseCandidates, parseWindowVerdicts, parsePicks, parseReviews } = require('./parse');
const { cuesInRange, round3 } = require('../transcript/format');
const { sameMoment } = require('../merge');
const { normalizeWords, snapWithin } = require('../words');
const { verifyCandidate, dedupe, findPunchline, REASONS, snapStart, snapEnd } = require('./verify');

/**
 * Início e fim que a IA devolveu na conferência -> as bordas novas, conferidas aqui, ou o motivo de não usá-las (`refused`).
 * Valem só horários dentro da fala que ela viu (com a folga de REVIEW_EDGE_TOLERANCE_SEC), levados ao começo e ao fim de uma fala, dentro
 * da duração mínima e máxima e que continuem sendo o MESMO momento (sameMoment, a regra da junção). Sem horário, ou com o horário igual
 * (menos de 1 s de diferença): nada muda. `it` = { start, end, from, to, cues } (o trecho mostrado e a fala dele).
 */
function reviewBounds(v, it, { duration, prefs, words = null }) {
  const hasStart = Number.isFinite(v.start);
  const hasEnd = Number.isFinite(v.end);
  if (!hasStart && !hasEnd) return {};
  const tol = REVIEW_EDGE_TOLERANCE_SEC;
  const s0 = hasStart ? v.start : it.start;
  const e0 = hasEnd ? v.end : it.end;
  if (Math.abs(s0 - it.start) < 1 && Math.abs(e0 - it.end) < 1) return {}; // repetiu os horários sugeridos
  if (!(e0 > s0) || s0 < it.from - tol || e0 > it.to + tol) return { refused: 'fora do trecho mostrado' };
  const s1 = Math.max(0, s0);
  const e1 = Math.min(duration, e0);
  const fits = (s, e) => e - s >= prefs.minDurationSec - 0.01 && e - s <= prefs.maxDurationSec + 0.01;
  const ss = hasStart ? Math.max(0, snapStart(s1, it.cues)) : s1;
  const se = hasEnd ? Math.min(duration, snapEnd(e1, it.cues)) : e1;
  const pick = [[ss, se], [ss, e1], [s1, se], [s1, e1]].find(([s, e]) => fits(s, e));
  if (!pick) return { refused: 'duração' };
  const fine = snapWithin(pick[0], pick[1], words, { minSec: prefs.minDurationSec, maxSec: prefs.maxDurationSec, duration });
  const start = round3(fine.start);
  const end = round3(fine.end);
  if (!sameMoment({ start, end }, it)) return { refused: 'outro momento' };
  if (Math.abs(start - it.start) < 1 && Math.abs(end - it.end) < 1) return {};
  return { bounds: { start, end } };
}

const WINDOW_CONTEXT_SEC = 15; // modo janelas candidatas: fala enviada antes e depois do trecho marcado

const ALGO_VERSION = 4; // versão do método de IA (prompt + conferência); mude quando mudarem (2: sem dicas de volume no pedido; 3: guia de cortes na mensagem de sistema; 4: a conferência acerta início e fim)
const MAX_CANDIDATES_PER_BLOCK = 8;
// QUANTIDADE AUTOMÁTICA (params.autoQuantity): a IA pode devolver mais candidatos por bloco e a escolha final olha mais deles. Numa gameplay
// de 4h18 a seleção feita à mão tem ~9 momentos a cada 35 min (5 fortes ou bons), e os blocos mais ricos passam de 8. O guia de cortes
// continua pedindo para não completar a lista com trechos fracos. NÃO medido com provedor de verdade.
const AUTO_CANDIDATES_PER_BLOCK = 12;
const AUTO_PICK_CANDIDATES = 80;
const PICK_TOKENS_PER_CANDIDATE = 90; // o resumo de cada candidato na escolha final (chunking.js tem a mesma conta)
const MAX_FAILED_WINDOWS = 2;
const MAX_PICK_CANDIDATES = 40;
const MAX_DROPPED_LISTED = 40;
const MAX_UNPICKED_LISTED = 40; // candidatos que a escolha final deixou de fora e ficam listados no resultado
// conferência das sugestões do algoritmo (modo Algoritmo + IA)
const MAX_REVIEW = 240;              // quantas sugestões do algoritmo vão para a conferência, no máximo
const REVIEW_PER_CALL = 35;          // por chamada (cada veredito, com início e fim, custa ~80 tokens de saída; 63 trechos de uma live de 4 h cabem em 2)
// fala mostrada antes e depois do corte: o detector pega a reação e perde a premissa. Na gameplay medida (16/11/2026), dos cortes do
// algoritmo que tocavam um momento bom, 4 de 27 começavam de 9 a 62 s depois dele e 13 de 27 terminavam mais de 5 s antes do fim dele.
const REVIEW_BEFORE_SEC = 40;
const REVIEW_AFTER_SEC = 15;
const REVIEW_EDGE_TOLERANCE_SEC = 2; // o horário devolvido pode passar esse tanto da fala mostrada
const REVIEW_CHAT_AFTER_SEC = 30;    // o chat reage com atraso
const REVIEW_MAX_CHAT_LINES = 10;    // por trecho
const OUTPUT_MAX_TOKENS_REVIEW = 6000;
// Modelos que "pensam" (ex.: Gemini 2.5) gastam parte do limite de saída raciocinando: o teto é folgado (só se paga o que é gerado)
// e, se a resposta vier cortada sem JSON, a tentativa seguinte pede mais espaço (até MAX_OUTPUT_TOKENS). Medido em rede real
// (23/10/2026, Nemotron 3 Ultra gratuito): 3 de 5 blocos gastaram de 3 a 3,4 mil dos 6000 tokens só raciocinando e um bloco e a escolha final
// saíram CORTADOS pelo limite (a escolha ficou com 7 de até 18 sugestões). Por isso: (1) a escolha final ganhou o mesmo teto dos blocos;
// (2) o limite cresce a partir da primeira resposta cortada e vale para as chamadas seguintes; (3) a escolha final cortada é pedida de novo
// UMA vez com mais espaço (a lista inteira é o valor dela); (4) o prazo da chamada cresce com o limite de saída.
const OUTPUT_MAX_TOKENS_BLOCK = 6000;
const OUTPUT_MAX_TOKENS_PICK = 6000;
const AUTO_OUTPUT_MAX_TOKENS_BLOCK = 9000; // quantidade automática: até 12 candidatos por bloco
const MAX_OUTPUT_TOKENS = 16000;
const OUTPUT_GROWTH = 1.6;
// Um modelo gratuito que raciocina levou de 77 s a 279 s por chamada de ~6000 tokens (o prazo fixo de 120 s do cliente o cortaria):
// 60 ms por token de saída pedido, de 2 a 10 minutos.
const MIN_CALL_TIMEOUT_MS = 120000;
const MAX_CALL_TIMEOUT_MS = 600000;
const MS_PER_OUTPUT_TOKEN = 60;

const growOutput = (tokens) => Math.min(MAX_OUTPUT_TOKENS, Math.round(tokens * OUTPUT_GROWTH));
const callTimeoutMs = (maxTokens) => Math.min(MAX_CALL_TIMEOUT_MS, Math.max(MIN_CALL_TIMEOUT_MS, Math.round(maxTokens * MS_PER_OUTPUT_TOKEN)));

const DEFAULT_RETRY = Object.freeze({ baseDelayMs: 2000, maxDelayMs: 30000, maxRetryAfterSec: 90 });

/** Espera `ms` (cancelável por `signal`). */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(cancelled()); return; }
    const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(cancelled()); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Uma chamada ao modelo com tentativas limitadas. `parse(text, res)` lê a resposta (lança AiError BAD_JSON se não presta).
 * Devolve { parsed, res, limit } (`limit` = o limite de saída da tentativa que deu certo). `stats` acumula chamadas, tentativas extras e tokens.
 */
async function callWithRetry({ chat, system, userContent, maxTokens, parse, signal, sleepFn, attempts, retry, stats, onRetry, grow = growOutput }) {
  const policy = { ...DEFAULT_RETRY, ...(retry || {}) };
  let nudge = false;
  let limit = maxTokens;
  for (let attempt = 1; ; attempt += 1) {
    if (signal && signal.aborted) throw cancelled();
    const content = nudge ? `${userContent}\n\n${JSON_NUDGE}` : userContent;
    try {
      stats.calls += 1;
      const res = await chat({ system, messages: [{ role: 'user', content }], maxTokens: limit, temperature: 0.2, jsonMode: true, signal, timeoutMs: callTimeoutMs(limit) });
      stats.promptTokens += res.usage && res.usage.promptTokens != null ? res.usage.promptTokens : estimateTokens(system) + estimateTokens(content);
      stats.completionTokens += res.usage && res.usage.completionTokens != null ? res.usage.completionTokens : estimateTokens(res.text);
      // quem de fato respondeu (o campo `model` da resposta; com o roteador gratuito do OpenRouter é o modelo sorteado), por quantas chamadas
      const answered = typeof res.answeredModel === 'string' && res.answeredModel ? res.answeredModel : (typeof res.model === 'string' && res.model ? res.model : '');
      if (answered) {
        stats.models = stats.models || {};
        stats.models[answered] = (stats.models[answered] || 0) + 1;
      }
      try {
        return { parsed: parse(res.text, res), res, limit };
      } catch (parseErr) {
        if (parseErr && parseErr.code === 'BAD_JSON' && res.finishReason === 'length') parseErr.truncated = true; // cortada pelo limite de saída
        throw parseErr;
      }
    } catch (err) {
      if (err && err.code === 'CANCELLED') throw err;
      const badJson = Boolean(err) && err.code === 'BAD_JSON';
      const verdict = badJson ? { retry: true, kind: 'json' } : classify(err);
      if (!verdict.retry) throw err;
      if (attempt >= attempts) {
        const out = new AiError(err.code || 'SERVER', err.message, { attempts: attempt, kind: verdict.kind });
        out.status = err.status;
        throw out;
      }
      let waitMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      if (verdict.kind === 'rate') {
        const ra = verdict.retryAfterSec;
        if (Number.isFinite(ra) && ra > policy.maxRetryAfterSec) {
          throw new AiError('QUOTA', `O provedor pediu para esperar ${ra >= 120 ? `${Math.round(ra / 60)} min` : `${ra} s`}: a cota de uso parece esgotada. Tente mais tarde, troque de provedor ou use o algoritmo.`, { retryAfterSec: ra });
        }
        if (Number.isFinite(ra)) waitMs = Math.max(waitMs, ra * 1000);
      }
      if (verdict.kind === 'json') nudge = true;
      if (err && err.truncated) limit = grow(limit);
      stats.retries += 1;
      if (onRetry) { try { onRetry({ attempt, waitMs, kind: verdict.kind }); } catch { /* aviso opcional */ } }
      await sleepFn(waitMs, signal);
    }
  }
}

/** Mensagem clara quando a análise por IA falha de vez. */
function failureMessage(err) {
  const code = err && err.code;
  const tail = ' Você pode tentar de novo ou usar o algoritmo.';
  if (code === 'AUTH') return `${err.message}${tail}`;
  if (code === 'MODEL') return `${err.message}${tail}`;
  if (code === 'QUOTA' || code === 'RATE_LIMIT') return `${err.message}${code === 'RATE_LIMIT' ? ' Mesmo esperando, o limite não liberou.' : ''}${tail}`;
  if (code === 'NETWORK' || code === 'TIMEOUT' || code === 'INTERRUPTED' || code === 'SERVER') return `${err.message} Várias tentativas falharam.${tail}`;
  if (code === 'BAD_JSON') return `A IA não conseguiu responder no formato pedido, mesmo depois de novas tentativas.${tail}`;
  return `${err && err.message ? err.message : 'A análise por IA falhou.'}${tail}`;
}

/**
 * @param {object} request {
 *   duration, hasAudio, params (parâmetros da análise: normalizeParams), transcript: { cues }, chat: bf-chat-1 | null,
 *   meta: { title?, channel?, game? }, existingCuts: [{start,end}],
 *   profile?: perfil de humor do canal (humor.js), examples?: { approved, rejected } (humorExamples.js; só entram se o perfil deixa),
 *   skill?: as instruções do guia de cortes do USUÁRIO (skill.js); vazio = o guia padrão do app }
 * @param {object} deps { chat(params) -> { text, usage, finishReason }, provider: { label, model }, limits: { maxCalls, maxInputTokens, windowMinutes, attempts },
 *   signal, onProgress({ p, stage, message }), sleep?, retry? }
 */
async function analyzeWithAi(request, deps) {
  const startedAt = Date.now();
  const signal = deps.signal || null;
  const check = () => { if (signal && signal.aborted) throw cancelled(); };
  check();
  const params = normalizeParams(request.params);
  const { duration, transcript } = request;
  const limits = deps.limits;
  // teto de SAÍDA por chamada: quando um provedor da cadeia tem limite por minuto baixo (limits.maxOutputTokens, do runtime), nenhum pedido de
  // saída passa dele, nem o que cresce depois de uma resposta cortada
  const outCap = Number.isFinite(limits.maxOutputTokens) && limits.maxOutputTokens > 0 ? Math.max(512, Math.round(limits.maxOutputTokens)) : MAX_OUTPUT_TOKENS;
  const growOutput = (tokens) => Math.min(outCap, Math.round(tokens * OUTPUT_GROWTH));
  const sleepFn = deps.sleep || sleep;
  // stageP (opcional): quanto da etapa já foi (na 1ª passada, os blocos prontos); a tela estima o tempo restante por ele
  const report = (p, stage, message, stageP) => { if (deps.onProgress) { try { deps.onProgress({ p: Math.min(0.99, Math.max(0, p)), stage, message, ...(typeof stageP === 'number' ? { stageP } : {}) }); } catch { /* ouvinte com defeito */ } } };
  if (!transcript || !Array.isArray(transcript.cues) || !transcript.cues.length) throw new AiError('NO_TRANSCRIPT', 'A análise por IA precisa da transcrição do vídeo. Gere ou importe uma na aba Análise.');
  if (!(duration > 0)) throw new AiError('INVALID_ARGS', 'Não sei a duração do vídeo.');

  const prefs = {
    minDurationSec: params.minDurationSec, maxDurationSec: params.maxDurationSec, padBeforeSec: params.padBeforeSec,
    padAfterSec: params.padAfterSec, minRelevance: params.minRelevance, keywords: params.chat.keywords,
    profile: params.profile // o tipo de vídeo (gameplay ou conversa) vai em cada pedido: o guia de cortes diz o que rende em cada um
  };
  // perfil de humor do canal: critérios, bordões e palavras sempre que existem; os exemplos só se o perfil deixa (`examples`) e o chamador os trouxe
  const profile = normalizeProfile(request.profile);
  const useProfile = !isEmptyProfile(profile);
  const examples = useProfile && profile.examples ? normalizeExamples(request.examples) : { approved: [], rejected: [] };
  const blockProfile = useProfile ? profileBlock(profile, examples) : '';
  const pickProfile = useProfile ? profileSummary(profile) : '';
  // guia de cortes: o do usuário (se escreveu um) entra na mensagem de sistema no lugar do padrão; a diferença de tamanho conta no limite de tokens
  const skillBody = typeof request.skill === 'string' ? request.skill.trim() : '';
  const system = skillBody ? systemPrompt(skillBody) : SYSTEM_PROMPT;
  const skillExtra = Math.max(0, estimateTokens(system) - estimateTokens(SYSTEM_PROMPT));

  const words = normalizeWords(transcript.words); // palavras com tempo (só transcrição gerada); sem elas vale o ajuste por falas
  const limit = suggestionLimit(params, duration);
  const perBlock = params.autoQuantity ? AUTO_CANDIDATES_PER_BLOCK : MAX_CANDIDATES_PER_BLOCK;
  // a escolha final recebe só resumos, mas cabe no teto de entrada da chamada (importa quando o teto é pequeno: limite por minuto baixo)
  const pickRoom = Math.floor((limits.maxInputTokens - OVERHEAD_TOKENS - estimateTokens(pickProfile) - skillExtra - 400) / PICK_TOKENS_PER_CANDIDATE);
  const pickMax = Math.max(8, Math.min(params.autoQuantity ? AUTO_PICK_CANDIDATES : MAX_PICK_CANDIDATES, pickRoom));
  // MODO JANELAS CANDIDATAS (opcional): o filtro local (candidates.js, chamado pelo manager) mandou só os trechos onde pode haver corte;
  // a IA vê só eles (com 15 s de contexto de cada lado) em poucas chamadas. Sem janelas (ou nenhuma com fala) vale o método de blocos.
  const profileTokens = estimateTokens(blockProfile) + skillExtra;
  let windows = Array.isArray(request.candidateWindows) && request.candidateWindows.length
    ? packCandidateBlocks(request.candidateWindows, transcript.cues, duration, { maxInputTokens: limits.maxInputTokens, chat: request.chat, profileTokens, contextSec: WINDOW_CONTEXT_SEC })
    : [];
  const windowMode = windows.length > 0;
  if (!windowMode) {
    windows = buildWindows(transcript.cues, duration, { windowSec: limits.windowMinutes * 60, maxInputTokens: limits.maxInputTokens, chat: request.chat, profileTokens });
  }
  const winStats = { sent: 0, valid: 0, rejected: 0, unanswered: 0, phraseMissing: 0 };
  if (windowMode) winStats.sent = windows.reduce((n, b) => n + b.packed.length, 0);
  const est = estimate(windows, { candidatesPerBlock: windowMode ? Math.max(...windows.map((b) => b.packed.length)) : perBlock, pickExtraTokens: estimateTokens(pickProfile) + skillExtra });
  if (!windows.length) throw new AiError('NO_TRANSCRIPT', 'A transcrição não tem nenhuma fala para enviar.');
  if (est.calls > limits.maxCalls) {
    const why = limits.limitedBy ? ` Os blocos ficaram menores (~${limits.maxInputTokens} tokens) para caber no limite de ${limits.limitedBy.tokensPerMinute.toLocaleString('pt-BR')} tokens por minuto de ${limits.limitedBy.label}; sem esse provedor de reserva, seriam menos chamadas.` : '';
    throw new AiError('TOO_MANY_CALLS', `Esta análise precisaria de ~${est.calls} chamadas, mais que o limite de ${limits.maxCalls}.${why} Aumente o limite nas configurações da IA ou use o algoritmo.`, { calls: est.calls, limit: limits.maxCalls });
  }

  const stats = { calls: 0, retries: 0, promptTokens: 0, completionTokens: 0, models: {} };
  const warnings = [];
  const dropped = [];
  const dropCount = {};
  const drop = (reason, detail, c) => {
    dropCount[reason] = (dropCount[reason] || 0) + 1;
    if (dropped.length < MAX_DROPPED_LISTED) dropped.push({ reason, detail, start: c.start, end: c.end, title: c.title || '' });
  };

  const accepted = [];
  const failedWindows = [];
  // por bloco: quantos candidatos o modelo devolveu e quantos passaram na conferência (null = o bloco não respondeu)
  const blockStats = windows.map((w) => ({ from: w.from, to: w.to, returned: null, verified: null }));
  let lastFailure = null;
  const shareBlocks = 0.84;
  const retryNote = (i) => ({ attempt, waitMs, kind }) => report(shareBlocks * (i / windows.length), 'ai1', `${kind === 'rate' ? 'Limite do provedor' : kind === 'json' ? 'Resposta fora do formato' : 'Falha de conexão'}: nova tentativa em ${Math.max(1, Math.round(waitMs / 1000))} s (${attempt + 1} de ${limits.attempts})…`);

  // limite de saída por chamada: começa nos padrões e CRESCE quando uma resposta vem cortada (modelo que raciocina), valendo para as seguintes
  // na quantidade automática cada bloco pode trazer 12 candidatos: o limite de saída já começa mais folgado (só se paga o que é gerado)
  const budget = { block: Math.min(outCap, params.autoQuantity ? AUTO_OUTPUT_MAX_TOKENS_BLOCK : OUTPUT_MAX_TOKENS_BLOCK), pick: Math.min(outCap, OUTPUT_MAX_TOKENS_PICK) };

  /** Janela candidata + veredito da IA -> início e fim, achados pelas FRASES na transcrição (por palavra, se há). { ok, start, end, detail } */
  const resolvePhrases = (v, w) => {
    const from = w.ctxFrom - 1;
    const to = w.ctxTo + 1;
    const inRange = words.length ? words.filter((q) => q.end >= from && q.start <= to) : cuesInRange(transcript.cues, from, to);
    const open = v.startPhrase ? findPunchline(v.startPhrase, inRange) : null;
    let start = open ? open.start : null;
    // o modelo não precisa dar horário; se deu e está dentro da janela, só vale quando a frase de abertura não foi achada
    if (start === null && Number.isFinite(v.start) && v.start >= w.ctxFrom - 2 && v.start <= w.ctxTo) start = v.start;
    if (start === null) return { ok: false, detail: 'a frase de abertura não existe na transcrição da janela' };
    const after = inRange.filter((q) => q.start >= start - 0.01);
    const close = v.endPhrase ? findPunchline(v.endPhrase, after) : null;
    let end = close ? close.end : null;
    if (end === null && Number.isFinite(v.end) && v.end > start && v.end <= w.ctxTo + 2) end = v.end;
    if (end === null) return { ok: false, detail: 'a frase de encerramento não existe na transcrição da janela' };
    if (!(end - start >= 3)) return { ok: false, detail: 'a frase de encerramento vem antes ou junto da abertura' };
    return { ok: true, start, end };
  };

  /** Resposta de um bloco de JANELAS: um veredito por janela; as frases viram horários e o resto da conferência é a de sempre. */
  const takeWindowBlock = (outcome, i, win) => {
    const { items, invalid, salvaged } = outcome.parsed;
    if (invalid) dropCount.format = (dropCount.format || 0) + invalid;
    if (salvaged) warnings.push({ code: 'AI_TRUNCATED', message: `A resposta do bloco ${i + 1} veio cortada; só os vereditos completos foram aproveitados.` });
    const seen = new Set();
    let passed = 0;
    for (const v of items) {
      const w = win.packed.find((p) => p.id === v.id);
      if (!w || seen.has(w.id)) { dropCount.format = (dropCount.format || 0) + 1; continue; } // id inventado ou repetido
      seen.add(w.id);
      if (!v.valid) { winStats.rejected += 1; continue; }
      winStats.valid += 1;
      const found = resolvePhrases(v, w);
      if (!found.ok) { winStats.phraseMissing += 1; drop('phrase', found.detail, { start: w.from, end: w.to, title: v.title }); continue; }
      const c = {
        start: found.start, end: found.end, title: v.title, category: v.category, relevance: v.hookScore == null ? 0.5 : Math.round(v.hookScore * 10) / 100,
        hook: v.startPhrase, punchline: v.endPhrase, reasons: v.reasons, keywords: v.keywords, theme: '', layout: '', flags: []
      };
      const r = verifyCandidate(c, { cues: transcript.cues, words, duration, window: { from: w.ctxFrom, to: w.ctxTo }, prefs, existing: request.existingCuts });
      if (r.ok) { accepted.push({ ...r.suggestion, block: i }); passed += 1; } else drop(r.reason, r.detail, c);
    }
    winStats.unanswered += win.packed.filter((p) => !seen.has(p.id)).length;
    blockStats[i].returned = items.length + (invalid || 0);
    blockStats[i].verified = passed;
  };

  /** Aproveita a resposta de um bloco: confere cada candidato com a transcrição e guarda o que passa. */
  const takeBlockClassic = (outcome, i, win) => {
    const { items, invalid, salvaged } = outcome.parsed;
    if (invalid) dropCount.format = (dropCount.format || 0) + invalid;
    if (salvaged) warnings.push({ code: 'AI_TRUNCATED', message: `A resposta do bloco ${i + 1} veio cortada; só os cortes completos foram aproveitados.` });
    let passed = 0;
    for (const c of items) {
      const v = verifyCandidate(c, { cues: transcript.cues, words, duration, window: win, prefs, existing: request.existingCuts });
      if (v.ok) { accepted.push({ ...v.suggestion, block: i }); passed += 1; } else drop(v.reason, v.detail, c);
    }
    blockStats[i].returned = items.length + (invalid || 0);
    blockStats[i].verified = passed;
  };
  const takeBlock = windowMode ? takeWindowBlock : takeBlockClassic;
  const askBlock = (i, win) => callWithRetry({
    chat: deps.chat, system,
    userContent: windowMode
      ? buildWindowsMessage({ block: win, meta: request.meta, duration, prefs, profile: blockProfile })
      : buildBlockMessage({ window: win, meta: request.meta, duration, prefs, maxCandidates: perBlock, profile: blockProfile }),
    maxTokens: budget.block, parse: (text) => (windowMode ? parseWindowVerdicts(text) : parseCandidates(text)), signal, sleepFn, attempts: limits.attempts, retry: deps.retry, stats, onRetry: retryNote(i), grow: growOutput
  });

  // ---- 1ª passada: candidatos por bloco ----
  for (let i = 0; i < windows.length; i += 1) {
    check();
    const win = windows[i];
    report(shareBlocks * (i / windows.length), 'ai1', `Analisando o bloco ${i + 1} de ${windows.length} (${clock(win.from)} a ${clock(win.to)})…`, i / windows.length);
    let outcome;
    try {
      outcome = await askBlock(i, win);
      budget.block = Math.max(budget.block, outcome.limit);
      if (outcome.res && outcome.res.finishReason === 'length') {
        budget.block = growOutput(outcome.limit);
        // cortada pelo limite de saída: os candidatos que não couberam se perdem (visto com provedor de verdade, num modelo que raciocina:
        // o bloco mais rico voltou com menos cortes). Pede o MESMO bloco de novo, uma vez, com mais espaço, se o limite de chamadas deixa.
        // Só quando o JSON veio cortado no meio (`salvaged`): se veio inteiro, nada se perdeu
        if (outcome.parsed.salvaged && stats.calls < limits.maxCalls) {
          report(shareBlocks * (i / windows.length), 'ai1', `A resposta do bloco ${i + 1} veio cortada pelo limite de saída da IA: pedindo de novo com mais espaço…`);
          try {
            const again = await askBlock(i, win);
            budget.block = Math.max(budget.block, again.limit);
            if (again.res && again.res.finishReason === 'length') budget.block = growOutput(again.limit);
            if (again.parsed.items.length >= outcome.parsed.items.length) outcome = again;
          } catch (againErr) {
            if (againErr && againErr.code === 'CANCELLED') throw againErr;
            // o segundo pedido falhou: vale a primeira resposta, mesmo cortada
          }
        }
      }
    } catch (err) {
      if (err && err.code === 'CANCELLED') throw err;
      const verdict = err && err.code === 'BAD_JSON' ? { retry: true } : classify(err);
      lastFailure = err;
      // erros que não melhoram tentando outro bloco (chave, modelo, aceite, cota, pedido recusado) param tudo
      if (!verdict.retry) throw Object.assign(new AiError(err.code || 'ERROR', failureMessage(err), { done: i, total: windows.length }), { status: err.status });
      failedWindows.push({ index: i, from: win.from, to: win.to, code: err.code || 'ERROR' });
      if (failedWindows.length > MAX_FAILED_WINDOWS || failedWindows.length === windows.length) {
        throw Object.assign(new AiError(err.code || 'ERROR', failureMessage(err), { done: i + 1 - failedWindows.length, total: windows.length }), { status: err.status });
      }
      continue;
    }
    takeBlock(outcome, i, win);
  }

  // ---- segunda chance: o bloco que falhou (servidor sobrecarregado, rede, limite por minuto) é pedido de novo no fim, quando o problema
  // costuma ter passado. Visto com provedor de verdade: um bloco de 35 min ficou de fora por HTTP 503 depois de 3 tentativas em poucos
  // segundos, e era o bloco com mais momentos da live. Só se o limite de chamadas deixa; falhar de novo só mantém o bloco de fora.
  for (const failed of [...failedWindows]) {
    check();
    if (stats.calls >= limits.maxCalls) break;
    const i = failed.index;
    const win = windows[i];
    report(shareBlocks, 'ai1', `Tentando de novo o bloco ${i + 1} de ${windows.length} (${clock(win.from)} a ${clock(win.to)}), que tinha falhado…`);
    try {
      const outcome = await askBlock(i, win);
      budget.block = Math.max(budget.block, outcome.limit);
      takeBlock(outcome, i, win);
      failedWindows.splice(failedWindows.indexOf(failed), 1);
      stats.recoveredBlocks = (stats.recoveredBlocks || 0) + 1;
    } catch (err) {
      if (err && err.code === 'CANCELLED') throw err;
      lastFailure = err; // continua de fora; o aviso abaixo diz qual trecho
    }
  }
  if (failedWindows.length) {
    const spans = failedWindows.map((f) => `${clock(f.from)}–${clock(f.to)}`).join(', ');
    warnings.push({ code: 'AI_BLOCKS_FAILED', message: `${failedWindows.length} bloco(s) não puderam ser analisados (${spans}) e ficaram de fora. ${lastFailure && lastFailure.message ? lastFailure.message : ''}`.trim() });
  }

  if (windowMode && winStats.unanswered) warnings.push({ code: 'AI_WINDOWS_UNANSWERED', message: `A IA não respondeu ${winStats.unanswered} das ${winStats.sent} janelas candidatas; elas ficaram de fora.` });

  // ---- junta os blocos: o mesmo momento achado duas vezes (sobreposição) fica uma vez só ----
  const merged = dedupe(accepted);
  for (const d of merged.dropped) drop('duplicate', REASONS.duplicate, d);
  let ranked = merged.kept.slice(0, pickMax);
  ranked.forEach((c, k) => { c.cid = `c${k + 1}`; });
  const offered = ranked.length; // quantos candidatos foram para a escolha final
  let pickedCount = null;        // quantos ela devolveu (null = não houve escolha final, ou ela falhou)
  let unpicked = [];             // os que ela deixou de fora: passaram na conferência, mas a IA preferiu outros

  // ---- 2ª passada: escolha e ordenação ----
  let pickUsed = false;
  if (ranked.length >= 2) {
    check();
    report(shareBlocks, 'ai2', `Escolhendo os melhores entre ${ranked.length} candidatos…`);
    try {
      const askPick = (maxTokens) => callWithRetry({
        chat: deps.chat, system,
        userContent: buildPickMessage({ candidates: ranked, meta: request.meta, duration, limit, prefs, profile: pickProfile }),
        maxTokens, parse: (text) => parsePicks(text), signal, sleepFn, attempts: limits.attempts, retry: deps.retry, stats, grow: growOutput,
        onRetry: ({ attempt, waitMs }) => report(shareBlocks, 'ai2', `Nova tentativa da escolha final em ${Math.max(1, Math.round(waitMs / 1000))} s (${attempt + 1} de ${limits.attempts})…`)
      });
      let picked = await askPick(budget.pick);
      // cortada pelo limite de saída: a lista inteira é o valor desta chamada, então pede de novo UMA vez com mais espaço (se o limite de chamadas deixa)
      if (picked.res && picked.res.finishReason === 'length' && stats.calls < limits.maxCalls) {
        report(shareBlocks, 'ai2', 'A escolha final veio cortada pelo limite de saída da IA: pedindo de novo com mais espaço…');
        try {
          const again = await askPick(growOutput(picked.limit));
          if (again.parsed.picks.length >= picked.parsed.picks.length) picked = again;
        } catch (againErr) {
          if (againErr && againErr.code === 'CANCELLED') throw againErr;
          // o segundo pedido falhou: vale a primeira resposta, mesmo cortada
        }
      }
      const { parsed, res: pickRes } = picked;
      if (pickRes && pickRes.finishReason === 'length') warnings.push({ code: 'AI_PICK_TRUNCATED', message: 'A resposta da escolha final veio cortada pelo limite de saída da IA; só as escolhas completas foram aproveitadas.' });
      const byId = new Map(ranked.map((c) => [c.cid, c]));
      const chosen = [];
      const seen = new Set();
      for (const pick of parsed.picks) {
        const c = byId.get(pick.id);
        if (!c || seen.has(c.cid)) continue; // id inventado ou repetido: ignora
        seen.add(c.cid);
        chosen.push({
          ...c,
          relevance: pick.relevance == null ? c.relevance : Math.round(pick.relevance * 100) / 100,
          title: pick.title || c.title, category: pick.category || c.category, reasons: pick.reasons.length ? pick.reasons : c.reasons
        });
      }
      if (chosen.length) { unpicked = ranked.filter((c) => !seen.has(c.cid)); pickedCount = chosen.length; ranked = chosen; pickUsed = true; } else warnings.push({ code: 'AI_PICK_EMPTY', message: 'A escolha final da IA não trouxe nenhum corte válido; foi usada a ordem da primeira passada.' });
    } catch (err) {
      if (err && err.code === 'CANCELLED') throw err;
      if (!classify(err).retry && err.code !== 'BAD_JSON') throw Object.assign(new AiError(err.code || 'ERROR', failureMessage(err)), { status: err.status });
      warnings.push({ code: 'AI_PICK_FAILED', message: 'A escolha final da IA falhou; foi usada a ordem da primeira passada.' });
    }
  }

  // ---- final: relevância mínima, teto de sugestões, ordem ----
  const final = [];
  for (const c of ranked) {
    if (c.relevance < prefs.minRelevance) { drop('relevance', `${Math.round(c.relevance * 100)}% (mínimo ${Math.round(prefs.minRelevance * 100)}%)`, c); continue; }
    final.push(c);
  }
  final.sort((a, b) => b.relevance - a.relevance);
  const top = final.slice(0, limit);
  // o tema que a IA cita só vale se for um dos temas do perfil (escrito como o dono escreveu, sem diferenciar acento nem caixa); senão não entra
  const themeKey = new Map(profile.themes.map((t) => [fold(t), t]));
  const suggestions = top.map((c) => {
    const reasons = [...c.reasons];
    if (c.flags.includes('revisar_sensivel')) reasons.push('revisar: conteúdo sensível');
    const out = { id: c.id, start: c.start, end: c.end, peak: c.peak, relevance: c.relevance, reasons, title: c.title || '', category: c.category || '' };
    if (c.layout) out.layout = c.layout;
    if (c.flags.length) out.flags = c.flags;
    const theme = c.theme ? themeKey.get(fold(c.theme)) : '';
    if (theme) out.theme = theme;
    if (c.keywords && c.keywords.length) out.keywords = c.keywords;
    return out;
  });
  // ---- conferência das sugestões do algoritmo: só as que a IA não sugeriu por conta própria ----
  const reviewList = (Array.isArray(request.review) ? request.review : [])
    .filter((c) => c && c.id != null && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    .map((c) => ({ id: String(c.id), start: Number(c.start), end: Number(c.end) }))
    .filter((c) => !suggestions.some((s) => sameMoment(s, c)))
    .slice(0, MAX_REVIEW);
  const review = { sent: reviewList.length, kept: 0, dropped: 0, unanswered: 0, adjusted: 0, boundsRefused: 0, calls: 0, verdicts: [] };
  if (reviewList.length) {
    const items = reviewList.map((c, k) => {
      const from = Math.max(0, c.start - REVIEW_BEFORE_SEC);
      const to = Math.min(duration, c.end + REVIEW_AFTER_SEC);
      const cues = cuesInRange(transcript.cues, from, to);
      return {
        rid: `a${k + 1}`, id: c.id, start: c.start, end: c.end, from, to, cues,
        before: cues.filter((q) => q.start < c.start - 0.5).map(cueLine),
        lines: cues.filter((q) => q.start >= c.start - 0.5 && q.start < c.end).map(cueLine),
        after: cues.filter((q) => q.start >= c.end).map(cueLine),
        chatLines: chatLinesFor(request.chat, c.start, c.end + REVIEW_CHAT_AFTER_SEC).slice(0, REVIEW_MAX_CHAT_LINES)
      };
    });
    // lotes: cabem no teto de tokens de entrada de uma chamada e têm no máximo REVIEW_PER_CALL trechos (menos, se o teto de saída é baixo:
    // cada veredito custa ~100 tokens de saída)
    const perCall = Math.max(5, Math.min(REVIEW_PER_CALL, Math.floor(outCap / 100)));
    const room = Math.max(2000, limits.maxInputTokens - estimateTokens(system) - estimateTokens(pickProfile) - 400);
    const batches = [];
    let cur = [];
    let used = 0;
    for (const it of items) {
      const cost = estimateTokens([...it.before, ...it.lines, ...it.after].join('\n')) + estimateTokens(it.chatLines.join('\n')) + 40;
      if (cur.length && (used + cost > room || cur.length >= perCall)) { batches.push(cur); cur = []; used = 0; }
      cur.push(it); used += cost;
    }
    if (cur.length) batches.push(cur);
    const answered = new Map(); // rid -> veredito
    const askReview = (batch, maxTokens, k) => callWithRetry({
      chat: deps.chat, system,
      userContent: buildReviewMessage({ items: batch, meta: request.meta, duration, prefs, profile: pickProfile }),
      maxTokens, parse: (text) => parseReviews(text), signal, sleepFn, attempts: limits.attempts, retry: deps.retry, stats, grow: growOutput,
      onRetry: ({ attempt, waitMs }) => report(0.9, 'ai3', `Nova tentativa da conferência em ${Math.max(1, Math.round(waitMs / 1000))} s (${attempt + 1} de ${limits.attempts})…`, k / batches.length)
    });
    let failed = false;
    let capped = false; // o limite de chamadas da análise acabou antes de a conferência terminar
    for (let k = 0; k < batches.length && !failed; k += 1) {
      check();
      if (stats.calls >= limits.maxCalls) { capped = true; break; } // sem chamadas sobrando: o resto fica sem resposta (e na lista)
      report(0.9 + 0.09 * (k / batches.length), 'ai3', `Conferindo ${reviewList.length} sugestões do algoritmo (${k + 1} de ${batches.length})…`, k / batches.length);
      let pending = batches[k];
      // se a resposta vier cortada, pede UMA vez só os que faltaram, com mais espaço
      for (let round = 0; round < 2 && pending.length; round += 1) {
        if (stats.calls >= limits.maxCalls) { capped = true; break; }
        try {
          const out = await askReview(pending, round === 0 ? Math.min(outCap, OUTPUT_MAX_TOKENS_REVIEW) : growOutput(OUTPUT_MAX_TOKENS_REVIEW), k);
          review.calls += 1;
          const known = new Set(pending.map((it) => it.rid));
          for (const v of out.parsed.reviews) if (known.has(v.id) && !answered.has(v.id)) answered.set(v.id, v);
          const truncated = out.res && out.res.finishReason === 'length';
          pending = pending.filter((it) => !answered.has(it.rid));
          if (!truncated) break;
        } catch (err) {
          if (err && err.code === 'CANCELLED') throw err;
          failed = true; // a análise já tem resultado: a conferência que falha só deixa de tirar sugestões
          warnings.push({ code: 'AI_REVIEW_FAILED', message: `A conferência das sugestões do algoritmo pela IA falhou (${failureMessage(err)}). As que ficaram sem resposta continuam na lista.` });
          break;
        }
      }
    }
    for (const it of items) {
      const v = answered.get(it.rid);
      if (!v) { review.unanswered += 1; continue; }
      if (v.keep) review.kept += 1; else review.dropped += 1;
      const verdict = { id: it.id, keep: v.keep, relevance: v.relevance, title: v.title, category: v.category, reasons: v.reasons };
      if (v.keep) {
        const b = reviewBounds(v, it, { duration, prefs, words });
        if (b.bounds) { verdict.start = b.bounds.start; verdict.end = b.bounds.end; review.adjusted += 1; } else if (b.refused) review.boundsRefused += 1;
      }
      review.verdicts.push(verdict);
    }
    if (review.unanswered && !failed) {
      warnings.push({ code: 'AI_REVIEW_PARTIAL', message: capped
        ? `A conferência das sugestões do algoritmo não coube no limite de ${limits.maxCalls} chamadas desta análise: ${review.unanswered} das ${review.sent} ficaram sem resposta e continuam na lista. Para conferir todas, aumente o limite de chamadas nas configurações da IA.`
        : `A IA não respondeu sobre ${review.unanswered} das ${review.sent} sugestões do algoritmo enviadas para conferência; elas continuam na lista.` });
    }
  }

  const droppedTotal = Object.values(dropCount).reduce((n, v) => n + v, 0);
  if (!suggestions.length) warnings.push({ code: 'AI_NO_RESULT', message: droppedTotal ? 'A IA não sugeriu nenhum momento que passasse na conferência local (veja os descartes abaixo).' : 'A IA não encontrou momentos que valessem um corte.' });

  report(0.995, 'done', 'Análise concluída.');
  return {
    version: ALGO_VERSION,
    engine: 'ai',
    at: new Date().toISOString(),
    fromCache: false,
    tookMs: Date.now() - startedAt,
    source: { duration, hasAudio: request.hasAudio !== false },
    params,
    signals: {
      transcript: { used: true, cues: transcript.cues.length },
      chat: { used: Boolean(request.chat && request.chat.messages && request.chat.messages.length), messages: request.chat && request.chat.messages ? request.chat.messages.length : 0 }
    },
    usedSignals: ['ai'],
    limit,
    warnings,
    suggestions,
    // veredito da IA sobre as sugestões do algoritmo (modo Algoritmo + IA); a junção (merge.js) é quem tira as recusadas
    ...(review.sent ? { review } : {}),
    ai: {
      provider: deps.provider ? deps.provider.label : '', model: deps.provider ? deps.provider.model : '',
      ...(windowMode ? { windows: { mode: 'candidates', ...winStats, coveredSec: Math.round(windows.reduce((n, b) => n + b.packed.reduce((m, p) => m + (p.ctxTo - p.ctxFrom), 0), 0)) } } : {}),
      blocks: windows.length, failedBlocks: failedWindows.length, ...(stats.recoveredBlocks ? { recoveredBlocks: stats.recoveredBlocks } : {}), pickUsed, calls: stats.calls, retries: stats.retries,
      promptTokens: stats.promptTokens, completionTokens: stats.completionTokens, estimate: est,
      candidates: accepted.length, droppedTotal, droppedByReason: dropCount, dropped,
      // o caminho dos candidatos, para ver ONDE os cortes se perdem (modelo que devolve poucos por bloco, conferência, ou escolha final que
      // corta): devolvidos pelo modelo, aprovados na conferência, sem repetição, enviados à escolha final, escolhidos e entregues
      funnel: {
        returned: blockStats.reduce((n, b) => n + (b.returned || 0), 0), verified: accepted.length, unique: merged.kept.length,
        offered, picked: pickedCount, final: suggestions.length, perBlock: blockStats
      },
      unpicked: unpicked.slice(0, MAX_UNPICKED_LISTED).map((c) => ({ start: c.start, end: c.end, title: c.title || '', relevance: c.relevance })),
      models: stats.models, // { <modelo que respondeu>: <chamadas> } (campo `model` da resposta; vazio se o provedor não informou)
      ...(review.sent ? { review: { sent: review.sent, kept: review.kept, dropped: review.dropped, unanswered: review.unanswered, adjusted: review.adjusted, calls: review.calls } } : {}),
      skill: { custom: Boolean(skillBody) }, // o guia de cortes usado: o do usuário ou o padrão do app (o texto não é guardado no resultado)
      // perfil de humor do canal que foi enviado (só contagens; o texto do perfil e dos exemplos não é guardado no resultado)
      profile: useProfile
        ? { criteria: Boolean(profile.criteria), catchphrases: profile.catchphrases.length, reactions: profile.reactions.length, themes: profile.themes.length, examples: { approved: examples.approved.length, rejected: examples.rejected.length } }
        : null
    }
  };
}

module.exports = { analyzeWithAi, callWithRetry, failureMessage, sleep, ALGO_VERSION, MAX_CANDIDATES_PER_BLOCK, AUTO_CANDIDATES_PER_BLOCK, AUTO_PICK_CANDIDATES, DEFAULT_RETRY };

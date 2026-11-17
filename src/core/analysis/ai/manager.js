'use strict';

const EventEmitter = require('node:events');
const fs = require('node:fs');
const { AnalysisError } = require('../errors');
const { AiError } = require('../../ai/errors');
const { sameSource } = require('../transcript/format');
const { analyzeWithAi, ALGO_VERSION, MAX_CANDIDATES_PER_BLOCK } = require('./analyze');
const { buildWindows, packCandidateBlocks, estimate, describeEstimate } = require('./chunking');
const { findCandidateWindows } = require('./windows');
const { profileBlock, profileSummary, estimateTokens, systemPrompt, SYSTEM_PROMPT } = require('./prompt');
const { selectExamples } = require('./humorExamples');
const humor = require('../humor');
const { probeMedia } = require('../../ffmpeg/probe');

const PROGRESS_THROTTLE_MS = 200;
const EXAMPLES_TTL_MS = 8000; // quanto tempo a estimativa reaproveita a leitura dos exemplos do perfil de humor

/** Por que o OpenRouter trocou de modelo (códigos de src/core/ai/openrouter/errors.js), em texto curto para a barra de progresso. */
const SWITCH_WHY = Object.freeze({
  MODEL: 'não encontrado, expirado ou indisponível', DATA_POLICY: 'a política de dados da sua conta o recusa', RATE_LIMIT: 'limite de uso',
  SERVER: 'erro do provedor', TIMEOUT: 'demorou demais', INTERRUPTED: 'a conexão caiu', BAD_RESPONSE: 'resposta inválida',
  // troca ENTRE provedores (src/core/ai/runtime.js, _chatChain)
  QUOTA: 'cota esgotada', NETWORK: 'sem conexão com o provedor'
});

/**
 * Executa UMA análise por IA por vez, em segundo plano, com os mesmos eventos do AnalysisManager do algoritmo (o renderer trata os dois
 * do mesmo jeito): 'progress' { jobId, p, stage, message }, 'done' { jobId, result }, 'failed' { jobId, code, message, details? }.
 * Não grava o projeto nem a chave; só devolve o resultado.
 *
 * deps: { runtime: AiRuntime, store: TranscriptStore, projects?: ProjectStore, skill?: SkillStore, getTools()->{ffmpeg,ffprobe}, readChat?, probe?, sleep?, retry? }
 * Com `skill` (skill.js), o guia de cortes que o usuário escreveu vai na mensagem de sistema no lugar do padrão do app.
 * Só o texto da transcrição, do chat e dos metadados sai do computador: o áudio não é lido para a IA (nem como "dica de volume").
 * Com o PERFIL DE HUMOR do canal (humor.js) vão também os critérios e as listas dele e, se ele deixou, trechos da fala de alguns cortes que ele aprovou
 * e rejeitou antes (humorExamples.js, lidos dos projetos do mesmo canal em `projects`; sem `projects` não há exemplos).
 */
class AiAnalysisManager extends EventEmitter {
  constructor(deps) {
    super();
    this.deps = deps;
    this.job = null;
    this.seq = 0;
    this.examplesCache = null; // { projectId, at, value }: os exemplos do perfil de humor lidos há pouco (só a estimativa os reaproveita)
  }

  status() {
    if (!this.job) return null;
    const { id, path: file, startedAt, p, stage, message } = this.job;
    return { jobId: id, path: file, startedAt, p, stage, message, engine: 'ai' };
  }

  /** Transcrição guardada, conferida com o vídeo aberto. Lança AnalysisError/AiError se não serve. */
  _transcriptFor(projectId, source) {
    const doc = this.deps.store.get(projectId);
    if (!doc) throw new AiError('NO_TRANSCRIPT', 'A análise por IA precisa da transcrição do vídeo. Gere ou importe uma na aba Análise.');
    if (!sameSource(doc.source, source)) throw new AiError('NO_TRANSCRIPT', 'A transcrição guardada é de outro arquivo de vídeo. Gere ou importe a transcrição deste vídeo.');
    return doc;
  }

  async _loadChat(chatPath, warnings) {
    if (!chatPath) return null;
    try {
      const read = this.deps.readChat || require('../../sources/chatFormat').readChat;
      return await read(chatPath);
    } catch (err) {
      warnings.push({ code: err && err.code ? err.code : 'CHAT_UNREADABLE', message: err && err.message ? err.message : 'O arquivo de chat não pôde ser lido; a análise seguiu sem ele.' });
      return null;
    }
  }

  /**
   * O perfil de humor do canal para um pedido: o perfil limpo (null se não diz nada), os exemplos de cortes aprovados/rejeitados (só se o perfil
   * deixa e há projetos do mesmo canal com transcrição) e os textos que vão nos pedidos (para contar tokens com exatidão).
   */
  humorFor(projectId, rawProfile, { fresh = false } = {}) {
    const profile = humor.normalizeProfile(rawProfile);
    if (humor.isEmpty(profile)) return { profile: null, examples: { approved: [], rejected: [] }, blockText: '', pickText: '' };
    const examples = profile.examples ? this._examples(projectId, fresh) : { approved: [], rejected: [] };
    return { profile, examples, blockText: profileBlock(profile, examples), pickText: profileSummary(profile) };
  }

  /**
   * Exemplos do canal do projeto. Ler os projetos e as transcrições do canal custa (arquivos de verdade, no processo principal): a estimativa
   * e a tela os pedem várias vezes em poucos segundos, então uma leitura vale por EXAMPLES_TTL_MS; `fresh` (a análise que vai enviar e a caixa
   * "Ver os exemplos") sempre lê de novo. Nunca lança: sem exemplos, o perfil segue só com critérios e listas.
   */
  _examples(projectId, fresh) {
    const now = Date.now();
    const hit = this.examplesCache;
    if (!fresh && hit && hit.projectId === projectId && now - hit.at < EXAMPLES_TTL_MS) return hit.value;
    let value;
    try {
      value = selectExamples({ projects: this.deps.projects, transcripts: this.deps.store, projectId: typeof projectId === 'string' ? projectId : null });
    } catch {
      value = { approved: [], rejected: [], projects: 0 };
    }
    this.examplesCache = { projectId, at: now, value };
    return value;
  }

  /**
   * Exemplos que iriam no pedido (a tela mostra antes de enviar qualquer coisa): { approved, rejected, projects } de humorExamples.js.
   * Não envia nada. Sem projetos do mesmo canal com transcrição, as listas ficam vazias.
   */
  humorExamples({ projectId } = {}) {
    return this._examples(typeof projectId === 'string' ? projectId : null, true);
  }

  /** O guia de cortes do usuário, se ele escreveu um: { body, extraTokens } (quanto ele pesa a mais que o padrão, por chamada). '' = vale o padrão. */
  _skill() {
    try {
      const active = this.deps.skill ? this.deps.skill.active() : null;
      if (!active || !active.custom) return { body: '', extraTokens: 0 };
      return { body: active.body, extraTokens: Math.max(0, estimateTokens(systemPrompt(active.body)) - estimateTokens(SYSTEM_PROMPT)) };
    } catch { return { body: '', extraTokens: 0 }; } // guia ilegível: segue com o padrão
  }

  /**
   * Janelas candidatas (modo opcional): o filtro local de áudio, chat e risadas. Nunca lança por falta de sinal: sem janelas suficientes
   * devolve { windows: [], reason } e quem chama volta ao método de blocos. `allowExtract:false` (estimativa) só usa o áudio já em cache.
   */
  async _candidateWindows({ doc, chat, duration, hasAudio, file, signal, allowExtract, onProgress }) {
    const found = await findCandidateWindows({ doc, chat, duration, hasAudio, file, audioDb: this.deps.audioDb, signal, allowExtract, onProgress });
    if (!found.enough) {
      const why = found.info.windows ? `só ${found.info.windows} janela(s) candidata(s)` : 'nenhum trecho candidato (sem picos de áudio, de chat nem risadas)';
      return { windows: [], info: found.info, reason: `O filtro local achou ${why}; foi usado o método de blocos, que lê a transcrição inteira.` };
    }
    return { windows: found.windows, info: found.info, reason: '' };
  }

  /** Estimativa honesta antes de rodar: { windows, calls, tokens, label, exceedsLimit, limit }. Não envia nada. */
  async estimate({ projectId, path: file, size, duration, chatPath, profile: rawProfile, aiWindows }) {
    const source = { path: file, size: Number(size) || 0, duration: Number(duration) || 0 };
    const doc = this._transcriptFor(projectId, source);
    const limits = this._limits();
    const chat = await this._loadChat(chatPath, []);
    const { blockText, pickText } = this.humorFor(projectId, rawProfile);
    const skill = this._skill();
    const windows = buildWindows(doc.cues, source.duration || doc.source.duration, {
      windowSec: limits.windowMinutes * 60, maxInputTokens: limits.maxInputTokens, chat, profileTokens: estimateTokens(blockText) + skill.extraTokens
    });
    const blocksEst = estimate(windows, { candidatesPerBlock: MAX_CANDIDATES_PER_BLOCK, pickExtraTokens: estimateTokens(pickText) + skill.extraTokens });
    let est = blocksEst;
    let windowsInfo = null;
    if (aiWindows === true) {
      const hasAudio = true;
      const found = await this._candidateWindows({ doc, chat, duration: source.duration || doc.source.duration, hasAudio, file, signal: null, allowExtract: false });
      if (found.windows.length) {
        const packed = packCandidateBlocks(found.windows, doc.cues, source.duration || doc.source.duration, { maxInputTokens: limits.maxInputTokens, chat, profileTokens: estimateTokens(blockText) + skill.extraTokens });
        const winEst = estimate(packed, { candidatesPerBlock: Math.max(1, ...packed.map((b) => b.packed.length)), pickExtraTokens: estimateTokens(pickText) + skill.extraTokens });
        est = winEst;
        windowsInfo = { mode: 'candidates', ...found.info, blocksTokens: blocksEst.totalTokens, blocksCalls: blocksEst.calls, savedPercent: blocksEst.totalTokens ? Math.round((1 - winEst.totalTokens / blocksEst.totalTokens) * 100) : 0 };
      } else {
        windowsInfo = { mode: 'blocks', fallback: true, reason: found.info.audio === 'not-cached' ? 'O áudio ainda não foi lido; rode o algoritmo uma vez (ou a análise) para o filtro local ter o volume. Estimativa pelo método de blocos.' : found.reason, ...found.info };
      }
    }
    return {
      ...est, label: describeEstimate(est), limit: limits.maxCalls, exceedsLimit: est.calls > limits.maxCalls,
      ...(windowsInfo ? { windowsInfo } : {}),
      // blocos encolhidos para caber no limite por minuto de um provedor da cadeia (a tela diz qual)
      ...(limits.limitedBy ? { limitedBy: limits.limitedBy, maxInputTokens: limits.maxInputTokens } : {})
    };
  }

  /** Os limites desta análise: os do usuário, encolhidos para o limite por minuto do provedor da cadeia que tem o menor (runtime.effectiveLimits). */
  _limits() {
    const { runtime } = this.deps;
    return typeof runtime.effectiveLimits === 'function' ? runtime.effectiveLimits() : runtime.limits();
  }

  /**
   * Confere tudo o que a análise por IA precisa para começar (projeto, vídeo, provedor pronto, aceite do aviso, transcrição deste vídeo),
   * sem começar nada. Lança AnalysisError/AiError com o motivo. O modo "Algoritmo + IA" (combo.js) chama antes de rodar o algoritmo, para
   * não fazer a pessoa esperar o algoritmo e só então saber que a IA não pode rodar.
   */
  check({ projectId, path: file, size, duration } = {}) {
    if (typeof projectId !== 'string' || !projectId) throw new AnalysisError('INVALID_ARGS', 'Informe o projeto.');
    if (typeof file !== 'string' || !file) throw new AnalysisError('INVALID_ARGS', 'Informe o caminho do vídeo a analisar.');
    if (!(Number(duration) > 0)) throw new AnalysisError('INVALID_ARGS', 'Não sei a duração do vídeo. Abra o vídeo de novo.');
    const { runtime } = this.deps;
    const current = runtime.describe();
    if (!current.ready) throw new AiError(current.reasonCode || (current.hasKey || !current.keyRequired ? 'NOT_CONFIGURED' : 'NO_KEY'), current.reason || 'Configure o provedor de IA antes de analisar.'); // reasonCode: NOT_CONFIGURED (sem provedor, endereço ou modelo) ou NO_KEY
    if (!current.accepted) throw new AiError('CONSENT_REQUIRED', 'Antes de enviar qualquer trecho, confirme o aviso de privacidade do provedor de IA.');
    const source = { path: file, size: Number(size) || 0, duration: Number(duration) };
    const doc = this._transcriptFor(projectId, source);
    return { current, source, doc };
  }

  /** Valida e começa em segundo plano. Lança AnalysisError/AiError se não puder começar. */
  start({ projectId, path: file, size, duration, params, chatPath, meta, existingCuts, profile, review, aiWindows } = {}) {
    if (this.job) throw new AnalysisError('BUSY', 'Já existe uma análise em andamento. Espere terminar ou cancele-a.');
    const { current, source, doc } = this.check({ projectId, path: file, size, duration });

    this.seq += 1;
    const job = {
      id: `i${Date.now().toString(36)}${this.seq}`, path: file, startedAt: Date.now(), p: 0, stage: 'prepare', message: 'Preparando…',
      abort: new AbortController(), lastEmit: 0
    };
    this.job = job;
    const cuts = Array.isArray(existingCuts)
      ? existingCuts.filter((c) => c && Number.isFinite(c.start) && Number.isFinite(c.end)).slice(0, 2000).map((c) => ({ start: Number(c.start), end: Number(c.end) }))
      : [];
    // modo Algoritmo + IA: as sugestões do algoritmo que a IA vai conferir (só id e horários; nenhuma pista do algoritmo sai daqui)
    const toReview = Array.isArray(review)
      ? review.filter((c) => c && c.id != null && Number.isFinite(c.start) && Number.isFinite(c.end)).slice(0, 600).map((c) => ({ id: String(c.id), start: Number(c.start), end: Number(c.end) }))
      : [];
    this._run(job, { doc, source, params, chatPath, meta: meta && typeof meta === 'object' ? meta : {}, existingCuts: cuts, provider: current, projectId, profile, review: toReview, aiWindows: aiWindows === true }).catch((err) => {
      this.job = null;
      this.emit('failed', { jobId: job.id, code: 'ERROR', message: err && err.message ? err.message : 'Erro inesperado na análise.' });
    });
    return { jobId: job.id };
  }

  _progress(job, ev) {
    const changed = ev.stage !== job.stage || ev.message !== job.message; // mensagem nova (outro bloco, nova tentativa) sai na hora
    job.p = ev.p; job.stage = ev.stage; job.message = ev.message;
    const now = Date.now();
    if (!changed && now - job.lastEmit < PROGRESS_THROTTLE_MS && ev.p < 1) return;
    job.lastEmit = now;
    this.emit('progress', { jobId: job.id, p: ev.p, stage: ev.stage, message: ev.message, ...(typeof ev.stageP === 'number' ? { stageP: ev.stageP } : {}) });
  }

  async _run(job, { doc, source, params, chatPath, meta, existingCuts, provider, projectId, profile, review, aiWindows }) {
    const progress = (ev) => this._progress(job, ev);
    try {
      progress({ p: 0, stage: 'prepare', message: 'Preparando…' });
      const warnings = [];
      let duration = source.duration;
      let hasAudio = true;
      const tools = this.deps.getTools();
      if (tools.ffprobe && fs.existsSync(source.path)) {
        try {
          const info = await (this.deps.probe || probeMedia)(tools.ffprobe, source.path);
          if (info.duration > 0) duration = info.duration;
          hasAudio = info.hasAudio;
        } catch { /* a duração do pedido vale */ }
      }
      if (job.abort.signal.aborted) throw new AnalysisError('CANCELLED', 'Análise cancelada. Nada foi alterado no projeto.');
      // OpenRouter com "Usar apenas modelos gratuitos": confere a lista pública de modelos (cache de 6 h; sem rede, o último) para o guard
      // decidir com os dados de hoje. Nada do usuário sai nesse passo; cancelar não espera a rede.
      if (provider.freeCapable && provider.freeOnly && typeof this.deps.runtime.prepare === 'function') {
        progress({ p: 0, stage: 'prepare', message: 'Conferindo a lista de modelos gratuitos…' });
        const aborted = new Promise((resolve, reject) => {
          job.abort.signal.addEventListener('abort', () => reject(new AnalysisError('CANCELLED', 'Análise cancelada. Nada foi alterado no projeto.')), { once: true });
        });
        const prepared = await Promise.race([this.deps.runtime.prepare(), aborted]);
        if (prepared && prepared.warning) warnings.push(prepared.warning);
      }
      const chat = await this._loadChat(chatPath, warnings);
      const humorProfile = this.humorFor(projectId, profile, { fresh: true }); // perfil de humor do canal e os exemplos dele, lidos agora (nada sai sem o aceite do provedor)
      // modo janelas candidatas (opcional): só os trechos que o filtro local marcou vão para a IA; sem sinais suficientes volta aos blocos
      let candidateWindows = null;
      let windowsInfo = null;
      if (aiWindows) {
        progress({ p: 0.01, stage: 'prepare', message: 'Procurando os trechos candidatos (áudio, chat e risadas)…' });
        const found = await this._candidateWindows({
          doc, chat, duration, hasAudio, file: source.path, signal: job.abort.signal, allowExtract: true,
          onProgress: (p) => progress({ p: 0.01 + 0.07 * Math.min(1, Math.max(0, Number(p) || 0)), stage: 'prepare', message: 'Lendo o volume do áudio…', stageP: p })
        });
        windowsInfo = found.info;
        if (found.windows.length) candidateWindows = found.windows;
        else warnings.push({ code: 'AI_WINDOWS_FALLBACK', message: found.reason });
        if (job.abort.signal.aborted) throw new AnalysisError('CANCELLED', 'Análise cancelada. Nada foi alterado no projeto.');
      }
      const switches = [];
      const onSwitch = (ev) => {
        switches.push(ev);
        progress({ p: job.p, stage: job.stage, message: `O modelo ${ev.from} não respondeu (${SWITCH_WHY[ev.reason.code] || ev.reason.code}); tentando ${ev.to}…` });
      };
      // Rede de segurança do modo gratuito: o OpenRouter informa o custo de cada resposta (`usage.cost`, 0 nos gratuitos). A trava impede o
      // pedido pago ANTES de sair; se mesmo assim vier custo (ex.: um modelo que passou a ser pago depois da lista), a análise avisa.
      let reportedCost = 0;
      const result = await analyzeWithAi(
        { duration, hasAudio, params, transcript: doc, chat, meta, existingCuts, profile: humorProfile.profile, examples: humorProfile.examples, skill: this._skill().body, review, candidateWindows },
        {
          chat: async (p) => {
            const out = await this.deps.runtime.chat({ ...p, onSwitch });
            const cost = out && out.usage ? Number(out.usage.cost) : NaN;
            if (provider.freeOnly === true && cost > 0) reportedCost += cost;
            return out;
          },
          provider: { label: provider.label, model: provider.model },
          limits: this._limits(),
          signal: job.abort.signal,
          onProgress: progress,
          sleep: this.deps.sleep,
          retry: this.deps.retry
        }
      );
      if (switches.length) {
        const seen = new Set();
        const parts = [];
        for (const ev of switches) {
          const key = `${ev.from}>${ev.to}`;
          if (seen.has(key)) continue;
          seen.add(key);
          parts.push(`${ev.from} (${SWITCH_WHY[ev.reason.code] || ev.reason.code}) → ${ev.to}`);
          if (parts.length >= 3) break;
        }
        warnings.push({ code: 'AI_MODEL_SWITCHED', message: `O app trocou de modelo durante a análise: ${parts.join('; ')}.` });
      }
      if (reportedCost > 0) {
        const usd = Number(reportedCost.toFixed(6)).toLocaleString('pt-BR', { maximumFractionDigits: 6 });
        warnings.push({ code: 'AI_COST_REPORTED', message: `O OpenRouter informou custo (US$ ${usd}) em pedidos desta análise, apesar de "Usar apenas modelos gratuitos" estar ligado. Confira o uso e os créditos no painel do OpenRouter.` });
      }
      if (windowsInfo && result.ai && result.ai.windows) result.ai.windows.filter = windowsInfo;
      else if (windowsInfo && result.ai) result.ai.windows = { mode: 'blocks', fallback: true, filter: windowsInfo };
      result.warnings = [...warnings, ...result.warnings];
      result.source.hasAudio = hasAudio;
      this.job = null;
      this.emit('done', { jobId: job.id, result });
    } catch (err) {
      this.job = null;
      const cancelledErr = err && err.code === 'CANCELLED';
      const out = {
        jobId: job.id,
        code: err && typeof err.code === 'string' ? err.code : 'ERROR',
        message: cancelledErr ? 'Análise cancelada. Nada foi alterado no projeto.' : (err && err.message ? err.message : 'Erro inesperado na análise.'),
        engine: 'ai'
      };
      if (err && err.details !== undefined) out.details = err.details;
      this.emit('failed', out);
    }
  }

  cancel(jobId) {
    if (!this.job || (jobId && jobId !== this.job.id)) return false;
    this.job.abort.abort();
    return true;
  }

  killAll() { if (this.job) this.job.abort.abort(); }
}

module.exports = { AiAnalysisManager, ALGO_VERSION };

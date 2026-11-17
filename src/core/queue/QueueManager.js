'use strict';

const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { QueueStore } = require('./queueStore');
const { jobKey, predictOutputPath, samePath, normPath, CASE_INSENSITIVE } = require('./jobKey');
const { QueueError, DEFAULT_MESSAGES, describeError, describePreflight } = require('./errors');

/**
 * Fila de exportação (contrato: docs/arquitetura.md, 3.3 e 3.4; detalhes em docs/recursos/queue.md).
 *
 * - Executor injetado (`runner`/`getRunner`): `runExportJob(job, { tools, onProgress, signal, tmpDir })`.
 * - Sequencial ou paralela (1..4), em ordem de entrada; reordenação só dos que ainda não começaram.
 * - Pausa (não inicia novos; opcionalmente interrompe os atuais, que voltam à fila ao retomar).
 * - Tentativas automáticas só para erros recuperáveis, limitadas e com espera crescente.
 * - Estado em `queue.json` (gravação atômica); jobs que estavam em execução viram `interrupted` ao reabrir.
 * - Não repete trabalho concluído (chave estável + arquivo de saída ainda existente) e pergunta em conflito de nome.
 */

const STATES = Object.freeze(['queued', 'running', 'paused', 'done', 'failed', 'interrupted', 'cancelled', 'skipped', 'needsAction']);
/** Esperam a vez (ou uma decisão): podem ser reordenados. */
const REORDERABLE = new Set(['queued', 'interrupted', 'needsAction']);
/** Ainda há o que fazer com eles. */
const ACTIVE = new Set(['queued', 'running', 'needsAction', 'interrupted']);
/** Estados em que o trabalho ainda ia rodar (`paused` é do contrato antigo e só existe em arquivos de versões anteriores). */
const WILL_RUN = new Set([...ACTIVE, 'paused']);
/** Registros que "Limpar concluídos" remove (falhas ficam: pedem atenção). */
const CLEARABLE = new Set(['done', 'skipped', 'cancelled']);

const CONFLICT_MODES = Object.freeze(['ask', 'rename', 'replace', 'skip', 'fail']);
const DEFAULT_CONFLICT_MODES = Object.freeze(['ask', 'rename', 'skip', 'fail']); // "substituir" só por escolha arquivo a arquivo
const RECOVERY_MODES = Object.freeze(['ask', 'resume', 'discard']);
const MAX_PARALLEL = 4;
const MAX_RETRIES = 5;

// Limites de processamento (Etapa 3): lowPriority = o ffmpeg da exportação roda com prioridade abaixo do normal (o computador continua
// respondendo; a velocidade quase não muda); encodeThreads = núcleos do codificador (0 = o ffmpeg decide); minFreeMemoryMb = com menos RAM livre
// que isto, nenhuma exportação NOVA começa enquanto outra roda (0 = não olhar). A primeira exportação nunca espera por memória.
const MAX_THREADS = 64;
const MAX_MIN_FREE_MEMORY_MB = 65536;
const THROTTLE_RECHECK_MS = 5000;
const DEFAULT_SETTINGS = Object.freeze({ parallel: null, retries: 2, recovery: 'ask', onConflict: 'ask', lowPriority: true, encodeThreads: 0, minFreeMemoryMb: 1024 });

/**
 * Id de job: vira nome de pasta de trabalho (`<tmpRoot>/<id>`) e é a chave de cancelamento ("all" é reservado), então só
 * aceita letras, números, "_" e "-" (sem pontos, barras nem espaços: nada que suba de pasta) e nomes que o Windows reserva.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_IDS = /^(all|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const isSafeId = (id) => typeof id === 'string' && SAFE_ID.test(id) && !RESERVED_IDS.test(id);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const clampParallel = (n) => Math.min(MAX_PARALLEL, Math.max(1, Math.floor(Number(n)) || 1));

let idCounter = 0;
function newId() {
  idCounter += 1;
  return `q${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Id de job que ainda não está em `used`: o do chamador, se for seguro e livre; senão um novo. */
function freeId(wanted, used) {
  let id = isSafeId(wanted) && !used.has(wanted) ? wanted : newId();
  while (used.has(id)) id = newId();
  used.add(id);
  return id;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try { return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); } catch { return d.toISOString(); }
}

/** Valida e normaliza ajustes. `strict`: erro com mensagem em português; senão (arquivo salvo) volta ao padrão. */
function normalizeSettings(patch, base, strict) {
  const out = { ...base };
  const src = isObj(patch) ? patch : {};
  const bad = (message) => { if (strict) throw new QueueError('INVALID_SETTINGS', message); };

  if ('parallel' in src) {
    if (src.parallel === null || src.parallel === 'auto' || src.parallel === '') out.parallel = null;
    else if (Number.isInteger(Number(src.parallel)) && Number(src.parallel) >= 1 && Number(src.parallel) <= MAX_PARALLEL) out.parallel = Number(src.parallel);
    else { bad(`Exportações ao mesmo tempo: use um número de 1 a ${MAX_PARALLEL}.`); out.parallel = base.parallel; }
  }
  if ('retries' in src) {
    const n = Number(src.retries);
    if (Number.isInteger(n) && n >= 0 && n <= MAX_RETRIES) out.retries = n;
    else { bad(`Tentativas automáticas: use um número de 0 a ${MAX_RETRIES}.`); out.retries = base.retries; }
  }
  if ('recovery' in src) {
    if (RECOVERY_MODES.includes(src.recovery)) out.recovery = src.recovery;
    else { bad('Recuperação: use "ask" (perguntar), "resume" (retomar sozinho) ou "discard" (descartar).'); out.recovery = base.recovery; }
  }
  if ('lowPriority' in src) {
    if (typeof src.lowPriority === 'boolean') out.lowPriority = src.lowPriority;
    else { bad('Prioridade baixa: use ligado ou desligado.'); out.lowPriority = base.lowPriority; }
  }
  if ('encodeThreads' in src) {
    const n = Number(src.encodeThreads);
    if (Number.isInteger(n) && n >= 0 && n <= MAX_THREADS) out.encodeThreads = n;
    else { bad(`Núcleos por exportação: use um número de 0 (automático) a ${MAX_THREADS}.`); out.encodeThreads = base.encodeThreads; }
  }
  if ('minFreeMemoryMb' in src) {
    const n = Number(src.minFreeMemoryMb);
    if (Number.isInteger(n) && n >= 0 && n <= MAX_MIN_FREE_MEMORY_MB) out.minFreeMemoryMb = n;
    else { bad(`Memória livre mínima: use um número de MB de 0 (não olhar) a ${MAX_MIN_FREE_MEMORY_MB}.`); out.minFreeMemoryMb = base.minFreeMemoryMb; }
  }
  if ('onConflict' in src) {
    if (DEFAULT_CONFLICT_MODES.includes(src.onConflict)) out.onConflict = src.onConflict;
    else if (src.onConflict === 'replace') { bad('Substituir arquivos não pode ser o padrão: ele só vale quando você escolhe, arquivo por arquivo, no aviso de conflito.'); out.onConflict = base.onConflict; }
    else { bad('Se o arquivo já existir: use "ask" (perguntar), "rename" (outro nome), "skip" (pular) ou "fail" (falhar).'); out.onConflict = base.onConflict; }
  }
  return out;
}

/** Falha de um registro que não dá para executar: o que fazer é sempre tirar da lista e enviar o corte de novo. */
const unusableError = (message) => ({
  code: 'INVALID_STATE', message, solution: 'Remova-o da lista e envie o corte para a fila de novo pela aba Exportar.', recoverable: false, technical: null
});

/** Problema estrutural de um job recebido (texto em português) ou null. */
function jobProblem(job) {
  if (!isObj(job)) return 'o trabalho não é um objeto.';
  if (typeof job.sourcePath !== 'string' || !job.sourcePath) return 'falta o caminho do vídeo de origem (sourcePath).';
  if (typeof job.outputDir !== 'string' || !job.outputDir) return 'falta a pasta de destino (outputDir).';
  if (typeof job.baseName !== 'string' || !job.baseName.trim()) return 'falta o nome do arquivo (baseName).';
  if (!isObj(job.cut) || !Number.isFinite(job.cut.start) || !Number.isFinite(job.cut.end)) return 'falta o corte com início e fim numéricos (cut).';
  if (!isObj(job.profile)) return 'falta o perfil de exportação (profile).';
  return null;
}

class QueueManager extends EventEmitter {
  /**
   * @param {object} opts
   *  statePath      caminho do queue.json (obrigatório)
   *  runner         async (job, { tools, onProgress, signal, tmpDir }) => { output, warnings } (ou getRunner: () => fn|null)
   *  preflight      async (job, { tools }) => { errors, warnings } (opcional; ou getPreflight)
   *  tools          objeto vivo { ffmpeg, ... } (ou função que o devolve)
   *  tmpRoot        pasta de trabalho dos jobs (cada job ganha uma subpasta apagada ao terminar)
   *  requireTools   ferramentas obrigatórias (padrão ['ffmpeg']); checkSource: confere o vídeo de origem (padrão true)
   *  defaultParallel paralelismo vindo das Preferências (padrão 1), usado enquanto o ajuste da fila for "padrão"
   *  backoffMs/backoffMaxMs espera entre tentativas (cresce 2x), abortGraceMs prazo para o runner atender o cancelamento,
   *  progressIntervalMs/updateIntervalMs limitam a frequência dos eventos, maxFinished limite do histórico, now/log
   */
  constructor(opts = {}) {
    super();
    if (!opts.statePath) throw new Error('QueueManager: informe statePath.');
    this.statePath = opts.statePath;
    this.store = opts.store || new QueueStore(opts.statePath);
    this.tmpRoot = opts.tmpRoot || path.join(path.dirname(opts.statePath), 'queue-tmp');
    this.cleanTmpRoot = /^queue/i.test(path.basename(this.tmpRoot)); // só limpa a pasta de trabalho se ela for mesmo da fila
    this.getRunner = typeof opts.getRunner === 'function' ? opts.getRunner : () => (typeof opts.runner === 'function' ? opts.runner : null);
    this.getPreflight = typeof opts.getPreflight === 'function' ? opts.getPreflight : () => (typeof opts.preflight === 'function' ? opts.preflight : null);
    this.getTools = typeof opts.tools === 'function' ? opts.tools : () => opts.tools || {};
    this.requireTools = Array.isArray(opts.requireTools) ? opts.requireTools : ['ffmpeg'];
    this.checkSource = opts.checkSource !== false;
    this.now = opts.now || Date.now;
    this.backoffMs = opts.backoffMs ?? 2000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30000;
    this.abortGraceMs = opts.abortGraceMs ?? 20000;
    this.progressIntervalMs = opts.progressIntervalMs ?? 250;
    this.updateIntervalMs = opts.updateIntervalMs ?? 40;
    this.maxFinished = opts.maxFinished ?? 300;
    this.maxCompleted = opts.maxCompleted ?? 5000;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this.freeMemoryMb = typeof opts.freeMemoryMb === 'function' ? opts.freeMemoryMb : () => Math.round(os.freemem() / (1024 * 1024)); // RAM livre agora (testes trocam)
    this.throttled = null; // { reason: 'memory', freeMb, minMb }: há trabalho esperando só porque falta memória livre
    this._throttleTimer = null;
    this.throttleRecheckMs = opts.throttleRecheckMs ?? THROTTLE_RECHECK_MS;

    this.jobs = [];
    this.completed = {}; // chave -> { output, at, dir }: sobrevive ao "Limpar concluídos"
    this.runtime = new Map(); // id -> estado só de memória do job em execução
    this.settings = { ...DEFAULT_SETTINGS };
    this.defaultParallel = clampParallel(opts.defaultParallel || 1);
    this.paused = false;
    this.recovery = { pending: false };
    this.blocked = null;
    this.loadWarning = null;
    this.saveError = null;
    this.closed = false;
    this.loaded = false;

    this._scheduling = false;
    this._rescan = false;
    this._saveHandle = null;
    this._updateTimer = null;
    this._retryTimer = null;
    this._dirty = false;
  }

  // ------------------------------------------------------------------ carga e persistência

  /** Lê o queue.json, aplica a política de recuperação e começa a processar o que estiver na fila. */
  load() {
    const read = this.store.read();
    let data = read.data;
    this.loadWarning = read.warning;
    this._cleanTmpRoot(); // sobras de jobs que a queda não deixou limpar

    let recoveryWasPending = false;
    if (data) {
      try {
        recoveryWasPending = this._ingest(data);
      } catch (err) {
        // um arquivo legível, mas com uma estrutura que não dá para interpretar, nunca derruba o app nem a aba: a fila sobe
        // vazia, o arquivo fica guardado ao lado (.corrupt) e a tela avisa
        this.log('error', `fila: não foi possível interpretar o arquivo salvo: ${err && err.stack ? err.stack : err}`);
        this.settings = { ...DEFAULT_SETTINGS };
        this.paused = false;
        this.completed = {};
        this.jobs = [];
        recoveryWasPending = false;
        data = null;
        const warning = `Não foi possível carregar a fila salva (${err && err.message ? err.message : err}); os trabalhos antigos não foram carregados e a fila começou vazia. O arquivo foi guardado ao lado do original (.corrupt).`;
        const kept = typeof this.store.quarantine === 'function' ? this.store.quarantine(warning) : { warning };
        this.loadWarning = kept.warning;
      }
    }

    // o que estava em execução quando o app caiu/fechou não terminou: vira "interrupted"
    for (const job of this.jobs) {
      if (job.state === 'running' || job.state === 'paused') {
        job.state = 'interrupted';
        job.interruptedBy = 'crash';
        job.progress = 0;
        job.phase = null;
        job.error = null;
      }
    }

    const candidates = this.jobs.filter((j) => j.state === 'interrupted' && j.interruptedBy !== 'pause');
    if (recoveryWasPending && this.jobs.some((j) => j.state === 'interrupted')) {
      this.recovery.pending = true;
      this.paused = true;
    } else if (candidates.length && !this.paused) {
      if (this.settings.recovery === 'resume') {
        candidates.forEach((j) => this._requeue(j));
      } else if (this.settings.recovery === 'discard') {
        candidates.forEach((j) => this._cancelNow(j, 'Descartado ao reabrir o app (configuração de recuperação).'));
      } else {
        this.recovery.pending = true;
        this.paused = true;
      }
    }

    this.loaded = true;
    if (data || this.jobs.length) this._changed(); // fila nova e vazia: nada a gravar ainda
    if (this.recovery.pending) this.emit('recovery', { jobs: this.jobs.filter((j) => j.state === 'interrupted').map((j) => this.view(j)) });
    this._schedule();
    return this;
  }

  /** Apaga a pasta de trabalho da fila (sobras de uma queda). Melhor esforço: uma pasta presa por um antivírus não impede a fila de abrir. */
  _cleanTmpRoot() {
    if (!this.cleanTmpRoot) return;
    try {
      fs.rmSync(this.tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (err) {
      this.log('warn', `fila: não foi possível limpar a pasta de trabalho ${this.tmpRoot}: ${err.message}`);
    }
  }

  /** Aplica o conteúdo lido do queue.json. Devolve se havia uma decisão de recuperação pendente quando o app fechou. */
  _ingest(data) {
    this.settings = normalizeSettings(data.settings, DEFAULT_SETTINGS, false);
    this.paused = data.paused === true;
    this.completed = this._sanitizeCompleted(data.completed);
    const used = new Set();
    this.jobs = data.jobs.map((raw) => this._sanitizeJob(raw, used)).filter(Boolean);
    return isObj(data.recovery) && data.recovery.pending === true;
  }

  _sanitizeCompleted(raw) {
    const out = {};
    if (!isObj(raw)) return out;
    for (const [key, v] of Object.entries(raw)) {
      if (isObj(v) && typeof v.output === 'string' && v.output) out[key] = { output: v.output, at: str(v.at), dir: str(v.dir, path.dirname(v.output)) };
    }
    return out;
  }

  /**
   * Um registro do arquivo da fila, em forma segura de usar. O id vira nome de pasta, então é conferido (trocado se não for
   * seguro ou repetido); um trabalho que ainda ia rodar mas está incompleto (arquivo editado à mão ou de versão antiga) vira
   * falha com causa e solução em vez de quebrar o agendador.
   */
  _sanitizeJob(raw, used = new Set()) {
    if (!isObj(raw)) return null;
    const job = { ...raw };
    job.id = freeId(job.id, used);
    const problem = jobProblem(raw);
    if (!STATES.includes(job.state)) {
      job.state = 'failed';
      job.error = unusableError('O estado deste trabalho estava inválido no arquivo da fila.');
    } else if (problem && WILL_RUN.has(job.state)) {
      job.state = 'failed';
      job.error = unusableError(`O registro deste trabalho no arquivo da fila estava incompleto: ${problem}`);
      job.finishedAt = new Date(this.now()).toISOString();
      job.progress = 0;
      job.phase = null;
      job.retryAt = null;
    }
    if (!isObj(job.cut)) job.cut = {};
    if (!isObj(job.profile)) job.profile = {};
    if (typeof job.key !== 'string' || !job.key) job.key = Number.isFinite(job.cut.start) && Number.isFinite(job.cut.end) ? jobKey(job) : job.id;
    job.warnings = Array.isArray(job.warnings) ? job.warnings : [];
    for (const f of ['runs', 'failures']) job[f] = Number.isFinite(job[f]) ? job[f] : 0;
    job.progress = Number.isFinite(job.progress) ? Math.min(1, Math.max(0, job.progress)) : 0;
    job.onConflict = CONFLICT_MODES.includes(job.onConflict) ? job.onConflict : 'ask';
    return job;
  }

  _serialize() {
    return { settings: this.settings, paused: this.paused, recovery: { pending: this.recovery.pending }, completed: this.completed, jobs: this.jobs };
  }

  /** Grava já (síncrono). Um erro de gravação não derruba a fila: fica em `saveError` e é mostrado na interface. */
  flush() {
    if (this._saveHandle) { clearImmediate(this._saveHandle); this._saveHandle = null; }
    this._dirty = false;
    try {
      this.store.write(this._serialize());
      this.saveError = null;
    } catch (err) {
      this.saveError = `Não foi possível salvar o estado da fila: ${err.message}. Libere espaço em disco ou verifique as permissões da pasta de dados do app.`;
      this.log('error', `fila: ${this.saveError}`);
    }
  }

  _save() {
    this._dirty = true;
    if (this._saveHandle || this.closed) return;
    this._saveHandle = setImmediate(() => { this._saveHandle = null; if (this._dirty) this.flush(); });
  }

  _emitUpdateSoon() {
    if (this._updateTimer || this.closed) return;
    this._updateTimer = setTimeout(() => {
      this._updateTimer = null;
      if (!this.closed) this.emit('update', this.snapshot());
    }, this.updateIntervalMs);
    if (typeof this._updateTimer.unref === 'function') this._updateTimer.unref();
  }

  /** Toda mudança de estado passa por aqui: reconcilia a recuperação, grava e avisa a interface. */
  _changed() {
    if (this.recovery.pending && !this.jobs.some((j) => j.state === 'interrupted')) {
      // o usuário cancelou/removeu tudo o que estava interrompido: a decisão está tomada
      this.recovery.pending = false;
      this.paused = false;
      this._schedule();
    }
    this._trimFinished();
    this._save();
    this._emitUpdateSoon();
  }

  _trimFinished() {
    const finished = this.jobs.filter((j) => CLEARABLE.has(j.state));
    const extra = finished.length - this.maxFinished;
    if (extra > 0) {
      const drop = new Set(finished.slice(0, extra).map((j) => j.id));
      this.jobs = this.jobs.filter((j) => !drop.has(j.id));
    }
    const keys = Object.keys(this.completed);
    if (keys.length > this.maxCompleted) {
      keys.sort((a, b) => String(this.completed[a].at).localeCompare(String(this.completed[b].at)));
      for (const k of keys.slice(0, keys.length - this.maxCompleted)) delete this.completed[k];
    }
  }

  // ------------------------------------------------------------------ visão para a interface

  /** Cópia do job para a interface: o corte vai resumido (sem legendas/histórico de áudio), o resto igual. */
  view(job) {
    const { cut, ...rest } = job;
    const rt = this.runtime.get(job.id);
    const c = isObj(cut) ? cut : {};
    return clone({
      ...rest,
      cut: { id: c.id, title: c.title, start: c.start, end: c.end, revision: c.revision, category: c.category, status: c.status },
      etaSec: rt && Number.isFinite(rt.eta) ? Math.round(rt.eta) : null,
      stopping: rt ? rt.reason : null
    });
  }

  effectiveParallel() {
    return clampParallel(this.settings.parallel ?? this.defaultParallel);
  }

  snapshot() {
    return {
      jobs: this.jobs.map((j) => this.view(j)),
      running: this.runtime.size,
      paused: this.paused,
      parallel: this.effectiveParallel(),
      active: this.jobs.filter((j) => ACTIVE.has(j.state)).length,
      blocked: this.blocked,
      throttled: this.throttled,
      recovery: { pending: this.recovery.pending, jobs: this.jobs.filter((j) => j.state === 'interrupted').map((j) => j.id) },
      loadWarning: this.loadWarning,
      saveError: this.saveError,
      settings: this.getSettings()
    };
  }

  list() {
    return this.snapshot();
  }

  getSettings() {
    return { ...this.settings, effectiveParallel: this.effectiveParallel(), defaultParallel: this.defaultParallel };
  }

  /** Ajustes: { parallel (null = padrão das Preferências), retries, recovery, onConflict } e { defaultParallel } (vem das Preferências). */
  setSettings(patch = {}) {
    if (!isObj(patch)) throw new QueueError('INVALID_SETTINGS', 'Ajustes inválidos.');
    const next = normalizeSettings(patch, this.settings, true);
    if ('defaultParallel' in patch && patch.defaultParallel !== null && patch.defaultParallel !== undefined) {
      const n = Number(patch.defaultParallel);
      if (!Number.isInteger(n) || n < 1 || n > MAX_PARALLEL) throw new QueueError('INVALID_SETTINGS', `O padrão das Preferências deve ficar entre 1 e ${MAX_PARALLEL}.`);
      this.defaultParallel = n;
    }
    this.settings = next;
    this._changed();
    this._schedule();
    return this.getSettings();
  }

  // ------------------------------------------------------------------ entrada

  /**
   * Coloca jobs na fila (ordem de entrada). Retorna a visão de cada um (na mesma ordem). Um job igual a outro
   * ainda ativo, ou já concluído com o arquivo ainda no disco, entra como `skipped` com o motivo (`force` repete).
   */
  enqueue(input, { force = false } = {}) {
    const list = Array.isArray(input) ? input : (input ? [input] : []);
    if (!list.length) throw new QueueError('INVALID_JOB', 'Nenhum trabalho foi informado para a fila.');
    const problems = [];
    list.forEach((job, index) => { const p = jobProblem(job); if (p) problems.push({ index, message: p }); });
    if (problems.length) {
      const more = problems.length > 1 ? ` (e mais ${problems.length - 1})` : '';
      throw new QueueError('INVALID_JOB', `Trabalho inválido na posição ${problems[0].index + 1}: ${problems[0].message}${more} Nada foi colocado na fila.`, { problems });
    }

    const used = new Set(this.jobs.map((j) => j.id));
    const created = [];
    for (const raw of list) {
      const id = freeId(raw.id, used); // o id do renderer só vale se for seguro (vira nome de pasta); senão a fila dá um novo
      const stamp = new Date(this.now()).toISOString();
      const job = {
        id,
        state: 'queued',
        projectId: str(raw.projectId),
        projectTitle: str(raw.projectTitle),
        sourcePath: raw.sourcePath,
        sourceInfo: isObj(raw.sourceInfo) ? clone(raw.sourceInfo) : null,
        cut: clone(raw.cut),
        profile: clone(raw.profile),
        framing: isObj(raw.framing) ? clone(raw.framing) : null,
        framingSource: isObj(raw.framingSource) ? clone(raw.framingSource) : null, // de onde veio o enquadramento (layout sugerido, escolhido, personalizado ou padrão): só auditoria
        outputDir: raw.outputDir,
        baseName: raw.baseName,
        onConflict: CONFLICT_MODES.includes(raw.onConflict) ? raw.onConflict : 'ask',
        createdAt: str(raw.createdAt) || stamp,
        enqueuedAt: stamp,
        startedAt: null,
        finishedAt: null,
        force: force === true || raw.force === true,
        conflictAction: null,
        progress: 0,
        phase: null,
        runs: 0,
        failures: 0,
        retryAt: null,
        output: null,
        warnings: [],
        error: null,
        lastError: null,
        skippedCode: null,
        skippedReason: null,
        conflictPath: null,
        cancelReason: null,
        interruptedBy: null
      };
      job.key = jobKey(job);

      const twin = this.jobs.find((j) => j.key === job.key && ACTIVE.has(j.state));
      if (twin) {
        this._skip(job, 'ALREADY_QUEUED', 'Este corte já está na fila com as mesmas configurações; não foi adicionado de novo.');
      } else if (!job.force) {
        const done = this._completedMatch(job);
        if (done) this._skip(job, 'ALREADY_DONE', this._alreadyDoneReason(done), done.output);
      }
      this.jobs.push(job);
      created.push(job);
    }
    this._changed();
    this._schedule();
    return created.map((j) => this.view(j));
  }

  _completedMatch(job) {
    const c = this.completed[job.key];
    if (!c || !c.output) return null;
    if (!samePath(path.dirname(c.output), job.outputDir)) return null; // outro destino: é trabalho novo
    if (!fs.existsSync(c.output)) return null; // arquivo apagado: refazer faz sentido
    return c;
  }

  _alreadyDoneReason(done) {
    const when = fmtDate(done.at);
    return `Já exportado${when ? ` em ${when}` : ''}: ${path.basename(done.output)}. Nada foi refeito; use "Exportar de novo" se quiser repetir.`;
  }

  // ------------------------------------------------------------------ transições simples

  _get(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new QueueError('JOB_NOT_FOUND', 'Este trabalho não está mais na fila.', { id });
    return job;
  }

  _skip(job, code, reason, output) {
    job.state = 'skipped';
    job.skippedCode = code;
    job.skippedReason = reason;
    if (output) job.output = output;
    job.finishedAt = new Date(this.now()).toISOString();
    job.progress = 0;
    job.phase = null;
    job.retryAt = null;
    job.error = null;
  }

  _cancelNow(job, reason) {
    if (job.startedAt && Date.parse(job.startedAt)) this._cleanPartial(job, Date.parse(job.startedAt)); // sobra (.part) de uma execução que ficou pela metade
    job.state = 'cancelled';
    job.cancelReason = reason;
    job.finishedAt = new Date(this.now()).toISOString();
    job.progress = 0;
    job.phase = null;
    job.retryAt = null;
    job.error = null;
    job.interruptedBy = null;
  }

  _requeue(job) {
    job.state = 'queued';
    job.interruptedBy = null;
    job.progress = 0;
    job.phase = null;
    job.error = null;
    job.retryAt = null;
  }

  /** Volta o job ao estado inicial de espera (usado por "tentar de novo"). */
  _reset(job) {
    this._requeue(job);
    job.failures = 0;
    job.lastError = null;
    job.output = null;
    job.skippedCode = null;
    job.skippedReason = null;
    job.conflictAction = null;
    job.conflictPath = null;
    job.cancelReason = null;
    job.finishedAt = null;
    job.warnings = [];
  }

  // ------------------------------------------------------------------ controles

  /** Pausa: nada novo começa. Com `interrupt`, os que estão rodando são interrompidos e voltam à fila ao retomar. */
  pause({ interrupt = false } = {}) {
    this.paused = true;
    let interrupting = 0;
    if (interrupt) {
      for (const job of this.jobs) if (job.state === 'running' && this._abort(job, 'interrupt')) interrupting += 1;
    }
    this._changed();
    return { paused: true, interrupting, running: this.runtime.size };
  }

  resume() {
    if (this.recovery.pending) return this.recover('resume');
    this.paused = false;
    let requeued = 0;
    for (const job of this.jobs) if (job.state === 'interrupted') { this._requeue(job); requeued += 1; }
    this._changed();
    this._schedule();
    return { paused: false, requeued };
  }

  /** Decisão do banner "a fila foi interrompida": 'resume' (volta tudo à fila) ou 'discard' (cancela o interrompido). */
  recover(action) {
    if (action !== 'resume' && action !== 'discard') throw new QueueError('INVALID_ACTION', 'Ação de recuperação inválida: use "resume" ou "discard".');
    const interrupted = this.jobs.filter((j) => j.state === 'interrupted');
    if (action === 'resume') interrupted.forEach((j) => this._requeue(j));
    else interrupted.forEach((j) => this._cancelNow(j, 'Descartado ao reabrir o app.'));
    this.recovery.pending = false;
    this.paused = false;
    this._changed();
    this._schedule();
    return { action, count: interrupted.length };
  }

  /** Cancela um trabalho (`{ id }`) ou todos os ativos (`{ all: true }` ou `{ id: 'all' }`). Os em execução são interrompidos de verdade. */
  cancel(arg) {
    const payload = typeof arg === 'string' ? { id: arg } : (arg || {});
    const all = payload.all === true || payload.id === 'all';
    if (!all && !payload.id) throw new QueueError('INVALID_ARGS', 'Informe qual trabalho cancelar (id) ou all:true.');
    const targets = all ? this.jobs.filter((j) => ACTIVE.has(j.state)) : [this._get(payload.id)];
    let cancelled = 0;
    let stopping = 0;
    for (const job of targets) {
      if (!ACTIVE.has(job.state)) throw new QueueError('NOT_CANCELLABLE', 'Este trabalho já terminou; não há o que cancelar.', { id: job.id, state: job.state });
      if (job.state === 'running') {
        if (this._abort(job, 'cancel')) stopping += 1;
      } else {
        this._cancelNow(job, 'Cancelado pelo usuário.');
        cancelled += 1;
      }
    }
    this._changed();
    return { cancelled, stopping };
  }

  /** Tira da lista (nunca apaga o arquivo exportado). Um trabalho em execução precisa ser cancelado antes. */
  remove(id) {
    const job = this._get(id);
    if (job.state === 'running' || this.runtime.has(job.id)) throw new QueueError('JOB_RUNNING', 'Este trabalho está em andamento. Cancele antes de remover.', { id });
    if (job.state === 'interrupted' && job.startedAt && Date.parse(job.startedAt)) this._cleanPartial(job, Date.parse(job.startedAt));
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this._changed();
    return { removed: true };
  }

  /** Remove concluídos, pulados e cancelados da lista (as falhas ficam, a menos que `includeFailed`). Não apaga nenhum arquivo. */
  clearFinished({ includeFailed = false } = {}) {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => !(CLEARABLE.has(j.state) || (includeFailed && j.state === 'failed')));
    this._changed();
    return { removed: before - this.jobs.length };
  }

  /** O trabalho é deste projeto? Pelo id do projeto; trabalho antigo sem id vale pelo caminho do vídeo (a mesma regra da aba Fila). */
  _isProjectJob(job, projectId, sourcePath) {
    if (job.projectId) return job.projectId === projectId;
    return typeof sourcePath === 'string' && typeof job.sourcePath === 'string' && samePath(job.sourcePath, sourcePath);
  }

  /** Trabalhos deste projeto que ainda não terminaram (esperando, rodando, interrompidos, esperando uma decisão ou, em arquivos antigos, pausados). */
  activeForProject({ projectId, sourcePath } = {}) {
    return this.jobs.filter((j) => WILL_RUN.has(j.state) && this._isProjectJob(j, projectId, sourcePath));
  }

  /**
   * Apaga do estado da fila o rastro de um projeto que foi apagado: os trabalhos JÁ TERMINADOS dele (concluídos, falhas, pulados, cancelados) e o
   * registro de "já exportado" dos arquivos em `outputs` (os que acabaram de ser apagados do disco). Não apaga arquivo nenhum e não toca em trabalho
   * que ainda vai rodar. Devolve { removed, forgotten }.
   */
  forgetProject({ projectId, sourcePath, outputs = [] } = {}) {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => WILL_RUN.has(j.state) || !this._isProjectJob(j, projectId, sourcePath));
    const gone = new Set((Array.isArray(outputs) ? outputs : []).filter((o) => typeof o === 'string' && o).map((o) => normPath(o)));
    let forgotten = 0;
    for (const [key, entry] of Object.entries(this.completed)) {
      if (entry && typeof entry.output === 'string' && gone.has(normPath(entry.output))) { delete this.completed[key]; forgotten += 1; }
    }
    if (before !== this.jobs.length || forgotten) this._changed();
    return { removed: before - this.jobs.length, forgotten };
  }

  /**
   * Nova ordem dos que ainda não começaram (queued, interrupted, needsAction): `ids` na ordem desejada. Os não
   * citados vão depois, na ordem em que estavam; em andamento e finalizados não mudam de lugar.
   */
  reorder(ids) {
    if (!Array.isArray(ids)) throw new QueueError('INVALID_ARGS', 'Informe a lista de ids na nova ordem.');
    const movable = this.jobs.filter((j) => REORDERABLE.has(j.state));
    const byId = new Map(movable.map((j) => [j.id, j]));
    const seen = new Set();
    const wanted = [];
    for (const id of ids) {
      const job = byId.get(id);
      if (job && !seen.has(id)) { wanted.push(job); seen.add(id); }
    }
    const order = [...wanted, ...movable.filter((j) => !seen.has(j.id))];
    let i = 0;
    this.jobs = this.jobs.map((j) => (REORDERABLE.has(j.state) ? order[i++] : j));
    this._changed();
    this._schedule();
    return { order: this.jobs.filter((j) => REORDERABLE.has(j.state)).map((j) => j.id) };
  }

  /** Tentar de novo / exportar de novo. Entra no fim da fila (exceto interrompido, que mantém o lugar). */
  retry(id) {
    const job = this._get(id);
    if (!['failed', 'cancelled', 'skipped', 'done', 'interrupted'].includes(job.state)) {
      throw new QueueError('NOT_RETRYABLE', 'Só dá para tentar de novo um trabalho que falhou, foi cancelado, interrompido, pulado ou concluído.', { id, state: job.state });
    }
    const problem = jobProblem(job);
    if (problem) throw new QueueError('INVALID_JOB', `Este trabalho está incompleto no arquivo da fila (${problem.replace(/.$/, '')}), então não dá para tentar de novo. Remova-o da lista e envie o corte para a fila de novo pela aba Exportar.`, { id, problem });
    if (job.skippedCode === 'ALREADY_QUEUED') throw new QueueError('ALREADY_QUEUED', 'Este corte já está na fila em outro trabalho igual; não há o que repetir.', { id });
    const twin = this.jobs.find((j) => j.id !== job.id && j.key === job.key && ACTIVE.has(j.state));
    if (twin) throw new QueueError('ALREADY_QUEUED', 'Já existe na fila um trabalho igual a este; espere ele terminar ou cancele-o.', { id, twin: twin.id });
    const explicitRedo = job.state === 'skipped' || job.state === 'done';
    const keepPlace = job.state === 'interrupted';
    this._reset(job);
    if (explicitRedo) job.force = true; // repetir de propósito: não pular por "já concluído"
    job.enqueuedAt = new Date(this.now()).toISOString();
    if (!keepPlace) {
      this.jobs = this.jobs.filter((j) => j.id !== job.id);
      this.jobs.push(job);
    }
    this._changed();
    this._schedule();
    return { job: this.view(job) };
  }

  /** Resposta ao aviso de conflito de nome: 'rename' | 'replace' | 'skip'. */
  resolveConflict(id, action) {
    const job = this._get(id);
    if (job.state !== 'needsAction') throw new QueueError('NOT_WAITING', 'Este trabalho não está esperando uma decisão.', { id, state: job.state });
    if (!['rename', 'replace', 'skip'].includes(action)) throw new QueueError('INVALID_ACTION', 'Ação inválida: use "rename" (outro nome), "replace" (substituir) ou "skip" (pular).');
    if (action === 'skip') {
      this._skip(job, 'CONFLICT_SKIPPED', `Pulado por você: já existia ${path.basename(job.conflictPath || predictOutputPath(job))}.`);
    } else {
      job.conflictAction = action;
      job.conflictPath = null;
      job.state = 'queued';
      job.error = null;
    }
    this._changed();
    this._schedule();
    return { job: this.view(job) };
  }

  // ------------------------------------------------------------------ agendamento

  _runnerOrBlock() {
    let runner = null;
    let reason = '';
    try { runner = this.getRunner(); } catch (err) { reason = ` (${err.message})`; this.log('warn', `fila: não foi possível carregar o motor de exportação: ${err.message}`); }
    if (typeof runner === 'function') {
      if (this.blocked) { this.blocked = null; this._emitUpdateSoon(); }
      return runner;
    }
    const message = `O motor de exportação não está disponível neste app${reason}. Os trabalhos continuam na fila e começam quando ele estiver disponível; se isso não mudar, atualize ou reinstale o Braga Frame.`;
    if (!this.blocked || this.blocked.message !== message) {
      this.blocked = { code: 'RUNNER_UNAVAILABLE', message };
      this._emitUpdateSoon();
    }
    return null;
  }

  _schedule() {
    if (this.closed || !this.loaded) return;
    if (this._scheduling) { this._rescan = true; return; }
    this._scheduling = true;
    try {
      do {
        this._rescan = false;
        this._scan();
      } while (this._rescan);
    } finally {
      this._scheduling = false;
    }
    this._armRetryTimer();
  }

  _scan() {
    if (this.paused) return;
    if (!this.jobs.some((j) => j.state === 'queued')) {
      if (this.blocked) { this.blocked = null; this._emitUpdateSoon(); } // nada esperando: o aviso de executor ausente não faz mais sentido
      return;
    }
    const runner = this._runnerOrBlock();
    if (!runner) return;
    const limit = this.effectiveParallel();
    const now = this.now();
    let memoryHeld = false;
    for (const job of [...this.jobs]) {
      if (job.state !== 'queued') continue;
      if (job.retryAt && job.retryAt > now) continue;
      if (this._safePrecheck(job) !== 'go') continue; // pulou, pediu decisão ou falhou: não ocupa vaga
      if (this.runtime.size >= limit) continue; // sem vaga: segue só para checar os próximos
      if (this._outputBusy(job)) continue; // outro job em execução vai gravar o mesmo arquivo: espera
      if (this._lowMemory()) { memoryHeld = true; continue; } // a primeira exportação nunca espera; as paralelas esperam por RAM livre
      this._start(job, runner);
    }
    this._setThrottled(memoryHeld);
  }

  /** Há exportação rodando E a RAM livre está abaixo do mínimo dos Ajustes? (uma nova esperaria) */
  _lowMemory() {
    const min = this.settings.minFreeMemoryMb;
    if (!(min > 0) || this.runtime.size === 0) return false;
    let free;
    try { free = this.freeMemoryMb(); } catch { return false; }
    if (!Number.isFinite(free) || free >= min) return false;
    this._lastFreeMb = free;
    return true;
  }

  _setThrottled(held) {
    const next = held ? { reason: 'memory', freeMb: this._lastFreeMb, minMb: this.settings.minFreeMemoryMb } : null;
    const changed = Boolean(next) !== Boolean(this.throttled);
    this.throttled = next;
    if (this._throttleTimer) { clearTimeout(this._throttleTimer); this._throttleTimer = null; }
    if (held && !this.closed) {
      // a memória livre muda sem avisar: confere de novo em alguns segundos
      this._throttleTimer = setTimeout(() => { this._throttleTimer = null; this._schedule(); }, this.throttleRecheckMs);
      if (typeof this._throttleTimer.unref === 'function') this._throttleTimer.unref();
    }
    if (changed) this._emitUpdateSoon();
  }

  _armRetryTimer() {
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this.closed || this.paused) return;
    let next = Infinity;
    for (const job of this.jobs) if (job.state === 'queued' && job.retryAt) next = Math.min(next, job.retryAt);
    if (!Number.isFinite(next)) return;
    this._retryTimer = setTimeout(() => { this._retryTimer = null; this._schedule(); }, Math.max(0, next - this.now()) + 5);
    if (typeof this._retryTimer.unref === 'function') this._retryTimer.unref();
  }

  /** Modo de conflito efetivo: escolha do usuário > o que o job pediu > padrão dos Ajustes (quando o job pede "ask"). */
  _conflictMode(job) {
    if (job.conflictAction) return job.conflictAction;
    if (job.onConflict && job.onConflict !== 'ask') return job.onConflict;
    return this.settings.onConflict;
  }

  /**
   * Antes de ocupar uma vaga: já foi concluído? o nome já existe? Devolve 'go' ou 'moved' (o job mudou de estado).
   */
  _precheck(job) {
    if (!job.force) {
      const done = this._completedMatch(job);
      if (done) {
        this._skip(job, 'ALREADY_DONE', this._alreadyDoneReason(done), done.output);
        this._changed();
        return 'moved';
      }
    }
    const mode = this._conflictMode(job);
    if (mode === 'ask' || mode === 'skip' || mode === 'fail') {
      const target = predictOutputPath(job);
      if (fs.existsSync(target)) {
        if (mode === 'ask') this._needsAction(job, target);
        else if (mode === 'skip') this._skip(job, 'CONFLICT_SKIPPED', `Pulado: já existe ${path.basename(target)} na pasta de destino.`);
        else this._fail(job, describeError(new QueueError('OUTPUT_EXISTS', `Já existe um arquivo com o nome "${path.basename(target)}".`, { path: target })));
        this._changed();
        return 'moved';
      }
    }
    return 'go';
  }

  /** `_precheck` que nunca lança: um trabalho com dados impossíveis vira falha (com causa) e o resto da fila segue. */
  _safePrecheck(job) {
    try {
      return this._precheck(job);
    } catch (err) {
      this.log('error', `fila: não foi possível preparar ${job.id}: ${err && err.stack ? err.stack : err}`);
      this._fail(job, unusableError(`Este trabalho não pôde ser preparado (${err && err.message ? err.message : err}).`));
      this._changed();
      return 'moved';
    }
  }

  _needsAction(job, target) {
    job.state = 'needsAction';
    job.conflictPath = target;
    job.progress = 0;
    job.phase = null;
    job.retryAt = null;
    this.emit('conflict', { job: this.view(job), path: target });
  }

  _fail(job, info) {
    job.state = 'failed';
    job.error = info;
    job.finishedAt = new Date(this.now()).toISOString();
    job.progress = 0;
    job.phase = null;
    job.retryAt = null;
  }

  /** Há um job em execução que vai gravar o mesmo arquivo de saída? (dois jobs no mesmo .part se corromperiam) */
  _outputBusy(job) {
    const target = normPath(predictOutputPath(job));
    for (const other of this.jobs) {
      if (other.id !== job.id && this.runtime.has(other.id) && normPath(predictOutputPath(other)) === target) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ execução

  _start(job, runner) {
    const mode = this._conflictMode(job);
    const rt = {
      controller: new AbortController(),
      reason: null,
      mode,
      startMs: this.now(),
      first: null,
      eta: null,
      lastEmit: 0,
      emitTimer: null,
      graceTimer: null
    };
    this.runtime.set(job.id, rt);
    job.state = 'running';
    job.runs += 1;
    job.startedAt = new Date(rt.startMs).toISOString();
    job.finishedAt = null;
    job.progress = 0;
    job.phase = 'preflight';
    job.error = null;
    job.retryAt = null;
    job.retryDelayMs = null;
    job.warnings = [];
    job.conflictPath = null;
    this._changed();
    this._execute(job, runner, rt).catch((err) => {
      this.log('error', `fila: erro inesperado ao executar ${job.id}: ${err && err.stack ? err.stack : err}`);
    });
  }

  _assertReady(job) {
    const tools = this.getTools() || {};
    for (const tool of this.requireTools) {
      if (!tools[tool]) {
        if (tool === 'ffmpeg') throw new QueueError('NO_FFMPEG', 'O FFmpeg não foi encontrado, então não dá para exportar.');
        throw new QueueError('NO_TOOL', `A ferramenta "${tool}" não foi encontrada, então não dá para exportar.`);
      }
    }
    if (this.checkSource && !fs.existsSync(job.sourcePath)) {
      throw new QueueError('INPUT_MISSING', `O vídeo de origem não foi encontrado: ${job.sourcePath}`, { path: job.sourcePath });
    }
  }

  /** O job que o executor recebe: o contrato 3.3, com `onConflict` já resolvido (nunca `ask`). */
  _runnerJob(job, mode) {
    return clone({
      id: job.id,
      projectId: job.projectId,
      projectTitle: job.projectTitle,
      sourcePath: job.sourcePath,
      sourceInfo: job.sourceInfo,
      cut: job.cut,
      profile: job.profile,
      framing: job.framing,
      outputDir: job.outputDir,
      baseName: job.baseName,
      onConflict: mode === 'ask' ? 'fail' : mode,
      createdAt: job.createdAt
    });
  }

  _addWarning(job, w) {
    const item = typeof w === 'string' ? { message: w } : (isObj(w) ? { code: w.code, message: str(w.message) } : null);
    if (!item || !item.message) return;
    if (!job.warnings.some((x) => x.message === item.message && x.code === item.code)) job.warnings.push(item);
  }

  async _runPreflight(job, rt) {
    const preflight = this.getPreflight();
    if (typeof preflight !== 'function') return;
    let res;
    try {
      res = await preflight(this._runnerJob(job, rt.mode), { tools: this.getTools() });
    } catch (err) {
      // a verificação prévia em si falhou: não é motivo para bloquear o trabalho
      this._addWarning(job, { code: 'PREFLIGHT_SKIPPED', message: `A verificação prévia não pôde ser feita (${err.message}); a exportação seguiu mesmo assim.` });
      return;
    }
    if (rt.controller.signal.aborted) return;
    // o aviso de nome repetido do QC fica de fora: a fila trata o conflito por conta própria (pergunta antes de gravar)
    for (const w of (res && res.warnings) || []) if (!(w && w.code === 'NAME_CONFLICT')) this._addWarning(job, w);
    const errors = (res && Array.isArray(res.errors)) ? res.errors : [];
    if (errors.length) {
      const infos = errors.map(describePreflight);
      const err = new QueueError(infos[0].code, infos.map((i) => i.message).join(' '));
      err.details = { solution: [...new Set(infos.map((i) => i.solution))].join(' ') };
      err.noRetry = true;
      throw err;
    }
  }

  /**
   * Pasta de trabalho do job: sempre uma subpasta direta de `tmpRoot`. O id já é validado na entrada, mas como esta pasta é
   * criada e depois APAGADA (recursivamente), o caminho é conferido de novo aqui, na hora de usar.
   */
  _jobTmpDir(job) {
    const root = path.resolve(this.tmpRoot);
    const dir = path.resolve(root, String(job.id));
    if (!isSafeId(job.id) || path.dirname(dir) !== root) {
      throw new QueueError('INVALID_STATE', 'O identificador deste trabalho é inválido, então a fila não o executou.', {
        id: String(job.id), solution: 'Remova-o da lista e envie o corte para a fila de novo pela aba Exportar.'
      });
    }
    return dir;
  }

  async _execute(job, runner, rt) {
    let outcome;
    let tmpDir = null;
    try {
      tmpDir = this._jobTmpDir(job);
      this._assertReady(job);
      await this._runPreflight(job, rt);
      if (rt.controller.signal.aborted) throw new QueueError('CANCELLED', 'Cancelado antes de começar.');
      job.phase = 'encoding';
      this._emitUpdateSoon();
      outcome = { ok: true, result: await this._callRunner(job, runner, rt, tmpDir) };
    } catch (err) {
      outcome = { ok: false, err };
    }
    if (rt.emitTimer) clearTimeout(rt.emitTimer);
    if (rt.graceTimer) clearTimeout(rt.graceTimer);
    this.runtime.delete(job.id);
    if (tmpDir) {
      // limpeza da pasta de trabalho: melhor esforço (um antivírus segurando um arquivo não pode deixar o job "em execução" para sempre)
      try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (err) { this.log('warn', `fila: não foi possível limpar ${tmpDir}: ${err.message}`); }
    }
    if (this.closed) return; // o encerramento do app já gravou "interrupted"
    this._settle(job, rt, outcome);
    this._schedule();
  }

  _callRunner(job, runner, rt, tmpDir) {
    fs.mkdirSync(tmpDir, { recursive: true });
    const opts = {
      tools: this.getTools(),
      onProgress: (p) => this._onProgress(job, rt, p),
      signal: rt.controller.signal,
      tmpDir,
      limits: { lowPriority: this.settings.lowPriority, threads: this.settings.encodeThreads } // o executor aplica (prioridade do ffmpeg e núcleos do codificador)
    };
    const running = Promise.resolve().then(() => runner(this._runnerJob(job, rt.mode), opts));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(rt.graceTimer); fn(value); };
      running.then((value) => finish(resolve, value), (err) => finish(reject, err));
      // o executor tem um prazo para atender o cancelamento; passado o prazo, a vaga é liberada mesmo assim
      const arm = () => {
        rt.graceTimer = setTimeout(() => {
          this.log('warn', `fila: o executor não parou em ${this.abortGraceMs} ms depois do cancelamento (${job.id}).`);
          finish(reject, new QueueError('ABANDONED', DEFAULT_MESSAGES.ABANDONED, { abandoned: true }));
        }, this.abortGraceMs);
        if (typeof rt.graceTimer.unref === 'function') rt.graceTimer.unref();
      };
      if (rt.controller.signal.aborted) arm();
      else rt.controller.signal.addEventListener('abort', arm, { once: true });
    });
  }

  _abort(job, reason) {
    const rt = this.runtime.get(job.id);
    if (!rt || rt.reason === 'cancel') return false;
    const first = rt.reason === null;
    rt.reason = reason;
    if (first) rt.controller.abort();
    this._emitUpdateSoon();
    return true;
  }

  _onProgress(job, rt, p) {
    if (this.runtime.get(job.id) !== rt) return;
    const value = Number(p);
    if (!Number.isFinite(value)) return;
    const progress = Math.min(1, Math.max(0, value));
    if (progress < job.progress) return; // nunca anda para trás
    job.progress = progress;
    const t = this.now();
    if (progress > 0 && !rt.first) rt.first = { t, p: progress };
    if (rt.first && progress > rt.first.p && t - rt.first.t >= 400) {
      const perMs = (progress - rt.first.p) / (t - rt.first.t);
      const eta = ((1 - progress) / perMs) / 1000;
      rt.eta = rt.eta === null ? eta : rt.eta * 0.6 + eta * 0.4; // suaviza para o tempo restante não "pular"
    }
    this._emitProgress(job, rt, false);
  }

  _emitProgress(job, rt, force) {
    const t = this.now();
    if (!force && t - rt.lastEmit < this.progressIntervalMs) {
      if (!rt.emitTimer) {
        rt.emitTimer = setTimeout(() => {
          rt.emitTimer = null;
          if (this.runtime.get(job.id) === rt) this._emitProgress(job, rt, true);
        }, Math.max(1, this.progressIntervalMs - (t - rt.lastEmit)));
        if (typeof rt.emitTimer.unref === 'function') rt.emitTimer.unref();
      }
      return;
    }
    rt.lastEmit = t;
    this.emit('progress', { id: job.id, p: job.progress, etaSec: Number.isFinite(rt.eta) ? Math.round(rt.eta) : null });
  }

  /** Resultado de uma execução -> novo estado do job. */
  _settle(job, rt, outcome) {
    const stamp = new Date(this.now()).toISOString();
    job.phase = null;
    job.retryAt = null;

    if (outcome.ok) {
      const res = outcome.result;
      if (isObj(res) && res.skipped === true) {
        this._skip(job, 'CONFLICT_SKIPPED', `Pulado: já existia ${res.output ? path.basename(res.output) : 'um arquivo com esse nome'}.`, res.output);
        this._changed();
        return;
      }
      if (!isObj(res) || typeof res.output !== 'string' || !res.output) {
        job.failures += 1;
        this._fail(job, describeError(new QueueError('RUNNER_BAD_RESULT', '')));
        this._changed();
        return;
      }
      for (const w of res.warnings || []) this._addWarning(job, w);
      job.state = 'done';
      job.output = res.output;
      job.progress = 1;
      job.finishedAt = stamp;
      job.error = null;
      job.lastError = null;
      // O arquivo agora é o deste trabalho. Se outro trabalho tinha concluído NESTE mesmo caminho (o usuário escolheu "Substituir"),
      // o "já exportado" dele deixou de valer: o arquivo daquele nome já não é o resultado dele, e pedir aquele trabalho de novo
      // não pode ser pulado como se estivesse pronto.
      for (const [key, entry] of Object.entries(this.completed)) {
        if (key !== job.key && entry && entry.output && samePath(entry.output, res.output)) delete this.completed[key];
      }
      this.completed[job.key] = { output: res.output, at: stamp, dir: path.dirname(path.resolve(res.output)) };
      this._changed();
      this.emit('jobDone', { job: this.view(job), output: res.output });
      return;
    }

    const err = outcome.err;
    this._cleanPartial(job, rt.startMs);
    if (err && err.code === 'ABANDONED') this._addWarning(job, { code: 'ABANDONED', message: 'O programa de codificação demorou a parar depois do cancelamento; confira se não sobrou um arquivo temporário (terminado em .part) na pasta de destino.' });

    if (rt.reason === 'cancel') {
      this._cancelNow(job, 'Cancelado pelo usuário.');
    } else if (rt.reason === 'interrupt') {
      job.state = 'interrupted';
      job.interruptedBy = 'pause';
      job.progress = 0;
    } else {
      const info = describeError(err);
      job.failures += 1;
      if (info.code === 'OUTPUT_EXISTS' && rt.mode === 'ask') {
        job.failures -= 1; // pedir uma decisão não é falha
        this._needsAction(job, (err.details && err.details.path) || predictOutputPath(job));
      } else if (info.recoverable && job.failures <= this.settings.retries) {
        const wait = Math.min(this.backoffMaxMs, this.backoffMs * 2 ** (job.failures - 1));
        job.state = 'queued';
        job.retryAt = this.now() + wait;
        job.retryDelayMs = wait;
        job.lastError = info;
        job.error = info;
        job.progress = 0;
      } else {
        this._fail(job, info);
      }
    }
    this._changed();
  }

  /** `.part` que a execução deste job pode ter deixado: o previsto e, em "salvar com outro nome", os numerados ("nome (2).mp4.part"). */
  _partialFiles(job) {
    const target = predictOutputPath(job);
    const files = [`${target}.part`];
    if (this._conflictMode(job) === 'rename') {
      const stem = path.basename(target, path.extname(target));
      const numbered = new RegExp(`^${escapeRegExp(stem)} \\(\\d+\\)${escapeRegExp(path.extname(target))}\\.part$`, CASE_INSENSITIVE ? 'i' : '');
      try {
        for (const name of fs.readdirSync(path.dirname(target))) if (numbered.test(name)) files.push(path.join(path.dirname(target), name));
      } catch { /* pasta de saída ainda não existe: sem variantes */ }
    }
    return files;
  }

  /**
   * Garantia extra depois de um cancelamento/falha/fechamento: apaga o `.part` do job, mas só se foi criado durante esta
   * execução e nenhum outro job em andamento usa o mesmo nome (o executor já deve ter apagado o dele). Com `retry`
   * (fechamento do app) tenta de novo por alguns instantes: o ffmpeg acabou de ser encerrado e ainda pode estar soltando o arquivo.
   */
  _cleanPartial(job, startMs, { retry = false } = {}) {
    let parts;
    try { parts = this._partialFiles(job); } catch { return; }
    for (const part of parts) {
      try {
        const st = fs.statSync(part);
        if (st.mtimeMs < startMs - 2000) continue;
        const key = normPath(part);
        if (this.jobs.some((other) => other.id !== job.id && this.runtime.has(other.id) && normPath(`${predictOutputPath(other)}.part`) === key)) continue;
        fs.rmSync(part, retry ? { force: true, maxRetries: 5, retryDelay: 40 } : { force: true }); // com tentativas: espera total de ~0,6 s no pior caso
      } catch { /* não existe (ou não deu para apagar): nada a fazer */ }
    }
  }

  /**
   * Fechamento do app (before-quit): grava tudo agora, marca o que rodava como `interrupted` e manda parar os
   * processos. O ffmpeg não é suspenso: ao retomar, o trabalho recomeça do início.
   */
  shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const timer of [this._updateTimer, this._retryTimer, this._throttleTimer]) if (timer) clearTimeout(timer);
    const stopped = [];
    for (const job of this.jobs) {
      if (job.state === 'running') {
        job.state = 'interrupted';
        job.interruptedBy = 'shutdown';
        job.progress = 0;
        job.phase = null;
        stopped.push(job);
      }
    }
    for (const rt of this.runtime.values()) {
      rt.reason = 'shutdown';
      if (rt.emitTimer) clearTimeout(rt.emitTimer);
      try { rt.controller.abort(); } catch { /* já abortado */ }
    }
    this.flush();
    // o processo do app sai logo depois e o executor não chega a limpar o que gravou: com o ffmpeg já mandado parar, o
    // arquivo temporário (.part) não pode ficar para trás na pasta do usuário
    for (const job of stopped) if (job.startedAt && Date.parse(job.startedAt)) this._cleanPartial(job, Date.parse(job.startedAt), { retry: true });
  }
}

module.exports = {
  QueueManager, STATES, ACTIVE, REORDERABLE, CLEARABLE, CONFLICT_MODES, DEFAULT_SETTINGS, MAX_PARALLEL, MAX_RETRIES, normalizeSettings, jobProblem
};

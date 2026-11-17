'use strict';

const EventEmitter = require('node:events');
const { AnalysisError } = require('./errors');
const { mergeResults } = require('./merge');

/** Parte do andamento que cabe ao algoritmo (o resto é da IA). */
const ALGORITHM_SHARE = 0.5;

/**
 * MODO "ALGORITMO + IA" (docs/recursos/analysis.md, "Algoritmo + IA"): roda o algoritmo e, em seguida, a IA na nuvem, e junta as duas listas
 * (merge.js). Usa os dois gerenciadores que já existem (AnalysisManager e AiAnalysisManager) e fala com o renderer pelos MESMOS eventos, com
 * o próprio jobId: 'progress' { jobId, p, stage, message }, 'done' { jobId, result }, 'failed' { jobId, code, message, details? }.
 * Os eventos dos trabalhos internos não devem chegar ao renderer: quem repassa pergunta `owns(jobId)`.
 *
 * Antes de começar, confere o que a IA precisa (provedor, aceite do aviso, transcrição): sem isso, falha na hora, sem rodar o algoritmo.
 * Se um dos motores falhar no meio (rede, cota, um erro do algoritmo), o resultado é o do outro, com aviso. Cancelar cancela os dois.
 *
 * deps: { algo: AnalysisManager, ai: AiAnalysisManager }
 */
class ComboAnalysis extends EventEmitter {
  constructor(deps) {
    super();
    this.deps = deps;
    this.job = null;
    this.seq = 0;
    this.inner = new Set(); // jobIds dos trabalhos internos (ainda correndo ou já terminados neste combo)
    const route = (phase, type) => (ev) => {
      const job = this.job;
      if (!job || job.phase !== phase || ev.jobId !== job.innerId) return;
      if (type === 'progress') this._progress(job, phase, ev);
      else if (type === 'done') this._phaseDone(job, phase, ev.result);
      else this._phaseFailed(job, phase, ev);
    };
    for (const type of ['progress', 'done', 'failed']) {
      deps.algo.on(type, route('algorithm', type));
      deps.ai.on(type, route('ai', type));
    }
  }

  /**
   * O evento com este jobId é de um trabalho interno do combo (não vai ao renderer)? Enquanto o combo roda, nenhuma outra análise pode rodar
   * (BUSY), então todo evento dos dois gerenciadores é dele, inclusive o primeiro andamento, que sai antes de o start interno devolver o jobId.
   */
  owns(jobId) {
    return Boolean(jobId) && (Boolean(this.job) || this.inner.has(jobId));
  }

  status() {
    if (!this.job) return null;
    const { id, path: file, startedAt, p, stage, message } = this.job;
    return { jobId: id, path: file, startedAt, p, stage, message, engine: 'both' };
  }

  /**
   * payload: o do algoritmo ({ path, params, chatPath, fresh, transcript }) + o da IA ({ projectId, size, duration, meta, existingCuts, profile }).
   * Lança AnalysisError/AiError se não puder começar (inclusive o que falta para a IA).
   */
  start(payload = {}) {
    if (this.job) throw new AnalysisError('BUSY', 'Já existe uma análise em andamento. Espere terminar ou cancele-a.');
    this.deps.ai.check(payload);
    this.seq += 1;
    const job = {
      id: `c${Date.now().toString(36)}${this.seq}`, path: payload.path, startedAt: Date.now(), p: 0, stage: 'prepare', message: 'Preparando…',
      phase: 'algorithm', innerId: null, payload, algo: null, algoError: null, cancelled: false
    };
    this.job = job; // antes do start interno: o primeiro andamento dele já é do combo (owns)
    try {
      const { jobId } = this.deps.algo.start({ path: payload.path, params: payload.params, chatPath: payload.chatPath, fresh: payload.fresh, transcript: payload.transcript });
      this.inner.add(jobId);
      job.innerId = jobId;
    } catch (err) {
      this.job = null;
      this.inner.clear();
      throw err;
    }
    return { jobId: job.id };
  }

  _progress(job, phase, ev) {
    const share = phase === 'algorithm' ? [0, ALGORITHM_SHARE] : [ALGORITHM_SHARE, 1];
    job.p = share[0] + (share[1] - share[0]) * Math.min(1, Math.max(0, Number(ev.p) || 0));
    job.stage = ev.stage;
    job.message = `${phase === 'algorithm' ? 'Algoritmo' : 'IA'}: ${ev.message || ''}`.trim();
    // phase: qual dos dois motores está rodando; stageP: o andamento da etapa dele (a tela estima o tempo pela etapa, não pela barra)
    this.emit('progress', { jobId: job.id, p: job.p, stage: job.stage, message: job.message, phase, ...(typeof ev.stageP === 'number' ? { stageP: ev.stageP } : {}) });
  }

  _phaseDone(job, phase, result) {
    if (phase === 'algorithm') { job.algo = result; this._startAi(job); return; }
    this._finish(job, mergeResults(job.algo, result, { algorithmError: job.algoError }));
  }

  _phaseFailed(job, phase, ev) {
    if (ev.code === 'CANCELLED' || job.cancelled) { this._fail(job, { code: 'CANCELLED', message: 'Análise cancelada. Nada foi alterado no projeto.' }); return; }
    if (phase === 'algorithm') { job.algoError = { code: ev.code, message: ev.message }; this._startAi(job); return; }
    if (!job.algo) { this._fail(job, { code: ev.code, message: ev.message, details: ev.details }); return; } // os dois falharam: vale o erro da IA
    this._finish(job, mergeResults(job.algo, null, { aiError: { code: ev.code, message: ev.message } }));
  }

  _startAi(job) {
    if (job.cancelled) { this._fail(job, { code: 'CANCELLED', message: 'Análise cancelada. Nada foi alterado no projeto.' }); return; }
    job.phase = 'ai';
    job.innerId = null;
    const p = job.payload;
    try {
      const { jobId } = this.deps.ai.start({
        projectId: p.projectId, path: p.path, size: p.size, duration: p.duration, params: p.params, chatPath: p.chatPath,
        meta: p.meta, existingCuts: p.existingCuts, profile: p.profile, ...(p.aiWindows === true ? { aiWindows: true } : {}),
        // a IA confere as sugestões do algoritmo (ligado por padrão; `review: false` no pedido desliga): vão só o id e os horários
        ...(p.review !== false && job.algo && Array.isArray(job.algo.suggestions) && job.algo.suggestions.length
          ? { review: job.algo.suggestions.map((s) => ({ id: s.id, start: s.start, end: s.end })) }
          : {})
      });
      this.inner.add(jobId);
      job.innerId = jobId;
      this._progress(job, 'ai', { p: 0, stage: 'prepare', message: 'Preparando…' });
    } catch (err) {
      // a IA não pôde nem começar (o aceite foi retirado no meio, a transcrição sumiu…)
      this._phaseFailed(job, 'ai', { code: err && err.code ? err.code : 'ERROR', message: err && err.message ? err.message : 'A IA não pôde começar.' });
    }
  }

  _finish(job, result) {
    if (this.job !== job) return;
    this.job = null;
    this.inner.clear();
    // a data e a duração são as DESTA execução inteira. A junção herdava as do algoritmo, que pode ter vindo do cache: com a IA falhando,
    // a análise ficava datada de quando o algoritmo rodou pela última vez e "calculada" em milissegundos, sem a espera pelo provedor
    this.emit('done', { jobId: job.id, result: { ...result, at: new Date().toISOString(), tookMs: Date.now() - job.startedAt } });
  }

  _fail(job, { code, message, details }) {
    if (this.job !== job) return;
    this.job = null;
    this.inner.clear();
    const out = { jobId: job.id, code: code || 'ERROR', message: message || 'Erro inesperado na análise.', engine: 'both' };
    if (details !== undefined) out.details = details;
    this.emit('failed', out);
  }

  /** Cancela o combo em andamento (ou o de `jobId`): cancela o trabalho interno da vez. true se havia o que cancelar. */
  cancel(jobId) {
    const job = this.job;
    if (!job || (jobId && jobId !== job.id)) return false;
    job.cancelled = true;
    const manager = job.phase === 'algorithm' ? this.deps.algo : this.deps.ai;
    if (!job.innerId || !manager.cancel(job.innerId)) this._fail(job, { code: 'CANCELLED', message: 'Análise cancelada. Nada foi alterado no projeto.' });
    return true;
  }
}

module.exports = { ComboAnalysis, ALGORITHM_SHARE };

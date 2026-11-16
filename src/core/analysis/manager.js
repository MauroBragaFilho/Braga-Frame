'use strict';

const EventEmitter = require('node:events');
const fs = require('node:fs');
const { AnalysisError } = require('./errors');
const { analyzeSource } = require('./analyze');
const { probeMedia } = require('../ffmpeg/probe');

const PROGRESS_THROTTLE_MS = 200;

/**
 * Executa UMA análise por vez em segundo plano. A chamada `start` volta logo com o `jobId`; andamento e
 * fim chegam por eventos:
 *   'progress' { jobId, p (0..1), stage, message }
 *   'done'     { jobId, result }
 *   'failed'   { jobId, code, message, details? }   (inclui CANCELLED)
 * Não grava nada no projeto (o renderer é o único que grava): só devolve o resultado.
 *
 * start({ path, params?, chatPath?, transcript?, fresh? }): `fresh: true` ignora o resultado e os sinais guardados (cache) e lê o vídeo de novo.
 *   `transcript` = { cues, stale? } (a transcrição do vídeo, já conferida com ele pelo chamador): vira o sinal de TEXTO; sem ela o
 *   algoritmo segue com áudio, imagem e chat.
 *
 * deps: { getTools() -> { ffmpeg, ffprobe }, cacheDir, spawn?, inputArgs?, probe?(ffprobe, file) }
 */
class AnalysisManager extends EventEmitter {
  constructor(deps) {
    super();
    this.deps = deps;
    this.job = null;
    this.children = new Set();
    this.seq = 0;
  }

  /** { jobId, path, startedAt, p, stage } do trabalho em andamento, ou null. */
  status() {
    if (!this.job) return null;
    const { id, path: file, startedAt, p, stage, message } = this.job;
    return { jobId: id, path: file, startedAt, p, stage, message };
  }

  /** Valida e começa em segundo plano. Lança AnalysisError se não puder começar. */
  start({ path: file, params, chatPath, fresh, transcript } = {}) {
    if (typeof file !== 'string' || !file) throw new AnalysisError('INVALID_ARGS', 'Informe o caminho do vídeo a analisar.');
    const tools = this.deps.getTools();
    if (!tools.ffmpeg) {
      throw new AnalysisError('NO_FFMPEG', 'ffmpeg não encontrado. Instale o FFmpeg e deixe-o no PATH (ou defina CORTE_FFMPEG); depois use "Verificar de novo" na aba Ferramentas.');
    }
    if (!tools.ffprobe && !this.deps.probe) {
      throw new AnalysisError('NO_FFPROBE', 'ffprobe não encontrado. Instale o FFmpeg e deixe-o no PATH (ou defina CORTE_FFPROBE); depois use "Verificar de novo" na aba Ferramentas.');
    }
    if (!fs.existsSync(file)) throw new AnalysisError('INPUT_MISSING', `O arquivo de vídeo não foi encontrado: ${file}`);
    if (this.job) throw new AnalysisError('BUSY', 'Já existe uma análise em andamento. Espere terminar ou cancele-a.');

    this.seq += 1;
    const job = {
      id: `a${Date.now().toString(36)}${this.seq}`,
      path: file,
      startedAt: Date.now(),
      p: 0,
      stage: 'probe',
      message: 'Lendo informações do vídeo…',
      abort: new AbortController(),
      lastEmit: 0
    };
    this.job = job;
    this._run(job, { params, chatPath, fresh: fresh === true, transcript: transcript && typeof transcript === 'object' ? transcript : null, ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe }).catch((err) => {
      // _run já trata tudo; isto só evita rejeição não tratada se algo inesperado escapar
      this.emit('failed', { jobId: job.id, code: 'ERROR', message: err && err.message ? err.message : 'Erro inesperado na análise.' });
    });
    return { jobId: job.id };
  }

  async _run(job, { params, chatPath, fresh, transcript, ffmpeg, ffprobe }) {
    const progress = (ev) => {
      job.p = ev.p;
      job.stage = ev.stage;
      job.message = ev.message;
      const now = Date.now();
      if (now - job.lastEmit < PROGRESS_THROTTLE_MS && ev.p < 1) return;
      job.lastEmit = now;
      this.emit('progress', { jobId: job.id, p: ev.p, stage: ev.stage, message: ev.message, ...(typeof ev.stageP === 'number' ? { stageP: ev.stageP } : {}) });
    };
    try {
      progress({ p: 0, stage: 'probe', message: job.message });
      const probe = this.deps.probe || probeMedia;
      let info;
      try {
        info = await probe(ffprobe, job.path);
      } catch (err) {
        // o probe já devolve a causa e a solução em português ("Não foi possível ler o vídeo: …"): não prefixar de novo
        const own = err && (err.code === 'PROBE_FAILED' || err.code === 'NO_VIDEO');
        throw new AnalysisError('PROBE_FAILED', own ? err.message : `Não foi possível ler o vídeo: ${err.message}`, err && err.details);
      }
      if (job.abort.signal.aborted) throw new AnalysisError('CANCELLED', 'Análise cancelada. Nada foi alterado no projeto.');
      const result = await analyzeSource(
        { file: job.path, duration: info.duration, hasAudio: info.hasAudio, params, chatPath, transcript, fresh },
        {
          ffmpeg,
          cacheDir: this.deps.cacheDir,
          signal: job.abort.signal,
          onProgress: progress,
          spawn: this.deps.spawn,
          inputArgs: this.deps.inputArgs,
          onSpawn: (child) => {
            this.children.add(child);
            child.once('close', () => this.children.delete(child));
          }
        }
      );
      this.job = null;
      this.emit('done', { jobId: job.id, result });
    } catch (err) {
      this.job = null;
      const code = err && typeof err.code === 'string' ? err.code : 'ERROR';
      const out = { jobId: job.id, code, message: err && err.message ? err.message : 'Erro inesperado na análise.' };
      if (err && err.details !== undefined) out.details = err.details;
      this.emit('failed', out);
    }
  }

  /** Cancela a análise em andamento (ou a de `jobId`). true se havia o que cancelar. */
  cancel(jobId) {
    if (!this.job || (jobId && jobId !== this.job.id)) return false;
    this.job.abort.abort();
    return true;
  }

  /** Fechamento do app: encerra o que estiver rodando (sem esperar). */
  killAll() {
    if (this.job) this.job.abort.abort();
    for (const child of this.children) {
      try { child.kill(); } catch { /* já saiu */ }
    }
  }
}

module.exports = { AnalysisManager };

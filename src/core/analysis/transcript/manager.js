'use strict';

const EventEmitter = require('node:events');
const fs = require('node:fs');
const { AnalysisError } = require('../errors');
const { transcribeVideo, DEFAULT_CHUNK_SEC } = require('./transcribe');
const { normalizeCues, buildDocument, summarize, sameSource } = require('./format');
const { parseSubtitleBuffer, SubtitleFileError } = require('./subtitleFile');

const PROGRESS_THROTTLE_MS = 250;

/**
 * Transcrição do vídeo inteiro, em segundo plano, uma por vez. Eventos:
 *   'progress' { jobId, p (0..1), doneUntil, message }
 *   'done'     { jobId, projectId, status }               status = resumo da transcrição pronta (format.summarize)
 *   'failed'   { jobId, projectId, code, message, details?, resumable?, doneUntil? }   (inclui CANCELLED)
 * O rascunho (userData/transcripts/<id>.partial.json) fica depois de um cancelamento ou erro, e `start` o retoma quando o vídeo, o
 * modelo e o idioma são os mesmos.
 *
 * deps: { store: TranscriptStore, engine: ctx.transcription (prepareRun/releaseRun/describeRun), statFile?, generate? (testes) }
 */
class TranscriptManager extends EventEmitter {
  constructor(deps) {
    super();
    this.deps = deps;
    this.job = null;
    this.seq = 0;
  }

  status() {
    if (!this.job) return null;
    const { id, projectId, startedAt, p, doneUntil, message } = this.job;
    return { jobId: id, projectId, startedAt, p, doneUntil, message };
  }

  /** Resumo da transcrição guardada (e do rascunho que dá para retomar). `source` = { path, size, duration } do vídeo aberto. */
  summary(projectId, source) {
    const doc = this.deps.store.get(projectId);
    const out = summarize(doc, source);
    const draft = this.deps.store.getDraft(projectId);
    if (draft && sameSource(draft.source, source) && draft.partial.doneUntil > 0) out.draft = { doneUntil: draft.partial.doneUntil, modelId: draft.partial.modelId };
    return out;
  }

  /**
   * Importa uma legenda .srt/.vtt (já lida em `buffer`). Valida, normaliza e grava. Lança SubtitleFileError (BAD_FORMAT, EMPTY, TOO_BIG).
   */
  importBuffer({ projectId, buffer, ext, fileName, source }) {
    const parsed = parseSubtitleBuffer(buffer, ext, { duration: source.duration });
    const doc = buildDocument({ projectId, origin: 'imported', source, cues: parsed.cues, dropped: parsed.dropped, importedFrom: fileName });
    this.deps.store.save(projectId, doc);
    return { status: summarize(doc, source), warnings: parsed.warnings };
  }

  remove(projectId) { return this.deps.store.remove(projectId); }

  start({ projectId, path: file, size, duration, modelId, language = 'pt', engine = 'auto', chunkSec = DEFAULT_CHUNK_SEC } = {}) {
    if (typeof projectId !== 'string' || !projectId) throw new AnalysisError('INVALID_ARGS', 'Informe o projeto.');
    if (typeof file !== 'string' || !file) throw new AnalysisError('INVALID_ARGS', 'Informe o caminho do vídeo.');
    if (!(Number(duration) > 0)) throw new AnalysisError('INVALID_ARGS', 'Não sei a duração do vídeo. Abra o vídeo de novo.');
    if (!fs.existsSync(file)) throw new AnalysisError('INPUT_MISSING', `O arquivo de vídeo não foi encontrado: ${file}`);
    if (this.job) throw new AnalysisError('BUSY', 'Já existe uma transcrição em andamento. Espere terminar ou cancele-a.');
    this.seq += 1;
    const job = {
      id: `t${Date.now().toString(36)}${this.seq}`, projectId, startedAt: Date.now(), p: 0, doneUntil: 0, message: 'Preparando…',
      abort: new AbortController(), lastEmit: 0
    };
    this.job = job; // reserva já: duas chamadas seguidas não passam
    this._run(job, { file, size: Number(size) || 0, duration: Number(duration), modelId, language, engine, chunkSec }).catch((err) => {
      this.job = null;
      this.emit('failed', { jobId: job.id, projectId, code: 'ERROR', message: err && err.message ? err.message : 'Erro inesperado na transcrição.' });
    });
    return { jobId: job.id };
  }

  async _run(job, { file, size, duration, modelId, language, engine, chunkSec }) {
    const { store } = this.deps;
    const source = { path: file, size, duration };
    let run = null;
    const progress = (ev) => {
      job.p = ev.p; job.doneUntil = ev.doneUntil; job.message = ev.message;
      const now = Date.now();
      if (now - job.lastEmit < PROGRESS_THROTTLE_MS && ev.p < 1) return;
      job.lastEmit = now;
      this.emit('progress', { jobId: job.id, p: ev.p, doneUntil: ev.doneUntil, message: ev.message });
    };
    try {
      progress({ p: 0, doneUntil: 0, message: 'Preparando o motor de transcrição…' });
      run = await this.deps.engine.prepareRun({
        key: `transcript:${job.projectId}`, modelId: modelId || this.deps.engine.defaultModelId, engine,
        onPrepare: (message) => progress({ p: 0, doneUntil: 0, message })
      });
      const onAbort = () => run.controller.abort();
      job.abort.signal.addEventListener('abort', onAbort, { once: true });
      if (job.abort.signal.aborted) onAbort();

      // retomada: mesmo vídeo, modelo, idioma e tamanho de pedaço
      let startAt = 0;
      let initialCues = [];
      const draft = store.getDraft(job.projectId);
      if (draft && sameSource(draft.source, source) && draft.partial.modelId === run.modelId && draft.partial.language === language && draft.partial.chunkSec === chunkSec && draft.partial.doneUntil > 0 && draft.partial.doneUntil < duration) {
        startAt = draft.partial.doneUntil;
        initialCues = draft.cues;
      }
      const result = await transcribeVideo({
        input: file, duration, genOptions: run.genOptions, language, chunkSec, startAt, initialCues, signal: job.abort.signal,
        generate: this.deps.generate,
        onProgress: progress,
        onChunk: ({ cues, doneUntil }) => {
          try { store.saveDraft(job.projectId, { source, partial: { doneUntil, chunkSec, modelId: run.modelId, language }, cues }); } catch { /* sem rascunho, só não retoma */ }
        }
      });
      const described = this.deps.engine.describeRun(run, { device: result.device, deviceName: result.deviceName, fellBack: result.fellBack, noSpeech: !result.cues.length });
      const doc = buildDocument({
        projectId: job.projectId, origin: 'generated', source, cues: result.cues, dropped: result.dropped,
        engine: { modelId: run.modelId, modelLabel: run.model.label, language, device: result.device, deviceLabel: described.deviceLabel, fellBack: result.fellBack }
      });
      if (!result.cues.length) {
        throw new AnalysisError('NO_SPEECH', 'Não encontrei fala neste vídeo (só silêncio, música ou ruído). Nada foi guardado.');
      }
      store.save(job.projectId, doc);
      this.job = null;
      this.emit('done', { jobId: job.id, projectId: job.projectId, status: summarize(doc, source), speed: result.transcribeMs > 0 ? Math.round((result.audioSec / (result.transcribeMs / 1000)) * 10) / 10 : null, deviceNote: described.deviceNote });
    } catch (err) {
      this.job = null;
      const cancelledErr = err && err.code === 'CANCELLED';
      const draft = store.getDraft(job.projectId);
      const out = {
        jobId: job.id, projectId: job.projectId,
        code: err && typeof err.code === 'string' ? err.code : 'ERROR',
        message: cancelledErr ? 'Transcrição cancelada. O que já foi transcrito fica guardado para retomar.' : (err && err.message ? err.message : 'Erro inesperado na transcrição.')
      };
      if (err && err.details !== undefined && !(err instanceof SubtitleFileError)) out.details = err.details;
      if (draft && sameSource(draft.source, source) && draft.partial.doneUntil > 0) { out.resumable = true; out.doneUntil = draft.partial.doneUntil; }
      this.emit('failed', out);
    } finally {
      if (run) this.deps.engine.releaseRun(run);
    }
  }

  cancel(jobId) {
    if (!this.job || (jobId && jobId !== this.job.id)) return false;
    this.job.abort.abort();
    return true;
  }

  killAll() { if (this.job) this.job.abort.abort(); }
}

module.exports = { TranscriptManager, SubtitleFileError, normalizeCues };

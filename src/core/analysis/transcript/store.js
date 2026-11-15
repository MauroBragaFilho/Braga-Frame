'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic, readJsonFile } = require('../../preferences/atomic');
const { readDocument, FORMAT, VERSION } = require('./format');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Guarda a transcrição de cada projeto em <dir>/<projectId>.json (e o rascunho de uma geração interrompida em
 * <projectId>.partial.json, para retomar). Arquivos nossos em userData: apagar aqui nunca toca em arquivo do usuário.
 */
class TranscriptStore {
  constructor(dir) { this.dir = dir; }

  _file(projectId, suffix = '') {
    if (!ID_RE.test(String(projectId))) throw Object.assign(new Error('Identificador de projeto inválido.'), { code: 'INVALID_ARGS' });
    return path.join(this.dir, `${projectId}${suffix}.json`);
  }

  get(projectId) {
    try {
      const { data } = readJsonFile(this._file(projectId));
      return readDocument(data);
    } catch (err) {
      if (err && err.code === 'INVALID_ARGS') throw err;
      return null;
    }
  }

  save(projectId, doc) {
    writeJsonAtomic(this._file(projectId), doc, { compact: true });
    this.clearDraft(projectId);
  }

  remove(projectId) {
    let removed = false;
    for (const suffix of ['', '.partial']) {
      try { fs.rmSync(this._file(projectId, suffix)); removed = true; } catch (err) { if (err && err.code === 'INVALID_ARGS') throw err; }
    }
    return removed;
  }

  /** Rascunho de uma geração em andamento: { format, version, partial:{ doneUntil, chunkSec, modelId, language }, source, cues }. */
  getDraft(projectId) {
    try {
      const { data } = readJsonFile(this._file(projectId, '.partial'));
      if (data && data.format === FORMAT && data.version === VERSION && data.partial && Array.isArray(data.cues)) return data;
    } catch (err) { if (err && err.code === 'INVALID_ARGS') throw err; }
    return null;
  }

  saveDraft(projectId, draft) {
    writeJsonAtomic(this._file(projectId, '.partial'), { format: FORMAT, version: VERSION, ...draft }, { compact: true });
  }

  clearDraft(projectId) {
    try { fs.rmSync(this._file(projectId, '.partial'), { force: true }); } catch { /* nada a limpar */ }
  }
}

module.exports = { TranscriptStore, ID_RE };

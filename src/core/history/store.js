'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { healStrings } = require('../projects/mojibake');

/** Mesmo limite de um id de projeto (hash hexadecimal), com folga; nada de separadores de pasta. */
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const VERSION = 1;
const DEFAULT_MAX_GROUPS = 5000;

function problem(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Histórico de decisões por projeto, em `<dir>/<projectId>.json` (dono: review). Só acrescenta:
 * desfazer e restaurar também são grupos novos. Gravação atômica (tmp + rename), uma por vez por
 * projeto. Arquivo ilegível é preservado como `.corrupt` e o histórico recomeça (nunca é apagado).
 * Ao passar de `maxGroups`, os grupos MAIS ANTIGOS saem do arquivo e a contagem fica em `dropped`
 * (a interface avisa).
 *
 * Formato: { version: 1, projectId, updatedAt, dropped, groups: [grupo] } — o grupo é definido em
 * `history/log.js`.
 */
class HistoryStore {
  constructor(dir, { maxGroups = DEFAULT_MAX_GROUPS } = {}) {
    this.dir = dir;
    this.maxGroups = maxGroups;
    this.chains = new Map(); // projectId -> Promise (fila de gravações)
    fs.mkdirSync(dir, { recursive: true });
  }

  fileFor(projectId) {
    if (typeof projectId !== 'string' || !ID_RE.test(projectId)) {
      throw problem('INVALID_ARGS', 'Identificador de projeto inválido para o histórico.');
    }
    return path.join(this.dir, `${projectId}.json`);
  }

  /** Lê o arquivo. Nunca lança por conteúdo ruim: preserva como .corrupt e devolve vazio. */
  _read(projectId) {
    const file = this.fileFor(projectId);
    if (!fs.existsSync(file)) return { groups: [], dropped: 0 };
    try {
      const data = healStrings(JSON.parse(fs.readFileSync(file, 'utf8'))).data; // texto estragado por outra ferramenta volta ao normal (mojibake.js)
      if (!data || typeof data !== 'object' || data.version > VERSION || !Array.isArray(data.groups)) throw new Error('formato desconhecido');
      return { groups: data.groups, dropped: Number(data.dropped) || 0 };
    } catch (err) {
      if (err instanceof SyntaxError || /formato desconhecido/.test(err.message)) {
        try { fs.renameSync(file, `${file}.${Date.now()}.corrupt`); } catch { /* segue sem o histórico antigo */ }
        return { groups: [], dropped: 0, recovered: true };
      }
      throw err;
    }
  }

  /** { groups, dropped, recovered? } do projeto. */
  load(projectId) {
    return this._read(projectId);
  }

  /** Acrescenta grupos (na ordem) e grava. Devolve { count, dropped }. */
  append(projectId, newGroups) {
    this.fileFor(projectId); // valida o id já
    if (!Array.isArray(newGroups) || newGroups.some((g) => !g || typeof g !== 'object' || typeof g.id !== 'string' || !Array.isArray(g.items))) {
      return Promise.reject(problem('INVALID_ARGS', 'Grupos de histórico inválidos.'));
    }
    const run = () => {
      const current = this._read(projectId);
      const known = new Set(current.groups.map((g) => g.id));
      let groups = [...current.groups, ...newGroups.filter((g) => !known.has(g.id))];
      let dropped = current.dropped;
      if (groups.length > this.maxGroups) {
        dropped += groups.length - this.maxGroups;
        groups = groups.slice(-this.maxGroups);
      }
      const file = this.fileFor(projectId);
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, projectId, updatedAt: new Date().toISOString(), dropped, groups }));
        fs.renameSync(tmp, file);
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw problem('HISTORY_WRITE_FAILED', `Não foi possível gravar o histórico: ${err.message}`);
      }
      return { count: groups.length, dropped };
    };
    return this._enqueue(projectId, run);
  }

  _enqueue(projectId, run) {
    const previous = this.chains.get(projectId) || Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.chains.set(projectId, next);
    next.catch(() => {}).then(() => { if (this.chains.get(projectId) === next) this.chains.delete(projectId); });
    return next;
  }

  /**
   * Copia o histórico de um projeto para outro (ex.: depois de adotar os cortes para uma versão nova do
   * vídeo: os ids dos cortes são os mesmos). Nunca sobrescreve: se o destino já tem histórico, não faz
   * nada. O histórico de origem fica como está. Devolve { copied, count, reason? }.
   */
  copy(fromId, toId) {
    const fromFile = this.fileFor(fromId);
    const toFile = this.fileFor(toId);
    if (fromFile === toFile) return Promise.resolve({ copied: false, count: 0, reason: 'SAME_PROJECT' });
    return this._enqueue(toId, () => {
      const source = this._read(fromId);
      if (!source.groups.length) return { copied: false, count: 0, reason: 'EMPTY' };
      if (this._read(toId).groups.length) return { copied: false, count: 0, reason: 'TARGET_HAS_HISTORY' };
      const tmp = `${toFile}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, projectId: toId, updatedAt: new Date().toISOString(), dropped: source.dropped, groups: source.groups }));
        fs.renameSync(tmp, toFile);
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw problem('HISTORY_WRITE_FAILED', `Não foi possível copiar o histórico: ${err.message}`);
      }
      return { copied: true, count: source.groups.length };
    });
  }
}

module.exports = { HistoryStore, ID_RE, VERSION, DEFAULT_MAX_GROUPS };

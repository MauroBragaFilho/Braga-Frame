'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']); // antivírus/indexador segurando o arquivo por um instante (Windows)

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Persistência do estado da fila (`queue.json`). Gravação atômica: escreve em `queue.json.<pid>.tmp`,
 * força o disco (fsync) e só então renomeia sobre o arquivo final. Uma queda no meio da gravação deixa
 * o arquivo anterior intacto. Um arquivo ilegível nunca é apagado: é guardado como `.corrupt`.
 */
class QueueStore {
  /**
   * @param {string} file caminho do queue.json
   * @param {object} [opts] { fsImpl (testes: injeta falhas), retries, retryDelayMs }
   */
  constructor(file, { fsImpl = fs, retries = 6, retryDelayMs = 30 } = {}) {
    this.file = file;
    this.fs = fsImpl;
    this.retries = retries;
    this.retryDelayMs = retryDelayMs;
    this.dir = path.dirname(file);
    this.base = path.basename(file);
  }

  /** Apaga sobras `queue.json.*.tmp` de uma gravação interrompida (só os nossos arquivos temporários). */
  cleanTemp() {
    try {
      for (const name of this.fs.readdirSync(this.dir)) {
        if (name.startsWith(`${this.base}.`) && name.endsWith('.tmp')) this.fs.rmSync(path.join(this.dir, name), { force: true });
      }
    } catch { /* pasta ainda não existe: nada a limpar */ }
  }

  /**
   * Lê o estado. Devolve { data, warning }: `data` é null quando não há arquivo (ou ele foi preservado
   * como .corrupt / .vN.bak); `warning` explica o que aconteceu, em português.
   */
  read() {
    this.cleanTemp();
    let text;
    try {
      text = this.fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { data: null, warning: null };
      return { data: null, warning: `Não foi possível ler a fila salva (${err.message}); os trabalhos antigos não foram carregados. Confira as permissões da pasta de dados do app.`, unreadable: true };
    }
    let data;
    try {
      data = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
    } catch {
      return this._preserve('corrupt', 'O arquivo da fila estava corrompido e foi guardado ao lado do original (.corrupt); a fila começou vazia.');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.jobs)) {
      return this._preserve('corrupt', 'O arquivo da fila não tem o formato esperado e foi guardado ao lado do original (.corrupt); a fila começou vazia.');
    }
    if (Number.isInteger(data.version) && data.version > VERSION) {
      return this._preserve(`v${data.version}.bak`, `A fila foi salva por uma versão mais nova do app (formato ${data.version}); a cópia foi mantida e a fila começou vazia.`);
    }
    return { data, warning: null };
  }

  /**
   * Guarda o arquivo atual ao lado (`.corrupt`) quando ele é legível, mas o conteúdo não pôde ser usado (estrutura que o
   * gerenciador não consegue interpretar). Devolve { warning, preservedAs? } como o `read()`; nunca apaga o original.
   */
  quarantine(warning) {
    return this._preserve('corrupt', warning);
  }

  _preserve(suffix, warning) {
    const target = `${this.file}.${Date.now()}.${suffix}`.replace(/\.\.+/g, '.');
    try {
      this.fs.renameSync(this.file, target);
    } catch (err) {
      return { data: null, warning: `${warning} (Não foi possível guardar a cópia: ${err.message}.)` };
    }
    return { data: null, warning, preservedAs: target };
  }

  /** Grava de forma atômica. Lança se não conseguir (o arquivo anterior continua válido). */
  write(data) {
    const payload = JSON.stringify({ ...data, version: VERSION, savedAt: new Date().toISOString() });
    const tmp = `${this.file}.${process.pid}.tmp`;
    // a pasta de dados já existe (o app a cria); se sumiu, a gravação falha em vez de recriá-la
    try {
      const fd = this.fs.openSync(tmp, 'w');
      try {
        this.fs.writeSync(fd, payload);
        this.fs.fsyncSync(fd);
      } finally {
        this.fs.closeSync(fd);
      }
      for (let attempt = 0; ; attempt++) {
        try {
          this.fs.renameSync(tmp, this.file);
          return;
        } catch (err) {
          if (!TRANSIENT.has(err.code) || attempt >= this.retries) throw err;
          sleepSync(this.retryDelayMs * (attempt + 1));
        }
      }
    } catch (err) {
      try { this.fs.rmSync(tmp, { force: true }); } catch { /* nada a fazer */ }
      throw err;
    }
  }
}

module.exports = { QueueStore, VERSION };

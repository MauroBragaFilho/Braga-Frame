'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ALGO_VERSION } = require('./params');

/**
 * Cache da análise em `userData/cache/analysis/` (arquivos nossos; apagar aqui nunca toca em arquivo do
 * usuário). Dois níveis:
 *  - `sig-*`: o que o ffmpeg extraiu de cada sinal (a parte cara), por fonte + parâmetros de extração;
 *  - `res-*`: o resultado final, por fonte + todos os parâmetros + arquivo de chat.
 * Mudar sensibilidade, pesos ou margens reaproveita os `sig-*` e recalcula só a combinação (instantâneo).
 * Gravação atômica (tmp + rename); arquivo ilegível ou de outra versão do algoritmo conta como ausente.
 */

const SAMPLE_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 80;

/**
 * "Hash leve" da fonte: tamanho + 3 trechos do arquivo (início, meio e fim, 256 KiB cada). Não depende
 * de nome nem de data (copiar/renomear o vídeo mantém o cache); gravação ainda crescendo muda o tamanho.
 */
function sourceKey(file) {
  const size = fs.statSync(file).size;
  const hash = crypto.createHash('sha1').update(`bf-analysis-source|${size}|`);
  const fd = fs.openSync(file, 'r');
  try {
    const offsets = size <= SAMPLE_BYTES * 3 ? [0] : [0, Math.floor(size / 2 - SAMPLE_BYTES / 2), size - SAMPLE_BYTES];
    const buf = Buffer.alloc(size <= SAMPLE_BYTES * 3 ? size : SAMPLE_BYTES);
    for (const offset of offsets) {
      const read = fs.readSync(fd, buf, 0, buf.length, offset);
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex').slice(0, 32);
}

const FILE_RE = /^(sig|res)-[a-z0-9-]+\.json$/;

class AnalysisCache {
  constructor(dir, { maxFiles = DEFAULT_MAX_FILES } = {}) {
    this.dir = dir;
    this.maxFiles = maxFiles;
  }

  _file(kind, key) {
    if (!/^[a-z0-9-]+$/.test(kind) || !/^[a-f0-9]+$/.test(key)) throw new Error('chave de cache inválida');
    return path.join(this.dir, `${kind}-${key}.json`);
  }

  /** Valor guardado ou null. */
  get(kind, key) {
    const file = this._file(kind, key);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw || raw.v !== ALGO_VERSION || raw.data === undefined) return null;
      const now = new Date();
      try { fs.utimesSync(file, now, now); } catch { /* uso recente é só para a limpeza */ }
      return raw.data;
    } catch {
      return null;
    }
  }

  set(kind, key, data) {
    const file = this._file(kind, key);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ v: ALGO_VERSION, createdAt: new Date().toISOString(), data }));
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignorar */ }
      throw err;
    }
    this.prune();
  }

  /** Mantém no máximo `maxFiles` arquivos de cache (apaga os usados há mais tempo) e limpa .tmp órfãos. */
  prune() {
    let names;
    try { names = fs.readdirSync(this.dir); } catch { return; }
    const entries = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      try {
        const st = fs.statSync(file);
        if (name.endsWith('.tmp')) {
          if (Date.now() - st.mtimeMs > 10 * 60 * 1000) fs.rmSync(file, { force: true });
        } else if (FILE_RE.test(name)) {
          entries.push({ file, mtime: st.mtimeMs });
        }
      } catch { /* sumiu no meio */ }
    }
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const { file } of entries.slice(0, Math.max(0, entries.length - this.maxFiles))) {
      try { fs.rmSync(file, { force: true }); } catch { /* em uso: fica para a próxima */ }
    }
  }
}

module.exports = { AnalysisCache, sourceKey, SAMPLE_BYTES };

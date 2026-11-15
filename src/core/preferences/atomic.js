'use strict';

const fs = require('node:fs');
const path = require('node:path');

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* sem espera */ }
}

/**
 * Grava JSON de forma atômica: arquivo temporário + fsync + rename. No Windows um antivírus ou o
 * indexador pode segurar o destino por instantes; o rename é repetido algumas vezes antes de desistir.
 * `compact: true` grava sem indentação (arquivos de máquina que crescem, como o learned.json: metade dos bytes e do tempo).
 */
function writeJsonAtomic(file, data, { compact = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, compact ? JSON.stringify(data) : JSON.stringify(data, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    let lastError = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try { fs.renameSync(tmp, file); return; } catch (err) {
        lastError = err;
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) break;
        sleepSync(25 * (attempt + 1));
      }
    }
    throw lastError;
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* sem o que limpar */ }
    throw err;
  }
}

/**
 * Lê um JSON de estado. Devolve { data, status } com status 'ok', 'missing' ou 'corrupt'. Arquivo
 * ilegível NUNCA é apagado: é renomeado para `<arquivo>.<data>.corrupt` e o chamador recomeça do zero.
 */
function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { data: null, status: 'missing' };
    throw err;
  }
  try {
    const data = JSON.parse(text);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('não é um objeto');
    return { data, status: 'ok' };
  } catch {
    let backup = null;
    try {
      backup = `${file}.${Date.now()}.corrupt`;
      fs.renameSync(file, backup);
    } catch { backup = null; }
    return { data: null, status: 'corrupt', backup };
  }
}

module.exports = { writeJsonAtomic, readJsonFile };

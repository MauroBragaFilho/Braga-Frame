'use strict';

/**
 * Log central do app em arquivo, com rotação por tamanho (`bragaframe.log`, `.1`, `.2`…).
 * Não depende do Electron: recebe a pasta. Escrita síncrona e nunca lança (log não derruba o app).
 * Compatível com `options.log` de createBfModule (objeto tipo console).
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_KEEP = 3;
const LEVELS = ['info', 'warn', 'error'];

function formatArg(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function createFileLogger({ dir, name = 'bragaframe', maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP, mirror = console, now = () => new Date() } = {}) {
  if (!dir || typeof dir !== 'string') throw new TypeError('createFileLogger: "dir" é obrigatório.');
  const file = path.join(dir, `${name}.log`);
  let ready = false;

  function ensureDir() {
    if (ready) return true;
    try { fs.mkdirSync(dir, { recursive: true }); ready = true; } catch { /* sem pasta: só espelha */ }
    return ready;
  }

  function rotate() {
    try {
      if (fs.statSync(file).size < maxBytes) return;
    } catch { return; }
    try {
      for (let i = keep - 1; i >= 1; i -= 1) {
        const from = `${file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
      }
      fs.renameSync(file, `${file}.1`);
      const oldest = `${file}.${keep + 1}`;
      if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
    } catch { /* rotação nunca derruba */ }
  }

  function write(level, args) {
    const line = `${now().toISOString()} [${level}] ${args.map(formatArg).join(' ')}\n`;
    if (ensureDir()) {
      try { rotate(); fs.appendFileSync(file, line); } catch { /* disco cheio, etc. */ }
    }
    const fn = mirror && (mirror[level] || mirror.log);
    if (typeof fn === 'function') { try { fn.call(mirror, line.trimEnd()); } catch { /* ignora */ } }
  }

  const logger = { file, dir };
  for (const level of LEVELS) logger[level] = (...args) => write(level, args);
  logger.log = logger.info;
  return logger;
}

/** Registra erros não tratados do processo principal. Devolve a função que desfaz o registro. */
function installCrashHandlers(logger, proc = process) {
  const onException = (err) => logger.error('uncaughtException:', err);
  const onRejection = (reason) => logger.error('unhandledRejection:', reason);
  proc.on('uncaughtException', onException);
  proc.on('unhandledRejection', onRejection);
  return () => {
    proc.removeListener('uncaughtException', onException);
    proc.removeListener('unhandledRejection', onRejection);
  };
}

module.exports = { createFileLogger, installCrashHandlers, DEFAULT_MAX_BYTES, DEFAULT_KEEP };

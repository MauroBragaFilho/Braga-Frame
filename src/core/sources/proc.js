'use strict';

/**
 * Executa programas externos (yt-dlp, TwitchDownloaderCLI) para a aba Novo projeto (sources): lê a saída linha a linha, aceita
 * cancelamento (AbortSignal) e limite de tempo, e só resolve DEPOIS de o processo ter saído. No Windows o
 * cancelamento derruba a árvore inteira (taskkill /T): o yt-dlp.exe empacotado cria um processo filho e chama
 * o ffmpeg para juntar vídeo e áudio. A saída é sempre lida como UTF-8 (o app define PYTHONIOENCODING).
 */

const { spawn, execFile } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

class ProcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProcError';
    this.code = code;
  }
}

/** Encerra o processo e os filhos dele; resolve quando o sistema respondeu ao pedido. */
function killTree(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    try {
      if (process.platform === 'win32' && child.pid) {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      } else {
        child.kill('SIGKILL');
        resolve();
      }
    } catch {
      resolve(); // já tinha terminado
    }
  });
}

/** Divide o fluxo em linhas, tratando "\r" (barras de progresso) e "\n" como fim de linha. */
function lineSplitter(onLine) {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  const feed = (text) => {
    carry += text;
    const parts = carry.split(/\r\n|\r|\n/);
    carry = parts.pop();
    for (const part of parts) if (part !== '') onLine(part);
  };
  return {
    write(chunk) { feed(decoder.write(chunk)); },
    end() { feed(decoder.end()); if (carry !== '') { onLine(carry); carry = ''; } }
  };
}

const MAX_CAPTURE = 64 * 1024 * 1024;

/**
 * @param {{ command:string, args?:string[], cwd?:string, env?:object, signal?:AbortSignal|null, timeoutMs?:number,
 *   onStdoutLine?:(line:string)=>void, onStderrLine?:(line:string)=>void, onSpawn?:(child)=>void,
 *   captureStdout?:boolean, captureStderr?:boolean }} o
 * @returns {Promise<{ code:number|null, stdout:string, stderr:string, reason:null|'cancelled'|'timeout', pid:number|undefined }>}
 *   Rejeita com ProcError('SPAWN') se o programa não pôde ser iniciado.
 *   `stderr` guarda sempre as últimas ~256 KB (para explicar erros); `stdout` só com captureStdout.
 */
function runProcess({ command, args = [], cwd, env, signal = null, timeoutMs = 0, onStdoutLine, onStderrLine, onSpawn, captureStdout = false, captureStderr = true }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { resolve({ code: null, stdout: '', stderr: '', reason: 'cancelled', pid: undefined }); return; }
    let child;
    try {
      child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new ProcError('SPAWN', `Não foi possível iniciar o programa (${err.message}).`));
      return;
    }
    if (onSpawn) { try { onSpawn(child); } catch { /* observador não pode derrubar o processo */ } }

    let stdout = '';
    let stderr = '';
    let reason = null;
    let settled = false;
    let timer = null;
    let spawnFailed = null;

    const stop = (why) => { if (!reason) reason = why; killTree(child); };
    const onAbort = () => stop('cancelled');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => stop('timeout'), timeoutMs);

    const out = lineSplitter((line) => { if (onStdoutLine) { try { onStdoutLine(line); } catch { /* idem */ } } });
    const err = lineSplitter((line) => { if (onStderrLine) { try { onStderrLine(line); } catch { /* idem */ } } });
    const decodeOut = new StringDecoder('utf8');
    const decodeErr = new StringDecoder('utf8');
    child.stdout.on('data', (chunk) => {
      out.write(chunk);
      if (captureStdout && stdout.length < MAX_CAPTURE) stdout += decodeOut.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      err.write(chunk);
      if (captureStderr) stderr = (stderr + decodeErr.write(chunk)).slice(-256 * 1024);
    });
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    child.on('error', (e) => {
      spawnFailed = e;
      // programa que nem chegou a iniciar (ENOENT, EACCES, EINVAL): não haverá "close" confiável
      if (!child.pid && !settled) {
        settled = true;
        cleanup();
        reject(new ProcError('SPAWN', `Não foi possível iniciar o programa (${e.message}).`));
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      out.end();
      err.end();
      if (captureStdout) stdout += decodeOut.end();
      if (spawnFailed && code === null) {
        reject(new ProcError('SPAWN', `Não foi possível iniciar o programa (${spawnFailed.message}).`));
        return;
      }
      resolve({ code, stdout, stderr, reason, pid: child.pid });
    });
    if (signal && signal.aborted) onAbort(); // abortou entre a checagem e o addEventListener
  });
}

module.exports = { runProcess, killTree, lineSplitter, ProcError };

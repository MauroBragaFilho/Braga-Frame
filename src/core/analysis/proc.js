'use strict';

const childProcess = require('node:child_process');
const os = require('node:os');
const { AnalysisError, cancelled } = require('./errors');

const STDERR_TAIL_BYTES = 4096;

/**
 * Roda o ffmpeg em segundo plano, com prioridade abaixo do normal (não atrapalha a interface nem uma live
 * em andamento). `onStdout(chunk)` recebe os dados em fluxo (nada é acumulado aqui). Cancelamento por
 * `signal` (AbortSignal): o processo é encerrado e a promessa só resolve DEPOIS de ele ter saído.
 *
 * Devolve { code, stderrTail } quando o processo termina; lança CANCELLED ou FFMPEG_START_FAILED.
 *
 * opts: { spawn, onSpawn(child), label }
 */
function runFfmpeg(ffmpeg, args, { onStdout, signal, spawn = childProcess.spawn, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(cancelled()); return; }
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new AnalysisError('FFMPEG_START_FAILED', `Não foi possível iniciar o ffmpeg (${err.message}). Confira se o FFmpeg está instalado e acessível na aba Ferramentas.`));
      return;
    }
    if (onSpawn) onSpawn(child);
    try { if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* prioridade é só uma gentileza */ }

    let tail = '';
    let wasCancelled = false;
    let settled = false;
    const onAbort = () => { wasCancelled = true; child.kill(); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      fn();
    };

    child.stdout.on('data', (chunk) => { if (onStdout && !wasCancelled) onStdout(chunk); });
    child.stderr.on('data', (chunk) => { tail = (tail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES); });
    child.on('error', (err) => finish(() => reject(new AnalysisError('FFMPEG_START_FAILED', `Não foi possível iniciar o ffmpeg (${err.message}). Confira se o FFmpeg está instalado e acessível na aba Ferramentas.`))));
    child.on('close', (code) => finish(() => {
      if (wasCancelled) reject(cancelled());
      else resolve({ code, stderrTail: tail.trim() });
    }));
    if (signal && signal.aborted) onAbort(); // abortou entre a checagem e o addEventListener
  });
}

/** Última linha útil do stderr do ffmpeg, para mensagens de erro. */
function lastLine(stderrTail) {
  const lines = String(stderrTail || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

module.exports = { runFfmpeg, lastLine };

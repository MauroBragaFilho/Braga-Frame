'use strict';

/**
 * Executa programas externos (ffmpeg, whisper-cli) para a geração de legendas: acompanha a saída linha a
 * linha, respeita cancelamento (AbortSignal) e limite de tempo, e só resolve depois que o processo terminou.
 * No Windows o cancelamento derruba a árvore de processos (taskkill /T) para não deixar filho para trás.
 */

const { spawn, execFile } = require('node:child_process');
const { SubtitlesError, cancelled } = require('./errors');

/** Encerra o processo e os filhos dele. */
function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* já tinha terminado */ }
}

/**
 * @param {{ command:string, args:string[], cwd?:string, env?:object, signal?:AbortSignal|null,
 *           onLine?:(line:string)=>void, timeoutMs?:number, capture?:boolean }} o
 *   capture: guarda a saída padrão inteira (para programas que "respondem" em stdout)
 * @returns {Promise<{ code:number|null, tail:string, stdout:string }>}
 *   `tail` = fim da saída combinada (stdout + stderr), para mensagens de erro.
 *   Rejeita com SubtitlesError: CANCELLED, TIMEOUT, NO_PROGRAM (não achou o executável), SPAWN.
 */
function runProcess({ command, args = [], cwd, env, signal = null, onLine = () => {}, timeoutMs = 0, capture = false }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(cancelled());
    let child;
    try {
      child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(new SubtitlesError('SPAWN', `Não foi possível iniciar ${command}: ${err.message}`));
    }
    let tail = '';
    let stdout = '';
    let reason = null;
    let finished = false;
    let timer = null;

    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    function onAbort() { reason = reason || 'cancelled'; killTree(child); }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => { reason = reason || 'timeout'; killTree(child); }, timeoutMs);

    const watch = (stream, keep) => {
      let carry = '';
      stream.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (keep) stdout += text;
        const parts = (carry + text).split(/\r\n|\n|\r/);
        carry = parts.pop();
        for (const line of parts) { tail = `${tail}${line}\n`.slice(-4000); onLine(line); }
      });
      stream.on('end', () => { if (carry) { tail = `${tail}${carry}\n`.slice(-4000); onLine(carry); } });
    };
    watch(child.stdout, capture);
    watch(child.stderr, false);

    child.on('error', (err) => {
      const missing = err.code === 'ENOENT';
      finish(reject, new SubtitlesError(missing ? 'NO_PROGRAM' : 'SPAWN',
        missing ? `Não encontrei o programa ${command}.` : `Não foi possível executar ${command}: ${err.message}`));
    });
    child.on('close', (code) => {
      if (reason === 'cancelled') return finish(reject, cancelled());
      if (reason === 'timeout') return finish(reject, new SubtitlesError('TIMEOUT', 'O programa demorou demais e foi interrompido.'));
      return finish(resolve, { code, tail, stdout });
    });
  });
}

module.exports = { runProcess, killTree };

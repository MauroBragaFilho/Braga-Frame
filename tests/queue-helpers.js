'use strict';

/**
 * Auxiliares dos testes da fila: pasta temporária, jobs de exemplo e um executor FALSO controlável
 * (o teste decide quando cada job termina, falha ou reporta progresso). Só isola o motor de exportação;
 * a fila, o disco e o relógio são os de verdade.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { QueueManager } = require('../src/core/queue');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tmpDir(name = 'queue') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bf-${name}-`));
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function waitUntil(cond, { timeout = 5000, what = 'a condição' } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    let ok = false;
    try { ok = await cond(); } catch { ok = false; }
    if (ok) return;
    await sleep(4);
  }
  throw new Error(`tempo esgotado esperando ${what}`);
}

/** Erro com código, como o ExportError do motor. */
function exportError(code, message, details) {
  const err = new Error(message || code);
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

/** Arquivo de origem de mentira (a fila só confere que ele existe). */
function makeSource(dir, name = 'fonte.mp4') {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, 'video');
  return file;
}

let seq = 0;
/** Job no formato do contrato 3.3. `i` muda o intervalo (e, portanto, a chave). */
function makeJob(dir, i = 0, extra = {}) {
  seq += 1;
  return {
    id: extra.id || `job-${seq}`,
    projectId: 'p1',
    projectTitle: 'Live de teste',
    sourcePath: extra.sourcePath || makeSource(dir),
    sourceInfo: { width: 1920, height: 1080, fps: 30, duration: 600, hasAudio: true },
    cut: { id: `cut-${i}`, title: `Corte ${i}`, category: 'clutch', status: 'approved', start: 10 + i * 20, end: 30 + i * 20, revision: 1, audio: { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0, history: [] }, subtitles: null, framing: null, exports: [] },
    profile: { id: 'vertical-1080-h264', name: 'Vertical 1080p', kind: 'vertical', width: 1080, height: 1920, codec: 'h264', bitrateKbps: 10000, container: 'mp4' },
    framing: null,
    outputDir: path.join(dir, 'Cortes'),
    baseName: `corte ${i}`,
    onConflict: 'ask',
    createdAt: new Date().toISOString(),
    ...extra
  };
}

/**
 * Executor falso. Cada chamada vira um item em `calls` com:
 *  finish(output?)   termina com sucesso (grava o arquivo de saída de verdade, salvo `write:false`)
 *  fail(err)         termina com erro
 *  progress(p)       reporta progresso
 *  aborted           true depois que a fila pediu para parar (o executor então rejeita com CANCELLED)
 * Com `autoFinish`, termina sozinho depois de `autoFinish` ms. `ignoreAbort` simula um executor que não obedece.
 */
function makeFakeRunner({ autoFinish = 0, ignoreAbort = false, write = true } = {}) {
  const calls = [];
  const state = { active: 0, maxActive: 0 };
  const runner = (job, opts) => new Promise((resolve, reject) => {
    const outputPath = path.join(job.outputDir, `${job.baseName}.mp4`);
    const call = {
      job, opts, index: calls.length, startedAt: Date.now(), done: false, aborted: false, outputPath,
      finish(output) {
        if (call.done) return;
        call.done = true;
        state.active -= 1;
        let target = output || outputPath;
        // como o motor real: em "rename" nunca grava sobre um arquivo existente
        if (!output && job.onConflict === 'rename' && fs.existsSync(target)) target = path.join(job.outputDir, `${job.baseName} (2).mp4`);
        if (write) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, `saida ${job.id}`); }
        resolve({ output: target, warnings: call.warnings || [] });
      },
      fail(err) {
        if (call.done) return;
        call.done = true;
        state.active -= 1;
        reject(err);
      },
      progress(p) { opts.onProgress(p); }
    };
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    calls.push(call);
    opts.signal.addEventListener('abort', () => {
      call.aborted = true;
      if (!ignoreAbort) call.fail(exportError('CANCELLED', 'Exportação cancelada.'));
    }, { once: true });
    if (autoFinish) setTimeout(() => call.finish(), autoFinish);
  });
  return { runner, calls, state, byJob: (id) => calls.filter((c) => c.job.id === id) };
}

/** Gerenciador de teste: relógio real, esperas curtas, ferramentas "presentes". */
function makeManager(dir, opts = {}) {
  const manager = new QueueManager({
    statePath: path.join(dir, 'queue.json'),
    tmpRoot: path.join(dir, 'queue-tmp'),
    tools: { ffmpeg: 'ffmpeg-de-teste' },
    backoffMs: 20,
    backoffMaxMs: 200,
    abortGraceMs: 300,
    progressIntervalMs: 0,
    updateIntervalMs: 3,
    ...opts
  });
  return manager;
}

const states = (manager) => manager.jobs.map((j) => j.state);
const stateOf = (manager, id) => (manager.jobs.find((j) => j.id === id) || {}).state;
const readState = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'));

/** Coleta os eventos de um canal do gerenciador. */
function collect(manager, event) {
  const list = [];
  manager.on(event, (payload) => list.push(payload));
  return list;
}

module.exports = { sleep, tmpDir, removeDir, waitUntil, exportError, makeSource, makeJob, makeFakeRunner, makeManager, states, stateOf, readState, collect };

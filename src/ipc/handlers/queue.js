'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { QueueManager, QueueError } = require('../../core/queue');

/**
 * Fila de exportação no IPC (contrato: docs/arquitetura.md 3.4; detalhes: docs/recursos/queue.md).
 *
 * Canais: queue:enqueue {jobs, force?}, queue:list, queue:pause {interrupt?}, queue:resume, queue:recover {action},
 * queue:cancel {id|all}, queue:reorder {ids}, queue:remove {id}, queue:retry {id}, queue:clearFinished {includeFailed?},
 * queue:getSettings, queue:setSettings {parallel, retries, recovery, onConflict, defaultParallel?},
 * queue:resolveConflict {id, action}.
 * Eventos: queue:update, queue:progress, queue:jobDone, queue:conflict, queue:recovery (também no ctx.bus).
 */

/** Variável só para testes automatizados: aponta um módulo com `runExportJob` no lugar do motor real. */
const TEST_RUNNER_VAR = 'BF_TEST_QUEUE_RUNNER';

/**
 * Carrega um módulo opcional de outro recurso (ainda pode não existir): tenta de novo a cada chamada até
 * conseguir. Devolve o módulo ou null; se o arquivo existe mas não carrega, o erro sobe (a fila o mostra).
 */
function lazyModule(request) {
  let cached = null;
  return () => {
    if (cached) return cached;
    try {
      require.resolve(request);
    } catch {
      return null; // o recurso dono ainda não entregou o arquivo
    }
    cached = require(request);
    return cached;
  };
}

/** Executor de teste: só com NODE_ENV=test, app não empacotado (isPackaged === false) e o arquivo existente. */
function testRunnerFromEnv(ctx, env) {
  const file = env[TEST_RUNNER_VAR];
  if (!file) return null;
  const packaged = !(ctx.app && ctx.app.isPackaged === false);
  if (env.NODE_ENV !== 'test' || packaged) {
    ctx.log('warn', `fila: ${TEST_RUNNER_VAR} ignorada (só vale com NODE_ENV=test e o app fora do pacote)`);
    return null;
  }
  if (!path.isAbsolute(file) || !fs.existsSync(file)) {
    ctx.log('warn', `fila: ${TEST_RUNNER_VAR} aponta para um arquivo que não existe: ${file}`);
    return null;
  }
  ctx.log('warn', `fila: usando o executor de TESTE ${file}; isto nunca deve ocorrer em produção`);
  const mod = require(file);
  return typeof mod === 'function' ? mod : mod.runExportJob;
}

/**
 * Cria o gerenciador ligado ao `ctx`. `overrides` (testes): { runner, preflight (false = sem pré-verificação), env, ...opções do QueueManager }.
 */
function createQueue(ctx, overrides = {}) {
  const { runner: runnerOverride, preflight: preflightOverride, env = process.env, ...managerOpts } = overrides;
  const jobRunner = lazyModule('../../core/export/jobRunner');
  const qc = lazyModule('../../core/export/qc');
  const injected = runnerOverride || testRunnerFromEnv(ctx, env);

  const manager = new QueueManager({
    statePath: path.join(ctx.paths.userData, 'queue.json'),
    tmpRoot: path.join(ctx.paths.cache, 'queue'),
    tools: ctx.tools, // objeto vivo: o caminho do ffmpeg é lido na hora de usar
    getRunner: () => injected || (jobRunner() && jobRunner().runExportJob) || null,
    getPreflight: () => (preflightOverride === false ? null : preflightOverride || (qc() && qc().preflight) || null),
    log: (level, msg) => ctx.log(level, msg),
    ...managerOpts
  });
  return manager;
}

function register(ctx, overrides) {
  const manager = createQueue(ctx, overrides);

  // evento -> renderer e ctx.bus (outros módulos do processo principal podem escutar); um ouvinte com defeito não derruba a fila
  const forward = (event, channel, payloadOf) => {
    manager.on(event, (data) => {
      try {
        const payload = payloadOf(data);
        ctx.bus.emit(channel, payload);
        ctx.send(channel, payload);
      } catch (err) {
        ctx.log('error', `fila: falha ao enviar ${channel}: ${err && err.message}`);
      }
    });
  };
  forward('update', 'queue:update', (s) => ({
    jobs: s.jobs, running: s.running, paused: s.paused, parallel: s.parallel, active: s.active, blocked: s.blocked,
    recovery: s.recovery, loadWarning: s.loadWarning, saveError: s.saveError, settings: s.settings
  }));
  forward('progress', 'queue:progress', (e) => e);
  forward('jobDone', 'queue:jobDone', (e) => e);
  forward('conflict', 'queue:conflict', (e) => e);
  forward('recovery', 'queue:recovery', (e) => e);

  manager.load();
  ctx.log('info', `fila: ${manager.jobs.length} trabalho(s) carregado(s)${manager.snapshot().recovery.pending ? ' (aguardando decisão de recuperação)' : ''}`);

  // outros recursos usam a fila (apagar um projeto leva o rastro dele) e o projeto com exportação na fila ou rodando não pode ser apagado
  ctx.queue = manager;
  if (Array.isArray(ctx.busyChecks)) {
    ctx.busyChecks.push((project) => {
      const active = manager.activeForProject({ projectId: project.id, sourcePath: project.source && project.source.path });
      if (!active.length) return null;
      return active.length === 1
        ? 'Há uma exportação deste projeto na fila ou em andamento. Cancele-a na aba Exportações antes de apagar o projeto.'
        : `Há ${active.length} exportações deste projeto na fila ou em andamento. Cancele-as na aba Exportações antes de apagar o projeto.`;
    });
  }

  // fechar o app: grava o estado agora, o que rodava vira "interrupted" e os processos do ffmpeg são mandados parar
  if (ctx.app && typeof ctx.app.on === 'function') ctx.app.on('before-quit', () => manager.shutdown());

  const fail = (code, message) => new QueueError(code, message);

  ctx.handle('queue:enqueue', ({ jobs, job, force }) => {
    const list = Array.isArray(jobs) ? jobs : (job ? [job] : null);
    if (!list) throw fail('INVALID_JOB', 'Informe os trabalhos da fila (jobs).');
    const views = manager.enqueue(list, { force: force === true });
    return { jobs: views, ids: views.map((j) => j.id) };
  });

  ctx.handle('queue:list', () => manager.list());
  ctx.handle('queue:pause', ({ interrupt }) => manager.pause({ interrupt: interrupt === true }));
  ctx.handle('queue:resume', () => manager.resume());
  ctx.handle('queue:recover', ({ action }) => manager.recover(action));
  ctx.handle('queue:cancel', (payload) => manager.cancel(payload));
  ctx.handle('queue:reorder', ({ ids }) => manager.reorder(ids));
  ctx.handle('queue:remove', ({ id }) => manager.remove(id));
  ctx.handle('queue:retry', ({ id }) => manager.retry(id));
  ctx.handle('queue:clearFinished', ({ includeFailed }) => manager.clearFinished({ includeFailed: includeFailed === true }));
  ctx.handle('queue:getSettings', () => ({ settings: manager.getSettings() }));
  ctx.handle('queue:setSettings', (patch) => ({ settings: manager.setSettings(patch) }));
  ctx.handle('queue:resolveConflict', ({ id, action }) => manager.resolveConflict(id, action));

  return manager;
}

module.exports = { register, createQueue, testRunnerFromEnv, TEST_RUNNER_VAR };

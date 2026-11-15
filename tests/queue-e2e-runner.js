'use strict';

/**
 * Executor usado SÓ pelo e2e da fila (injetado por BF_TEST_QUEUE_RUNNER, que o handler só aceita com
 * NODE_ENV=test e o app fora do pacote). Tudo vai para o motor REAL (src/core/export/jobRunner.js, com ffmpeg
 * de verdade); a única diferença é a falha passageira injetada de propósito (FFMPEG_CRASH, código recuperável do
 * contrato) para os trabalhos cujo nome tem "instável" ou "instável N" (N falhas antes de funcionar; padrão 2).
 * É assim que o e2e vê, na interface, a contagem regressiva e as tentativas automáticas da fila.
 */
const real = require('../src/core/export/jobRunner');

const injected = new Map(); // id do job -> falhas já injetadas

exports.runExportJob = async function runExportJob(job, opts) {
  const m = /instável(?: (\d+))?/i.exec(String(job.baseName || ''));
  if (m) {
    const wanted = m[1] === undefined ? 2 : Number(m[1]);
    const done = injected.get(job.id) || 0;
    if (done < wanted) {
      injected.set(job.id, done + 1);
      const err = new Error('O ffmpeg encerrou de forma inesperada (falha injetada pelo teste).');
      err.code = 'FFMPEG_CRASH';
      err.details = { stderr: 'falha injetada pelo teste e2e' };
      throw err;
    }
  }
  return real.runExportJob(job, opts);
};

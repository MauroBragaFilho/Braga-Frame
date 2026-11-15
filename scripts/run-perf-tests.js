#!/usr/bin/env node
'use strict';

/**
 * Testes de DESEMPENHO (fora do `npm test`): ligam BF_PERF_TESTS=1 e rodam tests/analysis-perf.test.js, que inclui a
 * análise de um vídeo de 20 minutos (leva alguns minutos e mede tempo e memória). Rode com o computador sem outra carga
 * pesada: a análise usa prioridade abaixo do normal e os números só fazem sentido em repouso.
 *
 * Uso: npm run test:perf
 */
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const env = { ...process.env, BF_PERF_TESTS: '1' };

console.log('Testes de desempenho (BF_PERF_TESTS=1): tests/analysis-perf.test.js (inclui o vídeo de 20 minutos)');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), 'tests/analysis-perf.test.js'], { cwd: ROOT, env, stdio: 'inherit' });
if (result.error) {
  console.error(`Não foi possível rodar os testes de desempenho: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);

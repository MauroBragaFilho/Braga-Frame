#!/usr/bin/env node
'use strict';

/**
 * Testes de REDE REAL (desligados no `npm test`): ligam BF_NETWORK_TESTS=1 e rodam
 *  - tests/sources-network.test.js: confere as entradas fixadas (yt-dlp, TwitchDownloaderCLI, Deno) contra a API oficial
 *    de releases do GitHub, instala o yt-dlp de verdade e baixa o vídeo público "Me at the zoo" numa pasta temporária;
 *  - tests/subtitles-whisper.test.js: instala o motor whisper.cpp oficial e o modelo tiny (~40 MB) numa pasta temporária;
 *  - tests/ai-openrouter-network.test.js: baixa o catálogo PÚBLICO de modelos do OpenRouter (sem chave, sem pedido de conversa) e
 *    confere o roteador gratuito, os gratuitos de texto adequados à análise e que nenhum "gratuito" tem preço maior que zero.
 *
 * Variáveis opcionais (passam direto): BF_NETWORK_TOOLS_ALL=1 também instala o TwitchDownloaderCLI (52 MB) e o Deno
 * (42 MB); BF_REQUIRE_NETWORK=1 faz o teste do whisper e o do catálogo do OpenRouter FALHAREM em vez de pular quando não há internet.
 * O YouTube às vezes pede "confirme que você não é um robô": o teste diz isso e se marca como pulado (não é falha do app).
 *
 * Os testes de provedor de IA COM CHAVE (tests/ai-real-network.test.js e tests/ai-openrouter-real.test.js) NÃO entram aqui: gastam a cota
 * do provedor e são opt-in por BF_AI_TEST_KEY (veja o cabeçalho de cada um; o do OpenRouter faz no máximo 8 pedidos de conversa).
 *
 * Uso: npm run test:network   (ou: node scripts/run-network-tests.js [argumentos extras do node --test])
 */
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const files = ['tests/sources-network.test.js', 'tests/subtitles-whisper.test.js', 'tests/ai-openrouter-network.test.js'];
const env = { ...process.env, BF_NETWORK_TESTS: '1' };
delete env.BF_SKIP_NETWORK_TESTS; // este modo existe justamente para usar a rede

console.log(`Testes de rede real (BF_NETWORK_TESTS=1): ${files.join(', ')}${env.BF_NETWORK_TOOLS_ALL === '1' ? ' (+ ferramentas grandes)' : ''}`);
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), ...files], { cwd: ROOT, env, stdio: 'inherit' });
if (result.error) {
  console.error(`Não foi possível rodar os testes de rede: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);

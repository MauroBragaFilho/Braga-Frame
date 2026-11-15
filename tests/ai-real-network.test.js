'use strict';

/**
 * Rede REAL com um provedor de verdade. Só roda com as três variáveis de ambiente (a chave NUNCA é pedida nem guardada em lugar nenhum):
 *   BF_AI_TEST_KEY    a chave de API
 *   BF_AI_TEST_URL    a URL base compatível com a OpenAI (ex.: https://generativelanguage.googleapis.com/v1beta/openai)
 *   BF_AI_TEST_MODEL  o modelo
 * Sem elas o teste é PULADO e a documentação marca "NÃO verificado em rede real". Faz uma chamada de teste de conexão e uma análise
 * curta (10 min de transcrição sintética, 2 chamadas) e confere que o JSON volta no formato e que a chave não aparece no resultado.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { AiRuntime } = require('../src/core/ai/runtime');
const { analyzeWithAi } = require('../src/core/analysis/ai/analyze');
const F = require('./ai-fakes');

const KEY = process.env.BF_AI_TEST_KEY;
const URL_BASE = process.env.BF_AI_TEST_URL;
const MODEL = process.env.BF_AI_TEST_MODEL;
const why = KEY && URL_BASE && MODEL ? false : 'sem BF_AI_TEST_KEY/BF_AI_TEST_URL/BF_AI_TEST_MODEL: NÃO verificado em rede real';

test('rede real: testar conexão e uma análise curta com o provedor informado nas variáveis de ambiente', { skip: why, timeout: 300000 }, async (t) => {
  const dir = F.tmpDir();
  t.after(() => F.cleanup(dir));
  const runtime = new AiRuntime({ dir: path.join(dir, 'ai'), safeStorage: null, restrict: () => {} });
  runtime.save({ provider: 'custom', baseUrl: URL_BASE, model: MODEL, apiKey: KEY });
  runtime.accept(true);
  const conn = await runtime.test();
  assert.equal(conn.ok, true);
  t.diagnostic(`conexão: ${conn.ms} ms`);

  const tr = F.makeTranscript({ minutes: 10, moments: [{ at: 200, punch: 'o bicho nem dropou couro' }] });
  const result = await analyzeWithAi(
    { duration: tr.duration, hasAudio: true, params: { perHour: 20, minRelevance: 0.3 }, transcript: { cues: tr.cues }, chat: null, meta: { title: 'Teste de rede real' }, existingCuts: [] },
    { chat: (p) => runtime.chat(p), provider: { label: 'real', model: MODEL }, limits: runtime.limits() }
  );
  t.diagnostic(`análise real: ${result.suggestions.length} sugestão(ões), ${result.ai.calls} chamada(s), ${result.ai.promptTokens}+${result.ai.completionTokens} tokens, descartes: ${JSON.stringify(result.ai.droppedByReason)}`);
  assert.ok(result.ai.calls >= 1);
  assert.ok(!F.mentions(result, KEY));
  for (const f of F.readAll(dir)) assert.ok(!f.text.includes(KEY), f.file);
});

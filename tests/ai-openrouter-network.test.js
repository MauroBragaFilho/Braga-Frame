'use strict';

/**
 * OpenRouter "só com modelos gratuitos": REDE REAL SEM CHAVE. Fica DESLIGADO por padrão (o conjunto normal não depende de internet);
 * ligue com  BF_NETWORK_TESTS=1 node --test tests/ai-openrouter-network.test.js
 * Baixa de verdade o catálogo PÚBLICO (https://openrouter.ai/api/v1/models, sem chave) e confere os invariantes da lista: o roteador
 * gratuito presente e primeiro, ao menos um gratuito de texto adequado à análise, nenhum modelo com preço maior que zero entre os gratuitos
 * (conferido de forma independente do código do app, direto no JSON baixado), a ordem certa e o cache. Imprime quantos gratuitos e quantos
 * adequados há hoje. NÃO faz nenhuma chamada de conversa (sem chave): as de conversa ficam em tests/ai-openrouter-real.test.js (opt-in, com BF_AI_TEST_KEY).
 * Sem internet o teste é PULADO com o motivo (BF_REQUIRE_NETWORK=1 faz falhar em vez de pular).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { OpenRouterCatalog, buildModelList, countGroups, ROUTER_ID, CACHE_FILE } = require('../src/core/ai/openrouter/catalog');
const { checkModel } = require('../src/core/ai/openrouter/guard');
const F = require('./ai-openrouter-fakes');

const ON = process.env.BF_NETWORK_TESTS === '1';
const skip = ON ? false : 'rede real desligada (BF_NETWORK_TESTS=1 liga)';

/** Preço de um campo do catálogo como número, sem usar o código do app (texto vazio/ausente = não é preço). */
const price = (v) => (typeof v === 'string' && /^[+-]?\d*\.?\d+(?:e[+-]?\d+)?$/i.test(v.trim()) ? Number(v) : (typeof v === 'number' ? v : NaN));

test('rede real: catálogo público do OpenRouter -> roteador primeiro, gratuitos de texto adequados, nenhum preço > 0 entre os gratuitos, ordem e cache', { skip, timeout: 120000 }, async (t) => {
  const dir = F.tmpDir('bf-or-net-');
  t.after(() => F.cleanup(dir));
  const aiDir = path.join(dir, 'ai');

  const catalog = new OpenRouterCatalog({ dir: aiDir });
  const loaded = await catalog.load({ refresh: true });
  if (loaded.source !== 'rede') {
    const why = `sem internet ou OpenRouter fora do ar (${loaded.error ? loaded.error.message : 'erro desconhecido'})`;
    if (process.env.BF_REQUIRE_NETWORK === '1') assert.fail(why);
    t.skip(why);
    return;
  }

  // o mesmo catálogo, direto da fonte, para conferir sem passar pelo código do app
  const res = await fetch('https://openrouter.ai/api/v1/models', { headers: { accept: 'application/json' } });
  assert.equal(res.status, 200);
  const raw = (await res.json()).data;
  assert.ok(Array.isArray(raw) && raw.length > 50, `o catálogo veio com ${raw && raw.length} modelos`);
  const rawById = new Map(raw.map((m) => [m.id, m]));

  const now = Date.now();
  const list = buildModelList(loaded.models, { now });
  const counts = countGroups(list);
  const suitable = list.filter((x) => x.group === 'free');
  const others = list.filter((x) => x.group === 'otherFree');
  const catalogFree = loaded.models.filter((m) => m.isFree);
  console.log(`\n  OpenRouter hoje (${new Date(now).toISOString()}): ${raw.length} modelos no catálogo; ${catalogFree.length} com preço zero (contando o roteador); ${suitable.length} gratuitos adequados à análise + o roteador; ${others.length} outros gratuitos.`);
  t.diagnostic(`catálogo: ${raw.length} modelos; ${catalogFree.length} com preço zero; ${suitable.length} gratuitos adequados (+ roteador); ${others.length} outros gratuitos`);

  // 1. o roteador gratuito: primeiro e presente
  assert.equal(list[0].id, ROUTER_ID);
  assert.equal(list.filter((x) => x.id === ROUTER_ID).length, 1);
  assert.ok(rawById.has(ROUTER_ID), 'o roteador gratuito consta no catálogo público');
  assert.equal(price(rawById.get(ROUTER_ID).pricing.prompt), 0);
  assert.equal(price(rawById.get(ROUTER_ID).pricing.completion), 0);

  // 2. ao menos um gratuito de texto adequado
  assert.ok(suitable.length >= 1, 'deveria haver ao menos um modelo gratuito de texto adequado à análise');
  for (const item of suitable) {
    assert.ok(item.isText && item.supportsJson && item.contextLength >= 60000, item.id);
    assert.deepEqual(item.reasons, [], item.id);
    const r = rawById.get(item.id);
    assert.deepEqual(r.architecture.output_modalities, ['text'], `${item.id}: saída só texto`);
    assert.ok(r.architecture.input_modalities.includes('text'), item.id);
    assert.ok(r.supported_parameters.includes('response_format') || r.supported_parameters.includes('structured_outputs'), item.id);
    assert.ok(!/safety|guard|moderation|embed|rerank/i.test(item.id), item.id);
  }

  // 3. NENHUM modelo com preço > 0 entre os gratuitos (conferido no JSON bruto, sem usar o código do app)
  for (const item of list) {
    const r = rawById.get(item.id);
    if (!r) { assert.equal(item.id, ROUTER_ID); continue; }
    assert.equal(price(r.pricing.prompt), 0, `${item.id}: prompt`);
    assert.equal(price(r.pricing.completion), 0, `${item.id}: completion`);
    for (const [key, value] of Object.entries(r.pricing)) {
      if (key === 'prompt' || key === 'completion') continue;
      if (key === 'overrides') { assert.ok(!JSON.stringify(value).match(/"(?:prompt|completion|image|request)":"0\.\d*[1-9]/), `${item.id}: faixa paga`); continue; }
      const n = price(value);
      assert.ok(!(n > 0), `${item.id}: ${key}=${value} é um preço maior que zero`);
    }
  }
  // e o contrário: ninguém do catálogo com os dois preços zero e sem outra tarifa ficou de fora da lista
  const inList = new Set(list.map((x) => x.id));
  for (const m of raw) {
    const p = m.pricing || {};
    const onlyZeros = price(p.prompt) === 0 && price(p.completion) === 0 && Object.entries(p).every(([k, v]) => k === 'prompt' || k === 'completion' || k === 'overrides' || !(price(v) > 0));
    if (onlyZeros && typeof m.id === 'string') assert.ok(inList.has(m.id), `${m.id} tem preço zero e deveria estar na lista de gratuitos`);
  }

  // 4. a ordem: roteador, adequados (contexto maior primeiro), demais gratuitos; nenhum pago
  const groups = list.map((x) => x.group);
  assert.equal(groups[0], 'router');
  assert.equal(groups.indexOf('free'), 1, 'os adequados vêm logo abaixo do roteador');
  assert.ok(groups.lastIndexOf('free') < (groups.indexOf('otherFree') < 0 ? Infinity : groups.indexOf('otherFree')));
  assert.ok(!groups.includes('paid'));
  for (let i = 1; i < suitable.length; i += 1) assert.ok(suitable[i - 1].contextLength >= suitable[i].contextLength, `contexto em ordem decrescente (${suitable[i - 1].id} antes de ${suitable[i].id})`);
  assert.equal(counts.paid, 0);
  // com o interruptor desligado os pagos entram DEPOIS dos gratuitos, com preço
  const withPaid = buildModelList(loaded.models, { freeOnly: false, now });
  assert.deepEqual(withPaid.slice(0, list.length).map((x) => x.id), list.map((x) => x.id));
  const paid = withPaid.filter((x) => x.group === 'paid');
  assert.ok(paid.length > 20, 'há muitos modelos pagos de texto');
  assert.ok(paid.every((x) => x.price && (x.price.variable || x.price.unknown || (x.price.promptPerMillion >= 0 && x.price.completionPerMillion >= 0))));
  t.diagnostic(`modelos pagos de texto na lista com o interruptor desligado: ${paid.length}`);

  // 5. o guard com o catálogo de verdade: todos os da lista passam; um pago real e um id inventado não
  for (const item of list) assert.equal(checkModel(item.id, { models: loaded.models }).ok, true, item.id);
  for (const item of paid.slice(0, 5)) assert.equal(checkModel(item.id, { models: loaded.models }).ok, false, item.id);
  assert.equal(checkModel('inventado/nao-existe:free', { models: loaded.models }).ok, false);

  // 6. o cache foi gravado e vale (sem nova rede); sem rede, o último cache segue valendo
  assert.ok(fs.existsSync(path.join(aiDir, CACHE_FILE)));
  let calls = 0;
  const counting = new OpenRouterCatalog({ dir: aiDir, fetchImpl: async (...a) => { calls += 1; return fetch(...a); } });
  const cached = await counting.load();
  assert.equal(cached.source, 'cache');
  assert.equal(calls, 0);
  const offline = await new OpenRouterCatalog({ dir: aiDir, fetchImpl: async () => { throw new Error('sem rede'); } }).load({ refresh: true });
  assert.equal(offline.source, 'cache-antigo');
  assert.equal(offline.fetchedAt, loaded.fetchedAt);
  assert.equal(offline.models.length, loaded.models.length);
});

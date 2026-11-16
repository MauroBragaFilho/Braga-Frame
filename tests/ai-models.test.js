'use strict';

/**
 * LISTA DE MODELOS do provedor (docs/recursos/analise-ia.md, "Lista de modelos"): `GET {baseUrl}/models` com a chave guardada, só no processo
 * principal; ids sem o prefixo "models/" (Gemini), sem repetição e sem o que não conversa (embedding, voz, imagem). Servidor de mentira local.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { listModels } = require('../src/core/ai/client');
const { AiRuntime } = require('../src/core/ai/runtime');
const F = require('./ai-fakes');

const LIST = { object: 'list', data: [{ id: 'models/gemini-3.8-flash' }, { id: 'models/gemini-3.8-pro' }, { id: 'models/text-embedding-004' }, { id: 'models/imagen-4' }, { id: 'models/gemini-3.8-flash' }, { id: 'llama-3.3-70b-versatile' }, { id: 'whisper-large-v3' }] };

test('cliente: lista de modelos com a chave só no cabeçalho; tira "models/", repetidos e o que não conversa', async (t) => {
  const mock = await F.startMockAi(() => ({ json: LIST }));
  t.after(() => mock.close());
  const r = await listModels({ baseUrl: mock.base, apiKey: F.KEY });
  assert.deepEqual(r.models, ['gemini-3.8-flash', 'gemini-3.8-pro', 'llama-3.3-70b-versatile']);
  assert.equal(r.hidden, 3, 'embedding, imagem e transcrição ficam de fora');
  const c = mock.calls[0];
  assert.equal(c.method, 'GET');
  assert.equal(c.path, '/v1/models');
  assert.equal(c.headers.authorization, `Bearer ${F.KEY}`);
  assert.ok(!c.path.includes(F.KEY));
  // sem chave (servidor local, como o LM Studio): sem Authorization
  await listModels({ baseUrl: mock.base });
  assert.equal(mock.calls[1].headers.authorization, undefined);
});

test('cliente: servidor sem lista, chave recusada, http fora da máquina e resposta estranha viram erros claros, sem a chave', async (t) => {
  let reply = { status: 404, json: { error: { message: 'not found' } } };
  const mock = await F.startMockAi(() => reply);
  t.after(() => mock.close());
  await assert.rejects(listModels({ baseUrl: mock.base, apiKey: F.KEY }), (e) => e.code === 'NO_MODEL_LIST' && /Digite o nome/.test(e.message));
  reply = { status: 401, json: { error: { message: `bad key ${F.KEY}` } } };
  await assert.rejects(listModels({ baseUrl: mock.base, apiKey: F.KEY }), (e) => e.code === 'AUTH' && !e.message.includes(F.KEY));
  reply = { text: 'isto não é json' };
  await assert.rejects(listModels({ baseUrl: mock.base, apiKey: F.KEY }), (e) => e.code === 'BAD_RESPONSE');
  const before = mock.calls.length;
  await assert.rejects(listModels({ baseUrl: 'http://exemplo.com/v1', apiKey: F.KEY }), (e) => e.code === 'KEY_INSECURE');
  assert.equal(mock.calls.length, before, 'nem chega a pedir');
});

test('runtime: a lista usa a chave guardada do provedor em uso; pede a chave antes; OpenRouter e hospedeiro têm o próprio caminho', async (t) => {
  const mock = await F.startMockAi(() => ({ json: LIST }));
  t.after(() => mock.close());
  const dir = F.tmpDir();
  t.after(() => F.cleanup(dir));
  const runtime = new AiRuntime({ dir: path.join(dir, 'ai'), safeStorage: F.fakeSafeStorage(), restrict: () => {} });
  await assert.rejects(runtime.models(), (e) => e.code === 'NOT_CONFIGURED', 'sem provedor');
  runtime.save({ provider: 'groq' });
  await assert.rejects(runtime.models(), (e) => e.code === 'NO_KEY' && /Guarde a chave/.test(e.message), 'a lista depende da chave');
  runtime.save({ provider: 'openrouter' });
  await assert.rejects(runtime.models(), (e) => /própria lista/.test(e.message));
  // Personalizado num servidor local (LM Studio): sem chave funciona; com chave, ela vai no cabeçalho
  runtime.save({ provider: 'custom', baseUrl: mock.base, model: 'm' });
  const r = await runtime.models();
  assert.deepEqual([r.provider, r.models.length, r.hidden, r.current], ['custom', 3, 3, 'm']);
  runtime.save({ apiKey: F.KEY });
  await runtime.models();
  assert.equal(mock.calls[mock.calls.length - 1].headers.authorization, `Bearer ${F.KEY}`);
  const hosted = new AiRuntime({ dir: path.join(dir, 'ai2'), host: { describe: () => null, chat: async () => ({ text: '' }) }, hostName: 'BDS' });
  await assert.rejects(hosted.models(), (e) => /BDS/.test(e.message));
});

test('rede local: a lista de modelos também aceita a chave por http:// num endereço da rede, e continua recusando a internet', async () => {
  const seen = [];
  const body = { data: [{ id: 'combo-a' }, { id: 'combo-b' }] };
  const fetchImpl = async (url, init) => { seen.push({ url: String(url), init }); return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(body), json: async () => body }; };
  const r = await listModels({ baseUrl: 'http://192.168.0.10:20128/v1', apiKey: F.KEY, fetchImpl });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.headers.authorization, `Bearer ${F.KEY}`);
  assert.ok(JSON.stringify(r).includes('combo-a'));
  await assert.rejects(listModels({ baseUrl: 'http://203.0.113.7/v1', apiKey: F.KEY, fetchImpl }), (e) => e.code === 'KEY_INSECURE');
  assert.equal(seen.length, 1, 'para a internet nem chega a pedir');
});

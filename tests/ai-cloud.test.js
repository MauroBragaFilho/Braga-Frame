'use strict';

/**
 * IA na nuvem, camada de acesso: cliente `chat/completions` (cabeçalho de autenticação, erros, tentativas de formato, cancelamento),
 * armazenamento da chave (cifrado pelo sistema ou arquivo restrito, nunca em claro nem devolvido) e a configuração/aceite do provedor,
 * contra um servidor HTTP local de verdade (tests/ai-fakes.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chatCompletion, redact } = require('../src/core/ai/client');
const { SecretStore, usableSafeStorage } = require('../src/core/ai/secretStore');
const { AiRuntime } = require('../src/core/ai/runtime');
const providers = require('../src/core/ai/providers');
const F = require('./ai-fakes');

const ok = (content = '{"cuts":[]}') => ({ json: F.chatBody(content) });
const msgs = [{ role: 'user', content: 'oi' }];

// ---------- cliente ----------

test('cliente: chave só no cabeçalho Authorization; corpo no formato do protocolo; JSON mode pedido', async (t) => {
  const mock = await F.startMockAi(() => ok('{"a":1}'));
  t.after(() => mock.close());
  const res = await chatCompletion({ baseUrl: mock.base, apiKey: F.KEY, model: 'm1', system: 'sistema', messages: msgs, maxTokens: 123, temperature: 0.2, jsonMode: true });
  assert.equal(res.text, '{"a":1}');
  assert.deepEqual(res.usage, { promptTokens: 1200, completionTokens: 300 });
  const c = mock.calls[0];
  assert.equal(c.method, 'POST');
  assert.equal(c.path, '/v1/chat/completions');
  assert.equal(c.headers.authorization, `Bearer ${F.KEY}`);
  assert.equal(c.headers['content-type'], 'application/json');
  assert.deepEqual(c.body.messages, [{ role: 'system', content: 'sistema' }, ...msgs]);
  assert.equal(c.body.model, 'm1');
  assert.equal(c.body.max_tokens, 123);
  assert.equal(c.body.temperature, 0.2);
  assert.equal(c.body.stream, false);
  assert.deepEqual(c.body.response_format, { type: 'json_object' });
  assert.ok(!c.raw.includes(F.KEY) && !c.path.includes(F.KEY));
});

test('cliente: sem chave não manda Authorization; OpenAI oficial usa max_completion_tokens; resposta em partes de texto', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] }, finish_reason: 'stop' }] }) }; };
  const r = await chatCompletion({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k'.repeat(20), model: 'm', messages: msgs, maxTokens: 10, fetchImpl });
  assert.equal(r.text, 'ab');
  assert.equal(JSON.parse(seen[0].init.body).max_completion_tokens, 10);
  assert.equal(JSON.parse(seen[0].init.body).max_tokens, undefined);
  await chatCompletion({ baseUrl: 'https://servidor.exemplo/v1', model: 'm', messages: msgs, fetchImpl });
  assert.equal(seen[1].init.headers.authorization, undefined);
});

test('cliente: a chave nunca vai por http:// a servidor que não é a própria máquina (e nem chega a fazer a requisição)', async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; throw new Error('não devia chamar'); };
  await assert.rejects(() => chatCompletion({ baseUrl: 'http://servidor.exemplo/v1', apiKey: F.KEY, model: 'm', messages: msgs, fetchImpl }), (e) => e.code === 'KEY_INSECURE' && !e.message.includes(F.KEY));
  assert.equal(called, 0);
  // localhost por http vale
  const mock = await F.startMockAi(() => ok());
  try { await chatCompletion({ baseUrl: mock.base, apiKey: F.KEY, model: 'm', messages: msgs }); } finally { await mock.close(); }
});

test('cliente: servidor que não aceita response_format — repete sem ele e lembra', async (t) => {
  const mock = await F.startMockAi((call) => (call.body.response_format ? { status: 400, json: { error: { message: "Unsupported parameter: 'response_format'" } } } : ok('{"x":1}')));
  t.after(() => mock.close());
  const memory = new Set();
  const r = await chatCompletion({ baseUrl: mock.base, apiKey: F.KEY, model: 'm', messages: msgs, jsonMode: true, noJsonMode: memory });
  assert.equal(r.text, '{"x":1}');
  assert.equal(mock.calls.length, 2);
  await chatCompletion({ baseUrl: mock.base, apiKey: F.KEY, model: 'm', messages: msgs, jsonMode: true, noJsonMode: memory });
  assert.equal(mock.calls.length, 3, 'na segunda vez já vai sem response_format');
  assert.equal(mock.calls[2].body.response_format, undefined);
  // outro 400 qualquer não vira repetição
  const mock2 = await F.startMockAi(() => ({ status: 400, json: { error: { message: 'mensagens inválidas' } } }));
  t.after(() => mock2.close());
  await assert.rejects(() => chatCompletion({ baseUrl: mock2.base, model: 'm', messages: msgs, jsonMode: true }), (e) => e.code === 'BAD_REQUEST');
  assert.equal(mock2.calls.length, 1);
});

test('cliente: cada status vira um código estável, com Retry-After lido e a chave retirada do texto do servidor', async (t) => {
  const date = new Date(Date.now() + 30000).toUTCString();
  const cases = [
    [401, 'AUTH'], [403, 'AUTH'], [404, 'MODEL'], [429, 'RATE_LIMIT', { 'retry-after': '7' }, 7], [429, 'RATE_LIMIT', { 'retry-after': date }, 30],
    [500, 'SERVER'], [503, 'SERVER'], [408, 'SERVER'], [400, 'BAD_REQUEST'], [422, 'BAD_REQUEST']
  ];
  for (const [status, code, headers, retry] of cases) {
    const mock = await F.startMockAi(() => ({ status, headers: headers || {}, json: { error: { message: `falhou com a chave ${F.KEY} (${status})` } } }));
    try {
      await assert.rejects(() => chatCompletion({ baseUrl: mock.base, apiKey: F.KEY, model: 'm', messages: msgs }), (e) => {
        assert.equal(e.code, code, `status ${status}`);
        assert.equal(e.status, status);
        assert.ok(!e.message.includes(F.KEY), 'a chave do eco do servidor foi retirada');
        assert.ok(!JSON.stringify(e).includes(F.KEY));
        if (retry) assert.ok(Math.abs(e.retryAfterSec - retry) <= 2, `Retry-After ${e.retryAfterSec}`);
        return true;
      });
    } finally { await mock.close(); }
  }
  void t;
});

test('cliente: rede, tempo esgotado, resposta que não é de chat, queda no meio e cancelamento', async (t) => {
  // porta fechada
  const closed = await F.startMockAi(() => ok());
  const base = closed.base;
  await closed.close();
  await assert.rejects(() => chatCompletion({ baseUrl: base, apiKey: F.KEY, model: 'm', messages: msgs }), (e) => e.code === 'NETWORK' && !e.message.includes(F.KEY));
  // tempo esgotado
  const hang = await F.startMockAi(() => ({ hang: true }));
  t.after(() => hang.close());
  await assert.rejects(() => chatCompletion({ baseUrl: hang.base, model: 'm', messages: msgs, timeoutMs: 150 }), (e) => e.code === 'TIMEOUT');
  // 200 com lixo
  const junk = await F.startMockAi(() => ({ text: '<html>ola</html>' }));
  t.after(() => junk.close());
  await assert.rejects(() => chatCompletion({ baseUrl: junk.base, model: 'm', messages: msgs }), (e) => e.code === 'BAD_RESPONSE');
  const empty = await F.startMockAi(() => ({ json: { choices: [] } }));
  t.after(() => empty.close());
  await assert.rejects(() => chatCompletion({ baseUrl: empty.base, model: 'm', messages: msgs }), (e) => e.code === 'BAD_RESPONSE');
  // queda no meio do corpo
  const mid = await F.startMockAi(() => ({ dropMidway: '{"choices":[{"mess' }));
  t.after(() => mid.close());
  await assert.rejects(() => chatCompletion({ baseUrl: mid.base, model: 'm', messages: msgs }), (e) => ['INTERRUPTED', 'NETWORK'].includes(e.code));
  // cancelamento no meio e antes de começar
  const ctrl = new AbortController();
  const p = chatCompletion({ baseUrl: hang.base, model: 'm', messages: msgs, signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 80);
  await assert.rejects(() => p, (e) => e.code === 'CANCELLED');
  await assert.rejects(() => chatCompletion({ baseUrl: hang.base, model: 'm', messages: msgs, signal: ctrl.signal }), (e) => e.code === 'CANCELLED');
  // faltou configurar
  await assert.rejects(() => chatCompletion({ baseUrl: '', model: 'm', messages: msgs }), (e) => e.code === 'NOT_CONFIGURED');
  await assert.rejects(() => chatCompletion({ baseUrl: hang.base, model: '', messages: msgs }), (e) => e.code === 'NOT_CONFIGURED');
});

test('redact: tira a chave, "Bearer …" e trechos com cara de chave', () => {
  assert.equal(redact(`falhou ${F.KEY} fim`, F.KEY), 'falhou ••• fim');
  assert.equal(redact('Authorization: Bearer abcdefghijklmnop123', null), 'Authorization: Bearer •••');
  assert.ok(!redact('chave gsk_abcdefghijklmnopqrstuvwxyz123456 aqui', null).includes('gsk_abc'));
  assert.ok(!redact('AIzaSyAbcdefghijklmnopqrstuvwxyz0123456', null).includes('AIza'));
  assert.equal(redact('texto normal', 'curta'), 'texto normal');
  assert.equal(redact(null, F.KEY), '');
});

// ---------- armazenamento da chave ----------

test('SecretStore com safeStorage: cifrado, lê de volta, nunca em claro nem em base64 simples', (t) => {
  const dir = F.tmpDir();
  t.after(() => F.cleanup(dir));
  const file = path.join(dir, 'ai', 'secrets.json');
  const restricted = [];
  const store = new SecretStore({ file, safeStorage: F.fakeSafeStorage(), restrict: (f) => restricted.push(f) });
  assert.equal(store.mode(), 'safeStorage');
  assert.equal(store.has('gemini'), false);
  assert.equal(store.status('gemini'), 'none');
  store.set('gemini', F.KEY);
  assert.equal(store.has('gemini'), true);
  assert.equal(store.get('gemini'), F.KEY);
  assert.equal(store.status('gemini'), 'ok');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.includes('"mode":"safe"'));
  assert.ok(!raw.includes(F.KEY));
  assert.ok(!raw.includes(Buffer.from(F.KEY).toString('base64')), 'nem em base64 simples');
  assert.deepEqual(restricted, [file], 'permissão restrita aplicada ao arquivo');
  // trocar e remover
  store.set('gemini', `${F.KEY}-nova`);
  assert.equal(store.get('gemini'), `${F.KEY}-nova`);
  assert.equal(store.remove('gemini'), true);
  assert.equal(store.get('gemini'), null);
  assert.equal(store.remove('gemini'), false);
  // cifrada com um sistema que agora não está disponível: ilegível, nunca devolve lixo
  store.set('groq', F.KEY);
  const later = new SecretStore({ file, safeStorage: F.fakeSafeStorage({ available: false }), restrict: () => {} });
  assert.equal(later.has('groq'), true);
  assert.equal(later.get('groq'), null);
  assert.equal(later.status('groq'), 'unreadable');
});

test('SecretStore sem cifragem do sistema: cai para arquivo simples com permissão restrita e diz isso', (t) => {
  const dir = F.tmpDir();
  t.after(() => F.cleanup(dir));
  const file = path.join(dir, 'secrets.json');
  const restricted = [];
  for (const safe of [null, undefined, {}, F.fakeSafeStorage({ available: false }), { ...F.fakeSafeStorage(), getSelectedStorageBackend: () => 'basic_text' }]) {
    const store = new SecretStore({ file, safeStorage: safe, restrict: (f) => restricted.push(f) });
    assert.equal(store.mode(), 'file');
    assert.equal(usableSafeStorage(safe), false);
  }
  const store = new SecretStore({ file, safeStorage: null, restrict: (f) => restricted.push(f) });
  store.set('custom', F.KEY);
  assert.equal(store.get('custom'), F.KEY);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.entries.custom.mode, 'plain');
  assert.ok(restricted.includes(file));
  // safeStorage como função (só fica pronto depois do app.ready)
  let ready = false;
  const lazy = new SecretStore({ file: path.join(dir, 'lazy.json'), safeStorage: () => (ready ? F.fakeSafeStorage() : null), restrict: () => {} });
  assert.equal(lazy.mode(), 'file');
  ready = true;
  assert.equal(lazy.mode(), 'safeStorage');
});

test('SecretStore: valida a chave sem repeti-la na mensagem de erro; arquivo estragado não derruba', (t) => {
  const dir = F.tmpDir();
  t.after(() => F.cleanup(dir));
  const store = new SecretStore({ file: path.join(dir, 's.json'), safeStorage: null, restrict: () => {} });
  for (const bad of ['curta', 'com espaço no meio da chave 12345', 'x'.repeat(401), '', null]) {
    assert.throws(() => store.set('a', bad), (e) => /formato inválido/.test(e.message) && !e.message.includes('com espaço'));
  }
  assert.throws(() => store.set('../x', F.KEY), /Identificador/);
  fs.writeFileSync(path.join(dir, 's.json'), '{ quebrado');
  assert.equal(store.has('a'), false);
  assert.doesNotThrow(() => store.set('a', F.KEY));
  assert.equal(store.get('a'), F.KEY);
});

test('SecretStore no Windows: o arquivo de chaves fica só com a conta do usuário (icacls)', { skip: process.platform !== 'win32' && 'só no Windows' }, (t) => {
  const dir = F.tmpDir();
  t.after(() => F.cleanup(dir));
  const file = path.join(dir, 'ai', 'secrets.json');
  const store = new SecretStore({ file, safeStorage: null }); // restrição padrão (icacls de verdade)
  store.set('custom', F.KEY);
  const out = execFileSync('icacls', [file], { encoding: 'utf8', windowsHide: true });
  const principals = out.split(/\r?\n/).filter((l) => /:\(/.test(l));
  assert.equal(principals.length, 1, out);
  assert.ok(principals[0].toLowerCase().includes((process.env.USERNAME || '').toLowerCase()), out);
  assert.ok(!/\(I\)/.test(out), 'sem herança');
  assert.equal(store.get('custom'), F.KEY, 'o usuário continua lendo');
});

// ---------- configuração do provedor ----------

function runtimeIn(t, over = {}) {
  const dir = F.tmpDir();
  t.after(() => F.cleanup(dir));
  const runtime = new AiRuntime({ dir: path.join(dir, 'ai'), safeStorage: F.fakeSafeStorage(), restrict: () => {}, ...over });
  return { dir, runtime };
}

test('nenhum provedor vem pré-selecionado: o usuário escolhe o provedor e o modelo, e nada é enviado antes', async (t) => {
  const calls = [];
  const { runtime } = runtimeIn(t, { fetchImpl: async (...args) => { calls.push(args); throw new Error('a rede não podia ser chamada'); } });
  const st = runtime.state();
  assert.deepEqual(st.presets.map((p) => p.id), ['gemini', 'groq', 'openrouter', 'custom']);
  assert.equal(st.selected, null, 'nenhum provedor escolhido');
  assert.equal(st.source, 'local');
  assert.equal(st.provider.id, null);
  assert.equal(st.provider.ready, false);
  assert.equal(st.ready, false);
  assert.equal(st.accepted, false);
  assert.match(st.provider.reason, /Escolha o provedor/);
  assert.ok(st.presets.every((p) => !('model' in p) && typeof p.suggestedModel === 'string'), 'o modelo de cada provedor é só uma SUGESTÃO');
  // sem provedor escolhido não há o que configurar, aceitar, testar nem enviar
  for (const patch of [{ model: 'x' }, { apiKey: F.KEY }, { baseUrl: 'https://x/v1' }, { clearKey: true }]) assert.throws(() => runtime.save(patch), /Escolha o provedor/, JSON.stringify(Object.keys(patch)));
  assert.throws(() => runtime.accept(true), (e) => e.code === 'NOT_CONFIGURED' && /Escolha o provedor/.test(e.message));
  await assert.rejects(() => runtime.chat({ messages: msgs }), (e) => e.code === 'NOT_CONFIGURED');
  await assert.rejects(() => runtime.chat({ messages: msgs }, { requireConsent: false }), (e) => e.code === 'NOT_CONFIGURED');
  await assert.rejects(() => runtime.test(), (e) => e.code === 'NOT_CONFIGURED');
  assert.equal(calls.length, 0, 'nada saiu do computador');
  // salvar só os limites não escolhe provedor por ninguém
  const limits = runtime.save({ limits: { maxCalls: 20 } });
  assert.equal(limits.selected, null);
  assert.equal(limits.limits.maxCalls, 20);
  assert.equal(JSON.parse(fs.readFileSync(runtime.configFile, 'utf8')).provider, null);

  // escolher o provedor: o endereço vem do app, mas o MODELO continua vazio (há só uma sugestão) e a chave é pedida
  const gemini = runtime.save({ provider: 'gemini' });
  assert.equal(gemini.selected, 'gemini');
  assert.equal(gemini.provider.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(gemini.provider.model, '');
  assert.equal(gemini.provider.suggestedModel, 'gemini-2.5-flash');
  assert.equal(gemini.provider.ready, false);
  assert.match(gemini.provider.reason, /modelo/i);
  assert.match(runtime.save({ model: 'gemini-x' }).provider.reason, /chave/i);
  assert.equal(runtime.save({ apiKey: F.KEY }).provider.ready, true);
  assert.equal(calls.length, 0);
  for (const id of ['groq', 'openrouter']) { runtime.save({ provider: id }); assert.match(runtime.state().provider.baseUrl, /^https:\/\//); assert.equal(runtime.state().provider.model, id === 'openrouter' ? 'openrouter/free' : '', id === 'openrouter' ? 'única exceção (decisão do dono, 23/10/2026): o OpenRouter começa no roteador gratuito' : 'cada provedor tem o seu modelo, escolhido pelo usuário'); }
  assert.throws(() => runtime.save({ provider: 'groq', baseUrl: 'https://outro/v1' }), /só pode ser mudado no provedor Personalizado/);
  assert.throws(() => runtime.save({ provider: 'inexistente' }), /desconhecido/);
  assert.throws(() => runtime.save({ model: 'com espaço' }), /espaços/);
  runtime.save({ provider: 'custom', baseUrl: 'https://meu.servidor/v1/', model: 'meu-modelo' });
  assert.equal(runtime.state().provider.baseUrl, 'https://meu.servidor/v1');
  assert.throws(() => runtime.save({ baseUrl: 'ftp://x' }), /https/);
  assert.throws(() => runtime.save({ baseUrl: 'https://u:p@x/v1' }), /usuário ou senha/);
  assert.throws(() => runtime.save({ baseUrl: 'https://x/v1?a=1' }), /parâmetros/);
  assert.equal(providers.isLoopbackHost('127.0.0.1'), true);
  assert.equal(providers.isLoopbackHost('exemplo.com'), false);
  assert.equal(providers.DEFAULT_PROVIDER, undefined, 'não existe provedor padrão');
});

test('chave sem cifra (decisão do dono: aceito, mas avisado): o estado diz qual modo vale e a nota que a tela mostra', (t) => {
  // com a cifragem do sistema: nota discreta
  const safe = runtimeIn(t).runtime.state();
  assert.equal(safe.encryption, 'safeStorage');
  assert.match(safe.encryptionNote, /cifrada pelo Windows \(só a sua conta lê\)/);
  // o sistema não cifra (ou o app roda fora do Electron): arquivo simples com permissão restrita, e o aviso diz isso com todas as letras
  const { dir, runtime } = runtimeIn(t, { safeStorage: null });
  const st = runtime.state();
  assert.equal(st.encryption, 'file');
  assert.match(st.encryptionNote, /O sistema não oferece cifragem aqui/);
  assert.match(st.encryptionNote, /sem cifra/);
  assert.match(st.encryptionNote, /permissão restrita à sua conta/);
  // a chave guardada assim continua sendo guardada (risco aceito), nunca devolvida, e o arquivo é o simples (base64, sem cifra)
  const saved = runtime.save({ provider: 'groq', model: 'm', apiKey: F.KEY });
  assert.equal(saved.encryption, 'file');
  assert.equal(saved.provider.hasKey, true);
  assert.ok(!F.mentions(saved, F.KEY));
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'ai', 'secrets.json'), 'utf8'));
  assert.equal(doc.entries.groq.mode, 'plain');
  assert.equal(Buffer.from(doc.entries.groq.data, 'base64').toString('utf8'), F.KEY, 'é base64, NÃO é cifra: por isso o aviso');
});

test('configuração: a chave nunca volta ao chamador nem aparece no arquivo; só se sabe que existe', (t) => {
  const { dir, runtime } = runtimeIn(t);
  const after = runtime.save({ provider: 'groq', apiKey: F.KEY, model: 'llama-x' });
  assert.equal(after.provider.hasKey, true);
  assert.equal(after.provider.keyStatus, 'ok');
  assert.equal(after.provider.ready, true);
  assert.ok(!F.mentions(after, F.KEY) && !F.mentions(runtime.state(), F.KEY) && !F.mentions(runtime.describe(), F.KEY));
  for (const f of F.readAll(dir)) assert.ok(!f.text.includes(F.KEY), f.file);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'ai', 'config.json'), 'utf8'));
  assert.deepEqual(Object.keys(cfg).sort(), ['accepted', 'limits', 'provider', 'providers', 'version']);
  assert.equal(cfg.providers.groq.model, 'llama-x');
  // uma chave por provedor: trocar de provedor não leva a chave junto
  const other = runtime.save({ provider: 'gemini' });
  assert.equal(other.provider.hasKey, false);
  assert.equal(runtime.save({ provider: 'groq' }).provider.hasKey, true);
  // remover
  const cleared = runtime.save({ clearKey: true });
  assert.equal(cleared.provider.hasKey, false);
  assert.equal(cleared.provider.ready, false);
  // chave inválida: o erro não repete a chave
  assert.throws(() => runtime.save({ apiKey: 'tem espaço' }), (e) => /formato inválido/.test(e.message) && !e.message.includes('tem espaço'));
});

test('trocar o endereço do Personalizado = outro destinatário: o aceite é pedido de novo; a chave só some se o SERVIDOR mudou', async (t) => {
  const mock = await F.startMockAi(() => ok());
  t.after(() => mock.close());
  const { runtime } = runtimeIn(t);
  runtime.save({ provider: 'custom', baseUrl: 'https://a.exemplo/v1', model: 'm', apiKey: F.KEY });
  runtime.accept(true);
  assert.equal(runtime.state().accepted, true);
  runtime.save({ baseUrl: 'https://a.exemplo/v1/' }); // a mesma coisa, só a barra final
  assert.equal(runtime.state().provider.hasKey, true);
  assert.equal(runtime.state().accepted, true, 'o mesmo endereço mantém o aceite');
  // outro caminho no MESMO servidor: a chave fica, mas é outro destinatário e o aceite é pedido de novo
  runtime.save({ baseUrl: 'https://a.exemplo/outro-inquilino/v1' });
  assert.equal(runtime.state().provider.hasKey, true, 'mesma origem: a chave continua');
  assert.equal(runtime.state().accepted, false, 'outro endereço base = outro destinatário');
  assert.equal(runtime.state().provider.ready, true);
  runtime.accept(true);
  assert.equal(runtime.state().accepted, true);
  // outro servidor: a chave nunca é reenviada, e o aceite também some
  runtime.save({ baseUrl: 'https://b.exemplo/v1' });
  assert.equal(runtime.state().provider.hasKey, false, 'a chave nunca é reenviada a um servidor novo');
  assert.equal(runtime.state().accepted, false);
  // voltar ao primeiro endereço NÃO traz o aceite de volta (ele valia para o destinatário daquela época)
  runtime.save({ baseUrl: 'https://a.exemplo/v1' });
  assert.equal(runtime.state().accepted, false);
  // o aceite guarda o destinatário exato; um arquivo antigo, sem o endereço, também não vale para o Personalizado
  const cfgFile = runtime.configFile;
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.accepted = { custom: { origin: 'https://a.exemplo', at: '2020-01-01T00:00:00.000Z' } };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  assert.equal(runtime.state().accepted, false, 'aceite sem o endereço base: pede de novo');
  // com um servidor de verdade: nada é enviado enquanto o aceite do NOVO endereço não existe
  runtime.save({ baseUrl: mock.base, apiKey: F.KEY, model: 'm' });
  runtime.accept(true);
  await runtime.chat({ messages: msgs });
  assert.equal(mock.calls.length, 1);
  runtime.save({ baseUrl: `${mock.base}/x` });
  await assert.rejects(() => runtime.chat({ messages: msgs }), (e) => e.code === 'CONSENT_REQUIRED');
  assert.equal(mock.calls.length, 1, 'mudou o endereço: nada foi enviado');
});

test('aceite de privacidade: por provedor, revogável, e o chat recusa sem ele', async (t) => {
  const mock = await F.startMockAi(() => ok());
  t.after(() => mock.close());
  const { runtime } = runtimeIn(t);
  runtime.save({ provider: 'custom', baseUrl: mock.base, model: 'm', apiKey: F.KEY });
  assert.equal(runtime.state().accepted, false);
  await assert.rejects(() => runtime.chat({ messages: msgs }), (e) => e.code === 'CONSENT_REQUIRED');
  assert.equal(mock.calls.length, 0);
  runtime.accept(true);
  await runtime.chat({ messages: msgs });
  assert.equal(mock.calls.length, 1);
  // o aceite de um provedor não vale para outro
  runtime.save({ provider: 'groq', apiKey: F.KEY });
  assert.equal(runtime.state().accepted, false);
  runtime.save({ provider: 'custom' });
  assert.equal(runtime.state().accepted, true, 'continua lembrado');
  runtime.accept(false);
  assert.equal(runtime.state().accepted, false);
  await assert.rejects(() => runtime.chat({ messages: msgs }), (e) => e.code === 'CONSENT_REQUIRED');
});

test('aceite de privacidade NÃO expira: vale até o usuário revogar (nem o tempo, nem o uso, nem remover a chave o apagam)', async (t) => {
  const mock = await F.startMockAi(() => ok());
  t.after(() => mock.close());
  const { runtime } = runtimeIn(t);
  runtime.save({ provider: 'custom', baseUrl: mock.base, model: 'm', apiKey: F.KEY });
  runtime.accept(true);
  // o registro guarda QUANDO foi aceito (informação), mas nada lê essa data: um aceite de muito tempo atrás continua valendo
  const cfg = JSON.parse(fs.readFileSync(runtime.configFile, 'utf8'));
  assert.deepEqual(Object.keys(cfg.accepted.custom).sort(), ['at', 'baseUrl', 'origin']);
  cfg.accepted.custom.at = '2001-01-01T00:00:00.000Z';
  fs.writeFileSync(runtime.configFile, JSON.stringify(cfg));
  assert.equal(runtime.state().accepted, true, 'um aceite de 2001 continua valendo');
  // usar muitas vezes não o consome
  for (let i = 0; i < 5; i += 1) await runtime.chat({ messages: msgs });
  assert.equal(runtime.state().accepted, true);
  // um novo processo (reinício do app) lê o mesmo aceite
  const later = new AiRuntime({ dir: path.dirname(runtime.configFile), safeStorage: F.fakeSafeStorage(), restrict: () => {} });
  assert.equal(later.state().accepted, true);
  // remover só a chave não revoga o aceite (o destinatário não mudou); revogar é decisão do usuário
  runtime.save({ clearKey: true });
  assert.equal(runtime.state().accepted, true);
  runtime.save({ apiKey: F.KEY });
  assert.equal(runtime.state().accepted, true);
  runtime.accept(false);
  assert.equal(runtime.state().accepted, false);
});

test('limites: valores fora da faixa são corrigidos; chave guardada ilegível pede para informar de novo', (t) => {
  const { dir, runtime } = runtimeIn(t);
  const st = runtime.save({ limits: { maxCalls: 9999, maxInputTokens: 1, windowMinutes: '40', attempts: 'x' } });
  assert.deepEqual(st.limits, { maxCalls: 60, maxInputTokens: 4000, windowMinutes: 40, attempts: 3 });
  runtime.save({ provider: 'groq', apiKey: F.KEY, model: 'llama-x' });
  const later = new AiRuntime({ dir: path.join(dir, 'ai'), safeStorage: F.fakeSafeStorage({ available: false }), restrict: () => {} });
  later.save({ provider: 'groq' });
  assert.equal(later.state().provider.keyStatus, 'unreadable');
  assert.match(later.state().provider.reason, /não pôde ser lida/);
  assert.equal(later.state().ready, false);
});

test('modo hospedeiro (BDS): provedor e chave são do hospedeiro, só leitura; o Braga Frame não recebe a chave', async (t) => {
  const asked = [];
  const host = {
    describe: () => ({ id: 'groq', label: 'Groq', model: 'llama-3.3', hasKey: true, ready: true, serverHost: 'api.groq.com' }),
    chat: async (params) => { asked.push(params); return { text: '{"ok":true}', usage: { prompt_tokens: 5, completion_tokens: 2 }, model: 'llama-3.3' }; }
  };
  const { dir, runtime } = runtimeIn(t, { host, hostName: 'BDS' });
  const st = runtime.state();
  assert.equal(st.source, 'host');
  assert.equal(st.readOnly, true);
  assert.equal(st.provider.label, 'Groq');
  assert.equal(st.provider.hasKey, true);
  assert.equal(st.encryption, null);
  assert.deepEqual(st.presets, []);
  assert.throws(() => runtime.save({ provider: 'gemini' }), /BDS/);
  await assert.rejects(() => runtime.chat({ messages: msgs }), (e) => e.code === 'CONSENT_REQUIRED');
  runtime.accept(true);
  assert.equal(runtime.describe().consentKey, 'host:groq');
  const res = await runtime.chat({ system: 's', messages: msgs, maxTokens: 50, jsonMode: true });
  assert.equal(res.text, '{"ok":true}');
  assert.deepEqual(res.usage, { promptTokens: 5, completionTokens: 2 });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].jsonMode, true);
  assert.deepEqual(Object.keys(asked[0]).sort(), ['jsonMode', 'maxTokens', 'messages', 'signal', 'system', 'temperature']);
  // nenhum arquivo de chave é criado em modo hospedeiro
  assert.ok(!fs.existsSync(path.join(dir, 'ai', 'secrets.json')));
  // hospedeiro sem provedor configurado
  const none = new AiRuntime({ dir: path.join(dir, 'ai2'), host: { describe: () => null, chat: async () => ({ text: '' }) }, hostName: 'BDS' });
  assert.equal(none.state().ready, false);
  assert.match(none.state().provider.reason, /BDS/);
  await assert.rejects(() => none.chat({ messages: msgs }, { requireConsent: false }), (e) => e.code === 'NO_KEY' || e.code === 'NOT_CONFIGURED');
  // erro do hospedeiro passa como veio (status/código), sem chave
  const failing = new AiRuntime({ dir: path.join(dir, 'ai3'), host: { describe: host.describe, chat: async () => { throw Object.assign(new Error('Servidor (429)'), { status: 429, retryAfter: 3 }); } }, hostName: 'BDS' });
  failing.accept(true);
  await assert.rejects(() => failing.chat({ messages: msgs }), (e) => e.status === 429);
});

test('testar conexão: pedido fixo e minúsculo, sem dado do projeto; erro claro e sem a chave', async (t) => {
  const mock = await F.startMockAi((call) => (call.n === 1 ? ok('ok') : { status: 401, json: { error: { message: `chave ${F.KEY} recusada` } } }));
  t.after(() => mock.close());
  const { runtime } = runtimeIn(t);
  runtime.save({ provider: 'custom', baseUrl: mock.base, model: 'm', apiKey: F.KEY });
  const r = await runtime.test();
  assert.equal(r.ok, true);
  assert.match(r.message, /Conexão ok/);
  assert.equal(mock.calls[0].body.max_tokens, 16);
  assert.equal(mock.calls[0].body.messages.length, 2);
  assert.ok(mock.calls[0].raw.length < 400);
  await assert.rejects(() => runtime.test(), (e) => e.code === 'AUTH' && !e.message.includes(F.KEY));
  // sem configuração
  const { runtime: empty } = runtimeIn(t);
  await assert.rejects(() => empty.test(), (e) => e.code === 'NOT_CONFIGURED' && /Escolha o provedor/.test(e.message));
  empty.save({ provider: 'groq', model: 'm' });
  await assert.rejects(() => empty.test(), (e) => e.code === 'NO_KEY');
});

'use strict';

/**
 * O cartão "Transcrição (legendas automáticas)" da aba Ferramentas por dentro (renderer/features/transcription.js, BF.transcription), com o arquivo
 * de verdade rodando num DOM de mentira (tests/prefs-fakedom.js + fakedom-extra.js): os estados (lendo, sem motor, sem modelo, pronta, indisponível,
 * do hospedeiro), o que cada botão oferece, o plano do que baixar, o fluxo guiado (motor e depois modelo, uma confirmação só, volta à tela de origem),
 * falha e cancelamento no meio, o andamento redesenhando só a barra, a lista de modelos e o foco do teclado. O desenho real (CSS, janela, downloads
 * de verdade de servidores locais) é conferido em tests/e2e/transcription.e2e.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FakeNode, createDocument, makeEl } = require('./prefs-fakedom');
const { extendFakeDom } = require('./fakedom-extra');
const { MODELS } = require('../src/core/subtitles/models');

extendFakeDom();
// a barra indeterminada: no navegador, tirar o atributo `value` do <progress> a deixa sem valor
FakeNode.prototype.removeAttribute = function removeAttribute(key) { delete this.attrs[key]; if (key === 'value') this.value = ''; };

const CODE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features', 'transcription.js'), 'utf8');
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const idle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

const ENGINE_BYTES = 8573270;
const CUDA_BYTES = 674539285;

/** A resposta de subtitles:status (o que a aba lê), com o motor e os modelos do catálogo de verdade. */
function makeStatus(over = {}) {
  const status = {
    ok: true,
    engine: {
      id: 'whisper', installed: false, origin: null, kind: null, hostName: null, available: true, unavailableReason: null, sizeBytes: ENGINE_BYTES,
      cuda: { id: 'whisper-cuda', available: true, installed: false, fromApp: false, sizeBytes: CUDA_BYTES, managedByHost: false }
    },
    hardware: { pending: false, gpu: { available: false, name: null, summary: '' } },
    models: MODELS.map((m) => ({ id: m.id, label: m.label, description: m.description, sizeBytes: m.sizeBytes, installed: false, installedSizeBytes: 0, busy: false, recommended: m.id === 'small' })),
    defaultModel: 'small', modelsManagedByHost: false, hostName: null
  };
  const { engine, hardware, models, ...rest } = over;
  Object.assign(status, rest);
  if (engine) status.engine = { ...status.engine, ...engine, cuda: { ...status.engine.cuda, ...(engine.cuda || {}) } };
  if (hardware) status.hardware = hardware;
  if (models) status.models = status.models.map((m) => ({ ...m, ...(models[m.id] || {}) }));
  return status;
}

const installedEngine = (extra = {}) => ({ installed: true, origin: 'app', kind: 'cpu', ...extra });
const withModels = (...ids) => Object.fromEntries(ids.map((id) => [id, { installed: true, installedSizeBytes: MODELS.find((m) => m.id === id).sizeBytes }]));

/**
 * Carrega o módulo. `routes[canal](payload, state)` responde a um canal (devolva undefined para `{ ok: true }`); os padrões instalam de mentira
 * (mudam `state.status`) e subtitles:status devolve o `state.status` de agora. `answers`: o que cada confirmação responde (padrão: sim).
 */
function load({ status = makeStatus(), routes = {}, answers = [], tab = 'analysis' } = {}) {
  const doc = createDocument();
  const appNode = doc.register('app');
  appNode.dataset.activeTab = tab;
  const state = { status };
  const calls = [];
  const toasts = [];
  const logs = [];
  const asked = [];
  const tabs = [];
  const bus = new Map();
  const channels = new Map();
  const queue = [...answers];
  const emitted = [];
  const defaults = {
    'subtitles:status': () => plain(state.status),
    'subtitles:hardware': () => ({ ok: true }),
    'tools:install': ({ id }) => {
      if (id === 'whisper') Object.assign(state.status.engine, { installed: true, origin: 'app', kind: 'cpu' });
      if (id === 'whisper-cuda') Object.assign(state.status.engine.cuda, { installed: true, fromApp: true });
      return { ok: true, id };
    },
    'subtitles:installModel': ({ id }) => {
      const m = state.status.models.find((x) => x.id === id);
      Object.assign(m, { installed: true, installedSizeBytes: m.sizeBytes });
      return { ok: true, id, installed: true };
    },
    'subtitles:removeModel': ({ id }) => { Object.assign(state.status.models.find((x) => x.id === id), { installed: false, installedSizeBytes: 0 }); return { ok: true, id, removed: true }; },
    'tools:remove': ({ id }) => {
      if (id === 'whisper') Object.assign(state.status.engine, { installed: false, origin: null, kind: null });
      if (id === 'whisper-cuda') Object.assign(state.status.engine.cuda, { installed: false, fromApp: false });
      return { ok: true, id, removed: true };
    }
  };
  const BF = {
    util: { el: makeEl(doc) },
    ui: {
      toast: (message, kind) => { toasts.push([message, kind]); },
      log: (message, kind) => { logs.push([message, kind]); },
      confirm: async (opts) => { asked.push(plain(opts)); return queue.length ? queue.shift() : true; },
      selectTab: (id) => { tabs.push(id); appNode.dataset.activeTab = id; }
    },
    bus: {
      on: (name, fn) => { bus.set(name, [...(bus.get(name) || []), fn]); return () => {}; },
      emit: (name, data) => { emitted.push(name); for (const fn of bus.get(name) || []) fn(data); }
    },
    on: (channel, fn) => { channels.set(channel, [...(channels.get(channel) || []), fn]); },
    api: async (channel, payload) => {
      calls.push([channel, plain(payload)]);
      const route = routes[channel] || defaults[channel];
      const answer = typeof route === 'function' ? await route(payload, state) : route;
      return answer === undefined ? { ok: true } : answer;
    }
  };
  vm.runInContext(CODE, vm.createContext({ window: { BF }, document: doc }), { filename: 'transcription.js' });
  const T = BF.transcription;
  const card = T.card();
  const q = (selector) => card.querySelectorAll(selector);
  const button = (act, model) => q('button').find((b) => b.dataset.act === act && (model === undefined || b.dataset.model === model)) || null;
  return {
    BF, T, card, state, calls, toasts, logs, asked, tabs, emitted, doc,
    channel: (name, payload) => { for (const fn of channels.get(name) || []) fn(plain(payload)); },
    acts: () => q('button').map((b) => [b.dataset.act, b.dataset.model || null]),
    button, text: () => card.textContent,
    names: () => calls.map(([channel]) => channel),
    installs: () => calls.filter(([c]) => c === 'tools:install' || c === 'subtitles:installModel').map(([c, p]) => `${c}:${p.id}`),
    row: (id) => q('li').find((li) => li.dataset.model === id) || null
  };
}

test('antes da leitura o cartão mostra só o título e uma barra de espera; depois, sem nada instalado, UM botão instala tudo e diz o tamanho', async () => {
  const env = load();
  assert.equal(env.card.dataset.state, 'loading');
  assert.equal(env.T.loaded(), false);
  assert.match(env.text(), /Transcrição \(legendas automáticas\)/);
  assert.match(env.text(), /Lendo a situação da transcrição/);
  assert.deepEqual(env.acts(), [], 'sem botões enquanto lê');
  await env.T.load();
  assert.equal(env.card.dataset.state, 'missing');
  assert.equal(env.T.loaded(), true);
  assert.equal(env.T.failed(), false);
  assert.equal(env.card.attrs['aria-busy'], 'false');
  assert.match(env.text(), /Não instalada/);
  assert.match(env.text(), /Instale para começar/);
  assert.match(env.text(), /Baixa o motor \(8,2 MB\) e o modelo Pequeno \(181 MB\), 189 MB no total, só desta vez/);
  assert.match(env.text(), /SHA-256 conferidos; dá para cancelar/);
  const main = env.button('install-all');
  assert.equal(main.textContent, 'Instalar a transcrição');
  assert.match(main.className, /primary/, 'é o destaque do cartão');
  assert.equal(main.disabled, false);
  assert.equal(env.acts().filter(([act]) => act === 'install-all').length, 1, 'um botão só para o motor e o modelo');
  assert.deepEqual(env.acts().filter(([act]) => act === 'install-model').map(([, id]) => id), MODELS.map((m) => m.id), 'a lista tem os cinco modelos, cada um com Baixar');
  assert.equal(env.acts().some(([act]) => act === 'remove-engine'), false);
  assert.equal(env.acts().some(([act]) => act === 'install-cuda'), false, 'sem placa NVIDIA utilizável: sem o bloco da aceleração');
  assert.equal(env.row('small').querySelector('.tr-tag').textContent, 'Recomendado');
  assert.equal(env.row('tiny').querySelector('.tr-tag'), null, 'só o modelo padrão é recomendado');
  assert.match(env.row('large-v3-turbo').textContent, /Large v3 Turbo.*547 MB/);
});

test('motor instalado e nenhum modelo: "Falta um modelo", o botão baixa o recomendado e o motor do app pode ser removido', async () => {
  const env = load({ status: makeStatus({ engine: installedEngine() }) });
  await env.T.load();
  assert.equal(env.card.dataset.state, 'no-model');
  assert.match(env.text(), /Falta um modelo/);
  assert.match(env.text(), /O motor está instalado\. Baixa o modelo Pequeno \(181 MB\), só desta vez/);
  assert.doesNotMatch(env.text(), /Baixa o motor/);
  assert.equal(env.button('install-all').textContent, 'Baixar o modelo Pequeno');
  assert.ok(env.button('remove-engine'), 'dá para tirar o motor mesmo sem modelo');
  // o motor do sistema (não instalado pelo app) não se remove por aqui
  const sys = load({ status: makeStatus({ engine: installedEngine({ origin: 'system' }) }) });
  await sys.T.load();
  assert.equal(sys.button('remove-engine'), null);
  assert.equal(sys.card.dataset.state, 'no-model');
});

test('pronta: o resumo diz de onde vem o motor e quantos modelos há; a lista marca os baixados e deixa remover', async () => {
  const env = load({ status: makeStatus({ engine: installedEngine(), models: withModels('small', 'base') }) });
  await env.T.load();
  assert.equal(env.card.dataset.state, 'ready');
  assert.match(env.text(), /Pronta para transcrever/);
  assert.match(env.text(), /motor do app · processador · 2 modelos baixados/);
  assert.equal(env.button('install-all'), null, 'pronta: nada a instalar');
  assert.ok(env.button('remove-engine'));
  assert.equal(env.row('small').dataset.state, 'installed');
  assert.match(env.row('small').textContent, /Baixado/);
  assert.ok(env.button('remove-model', 'small'));
  assert.equal(env.row('medium').dataset.state, 'missing');
  assert.ok(env.button('install-model', 'medium'));
  // um modelo só
  const one = load({ status: makeStatus({ engine: installedEngine({ kind: 'cuda' }), models: withModels('small') }) });
  await one.T.load();
  assert.match(one.text(), /pode usar a placa · 1 modelo baixado/);
});

test('indisponível neste sistema (sem pacote do motor): diz o motivo, não oferece instalar e o plano é vazio', async () => {
  const env = load({ status: makeStatus({ engine: { available: false, unavailableReason: 'Não há pacote do motor para este sistema.' } }) });
  await env.T.load();
  assert.equal(env.card.dataset.state, 'unavailable');
  assert.match(env.text(), /Indisponível/);
  assert.match(env.text(), /Não há pacote do motor para este sistema\./);
  assert.match(env.text(), /você ainda pode escrever ou importar a legenda/);
  assert.equal(env.button('install-all'), null);
  assert.equal(env.T.planOf().engine, false, 'não há motor para baixar neste sistema');
  assert.equal(await env.T.install(), false, 'sem motor possível, instalar nem baixa só o modelo');
  assert.equal(env.asked.length, 0, 'e nem pergunta');
  assert.match(env.toasts[0][0], /Não há pacote do motor/);
  assert.deepEqual(env.installs(), []);
});

test('do hospedeiro (BDS): o motor e os modelos vêm dele, o cartão só mostra "Fornecido pelo" e não oferece remover', async () => {
  const env = load({ status: makeStatus({
    engine: { installed: true, origin: 'host', kind: 'cuda', hostName: 'BDS', cuda: { installed: true, fromApp: false, managedByHost: true } },
    models: withModels('small'), modelsManagedByHost: true, hostName: 'BDS',
    hardware: { pending: false, gpu: { available: true, name: 'NVIDIA GeForce GTX 1650', summary: 'NVIDIA GeForce GTX 1650 · 4 GB' } }
  }) });
  env.state.status.models.find((m) => m.id === 'small').managedByHost = true;
  env.state.status.models.find((m) => m.id === 'small').hostName = 'BDS';
  await env.T.load();
  assert.equal(env.card.dataset.state, 'ready');
  assert.match(env.text(), /motor do BDS/);
  assert.match(env.text(), /Os modelos são baixados e guardados pelo BDS/);
  assert.match(env.row('small').textContent, /Fornecido pelo BDS/);
  assert.equal(env.button('remove-engine'), null, 'o motor é do hospedeiro');
  assert.equal(env.button('remove-model', 'small'), null, 'o modelo dele também');
  assert.equal(env.button('remove-cuda'), null);
  assert.equal(env.button('install-cuda'), null);
});

test('aceleração pela placa NVIDIA: só com placa utilizável; oferece, mostra ativa e só deixa remover o que o app instalou', async () => {
  const gpu = { pending: false, gpu: { available: true, name: 'NVIDIA GeForce GTX 1650', summary: 'NVIDIA GeForce GTX 1650 · 4 GB' } };
  const offer = load({ status: makeStatus({ engine: installedEngine(), models: withModels('small'), hardware: gpu }) });
  await offer.T.load();
  assert.match(offer.text(), /Aceleração pela placa NVIDIA/);
  assert.match(offer.text(), /NVIDIA GeForce GTX 1650 · 4 GB — deixa a transcrição bem mais rápida\. Download grande \(643 MB\), opcional/);
  assert.equal(offer.button('install-cuda').textContent, 'Baixar (643 MB)');

  // recusar a confirmação não baixa; ela cita a licença da NVIDIA
  const declined = load({ status: offer.state.status, answers: [false] });
  await declined.T.load();
  declined.button('install-cuda').click();
  await idle();
  assert.equal(declined.asked.length, 1);
  assert.equal(declined.asked[0].title, 'Baixar a aceleração pela placa NVIDIA?');
  assert.equal(declined.asked[0].okLabel, 'Baixar e aceitar');
  assert.match(declined.asked[0].message, /643 MB/);
  assert.match(declined.asked[0].message, /licença própria/);
  assert.match(declined.asked[0].message, /termos da NVIDIA/);
  assert.match(declined.asked[0].message, /opcional/);
  assert.deepEqual(declined.installs(), [], 'recusou: nada baixado');

  // aceitar instala o pacote CUDA e o bloco vira "ativa" com o botão de remover (foi o app que instalou)
  const ok = load({ status: makeStatus({ engine: installedEngine(), models: withModels('small'), hardware: gpu }) });
  await ok.T.load();
  ok.button('install-cuda').click();
  await idle();
  assert.deepEqual(ok.installs(), ['tools:install:whisper-cuda']);
  assert.match(ok.text(), /Aceleração pela placa NVIDIA ativa/);
  assert.match(ok.text(), /NVIDIA GeForce GTX 1650 · 4 GB — a transcrição usa a placa/);
  assert.ok(ok.button('remove-cuda'));
  assert.equal(ok.button('install-cuda'), null);
  assert.ok(ok.toasts.some(([m]) => /Aceleração pela placa NVIDIA instalada/.test(m)));

  // um motor CUDA que não é do app (sistema): ativa, sem remover
  const sys = load({ status: makeStatus({ engine: installedEngine({ origin: 'system', kind: 'cuda', cuda: { installed: true, fromApp: false } }), models: withModels('small'), hardware: gpu }) });
  await sys.T.load();
  assert.match(sys.text(), /Aceleração pela placa NVIDIA ativa/);
  assert.equal(sys.button('remove-cuda'), null, 'não é do app: não há o que apagar');
  assert.equal(sys.button('install-cuda'), null);

  // sem placa utilizável (ou sem pacote para o sistema): o bloco nem aparece
  for (const status of [makeStatus({ engine: installedEngine(), models: withModels('small') }), makeStatus({ engine: installedEngine({ cuda: { available: false } }), models: withModels('small'), hardware: gpu })]) {
    const none = load({ status });
    await none.T.load();
    assert.doesNotMatch(none.text(), /Aceleração pela placa NVIDIA/);
  }
});

test('planOf: o que falta baixar (motor, o modelo pedido ou o recomendado quando não há nenhum) e o total', async () => {
  const sizes = (id) => MODELS.find((m) => m.id === id).sizeBytes;
  const nothing = load();
  await nothing.T.load();
  const a = nothing.T.planOf();
  assert.deepEqual([a.engine, a.model.id, a.bytes], [true, 'small', ENGINE_BYTES + sizes('small')]);
  const asked = nothing.T.planOf('tiny');
  assert.deepEqual([asked.engine, asked.model.id, asked.bytes], [true, 'tiny', ENGINE_BYTES + sizes('tiny')], 'o modelo pedido manda');

  const ready = load({ status: makeStatus({ engine: installedEngine(), models: withModels('base') }) });
  await ready.T.load();
  const none = ready.T.planOf();
  assert.deepEqual([none.engine, none.model, none.bytes], [false, null, 0], 'já há um modelo e o motor: nada a baixar');
  const specific = ready.T.planOf('small');
  assert.deepEqual([specific.engine, specific.model.id, specific.bytes], [false, 'small', sizes('small')], 'quem pede um modelo específico recebe esse');
  assert.equal(ready.T.planOf('base').model, null, 'o pedido já está baixado');
  assert.equal(load().T.planOf(), null, 'antes da leitura não há plano');
});

test('instalar: pergunta UMA vez (tamanho total e origem), vai à aba Ferramentas, baixa o motor e depois o modelo e volta à tela de origem', async () => {
  const env = load({ tab: 'analysis' });
  const done = await env.T.install();
  assert.equal(done, true);
  assert.equal(env.asked.length, 1, 'uma confirmação só para os dois downloads');
  const q = env.asked[0];
  assert.equal(q.title, 'Instalar a transcrição?');
  assert.equal(q.okLabel, 'Baixar e instalar');
  assert.match(q.message, /motor Whisper \(8,2 MB, da página oficial do whisper\.cpp no GitHub\)/);
  assert.match(q.message, /modelo Pequeno \(181 MB, do repositório oficial do whisper\.cpp no Hugging Face\)/);
  assert.match(q.message, /189 MB no total/);
  assert.match(q.message, /SHA-256/);
  assert.match(q.message, /cancelar durante o download/);
  assert.deepEqual(env.installs(), ['tools:install:whisper', 'subtitles:installModel:small'], 'o motor primeiro, depois o modelo');
  assert.deepEqual(env.tabs, ['tools', 'analysis'], 'vai às Ferramentas (onde o andamento aparece) e, pronto, volta à Análise');
  assert.equal(env.card.dataset.state, 'ready');
  assert.deepEqual(env.toasts.map(([m]) => m), ['Transcrição pronta para usar.']);
  assert.equal(env.emitted.filter((n) => n === 'transcription:changed').length, 1, 'avisa a Análise e as Legendas que o que está instalado mudou');
  assert.equal(env.row('small').dataset.state, 'installed');
});

test('instalar de dentro do próprio cartão não troca de aba; e o usuário que saiu das Ferramentas no meio não é arrastado de volta', async () => {
  const own = load({ tab: 'tools' });
  assert.equal(await own.T.install(), true);
  assert.deepEqual(own.tabs, ['tools'], 'já estava nas Ferramentas: nada de voltar para outra tela');

  const gate = defer();
  const away = load({ tab: 'subtitles', routes: { 'subtitles:installModel': async ({ id }) => { await gate.promise; away.state.status.models.find((m) => m.id === id).installed = true; return { ok: true }; } } });
  const running = away.T.install();
  await idle();
  away.doc.getElementById('app').dataset.activeTab = 'home'; // o usuário foi para o Início enquanto baixava
  gate.resolve();
  assert.equal(await running, true);
  assert.equal(away.doc.getElementById('app').dataset.activeTab, 'home', 'continua onde ele está');
});

test('recusar a confirmação não baixa nada, não troca de aba e o cartão segue como estava', async () => {
  const env = load({ answers: [false], tab: 'subtitles' });
  assert.equal(await env.T.install(), false);
  assert.deepEqual(env.installs(), []);
  assert.deepEqual(env.tabs, []);
  assert.equal(env.card.dataset.state, 'missing');
  assert.deepEqual(env.emitted.filter((n) => n === 'transcription:changed'), []);
});

test('só falta uma parte: a confirmação e a conta falam só dela (só o modelo; só o motor; um modelo pedido)', async () => {
  const onlyModel = load({ status: makeStatus({ engine: installedEngine() }) });
  assert.equal(await onlyModel.T.install(), true);
  assert.deepEqual(onlyModel.installs(), ['subtitles:installModel:small']);
  assert.match(onlyModel.asked[0].message, /modelo Pequeno/);
  assert.doesNotMatch(onlyModel.asked[0].message, /motor Whisper|no total/);

  const onlyEngine = load({ status: makeStatus({ models: withModels('base') }) });
  assert.equal(await onlyEngine.T.install(), true);
  assert.deepEqual(onlyEngine.installs(), ['tools:install:whisper']);
  assert.match(onlyEngine.asked[0].message, /motor Whisper/);
  assert.doesNotMatch(onlyEngine.asked[0].message, /modelo|no total/);

  const requested = load({ status: makeStatus({ engine: installedEngine(), models: withModels('small') }) });
  assert.equal(await requested.T.install({ modelId: 'tiny' }), true, 'quem pede um modelo específico o recebe, mesmo com outro baixado');
  assert.deepEqual(requested.installs(), ['subtitles:installModel:tiny']);

  const ready = load({ status: makeStatus({ engine: installedEngine(), models: withModels('small') }) });
  assert.equal(await ready.T.install(), true, 'já está pronta');
  assert.equal(ready.asked.length, 0);
  assert.deepEqual(ready.installs(), []);
});

test('falha no motor: o modelo não é baixado, o erro aparece no cartão (com a causa), o usuário fica nas Ferramentas e tentar de novo limpa o erro', async () => {
  let attempt = 0;
  const env = load({ tab: 'analysis', routes: {
    'tools:install': ({ id }) => {
      attempt += 1;
      if (attempt === 1) return { ok: false, code: 'CHECKSUM_MISMATCH', message: 'O arquivo baixado não passou na verificação de integridade (SHA-256 diferente do oficial).' };
      Object.assign(env.state.status.engine, { installed: true, origin: 'app', kind: 'cpu' });
      return { ok: true, id };
    }
  } });
  assert.equal(await env.T.install(), false);
  assert.deepEqual(env.installs(), ['tools:install:whisper'], 'sem o motor o modelo nem é pedido');
  assert.deepEqual(env.tabs, ['tools'], 'a falha fica à vista na aba Ferramentas');
  assert.equal(env.card.dataset.state, 'missing');
  const err = env.card.querySelector('.tr-error');
  assert.ok(err);
  assert.equal(err.attrs.role, 'alert');
  assert.match(err.textContent, /verificação de integridade/);
  assert.equal(env.toasts.length, 0, 'sem aviso de "pronta"');
  assert.equal(env.logs.length, 1);
  assert.equal(await env.T.install(), true, 'na segunda tentativa funciona');
  assert.equal(env.card.querySelector('.tr-error'), null, 'e o erro da primeira sumiu');
  assert.deepEqual(env.installs(), ['tools:install:whisper', 'tools:install:whisper', 'subtitles:installModel:small']);
});

test('falha no modelo (depois do motor): o motor fica instalado, o cartão passa a "Falta um modelo" e mostra o erro', async () => {
  const env = load({ routes: { 'subtitles:installModel': { ok: false, code: 'HTTP_503', message: 'A fonte do modelo respondeu com erro (HTTP 503). Tente de novo mais tarde.' } } });
  assert.equal(await env.T.install(), false);
  assert.deepEqual(env.installs(), ['tools:install:whisper', 'subtitles:installModel:small']);
  assert.equal(env.card.dataset.state, 'no-model');
  assert.match(env.card.querySelector('.tr-error').textContent, /HTTP 503/);
  assert.equal(env.button('install-all').textContent, 'Baixar o modelo Pequeno', 'dá para tentar só o modelo');
});

test('cancelar no meio: cancela o download em andamento, não começa o passo seguinte e a mensagem é neutra (não é erro)', async () => {
  const gate = defer();
  const env = load({ routes: { 'tools:install': async () => gate.promise } });
  const running = env.T.install();
  await idle();
  assert.equal(env.card.dataset.state, 'busy');
  assert.match(env.text(), /Instalando a transcrição…/);
  assert.match(env.text(), /Passo 1 de 2 · Motor de transcrição \(Whisper\)/);
  assert.match(env.card.querySelector('.tr-status').textContent, /Instalando…/);
  assert.equal(env.button('install-all'), null, 'durante a instalação o botão vira Cancelar');
  assert.equal(env.button('install-model', 'tiny').disabled, true, 'e a lista não deixa começar outro download');
  env.button('cancel-flow').click();
  await idle();
  assert.deepEqual(env.calls.filter(([c]) => c === 'tools:cancel').map(([, p]) => p), [{ id: 'whisper' }]);
  assert.equal(env.button('cancel-flow').textContent, 'Cancelando…');
  assert.equal(env.button('cancel-flow').disabled, true);
  gate.resolve({ ok: false, code: 'CANCELLED', message: 'Instalação cancelada.' });
  assert.equal(await running, false);
  assert.deepEqual(env.installs(), ['tools:install:whisper'], 'o modelo não foi pedido');
  assert.equal(env.card.dataset.state, 'missing');
  assert.match(env.text(), /Instalação cancelada\. O que já foi baixado e conferido continua instalado\./);
  assert.equal(env.card.querySelector('.tr-error'), null);
  assert.deepEqual(env.tabs, ['tools'], 'cancelou: fica nas Ferramentas');
  assert.equal(env.logs.length, 0);
});

test('cancelar entre os passos: o motor termina e o modelo não começa', async () => {
  const gate = defer();
  const env = load({ routes: { 'tools:install': async ({ id }) => { await gate.promise; env.state.status.engine.installed = true; env.state.status.engine.origin = 'app'; return { ok: true, id }; } } });
  const running = env.T.install();
  await idle();
  env.button('cancel-flow').click(); // o cancelamento chega, mas o motor já estava terminando
  gate.resolve();
  assert.equal(await running, false);
  assert.deepEqual(env.installs(), ['tools:install:whisper'], 'cancelado: o passo 2 não começa');
  assert.match(env.text(), /Instalação cancelada/);
  assert.equal(env.card.dataset.state, 'no-model', 'o motor ficou instalado');
});

test('o andamento atualiza só a barra (sem redesenhar o cartão) e mostra percentual, bytes e velocidade', async () => {
  const gate = defer();
  const env = load({ routes: { 'tools:install': async () => gate.promise } });
  const running = env.T.install();
  await idle();
  const bar = env.card.querySelector('progress');
  assert.ok(bar);
  assert.equal(bar.value, '', 'sem andamento ainda: barra indeterminada');
  assert.match(env.text(), /Preparando…/);
  env.channel('tools:progress', { id: 'whisper', phase: 'download', percent: 40, received: 4 * 1024 * 1024, total: 10 * 1024 * 1024, speedBps: 2 * 1024 * 1024 });
  const same = env.card.querySelector('progress');
  assert.equal(same, bar, 'a mesma barra: nada foi redesenhado');
  assert.equal(same.value, 40);
  assert.match(env.text(), /Baixando… 40% · 4 MB de 10 MB · 2 MB\/s/);
  env.channel('tools:progress', { id: 'whisper', phase: 'verify', message: 'Conferindo o SHA-256…' });
  assert.equal(same.value, '', 'sem percentual (conferindo): volta a ser indeterminada');
  assert.match(env.text(), /Conferindo o SHA-256…/);
  gate.resolve({ ok: false, code: 'CANCELLED', message: '' });
  await running;
});

test('um download iniciado por outro caminho (a aba Legendas) aparece no cartão e termina com uma releitura', async () => {
  const env = load({ status: makeStatus() });
  await env.T.load();
  const before = env.names().filter((c) => c === 'subtitles:status').length;
  env.channel('tools:progress', { id: 'whisper', phase: 'download', percent: 10, received: 1, total: 10 });
  assert.match(env.text(), /Instalando o motor de transcrição…/);
  assert.ok(env.button('cancel-engine'), 'dá para cancelar também o que veio de fora');
  assert.equal(env.card.dataset.state, 'busy');
  env.button('cancel-engine').click();
  await idle();
  assert.deepEqual(env.calls.filter(([c]) => c === 'tools:cancel').map(([, p]) => p), [{ id: 'whisper' }]);
  env.channel('tools:progress', { id: 'whisper', phase: 'done', percent: 100 });
  await idle();
  assert.equal(env.names().filter((c) => c === 'subtitles:status').length, before + 1, 'terminou: o cartão lê a situação de novo');
  assert.equal(env.card.dataset.state, 'missing');
  // o mesmo para um modelo
  env.channel('subtitles:modelProgress', { id: 'base', phase: 'download', percent: 5, received: 1, total: 20 });
  assert.equal(env.row('base').dataset.state, 'busy');
  assert.ok(env.button('cancel-model', 'base'));
});

test('lista de modelos: os grandes (200 MB ou mais) pedem confirmação, os pequenos não; remover diz o que libera e avisa do último', async () => {
  const env = load({ status: makeStatus({ engine: installedEngine(), models: withModels('small') }), answers: [false] });
  await env.T.load();
  env.button('install-model', 'medium').click(); // 514 MB: pergunta (a resposta é "não")
  await idle();
  assert.equal(env.asked.length, 1);
  assert.equal(env.asked[0].title, 'Baixar o modelo Médio?');
  assert.match(env.asked[0].message, /download grande: 514 MB/);
  assert.match(env.asked[0].message, /Hugging Face/);
  assert.deepEqual(env.installs(), []);
  env.button('install-model', 'tiny').click(); // 31 MB: baixa direto
  await idle();
  assert.equal(env.asked.length, 1, 'o pequeno não pergunta');
  assert.deepEqual(env.installs(), ['subtitles:installModel:tiny']);
  assert.ok(env.toasts.some(([m]) => m === 'Modelo Tiny baixado.'));
  assert.equal(env.row('tiny').dataset.state, 'installed');

  // remover um (há outro): sem o aviso do último; o texto diz o tamanho
  env.button('remove-model', 'tiny').click();
  await idle();
  const rm = env.asked[1];
  assert.equal(rm.title, 'Remover o modelo Tiny?');
  assert.equal(rm.danger, true);
  assert.match(rm.message, /\(30,7 MB\) é apagado do computador/);
  assert.doesNotMatch(rm.message, /único modelo/);
  assert.deepEqual(env.calls.filter(([c]) => c === 'subtitles:removeModel').map(([, p]) => p), [{ id: 'tiny' }]);
  assert.equal(env.row('tiny').dataset.state, 'missing');
  assert.ok(env.toasts.some(([m]) => m === 'Modelo Tiny removido.'));

  // o último: avisa
  env.button('remove-model', 'small').click();
  await idle();
  assert.match(env.asked[2].message, /É o único modelo baixado: a transcrição só volta a funcionar depois que você baixar um modelo\./);
  assert.equal(env.card.dataset.state, 'no-model');
});

test('remover o motor pede confirmação (e diz que os modelos ficam); recusar não apaga; o erro "em uso" aparece no cartão', async () => {
  const env = load({ status: makeStatus({ engine: installedEngine(), models: withModels('small') }), answers: [false] });
  await env.T.load();
  env.button('remove-engine').click();
  await idle();
  assert.equal(env.asked[0].title, 'Remover o motor de transcrição?');
  assert.match(env.asked[0].message, /Os modelos baixados e a aceleração pela placa NVIDIA continuam no disco/);
  assert.deepEqual(env.calls.filter(([c]) => c === 'tools:remove'), [], 'recusou: nada apagado');

  const busy = load({ status: makeStatus({ engine: installedEngine(), models: withModels('small') }), routes: { 'tools:remove': { ok: false, code: 'TOOL_IN_USE', message: 'Não é possível remover o Whisper agora: a geração de legendas está rodando.' } } });
  await busy.T.load();
  busy.button('remove-engine').click();
  await idle();
  assert.match(busy.card.querySelector('.tr-error').textContent, /a geração de legendas está rodando/);
  assert.equal(busy.card.dataset.state, 'ready', 'nada mudou');
  assert.ok(busy.button('remove-engine'), 'e dá para tentar de novo');
});

test('o foco do teclado acompanha: o "Instalar" que vira "Cancelar", e o "Baixar" que vira "Remover" na mesma linha', async () => {
  const gate = defer();
  const env = load({ routes: { 'tools:install': async () => gate.promise } });
  await env.T.load();
  env.button('install-all').focus();
  assert.equal(env.doc.activeElement.dataset.act, 'install-all');
  const running = env.T.install();
  await idle();
  assert.equal(env.doc.activeElement.dataset.act, 'cancel-flow', 'o foco foi para o botão que assumiu o lugar');
  gate.resolve({ ok: false, code: 'CANCELLED', message: '' });
  await running;

  const rows = load({ status: makeStatus({ engine: installedEngine(), models: withModels('small') }) });
  await rows.T.load();
  rows.button('install-model', 'tiny').focus();
  rows.button('install-model', 'tiny').click();
  await idle();
  assert.equal(rows.doc.activeElement.dataset.act, 'remove-model', 'na mesma linha: o Baixar virou Remover');
  assert.equal(rows.doc.activeElement.dataset.model, 'tiny');
  // quem hospeda a aba (tools.js) pode guardar e devolver o foco do cartão ao redesenhar
  const spec = rows.T.captureFocus();
  assert.deepEqual(plain(spec), { act: 'remove-model', model: 'tiny' });
  rows.doc.activeElement = null;
  rows.T.restoreFocus(spec);
  assert.equal(rows.doc.activeElement.dataset.model, 'tiny');
  rows.doc.activeElement = rows.doc.body;
  assert.equal(rows.T.captureFocus(), null, 'foco fora do cartão: nada a guardar');
});

test('a leitura que falha: `failed()` avisa a aba Ferramentas (que volta a listar o motor como ferramenta comum) e o cartão não inventa dados', async () => {
  const env = load({ routes: { 'subtitles:status': { ok: false, code: 'NO_HANDLER', message: 'O módulo de legendas não carregou.' } } });
  await env.T.load();
  assert.equal(env.T.failed(), true);
  assert.equal(env.T.loaded(), false);
  assert.equal(env.card.dataset.state, 'loading');
  assert.deepEqual(env.acts(), []);
  assert.ok(env.emitted.includes('transcription:updated'), 'a aba é avisada para decidir como se desenhar');
  assert.equal(await env.T.install(), false);
  assert.match(env.toasts[0][0], /O módulo de legendas não carregou/);
  // com uma leitura que funciona, deixa de ser "falha"
  const ok = load();
  await ok.T.load();
  assert.equal(ok.T.failed(), false);
});

test('a detecção da placa ainda rodando: o cartão espera por ela e relê uma vez, e só avisa "mudou" quando o que está instalado mudou', async () => {
  const hw = { pending: false, gpu: { available: true, name: 'NVIDIA X', summary: 'NVIDIA X · 8 GB' } };
  let first = true;
  const env = load({ status: makeStatus({ engine: installedEngine(), models: withModels('small') }), routes: {
    'subtitles:status': (p, state) => { const s = plain(state.status); if (first) { first = false; s.hardware = { pending: true, gpu: { available: false, name: null, summary: '' } }; } else s.hardware = hw; return s; }
  } });
  await env.T.load();
  assert.deepEqual(env.names().filter((c) => c === 'subtitles:status' || c === 'subtitles:hardware'), ['subtitles:status', 'subtitles:hardware', 'subtitles:status']);
  assert.match(env.text(), /Aceleração pela placa NVIDIA/, 'com a placa já detectada');
  assert.equal(env.emitted.filter((n) => n === 'transcription:changed').length, 0, 'a primeira leitura é a linha de base: não avisa mudança');
  await env.T.load(); // nada mudou
  assert.equal(env.emitted.filter((n) => n === 'transcription:changed').length, 0);
  env.state.status.models.find((m) => m.id === 'base').installed = true; // outro caminho instalou um modelo
  await env.T.load();
  assert.equal(env.emitted.filter((n) => n === 'transcription:changed').length, 1, 'agora mudou: a Análise e as Legendas se atualizam');
});

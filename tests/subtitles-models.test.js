'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./subtitles-helpers');
const { ModelManager, MODELS, DEFAULT_MODEL_ID, REVISION, getModel, entryIdFor, validateModel, REPO } = require('../src/core/subtitles/models');

const { fakeHub, pinnedCatalog, REV } = H;

/** Gerenciador contra o servidor falso, com o catálogo fixado nos valores dele (como o app fixa os da fonte real). */
const managerFor = (dir, hub, extra = {}) => new ModelManager({ dir, baseUrl: hub.base, catalog: pinnedCatalog(hub), allowLoopbackHttp: true, ...extra });
const listFor = (dir) => H.listTree(dir);
const apiRequests = (hub) => hub.requests.filter((r) => r.url.startsWith('/api/'));

test('catálogo: modelos oficiais, padrão pequeno, arquivos quantizados e nomes únicos', () => {
  assert.equal(DEFAULT_MODEL_ID, 'small');
  assert.deepEqual(MODELS.map((m) => m.id), ['tiny', 'base', 'small', 'medium', 'large-v3-turbo']);
  for (const m of MODELS) {
    assert.match(m.file, /^ggml-[a-z0-9.-]+-q\d_\d\.bin$/, m.id);
    assert.ok(m.sizeBytes > 1e7, m.id);
    assert.ok(m.dtw && m.label && m.description, m.id);
    assert.equal(getModel(m.id), m);
    assert.match(entryIdFor(m.id), /^whisper-[a-z0-9-]+$/);
    assert.ok(entryIdFor(m.id).length <= 40, 'cabe no id do instalador');
  }
  assert.equal(new Set(MODELS.map((m) => m.file)).size, MODELS.length);
  assert.equal(getModel('nao-existe'), null);
  assert.equal(REPO, 'ggerganov/whisper.cpp');
});

test('catálogo: revisão, tamanho e SHA-256 de cada modelo ficam FIXADOS no código (nada é lido da fonte na hora)', () => {
  assert.match(REVISION, /^[0-9a-f]{40}$/);
  for (const m of MODELS) {
    assert.deepEqual(validateModel(m), [], m.id);
    assert.equal(m.revision, REVISION, m.id);
    assert.match(m.sha256, /^[0-9a-f]{64}$/, m.id);
    assert.ok(Number.isSafeInteger(m.sizeBytes) && m.sizeBytes > 1e7, m.id);
  }
  assert.equal(new Set(MODELS.map((m) => m.sha256)).size, MODELS.length, 'cada modelo tem o seu SHA-256');
  // valores conferidos na API da fonte oficial (GET /api/models/ggerganov/whisper.cpp?blobs=true, revisão acima)
  const pinned = Object.fromEntries(MODELS.map((m) => [m.id, [m.sizeBytes, m.sha256]]));
  assert.deepEqual(pinned.tiny, [32152673, '818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7']);
  assert.deepEqual(pinned.small, [190085487, 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb']);
  assert.equal(REVISION, '5359861c739e955e79d9a303bcbc70fb988958b1');
  // o código de instalação não consulta a API da fonte: um teste do fonte garante que ninguém a reintroduz sem querer
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'subtitles', 'models.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/fetch\(|\/api\/models|lookupRemote/.test(code), 'models.js não consulta a fonte para saber tamanho ou hash');
});

test('um item do catálogo sem revisão, tamanho ou SHA-256 válidos é recusado ao criar o gerenciador', () => {
  const dir = H.tmpDir();
  try {
    const good = MODELS[0];
    assert.deepEqual(validateModel({ ...good, sha256: 'xyz' }), ['SHA-256']);
    assert.deepEqual(validateModel({ ...good, revision: 'main' }), ['revisão']);
    assert.deepEqual(validateModel({ ...good, sizeBytes: 0 }), ['tamanho']);
    assert.deepEqual(validateModel({ ...good, sha256: undefined, revision: undefined }), ['revisão', 'SHA-256']);
    for (const bad of [{ ...good, sha256: '' }, { ...good, revision: 'latest' }, { ...good, sizeBytes: -1 }]) {
      assert.throws(() => new ModelManager({ dir, catalog: [bad] }), (e) => e.code === 'INVALID_ARGS' && /fixado/.test(e.message));
    }
    assert.doesNotThrow(() => new ModelManager({ dir, catalog: MODELS }));
  } finally { H.cleanup(dir); }
});

test('a fonte dos modelos precisa ser https (http só em localhost e só quando permitido)', () => {
  const dir = H.tmpDir();
  try {
    assert.throws(() => new ModelManager({ dir, baseUrl: 'http://huggingface.co' }), (e) => e.code === 'INSECURE_URL');
    assert.throws(() => new ModelManager({ dir, baseUrl: 'http://127.0.0.1:1234' }), (e) => e.code === 'INSECURE_URL', 'loopback sem permissão explícita');
    assert.doesNotThrow(() => new ModelManager({ dir, baseUrl: 'http://127.0.0.1:1234', allowLoopbackHttp: true }));
    assert.doesNotThrow(() => new ModelManager({ dir }));
    assert.throws(() => new ModelManager({}), (e) => e.code === 'INVALID_ARGS');
  } finally { H.cleanup(dir); }
});

test('instalar: o arquivo é conferido contra o tamanho e o SHA-256 FIXADOS e publicado; sem consulta à API; reinstalar não baixa de novo', async () => {
  const dir = H.tmpDir();
  const hub = await fakeHub();
  try {
    const mgr = managerFor(dir, hub);
    const events = [];
    mgr.on('progress', (e) => events.push(e));
    assert.equal(mgr.installed('tiny'), null);
    assert.equal(mgr.list().find((m) => m.id === 'tiny').installed, false);

    const res = await mgr.install('tiny');
    assert.equal(res.alreadyInstalled, false);
    assert.equal(res.revision, REV);
    assert.equal(res.sizeBytes, hub.data.length);
    assert.ok(fs.existsSync(res.path));
    assert.ok(res.path.includes(path.join('whisper-tiny', `r${REV.slice(0, 12)}`)));
    assert.equal(H.sha256(fs.readFileSync(res.path)), H.sha256(hub.data), 'o conteúdo é o do servidor');
    assert.deepEqual(hub.requests.map((r) => r.url), [`/${REPO}/resolve/${REV}/ggml-tiny-q5_1.bin`], 'um único pedido: o arquivo, na revisão fixada');
    assert.deepEqual(apiRequests(hub), [], 'a API da fonte não é consultada (tamanho e SHA-256 não vêm de lá)');

    const phases = new Set(events.map((e) => e.phase));
    for (const p of ['prepare', 'download', 'verify', 'install', 'done']) assert.ok(phases.has(p), `fase ${p}`);
    assert.equal(events.at(-1).phase, 'done');
    assert.ok(events.every((e) => e.id === 'whisper-tiny'));

    const have = mgr.installed('tiny');
    assert.equal(have.path, res.path);
    assert.equal(have.revision, REV.slice(0, 12), 'o que está instalado guarda os 12 primeiros caracteres da revisão (nome da pasta)');
    assert.equal(have.sha256, H.sha256(hub.data));
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(res.path), 'manifest.json'), 'utf8'));
    assert.equal(manifest.sha256, H.sha256(hub.data), 'o manifesto guarda o SHA-256 fixado, conferido no download');
    const row = mgr.list().find((m) => m.id === 'tiny');
    assert.equal(row.installed, true);
    assert.equal(row.installedSizeBytes, hub.data.length);
    assert.equal(row.sizeBytes, hub.data.length, 'o tamanho mostrado é o do catálogo');

    const before = hub.requests.length;
    const again = await mgr.install('tiny');
    assert.equal(again.alreadyInstalled, true);
    assert.equal(hub.requests.length, before, 'já instalado: nenhuma requisição de rede');
    assert.equal(fs.existsSync(path.join(dir, '.tmp')), false, 'sem pasta de trabalho sobrando');
  } finally { await hub.close(); H.cleanup(dir); }
});

test('arquivo trocado na fonte (mesmo tamanho, outro conteúdo): recusado, nada instalado e nada sobra', async () => {
  const dir = H.tmpDir();
  const data = crypto.randomBytes(200 * 1024);
  const evil = Buffer.from(data);
  evil[1000] ^= 0xff;
  const hub = await fakeHub({ data, served: evil });
  try {
    const mgr = managerFor(dir, hub, { catalog: pinnedCatalog({ ...hub, data }) });
    await assert.rejects(mgr.install('tiny'), (e) => e.code === 'CHECKSUM_MISMATCH' && /integridade/.test(e.message));
    assert.equal(mgr.installed('tiny'), null);
    assert.deepEqual(listFor(dir), [], 'nem modelo, nem .part, nem pasta de trabalho');
  } finally { await hub.close(); H.cleanup(dir); }
});

test('uma troca que a própria fonte "confirmaria" não passa: o SHA-256 vem do código, não do servidor', async () => {
  const dir = H.tmpDir();
  const real = crypto.randomBytes(180 * 1024); // o que o catálogo fixa
  const swapped = crypto.randomBytes(180 * 1024); // o que um repositório comprometido serviria (e anunciaria na API)
  const hub = await fakeHub({ data: swapped });
  try {
    const mgr = managerFor(dir, hub, { catalog: pinnedCatalog({ ...hub, data: real }) });
    await assert.rejects(mgr.install('tiny'), (e) => e.code === 'CHECKSUM_MISMATCH');
    assert.equal(mgr.installed('tiny'), null);
    assert.deepEqual(apiRequests(hub), []);
    assert.deepEqual(listFor(dir), []);
  } finally { await hub.close(); H.cleanup(dir); }
});

test('tamanho diferente do fixado no catálogo: recusado', async () => {
  const dir = H.tmpDir();
  const data = crypto.randomBytes(200 * 1024);
  const hub = await fakeHub({ data, served: data.subarray(0, data.length - 10) });
  try {
    const mgr = managerFor(dir, hub, { catalog: pinnedCatalog({ ...hub, data }) });
    await assert.rejects(mgr.install('tiny'), (e) => e.code === 'SIZE_MISMATCH');
    assert.deepEqual(listFor(dir), []);
  } finally { await hub.close(); H.cleanup(dir); }
});

test('revisão fixada que a fonte não tem (404) e fonte fora do ar: erro explicado, nada instalado', async () => {
  const dir = H.tmpDir();
  const hub = await fakeHub();
  const base = hub.base;
  try {
    const wrongRevision = managerFor(dir, hub, { catalog: pinnedCatalog(hub, { revision: 'd'.repeat(40) }), installerOptions: { attempts: 1, backoffMs: 1 } });
    await assert.rejects(wrongRevision.install('tiny'), (e) => e.code === 'HTTP_404' && /recusou o download/.test(e.message));
    assert.deepEqual(listFor(dir), []);
    await hub.close(); // porta fechada
    const down = new ModelManager({ dir, baseUrl: base, catalog: pinnedCatalog(hub), allowLoopbackHttp: true, installerOptions: { attempts: 1, backoffMs: 1 } });
    await assert.rejects(down.install('tiny'), (e) => e.code === 'NETWORK' && /Falha de rede/.test(e.message), 'falha de rede explicada, sem instalar nada');
    await assert.rejects(new ModelManager({ dir }).install('nao-existe'), (e) => e.code === 'UNKNOWN_MODEL');
    assert.deepEqual(listFor(dir), []);
  } finally { await hub.close().catch(() => {}); H.cleanup(dir); }
});

test('cancelar no meio do download: CANCELLED, nada instalado e nada sobra; dá para tentar de novo', async () => {
  const dir = H.tmpDir();
  const hub = await fakeHub({ data: crypto.randomBytes(2 * 1024 * 1024), slow: true });
  try {
    const mgr = managerFor(dir, hub);
    const controller = new AbortController();
    mgr.on('progress', (e) => { if (e.phase === 'download' && e.receivedBytes > 100 * 1024) controller.abort(); });
    await assert.rejects(mgr.install('tiny', { signal: controller.signal }), (e) => e.code === 'CANCELLED');
    assert.equal(mgr.installed('tiny'), null);
    assert.equal(mgr.isBusy('tiny'), false);
    assert.deepEqual(listFor(dir), [], 'o .part e a pasta de trabalho foram apagados');

    // cancelar pelo gerenciador (mesmo caminho do botão Cancelar)
    const m2 = managerFor(dir, hub);
    m2.on('progress', (e) => { if (e.phase === 'download' && e.receivedBytes > 100 * 1024) m2.cancel('tiny'); });
    await assert.rejects(m2.install('tiny'), (e) => e.code === 'CANCELLED');
    assert.deepEqual(listFor(dir), []);

    // depois de cancelar, uma instalação normal funciona
    const ok = await managerFor(dir, hub, { installerOptions: {} }).install('tiny');
    assert.equal(ok.alreadyInstalled, false);
  } finally { await hub.close(); H.cleanup(dir); }
});

test('cancelar antes de começar também vale (sinal já cancelado): nada é baixado', async () => {
  const dir = H.tmpDir();
  const hub = await fakeHub();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(managerFor(dir, hub).install('tiny', { signal: controller.signal }), (e) => e.code === 'CANCELLED');
    assert.equal(hub.requests.length, 0);
  } finally { await hub.close(); H.cleanup(dir); }
});

test('duas instalações do mesmo modelo ao mesmo tempo: a segunda é recusada (BUSY)', async () => {
  const dir = H.tmpDir();
  const hub = await fakeHub({ data: crypto.randomBytes(1024 * 1024), slow: true });
  try {
    const mgr = managerFor(dir, hub);
    const first = mgr.install('tiny');
    await new Promise((resolve) => { const t = setInterval(() => { if (mgr.isBusy('tiny')) { clearInterval(t); resolve(); } }, 20); });
    assert.deepEqual(mgr.busyIds(), ['tiny']);
    assert.equal(mgr.list().find((m) => m.id === 'tiny').busy, true);
    await assert.rejects(mgr.install('tiny'), (e) => e.code === 'BUSY');
    await first;
    assert.deepEqual(mgr.busyIds(), []);
  } finally { await hub.close(); H.cleanup(dir); }
});

test('remover apaga o modelo; modelo adulterado no disco (tamanho diferente) deixa de valer', async () => {
  const dir = H.tmpDir();
  const hub = await fakeHub();
  try {
    const mgr = managerFor(dir, hub);
    const res = await mgr.install('tiny');
    assert.equal((await mgr.remove('tiny')).removed, true);
    assert.equal(mgr.installed('tiny'), null);
    assert.equal(fs.existsSync(path.join(dir, 'whisper-tiny')), false);
    assert.equal((await mgr.remove('tiny')).removed, false, 'remover o que não existe não é erro');
    await assert.rejects(mgr.remove('nao-existe'), (e) => e.code === 'UNKNOWN_MODEL');

    const again = await mgr.install('tiny');
    fs.appendFileSync(again.path, 'lixo'); // arquivo mexido por fora: o tamanho não bate mais com o gravado
    assert.equal(mgr.installed('tiny'), null, 'não usa um modelo que não confere');
    const fixed = await mgr.install('tiny', { force: true });
    assert.equal(fixed.alreadyInstalled, false);
    assert.equal(mgr.installed('tiny').sizeBytes, hub.data.length);
    assert.equal(res.path, fixed.path);
  } finally { await hub.close(); H.cleanup(dir); }
});

test('app atualizado com outra revisão/SHA-256 fixados: o modelo antigo deixa de valer e a instalação o troca (só uma versão por modelo)', async () => {
  const dir = H.tmpDir();
  const data1 = crypto.randomBytes(120 * 1024);
  const data2 = crypto.randomBytes(130 * 1024);
  const hub1 = await fakeHub({ data: data1, revision: 'b'.repeat(40) });
  const hub2 = await fakeHub({ data: data2, revision: 'c'.repeat(40) });
  try {
    await managerFor(dir, hub1).install('tiny');
    const newer = managerFor(dir, hub2);
    assert.equal(newer.installed('tiny'), null, 'o modelo de outro SHA-256 não vale para o catálogo novo');
    assert.equal(newer.list().find((m) => m.id === 'tiny').installed, false);
    const second = await newer.install('tiny'); // sem force: o que está instalado não é o que o catálogo fixa
    assert.equal(second.alreadyInstalled, false);
    assert.equal(second.revision, 'c'.repeat(40));
    const versions = fs.readdirSync(path.join(dir, 'whisper-tiny'));
    assert.deepEqual(versions, [`r${'c'.repeat(12)}`]);
    assert.equal(newer.installed('tiny').sizeBytes, data2.length);
  } finally { await hub1.close(); await hub2.close(); H.cleanup(dir); }
});

test('resíduos de uma instalação interrompida são limpos ao iniciar', () => {
  const dir = H.tmpDir();
  try {
    const stale = path.join(dir, '.tmp', 'whisper-tiny-abc123');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'ggml-tiny-q5_1.bin.part'), 'meio');
    fs.mkdirSync(path.join(dir, '.tmp', 'trash-xyz'), { recursive: true });
    const mgr = new ModelManager({ dir });
    assert.ok(mgr.cleanup() >= 1);
    assert.equal(fs.existsSync(stale), false);
  } finally { H.cleanup(dir); }
});

// ------------------------------------------------------------------ catálogo falso só para o e2e

const { loadTestModels, TEST_ENV_VAR } = require('../src/core/subtitles/models');

test('catálogo de teste dos modelos (só e2e): vale só com NODE_ENV=test, app não empacotado, http local e tudo fixado; o resto devolve null', () => {
  const good = { baseUrl: 'http://127.0.0.1:4010', catalog: MODELS.map((m) => ({ ...m })) };
  const env = (over = {}) => ({ NODE_ENV: 'test', [TEST_ENV_VAR]: JSON.stringify(good), ...over });
  const ok = loadTestModels({ env: env(), isPackaged: false });
  assert.deepEqual([ok.baseUrl, ok.allowLoopbackHttp, ok.catalog.map((m) => m.id)], [good.baseUrl, true, MODELS.map((m) => m.id)]);
  assert.doesNotThrow(() => new ModelManager({ dir: H.tmpDir('bf-testmodels-'), ...ok }), 'as opções servem para o ModelManager');
  const withBase = (baseUrl) => env({ [TEST_ENV_VAR]: JSON.stringify({ ...good, baseUrl }) });
  const withCatalog = (catalog) => env({ [TEST_ENV_VAR]: JSON.stringify({ ...good, catalog }) });
  const cases = [
    ['sem a variável', { env: { NODE_ENV: 'test' }, isPackaged: false }],
    ['variável vazia', { env: env({ [TEST_ENV_VAR]: '  ' }), isPackaged: false }],
    ['NODE_ENV diferente de test', { env: env({ NODE_ENV: 'production' }), isPackaged: false }],
    ['NODE_ENV ausente', { env: { [TEST_ENV_VAR]: JSON.stringify(good) }, isPackaged: false }],
    ['app empacotado', { env: env(), isPackaged: true }],
    ['isPackaged indefinido conta como empacotado', { env: env(), isPackaged: undefined }],
    ['JSON inválido', { env: env({ [TEST_ENV_VAR]: '{não é json' }), isPackaged: false }],
    ['não é um objeto', { env: env({ [TEST_ENV_VAR]: '[1]' }), isPackaged: false }],
    ['endereço que não é local', { env: withBase('http://exemplo.invalid'), isPackaged: false }],
    ['https (a fonte falsa é http local)', { env: withBase('https://127.0.0.1:4010'), isPackaged: false }],
    ['endereço inválido', { env: withBase('isto não é um endereço'), isPackaged: false }],
    ['catálogo vazio', { env: withCatalog([]), isPackaged: false }],
    ['item sem SHA-256 fixado', { env: withCatalog([{ ...MODELS[0], sha256: 'curto' }]), isPackaged: false }],
    ['item sem revisão fixada', { env: withCatalog([{ ...MODELS[0], revision: '' }]), isPackaged: false }]
  ];
  for (const [why, args] of cases) assert.equal(loadTestModels(args), null, why);
});

test('garantia: a variável de teste dos modelos só é lida em src/core/subtitles/models.js (nada no main, preload, renderer ou outros módulos)', () => {
  const root = path.join(__dirname, '..');
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); } else if (e.name.endsWith('.js') || e.name.endsWith('.html')) {
        if (fs.readFileSync(full, 'utf8').includes(TEST_ENV_VAR)) hits.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  };
  for (const dir of ['src', 'renderer']) walk(path.join(root, dir));
  for (const file of ['main.js', 'preload.js']) if (fs.readFileSync(path.join(root, file), 'utf8').includes(TEST_ENV_VAR)) hits.push(file);
  assert.deepEqual(hits, ['src/core/subtitles/models.js']);
});

'use strict';

/**
 * Ferramentas e modelos do Whisper fornecidos pelo hospedeiro (módulo embutido no BDS): o Braga Frame os usa em vez de baixar
 * os seus, mostra "fornecida pelo hospedeiro" e nunca instala uma segunda cópia. Electron falso, sem rede.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBfModule } = require('../src/host');
const { ModelManager } = require('../src/core/subtitles/models');

const silent = { log() {}, info() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bf-shared-'));
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });

function fakeApp(dir) {
  const app = new EventEmitter();
  app.isPackaged = false;
  app.getPath = () => dir;
  return app;
}

/** Catálogo de teste com um modelo pequeno de verdade (tamanho e SHA-256 do conteúdo gerado). */
function fakeModel(dir) {
  const content = Buffer.from('modelo-de-teste-'.repeat(50));
  const file = path.join(dir, 'host-model.bin');
  fs.writeFileSync(file, content);
  const model = { id: 'tiny', label: 'Tiny', file: 'ggml-tiny-q5_1.bin', dtw: 'tiny', revision: 'a'.repeat(40), sizeBytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex'), description: 'teste' };
  return { content, file, model };
}

test('ModelManager com modelos do hospedeiro: usa o arquivo dele, confere o SHA-256, não grava nada em pasta própria e recusa remover', async () => {
  const dir = tmp();
  try {
    const { file, model } = fakeModel(dir);
    const ownDir = path.join(dir, 'own-models');
    const manager = new ModelManager({ dir: ownDir, catalog: [model], hostName: 'BDS', hostModels: { resolve: (id) => (id === 'tiny' ? file : null), install: async () => { throw new Error('não deveria instalar'); } } });
    const have = manager.installed('tiny');
    assert.equal(have.path, file);
    assert.equal(have.origin, 'host');
    assert.equal(manager.list()[0].managedByHost, true);
    assert.equal(await manager.verifyHost('tiny'), true, 'SHA-256 do arquivo do hospedeiro confere com o catálogo');
    assert.equal(manager.installed('tiny').verified, true);
    const again = await manager.install('tiny'); // já está no hospedeiro: nenhuma instalação
    assert.equal(again.alreadyInstalled, true);
    await assert.rejects(() => manager.remove('tiny'), (err) => err.code === 'HOST_MANAGED' && /BDS/.test(err.message));
    assert.equal(fs.existsSync(ownDir), false, 'nenhuma pasta de modelos própria foi criada');
  } finally { rm(dir); }
});

test('ModelManager: arquivo do hospedeiro com outro tamanho ou outro SHA-256 não vale', async () => {
  const dir = tmp();
  try {
    const { file, model, content } = fakeModel(dir);
    const manager = new ModelManager({ dir: path.join(dir, 'own'), catalog: [model], hostModels: { resolve: () => file, install: async () => {} } });
    fs.writeFileSync(file, Buffer.concat([content, Buffer.from('x')]));
    assert.equal(manager.installed('tiny'), null, 'tamanho diferente');
    const other = Buffer.from('y'.repeat(content.length)); // mesmo tamanho, conteúdo diferente
    fs.writeFileSync(file, other);
    assert.ok(manager.installed('tiny'), 'pelo tamanho ainda parece válido');
    assert.equal(await manager.verifyHost('tiny'), false, 'o SHA-256 denuncia');
    assert.equal(manager.installed('tiny'), null, 'depois da conferência o arquivo é recusado');
  } finally { rm(dir); }
});

test('ModelManager: instalar um modelo ausente é delegado ao hospedeiro (progresso repassado, cancelamento avisado, resultado conferido)', async () => {
  const dir = tmp();
  try {
    const { file, model, content } = fakeModel(dir);
    let installed = false;
    const calls = [];
    const hostModels = {
      resolve: () => (installed ? file : null),
      install: async (id, { onProgress }) => {
        calls.push(id);
        onProgress({ phase: 'download', percent: 50, receivedBytes: 10, totalBytes: 20, speedBps: 5 });
        installed = true;
      },
      cancel: () => calls.push('cancel')
    };
    const manager = new ModelManager({ dir: path.join(dir, 'own'), catalog: [model], hostModels, hostName: 'BDS' });
    assert.equal(manager.installed('tiny'), null);
    const events = [];
    manager.on('progress', (e) => events.push(e));
    const res = await manager.install('tiny');
    assert.deepEqual(calls, ['tiny']);
    assert.equal(res.path, file);
    assert.ok(events.some((e) => e.phase === 'download' && e.percent === 50 && e.id === 'whisper-tiny'));
    assert.equal(manager.isBusy('tiny'), false);

    // o hospedeiro "instala" um arquivo errado: recusado
    installed = false;
    fs.writeFileSync(file, Buffer.from('z'.repeat(content.length)));
    hostModels.install = async () => { installed = true; };
    const manager2 = new ModelManager({ dir: path.join(dir, 'own2'), catalog: [model], hostModels, hostName: 'BDS' });
    await assert.rejects(() => manager2.install('tiny'), (err) => err.code === 'HOST_MODEL_MISMATCH');

    // cancelamento chega ao hospedeiro
    installed = false;
    const controller = new AbortController();
    hostModels.install = async () => { controller.abort(); };
    const manager3 = new ModelManager({ dir: path.join(dir, 'own3'), catalog: [model], hostModels, hostName: 'BDS' });
    await manager3.install('tiny', { signal: controller.signal }).catch(() => {});
    assert.ok(calls.includes('cancel'));
  } finally { rm(dir); }
});

test('createBfModule com ferramentas do hospedeiro: tools:status mostra "host", Deno incluído, e tools:install do que o hospedeiro tem é recusado', async () => {
  const dir = tmp();
  const bf = createBfModule({
    app: fakeApp(dir), dialog: {}, shell: {}, userDataDir: path.join(dir, 'bf'), log: silent, hostName: 'BDS',
    tools: { ffmpeg: process.execPath, ffprobe: process.execPath, ytdlp: process.execPath, deno: () => process.execPath, whisper: process.execPath }
  });
  try {
    const status = await bf.invoke('tools:status', {});
    assert.equal(status.ok, true);
    assert.deepEqual(status.host, { embedded: true, name: 'BDS' });
    assert.equal(status.system.find((s) => s.id === 'ffmpeg').origin, 'host');
    const byId = Object.fromEntries(status.tools.map((t) => [t.id, t]));
    assert.equal(byId.ytdlp.active.origin, 'host');
    assert.equal(byId.deno.active.origin, 'host');
    assert.equal(byId.whisper.active.origin, 'host');
    assert.equal(byId.twitchdownloader.active.origin, null, 'o que o hospedeiro não tem continua instalável pelo app');
    for (const id of ['ytdlp', 'deno', 'whisper']) {
      const res = await bf.invoke('tools:install', { id });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'HOST_PROVIDED', id);
    }
    assert.equal(fs.readdirSync(path.join(dir, 'bf', 'tools')).length, 0, 'nada foi instalado');
    // os modelos: sem whisperModels do hospedeiro, o app segue com a pasta própria
    const subs = await bf.invoke('subtitles:status', {});
    assert.equal(subs.modelsManagedByHost, false);
    assert.equal(subs.engine.origin, 'host');
  } finally { bf.dispose(); rm(dir); }
});

test('createBfModule com whisperModels: status das legendas, instalação delegada e remoção recusada', async () => {
  const dir = tmp();
  const bf = createBfModule({
    app: fakeApp(dir), dialog: {}, shell: {}, userDataDir: path.join(dir, 'bf'), log: silent, hostName: 'BDS',
    whisperModels: { resolve: () => null, install: async () => {} }
  });
  try {
    const subs = await bf.invoke('subtitles:status', {});
    assert.equal(subs.modelsManagedByHost, true);
    assert.equal(subs.hostName, 'BDS');
    assert.ok(subs.models.every((m) => m.managedByHost === true && m.installed === false));
    const removed = await bf.invoke('subtitles:removeModel', { id: 'small' });
    assert.equal(removed.code, 'HOST_MANAGED');
    const installed = await bf.invoke('subtitles:installModel', { id: 'small' });
    assert.equal(installed.code, 'HOST_MODEL_MISMATCH', 'o hospedeiro não colocou o arquivo: a instalação não finge sucesso');
    assert.equal(fs.existsSync(path.join(dir, 'bf', 'models')), false, 'nenhuma pasta de modelos própria');
  } finally { bf.dispose(); rm(dir); }
});

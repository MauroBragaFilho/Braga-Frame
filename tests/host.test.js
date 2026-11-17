'use strict';

/**
 * Camada de acoplamento (src/host/index.js): o Braga Frame como módulo de outro app. Tudo com Electron falso, sem abrir janela.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createBfModule, MODULE_ID } = require('../src/host');

const silent = { log() {}, info() {}, warn() {}, error() {} };

function tmp(name = 'host') { return fs.mkdtempSync(path.join(os.tmpdir(), `bf-${name}-`)); }
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });

/** ipcMain falso: guarda os listeners como o real faria e permite chamá-los. */
function fakeIpc() {
  const handlers = new Map();
  const removed = [];
  return {
    handlers, removed,
    handle: (channel, fn) => { if (handlers.has(channel)) throw new Error(`duplicado: ${channel}`); handlers.set(channel, fn); },
    removeHandler: (channel) => { removed.push(channel); handlers.delete(channel); },
    call: (channel, payload) => handlers.get(channel)({ sender: 'real' }, payload)
  };
}

/** `app` falso (EventEmitter, como o real) cuja pasta de dados é um chamariz: nada do módulo pode parar lá. */
function fakeApp(decoy) {
  const app = new EventEmitter();
  app.isPackaged = false;
  app.getVersion = () => '9.9.9-host';
  app.getPath = (name) => (name === 'videos' ? path.join(decoy, 'Videos') : decoy);
  return app;
}

function setup(over = {}) {
  const root = tmp('host');
  const decoy = path.join(root, 'decoy-userdata');
  fs.mkdirSync(decoy);
  const userDataDir = path.join(root, 'modulo');
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } };
  const app = fakeApp(decoy);
  const options = {
    app, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, shell: { showItemInFolder() {} },
    getWindow: () => win, userDataDir, log: silent, env: {}, ...over
  };
  const bf = createBfModule(options);
  return { root, decoy, userDataDir, sent, win, app, options, bf, cleanup: () => { try { bf.dispose(); } finally { rm(root); } } };
}

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(full, ...filesUnder(full)); else out.push(full);
  }
  return out;
}

test('opções inválidas são recusadas com mensagem clara', () => {
  const root = tmp('host-opt');
  try {
    const base = { app: new EventEmitter(), dialog: {}, shell: {}, userDataDir: path.join(root, 'm') };
    assert.throws(() => createBfModule(), /app/);
    assert.throws(() => createBfModule({ ...base, app: undefined }), /"app"/);
    assert.throws(() => createBfModule({ ...base, dialog: undefined }), /"dialog"/);
    assert.throws(() => createBfModule({ ...base, shell: undefined }), /"shell"/);
    assert.throws(() => createBfModule({ ...base, userDataDir: undefined }), /userDataDir/);
    assert.throws(() => createBfModule({ ...base, userDataDir: 'relativo/pasta' }), /absoluto/);
    for (const bad of ['bf', 'bf-', '1bf:', 'b f:', 'bf::', 7]) {
      assert.throws(() => createBfModule({ ...base, channelPrefix: bad }), /channelPrefix/, String(bad));
    }
    assert.throws(() => createBfModule({ ...base, send: 'não é função' }), /"send"/);
    assert.doesNotThrow(() => createBfModule({ ...base, channelPrefix: 'bf:' }));
    assert.equal(fs.existsSync(base.userDataDir), false, 'criar o módulo não cria pasta nenhuma (isso é do register)');
  } finally { rm(root); }
});

test('meta descreve o módulo e register cria o estado só dentro de userDataDir', () => {
  const t = setup({ version: '1.2.3' });
  try {
    assert.equal(t.bf.meta.id, MODULE_ID);
    assert.equal(t.bf.meta.id, 'frame');
    assert.equal(t.bf.meta.title, 'Braga Frame');
    assert.equal(t.bf.meta.version, '1.2.3');
    assert.ok(t.bf.meta.description.length > 10);
    assert.throws(() => { t.bf.meta.id = 'outro'; }, 'meta é congelado');
    assert.equal(t.bf.registered, false);

    const reg = t.bf.register();
    assert.equal(t.bf.registered, true);
    assert.equal(t.bf.register(), reg, 'register é idempotente');
    assert.deepEqual(reg.failed, []);
    assert.ok(reg.loaded.length >= 11);
    for (const sub of ['projects', 'tools', 'cache', 'downloads']) assert.ok(fs.statSync(path.join(t.userDataDir, sub)).isDirectory(), sub);
    assert.deepEqual(fs.readdirSync(t.decoy), [], 'a pasta de dados do app hospedeiro não recebe nada');
    for (const ch of ['app:info', 'app:takeOpenRequest', 'tools:status', 'source:open', 'source:pick', 'queue:enqueue', 'project:save']) {
      assert.ok(t.bf.channels().includes(ch), ch);
    }
    assert.deepEqual(t.bf.channels(), [...t.bf.channels()].sort());
  } finally { t.cleanup(); }
});

test('sem windowControls o módulo não expõe window:* (a interface fecharia a janela do hospedeiro)', async () => {
  const t = setup();
  try {
    t.bf.register();
    assert.equal(t.bf.channels().some((c) => c.startsWith('window:')), false);
    assert.equal((await t.bf.invoke('window:close')).code, 'UNKNOWN_CHANNEL');
  } finally { t.cleanup(); }
  const own = setup({ windowControls: true });
  try {
    own.bf.register();
    for (const ch of ['window:state', 'window:minimize', 'window:maximize', 'window:fullscreen', 'window:close']) assert.ok(own.bf.channels().includes(ch), ch);
  } finally { own.cleanup(); }
});

test('com ipcMain: registra cada canal (com prefixo) e invoke devolve o mesmo que o canal real', async () => {
  const ipc = fakeIpc();
  const t = setup({ ipcMain: ipc, channelPrefix: 'bf:' });
  try {
    t.bf.register();
    assert.equal(ipc.handlers.size, t.bf.channels().length);
    assert.ok([...ipc.handlers.keys()].every((c) => c.startsWith('bf:')));
    assert.deepEqual(t.bf.channels({ prefixed: true }), t.bf.channels().map((c) => `bf:${c}`));
    assert.equal(ipc.handlers.has('app:info'), false, 'o nome sem prefixo não é tomado do hospedeiro');

    const viaIpc = await ipc.call('bf:app:info');
    const direct = await t.bf.invoke('app:info');
    const prefixed = await t.bf.invoke('bf:app:info');
    assert.equal(viaIpc.ok, true);
    assert.equal(viaIpc.version, '9.9.9-host'.replace('9.9.9-host', require('../package.json').version), 'a versão é a do Braga Frame, não a do app hospedeiro');
    assert.deepEqual(direct, viaIpc);
    assert.deepEqual(prefixed, viaIpc);
    assert.equal(viaIpc.name, 'Braga Frame');
  } finally { t.cleanup(); }
});

test('sem ipcMain: nada é registrado em lugar nenhum e invoke funciona (e se registra sozinho)', async () => {
  const t = setup();
  try {
    assert.equal(t.bf.registered, false);
    const res = await t.bf.invoke('app:info');
    assert.equal(res.ok, true);
    assert.equal(t.bf.registered, true, 'primeira chamada registra');
    assert.deepEqual(await t.bf.invoke('app:nenhum'), { ok: false, code: 'UNKNOWN_CHANNEL', message: 'Canal desconhecido: app:nenhum.' });
    for (const bad of ['', 'info', 'App:info', 'app:info:x', 'bf:app:info', 7, null, undefined, {}, '../x:y']) {
      const r = await t.bf.invoke(bad);
      assert.equal(r.ok, false, String(bad));
      assert.equal(r.code, 'INVALID_CHANNEL', String(bad));
    }
  } finally { t.cleanup(); }
});

test('invoke repassa o payload e o evento do hospedeiro, e erros viram { ok:false, code, message }', async () => {
  const hdir = tmp('host-handlers');
  fs.writeFileSync(path.join(hdir, 'eco.js'), `exports.register = (ctx) => {
    ctx.handle('eco:diga', (payload, event) => ({ payload, sender: event && event.sender, sintetico: Boolean(event && event.synthetic) }));
    ctx.handle('eco:falha', () => { const e = new Error('Falhou por causa X. Faça Y.'); e.code = 'EXEMPLO'; throw e; });
  };`);
  const t = setup({ handlersDir: hdir });
  try {
    t.bf.register();
    assert.deepEqual(await t.bf.invoke('eco:diga', { a: 1 }), { ok: true, payload: { a: 1 }, sender: null, sintetico: true });
    assert.deepEqual(await t.bf.invoke('eco:diga'), { ok: true, payload: {}, sender: null, sintetico: true });
    const r = await t.bf.invoke('eco:diga', { b: 2 }, { sender: 'evento-real' });
    assert.equal(r.sender, 'evento-real');
    assert.equal(r.sintetico, false);
    assert.deepEqual(await t.bf.invoke('eco:falha'), { ok: false, code: 'EXEMPLO', message: 'Falhou por causa X. Faça Y.' });
  } finally { t.cleanup(); rm(hdir); }
});

test('um handler que não carrega fica em registration.failed e não derruba o módulo', async () => {
  const hdir = tmp('host-handlers');
  fs.writeFileSync(path.join(hdir, 'a-bom.js'), "exports.register = (ctx) => ctx.handle('bom:ping', () => ({ pong: true }));");
  fs.writeFileSync(path.join(hdir, 'b-ruim.js'), "throw new Error('dependência ausente');");
  const t = setup({ handlersDir: hdir });
  try {
    const reg = t.bf.register();
    assert.equal(reg.failed.length, 1);
    assert.equal(reg.failed[0].file, 'b-ruim.js');
    assert.deepEqual(await t.bf.invoke('bom:ping'), { ok: true, pong: true });
    assert.equal(t.bf.channels().includes('app:takeOpenRequest'), true, 'os canais do encaixe existem mesmo assim');
  } finally { t.cleanup(); rm(hdir); }
});

test('prefixo vale também para os eventos enviados à janela; com options.send eles chegam sem prefixo', () => {
  const a = setup({ channelPrefix: 'bf:' });
  try {
    a.bf.register();
    a.bf.send('queue:update', { n: 1 });
    assert.deepEqual(a.sent.at(-1), ['bf:queue:update', { n: 1 }]);
  } finally { a.cleanup(); }

  const events = [];
  const b = setup({ channelPrefix: 'bf:', send: (channel, payload) => events.push([channel, payload]) });
  try {
    b.bf.register();
    b.bf.send('queue:update', { n: 2 });
    assert.deepEqual(events.at(-1), ['queue:update', { n: 2 }]);
    assert.deepEqual(b.sent, [], 'com send próprio nada vai direto à janela');
  } finally { b.cleanup(); }

  const own = setup(); // app próprio: sem prefixo, direto para a janela
  try {
    own.bf.register();
    own.bf.send('tools:changed', { x: 1 });
    assert.deepEqual(own.sent.at(-1), ['tools:changed', { x: 1 }]);
  } finally { own.cleanup(); }
});

test('um send do hospedeiro que lança não derruba o módulo', async () => {
  const t = setup({ send: () => { throw new Error('janela fechou'); } });
  try {
    await t.bf.invoke('app:info');
    assert.doesNotThrow(() => t.bf.ctx.send('a:b', 1));
    assert.doesNotThrow(() => t.bf.send('a:b', 1));
  } finally { t.cleanup(); }
});

test('ferramentas do hospedeiro valem antes do que o Braga Frame acharia sozinho', async () => {
  const dir = tmp('host-tools');
  const hostFfmpeg = path.join(dir, 'ffmpeg-do-bds.exe');
  const hostYtdlp = path.join(dir, 'yt-dlp-do-bds.exe');
  const envFfmpeg = path.join(dir, 'ffmpeg-do-ambiente.exe');
  for (const f of [hostFfmpeg, hostYtdlp, envFfmpeg]) fs.writeFileSync(f, 'x');
  let calls = 0;
  const t = setup({
    env: { CORTE_FFMPEG: envFfmpeg },
    tools: {
      ffmpeg: hostFfmpeg,
      ytdlp: () => { calls += 1; return hostYtdlp; },
      whisper: path.join(dir, 'nao-existe.exe'), // sumiu: cai na resolução normal
      ffprobe: 'ffprobe-relativo.exe', // não absoluto: ignorado
      twitchDownloader: () => { throw new Error('quebrou'); } // não derruba
    }
  });
  try {
    const info = await t.bf.invoke('app:info');
    assert.equal(info.tools.ffmpeg, hostFfmpeg, 'ganha da variável CORTE_FFMPEG');
    assert.equal(info.tools.ytdlp, hostYtdlp);
    assert.ok(calls >= 1, 'a função é consultada na hora de resolver');
    assert.notEqual(info.tools.whisper, path.join(dir, 'nao-existe.exe'));
    assert.notEqual(info.tools.ffprobe, 'ffprobe-relativo.exe');
    assert.equal(info.tools.twitchDownloader, t.bf.ctx.tools.twitchDownloader);

    // o hospedeiro troca a ferramenta com o módulo já ligado: refreshTools enxerga
    const before = calls;
    const refreshed = await t.bf.invoke('app:refreshTools');
    assert.equal(refreshed.tools.ffmpeg, hostFfmpeg);
    assert.ok(calls > before);
  } finally { t.cleanup(); rm(dir); }
});

test('ferramentas do hospedeiro e a lista de ferramentas do app: ctx.tools é o mesmo objeto vivo', async () => {
  const dir = tmp('host-tools');
  const first = path.join(dir, 'ffmpeg-1.exe');
  const second = path.join(dir, 'ffmpeg-2.exe');
  fs.writeFileSync(first, 'x'); fs.writeFileSync(second, 'x');
  let current = first;
  const t = setup({ tools: { ffmpeg: () => current } });
  try {
    await t.bf.invoke('app:info');
    const live = t.bf.ctx.tools;
    assert.equal(live.ffmpeg, first);
    current = second;
    await t.bf.invoke('app:refreshTools');
    assert.equal(live.ffmpeg, second);
  } finally { t.cleanup(); rm(dir); }
});

test('todo o estado fica em userDataDir: projeto, fila e preferências nunca saem da pasta do módulo', async () => {
  const t = setup();
  try {
    const video = path.join(t.root, 'jogo.mp4');
    fs.writeFileSync(video, 'não é um vídeo de verdade');
    const project = { version: 2, id: 'x', source: { path: video, size: 1, duration: 10, width: 1920, height: 1080, origin: null }, cuts: [] };
    const saved = await t.bf.invoke('project:save', { project });
    assert.equal(saved.ok, true);
    const listed = await t.bf.invoke('project:list');
    assert.equal(listed.projects.length, 1);
    await t.bf.invoke('queue:list');
    await t.bf.invoke('queue:getSettings');
    await t.bf.invoke('prefs:get').catch(() => {});

    const inside = filesUnder(t.userDataDir);
    assert.ok(inside.some((f) => f.includes(`${path.sep}projects${path.sep}`)), 'projeto gravado na pasta do módulo');
    assert.deepEqual(fs.readdirSync(t.decoy), [], 'nada na pasta de dados do hospedeiro');
    assert.deepEqual(fs.readdirSync(t.root).sort(), ['decoy-userdata', 'jogo.mp4', 'modulo'].sort(), 'nada novo ao lado da pasta do módulo');
  } finally { t.cleanup(); }
});

test('fachada do app: os handlers do módulo conseguem fechar o app (quit) e pedir a placa de vídeo (getGPUInfo); a pasta de dados continua a do módulo', async () => {
  const hdir = tmp('host-facade');
  fs.writeFileSync(path.join(hdir, 'usa.js'), `exports.register = (ctx) => {
    ctx.handle('usa:sair', () => { ctx.app.quit(); return { saiu: true }; });
    ctx.handle('usa:placa', async () => ({ gpu: await ctx.app.getGPUInfo('basic'), dados: ctx.app.getPath('userData'), versao: ctx.app.getVersion() }));
  };`);
  const ipc = fakeIpc();
  const t = setup({ ipcMain: ipc, channelPrefix: 'bf:', handlersDir: hdir });
  try {
    let quits = 0;
    t.app.quit = () => { quits += 1; };
    t.app.getGPUInfo = async (type) => ({ type, gpuDevice: [{ deviceString: 'GPU de teste' }] });
    t.bf.register();
    assert.equal((await t.bf.invoke('usa:sair')).saiu, true);
    assert.equal(quits, 1, 'ctx.app.quit chegou ao app de verdade');
    const gpu = await t.bf.invoke('usa:placa');
    assert.deepEqual([gpu.gpu.type, gpu.gpu.gpuDevice[0].deviceString, gpu.dados, gpu.versao], ['basic', 'GPU de teste', t.userDataDir, require('../package.json').version]); // a versão é a do MÓDULO, não a do hospedeiro
  } finally { t.cleanup(); rm(hdir); }
});

test('fachada do app sem quit/getGPUInfo no app real (outro hospedeiro): não quebra, só não faz nada', async () => {
  const hdir = tmp('host-facade2');
  fs.writeFileSync(path.join(hdir, 'usa.js'), `exports.register = (ctx) => {
    ctx.handle('usa:sair', () => { ctx.app.quit(); return { saiu: true }; });
    ctx.handle('usa:placa', async () => ({ gpu: await ctx.app.getGPUInfo('basic') }));
  };`);
  const ipc = fakeIpc();
  const t = setup({ ipcMain: ipc, channelPrefix: 'bf:', handlersDir: hdir });
  try {
    t.bf.register();
    assert.equal((await t.bf.invoke('usa:sair')).saiu, true);
    assert.equal((await t.bf.invoke('usa:placa')).gpu, null);
  } finally { t.cleanup(); rm(hdir); }
});

test('dispose: fecha cada recurso uma vez, solta canais e ouvintes e a instância deixa de responder', async () => {
  const hdir = tmp('host-handlers');
  fs.writeFileSync(path.join(hdir, 'vida.js'), `exports.register = (ctx) => {
    globalThis.__bfFechou = 0;
    ctx.app.on('before-quit', () => { globalThis.__bfFechou += 1; });
    ctx.handle('vida:ping', () => ({ pong: true }));
  };`);
  const ipc = fakeIpc();
  const t = setup({ ipcMain: ipc, channelPrefix: 'bf:', handlersDir: hdir });
  try {
    t.bf.register();
    const registered = ipc.handlers.size;
    assert.equal(registered, 3, 'vida:ping + os 2 canais de abrir vídeo');
    assert.ok(t.app.listenerCount('before-quit') >= 1, 'o fechamento dos recursos se registrou no app');

    assert.equal(t.bf.disposed, false);
    t.bf.dispose();
    assert.equal(t.bf.disposed, true);
    assert.equal(globalThis.__bfFechou, 1, 'o fechamento do recurso rodou');
    assert.equal(t.app.listenerCount('before-quit'), 0, 'ouvintes do app soltos');
    assert.equal(ipc.handlers.size, 0, 'canais soltos do ipcMain');
    assert.equal(ipc.removed.length, registered);
    assert.deepEqual(t.bf.channels(), []);

    t.app.emit('before-quit'); // o app encerrando depois do dispose não repete nada
    assert.equal(globalThis.__bfFechou, 1);
    t.bf.dispose(); // idempotente
    assert.equal(globalThis.__bfFechou, 1);

    const r = await t.bf.invoke('vida:ping');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MODULE_DISPOSED');
    assert.throws(() => t.bf.register(), /desligado/);
    assert.equal(t.bf.requestOpen(path.join(t.root, 'x.mp4')), false);
    t.sent.length = 0;
    t.bf.send('a:b', 1);
    assert.deepEqual(t.sent, [], 'depois de desligado não sai evento nenhum');
  } finally { delete globalThis.__bfFechou; t.cleanup(); rm(hdir); }
});

test('dispose antes de registrar não faz nada de estranho; before-quit do app encerra os recursos uma vez só', async () => {
  const t = setup();
  try {
    t.bf.dispose();
    assert.equal(fs.existsSync(t.userDataDir), false);
  } finally { t.cleanup(); }

  const hdir = tmp('host-handlers');
  fs.writeFileSync(path.join(hdir, 'vida.js'), `exports.register = (ctx) => {
    globalThis.__bfFechou2 = 0;
    ctx.app.on('before-quit', () => { globalThis.__bfFechou2 += 1; });
  };`);
  const u = setup({ handlersDir: hdir });
  try {
    u.bf.register();
    u.app.emit('before-quit'); // o hospedeiro fechando
    u.bf.dispose(); // e depois o dispose
    assert.equal(globalThis.__bfFechou2, 1);
  } finally { delete globalThis.__bfFechou2; u.cleanup(); rm(hdir); }
});

test('um recurso que falha ao fechar não impede os outros nem o dispose', () => {
  const hdir = tmp('host-handlers');
  fs.writeFileSync(path.join(hdir, 'a.js'), "exports.register = (ctx) => ctx.app.on('before-quit', () => { throw new Error('travou'); });");
  fs.writeFileSync(path.join(hdir, 'b.js'), "exports.register = (ctx) => { globalThis.__bfOk = 0; ctx.app.on('before-quit', () => { globalThis.__bfOk += 1; }); };");
  const t = setup({ handlersDir: hdir });
  try {
    t.bf.register();
    assert.doesNotThrow(() => t.bf.dispose());
    assert.equal(globalThis.__bfOk, 1);
  } finally { delete globalThis.__bfOk; t.cleanup(); rm(hdir); }
});

test('dois módulos independentes na mesma execução: pastas, canais e desligamento separados', async () => {
  const ipcA = fakeIpc();
  const ipcB = fakeIpc();
  const a = setup({ ipcMain: ipcA, channelPrefix: 'a:' });
  const b = setup({ ipcMain: ipcB, channelPrefix: 'b:' });
  try {
    a.bf.register();
    b.bf.register();
    assert.notEqual(a.userDataDir, b.userDataDir);
    const video = path.join(a.root, 'so-do-a.mp4');
    fs.writeFileSync(video, 'x');
    const project = { version: 2, id: 'a', source: { path: video, size: 1, duration: 5, width: 640, height: 360, origin: null }, cuts: [] };
    assert.equal((await ipcA.call('a:project:save', { project })).ok, true);
    assert.equal((await a.bf.invoke('project:list')).projects.length, 1);
    assert.equal((await b.bf.invoke('project:list')).projects.length, 0, 'o outro módulo não vê o projeto');
    assert.deepEqual(fs.readdirSync(path.join(b.userDataDir, 'projects')), []);

    // eventos separados
    a.bf.send('x:evento', 1);
    assert.equal(a.sent.at(-1)[0], 'a:x:evento');
    assert.equal(b.sent.some(([c]) => c === 'a:x:evento'), false);

    // desligar um não afeta o outro
    a.bf.dispose();
    assert.equal(ipcA.handlers.size, 0);
    assert.ok(ipcB.handlers.size > 5);
    assert.equal((await a.bf.invoke('app:info')).code, 'MODULE_DISPOSED');
    assert.equal((await b.bf.invoke('app:info')).ok, true);
    assert.equal((await ipcB.call('b:project:list')).ok, true);
  } finally { a.cleanup(); b.cleanup(); }
});

test('requestOpen: valida o caminho, entrega uma única vez e avisa a interface', async () => {
  const t = setup();
  try {
    const video = path.join(t.root, 'gameplay.mkv');
    fs.writeFileSync(video, 'x');

    // antes de registrar: fica na fila, e o aviso sai junto com o registro
    assert.equal(t.bf.requestOpen(video), true);
    assert.deepEqual(t.sent, []);
    t.bf.register();
    assert.deepEqual(t.sent.at(-1), ['app:openRequest', { count: 1 }]);

    const first = await t.bf.invoke('app:takeOpenRequest');
    assert.deepEqual(first, { ok: true, requests: [{ path: video }] });
    assert.deepEqual(await t.bf.invoke('app:takeOpenRequest'), { ok: true, requests: [] }, 'cada pedido sai uma vez');

    // inválidos viram aviso para o usuário, nunca abrem nada
    assert.equal(t.bf.requestOpen(path.join(t.root, 'nao-existe.mp4')), true);
    assert.equal(t.bf.requestOpen('relativo.mp4'), true);
    assert.equal(t.bf.requestOpen(path.join(t.root, 'texto.txt')), true);
    const errors = (await t.bf.invoke('app:takeOpenRequest')).requests;
    assert.deepEqual(errors.map((r) => r.error.code), ['INPUT_MISSING', 'RELATIVE_PATH', 'UNSUPPORTED_FORMAT']);
    assert.ok(errors.every((r) => !r.path && typeof r.error.message === 'string' && r.error.message.length > 10));

    // um vídeo novo substitui o que ainda não foi entregue
    const other = path.join(t.root, 'outro.mp4');
    fs.writeFileSync(other, 'x');
    t.bf.requestOpen(video);
    t.bf.requestOpen(other);
    assert.deepEqual((await t.bf.invoke('app:takeOpenRequest')).requests, [{ path: other }]);

    // resultado de parseCli
    assert.equal(t.bf.requestOpen({ videoPath: video, error: null, extra: 0 }), true);
    assert.equal(t.bf.requestOpen({ videoPath: null, error: null, extra: 0, requested: null }), false, 'nada a abrir');
    assert.equal(t.bf.requestOpen(null), false);
  } finally { t.cleanup(); }
});

test('o processo termina sozinho depois do dispose (nenhum timer, processo ou fila fica vivo)', () => {
  const root = tmp('host-exit');
  try {
    const script = path.join(root, 'ciclo.js');
    fs.writeFileSync(script, `
      const { EventEmitter } = require('node:events');
      const path = require('node:path');
      const { createBfModule } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'host'))});
      const app = new EventEmitter();
      app.isPackaged = false; app.getPath = () => ${JSON.stringify(root)};
      (async () => {
        const bf = createBfModule({ app, dialog: {}, shell: {}, userDataDir: path.join(${JSON.stringify(root)}, 'm'), log: { log() {}, info() {}, warn() {}, error() {} }, env: {} });
        await bf.invoke('app:info');
        await bf.invoke('tools:status');
        await bf.invoke('queue:list');
        await bf.invoke('sources:state');
        bf.dispose();
      })().catch((err) => { console.error(err); process.exitCode = 1; });
    `);
    const started = Date.now();
    execFileSync(process.execPath, [script], { timeout: 60000, stdio: 'pipe' });
    assert.ok(Date.now() - started < 60000);
  } finally { rm(root); }
});

test('app:requestOpen (canal) confere o caminho, enfileira e avisa; erro volta com código e mensagem', async () => {
  const t = setup();
  try {
    t.bf.register();
    const video = path.join(t.root, 'pelo-canal.mp4');
    fs.writeFileSync(video, 'x');
    t.sent.length = 0;
    assert.deepEqual(await t.bf.invoke('app:requestOpen', { path: video }), { ok: true, path: video });
    assert.deepEqual(t.sent.at(-1), ['app:openRequest', { count: 1 }]);
    assert.deepEqual((await t.bf.invoke('app:takeOpenRequest')).requests, [{ path: video }]);

    for (const [payload, code] of [[{ path: path.join(t.root, 'nao-existe.mp4') }, 'INPUT_MISSING'], [{ path: 'relativo.mp4' }, 'RELATIVE_PATH'], [{ path: path.join(t.root, 'a.txt') }, 'UNSUPPORTED_FORMAT'], [{}, 'INVALID_PATH'], [undefined, 'INVALID_PATH']]) {
      const r = await t.bf.invoke('app:requestOpen', payload);
      assert.equal(r.ok, false);
      assert.equal(r.code, code);
      assert.ok(r.message.length > 10);
    }
    assert.deepEqual((await t.bf.invoke('app:takeOpenRequest')).requests, [], 'pedido inválido não entra na fila');
  } finally { t.cleanup(); }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { locateTools } = require('../src/core/ffmpeg/locate');
const { createContext } = require('../src/ipc/context');
const { setupIpc, loadHandlers, HANDLERS_DIR } = require('../src/ipc');

const real = locateTools();
const skipMedia = !real.ffmpeg || !real.ffprobe ? 'ffmpeg/ffprobe não encontrados' : false;
const silent = { log() {}, info() {}, warn() {}, error() {} };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bf-ipc-')); }

/** ipcMain/app/dialog/shell falsos: guardam os handlers para chamá-los direto. */
function fakeElectron(userData, extra = {}) {
  const handlers = new Map();
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } };
  const dialogs = { next: { canceled: true, filePaths: [] }, calls: [] };
  const revealed = [];
  const deps = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: () => userData, getVersion: () => '9.9.9' },
    dialog: { showOpenDialog: async (_win, opts) => { dialogs.calls.push(opts); return dialogs.next; } },
    shell: { showItemInFolder: (p) => revealed.push(p) },
    getWindow: () => win,
    logger: silent,
    ...extra
  };
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  return { deps, handlers, sent, dialogs, revealed, call };
}

test('createContext cria as pastas e o ctx do contrato', () => {
  const dir = tmp();
  try {
    const fe = fakeElectron(dir, { resolveTools: () => ({ ffmpeg: 'f', ffprobe: 'p', ytdlp: 'y' }) });
    const ctx = createContext(fe.deps);
    for (const key of ['userData', 'projects', 'tools', 'cache', 'downloads']) {
      assert.ok(fs.statSync(ctx.paths[key]).isDirectory(), key);
    }
    assert.deepEqual(ctx.tools, { ffmpeg: 'f', ffprobe: 'p', ytdlp: 'y', whisper: null, twitchDownloader: null });
    for (const key of ['ipcMain', 'app', 'dialog', 'shell', 'getWindow', 'send', 'projectStore', 'bus', 'log', 'handle', 'refreshTools']) {
      assert.ok(ctx[key], key);
    }
    ctx.send('x:y', { a: 1 });
    assert.deepEqual(fe.sent, [['x:y', { a: 1 }]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('send não falha sem janela ou com janela destruída', () => {
  const dir = tmp();
  try {
    const fe = fakeElectron(dir, { getWindow: () => null });
    createContext(fe.deps).send('a:b', 1);
    const fe2 = fakeElectron(dir, { getWindow: () => ({ isDestroyed: () => true, webContents: { send() { throw new Error('não deveria enviar'); } } }) });
    createContext(fe2.deps).send('a:b', 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ctx.tools é um objeto vivo e refreshTools avisa só quando algo mudou', () => {
  const dir = tmp();
  try {
    let found = { ffmpeg: null, ffprobe: null };
    const fe = fakeElectron(dir, { resolveTools: () => found });
    const ctx = createContext(fe.deps);
    const same = ctx.tools;
    const events = [];
    ctx.bus.on('tools:changed', (t) => events.push({ ...t }));
    assert.equal(ctx.tools.ffmpeg, null);

    ctx.refreshTools();
    assert.equal(events.length, 0, 'nada mudou');
    found = { ffmpeg: 'C:\\ff\\ffmpeg.exe', ffprobe: 'C:\\ff\\ffprobe.exe' };
    assert.equal(ctx.refreshTools(), same, 'devolve o mesmo objeto');
    assert.equal(same.ffmpeg, 'C:\\ff\\ffmpeg.exe');
    assert.equal(events.length, 1);
    assert.deepEqual(fe.sent.at(-1)[0], 'tools:changed');
    assert.equal(fe.sent.at(-1)[1].tools.ffprobe, 'C:\\ff\\ffprobe.exe');
    found = { ffmpeg: null, ffprobe: null };
    ctx.refreshTools();
    assert.equal(same.ffmpeg, null, 'ferramenta removida some do objeto vivo');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ctx.handle: ok implícito, erro padronizado, canal inválido e duplicado', async () => {
  const dir = tmp();
  try {
    const fe = fakeElectron(dir);
    const ctx = createContext(fe.deps);
    ctx.handle('t:soma', ({ a, b }) => ({ total: a + b }));
    ctx.handle('t:vazio', () => undefined);
    ctx.handle('t:explicito', () => ({ ok: false, code: 'X', message: 'direto' }));
    ctx.handle('t:falha', () => { const e = new Error('Sem espaço em disco. Libere espaço e tente de novo.'); e.code = 'NO_DISK_SPACE'; e.details = { livre: 10 }; throw e; });
    ctx.handle('t:bug', () => { throw new TypeError('quebrou'); });
    ctx.handle('t:assincrono', async () => { throw Object.assign(new Error('depois'), { code: 42, details: { f() {} } }); });
    ctx.handle('t:semPayload', (payload) => ({ tipo: typeof payload }));

    assert.deepEqual(await fe.call('t:soma', { a: 1, b: 2 }), { ok: true, total: 3 });
    assert.deepEqual(await fe.call('t:vazio'), { ok: true });
    assert.deepEqual(await fe.call('t:explicito'), { ok: false, code: 'X', message: 'direto' });
    assert.deepEqual(await fe.call('t:falha'), { ok: false, code: 'NO_DISK_SPACE', message: 'Sem espaço em disco. Libere espaço e tente de novo.', details: { livre: 10 } });
    assert.deepEqual(await fe.call('t:bug'), { ok: false, code: 'ERROR', message: 'quebrou' });
    assert.deepEqual(await fe.call('t:assincrono'), { ok: false, code: 'ERROR', message: 'depois', details: {} });
    assert.deepEqual(await fe.call('t:semPayload'), { ok: true, tipo: 'object' });

    assert.throws(() => ctx.handle('t:soma', () => ({})), /já registrado/);
    for (const bad of ['semdoispontos', 'Maiuscula:acao', 'a:b-c', 'a:', ':b', 'a:b:c', '', 5]) {
      assert.throws(() => ctx.handle(bad, () => ({})), /Canal IPC inválido/, String(bad));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadHandlers carrega todos os handlers reais sem falhas', () => {
  const dir = tmp();
  try {
    const fe = fakeElectron(dir);
    const ctx = createContext(fe.deps);
    const res = loadHandlers(ctx);
    assert.deepEqual(res.failed, []);
    const onDisk = fs.readdirSync(HANDLERS_DIR).filter((f) => f.endsWith('.js'));
    assert.deepEqual(res.loaded, [...onDisk].sort());
    for (const channel of ['app:info', 'app:refreshTools', 'shell:reveal', 'window:state', 'window:minimize', 'window:maximize', 'window:fullscreen', 'window:close', 'source:pick', 'source:open', 'project:save', 'project:list', 'project:adopt', 'export:pickDir', 'export:warnings', 'export:run', 'export:cancel']) {
      assert.ok(fe.handlers.has(channel), `canal ${channel} registrado`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('um handler quebrado não derruba os outros e fica registrado', () => {
  const dir = tmp();
  const hdir = path.join(dir, 'handlers');
  try {
    fs.mkdirSync(hdir);
    fs.writeFileSync(path.join(hdir, 'a-bom.js'), "exports.register = (ctx) => ctx.handle('bom:ping', () => ({ pong: true }));");
    fs.writeFileSync(path.join(hdir, 'b-quebrado.js'), "throw new Error('dependência ausente');");
    fs.writeFileSync(path.join(hdir, 'c-sem-register.js'), 'exports.outra = 1;');
    fs.writeFileSync(path.join(hdir, 'd-duplicado.js'), "exports.register = (ctx) => ctx.handle('bom:ping', () => ({}));");
    fs.writeFileSync(path.join(hdir, 'leia-me.txt'), 'ignorado');
    const fe = fakeElectron(dir);
    const ctx = setupIpc({ ...fe.deps, handlersDir: hdir });
    assert.deepEqual(ctx.handlers.loaded, ['a-bom.js']);
    assert.deepEqual(ctx.handlers.failed.map((f) => f.file), ['b-quebrado.js', 'c-sem-register.js', 'd-duplicado.js']);
    assert.match(ctx.handlers.failed[0].message, /dependência ausente/);
    assert.ok(fe.handlers.has('bom:ping'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('app:info, app:refreshTools e shell:reveal', async () => {
  const dir = tmp();
  try {
    let found = { ffmpeg: null, ffprobe: null };
    const fe = fakeElectron(dir, { resolveTools: () => found });
    setupIpc(fe.deps);

    const info = await fe.call('app:info');
    assert.equal(info.ok, true);
    assert.deepEqual([info.name, info.version], ['Braga Frame', '9.9.9']);
    assert.ok(info.tagline);
    // o app não tem IA (a aba Análise diz isso) nem publica nada: a frase de apresentação não pode prometer isso
    assert.doesNotMatch(info.tagline, /inteligen|\bIA\b|artificial|autom[aá]tic/i);
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').split('\n')[2], /inteligen|\bIA\b|pronto para publicar/i);
    assert.deepEqual(info.tools, { ffmpeg: null, ffprobe: null, ytdlp: null, whisper: null, twitchDownloader: null });
    assert.deepEqual(info.loadErrors, []);

    found = { ffmpeg: 'F', ffprobe: 'P' };
    assert.equal((await fe.call('app:refreshTools')).tools.ffmpeg, 'F');
    assert.equal((await fe.call('app:info')).tools.ffprobe, 'P');

    assert.equal((await fe.call('shell:reveal', { path: 'C:\\x\\y.mp4' })).ok, true);
    assert.equal((await fe.call('shell:reveal', 'C:\\z.mp4')).ok, true);
    assert.deepEqual(fe.revealed, ['C:\\x\\y.mp4', 'C:\\z.mp4']);
    assert.equal((await fe.call('shell:reveal', {})).code, 'INVALID_PATH');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** Janela falsa com o estado que o Electron guardaria (maximizada, tela cheia, minimizada) e os eventos registrados. */
function fakeWindow() {
  const listeners = new Map();
  const state = { maximized: false, fullscreen: false, minimized: false, closed: false };
  const sent = [];
  const emit = (name) => (listeners.get(name) || []).forEach((fn) => fn());
  const win = {
    isDestroyed: () => false,
    isMaximized: () => state.maximized,
    isFullScreen: () => state.fullscreen,
    isMinimized: () => state.minimized,
    minimize() { state.minimized = true; emit('minimize'); },
    maximize() { state.maximized = true; emit('maximize'); },
    unmaximize() { state.maximized = false; emit('unmaximize'); },
    setFullScreen(on) { state.fullscreen = on; emit(on ? 'enter-full-screen' : 'leave-full-screen'); },
    close() { state.closed = true; },
    on: (name, fn) => listeners.set(name, [...(listeners.get(name) || []), fn]),
    removeListener: (name, fn) => listeners.set(name, (listeners.get(name) || []).filter((f) => f !== fn)),
    webContents: { send: (channel, payload) => sent.push([channel, payload]) }
  };
  return { win, state, sent, listeners };
}

test('window:* controlam a janela sem moldura e respondem com o estado depois da ação', async () => {
  const dir = tmp();
  try {
    const fw = fakeWindow();
    const fe = fakeElectron(dir, { getWindow: () => fw.win });
    setupIpc(fe.deps);
    assert.deepEqual(await fe.call('window:state'), { ok: true, maximized: false, fullscreen: false, minimized: false });
    // maximizar alterna com restaurar
    assert.deepEqual(await fe.call('window:maximize'), { ok: true, maximized: true, fullscreen: false, minimized: false });
    assert.equal(fw.state.maximized, true);
    assert.equal((await fe.call('window:maximize')).maximized, false, 'segundo clique restaura');
    // tela cheia: alterna; { exit:true } só sai (tecla Esc) e não entra
    assert.equal((await fe.call('window:fullscreen')).fullscreen, true);
    assert.equal((await fe.call('window:fullscreen', { exit: true })).fullscreen, false);
    assert.equal((await fe.call('window:fullscreen', { exit: true })).fullscreen, false, 'sair da tela cheia sem estar nela não faz nada');
    // maximizar em tela cheia só sai da tela cheia
    await fe.call('window:fullscreen');
    assert.equal((await fe.call('window:maximize')).fullscreen, false);
    assert.equal(fw.state.maximized, false);
    assert.equal((await fe.call('window:minimize')).minimized, true);
    assert.deepEqual(await fe.call('window:close'), { ok: true });
    assert.equal(fw.state.closed, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('window:* não falham sem janela ou com a janela já destruída', async () => {
  const dir = tmp();
  try {
    for (const getWindow of [() => null, () => ({ isDestroyed: () => true })]) {
      const fe = fakeElectron(dir, { getWindow });
      setupIpc(fe.deps);
      for (const channel of ['window:state', 'window:minimize', 'window:maximize', 'window:fullscreen', 'window:close']) {
        assert.equal((await fe.call(channel)).ok, true, channel);
      }
      assert.deepEqual(await fe.call('window:state'), { ok: true, maximized: false, fullscreen: false, minimized: false });
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('watchWindow avisa o renderer (window:changed) a cada mudança e para quando desligado', () => {
  const { watchWindow, CHANGE_EVENTS } = require('../src/windowControls');
  const fw = fakeWindow();
  const events = [];
  const off = watchWindow(fw.win, (channel, payload) => events.push([channel, payload]));
  fw.win.maximize();
  fw.win.setFullScreen(true);
  fw.win.setFullScreen(false);
  fw.win.unmaximize();
  assert.deepEqual(events.map(([channel]) => channel), Array(4).fill('window:changed'));
  assert.deepEqual(events[0][1], { maximized: true, fullscreen: false, minimized: false });
  assert.deepEqual(events[1][1], { maximized: true, fullscreen: true, minimized: false });
  assert.deepEqual(events[3][1], { maximized: false, fullscreen: false, minimized: false });
  assert.deepEqual([...CHANGE_EVENTS].sort(), ['enter-full-screen', 'leave-full-screen', 'maximize', 'minimize', 'restore', 'unmaximize']);
  off();
  fw.win.maximize();
  assert.equal(events.length, 4, 'depois de desligar, nada é enviado');
  assert.equal(typeof watchWindow(null, () => {}), 'function', 'sem janela devolve uma função inofensiva');
});

test('source:pick e export:pickDir devolvem o caminho ou canceled', async () => {
  const dir = tmp();
  try {
    const fe = fakeElectron(dir);
    setupIpc(fe.deps);
    assert.deepEqual(await fe.call('source:pick'), { ok: true, canceled: true });
    fe.dialogs.next = { canceled: false, filePaths: ['D:\\v\\a.mp4'] };
    assert.deepEqual(await fe.call('source:pick'), { ok: true, path: 'D:\\v\\a.mp4' });
    assert.deepEqual(await fe.call('export:pickDir'), { ok: true, path: 'D:\\v\\a.mp4' });
    assert.deepEqual(fe.dialogs.calls[0].filters[0].extensions, ['mp4', 'mkv', 'mov', 'webm', 'avi', 'flv', 'ts']);
    assert.ok(fe.dialogs.calls[2].properties.includes('openDirectory'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('source:open sem ffprobe ou com arquivo ausente dá erro claro', async () => {
  const dir = tmp();
  try {
    const noTools = fakeElectron(dir, { resolveTools: () => ({}) });
    setupIpc(noTools.deps);
    const a = await noTools.call('source:open', { path: path.join(dir, 'x.mp4') });
    assert.equal(a.ok, false);
    assert.equal(a.code, 'NO_FFPROBE');
    assert.match(a.message, /FFmpeg/);
    assert.equal((await noTools.call('source:open', {})).code, 'INVALID_PATH');

    if (!skipMedia) {
      const fe = fakeElectron(dir);
      setupIpc(fe.deps);
      const b = await fe.call('source:open', { path: path.join(dir, 'nao-existe.mp4') });
      assert.equal(b.code, 'INPUT_MISSING');
      const bad = path.join(dir, 'texto.mp4');
      fs.writeFileSync(bad, 'isto não é um vídeo');
      const c = await fe.call('source:open', bad);
      assert.equal(c.ok, false);
      assert.equal(c.code, 'PROBE_FAILED');
      assert.match(c.message, /^Não foi possível ler o vídeo: o arquivo não parece ser um vídeo válido ou está incompleto.*tente de novo\.$/s);
      // causa e solução em português, sem a linha de comando nem o texto cru do ffprobe (esse fica em details.raw)
      assert.doesNotMatch(c.message, /Command failed|ffprobe\.exe|moov atom|Invalid data|texto\.mp4/);
      assert.match(c.details.raw, /moov atom not found|Invalid data/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('source:open, project:save, project:list e project:adopt com vídeo real', { skip: skipMedia }, async () => {
  const dir = tmp();
  try {
    const a = path.join(dir, 'a.mp4');
    const b = path.join(dir, 'b.mp4');
    for (const file of [a, b]) {
      execFileSync(real.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=2', '-pix_fmt', 'yuv420p', file], { windowsHide: true });
    }
    const fe = fakeElectron(path.join(dir, 'ud'));
    setupIpc(fe.deps);

    // abre: cria
    const first = await fe.call('source:open', { path: a, origin: { type: 'obs' } });
    assert.equal(first.ok, true);
    assert.equal(first.restored, false);
    assert.equal(first.project.version, 2);
    assert.equal(first.project.source.origin.type, 'obs');
    assert.deepEqual([first.info.width, first.info.height], [320, 180]);
    assert.ok(Math.abs(first.info.duration - 2) < 0.3);
    assert.match(first.url, /^file:\/\/\/.*a\.mp4$/);

    // salva uma edição vinda do renderer e reabre: restaura
    const edited = { ...first.project, cuts: [{ id: 'c1', title: 'Teste', start: 0.5, end: 1.5, status: 'approved', exports: [] }] };
    const saved = await fe.call('project:save', { project: edited });
    assert.equal(saved.ok, true);
    assert.equal(saved.project.cuts[0].audio.gainDb, 0);
    const again = await fe.call('source:open', { path: a });
    assert.equal(again.restored, true);
    assert.equal(again.project.cuts[0].title, 'Teste');
    assert.equal(again.project.source.origin.type, 'obs', 'origem existente é mantida');

    assert.equal((await fe.call('project:save', { project: { cuts: [] } })).code, 'INVALID_PROJECT');
    assert.equal((await fe.call('project:save', {})).code, 'INVALID_PROJECT');

    // lista
    const list = await fe.call('project:list');
    assert.equal(list.projects.length, 1);
    assert.equal(list.projects[0].cutCount, 1);

    // adota para b
    const adopted = await fe.call('project:adopt', { fromId: list.projects[0].id, path: b });
    assert.equal(adopted.ok, true);
    assert.equal(adopted.project.cuts[0].title, 'Teste');
    assert.equal(adopted.project.source.path, path.resolve(b));
    assert.ok(adopted.project.source.duration > 1);
    const reopened = await fe.call('source:open', { path: b });
    assert.equal(reopened.restored, true);
    assert.equal(reopened.project.cuts.length, 1);
    assert.equal((await fe.call('project:list')).projects.length, 2);

    assert.equal((await fe.call('project:adopt', { fromPath: a, path: b })).code, 'PROJECT_EXISTS');
    assert.equal((await fe.call('project:adopt', { fromId: 'ffffffffffffffff', path: b })).code, 'PROJECT_NOT_FOUND');
    assert.equal((await fe.call('project:adopt', { fromPath: a })).code, 'INVALID_PATH');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('export:warnings e export:cancel sem exportação em andamento', async () => {
  const dir = tmp();
  try {
    const fe = fakeElectron(dir);
    setupIpc(fe.deps);
    const w = await fe.call('export:warnings', { profile: { resolution: 2160, codec: 'h265' }, source: { width: 1920, height: 1080 } });
    assert.equal(w.ok, true);
    assert.deepEqual(w.errors, []);
    assert.equal(w.warnings.length, 2);
    const bad = await fe.call('export:warnings', { profile: { resolution: 720 }, source: { width: 1920, height: 1080 } });
    assert.equal(bad.errors.length, 1);
    assert.equal((await fe.call('export:cancel')).ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('export:run sem ffmpeg explica o que fazer', async () => {
  const dir = tmp();
  try {
    const fe = fakeElectron(dir, { resolveTools: () => ({}) });
    setupIpc(fe.deps);
    const res = await fe.call('export:run', { input: 'x.mp4', outputDir: dir, baseName: 'a', startSec: 0, endSec: 1 });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'NO_FFMPEG');
    assert.match(res.message, /Instale o FFmpeg/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('export:run exporta de verdade e emite progresso; OUTPUT_EXISTS volta como erro padronizado', { skip: skipMedia }, async () => {
  const dir = tmp();
  try {
    const src = path.join(dir, 'fonte.mp4');
    execFileSync(real.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15:duration=3', '-pix_fmt', 'yuv420p', src], { windowsHide: true });
    const fe = fakeElectron(path.join(dir, 'ud'));
    setupIpc(fe.deps);
    const req = { input: src, outputDir: path.join(dir, 'Cortes'), baseName: 'corte 01', startSec: 0.5, endSec: 2, profile: { resolution: 1080, codec: 'h264', bitrateKbps: 4000 }, onConflict: 'fail' };
    const res = await fe.call('export:run', req);
    assert.equal(res.ok, true);
    assert.ok(fs.existsSync(res.output));
    assert.ok(fe.sent.some(([channel]) => channel === 'export:progress'));
    const dup = await fe.call('export:run', req);
    assert.equal(dup.ok, false);
    assert.equal(dup.code, 'OUTPUT_EXISTS');
    assert.match(dup.message, /Já existe um arquivo/);
    const renamed = await fe.call('export:run', { ...req, onConflict: 'rename' });
    assert.match(renamed.output, /\(2\)\.mp4$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

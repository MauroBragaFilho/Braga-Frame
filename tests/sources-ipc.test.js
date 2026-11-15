'use strict';

/**
 * Fontes: o handler IPC (src/ipc/handlers/sources.js) com um `ctx` de verdade (createContext) e Electron falso.
 * Os programas externos são os falsos de tests/sources-fakes.js (YouTube/Twitch de verdade não são usados aqui).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { locateTools } = require('../src/core/ffmpeg/locate');
const { createContext } = require('../src/ipc/context');
const sources = require('../src/ipc/handlers/sources');
const fakes = require('./sources-fakes');

const FIX = path.join(__dirname, 'sources-fixtures');
const tools = locateTools();
const skipMedia = !tools.ffmpeg || !tools.ffprobe ? 'ffmpeg/ffprobe não encontrados' : false;
const skipFake = skipMedia || fakes.fakeExeSkipReason();
const silent = { log() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHANNELS = [
  'sources:state', 'sources:setSettings', 'sources:pickFolder', 'sources:obsDetect', 'sources:obsList', 'sources:probe', 'sources:fetchVod',
  'sources:refreshMeta', 'sources:partial', 'sources:discardPartial', 'sources:download', 'sources:chat', 'sources:cancel',
  'sources:originFor', 'sources:chatCheck'
];

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bf-src-ipc-')); }
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });

/** ctx real + ipcMain/app/dialog falsos. `found` = ferramentas devolvidas pelo resolvedor. */
function mkCtx(root, found = {}) {
  const handlers = new Map();
  const sent = [];
  const quitListeners = [];
  const dialogs = { next: { canceled: true, filePaths: [] }, calls: [] };
  const win = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } };
  const ctx = createContext({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: (name) => (name === 'videos' ? path.join(root, 'Videos') : path.join(root, 'userData')), getVersion: () => '9.9.9', isPackaged: false, on: (ev, fn) => { if (ev === 'before-quit') quitListeners.push(fn); } },
    dialog: { showOpenDialog: async (_w, opts) => { dialogs.calls.push(opts); return dialogs.next; } },
    shell: {}, getWindow: () => win, logger: silent,
    userDataDir: path.join(root, 'userData'),
    resolveTools: () => ({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, ...found })
  });
  const manager = sources.register(ctx);
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  return { ctx, manager, handlers, sent, dialogs, call, quit: () => quitListeners.forEach((fn) => fn()) };
}

test('registra todos os canais do contrato e só eles', () => {
  const root = tmp();
  try {
    const { ctx } = mkCtx(root);
    const mine = [...ctx.channels].filter((c) => c.startsWith('sources:')).sort();
    assert.deepEqual(mine, [...CHANNELS].sort());
    for (const channel of CHANNELS) assert.match(channel, /^[a-z][a-zA-Z0-9]*:[a-zA-Z0-9]+$/);
  } finally { rm(root); }
});

test('sources:state resume ferramentas, pasta de downloads e configurações; setSettings e pickFolder', async () => {
  const root = tmp();
  try {
    const { call, dialogs } = mkCtx(root, { ytdlp: null });
    const state = await call('sources:state', {});
    assert.equal(state.ok, true);
    assert.equal(state.tools.ytdlp.found, false);
    assert.equal(state.tools.ffmpeg.found, true);
    assert.equal(state.downloadDir, path.join(root, 'Videos', 'Braga Frame'));
    assert.deepEqual(state.settings, { obsFolder: null, downloadDir: null, cookiesBrowser: '', lastQuality: '' });
    assert.equal(state.job, null);

    const set = await call('sources:setSettings', { cookiesBrowser: 'edge' });
    assert.equal(set.ok, true);
    assert.equal(set.settings.cookiesBrowser, 'edge');
    const bad = await call('sources:setSettings', { cookiesBrowser: 'xyz' });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'INVALID_BROWSER');

    // escolher pasta: cancelar não muda nada
    assert.deepEqual(await call('sources:pickFolder', { purpose: 'download' }), { ok: true, canceled: true });
    assert.deepEqual(dialogs.calls[0].properties, ['openDirectory', 'createDirectory']);
    const invalid = await call('sources:pickFolder', { purpose: 'outra' });
    assert.equal(invalid.code, 'INVALID_ARGS');

    const folder = path.join(root, 'Escolhida');
    fs.mkdirSync(folder);
    dialogs.next = { canceled: false, filePaths: [folder] };
    const picked = await call('sources:pickFolder', { purpose: 'download' });
    assert.equal(picked.path, folder);
    assert.equal(picked.settings.downloadDir, folder);
    const obs = await call('sources:pickFolder', { purpose: 'obs' });
    assert.equal(obs.settings.obsFolder, folder);
    assert.deepEqual(dialogs.calls[2].properties, ['openDirectory'], 'a pasta do OBS já existe: sem "criar pasta"');
    assert.equal(dialogs.calls[2].defaultPath === undefined || typeof dialogs.calls[2].defaultPath === 'string', true);
    assert.equal((await call('sources:state', {})).downloadDir, folder);
    // a escolha sobrevive a reiniciar o app (outro ctx sobre a mesma pasta)
    const again = mkCtx(root);
    assert.equal((await again.call('sources:state', {})).settings.obsFolder, folder);
  } finally { rm(root); }
});

test('sources:obsDetect e obsList leem o %APPDATA% do processo (configuração do OBS de verdade)', { skip: skipMedia }, async () => {
  const root = tmp();
  const saved = process.env.APPDATA;
  try {
    const appData = path.join(root, 'Roaming');
    const profile = path.join(appData, 'obs-studio', 'basic', 'profiles', 'Live');
    fs.mkdirSync(profile, { recursive: true });
    const rec = path.join(root, 'Gravacoes');
    fs.mkdirSync(rec);
    fs.writeFileSync(path.join(profile, 'basic.ini'), `[General]\nName=Live\n[Output]\nMode=Advanced\n[AdvOut]\nRecType=Standard\nRecFilePath=${rec.replace(/\\/g, '/')}\n`);
    fs.writeFileSync(path.join(appData, 'obs-studio', 'user.ini'), '[Basic]\nProfile=Live\nProfileDir=Live\n');
    fakes.sampleVideo(tools.ffmpeg, path.join(rec, '2026-10-20 09-00-00.mkv'), { seconds: 2 });
    const old = new Date(Date.now() - 7200 * 1000);
    fs.utimesSync(path.join(rec, '2026-10-20 09-00-00.mkv'), old, old);

    process.env.APPDATA = appData;
    const { call } = mkCtx(root);
    const det = await call('sources:obsDetect', {});
    assert.equal(det.ok, true);
    assert.equal(det.found, true);
    assert.equal(det.selected, path.normalize(rec));
    assert.equal(det.profiles[0].name, 'Live');
    assert.equal(det.profiles[0].active, true);
    const list = await call('sources:obsList', {});
    assert.equal(list.ok, true);
    assert.equal(list.files.length, 1);
    assert.ok(list.files[0].durationSec > 1);
    const missing = await call('sources:obsList', { folder: path.join(root, 'nada') });
    assert.equal(missing.ok, true);
    assert.equal(missing.exists, false);
    assert.match(missing.error, /não existe/);

    process.env.APPDATA = path.join(root, 'SemObs');
    const none = await mkCtx(root).call('sources:obsDetect', {});
    assert.equal(none.found, false);
    assert.match(none.reason, /Não encontrei a configuração do OBS/);
    const noFolder = await mkCtx(root).call('sources:obsList', {});
    assert.equal(noFolder.ok === false ? noFolder.code : 'ok', 'NO_FOLDER');
  } finally {
    if (saved === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved;
    rm(root);
  }
});

test('erros de argumento e de link voltam como { ok:false, code, message } em português', async () => {
  const root = tmp();
  try {
    const { call } = mkCtx(root, { ytdlp: 'C:\\nao\\importa\\yt-dlp.exe' });
    for (const channel of ['sources:fetchVod', 'sources:refreshMeta', 'sources:partial', 'sources:discardPartial', 'sources:download', 'sources:chat']) {
      const res = await call(channel, {});
      assert.equal(res.ok, false, channel);
      assert.equal(res.code, 'INVALID_ARGS', channel);
      assert.match(res.message, /Informe o link do vídeo/);
    }
    for (const channel of ['sources:originFor', 'sources:chatCheck']) assert.equal((await call(channel, {})).code, 'INVALID_ARGS');
    const vimeo = await call('sources:fetchVod', { url: 'https://vimeo.com/1' });
    assert.equal(vimeo.code, 'UNSUPPORTED_URL');
    assert.match(vimeo.message, /YouTube e da Twitch/);
    const nothing = await call('sources:cancel', {});
    assert.deepEqual(nothing, { ok: true, cancelled: false });
    const unknown = await call('sources:originFor', { path: path.join(root, 'x.mp4') });
    assert.deepEqual(unknown, { ok: true, known: false });
    const noYt = await mkCtx(root, { ytdlp: null }).call('sources:fetchVod', { url: 'https://youtu.be/jNQXAC9IVRw' });
    assert.equal(noYt.code, 'NO_YTDLP');
  } finally { rm(root); }
});

test('download pelo IPC: eventos sources:progress, ctx.toolUsage durante o trabalho, origem reconhecida depois', { skip: skipFake, timeout: 90000 }, async () => {
  const root = tmp();
  try {
    process.env.BF_FAKE_NODE = process.execPath;
    const bin = path.join(root, 'bin');
    const ytdlp = fakes.makeFakeYtdlp(bin);
    const sample = path.join(root, 'amostra.mp4');
    fakes.sampleVideo(tools.ffmpeg, sample, { seconds: 3 });
    fakes.fakeScenario(bin, { metaFile: path.join(FIX, 'ytdlp-youtube-zoo.json'), sampleFile: sample, steps: 10, stepMs: 150 });
    const { ctx, call, sent } = mkCtx(root, { ytdlp });
    const url = 'https://youtu.be/jNQXAC9IVRw';
    const dest = path.join(root, 'VODs');

    const meta = await call('sources:fetchVod', { url });
    assert.equal(meta.ok, true);
    assert.equal(meta.meta.title, 'Me at the zoo');
    assert.equal(meta.fromCache, false);
    assert.equal((await call('sources:fetchVod', { url })).fromCache, true);
    assert.equal((await call('sources:fetchVod', { url, refresh: true })).fromCache, false, 'o botão Buscar ignora o cache');
    const refreshed = await call('sources:refreshMeta', { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=3' });
    assert.equal(refreshed.origin.url, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
    assert.equal(refreshed.origin.type, 'vod');

    assert.equal(ctx.toolUsage.inUse('ytdlp', 'ytdlp'), null);
    const running = call('sources:download', { url, dir: dest, quality: 'best' });
    await sleep(500);
    assert.match(ctx.toolUsage.inUse('ytdlp', 'ytdlp') || '', /yt-dlp/, 'a aba Ferramentas não remove o yt-dlp no meio do download');
    assert.equal(ctx.toolUsage.inUse('whisper', 'whisper'), null, 'não bloqueia ferramentas de outros recursos');
    assert.equal((await call('sources:state', {})).job.kind, 'download');
    const busy = await call('sources:download', { url, dir: dest });
    assert.equal(busy.code, 'BUSY');

    const res = await running;
    assert.equal(res.ok, true);
    assert.equal(path.basename(res.path), 'Me at the zoo [jNQXAC9IVRw].mp4');
    assert.equal(res.origin.type, 'vod');
    assert.equal(res.origin.videoId, 'jNQXAC9IVRw');
    assert.equal(ctx.toolUsage.inUse('ytdlp', 'ytdlp'), null, 'terminou: liberado');

    const progress = sent.filter(([ch]) => ch === 'sources:progress').map(([, p]) => p);
    assert.ok(progress.length >= 3);
    assert.ok(progress.every((p) => p.jobId && p.kind === 'download'));
    assert.equal(progress[progress.length - 1].phase, 'done');

    const known = await call('sources:originFor', { path: res.path });
    assert.equal(known.known, true);
    assert.equal(known.kind, 'vod');
    assert.equal(known.origin.title, 'Me at the zoo');
    assert.equal(known.meta.channel, 'jawed');

    const partial = await call('sources:partial', { url, dir: dest });
    assert.equal(partial.bytes, 0);
    assert.equal((await call('sources:discardPartial', { url, dir: dest })).freed, 0);
  } finally { rm(root); }
});

test('fechar o app cancela o trabalho em andamento; sobras de chat de uma execução anterior são limpas ao iniciar', { skip: skipFake, timeout: 60000 }, async () => {
  const root = tmp();
  try {
    process.env.BF_FAKE_NODE = process.execPath;
    const bin = path.join(root, 'bin');
    const ytdlp = fakes.makeFakeYtdlp(bin);
    const sample = path.join(root, 'amostra.mp4');
    fakes.sampleVideo(tools.ffmpeg, sample, { seconds: 2 });
    fakes.fakeScenario(bin, { metaFile: path.join(FIX, 'ytdlp-youtube-zoo.json'), sampleFile: sample, steps: 40, stepMs: 200 });
    const leftover = path.join(root, 'userData', 'cache', 'sources', 'chat-antigo');
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, 'sobra.json'), '{}');

    const { call, quit, manager } = mkCtx(root, { ytdlp });
    assert.equal(fs.existsSync(leftover), false, 'resíduo do cache do próprio recurso removido');
    const running = call('sources:download', { url: 'https://youtu.be/jNQXAC9IVRw', dir: path.join(root, 'V') });
    await sleep(900);
    assert.ok(manager.job, 'download em andamento');
    quit();
    const res = await running;
    assert.equal(res.ok, false);
    assert.equal(res.code, 'CANCELLED');
    assert.equal(manager.job, null);
    const cancelled = await call('sources:cancel', {});
    assert.equal(cancelled.cancelled, false);
  } finally { rm(root); }
});

test('consulta de metadados: cancelar pelo queryId (sources:cancel), fechar o app a encerra e sobras do TEMP do yt-dlp são varridas', { skip: skipFake, timeout: 90000 }, async () => {
  const root = tmp();
  try {
    process.env.BF_FAKE_NODE = process.execPath;
    const bin = path.join(root, 'bin');
    const ytdlp = fakes.makeFakeYtdlp(bin);
    fakes.fakeScenario(bin, { metaFile: path.join(FIX, 'ytdlp-youtube-zoo.json'), delayBeforeMetaMs: 40000 });
    const stale = path.join(root, 'userData', 'cache', 'yt-dlp-tmp', 'velho', '_MEI999');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'python.dll'), 'x');

    const { call, quit, manager } = mkCtx(root, { ytdlp });
    assert.equal(fs.existsSync(path.join(root, 'userData', 'cache', 'yt-dlp-tmp')), false, 'sobra do yt-dlp encerrado à força removida ao iniciar');
    const url = 'https://youtu.be/jNQXAC9IVRw';
    const started = () => { try { return fs.readFileSync(path.join(bin, 'calls.log'), 'utf8').includes('"-J"'); } catch { return false; } };
    const waitStarted = async () => { for (let i = 0; i < 300 && !started(); i += 1) await sleep(50); assert.ok(started(), 'o yt-dlp começou a consulta'); };

    // o botão "Cancelar" da aba: cancela só a consulta que tem esse id
    const first = call('sources:fetchVod', { url, refresh: true, queryId: 'consulta-1' });
    await waitStarted();
    assert.deepEqual(await call('sources:cancel', { queryId: 'outra' }), { ok: true, cancelled: false });
    assert.deepEqual(await call('sources:cancel', {}), { ok: true, cancelled: false }, 'sem queryId e sem trabalho, nada a cancelar');
    assert.deepEqual(await call('sources:cancel', { queryId: 'consulta-1' }), { ok: true, cancelled: true });
    const res = await first;
    assert.equal(res.ok, false);
    assert.equal(res.code, 'CANCELLED');
    assert.match(res.message, /Consulta cancelada/);

    // fechar o app com uma consulta no ar: antes o yt-dlp seguia rodando até terminar sozinho
    fs.rmSync(path.join(bin, 'calls.log'), { force: true });
    const second = call('sources:fetchVod', { url, refresh: true });
    await waitStarted();
    quit();
    assert.equal((await second).code, 'CANCELLED');
    assert.equal(manager.aborters.size, 0);
    await sleep(600);
    const out = require('node:child_process').execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${path.basename(root)}') -and -not $_.CommandLine.Contains('Get-CimInstance') } | Select-Object -ExpandProperty ProcessId`], { encoding: 'utf8', windowsHide: true });
    assert.equal(out.trim(), '', 'nenhum processo do yt-dlp ficou para trás');
  } finally { rm(root); }
});

test('sources:partial devolve também a avaliação do espaço livre (disk) para a aba avisar ANTES de baixar', { skip: skipFake, timeout: 60000 }, async () => {
  const root = tmp();
  try {
    process.env.BF_FAKE_NODE = process.execPath;
    const bin = path.join(root, 'bin');
    const ytdlp = fakes.makeFakeYtdlp(bin);
    const info = JSON.parse(fs.readFileSync(path.join(FIX, 'ytdlp-youtube-zoo.json'), 'utf8'));
    for (const fmt of info.formats) { fmt.filesize = fmt.vcodec !== 'none' ? 900 * 1024 ** 4 : 0; delete fmt.filesize_approx; }
    fs.writeFileSync(path.join(bin, 'gigante.json'), JSON.stringify(info));
    fakes.fakeScenario(bin, { metaFile: path.join(bin, 'gigante.json') });
    const { call } = mkCtx(root, { ytdlp });
    const url = 'https://youtu.be/jNQXAC9IVRw';
    const dest = path.join(root, 'VODs');

    const before = await call('sources:partial', { url, dir: dest });
    assert.equal(before.ok, true);
    assert.equal(before.bytes, 0);
    assert.equal(before.disk.level, 'unknown', 'sem consulta não há tamanho para comparar');

    await call('sources:fetchVod', { url });
    const after = await call('sources:partial', { url, dir: dest, quality: 'best' });
    assert.equal(after.disk.level, 'block');
    assert.match(after.disk.message, /Não há espaço suficiente em .*VODs/);
    assert.ok(after.disk.freeBytes > 0 && after.disk.estBytes > after.disk.freeBytes);
    const refused = await call('sources:download', { url, dir: dest });
    assert.equal(refused.code, 'NO_DISK_SPACE');
    // o aviso de antes e a recusa dizem a mesma coisa (o espaço livre pode variar alguns MB entre as duas leituras: compara sem ele)
    const withoutFree = (text) => text.replace(/restam .*? (MB|GB)\./, 'restam X.');
    assert.equal(withoutFree(refused.message), withoutFree(after.disk.message));
  } finally { rm(root); }
});

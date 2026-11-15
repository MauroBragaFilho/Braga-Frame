'use strict';

/**
 * Integração ferramentas x Fontes x Legendas, com o `ctx` e os handlers REAIS (createContext + handlers/*.js) e programas de
 * verdade (lançadores .exe que rodam um script de teste; nada de mock do ctx):
 *
 *  1. ordem de resolução para as TRÊS ferramentas externas (yt-dlp, whisper, TwitchDownloaderCLI):
 *     instalada pelo app  >  variável CORTE_*  >  PATH;
 *  2. enquanto o processo de cada uma roda, `tools:remove` responde TOOL_IN_USE (a aba Ferramentas não tira o programa de
 *     baixo do trabalho) e, depois, a remoção funciona e o app volta a usar a do sistema.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createContext } = require('../src/ipc/context');
const registry = require('../src/core/tools/registry');
const fakes = require('./sources-fakes');
const fx = require('./export-fixtures');
const sourcesHandler = require('../src/ipc/handlers/sources');
const subtitlesHandler = require('../src/ipc/handlers/subtitles');
const { getModel } = require('../src/core/subtitles/models');
const toolsHandler = require('../src/ipc/handlers/tools');

const skip = fx.skipMedia || fakes.fakeExeSkipReason();
const silent = { log() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIX = path.join(__dirname, 'sources-fixtures');
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
const WHISPER_SCRIPT = String.raw`
const fs = require('fs'); const path = require('path');
fs.writeFileSync(path.join(__dirname, 'iniciou.flag'), '1');
setTimeout(() => process.exit(0), 2500);
`;

async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(40);
  }
  throw new Error(`Tempo esgotado esperando: ${what}`);
}

/** ctx real com `env` próprio (os testes mexem em PATH e CORTE_*) e Electron falso. */
function mkCtx(root, env, { handlers: wanted = [] } = {}) {
  const handlers = new Map();
  const ctx = createContext({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: (name) => (name === 'videos' ? path.join(root, 'Videos') : path.join(root, 'userData')), getVersion: () => '9.9.9', isPackaged: false, on() {} },
    dialog: {}, shell: {}, getWindow: () => null, logger: silent, userDataDir: path.join(root, 'userData'), env
  });
  const managers = {};
  for (const name of wanted) managers[name] = ({ sources: sourcesHandler, subtitles: subtitlesHandler, tools: toolsHandler })[name].register(ctx);
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  return { ctx, call, managers };
}

/** Coloca na pasta de ferramentas do app uma instalação "oficial" (manifesto da entrada real) cujo executável é o programa de teste. */
function installFake(ctx, id, makeExe) {
  const entry = registry.getEntries().find((e) => e.id === id);
  const asset = registry.assetFor(entry);
  const dir = path.join(ctx.paths.tools, id, entry.version);
  const target = path.join(dir, ...asset.exe.split('/'));
  const exe = makeExe(path.dirname(target));
  assert.equal(path.basename(exe).toLowerCase(), path.basename(target).toLowerCase(), 'o programa de teste tem o nome que a entrada espera');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schema: 1, id, version: entry.version, file: asset.name, sha256: asset.sha256, exe: asset.exe, exeSize: fs.statSync(exe).size,
    installedAt: new Date().toISOString(), source: entry.source
  }));
  return exe;
}

const trivial = (name) => (dir) => fakes.makeFakeExe(dir, name, "console.log('ok');");

test('ordem de resolução das três ferramentas: instalada pelo app > CORTE_* > PATH (e volta ao cair uma camada)', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-integ-tools-'));
  try {
    process.env.BF_FAKE_NODE = process.execPath;
    const pathDir = path.join(root, 'no-path');
    const envDir = path.join(root, 'por-variavel');
    const inPath = {
      ytdlp: fakes.makeFakeExe(pathDir, 'yt-dlp', "console.log('path');"),
      whisper: fakes.makeFakeExe(pathDir, 'whisper-cli', "console.log('path');"),
      twitchDownloader: fakes.makeFakeExe(pathDir, 'TwitchDownloaderCLI', "console.log('path');")
    };
    const inEnv = {
      ytdlp: fakes.makeFakeExe(envDir, 'ytdlp-env', "console.log('env');"),
      whisper: fakes.makeFakeExe(envDir, 'whisper-env', "console.log('env');"),
      twitchDownloader: fakes.makeFakeExe(envDir, 'tdl-env', "console.log('env');")
    };
    // o PATH do teste começa pela pasta falsa (o `where` do sistema ainda é achado no resto do PATH)
    const env = { ...process.env, PATH: `${pathDir}${path.delimiter}${process.env.PATH}` };
    for (const name of ['CORTE_YTDLP', 'CORTE_WHISPER', 'CORTE_TWITCHDOWNLOADER']) delete env[name];
    const { ctx } = mkCtx(root, env);
    const names = ['ytdlp', 'whisper', 'twitchDownloader'];
    const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

    // 3) só o PATH
    for (const key of names) assert.ok(ctx.tools[key] && same(ctx.tools[key], inPath[key]), `${key}: PATH -> ${ctx.tools[key]}`);

    // 2) a variável de ambiente vence o PATH
    env.CORTE_YTDLP = inEnv.ytdlp;
    env.CORTE_WHISPER = inEnv.whisper;
    env.CORTE_TWITCHDOWNLOADER = inEnv.twitchDownloader;
    ctx.refreshTools();
    for (const key of names) assert.ok(same(ctx.tools[key], inEnv[key]), `${key}: CORTE_* vence o PATH -> ${ctx.tools[key]}`);

    // 1) a instalada pelo app vence as duas
    const installed = {
      ytdlp: installFake(ctx, 'ytdlp', trivial('yt-dlp')),
      whisper: installFake(ctx, 'whisper', trivial('whisper-cli')),
      twitchDownloader: installFake(ctx, 'twitchdownloader', trivial('TwitchDownloaderCLI'))
    };
    ctx.refreshTools();
    for (const key of names) assert.ok(same(ctx.tools[key], installed[key]), `${key}: a instalada pelo app vence -> ${ctx.tools[key]}`);

    // remover a instalada devolve a variável; sem a variável, o PATH
    fs.rmSync(path.join(ctx.paths.tools, 'whisper'), { recursive: true, force: true });
    fs.rmSync(path.join(ctx.paths.tools, 'twitchdownloader'), { recursive: true, force: true });
    ctx.refreshTools();
    assert.ok(same(ctx.tools.whisper, inEnv.whisper));
    assert.ok(same(ctx.tools.twitchDownloader, inEnv.twitchDownloader));
    assert.ok(same(ctx.tools.ytdlp, installed.ytdlp), 'a outra continua instalada');
    delete env.CORTE_WHISPER;
    delete env.CORTE_TWITCHDOWNLOADER;
    ctx.refreshTools();
    assert.ok(same(ctx.tools.whisper, inPath.whisper));
    assert.ok(same(ctx.tools.twitchDownloader, inPath.twitchDownloader));
  } finally { rm(root); }
});

test('yt-dlp e TwitchDownloaderCLI: a aba Ferramentas não remove o programa enquanto ele baixa (TOOL_IN_USE) e libera no fim', { skip, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-integ-tools-'));
  try {
    process.env.BF_FAKE_NODE = process.execPath;
    const env = { ...process.env };
    for (const name of ['CORTE_YTDLP', 'CORTE_WHISPER', 'CORTE_TWITCHDOWNLOADER']) delete env[name];
    const { ctx, call } = mkCtx(root, env, { handlers: ['tools', 'sources'] });
    const ytdlpExe = installFake(ctx, 'ytdlp', (dir) => fakes.makeFakeYtdlp(dir));
    const twitchExe = installFake(ctx, 'twitchdownloader', (dir) => fakes.makeFakeTwitchDownloader(dir));
    ctx.refreshTools();
    assert.equal(path.resolve(ctx.tools.ytdlp).toLowerCase(), path.resolve(ytdlpExe).toLowerCase());
    assert.equal(path.resolve(ctx.tools.twitchDownloader).toLowerCase(), path.resolve(twitchExe).toLowerCase());
    const calls = (exe) => { try { return fs.readFileSync(path.join(path.dirname(exe), 'calls.log'), 'utf8'); } catch { return ''; } };

    // --- TwitchDownloaderCLI: baixando o chat de um VOD ---
    fakes.fakeScenario(path.dirname(twitchExe), { chatFile: path.join(FIX, 'twitchdownloader-chat.json'), stepMs: 700 });
    fakes.fakeScenario(path.dirname(ytdlpExe), { metaFile: path.join(FIX, 'ytdlp-twitch-vod.json'), delayBeforeMetaMs: 2500 });
    const chat = call('sources:chat', { url: 'https://www.twitch.tv/videos/2345678901' });
    await until(() => calls(twitchExe).length > 0, 'o TwitchDownloaderCLI começou');
    assert.match(ctx.toolUsage.inUse('twitchDownloader', 'twitchdownloader') || '', /TwitchDownloaderCLI/);
    assert.equal(ctx.toolUsage.inUse('ytdlp', 'ytdlp'), null, 'o yt-dlp não está em uso');
    const busyRemove = await call('tools:remove', { id: 'twitchdownloader' });
    assert.equal(busyRemove.ok, false);
    assert.equal(busyRemove.code, 'TOOL_IN_USE');
    assert.match(busyRemove.message, /TwitchDownloaderCLI está baixando um chat/);
    assert.match(busyRemove.message, /Espere terminar \(ou cancele\)/, 'causa e o que fazer');
    assert.ok(fs.existsSync(twitchExe), 'nada foi removido');
    const force = await call('tools:install', { id: 'twitchdownloader', force: true });
    assert.equal(force.code, 'TOOL_IN_USE', 'reinstalar/atualizar também espera');
    assert.equal((await chat).ok, true);
    assert.equal(ctx.toolUsage.inUse('twitchDownloader', 'twitchdownloader'), null, 'terminou: liberado');
    const removed = await call('tools:remove', { id: 'twitchdownloader' });
    assert.equal(removed.ok, true);
    assert.equal(removed.removed, true);
    assert.ok(!fs.existsSync(path.join(ctx.paths.tools, 'twitchdownloader')));

    // --- yt-dlp: consultando um VOD ---
    const meta = call('sources:fetchVod', { url: 'https://www.twitch.tv/videos/2345678901', refresh: true });
    await until(() => calls(ytdlpExe).length > 0, 'o yt-dlp começou');
    assert.match(ctx.toolUsage.inUse('ytdlp', 'ytdlp') || '', /yt-dlp/);
    const blocked = await call('tools:remove', { id: 'ytdlp' });
    assert.equal(blocked.code, 'TOOL_IN_USE');
    assert.match(blocked.message, /yt-dlp/);
    assert.equal((await meta).ok, true);
    assert.equal(ctx.toolUsage.inUse('ytdlp', 'ytdlp'), null);
    assert.equal((await call('tools:remove', { id: 'ytdlp' })).removed, true);
  } finally { rm(root); }
});

test('whisper: gerar legenda segura o motor (TOOL_IN_USE) enquanto o whisper-cli roda e libera quando acaba (ou falha)', { skip, timeout: 180000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-integ-tools-'));
  try {
    process.env.BF_FAKE_NODE = process.execPath;
    const env = { ...process.env };
    for (const name of ['CORTE_YTDLP', 'CORTE_WHISPER', 'CORTE_TWITCHDOWNLOADER']) delete env[name];
    const { ctx, call } = mkCtx(root, env, { handlers: ['tools', 'subtitles'] });
    const whisperExe = installFake(ctx, 'whisper', (dir) => fakes.makeFakeExe(dir, 'whisper-cli', WHISPER_SCRIPT));
    // modelo "instalado" (mesma estrutura do ModelManager): pasta whisper-small/r<revisão>/ + manifesto. O ModelManager só aceita o
    // modelo cujo arquivo e SHA-256 são os FIXADOS no catálogo (um arquivo de outro hash não vale), então o manifesto usa os do catálogo
    const small = getModel('small');
    const modelDir = path.join(root, 'userData', 'models', 'whisper-small', 'rabcdef123456');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, small.file), 'modelo de teste');
    fs.writeFileSync(path.join(modelDir, 'manifest.json'), JSON.stringify({
      schema: 1, id: 'whisper-small', version: 'rabcdef123456', file: small.file, exe: small.file,
      exeSize: Buffer.byteLength('modelo de teste'), sha256: small.sha256, installedAt: new Date().toISOString()
    }));
    ctx.refreshTools();
    assert.equal(path.resolve(ctx.tools.whisper).toLowerCase(), path.resolve(whisperExe).toLowerCase());

    // vídeo com fala "de mentira" (um tom contínuo não é silêncio: o whisper é chamado)
    const video = path.join(root, 'v.mp4');
    fx.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=5:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);

    assert.equal(ctx.toolUsage.inUse('whisper', 'whisper'), null, 'ocioso');
    const generating = call('subtitles:generate', { cutId: 'c1', input: video, start: 0, end: 3, language: 'pt', modelId: 'small' });
    await until(() => fs.existsSync(path.join(path.dirname(whisperExe), 'iniciou.flag')), 'o whisper-cli começou');
    assert.match(ctx.toolUsage.inUse('whisper', 'whisper') || '', /geração de legendas/);
    const blocked = await call('tools:remove', { id: 'whisper' });
    assert.equal(blocked.code, 'TOOL_IN_USE');
    assert.match(blocked.message, /Whisper|legendas/);
    assert.ok(fs.existsSync(whisperExe), 'o motor continua no lugar');
    const res = await generating; // o programa de teste não grava o JSON: a geração falha, e mesmo assim libera
    assert.equal(typeof res.ok, 'boolean');
    assert.equal(ctx.toolUsage.inUse('whisper', 'whisper'), null, 'terminou (ou falhou): liberado');
    assert.equal((await call('tools:remove', { id: 'whisper' })).removed, true);
  } finally { rm(root); }
});

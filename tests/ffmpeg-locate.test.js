'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { findTool, findTools, locateTools, pathDirs } = require('../src/core/ffmpeg/locate');
const { resolveTools } = require('../src/ipc/context');

const EXT = process.platform === 'win32' ? '.exe' : '';

function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `bf-locate-${name}-`)); }
function fakeExe(dir, name) {
  const file = path.join(dir, name + EXT);
  fs.writeFileSync(file, 'x');
  if (EXT === '') fs.chmodSync(file, 0o755);
  return file;
}
/** Ambiente só com o PATH dado (sem herdar o do computador, que pode ter ffmpeg de verdade). */
function envWith(...dirs) {
  const base = process.platform === 'win32' ? { PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: process.env.SystemRoot } : {};
  return { ...base, PATH: dirs.join(path.delimiter) };
}

test('acha a ferramenta numa pasta com acento (João Programação), que o `where` do Windows corrompia', () => {
  const dir = tmp('João Programação ');
  try {
    const exe = fakeExe(dir, 'footool');
    assert.equal(findTool('footool', null, envWith(dir)), exe);
    assert.equal(findTool('footool', null, envWith(os.tmpdir(), dir)), exe, 'depois de outras pastas do PATH');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('não procura na pasta atual do processo: só no PATH', () => {
  const dir = tmp('cwd');
  const previous = process.cwd();
  try {
    fakeExe(dir, 'falsotool');
    process.chdir(dir);
    assert.equal(findTool('falsotool', null, envWith(os.tmpdir())), null, 'um executável solto na pasta atual não vale');
    assert.equal(findTool('falsotool', null, envWith('.', '')), null, 'entradas relativas ou vazias do PATH não valem');
    assert.equal(findTool('falsotool', null, envWith(dir)), path.join(dir, `falsotool${EXT}`), 'a mesma pasta, se estiver no PATH de verdade, vale');
  } finally { process.chdir(previous); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a variável CORTE_* vale antes do PATH, mas precisa ser um arquivo (pasta não conta)', () => {
  const dir = tmp('env');
  const other = tmp('env2');
  try {
    const inPath = fakeExe(dir, 'tooly');
    const viaEnv = fakeExe(other, 'tooly-custom');
    assert.equal(findTool('tooly', 'CORTE_TOOLY', { ...envWith(dir), CORTE_TOOLY: viaEnv }), viaEnv);
    assert.equal(findTool('tooly', 'CORTE_TOOLY', { ...envWith(dir), CORTE_TOOLY: other }), inPath, 'uma pasta em CORTE_* é ignorada');
    assert.equal(findTool('tooly', 'CORTE_TOOLY', { ...envWith(dir), CORTE_TOOLY: path.join(other, 'nao-existe') }), inPath);
    assert.equal(findTool('inexistente-xyz', 'CORTE_NADA', envWith(dir)), null);
  } finally { for (const d of [dir, other]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('findTools resolve vários nomes numa única passagem, respeitando a ordem do PATH', () => {
  const a = tmp('a');
  const b = tmp('b-ação');
  try {
    const alfaA = fakeExe(a, 'alfa');
    fakeExe(b, 'alfa');
    const beta = fakeExe(b, 'beta');
    const found = findTools([
      { key: 'um', name: 'alfa' }, { key: 'dois', name: 'beta' }, { key: 'tres', name: 'gama' }
    ], envWith(a, b));
    assert.deepEqual(found, { um: alfaA, dois: beta, tres: null }, 'a primeira pasta do PATH vence');
  } finally { for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('pathDirs: aspas e repetições são tratadas; o PATH pode se chamar "Path"', () => {
  const dir = tmp('quote');
  try {
    const exe = fakeExe(dir, 'quoted');
    assert.deepEqual(pathDirs({ PATH: `"${dir}"${path.delimiter}${dir}${path.delimiter}` }), [dir]);
    assert.equal(findTool('quoted', null, { PATHEXT: '.COM;.EXE;.BAT;.CMD', Path: `"${dir}"` }), exe);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a procura não executa nenhum programa (nada de `where`/`which`, que bloqueavam o processo principal)', () => {
  const patched = ['execFileSync', 'execSync', 'spawnSync', 'execFile', 'exec', 'spawn', 'fork'];
  const original = {};
  const modulePath = require.resolve('../src/core/ffmpeg/locate');
  const cached = require.cache[modulePath];
  try {
    for (const name of patched) { original[name] = childProcess[name]; childProcess[name] = () => { throw new Error(`locate.js chamou child_process.${name}`); }; }
    delete require.cache[modulePath];
    const fresh = require('../src/core/ffmpeg/locate');
    const t0 = Date.now();
    const real = fresh.findTools([
      { key: 'ffmpeg', name: 'ffmpeg' }, { key: 'ffprobe', name: 'ffprobe' }, { key: 'a', name: 'yt-dlp' },
      { key: 'b', name: 'whisper-cli' }, { key: 'c', name: 'TwitchDownloaderCLI' }
    ]);
    assert.ok(Date.now() - t0 < 1500, 'os cinco nomes numa só varredura do PATH');
    assert.equal(typeof real, 'object');
  } finally {
    for (const name of patched) childProcess[name] = original[name];
    delete require.cache[modulePath];
    if (cached) require.cache[modulePath] = cached;
  }
});

test('locateTools e resolveTools usam a mesma procura (pasta com acento no PATH)', () => {
  const dir = tmp('Vídeos ');
  const empty = tmp('vazio');
  try {
    const ffmpeg = fakeExe(dir, 'ffmpeg');
    const ffprobe = fakeExe(dir, 'ffprobe');
    const ytdlp = fakeExe(dir, 'yt-dlp');
    const env = envWith(dir);
    assert.deepEqual(locateTools(env), { ffmpeg, ffprobe });
    const tools = resolveTools({ paths: { tools: path.join(empty, 'tools') }, env });
    assert.deepEqual(tools, { ffmpeg, ffprobe, ytdlp, whisper: null, twitchDownloader: null });
  } finally { for (const d of [dir, empty]) fs.rmSync(d, { recursive: true, force: true }); }
});

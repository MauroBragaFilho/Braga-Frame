'use strict';

/**
 * Catálogo de ferramentas (entradas oficiais + entradas de teste) e resolução do ctx.tools:
 * a ferramenta instalada pelo app tem preferência; sem ela vale CORTE_* e depois o PATH.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadToolCatalog, parseTestEntries, testModeAllowed, toolKeyFor, TEST_ENV_VAR } = require('../src/core/tools/catalog');
const { resolveTools } = require('../src/ipc/context');
const { sha256, tmpDir, cleanup } = require('./tools-fixtures');

const PLATFORM_KEY = `${process.platform}-${process.arch}`;
const SHA = sha256(Buffer.from('conteudo'));
const ROOT = path.join(__dirname, '..');

function entry(patch = {}) {
  return {
    id: 'whisper',
    label: 'Whisper (teste)',
    version: 'b1',
    source: 'oficial: https://exemplo.invalid/projeto (teste local)',
    assets: { [PLATFORM_KEY]: { url: 'http://127.0.0.1:9/whisper.zip', name: 'whisper.zip', size: 10, sha256: SHA, exe: 'whisper-cli.exe' } },
    ...patch
  };
}

const official = (id = 'ytdlp') => entry({
  id,
  label: `Oficial ${id}`,
  assets: { [PLATFORM_KEY]: { url: 'https://github.com/exemplo/projeto/releases/download/1/a.zip', name: 'a.zip', size: 10, sha256: SHA, exe: 'a.exe' } }
});

const TEST_ENV = (entries) => ({ NODE_ENV: 'test', [TEST_ENV_VAR]: JSON.stringify(entries) });

/** Cria à mão uma instalação como o ToolInstaller deixa no disco. */
function fakeInstall(toolsDir, e) {
  const asset = e.assets[PLATFORM_KEY];
  const dir = path.join(toolsDir, e.id, e.version);
  const exe = path.join(dir, ...asset.exe.split('/'));
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, 'MZ-programa');
  const extras = {};
  for (const [name, rel] of Object.entries(asset.alsoExe || {})) { // programas extras do mesmo pacote (o ffprobe, junto do ffmpeg)
    extras[name] = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(extras[name]), { recursive: true });
    fs.writeFileSync(extras[name], 'MZ-extra');
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schema: 1, id: e.id, version: e.version, file: asset.name, sha256: asset.sha256, exe: asset.exe, ...(asset.alsoExe ? { alsoExe: asset.alsoExe } : {}),
    exeSize: Buffer.byteLength('MZ-programa'), installedAt: new Date().toISOString(), source: e.source
  }));
  return { dir, exe, extras };
}

// ------------------------------------------------------------------ chaves do ctx.tools

test('toolKeyFor: ffmpeg, ytdlp, whisper e twitchdownloader alimentam o ctx.tools (sem diferenciar maiúsculas); o ffprobe vem junto do ffmpeg, sem entrada própria', () => {
  assert.equal(toolKeyFor('ffmpeg'), 'ffmpeg');
  assert.equal(toolKeyFor('FFmpeg'), 'ffmpeg');
  assert.equal(toolKeyFor('ytdlp'), 'ytdlp');
  assert.equal(toolKeyFor('YTDLP'), 'ytdlp');
  assert.equal(toolKeyFor('whisper'), 'whisper');
  assert.equal(toolKeyFor('twitchdownloader'), 'twitchDownloader');
  assert.equal(toolKeyFor('TwitchDownloader'), 'twitchDownloader');
  for (const other of ['ffprobe', 'demo', '', null, undefined, 'constructor', '__proto__']) assert.equal(toolKeyFor(other), null, String(other));
});

// ------------------------------------------------------------------ entradas de teste

const BASE = { entries: [official('ytdlp'), official('whisper')], errors: [] };

test('sem BF_TEST_TOOL_ENTRIES: só as entradas oficiais, sem http local', () => {
  const cat = loadToolCatalog({ env: { NODE_ENV: 'test' }, isPackaged: false, base: BASE });
  assert.deepEqual(cat.entries.map((e) => e.id), ['ytdlp', 'whisper']);
  assert.deepEqual([cat.allowLoopbackHttp, cat.testIds], [false, []]);
  const empty = loadToolCatalog({ env: TEST_ENV([entry()]), isPackaged: false, base: { entries: [], errors: [] } });
  assert.equal(empty.entries.length, 1, 'com a variável, a entrada de teste entra mesmo com o registro vazio');
});

test('entradas de teste só valem com NODE_ENV=test E app não empacotado (produção as ignora por completo)', () => {
  const env = TEST_ENV([entry({ id: 'bftest' })]);
  assert.equal(testModeAllowed(env, false), true);
  const blocked = [
    ['app empacotado', env, true],
    ['isPackaged indefinido conta como empacotado', env, undefined],
    ['NODE_ENV=production', { ...env, NODE_ENV: 'production' }, false],
    ['NODE_ENV=development', { ...env, NODE_ENV: 'development' }, false],
    ['NODE_ENV ausente', { [TEST_ENV_VAR]: env[TEST_ENV_VAR] }, false],
    ['NODE_ENV=Test (maiúscula)', { ...env, NODE_ENV: 'Test' }, false]
  ];
  for (const [why, e, packaged] of blocked) {
    const cat = loadToolCatalog({ env: e, isPackaged: packaged, base: BASE });
    assert.deepEqual(cat.entries.map((x) => x.id), ['ytdlp', 'whisper'], why);
    assert.deepEqual([cat.allowLoopbackHttp, cat.testIds, cat.errors], [false, [], []], why);
  }
});

test('entrada de teste substitui a oficial de mesmo id, libera http local e vira testId', () => {
  const cat = loadToolCatalog({ env: TEST_ENV([entry({ id: 'Whisper' }), entry({ id: 'bftest' })]), isPackaged: false, base: BASE });
  assert.deepEqual(cat.entries.map((e) => e.id), ['ytdlp', 'Whisper', 'bftest']);
  assert.equal(cat.entries.find((e) => e.id === 'Whisper').assets[PLATFORM_KEY].url.startsWith('http://127.0.0.1'), true);
  assert.deepEqual(cat.testIds, ['whisper', 'bftest']);
  assert.equal(cat.allowLoopbackHttp, true);
  assert.deepEqual(cat.errors, []);
  // aceita uma entrada solta (sem lista)
  assert.equal(loadToolCatalog({ env: { NODE_ENV: 'test', [TEST_ENV_VAR]: JSON.stringify(entry()) }, isPackaged: false, base: BASE }).testIds.length, 1);
});

test('entradas de teste inválidas ou não locais são descartadas e explicadas', () => {
  const remote = entry({ id: 'remota', assets: { [PLATFORM_KEY]: { ...entry().assets[PLATFORM_KEY], url: 'https://exemplo.com/a.zip' } } });
  const remoteHttp = entry({ id: 'remotahttp', assets: { [PLATFORM_KEY]: { ...entry().assets[PLATFORM_KEY], url: 'http://exemplo.com/a.zip' } } });
  const broken = entry({ id: 'quebrada', version: '../x' });
  const cat = loadToolCatalog({ env: TEST_ENV([remote, remoteHttp, broken, entry({ id: 'boa' })]), isPackaged: false, base: BASE });
  assert.deepEqual(cat.entries.map((e) => e.id), ['ytdlp', 'whisper', 'boa']);
  assert.equal(cat.errors.length, 3);
  assert.match(cat.errors[0].message, /remota.*endereços locais/);
  assert.match(cat.errors[1].message, /remotahttp.*https/);
  assert.match(cat.errors[2].message, /quebrada.*version/);

  const badJson = loadToolCatalog({ env: { NODE_ENV: 'test', [TEST_ENV_VAR]: '{nao é json' }, isPackaged: false, base: BASE });
  assert.equal(badJson.entries.length, 2);
  assert.match(badJson.errors[0].message, /JSON inválido/);
  assert.deepEqual(parseTestEntries('[]'), { entries: [], errors: [] });
});

test('garantia: BF_TEST_TOOL_ENTRIES só é lida em src/core/tools/catalog.js (nada no main, preload, renderer ou outros módulos)', () => {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); } else if (e.name.endsWith('.js') || e.name.endsWith('.html')) {
        if (fs.readFileSync(full, 'utf8').includes(TEST_ENV_VAR)) hits.push(path.relative(ROOT, full).replace(/\\/g, '/'));
      }
    }
  };
  for (const dir of ['src', 'renderer']) walk(path.join(ROOT, dir));
  for (const file of ['main.js', 'preload.js']) if (fs.readFileSync(path.join(ROOT, file), 'utf8').includes(TEST_ENV_VAR)) hits.push(file);
  assert.deepEqual(hits, ['src/core/tools/catalog.js']);
});

// ------------------------------------------------------------------ resolveTools

test('resolveTools: a instalada pelo app vence CORTE_* e PATH (o ffprobe vem junto do ffmpeg); sem ela cai para a variável', () => {
  const base = tmpDir();
  try {
    const toolsDir = path.join(base, 'tools');
    const sys = {};
    for (const name of ['ytdlp', 'whisper', 'twitch', 'ffmpeg', 'ffprobe']) {
      sys[name] = path.join(base, `sistema-${name}.exe`);
      fs.writeFileSync(sys[name], 'sistema');
    }
    const env = {
      ...process.env,
      CORTE_YTDLP: sys.ytdlp, CORTE_WHISPER: sys.whisper, CORTE_TWITCHDOWNLOADER: sys.twitch, CORTE_FFMPEG: sys.ffmpeg, CORTE_FFPROBE: sys.ffprobe
    };
    const ffmpegEntry = entry({
      id: 'ffmpeg', label: 'FFmpeg (teste)',
      assets: { [PLATFORM_KEY]: { url: 'http://127.0.0.1:9/ffmpeg.zip', name: 'ffmpeg.zip', size: 10, sha256: SHA, exe: 'bin/ffmpeg.exe', alsoExe: { ffprobe: 'bin/ffprobe.exe' } } }
    });
    const entries = [official('ytdlp'), entry({ id: 'whisper' }), entry({ id: 'twitchdownloader' }), ffmpegEntry];
    const paths = { tools: toolsDir };

    // nada instalado: valem as variáveis de ambiente
    assert.deepEqual(resolveTools({ paths, env, entries }), {
      ffmpeg: sys.ffmpeg, ffprobe: sys.ffprobe, ytdlp: sys.ytdlp, whisper: sys.whisper, twitchDownloader: sys.twitch
    });

    // instala whisper e twitchdownloader (id em minúsculas -> chave twitchDownloader): o do app passa a valer
    const w = fakeInstall(toolsDir, entries[1]);
    const t = fakeInstall(toolsDir, entries[2]);
    const f = fakeInstall(toolsDir, ffmpegEntry); // ffmpeg do app: o ffprobe sai do mesmo pacote (alsoExe)
    const withApp = resolveTools({ paths, env, entries });
    assert.deepEqual([withApp.whisper, withApp.twitchDownloader, withApp.ytdlp], [w.exe, t.exe, sys.ytdlp]);
    assert.equal(withApp.ffmpeg, f.exe, 'o ffmpeg instalado pelo app vence CORTE_FFMPEG');
    assert.equal(withApp.ffprobe, f.extras.ffprobe, 'o ffprobe vem do mesmo pacote e vence CORTE_FFPROBE');

    // instalação adulterada (executável sumiu): não vale; volta para a variável de ambiente
    fs.rmSync(w.exe);
    assert.equal(resolveTools({ paths, env, entries }).whisper, sys.whisper);
    // sem o ffprobe a instalação inteira do ffmpeg não vale (os dois voltam para o sistema: nunca um de cada lugar)
    fs.rmSync(f.extras.ffprobe);
    const broken = resolveTools({ paths, env, entries });
    assert.deepEqual([broken.ffmpeg, broken.ffprobe], [sys.ffmpeg, sys.ffprobe]);

    // pasta de ferramentas vazia e CORTE_* vazia: nada do app, só o que existir no PATH desta máquina
    const bare = resolveTools({ paths: { tools: path.join(base, 'vazio') }, env: { ...env, CORTE_WHISPER: '', CORTE_TWITCHDOWNLOADER: '' }, entries });
    assert.notEqual(bare.whisper, w.exe);
    assert.equal(bare.ytdlp, sys.ytdlp);
  } finally { cleanup(base); }
});

test('resolveTools sem paths (chamada antiga) não quebra', () => {
  const r = resolveTools({ env: { ...process.env, CORTE_YTDLP: __filename } });
  assert.equal(r.ytdlp, __filename);
  assert.deepEqual(Object.keys(r).sort(), ['ffmpeg', 'ffprobe', 'twitchDownloader', 'whisper', 'ytdlp']);
});

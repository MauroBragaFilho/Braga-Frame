'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const registry = require('../src/core/tools/registry');
const { sha256, tmpDir, cleanup } = require('./tools-fixtures');

const SHA = sha256(Buffer.from('conteudo'));

function goodEntry(patch = {}) {
  return {
    id: 'demotool',
    label: 'Ferramenta de teste',
    version: '1.2.3',
    source: 'oficial: https://github.com/exemplo/projeto',
    assets: {
      'win32-x64': { url: 'https://github.com/exemplo/projeto/releases/download/1.2.3/demo-win.zip', name: 'demo-win.zip', size: 1234, sha256: SHA, exe: 'bin/demo.exe' }
    },
    ...patch
  };
}

function writeEntryFile(dir, name, entry) {
  fs.writeFileSync(path.join(dir, name), `'use strict';\nmodule.exports = ${JSON.stringify(entry, null, 2)};\n`);
}

/** Cria à mão uma instalação como o ToolInstaller deixa no disco. */
function fakeInstall(toolsDir, entry, { exeBytes = 'MZ-programa', manifest = {} } = {}) {
  const asset = entry.assets['win32-x64'];
  const dir = path.join(toolsDir, entry.id, entry.version);
  const exe = path.join(dir, ...asset.exe.split('/'));
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, exeBytes);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schema: 1, id: entry.id, version: entry.version, file: asset.name, sha256: asset.sha256, exe: asset.exe,
    exeSize: Buffer.byteLength(exeBytes), installedAt: new Date().toISOString(), source: entry.source, ...manifest
  }));
  return { dir, exe };
}

const WIN = { platform: 'win32', arch: 'x64' };

// ------------------------------------------------------------------ validação

test('entrada correta é válida; formato do contrato (3.7) aceito', () => {
  assert.deepEqual(registry.validateEntry(goodEntry()), []);
  assert.doesNotThrow(() => registry.assertValidEntry(goodEntry()));
  // arquivo único (ex.: yt-dlp.exe) e kind/stripComponents explícitos
  const single = goodEntry({ assets: { 'win32-x64': { url: 'https://github.com/x/y/releases/download/1/yt-dlp.exe', name: 'yt-dlp.exe', size: 10, sha256: SHA, exe: 'yt-dlp.exe' } } });
  assert.deepEqual(registry.validateEntry(single), []);
  const nested = goodEntry({ assets: { 'linux-x64': { url: 'https://github.com/x/y/a.tar.gz', name: 'a.tar.gz', size: 10, sha256: SHA, exe: 'bin/tool', stripComponents: 1, kind: 'tar.gz' } } });
  assert.deepEqual(registry.validateEntry(nested), []);
});

test('entrada inválida: cada defeito é apontado', () => {
  const bad = (patch, regex) => {
    const errs = registry.validateEntry(goodEntry(patch));
    assert.ok(errs.some((e) => regex.test(e)), `esperava erro ${regex} em ${JSON.stringify(errs)}`);
  };
  const asset = (patch) => ({ assets: { 'win32-x64': { ...goodEntry().assets['win32-x64'], ...patch } } });

  bad({ id: '../x' }, /id inválido/);
  bad({ id: '' }, /id inválido/);
  bad({ id: '1abc' }, /id inválido/);
  bad({ label: '' }, /label/);
  bad({ version: '../1' }, /version/);
  bad({ version: '1/2' }, /version/);
  bad({ source: '' }, /source/);
  bad({ assets: {} }, /assets/);
  bad({ assets: null }, /assets/);
  bad({ assets: { 'win95-x64': goodEntry().assets['win32-x64'] } }, /chave inválida/);
  bad(asset({ url: 'http://exemplo.com/a.zip' }), /https/);
  bad(asset({ url: 'ftp://exemplo.com/a.zip' }), /https/);
  bad(asset({ url: 'nao é url' }), /URL/);
  bad(asset({ url: undefined }), /url ausente/);
  bad(asset({ name: '../a.zip' }), /name/);
  bad(asset({ name: 'a/b.zip' }), /name/);
  bad(asset({ size: 0 }), /size/);
  bad(asset({ size: 1.5 }), /size/);
  bad(asset({ size: '10' }), /size/);
  bad(asset({ sha256: 'abc' }), /sha256/);
  bad(asset({ sha256: 'z'.repeat(64) }), /sha256/);
  bad(asset({ exe: '../fora.exe' }), /exe/);
  bad(asset({ exe: '/abs/fora.exe' }), /exe/);
  bad(asset({ exe: 'C:/fora.exe' }), /exe/);
  bad(asset({ exe: 'a\\b.exe' }), /exe/);
  bad(asset({ exe: '' }), /exe/);
  bad(asset({ kind: 'rar' }), /kind/);
  bad(asset({ stripComponents: -1 }), /stripComponents/);
  bad(asset({ stripComponents: 'um' }), /stripComponents/);
  // arquivo único: exe é só um nome e não há pasta externa para ignorar
  bad(asset({ name: 'tool.exe', exe: 'bin/tool.exe' }), /arquivo único/);
  bad(asset({ name: 'tool.exe', exe: 'tool.exe', stripComponents: 1 }), /arquivo único/);
  assert.deepEqual(registry.validateEntry(null), ['a entrada deve ser um objeto']);
  assert.deepEqual(registry.validateEntry([]), ['a entrada deve ser um objeto']);
  assert.throws(() => registry.assertValidEntry(goodEntry({ id: '' })), { code: 'INVALID_ENTRY' });
});

test('http só vale em loopback e só quando permitido (testes)', () => {
  const local = goodEntry({ assets: { 'win32-x64': { ...goodEntry().assets['win32-x64'], url: 'http://127.0.0.1:8080/a.zip' } } });
  assert.ok(registry.validateEntry(local).some((e) => /https/.test(e)));
  assert.deepEqual(registry.validateEntry(local, { allowLoopbackHttp: true }), []);
  const remote = goodEntry({ assets: { 'win32-x64': { ...goodEntry().assets['win32-x64'], url: 'http://exemplo.com/a.zip' } } });
  assert.ok(registry.validateEntry(remote, { allowLoopbackHttp: true }).some((e) => /https/.test(e)));
});

test('inferKind e assetFor: normaliza o pacote e escolhe por plataforma-arquitetura', () => {
  assert.equal(registry.inferKind('a.zip'), 'zip');
  assert.equal(registry.inferKind('A.TAR.GZ'), 'tar.gz');
  assert.equal(registry.inferKind('a.tgz'), 'tar.gz');
  assert.equal(registry.inferKind('yt-dlp.exe'), 'file');

  const entry = goodEntry({
    assets: {
      'win32-x64': { url: 'https://h/a.zip', name: 'a.zip', size: 1, sha256: SHA.toUpperCase(), exe: 'a.exe' },
      'linux-arm64': { url: 'https://h/b.tar.gz', name: 'b.tar.gz', size: 2, sha256: SHA, exe: 'b', stripComponents: 1 }
    }
  });
  const win = registry.assetFor(entry, 'win32', 'x64');
  assert.equal(win.kind, 'zip');
  assert.equal(win.sha256, SHA); // sempre em minúsculas
  assert.equal(win.stripComponents, 0);
  assert.equal(win.key, 'win32-x64');
  const linux = registry.assetFor(entry, 'linux', 'arm64');
  assert.equal(linux.kind, 'tar.gz');
  assert.equal(linux.stripComponents, 1);
  assert.equal(registry.assetFor(entry, 'darwin', 'arm64'), null);
  assert.equal(registry.assetFor(entry, 'win32', 'arm64'), null);
  assert.match(registry.unavailableReason(entry, 'darwin', 'arm64'), /macOS/);
  assert.match(registry.unavailableReason(entry, 'win32', 'ia32'), /Windows/);
});

// ------------------------------------------------------------------ carga das entradas

test('loadRegistry carrega entries/*.js, ignora "_" e README e descarta inválidas', () => {
  const dir = tmpDir();
  try {
    writeEntryFile(dir, 'demotool.js', goodEntry());
    writeEntryFile(dir, 'outra.js', goodEntry({ id: 'outra' }));
    writeEntryFile(dir, '_exemplo.js', goodEntry({ id: '_exemplo' }));
    fs.writeFileSync(path.join(dir, 'README.md'), '# nada');
    writeEntryFile(dir, 'quebrada.js', goodEntry({ id: 'quebrada', version: '' }));
    writeEntryFile(dir, 'nomeerrado.js', goodEntry({ id: 'outroid' }));
    writeEntryFile(dir, 'DemoTool2.js', goodEntry({ id: 'demotool' })); // id repetido (sem diferenciar maiúsculas) e arquivo com nome diferente
    fs.writeFileSync(path.join(dir, 'sintaxe.js'), 'module.exports = {{{');

    const { entries, errors } = registry.loadRegistry({ dir });
    assert.deepEqual(entries.map((e) => e.id).sort(), ['demotool', 'outra']);
    const byFile = Object.fromEntries(errors.map((e) => [e.file, e.message]));
    assert.match(byFile['quebrada.js'], /version/);
    assert.match(byFile['nomeerrado.js'], /nomeerrado\.js|id/);
    assert.ok(byFile['DemoTool2.js']);
    assert.ok(byFile['sintaxe.js']);
    assert.ok(!('_exemplo.js' in byFile));

    assert.throws(() => registry.loadRegistry({ dir, strict: true }), { code: 'INVALID_ENTRY' });
  } finally { cleanup(dir); }
});

test('loadRegistry com pasta inexistente devolve vazio; recarrega mudanças do disco', () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(registry.loadRegistry({ dir: path.join(dir, 'nao-existe') }), { entries: [], errors: [] });
    writeEntryFile(dir, 'demotool.js', goodEntry({ version: '1.0.0' }));
    assert.equal(registry.loadRegistry({ dir }).entries[0].version, '1.0.0');
    writeEntryFile(dir, 'demotool.js', goodEntry({ version: '2.0.0' }));
    assert.equal(registry.loadRegistry({ dir }).entries[0].version, '2.0.0');
  } finally { cleanup(dir); }
});

test('todas as entradas reais de src/core/tools/entries são válidas', () => {
  const { entries, errors } = registry.loadRegistry({ strict: false });
  assert.deepEqual(errors, [], `entradas inválidas: ${JSON.stringify(errors)}`);
  const ids = entries.map((e) => e.id.toLowerCase());
  assert.equal(new Set(ids).size, ids.length);
  assert.doesNotThrow(() => registry.loadRegistry({ strict: true }));
});

// ------------------------------------------------------------------ o que está instalado

test('resolveInstalled/status: instalação íntegra é reconhecida', () => {
  const toolsDir = tmpDir();
  try {
    const entry = goodEntry();
    const opts = { entries: [entry], ...WIN };
    assert.equal(registry.resolveInstalled(toolsDir, 'demotool', opts), null);
    assert.equal(registry.status(toolsDir, opts)[0].installed, false);

    const { exe } = fakeInstall(toolsDir, entry);
    assert.equal(registry.resolveInstalled(toolsDir, 'demotool', opts), exe);
    const [st] = registry.status(toolsDir, opts);
    assert.deepEqual(
      { id: st.id, label: st.label, version: st.version, installed: st.installed, path: st.path, available: st.available, source: st.source },
      { id: 'demotool', label: 'Ferramenta de teste', version: '1.2.3', installed: true, path: exe, available: true, source: entry.source }
    );
    assert.equal(st.installedVersion, '1.2.3');
    assert.equal(st.outdated, false);
    assert.equal(st.sizeBytes, 1234);
    assert.deepEqual(registry.resolveAll(toolsDir, opts), { demotool: exe });
    assert.equal(registry.resolveInstalled(toolsDir, 'desconhecida', opts), null);
  } finally { cleanup(toolsDir); }
});

test('resolveInstalled reconfere o disco: manifesto ou executável adulterado = não instalado', () => {
  const toolsDir = tmpDir();
  try {
    const entry = goodEntry();
    const opts = { entries: [entry], ...WIN };
    const { dir, exe } = fakeInstall(toolsDir, entry);
    const manifestFile = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const write = (m) => fs.writeFileSync(manifestFile, typeof m === 'string' ? m : JSON.stringify(m));
    const resolves = () => registry.resolveInstalled(toolsDir, 'demotool', opts);

    assert.equal(resolves(), exe);
    write({ ...manifest, sha256: 'a'.repeat(64) }); assert.equal(resolves(), null, 'sha256 do manifesto diferente da entrada');
    write({ ...manifest, version: '9.9.9' }); assert.equal(resolves(), null, 'versão diferente');
    write({ ...manifest, id: 'outra' }); assert.equal(resolves(), null, 'id diferente');
    write({ ...manifest, exe: 'outro.exe' }); assert.equal(resolves(), null, 'executável diferente');
    write({ ...manifest, schema: 99 }); assert.equal(resolves(), null, 'manifesto de outro formato');
    write('{ quebrado'); assert.equal(resolves(), null, 'manifesto corrompido');
    fs.rmSync(manifestFile); assert.equal(resolves(), null, 'sem manifesto');

    write(manifest); assert.equal(resolves(), exe);
    fs.writeFileSync(exe, 'truncado'); assert.equal(resolves(), null, 'tamanho do executável mudou');
    fs.rmSync(exe); assert.equal(resolves(), null, 'executável sumiu');
    fs.mkdirSync(exe); assert.equal(resolves(), null, 'executável virou pasta');
  } finally { cleanup(toolsDir); }
});

test('status: versão antiga instalada aparece como desatualizada; plataforma sem pacote fica indisponível', () => {
  const toolsDir = tmpDir();
  try {
    const old = goodEntry({ version: '1.0.0' });
    fakeInstall(toolsDir, old);
    const current = goodEntry({ version: '2.0.0' });
    const [st] = registry.status(toolsDir, { entries: [current], ...WIN });
    assert.equal(st.installed, false);
    assert.equal(st.path, null);
    assert.equal(st.installedVersion, '1.0.0');
    assert.equal(st.outdated, true);
    assert.equal(registry.resolveInstalled(toolsDir, 'demotool', { entries: [current], ...WIN }), null);

    const [mac] = registry.status(toolsDir, { entries: [current], platform: 'darwin', arch: 'arm64' });
    assert.equal(mac.available, false);
    assert.equal(mac.installed, false);
    assert.match(mac.unavailableReason, /macOS/);
    assert.equal(mac.sizeBytes, 0);
  } finally { cleanup(toolsDir); }
});

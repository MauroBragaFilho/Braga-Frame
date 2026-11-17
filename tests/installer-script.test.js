'use strict';

/** Partes puras de scripts/testar-instalador.js (o teste de verdade, que gera e instala o programa, é `npm run test:installer`). */

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../scripts/testar-instalador');

test('bumpPatch: soma 1 ao último número; versão fora de X.Y.Z é recusada', () => {
  assert.equal(T.bumpPatch('0.1.0'), '0.1.1');
  assert.equal(T.bumpPatch('1.2.9'), '1.2.10');
  for (const bad of ['1.2', 'v1.2.3', '1.2.3-beta', '', undefined]) assert.throws(() => T.bumpPatch(bad), /Versão inesperada/, String(bad));
});

test('installerFile: o instalador segue o padrão da Release (versão, sistema e arquitetura no nome) que o workflow de release também espera', () => {
  assert.equal(require('node:path').basename(T.installerFile(require('node:path').join('X:', 'saida'), '0.2.0')), 'braga-frame-0.2.0-windows-x64-setup.exe');
  const pkg = require('../package.json');
  assert.equal(pkg.build.nsis.artifactName, 'braga-frame-${version}-windows-${arch}-setup.${ext}', 'o artifactName do package.json é a fonte do padrão');
  const release = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.ok(release.includes('braga-frame-${VERSION}-windows-x64-setup.exe'), 'o workflow de release procura o mesmo nome');
});

test('nsisArgs: /S e /D= por último e sem aspas, mesmo com espaços no caminho', () => {
  assert.deepEqual(T.nsisArgs('C:\\Users\\Ana Maria\\inst'), ['/S', '/D=C:\\Users\\Ana Maria\\inst']);
  assert.equal(T.nsisArgs('X:\\a').at(-1).startsWith('/D='), true);
});

test('parseRegValue: lê o valor do `reg query`, com espaços, e devolve null se não existir', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Software\\X\r\n    DisplayName    REG_SZ    Braga Frame Teste\r\n    DisplayVersion    REG_SZ    0.1.1\r\n    EstimatedSize    REG_DWORD    0x1b58\r\n';
  assert.equal(T.parseRegValue(out, 'DisplayVersion'), '0.1.1');
  assert.equal(T.parseRegValue(out, 'DisplayName'), 'Braga Frame Teste');
  assert.equal(T.parseRegValue(out, 'EstimatedSize'), '0x1b58');
  assert.equal(T.parseRegValue(out, 'InstallLocation'), null);
  assert.equal(T.parseRegValue('', 'DisplayVersion'), null);
  assert.equal(T.parseRegValue(undefined, 'DisplayVersion'), null);
});

test('findUninstallKey: acha a chave pelo nome do programa; sem resultado (reg sai com 1) dá null', () => {
  const key = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{ABC-123}';
  const found = (args) => {
    assert.deepEqual(args.slice(0, 2), ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall']);
    assert.ok(args.includes('/s') && args.includes('/d') && args.includes('Braga Frame Teste'));
    return { status: 0, stdout: `\r\n${key}\r\n    DisplayName    REG_SZ    Braga Frame Teste\r\n\r\nEnd of search: 1 match(es) found.\r\n`, stderr: '' };
  };
  assert.equal(T.findUninstallKey('Braga Frame Teste', found), key);
  assert.equal(T.findUninstallKey('Braga Frame Teste', () => ({ status: 1, stdout: '', stderr: '' })), null);
  assert.equal(T.findUninstallKey('Braga Frame Teste', () => ({ status: 0, stdout: 'sem chave', stderr: '' })), null);
});

test('a identidade de teste nunca é a do app real (outro appId, nome e pacote)', () => {
  const pkg = require('../package.json');
  assert.notEqual(T.IDENT.appId, pkg.build.appId);
  assert.notEqual(T.IDENT.productName, pkg.build.productName);
  assert.notEqual(T.IDENT.name, pkg.name);
  assert.equal(Object.isFrozen(T.IDENT), true);
});

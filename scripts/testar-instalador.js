#!/usr/bin/env node
'use strict';

/**
 * Teste do instalador do Windows (Etapa 6): gera o instalador NSIS de duas versões, instala em silêncio, abre o programa INSTALADO,
 * instala a versão nova por cima (a atualização), confere que os dados do usuário sobreviveram, desinstala e confere que nada ficou.
 *
 *   npm run test:installer                 gera os dois instaladores (uns 2 a 4 minutos) e roda tudo
 *   npm run test:installer -- --reuse      reaproveita os instaladores já gerados na pasta de trabalho
 *   npm run test:installer -- --out <pasta> pasta de trabalho (padrão: %TEMP%\bf-instalador)
 *   npm run test:installer -- --keep       guarda os instaladores gerados no fim (para um próximo --reuse; o resto sempre é apagado)
 *
 * Ele usa uma IDENTIDADE PRÓPRIA ("Braga Frame Teste": outro appId, outro nome, outro atalho e outra chave no "Adicionar ou remover
 * programas"), então não encosta numa instalação real do Braga Frame nem nos atalhos dela. O código instalado é o mesmo do projeto: só a
 * identidade e o número da versão (a segunda é a primeira +0.0.1) mudam.
 *
 * O que NÃO prova: instalação em outra máquina que não esta (a CI roda numa máquina limpa do GitHub, uma segunda configuração, mas não há
 * VM com Windows 10, antivírus de terceiros, perfil sem permissão de escrita…), instalação para todos os usuários (o instalador é por
 * usuário), SmartScreen (só aparece com o instalador baixado da internet) e a atualização com o programa ABERTO.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const IDENT = Object.freeze({ appId: 'com.bragadev.bragaframe.instalador-teste', productName: 'Braga Frame Teste', name: 'braga-frame-teste' });
const UNINSTALL_ROOT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

/** Nome do instalador no padrão da Release (package.json, nsis.artifactName): versão, sistema e arquitetura no nome. */
function installerFile(outDir, version) {
  return path.join(outDir, `braga-frame-${version}-windows-x64-setup.exe`);
}

/** "0.1.0" -> "0.1.1". */
function bumpPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!m) throw new Error(`Versão inesperada: ${version} (esperado X.Y.Z).`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/**
 * Linha de comando do NSIS: `/S` (silencioso) e `/D=` (pasta; precisa ser o ÚLTIMO argumento, sem aspas, mesmo com espaços no caminho).
 * Por isso o processo é aberto com argumentos "verbatim": o Node não pode aspear o `/D=...`.
 */
function nsisArgs(installDir) {
  return ['/S', `/D=${installDir}`];
}

/** Valor de `name` na saída do `reg query` (texto "    Nome    REG_SZ    valor"); null se não houver. */
function parseRegValue(output, name) {
  const re = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*?)\\s*$`, 'mi');
  const m = re.exec(String(output || ''));
  return m ? m[1] : null;
}

/** Chave de desinstalação do app pelo nome que aparece em "Adicionar ou remover programas"; null se não houver. */
function findUninstallKey(productName, reg = regQuery) {
  const found = reg(['query', UNINSTALL_ROOT, '/s', '/f', productName, '/d']);
  if (found.status !== 0) return null;
  const line = String(found.stdout).split(/\r?\n/).find((l) => /^HKEY_CURRENT_USER\\.*\\Uninstall\\/i.test(l.trim()));
  return line ? line.trim() : null;
}

function regQuery(args) {
  const r = spawnSync('reg', args, { encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** As pastas de dados que um desinstalador configurado para apagar os dados removeria: %APPDATA%\<nome do programa> e %APPDATA%\<nome do pacote>. */
function defaultDataDirs(env = process.env) {
  return [path.join(env.APPDATA || '', IDENT.productName), path.join(env.APPDATA || '', IDENT.name)];
}

function startMenuShortcut(productName) {
  return path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${productName}.lnk`);
}

// ---------------------------------------------------------------------------------------------------------------------------------

const log = (message) => console.log(`✔ ${message}`);
const note = (message) => console.log(`  ${message}`);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

function build(version, outDir) {
  const cli = require.resolve('electron-builder/cli.js');
  const args = [cli, '--win', 'nsis', '--x64', '--publish', 'never',
    `-c.directories.output=${outDir}`, `-c.appId=${IDENT.appId}`, `-c.productName=${IDENT.productName}`, `-c.nsis.shortcutName=${IDENT.productName}`,
    `-c.extraMetadata.version=${version}`, `-c.extraMetadata.name=${IDENT.name}`];
  const started = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  if (r.status !== 0) throw new Error(`electron-builder falhou (versão ${version}):\n${String(r.stdout).slice(-1500)}\n${String(r.stderr).slice(-1500)}`);
  const file = installerFile(outDir, version);
  if (!fs.existsSync(file)) throw new Error(`O instalador esperado não foi gerado: ${file}`);
  note(`instalador ${version}: ${mb(fs.statSync(file).size)}, gerado em ${Math.round((Date.now() - started) / 1000)} s`);
  return file;
}

/** Roda o NSIS (instalador) sem janela e espera terminar. O arquivo é copiado para um nome sem espaços (o NSIS lê a linha de comando crua). */
function runInstaller(installer, installDir, work, label) {
  const plain = path.join(work, `setup-${label}.exe`);
  fs.copyFileSync(installer, plain);
  const r = spawnSync(plain, nsisArgs(installDir), { windowsVerbatimArguments: true, windowsHide: true, timeout: 5 * 60 * 1000 });
  if (r.status !== 0) throw new Error(`O instalador (${label}) saiu com código ${r.status}${r.error ? ` (${r.error.message})` : ''}.`);
}

/** Desinstala em silêncio e ESPERANDO: com `_?=<pasta>` o desinstalador não se copia para o TEMP e termina só depois de remover tudo. */
function runUninstaller(installDir) {
  const exe = path.join(installDir, `Uninstall ${IDENT.productName}.exe`);
  assert.ok(fs.existsSync(exe), 'o desinstalador existe na pasta de instalação');
  const r = spawnSync(exe, ['/S', `_?=${installDir}`], { windowsVerbatimArguments: true, windowsHide: true, timeout: 3 * 60 * 1000 });
  if (r.status !== 0) throw new Error(`O desinstalador saiu com código ${r.status}${r.error ? ` (${r.error.message})` : ''}.`);
}

function tryRemove(dir) {
  for (let i = 0; i < 6; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  }
}

async function main() {
  if (process.platform !== 'win32') { console.log('Teste do instalador: só no Windows (o instalador é NSIS). Nada a fazer aqui.'); return; }
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(name);
  const outIndex = argv.indexOf('--out');
  const work = path.resolve(outIndex >= 0 && argv[outIndex + 1] ? argv[outIndex + 1] : path.join(os.tmpdir(), 'bf-instalador'));
  const reuse = flag('--reuse');
  const keep = flag('--keep');

  const h = require('../tests/e2e/helpers');
  const { locateTools } = require('../src/core/ffmpeg/locate');
  const ffmpeg = locateTools().ffmpeg;
  assert.ok(ffmpeg, 'precisa do FFmpeg (no PATH ou em CORTE_FFMPEG) para gerar o vídeo de teste');

  const v1 = require('../package.json').version;
  const v2 = bumpPatch(v1);
  const installDir = path.join(work, 'instalado');
  const userData = path.join(work, 'dados');
  let installed = false;
  let app = null;
  const started = Date.now();

  fs.mkdirSync(work, { recursive: true });
  try {
    // segurança: se sobrou uma instalação de teste de uma execução interrompida, tira antes
    const stale = findUninstallKey(IDENT.productName);
    if (stale) {
      const leftover = parseRegValue(regQuery(['query', stale, '/v', 'InstallLocation']).stdout, 'InstallLocation');
      if (leftover && fs.existsSync(path.join(leftover, `Uninstall ${IDENT.productName}.exe`))) runUninstaller(leftover);
      regQuery(['delete', stale, '/f']);
    }
    tryRemove(installDir); tryRemove(userData);

    const out1 = path.join(work, 'build-v1');
    const out2 = path.join(work, 'build-v2');
    const file1 = installerFile(out1, v1);
    const file2 = installerFile(out2, v2);
    const installer1 = reuse && fs.existsSync(file1) ? file1 : build(v1, out1);
    const installer2 = reuse && fs.existsSync(file2) ? file2 : build(v2, out2);
    log(`instaladores gerados (${v1} e ${v2}), com a identidade de teste "${IDENT.productName}"`);

    const video = path.join(work, 'Aventura de teste.mp4');
    h.makeSampleVideo(ffmpeg, video, { seconds: 12, size: '640x360', rate: 15 });

    // ---- instalação limpa
    runInstaller(installer1, installDir, work, 'v1');
    installed = true;
    const exe = path.join(installDir, `${IDENT.productName}.exe`);
    // o que a distribuição precisa levar: programa, desinstalador, código empacotado e os avisos de licença (Electron, Chromium, fontes e o inventário)
    for (const rel of [`${IDENT.productName}.exe`, `Uninstall ${IDENT.productName}.exe`, path.join('resources', 'app.asar'), 'LICENSE.electron.txt', 'LICENSES.chromium.html',
      'THIRD-PARTY-NOTICES.md', 'LICENSE.bragaframe.txt', path.join('licenses', 'fonts', 'OFL-Inter.txt'), path.join('licenses', 'fonts', 'OFL-Montserrat.txt'),
      path.join('licenses', 'fonts', 'APACHE-MaterialSymbols.txt'), path.join('licenses', 'fonts', 'FONTES_ORIGEM.md')]) {
      assert.ok(fs.existsSync(path.join(installDir, rel)), `instalado: ${rel}`);
    }
    // a licença do app (GPL v3) acompanha o instalador, igual à do repositório
    const shipped = fs.readFileSync(path.join(installDir, 'LICENSE.bragaframe.txt'), 'utf8');
    assert.ok(shipped.includes('GNU GENERAL PUBLIC LICENSE') && shipped.includes('Version 3, 29 June 2007'), 'LICENSE.bragaframe.txt é o texto da GPL v3');
    assert.equal(shipped.replace(/\r\n/g, '\n'), fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n'), 'e é o mesmo do repositório');
    const key = findUninstallKey(IDENT.productName);
    assert.ok(key, 'o app aparece em "Adicionar ou remover programas"');
    assert.equal(parseRegValue(regQuery(['query', key, '/v', 'DisplayVersion']).stdout, 'DisplayVersion'), v1, 'a versão listada é a instalada');
    assert.ok(fs.existsSync(startMenuShortcut(IDENT.productName)), 'atalho no Menu Iniciar');
    log(`instalação limpa (${v1}): arquivos, avisos de licença (a GPL do app, Electron, Chromium, fontes e inventário), "Adicionar ou remover programas" e atalho do Menu Iniciar`);

    // ---- o programa instalado abre, mostra a versão e grava um projeto
    app = await h.launchApp(userData, { exe, timeout: 60000 });
    let info = await app.page.eval('BF.api("app:info")');
    assert.equal(info.version, v1, 'o programa instalado diz a versão instalada');
    assert.equal(info.loadErrors.length, 0, `nenhum módulo deixou de carregar: ${JSON.stringify(info.loadErrors)}`);
    await app.page.eval(`BF.openSource(${JSON.stringify(video)})`);
    await h.waitFor(app.page, 'BF.state.project && document.getElementById("video").readyState >= 1', 30000, 'vídeo aberto no programa instalado');
    await app.page.eval("BF.project.addCut({ title: 'Corte que precisa sobreviver', start: 2, end: 8, status: 'approved' })");
    await h.sleep(1500); // o projeto é salvo sozinho
    const projectsDir = info.projectsDir;
    assert.ok(projectsDir && projectsDir.startsWith(userData), `os dados ficam no perfil do usuário (${projectsDir})`);
    h.assertNoConsoleErrors(app.page, [/Autofill|favicon|MEDIA_ELEMENT_ERROR/i]);
    await app.stop(); app = null;
    const filesBefore = fs.readdirSync(projectsDir);
    assert.ok(filesBefore.length > 0, 'o projeto foi gravado em disco');
    log(`o programa instalado abre (${v1}), abre um vídeo e grava o projeto em ${path.relative(work, projectsDir)}`);

    // ---- atualização por cima
    runInstaller(installer2, installDir, work, 'v2');
    assert.equal(parseRegValue(regQuery(['query', key, '/v', 'DisplayVersion']).stdout, 'DisplayVersion'), v2, 'a versão listada passou para a nova');
    assert.equal(findUninstallKey(IDENT.productName), key, 'a mesma entrada foi atualizada (não duplicou)');
    app = await h.launchApp(userData, { exe, timeout: 60000 });
    info = await app.page.eval('BF.api("app:info")');
    assert.equal(info.version, v2, 'depois da atualização o programa diz a versão nova');
    assert.deepEqual(fs.readdirSync(projectsDir), filesBefore, 'os arquivos de projeto continuam os mesmos');
    await app.page.eval(`BF.openSource(${JSON.stringify(video)})`);
    await h.waitFor(app.page, 'BF.state.project && document.getElementById("video").readyState >= 1', 30000, 'vídeo reaberto na versão nova');
    const cuts = await app.page.eval('JSON.stringify(BF.state.project.cuts.map((c) => ({ t: c.title, s: c.status })))').then(JSON.parse);
    assert.deepEqual(cuts, [{ t: 'Corte que precisa sobreviver', s: 'approved' }], 'a versão nova lê o projeto da antiga, com o corte e a decisão');
    h.assertNoConsoleErrors(app.page, [/Autofill|favicon|MEDIA_ELEMENT_ERROR/i]);
    await app.stop(); app = null;
    log(`atualização ${v1} → ${v2} por cima: mesma entrada em "Adicionar ou remover programas", projeto e decisão preservados`);

    // ---- desinstalação
    // Os dados do teste ficam numa pasta própria (--user-data-dir), que nenhum desinstalador tocaria. Para provar `deleteAppDataOnUninstall: false`
    // de verdade, põe marcadores onde o desinstalador APAGARIA se a opção estivesse ligada: as pastas de dados padrão (nome do programa e do pacote).
    for (const dir of defaultDataDirs()) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'marcador.txt'), 'meus dados'); }
    runUninstaller(installDir);
    installed = false;
    for (const dir of defaultDataDirs()) {
      const marker = path.join(dir, 'marcador.txt');
      assert.ok(fs.existsSync(marker), `desinstalar apagou a pasta de dados padrão (${dir}): confira nsis.deleteAppDataOnUninstall no package.json, que deve ser false`);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'meus dados', `desinstalar não mexe nos dados (${dir})`);
    }
    assert.equal(findUninstallKey(IDENT.productName), null, 'sumiu de "Adicionar ou remover programas"');
    assert.ok(!fs.existsSync(startMenuShortcut(IDENT.productName)), 'atalho do Menu Iniciar removido');
    const left = fs.existsSync(installDir) ? fs.readdirSync(installDir).filter((n) => !/^Uninstall .*\.exe$/.test(n)) : [];
    assert.deepEqual(left, [], 'nada do programa sobrou na pasta de instalação (além do próprio desinstalador, que não se apaga com `_?=`)');
    assert.deepEqual(fs.readdirSync(projectsDir), filesBefore, 'desinstalar não apaga os projetos do usuário');
    log('desinstalação: entrada, atalho e arquivos removidos; os projetos do usuário ficam');

    console.log(`\nTESTE DO INSTALADOR OK (${Math.round((Date.now() - started) / 1000)} s)`);
  } finally {
    try { if (app) await app.stop(); } catch { /* já fechado */ }
    try { if (installed) runUninstaller(installDir); } catch (e) { console.error(`(não consegui desinstalar a instalação de teste: ${e.message})`); }
    try { await h.cleanupAll(); } catch { /* nada a limpar */ }
    for (const dir of defaultDataDirs()) tryRemove(dir); // os marcadores da desinstalação (a identidade de teste nunca tem dados de verdade)
    // os instaladores gerados só ficam com --keep/--reuse (para o próximo --reuse); o resto (instalação, dados, vídeo, cópias do instalador) sempre sai
    for (const name of ['instalado', 'dados', 'Aventura de teste.mp4', 'setup-v1.exe', 'setup-v2.exe']) tryRemove(path.join(work, name));
    if (!(keep || reuse)) tryRemove(work);
    else console.log(`(instaladores mantidos em ${work}; use --reuse para não gerar de novo)`);
  }
}

if (require.main === module) {
  main().then(() => process.exit(0), (err) => { console.error(`\n✖ TESTE DO INSTALADOR FALHOU: ${err.stack || err.message}`); process.exit(1); });
}

module.exports = { installerFile, bumpPatch, nsisArgs, parseRegValue, findUninstallKey, startMenuShortcut, defaultDataDirs, IDENT };

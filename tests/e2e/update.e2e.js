'use strict';

/**
 * E2E da atualização, no app Electron de verdade (perfil temporário) com um "GitHub" local (BF_TEST_UPDATE_API, que só vale com NODE_ENV=test e app não
 * empacotado; nesse modo o app não abre o navegador nem EXECUTA o instalador: só devolve o que executaria). O "instalador" baixado é um programa pequeno do
 * próprio Windows, para o PowerShell ler a assinatura DE VERDADE: a cópia é assinada (Valid), com 1 byte trocado vira um programa válido sem assinatura
 * (NotSigned), e bytes aleatórios não são um programa (assinatura inválida).
 *  - ao abrir, consulta UMA vez (só nome e versão do app) e baixa sozinho; a faixa vai de "Baixando…" a "pronta para instalar" com as 3 escolhas;
 *  - legível nos dois temas; o cartão Geral mostra o estado, a assinatura e os botões do momento;
 *  - "Instalar quando eu fechar" agenda e dá para desfazer; "Instalar e reiniciar" pede ao instalador --updated --force-run e mostra "Instalando…";
 *  - reabrir o app com a atualização já baixada: a faixa volta na hora e NADA é baixado de novo;
 *  - arquivo adulterado depois da conferência: recusa, descarta e não executa; assinatura inválida e SHA-256 que não bate: recusados com a causa e sem arquivo;
 *  - "baixar sozinho" desligado: só baixa quando o usuário pede; cancelar no meio não deixa nada; versão mais nova substitui a baixada;
 *  - o interruptor "avisar" desligado: abrir o app não consulta; erro do GitHub e "sem versões" viram texto.
 * Uso: node tests/e2e/update.e2e.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const h = require('./helpers');
const pkg = require('../../package.json');
const appInfo = require('../../src/appInfo');
const { CONTRAST, SMALL, NAMELESS } = require('./a11y');

const { waitFor, sleep } = h;
const step = (m) => console.log(`✔ ${m}`);
const j = JSON.stringify;
const PANEL = '#tabpanel-general';
const STARTUP_WAIT = 25000; // a consulta de abertura é agendada para ~4 s depois de a interface carregar
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const nameOf = (v) => `braga-frame-${v}-windows-x64-setup.exe`;

/** Três "instaladores" que o PowerShell classifica de verdade: assinado, válido sem assinatura, e lixo. */
function fixtures() {
  const original = fs.readFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'hostname.exe'));
  const peOffset = original.readUInt32LE(0x3c);
  const section = peOffset + 24 + original.readUInt16LE(peOffset + 20);
  const unsigned = Buffer.from(original);
  unsigned[original.readUInt32LE(section + 20) + original.readUInt32LE(section + 16) - 1] ^= 0x01; // 1 byte do corpo de uma seção: sai do catálogo da Microsoft
  return { signed: original, unsigned, junk: crypto.randomBytes(8000) };
}

/** "GitHub" local: a Release mais nova (mutável) e os arquivos dela; guarda cada pedido. */
function startFakeGithub() {
  const gh = { version: '9.0.0', files: new Map(), api: [], downloads: [], reply: null, slow: false, digestOverride: undefined };
  gh.publish = (version, buf) => { gh.files.set(version, buf); gh.version = version; };
  const server = http.createServer(async (req, res) => {
    if (req.url === `/repos/${appInfo.repo}/releases/latest`) {
      gh.api.push({ method: req.method, headers: req.headers });
      if (gh.reply) { res.writeHead(gh.reply.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(gh.reply.body)); return; }
      const buf = gh.files.get(gh.version);
      const asset = { name: nameOf(gh.version), size: buf.length, digest: gh.digestOverride || `sha256:${sha(buf)}`, browser_download_url: `${gh.base}/${appInfo.repo}/releases/download/v${gh.version}/${nameOf(gh.version)}` };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tag_name: `v${gh.version}`, html_url: `https://github.com/${appInfo.repo}/releases/tag/v${gh.version}`, draft: false, prerelease: false, published_at: '2026-11-17T12:00:00Z', assets: [asset] }));
      return;
    }
    const m = new RegExp(`^/${appInfo.repo}/releases/download/v([0-9.]+)/`).exec(req.url);
    if (m && gh.files.has(m[1])) {
      gh.downloads.push(req.url);
      const buf = gh.files.get(m[1]);
      res.writeHead(200, { 'Content-Length': buf.length });
      if (!gh.slow) { res.end(buf); return; }
      for (let i = 0; i < buf.length && !res.destroyed; i += 2048) { res.write(buf.subarray(i, i + 2048)); await sleep(110); }
      res.end();
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    gh.base = `http://127.0.0.1:${server.address().port}`;
    gh.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
    resolve(gh);
  }));
}

async function main() {
  const tmp = h.mkTemp('update-');
  const gh = await startFakeGithub();
  const fx = fixtures();
  const apps = [];
  try {
    gh.publish('9.0.0', fx.unsigned);
    const env = { NODE_ENV: 'test', BF_TEST_UPDATE_API: gh.base };
    const launch = async (name, extraEnv = {}) => { const a = await h.launchApp(path.join(tmp, name), { env: { ...env, ...extraEnv } }); apps.push(a); a.ud = path.join(tmp, name); a.updates = path.join(a.ud, 'updates'); return a; };
    const stop = async (a) => { await a.stop(); apps.splice(apps.indexOf(a), 1); };
    const banner = (page) => page.eval("(() => { const b = document.getElementById('updateNote'); return { hidden: b.hidden, text: b.textContent, buttons: [...b.querySelectorAll('button')].map((x) => x.dataset.act) }; })()");
    const waitBanner = (page, re, what, ms = 20000) => waitFor(page, `(() => { const b = document.getElementById('updateNote'); return !b.hidden && ${re}.test(b.textContent); })()`, ms, what);
    const waitReady = (page, ms = 20000) => waitBanner(page, '/pronta para instalar|será instalada quando/', 'faixa: atualização pronta', ms);
    const files = (a) => (fs.existsSync(a.updates) ? fs.readdirSync(a.updates).sort() : []);
    const state = (page) => page.eval("BF.api('app:updateState')");
    const selectGeneral = async (page) => { await page.eval("BF.ui.selectTab('general')"); await waitFor(page, `!!document.querySelector('${PANEL} [data-section="updates"]')`, 10000, 'cartão Atualizações'); };
    const card = (page) => page.eval(`(() => { const s = document.querySelector('${PANEL} [data-section="updates"]'); const vis = (sel) => !s.querySelector(sel).hidden; return { text: s.querySelector('.gen-update-status').textContent, sub: s.querySelector('.gen-update-sub').hidden ? '' : s.querySelector('.gen-update-sub').textContent, kind: s.querySelector('.gen-update-status').dataset.kind, on: s.querySelector('#genUpdateSwitch').checked, auto: s.querySelector('#genUpdateAutoSwitch').checked, show: { download: vis('[data-act="download-update"]'), install: vis('[data-act="install-update"]'), quit: vis('[data-act="install-update-quit"]'), cancel: vis('[data-act="cancel-update"]'), open: vis('[data-act="open-update"]') }, checkDisabled: s.querySelector('[data-act="check-update"]').disabled }; })()`);
    const click = (page, sel) => page.eval(`document.querySelector(${j(sel)}).click()`);

    // ---- 1) ao abrir: uma consulta (só nome e versão), baixa sozinho e a faixa vai de "Baixando…" a "pronta para instalar"
    gh.slow = true;
    let a = await launch('ud1');
    let page = a.page;
    assert.equal((await banner(page)).hidden, true, 'a faixa começa escondida (a consulta é depois da abertura)');
    await waitBanner(page, '/Baixando a versão 9\\.0\\.0… \\d+%/', 'faixa: baixando', STARTUP_WAIT);
    assert.deepEqual((await banner(page)).buttons, ['update-cancel']);
    await waitReady(page);
    gh.slow = false;
    assert.equal(gh.api.length, 1, 'uma única consulta ao abrir');
    assert.equal(gh.downloads.length, 1, 'um único download');
    const req = gh.api[0];
    assert.equal(req.method, 'GET');
    assert.equal(req.headers['user-agent'], `BragaFrame/${pkg.version} (verificacao-de-versao)`);
    assert.equal(req.headers.authorization, undefined, 'sem credenciais');
    const b1 = await banner(page);
    assert.match(b1.text, /Versão 9\.0\.0 pronta para instalar \(seus projetos continuam como estão\)\./);
    assert.deepEqual(b1.buttons, ['update-install-now', 'update-install-quit', 'update-dismiss']);
    assert.deepEqual(files(a), [nameOf('9.0.0'), 'pending.json'], 'só o instalador e o pending.json');
    assert.equal(sha(fs.readFileSync(path.join(a.updates, nameOf('9.0.0')))), sha(fx.unsigned), 'o arquivo é idêntico ao da Release');
    const s1 = await state(page);
    assert.deepEqual([s1.phase, s1.ready.version, s1.ready.sha256], ['ready', '9.0.0', sha(fx.unsigned)]);
    assert.match(s1.ready.signature.text, /Sem assinatura digital.*SHA-256/);
    step('ao abrir: uma consulta (só nome e versão do app), baixa sozinho e a faixa vai de "Baixando…" a "pronta para instalar" com 3 escolhas; o arquivo é idêntico ao da Release');

    // ---- 2) legível nos dois temas
    for (const theme of ['dark', 'light']) {
      await page.eval(`BF.ui.setTheme(${j(theme)})`);
      await sleep(250);
      assert.deepEqual(JSON.parse(await page.eval(SMALL)), [], `${theme}: alvos de 24 px`);
      assert.deepEqual(JSON.parse(await page.eval(NAMELESS)), [], `${theme}: controles com nome`);
      assert.deepEqual(JSON.parse(await page.eval(CONTRAST)), [], `${theme}: contraste`);
    }
    await page.eval("BF.ui.setTheme('dark')");
    step('a faixa pronta é legível nos dois temas (contraste, alvos de 24 px, nomes acessíveis)');

    // ---- 3) o cartão Geral no estado "pronta"
    await selectGeneral(page);
    const c1 = await card(page);
    assert.match(c1.text, /A versão 9\.0\.0 está pronta e verificada \(tamanho e SHA-256 conferidos\)\./);
    assert.match(c1.sub, /Sem assinatura digital/);
    assert.deepEqual([c1.on, c1.auto, c1.show], [true, true, { download: false, install: true, quit: true, cancel: false, open: true }]);
    assert.equal(c1.kind, 'info');
    step('Geral > Atualizações: estado "pronta", a assinatura em palavras e só os botões do momento (instalar, instalar ao fechar, ver novidades)');

    // ---- 4) "Instalar quando eu fechar": agenda e dá para desfazer
    await click(page, '#updateNote [data-act="update-install-quit"]');
    await waitBanner(page, '/será instalada quando você fechar o Braga Frame/', 'faixa: agendada');
    assert.deepEqual((await banner(page)).buttons, ['update-install-now', 'update-install-none']);
    assert.equal((await state(page)).installOnQuit, true);
    assert.match((await card(page)).sub, /Será instalada quando você fechar/);
    await click(page, '#updateNote [data-act="update-install-none"]');
    await waitBanner(page, '/pronta para instalar/', 'faixa: desagendada');
    assert.equal((await state(page)).installOnQuit, false);
    step('"Instalar quando eu fechar" agenda (a faixa e o cartão dizem) e "Não instalar ao fechar" desfaz');

    // ---- 5) reabrir com a atualização já baixada: a faixa volta na hora e NADA é baixado de novo
    await stop(a);
    const downloadsBefore = gh.downloads.length;
    const apiBefore = gh.api.length;
    a = await launch('ud1');
    page = a.page;
    await waitReady(page, 8000); // vem do disco (pending.json), antes da consulta de abertura (~4 s)
    assert.equal(gh.api.length, apiBefore, 'a faixa já estava lá antes de qualquer consulta');
    const t0 = Date.now();
    while (gh.api.length === apiBefore && Date.now() - t0 < STARTUP_WAIT) await sleep(100);
    assert.equal(gh.api.length, apiBefore + 1, 'a consulta de abertura acontece');
    await sleep(800);
    assert.equal(gh.downloads.length, downloadsBefore, 'já estava baixada e verificada: nada é baixado de novo');
    assert.deepEqual(files(a), [nameOf('9.0.0'), 'pending.json']);
    step('reabrir o app: a atualização já baixada volta pronta (a faixa aparece antes de qualquer consulta) e nada é baixado de novo');

    // ---- 6) "Instalar e reiniciar": pede o instalador em silêncio com --updated --force-run (no teste só devolve o que executaria)
    await page.eval("window.__install = null; const orig = BF.api; BF.api = async (c, p, o) => { const r = await orig(c, p, o); if (c === 'app:updateInstall') window.__install = r; return r; }; true");
    await click(page, '#updateNote [data-act="update-install-now"]');
    await waitBanner(page, '/Instalando a versão 9\\.0\\.0… o Braga Frame vai reiniciar/', 'faixa: instalando');
    assert.deepEqual((await banner(page)).buttons, [], 'instalando: nada a clicar');
    const res = await page.eval('window.__install');
    assert.deepEqual([res.ok, res.installing, res.test], [true, true, { executed: false, args: ['/S', '--updated', '--force-run'] }]);
    h.assertNoConsoleErrors(page);
    await stop(a);
    step('"Instalar e reiniciar": o instalador seria aberto com /S --updated --force-run e a faixa passa a "Instalando…"');

    // ---- 7) arquivo adulterado depois da conferência: recusa, descarta e não executa
    a = await launch('ud2');
    page = a.page;
    await page.eval('BF.update.check({ force: true })');
    await waitReady(page);
    const bytes = fs.readFileSync(path.join(a.updates, nameOf('9.0.0')));
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(path.join(a.updates, nameOf('9.0.0')), bytes);
    await page.eval("window.__install = null; const orig = BF.api; BF.api = async (c, p, o) => { const r = await orig(c, p, o); if (c === 'app:updateInstall') window.__install = r; return r; }; true");
    await click(page, '#updateNote [data-act="update-install-now"]');
    await waitFor(page, 'window.__install !== null', 10000, 'resposta do instalar');
    const bad = await page.eval('window.__install');
    assert.deepEqual([bad.ok, bad.code], [false, 'TAMPERED']);
    await waitFor(page, "/mudou depois de ser conferido/.test(document.getElementById('toasts').textContent)", 5000, 'aviso de adulteração');
    assert.deepEqual(files(a), [], 'arquivo descartado');
    assert.equal((await state(page)).phase, 'idle');
    await stop(a);
    step('arquivo adulterado depois da conferência: recusa com a causa, descarta e NÃO executa o instalador');

    // ---- 8) assinatura: válida é aceita e dita; inválida (lixo) é recusada com a causa e sem arquivo; SHA-256 errado também
    gh.publish('9.0.1', fx.signed);
    a = await launch('ud3');
    page = a.page;
    await page.eval('BF.update.check({ force: true })');
    await waitReady(page);
    assert.match((await state(page)).ready.signature.text, /^Assinatura digital válida \(Microsoft Windows\)\.$/);
    await selectGeneral(page);
    assert.match((await card(page)).sub, /Assinatura digital válida \(Microsoft Windows\)\./);
    await stop(a);

    gh.publish('9.0.2', fx.junk);
    a = await launch('ud4');
    page = a.page;
    await page.eval('BF.update.check({ force: true })');
    await waitFor(page, "BF.update.state.error && BF.update.state.error.code === 'INVALID_SIGNATURE'", 20000, 'assinatura inválida recusada');
    await selectGeneral(page);
    const c4 = await card(page);
    assert.match(c4.text, /assinatura digital do instalador é inválida\. Nada foi instalado\./);
    assert.equal(c4.kind, 'warn');
    assert.equal((await banner(page)).hidden, true, 'erro não vira faixa');
    assert.deepEqual(files(a), [], 'nada fica no disco');
    await stop(a);

    gh.publish('9.0.3', fx.unsigned);
    gh.digestOverride = `sha256:${'0'.repeat(64)}`;
    a = await launch('ud5');
    page = a.page;
    await page.eval('BF.update.check({ force: true })');
    await waitFor(page, "BF.update.state.error && BF.update.state.error.code === 'HASH'", 20000, 'SHA-256 recusado');
    await selectGeneral(page);
    assert.match((await card(page)).text, /SHA-256 do arquivo baixado não confere com o da Release\. Nada foi instalado\./);
    assert.deepEqual(files(a), []);
    gh.digestOverride = undefined;
    await stop(a);
    step('assinatura válida aceita e dita ("Microsoft Windows"); assinatura inválida e SHA-256 que não bate recusados com a causa no cartão, sem faixa e sem arquivo');

    // ---- 9) "baixar sozinho" desligado, cancelar no meio, versão mais nova
    gh.publish('9.1.0', fx.unsigned);
    a = await launch('ud6');
    page = a.page;
    await page.eval("window.localStorage.setItem('bf.updateAutoDownload', '0'); true");
    const downloads9 = gh.downloads.length;
    await page.eval('BF.update.check({ force: true })');
    await waitBanner(page, '/Nova versão 9\\.1\\.0 do Braga Frame disponível/', 'faixa: disponível');
    assert.deepEqual((await banner(page)).buttons, ['update-download', 'update-open', 'update-dismiss']);
    await sleep(600);
    assert.equal(gh.downloads.length, downloads9, 'com "baixar sozinho" desligado nada é baixado até o usuário pedir');
    gh.slow = true;
    await click(page, '#updateNote [data-act="update-download"]');
    await waitBanner(page, '/Baixando a versão 9\\.1\\.0/', 'faixa: baixando');
    await sleep(400);
    await click(page, '#updateNote [data-act="update-cancel"]');
    await waitBanner(page, '/Nova versão 9\\.1\\.0 do Braga Frame disponível/', 'faixa: voltou a disponível');
    assert.deepEqual(files(a), [], 'cancelar no meio não deixa nada (nem .part)');
    assert.equal((await state(page)).error, null, 'cancelar não é erro');
    gh.slow = false;
    await click(page, '#updateNote [data-act="update-download"]');
    await waitReady(page);
    assert.match((await banner(page)).text, /9\.1\.0/);
    // uma versão MAIS NOVA que a baixada: a antiga sai na hora (com "baixar sozinho" desligado a nova só vem quando o usuário pede), depois a nova entra
    gh.publish('9.2.0', fx.unsigned);
    await page.eval('BF.update.check({ force: true })');
    await waitFor(page, "BF.update.state.ready === null && BF.update.state.phase === 'idle'", 20000, 'a 9.1.0 baixada ficou velha e saiu');
    assert.deepEqual(files(a), [], 'a antiga foi apagada do disco');
    await waitBanner(page, '/Nova versão 9\\.2\\.0 do Braga Frame disponível/', 'faixa: a 9.2.0 disponível');
    await click(page, '#updateNote [data-act="update-download"]');
    await waitFor(page, "BF.update.state.ready && BF.update.state.ready.version === '9.2.0'", 20000, 'a 9.2.0 baixada no lugar da 9.1.0');
    assert.deepEqual(files(a), [nameOf('9.2.0'), 'pending.json'], 'só a nova fica no disco');
    h.assertNoConsoleErrors(page);
    await stop(a);
    step('"baixar sozinho" desligado só baixa quando o usuário pede; cancelar no meio não deixa nada; uma versão mais nova substitui a baixada');

    // ---- 10) erro do GitHub, "sem versões", "na mais recente": texto no cartão, nunca faixa
    a = await launch('ud7');
    page = a.page;
    await selectGeneral(page);
    const text = () => page.eval(`document.querySelector('${PANEL} .gen-update-status').textContent`);
    gh.reply = { status: 500, body: {} };
    await click(page, `${PANEL} [data-act="check-update"]`);
    await waitFor(page, `/GitHub respondeu com um erro/.test(document.querySelector('${PANEL} .gen-update-status').textContent)`, 10000, 'erro do GitHub');
    assert.equal((await card(page)).kind, 'warn');
    gh.reply = { status: 404, body: { message: 'Not Found' } };
    await click(page, `${PANEL} [data-act="check-update"]`);
    await waitFor(page, `/ainda não publicou nenhuma versão/.test(document.querySelector('${PANEL} .gen-update-status').textContent)`, 10000, 'sem versões');
    gh.reply = null;
    gh.publish(pkg.version, fx.unsigned);
    await click(page, `${PANEL} [data-act="check-update"]`);
    await waitFor(page, `/versão mais recente/.test(document.querySelector('${PANEL} .gen-update-status').textContent)`, 10000, 'na mais recente');
    assert.match(await text(), new RegExp(`\\(${pkg.version.replace(/\./g, '\\.')}\\)`));
    assert.equal((await banner(page)).hidden, true);
    h.assertNoConsoleErrors(page);
    step('erro do GitHub, "sem versões publicadas" e "na versão mais recente" viram texto no cartão (sem faixa nem erro de console)');

    // ---- 11) o interruptor "avisar" desligado: abrir o app não consulta (a atualização já baixada continua no cartão)
    gh.publish('9.3.0', fx.unsigned);
    await page.eval(`(() => { const sw = document.querySelector('${PANEL} #genUpdateSwitch'); sw.checked = false; sw.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    assert.equal(await page.eval("window.localStorage.getItem('bf.updateCheck')"), '0');
    assert.equal((await card(page)).on, false);
    await stop(a);
    const countOff = gh.api.length;
    a = await launch('ud7');
    page = a.page;
    await sleep(7000); // bem mais que os ~4 s da consulta de abertura
    assert.equal(gh.api.length, countOff, 'com o aviso desligado, abrir o app não consulta o GitHub');
    assert.equal((await banner(page)).hidden, true);
    await selectGeneral(page);
    await click(page, `${PANEL} [data-act="check-update"]`);
    await waitFor(page, `/Nova versão 9\\.3\\.0 disponível/.test(document.querySelector('${PANEL} .gen-update-status').textContent)`, 10000, 'resultado do "Verificar agora"');
    assert.equal((await banner(page)).hidden, true, 'desligado, nem o "Verificar agora" levanta a faixa');
    assert.equal(gh.downloads.filter((u) => u.includes('9.3.0')).length, 0, 'e nada é baixado sozinho');
    h.assertNoConsoleErrors(page);
    step('aviso desligado: abrir o app não consulta e a faixa não aparece; "Verificar agora" mostra o resultado no cartão e nada é baixado sozinho');

    console.log('\nE2E DA ATUALIZAÇÃO OK');
  } finally {
    for (const x of apps) { try { await x.stop(); } catch { /* já fechado */ } }
    await h.cleanupAll();
    await gh.close();
    h.removeDir(tmp);
  }
}

main().then(() => process.exit(0), (err) => { console.error(`\n✖ E2E FALHOU: ${err.stack || err.message}`); h.cleanupAll().finally(() => process.exit(1)); });

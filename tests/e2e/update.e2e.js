'use strict';

/**
 * E2E do aviso de versão nova, no app Electron de verdade (perfil temporário) com um "GitHub" local (BF_TEST_UPDATE_API, que só vale com NODE_ENV=test e app
 * não empacotado; nesse modo o app também não abre o navegador da máquina):
 *  - ao abrir, alguns segundos depois, o app consulta UMA vez e mostra a faixa "Nova versão X"; a consulta leva só o nome e a versão do app;
 *  - a faixa é legível (contraste, alvos de 24 px, nome acessível) nos dois temas;
 *  - "Ver e baixar" pede ao main a página da Release (nada abre de verdade); "Agora não" esconde ESTA versão, mesmo depois de reabrir o app;
 *  - Configurações > Geral > Atualizações: resultado em palavras, "Verificar agora" sempre consulta, o interruptor desliga o aviso (reabrir não consulta);
 *  - versão mais nova que a dispensada avisa de novo; erro do GitHub e "sem versões publicadas" viram texto, nunca faixa;
 * (Dentro de outro aplicativo, o BDS, o app não consulta nem mostra o cartão: isso está nos testes unitários update-ipc e general-ui.)
 * Uso: node tests/e2e/update.e2e.js
 */
const assert = require('node:assert/strict');
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
const STARTUP_WAIT = 20000; // a consulta de abertura é agendada para ~4 s depois de a interface carregar

const releaseJson = (tag) => ({
  tag_name: tag, html_url: `https://github.com/${appInfo.repo}/releases/tag/${tag}`, draft: false, prerelease: false, published_at: '2026-11-17T12:00:00Z',
  assets: [{ name: `braga-frame-${tag.slice(1)}-windows-x64-setup.exe`, size: 114356807 }]
});

/** "GitHub" local: responde a /repos/<repo>/releases/latest com o que o teste mandar e guarda cada pedido. */
function startFakeGithub() {
  const state = { reply: { status: 200, body: releaseJson('v9.0.0') }, requests: [] };
  const server = http.createServer((req, res) => {
    state.requests.push({ url: req.url, method: req.method, headers: req.headers });
    if (req.url === `/repos/${appInfo.repo}/releases/latest`) {
      res.writeHead(state.reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.reply.body));
    } else { res.writeHead(404); res.end('{}'); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

async function main() {
  const tmp = h.mkTemp('update-');
  const gh = await startFakeGithub();
  const apps = [];
  try {
    const userData = path.join(tmp, 'ud');
    const env = { NODE_ENV: 'test', BF_TEST_UPDATE_API: gh.base };
    const launch = async (extraEnv = {}, ud = userData) => { const a = await h.launchApp(ud, { env: { ...env, ...extraEnv } }); apps.push(a); return a; };
    const banner = (page) => page.eval("(() => { const b = document.getElementById('updateNote'); return { hidden: b.hidden, text: b.textContent, buttons: [...b.querySelectorAll('button')].map((x) => x.dataset.act + ':' + x.textContent) }; })()");
    const stop = async (a) => { await a.stop(); apps.splice(apps.indexOf(a), 1); };
    const selectGeneral = async (page) => { await page.eval("BF.ui.selectTab('general')"); await waitFor(page, `!!document.querySelector('${PANEL} [data-section="updates"]')`, 10000, 'cartão Atualizações'); };

    // ---- ao abrir: uma consulta, só com o nome e a versão do app, e a faixa
    let app = await launch();
    let page = app.page;
    assert.equal((await banner(page)).hidden, true, 'a faixa começa escondida (a consulta é depois da abertura)');
    await waitFor(page, "!document.getElementById('updateNote').hidden", STARTUP_WAIT, 'faixa de versão nova');
    assert.equal(gh.state.requests.length, 1, 'uma única consulta ao abrir');
    const req = gh.state.requests[0];
    assert.equal(req.method, 'GET');
    assert.equal(req.headers['user-agent'], `BragaFrame/${pkg.version} (verificacao-de-versao)`);
    assert.equal(req.headers.authorization, undefined, 'sem credenciais');
    assert.equal(req.headers.cookie, undefined);
    const b1 = await banner(page);
    assert.match(b1.text, /Nova versão 9\.0\.0 do Braga Frame disponível \(você usa a /);
    assert.match(b1.text, /seus projetos continuam como estão/);
    assert.deepEqual(b1.buttons, ['update-open:Ver e baixar', 'update-dismiss:Agora não']);
    step('ao abrir consulta uma vez (só nome e versão do app, sem credenciais) e mostra a faixa "Nova versão 9.0.0"');

    // ---- legível nos dois temas
    for (const theme of ['dark', 'light']) {
      await page.eval(`BF.ui.setTheme(${j(theme)})`);
      await sleep(250);
      assert.deepEqual(JSON.parse(await page.eval(SMALL)), [], `${theme}: alvos de 24 px`);
      assert.deepEqual(JSON.parse(await page.eval(NAMELESS)), [], `${theme}: controles com nome`);
      assert.deepEqual(JSON.parse(await page.eval(CONTRAST)), [], `${theme}: contraste da faixa e da tela`);
    }
    await page.eval("BF.ui.setTheme('dark')");
    step('a faixa é legível nos dois temas (contraste, alvos de 24 px, nomes acessíveis)');

    // ---- "Ver e baixar": o main devolve a página da Release (no modo de teste não abre o navegador)
    const opened = await page.eval("BF.api('app:updateOpen', { url: 'https://evil.example/' })");
    assert.deepEqual([opened.ok, opened.opened, opened.url], [true, false, `https://github.com/${appInfo.repo}/releases/tag/v9.0.0`], 'o main usa o endereço que ele mesmo conferiu; o pedido não escolhe a URL');
    await page.eval("document.querySelector('#updateNote [data-act=\"update-open\"]').click()");
    await sleep(300);
    assert.doesNotMatch(await page.eval("document.getElementById('toasts').textContent"), /Não há versão nova|erro/i, 'clicar não dá erro');
    step('"Ver e baixar" abre a página da Release que o main conferiu (a URL do renderer é ignorada)');

    // ---- Configurações > Geral > Atualizações
    await selectGeneral(page);
    const card = () => page.eval(`(() => { const s = document.querySelector('${PANEL} [data-section="updates"]'); return { text: s.querySelector('.gen-update-status').textContent, kind: s.querySelector('.gen-update-status').dataset.kind, on: s.querySelector('#genUpdateSwitch').checked, openHidden: s.querySelector('[data-act="open-update"]').hidden, checkDisabled: s.querySelector('[data-act="check-update"]').disabled }; })()`);
    const c1 = await card();
    assert.deepEqual([c1.text, c1.kind, c1.on, c1.openHidden], [`Nova versão 9.0.0 disponível (você usa a ${pkg.version}).`, 'info', true, false]);
    const before = gh.state.requests.length;
    await page.eval(`document.querySelector('${PANEL} [data-act="check-update"]').click()`);
    await waitUntilRequests(gh, before + 1);
    assert.equal(gh.state.requests.length, before + 1, '"Verificar agora" sempre consulta (não usa a consulta guardada)');
    await page.eval(`document.querySelector('${PANEL} [data-act="open-update"]').click()`);
    step('Geral > Atualizações mostra o resultado, "Verificar agora" consulta de verdade e "Ver e baixar" fica à mão');

    // ---- "Agora não" vale para esta versão, mesmo reabrindo o app
    await page.eval("document.querySelector('#updateNote [data-act=\"update-dismiss\"]').click()");
    assert.equal((await banner(page)).hidden, true);
    assert.equal(await page.eval("window.localStorage.getItem('bf.updateDismissed')"), '9.0.0');
    await stop(app);
    const requestsBeforeReopen = gh.state.requests.length;
    app = await launch();
    page = app.page;
    await waitUntilRequests(gh, requestsBeforeReopen + 1, STARTUP_WAIT);
    await sleep(500);
    assert.equal((await banner(page)).hidden, true, 'a 9.0.0 já foi dispensada: não volta a cada abertura');
    await selectGeneral(page);
    assert.equal((await card()).openHidden, false, 'mas o cartão ainda deixa baixar quem quiser');
    step('"Agora não" esconde a 9.0.0 mesmo depois de reabrir; o cartão continua oferecendo');

    // ---- versão mais nova avisa de novo
    gh.state.reply = { status: 200, body: releaseJson('v9.1.0') };
    await page.eval(`document.querySelector('${PANEL} [data-act="check-update"]').click()`);
    await waitFor(page, "!document.getElementById('updateNote').hidden", 10000, 'faixa da 9.1.0');
    assert.match((await banner(page)).text, /Nova versão 9\.1\.0/);
    step('uma versão mais nova que a dispensada (9.1.0) avisa de novo');

    // ---- erro e "sem versões": texto no cartão, nunca faixa
    gh.state.reply = { status: 500, body: {} };
    await page.eval(`document.querySelector('${PANEL} [data-act="check-update"]').click()`);
    await waitFor(page, `/GitHub respondeu com um erro/.test(document.querySelector('${PANEL} .gen-update-status').textContent)`, 10000, 'erro do GitHub');
    assert.equal((await card()).kind, 'warn');
    assert.equal((await card()).openHidden, true, 'com erro não há o que baixar');
    gh.state.reply = { status: 404, body: { message: 'Not Found' } };
    await page.eval(`document.querySelector('${PANEL} [data-act="check-update"]').click()`);
    await waitFor(page, `/ainda não publicou nenhuma versão/.test(document.querySelector('${PANEL} .gen-update-status').textContent)`, 10000, 'sem versões publicadas');
    gh.state.reply = { status: 200, body: releaseJson(`v${pkg.version}`) };
    await page.eval(`document.querySelector('${PANEL} [data-act="check-update"]').click()`);
    await waitFor(page, `/versão mais recente/.test(document.querySelector('${PANEL} .gen-update-status').textContent)`, 10000, 'na versão mais recente');
    assert.equal((await card()).kind, 'ok');
    step('erro do GitHub, "sem versões publicadas" e "na versão mais recente" viram texto no cartão (sem faixa nem erro de console)');

    // ---- o interruptor: desligado, abrir o app não consulta
    gh.state.reply = { status: 200, body: releaseJson('v9.2.0') };
    await page.eval(`(() => { const sw = document.querySelector('${PANEL} #genUpdateSwitch'); sw.checked = false; sw.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    assert.equal(await page.eval("window.localStorage.getItem('bf.updateCheck')"), '0');
    h.assertNoConsoleErrors(page);
    await stop(app);
    const countOff = gh.state.requests.length;
    app = await launch();
    page = app.page;
    await sleep(8000); // bem mais que os ~4 s da consulta de abertura
    assert.equal(gh.state.requests.length, countOff, 'com o aviso desligado, abrir o app não consulta o GitHub');
    assert.equal((await banner(page)).hidden, true);
    await selectGeneral(page);
    assert.equal((await card()).on, false, 'o interruptor continua desligado');
    await page.eval(`document.querySelector('${PANEL} [data-act="check-update"]').click()`);
    await waitUntilRequests(gh, countOff + 1);
    assert.equal((await banner(page)).hidden, true, 'desligado, nem o "Verificar agora" levanta a faixa');
    assert.match((await card()).text, /Nova versão 9\.2\.0/, 'mas o cartão mostra o resultado de quem pediu');
    // ligar de novo traz o aviso da versão ainda não dispensada
    await page.eval(`(() => { const sw = document.querySelector('${PANEL} #genUpdateSwitch'); sw.checked = true; sw.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(page, "!document.getElementById('updateNote').hidden", 10000, 'faixa depois de religar');
    h.assertNoConsoleErrors(page);
    await stop(app);
    step('interruptor desligado: abrir o app não consulta e a faixa não aparece; ligar de novo traz o aviso');

    console.log('\nE2E DO AVISO DE ATUALIZAÇÃO OK');
  } finally {
    for (const a of apps) { try { await a.stop(); } catch { /* já fechado */ } }
    await h.cleanupAll();
    await gh.close();
    h.removeDir(tmp);
  }
}

/** Espera o servidor local ter recebido pelo menos `n` pedidos. */
async function waitUntilRequests(gh, n, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (gh.state.requests.length >= n) return;
    await sleep(100);
  }
  throw new Error(`o servidor local esperava ${n} pedido(s) e recebeu ${gh.state.requests.length}`);
}

main().then(() => process.exit(0), (err) => { console.error(`\n✖ E2E FALHOU: ${err.stack || err.message}`); h.cleanupAll().finally(() => process.exit(1)); });

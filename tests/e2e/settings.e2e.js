'use strict';

/**
 * E2E da tela Geral de Configurações (primeira aba do item Configurações do menu), no app Electron de verdade (perfil temporário):
 *  - Configurações abre pela Geral, com Preferências e Ferramentas ao lado; só o que o app tem (sem idioma, notificações, envio de dados nem links);
 *  - Aparência: Escuro e Claro trocam o tema de verdade (e o botão do rodapé do menu acompanha), cada opção mostra uma janelinha no tema dela;
 *  - Pasta de projetos: o caminho real da pasta do perfil e "Mostrar na pasta" (aqui interceptado: não abre o Explorer);
 *  - Suporte: "Copiar informações" gera o relatório (versão, sistema, placa de vídeo, codificação) sem o nome de usuário e "Mostrar o registro" aponta o arquivo;
 *  - Sobre: nome, versão e frase do app; janela estreita (uma coluna); dentro do Braga Digital Studio o tema é dele e as opções ficam desabilitadas.
 * Uso: node tests/e2e/settings.e2e.js     (BF_E2E_SHOTDIR=C:\pasta guarda capturas da janela)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./helpers');
const appInfo = require('../../src/appInfo');
const pkg = require('../../package.json');

const { waitFor, sleep } = h;
const step = (m) => console.log(`✔ ${m}`);

async function main() {
  const tmp = h.mkTemp('settings-');
  const shotDir = process.env.BF_E2E_SHOTDIR;
  let app = null;
  try {
    const userData = path.join(tmp, 'ud');
    app = await h.launchApp(userData, {});
    const { page } = app;
    const ev = (x) => page.eval(x);
    const shot = async (name) => { if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); await sleep(400); await h.screenshot(page, path.join(shotDir, `${name}.png`)); } };
    const themes = () => ev("JSON.stringify([...document.querySelectorAll('#tabpanel-general .gen-theme')].map((b) => [b.dataset.theme, b.getAttribute('aria-checked'), b.disabled]))").then(JSON.parse);

    // ---- Configurações abre pela Geral
    await ev("document.getElementById('tab-settings').click()");
    assert.deepEqual(await ev("[document.getElementById('app').dataset.activeTab, document.getElementById('app').dataset.activeMenu, document.getElementById('pageTitle').textContent]"), ['general', 'settings', 'Configurações']);
    assert.deepEqual(await ev("[...document.querySelectorAll('#subTabs .subtabs:not([hidden]) .subtab-label')].map((n) => n.textContent)"), ['Geral', 'Preferências', 'Ferramentas']);
    assert.deepEqual(await ev("[...document.querySelectorAll('#tabpanel-general .gen-card h3')].map((n) => n.textContent)"), ['Aparência', 'Pasta de projetos', 'Atualizações', 'Agentes de IA (MCP)', 'Suporte', 'Sobre']);
    const text = await ev("document.getElementById('tabpanel-general').textContent");
    for (const missing of ['Idioma', 'Notificações', 'Salvar automaticamente', 'Enviar dados', 'Discord', 'github.com', 'Chat de suporte', 'Atualização automática']) assert.ok(!text.includes(missing), `"${missing}" não existe no app`);
    assert.equal(await ev("document.querySelectorAll('#tabpanel-general a').length"), 0, 'sem links');
    await shot('settings-geral');
    step('Configurações abre pela Geral (Geral · Preferências · Ferramentas) e mostra só Aparência, Pasta de projetos, Atualizações, Agentes de IA (MCP), Suporte e Sobre');

    // ---- Aparência
    assert.deepEqual(await themes(), [['dark', 'true', false], ['light', 'false', false]]);
    const looks = await ev("JSON.stringify([...document.querySelectorAll('#tabpanel-general .gen-swatch')].map((s) => [s.dataset.theme, getComputedStyle(s).backgroundColor, Math.round(s.getBoundingClientRect().width), Math.round(s.getBoundingClientRect().height)]))").then(JSON.parse);
    assert.deepEqual(looks, [['dark', 'rgb(0, 0, 0)', 112, 68], ['light', 'rgb(244, 244, 244)', 112, 68]], 'cada opção mostra uma janelinha no tema dela');
    await ev("document.querySelector('#tabpanel-general .gen-theme[data-theme=light]').click()");
    await sleep(400);
    assert.deepEqual(await ev("[document.documentElement.getAttribute('data-theme'), window.localStorage.getItem('bf.theme'), document.getElementById('btnTheme').getAttribute('aria-label')]"), ['light', 'light', 'Usar tema escuro'], 'o tema trocou de verdade e o botão do menu acompanha');
    assert.deepEqual(await themes(), [['dark', 'false', false], ['light', 'true', false]]);
    const chosen = await ev("getComputedStyle(document.querySelector('#tabpanel-general .gen-theme[aria-checked=true]')).borderTopColor");
    const other = await ev("getComputedStyle(document.querySelector('#tabpanel-general .gen-theme[aria-checked=false]')).borderTopColor");
    assert.notEqual(chosen, other, 'a opção em uso tem o contorno de destaque');
    await shot('settings-geral-claro');
    // o botão do rodapé do menu também troca, e a tela acompanha
    await ev("document.getElementById('btnTheme').click()");
    await sleep(300);
    assert.deepEqual(await themes(), [['dark', 'true', false], ['light', 'false', false]], 'a tela acompanha o botão do menu');
    step('Aparência: Escuro e Claro trocam o tema de verdade, cada opção mostra o tema dela e a tela acompanha o botão do menu');

    // ---- Pasta de projetos (o Explorer não é aberto: o pedido é interceptado)
    await ev("window.__reveals = []; const orig = BF.api; BF.api = (channel, payload, opts) => (channel === 'shell:reveal' ? (window.__reveals.push(payload), Promise.resolve({ ok: true })) : orig(channel, payload, opts)); true");
    const folder = await ev("document.querySelector('#tabpanel-general .gen-path').value");
    assert.equal(path.resolve(folder).toLowerCase(), path.resolve(userData, 'projects').toLowerCase(), 'o caminho real da pasta de projetos do perfil');
    assert.equal(fs.existsSync(folder), true, 'a pasta existe');
    assert.equal(await ev("document.querySelector('#tabpanel-general .gen-path').readOnly"), true);
    assert.equal(await ev("document.querySelectorAll('#tabpanel-general .gen-folder button').length"), 1, 'sem "Alterar": o app não troca a pasta');
    await ev("document.querySelector('#tabpanel-general [data-act=reveal]').click()");
    assert.deepEqual(await ev('window.__reveals'), [{ path: folder }], '"Mostrar na pasta" pede para mostrar a pasta de projetos');
    step('Pasta de projetos: o caminho real do perfil, somente leitura, e "Mostrar na pasta" a revela');

    // ---- Suporte: o relatório vem do app de verdade (o Explorer continua interceptado)
    await ev("window.__toasts = []; const toast = BF.ui.toast; BF.ui.toast = (message, kind) => { window.__toasts.push([message, kind]); return toast(message, kind); }; true");
    await ev("document.querySelector('#tabpanel-general [data-act=copy-support]').click()");
    await waitFor(page, 'window.__toasts.length > 0', 30000, 'aviso de "informações copiadas"');
    const copied = await ev("(async () => { try { return await navigator.clipboard.readText(); } catch (e) { return null; } })()");
    const shown = await ev("(() => { const t = document.querySelector('#tabpanel-general .gen-report'); return t.hidden ? null : t.value; })()");
    const report = String(copied || shown || '').replace(/\r\n/g, '\n'); // a área de transferência do Windows devolve \r\n
    assert.ok(report, 'o relatório foi para a área de transferência ou ficou à vista, selecionado, para copiar à mão');
    assert.match(report, new RegExp(`^${appInfo.name} ${pkg.version.replace(/\./g, '\\.')}`), 'começa pelo nome e a versão');
    assert.match(report, /Electron .* Chromium/);
    assert.match(report, /Placas de vídeo:\n {2}\S/, 'lista a placa de vídeo');
    assert.doesNotMatch(report, /não informadas pelo sistema/, 'a fachada do app deixa o relatório pedir a placa de vídeo de verdade (antes o texto de reserva escondia a falta)');
    assert.match(report, /Codificação: H\.264 por software: (sim|não)/, 'diz o que o FFmpeg codifica');
    assert.match(report, /Registro: ~.*bragaframe\.log/, 'aponta o arquivo de registro, com a pasta pessoal como ~');
    assert.ok(!report.toLowerCase().includes(os.userInfo().username.toLowerCase()), 'o nome de usuário do Windows não vai no relatório');
    assert.ok(!/sk-|api[_-]?key|authorization/i.test(report), 'nenhuma chave ou segredo no relatório');
    await ev("document.querySelector('#tabpanel-general [data-act=show-log]').click()");
    await waitFor(page, "window.__reveals.some((r) => /bragaframe\\.log$/.test(r.path))", 15000, 'registro mostrado na pasta');
    assert.equal(fs.existsSync(await ev("window.__reveals.filter((r) => /bragaframe\\.log$/.test(r.path)).pop().path")), true, '"Mostrar o registro" aponta um arquivo que existe');
    assert.equal(await ev("document.querySelectorAll('#tabpanel-general [data-section=support] button').length"), 2, 'só dois botões: copiar e mostrar o registro');
    step(`Suporte: "Copiar informações" gera o relatório (${copied ? 'na área de transferência' : 'à vista, para copiar à mão'}) sem o nome de usuário nem segredos, e "Mostrar o registro" aponta o arquivo`);

    // ---- Sobre
    assert.deepEqual(await ev("JSON.stringify([document.querySelector('.gen-about-name').textContent, document.querySelector('.gen-about-version').textContent, document.querySelector('.gen-about-tagline').textContent, document.querySelector('.gen-credit').textContent])").then(JSON.parse),
      [appInfo.name, `Versão ${pkg.version}`, appInfo.tagline, 'Desenvolvido por Braga Dev']);
    assert.equal(await ev("document.querySelector('.gen-license').textContent"), 'Software livre: licença GPL v3 ou posterior, sem garantia. O texto da licença acompanha o instalador.');
    assert.equal(pkg.license, 'GPL-3.0-or-later', 'o package.json declara a mesma licença que o app mostra');
    assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', 'LICENSE'), 'utf8').includes('GNU GENERAL PUBLIC LICENSE'), 'o LICENSE é o texto da GPL');
    const sides = await ev("(() => { const a = document.querySelector('.gen-about').getBoundingClientRect(); const m = document.querySelector('.gen-main').getBoundingClientRect(); return { right: a.left >= m.right - 1, sameTop: Math.abs(a.top - m.top) < 2, w: Math.round(a.width) }; })()").then((r) => r);
    assert.deepEqual(sides, { right: true, sameTop: true, w: 280 }, 'o Sobre fica ao lado, em coluna de 280 px');
    step('Sobre: nome, versão e frase do app, e o crédito, ao lado dos outros cartões');

    // ---- janela estreita: uma coluna
    const narrow = await page.send('Emulation.setDeviceMetricsOverride', { width: 880, height: 700, deviceScaleFactor: 1, mobile: false });
    assert.ok(!narrow.error, `Emulation.setDeviceMetricsOverride: ${narrow.error && narrow.error.message}`);
    try {
      await sleep(500);
      const fit = await ev("(() => { const a = document.querySelector('.gen-about').getBoundingClientRect(); const m = document.querySelector('.gen-main').getBoundingClientRect(); return { stacked: a.top >= m.bottom - 1, hScroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth, sameLeft: Math.abs(a.left - m.left) < 2 }; })()");
      assert.deepEqual(fit, { stacked: true, hScroll: true, sameLeft: true }, 'na janela estreita o Sobre desce para baixo dos cartões');
      await shot('settings-janela-estreita');
    } finally {
      await page.send('Emulation.clearDeviceMetricsOverride');
    }
    h.assertNoConsoleErrors(page, [/Autofill|favicon/i]);
    step('janela estreita: uma coluna só, sem rolagem lateral');

    // ---- dentro do Braga Digital Studio o tema é dele
    const baseUrl = (await ev('location.href')).split(/[?#]/)[0];
    await ev('window.__marker = 1; true');
    await page.send('Page.navigate', { url: `${baseUrl}?embedded=1&themeLocked=1` });
    await waitFor(page, "window.__marker === undefined && document.readyState === 'complete' && !!window.BF", 30000, 'página recarregada no modo embutido');
    await ev('BF.ready.then(() => true)');
    await ev('BF.ui.selectTab("general")');
    assert.equal(await ev("[...document.querySelectorAll('#tabpanel-general .gen-theme')].every((b) => b.disabled)"), true, 'com o tema do hospedeiro as opções ficam desabilitadas');
    assert.equal(await ev("document.querySelector('#tabpanel-general [data-section=appearance] .gen-note').hidden"), false);
    step('dentro do Braga Digital Studio (tema bloqueado) as opções de aparência ficam desabilitadas, com o motivo');

    await app.stop(); app = null;
    console.log('\nE2E DA TELA GERAL OK');
  } finally {
    try { if (app) await app.stop(); } catch { /* já fechado */ }
    h.removeDir(tmp);
  }
}

main().then(() => process.exit(0), (err) => { console.error(`\n✖ E2E FALHOU: ${err.stack || err.message}`); h.cleanupAll().finally(() => process.exit(1)); });

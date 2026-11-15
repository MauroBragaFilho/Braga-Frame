'use strict';

/**
 * E2E do Editor de Cortes (item Cortes do menu), no app Electron de verdade (perfil temporário, vídeo gerado):
 *  - o cabeçalho mostra "Projetos › nome do projeto" e o estado (Novo, Em revisão, Pronto para exportar, Exportado), que acompanha as decisões;
 *    "Projetos" volta à lista; o botão "Exportar" é a ação principal e abre a aba Exportar ("Abrir vídeo" fica de contorno); fora do editor nada disso aparece;
 *  - cada corte da lista tem a miniatura (um quadro do vídeo, pedido só às linhas à vista), à esquerda do título; redesenhar a lista não a perde;
 *  - janela estreita (o cabeçalho cabe sem rolar) e tema claro.
 * Uso: node tests/e2e/editor.e2e.js     (BF_E2E_SHOTDIR=C:\pasta guarda capturas da janela)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { locateTools } = require('../../src/core/ffmpeg/locate');
const h = require('./helpers');

const ffmpeg = locateTools().ffmpeg;
const { waitFor, sleep } = h;
const step = (m) => console.log(`✔ ${m}`);
const j = JSON.stringify;

async function main() {
  const tmp = h.mkTemp('editor-');
  const shotDir = process.env.BF_E2E_SHOTDIR;
  let app = null;
  try {
    const video = path.join(tmp, 'NFS Most Wanted - Gameplay.mp4');
    h.makeSampleVideo(ffmpeg, video, { seconds: 20, size: '1280x720', rate: 15 });
    app = await h.launchApp(path.join(tmp, 'ud'), {});
    const { page } = app;
    const ev = (x) => page.eval(x);
    const shot = async (name) => { if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); await sleep(400); await h.screenshot(page, path.join(shotDir, `${name}.png`)); } };
    const header = () => ev(`(() => {
      const vis = (id) => { const n = document.getElementById(id); const r = n.getBoundingClientRect(); return !n.hidden && r.width > 0 && r.height > 0; };
      const open = document.getElementById('btnOpen');
      return JSON.stringify({
        crumbs: vis('crumbs'), name: document.getElementById('crumbName').textContent, state: document.getElementById('crumbState').hidden ? '' : document.getElementById('crumbState').textContent,
        exportButton: vis('btnExport'), openPrimary: open.classList.contains('primary'), openSecondary: open.classList.contains('secondary'),
        title: document.getElementById('pageTitle').textContent, titleW: Math.round(document.getElementById('pageTitle').getBoundingClientRect().width),
        path: vis('sourceName')
      });
    })()`).then(JSON.parse);
    const click = (id) => ev(`document.getElementById(${j(id)}).click()`);

    // ---- fora do editor o cabeçalho é o de sempre
    let head = await header();
    assert.equal(head.crumbs, false, 'sem projeto não há "Projetos › nome"');
    assert.equal(head.exportButton, false);
    assert.deepEqual([head.openPrimary, head.openSecondary], [true, false], '"Abrir vídeo" é a ação principal da Início');
    assert.equal(head.title, 'Início');
    step('fora do editor: sem "Projetos › nome" e sem "Exportar"; "Abrir vídeo" segue como ação principal');

    // ---- abre um vídeo com 3 cortes
    await ev(`BF.openSource(${j(video)})`);
    await waitFor(page, "BF.state.project && document.getElementById('video').readyState >= 1", 30000, 'vídeo aberto');
    for (const [title, start, end, status] of [['Perseguição policial', 2, 9, 'pending'], ['Pulo épico', 4, 12, 'pending'], ['Fuga no último segundo', 8, 17, 'approved']]) {
      await ev(`BF.project.addCut({ title: ${j(title)}, start: ${start}, end: ${end}, status: ${j(status)} })`);
    }
    assert.equal((await ev('BF.state.project.cuts.length')), 3);
    await click('tab-editor');
    await waitFor(page, "document.getElementById('app').dataset.activeMenu === 'editor'", 10000, 'item Cortes aberto');
    head = await header();
    assert.equal(head.crumbs, true, 'o editor mostra "Projetos › nome"');
    assert.equal(head.name, 'NFS Most Wanted - Gameplay', 'o nome do projeto (o do arquivo, sem a extensão)');
    assert.equal(head.state, 'Em revisão', 'há cortes pendentes');
    assert.equal(await ev("document.getElementById('crumbState').className"), 'bds-chip crumb-state bds-chip-info');
    assert.equal(await ev("document.getElementById('crumbName').title"), video, 'o caminho do arquivo fica na dica');
    assert.equal(await ev("document.querySelector('#crumbBack').textContent"), 'chevron_leftProjetos');
    assert.deepEqual([head.exportButton, head.openPrimary, head.openSecondary], [true, false, true], '"Exportar" é a ação principal e "Abrir vídeo" fica de contorno');
    assert.equal(await ev("document.querySelectorAll('.header-actions .primary:not([hidden])').length"), 1, 'uma ação principal só no cabeçalho');
    assert.equal(head.path, false, 'o caminho do arquivo deu lugar a "Projetos › nome"');
    assert.deepEqual([head.title, head.titleW], ['Cortes', 1], 'o título continua para o leitor de tela, sem ocupar lugar');
    await shot('editor-cabecalho');
    step('Cortes: o cabeçalho mostra "Projetos › nome do projeto" e o estado "Em revisão"; "Exportar" é a ação principal e "Abrir vídeo" fica de contorno');

    // ---- o estado acompanha as decisões
    await ev("BF.project.cut(BF.state.project.cuts[0].id) && true");
    const decide = (status) => ev(`(() => { for (const c of BF.state.project.cuts) { if (c.status === 'pending') BF.review.engine.setStatus(c.id, ${j(status)}); } return true; })()`);
    await decide('approved');
    await waitFor(page, "document.getElementById('crumbState').textContent === 'Pronto para exportar'", 10000, 'estado Pronto para exportar');
    assert.equal(await ev("document.getElementById('crumbState').className"), 'bds-chip crumb-state bds-chip-warn');
    await ev("(() => { const c = BF.state.project.cuts[0]; BF.review.engine.setStatus(c.id, 'pending'); return true; })()");
    await waitFor(page, "document.getElementById('crumbState').textContent === 'Em revisão'", 10000, 'volta para Em revisão');
    step('o estado do cabeçalho acompanha as decisões (Em revisão → Pronto para exportar → Em revisão)');

    // ---- miniaturas
    await waitFor(page, "document.querySelectorAll('#tabpanel-cuts .cut-thumb img').length === 3 && [...document.querySelectorAll('#tabpanel-cuts .cut-thumb img')].every((i) => i.complete && i.naturalWidth > 0)", 40000, 'as 3 miniaturas dos cortes');
    const layout = await ev(`JSON.stringify([...document.querySelectorAll('#tabpanel-cuts li.cut')].map((li) => {
      const t = li.querySelector('.cut-thumb').getBoundingClientRect(); const title = li.querySelector('.cut-title').getBoundingClientRect(); const act = li.querySelector('.actions').getBoundingClientRect();
      const img = li.querySelector('.cut-thumb img');
      return { thumbW: Math.round(t.width), thumbH: Math.round(t.height), left: t.right <= title.left + 1, above: t.top <= title.top + 1, actionsBelow: act.top >= t.bottom - 1, img: [img.naturalWidth > 0, img.naturalWidth <= 192] };
    }))`).then(JSON.parse);
    assert.equal(layout.length, 3);
    for (const l of layout) assert.deepEqual(l, { thumbW: 96, thumbH: 54, left: true, above: true, actionsBelow: true, img: [true, true] }, 'miniatura de 96×54 à esquerda do título, ações embaixo');
    // tema do perfil e palavras-chave da análise por IA (guardados no corte quando a sugestão vira corte) aparecem como indicadores da linha
    await ev("BF.project.addCut({ title: 'Com etiquetas', start: 10, end: 20, theme: 'Piadas', keywords: ['susto', 'corredor'] }) && true");
    await waitFor(page, "document.querySelectorAll('#tabpanel-cuts li.cut .chip.theme').length === 1", 10000, 'o indicador do tema');
    assert.equal(await ev("document.querySelector('#tabpanel-cuts li.cut .chip.theme').textContent"), 'Tema: Piadas');
    assert.deepEqual(await ev("[...document.querySelectorAll('#tabpanel-cuts li.cut .chip.keyword')].map((n) => n.textContent)"), ['#susto', '#corredor']);
    await ev("BF.review.engine.remove(BF.state.project.cuts.find((c) => c.title === 'Com etiquetas').id) && true");
    // redesenhar a lista (uma decisão) não perde a imagem nem pede de novo
    const before = await ev("document.querySelectorAll('#tabpanel-cuts .cut-thumb img').length");
    await ev("document.querySelector('#tabpanel-cuts li.cut .act-approve').click()");
    assert.equal(await ev("document.querySelectorAll('#tabpanel-cuts .cut-thumb img').length"), before, 'a lista redesenhada já nasce com as miniaturas');
    await shot('editor-lista');
    step('cada corte tem a miniatura (96×54, à esquerda do título, um quadro do vídeo) e o redesenho da lista a mantém');

    // ---- "Projetos" volta à lista; "Exportar" abre a aba Exportar
    await click('crumbBack');
    assert.deepEqual(await ev("[document.getElementById('app').dataset.activeTab, document.getElementById('app').dataset.activeMenu]"), ['projects', 'projects']);
    head = await header();
    assert.deepEqual([head.crumbs, head.exportButton, head.openPrimary], [false, false, true], 'na lista de projetos o cabeçalho é o de sempre');
    await click('tab-editor');
    await click('btnExport');
    assert.deepEqual(await ev("[document.getElementById('app').dataset.activeTab, document.getElementById('app').dataset.activeMenu]"), ['export', 'editor']);
    head = await header();
    assert.deepEqual([head.crumbs, head.exportButton, head.openPrimary], [true, false, true], 'já na aba Exportar o atalho some (a ação é a da própria aba)');
    await click('tab-cuts');
    step('"Projetos" volta à lista; "Exportar" abre a aba Exportar e o atalho some quando já se está nela');

    // ---- janela estreita e tema claro
    const narrow = await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 640, deviceScaleFactor: 1, mobile: false });
    assert.ok(!narrow.error, `Emulation.setDeviceMetricsOverride: ${narrow.error && narrow.error.message}`);
    try {
      await waitFor(page, "Math.round(document.querySelector('.sidebar').getBoundingClientRect().width) === 64", 10000, 'menu em trilho de 64 px (depois da transição do shell)');
      await sleep(300);
      const fit = await ev(`(() => { const hd = document.getElementById('globalHeader'); const last = document.querySelector('.header-actions').getBoundingClientRect(); const crumbs = document.getElementById('crumbs').getBoundingClientRect(); return { hScroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth, headerOverflow: hd.scrollWidth > hd.clientWidth, crumbsLeftOfActions: crumbs.right <= last.left + 1, crumbVisible: crumbs.width > 80, nameW: Math.round(document.getElementById('crumbName').getBoundingClientRect().width) >= 80 }; })()`);
      assert.deepEqual(fit, { hScroll: true, headerOverflow: false, crumbsLeftOfActions: true, crumbVisible: true, nameW: true }, 'na janela mínima o cabeçalho cabe e o nome do projeto continua legível (a mensagem de estado encolhe antes)');
      await shot('editor-janela-minima');
    } finally {
      await page.send('Emulation.clearDeviceMetricsOverride');
    }
    await sleep(300);
    await ev("BF.ui.setTheme('light')");
    await sleep(300);
    const light = await ev(`(() => { const s = getComputedStyle(document.getElementById('btnExport')); return [s.backgroundColor, s.color]; })()`);
    assert.deepEqual(light, ['rgb(0, 0, 0)', 'rgb(255, 255, 255)'], 'tema claro: "Exportar" preto com texto branco');
    await shot('editor-claro');
    await ev("BF.ui.setTheme('dark')");
    h.assertNoConsoleErrors(page, [/Autofill|favicon/i]);
    step('janela mínima: o cabeçalho cabe sem rolar; tema claro: a ação principal é preta com texto branco');

    await app.stop(); app = null;
    console.log('\nE2E DO EDITOR DE CORTES OK');
  } finally {
    try { if (app) await app.stop(); } catch { /* já fechado */ }
    h.removeDir(tmp);
  }
}

main().then(() => process.exit(0), (err) => { console.error(`\n✖ E2E FALHOU: ${err.stack || err.message}`); h.cleanupAll().finally(() => process.exit(1)); });

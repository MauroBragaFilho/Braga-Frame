'use strict';

/**
 * E2E do menu lateral de 5 itens (Início, Projetos, Cortes, Exportações, Configurações), no app Electron de verdade (perfil temporário, vídeo gerado):
 *  - sem projeto: os 5 itens com os ícones certos, Início aberta, Cortes desabilitado (com a dica) e nenhuma barra de abas internas à vista;
 *  - Configurações abriga Preferências e Ferramentas como abas internas; o item lembra a última aba em que se esteve; o título do cabeçalho é o do item;
 *  - Novo projeto não tem item: abre pelos botões (Início e Projetos) e acende Projetos; o botão de Projetos é a ação principal da tela;
 *  - teclado no menu (setas, Home, End; pula o item desabilitado) e nas abas internas (←/→, Home, End);
 *  - com projeto: Cortes abriga Cortes, Análise, Legendas, Áudio e Exportar (nessa ordem, numa linha só, com a linha vermelha na ativa), cada aba abre a sua
 *    tela, BF.ui.selectTab(id) segue abrindo qualquer tela, os selos ficam na aba interna e só o que pede atenção ("!" e "…") sobe para o item;
 *  - janela estreita (uma linha só), tema claro, as abas coladas no topo nas telas largas que rolam, o trilho de ícones e o modo embutido (5 itens);
 *  - uma tela que o layout não conhece (recurso novo) ganha um item próprio na posição do seu order.
 * Uso: node tests/e2e/menu.e2e.js     (BF_E2E_SHOTDIR=C:\pasta guarda capturas da janela)
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

const ITEMS = [['home', 'Início'], ['projects', 'Projetos'], ['editor', 'Cortes'], ['queue', 'Exportações'], ['settings', 'Configurações']];
const EDITOR_TABS = [['analysis', 'Análise'], ['cuts', 'Cortes'], ['subtitles', 'Legendas'], ['audio', 'Áudio'], ['export', 'Exportar']];
const LOCKED = 'Abra um vídeo para usar esta aba';

async function main() {
  const tmp = h.mkTemp('menu-');
  const shotDir = process.env.BF_E2E_SHOTDIR;
  let app = null;
  try {
    const video = path.join(tmp, 'NFS Most Wanted - Gameplay.mp4');
    h.makeSampleVideo(ffmpeg, video, { seconds: 20, size: '1280x720', rate: 15 });
    app = await h.launchApp(path.join(tmp, 'ud'), {});
    let { page } = app;
    const ev = (x) => page.eval(x);
    const shot = async (name) => { if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); await sleep(400); await h.screenshot(page, path.join(shotDir, `${name}.png`)); } };
    const menu = () => ev(`JSON.stringify([...document.querySelectorAll('#tabBar [role=tab]')].map((b) => ({ tab: b.dataset.tab, label: b.querySelector('.tab-label').textContent, selected: b.getAttribute('aria-selected') === 'true', disabled: b.disabled, badge: b.querySelector('.tab-badge').hidden ? '' : b.querySelector('.tab-badge').textContent })))`).then(JSON.parse);
    const strips = () => ev(`JSON.stringify([...document.querySelectorAll('#subTabs .subtabs')].filter((s) => !s.hidden).map((s) => ({ group: s.dataset.group, rows: new Set([...s.children].map((c) => Math.round(c.getBoundingClientRect().top))).size, tabs: [...s.children].map((c) => ({ tab: c.dataset.tab, label: c.querySelector('.subtab-label').textContent, selected: c.getAttribute('aria-selected') === 'true', disabled: c.disabled, badge: c.querySelector('.tab-badge').hidden ? '' : c.querySelector('.tab-badge').textContent })) })))`).then(JSON.parse);
    const where = () => ev("(() => { const a = document.getElementById('app'); return JSON.stringify({ tab: a.dataset.activeTab, menu: a.dataset.activeMenu, view: a.dataset.viewKind, title: document.getElementById('pageTitle').textContent }); })()").then(JSON.parse);
    const visiblePanels = () => ev("JSON.stringify([...document.querySelectorAll('#tabPanels .tabpanel')].filter((p) => !p.hidden).map((p) => p.dataset.tab))").then(JSON.parse);
    const keyTrail = async (keys) => { const seen = []; for (const key of keys) { await page.press(key); seen.push(await ev('document.activeElement.id')); } return seen; };
    const click = (id) => ev(`document.getElementById(${j(id)}).click()`);

    // ============================================================ sem projeto
    assert.equal(await ev('BF.state.project'), null);
    let items = await menu();
    assert.deepEqual(items.map((m) => [m.tab, m.label]), ITEMS, 'cinco itens, na ordem do desenho');
    assert.deepEqual(await ev("[...document.querySelectorAll('#tabBar [role=tab]')].map((b) => { const i = b.querySelector('.material-symbols-rounded'); return [i.textContent, Math.round(i.getBoundingClientRect().width)]; })"),
      [['home', 22], ['folder_special', 22], ['content_cut', 22], ['queue', 22], ['settings', 22]], 'ícones desenhados pela fonte');
    assert.deepEqual(items.map((m) => [m.tab, m.selected, m.disabled]), [['home', true, false], ['projects', false, false], ['editor', false, true], ['queue', false, false], ['settings', false, false]]);
    assert.equal(await ev("document.getElementById('tab-editor').title"), LOCKED);
    assert.deepEqual(await where(), { tab: 'home', menu: 'home', view: 'wide', title: 'Início' });
    assert.deepEqual(await strips(), [], 'sem item com abas internas aberto, nenhuma barra à vista');
    assert.deepEqual(await ev("['analysis', 'cuts', 'subtitles', 'audio', 'export', 'general', 'prefs', 'tools'].map((id) => { const b = document.getElementById('tab-' + id); return [b.disabled, b.title]; })"),
      [[true, LOCKED], [true, LOCKED], [true, LOCKED], [true, LOCKED], [true, LOCKED], [false, ''], [false, ''], [false, '']], 'as abas internas existem; as que exigem projeto ficam desabilitadas com a dica');
    assert.equal(await ev("BF.ui.selectTab('cuts')"), false, 'tela que exige projeto não abre sem projeto');
    assert.equal(await ev("BF.ui.selectTab('nao-existe')"), false);
    await shot('menu-sem-projeto');
    step('sem projeto: os 5 itens (Início, Projetos, Cortes, Exportações, Configurações) com os ícones certos; Início aberta; Cortes desabilitado com a dica e sem barra de abas');

    // ---- Configurações: Preferências e Ferramentas como abas internas
    await click('tab-settings');
    assert.deepEqual(await where(), { tab: 'general', menu: 'settings', view: 'wide', title: 'Configurações' }, 'o item abre a primeira aba (Geral); o cabeçalho leva o nome do item');
    let bars = await strips();
    assert.equal(bars.length, 1);
    assert.deepEqual(bars[0].tabs.map((t) => [t.tab, t.label, t.selected, t.disabled]), [['general', 'Geral', true, false], ['prefs', 'Preferências', false, false], ['tools', 'Ferramentas', false, false]]);
    assert.equal(bars[0].rows, 1);
    assert.deepEqual(await visiblePanels(), ['general']);
    assert.deepEqual((await menu()).map((m) => [m.tab, m.selected]), [['home', false], ['projects', false], ['editor', false], ['queue', false], ['settings', true]]);
    const underline = await ev(`(() => { const on = getComputedStyle(document.getElementById('tab-general')); const off = getComputedStyle(document.getElementById('tab-tools')); return { onWidth: on.borderBottomWidth, onColor: on.borderBottomColor, offColor: off.borderBottomColor, offText: off.color, onText: on.color, bg: on.backgroundColor }; })()`);
    assert.equal(underline.onWidth, '2px', 'a ativa tem a linha de baixo');
    assert.notEqual(underline.onColor, underline.offColor, 'e só ela a tem em vermelho');
    assert.notEqual(underline.onText, underline.offText, 'o texto da ativa é mais claro');
    assert.equal(underline.bg, 'rgba(0, 0, 0, 0)', 'sem fundo de pílula');
    await click('tab-tools');
    assert.deepEqual(await where(), { tab: 'tools', menu: 'settings', view: 'wide', title: 'Configurações' }, 'trocar de aba interna não muda o item nem o título');
    assert.deepEqual((await strips())[0].tabs.map((t) => t.selected), [false, false, true]);
    assert.deepEqual(await visiblePanels(), ['tools']);
    await shot('menu-configuracoes');
    // o item lembra a aba em que se estava
    await click('tab-home');
    assert.deepEqual(await strips(), [], 'saiu do item: a barra some');
    await click('tab-settings');
    assert.equal((await where()).tab, 'tools', 'voltar a Configurações abre a última aba usada (Ferramentas)');
    step('Configurações abriga Preferências e Ferramentas como abas internas (linha vermelha na ativa); o cabeçalho leva o nome do item e o item lembra a última aba');

    // ---- Novo projeto: sem item, abre pelos botões e acende Projetos
    await click('tab-home');
    await ev("document.querySelector('#tabpanel-home [data-act=new]').click()");
    assert.deepEqual(await where(), { tab: 'sources', menu: 'projects', view: 'wide', title: 'Novo projeto' });
    assert.deepEqual((await menu()).map((m) => [m.tab, m.selected]), [['home', false], ['projects', true], ['editor', false], ['queue', false], ['settings', false]], 'Projetos fica aceso');
    assert.deepEqual(await strips(), []);
    assert.equal(await ev("document.getElementById('tab-sources')"), null, 'não existe botão de menu nem aba interna para Novo projeto');
    await click('tab-projects');
    assert.deepEqual(await where(), { tab: 'projects', menu: 'projects', view: 'wide', title: 'Projetos' }, 'o item Projetos abre a lista, mesmo vindo de Novo projeto');
    const head = await ev("(() => { const b = document.querySelector('#tabpanel-projects .prj-head [data-act=new]'); const r = b.getBoundingClientRect(); return { text: b.textContent, primary: b.classList.contains('primary'), visible: r.width > 0 && r.height > 0, icon: b.querySelector('.material-symbols-rounded').textContent }; })()");
    assert.deepEqual(head, { text: 'addNovo projeto', primary: true, visible: true, icon: 'add' }, 'o botão do cabeçalho de Projetos');
    await ev("document.querySelector('#tabpanel-projects .prj-head [data-act=new]').click()");
    assert.deepEqual(await where(), { tab: 'sources', menu: 'projects', view: 'wide', title: 'Novo projeto' });
    await shot('menu-novo-projeto');
    step('Novo projeto não tem item: abre pelos botões da Início e de Projetos e acende Projetos; o item Projetos volta à lista');

    // ---- teclado no menu (o item Cortes desabilitado fica de fora da volta)
    await click('tab-home');
    await ev("document.getElementById('tab-home').focus()");
    assert.deepEqual(await keyTrail(['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown']), ['tab-projects', 'tab-queue', 'tab-settings', 'tab-home'], 'sem projeto pula Cortes e dá a volta');
    assert.equal((await where()).tab, 'home');
    assert.deepEqual(await keyTrail(['ArrowUp', 'ArrowUp']), ['tab-settings', 'tab-queue']);
    assert.deepEqual(await keyTrail(['Home', 'End']), ['tab-home', 'tab-settings']);
    assert.equal((await where()).menu, 'settings', 'o foco acompanha a seleção');
    // teclado nas abas internas: ←/→, Home e End
    await click('tab-general');
    await ev("document.getElementById('tab-general').focus()");
    assert.deepEqual(await keyTrail(['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowLeft', 'End', 'Home']), ['tab-prefs', 'tab-tools', 'tab-general', 'tab-tools', 'tab-tools', 'tab-general'], 'as setas dão a volta nas abas do item');
    assert.deepEqual((await where()).tab, 'general');
    step('teclado: setas, Home e End no menu (pulando o item desabilitado) e ←/→, Home e End nas abas internas, com a seleção acompanhando o foco');

    // ============================================================ com projeto
    await ev(`BF.openSource(${j(video)})`);
    await waitFor(page, "BF.state.project && document.getElementById('video').readyState >= 1", 30000, 'vídeo aberto');
    for (const [title, start, end, status] of [['Perseguição policial', 2, 9, 'approved'], ['Pulo épico', 4, 12, 'pending'], ['Fuga no último segundo', 8, 17, 'approved']]) {
      await ev(`BF.project.addCut({ title: ${j(title)}, start: ${start}, end: ${end}, status: ${j(status)} })`);
    }
    items = await menu();
    assert.deepEqual(items.map((m) => [m.tab, m.disabled]), [['home', false], ['projects', false], ['editor', false], ['queue', false], ['settings', false]], 'com projeto o item Cortes libera');
    assert.equal(await ev("document.getElementById('tab-editor').title"), '');
    assert.deepEqual(await ev("['analysis', 'cuts', 'subtitles', 'audio', 'export'].map((id) => document.getElementById('tab-' + id).disabled)"), [false, false, false, false, false]);
    await click('tab-editor');
    assert.deepEqual(await where(), { tab: 'cuts', menu: 'editor', view: 'work', title: 'Cortes' }, 'abrir um vídeo leva à aba Cortes; o cabeçalho leva o nome do item');
    bars = await strips();
    assert.equal(bars.length, 1);
    assert.equal(bars[0].group, 'editor');
    assert.deepEqual(bars[0].tabs.map((t) => [t.tab, t.label]), EDITOR_TABS, 'Análise, Cortes, Legendas, Áudio e Exportar, nessa ordem');
    assert.equal(bars[0].rows, 1, 'as cinco abas cabem numa linha só');
    assert.deepEqual(bars[0].tabs.map((t) => t.selected), [false, true, false, false, false]);
    assert.ok(await ev("document.querySelector('.player').getBoundingClientRect().width > 250"), 'tela de trabalho: o player aparece ao lado');
    assert.deepEqual(await visiblePanels(), ['cuts']);
    await shot('menu-cortes');
    // cada aba abre a sua tela; o item e o título não mudam; as outras telas ficam escondidas
    for (const [id, label] of EDITOR_TABS) {
      await click(`tab-${id}`);
      assert.deepEqual(await where(), { tab: id, menu: 'editor', view: 'work', title: 'Cortes' }, `aba ${label}`);
      assert.deepEqual(await visiblePanels(), [id]);
      assert.deepEqual((await strips())[0].tabs.map((t) => t.selected), EDITOR_TABS.map(([x]) => x === id), `${label} é a aba marcada`);
      assert.equal((await menu()).find((m) => m.tab === 'editor').selected, true);
    }
    await shot('menu-exportar');
    // as telas continuam abrindo por BF.ui.selectTab(id), pelo id de sempre
    for (const [id] of [...EDITOR_TABS].reverse()) {
      assert.equal(await ev(`BF.ui.selectTab(${j(id)})`), true);
      assert.equal((await where()).tab, id);
      assert.equal((await strips())[0].tabs.find((t) => t.selected).tab, id);
    }
    step('Cortes abriga Cortes, Análise, Legendas, Áudio e Exportar (numa linha, com a linha vermelha na ativa): cada aba abre a sua tela e BF.ui.selectTab(id) segue valendo');

    // ---- selos: contagens ficam na aba interna; só "!" e "…" sobem para o item
    await ev('BF.ui.refreshTabs()');
    bars = await strips();
    assert.equal(bars[0].tabs.find((t) => t.tab === 'cuts').badge, '3', 'o total de cortes na aba Cortes');
    assert.equal(bars[0].tabs.find((t) => t.tab === 'export').badge, '2', 'os aprovados na aba Exportar');
    assert.equal((await menu()).find((m) => m.tab === 'editor').badge, '', 'contagens não sobem para o item do menu');
    const badgeOf = (id) => ev(`(() => { const n = document.querySelector('#tab-${id} .tab-badge'); return n.hidden ? '' : n.textContent; })()`);
    await ev('BF.state.tools = { ...BF.state.tools, ffmpeg: null }; BF.ui.refreshTabs();');
    assert.equal(await badgeOf('tools'), '!', 'a aba Ferramentas avisa que falta o FFmpeg');
    assert.equal(await badgeOf('settings'), '!', 'e o aviso sobe para o item Configurações');
    await ev("BF.sources.state.vod.stage = 'running'; BF.ui.refreshTabs();");
    assert.equal(await badgeOf('projects'), '…', 'o download em andamento (tela Novo projeto, sem item) aparece no item Projetos');
    await ev("BF.sources.state.vod.stage = 'idle'; BF.state.tools = { ...BF.state.tools, ffmpeg: 'ffmpeg' }; BF.ui.refreshTabs();");
    assert.equal(await badgeOf('settings'), '');
    assert.equal(await badgeOf('projects'), '');
    step('selos: as contagens ficam na aba interna; "!" (Ferramentas) e "…" (download de Novo projeto) sobem para Configurações e Projetos');

    // ---- o item lembra a última aba; teclado nas abas internas e no menu com projeto
    await click('tab-subtitles');
    await click('tab-home');
    assert.deepEqual(await strips(), []);
    await click('tab-editor');
    assert.equal((await where()).tab, 'subtitles', 'o item Cortes volta à última aba usada (Legendas)');
    await ev("document.getElementById('tab-subtitles').focus()");
    assert.deepEqual(await keyTrail(['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowLeft', 'Home', 'End']), ['tab-audio', 'tab-export', 'tab-analysis', 'tab-export', 'tab-analysis', 'tab-export']);
    assert.equal((await where()).tab, 'export');
    await ev("document.getElementById('tab-projects').click(); document.getElementById('tab-projects').focus()");
    assert.deepEqual(await keyTrail(['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown']), ['tab-editor', 'tab-queue', 'tab-settings', 'tab-home', 'tab-projects'], 'com projeto o item Cortes entra na volta');
    await ev("document.getElementById('tab-projects').focus()");
    await page.press('ArrowDown');
    assert.equal((await where()).tab, 'export', 'e abre a última aba usada');
    step('o item Cortes lembra a última aba; o teclado anda pelas abas internas e entra o item Cortes na volta do menu');

    // ---- janela estreita, tema claro
    const narrow = await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 640, deviceScaleFactor: 1, mobile: false });
    assert.ok(!narrow.error, `Emulation.setDeviceMetricsOverride: ${narrow.error && narrow.error.message}`);
    try {
      await sleep(500);
      await click('tab-cuts');
      const fit = await ev(`(() => { const s = document.querySelector('#subTabs .subtabs:not([hidden])'); const side = document.querySelector('.side'); return { rows: new Set([...s.children].map((c) => Math.round(c.getBoundingClientRect().top))).size, sideWidth: Math.round(side.getBoundingClientRect().width), overflow: side.scrollWidth > side.clientWidth, pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth }; })()`);
      assert.deepEqual(fit, { rows: 1, sideWidth: 440, overflow: false, pageFits: true }, 'na janela mínima (painel de 440 px) as cinco abas ainda cabem numa linha');
      await shot('menu-janela-minima');
    } finally {
      await page.send('Emulation.clearDeviceMetricsOverride');
    }
    await sleep(300);
    await ev("BF.ui.setTheme('light')");
    await sleep(300);
    const light = await ev(`(() => { const on = getComputedStyle(document.getElementById('tab-cuts')); const off = getComputedStyle(document.getElementById('tab-analysis')); return { on: on.color, off: off.color, line: on.borderBottomColor }; })()`);
    assert.notEqual(light.on, light.off, 'no tema claro a aba ativa também se destaca');
    assert.equal(light.on, 'rgb(0, 0, 0)');
    await shot('menu-claro');
    await ev("BF.ui.setTheme('dark')");
    step('na janela mínima (painel de 440 px) as cinco abas ainda cabem numa linha; o tema claro destaca a ativa');

    // ---- telas largas que rolam: as abas internas ficam coladas no topo
    await click('tab-tools');
    await sleep(400);
    const sticky = await ev(`(() => {
      const ws = document.getElementById('workspace');
      const host = document.getElementById('subTabs');
      const before = Math.round(host.getBoundingClientRect().top);
      const scrollable = ws.scrollHeight > ws.clientHeight + 40;
      ws.scrollTop = 300;
      return { scrollable, before, after: Math.round(host.getBoundingClientRect().top), ws: Math.round(ws.getBoundingClientRect().top) };
    })()`);
    if (sticky.scrollable) assert.ok(sticky.after <= sticky.ws + 1, `as abas internas ficam no topo ao rolar (topo ${sticky.after}, área ${sticky.ws})`);
    await ev("document.getElementById('workspace').scrollTop = 0");
    step(sticky.scrollable ? 'nas telas largas que rolam as abas internas ficam coladas no topo' : 'a tela larga não rolou neste tamanho (colagem no topo não exercitada)');

    // ---- uma tela que o layout não conhece ganha um item próprio, na posição do seu order, com o selo e o ícone
    await ev("BF.ui.registerTab({ id: 'extra', title: 'Extra', order: 25, icon: 'star', render(c) { c.textContent = 'tela extra'; }, badge: () => '…' })");
    items = await menu();
    assert.deepEqual(items.map((m) => m.tab), ['home', 'projects', 'editor', 'extra', 'queue', 'settings'], 'entre Cortes (10) e Exportações (30), pelo order');
    assert.deepEqual(items.find((m) => m.tab === 'extra'), { tab: 'extra', label: 'Extra', selected: false, disabled: false, badge: '…' }, 'com projeto aberto o item novo está liberado e traz o selo da tela');
    assert.equal(await ev("document.querySelector('#tab-extra .material-symbols-rounded').textContent"), 'star');
    assert.equal(await ev("BF.ui.selectTab('extra')"), true);
    assert.deepEqual(await where(), { tab: 'extra', menu: 'extra', view: 'work', title: 'Extra' });
    assert.deepEqual(await strips(), [], 'um item de uma tela só não tem abas internas');
    step('uma tela que o layout não conhece ganha um item de menu próprio (entre Cortes e Exportações, pelo order), com o ícone e o selo dela');
    h.assertNoConsoleErrors(page, [/Autofill|favicon/i]);
    await app.stop(); app = null;

    // ============================================================ trilho de ícones e modo embutido: os mesmos 5 itens
    app = await h.launchApp(path.join(tmp, 'ud-trilho'), {});
    ({ page } = app);
    await ev('BF.ui.setSidebarCollapsed(true)');
    await sleep(400);
    assert.equal(await ev("document.getElementById('app').classList.contains('collapsed')"), true);
    assert.deepEqual(await ev("[...document.querySelectorAll('#tabBar [role=tab]')].map((b) => [b.dataset.tab, getComputedStyle(b.querySelector('.tab-label')).display, b.getAttribute('aria-label')])"),
      ITEMS.map(([id, label]) => [id, 'none', label]), 'só os ícones, com o nome acessível');
    assert.deepEqual(await ev("[...document.querySelectorAll('#tabBar [role=tab]')].map((b) => b.title)"), ['Início', 'Projetos', LOCKED, 'Exportações', 'Configurações'], 'no trilho o título vira dica (o item desabilitado diz por quê)');
    await click('tab-settings');
    assert.equal((await strips()).length, 1, 'as abas internas aparecem no painel mesmo com o menu recolhido');
    await shot('menu-trilho');
    await ev('BF.ui.setSidebarCollapsed(false)');
    const baseUrl = (await ev('location.href')).split(/[?#]/)[0];
    await ev('window.__marker = 1; true');
    await page.send('Page.navigate', { url: `${baseUrl}?embedded=1` });
    await waitFor(page, "window.__marker === undefined && document.readyState === 'complete' && !!window.BF", 30000, 'página recarregada no modo embutido');
    await ev('BF.ready.then(() => true)');
    assert.equal(await ev('BF.embedded'), true);
    assert.deepEqual((await menu()).map((m) => [m.tab, m.label]), ITEMS, 'o modo embutido tem os mesmos 5 itens');
    await waitFor(page, "Math.round(document.querySelector('.sidebar').getBoundingClientRect().width) === 64", 5000, 'menu em trilho de 64 px (depois da transição do shell)');
    await ev("BF.ui.selectTab('tools')");
    assert.deepEqual(await where(), { tab: 'tools', menu: 'settings', view: 'wide', title: 'Configurações' });
    h.assertNoConsoleErrors(page, [/Autofill|favicon/i]);
    step('o trilho de ícones e o modo embutido têm os mesmos 5 itens (com título como dica e as abas internas no painel)');
    await app.stop(); app = null;
    console.log('\nE2E DO MENU OK');
  } finally {
    try { if (app) await app.stop(); } catch { /* já fechado */ }
    h.removeDir(tmp);
  }
}

main().then(() => process.exit(0), (err) => { console.error(`\n✖ E2E FALHOU: ${err.stack || err.message}`); h.cleanupAll().finally(() => process.exit(1)); });

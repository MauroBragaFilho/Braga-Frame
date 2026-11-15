'use strict';

/**
 * E2E da tela Início: abre o app Electron de verdade (perfil temporário) com projetos reais gravados em disco e vídeos de verdade (ffmpeg) e confere
 *  - é a aba inicial sem vídeo aberto (a primeira do menu, com o ícone certo), em tela larga, com a saudação "Bem-vindo de volta!";
 *  - os 3 projetos mais recentes, do mais novo ao mais antigo, com o estado, os cortes e a origem de cada um, e a MINIATURA de verdade (320 px);
 *  - o desenho: brilho vermelho no cartão de boas-vindas, atalhos à vista, nada passando da largura da janela (nem estreita), tema claro;
 *  - a busca: digitar (de verdade) mostra os resultados de TODOS os projetos; Escape limpa; Enter e "Ver todos os resultados" abrem Projetos já com o texto;
 *  - os atalhos: "Novo projeto" (pelo mouse e pelo teclado) e "Continuar de onde parou" (abre o mais recente e vai para Cortes), "Abrir" num cartão;
 *  - o vídeo que sumiu: aviso no cartão, sem miniatura e sem abrir, "Ver em Projetos" e o atalho de continuar que pula para o próximo;
 *  - primeira vez (perfil vazio): "Bem-vindo ao <nome>!", a explicação e nenhum "Ver todos"; abrir um vídeo e voltar à Início mostra o projeto novo.
 * Uso: node tests/e2e/home.e2e.js     (BF_E2E_SHOTDIR=C:\pasta guarda capturas da janela)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ProjectStore, newProject } = require('../../src/core/projects/projectStore');
const { newCut } = require('../../src/core/projects/model');
const { locateTools } = require('../../src/core/ffmpeg/locate');
const h = require('./helpers');

const ffmpeg = locateTools().ffmpeg;
const { waitFor, sleep } = h;
const step = (m) => console.log(`✔ ${m}`);
const j = JSON.stringify;
const HOME = '#tabpanel-home';

/** Um projeto real no perfil: o vídeo, os cortes e a data da última alteração (o store grava "agora"; a data é ajustada no arquivo). */
function makeProject(store, projectsDir, file, { origin = null, cuts = [], ageMs }) {
  const duration = 6;
  const p = newProject(file, { size: fs.existsSync(file) ? fs.statSync(file).size : 1, duration, width: 1920, height: 1080 }, origin);
  p.cuts = cuts.map((c, i) => newCut({ id: `c${i}${Math.abs(file.length)}`, title: `Corte ${i + 1}`, start: i * 5, end: i * 5 + 4, status: c.status, exports: c.exported ? [{ path: 'x.mp4', at: new Date().toISOString(), start: 0, end: 4, profile: 'p' }] : [] }));
  const saved = store.save(p);
  const f = path.join(projectsDir, `${saved.id}.json`);
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  data.updatedAt = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
  return saved;
}

async function main() {
  const tmp = h.mkTemp('home-');
  const shotDir = process.env.BF_E2E_SHOTDIR;
  let app = null;
  try {
    const shot = async (page, name) => { if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); await sleep(300); await h.screenshot(page, path.join(shotDir, `${name}.png`)); } };
    const ud = path.join(tmp, 'ud');
    const projectsDir = path.join(ud, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const store = new ProjectStore(projectsDir);
    const HOUR = 3600e3;
    const DAY = 24 * HOUR;
    const video = (name) => { const f = path.join(tmp, `${name}.mp4`); h.makeSampleVideo(ffmpeg, f, { seconds: 6, size: '640x360', rate: 15 }); return f; };
    const vMine = video('Minecraft - Sobrevivência EP12');
    const vNfs = video('NFS Most Wanted - Gameplay');
    const vObs = video('2026-10-20 21-00-00');
    const vOld1 = video('Aula de música');
    const vOld2 = video('Quinto projeto');
    makeProject(store, projectsDir, vMine, { origin: { type: 'vod', platform: 'youtube', url: 'https://www.youtube.com/watch?v=abc', videoId: 'abc', title: 'Minecraft - Sobrevivência EP12', channel: 'MauroBragaFilho' }, cuts: [{ status: 'approved', exported: true }, { status: 'approved', exported: true }], ageMs: HOUR });
    makeProject(store, projectsDir, vNfs, { origin: { type: 'vod', platform: 'twitch', url: 'https://www.twitch.tv/videos/1', videoId: '1', title: 'NFS Most Wanted - Gameplay', channel: 'Live do Dia', game: 'NFS' }, cuts: [{ status: 'pending' }, { status: 'approved' }, { status: 'pending' }], ageMs: 26 * HOUR });
    makeProject(store, projectsDir, vObs, { origin: { type: 'obs' }, cuts: [{ status: 'approved' }], ageMs: 3 * DAY });
    makeProject(store, projectsDir, vOld1, { cuts: [], ageMs: 9 * DAY });
    makeProject(store, projectsDir, vOld2, { cuts: [{ status: 'pending' }], ageMs: 12 * DAY });

    app = await h.launchApp(ud, {});
    let { page } = app;
    const ev = (x) => page.eval(x);
    const cards = () => ev(`JSON.stringify([...document.querySelectorAll('${HOME} .prj-card')].map((c) => ({ title: c.querySelector('.prj-title').textContent, state: c.dataset.state, sub: c.querySelector('.prj-sub') ? c.querySelector('.prj-sub').textContent : '', chips: [...c.querySelectorAll('.prj-chips .bds-chip')].map((n) => n.textContent) })))`).then(JSON.parse);
    await waitFor(page, `document.querySelectorAll('${HOME} .prj-card').length === 3`, 20000, 'os 3 projetos recentes');

    // ---- a aba inicial
    assert.equal(await ev('BF.state.project'), null);
    assert.deepEqual(await ev("[document.getElementById('app').dataset.activeTab, document.getElementById('app').dataset.viewKind, document.getElementById('pageTitle').textContent]"), ['home', 'wide', 'Início']);
    assert.equal(await ev("document.getElementById('tab-home').getAttribute('aria-selected')"), 'true', 'Início é a aba inicial sem vídeo aberto');
    assert.equal(await ev("document.querySelector('#tabBar [role=tab]').dataset.tab"), 'home', 'e a primeira do menu');
    assert.deepEqual(await ev("(() => { const b = document.getElementById('tab-home'); const i = b.querySelector('.material-symbols-rounded'); return [i.textContent, Math.round(i.getBoundingClientRect().width), b.querySelector('.tab-label').textContent]; })()"), ['home', 22, 'Início']);
    assert.equal(await ev("document.querySelector('.player').getBoundingClientRect().width"), 0, 'tela larga: sem player');
    assert.equal(await ev(`document.querySelector('${HOME} .home-title').textContent`), 'Bem-vindo de volta!');
    assert.equal(await ev(`document.querySelector('${HOME} .home-lead').textContent`), 'Seus projetos, cortes e exportações em um só lugar.');
    assert.doesNotMatch(await ev(`document.querySelector('${HOME}').textContent`), /Mauro(?!BragaFilho)/, 'o app não tem nome de usuário');
    step('Início é a aba inicial (a primeira do menu, ícone home, tela larga) e diz "Bem-vindo de volta!"');

    // ---- os recentes
    const recent = await cards();
    assert.deepEqual(recent.map((c) => c.title), ['Minecraft - Sobrevivência EP12', 'NFS Most Wanted - Gameplay', '2026-10-20 21-00-00'], 'só os 3 mais novos, do mais novo ao mais antigo');
    assert.deepEqual(recent.map((c) => [c.state, c.chips]), [['done', ['Exportado', '2 cortes']], ['review', ['Em revisão', '3 cortes']], ['ready', ['Pronto para exportar', '1 corte']]]);
    assert.match(recent[0].sub, /^YouTube · MauroBragaFilho/);
    assert.match(recent[1].sub, /^Twitch · Live do Dia · NFS/);
    assert.match(recent[2].sub, /^OBS/);
    assert.equal(await ev(`document.querySelector('${HOME} .home-section-head h3').textContent`), 'Projetos recentes');
    assert.equal(await ev(`document.querySelector('${HOME} [data-act=all]').hidden`), false);
    await waitFor(page, `document.querySelectorAll('${HOME} .prj-thumb img').length === 3`, 40000, 'as 3 miniaturas de verdade');
    assert.deepEqual(await ev(`[...document.querySelectorAll('${HOME} .prj-thumb img')].map((i) => [i.complete, i.naturalWidth])`), [[true, 320], [true, 320], [true, 320]], 'quadros de 320 px tirados do vídeo');
    step('os 3 projetos recentes (do mais novo ao mais antigo) com estado, cortes, origem e a miniatura de verdade');

    // ---- o desenho
    const look = await ev(`(() => {
      const q = (s) => document.querySelector('${HOME} ' + s);
      const hero = q('.home-hero'); const box = hero.getBoundingClientRect();
      const visible = (s) => { const n = q(s); return !!n && n.getClientRects().length > 0; };
      const inside = (s) => { const r = q(s).getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1; };
      return { glow: getComputedStyle(hero).backgroundImage.includes('radial-gradient'), radius: getComputedStyle(hero).borderTopLeftRadius,
        newVisible: visible('[data-act=new]'), resumeVisible: visible('[data-act=resume]'), searchVisible: visible('.home-search-input'), inside: inside('[data-act=resume]') && inside('.home-search'),
        primary: q('[data-act=new]').classList.contains('primary'), pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        searchIcon: Math.round(q('.home-search-icon').getBoundingClientRect().width), noOpenVideoShortcut: !q('[data-act=open-video]') };
    })()`);
    assert.deepEqual(look, { glow: true, radius: '24px', newVisible: true, resumeVisible: true, searchVisible: true, inside: true, primary: true, pageFits: true, searchIcon: 22, noOpenVideoShortcut: true });
    await shot(page, 'inicio-escuro');
    const narrow = await page.send('Emulation.setDeviceMetricsOverride', { width: 680, height: 820, deviceScaleFactor: 1, mobile: false });
    assert.ok(!narrow.error, `Emulation.setDeviceMetricsOverride: ${narrow.error && narrow.error.message}`);
    try {
      await sleep(400);
      const fits = await ev(`(() => { const root = document.querySelector('${HOME} .home'); const cards = [...root.querySelectorAll('.prj-card')]; const box = root.getBoundingClientRect(); return { pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth, cardsInside: cards.every((c) => { const r = c.getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1; }) }; })()`);
      assert.deepEqual(fits, { pageFits: true, cardsInside: true }, 'nada passa da largura da janela estreita');
      await shot(page, 'inicio-estreito');
    } finally {
      await page.send('Emulation.clearDeviceMetricsOverride');
    }
    await ev("BF.ui.setTheme('light')");
    await sleep(200);
    await shot(page, 'inicio-claro');
    assert.equal(await ev(`getComputedStyle(document.querySelector('${HOME} .home-hero')).backgroundColor`), 'rgb(255, 255, 255)', 'no tema claro o cartão é branco');
    await ev("BF.ui.setTheme('dark')");
    step('o cartão de boas-vindas tem o brilho vermelho e os atalhos à vista; nada passa da largura (nem da janela estreita); o tema claro também funciona');

    // ---- a busca (digitada de verdade)
    await ev(`document.querySelector('${HOME} .home-search-input').focus()`);
    await page.send('Input.insertText', { text: 'nfs' });
    await waitFor(page, `document.querySelector('${HOME} .home-section-head h3').textContent === 'Resultados (1)'`, 10000, 'o resultado da busca');
    assert.deepEqual((await cards()).map((c) => c.title), ['NFS Most Wanted - Gameplay']);
    assert.equal(await ev(`document.querySelector('${HOME} [data-act=all] span').textContent`), 'Ver todos os resultados');
    await shot(page, 'inicio-busca');
    await page.press('Escape');
    await waitFor(page, `document.querySelector('${HOME} .home-section-head h3').textContent === 'Projetos recentes'`, 10000, 'a busca limpa');
    assert.equal(await ev(`document.querySelector('${HOME} .home-search-input').value`), '');
    assert.equal((await cards()).length, 3);
    // um projeto que não está entre os 3 recentes também é achado (a busca vale para todos)
    await page.send('Input.insertText', { text: 'AULA de musica' });
    await waitFor(page, `document.querySelector('${HOME} .home-section-head h3').textContent === 'Resultados (1)'`, 10000, 'resultado sem acento e sem maiúsculas');
    assert.deepEqual((await cards()).map((c) => c.title), ['Aula de música']);
    // Enter leva a Projetos já com o texto
    await ev(`document.querySelector('${HOME} .home-search-input').value = ''; document.querySelector('${HOME} .home-search-input').dispatchEvent(new Event('input', { bubbles: true })); true`);
    await page.send('Input.insertText', { text: 'live do dia' }); // o canal do projeto da Twitch
    await page.press('Enter');
    await waitFor(page, "document.getElementById('tab-projects').getAttribute('aria-selected') === 'true'", 10000, 'a aba Projetos aberta pelo Enter');
    assert.equal(await ev("document.querySelector('#tabpanel-projects .prj-search').value"), 'live do dia');
    await waitFor(page, "document.querySelectorAll('#tabpanel-projects .prj-card').length === 1", 10000, 'a lista de Projetos filtrada pela busca');
    assert.equal(await ev("document.querySelector('#tabpanel-projects .prj-card .prj-title').textContent"), 'NFS Most Wanted - Gameplay');
    step('a busca digitada mostra os resultados de todos os projetos; Escape limpa; Enter abre Projetos já com o texto');
    // "Ver todos os resultados" faz o mesmo (e ignora o filtro de estado que estivesse ligado em Projetos)
    await ev("document.querySelector('#tabpanel-projects [data-filter=done]').click(); BF.ui.selectTab('home'); true");
    await ev(`(() => { const i = document.querySelector('${HOME} .home-search-input'); i.value = 'minecraft'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await ev(`document.querySelector('${HOME} [data-act=all]').click()`);
    await waitFor(page, "document.getElementById('tab-projects').getAttribute('aria-selected') === 'true' && document.querySelector('#tabpanel-projects .prj-search').value === 'minecraft'", 10000, 'Projetos com a busca da Início');
    assert.equal(await ev("document.querySelector('#tabpanel-projects [data-filter=all]').getAttribute('aria-pressed')"), 'true');
    assert.deepEqual(JSON.parse(await ev("JSON.stringify([...document.querySelectorAll('#tabpanel-projects .prj-card .prj-title')].map((t) => t.textContent))")), ['Minecraft - Sobrevivência EP12']);
    await ev("document.querySelector('#tabpanel-projects .prj-search').value = ''; document.querySelector('#tabpanel-projects .prj-search').dispatchEvent(new Event('input', { bubbles: true })); BF.ui.selectTab('home'); true");
    await waitFor(page, `document.querySelector('${HOME} .home-section-head h3').textContent === 'Projetos recentes'`, 10000, 'a Início de volta, sem busca');
    step('"Ver todos os resultados" abre Projetos com a busca e sem filtro de estado');

    // ---- os atalhos
    // Novo projeto não tem item no menu: a tela abre por este botão e acende o item Projetos
    const onNewProject = () => ev("(() => { const a = document.getElementById('app'); return [a.dataset.activeTab, a.dataset.activeMenu, document.getElementById('tab-projects').getAttribute('aria-selected'), document.getElementById('pageTitle').textContent, document.getElementById('tab-sources')].join('|'); })()");
    await ev(`document.querySelector('${HOME} [data-act=new]').click()`);
    assert.equal(await onNewProject(), 'sources|projects|true|Novo projeto|', '"Novo projeto" abre a tela Novo projeto (e acende Projetos)');
    await ev("BF.ui.selectTab('home')");
    await ev(`document.querySelector('${HOME} [data-act=new]').focus()`);
    await page.press('Enter');
    assert.equal(await onNewProject(), 'sources|projects|true|Novo projeto|', 'e o teclado também chega lá (Enter no botão)');
    await ev("BF.ui.selectTab('home')");
    step('"Novo projeto" leva à tela Novo projeto, pelo mouse e pelo teclado');

    assert.equal(await ev(`document.querySelector('${HOME} [data-act=resume]').title`), 'Abrir “Minecraft - Sobrevivência EP12”');
    await ev(`document.querySelector('${HOME} [data-act=resume]').click()`);
    await waitFor(page, `BF.state.project && BF.state.project.source.path === ${j(vMine)} && document.getElementById('video').readyState >= 1`, 30000, 'o projeto mais recente aberto');
    assert.equal(await ev("document.getElementById('app').dataset.activeTab"), 'cuts', '"Continuar de onde parou" segue para Cortes');
    step('"Continuar de onde parou" abre o projeto mais recente e vai para Cortes');

    // com um projeto aberto, a Início mostra "Aberto agora" e "Continuar"
    await ev("BF.ui.selectTab('home')");
    await waitFor(page, `[...document.querySelectorAll('${HOME} .prj-card')][0].querySelector('[data-act=open]').textContent === 'Continuar'`, 15000, 'o projeto aberto marcado');
    assert.ok((await cards())[0].chips.includes('Aberto agora'));
    assert.equal(await ev(`document.querySelectorAll('${HOME} .prj-card')[1].querySelector('[data-act=open]').textContent`), 'Abrir');
    await ev(`document.querySelectorAll('${HOME} .prj-card')[1].querySelector('[data-act=open]').click()`);
    await waitFor(page, `BF.state.project && BF.state.project.source.path === ${j(vNfs)}`, 30000, 'o segundo projeto aberto pelo cartão');
    assert.equal(await ev("document.getElementById('app').dataset.activeTab"), 'cuts');
    // o projeto aberto agora é o NFS: ele ganha "Aberto agora" quando a Início volta
    await ev("BF.ui.selectTab('home')");
    await waitFor(page, `[...document.querySelectorAll('${HOME} .prj-card')].find((c) => c.querySelector('.prj-title').textContent === 'NFS Most Wanted - Gameplay').querySelector('.prj-chips').textContent.includes('Aberto agora')`, 15000, '"Aberto agora" no projeto que abriu');
    step('"Abrir" num cartão abre o projeto e vai para Cortes; o projeto aberto mostra "Aberto agora" e "Continuar"');
    h.assertNoConsoleErrors(page, [/Autofill|favicon/i]);
    await app.stop(); app = null;

    // ---- o vídeo que sumiu: aviso no cartão, sem miniatura, sem abrir; o atalho de continuar pula para o próximo
    fs.rmSync(vNfs); // o mais recente (foi o último aberto: abrir um projeto o põe no topo)
    app = await h.launchApp(ud, {});
    ({ page } = app);
    await waitFor(page, `document.querySelectorAll('${HOME} .prj-card').length === 3`, 20000, 'os recentes (com o vídeo de um deles sumido)');
    await waitFor(page, `document.querySelectorAll('${HOME} .prj-thumb img').length === 2`, 40000, 'as 2 miniaturas dos vídeos que existem');
    const afterOpening = await cards();
    assert.deepEqual(afterOpening.map((c) => c.title), ['NFS Most Wanted - Gameplay', 'Minecraft - Sobrevivência EP12', '2026-10-20 21-00-00'], 'os projetos abertos nos passos anteriores subiram na lista: o último aberto é o primeiro');
    const missing = afterOpening[0];
    assert.ok(missing.chips.includes('Vídeo não encontrado'));
    assert.deepEqual(await ev(`(() => { const c = document.querySelector('${HOME} .prj-card'); return [c.querySelector('.prj-thumb').disabled, !!c.querySelector('[data-act=open]'), c.querySelector('[data-act=resolve]').textContent, !!c.querySelector('.prj-thumb img')]; })()`), [true, false, 'Ver em Projetos', false]);
    assert.equal(await ev(`document.querySelector('${HOME} [data-act=resume]').title`), 'Abrir “Minecraft - Sobrevivência EP12”', 'o atalho pula o vídeo que sumiu');
    await shot(page, 'inicio-video-sumido');
    await ev(`document.querySelector('${HOME} [data-act=resolve]').click()`);
    await waitFor(page, "document.getElementById('tab-projects').getAttribute('aria-selected') === 'true' && document.querySelector('#tabpanel-projects .prj-search').value === 'NFS Most Wanted - Gameplay'", 10000, 'Projetos aberta pelo cartão do vídeo sumido');
    assert.ok(await ev("!!document.querySelector('#tabpanel-projects [data-act=locate]')"), 'em Projetos dá para localizar o vídeo');
    step('vídeo que sumiu: aviso no cartão, sem miniatura e sem abrir; "Ver em Projetos" leva à busca; "Continuar" pula para o próximo');
    h.assertNoConsoleErrors(page, [/Autofill|favicon/i]);
    await app.stop(); app = null;

    // ---- primeira vez: perfil vazio
    const first = path.join(tmp, 'ud-vazio');
    app = await h.launchApp(first, {});
    ({ page } = app);
    await waitFor(page, `!!document.querySelector('${HOME} .home-empty')`, 20000, 'a explicação sem projetos');
    assert.equal(await ev(`document.querySelector('${HOME} .home-title').textContent`), 'Bem-vindo ao Braga Frame!');
    assert.equal(await ev(`document.querySelector('${HOME} .home-lead').textContent`), 'Comece trazendo um vídeo: arraste o arquivo para a janela ou use Novo projeto.');
    assert.deepEqual(await ev(`(() => [document.querySelector('${HOME} [data-act=resume]').getClientRects().length, document.querySelector('${HOME} [data-act=all]').getClientRects().length])()`), [0, 0], 'sem projetos não há "Continuar" nem "Ver todos"');
    assert.equal(await ev(`document.querySelector('${HOME} .home-empty strong').textContent`), 'Nenhum projeto ainda');
    await shot(page, 'inicio-primeira-vez');
    // abrir um vídeo e voltar à Início: o projeto novo está lá, "Aberto agora", e a saudação muda
    await ev(`BF.openSource(${j(vOld1)})`);
    await waitFor(page, `BF.state.project && BF.state.project.source.path === ${j(vOld1)}`, 30000, 'o vídeo aberto');
    await ev("BF.ui.selectTab('home')");
    await waitFor(page, `document.querySelectorAll('${HOME} .prj-card').length === 1 && document.querySelector('${HOME} .home-title').textContent === 'Bem-vindo de volta!'`, 15000, 'o projeto novo na lista e a saudação de volta');
    assert.deepEqual(await cards().then((c) => [c[0].title, c[0].chips]), ['Aula de música', ['Novo', 'Aberto agora']]);
    step('primeira vez: "Bem-vindo ao Braga Frame!" com a explicação; depois de abrir um vídeo a Início lista o projeto e diz "Bem-vindo de volta!"');
    h.assertNoConsoleErrors(page, [/Autofill|favicon/i]);
    await app.stop(); app = null;

    console.log('\nE2E DA TELA INÍCIO OK');
  } finally {
    try { if (app) await app.stop(); } catch { /* já fechado */ }
    h.removeDir(tmp);
  }
}

main().then(() => process.exit(0), (err) => { console.error(`\n✖ E2E FALHOU: ${err.stack || err.message}`); h.cleanupAll().finally(() => process.exit(1)); });

'use strict';

/**
 * E2E de usabilidade e acessibilidade (Etapa 5), no app Electron de verdade (perfil temporário, vídeo gerado):
 *  - cada tela lembra a própria rolagem (o painel é um só: a rolagem de uma aba não passa para a outra) e abre no topo da primeira vez;
 *  - revisão pelo teclado: A aprova e R rejeita o corte aberto e já abrem o próximo pendente, J/K e as setas andam pela lista, V toca o trecho;
 *    nada disso dispara digitando num campo nem em outra aba; as letras mudam em Preferências e duas ações na mesma letra não disputam a tecla;
 *  - alvos de clique de pelo menos 24 px (WCAG 2.2, 2.5.8) nos recolhíveis e nos links;
 *  - contraste (4,5:1 para texto, 3:1 para ícones) em todas as telas, nos dois temas;
 *  - foco visível: todo controle focável muda de aparência ao receber o foco do teclado;
 *  - nome acessível: nenhum botão, campo, seletor ou link visível fica sem nome para o leitor de tela.
 * Uso: node tests/e2e/ux.e2e.js
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { locateTools } = require('../../src/core/ffmpeg/locate');
const h = require('./helpers');

const ffmpeg = locateTools().ffmpeg;
const { waitFor, sleep } = h;
const step = (m) => console.log(`✔ ${m}`);
const j = JSON.stringify;
const TABS = ['home', 'projects', 'cuts', 'analysis', 'subtitles', 'audio', 'export', 'queue', 'general', 'prefs', 'tools'];

const { CONTRAST, SMALL, FOCUS, NAMELESS } = require('./a11y');

async function main() {
  const tmp = h.mkTemp('ux-');
  let app = null;
  try {
    const video = path.join(tmp, 'Minecraft - Aventura no deserto.mp4');
    h.makeSampleVideo(ffmpeg, video, { seconds: 40, size: '1280x720', rate: 15 });
    app = await h.launchApp(path.join(tmp, 'ud'), {});
    const { page } = app;
    const ev = (x) => page.eval(x);
    const typeKey = async (key, code, vk) => {
      const base = { key, code, windowsVirtualKeyCode: vk };
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(key.length === 1 ? { text: key } : {}) });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(120);
    };
    const letter = (c) => typeKey(c, `Key${c.toUpperCase()}`, c.toUpperCase().charCodeAt(0));
    const statuses = () => ev("JSON.stringify(BF.state.project.cuts.map((c) => c.title.slice(0, 1) + ':' + c.status))").then(JSON.parse);
    const active = () => ev('BF.review.activeId()');

    await waitFor(page, "document.getElementById('app')", 20000, 'app');
    await ev(`BF.openSource(${j(video)})`);
    await waitFor(page, "BF.state.project && document.getElementById('video').readyState >= 1", 30000, 'vídeo');
    for (const [title, start, end] of [['A Perseguição', 2, 9], ['B Pulo épico', 11, 18], ['C Fuga', 20, 27], ['D Final', 30, 37]]) {
      await ev(`BF.project.addCut({ title: ${j(title)}, start: ${start}, end: ${end}, status: 'pending' })`);
    }

    // ---- rolagem por tela
    await ev("BF.ui.selectTab('analysis')");
    await sleep(500);
    const room = await ev("(() => { const s = document.getElementById('tabPanels'); return s.scrollHeight - s.clientHeight; })()");
    assert.ok(room > 400, `a Análise precisa de rolagem para o teste (sobram ${room} px)`);
    await ev("document.getElementById('tabPanels').scrollTop = 300");
    await ev("BF.ui.selectTab('export')");
    await sleep(400);
    assert.equal(await ev("document.getElementById('tabPanels').scrollTop"), 0, 'o Exportar abre no topo, não onde a Análise parou');
    await ev("document.getElementById('tabPanels').scrollTop = 150");
    await ev("BF.ui.selectTab('analysis')");
    await sleep(400);
    assert.equal(await ev("document.getElementById('tabPanels').scrollTop"), 300, 'a Análise volta para onde estava');
    await ev("BF.ui.selectTab('export')");
    await sleep(400);
    assert.equal(await ev("document.getElementById('tabPanels').scrollTop"), 150, 'o Exportar também');
    step('cada tela lembra a própria rolagem e abre no topo da primeira vez');

    // ---- revisão pelo teclado
    await ev("BF.ui.selectTab('cuts')");
    await sleep(500);
    await ev('document.activeElement && document.activeElement.blur()');
    const ids = await ev("JSON.stringify(BF.state.project.cuts.map((c) => c.id))").then(JSON.parse);
    await ev(`BF.review.select(${j(ids[0])}, { seek: false })`);
    await sleep(200);
    await letter('a');
    assert.deepEqual(await statuses(), ['A:approved', 'B:pending', 'C:pending', 'D:pending']);
    assert.equal(await active(), ids[1], 'aprovar abre o próximo pendente');
    await letter('r');
    assert.deepEqual(await statuses(), ['A:approved', 'B:rejected', 'C:pending', 'D:pending']);
    assert.equal(await active(), ids[2], 'rejeitar também');
    await letter('j');
    assert.equal(await active(), ids[3], 'J abre o próximo da lista');
    await letter('k');
    assert.equal(await active(), ids[2], 'K abre o anterior');
    await typeKey('ArrowDown', 'ArrowDown', 40);
    assert.equal(await active(), ids[3], 'a seta para baixo também');
    await typeKey('ArrowUp', 'ArrowUp', 38);
    assert.equal(await active(), ids[2], 'a seta para cima também');
    await letter('d'); // tecla sem ação
    assert.equal(await active(), ids[2]);
    await letter('v');
    await waitFor(page, "Math.abs(BF.player.video.currentTime - 20) < 1.5 && !BF.player.video.paused", 8000, 'V tocar o trecho do corte aberto (20 s)');
    await ev('BF.player.pause()');
    await ev(`BF.review.select(${j(ids[3])}, { seek: false })`);
    await letter('a');
    assert.deepEqual(await statuses(), ['A:approved', 'B:rejected', 'C:pending', 'D:approved']);
    assert.equal(await active(), ids[2], 'sem pendente depois, abre o primeiro pendente antes (C)');
    await letter('a');
    assert.deepEqual(await statuses(), ['A:approved', 'B:rejected', 'C:approved', 'D:approved']);
    assert.match(await ev("document.getElementById('log').textContent"), /Todos os cortes da lista já foram decididos/);
    await ev('BF.review.engine.undo(); BF.review.engine.undo(); true');
    await sleep(200);
    step('A/R decidem e abrem o próximo pendente; J/K e as setas andam; V toca o trecho; no fim avisa que tudo foi decidido');

    // não dispara digitando num campo nem em outra aba
    const before = await statuses();
    await ev(`BF.review.select(${j(ids[2])}, { seek: false })`);
    const field = await ev("(() => { const i = [...document.querySelectorAll('#tabpanel-cuts input')].find((n) => n.offsetParent && (n.type === 'text' || n.type === 'search' || !n.type)); if (!i) return false; i.focus(); return true; })()");
    if (field) {
      await letter('r');
      assert.deepEqual(await statuses(), before, 'digitando num campo as letras são do campo');
    }
    await ev('document.activeElement && document.activeElement.blur()');
    await ev("BF.ui.selectTab('analysis')");
    await sleep(300);
    await letter('r');
    assert.deepEqual(await statuses(), before, 'em outra aba a letra não decide corte nenhum');
    await ev("BF.ui.selectTab('cuts')");
    step('as letras não disparam digitando num campo nem em outra aba');

    // letras configuráveis
    await ev("BF.prefs.set('review.key.approve', 'x')");
    await sleep(300);
    assert.match(await ev("document.querySelector('#tabpanel-cuts .shortcuts').textContent"), /X \/ R: aprovam e rejeitam/, 'o quadro de atalhos mostra a letra nova');
    await ev('document.activeElement && document.activeElement.blur()');
    await ev(`BF.review.select(${j(ids[2])}, { seek: false })`);
    await letter('a');
    assert.deepEqual(await statuses(), before, 'A deixou de aprovar');
    await letter('x');
    assert.equal((await statuses())[2], 'C:approved', 'X passou a aprovar');
    await ev('BF.review.engine.undo(); true');
    await ev("BF.prefs.set('review.key.reject', 'x')"); // conflito: aprovar já ficou com X; rejeitar volta ao R
    await sleep(300);
    await ev(`BF.review.select(${j(ids[2])}, { seek: false })`);
    await letter('r');
    assert.equal((await statuses())[2], 'C:rejected', 'duas ações na mesma letra: a segunda volta ao padrão dela');
    await ev("BF.prefs.unset('review.key.approve'); BF.prefs.unset('review.key.reject'); true");
    await sleep(300);
    step('as letras mudam em Preferências; conflito entre duas ações não disputa a tecla');

    // ---- a verificação de nome acessível enxerga de verdade: um botão sem nome é apontado, um com aria-label não
    await ev("(() => { const a = document.createElement('button'); a.id = 'ux-probe-a'; const b = document.createElement('button'); b.id = 'ux-probe-b'; b.setAttribute('aria-label', 'Sonda'); document.body.append(a, b); return true; })()");
    const probe = JSON.parse(await ev(NAMELESS));
    await ev("document.getElementById('ux-probe-a').remove(); document.getElementById('ux-probe-b').remove(); true");
    assert.ok(probe.some((x) => x.includes('#ux-probe-a')), 'a checagem de nome acessível aponta o botão sem nome');
    assert.ok(!probe.some((x) => x.includes('#ux-probe-b')), 'e aceita o que tem aria-label');

    // ---- alvos, contraste e foco, em todas as telas e nos dois temas
    for (const theme of ['dark', 'light']) {
      await ev(`BF.ui.setTheme(${j(theme)})`);
      await sleep(300);
      for (const tab of TABS) {
        await ev(`BF.ui.selectTab(${j(tab)})`);
        await sleep(450);
        const small = JSON.parse(await ev(SMALL));
        assert.deepEqual(small, [], `${theme}/${tab}: alvos com menos de 24 px de altura`);
        assert.deepEqual(JSON.parse(await ev(NAMELESS)), [], `${theme}/${tab}: controles sem nome para o leitor de tela`);
        const contrast = JSON.parse(await ev(CONTRAST));
        assert.deepEqual(contrast, [], `${theme}/${tab}: contraste abaixo do mínimo`);
        if (theme === 'dark') {
          const focus = JSON.parse(await ev(FOCUS));
          assert.deepEqual(focus.bad, [], `${tab}: controles sem foco visível (de ${focus.checked})`);
        }
      }
    }
    step('24 px de alvo, contraste (4,5:1 texto, 3:1 ícones) e foco visível em todas as telas, nos dois temas');

    h.assertNoConsoleErrors(page, [/Autofill|favicon|MEDIA_ELEMENT_ERROR/i]);
    await app.stop(); app = null;
    console.log('\nE2E DE USABILIDADE OK');
  } finally {
    try { if (app) await app.stop(); } catch { /* já fechado */ }
    h.removeDir(tmp);
  }
}

main().then(() => process.exit(0), (err) => { console.error(`\n✖ E2E FALHOU: ${err.stack || err.message}`); h.cleanupAll().finally(() => process.exit(1)); });

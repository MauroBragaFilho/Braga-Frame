'use strict';

/**
 * Teste de ponta a ponta da base: abre o app Electron real (perfil de usuário temporário), controla a
 * interface pelo DevTools Protocol e confere os arquivos gerados com ffprobe. Uso: node tests/e2e/app.e2e.js
 * (ou `npm run test:e2e -- app`). A exportação segue o fluxo real: aba Exportar -> "Adicionar à fila" -> aba Fila
 * (pulado se já exportado, conflito de nome, 1440p H.265, pasta escolhida) -> arquivo conferido com ffprobe.
 * Para guardar uma captura da janela: BF_E2E_SHOT=C:\caminho\captura.png node tests/e2e/app.e2e.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { locateTools } = require('../../src/core/ffmpeg/locate');
const { probeMedia } = require('../../src/core/ffmpeg/probe');
const { ProjectStore, newProject, projectIdFor } = require('../../src/core/projects/projectStore');
const h = require('./helpers');

const { sleep, waitFor, answerModal } = h;
const tools = locateTools();
const J = JSON.stringify;

const setValue = (page, id, value, evt = 'input') => page.eval(`(() => { const e = document.getElementById(${J(id)}); e.value = ${J(value)}; e.dispatchEvent(new Event(${J(evt)}, { bubbles: true })); })()`);
const logText = (page) => page.eval("document.getElementById('log').textContent");
const clickCutButton = (page, index, label) => page.eval(`(() => { const items = document.querySelectorAll('#cuts .cut'); [...items[${index}].querySelectorAll('button')].find((b) => b.textContent === ${J(label)}).click(); })()`);
const saveProject = (page) => page.eval('BF.project.flush()');

// ---- fluxo real de exportação: aba Exportar -> "Adicionar à fila" -> aba Fila -> arquivo conferido com ffprobe ----

/** Linhas da aba Fila (um `li.q-job` por trabalho): estado, título do corte, texto e botões habilitados. */
const queueRows = (page) => page.eval(`[...document.querySelectorAll('#tabpanel-queue li.q-job')].map((li) => ({
  id: li.dataset.id, state: li.dataset.state, name: li.querySelector('.q-name').textContent, text: li.textContent,
  acts: [...li.querySelectorAll('button')].filter((b) => !b.disabled).map((b) => b.dataset.act)
}))`);
const waitQueueRow = (page, title, state, timeout = 120000) => waitFor(page,
  `[...document.querySelectorAll('#tabpanel-queue li.q-job')].some((li) => li.querySelector('.q-name').textContent === ${J(title)} && li.dataset.state === ${J(state)})`,
  timeout, `"${title}" ficar "${state}" na aba Fila`);
/** Clica no botão `act` da primeira linha da fila que está em `state`. */
const clickQueueAct = (page, state, act) => page.eval(`(() => {
  const li = document.querySelector('#tabpanel-queue li.q-job[data-state=${J(state)}]');
  const b = li && li.querySelector('button[data-act=${J(act)}]');
  if (!b || b.disabled) throw new Error('botão ${act} indisponível numa linha "${state}"');
  b.click();
})()`);
/** Responde ao diálogo de conflito de nome da fila (`skip`, `rename` ou `replace`). */
async function answerConflict(page, action) {
  await waitFor(page, "!!document.querySelector('.bf-modal.q-conflict')", 20000, 'o diálogo de conflito de nome da fila');
  const msg = await page.eval("document.querySelector('.q-conflict .bf-modal-msg').textContent");
  await page.eval(`document.querySelector('.q-conflict [data-act=${action}]').click()`);
  await waitFor(page, "!document.querySelector('.bf-modal')", 10000, 'o diálogo fechar');
  return msg;
}
/** Aba Exportar: espera a conferência (QC) e o botão "Adicionar à fila (N)", clica e confere que foi para a aba Fila. */
async function addToQueue(page, count) {
  await page.eval("BF.ui.selectTab('export')");
  await waitFor(page, `(() => { const b = document.getElementById('exp-enqueue'); return !!b && !b.disabled && b.textContent === ${J(`Adicionar à fila (${count})`)} && /pronto/.test(document.getElementById('exp-qc-status').textContent); })()`,
    40000, `botão "Adicionar à fila (${count})" liberado depois da conferência`);
  await page.eval("document.getElementById('exp-enqueue').click()");
  await waitFor(page, "document.getElementById('tab-queue').getAttribute('aria-selected') === 'true'", 20000, 'ir para a aba Fila');
}
const kbpsToSlider = (k) => Math.round((Math.log(k / 500) / Math.log(300)) * 1000); // barra de bitrate: escala logarítmica de 0,5 a 150 Mbps

async function main() {
  assert.ok(tools.ffmpeg && tools.ffprobe, 'ffmpeg/ffprobe necessários para o teste');
  const tmp = h.mkTemp('e2e-app');
  const userData = path.join(tmp, 'userdata');
  const source = path.join(tmp, 'gameplay.mp4');
  const out = path.join(tmp, 'Cortes');
  const step = (m) => console.log(`✔ ${m}`);

  try {
    h.makeSampleVideo(tools.ffmpeg, source, { seconds: 20, size: '1920x1080', rate: 30 });
    step('vídeo de teste 1080p gerado');

    let app = await h.launchApp(userData);
    let page = app.page;
    step('app Electron aberto (porta de depuração dinâmica)');

    // ---- instância única: abrir o app de novo no mesmo perfil não cria outra janela nem disputa a fila e os projetos ----
    const second = await h.runSecondInstance(userData);
    assert.equal(second.exitCode, 0, `a segunda instância deveria sair sozinha (código ${second.exitCode} depois de ${second.ms} ms)`);
    assert.equal(app.proc.exitCode, null, 'a primeira instância continua aberta');
    assert.equal(await page.eval("document.getElementById('appName').textContent"), 'Braga Frame', 'e respondendo');
    const debugPort = (h.readPortFile(path.join(userData, 'DevToolsActivePort')) || '').split(/\r?\n/)[0];
    const windows = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).filter((t) => t.type === 'page');
    assert.equal(windows.length, 1, 'continua uma janela só');
    step(`segunda instância no mesmo perfil encerra sozinha em ${(second.ms / 1000).toFixed(1)} s (código 0); a primeira segue com uma janela`);

    assert.equal(await page.eval("document.getElementById('appName').textContent"), 'Braga Frame');
    assert.equal(await page.eval("document.getElementById('toolsWarn').hidden"), true, 'ffmpeg deveria ter sido encontrado');
    assert.deepEqual(await page.eval('BF.state.loadErrors'), [], 'todos os handlers do processo principal carregaram');

    // ---- ponte segura e contrato do renderer ----
    assert.equal(await page.eval('typeof window.corte'), 'undefined', 'window.corte foi removido');
    assert.deepEqual(await page.eval('Object.keys(window.bf).sort()'), ['invoke', 'on', 'pathForFile']);
    assert.equal(await page.eval("window.bf.invoke('canal-invalido').then(() => 'aceitou', (e) => /Canal IPC inválido/.test(e.message) ? 'recusou' : e.message)"), 'recusou');
    const missing = await page.eval("BF.api('naoexiste:acao')");
    assert.deepEqual([missing.ok, missing.code], [false, 'IPC_ERROR'], 'canal sem handler vira { ok:false }');
    assert.equal(await page.eval("['state','bus','api','on','project','ui','player','hooks','prefs','util','openSource'].every((k) => k in BF)"), true);
    assert.equal(await page.eval("['log','toast','confirm','prompt','registerTab','selectTab'].every((k) => typeof BF.ui[k] === 'function')"), true);
    assert.equal(await page.eval("['fmt','parseTime','el','debounce'].every((k) => typeof BF.util[k] === 'function')"), true);
    assert.equal(await page.eval("BF.prefs.get('analysis.minRelevance', 0.5)"), 0.5, 'BF.prefs devolve o fallback');
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#tabBar [role=tab]')].map((b) => b.dataset.tab)"),
      ['home', 'projects', 'editor', 'queue', 'settings'], 'o menu tem 5 itens (Novo projeto abre pelos botões, sem item)');
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#tabBar [role=tab]')].map((b) => b.querySelector('.tab-label').textContent)"),
      ['Início', 'Projetos', 'Cortes', 'Exportações', 'Configurações']);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#subTabs .subtab')].map((b) => b.dataset.tab)"),
      ['cuts', 'analysis', 'subtitles', 'audio', 'export', 'general', 'prefs', 'tools'], 'as telas de Cortes e de Configurações são abas internas, na ordem do desenho');
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#subTabs .subtab-label')].map((n) => n.textContent)"),
      ['Cortes', 'Análise', 'Legendas', 'Áudio', 'Exportar', 'Geral', 'Preferências', 'Ferramentas']);
    assert.equal(await page.eval("document.querySelector('#timelineSlot').previousElementSibling.id"), 'rangeInfo', '#timelineSlot fica abaixo do player');
    step('contrato do renderer: window.bf sem window.corte, BF.*, menu de 5 itens e abas internas na ordem de 1.4, #timelineSlot');

    // itens e abas: o painel aparece sem projeto; o que exige projeto (o item Cortes e as abas dele) fica desabilitado, o resto funciona
    assert.deepEqual(await page.eval("['home','projects','queue','settings','general','prefs','tools'].map((id) => document.getElementById('tab-' + id).disabled)"), [false, false, false, false, false, false, false]);
    assert.deepEqual(await page.eval("['editor','cuts','export','subtitles','audio','analysis'].map((id) => document.getElementById('tab-' + id).disabled)"), [true, true, true, true, true, true]);
    assert.equal(await page.eval("document.getElementById('tab-sources')"), null, 'Novo projeto não tem botão de menu');
    assert.equal(await page.eval("document.getElementById('tab-home').getAttribute('aria-selected')"), 'true', 'sem projeto a aba inicial é Início');
    assert.equal(await page.eval("BF.ui.selectTab('cuts')"), false, 'aba que exige projeto não abre sem projeto');
    await page.eval("BF.ui.selectTab('queue')");
    assert.deepEqual(await page.eval("[document.getElementById('tabpanel-queue').hidden, document.getElementById('tabpanel-sources').hidden, document.getElementById('tab-queue').getAttribute('aria-selected')]"), [false, true, 'true']);
    assert.equal(await page.eval("BF.ui.selectTab('nao-existe')"), false);
    await page.eval("BF.ui.selectTab('sources')");

    // teclado sem projeto: setas/Home/End só passam pelos itens utilizáveis (Exportações fica depois do item Cortes desabilitado e era inalcançável)
    const keyTrail = async (keys) => { const seen = []; for (const key of keys) { await page.press(key); seen.push(await page.eval('document.activeElement.id')); } return seen; };
    await page.eval("document.getElementById('tab-projects').focus()"); // Novo projeto (aberta) acende o item Projetos
    assert.deepEqual(await keyTrail(['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight']), ['tab-queue', 'tab-settings', 'tab-home', 'tab-projects']);
    assert.deepEqual(await keyTrail(['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft']), ['tab-home', 'tab-settings', 'tab-queue', 'tab-projects']);
    assert.deepEqual(await keyTrail(['Home', 'End']), ['tab-home', 'tab-settings']);
    assert.equal(await page.eval("document.getElementById('tab-settings').getAttribute('aria-selected')"), 'true', 'o foco acompanha a seleção');
    assert.equal(await page.eval("document.getElementById('app').dataset.activeTab"), 'general', 'Configurações abre pela primeira aba (Geral)');
    await page.eval("document.getElementById('tab-general').focus()");
    assert.deepEqual(await keyTrail(['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowLeft']), ['tab-prefs', 'tab-tools', 'tab-general', 'tab-tools'], 'nas abas internas as setas ←/→ dão a volta');
    await page.eval("BF.ui.selectTab('sources')");
    step('sem projeto: Início, Projetos, Exportações e Configurações (com Preferências e Ferramentas) são alcançáveis só com o teclado (setas, Home, End), sem parar no item Cortes desabilitado');

    // ---- identidade visual (família do BDS): fontes locais, ícones, telas largas, indicador de estado, barras deslizantes ----
    const css = (selector, prop) => page.eval(`getComputedStyle(document.querySelector(${J(selector)})).getPropertyValue(${J(prop)})`);
    const reload = async (url) => {
      await page.eval('window.__marker = 1; true');
      await page.send(url ? 'Page.navigate' : 'Page.reload', url ? { url } : {});
      await waitFor(page, "window.__marker === undefined && document.readyState === 'complete' && !!window.BF", 30000, 'página recarregada');
      await page.eval('BF.ready.then(() => true)');
      await sleep(300);
    };
    assert.equal(await page.eval("document.fonts.check('16px \"Material Symbols Rounded\"') && document.fonts.check('700 16px Montserrat') && document.fonts.check('14px Inter')"), true, 'fontes locais (Inter, Montserrat, Material Symbols) carregadas');
    assert.equal(await page.eval("[...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/\"/g, '')).sort().join(',')"), 'Inter,Inter,Material Symbols Rounded,Montserrat', 'as quatro fontes empacotadas foram usadas');
    assert.equal(await css('.page-title', 'font-family'), 'Montserrat, "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif', 'título em Montserrat');
    assert.equal(await css('body', 'font-family').then((f) => f.startsWith('Inter')), true, 'texto em Inter');
    const iconWidths = await page.eval("[...document.querySelectorAll('#tabBar .material-symbols-rounded')].map((i) => Math.round(i.getBoundingClientRect().width))");
    assert.equal(iconWidths.length, 5, 'um ícone por item do menu');
    assert.ok(iconWidths.every((w) => w >= 18 && w <= 26), `ícones desenhados pela fonte (e não o nome do ícone como texto): larguras ${iconWidths}`);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#tabBar [role=tab]')].map((b) => b.querySelector('.material-symbols-rounded').textContent)"),
      ['home', 'folder_special', 'content_cut', 'queue', 'settings'], 'ícone de cada item do menu');
    assert.equal(await css('#tab-editor', 'opacity'), '0.4', 'item desabilitado (sem projeto) fica esmaecido');
    assert.equal(await page.eval("document.getElementById('tab-editor').title"), 'Abra um vídeo para usar esta aba');
    assert.deepEqual(await page.eval("['body','#app','.sidebar','.panel-probe'].map((s) => document.querySelector(s) && getComputedStyle(document.querySelector(s)).backgroundColor)"), ['rgb(0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgb(28, 28, 28)', null], 'tema escuro: fundo #000, menu #1c1c1c');
    // tela larga: o player não aparece, o painel ocupa a área e a tela Novo projeto é a de boas-vindas (a pergunta, os cartões e a área de soltar)
    assert.deepEqual(await page.eval("[document.getElementById('app').dataset.viewKind, document.getElementById('app').dataset.activeTab, document.getElementById('pageTitle').textContent]"), ['wide', 'sources', 'Novo projeto']);
    assert.equal(await page.eval("document.querySelector('.player').getBoundingClientRect().width"), 0, 'sem projeto o player não ocupa espaço');
    assert.match(await page.eval("document.querySelector('#tabpanel-sources .src-question').textContent"), /Como deseja adicionar o seu vídeo\?/);
    assert.equal(await page.eval("document.querySelectorAll('#tabpanel-sources .src-choice').length"), 4, 'quatro cartões: arquivos, YouTube, Twitch e OBS');
    assert.equal(await page.eval("document.querySelector('#tabpanel-sources .src-drop').getBoundingClientRect().height > 100"), true, 'sem projeto a área de soltar está à vista');
    assert.equal(await page.eval("document.getElementById('empty')"), null, 'a faixa de boas-vindas deu lugar à tela Novo projeto');
    await page.eval("BF.ui.selectTab('queue')");
    assert.deepEqual(await page.eval("[document.getElementById('app').dataset.viewKind, document.getElementById('pageTitle').textContent]"), ['wide', 'Exportações']);
    await page.eval("BF.ui.selectTab('sources')");
    // indicador de estado do rodapé do menu segue BF.ui.log (verde, âmbar, vermelho) e é um bloco acessível
    assert.deepEqual(await page.eval("[document.getElementById('toolState').dataset.kind, document.getElementById('stateText').textContent]"), ['ok', 'Pronto']);
    await page.eval("BF.ui.log('Falhou de propósito.', 'error')");
    assert.deepEqual(await page.eval("[document.getElementById('toolState').dataset.kind, document.getElementById('stateText').textContent, document.getElementById('log').className, document.getElementById('toolState').title]"), ['error', 'Erro', 'log error', 'Falhou de propósito.']);
    assert.equal(await css('#stateDot', 'background-color'), 'rgb(255, 82, 82)', 'ponto vermelho no erro');
    await page.eval("BF.ui.log('Atenção de propósito.', 'warn')");
    assert.deepEqual(await page.eval("[document.getElementById('toolState').dataset.kind, document.getElementById('stateText').textContent]"), ['warn', 'Atenção']);
    await page.eval("BF.ui.log('Tudo certo.', 'ok')");
    assert.deepEqual(await page.eval("[document.getElementById('toolState').dataset.kind, document.getElementById('stateText').textContent, document.getElementById('log').textContent]"), ['ok', 'Pronto', 'Tudo certo.']);
    assert.equal(await css('#stateDot', 'background-color'), 'rgb(46, 125, 50)', 'ponto verde quando pronto');
    await page.eval("BF.ui.setState({ kind: 'busy', text: 'Exportando…' })");
    assert.deepEqual(await page.eval("[document.getElementById('toolState').dataset.kind, document.getElementById('stateText').textContent]"), ['busy', 'Exportando…'], 'as features podem marcar "ocupado"');
    await page.eval("BF.ui.setState({ kind: 'ok' })");
    // mostrar/esconder a mensagem nunca desloca a tela (um clique em andamento não pode "fugir" do botão)
    await page.eval("BF.ui.log('', '')");
    const workspaceBox = () => page.eval("(() => { const r = document.getElementById('workspace').getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; })()");
    const quietBox = await workspaceBox();
    await page.eval("BF.ui.log('Uma mensagem bem longa só para conferir que a pílula de estado não empurra o conteúdo nem muda a altura da área de trabalho.', 'error')");
    assert.deepEqual(await workspaceBox(), quietBox, 'a mensagem de estado não desloca a área de trabalho');
    // erro some só ao clicar; informativo some sozinho (classe idle) — aqui só o clique, para não esperar
    await page.eval("BF.ui.log('Erro para descartar.', 'error')");
    assert.equal(await css('#log', 'display'), 'block', 'erro visível na pílula de estado do cabeçalho');
    await page.eval("document.getElementById('log').click()");
    assert.deepEqual(await page.eval("[getComputedStyle(document.getElementById('log')).display, document.getElementById('stateText').textContent]"), ['none', 'Pronto'], 'clique descarta o erro e volta o indicador');
    await page.eval("BF.ui.log('', '')");
    // barras deslizantes: o preenchimento (--slider-value) acompanha o valor, inclusive quando ele muda por código e quando o slider nasce depois
    await page.eval(`(() => { const r = document.createElement('input'); r.type = 'range'; r.id = 'probeRange'; r.min = '0'; r.max = '200'; r.value = '50'; document.body.append(r); return true; })()`);
    await sleep(50);
    assert.equal(await page.eval("document.getElementById('probeRange').style.getPropertyValue('--slider-value')"), '25%', 'slider criado depois: sincronizado');
    await page.eval("document.getElementById('probeRange').value = 150; true");
    assert.equal(await page.eval("document.getElementById('probeRange').style.getPropertyValue('--slider-value')"), '75%', 'valor atribuído por código: sincronizado na hora');
    await page.eval("document.getElementById('probeRange').max = '300'; true");
    await sleep(50);
    assert.equal(await page.eval("document.getElementById('probeRange').style.getPropertyValue('--slider-value')"), '50%', 'mudar o max também atualiza');
    await page.eval("document.getElementById('probeRange').remove(); true");
    step('identidade do BDS: fontes locais, ícones por ligadura, tema escuro #000/#1c1c1c, tela larga com a tela Novo projeto de boas-vindas, indicador de estado e barras deslizantes');

    // janela sem moldura: o app desenha os controles e a barra é a região de arrasto
    assert.ok(await page.eval('Math.abs(window.outerHeight - window.innerHeight) <= 16 && Math.abs(window.outerWidth - window.innerWidth) <= 16'), 'janela sem moldura nem barra de título do sistema');
    assert.equal(await css('.global-header', '-webkit-app-region'), 'drag');
    assert.equal(await css('.header-actions', '-webkit-app-region'), 'no-drag', 'o botão Abrir vídeo e os controles ficam na área que não arrasta');
    assert.equal(await css('#win-close', '-webkit-app-region'), 'no-drag');
    assert.equal(await css('.page-title', 'font-size'), '26px');
    assert.equal(await page.eval("document.querySelector('.global-header').getBoundingClientRect().height"), 64, 'cabeçalho de 64px');
    assert.equal(await page.eval("document.querySelector('.sidebar').getBoundingClientRect().width"), 240, 'menu de 240px');
    const winState = () => page.eval("BF.api('window:state').then((s) => ({ max: s.maximized, full: s.fullscreen, min: s.minimized, mark: document.getElementById('app').dataset.windowState, maxTitle: document.getElementById('win-max').title, fullTitle: document.getElementById('win-full').title }))");
    const initialWin = await winState();
    assert.deepEqual([initialWin.max, initialWin.full, initialWin.min], [false, false, false]);
    assert.deepEqual([initialWin.mark, initialWin.maxTitle, initialWin.fullTitle], ['normal', 'Maximizar', 'Tela cheia']);
    await page.eval("document.getElementById('win-max').click()");
    await waitFor(page, "document.getElementById('app').dataset.windowState === 'maximized'", 10000, 'janela maximizada (evento window:changed)');
    const maxed = await winState();
    assert.deepEqual([maxed.max, maxed.maxTitle], [true, 'Restaurar'], 'maximizar muda o estado e o botão passa a restaurar');
    assert.equal(await page.eval("document.getElementById('win-max').firstElementChild.textContent"), 'filter_none');
    await page.eval("document.getElementById('win-max').click()");
    await waitFor(page, "document.getElementById('app').dataset.windowState === 'normal'", 10000, 'janela restaurada');
    assert.deepEqual([(await winState()).max, (await winState()).maxTitle], [false, 'Maximizar']);
    await page.eval("document.getElementById('win-full').click()");
    await waitFor(page, "document.getElementById('app').dataset.windowState === 'fullscreen'", 10000, 'tela cheia');
    assert.deepEqual([(await winState()).full, (await winState()).fullTitle], [true, 'Sair da tela cheia']);
    await page.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await waitFor(page, "document.getElementById('app').dataset.windowState === 'normal'", 10000, 'Esc sai da tela cheia');
    assert.equal((await winState()).full, false);
    assert.equal((await page.eval("BF.api('window:minimize').then((r) => r.ok && r.minimized)")), true, 'minimizar responde com o estado');
    await page.eval("BF.api('window:maximize')"); // restaura a janela minimizada (maximizar traz de volta) e volta ao normal
    await waitFor(page, "document.getElementById('app').dataset.windowState === 'maximized'", 10000, 'janela de volta depois de minimizar');
    await page.eval("BF.api('window:maximize')");
    await waitFor(page, "document.getElementById('app').dataset.windowState === 'normal'", 10000, 'janela normal de novo');
    step('janela sem moldura: cabeçalho de 64px é região de arrasto, controles no-drag; maximizar/restaurar, tela cheia (botão e Esc) e minimizar mudam o estado');

    // menu lateral: recolhe, lembra a escolha entre execuções e a marca expande de novo
    assert.equal(await page.eval("[document.getElementById('app').classList.contains('collapsed'), document.getElementById('sidebarToggleBtn').getAttribute('aria-expanded')]").then(String), 'false,true');
    await page.eval("document.getElementById('sidebarToggleBtn').click()");
    await sleep(500);
    assert.equal(await page.eval("document.getElementById('app').classList.contains('collapsed')"), true);
    assert.equal(await page.eval("Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)"), 64, 'trilho de 64px');
    assert.equal(await css('#tab-queue .tab-label', 'display'), 'none', 'só ícones no trilho');
    assert.equal(await page.eval("document.getElementById('tab-queue').title"), 'Exportações', 'o título vira dica no trilho');
    assert.equal(await page.eval("document.getElementById('tab-queue').getAttribute('aria-label')"), 'Exportações', 'e continua com nome acessível');
    assert.equal(await page.eval("window.localStorage.getItem('bf.sidebarCollapsed')"), '1');
    await reload();
    assert.equal(await page.eval("document.getElementById('app').classList.contains('collapsed')"), true, 'lembra o menu recolhido depois de reabrir');
    await page.eval("document.querySelector('.brand').click()"); // recolhido, a marca expande
    await sleep(500);
    assert.deepEqual(await page.eval("[document.getElementById('app').classList.contains('collapsed'), Math.round(document.querySelector('.sidebar').getBoundingClientRect().width), window.localStorage.getItem('bf.sidebarCollapsed'), document.getElementById('tab-queue').title]"), [false, 240, '0', '']);
    step('menu lateral recolhe para o trilho de 64px, a escolha persiste ao recarregar e a marca expande de novo');

    // tema claro/escuro: alterna, muda as cores pelos mesmos tokens e persiste
    assert.deepEqual(await page.eval("[document.documentElement.getAttribute('data-theme'), document.getElementById('btnTheme').getAttribute('aria-label'), document.getElementById('btnTheme').firstElementChild.textContent]"), ['dark', 'Usar tema claro', 'light_mode']);
    await page.eval("document.getElementById('btnTheme').click()");
    await sleep(400); // as cores têm transição curta
    assert.deepEqual(await page.eval("[document.documentElement.getAttribute('data-theme'), getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector('.sidebar')).backgroundColor, document.getElementById('btnTheme').getAttribute('aria-label'), window.localStorage.getItem('bf.theme')]"),
      ['light', 'rgb(244, 244, 244)', 'rgb(255, 255, 255)', 'Usar tema escuro', 'light']);
    assert.deepEqual(await page.eval("[getComputedStyle(document.getElementById('btnOpen')).backgroundColor, getComputedStyle(document.getElementById('btnOpen')).color]"), ['rgb(0, 0, 0)', 'rgb(255, 255, 255)'], 'tema claro: botão primário preto com texto branco');
    await reload();
    assert.equal(await page.eval("document.documentElement.getAttribute('data-theme')"), 'light', 'lembra o tema depois de reabrir');
    await page.eval("document.getElementById('btnTheme').click()");
    await sleep(400);
    assert.deepEqual(await page.eval("[document.documentElement.getAttribute('data-theme'), getComputedStyle(document.body).backgroundColor, getComputedStyle(document.getElementById('btnOpen')).backgroundColor, getComputedStyle(document.getElementById('btnOpen')).color, window.localStorage.getItem('bf.theme')]"),
      ['dark', 'rgb(0, 0, 0)', 'rgb(255, 255, 255)', 'rgb(0, 0, 0)', 'dark'], 'tema escuro: botão primário branco com texto preto');
    step('tema claro/escuro alterna pelos tokens (fundo #000/#f4f4f4, botão primário branco/preto) e persiste ao recarregar');

    // modo embutido (?embedded=1): sem marca nem controles de janela, menu em trilho de ícones, o app não age como dono da janela
    const baseUrl = (await page.eval('location.href')).split(/[?#]/)[0];
    await reload(`${baseUrl}?embedded=1`);
    assert.deepEqual(await page.eval("[BF.embedded, document.getElementById('app').classList.contains('embedded'), document.getElementById('app').classList.contains('collapsed')]"), [true, true, false]);
    assert.deepEqual(await page.eval("['#windowControls', '.brand', '#sidebarToggleBtn'].map((s) => getComputedStyle(document.querySelector(s)).display === 'none' || document.querySelector(s).hidden)"), [true, true, true], 'sem controles de janela, sem marca e sem botão de recolher');
    assert.equal(await page.eval("Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)"), 64, 'menu vira trilho de ícones de 64px');
    assert.equal(await css('.global-header', '-webkit-app-region'), 'no-drag', 'não é dono da janela: sem região de arrasto');
    assert.equal(await page.eval("document.getElementById('tab-home').getAttribute('aria-selected')"), 'true', 'continua funcionando (aba Início, sem projeto)');
    await page.eval("document.getElementById('tab-queue').click()");
    assert.equal(await page.eval("document.getElementById('app').dataset.viewKind + '/' + document.getElementById('pageTitle').textContent"), 'wide/Exportações');
    assert.equal(await page.eval("window.localStorage.getItem('bf.sidebarCollapsed')"), '0', 'o embutido não mexe na escolha do usuário');
    await reload(baseUrl);
    assert.deepEqual(await page.eval("[BF.embedded, document.getElementById('app').classList.contains('embedded'), getComputedStyle(document.getElementById('windowControls')).display !== 'none']"), [false, false, true], 'sem ?embedded=1 volta ao normal');
    step('modo embutido (?embedded=1): sem marca, sem controles de janela e sem arrasto; menu em trilho de 64px; sem a opção volta ao normal');

    // ---- modais próprios ----
    await page.eval("document.getElementById('btnOpen').focus(); window.__r = []; BF.ui.confirm({ title: 'Teste', message: 'Pergunta?', okLabel: 'Sim' }).then((v) => window.__r.push(['c1', v])); true");
    await waitFor(page, "!!document.querySelector('.bf-modal')");
    assert.deepEqual(await page.eval("(() => { const m = document.querySelector('.bf-modal'); return [m.getAttribute('role'), m.getAttribute('aria-modal'), !!document.getElementById(m.getAttribute('aria-labelledby')), document.getElementById('app').inert, m.contains(document.activeElement), document.activeElement.dataset.act]; })()"),
      ['dialog', 'true', true, true, true, 'ok']);
    await page.press('Tab');
    assert.equal(await page.eval("document.activeElement.dataset.act"), 'cancel', 'Tab percorre os botões do modal');
    await page.press('Tab');
    assert.equal(await page.eval("document.activeElement.dataset.act"), 'ok', 'o foco não escapa do modal');
    await page.press('Escape');
    await waitFor(page, "window.__r.length === 1");
    assert.deepEqual(await page.eval('window.__r'), [['c1', false]], 'Esc cancela');
    assert.deepEqual(await page.eval("[!!document.querySelector('.bf-modal'), document.getElementById('app').inert, document.activeElement.id]"), [false, false, 'btnOpen'], 'foco volta ao botão de origem');

    await page.eval("BF.ui.confirm({ title: 'Teste 2', message: 'Outra?' }).then((v) => window.__r.push(['c2', v])); true");
    await waitFor(page, "!!document.querySelector('.bf-modal')");
    await page.press('Enter');
    await waitFor(page, "window.__r.length === 2");
    assert.deepEqual(await page.eval('window.__r[1]'), ['c2', true], 'Enter confirma');

    await page.eval("BF.ui.prompt({ title: 'Nome', label: 'Novo nome', value: 'Inicial' }).then((v) => window.__r.push(['p1', v])); true");
    await waitFor(page, "!!document.querySelector('.bf-modal input')");
    assert.deepEqual(await page.eval("[document.activeElement.tagName, document.activeElement.value, document.querySelector('.bf-modal label').getAttribute('for') === document.activeElement.id]"), ['INPUT', 'Inicial', true]);
    assert.equal((await answerModal(page, true, { text: '  Meu nome  ' })).title, 'Nome');
    await waitFor(page, "window.__r.length === 3");
    assert.deepEqual(await page.eval('window.__r[2]'), ['p1', 'Meu nome']);
    await page.eval("BF.ui.prompt({ title: 'Nome', label: 'Novo nome' }).then((v) => window.__r.push(['p2', v])); true");
    await answerModal(page, false);
    await waitFor(page, "window.__r.length === 4");
    assert.deepEqual(await page.eval('window.__r[3]'), ['p2', null], 'cancelar o prompt devolve null');

    // vários pedidos ao mesmo tempo: um modal por vez, na ordem
    await page.eval("window.__q = []; BF.ui.confirm({ title: 'A' }).then((v) => window.__q.push(['A', v])); BF.ui.confirm({ title: 'B' }).then((v) => window.__q.push(['B', v])); true");
    assert.equal((await answerModal(page, true)).title, 'A');
    assert.equal((await answerModal(page, false)).title, 'B');
    await waitFor(page, 'window.__q.length === 2');
    assert.deepEqual(await page.eval('window.__q'), [['A', true], ['B', false]]);
    step('modais BF.ui.confirm/prompt: foco preso, Esc cancela, Enter confirma, fila, foco devolvido');

    // toast
    await page.eval("BF.ui.toast('Aviso de teste', 'ok')");
    assert.match(await page.eval("document.getElementById('toasts').textContent"), /Aviso de teste/);

    // ---- erro compreensível ao abrir arquivo que não é vídeo ----
    const notVideo = path.join(tmp, 'texto.mp4');
    fs.writeFileSync(notVideo, 'isto não é um vídeo');
    await page.eval(`BF.openSource(${JSON.stringify(notVideo)})`);
    await waitFor(page, "document.getElementById('log').className.includes('error')", 10000, 'mensagem de erro');
    const readError = await logText(page);
    assert.match(readError, /^Não foi possível ler o vídeo: o arquivo não parece ser um vídeo válido ou está incompleto/);
    // causa e solução em português, sem a linha de comando do ffprobe nem o texto cru em inglês
    assert.doesNotMatch(readError, /Command failed|ffprobe|moov atom|Invalid data|[A-Z]:\\/);
    assert.match(await page.eval("document.getElementById('toasts').textContent"), /tente de novo/);
    assert.equal(await page.eval("document.getElementById('app').classList.contains('no-project')"), true);
    step('arquivo inválido gera erro claro em português (causa e solução, sem a linha de comando) e não abre projeto');

    // ---- abrir fonte real ----
    const decisions = '__decisions';
    await page.eval(`window.${decisions} = []; BF.bus.on('decision', (d) => window.${decisions}.push(d));`);
    await page.eval(`BF.openSource(${JSON.stringify(source)})`);
    await waitFor(page, "!document.getElementById('app').classList.contains('no-project') && document.getElementById('video').readyState >= 1", 20000, 'vídeo carregado');
    const dur = await page.eval("document.getElementById('video').duration");
    assert.ok(Math.abs(dur - 20) < 0.5, `duração ${dur}`);
    assert.match(await logText(page), /Projeto criado/);
    assert.equal(await page.eval("document.getElementById('sourceName').textContent"), source);
    assert.equal(await page.eval('BF.state.project.version'), 2);
    step(`fonte aberta e reproduzível no player (${dur.toFixed(1)} s)`);

    // itens do menu por clique e por teclado (setas/Home/End), agora com o painel visível
    await page.eval("document.getElementById('tab-queue').click()");
    assert.equal(await page.eval("document.getElementById('tabpanel-queue').hidden"), false);
    await page.eval("document.getElementById('tab-queue').focus()");
    await page.press('ArrowRight');
    assert.equal(await page.eval('document.activeElement.id'), 'tab-settings');
    assert.equal(await page.eval("document.getElementById('tabpanel-general').hidden"), false, 'Configurações abre a Geral');
    await page.press('Home');
    assert.equal(await page.eval('document.activeElement.id'), 'tab-home', 'Home vai para o primeiro item (Início)');
    await page.press('End');
    assert.equal(await page.eval('document.activeElement.id'), 'tab-settings');
    await page.press('ArrowRight');
    assert.equal(await page.eval('document.activeElement.id'), 'tab-home', 'a navegação dá a volta');
    // abas internas de Cortes: clique, ←/→ (dão a volta), Home e End
    await page.eval("document.getElementById('tab-editor').click()");
    assert.equal(await page.eval("document.getElementById('app').dataset.activeTab"), 'cuts', 'o item Cortes abre pela primeira aba');
    await page.eval("document.getElementById('tab-export').click()");
    assert.equal(await page.eval("document.getElementById('tabpanel-export').hidden"), false);
    await page.eval("document.getElementById('tab-export').focus()");
    await page.press('ArrowRight');
    assert.equal(await page.eval('document.activeElement.id'), 'tab-cuts', '→ na última aba dá a volta');
    assert.equal(await page.eval("document.getElementById('tabpanel-cuts').hidden"), false);
    await page.press('ArrowRight');
    await page.press('ArrowRight');
    assert.equal(await page.eval('document.activeElement.id'), 'tab-subtitles', 'Cortes → Análise → Legendas');
    assert.equal(await page.eval("document.getElementById('tabpanel-subtitles').hidden"), false);
    await page.press('End');
    assert.equal(await page.eval('document.activeElement.id'), 'tab-export');
    await page.press('Home');
    assert.equal(await page.eval('document.activeElement.id'), 'tab-cuts');
    await page.eval("BF.ui.selectTab('cuts')");
    step('menu e abas internas: selecionar por clique e por teclado (setas/Home/End)');

    // o menu é vertical: ↑/↓ andam pelos itens como ←/→
    await page.eval("document.getElementById('tab-cuts').focus(); BF.ui.selectTab('cuts'); true");
    await page.eval("document.getElementById('tab-editor').focus()");
    await page.press('ArrowDown');
    assert.equal(await page.eval('document.activeElement.id'), 'tab-queue', '↓ vai para o item seguinte (Exportações)');
    await page.press('ArrowDown');
    assert.equal(await page.eval('document.activeElement.id'), 'tab-settings');
    await page.press('ArrowUp');
    await page.press('ArrowUp');
    assert.equal(await page.eval('document.activeElement.id'), 'tab-editor', '↑ volta');
    await page.press('ArrowUp');
    assert.equal(await page.eval('document.activeElement.id'), 'tab-projects', '↑ passa pelos Projetos');
    await page.press('ArrowUp');
    assert.equal(await page.eval('document.activeElement.id'), 'tab-home', '↑ chega ao Início');
    await page.press('ArrowUp');
    assert.equal(await page.eval('document.activeElement.id'), 'tab-settings', '↑ dá a volta no começo');
    await page.eval("BF.ui.selectTab('cuts')");
    step('menu vertical: ↑/↓ navegam pelos itens (e dão a volta)');

    // tipo de tela por aba: de trabalho (player + painel à direita) ou larga (painel em largura total, player oculto, vídeo intacto)
    const layout = (id) => page.eval(`(() => {
      BF.ui.selectTab(${J(id)});
      const app = document.getElementById('app');
      const video = document.getElementById('video').getBoundingClientRect();
      const panel = document.getElementById('tabpanel-${id}').getBoundingClientRect();
      const side = document.querySelector('.side').getBoundingClientRect();
      return { kind: app.dataset.viewKind, active: app.dataset.activeTab, title: document.getElementById('pageTitle').textContent,
        videoWidth: Math.round(video.width), videoLeft: Math.round(video.left), panelLeft: Math.round(panel.left), sideWidth: Math.round(side.width),
        hasVideo: !!document.getElementById('video').getAttribute('src') };
    })()`);
    // o cabeçalho leva o nome do item do menu: Cortes para as telas do editor, Configurações para as de dentro dela; as telas sem abas internas, o próprio nome
    const titles = { home: 'Início', projects: 'Projetos', cuts: 'Cortes', export: 'Cortes', subtitles: 'Cortes', audio: 'Cortes', analysis: 'Cortes', sources: 'Novo projeto', queue: 'Exportações', general: 'Configurações', prefs: 'Configurações', tools: 'Configurações' };
    for (const id of ['cuts', 'export', 'subtitles', 'audio', 'analysis']) {
      const l = await layout(id);
      assert.equal(l.kind, 'work', `${id} é tela de trabalho`);
      assert.equal(l.title, titles[id], 'o título do cabeçalho é o nome do item do menu');
      assert.ok(l.videoWidth > 250, `${id}: player visível (${l.videoWidth}px)`);
      assert.ok(l.panelLeft > l.videoLeft + l.videoWidth - 5, `${id}: painel à direita do player`);
      assert.ok(l.sideWidth >= 440 && l.sideWidth <= 521, `${id}: painel com largura confortável (${l.sideWidth}px)`);
    }
    for (const id of ['home', 'projects', 'sources', 'queue', 'general', 'prefs', 'tools']) {
      const l = await layout(id);
      assert.equal(l.kind, 'wide', `${id} é tela larga`);
      assert.equal(l.title, titles[id]);
      assert.equal(l.videoWidth, 0, `${id}: player oculto`);
      assert.ok(l.sideWidth > 800, `${id}: painel em largura total (${l.sideWidth}px)`);
      assert.equal(l.hasVideo, true, `${id}: o vídeo continua carregado (só fica oculto)`);
    }
    assert.equal(await page.eval("document.getElementById('video').duration > 19"), true, 'o elemento de vídeo seguiu intacto nas telas largas');
    assert.equal(await page.eval("(async () => { BF.ui.selectTab('queue'); BF.player.video.currentTime = 1; BF.player.video.volume = 0; const p = BF.player.video.play(); if (p) await p; await new Promise((r) => setTimeout(r, 400)); const t = BF.player.video.currentTime; BF.player.pause(); BF.ui.selectTab('cuts'); return t > 1.1; })()"), true, 'o vídeo pode seguir tocando com o player oculto');
    // fora do editor o cabeçalho traz o caminho do vídeo aberto; no editor ele dá lugar a "Projetos › nome do projeto" (e2e do editor)
    await page.eval("BF.ui.selectTab('queue')");
    assert.equal(await page.eval("document.getElementById('sourceName').textContent"), source, 'o nome do vídeo aberto fica no cabeçalho');
    assert.equal(await page.eval("getComputedStyle(document.getElementById('headerDivider')).display !== 'none'"), true);
    await page.eval("BF.ui.selectTab('cuts')");
    assert.equal(await page.eval("document.getElementById('crumbs').hidden"), false, 'no editor o cabeçalho mostra o projeto aberto');
    step('data-view-kind: Cortes/Exportar/Legendas/Áudio/Análise em duas colunas (painel 440-520 px); Novo projeto/Exportações/Preferências/Ferramentas em largura total com o player oculto e o vídeo intacto');

    // módulos "universais" (CommonJS no main, window.BF* no renderer): entram por <script> estático do index.html (CSP
    // script-src 'self'); os carregadores dinâmicos das abas Áudio, Legendas e Cortes não podem duplicá-los
    for (const id of ['audio', 'subtitles', 'cuts']) { await page.eval(`BF.ui.selectTab(${J(id)})`); await sleep(250); }
    const scriptUrls = await page.eval('[...document.scripts].map((s) => s.src).filter(Boolean)');
    assert.equal(new Set(scriptUrls).size, scriptUrls.length, `nenhum <script> repetido: ${scriptUrls.filter((u, i) => scriptUrls.indexOf(u) !== i)}`);
    for (const file of ['src/core/audio/audioFilter.js', 'src/core/audio/audioHistory.js', 'src/core/subtitles/shared.js']) {
      assert.equal(scriptUrls.filter((u) => u.endsWith(file)).length, 1, `${file} carregado uma única vez`);
    }
    assert.equal(await page.eval("document.querySelectorAll('script:not([src])').length"), 0, 'nenhum script inline (CSP)');
    assert.deepEqual(await page.eval("['BFModel', 'BFAudioFilter', 'BFAudioHistory', 'BFSubtitles', 'BFReview'].map((k) => typeof window[k])"), ['object', 'object', 'object', 'object', 'object']);
    const staticOrder = await page.eval('[...document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"))');
    const at = (suffix) => staticOrder.findIndex((s) => s.endsWith(suffix));
    assert.ok(at('src/core/audio/audioFilter.js') >= 0 && at('src/core/audio/audioFilter.js') < at('src/core/audio/audioHistory.js') && at('src/core/audio/audioHistory.js') < at('features/audio.js'), 'audioFilter -> audioHistory -> features/audio.js');
    assert.ok(at('src/core/subtitles/shared.js') >= 0 && at('src/core/subtitles/shared.js') < at('features/subtitles.js'), 'shared.js antes de features/subtitles.js');
    step('módulos universais (audioFilter, audioHistory, subtitles/shared) carregados uma vez, na ordem, sem script inline');

    // marcar início/fim e ver trecho
    await setValue(page, 'inInput', '0:02.0');
    await setValue(page, 'outInput', '0:06.5');
    assert.match(await page.eval("document.getElementById('rangeInfo').textContent"), /4,5 s/, 'durações com a vírgula do português');
    assert.doesNotMatch(await page.eval("document.getElementById('rangeInfo').textContent"), /\d\.\d s\b/);
    await page.eval("document.getElementById('btnPreview').click()");
    await waitFor(page, "document.getElementById('video').currentTime > 2.3", 30000, 'prévia tocando');
    await waitFor(page, "document.getElementById('video').paused", 30000, 'prévia parando no fim do corte');
    const stopAt = await page.eval("document.getElementById('video').currentTime");
    assert.ok(stopAt >= 6.4 && stopAt < 7.5, `parou em ${stopAt}`);
    step(`prévia toca só o trecho selecionado (parou em ${stopAt.toFixed(2)} s)`);

    // "Marcar início/fim" usa o tempo atual do player
    await page.eval("BF.player.seek(3.2)");
    await waitFor(page, "Math.abs(document.getElementById('video').currentTime - 3.2) < 0.05 && !document.getElementById('video').seeking");
    await page.eval("document.getElementById('btnMarkIn').click()");
    assert.equal(await page.eval("document.getElementById('inInput').value"), '0:03.2');
    await page.eval("document.getElementById('btnMarkOut').click()");
    assert.equal(await page.eval("document.getElementById('outInput').value"), '0:03.2');
    assert.equal(await page.eval("document.getElementById('btnAddCut').disabled"), true, 'início = fim é inválido');
    await page.eval("BF.player.pause()");

    // validação do intervalo
    await setValue(page, 'inInput', '0:02.0');
    await setValue(page, 'outInput', '0:01.0');
    assert.equal(await page.eval("document.getElementById('btnAddCut').disabled"), true);
    assert.match(await page.eval("document.getElementById('rangeInfo').textContent"), /fim precisa ser maior/);
    await setValue(page, 'outInput', '0:99.0');
    assert.match(await page.eval("document.getElementById('rangeInfo').textContent"), /passa da duração/);
    await setValue(page, 'outInput', 'abc');
    assert.match(await page.eval("document.getElementById('rangeInfo').textContent"), /formato/);
    // h:mm:ss e vírgula decimal valem (uma live de horas é o caso central; antes só m:ss era aceito)
    await setValue(page, 'inInput', '0:00:02');
    await setValue(page, 'outInput', '0:00:06,5');
    assert.match(await page.eval("document.getElementById('rangeInfo').textContent"), /^Trecho de 0:04\.5 \(4,5 s\)\. Vídeo: 0:20\.0\.$/);
    assert.equal(await page.eval("document.getElementById('btnAddCut').disabled"), false, 'h:mm:ss é um tempo válido');
    assert.deepEqual(await page.eval("[BF.util.fmt(3 * 3600 + 4 * 60 + 23.4), BF.util.parseTime('1:05:30'), BF.util.fmt(59.96), BF.util.secs(6)]"), ['3:04:23.4', 3930, '1:00.0', '6,0 s']);
    await setValue(page, 'inInput', '0:02.0');
    await setValue(page, 'outInput', '0:06.5');
    step('intervalo inválido bloqueia o corte com mensagem; h:mm:ss e vírgula decimal são aceitos; durações em pt-BR');

    // salvar dois cortes, renomear, aprovar/rejeitar
    await page.eval("document.getElementById('btnAddCut').click()");
    await setValue(page, 'inInput', '0:10.0');
    await setValue(page, 'outInput', '0:14.0');
    await page.eval("document.getElementById('btnAddCut').click()");
    await waitFor(page, "document.querySelectorAll('#cuts .cut').length === 2");
    await page.eval(`(() => { const t = document.querySelector('#cuts .cut input'); t.value = 'Clutch final'; t.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(200);
    await clickCutButton(page, 0, 'Aprovar');
    await waitFor(page, "document.querySelectorAll('#cuts .cut')[0].classList.contains('approved')");
    await clickCutButton(page, 1, 'Rejeitar');
    await waitFor(page, "document.querySelectorAll('#cuts .cut')[1].classList.contains('rejected')");
    assert.equal(await page.eval("document.querySelector('#tab-cuts .tab-badge').textContent"), '2', 'aba Cortes mostra o total');
    assert.equal(await page.eval("document.querySelector('#tab-export .tab-badge').textContent"), '1', 'aba Exportar mostra os aprovados');
    step('2 cortes salvos em ordem cronológica; um aprovado, outro rejeitado');

    // eventos 'decision' (create, create, retitle, approve, reject)
    const types = (await page.eval(`window.${decisions}.map((d) => d.type)`));
    assert.deepEqual(types, ['create', 'create', 'retitle', 'approve', 'reject']);
    const retitle = await page.eval(`window.${decisions}.find((d) => d.type === 'retitle')`);
    assert.deepEqual([retitle.before, retitle.after], ['Corte 1', 'Clutch final']);
    const approve = await page.eval(`window.${decisions}.find((d) => d.type === 'approve')`);
    assert.deepEqual([approve.before, approve.after], ['pending', 'approved']);
    step('eventos decision emitidos (create, retitle, approve, reject)');

    // corte novo é completo (modelo v2) e a ordem é cronológica mesmo criando fora de ordem
    await setValue(page, 'inInput', '0:16.0');
    await setValue(page, 'outInput', '0:18.0');
    await page.eval("document.getElementById('btnAddCut').click()");
    await setValue(page, 'inInput', '0:00.5');
    await setValue(page, 'outInput', '0:01.5');
    await page.eval("document.getElementById('btnAddCut').click()");
    await waitFor(page, "document.querySelectorAll('#cuts .cut').length === 4");
    assert.deepEqual(await page.eval('BF.state.project.cuts.map((c) => [c.title, c.start])'), [['Corte 4', 0.5], ['Clutch final', 2], ['Corte 2', 10], ['Corte 3', 16]]);
    assert.deepEqual(await page.eval("(() => { const c = BF.state.project.cuts[0]; return [c.audio.gainDb, c.subtitles, c.framing, c.revision, c.origin, c.status, Array.isArray(c.exports)]; })()"), [0, null, null, 1, 'manual', 'pending', true]);

    // remover com confirmação: cancelar mantém, confirmar remove (sem apagar nada do disco)
    await clickCutButton(page, 0, 'Remover');
    assert.match((await answerModal(page, false)).message, /Remover "Corte 4" do projeto/);
    assert.equal(await page.eval("document.querySelectorAll('#cuts .cut').length"), 4);
    await clickCutButton(page, 3, 'Remover');
    await answerModal(page, true);
    await waitFor(page, "document.querySelectorAll('#cuts .cut').length === 3");
    await clickCutButton(page, 0, 'Remover');
    await answerModal(page, true);
    await waitFor(page, "document.querySelectorAll('#cuts .cut').length === 2");
    assert.deepEqual(await page.eval('BF.state.project.cuts.map((c) => c.title)'), ['Clutch final', 'Corte 2']);
    const removed = await page.eval(`window.${decisions}.filter((d) => d.type === 'remove').map((d) => [d.before.title, d.after])`);
    assert.deepEqual(removed, [['Corte 3', null], ['Corte 4', null]]);
    step('remover corte pede confirmação (cancelar mantém) e emite decision remove');

    // salvamento com debounce: o arquivo do projeto reflete a edição
    await saveProject(page);
    const projFile = path.join(userData, 'projects', `${projectIdFor(source)}.json`);
    const onDisk = JSON.parse(fs.readFileSync(projFile, 'utf8'));
    assert.equal(onDisk.version, 2);
    assert.deepEqual(onDisk.cuts.map((c) => [c.title, c.status]), [['Clutch final', 'approved'], ['Corte 2', 'rejected']]);
    assert.equal(onDisk.profileId, 'vertical-1080-h264');
    const list = await page.eval("BF.api('project:list')");
    assert.equal(list.ok, true);
    assert.deepEqual(list.projects.map((p) => [p.id, p.cutCount, p.counts.approved]), [[projectIdFor(source), 2, 1]]);
    step('projeto salvo em v2 no disco e listado por project:list');

    // ---- exportação real: aba Exportar -> "Adicionar à fila" -> aba Fila -> arquivo conferido com ffprobe ----
    await page.eval("window.__qev = { done: [], conflicts: 0 }; BF.on('queue:jobDone', (e) => window.__qev.done.push(e)); BF.on('queue:conflict', () => { window.__qev.conflicts += 1; }); true");
    await page.eval("BF.ui.selectTab('export')");
    await waitFor(page, "document.querySelectorAll('#exp-profile option').length >= 12", 20000, 'perfis de exportação carregados');
    assert.equal(await page.eval("document.getElementById('tabpanel-export').hidden"), false);
    await waitFor(page, "/Detalhes · 1080×1920 · H\\.264 · 10 Mbps/.test(document.querySelector('#exp-details summary').textContent)", 20000, 'resumo do perfil padrão (1080×1920 · H.264 · 10 Mbps)');
    assert.equal(await page.eval("document.getElementById('exp-profile').value"), 'vertical-1080-h264', 'padrão obrigatório do produto: 9:16, 1080p, H.264');
    assert.equal(await page.eval("document.getElementById('exp-bitrate-label').textContent"), '10 Mbps', 'bitrate padrão de 10 Mbps');
    assert.equal(await page.eval("document.getElementById('exp-details').open"), false, 'ajustes avançados do perfil começam recolhidos');
    // o contador do botão só aparece depois de a aba marcar os aprovados: espera por ele em vez de ler na hora
    await waitFor(page, "[...document.querySelectorAll('#tabpanel-export .exp-main > .exp-foot button')].map((b) => b.textContent).join('|') === 'Adicionar à fila (1)'", 20000, 'o botão "Adicionar à fila (1)" (um único botão de ação, só com o corte aprovado)');
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#tabpanel-export .exp-main > .exp-foot button')].map((b) => b.textContent)"), ['Adicionar à fila (1)'], 'um único botão de ação, só com o corte aprovado');
    await addToQueue(page, 1);
    await waitQueueRow(page, 'Clutch final', 'done');
    const f1 = path.join(out, 'gameplay - corte 01 - Clutch final.mp4');
    assert.deepEqual(fs.readdirSync(out).sort(), ['gameplay - corte 01 - Clutch final.mp4'], 'só o arquivo final (nenhum .part)');
    let info = await probeMedia(tools.ffprobe, f1);
    assert.deepEqual([info.width, info.height, info.videoCodec, info.hasAudio], [1080, 1920, 'h264', true]);
    assert.ok(Math.abs(info.duration - 4.5) < 0.25, `duração ${info.duration}`);
    const doneEvents = await page.eval('window.__qev.done');
    assert.equal(doneEvents.length, 1, 'o evento queue:jobDone chegou ao renderer');
    assert.equal(path.resolve(doneEvents[0].output).toLowerCase(), path.resolve(f1).toLowerCase());
    await waitFor(page, "BF.project.cut(BF.state.project.cuts[0].id).exports.length === 1", 20000, 'exportação anotada no corte');
    assert.equal(path.resolve(await page.eval('BF.state.project.cuts[0].exports[0].path')).toLowerCase(), path.resolve(f1).toLowerCase());
    await page.eval("BF.ui.selectTab('cuts')");
    assert.equal(await page.eval("!!document.querySelector('#cuts .cut .exported')"), true, 'a lista de cortes mostra onde foi exportado');
    step(`exportado pela fila: ${path.basename(f1)} — ${info.width}x${info.height} ${info.videoCodec}, ${info.duration.toFixed(2)} s, com áudio (conferido com ffprobe)`);

    // não repetir trabalho concluído: mandar o mesmo corte de novo vira "pulado" (nada é refeito nem sobrescrito)
    const before = fs.statSync(f1).mtimeMs;
    await addToQueue(page, 1);
    await waitQueueRow(page, 'Clutch final', 'skipped', 30000);
    assert.match((await queueRows(page)).find((r) => r.state === 'skipped').text, /Já exportado.*Nada foi refeito/s);
    assert.equal(fs.statSync(f1).mtimeMs, before);
    assert.equal(fs.readdirSync(out).length, 1);
    step('corte já exportado não é repetido: a fila o marca como pulado e explica');

    // conflito de nome: "Exportar de novo" cai no conflito (o arquivo existe); pular não sobrescreve nada
    await clickQueueAct(page, 'skipped', 'retry');
    assert.match(await answerConflict(page, 'skip'), /gameplay - corte 01 - Clutch final\.mp4” já está em .*Nada será sobrescrito sem a sua escolha/s);
    await waitFor(page, "[...document.querySelectorAll('#tabpanel-queue li.q-job')].every((li) => li.dataset.state !== 'needsAction' && li.dataset.state !== 'queued' && li.dataset.state !== 'running')", 30000, 'fila parada depois de pular');
    assert.equal(fs.statSync(f1).mtimeMs, before);
    assert.equal(fs.readdirSync(out).length, 1);
    step('nome conflitante: a fila pergunta; pular não sobrescreve nada');

    // conflito: salvar com outro nome ("(2)"), preservando o original
    await clickQueueAct(page, 'skipped', 'retry');
    await answerConflict(page, 'rename');
    await waitFor(page, "document.querySelectorAll('#tabpanel-queue li.q-job[data-state=done]').length >= 2", 120000, 'segundo arquivo concluído');
    assert.deepEqual(fs.readdirSync(out).sort(), ['gameplay - corte 01 - Clutch final (2).mp4', 'gameplay - corte 01 - Clutch final.mp4']);
    assert.equal(fs.statSync(f1).mtimeMs, before, 'o original não foi tocado');
    assert.equal((await page.eval('window.__qev.conflicts')) >= 2, true, 'queue:conflict chegou ao renderer');
    step('nome conflitante: "Salvar com outro nome" cria "(2)" e preserva o original');

    // pasta de destino (o diálogo nativo não dá para automatizar: grava pelo projeto) + 1440p, H.265, 20 Mbps
    const otherDir = path.join(tmp, 'Outra');
    await page.eval(`BF.project.update((p) => { p.exportDir = ${J(otherDir)}; }, { reason: 'teste' }); BF.bus.emit('project:loaded', { project: BF.state.project, restored: true })`);
    await page.eval("BF.ui.selectTab('export')");
    await waitFor(page, `/Outra$/.test(document.getElementById('exp-dir').textContent)`, 15000, 'pasta de destino atualizada');
    await setValue(page, 'exp-profile', 'vertical-1440-h265', 'change');
    await waitFor(page, "document.getElementById('exp-bitrate-label').textContent.length > 0 && /1440×2560 · H\\.265/.test(document.querySelector('#exp-details summary').textContent)", 15000, 'perfil 1440p H.265 aplicado');
    await setValue(page, 'exp-bitrate', String(kbpsToSlider(20000)), 'input');
    await setValue(page, 'exp-bitrate', String(kbpsToSlider(20000)), 'change');
    assert.equal(await page.eval("document.getElementById('exp-bitrate-label').textContent"), '20 Mbps');
    await waitFor(page, "/Tudo pronto/.test(document.getElementById('exp-qc-status').textContent)", 40000, 'conferência do perfil novo');
    assert.match(await page.eval("document.getElementById('exp-qc').textContent"), /ampliada|H\.265/, 'avisos (ampliação e H.265) aparecem e não bloqueiam');
    await addToQueue(page, 1);
    await waitFor(page, "document.querySelectorAll('#tabpanel-queue li.q-job[data-state=done]').length >= 3", 120000, 'terceiro arquivo concluído');
    const f3 = path.join(otherDir, 'gameplay - corte 01 - Clutch final.mp4');
    assert.deepEqual(fs.readdirSync(otherDir), ['gameplay - corte 01 - Clutch final.mp4'], 'o arquivo foi para a pasta escolhida');
    info = await probeMedia(tools.ffprobe, f3);
    assert.deepEqual([info.width, info.height, info.videoCodec, info.hasAudio], [1440, 2560, 'hevc', true]);
    step(`1440p / H.265 / 20 Mbps exportado na pasta escolhida (${info.width}x${info.height} ${info.videoCodec}); avisos exibidos sem bloquear`);

    // ---- persistência: reiniciar o app e reabrir ----
    await saveProject(page);
    assert.deepEqual(await page.eval('BF.state.project.profileId'), 'vertical-1440-h265');
    assert.equal(await page.eval("BF.state.project.ext.export.overrides['vertical-1440-h265'].bitrateKbps"), 20000);
    h.assertNoConsoleErrors(page);
    await app.stop();
    app = await h.launchApp(userData);
    page = app.page;
    await page.eval(`BF.openSource(${JSON.stringify(source)})`);
    await waitFor(page, "!document.getElementById('app').classList.contains('no-project') && document.querySelectorAll('#cuts .cut').length === 2");
    assert.match(await logText(page), /Projeto reaberto com 2 corte/);
    const restored = await page.eval("JSON.stringify([...document.querySelectorAll('#cuts .cut')].map(c => [c.querySelector('input').value, c.className, !!c.querySelector('.exported')]))");
    assert.deepEqual(JSON.parse(restored), [['Clutch final', 'cut approved', true], ['Corte 2', 'cut rejected', false]]);
    await page.eval("BF.ui.selectTab('export')");
    await waitFor(page, "document.querySelectorAll('#exp-profile option').length >= 12", 20000, 'perfis de exportação carregados');
    assert.equal(await page.eval("document.getElementById('exp-profile').value"), 'vertical-1440-h265');
    assert.equal(await page.eval("document.getElementById('exp-bitrate-label').textContent"), '20 Mbps');
    assert.match(await page.eval("document.getElementById('exp-dir').textContent"), /Outra$/);
    // a fila (queue.json) também sobreviveu: os 3 arquivos exportados continuam listados como concluídos
    await page.eval("BF.ui.selectTab('queue')");
    await waitFor(page, "document.querySelectorAll('#tabpanel-queue li.q-job[data-state=done]').length === 3", 20000, 'fila restaurada com os 3 concluídos');
    step('após reiniciar: cortes, títulos, decisões, exportações, perfil/bitrate/pasta e fila preservados');

    // ---- projeto v1 gravado pelo app antigo é migrado ao abrir ----
    const legacy = path.join(tmp, 'legado.mp4');
    h.makeSampleVideo(tools.ffmpeg, legacy, { seconds: 8, size: '640x360', rate: 15 });
    const v1 = {
      version: 1, id: projectIdFor(legacy),
      source: { path: path.resolve(legacy), size: 1, duration: 8, width: 640, height: 360 },
      cuts: [
        { id: 'cold1', title: 'Antigo bom', start: 1, end: 3, status: 'approved', exports: [] },
        { id: 'cold2', title: 'Antigo ruim', start: 4, end: 6, status: 'rejected', exports: [] }
      ],
      exportDir: null, profile: { resolution: 2160, codec: 'h265', bitrateKbps: 30000 }, updatedAt: '2026-10-01T00:00:00.000Z', campoFuturo: { x: 1 }
    };
    const v1File = path.join(userData, 'projects', `${projectIdFor(legacy)}.json`);
    fs.writeFileSync(v1File, JSON.stringify(v1, null, 2));
    // o v1 registrou size: 1 e o vídeo real é maior: a aba Preferências pergunta antes de abrir (decisões e ajustes ficam preservados)
    const opening = page.eval(`BF.openSource(${J(legacy)})`);
    const asked = await answerModal(page, true);
    assert.equal(asked.title, 'A fonte mudou desde a última análise');
    await opening;
    await waitFor(page, "document.getElementById('sourceName').textContent.endsWith('legado.mp4') && document.querySelectorAll('#cuts .cut').length === 2");
    assert.match(await logText(page), /Projeto reaberto com 2 corte/);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#cuts .cut')].map(c => [c.querySelector('input').value, c.className])"), [['Antigo bom', 'cut approved'], ['Antigo ruim', 'cut rejected']]);
    // o perfil legado { resolution, codec } vira o perfil embutido equivalente na aba Exportar nova
    await page.eval("BF.ui.selectTab('export')");
    await waitFor(page, "document.querySelectorAll('#exp-profile option').length >= 12", 20000, 'perfis de exportação carregados');
    assert.equal(await page.eval("document.getElementById('exp-profile').value"), 'vertical-2160-h265');
    await saveProject(page);
    const migrated = JSON.parse(fs.readFileSync(v1File, 'utf8'));
    assert.equal(migrated.version, 2);
    assert.deepEqual(migrated.campoFuturo, { x: 1 });
    assert.equal(migrated.profileId, 'vertical-2160-h265');
    assert.equal(migrated.profile.bitrateKbps, 30000, 'o perfil legado (com o bitrate) continua guardado no projeto');
    assert.deepEqual(JSON.parse(fs.readFileSync(`${v1File}.v1.bak`, 'utf8')), v1, 'cópia do v1 original guardada');
    step('projeto v1 antigo abre, é migrado para v2 e o original fica guardado em .v1.bak');

    // arrastar e soltar: solta o arquivo na janela (arquivo real, caminho resolvido por pathForFile)
    const dropped = await page.send('Input.dispatchDragEvent', { type: 'dragEnter', x: 300, y: 300, data: { items: [], files: [source], dragOperationsMask: 1 } });
    if (!dropped.error) {
      await page.send('Input.dispatchDragEvent', { type: 'dragOver', x: 300, y: 300, data: { items: [], files: [source], dragOperationsMask: 1 } });
      assert.equal(await page.eval("document.getElementById('app').classList.contains('drag')"), true, 'destaque ao arrastar');
      await page.send('Input.dispatchDragEvent', { type: 'drop', x: 300, y: 300, data: { items: [], files: [source], dragOperationsMask: 1 } });
      await waitFor(page, `document.getElementById('sourceName').textContent === ${JSON.stringify(source)}`, 15000, 'vídeo aberto por arrastar e soltar');
      assert.equal(await page.eval("document.getElementById('app').classList.contains('drag')"), false);
      step('arrastar e soltar um vídeo na janela o abre');
    } else {
      throw new Error(`dispatchDragEvent indisponível: ${dropped.error.message}`);
    }

    // reprocurar ferramentas pelo renderer (ffmpeg está no PATH deste teste)
    const again = await page.eval("BF.api('app:refreshTools')");
    assert.equal(again.ok, true);
    assert.ok(again.tools.ffmpeg && again.tools.ffprobe);

    // ---- fontes que o player não toca (.ts, .flv): "Ver trecho" fica desabilitado COM o motivo; marcar e exportar continuam ----
    const errorsBeforeMedia = page.errors.length;
    const clip = path.join(tmp, 'clip.mp4');
    h.makeSampleVideo(tools.ffmpeg, clip, { seconds: 6, size: '640x360', rate: 15 });
    const tsFile = path.join(tmp, 'clip.ts');
    const flvFile = path.join(tmp, 'clip.flv');
    for (const file of [tsFile, flvFile]) execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', clip, '-c', 'copy', file], { windowsHide: true });
    for (const file of [tsFile, flvFile]) {
      await page.eval(`BF.openSource(${J(file)})`);
      await waitFor(page, "document.getElementById('video').error !== null && document.getElementById('btnPreview').disabled", 20000, `o player recusar ${path.basename(file)} e "Ver trecho" ficar desabilitado`);
      const title = await page.eval("document.getElementById('btnPreview').title");
      assert.match(title, /não toca no player do app.*não dependem do player/, 'o botão explica por que está desabilitado');
      assert.equal(await page.eval("document.getElementById('btnAddCut').disabled"), false, 'marcar e salvar o corte continua funcionando');
      assert.equal(await page.eval('BF.player.playRange(1, 2)'), false, 'quem chama playRange diretamente também fica sabendo');
      assert.match(await page.eval("document.getElementById('toasts').textContent"), /não toca no player do app/);
    }
    step('.ts e .flv (o Chromium não toca): "Ver trecho" desabilitado com o motivo no title, Salvar corte segue ativo, playRange devolve false');

    // MKV escrito em "pipe" não tem a duração no cabeçalho: o app a descobre lendo os pacotes e o vídeo fica utilizável
    const noDuration = path.join(tmp, 'sem-duracao.mkv');
    fs.writeFileSync(noDuration, execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', clip, '-f', 'matroska', '-c', 'copy', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }));
    await page.eval(`BF.openSource(${J(noDuration)})`);
    await waitFor(page, "BF.state.info && BF.state.info.durationSource === 'scan' && document.getElementById('video').readyState >= 1", 30000, 'MKV sem duração aberto');
    const mkvDuration = await page.eval('BF.state.info.duration');
    assert.ok(Math.abs(mkvDuration - 6) < 0.4, `duração lida dos pacotes: ${mkvDuration}`);
    await setValue(page, 'inInput', '0:01.0');
    await setValue(page, 'outInput', '0:05.0');
    assert.deepEqual(await page.eval("[document.getElementById('btnAddCut').disabled, document.getElementById('btnPreview').disabled]"), [false, false], 'antes ficavam desabilitados (duração 0)');
    step(`MKV sem duração no cabeçalho: duração ${mkvDuration.toFixed(2)} s lida do arquivo, marcação e "Ver trecho" habilitados`);
    // duração totalmente desconhecida (nem a leitura dos pacotes deu): sem limite superior e com a explicação, nunca "o fim passa da duração"
    await page.eval('BF.state.info = { ...BF.state.info, duration: 0 }');
    await setValue(page, 'outInput', '0:59.0');
    assert.match(await page.eval("document.getElementById('rangeInfo').textContent"), /Duração do vídeo desconhecida/);
    assert.doesNotMatch(await page.eval("document.getElementById('rangeInfo').textContent"), /passa da duração|precisa ser maior/);
    assert.equal(await page.eval("document.getElementById('btnAddCut').disabled"), false);
    step('duração desconhecida: a interface não aplica limite superior e explica');
    const freshErrors = page.errors.slice(errorsBeforeMedia);
    assert.ok(freshErrors.every((e) => /DEMUXER_ERROR|PIPELINE_ERROR|media|MediaError/i.test(e)), `erros de console inesperados nas fontes de mídia: ${freshErrors.join(' | ')}`);
    page.errors.length = errorsBeforeMedia; // os do decodificador (esperados para .ts/.flv) já foram conferidos

    // ---- trocar de vídeo quando a gravação do projeto aberto falha: nada se perde em silêncio ----
    const projectsDir = path.join(userData, 'projects');
    const diskCuts = (file) => JSON.parse(fs.readFileSync(path.join(projectsDir, `${projectIdFor(file)}.json`), 'utf8')).cuts.map((c) => c.title);
    await page.eval(`BF.openSource(${J(clip)})`);
    await waitFor(page, `BF.state.project && BF.state.project.source.path === ${J(clip)} && document.getElementById('video').readyState >= 1`, 20000, 'clip.mp4 aberto');
    const breakSaves = "window.__realApi = BF.api; BF.api = async (ch, p, o) => (ch === 'project:save' ? { ok: false, code: 'PROJECT_WRITE_FAILED', message: 'a pasta de projetos está em uso por outro programa (EBUSY simulado)' } : window.__realApi(ch, p, o)); true";
    const fixSaves = 'BF.api = window.__realApi; true';
    await page.eval(breakSaves);
    await page.eval("BF.project.addCut({ start: 1, end: 2, title: 'EDICAO-NAO-SALVA' }); true");
    const switching = page.eval(`BF.openSource(${J(tsFile)})`);
    const askedSave = await answerModal(page, false);
    assert.equal(askedSave.title, 'Não foi possível salvar o projeto atual');
    assert.match(askedSave.message, /podem se perder/);
    const refused = await switching;
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'SAVE_FAILED');
    assert.equal(await page.eval('BF.state.project.source.path'), clip, 'continua no vídeo atual');
    assert.equal(await page.eval("BF.state.project.cuts.some((c) => c.title === 'EDICAO-NAO-SALVA')"), true, 'a edição continua na memória');
    assert.ok(!diskCuts(clip).includes('EDICAO-NAO-SALVA'), 'e ainda não foi para o disco (a gravação está falhando)');
    // a gravação volta a funcionar: o app tenta de novo sozinho e a edição chega ao disco (antes só na próxima edição, que podia nunca vir)
    await page.eval(fixSaves);
    const t0 = Date.now();
    for (;;) {
      if (diskCuts(clip).includes('EDICAO-NAO-SALVA')) break;
      if (Date.now() - t0 > 25000) throw new Error('a edição pendente não foi gravada sozinha depois que a gravação voltou');
      await sleep(250);
    }
    await waitFor(page, "/Projeto salvo/.test(document.getElementById('log').textContent)", 10000, 'aviso "Projeto salvo" depois da falha');
    step(`gravação falhando ao trocar de vídeo: o app pergunta, mantém o projeto na memória e grava sozinho quando volta (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    // "Abrir mesmo assim": o usuário decide, sabendo
    await page.eval(breakSaves);
    await page.eval("BF.project.addCut({ start: 3, end: 4, title: 'OUTRA-EDICAO' }); true");
    const forced = page.eval(`BF.openSource(${J(tsFile)})`);
    await answerModal(page, true);
    assert.equal((await forced).ok, true);
    assert.equal(await page.eval('BF.state.project.source.path'), tsFile);
    await page.eval(fixSaves);
    await page.eval(`BF.openSource(${J(source)})`);
    await waitFor(page, `BF.state.project && BF.state.project.source.path === ${J(source)}`, 20000, 'volta ao vídeo principal');
    step('"Abrir mesmo assim" abre o outro vídeo depois do aviso');

    // ---- projeto corrompido: o app AVISA com o caminho e recupera a última cópia boa (antes os cortes sumiam sem nenhum aviso) ----
    const store = new ProjectStore(projectsDir);
    // (vídeos de durações diferentes entre si e do clip: parecidos demais acionariam a pergunta "é a mesma live?" das Preferências)
    const makeProject = async (file, titles) => {
      const info = await probeMedia(tools.ffprobe, file); // tamanho e duração reais: senão as Preferências perguntariam "a fonte mudou?"
      const p = newProject(file, info);
      p.cuts = titles.map((title, i) => ({ id: `c${i}`, title, start: i + 1, end: i + 2, status: 'approved' }));
      return p;
    };
    const damaged = path.join(tmp, 'danificado.mp4');
    h.makeSampleVideo(tools.ffmpeg, damaged, { seconds: 11, size: '640x360', rate: 15 });
    store.save(await makeProject(damaged, ['Corte bom 1', 'Corte bom 2']));
    store.save(await makeProject(damaged, ['Corte bom 1', 'Corte bom 2'])); // a 2ª gravação guarda a 1ª como .bak
    const damagedFile = store.fileFor(damaged);
    fs.writeFileSync(damagedFile, fs.readFileSync(damagedFile, 'utf8').slice(0, 90)); // queda de energia: arquivo pela metade
    await page.eval(`BF.openSource(${J(damaged)})`);
    await waitFor(page, `BF.state.project && BF.state.project.source.path === ${J(damaged)}`, 20000, 'projeto danificado aberto');
    assert.deepEqual(await page.eval('BF.state.project.cuts.map((c) => c.title)'), ['Corte bom 1', 'Corte bom 2'], 'os cortes voltaram da cópia');
    const warned = await page.eval("document.getElementById('toasts').textContent");
    assert.match(warned, /estava danificado\. Recuperamos a última cópia boa \(de .*pode ter se perdido\./);
    assert.ok(warned.includes('.corrupt'), 'o aviso mostra onde o arquivo danificado foi guardado');
    assert.ok(fs.readdirSync(projectsDir).some((f) => f.startsWith(path.basename(damagedFile)) && f.endsWith('.corrupt')), 'o danificado foi preservado, não apagado');
    const lost = path.join(tmp, 'perdido.mp4');
    h.makeSampleVideo(tools.ffmpeg, lost, { seconds: 14, size: '640x360', rate: 15 });
    fs.writeFileSync(store.fileFor(lost), '{ "version": 2, "source": { "pa');
    await page.eval(`BF.openSource(${J(lost)})`);
    await waitFor(page, `BF.state.project && BF.state.project.source.path === ${J(lost)}`, 20000, 'projeto sem cópia aberto');
    assert.match(await page.eval("document.getElementById('log').textContent"), /não havia cópia para recuperar.*projeto novo.*Não o apague/);
    step('projeto corrompido: o aviso (toast e barra de status) diz o que houve e onde o arquivo ficou; com .bak recupera os cortes, sem .bak começa vazio e avisa');
    await page.eval(`BF.openSource(${J(source)})`);
    await waitFor(page, `BF.state.project && BF.state.project.source.path === ${J(source)}`, 20000, 'volta ao vídeo principal');

    // ---- nenhum erro de console durante toda a sessão ----
    h.assertNoConsoleErrors(page);
    step('nenhum erro de console no app (Runtime, Log e exceções)');
    if (process.env.BF_E2E_SHOT) await h.screenshot(page, process.env.BF_E2E_SHOT);
    await app.stop();

    // ---- sem FFmpeg no PATH: aviso claro, ações desabilitadas, nada quebra ----
    const bare = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const noFfmpeg = await h.launchApp(path.join(tmp, 'userdata-semffmpeg'), { env: { PATH: bare, CORTE_FFMPEG: '', CORTE_FFPROBE: '' } });
    page = noFfmpeg.page;
    if (await page.eval('BF.state.tools.ffmpeg || BF.state.tools.ffprobe')) {
      // não é mais "pulado": launchApp usa mergeEnv, então PATH=System32 de fato esconde o ffmpeg; se ele aparece, o teste não prova nada
      throw new Error(`o ffmpeg deveria estar escondido (PATH só com a pasta do sistema): ${JSON.stringify(await page.eval('BF.state.tools'))}`);
    } else {
      assert.equal(await page.eval("document.getElementById('toolsWarn').hidden"), false);
      assert.match(await page.eval("document.getElementById('toolsWarn').textContent"), /Não encontrado: ffmpeg, ffprobe.*Instale o FFmpeg/);
      assert.deepEqual(await page.eval("[...document.querySelectorAll('#toolsWarn button')].map((b) => b.textContent)"), ['Instalar o FFmpeg', 'Verificar de novo'], 'o aviso oferece instalar e verificar de novo');
      await page.eval("[...document.querySelectorAll('#toolsWarn button')].find((b) => b.textContent === 'Verificar de novo').click()");
      await waitFor(page, "/ainda não foi encontrado/.test(document.getElementById('toasts').textContent)", 10000, 'aviso de que o FFmpeg continua ausente');
      await page.eval(`BF.openSource(${JSON.stringify(source)})`);
      assert.match(await logText(page), /ffprobe não encontrado/);
      assert.equal(await page.eval("document.getElementById('app').classList.contains('no-project')"), true);
      assert.equal(await page.eval("document.getElementById('tab-export').disabled"), true, 'sem vídeo aberto a aba Exportar fica desabilitada');
      assert.match(await page.eval("document.getElementById('tabpanel-export').textContent"), /Abra um vídeo/, 'o painel orienta em vez de quebrar');
      assert.equal(await page.eval("BF.ui.selectTab('export')"), false);
      step('sem FFmpeg: aviso no topo com "Instalar o FFmpeg" e "Verificar de novo", abrir vídeo explica o motivo, a aba Exportar não abre sem projeto');
    }
    h.assertNoConsoleErrors(page);
    await noFfmpeg.stop();

    // ---- ferramentas numa pasta com acento no PATH (João, Programação, Vídeos…): o `where` do Windows corrompia o nome e o app dizia que não achava ----
    const accentDir = path.join(tmp, 'João Programação');
    fs.mkdirSync(accentDir);
    for (const name of ['ffmpeg.exe', 'ffprobe.exe']) fs.writeFileSync(path.join(accentDir, name), 'x'); // só precisam ser achados (nada é executado aqui)
    const accented = await h.launchApp(path.join(tmp, 'userdata-acento'), { env: { PATH: `${bare};${accentDir}`, CORTE_FFMPEG: '', CORTE_FFPROBE: '' } });
    const foundTools = await accented.page.eval('BF.state.tools');
    assert.equal(String(foundTools.ffmpeg).toLowerCase(), path.join(accentDir, 'ffmpeg.exe').toLowerCase(), `ffmpeg não achado na pasta com acento: ${JSON.stringify(foundTools)}`);
    assert.equal(String(foundTools.ffprobe).toLowerCase(), path.join(accentDir, 'ffprobe.exe').toLowerCase());
    assert.equal(await accented.page.eval("document.getElementById('toolsWarn').hidden"), true, 'sem o aviso de "FFmpeg não encontrado"');
    h.assertNoConsoleErrors(accented.page);
    await accented.stop();
    step('ferramentas achadas no PATH mesmo com a pasta "João Programação" (acento): sem aviso de FFmpeg ausente');

    console.log('\nE2E OK');
  } finally {
    await h.cleanupAll();
    h.removeDir(tmp);
  }
}

main().then(() => process.exit(0), (err) => {
  console.error(`\n✖ E2E FALHOU: ${err.message}`);
  h.cleanupAll().finally(() => process.exit(1));
});

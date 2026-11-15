'use strict';

/**
 * E2E do OpenRouter "só com modelos gratuitos" NO CARTÃO DO PROVEDOR da aba Análise: app Electron de verdade (perfil temporário) falando com um
 * servidor HTTP LOCAL que imita o OpenRouter (tests/ai-openrouter-fakes.js, apontado por BF_OPENROUTER_BASE_URL). Cobre: escolher o OpenRouter
 * (lista com o roteador gratuito PRIMEIRO e os gratuitos logo abaixo, o roteador JÁ selecionado como modelo de partida, interruptor ligado por padrão,
 * selo de pedidos restantes), escolher o roteador (e outro modelo, voltando ao padrão), a estimativa comparada com o que resta hoje, o aviso de privacidade com o parágrafo dos modelos gratuitos, rodar a análise
 * (o modelo que respondeu aparece no resultado), um modelo PAGO forçado sendo recusado, "Modelos de reserva" (429 troca para o próximo gratuito;
 * 401 não), cada erro explicado na tela, desligar o interruptor de propósito, a persistência depois de reiniciar, nenhum erro de console e a CHAVE
 * fora da tela, do projeto, do navegador e de todo arquivo do perfil.
 * Uso: node tests/e2e/analysis-openrouter.e2e.js   (BF_E2E_SHOTDIR=<pasta> guarda capturas 1360x840 nos temas escuro e claro)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { locateTools } = require('../../src/core/ffmpeg/locate');
const A = require('../ai-fakes');
const F = require('../ai-openrouter-fakes');
const h = require('./helpers');

const { sleep, waitFor, answerModal } = h;
const tools = locateTools();
const step = (m) => console.log(`✔ ${m}`);
const q = (s) => JSON.stringify(s);
const FREE_PARAGRAPH = 'Modelos gratuitos podem usar o que você envia para treino ou publicação, conforme as configurações da sua conta no OpenRouter.';

const text = (page, sel) => page.eval(`document.querySelector(${q(sel)}) ? document.querySelector(${q(sel)}).textContent : null`);
const click = (page, sel) => page.eval(`document.querySelector(${q(sel)}).click()`);
const setValue = (page, sel, value, events = ['input', 'change']) => page.eval(`(() => { const e = document.querySelector(${q(sel)}); e.value = ${q(String(value))}; ${events.map((ev) => `e.dispatchEvent(new Event(${q(ev)}, { bubbles: true }))`).join('; ')}; })()`);
/** O elemento existe, nenhum ancestral está escondido ([hidden]) nem recolhido (<details> fechado) e ele tem caixa na tela. */
const visible = (page, sel) => page.eval(`(() => {
  const e = document.querySelector(${q(sel)});
  if (!e) return false;
  const summary = e.closest('summary');
  for (let n = e; n; n = n.parentElement) {
    if (n.hidden) return false;
    if (n.tagName === 'DETAILS' && !n.open && !(summary && summary.parentElement === n)) return false;
  }
  return e.getClientRects().length > 0;
})()`);

const lastContent = (call) => call.body.messages[call.body.messages.length - 1].content;
const isPick = (call) => lastContent(call).includes('=== CANDIDATOS ===');
const chatCalls = (mock) => mock.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/chat/completions');

/** Procura a chave em tudo o que a tela, o projeto e o navegador guardam. */
async function leaks(page) {
  return page.eval(`(() => {
    const KEY = ${q(F.KEY)}; const LABEL = ${q(F.KEY_LABEL)};
    let ls = ''; let ss = '';
    try { ls = JSON.stringify(localStorage); ss = JSON.stringify(sessionStorage); } catch (e) { /* sem acesso */ }
    const any = (s) => s.includes(KEY) || s.includes(LABEL) || s.includes('sk-or-v1');
    return {
      html: any(document.documentElement.outerHTML),
      text: any(document.body.innerText),
      inputs: [...document.querySelectorAll('input,textarea,select')].some((i) => any(String(i.value) + String(i.placeholder))),
      titles: [...document.querySelectorAll('[title]')].some((n) => any(n.title)),
      project: any(JSON.stringify(BF.state.project)),
      state: any(JSON.stringify({ app: BF.state.app, tools: BF.state.tools, info: BF.state.info })),
      storage: any(ls + ss),
      log: any(String(document.getElementById('log') ? document.getElementById('log').textContent : ''))
    };
  })()`);
}
const assertNoLeak = async (page, where) => {
  const l = await leaks(page);
  assert.deepEqual(Object.entries(l).filter(([, v]) => v).map(([k]) => k), [], `a chave apareceu (${where}): ${JSON.stringify(l)}`);
};

function scanFiles(dir, needle) {
  const hits = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try { if (fs.statSync(p).size < 64 * 1024 * 1024 && fs.readFileSync(p).toString('latin1').includes(needle)) hits.push(p); } catch { /* em uso */ }
      }
    }
  };
  walk(dir);
  return hits;
}

const chipText = (page) => page.eval("[...document.querySelector('#anOrLimits .bfor-limits .bds-chip').childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('')");
const optionIds = (page) => page.eval("[...document.querySelectorAll('#anOrPicker [role=\"option\"]')].map((o) => o.dataset.model)");
const selectedIds = (page) => page.eval("[...document.querySelectorAll('#anOrPicker [role=\"option\"][aria-selected=\"true\"]')].map((o) => o.dataset.model)");
const aiState = (page) => page.eval("BF.api('analysis:aiState').then((r) => r.ai)");
const pickerReady = (page) => waitFor(page, "!!document.querySelector('#anOrPicker .bfor-picker[data-state=\"ready\"]')", 15000, 'lista de modelos do OpenRouter');

async function main() {
  assert.ok(tools.ffmpeg && tools.ffprobe, 'ffmpeg/ffprobe necessários para o teste');
  const tmp = h.mkTemp('e2e-analysis-openrouter');
  const userData = path.join(tmp, 'userdata');
  const video = path.join(tmp, 'live-or.mp4');
  const srt = path.join(tmp, 'live-or.srt');
  const shotDir = process.env.BF_E2E_SHOTDIR;
  let mock = null;

  try {
    // vídeo de 12 min (pequeno) e transcrição sintética com dois momentos conhecidos
    require('node:child_process').execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=5:duration=720',
      '-f', 'lavfi', '-i', 'sine=frequency=330:duration=720', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '32k', '-shortest', video], { windowsHide: true });
    const tr = A.makeTranscript({ minutes: 12, moments: [{ at: 120, punch: 'o bicho nem dropou couro' }, { at: 300, punch: 'obrigado jogo eu morri afogado' }] });
    const stamp = (s) => `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')},${String(Math.round((s % 1) * 1000)).padStart(3, '0')}`;
    fs.writeFileSync(srt, tr.cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n'));
    step('vídeo de 12 min e legenda .srt sintéticos gerados');

    // servidor "OpenRouter" local: o que o chat responde muda de um passo para o outro
    const control = { chat: 'ok', remaining: 38, primaryFails: 'acme/medio-a:free' };
    const analysis = (call) => {
      if (isPick(call)) {
        const ids = [...lastContent(call).matchAll(/id=(c\d+)/g)].map((x) => x[1]);
        return { json: F.chatBody(JSON.stringify({ picks: ids.map((id, k) => ({ id, relevance: 0.92 - k * 0.1, title: `Momento final ${k + 1}`, category: 'Hype', reasons: ['escolhido na 2ª passada'] })) }), { answered: call.body.model === 'openrouter/free' ? 'zeta/medio-b:free' : call.body.model }) };
      }
      const m = tr.moments;
      return { json: F.chatBody(A.cutsJson([
        { start: m[0].start, end: m[0].end, punchline: m[0].punch, title: 'O rato que não dropou couro', relevance: 0.9 },
        { start: m[1].start, end: m[1].end, punchline: m[1].punch, title: 'Obrigado, jogo', relevance: 0.8 }
      ]), { answered: call.body.model === 'openrouter/free' ? 'acme/grande-ctx:free' : call.body.model }) };
    };
    mock = await F.startMockOpenRouter({
      models: () => ({ json: F.catalogBody() }),
      key: (call) => (call.headers.authorization === `Bearer ${F.KEY}` ? { json: F.keyBody({ used: 50 - control.remaining, limit: 50 }) } : F.ERRORS.auth401()),
      chat: (call) => {
        if (control.chat === '401') return F.ERRORS.auth401();
        if (control.chat === 'day') return F.ERRORS.rateLimitDay(Date.now());
        if (control.chat === 'policy') return F.ERRORS.dataPolicy404();
        if (control.chat === 'fallback' && call.body.model === control.primaryFails) return F.ERRORS.rateLimitMinute(Date.now());
        return analysis(call);
      }
    });
    const env = { BF_OPENROUTER_BASE_URL: mock.base };

    let app = await h.launchApp(userData, { env });
    let page = app.page;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 840, deviceScaleFactor: 1, mobile: false });
    assert.deepEqual(await page.eval('BF.state.loadErrors'), []);
    await page.eval(`BF.openSource(${q(video)})`);
    await waitFor(page, "!document.getElementById('app').classList.contains('no-project')", 20000, 'projeto aberto');
    await page.eval("BF.ui.selectTab('analysis')");
    await waitFor(page, "!document.getElementById('tabpanel-analysis').hidden", 5000, 'aba Análise visível');
    await waitFor(page, "document.getElementById('anProvider').textContent.length > 0 && !/Carregando/.test(document.getElementById('anProvider').textContent)", 10000, 'estado da IA carregado');
    await click(page, '#anEngine-ai');
    await waitFor(page, "document.getElementById('anEngine-ai').getAttribute('aria-selected') === 'true'", 5000, 'motor IA');
    // transcrição importada (a IA só trabalha sobre o texto)
    await page.eval(`BF.api('analysis:transcriptImport', { projectId: BF.state.project.id, path: BF.state.project.source.path, size: BF.state.project.source.size, duration: BF.state.project.source.duration, subtitlePath: ${q(srt)} }).then((r) => { window.__imp = r; })`);
    assert.equal(await page.eval('window.__imp.ok'), true, JSON.stringify(await page.eval('window.__imp')));
    await page.eval("BF.ui.selectTab('cuts'); BF.ui.selectTab('analysis')");
    await waitFor(page, "document.getElementById('anTChip').textContent === 'Importada'", 10000, 'transcrição importada na tela');

    // ---- escolher o OpenRouter: lista, roteador primeiro, nada selecionado, interruptor ligado ----
    assert.equal(await visible(page, '#anOrBlock'), false, 'sem provedor escolhido não há seletor do OpenRouter');
    await setValue(page, '#anCfgProvider', 'openrouter', ['change']);
    await waitFor(page, "!document.getElementById('anOrBlock').hidden", 8000, 'seletor do OpenRouter na tela');
    await pickerReady(page);
    assert.equal(await visible(page, '#anCfgModel'), false, 'o campo de texto livre do modelo some no OpenRouter');
    assert.equal(await visible(page, '#anOrPicker'), true);
    const ids = await optionIds(page);
    assert.equal(ids[0], 'openrouter/free', 'o roteador gratuito é o PRIMEIRO item da lista');
    assert.deepEqual(ids.slice(1, 4), ['acme/grande-ctx:free', 'acme/medio-a:free', 'zeta/medio-b:free'], 'os gratuitos adequados logo abaixo, maior contexto primeiro');
    const yRouter = await page.eval("document.querySelector('#anOrPicker [data-model=\"openrouter/free\"]').getBoundingClientRect().top");
    const yTitle = await page.eval("[...document.querySelectorAll('#anOrPicker .bfor-group-title')].find((n) => n.textContent === 'Modelos gratuitos').getBoundingClientRect().top");
    const yFirst = await page.eval("document.querySelector('#anOrPicker [data-model=\"acme/grande-ctx:free\"]').getBoundingClientRect().top");
    assert.ok(yRouter < yTitle && yTitle < yFirst, `ordem visual: roteador ${yRouter} < "Modelos gratuitos" ${yTitle} < 1º gratuito ${yFirst}`);
    assert.deepEqual(await selectedIds(page), ['openrouter/free'], 'o roteador gratuito já vem selecionado (modelo de partida; o provedor foi escolha do usuário)');
    assert.equal(await page.eval("document.querySelector('#anOrPicker .bds-switch').checked"), true, '"Usar apenas modelos gratuitos" ligado por padrão');
    assert.equal(await visible(page, '#anOrPicker [data-group="paid"]'), false, 'sem modelos pagos na lista');
    let st = await aiState(page);
    assert.equal(st.provider.id, 'openrouter');
    assert.equal(st.provider.freeOnly, true, 'e guardado por provedor no processo principal, não só na tela');
    assert.equal(st.provider.model, 'openrouter/free', 'o modelo de partida é o roteador gratuito (nenhum modelo pago vem escolhido)');
    assert.match(await text(page, '#anProvider'), /OpenRouter: Informe a chave de API\./);
    assert.equal(await visible(page, '#anOrLimits .bfor-limits'), false, 'sem chave o selo de limites não aparece');
    assert.equal(mock.count('GET', '/api/v1/key'), 0, 'sem chave nem pergunta quantos pedidos restam');
    assert.ok(mock.calls.filter((c) => c.path === '/api/v1/models').every((c) => c.headers.authorization === undefined), 'a lista de modelos é pública: sem chave');
    step('OpenRouter escolhido: lista com o roteador gratuito PRIMEIRO (na tela) e os gratuitos logo abaixo, o roteador já selecionado, interruptor ligado e guardado no processo principal, sem selo de limites sem chave');

    // ---- a chave e o selo de pedidos restantes ----
    await page.eval(`(() => { document.getElementById('anCfgKey').value = ${q(F.KEY)}; })()`);
    await click(page, '#anCfgKeySave');
    await waitFor(page, "/Chave guardada neste computador/.test(document.getElementById('anCfgKeyState').textContent)", 10000, 'chave guardada');
    await waitFor(page, "!!document.querySelector('#anOrLimits .bfor-limits') && !document.querySelector('#anOrLimits .bfor-limits').hidden", 10000, 'selo de limites');
    assert.match(await chipText(page), /^Restam 38 de 50 pedidos gratuitos hoje · renova (amanhã )?às 21:00$/);
    assert.equal(await page.eval("document.getElementById('anCfgKey').value"), '', 'o campo da chave foi limpo');
    await assertNoLeak(page, 'depois de guardar a chave');
    assert.deepEqual(await selectedIds(page), ['openrouter/free'], 'guardar a chave não troca o modelo: o roteador segue selecionado');
    if (shotDir) {
      fs.mkdirSync(shotDir, { recursive: true });
      for (const theme of ['dark', 'light']) {
        await page.eval(`BF.ui.setTheme(${q(theme)})`);
        await sleep(400);
        await page.eval("document.getElementById('anProviderCard').scrollIntoView({ block: 'start' }); true");
        await sleep(300);
        await h.screenshot(page, path.join(shotDir, `openrouter-cartao-${theme === 'dark' ? 'escuro' : 'claro'}-1-lista.png`));
      }
      await page.eval("BF.ui.setTheme('dark')");
    }
    step('chave guardada (campo limpo, nada vaza): o selo "Restam 38 de 50 pedidos gratuitos hoje · renova às 21:00" aparece no cartão');

    // ---- escolher o roteador ----
    await click(page, '#anOrPicker [data-model="openrouter/free"]');
    await waitFor(page, "document.getElementById('anProvider').textContent.includes('Automático — roteador gratuito')", 10000, 'roteador escolhido');
    st = await aiState(page);
    assert.equal(st.provider.model, 'openrouter/free');
    assert.equal(st.provider.ready, true);
    assert.deepEqual(await selectedIds(page), ['openrouter/free']);
    assert.equal(await text(page, '#anPChip'), 'Aviso pendente');
    assert.equal(chatCalls(mock).length, 0, 'escolher o modelo não envia nada');
    await waitFor(page, "/Estimativa: ~2 chamadas?, ~\\d+ mil tokens/.test(document.getElementById('anEstimate').textContent)", 10000, 'estimativa');
    await waitFor(page, "!document.getElementById('anEstimateFree').hidden", 10000, 'estimativa comparada com os pedidos gratuitos');
    assert.match(await text(page, '#anEstimateFree'), /A análise usa cerca de 2 pedidos; restam 38 hoje\./);
    assert.equal(await page.eval("document.getElementById('anRun').disabled"), false, 'a estimativa só avisa: não bloqueia');
    step('roteador escolhido: provedor pronto (aviso pendente), nada enviado, e a estimativa "~2 chamadas" é comparada com os 38 pedidos gratuitos que restam (avisa, não bloqueia)');

    // ---- aviso de privacidade com o parágrafo dos modelos gratuitos ----
    await click(page, '#anRun');
    await waitFor(page, "!!document.querySelector('.bf-modal')", 10000, 'aviso de privacidade');
    const message = await text(page, '.bf-modal .bf-modal-msg');
    assert.match(message, /Quem recebe: OpenRouter \(127\.0\.0\.1:\d+\)/);
    assert.ok(message.includes(FREE_PARAGRAPH), 'o aviso do OpenRouter traz o parágrafo dos modelos gratuitos');
    assert.match(message, /O aviso fica aceito para este provedor até você revogar\. Não tem prazo\./);
    assert.ok(!message.includes(F.KEY));
    if (shotDir) {
      await sleep(300);
      for (const theme of ['dark', 'light']) {
        await page.eval(`BF.ui.setTheme(${q(theme)})`);
        await sleep(400);
        await h.screenshot(page, path.join(shotDir, `openrouter-cartao-${theme === 'dark' ? 'escuro' : 'claro'}-4-aviso-de-privacidade.png`));
      }
      await page.eval("BF.ui.setTheme('dark')");
    }
    await answerModal(page, false); // "Agora não"
    await sleep(500);
    assert.equal(chatCalls(mock).length, 0, 'recusar o aviso não envia nada');
    step('aviso de privacidade: traz o parágrafo "Modelos gratuitos podem usar o que você envia para treino ou publicação…", vale por provedor e sem prazo; recusar não envia nada');

    // ---- a análise de verdade contra o servidor local ----
    await page.eval("window.__done = 0; BF.on('analysis:done', () => { window.__done += 1; }); BF.on('analysis:failed', () => { window.__done += 1; }); true");
    await click(page, '#anRun');
    await answerModal(page, true);
    await waitFor(page, 'window.__done >= 1', 90000, 'fim da análise por IA');
    await waitFor(page, "!document.getElementById('anRun').disabled && document.getElementById('anRun').textContent === 'Analisar'", 10000, 'interface liberada');
    assert.equal(await page.eval("document.getElementById('anCfgAccept').checked"), true, 'aceite lembrado');
    const sentCalls = chatCalls(mock);
    assert.equal(sentCalls.length, 2, 'um bloco e a escolha final');
    for (const call of sentCalls) {
      assert.equal(call.body.model, 'openrouter/free');
      assert.equal(call.headers.authorization, `Bearer ${F.KEY}`);
      assert.ok(!call.raw.includes(F.KEY));
      assert.ok(!('models' in call.body) && !('route' in call.body), 'nenhum fallback pago no corpo');
    }
    assert.equal(mock.count('GET', '/api/v1/models') >= 1, true);
    assert.equal(await page.eval('BF.state.project.ext.analysis.engine'), 'ai');
    assert.deepEqual(await page.eval('BF.state.project.ext.analysis.ai.models'), { 'acme/grande-ctx:free': 1, 'zeta/medio-b:free': 1 });
    assert.equal(await visible(page, '#anModels'), true);
    assert.equal(await text(page, '#anModels'), 'Modelo(s) que responderam: acme/grande-ctx:free (1 chamada), zeta/medio-b:free (1 chamada)');
    assert.match(await text(page, '#anSummary'), /2 sugestão\(ões\) encontrada\(s\) · IA: OpenRouter · openrouter\/free · 2 chamadas/);
    assert.equal(await page.eval('document.querySelectorAll("#anList .an-item").length'), 2);
    await assertNoLeak(page, 'depois da análise');
    if (shotDir) {
      for (const theme of ['dark', 'light']) {
        await page.eval(`BF.ui.setTheme(${q(theme)})`);
        await sleep(400);
        await page.eval('document.getElementById("anResults").scrollIntoView(); true');
        await sleep(300);
        await h.screenshot(page, path.join(shotDir, `openrouter-cartao-${theme === 'dark' ? 'escuro' : 'claro'}-5-resultado.png`));
      }
      await page.eval("BF.ui.setTheme('dark')");
    }
    step('análise com o roteador: o servidor local respondeu com outros modelos e o resultado mostra "Modelo(s) que responderam: …"; o corpo enviado tem o modelo escolhido e a chave só no cabeçalho, sem `models`/`route`');

    // ---- modelo pago forçado: recusado, nada chega ao servidor ----
    const before = chatCalls(mock).length;
    await page.eval("BF.api('analysis:aiSave', { model: 'vendor/pago-barato' }).then((r) => { window.__forced = r.ok; })");
    assert.equal(await page.eval('window.__forced'), true, 'o modelo digitado por fora da lista é gravado, mas o provedor deixa de ficar pronto');
    await page.eval("BF.ui.selectTab('cuts'); BF.ui.selectTab('analysis')");
    await waitFor(page, "/não é gratuito/.test(document.getElementById('anProvider').textContent)", 10000, 'recusa do modelo pago na tela');
    assert.match(await text(page, '#anProvider'), /OpenRouter: O modelo "vendor\/pago-barato" não é gratuito/);
    assert.match(await text(page, '#anProvider'), /nada foi enviado e nada foi cobrado/);
    assert.equal(await page.eval("document.getElementById('anRun').disabled"), true, 'Analisar travado com o motivo');
    assert.match(await text(page, '#anAiWarn'), /não é gratuito/);
    assert.equal(await text(page, '#anPChip'), 'Falta configurar');
    assert.match(await text(page, '#anOrPicker .bfor-value-note'), /O modelo escolhido \(vendor\/pago-barato\) não está na lista de modelos gratuitos/);
    assert.deepEqual(await selectedIds(page), [], 'o pago não está na lista gratuita: nada marcado');
    const forcedStart = await page.eval(`BF.api('analysis:start', { engine: 'ai', projectId: BF.state.project.id, path: BF.state.project.source.path, size: BF.state.project.source.size, duration: BF.state.project.source.duration, params: {}, meta: {}, existingCuts: [] })`);
    assert.deepEqual([forcedStart.ok, forcedStart.code], [false, 'NOT_FREE'], 'também se alguém pedir a análise por fora da tela');
    assert.match(forcedStart.message, /O modelo "vendor\/pago-barato" não é gratuito/);
    assert.equal(chatCalls(mock).length, before, 'nenhum pedido chegou ao servidor');
    await assertNoLeak(page, 'depois da recusa');
    // volta para um modelo gratuito pela lista
    await click(page, '#anOrPicker [data-model="acme/medio-a:free"]');
    await waitFor(page, "document.getElementById('anProvider').textContent.includes('acme/medio-a:free')", 10000, 'modelo gratuito escolhido');
    assert.equal(await page.eval("document.getElementById('anRun').disabled"), false);
    step('modelo PAGO forçado por fora da lista: o cartão mostra a recusa (NOT_FREE), Analisar trava e a análise pedida por fora também é recusada; nada chegou ao servidor');

    // ---- modelos de reserva: 429 troca para a reserva gratuita ----
    assert.equal(await page.eval("document.getElementById('anOrReserveBox').open"), false, '"Modelos de reserva" começa recolhido');
    await page.eval("document.getElementById('anOrReserveBox').open = true");
    await waitFor(page, "document.getElementById('anOrReserve1').children.length > 3", 10000, 'opções das reservas');
    const reserveOptions = await page.eval("[...document.getElementById('anOrReserve1').children].map((o) => o.value)");
    assert.equal(reserveOptions[0], '');
    assert.ok(reserveOptions.includes('openrouter/free') && reserveOptions.includes('zeta/medio-b:free'));
    assert.ok(!reserveOptions.some((id) => /vendor|trap|omega|musica|imagem/.test(id)), `só modelos gratuitos adequados nas reservas: ${reserveOptions}`);
    assert.equal(await page.eval("[...document.getElementById('anOrReserve1').children].find((o) => o.value === 'acme/medio-a:free').disabled"), true, 'o modelo principal não se repete na reserva');
    await setValue(page, '#anOrReserve1', 'zeta/medio-b:free', ['change']);
    await waitFor(page, "/Modelos de reserva \\(1\\)/.test(document.getElementById('anOrReserveBox').children[0].textContent)", 10000, 'reserva guardada');
    st = await aiState(page);
    assert.deepEqual(st.provider.fallbackModels, ['zeta/medio-b:free']);
    assert.equal(await page.eval("[...document.getElementById('anOrReserve2').children].find((o) => o.value === 'zeta/medio-b:free').disabled"), true, 'um modelo só entra uma vez');
    if (shotDir) {
      for (const theme of ['dark', 'light']) {
        await page.eval(`BF.ui.setTheme(${q(theme)})`);
        await sleep(400);
        await page.eval("document.getElementById('anOrReserveBox').scrollIntoView({ block: 'center' }); true");
        await sleep(300);
        await h.screenshot(page, path.join(shotDir, `openrouter-cartao-${theme === 'dark' ? 'escuro' : 'claro'}-3-reserva.png`));
      }
      await page.eval("BF.ui.setTheme('dark')");
    }
    control.chat = 'fallback';
    mock.calls.length = 0;
    await page.eval("window.__done = 0; true");
    await click(page, '#anRun');
    await waitFor(page, 'window.__done >= 1', 90000, 'fim da análise com a troca de modelo');
    await waitFor(page, "!document.getElementById('anRun').disabled && document.getElementById('anRun').textContent === 'Analisar'", 10000, 'interface liberada');
    const order = chatCalls(mock).map((c) => c.body.model);
    assert.equal(order[0], 'acme/medio-a:free', 'tentou o escolhido primeiro');
    assert.ok(order.includes('zeta/medio-b:free'), 'e trocou para a reserva');
    assert.ok(!order.some((id) => /vendor|trap/.test(id)), 'só gratuitos');
    // cada chamada da análise tenta o modelo escolhido primeiro (429) e a reserva responde: quem responde é só a reserva
    const answered = order.filter((id) => id === 'zeta/medio-b:free').length;
    assert.equal(order.filter((id) => id === 'acme/medio-a:free').length, answered, 'cada chamada tentou o escolhido antes da reserva');
    assert.equal(await text(page, '#anModels'), `Modelo(s) que responderam: zeta/medio-b:free (${answered} ${answered === 1 ? 'chamada' : 'chamadas'})`);
    assert.match(await text(page, '#anNotice'), /O app trocou de modelo durante a análise: acme\/medio-a:free \(limite de uso\) → zeta\/medio-b:free/);
    step('429 no modelo escolhido: o app usa a reserva gratuita (a lista dele, em ordem), o resultado diz quem respondeu e o aviso conta a troca');

    // ---- chave recusada: não troca de modelo; erro explicado ----
    control.chat = '401';
    mock.calls.length = 0;
    await page.eval("window.__done = 0; true");
    await click(page, '#anRun');
    await waitFor(page, "!!document.getElementById('anFallback')", 30000, 'falha da IA com a opção do algoritmo');
    const fail401 = await text(page, '#anFallback');
    assert.match(fail401, /O OpenRouter recusou a chave de API/);
    assert.match(fail401, /Usar o algoritmo/);
    assert.ok(!fail401.includes(F.KEY));
    assert.equal(chatCalls(mock).length, 1, '401: um pedido só, sem trocar de modelo e sem repetir');
    step('401: a chave recusada NÃO troca de modelo; a mensagem é clara e não traz a chave');

    // ---- 429 do dia, política de dados ----
    // 429 do DIA: acabou para todos os modelos gratuitos, então não adianta trocar (1 pedido). Política de dados (404): é o provedor DAQUELE modelo,
    // então a reserva configurada ainda é tentada (escolhido, depois a reserva) e, se ela também falhar, o erro chega à tela explicado.
    for (const [mode, re, expected] of [
      ['day', /Os pedidos gratuitos de hoje do OpenRouter acabaram: restam 0 de 50[\s\S]*renova (amanhã )?às 21:00[\s\S]*US\$ 10 em créditos[\s\S]*1\.000 pedidos/, ['acme/medio-a:free']],
      ['policy', /podem usar o que você envia para treino ou publicação[\s\S]*em Privacy na conta do OpenRouter[\s\S]*decisão sua: o app não altera a sua conta/, ['acme/medio-a:free', 'zeta/medio-b:free']]
    ]) {
      control.chat = mode;
      mock.calls.length = 0;
      await click(page, '#anRun');
      await waitFor(page, `(() => { const f = document.getElementById('anFallback'); return !!f && !/recusou a chave/.test(f.textContent); })()`, 30000, `falha ${mode}`);
      const failText = await text(page, '#anFallback');
      assert.match(failText, re, mode);
      assert.ok(!failText.includes(F.KEY));
      assert.deepEqual(chatCalls(mock).map((c) => c.body.model), expected, `${mode}: pedidos enviados`);
      await waitFor(page, "!document.getElementById('anRun').disabled", 10000, 'interface liberada');
    }
    await assertNoLeak(page, 'depois dos erros explicados');
    h.assertNoConsoleErrors(page);
    step('429 do dia (não troca de modelo: 1 pedido) e 404 de política de dados (tenta a reserva e então explica): cada um chega à tela explicado (quando renova, US$ 10 → 1.000; Privacy na conta, decisão do usuário)');

    // ---- desligar o interruptor é explícito ----
    control.chat = 'ok';
    await click(page, '#anOrPicker .bds-switch');
    await waitFor(page, "document.querySelectorAll('#anOrPicker [data-group=\"paid\"]').length > 3", 15000, 'pagos na lista');
    st = await aiState(page);
    assert.equal(st.provider.freeOnly, false, 'desligar é guardado');
    assert.ok(!st.provider.privacy.includes(FREE_PARAGRAPH), 'e o parágrafo dos modelos gratuitos sai do aviso');
    assert.equal(st.accepted, true, 'o aceite é do provedor: continua');
    assert.equal(await visible(page, '#anOrPicker .bfor-cost'), true, 'aviso de custo visível');
    assert.match(await text(page, '#anOrPicker [data-model="vendor/pago-barato"]'), /Entrada US\$ 0,30 · saída US\$ 2,50 por milhão de tokens/);
    assert.equal((await optionIds(page))[0], 'openrouter/free', 'o roteador continua primeiro');
    if (shotDir) {
      for (const theme of ['dark', 'light']) {
        await page.eval(`BF.ui.setTheme(${q(theme)})`);
        await sleep(400);
        await page.eval("document.getElementById('anProviderCard').scrollIntoView({ block: 'start' }); true");
        await sleep(300);
        await h.screenshot(page, path.join(shotDir, `openrouter-cartao-${theme === 'dark' ? 'escuro' : 'claro'}-2-pagos.png`));
      }
      await page.eval("BF.ui.setTheme('dark')");
    }
    await click(page, '#anOrPicker [data-model="vendor/pago-barato"]');
    await waitFor(page, "document.getElementById('anProvider').textContent.includes('vendor/pago-barato') && !/não é gratuito/.test(document.getElementById('anProvider').textContent)", 10000, 'modelo pago aceito com o interruptor desligado');
    assert.equal(await page.eval("document.getElementById('anRun').disabled"), false);
    // ligar de novo traz a recusa de volta
    await click(page, '#anOrPicker .bds-switch');
    await waitFor(page, "/não é gratuito/.test(document.getElementById('anProvider').textContent)", 15000, 'recusa de volta');
    assert.equal((await aiState(page)).provider.freeOnly, true);
    assert.equal(await page.eval("document.getElementById('anRun').disabled"), true);
    await click(page, '#anOrPicker [data-model="openrouter/free"]');
    await waitFor(page, "document.getElementById('anProvider').textContent.includes('Automático — roteador gratuito')", 10000, 'roteador de novo');
    step('desligar "Usar apenas modelos gratuitos" é explícito (aviso de custo, preço por milhão, parágrafo do aviso some, aceite fica); ligar de novo recusa o modelo pago');

    // ---- depois de reiniciar ----
    await app.stop();
    app = await h.launchApp(userData, { env });
    page = app.page;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 840, deviceScaleFactor: 1, mobile: false });
    await page.eval(`BF.openSource(${q(video)})`);
    await waitFor(page, "!document.getElementById('app').classList.contains('no-project')", 20000, 'projeto reaberto');
    await page.eval("BF.ui.selectTab('analysis')");
    await click(page, '#anEngine-ai');
    await waitFor(page, "!document.getElementById('anOrBlock').hidden", 10000, 'seletor do OpenRouter lembrado');
    await pickerReady(page);
    st = await aiState(page);
    assert.deepEqual([st.provider.id, st.provider.model, st.provider.freeOnly, st.provider.fallbackModels, st.accepted], ['openrouter', 'openrouter/free', true, ['zeta/medio-b:free'], true]);
    assert.deepEqual(await selectedIds(page), ['openrouter/free'], 'o modelo guardado vem marcado');
    assert.equal(await page.eval("document.querySelector('#anOrPicker .bds-switch').checked"), true);
    await waitFor(page, "!!document.querySelector('#anOrLimits .bfor-limits') && !document.querySelector('#anOrLimits .bfor-limits').hidden", 10000, 'selo de limites lembrado');
    assert.equal(await page.eval("document.getElementById('anCfgKey').value"), '');
    await assertNoLeak(page, 'depois de reiniciar');
    h.assertNoConsoleErrors(page);
    await app.stop();
    step('persistência: provedor, modelo, interruptor, reserva, aceite e chave sobrevivem ao reinício; o modelo guardado vem marcado; zero erros no console');

    // ---- a chave nunca ficou em arquivo ----
    const hits = scanFiles(userData, F.KEY);
    assert.deepEqual(hits, [], `a chave apareceu em arquivo(s): ${hits.join(', ')}`);
    assert.deepEqual(scanFiles(userData, F.KEY_LABEL), []);
    step(`a chave não está em nenhum arquivo do perfil (${fs.existsSync(path.join(userData, 'ai', 'secrets.json')) ? 'secrets.json existe, mas cifrado' : 'sem secrets.json'})`);

    console.log('! este e2e usa um servidor local no lugar do OpenRouter: nenhuma chamada de rede real (o teste opt-in com chave é tests/ai-openrouter-real.test.js)');
    console.log('\nanalysis-openrouter.e2e: tudo certo');
  } finally {
    await h.cleanupAll();
    if (mock) await mock.close();
    h.removeDir(tmp);
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });

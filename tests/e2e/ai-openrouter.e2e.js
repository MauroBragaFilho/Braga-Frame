'use strict';

/**
 * E2E do OpenRouter "só com modelos gratuitos": app Electron de verdade (perfil temporário) falando com um servidor HTTP LOCAL que imita o
 * OpenRouter (tests/ai-openrouter-fakes.js, apontado por BF_OPENROUTER_BASE_URL). Monta o seletor de modelos e o selo de pedidos restantes
 * numa sobreposição de teste (a integração no cartão do provedor é a fase 2) e confere: o roteador gratuito PRIMEIRO (na tela, não só no
 * DOM), "Modelos gratuitos" logo abaixo, nada selecionado, seleção por clique e por teclado (setas, Home/End, Enter, digitar o nome),
 * "Outros gratuitos" recolhido com o motivo, o interruptor mostrando/ocultando os pagos com o aviso de custo e o preço por milhão, a busca,
 * "Atualizar lista", o modo sem internet (cache), o selo de pedidos restantes (inclusive sem chave e com chave recusada), nenhum erro de
 * console, nenhum scroll horizontal e a CHAVE fora da tela, do projeto, do navegador e de todos os arquivos do perfil.
 * Uso: node tests/e2e/ai-openrouter.e2e.js   (BF_E2E_SHOTDIR=<pasta> guarda capturas 1360x840 nos temas escuro e claro)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../ai-openrouter-fakes');
const h = require('./helpers');

const { sleep, waitFor } = h;
const step = (m) => console.log(`✔ ${m}`);
const q = (s) => JSON.stringify(s);

const text = (page, sel) => page.eval(`(document.querySelector(${q(sel)}) || {}).textContent ?? null`);
const click = (page, sel) => page.eval(`document.querySelector(${q(sel)}).click()`);
const exists = (page, sel) => page.eval(`!!document.querySelector(${q(sel)})`);
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

const KEY_CODES = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Home: 36, End: 35, ' ': 32 };
/** Tecla de verdade (DevTools) enviada ao elemento em foco. */
async function key(page, k) {
  const printable = k.length === 1;
  const base = { key: k, code: k === ' ' ? 'Space' : (printable ? `Key${k.toUpperCase()}` : k), windowsVirtualKeyCode: KEY_CODES[k] || k.toUpperCase().charCodeAt(0) };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(k === 'Enter' ? { text: '\r' } : {}), ...(printable ? { text: k } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

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
      state: any(JSON.stringify({ app: BF.state.app, tools: BF.state.tools, info: BF.state.info })),
      storage: any(ls + ss)
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

/** (Re)monta o seletor e o selo numa sobreposição que imita o cartão do painel de trabalho (480 px, à direita). */
async function mount(page, { value = '', freeOnly = true } = {}) {
  await page.eval(`(() => {
    const old = document.getElementById('orTestHost'); if (old) old.remove();
    const host = document.createElement('div');
    host.id = 'orTestHost';
    host.className = 'panel';
    const s = host.style;
    s.position = 'fixed'; s.top = '72px'; s.right = '24px'; s.width = '480px'; s.maxHeight = 'calc(100vh - 96px)'; s.overflowY = 'auto'; s.zIndex = '900';
    window.__picks = []; window.__free = [];
    const picker = BF.aiOpenRouter.createModelPicker({ value: ${q(value)}, freeOnly: ${freeOnly}, onChange: (id) => window.__picks.push(id), onFreeOnlyChange: (v) => window.__free.push(v) });
    const chip = BF.aiOpenRouter.createLimitsChip({ refreshMs: 3600000 });
    window.__chip = chip; window.__picker = picker;
    host.append(chip, picker);
    document.body.append(host);
    return true;
  })()`);
}

const optionIds = (page, scope = '#orTestHost') => page.eval(`[...document.querySelectorAll(${q(`${scope} [role="option"]`)})].map((o) => o.dataset.model)`);
const selectedIds = (page) => page.eval(`[...document.querySelectorAll('#orTestHost [role="option"][aria-selected="true"]')].map((o) => o.dataset.model)`);
/** Texto da linha de estado sem o glifo do ícone (que é uma ligadura de texto). */
const statusText = (page) => page.eval(`[...document.querySelector('#orTestHost .bfor-status').children].filter((n) => !n.classList.contains('material-symbols-rounded')).map((n) => n.textContent).join('')`);
/** Texto do selo de limites sem o glifo do ícone. */
const chipText = (page) => page.eval(`[...document.querySelector('#orTestHost .bfor-limits .bds-chip').childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('')`);
const optionText = (page, id) => page.eval(`(() => { const o = [...document.querySelectorAll('#orTestHost [role="option"]')].find((x) => x.dataset.model === ${q(id)}); return o ? o.textContent : null; })()`);
const topOfOption = (page, id) => page.eval(`[...document.querySelectorAll('#orTestHost [role="option"]')].find((x) => x.dataset.model === ${q(id)}).getBoundingClientRect().top`);
const active = (page, list = 'main') => page.eval(`(() => { const b = document.querySelector('#orTestHost [data-list="${list}"]'); const o = b.querySelector('#' + (b.getAttribute('aria-activedescendant') || 'nenhum')); return o ? o.dataset.model : null; })()`);

async function main() {
  const tmp = h.mkTemp('e2e-ai-openrouter');
  const userData = path.join(tmp, 'userdata');
  let mock = null;
  const shotDir = process.env.BF_E2E_SHOTDIR;

  try {
    // ---- servidor que imita o OpenRouter ----
    const state = { models: 'ok', key: 'ok', remaining: 38, chat: null };
    mock = await F.startMockOpenRouter({
      models: () => (state.models === 'drop' ? { drop: true } : { json: F.catalogBody() }),
      key: (call) => {
        if (call.headers.authorization !== `Bearer ${F.KEY}` || state.key === 'unauthorized') return F.ERRORS.auth401();
        return { json: F.keyBody({ used: 50 - state.remaining, limit: 50 }) };
      }
    });
    const env = { BF_OPENROUTER_BASE_URL: mock.base };

    let app = await h.launchApp(userData, { env });
    let page = app.page;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 840, deviceScaleFactor: 1, mobile: false });
    assert.deepEqual(await page.eval('BF.state.loadErrors'), []);
    assert.equal(await page.eval("typeof BF.aiOpenRouter.createModelPicker + '/' + typeof BF.aiOpenRouter.createLimitsChip"), 'function/function');
    assert.equal(await page.eval('BF.aiOpenRouter.ROUTER_ID'), 'openrouter/free');
    assert.equal(await exists(page, '#tab-aiOpenrouter'), false, 'a feature não tem aba');
    step('a feature carrega sem aba e expõe BF.aiOpenRouter (seletor de modelos e selo de limites)');

    // ---- a lista: ordem, nada selecionado ----
    await mount(page);
    // o roteador aparece NA HORA, antes de o catálogo chegar
    const early = await page.eval("[...document.querySelectorAll('#orTestHost [role=\"option\"]')].map((o) => o.dataset.model)");
    assert.equal(early[0], 'openrouter/free', 'o roteador é o primeiro item mesmo antes de a lista carregar');
    await waitFor(page, "document.querySelector('#orTestHost .bfor-picker').dataset.state === 'ready'", 15000, 'lista carregada');
    const ids = await optionIds(page);
    assert.equal(ids[0], 'openrouter/free');
    assert.equal(ids.filter((id) => id === 'openrouter/free').length, 1);
    assert.deepEqual(ids.slice(1, 11), [
      'acme/grande-ctx:free', 'acme/medio-a:free', 'zeta/medio-b:free', 'later/expira-em-60-dias:free', 'fmt/zeros-texto:free',
      'fmt/zeros-numero:free', 'fmt/override-zero:free', 'edge/expira-em-15-dias:free', 'beta/pequeno-ok:free', 'edge/ctx-60000:free'
    ]);
    // ordem VISUAL: roteador, depois o título "Modelos gratuitos", depois o primeiro gratuito
    const yRouter = await topOfOption(page, 'openrouter/free');
    const yTitle = await page.eval("[...document.querySelectorAll('#orTestHost .bfor-group-title')].find((n) => n.textContent === 'Modelos gratuitos').getBoundingClientRect().top");
    const yFirst = await topOfOption(page, 'acme/grande-ctx:free');
    assert.ok(yRouter < yTitle && yTitle < yFirst, `ordem visual: roteador ${yRouter} < título ${yTitle} < 1º gratuito ${yFirst}`);
    const topmost = await page.eval("(() => { const all = [...document.querySelectorAll('#orTestHost [role=\"option\"]')]; return all.reduce((a, b) => (b.getBoundingClientRect().top < a.getBoundingClientRect().top ? b : a)).dataset.model; })()");
    assert.equal(topmost, 'openrouter/free', 'o roteador é o item mais alto da lista');
    assert.match(await optionText(page, 'openrouter/free'), /Automático — roteador gratuito/);
    assert.equal(await page.eval("document.querySelector('#orTestHost [data-model=\"openrouter/free\"] .bds-chip').textContent"), 'Automático', 'selo "Automático"');
    assert.deepEqual(await selectedIds(page), [], 'NADA vem selecionado');
    assert.equal(await page.eval("document.querySelectorAll('#orTestHost [role=\"option\"][aria-selected=\"true\"]').length"), 0);
    assert.equal(await page.eval("[...document.querySelectorAll('#orTestHost [role=\"option\"]')].every((o) => o.getAttribute('aria-selected') === 'false')"), true);
    assert.equal(await page.eval("document.querySelector('#orTestHost [role=\"listbox\"]').getAttribute('role')"), 'listbox');
    assert.deepEqual(await page.eval('window.__picks'), [], 'carregar a lista não escolhe nada');
    step('lista: roteador gratuito PRIMEIRO (também na tela e antes de o catálogo chegar), "Modelos gratuitos" abaixo, adequados por contexto, nada selecionado');

    // ---- cabeçalho, selos e "Outros gratuitos" ----
    assert.equal(await page.eval("document.querySelector('#orTestHost .bds-switch').checked"), true, 'interruptor ligado por padrão');
    assert.equal(await text(page, '#orTestHost .bfor-switch-text strong'), 'Usar apenas modelos gratuitos');
    assert.match(await statusText(page), /^Lista de \d{2}\/\d{2} às \d{2}:\d{2}$/);
    assert.equal(await page.eval("document.querySelector('#orTestHost .bfor-refresh').textContent.trim().replace(/^refresh/, '')"), 'Atualizar lista');
    assert.equal(await visible(page, '#orTestHost .bfor-search'), false, 'sem busca no modo gratuito');
    assert.equal(await visible(page, '#orTestHost .bfor-cost'), false, 'sem aviso de custo no modo gratuito');
    assert.equal(await exists(page, '#orTestHost [data-group="paid"]'), false);
    const bigText = await optionText(page, 'acme/grande-ctx:free');
    assert.match(bigText, /Acme: Grande Contexto/);
    assert.match(bigText, /contexto 1 mi/);
    assert.match(bigText, /JSON/);
    assert.ok(!/\(free\)/.test(bigText), 'sem o "(free)" do catálogo');
    assert.match(await optionText(page, 'zeta/medio-b:free'), /contexto 262 mil/);
    assert.match(await optionText(page, 'later/expira-em-60-dias:free'), /expira \d{2}\/\d{2}/);
    assert.ok(!/expira/.test(await optionText(page, 'acme/medio-a:free')));
    // recolhido, esmaecido e com o motivo
    assert.equal(await text(page, '#orTestHost .bfor-fold > summary'), 'Outros gratuitos (9)');
    assert.equal(await page.eval("document.querySelector('#orTestHost .bfor-fold').open"), false, '"Outros gratuitos" começa recolhido');
    assert.equal(await visible(page, '#orTestHost [data-list="others"]'), false);
    await click(page, '#orTestHost .bfor-fold > summary');
    await waitFor(page, "document.querySelector('#orTestHost .bfor-fold').open", 5000, 'seção aberta');
    assert.equal(await visible(page, '#orTestHost [data-list="others"]'), true);
    assert.match(await optionText(page, 'omega/sem-json:free'), /sem saída em JSON/);
    assert.match(await optionText(page, 'edge/ctx-59999:free'), /contexto curto \(60 mil\)/);
    assert.match(await optionText(page, 'omega/expira-logo:free'), /expira em \d{2}\/\d{2}/);
    assert.match(await optionText(page, 'musica/lyria-like'), /não é modelo de conversa/);
    assert.match(await optionText(page, 'omega/nemo-guard-x:free'), /modelo de segurança, não de análise/);
    assert.equal(await page.eval("[...document.querySelectorAll('#orTestHost [data-list=\"others\"] [role=\"option\"]')].find((o) => o.dataset.model === 'omega/expirou:free').getAttribute('aria-disabled')"), 'true', 'expirado não dá para escolher');
    assert.equal(await page.eval("getComputedStyle(document.querySelector('#orTestHost [data-list=\"others\"] [role=\"option\"]')).opacity < 1"), true, 'esmaecidos');
    await click(page, '#orTestHost [data-model="omega/expirou:free"]');
    assert.deepEqual(await page.eval('window.__picks'), [], 'clicar em modelo expirado não escolhe nada');
    // o catálogo é público: nenhum Authorization foi enviado
    assert.ok(mock.calls.filter((c) => c.path === '/api/v1/models').every((c) => c.headers.authorization === undefined), 'o catálogo é baixado sem chave');
    step('cabeçalho (interruptor ligado, "Lista de dd/mm às hh:mm"), selos (contexto/JSON/expira) e "Outros gratuitos" recolhido, esmaecido, com o motivo');

    // ---- escolher por clique ----
    await click(page, '#orTestHost [data-model="acme/medio-a:free"]');
    assert.deepEqual(await page.eval('window.__picks'), ['acme/medio-a:free']);
    assert.deepEqual(await selectedIds(page), ['acme/medio-a:free']);
    assert.equal(await visible(page, '#orTestHost .bfor-router-hint'), false, 'dica do roteador só com o roteador escolhido');
    await click(page, '#orTestHost [data-model="openrouter/free"]');
    assert.deepEqual(await page.eval('window.__picks'), ['acme/medio-a:free', 'openrouter/free']);
    assert.deepEqual(await selectedIds(page), ['openrouter/free']);
    assert.equal(await visible(page, '#orTestHost .bfor-router-hint'), true);
    assert.match(await page.eval("document.querySelector('#orTestHost .bfor-router-hint').textContent"), /um modelo fixo costuma render mais/);
    step('clique escolhe o modelo (aria-selected só nele, onChange com o id); com o roteador aparece a dica de qualidade');

    // ---- teclado ----
    await page.eval("document.querySelector('#orTestHost [data-list=\"main\"]').focus()");
    assert.equal(await active(page), 'openrouter/free', 'ao focar, o item ativo é o selecionado');
    await key(page, 'ArrowDown');
    assert.equal(await active(page), 'acme/grande-ctx:free');
    await key(page, 'ArrowDown');
    assert.equal(await active(page), 'acme/medio-a:free');
    assert.deepEqual(await selectedIds(page), ['openrouter/free'], 'as setas só movem; quem escolhe é o Enter');
    await key(page, 'ArrowDown');
    await key(page, 'Enter');
    assert.equal(await page.eval('window.__picks.at(-1)'), 'zeta/medio-b:free');
    assert.deepEqual(await selectedIds(page), ['zeta/medio-b:free']);
    await key(page, 'ArrowUp');
    assert.equal(await active(page), 'acme/medio-a:free');
    await key(page, ' ');
    assert.equal(await page.eval('window.__picks.at(-1)'), 'acme/medio-a:free', 'espaço também escolhe');
    await key(page, 'End');
    assert.equal(await active(page), 'edge/ctx-60000:free', 'End vai ao último da lista principal');
    await key(page, 'Home');
    assert.equal(await active(page), 'openrouter/free', 'Home volta ao roteador');
    await key(page, 'ArrowUp');
    assert.equal(await active(page), 'openrouter/free', 'não passa do topo');
    await key(page, 'z');
    assert.equal(await active(page), 'zeta/medio-b:free', 'digitar o começo do nome vai ao modelo');
    assert.equal(await page.eval("document.querySelector('#orTestHost [data-list=\"main\"]').getAttribute('role')"), 'listbox');
    assert.equal(await page.eval("document.activeElement === document.querySelector('#orTestHost [data-list=\"main\"]')"), true, 'o foco fica na lista (aria-activedescendant)');
    // as listas de "Outros gratuitos" também respondem ao teclado e pulam o expirado
    await page.eval("document.querySelector('#orTestHost [data-list=\"others\"]').focus()");
    await key(page, 'End');
    assert.notEqual(await active(page, 'others'), 'omega/expirou:free', 'End pula o item desabilitado');
    step('teclado: setas movem, Enter/espaço escolhem, Home/End, digitar o nome e foco por aria-activedescendant (inclusive em "Outros gratuitos")');

    // ---- interruptor desligado: pagos, preço e aviso de custo ----
    await click(page, '#orTestHost .bds-switch');
    await waitFor(page, "document.querySelectorAll('#orTestHost [data-group=\"paid\"]').length > 5", 15000, 'pagos na lista');
    assert.deepEqual(await page.eval('window.__free'), [false]);
    assert.equal(await page.eval("document.querySelector('#orTestHost .bds-switch').checked"), false);
    assert.equal(await visible(page, '#orTestHost .bfor-cost'), true, 'aviso de custo visível');
    assert.match(await text(page, '#orTestHost .bfor-cost'), /cobrados na sua conta do OpenRouter/);
    assert.equal(await visible(page, '#orTestHost .bfor-search'), true, 'busca aparece com a lista longa');
    assert.match(await text(page, '#orTestHost .bfor-fold:last-of-type > summary'), /^Pagos \(\d+\)$/);
    const withPaid = await optionIds(page);
    assert.equal(withPaid[0], 'openrouter/free', 'o roteador continua primeiro');
    assert.equal(await topOfOption(page, 'openrouter/free') < await topOfOption(page, 'acme/grande-ctx:free'), true);
    assert.ok(withPaid.indexOf('vendor/pago-barato') > withPaid.indexOf('omega/expirou:free'), 'pagos depois dos gratuitos');
    assert.match(await optionText(page, 'vendor/pago-barato'), /Entrada US\$ 0,30 · saída US\$ 2,50 por milhão de tokens/);
    assert.match(await optionText(page, 'vendor/pago-caro'), /Entrada US\$ 15,00 · saída US\$ 75,00 por milhão de tokens/);
    assert.match(await optionText(page, 'openrouter/auto'), /Preço variável/);
    assert.match(await optionText(page, 'trap/preco-extra:free'), /outras tarifas/);
    assert.ok(!withPaid.includes('vendor/pago-imagem'), 'modelo que gera imagem não é de conversa');
    // busca
    await page.eval("(() => { const i = document.querySelector('#orTestHost .bfor-search'); i.value = 'vendor caro'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await waitFor(page, "document.querySelectorAll('#orTestHost [data-group=\"paid\"]').length === 1", 10000, 'busca aplicada');
    assert.deepEqual(await optionIds(page), ['openrouter/free', 'vendor/pago-caro'], 'busca: só o que combina; o roteador fica no topo');
    assert.match(await page.eval("document.querySelector('#orTestHost [data-list=\"main\"]').textContent"), /Nenhum modelo encontrado/);
    await click(page, '#orTestHost [data-model="vendor/pago-caro"]');
    assert.equal(await page.eval('window.__picks.at(-1)'), 'vendor/pago-caro');
    await page.eval("(() => { const i = document.querySelector('#orTestHost .bfor-search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await waitFor(page, "document.querySelectorAll('#orTestHost [data-group=\"paid\"]').length > 5", 10000, 'busca limpa');
    // volta ao modo gratuito: o pago escolhido deixa de estar na lista e a tela avisa
    await click(page, '#orTestHost .bds-switch');
    await waitFor(page, "document.querySelectorAll('#orTestHost [data-group=\"paid\"]').length === 0", 10000, 'pagos escondidos');
    assert.deepEqual(await page.eval('window.__free'), [false, true]);
    assert.equal(await visible(page, '#orTestHost .bfor-search'), false);
    assert.equal(await visible(page, '#orTestHost .bfor-value-note'), true, 'aviso do modelo que sumiu');
    assert.match(await text(page, '#orTestHost .bfor-value-note'), /O modelo escolhido \(vendor\/pago-caro\) não está na lista de modelos gratuitos/);
    assert.deepEqual(await selectedIds(page), [], 'o modelo pago não está na lista gratuita, então nada fica marcado');
    step('interruptor desligado: pagos depois dos gratuitos com o preço por milhão, aviso de custo, busca (roteador sempre no topo); ligado de novo, os pagos somem e a tela avisa do modelo que saiu');

    // ---- Atualizar lista ----
    const before = mock.count('GET', '/api/v1/models');
    await sleep(1100);
    await click(page, '#orTestHost .bfor-refresh');
    await waitFor(page, "document.querySelector('#orTestHost .bfor-picker').getAttribute('aria-busy') === 'false'", 15000, 'atualização concluída');
    assert.equal(mock.count('GET', '/api/v1/models'), before + 1, '"Atualizar lista" baixa de novo (ignora o cache de 6 h)');
    assert.match(await statusText(page), /^Lista de \d{2}\/\d{2} às \d{2}:\d{2}$/);
    // sem o botão, abrir de novo usa o cache (nenhum pedido novo)
    await mount(page);
    await waitFor(page, "document.querySelector('#orTestHost .bfor-picker').dataset.state === 'ready'", 15000, 'lista do cache');
    assert.equal(mock.count('GET', '/api/v1/models'), before + 1, 'lista montada de novo usa o cache de 6 h');
    step('"Atualizar lista" baixa de novo; abrir a lista sem o botão usa o cache');

    // ---- sem internet: o último cache, com a data ----
    state.models = 'drop';
    await click(page, '#orTestHost .bfor-refresh');
    await waitFor(page, "/Sem conexão com o OpenRouter: mostrando a lista de/.test(document.querySelector('#orTestHost .bfor-status').textContent)", 15000, 'aviso de falta de conexão');
    assert.match(await statusText(page), /^Sem conexão com o OpenRouter: mostrando a lista de \d{2}\/\d{2} às \d{2}:\d{2}\.$/);
    assert.equal(await page.eval("document.querySelector('#orTestHost .bfor-status').classList.contains('is-warn')"), true);
    assert.equal((await optionIds(page)).length, 20, 'a lista (do cache) continua inteira: roteador + 10 adequados + 9 outros gratuitos');
    assert.equal((await optionIds(page))[0], 'openrouter/free');
    if (shotDir) {
      fs.mkdirSync(shotDir, { recursive: true });
      await page.eval("window.scrollTo(0, 0); document.getElementById('orTestHost').scrollTop = 0; true");
      await sleep(300);
      await h.screenshot(page, path.join(shotDir, 'openrouter-escuro-4-sem-internet-com-cache.png'));
    }
    // sem cache nenhum: só o roteador, com o motivo, e ele continua escolhível
    fs.rmSync(path.join(userData, 'ai', 'openrouter-models.json'), { force: true });
    await click(page, '#orTestHost .bfor-refresh');
    await waitFor(page, "document.querySelector('#orTestHost .bfor-picker').dataset.state === 'error'", 15000, 'sem lista e sem cache');
    assert.deepEqual(await optionIds(page), ['openrouter/free'], 'sem catálogo e sem cache: o roteador está lá');
    assert.match(await page.eval("document.querySelector('#orTestHost .bfor-empty').textContent"), /Lista indisponível/);
    assert.match(await page.eval("document.querySelector('#orTestHost .bfor-empty').textContent"), /O roteador gratuito acima funciona sem a lista/);
    assert.equal(await visible(page, '#orTestHost .bfor-fold'), false);
    if (shotDir) await h.screenshot(page, path.join(shotDir, 'openrouter-escuro-5-sem-internet-sem-cache.png'));
    await click(page, '#orTestHost [data-model="openrouter/free"]');
    assert.equal(await page.eval('window.__picks.at(-1)'), 'openrouter/free', 'o roteador pode ser escolhido sem a lista');
    h.assertNoConsoleErrors(page);
    step('sem internet: usa o último cache e diz a data; sem cache nenhum, só o roteador (escolhível) com o motivo; nenhum erro');

    // ---- volta a rede; recarregar o app usa o cache em disco ----
    state.models = 'ok';
    await click(page, '#orTestHost .bfor-refresh');
    await waitFor(page, "document.querySelector('#orTestHost .bfor-picker').dataset.state === 'ready'", 15000, 'rede de volta');
    await app.stop();
    state.models = 'drop'; // o servidor "cai": o próximo app só tem o cache do disco
    const callsBeforeRestart = mock.count('GET', '/api/v1/models');
    app = await h.launchApp(userData, { env });
    page = app.page;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 840, deviceScaleFactor: 1, mobile: false });
    await mount(page, { value: 'zeta/medio-b:free' });
    await waitFor(page, "document.querySelector('#orTestHost .bfor-picker').dataset.state === 'ready'", 15000, 'lista do cache depois de reiniciar');
    assert.equal(mock.count('GET', '/api/v1/models'), callsBeforeRestart, 'depois de reiniciar, a lista vem do cache em disco (nenhum pedido)');
    assert.deepEqual(await selectedIds(page), ['zeta/medio-b:free'], 'o valor guardado vem marcado');
    assert.deepEqual(await page.eval('window.__picks'), [], 'montar com um valor não dispara onChange');
    assert.match(await statusText(page), /^Lista de \d{2}\/\d{2} às \d{2}:\d{2}$/);
    state.models = 'ok';
    step('depois de reiniciar: a lista vem do cache em disco, o valor guardado vem marcado e nada dispara onChange');

    // ---- selo de pedidos gratuitos restantes ----
    await mount(page);
    await waitFor(page, "document.querySelector('#orTestHost .bfor-picker').dataset.state === 'ready'", 15000, 'lista');
    await sleep(400);
    assert.equal(await page.eval("document.querySelector('#orTestHost .bfor-limits').hidden"), true, 'sem chave o selo some');
    assert.equal(mock.count('GET', '/api/v1/key'), 0, 'sem chave nem pergunta ao OpenRouter');
    // guarda a chave pelo canal da análise (cofre do app) e consulta de novo
    const saved = await page.eval(`BF.api('analysis:aiSave', { provider: 'openrouter', apiKey: ${q(F.KEY)} }).then((r) => ({ ok: r.ok, has: r.ai && r.ai.provider && r.ai.provider.hasKey }))`);
    assert.deepEqual(saved, { ok: true, has: true });
    await page.eval('window.__chip.refresh({ force: true }).then(() => true)');
    await waitFor(page, "!document.querySelector('#orTestHost .bfor-limits').hidden", 10000, 'selo visível');
    assert.match(await chipText(page), /^Restam 38 de 50 pedidos gratuitos hoje · renova (amanhã )?às 21:00$/);
    assert.equal(await page.eval("document.querySelector('#orTestHost .bfor-limits .bds-chip').classList.contains('bds-chip-ok')"), true);
    assert.equal(mock.calls.filter((c) => c.path === '/api/v1/key').every((c) => c.headers.authorization === `Bearer ${F.KEY}`), true, 'a chave foi usada só no cabeçalho, pelo processo principal');
    await assertNoLeak(page, 'com o selo de limites na tela');
    if (shotDir) {
      for (const theme of ['dark', 'light']) {
        await page.eval(`BF.ui.setTheme(${q(theme)})`);
        await sleep(400);
        await page.eval("document.getElementById('orTestHost').scrollTop = 0; document.querySelector('#orTestHost [data-list=\"main\"]').scrollTop = 0; true");
        await h.screenshot(page, path.join(shotDir, `openrouter-${theme === 'dark' ? 'escuro' : 'claro'}-1-so-gratuitos.png`));
      }
      await page.eval("BF.ui.setTheme('dark')");
    }
    // outras faixas do selo
    for (const [remaining, kind, re] of [[8, 'warn', /^Restam 8 de 50 pedidos gratuitos hoje/], [1, 'warn', /^Resta 1 de 50 pedido gratuito hoje/], [0, 'bad', /^Acabaram os 50 pedidos gratuitos de hoje/]]) {
      state.remaining = remaining;
      await page.eval('window.__chip.refresh({ force: true }).then(() => true)');
      assert.match(await chipText(page), re, `restam ${remaining}`);
      assert.equal(await page.eval(`document.querySelector('#orTestHost .bfor-limits .bds-chip').classList.contains('bds-chip-${kind}')`), true, `restam ${remaining}: selo ${kind}`);
    }
    state.remaining = 38;
    state.key = 'unauthorized';
    await page.eval('window.__chip.refresh({ force: true }).then(() => true)');
    assert.match(await chipText(page), /O OpenRouter recusou a chave/);
    await assertNoLeak(page, 'com a chave recusada');
    state.key = 'ok';
    await page.eval('window.__chip.refresh({ force: true }).then(() => true)');
    assert.match(await chipText(page), /Restam 38 de 50/);
    // sobrevive a um selo montado de novo (outra consulta)
    await mount(page);
    await waitFor(page, "!document.querySelector('#orTestHost .bfor-limits').hidden", 10000, 'selo de novo');
    step('selo "Restam N de L pedidos gratuitos hoje · renova às 21:00": some sem chave, aparece com a chave, muda de cor (ok/aviso/esgotado), trata chave recusada; a chave nunca aparece');

    // ---- capturas e verificação visual do componente ----
    if (shotDir) {
      state.models = 'ok';
      await page.eval("BF.ui.setTheme('dark')");
      await mount(page);
      await waitFor(page, "document.querySelector('#orTestHost .bfor-picker').dataset.state === 'ready'", 15000, 'lista');
      // um modelo escolhido por clique e o foco do teclado em outro (anel de foco), nos dois temas
      await click(page, '#orTestHost [data-model="zeta/medio-b:free"]');
      await page.eval("document.querySelector('#orTestHost [data-list=\"main\"]').focus()");
      await key(page, 'ArrowDown');
      await key(page, 'ArrowDown');
      await page.eval("document.querySelector('#orTestHost [data-list=\"others\"]').closest('details').open = false; document.getElementById('orTestHost').scrollTop = 0; true");
      for (const theme of ['dark', 'light']) {
        await page.eval(`BF.ui.setTheme(${q(theme)})`);
        await sleep(400);
        await h.screenshot(page, path.join(shotDir, `openrouter-${theme === 'dark' ? 'escuro' : 'claro'}-6-selecionado-teclado.png`));
      }
      await page.eval("BF.ui.setTheme('dark')");
      await mount(page);
      await waitFor(page, "document.querySelector('#orTestHost .bfor-picker').dataset.state === 'ready'", 15000, 'lista');
      await page.eval("document.querySelector('#orTestHost .bds-switch').click()");
      await waitFor(page, "document.querySelectorAll('#orTestHost [data-group=\"paid\"]').length > 5", 15000, 'pagos');
      await click(page, '#orTestHost .bfor-fold > summary'); // abre "Outros gratuitos"
      await sleep(400);
      await page.eval("document.getElementById('orTestHost').scrollTop = 0; true");
      await h.screenshot(page, path.join(shotDir, 'openrouter-escuro-2-com-pagos.png'));
      await page.eval("document.getElementById('orTestHost').scrollTop = 9999; true");
      await sleep(200);
      await h.screenshot(page, path.join(shotDir, 'openrouter-escuro-3-pagos-fim.png'));
      await page.eval("BF.ui.setTheme('light'); document.getElementById('orTestHost').scrollTop = 0; true");
      await sleep(400);
      await h.screenshot(page, path.join(shotDir, 'openrouter-claro-2-com-pagos.png'));
      await page.eval("BF.ui.setTheme('dark')");
    }

    // ---- sem rolagem horizontal, sem erro, sem chave ----
    await mount(page);
    await waitFor(page, "document.querySelector('#orTestHost .bfor-picker').dataset.state === 'ready'", 15000, 'lista');
    await page.eval("document.querySelector('#orTestHost .bds-switch').click()");
    await waitFor(page, "document.querySelectorAll('#orTestHost [data-group=\"paid\"]').length > 5", 15000, 'pagos');
    const overflow = await page.eval(`(() => {
      const host = document.getElementById('orTestHost');
      host.style.width = '440px'; // a largura mínima do painel de trabalho do app
      const wide = [...host.querySelectorAll('*')].filter((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX !== 'visible' && n.clientWidth > 0).map((n) => n.className);
      return { hostScroll: host.scrollWidth - host.clientWidth, listScroll: [...host.querySelectorAll('[role=listbox]')].map((b) => b.scrollWidth - b.clientWidth), wide };
    })()`);
    assert.ok(overflow.hostScroll <= 1, `rolagem horizontal no cartão: ${JSON.stringify(overflow)}`);
    assert.ok(overflow.listScroll.every((x) => x <= 1), `rolagem horizontal numa lista: ${JSON.stringify(overflow)}`);
    if (shotDir) {
      await page.eval("document.getElementById('orTestHost').scrollTop = 0; true");
      await sleep(300);
      await h.screenshot(page, path.join(shotDir, 'openrouter-escuro-7-painel-440px-com-pagos.png'));
    }
    h.assertNoConsoleErrors(page);
    await assertNoLeak(page, 'no fim');
    await app.stop();
    step('sem rolagem horizontal (lista de pagos incluída), zero erros no console e nenhuma chave na tela, no projeto ou no navegador');

    // ---- a chave nunca ficou em arquivo ----
    const hits = scanFiles(userData, F.KEY);
    assert.deepEqual(hits, [], `a chave apareceu em arquivo(s): ${hits.join(', ')}`);
    assert.deepEqual(scanFiles(userData, F.KEY_LABEL), []);
    const cache = fs.readFileSync(path.join(userData, 'ai', 'openrouter-models.json'), 'utf8');
    assert.ok(!cache.includes('Descrição longa') && JSON.parse(cache).models.length > 20, 'o cache em disco é enxuto');
    step(`a chave não está em nenhum arquivo do perfil (${fs.existsSync(path.join(userData, 'ai', 'secrets.json')) ? 'secrets.json existe, mas cifrado' : 'sem secrets.json'}); cache do catálogo enxuto`);

    console.log('! este e2e usa um servidor local no lugar do OpenRouter: nenhuma chamada de rede real (o teste opt-in com chave é tests/ai-openrouter-real.test.js)');
    console.log('\nai-openrouter.e2e: tudo certo');
  } finally {
    await h.cleanupAll();
    if (mock) await mock.close();
    h.removeDir(tmp);
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });

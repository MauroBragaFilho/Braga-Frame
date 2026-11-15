'use strict';

/**
 * E2E da central de revisão (dono: review): abre o app Electron de verdade (perfil temporário), cria um
 * vídeo real com ffmpeg (bipes de áudio em instantes conhecidos) e percorre a aba Cortes, a timeline e o
 * histórico pela interface: ordem, filtros, indicadores, seleção em lote com prévia/confirmação/desfazer,
 * ajuste de tempo ("alterado"), semelhantes, títulos, atalhos, forma de onda real, arrastar borda com o
 * mouse, restaurar do histórico e persistência após reiniciar.
 * Uso: node tests/e2e/review.e2e.js   (BF_E2E_SHOTDIR=<pasta> guarda capturas da janela)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { locateTools } = require('../../src/core/ffmpeg/locate');
const { projectIdFor } = require('../../src/core/projects/projectStore');
const h = require('./helpers');

const { sleep, waitFor, answerModal, modalOpen } = h;
const tools = locateTools();
const step = (m) => console.log(`✔ ${m}`);
const j = JSON.stringify;

/** Vídeo 40 s com bipes de 800 Hz em 5-6 s, 15-17 s e 25-26,5 s (amplitude ~0,75). */
function makeBeepVideo(file) {
  execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15:duration=40',
    '-f', 'lavfi', '-i', 'sine=frequency=800:sample_rate=44100:duration=40',
    '-af', "volume='6*(between(t,5,6)+between(t,15,17)+between(t,25,26.5))':eval=frame",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { windowsHide: true });
}

// ---------- ajudantes de página ----------

const rows = (page) => page.eval(`[...document.querySelectorAll('#cuts .cut')].map((c) => ({
  id: c.dataset.id, title: c.querySelector('.cut-title').value, cls: c.className, origin: c.dataset.origin, reviewed: c.dataset.reviewed,
  changed: c.dataset.changed, similar: c.dataset.similar, custom: c.dataset.custom, picked: c.querySelector('.cut-pick').checked,
  chips: [...c.querySelectorAll('.chips .chip')].map((x) => x.textContent), status: c.className.includes('approved') ? 'approved' : c.className.includes('rejected') ? 'rejected' : 'pending'
}))`);
const order = async (page) => (await rows(page)).map((r) => r.title);
const cutsData = (page) => page.eval('BF.state.project.cuts.map((c) => ({ id: c.id, title: c.title, start: c.start, end: c.end, status: c.status, category: c.category, revision: c.revision, titleCustom: c.titleCustom, origin: c.origin, reviewedRange: c.reviewedRange || null, notes: c.notes, titleSuggestions: c.titleSuggestions }))');
const idOf = (page, title) => page.eval(`BF.state.project.cuts.find((c) => c.title === ${j(title)}).id`);
const click = (page, selector) => page.eval(`(() => { const e = document.querySelector(${j(selector)}); if (!e) throw new Error('não achei ${selector.replace(/'/g, '')}'); e.click(); return true; })()`);
const clickIn = (page, id, focusKey) => click(page, `[data-id="${id}"] [data-focus="${focusKey}"]`);
const setField = (page, selector, value, evt = 'change') => page.eval(`(() => { const e = document.querySelector(${j(selector)}); if (!e) throw new Error('não achei ${selector.replace(/'/g, '')}'); e.value = ${j(value)}; e.dispatchEvent(new Event(${j(evt)}, { bubbles: true })); return true; })()`);
const text = (page, selector) => page.eval(`(document.querySelector(${j(selector)}) || {}).textContent || ''`);
const hidden = (page, selector) => page.eval(`document.querySelector(${j(selector)}).hidden`);

async function pick(page, title, { shift = false } = {}) {
  await page.eval(`(() => { const row = [...document.querySelectorAll('#cuts .cut')].find((c) => c.querySelector('.cut-title').value === ${j(title)}); row.querySelector('.cut-pick').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: ${shift} })); })()`);
  await sleep(120);
}

async function openPreview(page, action) {
  await action();
  await waitFor(page, "!document.querySelector('.preview').hidden", 8000, 'prévia aberta');
  await sleep(60);
}
const previewItems = (page) => page.eval(`[...document.querySelectorAll('.preview-item')].map((i) => ({ name: i.querySelector('.preview-name').textContent, from: i.querySelector('.from').textContent, to: i.querySelector('.to').textContent, cls: i.className.replace('preview-item ', ''), note: (i.querySelector('.preview-note') || {}).textContent || '' }))`);
async function confirmPreview(page) {
  await click(page, '[data-focus="preview-confirm"]');
  await waitFor(page, "document.querySelector('.preview').hidden", 8000, 'prévia fechada');
  await sleep(80);
}
async function cancelPreview(page) {
  await click(page, '[data-focus="preview-cancel"]');
  await waitFor(page, "document.querySelector('.preview').hidden");
  await sleep(60);
}
const toastUndo = async (page) => {
  await waitFor(page, "!!document.querySelector('#toasts .review-toast .toast-action')", 5000, 'aviso com Desfazer');
  await click(page, '#toasts .review-toast:last-child .toast-action');
  await sleep(120);
};

async function main() {
  assert.ok(tools.ffmpeg && tools.ffprobe, 'ffmpeg/ffprobe necessários para o teste');
  const tmp = h.mkTemp('e2e-review');
  const userData = path.join(tmp, 'userdata');
  const source = path.join(tmp, 'live.mp4');
  const shots = process.env.BF_E2E_SHOTDIR;

  try {
    makeBeepVideo(source);
    step('vídeo de teste (40 s, bipes em 5-6, 15-17 e 25-26,5 s) gerado');

    let app = await h.launchApp(userData);
    let page = app.page;
    assert.deepEqual(await page.eval('BF.state.loadErrors'), [], 'todos os handlers carregaram (inclui handlers/review.js)');
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#tabBar [role=tab]')].map((b) => b.dataset.tab)"),
      ['home', 'projects', 'editor', 'queue', 'settings'], 'itens do menu na ordem do contrato');
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#subTabs .subtab')].map((b) => b.dataset.tab)"),
      ['cuts', 'analysis', 'subtitles', 'audio', 'export', 'general', 'prefs', 'tools'], 'e as abas internas de Cortes e de Configurações');
    await waitFor(page, 'window.BF.review && window.BF.review.engine && window.BFReview && !!window.BFReview.engine', 15000, 'lógica da revisão carregada');
    assert.equal(await page.eval("document.getElementById('tab-cuts').disabled"), true, 'sem projeto a aba Cortes fica desabilitada (comportamento da base)');
    assert.equal(await page.eval("document.getElementById('tabpanel-cuts').querySelector('#cuts') !== null"), true);
    step('app aberto: handlers carregados e lógica da revisão (BFReview) carregada pelo cuts.js');

    // eventos para conferir contrato
    await page.eval(`window.__ev = []; for (const n of ['decision', 'cuts:changed', 'cut:selected']) BF.bus.on(n, (d) => window.__ev.push([n, JSON.parse(JSON.stringify(d || {}))])); true`);

    await page.eval(`BF.openSource(${j(source)})`);
    await waitFor(page, "!document.getElementById('app').classList.contains('no-project') && document.getElementById('video').readyState >= 1", 30000, 'vídeo carregado');
    assert.equal(await page.eval("document.getElementById('app').classList.contains('no-project')"), false);

    // ---- cortes de teste: 3 manuais (títulos "Corte N" = automáticos) e 3 sugeridos ----
    await page.eval(`(() => {
      BF.project.addCut({ title: 'Corte 1', start: 2, end: 8 });
      BF.project.addCut({ title: 'Pico de áudio', start: 4.5, end: 9, origin: 'auto', relevance: 0.9, reasons: ['pico de áudio'] });
      BF.project.addCut({ title: 'Lance final', start: 14, end: 19, origin: 'auto', relevance: 0.6, reasons: ['chat acelerou'] });
      BF.project.addCut({ title: 'Lance final 2', start: 15, end: 20, origin: 'auto', relevance: 0.8 });
      BF.project.addCut({ title: 'Corte 5', start: 24, end: 28 });
      BF.project.addCut({ title: 'Corte 6', start: 33, end: 36 });
      return true;
    })()`);
    await waitFor(page, "document.querySelectorAll('#cuts .cut').length === 6");
    await sleep(100);
    assert.deepEqual(await order(page), ['Corte 1', 'Pico de áudio', 'Lance final', 'Lance final 2', 'Corte 5', 'Corte 6'], 'ordem cronológica original por padrão');
    assert.equal(await page.eval("document.querySelector('#tab-cuts .tab-badge').textContent"), '6');
    assert.equal(await page.eval('BF.state.project.cuts.every((c) => c.revision === 1)'), true);
    step('lista na ordem cronológica da live (padrão)');

    // ---- relevância e preferência review.defaultSort ----
    await setField(page, '.sort', 'relevance');
    await sleep(120);
    assert.deepEqual(await order(page), ['Pico de áudio', 'Lance final 2', 'Lance final', 'Corte 1', 'Corte 5', 'Corte 6'], 'relevância: sugeridos primeiro; manuais depois, em ordem cronológica');
    await setField(page, '.sort', 'chrono');
    await sleep(120);
    assert.equal((await order(page))[0], 'Corte 1');
    // a preferência de ordem padrão é lida ao abrir o projeto (BF.prefs.get('review.defaultSort'))
    await page.eval(`window.__prefsGet = BF.prefs.get; BF.prefs.get = (key, fallback) => (key === 'review.defaultSort' ? 'relevance' : fallback); BF.bus.emit('project:loaded', { project: BF.state.project, restored: true }); true`);
    await sleep(200);
    assert.equal((await order(page))[0], 'Pico de áudio', 'review.defaultSort = relevance vira a ordem inicial');
    assert.equal(await page.eval("document.querySelector('.sort').value"), 'relevance');
    await page.eval('BF.prefs.get = window.__prefsGet; BF.bus.emit("project:loaded", { project: BF.state.project, restored: true }); true');
    await sleep(200);
    assert.equal((await order(page))[0], 'Corte 1');
    step('ordenação por relevância e preferência review.defaultSort');

    // ---- indicadores por corte ----
    let r = await rows(page);
    const byTitle = Object.fromEntries(r.map((x) => [x.title, x]));
    assert.deepEqual([byTitle['Corte 1'].origin, byTitle['Pico de áudio'].origin], ['manual', 'auto']);
    assert.ok(byTitle['Corte 1'].chips.includes('Manual') && byTitle['Pico de áudio'].chips.includes('Sugerido'));
    assert.deepEqual([byTitle['Corte 1'].similar, byTitle['Pico de áudio'].similar, byTitle['Lance final'].similar, byTitle['Lance final 2'].similar, byTitle['Corte 5'].similar, byTitle['Corte 6'].similar],
      ['true', 'true', 'true', 'true', 'false', 'false'], 'semelhantes: Corte 1 ~ Pico de áudio e Lance final ~ Lance final 2');
    assert.ok(byTitle['Corte 1'].chips.some((c) => c.startsWith('Semelhante')));
    assert.ok(r.every((x) => x.reviewed === 'false' && x.changed === 'false'));
    step('indicadores: sugerido/manual e semelhante a outro');

    // ---- chips de estado e filtros ----
    assert.equal(await text(page, '[data-state="pending"] .count'), '6');
    assert.equal(await text(page, '[data-state="approved"] .count'), '0');
    await setField(page, '.filters-grid select:nth-of-type(2)', 'auto');
    await sleep(120);
    assert.deepEqual(await order(page), ['Pico de áudio', 'Lance final', 'Lance final 2'], 'filtro: só sugeridos');
    assert.match(await text(page, '.filters summary'), /Mais filtros \(1\)/);
    await setField(page, '.filters-grid select:nth-of-type(2)', 'manual');
    await sleep(120);
    assert.deepEqual(await order(page), ['Corte 1', 'Corte 5', 'Corte 6']);
    await click(page, '[data-focus="f-clear"]');
    await sleep(120);
    assert.equal((await rows(page)).length, 6);
    // semelhantes agrupados, com cabeçalho de grupo e "Manter um…"
    await click(page, '[data-focus="f-similar"]');
    await sleep(150);
    assert.deepEqual(await order(page), ['Corte 1', 'Pico de áudio', 'Lance final', 'Lance final 2']);
    assert.equal(await page.eval("document.querySelectorAll('#cuts .group-head').length"), 2, 'um cabeçalho por grupo');
    assert.match(await text(page, '#cuts .group-head'), /2 cortes parecidos/);
    assert.equal(await page.eval("document.querySelectorAll('#cuts .group-head button').length"), 2);
    await click(page, '[data-focus="f-clear"]');
    await sleep(120);
    step('filtros por estado, origem e semelhantes (agrupados, com cabeçalho do grupo)');

    // ---- seleção: caixas, shift, selecionar filtrados ----
    await pick(page, 'Corte 1');
    await pick(page, 'Lance final', { shift: true });
    assert.deepEqual((await rows(page)).filter((x) => x.picked).map((x) => x.title), ['Corte 1', 'Pico de áudio', 'Lance final'], 'shift marca o intervalo');
    assert.equal(await hidden(page, '.selbar'), false);
    assert.match(await text(page, '.sel-count'), /3 selecionados/);
    await click(page, '[data-focus="select-all"]');
    await sleep(120);
    assert.equal((await rows(page)).filter((x) => x.picked).length, 6, 'selecionar todos');
    await click(page, '[data-focus="select-all"]');
    await sleep(120);
    assert.equal((await rows(page)).filter((x) => x.picked).length, 0);
    assert.equal(await hidden(page, '.selbar'), true);
    // selecionar os filtrados: só pendentes sugeridos
    await setField(page, '.filters-grid select:nth-of-type(2)', 'auto');
    await sleep(100);
    await click(page, '[data-focus="select-all"]');
    await sleep(120);
    assert.match(await text(page, '.sel-count'), /3 selecionados/);
    await click(page, '[data-focus="batch-clear"]');
    await click(page, '[data-focus="f-clear"]');
    await sleep(120);
    step('seleção individual, por intervalo (shift) e dos filtrados');

    // ---- lote: aprovar com prévia, cancelar, confirmar, desfazer pelo aviso ----
    await pick(page, 'Corte 1');
    await pick(page, 'Lance final', { shift: true });
    const evBefore = await page.eval('window.__ev.length');
    await openPreview(page, () => click(page, '[data-focus="batch-approve"]'));
    assert.match(await text(page, '.preview h3'), /Prévia: Aprovar 3 cortes/);
    assert.deepEqual((await previewItems(page)).map((i) => [i.name, i.from, i.to]), [['Corte 1', 'Pendente', 'Aprovado'], ['Pico de áudio', 'Pendente', 'Aprovado'], ['Lance final', 'Pendente', 'Aprovado']]);
    assert.equal(await page.eval("document.querySelector('.cuts-main').hidden"), true, 'a lista dá lugar à prévia');
    assert.deepEqual((await cutsData(page)).map((c) => c.status), ['pending', 'pending', 'pending', 'pending', 'pending', 'pending'], 'a prévia não altera nada');
    assert.equal(await page.eval('window.__ev.length'), evBefore, 'nem emite eventos');
    await cancelPreview(page);
    assert.deepEqual((await cutsData(page)).map((c) => c.status), ['pending', 'pending', 'pending', 'pending', 'pending', 'pending'], 'cancelar não muda nada');
    assert.equal(await page.eval("document.querySelector('.cuts-main').hidden"), false);

    await openPreview(page, () => click(page, '[data-focus="batch-approve"]'));
    await page.eval('window.__ev.length = 0; true');
    await confirmPreview(page);
    assert.deepEqual((await cutsData(page)).map((c) => c.status), ['approved', 'approved', 'approved', 'pending', 'pending', 'pending']);
    let ev = await page.eval('window.__ev');
    assert.equal(ev.filter(([n]) => n === 'cuts:changed').length, 1, 'um único cuts:changed para o lote inteiro');
    const decisions = ev.filter(([n]) => n === 'decision').map(([, d]) => d);
    assert.deepEqual(decisions.map((d) => [d.type, d.before, d.after]), [['approve', 'pending', 'approved'], ['approve', 'pending', 'approved'], ['approve', 'pending', 'approved']]);
    assert.equal(new Set(decisions.map((d) => d.reviewGroup)).size, 1, 'o lote é um grupo só');
    assert.match(await text(page, '#toasts .review-toast .toast-text'), /Aprovou 3 cortes/);
    assert.deepEqual((await rows(page)).map((x) => x.reviewed), ['true', 'true', 'true', 'false', 'false', 'false']);
    assert.ok((await rows(page))[0].chips.includes('Revisado: aprovado'));
    // desfazer imediato pelo aviso
    await page.eval('window.__ev.length = 0; true');
    await toastUndo(page);
    assert.deepEqual((await cutsData(page)).map((c) => c.status), ['pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
    ev = await page.eval('window.__ev');
    assert.deepEqual(ev.filter(([n]) => n === 'decision').map(([, d]) => [d.type, d.source]), [['reset', 'undo'], ['reset', 'undo'], ['reset', 'undo']]);
    assert.equal(await page.eval("document.querySelector('[data-focus=\"redo\"]').disabled"), false, 'refazer disponível');
    await click(page, '[data-focus="redo"]');
    await sleep(120);
    assert.deepEqual((await cutsData(page)).map((c) => c.status), ['approved', 'approved', 'approved', 'pending', 'pending', 'pending'], 'refazer');
    await click(page, '[data-focus="undo"]');
    await sleep(120);
    step('lote: prévia (antes→depois) sem alterar nada, cancelar, confirmar, aviso "Desfazer", refazer; um grupo e um cuts:changed');

    // ---- lote: deslocar tempos (prévia com antes→depois, limite do vídeo) ----
    await click(page, '[data-focus="batch-clear"]');
    await pick(page, 'Pico de áudio');
    await pick(page, 'Corte 6');
    await openPreview(page, async () => {
      await page.eval("document.querySelector('.selbar .more summary').click()");
      await click(page, '[data-focus="batch-shift"]');
    });
    await page.eval(`(() => { const [a, b] = document.querySelectorAll('.preview-controls .num-input'); a.value = '0,5'; a.dispatchEvent(new Event('input', { bubbles: true })); b.value = '1'; b.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(100);
    assert.deepEqual((await previewItems(page)).map((i) => [i.name, i.from, i.to]), [['Pico de áudio', '0:04.5 – 0:09.0', '0:05.0 – 0:10.0'], ['Corte 6', '0:33.0 – 0:36.0', '0:33.5 – 0:37.0']]);
    await confirmPreview(page);
    let cuts = await cutsData(page);
    assert.deepEqual(cuts.filter((c) => ['Pico de áudio', 'Corte 6'].includes(c.title)).map((c) => [c.start, c.end, c.revision]), [[5, 10, 2], [33.5, 37, 2]]);
    await toastUndo(page);
    cuts = await cutsData(page);
    assert.deepEqual(cuts.filter((c) => ['Pico de áudio', 'Corte 6'].includes(c.title)).map((c) => [c.start, c.end]), [[4.5, 9], [33, 36]]);
    // deslocar além do vídeo: limite e aviso, sem bloquear
    await click(page, '[data-focus="batch-clear"]');
    await pick(page, 'Corte 6');
    await openPreview(page, async () => { await page.eval("document.querySelector('.selbar .more summary').click()"); await click(page, '[data-focus="batch-shift"]'); });
    await page.eval(`(() => { const [a, b] = document.querySelectorAll('.preview-controls .num-input'); b.value = '20'; b.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(100);
    const limited = (await previewItems(page))[0];
    assert.equal(limited.to, '0:33.0 – 0:40.0');
    assert.match(limited.note, /limitado aos limites do vídeo/);
    await cancelPreview(page);
    await click(page, '[data-focus="batch-clear"]');
    step('lote: deslocar tempos com prévia, desfazer e limite do vídeo avisado');

    // ---- alterado desde a revisão (lote e ajuste simples) ----
    await pick(page, 'Corte 1');
    await pick(page, 'Lance final', { shift: true });
    await openPreview(page, () => click(page, '[data-focus="batch-approve"]'));
    await confirmPreview(page);
    await click(page, '[data-focus="batch-clear"]');
    const lance = await idOf(page, 'Lance final');
    // abre o corte e usa o ajuste simples sempre visível (+0,1 s no início, duas vezes; +1 s no fim)
    await page.eval(`BF.review.select(${j(lance)})`);
    await waitFor(page, `!!document.querySelector('[data-id="${lance}"] .adjust')`);
    assert.deepEqual(await page.eval(`[...document.querySelectorAll('[data-id="${lance}"] .edge-row[data-edge="start"] .step:not(.here)')].map((b) => b.textContent)`), ['-1 s', '-0,1 s', '+0,1 s', '+1 s']);
    assert.deepEqual(await page.eval(`[...document.querySelectorAll('[data-id="${lance}"] .edge-row[data-edge="end"] .step:not(.here)')].map((b) => b.textContent)`), ['-1 s', '-0,1 s', '+0,1 s', '+1 s']);
    await page.eval('window.__ev.length = 0; true');
    await click(page, `[data-id="${lance}"] .edge-row[data-edge="start"] [data-focus="step-start-0.1"]`);
    await sleep(100);
    await click(page, `[data-id="${lance}"] .edge-row[data-edge="start"] [data-focus="step-start-0.1"]`);
    await sleep(100);
    await click(page, `[data-id="${lance}"] .edge-row[data-edge="end"] [data-focus="step-end-1"]`);
    await sleep(150);
    let lc = (await cutsData(page)).find((c) => c.id === lance);
    assert.deepEqual([lc.start, lc.end, lc.revision, lc.status], [14.2, 20, 4, 'approved'], 'revision incrementa a cada ajuste');
    assert.deepEqual(lc.reviewedRange, [14, 19], 'guarda o tempo de quando foi revisado');
    r = await rows(page);
    assert.equal(r.find((x) => x.title === 'Lance final').changed, 'true');
    assert.ok(r.find((x) => x.title === 'Lance final').chips.includes('Alterado'));
    assert.equal(r.find((x) => x.title === 'Corte 1').changed, 'false');
    ev = await page.eval('window.__ev');
    assert.deepEqual(ev.filter(([n]) => n === 'decision').map(([, d]) => [d.type, d.before, d.after]), [
      ['adjust', { start: 14, end: 19 }, { start: 14.1, end: 19 }],
      ['adjust', { start: 14.1, end: 19 }, { start: 14.2, end: 19 }],
      ['adjust', { start: 14.2, end: 19 }, { start: 14.2, end: 20 }]
    ]);
    // filtro "alterados desde a revisão"
    await click(page, '[data-focus="f-changed"]');
    await sleep(120);
    assert.deepEqual(await order(page), ['Lance final']);
    await click(page, '[data-focus="f-clear"]');
    await sleep(100);
    // desfazer os 3 ajustes limpa o aviso; reconfirmar também
    await click(page, '[data-focus="undo"]');
    await click(page, '[data-focus="undo"]');
    await click(page, '[data-focus="undo"]');
    await sleep(150);
    lc = (await cutsData(page)).find((c) => c.id === lance);
    assert.deepEqual([lc.start, lc.end], [14, 19]);
    assert.equal((await rows(page)).find((x) => x.title === 'Lance final').changed, 'false', 'voltou ao tempo revisado: sem aviso');
    await click(page, `[data-id="${lance}"] [data-focus="step-end--1"]`);
    await sleep(120);
    assert.equal((await rows(page)).find((x) => x.title === 'Lance final').changed, 'true');
    await click(page, `[data-id="${lance}"] [data-focus="mark-reviewed"]`);
    await sleep(120);
    assert.equal((await rows(page)).find((x) => x.title === 'Lance final').changed, 'false', '"Marcar como revisado" reconfirma');
    assert.equal((await cutsData(page)).find((c) => c.id === lance).end, 18);
    // digitar o tempo
    await setField(page, `[data-id="${lance}"] [data-focus="time-end"]`, '0:19.5');
    await sleep(120);
    assert.equal((await cutsData(page)).find((c) => c.id === lance).end, 19.5);
    // tempo inválido não muda nada e avisa
    await setField(page, `[data-id="${lance}"] [data-focus="time-end"]`, 'abc');
    await sleep(120);
    assert.equal((await cutsData(page)).find((c) => c.id === lance).end, 19.5);
    assert.match(await text(page, '#toasts'), /formato m:ss/);
    step('ajuste simples (-1 s, -0,1 s, +0,1 s, +1 s): revision, "alterado" após revisão, filtro, desfazer e reconfirmar');

    // ---- categorias, notas e títulos ----
    const corte5 = await idOf(page, 'Corte 5');
    await page.eval(`BF.review.select(${j(corte5)})`);
    await waitFor(page, `!!document.querySelector('[data-id="${corte5}"] .editor')`);
    assert.ok((await page.eval("[...document.querySelectorAll('#cutCategories option')].map((o) => o.value)")).includes('Clutch'), 'sugestões de categoria (review.categories)');
    await setField(page, `[data-id="${corte5}"] [data-focus="category"]`, '  Minha   categoria ');
    await sleep(120);
    assert.equal((await cutsData(page)).find((c) => c.id === corte5).category, 'Minha categoria', 'categoria livre');
    assert.ok((await page.eval("[...document.querySelectorAll('#cutCategories option')].map((o) => o.value)")).includes('Minha categoria'));
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#cuts .cut')].find((c) => c.dataset.id === " + j(corte5) + ").querySelector('.chips .chip.category').textContent"), 'Minha categoria');
    await setField(page, `[data-id="${corte5}"] [data-focus="notes"]`, 'conferir o som');
    await sleep(120);
    assert.equal((await cutsData(page)).find((c) => c.id === corte5).notes, 'conferir o som');
    // sugestões: só aparecem quando pedidas e não trocam o título
    await page.eval("BF.project.update((p) => { p.meta.game = 'Valorant'; }, { reason: 'teste' }); true");
    const sugBefore = await page.eval(`BF.project.cut(${j(corte5)}).titleSuggestions.length`);
    assert.equal(sugBefore, 0);
    await clickIn(page, corte5, 'suggest');
    await waitFor(page, `document.querySelectorAll('[data-id="${corte5}"] .suggestion').length > 0`);
    let c5 = (await cutsData(page)).find((c) => c.id === corte5);
    assert.equal(c5.title, 'Corte 5', 'sugerir não troca o título');
    assert.ok(c5.titleSuggestions.length >= 3, `sugestões: ${c5.titleSuggestions}`);
    assert.ok(c5.titleSuggestions.some((s) => /Valorant/.test(s)), 'usa o jogo do projeto');
    assert.ok(c5.titleSuggestions.every((s) => !/IA|http/.test(s)));
    assert.ok(c5.titleSuggestions.some((s) => /Minha categoria/.test(s)), 'usa a categoria');
    // título padrão: clicar na sugestão aplica direto e a marca de personalizado fica falsa
    const sug = c5.titleSuggestions[0];
    await page.eval(`document.querySelector('[data-id="${corte5}"] .suggestion').click()`);
    await sleep(150);
    c5 = (await cutsData(page)).find((c) => c.id === corte5);
    assert.deepEqual([c5.title, c5.titleCustom], [sug, false]);
    assert.equal(await modalOpen(page), false, 'título automático troca sem pedir confirmação');
    // título digitado: marcado como personalizado e protegido
    await setField(page, `[data-id="${corte5}"] .cut-title`, 'Minha jogada preferida');
    await sleep(150);
    c5 = (await cutsData(page)).find((c) => c.id === corte5);
    assert.deepEqual([c5.title, c5.titleCustom], ['Minha jogada preferida', true]);
    assert.equal((await rows(page)).find((x) => x.id === corte5).custom, 'true');
    await clickIn(page, corte5, 'suggest');
    await sleep(150);
    c5 = (await cutsData(page)).find((c) => c.id === corte5);
    assert.equal(c5.title, 'Minha jogada preferida', 'gerar mais sugestões nunca troca o título personalizado');
    const second = c5.titleSuggestions[1];
    await page.eval(`document.querySelectorAll('[data-id="${corte5}"] .suggestion')[1].click()`);
    const asked = await answerModal(page, false);
    assert.match(asked.message, /Minha jogada preferida/);
    await sleep(150);
    assert.equal((await cutsData(page)).find((c) => c.id === corte5).title, 'Minha jogada preferida', 'recusar mantém o título do usuário');
    await page.eval(`document.querySelectorAll('[data-id="${corte5}"] .suggestion')[1].click()`);
    await answerModal(page, true);
    await sleep(200);
    c5 = (await cutsData(page)).find((c) => c.id === corte5);
    assert.deepEqual([c5.title, c5.titleCustom], [second, false], 'só o clique confirmado troca');
    await click(page, '[data-focus="undo"]');
    await sleep(150);
    c5 = (await cutsData(page)).find((c) => c.id === corte5);
    assert.deepEqual([c5.title, c5.titleCustom], ['Minha jogada preferida', true], 'desfazer devolve o título e a marca de personalizado');
    step('categorias livres (com sugestões), notas e títulos: sugestões só entram no clique e nunca trocam o personalizado');

    // ---- semelhantes: manter um / rejeitar os demais ----
    const lance2 = await idOf(page, 'Lance final 2');
    await page.eval('BF.review.select(null); true');
    await clickIn(page, lance2, 'similar');
    await sleep(150);
    assert.equal(await hidden(page, '.group-banner'), false);
    assert.deepEqual((await order(page)).sort(), ['Lance final', 'Lance final 2'], 'só o grupo em foco');
    await openPreview(page, () => click(page, '[data-focus="banner-keep"]'));
    const radios = await page.eval("[...document.querySelectorAll('.keep-choice input')].map((r) => [r.value, r.checked])");
    assert.deepEqual(radios.find((x) => x[1])[0], lance, 'sugere manter o que já foi aprovado (decisão do usuário)');
    assert.deepEqual((await previewItems(page)).map((i) => [i.name, i.from, i.to]), [['Lance final', 'mantido', 'mantido'], ['Lance final 2', 'Pendente', 'Rejeitado']]);
    // o usuário prefere o de maior relevância: troca a escolha e a prévia acompanha
    await page.eval(`(() => { const r = document.querySelector('.keep-choice input[value="${lance2}"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(120);
    assert.deepEqual((await previewItems(page)).map((i) => [i.name, i.from, i.to]), [['Lance final', 'Aprovado', 'Rejeitado'], ['Lance final 2', 'mantido', 'mantido']]);
    await confirmPreview(page);
    cuts = await cutsData(page);
    assert.deepEqual(cuts.filter((c) => c.title.startsWith('Lance final')).map((c) => [c.title, c.status]), [['Lance final', 'rejected'], ['Lance final 2', 'pending']]);
    assert.match(await text(page, '#toasts .review-toast:last-child .toast-text'), /Manteve um e rejeitou os demais/);
    await toastUndo(page);
    assert.deepEqual((await cutsData(page)).filter((c) => c.title.startsWith('Lance final')).map((c) => c.status), ['approved', 'pending']);
    await click(page, '[data-focus="banner-clear"]');
    await sleep(120);
    assert.equal((await rows(page)).length, 6);
    step('semelhantes: grupo em foco, "Manter um" com prévia, rejeita os demais em lote e desfaz');

    // ---- digitar o título e clicar (mouse de verdade) em "Aprovar" da mesma linha: o clique não pode se perder ----
    const typed = await idOf(page, 'Corte 6');
    await page.eval(`(() => { const row = document.querySelector('[data-id="${typed}"]'); row.scrollIntoView({ block: 'center' }); const t = row.querySelector('.cut-title'); t.focus(); t.select(); return true; })()`);
    await page.send('Input.insertText', { text: 'Corte seis' });
    // os avisos dos passos anteriores ficam no canto da janela e, com a última linha rente ao fim da lista, cobrem o botão: o clique cairia no aviso
    // (o teste é do clique que não pode se perder por redesenho, não de quem está por cima dele)
    await page.eval("document.getElementById('toasts').replaceChildren(); true");
    const approveAt = await page.eval(`(() => { const r = document.querySelector('[data-id="${typed}"] [data-focus="approve"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: approveAt.x, y: approveAt.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(200); // o título já foi salvo ao sair do campo; com o mouse ainda pressionado a lista não pode ser refeita
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: approveAt.x, y: approveAt.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(350);
    let six = (await cutsData(page)).find((c) => c.id === typed);
    assert.deepEqual([six.title, six.status, six.titleCustom], ['Corte seis', 'approved', true], 'o título digitado foi salvo E o clique em Aprovar valeu (a lista não é redesenhada no meio do clique)');
    await click(page, '[data-focus="undo"]');
    await click(page, '[data-focus="undo"]');
    await sleep(200);
    six = (await cutsData(page)).find((c) => c.id === typed);
    assert.deepEqual([six.title, six.status, 'titleCustom' in six && six.titleCustom !== undefined], ['Corte 6', 'pending', false]);
    step('digitar o título e clicar em Aprovar na mesma linha (mouse real) salva os dois');

    // ---- lote: categorizar (categoria livre) e redefinir ----
    await pick(page, 'Corte 1');
    await pick(page, 'Pico de áudio');
    await openPreview(page, async () => { await page.eval("document.querySelector('.selbar .more summary').click()"); await click(page, '[data-focus="batch-categorize"]'); });
    await page.eval(`(() => { const i = document.querySelector('.preview-controls input'); i.value = '  Engraçado  '; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(100);
    assert.deepEqual((await previewItems(page)).map((i) => [i.name, i.from, i.to]), [['Corte 1', 'sem categoria', 'Engraçado'], ['Pico de áudio', 'sem categoria', 'Engraçado']]);
    assert.match(await text(page, '.preview h3'), /Categorizar 2 cortes como “Engraçado”/);
    await confirmPreview(page);
    assert.deepEqual((await cutsData(page)).filter((c) => c.category === 'Engraçado').map((c) => c.title), ['Corte 1', 'Pico de áudio']);
    assert.ok((await page.eval("[...document.querySelector('.filters-grid select').options].map((o) => o.value)")).includes('Engraçado'), 'a categoria nova entra no filtro de categorias');
    await toastUndo(page);
    assert.deepEqual((await cutsData(page)).filter((c) => c.category === 'Engraçado'), []);
    await openPreview(page, () => click(page, '[data-focus="batch-reset"]'));
    assert.ok((await previewItems(page)).every((i) => i.from === 'Aprovado' && i.to === 'Pendente'), 'redefinir: Aprovado → Pendente');
    await confirmPreview(page);
    assert.deepEqual((await cutsData(page)).filter((c) => ['Corte 1', 'Pico de áudio'].includes(c.title)).map((c) => c.status), ['pending', 'pending']);
    await toastUndo(page);
    assert.deepEqual((await cutsData(page)).filter((c) => ['Corte 1', 'Pico de áudio'].includes(c.title)).map((c) => c.status), ['approved', 'approved']);
    await click(page, '[data-focus="batch-clear"]');
    step('lote: categorizar (categoria livre, entra no filtro) e redefinir, com prévia e Desfazer');

    // ---- remover: um corte (confirmação) e em lote (prévia) ----
    const c6 = await idOf(page, 'Corte 6');
    await clickIn(page, c6, 'remove');
    assert.match((await answerModal(page, false)).message, /Remover "Corte 6" do projeto/);
    assert.equal((await rows(page)).length, 6);
    await clickIn(page, c6, 'remove');
    await answerModal(page, true);
    await waitFor(page, "document.querySelectorAll('#cuts .cut').length === 5");
    await toastUndo(page);
    await waitFor(page, "document.querySelectorAll('#cuts .cut').length === 6");
    assert.deepEqual((await cutsData(page)).map((c) => c.title).slice(-1), ['Corte 6'], 'o corte volta na posição cronológica');
    await pick(page, 'Minha jogada preferida');
    await pick(page, 'Corte 6');
    await openPreview(page, async () => { await page.eval("document.querySelector('.selbar .more summary').click()"); await click(page, '[data-focus="batch-remove"]'); });
    assert.deepEqual((await previewItems(page)).map((i) => i.to), ['removido', 'removido']);
    assert.match(await text(page, '[data-focus="preview-confirm"]'), /Remover 2 cortes/);
    await confirmPreview(page);
    assert.equal((await rows(page)).length, 4);
    await toastUndo(page);
    await waitFor(page, "document.querySelectorAll('#cuts .cut').length === 6");
    assert.equal(await page.eval("BF.state.project.cuts.find((c) => c.title === 'Minha jogada preferida').titleCustom"), true, 'os cortes voltam inteiros');
    await click(page, '[data-focus="batch-clear"]');
    step('remover: confirmação para um corte; lote com prévia; os dois voltam inteiros com Desfazer');

    // ---- histórico ----
    await page.eval("document.querySelector('details.history').open = true; document.querySelector('details.history').dispatchEvent(new Event('toggle')); true");
    await sleep(200);
    const total = await page.eval('BF.review.engine.groups().length');
    const histCount = await page.eval("document.querySelectorAll('.history-item').length");
    assert.equal(histCount, Math.min(30, total), 'o painel mostra os 30 mais recentes');
    assert.ok(total >= 10, `histórico com as decisões da sessão (${total})`);
    if (total > 30) {
      await page.eval("[...document.querySelectorAll('details.history button.link')].find((b) => /Mostrar mais/.test(b.textContent)).click()");
      await sleep(150);
    }
    const labels = await page.eval("[...document.querySelectorAll('.history-label')].map((e) => e.textContent)");
    assert.ok(labels.some((l) => /^Aprovou 3 cortes$/.test(l)), 'o lote aparece agrupado');
    assert.ok(labels.some((l) => /^Desfez: /.test(l)));
    assert.ok(labels.some((l) => /^Criou 6 cortes$/.test(l)), 'as criações vindas da base entram agrupadas (6 addCut seguidos = 1 entrada)');
    assert.ok(labels.some((l) => /^Ajustou “Lance final” \(início \+0,1 s\)$/.test(l)));
    assert.ok(labels.some((l) => /^Removeu 2 cortes$/.test(l)), 'a remoção em lote também');
    // restaurar: volta ao estado de antes de "Aprovou 3 cortes" (o primeiro lote)
    const before = await cutsData(page);
    const firstApprove = await page.eval(`(() => { const g = BF.review.engine.groups().find((x) => x.label === 'Aprovou 3 cortes'); return g.id; })()`);
    await openPreview(page, () => click(page, `[data-focus="restore-${firstApprove}"]`));
    assert.match(await text(page, '.preview h3'), /Restaurar o estado anterior a/);
    const restoreItems = await previewItems(page);
    assert.ok(restoreItems.length >= 3 && restoreItems.every((i) => i.cls.includes('changed')));
    assert.deepEqual((await cutsData(page)), before, 'a prévia da restauração não altera nada');
    await confirmPreview(page);
    cuts = await cutsData(page);
    assert.ok(cuts.every((c) => c.status === 'pending'), 'tudo que era posterior ao primeiro lote foi desfeito');
    assert.equal(cuts.find((c) => c.title === 'Lance final').start, 14);
    assert.match(await text(page, '#toasts .review-toast:last-child .toast-text'), /Restaurou o estado anterior a/);
    // a restauração é uma entrada e pode ser desfeita
    const groupsNow = await page.eval('BF.review.engine.groups().map((g) => g.source)');
    assert.equal(groupsNow.at(-1), 'restore');
    await toastUndo(page);
    assert.deepEqual((await cutsData(page)).map((c) => [c.title, c.status, c.start, c.end]), before.map((c) => [c.title, c.status, c.start, c.end]), 'desfazer a restauração devolve o estado de antes dela');
    step(`histórico: lote agrupado, criações/desfazer registrados, restaurar com prévia e reversível (${total} entradas)`);

    // ---- atalhos ----
    await page.eval('document.activeElement && document.activeElement.blur(); document.body.focus(); true');
    await page.eval("BF.player.seek(7.2); true");
    await waitFor(page, "Math.abs(document.getElementById('video').currentTime - 7.2) < 0.1 && !document.getElementById('video').seeking");
    const key = (k, extra = {}) => page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k === ' ' ? 'Space' : `Key${k.toUpperCase()}`, text: k, ...extra }).then(() => page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k === ' ' ? 'Space' : `Key${k.toUpperCase()}`, ...extra }));
    await key('i');
    assert.equal(await page.eval("document.getElementById('inInput').value"), '0:07.2', 'I marca o início na barra do player');
    await page.eval("BF.player.seek(9.4); true");
    await waitFor(page, "Math.abs(document.getElementById('video').currentTime - 9.4) < 0.1 && !document.getElementById('video').seeking");
    await key('o');
    assert.equal(await page.eval("document.getElementById('outInput').value"), '0:09.4', 'O marca o fim');
    await key(' ');
    await waitFor(page, "!document.getElementById('video').paused", 5000, 'Espaço toca');
    await key(' ');
    await waitFor(page, "document.getElementById('video').paused", 5000, 'Espaço pausa');
    // dentro de um campo de texto os atalhos não valem
    await page.eval(`document.querySelector('#cuts .cut-title').focus(); true`);
    const inBefore = await page.eval("document.getElementById('inInput').value");
    await key('i');
    assert.equal(await page.eval("document.getElementById('inInput').value"), inBefore, 'digitando num campo, "i" é só uma letra');
    assert.equal(await page.eval("document.querySelector('#cuts .cut-title').value.endsWith('i')"), true);
    await page.eval(`(() => { const t = document.querySelector('#cuts .cut-title'); t.value = t.value.slice(0, -1); t.blur(); })()`);
    // Ctrl+Z desfaz a última decisão
    await click(page, `[data-id="${await idOf(page, 'Corte 6')}"] [data-focus="approve"]`);
    await sleep(120);
    assert.equal((await cutsData(page)).find((c) => c.title === 'Corte 6').status, 'approved');
    await page.eval('document.activeElement && document.activeElement.blur(); true');
    await key('z', { modifiers: 2 });
    await sleep(150);
    assert.equal((await cutsData(page)).find((c) => c.title === 'Corte 6').status, 'pending', 'Ctrl+Z desfaz');
    await key('y', { modifiers: 2 });
    await sleep(150);
    assert.equal((await cutsData(page)).find((c) => c.title === 'Corte 6').status, 'approved', 'Ctrl+Y refaz');
    await click(page, '[data-focus="undo"]');
    await sleep(100);
    step('atalhos: I/O marcam, Espaço toca/pausa, Ctrl+Z/Ctrl+Y desfazem/refazem; nada disso dispara digitando em campos');

    // ---- timeline: forma de onda real, regiões, arrastar borda, clicar para posicionar ----
    assert.equal(await page.eval("document.getElementById('timelineSlot').children.length"), 0, 'timeline começa oculta');
    await click(page, '.tl-toggle');
    await waitFor(page, "BF.review.timeline.isOpen() && BF.review.timeline.info().status === 'ready' && BF.review.timeline.info().detailBuckets >= 0", 30000, 'forma de onda calculada');
    assert.equal(await page.eval("document.querySelector('.tl-toggle').getAttribute('aria-pressed')"), 'true');
    assert.equal(await page.eval("!!document.querySelector('#timelineSlot canvas.tl-main') && !!document.querySelector('#timelineSlot canvas.tl-overview')"), true);
    const info = await page.eval(`(() => { const i = BF.review.timeline.info(); return { buckets: i.overviewBuckets, p55: i.peakAt(5.5), p10: i.peakAt(10), p16: i.peakAt(16), p26: i.peakAt(25.8), p30: i.peakAt(30), p5: i.peakAt(2.5) }; })()`);
    assert.ok(info.buckets >= 1000, `buckets ${info.buckets}`);
    assert.ok(info.p55 > 150 && info.p16 > 150 && info.p26 > 150, `bipes nos instantes certos: ${j(info)}`);
    assert.ok(info.p10 < 12 && info.p30 < 12 && info.p5 < 12, `silêncio fora dos bipes: ${j(info)}`);
    assert.equal(await page.eval("document.querySelector('.tl-info').textContent.length > 0"), true);
    const wfCache = path.join(userData, 'cache', 'waveform');
    assert.equal(fs.readdirSync(wfCache).filter((f) => f.endsWith('.bfwf')).length, 1, 'cache da onda em userData/cache');
    step(`timeline: forma de onda REAL no lugar certo (bipe ${info.p55}/${info.p16}/${info.p26}, silêncio ${info.p10}/${info.p30})`);

    // cores das regiões: vêm dos TOKENS do tema (manual = --status-info, sugerido = --accent-solid, rejeitado = --muted), são
    // diferentes entre si, legíveis sobre o fundo e acompanham a troca de tema (lidas dos pixels do canvas, nos dois temas)
    const manual = await idOf(page, 'Corte 1');
    const auto = await idOf(page, 'Pico de áudio');
    await page.eval(`(() => { const t = BF.review.timeline; t.close(); t.open(); return true; })()`);
    await waitFor(page, "BF.review.timeline.info().status === 'ready'", 15000);
    await page.eval("document.querySelector('.tl-btn[title=\"Mostrar o vídeo inteiro\"]').click(); true");
    await sleep(400);
    const tokenRgb = (name) => page.eval(`(() => { const c = document.createElement('canvas'); c.width = 1; c.height = 1; const g = c.getContext('2d'); g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(${j(name)}).trim(); g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]]; })()`);
    const mixc = (c, bg, t) => c.map((v, i) => v * t + bg[i] * (1 - t));
    const dist = (x, y) => Math.hypot(...x.map((v, i) => v - y[i]));
    const lum = (c) => { const f = (v) => { const u = v / 255; return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const contrast = (x, y) => { const [hi, lo] = [lum(x), lum(y)].sort((m, n) => n - m); return (hi + 0.05) / (lo + 0.05); };
    // a etiqueta do corte (faixa de 13 px sob a régua) logo na borda esquerda, antes do título: as três faixas possíveis
    const labelPixels = (id) => page.eval(`(() => {
      const t = BF.review.timeline; const cv = document.querySelector('.tl-main'); const cut = BF.project.cut(${j(id)});
      const x = (t.timeToX(cut.start) - cv.getBoundingClientRect().left) + 2; const dpr = window.devicePixelRatio || 1;
      return [0, 1, 2].map((lane) => { const d = cv.getContext('2d').getImageData(Math.round(x * dpr), Math.round((16 + lane * 13 + 6) * dpr), 1, 1).data; return [d[0], d[1], d[2]]; });
    })()`);
    for (const theme of ['dark', 'light']) {
      await page.eval(`BF.ui.setTheme(${j(theme)}); true`);
      await sleep(500);
      const palette = await page.eval('BF.review.timeline.info().palette');
      const tokens = { manual: await tokenRgb('--status-info'), auto: await tokenRgb('--accent-solid'), rejected: await tokenRgb('--muted'), bg: await tokenRgb('--bg') };
      for (const key of ['manual', 'auto', 'rejected', 'bg']) assert.deepEqual(palette[key], tokens[key], `${theme}: a timeline lê ${key} dos tokens do tema (nada de hex fixo)`);
      assert.ok(dist(tokens.manual, tokens.auto) > 120, `${theme}: manual e sugerido têm cores bem diferentes (${j(tokens.manual)} x ${j(tokens.auto)})`);
      const selected = await page.eval('BF.review.timeline.info().selected');
      const expected = {};
      for (const [name, id] of [['manual', manual], ['auto', auto]]) {
        const cut = await page.eval(`(() => { const c = BF.project.cut(${j(id)}); return { status: c.status, origin: c.origin }; })()`);
        const base = cut.status === 'rejected' ? tokens.rejected : cut.origin === 'auto' ? tokens.auto : tokens.manual;
        const label = id === selected ? base : mixc(base, tokens.bg, palette.labelAlpha);
        expected[name] = label;
        const nearest = (await labelPixels(id)).map((px) => dist(px, label)).sort((m, n) => m - n)[0];
        assert.ok(nearest < 40, `${theme}: etiqueta de "${name}" na cor do token (distância ${nearest.toFixed(1)})`);
        assert.ok(contrast(label, tokens.bg) >= 3, `${theme}: etiqueta de "${name}" legível sobre o fundo (contraste ${contrast(label, tokens.bg).toFixed(2)})`);
      }
      assert.ok(dist(expected.manual, expected.auto) > 100, `${theme}: o manual e o sugerido continuam distinguíveis na tela`);
      if (shots) await h.screenshot(page, path.join(shots, `timeline-cores-${theme}.png`));
    }
    await page.eval("BF.ui.setTheme('dark'); true");
    await sleep(400);
    step('timeline: manual (--status-info) e sugerido (--accent-solid) lidos dos tokens, diferentes e legíveis nos temas escuro e claro');
    if (shots) await h.screenshot(page, path.join(shots, 'timeline-tudo.png'));

    // zoom e rolagem
    const lanceId = await idOf(page, 'Lance final');
    await page.eval(`BF.review.select(${j(lanceId)}); true`);
    await sleep(300);
    const span0 = await page.eval('BF.review.timeline.info().view.span');
    await click(page, '.tl-btn[title^="Mais zoom"]');
    await sleep(150);
    const span1 = await page.eval('BF.review.timeline.info().view.span');
    assert.ok(span1 < span0, `zoom aproxima (${span0} -> ${span1})`);
    const start1 = await page.eval('BF.review.timeline.info().view.start');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 300, y: await page.eval('BF.review.timeline.info().canvas.top + 60'), deltaX: 0, deltaY: 100 });
    await sleep(200);
    assert.ok(await page.eval('BF.review.timeline.info().view.start') > start1, 'a roda rola para frente');
    const spanBeforeCtrl = await page.eval('BF.review.timeline.info().view.span');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 300, y: await page.eval('BF.review.timeline.info().canvas.top + 60'), deltaX: 0, deltaY: -100, modifiers: 2 });
    await sleep(200);
    assert.ok(await page.eval('BF.review.timeline.info().view.span') < spanBeforeCtrl, 'Ctrl + roda para cima aproxima');
    await page.eval(`BF.review.select(${j(lanceId)}); document.querySelector('.tl-btn[title^="Aproximar"]').click(); true`);
    await sleep(500);
    await waitFor(page, 'BF.review.timeline.info().detailBuckets > 0', 10000, 'detalhe da onda (zoom) carregado');
    step('timeline: zoom, rolagem e detalhe da onda ao aproximar');

    // clicar para posicionar o player
    const target = 16.5;
    await page.eval(`BF.review.timeline.info(); BF.player.pause(); true`);
    const clickX = await page.eval(`BF.review.timeline.timeToX(${target})`);
    const clickY = await page.eval('BF.review.timeline.info().canvas.top + 100');
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', buttons: 0, clickCount: 1 });
    await waitFor(page, `Math.abs(document.getElementById('video').currentTime - ${target}) < 0.3`, 5000, 'player posicionado pelo clique');
    step('timeline: clicar posiciona o player');

    // arrastar a borda de início do corte selecionado com o mouse de verdade
    await page.eval(`BF.review.select(${j(lanceId)}, { seek: false }); document.querySelector('.tl-btn[title^="Aproximar"]').click(); true`);
    await sleep(500);
    await page.eval('window.__ev.length = 0; true');
    const beforeDrag = (await cutsData(page)).find((c) => c.id === lanceId);
    const edge = await page.eval(`BF.review.timeline.edgePoint(${j(lanceId)}, 'start')`);
    const dx = 60;
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: edge.x, y: edge.y });
    assert.equal(await page.eval("document.querySelector('.tl-main').style.cursor"), 'ew-resize', 'o cursor indica que a borda arrasta');
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: edge.x, y: edge.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 6; i++) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: edge.x + (dx / 6) * i, y: edge.y, buttons: 1 });
    // durante o arrasto o corte ainda não mudou (valor provisório só na tela)
    assert.equal((await cutsData(page)).find((c) => c.id === lanceId).start, beforeDrag.start);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: edge.x + dx, y: edge.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(250);
    const afterDrag = (await cutsData(page)).find((c) => c.id === lanceId);
    const expected = beforeDrag.start + dx * edge.secPerPx;
    assert.ok(Math.abs(afterDrag.start - expected) < 0.06, `início arrastado: ${afterDrag.start} (esperado ~${expected.toFixed(2)})`);
    assert.equal(afterDrag.end, beforeDrag.end, 'o fim não muda');
    assert.equal(afterDrag.revision, beforeDrag.revision + 1);
    assert.equal((await rows(page)).find((x) => x.id === lanceId).changed, 'true', 'arrastar borda de corte revisado marca "alterado"');
    ev = await page.eval('window.__ev');
    const adj = ev.filter(([n]) => n === 'decision').map(([, d]) => d);
    assert.equal(adj.length, 1);
    assert.deepEqual([adj[0].type, adj[0].before.start, adj[0].before.end, adj[0].after.end], ['adjust', beforeDrag.start, beforeDrag.end, beforeDrag.end]);
    assert.equal(ev.filter(([n]) => n === 'cuts:changed').length, 1);
    assert.match(await page.eval('BF.review.engine.groups().at(-1).label'), /^Ajustou “Lance final” \(início \+/);
    if (shots) await h.screenshot(page, path.join(shots, 'timeline-arrastar.png'));
    // arrastar a borda do fim para o outro lado (e Esc cancela)
    const endEdge = await page.eval(`BF.review.timeline.edgePoint(${j(lanceId)}, 'end')`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: endEdge.x, y: endEdge.y, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: endEdge.x + 40, y: endEdge.y, buttons: 1 });
    await page.press('Escape');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endEdge.x + 40, y: endEdge.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(200);
    assert.equal((await cutsData(page)).find((c) => c.id === lanceId).end, beforeDrag.end, 'Esc cancela o arrasto');
    // desfazer o arrasto
    await click(page, '[data-focus="undo"]');
    await sleep(150);
    assert.equal((await cutsData(page)).find((c) => c.id === lanceId).start, beforeDrag.start);
    step(`timeline: arrastar a borda mudou o início de ${beforeDrag.start} para ${afterDrag.start} (marcou "alterado", gerou 1 decisão adjust); Esc cancela; desfaz`);

    // ocultar
    await click(page, '.tl-toggle');
    await waitFor(page, "!BF.review.timeline.isOpen() && document.getElementById('timelineSlot').children.length === 0");
    assert.equal(await page.eval("getComputedStyle(document.getElementById('timelineSlot')).display"), 'none');
    assert.equal(await page.eval("document.querySelector('.tl-toggle').getAttribute('aria-pressed')"), 'false');
    step('timeline: botão mostra e oculta');

    // ---- persistência: histórico em disco e cortes após reiniciar ----
    await page.eval('BF.review.history.flush(); BF.project.flush()');
    await sleep(300);
    const projectId = projectIdFor(source);
    const histFile = path.join(userData, 'history', `${projectId}.json`);
    assert.ok(fs.existsSync(histFile), 'histórico gravado em userData/history/<projectId>.json');
    const onDisk = JSON.parse(fs.readFileSync(histFile, 'utf8'));
    assert.equal(onDisk.version, 1);
    const inMemory = await page.eval('BF.review.engine.groups().length');
    assert.equal(onDisk.groups.length, inMemory, 'tudo o que está em memória foi gravado');
    assert.ok(onDisk.groups.some((g) => g.source === 'batch') && onDisk.groups.some((g) => g.source === 'restore') && onDisk.groups.some((g) => g.source === 'external'));
    assert.deepEqual(fs.readdirSync(path.join(userData, 'history')).filter((f) => f.includes('.tmp')), []);
    const stateBefore = await cutsData(page);
    h.assertNoConsoleErrors(page);
    await app.stop();

    app = await h.launchApp(userData);
    page = app.page;
    await page.eval(`BF.openSource(${j(source)})`);
    await waitFor(page, "document.querySelectorAll('#cuts .cut').length === 6", 30000);
    await waitFor(page, `BF.review.engine.groups().length === ${onDisk.groups.length}`, 10000, 'histórico lido do disco');
    assert.deepEqual(await cutsData(page), stateBefore, 'cortes, decisões, títulos e categorias preservados');
    assert.equal(await page.eval('BF.review.engine.canUndo()'), false, 'a pilha de desfazer é só da sessão');
    await page.eval("document.querySelector('details.history').open = true; document.querySelector('details.history').dispatchEvent(new Event('toggle')); true");
    await sleep(200);
    assert.equal(await page.eval("document.querySelectorAll('.history-item').length"), Math.min(30, onDisk.groups.length));
    // restaurar a partir do histórico gravado por uma sessão anterior (o primeiro lote aprovado)
    await page.eval("[...document.querySelectorAll('details.history button.link')].find((b) => /Mostrar mais/.test(b.textContent)).click()");
    await sleep(200);
    const oldGroup = await page.eval('BF.review.engine.groups().find((g) => g.source === "batch").id');
    await openPreview(page, () => click(page, `[data-focus="restore-${oldGroup}"]`));
    assert.ok((await previewItems(page)).length >= 3);
    assert.deepEqual(await cutsData(page), stateBefore, 'a prévia não altera nada');
    await confirmPreview(page);
    assert.ok((await cutsData(page)).every((c) => c.status === 'pending'), 'voltou ao estado de antes do primeiro lote');
    await click(page, '[data-focus="undo"]');
    await sleep(200);
    const noRevision = (list) => list.map((c) => ({ ...c, revision: 0 }));
    assert.deepEqual(noRevision(await cutsData(page)), noRevision(stateBefore), 'e a restauração (de sessão anterior) também desfaz (a revisão só sobe, de propósito)');
    // restaurar quando nada mudaria avisa em vez de abrir uma prévia vazia
    const lastBatch = await page.eval('[...BF.review.engine.groups()].reverse().find((g) => g.source === "batch").id');
    await page.eval("document.getElementById('toasts').replaceChildren(); true");
    await click(page, `[data-focus="restore-${lastBatch}"]`);
    await sleep(200);
    assert.equal(await hidden(page, '.preview'), true);
    assert.match(await text(page, '#toasts'), /Nada a restaurar/);
    step('após reiniciar: cortes e histórico lidos do disco; restaurar de sessão anterior com prévia e reversível; "nada a restaurar" avisa');

    // ---- vídeo SEM áudio: a timeline explica o motivo e continua funcionando (nada fictício) ----
    const muted = path.join(tmp, 'mudo.mp4');
    execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', muted], { windowsHide: true });
    await page.eval(`BF.openSource(${j(muted)})`);
    await waitFor(page, `BF.state.project && BF.state.project.source.path.endsWith('mudo.mp4')`, 20000, 'vídeo mudo aberto');
    await page.eval(`BF.project.addCut({ title: 'Sem som', start: 3, end: 8 }); true`);
    await waitFor(page, "document.querySelectorAll('#cuts .cut').length === 1");
    await click(page, '.tl-toggle');
    await waitFor(page, "BF.review.timeline.info().status === 'error'", 20000, 'erro de áudio explicado');
    const noAudio = await page.eval('BF.review.timeline.info()');
    assert.equal(noAudio.errorCode, 'NO_AUDIO');
    assert.match(noAudio.error, /não tem faixa de áudio/);
    assert.match(await text(page, '.tl-info'), /Sem forma de onda/);
    assert.equal(await page.eval("document.querySelector('.tl-info + button').hidden"), true, 'sem áudio não adianta tentar de novo');
    // mesmo assim as regiões aparecem e as bordas arrastam
    const muteCut = await idOf(page, 'Sem som');
    await page.eval(`BF.review.select(${j(muteCut)}, { seek: false }); document.querySelector('.tl-btn[title^="Aproximar"]').click(); true`);
    await sleep(400);
    const muteEdge = await page.eval(`BF.review.timeline.edgePoint(${j(muteCut)}, 'end')`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: muteEdge.x, y: muteEdge.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 4; i++) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: muteEdge.x - 10 * i, y: muteEdge.y, buttons: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: muteEdge.x - 40, y: muteEdge.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(250);
    const muteAfter = (await cutsData(page)).find((c) => c.id === muteCut);
    assert.ok(Math.abs(muteAfter.end - (8 - 40 * muteEdge.secPerPx)) < 0.06, `fim arrastado sem áudio: ${muteAfter.end}`);
    step('vídeo sem áudio: a timeline diz por que não há onda (NO_AUDIO) e as bordas continuam arrastando');

    // ---- integração: títulos da análise, "Exportado" defasado, borda que não arrasta a outra, Ctrl+Z por aba, rascunho ----
    // (projeto do vídeo mudo, 12 s; cortes criados como a análise os cria: origin 'auto', título "Sugestão m:ss", sem titleCustom)
    await page.eval(`(() => {
      BF.project.addCut({ title: 'Sugestão 0:08', start: 8, end: 9, origin: 'auto', relevance: 0.7 });
      BF.project.addCut({ title: 'Sugestão 0:09', start: 9.5, end: 10.5, origin: 'auto', relevance: 0.6 });
      BF.project.addCut({ title: 'Fora do fim', start: 11, end: 14 });
      return true;
    })()`);
    await waitFor(page, "document.querySelectorAll('#cuts .cut').length === 4");
    const sug1 = await idOf(page, 'Sugestão 0:08');
    const sug2 = await idOf(page, 'Sugestão 0:09');
    const fora = await idOf(page, 'Fora do fim');
    r = await rows(page);
    assert.deepEqual([r.find((x) => x.id === sug1).similar, r.find((x) => x.id === sug2).similar], ['false', 'false'], 'sugestões vizinhas da análise (a 0,5 s uma da outra) não são "semelhantes" só pelo título automático');
    assert.ok(!r.find((x) => x.id === sug1).chips.some((c) => c.startsWith('Semelhante')));
    await clickIn(page, sug1, 'approve');
    await sleep(150);
    r = await rows(page);
    assert.equal(r.find((x) => x.id === sug1).status, 'approved');
    assert.equal(r.find((x) => x.id === sug1).custom, 'false', 'aprovar não faz o título "Sugestão m:ss" virar "personalizado"');
    await page.eval(`BF.review.select(${j(sug1)}, { seek: false }); true`);
    await waitFor(page, `!!document.querySelector('[data-id="${sug1}"] [data-focus="suggest"]')`);
    assert.equal(await page.eval(`!!document.querySelector('[data-id="${sug1}"] .chip.custom')`), false, 'sem o selo "personalizado"');
    await clickIn(page, sug1, 'suggest');
    await waitFor(page, `document.querySelectorAll('[data-id="${sug1}"] .suggestion').length > 0`);
    const aSuggestion = await page.eval(`document.querySelector('[data-id="${sug1}"] .suggestion').textContent`);
    await page.eval(`document.querySelector('[data-id="${sug1}"] .suggestion').click()`);
    await sleep(200);
    assert.equal(await modalOpen(page), false, 'trocar o título automático da análise por uma sugestão não pede confirmação');
    assert.deepEqual(await page.eval(`(() => { const c = BF.project.cut(${j(sug1)}); return [c.title, c.titleCustom]; })()`), [aSuggestion, false]);
    step('títulos da análise: aprovar não os torna "personalizados" e sugestões vizinhas não viram "semelhantes"');

    // "Exportado": o selo só vale enquanto o início e o fim batem com o que foi exportado
    await page.eval(`(() => {
      BF.project.update((p) => { const c = p.cuts.find((x) => x.id === ${j(sug2)}); c.exports.push({ path: 'C:\\\\videos\\\\sug2.mp4', at: new Date().toISOString(), start: c.start, end: c.end, profile: 'vertical-1080-h264', jobId: 'j-e2e', key: 'k-e2e', revision: c.revision }); }, { reason: 'queue:done' });
      BF.bus.emit('cuts:changed', { ids: [${j(sug2)}], from: 'queue:done' });
      return true;
    })()`);
    const exportedOf = (id) => page.eval(`(() => { const b = document.querySelector('[data-id="${id}"] .exported'); return b ? { text: b.textContent, stale: b.dataset.stale, title: b.title } : null; })()`);
    await waitFor(page, `!!document.querySelector('[data-id="${sug2}"] .exported')`);
    assert.deepEqual((await exportedOf(sug2)).text, 'Exportado: C:\\videos\\sug2.mp4');
    assert.equal((await exportedOf(sug2)).stale, 'false');
    await page.eval(`BF.review.select(${j(sug2)}, { seek: false }); true`);
    await waitFor(page, `!!document.querySelector('[data-id="${sug2}"] [data-focus="step-end-1"]')`);
    await clickIn(page, sug2, 'step-end--0.1');
    await sleep(200);
    const stale = await exportedOf(sug2);
    assert.equal(stale.stale, 'true', 'o fim mudou depois de exportar');
    assert.match(stale.text, /^Exportado \(corte alterado depois\): C:\\videos\\sug2\.mp4$/);
    assert.match(stale.title, /exportado com o corte em 0:09\.5 → 0:10\.5; agora ele está em 0:09\.5 → 0:10\.4/);
    await click(page, '[data-focus="undo"]');
    await sleep(200);
    assert.equal((await exportedOf(sug2)).stale, 'false', 'voltou ao tempo exportado: o arquivo volta a valer');
    step('"Exportado": avisa "corte alterado depois" quando início/fim mudam depois da exportação e volta ao normal ao desfazer');

    // borda: mexer no início de um corte que passa do fim do vídeo não toca no fim; o fim só é limitado quando é ele que se mexe
    await page.eval(`BF.review.select(${j(fora)}, { seek: false }); true`);
    await waitFor(page, `!!document.querySelector('[data-id="${fora}"] [data-focus="step-start--1"]')`);
    const videoLength = await page.eval('BF.player.duration()');
    assert.ok(videoLength > 11.5 && videoLength < 12.5, `vídeo de 12 s (${videoLength})`);
    await clickIn(page, fora, 'step-start--1');
    await sleep(200);
    let foraCut = (await cutsData(page)).find((c) => c.id === fora);
    assert.deepEqual([foraCut.start, foraCut.end, foraCut.revision], [10, 14, 2], 'só o início andou: o fim segue em 14 s (passa do vídeo; isso é aviso, não algo a corrigir em silêncio)');
    assert.doesNotMatch(await text(page, '#log'), /limitado/);
    assert.match(await text(page, '#log'), /início -1 s/);
    await clickIn(page, fora, 'step-end--1');
    await sleep(200);
    foraCut = (await cutsData(page)).find((c) => c.id === fora);
    assert.equal(foraCut.start, 10, 'o início continua onde estava');
    assert.ok(Math.abs(foraCut.end - Math.round(videoLength * 100) / 100) < 0.011, `o fim é limitado ao vídeo (${foraCut.end})`);
    assert.match(await text(page, '#log'), /^Fim do corte limitado ao máximo possível/, 'a mensagem nomeia a borda que de fato foi limitada');
    step('ajuste de tempo: mexer numa borda não reescreve a outra (corte parcialmente fora do vídeo) e a mensagem nomeia a borda certa');

    // Ctrl+Z / Ctrl+Y valem na aba Cortes; nas outras abas (Legendas, Áudio) não desfazem decisões da revisão
    const keyZ = (extra = {}) => page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', text: 'z', modifiers: 2, ...extra }).then(() => page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2, ...extra }));
    const statusOf = async (id) => (await cutsData(page)).find((c) => c.id === id).status;
    assert.equal(await statusOf(sug1), 'approved');
    for (const tab of ['subtitles', 'audio']) {
      await page.eval(`BF.ui.selectTab(${j(tab)}); document.activeElement && document.activeElement.blur(); true`);
      await waitFor(page, `!document.getElementById('tabpanel-${tab}').hidden`);
      await sleep(150);
      await keyZ();
      await sleep(200);
      assert.equal(await statusOf(sug1), 'approved', `Ctrl+Z na aba ${tab} não desfaz a aprovação da revisão`);
      assert.equal(await page.eval('BF.review.engine.canUndo()'), true, 'a pilha de desfazer da revisão continua intacta');
    }
    await page.eval("BF.ui.selectTab('cuts'); document.activeElement && document.activeElement.blur(); true");
    await waitFor(page, "!document.getElementById('tabpanel-cuts').hidden");
    await sleep(150);
    const undoLabel = await page.eval('BF.review.engine.undoLabel()');
    await keyZ();
    await sleep(200);
    assert.notEqual(await page.eval('BF.review.engine.undoLabel()'), undoLabel, 'na aba Cortes o Ctrl+Z continua desfazendo a última ação');
    await page.eval('BF.review.engine.redo(); true');
    step('Ctrl+Z: só na aba Cortes (nas abas Legendas e Áudio não desfaz decisões da revisão)');

    // quem está digitando não tem a lista refeita debaixo das mãos (exportação que termina, aprendizado das preferências, …):
    // o texto não some nem é confirmado pela metade (um título incompleto virava o título do corte e entrava no histórico)
    const sem = await idOf(page, 'Sem som');
    await page.eval(`BF.review.select(${j(sem)}, { seek: false }); true`);
    await waitFor(page, `!!document.querySelector('[data-id="${sem}"] [data-focus="notes"]')`);
    const field = (key) => `document.querySelector('[data-id="${sem}"] [data-focus="${key}"]')`;
    const semData = async () => (await cutsData(page)).find((c) => c.id === sem);
    await page.eval(`document.querySelector('[data-id="${sem}"] .advanced').open = true; true`); // notas e sugestões de título ficam em "Avançado"
    await sleep(100);
    await page.eval(`${field('notes')}.focus(); true`);
    await page.send('Input.insertText', { text: 'nota longa em andamento' });
    assert.equal(await page.eval(`${field('notes')}.value`), 'nota longa em andamento');
    // aprendizado de outra chave (analysis.*): a revisão nem lê, então nem refaz a lista
    await page.eval(`window.__notesNode = ${field('notes')}; BF.bus.emit('prefs:changed', { reason: 'learned', keys: ['analysis.minDurationSec', 'analysis.maxDurationSec'] }); true`);
    await sleep(250);
    assert.equal(await page.eval(`${field('notes')} === window.__notesNode`), true, 'preferência que a revisão não lê não refaz a lista');
    // o mesmo evento que a fila emite ao terminar uma exportação, e uma preferência que a revisão lê: com o campo em edição a lista espera
    await page.eval(`BF.project.update((p) => { const c = p.cuts.find((x) => x.id === ${j(sem)}); c.exports.push({ path: 'C:\\\\videos\\\\sem-som.mp4', at: new Date().toISOString(), start: c.start, end: c.end, profile: 'vertical-1080-h264', jobId: 'j-e2e-2', key: 'k-e2e-2', revision: c.revision }); }, { reason: 'queue:done' });
      BF.bus.emit('cuts:changed', { ids: [${j(sem)}], from: 'queue:done' }); BF.bus.emit('prefs:changed', { reason: 'set', keys: ['review.categories'] }); true`);
    await sleep(400);
    assert.equal(await page.eval(`${field('notes')} === window.__notesNode`), true, 'a lista não é refeita enquanto o campo está sendo editado');
    assert.equal(await page.eval(`${field('notes')}.value`), 'nota longa em andamento', 'o texto digitado continua lá');
    assert.equal(await page.eval(`document.activeElement === ${field('notes')}`), true, 'com o foco no campo');
    assert.equal((await semData()).notes, '', 'e não foi confirmado pela metade');
    assert.equal(await page.eval(`!!document.querySelector('[data-id="${sem}"] .exported')`), false, 'a linha "Exportado" espera');
    await page.eval('document.activeElement.blur(); true'); // sair do campo confirma o texto e libera o redesenho que estava esperando
    await waitFor(page, `!!document.querySelector('[data-id="${sem}"] .exported')`, 5000, 'redesenho adiado aconteceu depois de sair do campo');
    assert.equal((await semData()).notes, 'nota longa em andamento', 'sair do campo confirma as notas');
    assert.match(await text(page, `[data-id="${sem}"] .exported`), /sem-som\.mp4/);
    // título: um único registro no histórico, com o texto inteiro, mesmo com a lista querendo se refazer no meio da digitação
    const groupsBefore = await page.eval('BF.review.engine.groups().length');
    await page.eval(`${field('title')}.focus(); ${field('title')}.select(); true`);
    await page.send('Input.insertText', { text: 'Título que estou' });
    await page.eval(`BF.bus.emit('cuts:changed', { ids: [], from: 'queue:done' }); true`);
    await sleep(300);
    assert.equal(await page.eval(`${field('title')}.value`), 'Título que estou');
    assert.equal(await page.eval(`document.activeElement === ${field('title')}`), true);
    assert.equal((await semData()).title, 'Sem som', 'o título pela metade não virou o título do corte');
    assert.equal(await page.eval('BF.review.engine.groups().length'), groupsBefore, 'nem entrou no histórico');
    await page.send('Input.insertText', { text: ' digitando agora' });
    await page.eval('document.activeElement.blur(); true');
    await sleep(300);
    const semCut = await semData();
    assert.deepEqual([semCut.title, semCut.titleCustom], ['Título que estou digitando agora', true]);
    assert.equal(await page.eval('BF.review.engine.groups().length'), groupsBefore + 1, 'uma única renomeação no histórico');
    // tempo digitado pela metade também não mexe no corte
    await page.eval(`${field('time-end')}.focus(); ${field('time-end')}.select(); true`);
    const endBefore = (await semData()).end;
    await page.send('Input.insertText', { text: '0:0' });
    await page.eval(`BF.bus.emit('cuts:changed', { ids: [], from: 'queue:done' }); true`);
    await sleep(300);
    assert.equal(await page.eval(`${field('time-end')}.value`), '0:0');
    assert.equal((await semData()).end, endBefore, 'um tempo incompleto não vira o fim do corte');
    await page.send('Input.insertText', { text: '7.0' }); // completa o tempo: 0:07.0
    await page.eval('document.activeElement.blur(); true');
    await sleep(300);
    assert.equal((await semData()).end, 7, 'completo e confirmado ao sair do campo');
    step('quem digita não tem a lista refeita (exportação concluída, preferências): o texto fica, nada é confirmado pela metade e o redesenho vem ao sair do campo');

    // ---- sem erros de console ----
    h.assertNoConsoleErrors(page);
    step('nenhum erro de console no app');
    if (shots) { await page.eval("document.querySelector('details.history').open = false; true"); await h.screenshot(page, path.join(shots, 'cortes.png')); }
    await app.stop();
    console.log('\nE2E OK');
  } finally {
    await h.cleanupAll();
    // se o teste falhou no meio, o Electron pode demorar a soltar os arquivos: tenta de novo sem mascarar o erro original
    for (let attempt = 1; attempt <= 12; attempt++) {
      try { h.removeDir(tmp); break; } catch (err) {
        if (attempt === 12) console.warn(`aviso: não foi possível remover ${tmp}: ${err.message}`);
        else await sleep(700);
      }
    }
  }
}

main().then(() => process.exit(0), (err) => {
  console.error(`\n✖ E2E FALHOU: ${err.stack || err.message}`);
  h.cleanupAll().finally(() => process.exit(1));
});

'use strict';

/**
 * E2E da aba Análise: abre o app Electron de verdade (perfil temporário), analisa um vídeo sintético (rajadas de
 * áudio, flash e chat em instantes conhecidos), confere a lista, "ver trecho", adicionar uma / todas, reanálise sem
 * duplicar (inclusive com corte rejeitado), descartar/restaurar sugestões (sem criar corte), campos numéricos que mostram o
 * valor que vale, botão Analisar sem sinal utilizável, cancelamento, confirmação ao abrir outro vídeo durante a análise,
 * persistência, resultado de um projeto adotado (outro vídeo) e que NADA é aprovado automaticamente.
 * Uso: node tests/e2e/analysis.e2e.js   (BF_E2E_SHOTDIR=<pasta> guarda capturas da janela)
 */
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { locateTools } = require('../../src/core/ffmpeg/locate');
const { makeMedia, makeChat } = require('../analysis-fixtures');
const h = require('./helpers');

const { sleep, waitFor, answerModal } = h;
const tools = locateTools();
const step = (m) => console.log(`✔ ${m}`);
const q = (s) => JSON.stringify(s);

const setRange = (page, id, value) => page.eval(`(() => { const e = document.getElementById(${q(id)}); e.value = ${q(String(value))}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const items = (page) => page.eval(`[...document.querySelectorAll('#anList .an-item')].map((li) => ({ start: Number(li.dataset.start), end: Number(li.dataset.end), text: li.textContent, reasons: [...li.querySelectorAll('.an-reasons li')].map((r) => r.textContent) }))`);
const cuts = (page) => page.eval('JSON.parse(JSON.stringify(BF.state.project.cuts))');
const text = (page, sel) => page.eval(`document.querySelector(${q(sel)}) ? document.querySelector(${q(sel)}).textContent : null`);

/** Clica em Analisar e espera a análise terminar (resumo atualizado ou aviso). */
async function analyze(page, { expectCache } = {}) {
  await page.eval("window.__done = 0; BF.on('analysis:done', () => { window.__done += 1; }); BF.on('analysis:failed', () => { window.__done += 1; }); true");
  await waitFor(page, "!document.getElementById('anRun').disabled", 15000, 'botão Analisar liberado');
  await page.eval("document.getElementById('anRun').click()");
  await waitFor(page, 'window.__done >= 1', 120000, 'fim da análise');
  await waitFor(page, "!document.getElementById('anRun').disabled && document.getElementById('anRun').textContent === 'Analisar'", 15000, 'interface liberada');
  if (expectCache !== undefined) assert.equal(/resultado do cache/.test(await text(page, '#anSummary')), expectCache, await text(page, '#anSummary'));
}

async function main() {
  assert.ok(tools.ffmpeg && tools.ffprobe, 'ffmpeg/ffprobe necessários para o teste');
  const tmp = h.mkTemp('e2e-analysis');
  const userData = path.join(tmp, 'userdata');
  const live = path.join(tmp, 'live.mp4');
  const long = path.join(tmp, 'longo.mp4');
  const chatFile = path.join(tmp, 'chat.json');

  try {
    // vídeo de 70 s: rajadas de áudio em 12-15 e 50-53; flash em 31,0-31,4; chat reage ~6 s depois da 2ª rajada
    makeMedia(live, { seconds: 70, size: '320x180', rate: 15, audio: { baseDb: -50, bursts: [{ at: 12, dur: 3, db: -20 }, { at: 50, dur: 3, db: -20 }] }, luma: { base: 60, flashes: [{ at: 31, dur: 0.4, level: 235 }] } });
    const chatCount = makeChat(chatFile, { duration: 70, baseRate: 0.3, bursts: [{ at: 56, dur: 8, rate: 6, text: 'clipa essa!' }] });
    // vídeo longo (movimento constante) só para ter tempo de cancelar: 20 min em 320x180
    childProcess.execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=1200',
      '-f', 'lavfi', '-i', 'anoisesrc=d=1200:c=pink:r=44100:a=0.2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-shortest', long], { windowsHide: true });
    step('vídeos sintéticos gerados (70 s com rajadas/flash/chat e 20 min para cancelar)');

    let app = await h.launchApp(userData);
    let page = app.page;
    assert.deepEqual(await page.eval('BF.state.loadErrors'), [], 'todos os handlers carregaram (inclui analysis)');

    // sem projeto: a aba existe mas fica desabilitada (a base cuida disso)
    assert.equal(await page.eval("document.getElementById('tab-analysis').disabled"), true);
    assert.equal(await page.eval("document.getElementById('anRun').disabled"), true, 'sem projeto o botão Analisar está desabilitado');

    await page.eval("window.__ev = []; BF.bus.on('decision', (d) => window.__ev.push(['decision', d.type, d.cutId])); BF.bus.on('cuts:changed', (d) => window.__ev.push(['cuts:changed', (d && d.ids || []).length])); true");
    await page.eval(`BF.openSource(${q(live)})`);
    await waitFor(page, "!document.getElementById('app').classList.contains('no-project')", 20000, 'projeto aberto');

    // chat "baixado" (como a aba Fontes faria) e preferências: margens/durações vêm de BF.prefs
    await page.eval(`BF.project.update((p) => { p.chat = { path: ${q(chatFile)}, format: 'bf-chat-1', count: ${chatCount}, fetchedAt: new Date().toISOString(), platform: 'twitch' }; }, { reason: 'teste:chat' }); BF.bus.emit('project:changed', { reason: 'teste' }); true`);
    await page.eval(`(() => { const prefs = { 'analysis.padBeforeSec': 2, 'analysis.padAfterSec': 1, 'analysis.minDurationSec': 10, 'analysis.maxDurationSec': 30, 'analysis.minRelevance': 0.5 }; BF.prefs.get = (key, fallback) => (key in prefs ? prefs[key] : fallback); })()`);
    // um corte REJEITADO sobre a 1ª rajada: não pode voltar como sugestão
    await page.eval("BF.project.addCut({ start: 11, end: 18, title: 'Já rejeitado' }); BF.project.update((p) => { p.cuts[0].status = 'rejected'; }, { reason: 'teste' }); true");
    await page.eval("window.__ev.length = 0; BF.ui.selectTab('analysis')");
    await waitFor(page, "!document.getElementById('tabpanel-analysis').hidden", 5000, 'aba Análise visível');

    // ---- a tela ----
    const intro = await text(page, '.an-intro');
    assert.match(intro, /não inteligência artificial/);
    assert.match(intro, /sugestão não é garantia — revise/);
    assert.equal(await page.eval("document.getElementById('anRun').disabled"), false);
    assert.equal(await page.eval("document.querySelector('.an-advanced').open"), false, 'ajustes avançados recolhidos');
    assert.equal(await page.eval("document.getElementById('anCancel').hidden"), true);
    assert.equal(await page.eval("document.getElementById('anResults').hidden"), true, 'sem resultado antes de analisar');
    assert.deepEqual(await page.eval("['audio','image','chat'].map((s) => document.getElementById('anSignal-' + s).disabled)"), [false, false, false]);
    assert.equal(await page.eval("document.getElementById('anSignal-text').disabled"), true, 'sem transcrição o sinal de texto fica desligado');
    assert.match(await text(page, '#anHint-text'), /sem transcrição deste vídeo/);
    assert.equal(await page.eval("[...document.querySelectorAll('#analysis button')].filter((b) => !b.closest('[hidden]')).length <= 7"), true, 'poucos botões visíveis antes de analisar (motor, Analisar, Transcrever/Importar e os dois dos ajustes avançados)');
    assert.equal(await page.eval("[...document.querySelectorAll('#analysis button.primary')].filter((b) => !b.closest('[hidden]')).length"), 1, 'um destaque primário só');
    assert.equal(await page.eval("document.getElementById('anHints')"), null, 'não existe mais a opção "Dicas de volume"');
    assert.equal(await page.eval("['anWeight-text', 'anTextWeight-laugh', 'anTextWeight-exclaim', 'anTextWeight-pace', 'anTextWeight-repeat', 'anTextWeight-meta'].every((id) => document.querySelector('.an-advanced').contains(document.getElementById(id)))"), true, 'pesos do texto dentro dos ajustes avançados (recolhidos)');
    assert.match(await text(page, '#anPrefsNote'), /2 s antes, 1 s depois, entre 10 e 30 s, relevância mínima 50%/);
    step('tela: intro com aviso "sugestão não é garantia", sinais ligáveis, avançados recolhidos, preferências lidas de BF.prefs');

    // ajustes persistem no projeto
    await setRange(page, 'anSensitivity', 4);
    await setRange(page, 'anPerHour', 8);
    assert.match(await text(page, '#analysis output[for=anSensitivity]'), /alta/);
    assert.equal(await page.eval('BF.state.project.ext.analysis.settings.sensitivity'), 4);

    // campos numéricos fora da faixa: o campo passa a mostrar o valor que a análise usa (e que fica gravado)
    await setRange(page, 'anWeight-audio', 5);
    assert.equal(await page.eval("document.getElementById('anWeight-audio').value"), '2', 'peso acima do máximo: o campo mostra 2');
    assert.equal(await page.eval('BF.state.project.ext.analysis.settings.weights.audio'), 2);
    await setRange(page, 'anChatLag', 500);
    assert.equal(await page.eval("document.getElementById('anChatLag').value"), '60', 'atraso acima do máximo: o campo mostra 60');
    assert.equal(await page.eval('BF.state.project.ext.analysis.settings.chat.lagSec'), 60);
    await setRange(page, 'anWeight-audio', 1);
    await setRange(page, 'anChatLag', 6);
    // sem nenhum sinal utilizável o botão Analisar fica desabilitado, e a tela diz por quê
    const clickSignals = (on) => page.eval(`['audio', 'image', 'chat'].forEach((id) => { const b = document.getElementById('anSignal-' + id); if (b.checked !== ${on}) b.click(); }); true`);
    await clickSignals(false);
    assert.equal(await page.eval("document.getElementById('anRun').disabled"), true, 'três sinais desligados: não há o que analisar');
    assert.equal(await page.eval("document.getElementById('anSignalWarn').hidden"), false);
    assert.match(await text(page, '#anSignalWarn'), /Nenhum sinal utilizável/);
    await clickSignals(true);
    assert.equal(await page.eval("document.getElementById('anRun').disabled"), false);
    assert.equal(await page.eval("document.getElementById('anSignalWarn').hidden"), true);
    step('ajustes: número fora da faixa mostra o valor limitado; sem sinal utilizável o Analisar fica desabilitado com o motivo');

    // ---- analisar ----
    await analyze(page, { expectCache: false });
    const list = await items(page);
    assert.equal(list.length, 2, `sugestões: ${JSON.stringify(list.map((s) => [s.start, s.end]))}`);
    const summary = await text(page, '#anSummary');
    assert.match(summary, /3 sugestão\(ões\) encontrada\(s\)/);
    assert.match(summary, /1 já nos cortes/);
    assert.match(summary, /sinais usados: áudio, imagem, chat/);
    const byStart = [...list].sort((a, b) => a.start - b.start);
    const [flash, second] = byStart;
    assert.ok(flash.start <= 31 && flash.end >= 31.4, `flash: ${flash.start}-${flash.end}`);
    assert.ok(flash.reasons.includes('mudança de cena'));
    assert.ok(second.start <= 50 && second.end >= 53, `2ª rajada: ${second.start}-${second.end}`);
    assert.ok(second.reasons.some((r) => /^volume acima do normal de fala/.test(r)) && second.reasons.some((r) => /^chat .*× a média$/.test(r)), second.reasons.join('|'));
    for (const s of list) assert.ok(s.end - s.start >= 10 - 0.05 && s.end - s.start <= 30 + 0.05, `duração ${s.end - s.start} fora das preferências (10-30 s)`);
    // a 1ª rajada (12-15) já tem corte rejeitado: não aparece
    assert.ok(!list.some((s) => s.start <= 13 && s.end >= 14), 'sugestão sobre corte rejeitado não volta');
    assert.equal(await page.eval("document.querySelectorAll('#anList .an-item').length"), 2);
    // ordenadas por relevância (a 2ª rajada tem 3 sinais: 100%)
    assert.match((await items(page))[0].text, /100%/);
    assert.equal(await page.eval("document.getElementById('tab-analysis').querySelector('.tab-badge').textContent"), '2', 'badge com as sugestões pendentes');
    assert.equal(await page.eval('BF.state.project.analysis.lastRun.count'), 3);
    assert.deepEqual(await page.eval('BF.state.project.analysis.lastRun.signals'), ['audio', 'image', 'chat', 'calm']);
    step(`análise: ${list.length} sugestões visíveis nos instantes certos (flash ~31, rajada+chat ~51), motivos legíveis, rejeitada não volta`);

    if (process.env.BF_E2E_SHOTDIR) {
      fs.mkdirSync(process.env.BF_E2E_SHOTDIR, { recursive: true });
      await h.screenshot(page, path.join(process.env.BF_E2E_SHOTDIR, 'analysis-lista.png'));
    }

    // ---- ver trecho ----
    const target = second;
    await page.eval(`document.querySelector('#anList .an-item[data-start="${target.start}"] .an-view').click()`);
    await waitFor(page, `Math.abs(document.getElementById('video').currentTime - ${target.start}) < 3 || document.getElementById('video').currentTime > ${target.start}`, 8000, 'player no início do trecho');
    await page.eval('BF.player.pause()');
    step('"Ver trecho" leva o player ao início do trecho');

    // ---- descartar (sem criar corte) e restaurar ----
    const cutsBeforeDismiss = await cuts(page);
    await page.eval(`document.querySelector('#anList .an-item[data-start="${second.start}"] .an-dismiss').click()`);
    await waitFor(page, "document.querySelectorAll('#anList .an-item').length === 1", 5000, 'sugestão descartada sai da lista');
    assert.equal((await cuts(page)).length, cutsBeforeDismiss.length, 'descartar não cria corte');
    assert.equal(await page.eval("document.getElementById('tab-analysis').querySelector('.tab-badge').textContent"), '1', 'o selo da aba acompanha');
    assert.equal(await page.eval("document.getElementById('anDismissed').hidden"), false);
    assert.equal(await page.eval("document.getElementById('anDismissed').open"), false, 'a seção Descartadas vem recolhida');
    assert.match(await text(page, '#anDismissed summary'), /Descartadas \(1\)/);
    assert.match(await text(page, '#anSummary'), /1 descartada\(s\)/);
    // reanalisar (do cache): a descartada não volta
    await analyze(page, { expectCache: true });
    assert.equal(await page.eval("document.querySelectorAll('#anList .an-item').length"), 1, 'a descartada não volta numa nova análise');
    assert.equal(await page.eval('BF.state.project.ext.analysis.dismissed.length'), 1);
    await page.eval("document.querySelector('#anDismissed summary').click()");
    await page.eval(`document.querySelector('#anDismissedList .an-item[data-start="${second.start}"] .an-restore').click()`);
    await waitFor(page, "document.querySelectorAll('#anList .an-item').length === 2", 5000, 'restaurada volta à lista');
    assert.equal(await page.eval('BF.state.project.ext.analysis.dismissed.length'), 0);
    assert.equal(await page.eval("document.getElementById('anDismissed').hidden"), true);
    assert.equal((await cuts(page)).length, cutsBeforeDismiss.length, 'restaurar também não cria corte');
    step('descartar: some da lista e do selo sem criar corte, fica em Descartadas, não volta ao reanalisar e pode ser restaurada');

    // ---- adicionar uma ----
    const before = await cuts(page);
    await page.eval("window.__ev.length = 0; true");
    await page.eval(`document.querySelector('#anList .an-item[data-start="${flash.start}"] .an-add').click()`);
    await waitFor(page, `BF.state.project.cuts.length === ${before.length + 1}`, 5000, 'corte criado');
    const afterOne = await cuts(page);
    const added = afterOne.find((c) => !before.some((b) => b.id === c.id));
    assert.deepEqual([added.status, added.origin, added.start, added.end], ['pending', 'auto', flash.start, flash.end]);
    assert.ok(added.relevance > 0.5 && added.reasons.includes('mudança de cena'));
    assert.equal(added.reviewedAt, null);
    const ev = await page.eval('window.__ev');
    assert.ok(ev.some(([n]) => n === 'cuts:changed'), 'cuts:changed emitido');
    assert.deepEqual(ev.filter(([n]) => n === 'decision').map(([, t]) => t), ['create'], 'um decision create');
    assert.equal(await page.eval("document.querySelectorAll('#anList .an-item').length"), 1, 'a adicionada sai da lista');
    assert.match(await text(page, '#anSummary'), /2 já nos cortes/);
    assert.equal(await page.eval("!!document.querySelector('#cuts .cut[data-id=\"" + added.id + "\"]')"), true, 'aparece na aba Cortes');
    step('adicionar uma: corte pendente origin auto com relevância e motivos; cuts:changed + decision create');

    // ---- adicionar todas (só sobrou uma: o botão some; reanalisa para ter várias) ----
    assert.equal(await page.eval("document.getElementById('anAddAll').hidden"), true, '"Adicionar todas" só aparece com 2 ou mais');
    await page.eval("window.__ev.length = 0; document.querySelector('#anList .an-item .an-add').click()");
    await waitFor(page, 'BF.state.project.cuts.length === 3', 5000);
    assert.match(await text(page, '#anEmpty'), /Todas as sugestões já estão nos cortes/);

    // ---- reanálise: do cache, nada duplica ----
    const cutsBefore = await cuts(page);
    await analyze(page, { expectCache: true });
    assert.equal(await page.eval("document.querySelectorAll('#anList .an-item').length"), 0, 'nada novo');
    assert.equal((await cuts(page)).length, cutsBefore.length, 'reanalisar não cria cortes');
    // outros parâmetros (sinais em cache, combinação recalculada): continua sem duplicar
    await setRange(page, 'anSensitivity', 5);
    await setRange(page, 'anPerHour', 20);
    await analyze(page, { expectCache: false });
    const reCuts = await cuts(page);
    assert.ok(reCuts.length >= cutsBefore.length);
    for (const c of reCuts.filter((c) => c.origin === 'auto')) {
      assert.equal(c.status, 'pending', 'auto nunca vem aprovado');
      for (const o of reCuts) if (o.id !== c.id) assert.ok(Math.min(c.end, o.end) - Math.max(c.start, o.start) < 0.5 * Math.min(c.end - c.start, o.end - o.start), `corte ${c.start}-${c.end} sobrepõe ${o.start}-${o.end}`);
    }
    assert.equal(reCuts.filter((c) => c.status === 'approved').length, 0, 'nenhum corte aprovado automaticamente');
    assert.equal(reCuts.find((c) => c.title === 'Já rejeitado').status, 'rejected');
    step('reanálise (cache e parâmetros novos): nada duplicado, rejeitado respeitado, nada aprovado');

    // ---- adicionar todas de verdade: remove 2 cortes auto e reanalisa; as sugestões voltam e entram juntas ----
    await page.eval(`BF.project.update((p) => { p.cuts = p.cuts.filter((c) => c.origin !== 'auto'); }, { reason: 'teste' }); BF.bus.emit('cuts:changed', {}); true`);
    await waitFor(page, "document.querySelectorAll('#anList .an-item').length >= 2", 5000, 'sugestões de volta após remover os cortes');
    assert.equal(await page.eval("document.getElementById('anAddAll').hidden"), false);
    assert.match(await text(page, '#anAddAll'), /^Adicionar todas \(\d+\)$/);
    const nBefore = (await cuts(page)).length;
    await page.eval("window.__ev.length = 0; document.getElementById('anAddAll').click()");
    await waitFor(page, "document.querySelectorAll('#anList .an-item').length === 0", 5000, 'lista vazia');
    const all = await cuts(page);
    const addedAll = all.length - nBefore;
    assert.ok(addedAll >= 2);
    const ev2 = await page.eval('window.__ev');
    assert.equal(ev2.filter(([n]) => n === 'cuts:changed').length, 1, 'um único cuts:changed no lote');
    assert.equal(ev2.filter(([n, t]) => n === 'decision' && t === 'create').length, addedAll, 'um decision create por corte');
    assert.ok(all.filter((c) => c.origin === 'auto').every((c) => c.status === 'pending' && c.reviewedAt === null), 'todos pendentes');
    assert.ok(/pendentes/.test(await page.eval("document.getElementById('toasts').textContent")), 'aviso de que ficaram pendentes');
    step(`adicionar todas: ${addedAll} cortes pendentes, 1 cuts:changed e ${addedAll} decision create`);

    // ---- cancelamento (vídeo longo) e confirmação ao abrir outro vídeo durante a análise ----
    await page.eval(`BF.openSource(${q(long)})`);
    await waitFor(page, `BF.state.project && BF.state.project.source.path.endsWith('longo.mp4')`, 20000, 'vídeo longo aberto');
    await page.eval("window.__done = 0; BF.on('analysis:done', () => { window.__done += 1; }); BF.on('analysis:failed', (e) => { window.__done += 1; window.__failed = e.code; }); true");
    await page.eval("document.getElementById('anRun').click()");
    await waitFor(page, "!document.getElementById('anCancel').hidden && !document.getElementById('anCancel').disabled", 15000, 'análise em andamento');
    const running = await page.eval("({ p: document.querySelector('.an-progress progress') !== null, bar: document.querySelector('.an-progress').hidden, run: document.getElementById('anRun').textContent, disabled: [...document.querySelectorAll('#analysis input:not([data-signal])')].every((i) => i.disabled) })");
    assert.deepEqual([running.bar, running.run, running.disabled], [false, 'Analisando…', true], 'barra visível, botão ocupado, ajustes travados');
    assert.equal(await page.eval("document.getElementById('tab-analysis').querySelector('.tab-badge').textContent"), '…');
    // tenta abrir o outro vídeo: pergunta; recusar mantém a análise
    if (await page.eval('window.__done === 0')) {
      await page.eval(`window.__open = BF.openSource(${q(live)}).then((r) => r.code || 'aberto'); true`);
      const asked = await answerModal(page, false);
      assert.match(asked.title, /Análise em andamento/);
      assert.equal(await page.eval('window.__open'), 'CANCELLED', 'abertura cancelada');
      assert.ok(await page.eval("BF.state.project.source.path.endsWith('longo.mp4')"), 'continua no vídeo longo');
    } else {
      step('(análise do vídeo longo terminou antes da confirmação; trecho da confirmação não exercitado nesta máquina)');
    }
    if (await page.eval('window.__done === 0')) {
      await page.eval("document.getElementById('anCancel').click()");
      await waitFor(page, 'window.__done >= 1', 30000, 'cancelamento');
      assert.equal(await page.eval('window.__failed'), 'CANCELLED');
      assert.match(await text(page, '#anNotice'), /Análise cancelada\. Nada foi alterado no projeto\./);
      assert.equal(await page.eval('BF.state.project.analysis.lastRun'), null, 'cancelar não grava resultado');
      assert.equal(await page.eval("document.getElementById('anResults').hidden"), true);
      assert.equal(await page.eval("document.getElementById('anRun').disabled"), false, 'liberado para tentar de novo');
      step('cancelamento: aviso claro, nenhum resultado gravado, botão liberado; abrir outro vídeo durante a análise pergunta antes');
    } else {
      step('(análise do vídeo longo terminou antes do cancelamento; cancelamento coberto por tests/analysis-media e analysis-ipc)');
    }
    await waitFor(page, "document.getElementById('anRun').textContent === 'Analisar'", 60000, 'interface ociosa');

    // ---- persistência ----
    await page.eval(`BF.openSource(${q(live)})`);
    await waitFor(page, "BF.state.project.source.path.endsWith('live.mp4')", 20000);
    await page.eval('BF.project.flush()');
    h.assertNoConsoleErrors(page);
    await app.stop();
    app = await h.launchApp(userData);
    page = app.page;
    await page.eval(`BF.openSource(${q(live)})`);
    await waitFor(page, "BF.state.project && BF.state.project.source.path.endsWith('live.mp4')", 20000);
    await page.eval("BF.ui.selectTab('analysis')");
    await waitFor(page, "document.getElementById('anSensitivity').value === '5'", 5000, 'sensibilidade restaurada');
    assert.equal(await page.eval("document.getElementById('anPerHour').value"), '20');
    assert.equal(await page.eval("document.getElementById('anResults').hidden"), false, 'resultado da última análise volta ao reabrir');
    assert.match(await text(page, '#anSummary'), /sugestão\(ões\) encontrada\(s\)/);
    const persisted = await cuts(page);
    assert.ok(persisted.filter((c) => c.origin === 'auto').length >= 2 && persisted.every((c) => c.status !== 'approved'));
    assert.ok(persisted.filter((c) => c.origin === 'auto').every((c) => c.relevance > 0 && c.reasons.length > 0), 'relevância e motivos persistem');
    step('após reiniciar: ajustes, resultado e cortes auto (pendentes, com motivos) preservados');

    // ---- projeto adotado para outro vídeo: o resultado do vídeo antigo não aparece como se fosse do novo ----
    const copy = path.join(tmp, 'live-copia.mp4');
    fs.copyFileSync(live, copy);
    await page.eval('BF.project.flush()');
    const adopted = await page.eval(`BF.api('project:adopt', { fromPath: ${q(live)}, path: ${q(copy)} }).then((r) => ({ ok: r.ok, code: r.code, message: r.message }))`);
    assert.equal(adopted.ok, true, adopted.message);
    await page.eval(`BF.openSource(${q(copy)})`);
    await waitFor(page, "BF.state.project && BF.state.project.source.path.endsWith('live-copia.mp4')", 20000, 'projeto adotado aberto');
    await page.eval("BF.ui.selectTab('analysis')");
    await waitFor(page, "!document.getElementById('tabpanel-analysis').hidden", 5000, 'aba Análise do projeto adotado');
    assert.equal(await page.eval("document.getElementById('anResults').hidden"), true, 'sugestões do vídeo antigo não aparecem no novo');
    assert.equal(await page.eval("document.getElementById('tab-analysis').querySelector('.tab-badge')?.textContent || ''"), '', 'nem no selo da aba');
    assert.equal(await page.eval("document.getElementById('anNotice').children.length"), 0);
    assert.equal(await page.eval("document.getElementById('anSensitivity').value"), '5', 'os ajustes acompanham a adoção');
    await page.eval(`BF.openSource(${q(live)})`);
    await waitFor(page, "BF.state.project && BF.state.project.source.path.endsWith('live.mp4')", 20000, 'vídeo original reaberto');
    await page.eval("BF.ui.selectTab('analysis')");
    await waitFor(page, "document.getElementById('anResults').hidden === false", 5000, 'o resultado do vídeo original continua lá');
    step('projeto adotado: o resultado do vídeo antigo não aparece no novo (ajustes sim); o original continua com o dele');

    // ---- sem chat / sem áudio: sinais ignorados com explicação ----
    await page.eval("BF.project.update((p) => { p.chat = null; }, { reason: 'teste' }); BF.bus.emit('project:changed', { reason: 'teste' }); BF.ui.selectTab('analysis'); true");
    await sleep(200);
    assert.equal(await page.eval("document.getElementById('anSignal-chat').disabled"), true);
    assert.match(await text(page, '#anHint-chat'), /sem chat baixado \(aba Novo projeto\): será ignorado/);

    if (process.env.BF_E2E_SHOTDIR) {
      fs.mkdirSync(process.env.BF_E2E_SHOTDIR, { recursive: true });
      await h.screenshot(page, path.join(process.env.BF_E2E_SHOTDIR, 'analysis.png'));
    }
    h.assertNoConsoleErrors(page);
    step('nenhum erro de console no app');
    console.log('\nE2E OK');
  } finally {
    await h.cleanupAll();
    h.removeDir(tmp);
  }
}

main().then(() => process.exit(0), (err) => {
  console.error(`\n✖ E2E FALHOU: ${err.stack || err.message}`);
  h.cleanupAll().finally(() => process.exit(1));
});

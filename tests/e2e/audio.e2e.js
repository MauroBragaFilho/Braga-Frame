'use strict';

/**
 * Teste de ponta a ponta da aba Áudio: abre o app Electron de verdade (perfil de usuário temporário), usa o
 * vídeo gerado pelo ffmpeg e confere, pela interface, os ajustes manuais por corte: ganho, mudo, fades,
 * histórico/desfazer/refazer/restaurar/voltar ao original, medição, avisos e a prévia com o GainNode
 * (níveis reais lidos de um AnalyserNode). Também confere que a fonte não muda (hash) e que a exportação
 * pelo filtro bate com a prévia e que a exportação pela fila de verdade (aba Exportar -> Fila) sai com o ajuste. Uso: node tests/e2e/audio.e2e.js
 * Para guardar capturas da janela: BF_E2E_SHOTDIR=C:\pasta node tests/e2e/audio.e2e.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { projectIdFor } = require('../../src/core/projects/projectStore');
const { buildAudioFilter } = require('../../src/core/audio/audioFilter');
const fx = require('../audio-fixtures');
const h = require('./helpers');

const { sleep, waitFor } = h;
const tools = fx.tools;

const q = (v) => JSON.stringify(v);
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: esperado ${expected} ±${tol}, obtido ${actual}`);
const step = (m) => console.log(`✔ ${m}`);

const setNum = (page, id, value, evt = 'change') => page.eval(`(() => { const e = document.getElementById(${q(id)}); e.value = ${q(String(value))}; e.dispatchEvent(new Event(${q(evt)}, { bubbles: true })); })()`);
const click = (page, id) => page.eval(`document.getElementById(${q(id)}).click()`);
const text = (page, selector) => page.eval(`(document.querySelector(${q(selector)}) || {}).textContent || ''`);
const visible = (page, selector) => page.eval(`(() => { const e = document.querySelector(${q(selector)}); return Boolean(e) && !e.hidden && e.getClientRects().length > 0; })()`);
const audioOf = (page, cutId) => page.eval(`JSON.parse(JSON.stringify(BF.project.cut(${q(cutId)}).audio))`);
const values = (a) => ({ gainDb: a.gainDb, mute: a.mute, fadeInSec: a.fadeInSec, fadeOutSec: a.fadeOutSec });
const notes = (page) => page.eval("[...document.querySelectorAll('#tabpanel-audio .audio-note')].map((n) => n.textContent)");
const historyLabels = (page) => page.eval("[...document.querySelectorAll('#tabpanel-audio .audio-history-list li .audio-h-label')].map((n) => n.textContent)");

/** Mediana de `n` leituras do nível (dBFS, RMS) do que está saindo do player. */
const levelNow = (page, n = 7, gapMs = 70) => page.eval(`(async () => {
  const out = [];
  for (let i = 0; i < ${n}; i++) { out.push(BF.audioPreview.level().rmsDb); await new Promise((r) => setTimeout(r, ${gapMs})); }
  out.sort((a, b) => a - b);
  return out[Math.floor(out.length / 2)];
})()`);

/** Tecla de verdade com Ctrl (e Shift) enviada ao elemento em foco, como o teclado faz. */
async function ctrlKey(page, key, { shift = false } = {}) {
  const letter = key.toUpperCase();
  const base = { key: shift ? letter : key, code: `Key${letter}`, windowsVirtualKeyCode: letter.charCodeAt(0), modifiers: 2 + (shift ? 8 : 0) };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** Aba Exportar: espera a conferência (QC) e o botão "Adicionar à fila (N)", clica e confere que foi para a aba Fila. */
async function enqueueFromExportTab(page, count = 1) {
  await page.eval("BF.ui.selectTab('export'); true");
  await waitFor(page, `(() => { const b = document.getElementById('exp-enqueue'); return !!b && !b.disabled && b.textContent === ${q(`Adicionar à fila (${count})`)} && /pronto/.test(document.getElementById('exp-qc-status').textContent); })()`, 60000, 'botão "Adicionar à fila" liberado depois da conferência');
  await page.eval("document.getElementById('exp-enqueue').click(); true");
  await waitFor(page, "document.getElementById('tab-queue').getAttribute('aria-selected') === 'true'", 20000, 'ir para a aba Fila');
}

const gainNow = (page) => page.eval('BF.audioPreview.state().gain');
const playing = (page) => page.eval("!document.getElementById('video').paused");

async function main() {
  assert.ok(tools.ffmpeg && tools.ffprobe, 'ffmpeg/ffprobe necessários para o teste');
  const tmp = h.mkTemp('e2e-audio');
  const userData = path.join(tmp, 'userdata');
  const media = path.join(tmp, 'gravacoes');
  fs.mkdirSync(media);
  const source = path.join(media, 'gameplay.mp4');
  const silent = path.join(media, 'sem-audio.mp4');
  const shot = async (page, name) => { if (process.env.BF_E2E_SHOTDIR) { fs.mkdirSync(process.env.BF_E2E_SHOTDIR, { recursive: true }); await h.screenshot(page, path.join(process.env.BF_E2E_SHOTDIR, `audio-${name}.png`)); } };

  try {
    // 40 s de vídeo com uma senoide de nível conhecido (pico perto de -8 dBFS) e outro vídeo sem faixa de áudio
    fx.makeVideo(source, { seconds: 40, volumeDb: 10, size: '320x180', rate: 15 });
    fx.makeVideo(silent, { seconds: 8, audio: false, size: '320x180', rate: 15 });
    const sourceHash = fx.sha256(source);
    const mediaListing = fs.readdirSync(media).sort();
    step('vídeos de teste gerados (com e sem áudio)');

    // o áudio do teste não deve sair nas caixas de som: --mute-audio silencia só a saída (o grafo continua processando)
    let app = await h.launchApp(userData, { args: ['--mute-audio'] });
    let page = app.page;
    await page.eval(`window.__decisions = []; BF.bus.on('decision', (d) => window.__decisions.push(JSON.parse(JSON.stringify(d)))); true`);

    // ---- sem projeto: a aba existe e fica desabilitada com dica ----
    assert.equal(await page.eval("document.getElementById('tab-audio').disabled"), true);
    assert.equal(await page.eval("document.getElementById('tab-audio').title"), 'Abra um vídeo para usar esta aba');
    assert.equal(await page.eval("typeof BF.audioPreview.state"), 'function');
    assert.equal((await page.eval('BF.audioPreview.state()')).usesGainNode, false, 'sem uso, o áudio do player não é tocado pelo grafo');
    step('sem projeto aberto a aba fica desabilitada e o áudio do player segue intocado');

    // ---- abrir o vídeo ----
    await page.eval(`BF.openSource(${q(source)})`);
    await waitFor(page, "BF.state.project && !document.getElementById('app').classList.contains('no-project') && document.getElementById('video').readyState >= 1", 20000, 'vídeo carregado');
    await waitFor(page, 'Boolean(window.BFAudioFilter && window.BFAudioHistory)', 10000, 'regras de áudio carregadas (CSP aceita o script do núcleo)');
    await page.eval("BF.ui.selectTab('audio')");
    assert.equal(await page.eval("document.getElementById('tabpanel-audio').hidden"), false);
    assert.equal(await visible(page, '#tabpanel-audio .audio-empty'), true);
    assert.match(await text(page, '#tabpanel-audio .audio-empty'), /ainda não tem cortes/);
    assert.equal(await visible(page, '#tabpanel-audio .audio-body'), false);
    step('aba Áudio: mensagem clara quando o projeto não tem cortes');

    // ---- cortes: um sem selecionar, depois escolhido pelo seletor da aba ----
    await page.eval(`(() => {
      BF.project.update((p) => {
        p.cuts.push(BF.model.newCut({ title: 'Clutch longo', start: 2, end: 32 }, { index: 0 }));
        p.cuts.push(BF.model.newCut({ title: 'Reação curta', start: 34, end: 38 }, { index: 1 }));
      }, { reason: 'teste' });
      BF.bus.emit('cuts:changed', {});
    })()`);
    await waitFor(page, "document.querySelectorAll('#audioCut option').length === 3", 5000, 'seletor de cortes');
    const [cutA, cutB] = await page.eval('BF.state.project.cuts.map((c) => c.id)');
    assert.equal(await visible(page, '#tabpanel-audio .audio-body'), false);
    assert.match(await text(page, '#tabpanel-audio .audio-empty'), /Escolha um corte/);
    assert.equal(await page.eval("document.getElementById('audioCut').value"), '');
    await page.eval(`(() => { const s = document.getElementById('audioCut'); s.value = ${q(cutA)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(page, "document.querySelector('#tabpanel-audio .audio-body') && !document.querySelector('#tabpanel-audio .audio-body').hidden", 5000, 'painel do corte');
    assert.match(await page.eval("document.getElementById('audioCut').selectedOptions[0].textContent"), /Clutch longo/);
    assert.match(await text(page, '#tabpanel-audio .audio-meta'), /Trecho de 0:02.0 a 0:32.0 · 30,0 s/);
    assert.equal(await page.eval("document.getElementById('inInput').value"), '0:02.0', 'a escolha também chega ao resto do app (cut:selected)');
    assert.equal(await page.eval("document.getElementById('audioGainNum').value"), '0');
    assert.equal(await visible(page, '.audio-same'), true, 'sem ajustes: Original e Ajustado soam iguais');
    assert.equal(await page.eval("document.getElementById('audioUndo').disabled && document.getElementById('audioRedo').disabled && document.getElementById('audioReset').disabled"), true);
    await shot(page, '1-sem-ajustes');
    step('sem corte selecionado a mensagem pede para escolher; escolher pelo seletor abre o painel (cut:selected)');

    // ---- medição real do trecho ----
    await waitFor(page, "/pico/.test(document.querySelector('#tabpanel-audio .audio-measure').textContent)", 20000, 'medição do trecho');
    const truth = await fx.measure(source, 2, 32);
    const measureText = await text(page, '#tabpanel-audio .audio-measure');
    const pt = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    assert.ok(measureText.includes(`pico ${pt(truth.peakDb)} dB`) && measureText.includes(`média ${pt(truth.meanDb)} dB`), `medição "${measureText}" deveria trazer pico ${truth.peakDb} e média ${truth.meanDb}`);
    assert.ok(truth.peakDb < -5 && truth.peakDb > -12, `a fonte de teste deveria ter pico perto de -8 dB (${truth.peakDb})`);
    assert.ok(!/com o ajuste/.test(measureText), 'sem ganho, não há "com o ajuste"');
    step(`medição do trecho na tela bate com o ffmpeg (pico ${truth.peakDb} dB, média ${truth.meanDb} dB)`);

    // ---- ganho: controle deslizante toca ao vivo e só grava ao soltar ----
    await page.eval(`(() => { const s = document.getElementById('audioGain'); s.value = '3.5'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.equal(await page.eval("document.getElementById('audioGainNum').value"), '3.5', 'o campo numérico acompanha o arrasto');
    assert.equal((await audioOf(page, cutA)).gainDb, 0, 'arrastando ainda não grava');
    assert.equal((await audioOf(page, cutA)).history.length, 0);
    await page.eval(`(() => { const s = document.getElementById('audioGain'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    let a = await audioOf(page, cutA);
    assert.equal(a.gainDb, 3.5);
    assert.equal(a.history.length, 1);
    assert.deepEqual(Object.keys(a.history[0]).sort(), ['after', 'at', 'before', 'label']);
    assert.equal(a.history[0].label, 'Ganho +3,5 dB');
    // número digitado: +6 dB (mexida contínua no mesmo campo vira uma entrada só)
    await setNum(page, 'audioGainNum', '6');
    a = await audioOf(page, cutA);
    assert.deepEqual(values(a), { gainDb: 6, mute: false, fadeInSec: 0, fadeOutSec: 0 });
    assert.equal(a.history.length, 1, 'mexidas seguidas no ganho viram uma entrada');
    assert.equal(a.history[0].label, 'Ganho +6 dB');
    assert.equal(await page.eval("document.getElementById('audioGain').value"), '6');
    assert.equal((await page.eval('__decisions')).filter((d) => d.type === 'adjust').length >= 2, true);
    const last = (await page.eval('__decisions')).filter((d) => d.type === 'adjust').pop();
    assert.deepEqual([last.cutId, last.scope, last.before.gainDb, last.after.gainDb], [cutA, 'audio', 3.5, 6]);
    step('ganho: arrastar toca ao vivo sem gravar; ao soltar/digitar grava em cut.audio e emite decision "adjust"');

    // ---- prévia: o áudio do player passa por um GainNode (Web Audio) ----
    const st = await page.eval('BF.audioPreview.state()');
    assert.equal(st.usesGainNode, true);
    assert.equal(st.videoVolume, 1, 'o volume do elemento não é usado para o ajuste');
    assert.equal(await page.eval("(() => { const n = BF.audioPreview.nodes(); return n.gain instanceof GainNode && n.source instanceof MediaElementAudioSourceNode && n.context instanceof AudioContext; })()"), true);
    assert.equal(await page.eval('BF.audioPreview.nodes().source.mediaElement === document.getElementById("video")'), true);

    // Original x Ajustado, ouvindo o trecho de verdade
    await click(page, 'audioModeOriginal');
    assert.equal(await page.eval("document.getElementById('audioModeOriginal').getAttribute('aria-pressed')"), 'true');
    await click(page, 'audioPlay');
    await waitFor(page, "!document.getElementById('video').paused && document.getElementById('video').currentTime > 3.2", 10000, 'prévia tocando');
    assert.equal(await text(page, '#audioPlay'), 'Parar');
    const original = await levelNow(page);
    near(await gainNow(page), 1, 0.001, 'Original: ganho 1');
    await click(page, 'audioModeAdjusted');
    await sleep(250);
    const adjusted = await levelNow(page);
    near(await gainNow(page), 10 ** (6 / 20), 0.01, 'Ajustado: ganho linear de +6 dB');
    near(adjusted - original, 6, 1.0, 'Ajustado soa 6 dB acima do Original');
    assert.ok(original > -30 && original < -5, `nível original plausível (${original})`);
    step(`prévia no GainNode: Original ${original.toFixed(1)} dB x Ajustado ${adjusted.toFixed(1)} dB (diferença ${(adjusted - original).toFixed(1)} dB, esperado +6)`);

    // aviso de possível distorção (não impeditivo), com a prévia tocando
    await setNum(page, 'audioGainNum', '9');
    const warn = (await notes(page)).find((n) => /distor/.test(n));
    assert.ok(warn, `esperava o aviso de distorção em ${JSON.stringify(await notes(page))}`);
    assert.match(warn, /acima de 0 dB/);
    assert.equal(await playing(page), true, 'o aviso não bloqueia nada');
    assert.equal((await audioOf(page, cutA)).gainDb, 9, 'e o app não corrige o valor sozinho');
    await setNum(page, 'audioGainNum', '4');
    assert.ok(!(await notes(page)).some((n) => /distor/.test(n)), 'o aviso some quando o ganho volta a um valor seguro');
    await sleep(150);
    near(await gainNow(page), 10 ** (4 / 20), 0.02, 'a prévia acompanha o ajuste enquanto toca');

    // mudo
    await click(page, 'audioMute');
    await sleep(250);
    assert.equal((await audioOf(page, cutA)).mute, true);
    assert.ok((await levelNow(page)) <= -100, 'mudo: silêncio de verdade na prévia');
    assert.equal(await gainNow(page), 0);
    assert.match(await text(page, '.audio-filter'), /^volume=0$/);
    await click(page, 'audioMute');
    await sleep(250);
    assert.ok((await levelNow(page)) > -30, 'sem mudo o som volta');
    await click(page, 'audioPlay'); // Parar
    await waitFor(page, "document.getElementById('video').paused", 5000, 'prévia parada');
    assert.equal(await text(page, '#audioPlay'), 'Ouvir trecho');
    step('prévia: aviso de distorção sem bloquear, mudo silencia de verdade, ganho acompanha o ajuste ao vivo');

    // ---- limites: o campo recusa o que passa do permitido e explica ----
    await setNum(page, 'audioGainNum', '99');
    assert.equal((await audioOf(page, cutA)).gainDb, 20);
    assert.match(await text(page, '.audio-flash'), /vai de -30 a \+20 dB/);
    await setNum(page, 'audioGainNum', 'abc');
    assert.equal((await audioOf(page, cutA)).gainDb, 20, 'texto inválido não altera nada');
    assert.match(await text(page, '.audio-flash'), /Digite o ganho em dB/);
    await sleep(1300); // passou a janela em que mexidas seguidas no mesmo campo viram uma entrada só
    await setNum(page, 'audioGainNum', '-2.5'); // (campo numérico: o navegador converte a vírgula digitada no formato do sistema)
    assert.equal((await audioOf(page, cutA)).gainDb, -2.5, 'ganho negativo fracionário');

    // ---- histórico: desfazer, refazer, restaurar, voltar ao original ----
    const histBefore = (await audioOf(page, cutA)).history.length;
    await click(page, 'audioUndo');
    assert.equal((await audioOf(page, cutA)).gainDb, 20, 'desfazer volta ao valor anterior');
    assert.equal(await text(page, '#log'), 'Desfeito: Ganho -2,5 dB.', 'a barra de status diz o que foi desfeito (e não o valor que acabou de sair)');
    assert.equal(await page.eval("document.getElementById('audioRedo').disabled"), false);
    await click(page, 'audioRedo');
    assert.equal((await audioOf(page, cutA)).gainDb, -2.5);
    assert.equal(await text(page, '#log'), 'Refeito: Ganho -2,5 dB.');
    assert.equal((await audioOf(page, cutA)).history.length, histBefore);
    await click(page, 'audioReset');
    a = await audioOf(page, cutA);
    assert.deepEqual(values(a), { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0 });
    assert.equal(a.history.at(-1).label, 'Voltar ao original');
    assert.equal((await historyLabels(page))[0], 'Voltar ao original', 'o histórico mostra a mudança mais nova primeiro');
    assert.equal(await page.eval("document.getElementById('audioReset').disabled"), true, 'já está no original');
    await click(page, 'audioUndo'); // desfaz o "voltar ao original"
    assert.equal((await audioOf(page, cutA)).gainDb, -2.5);
    // restaurar uma entrada antiga pelo histórico recolhido
    const oldest = (await audioOf(page, cutA)).history[0];
    await page.eval(`(() => { const items = document.querySelectorAll('#tabpanel-audio .audio-history-list li'); items[items.length - 1].querySelector('button').click(); })()`);
    a = await audioOf(page, cutA);
    assert.deepEqual(values(a), values(oldest.after), 'restaurar leva ao estado em que a entrada deixou o áudio');
    assert.match(a.history.at(-1).label, /^Restaurado: /);
    await click(page, 'audioUndo'); // a restauração também se desfaz
    assert.equal((await audioOf(page, cutA)).gainDb, -2.5);
    assert.match(await text(page, '#tabpanel-audio .audio-history > summary'), /^Histórico \(\d+\)$/);
    await shot(page, '2-historico');
    step('histórico: desfazer, refazer, voltar ao original (com desfazer) e restaurar uma entrada pelos botões');

    // o histórico guarda no máximo 50 entradas, mesmo com muita mexida (alternando campos para não juntar entradas)
    await page.eval(`(() => {
      const fire = (id, v) => { const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event('change', { bubbles: true })); };
      for (let i = 1; i <= 70; i++) { if (i % 2) fire('audioGainNum', (i % 20) + 1); else fire('audioFadeIn', (i % 9) / 10 + 0.1); }
    })()`);
    assert.equal((await audioOf(page, cutA)).history.length, 50);
    assert.equal(await page.eval("document.querySelectorAll('#tabpanel-audio .audio-history-list li').length"), 50);
    assert.equal(await text(page, '#tabpanel-audio .audio-history > summary'), 'Histórico (50)');
    step('histórico limitado a 50 entradas');

    // volta ao original neste corte para os próximos testes
    await click(page, 'audioReset');
    assert.deepEqual(values(await audioOf(page, cutA)), { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0 });

    // ---- Ctrl+Z / Ctrl+Y: na aba Áudio valem para o ajuste de áudio e não desfazem decisões da revisão às escondidas ----
    await page.eval("BF.ui.selectTab('cuts')");
    await waitFor(page, `!!document.querySelector('#cuts .cut[data-id="${cutA}"]')`, 10000, 'corte A na aba Cortes');
    await page.eval(`(() => { const li = document.querySelector('#cuts .cut[data-id="${cutA}"]'); [...li.querySelectorAll('button')].find((b) => b.textContent === 'Aprovar').click(); })()`);
    await waitFor(page, `BF.project.cut(${q(cutA)}).status === 'approved'`, 10000, 'corte A aprovado pela revisão');
    await page.eval(`BF.ui.selectTab('audio'); BF.bus.emit('cut:selected', { id: ${q(cutA)} }); true`);
    await waitFor(page, "/Clutch longo/.test(document.getElementById('audioCut').selectedOptions[0].textContent)", 5000, 'painel do corte A');
    await setNum(page, 'audioGainNum', '4');
    assert.equal((await audioOf(page, cutA)).gainDb, 4);
    await page.eval("document.getElementById('audioMute').focus(); true"); // foco num checkbox da aba (fora de campo de texto)
    await ctrlKey(page, 'z');
    await waitFor(page, `BF.project.cut(${q(cutA)}).audio.gainDb === 0`, 5000, 'Ctrl+Z desfazer o ganho');
    assert.equal(await page.eval(`BF.project.cut(${q(cutA)}).status`), 'approved', 'a decisão da revisão (aprovado) continua valendo');
    assert.equal(await text(page, '#log'), 'Desfeito: Ganho +4 dB.');
    await ctrlKey(page, 'y');
    await waitFor(page, `BF.project.cut(${q(cutA)}).audio.gainDb === 4`, 5000, 'Ctrl+Y refazer o ganho');
    await ctrlKey(page, 'z', { shift: true }); // nada a refazer: não desfaz nem refaz mais nada, em lugar nenhum
    await sleep(200);
    assert.equal(await text(page, '#log'), 'Nada para refazer no áudio deste corte.');
    assert.deepEqual([(await audioOf(page, cutA)).gainDb, await page.eval(`BF.project.cut(${q(cutA)}).status`)], [4, 'approved']);
    await ctrlKey(page, 'z');
    await waitFor(page, `BF.project.cut(${q(cutA)}).audio.gainDb === 0`, 5000, 'Ctrl+Z de novo');
    // de volta à aba Cortes o mesmo atalho é da revisão: desfaz a aprovação
    await page.eval("BF.ui.selectTab('cuts'); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); true");
    await ctrlKey(page, 'z');
    await waitFor(page, `BF.project.cut(${q(cutA)}).status === 'pending'`, 5000, 'Ctrl+Z na aba Cortes desfaz a aprovação');
    assert.equal((await audioOf(page, cutA)).gainDb, 0, 'e não mexe no áudio');
    await page.eval("BF.ui.selectTab('audio'); true");
    step('Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z: na aba Áudio desfazem o ajuste de áudio (a aprovação fica), na aba Cortes continuam sendo da revisão');

    // ---- fades: limite da metade, prévia com rampa de verdade e igual à exportação ----
    await page.eval(`BF.bus.emit('cut:selected', { id: ${q(cutB)} })`); // corte de 4 s: cada fade vai até 2 s
    await waitFor(page, "/Reação curta/.test(document.getElementById('audioCut').selectedOptions[0].textContent)", 5000, 'painel do corte B');
    assert.equal(await page.eval("document.getElementById('audioFadeIn').max"), '2');
    assert.match(await text(page, '.audio-hint'), /até 2,00 s \(metade do corte\)/);
    await setNum(page, 'audioFadeIn', '9');
    assert.equal((await audioOf(page, cutB)).fadeInSec, 2, 'o campo limita à metade do corte');
    assert.match(await text(page, '.audio-flash'), /limitado à metade do corte/);
    await setNum(page, 'audioFadeIn', '1.5');
    await setNum(page, 'audioFadeOut', '1.5');
    await setNum(page, 'audioGainNum', '6');
    const cutBAudio = await audioOf(page, cutB);
    assert.deepEqual(values(cutBAudio), { gainDb: 6, mute: false, fadeInSec: 1.5, fadeOutSec: 1.5 });
    assert.equal(await text(page, '.audio-filter'), 'volume=6dB,afade=t=in:st=0:d=1.5,afade=t=out:st=2.5:d=1.5');
    assert.equal(await text(page, '.audio-filter'), buildAudioFilter(cutBAudio, { duration: 4 }), 'a tela mostra o mesmo filtro que a exportação usa');
    await page.eval(`window.__s = []; window.__iv = setInterval(() => { const v = document.getElementById('video'); if (!v.paused) window.__s.push({ t: v.currentTime - 34, g: BF.audioPreview.state().gain, l: BF.audioPreview.level().rmsDb }); }, 30); true`);
    await click(page, 'audioModeAdjusted');
    await click(page, 'audioPlay');
    await waitFor(page, "window.__s.length > 5", 8000, 'prévia do corte B começou');
    await waitFor(page, "document.getElementById('video').paused", 12000, 'prévia do corte B terminou sozinha no fim do corte');
    await page.eval('clearInterval(window.__iv); true');
    const samples = await page.eval('window.__s');
    const lin = 10 ** (6 / 20);
    const at = (lo, hi) => samples.filter((s) => s.t >= lo && s.t <= hi);
    assert.ok(samples.length > 40, `amostras da prévia: ${samples.length}`);
    const g = (s) => s.g / lin;
    // fade in: 0 -> 1 entre 0 e 1,5 s (rampa linear, tolerância para o atraso do relógio de áudio)
    const rise = at(0.1, 1.4);
    assert.ok(rise.length > 10);
    for (const s of rise) near(g(s), s.t / 1.5, 0.3, `fade in em ${s.t.toFixed(2)} s`);
    assert.ok(g(rise[rise.length - 1]) > g(rise[0]) + 0.4, 'o ganho sobe durante o fade in');
    // platô
    const plateau = at(1.7, 2.3);
    assert.ok(plateau.length > 5);
    for (const s of plateau) near(g(s), 1, 0.06, `platô em ${s.t.toFixed(2)} s`);
    // fade out: 1 -> 0 entre 2,5 e 4 s
    const fall = at(2.7, 3.8);
    assert.ok(fall.length > 10);
    for (const s of fall) near(g(s), (4 - s.t) / 1.5, 0.3, `fade out em ${s.t.toFixed(2)} s`);
    assert.ok(g(fall[0]) > g(fall[fall.length - 1]) + 0.4, 'o ganho cai durante o fade out');
    // o som de verdade (analisador) acompanha o envelope
    const plateauLevel = plateau.map((s) => s.l).sort((x, y) => x - y)[Math.floor(plateau.length / 2)];
    const headLevel = Math.min(...at(0.05, 0.3).map((s) => s.l));
    const tailLevel = Math.min(...at(3.7, 4.2).map((s) => s.l));
    assert.ok(headLevel < plateauLevel - 8, `início do fade in bem abaixo do platô (${headLevel} x ${plateauLevel})`);
    assert.ok(tailLevel < plateauLevel - 8, `fim do fade out bem abaixo do platô (${tailLevel} x ${plateauLevel})`);
    step(`prévia dos fades: ganho sobe 0 -> 1 em 1,5 s, platô, desce até o fim; som medido: início ${headLevel.toFixed(0)} dB, platô ${plateauLevel.toFixed(0)} dB, fim ${tailLevel.toFixed(0)} dB`);
    await shot(page, '3-fades');

    // modo Original: nenhuma rampa, nenhum ganho — o trecho toca como está na fonte
    await click(page, 'audioModeOriginal');
    await page.eval(`window.__s = []; window.__iv = setInterval(() => { const v = document.getElementById('video'); if (!v.paused) window.__s.push({ t: v.currentTime - 34, g: BF.audioPreview.state().gain, l: BF.audioPreview.level().rmsDb }); }, 30); true`);
    await click(page, 'audioPlay');
    await waitFor(page, "window.__s.length > 40", 8000, 'prévia Original tocando');
    await page.eval('clearInterval(window.__iv); BF.player.pause(); true');
    const orig = await page.eval('window.__s');
    assert.ok(orig.every((s) => s.g === 1), 'Original: ganho sempre 1');
    const origHead = orig.filter((s) => s.t >= 0.2 && s.t < 0.6).map((s) => s.l).sort((x, y) => x - y);
    assert.ok(origHead.length > 5);
    near(origHead[Math.floor(origHead.length / 2)], plateauLevel - 6, 1.5, 'Original: o começo já tem o nível cheio da fonte (sem fade)');

    // a exportação pelo mesmo filtro dá o mesmo ganho que a prévia mostrou (+6 dB no platô)
    const exported = path.join(tmp, 'corte-b.wav');
    fx.exportAudio(source, exported, { start: 34, end: 38, filter: buildAudioFilter(cutBAudio, { duration: 4 }) });
    const srcPlateau = await fx.measure(source, 35.5, 36.5);
    const outPlateau = await fx.measure(exported, 1.5, 2.5);
    const outHead = await fx.measure(exported, 0, 0.2);
    near(outPlateau.meanDb - srcPlateau.meanDb, 6, 0.8, 'exportação: +6 dB no platô');
    assert.ok(outPlateau.meanDb - outHead.meanDb > 12, 'exportação: o início do fade in fica bem abaixo do platô');
    near(adjusted - original, outPlateau.meanDb - srcPlateau.meanDb, 1.5, 'prévia e exportação concordam no ganho');
    step('o mesmo filtro aplicado pelo ffmpeg confere com a prévia (+6 dB no platô, fade in no começo)');

    // ---- persistência: grava no projeto e volta igual depois de reiniciar ----
    await page.eval('BF.project.flush()');
    const projFile = path.join(userData, 'projects', `${projectIdFor(source)}.json`);
    const onDisk = JSON.parse(fs.readFileSync(projFile, 'utf8'));
    const diskB = onDisk.cuts.find((c) => c.id === cutB).audio;
    assert.deepEqual(values(diskB), values(cutBAudio));
    assert.equal(diskB.history.length, cutBAudio.history.length);
    assert.ok(diskB.history.every((e) => e.at && e.label && e.before && e.after));
    const savedBHistory = diskB.history.length;
    h.assertNoConsoleErrors(page);
    await app.stop();

    app = await h.launchApp(userData, { args: ['--mute-audio'] });
    page = app.page;
    await page.eval(`BF.openSource(${q(source)})`);
    await waitFor(page, "BF.state.project && BF.state.project.cuts.length === 2 && Boolean(window.BFAudioHistory)", 20000, 'projeto reaberto');
    await page.eval(`BF.ui.selectTab('audio'); BF.bus.emit('cut:selected', { id: ${q(cutB)} })`);
    await waitFor(page, "/Reação curta/.test(document.getElementById('audioCut').selectedOptions[0].textContent)", 5000, 'painel do corte B depois de reiniciar');
    assert.equal(await page.eval("document.getElementById('audioGainNum').value"), '6');
    assert.equal(await page.eval("document.getElementById('audioFadeIn').value"), '1.5');
    assert.equal(await page.eval("document.getElementById('audioFadeOut').value"), '1.5');
    assert.equal(await page.eval("document.querySelectorAll('#tabpanel-audio .audio-history-list li').length"), savedBHistory);
    assert.equal(await page.eval("document.getElementById('audioUndo').disabled"), false, 'o histórico sobrevive ao reinício');
    await click(page, 'audioUndo');
    assert.equal((await audioOf(page, cutB)).gainDb !== 6 || (await audioOf(page, cutB)).fadeOutSec !== 1.5, true, 'desfazer funciona depois de reiniciar');
    await click(page, 'audioRedo');
    assert.deepEqual(values(await audioOf(page, cutB)), values(cutBAudio));
    step('ajustes e histórico persistem no projeto e voltam iguais depois de reiniciar o app');

    // ---- exportação pelo fluxo REAL (aba Exportar -> Adicionar à fila -> aba Fila): o arquivo sai com o ajuste do corte ----
    const outDir = path.join(tmp, 'saida');
    await page.eval(`BF.project.update((p) => { p.exportDir = ${q(outDir)}; }, { reason: 'teste' }); BF.bus.emit('project:loaded', { project: BF.state.project, restored: true }); true`);
    await page.eval("BF.ui.selectTab('cuts'); true");
    await waitFor(page, `!!document.querySelector('#cuts .cut[data-id="${cutB}"]')`, 10000, 'corte B na aba Cortes');
    await page.eval(`(() => { const li = document.querySelector('#cuts .cut[data-id="${cutB}"]'); [...li.querySelectorAll('button')].find((b) => b.textContent === 'Aprovar').click(); })()`);
    await waitFor(page, `BF.project.cut(${q(cutB)}).status === 'approved'`, 10000, 'corte B aprovado');
    await page.eval("window.__done = []; BF.on('queue:jobDone', (e) => window.__done.push(e)); true");
    await enqueueFromExportTab(page);
    await waitFor(page, 'window.__done.length === 1', 180000, 'exportação concluída pela fila');
    const exportedFile = await page.eval('window.__done[0].output');
    assert.equal(path.dirname(path.resolve(exportedFile)).toLowerCase(), path.resolve(outDir).toLowerCase(), 'saiu na pasta escolhida');
    near(fx.duration(exportedFile), 4, 0.3, 'duração do arquivo exportado (corte de 4 s)');
    const srcPlateauQ = await fx.measure(source, 35.5, 36.5);
    const outPlateauQ = await fx.measure(exportedFile, 1.5, 2.5);
    const outHeadQ = await fx.measure(exportedFile, 0, 0.2);
    near(outPlateauQ.meanDb - srcPlateauQ.meanDb, 6, 0.8, 'arquivo exportado pela fila: +6 dB no platô');
    assert.ok(outPlateauQ.meanDb - outHeadQ.meanDb > 12, 'arquivo exportado pela fila: o início do fade in fica bem abaixo do platô');
    step(`exportado pela fila de verdade: platô ${(outPlateauQ.meanDb - srcPlateauQ.meanDb).toFixed(1)} dB acima da fonte e fade in no começo (medido no arquivo ${path.basename(exportedFile)})`);

    // desfazer e refazer não mudam o som: reenfileirar o mesmo corte não exporta de novo (a fila o reconhece como já feito)
    await page.eval(`BF.ui.selectTab('audio'); BF.bus.emit('cut:selected', { id: ${q(cutB)} }); true`);
    await waitFor(page, "/Reação curta/.test(document.getElementById('audioCut').selectedOptions[0].textContent)", 5000, 'painel do corte B para o desfazer');
    await setNum(page, 'audioGainNum', '8');
    await click(page, 'audioUndo');
    const afterUndo = await audioOf(page, cutB);
    assert.deepEqual(values(afterUndo), values(cutBAudio), 'voltou ao som que foi exportado');
    assert.equal(Array.isArray(afterUndo.redo) && afterUndo.redo.length, 1, 'e agora há uma entrada para refazer no cut.audio');
    await enqueueFromExportTab(page);
    await waitFor(page, "[...document.querySelectorAll('#tabpanel-queue li.q-job')].some((li) => li.dataset.state === 'skipped')", 30000, 'a fila marcar o corte como já exportado');
    assert.match(await page.eval("[...document.querySelectorAll('#tabpanel-queue li.q-job')].find((li) => li.dataset.state === 'skipped').textContent"), /Já exportado/);
    assert.equal(await page.eval("!!document.querySelector('.bf-modal')"), false, 'nenhum diálogo de conflito de nome');
    assert.deepEqual(fs.readdirSync(outDir), [path.basename(exportedFile)], 'nenhum arquivo repetido na pasta');
    step('desfazer e refazer não mudam a chave da fila: o mesmo som não é exportado duas vezes');

    // ---- medição por corte e prévia só com a aba à vista (fonte com dois níveis de volume: pico -38 dB e depois -18 dB) ----
    const twoLevel = path.join(tmp, 'dois-niveis.mp4'); // fora da pasta das gravações: não mexe na conferência de arquivos novos
    execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=40',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=40',
      '-af', "volume='if(lt(t,20),0.1,1)':eval=frame", '-c:a', 'aac', '-b:a', '192k',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-shortest', twoLevel], { windowsHide: true });
    await page.eval(`BF.openSource(${q(twoLevel)})`);
    await waitFor(page, `BF.state.project && BF.state.project.source.path === ${q(twoLevel)} && document.getElementById('video').readyState >= 1`, 30000, 'vídeo de dois níveis aberto');
    // conta os pedidos de medição e deixa a resposta de um trecho chegar tarde (como num trecho longo ou num disco lento)
    await page.eval(`(() => {
      window.__calls = []; window.__slow = null; window.__release = null; window.__lateDelivered = false;
      const real = BF.api;
      BF.api = function (channel, payload, opts) {
        const run = real.call(BF, channel, payload, opts);
        if (channel !== 'audio:measure') return run;
        window.__calls.push(payload);
        // a resposta deste trecho fica retida até o teste soltá-la (window.__release): a ordem dos acontecimentos é exata
        if (window.__slow !== null && payload.start === window.__slow) return run.then((r) => new Promise((resolve) => { window.__release = () => { window.__lateDelivered = true; resolve(r); }; }));
        return run;
      };
      BF.project.update((p) => {
        p.cuts.push(BF.model.newCut({ title: 'Alto', start: 22, end: 36 }, { index: 0 }));
        p.cuts.push(BF.model.newCut({ title: 'Baixo', start: 2, end: 16 }, { index: 1 }));
      }, { reason: 'teste' });
      BF.bus.emit('cuts:changed', {});
      return true;
    })()`);
    const [altoId, baixoId] = await page.eval('BF.state.project.cuts.map((c) => c.id)');
    const measureLineText = () => text(page, '#tabpanel-audio .audio-measure');

    // com a aba Cortes aberta, selecionar cortes e mexer nos tempos pelo resto do app não chama o ffmpeg
    await page.eval("BF.ui.selectTab('cuts'); true");
    for (const id of [altoId, baixoId, altoId]) {
      await page.eval(`BF.bus.emit('cut:selected', { id: ${q(id)} }); true`);
      await sleep(350);
    }
    for (let i = 0; i < 3; i += 1) {
      await page.eval(`BF.project.update((p) => { p.cuts[0].end += 0.5; }, { reason: 'review' }); BF.bus.emit('cuts:changed', { ids: [${q(altoId)}], from: 'review' }); true`);
      await sleep(350);
    }
    assert.equal(await page.eval('window.__calls.length'), 0, 'nenhuma medição enquanto a aba Áudio não está à vista');

    // um corte mudo, visto e tocado pela aba Cortes, soa como a fonte (o ajuste só vale na aba Áudio)
    await page.eval(`BF.ui.selectTab('audio'); BF.bus.emit('cut:selected', { id: ${q(baixoId)} }); true`);
    await waitFor(page, "!document.querySelector('#tabpanel-audio .audio-body').hidden && /Baixo/.test(document.getElementById('audioCut').selectedOptions[0].textContent)", 5000, 'painel do corte Baixo');
    await click(page, 'audioMute');
    await waitFor(page, `BF.project.cut(${q(baixoId)}).audio.mute === true`, 5000, 'mudo gravado');
    await page.eval("BF.ui.selectTab('cuts'); true");
    await page.eval(`BF.bus.emit('cut:selected', { id: ${q(baixoId)} }); BF.player.playRange(2, 16); true`);
    await waitFor(page, "!document.getElementById('video').paused && document.getElementById('video').currentTime > 3", 10000, 'corte mudo tocando pela aba Cortes');
    near(await gainNow(page), 1, 0.001, 'pela aba Cortes o ganho do player é 1');
    // espera por condição (com o computador saturado o som pode demorar a sair); se o ajuste mudo valesse aqui, o nível ficaria em -120 dB para sempre
    await waitFor(page, '(window.__lv = BF.audioPreview.level().rmsDb) > -60', 20000, 'pela aba Cortes o corte mudo tocar o áudio da fonte');
    const levelFromCuts = await page.eval('window.__lv');
    await page.eval("BF.ui.selectTab('audio'); true");
    await waitFor(page, 'BF.audioPreview.state().gain === 0', 5000, 'ao abrir a aba Áudio o corte mudo volta a soar mudo');
    await waitFor(page, 'BF.audioPreview.level().rmsDb <= -100', 5000, 'silêncio de verdade na aba Áudio');
    await page.eval('BF.player.pause(); true');
    await click(page, 'audioMute'); // desliga o mudo
    await waitFor(page, `BF.project.cut(${q(baixoId)}).audio.mute === false`, 5000, 'mudo desligado');
    step(`aba Cortes aberta: nenhuma medição (0 pedidos ao ffmpeg) e o corte mudo toca a fonte (${levelFromCuts.toFixed(0)} dB); na aba Áudio ele soa mudo`);

    // a medição de um corte nunca aparece no outro (resposta atrasada, volta ao cache e troca de corte)
    const altoCut = await page.eval(`({ start: BF.project.cut(${q(altoId)}).start, end: BF.project.cut(${q(altoId)}).end })`);
    const truthAlto = await fx.measure(twoLevel, altoCut.start, altoCut.end);
    const truthOutro = await fx.measure(twoLevel, 5, 19);
    assert.ok(truthAlto.peakDb - truthOutro.peakDb > 15, 'os dois trechos têm volumes bem diferentes');
    const ptDbText = (n) => `pico ${n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} dB`;
    await page.eval("BF.project.update((p) => { p.cuts.push(BF.model.newCut({ title: 'Outro baixo', start: 5, end: 19 }, { index: 2 })); }, { reason: 'teste' }); BF.bus.emit('cuts:changed', {}); true");
    const outroId = await page.eval("BF.state.project.cuts.find((c) => c.title === 'Outro baixo').id");
    await page.eval(`BF.bus.emit('cut:selected', { id: ${q(altoId)} }); true`);
    await waitFor(page, `document.querySelector('#tabpanel-audio .audio-measure').textContent.includes(${q(ptDbText(truthAlto.peakDb))})`, 20000, 'medição do corte Alto na tela');
    await page.eval('window.__slow = 5; window.__release = null; window.__lateDelivered = false; true');
    const lineRightAfterSwitch = await page.eval(`(() => { BF.bus.emit('cut:selected', { id: ${q(outroId)} }); return document.querySelector('#tabpanel-audio .audio-measure').textContent; })()`);
    assert.equal(lineRightAfterSwitch, 'Medindo o trecho…', 'ao trocar de corte, a medição do anterior sai da tela na hora');
    await waitFor(page, "window.__calls.some((c) => c.start === 5) && typeof window.__release === 'function'", 15000, 'a medição do corte Outro baixo terminar no ffmpeg (resposta retida pelo teste)');
    await page.eval(`BF.bus.emit('cut:selected', { id: ${q(altoId)} }); true`); // volta ao Alto (vem do cache) com a resposta do outro ainda a caminho
    await waitFor(page, `document.querySelector('#tabpanel-audio .audio-measure').textContent.includes(${q(ptDbText(truthAlto.peakDb))})`, 5000, 'Alto de volta, vindo do cache');
    await page.eval('window.__release(); true'); // só agora a resposta do Outro baixo chega à aba, com o Alto na tela
    await waitFor(page, 'window.__lateDelivered === true', 5000, 'a resposta atrasada chegar à aba');
    await sleep(500);
    assert.ok((await measureLineText()).includes(ptDbText(truthAlto.peakDb)), `o Alto continua com a medição DELE depois da resposta atrasada ("${await measureLineText()}")`);
    await page.eval(`BF.bus.emit('cut:selected', { id: ${q(outroId)} }); true`);
    await waitFor(page, `document.querySelector('#tabpanel-audio .audio-measure').textContent.includes(${q(ptDbText(truthOutro.peakDb))})`, 5000, 'Outro baixo com a medição certa (guardada quando a resposta chegou)');
    step(`medição por corte: Alto ${truthAlto.peakDb} dB e Outro baixo ${truthOutro.peakDb} dB não se misturam, mesmo com a resposta de um chegando atrasada`);

    // ---- fonte sem faixa de áudio: aviso, não erro ----
    await page.eval(`BF.openSource(${q(silent)})`);
    await waitFor(page, `BF.state.project && BF.state.project.source.path === ${q(silent)}`, 20000, 'vídeo sem áudio aberto');
    await page.eval("BF.project.addCut({ start: 1, end: 5 }); true");
    await waitFor(page, "/não tem faixa de áudio/.test(document.querySelector('#tabpanel-audio .audio-notes').textContent)", 10000, 'aviso de fonte sem áudio');
    assert.equal(await page.eval("document.getElementById('audioGainNum').disabled"), false, 'aviso não é bloqueio: os campos continuam livres');
    assert.equal(await visible(page, '#tabpanel-audio .audio-notes .warn'), true);
    await shot(page, '4-sem-audio');
    step('fonte sem faixa de áudio: aviso claro (não impeditivo)');

    // ---- nada foi escrito na fonte nem ao lado dela ----
    assert.equal(fx.sha256(source), sourceHash, 'a fonte continua idêntica (hash)');
    assert.deepEqual(fs.readdirSync(media).sort(), mediaListing, 'nenhum arquivo novo ao lado das fontes');

    h.assertNoConsoleErrors(page);
    step('nenhum erro de console no app (Runtime, Log e exceções)');
    await app.stop();
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

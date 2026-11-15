'use strict';

/**
 * E2E dos layouts do canal na aba Exportar: abre o app Electron de verdade (perfil de usuário temporário, vídeos gerados com o ffmpeg) e confere
 *  - o interruptor "Usar o enquadramento sugerido pela análise" (ligado por padrão, guardado no projeto) e a frase com quantos cortes têm layout sugerido;
 *  - o chip de origem em cada corte ('sugerido: Jogo', 'escolhido: Conversa', 'personalizado', 'padrão') e de quem sugeriu (palpite da IA);
 *  - a prévia REAL do layout (Jogo = câmera em cima, jogo embaixo; Conversa = recorte no rosto) pelo mesmo filtro da exportação;
 *  - trocar o layout de um corte (Conversa | Jogo | Padrão), personalizar sem alterar preset nem perfil e "Restaurar para o sugerido";
 *  - a ação em lote "Definir layout dos cortes selecionados";
 *  - "Layouts do canal": os dois presets editáveis com prévia, "deste projeto", voltar ao padrão e salvar como padrão do canal (novos projetos do canal herdam);
 *  - os Jobs enviados à fila (origem em framingSource) e o aviso do QC quando a câmera sai da fonte;
 *  - o detector local: quadros de referência pelo player, detecção por imagem (vence o palpite da IA), referências mudadas = detecção desatualizada;
 *  - nenhum erro de console. Capturas 1360x840 nos temas escuro e claro (BF_E2E_SHOTDIR=<pasta>).
 * Uso: node tests/e2e/export-layout.e2e.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const fx = require('../export-fixtures');

const { sleep, waitFor, answerModal } = h;
const { tools } = fx;
const step = (m) => console.log(`✔ ${m}`);
const J = JSON.stringify;
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: obtido ${Number(actual).toFixed(1)}, esperado ${expected} (±${tol})`);

async function main() {
  assert.ok(tools.ffmpeg && tools.ffprobe, 'ffmpeg/ffprobe necessários para o teste');
  const tmp = h.mkTemp('e2e-export-layout');
  const userData = path.join(tmp, 'userdata');
  const coded = path.join(tmp, 'gameplay.mp4');
  const layouts = path.join(tmp, 'layouts.mp4');
  const shots = process.env.BF_E2E_SHOTDIR;
  if (shots) fs.mkdirSync(shots, { recursive: true });

  try {
    fx.makeCodedSource(coded, { width: 1920, height: 1080, fps: 10, seconds: 20 });
    const lay = fx.makeLayoutSource(layouts);
    step('vídeos de teste gerados (fonte codificada por posição e vídeo com dois layouts de verdade)');

    const app = await h.launchApp(userData);
    const page = app.page;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 840, deviceScaleFactor: 1, mobile: false });
    const ev = (expr) => page.eval(expr);
    const q = (sel) => `document.querySelector(${J(sel)})`;
    const click = (sel) => ev(`${q(sel)}.click()`);
    const text = (sel) => ev(`(${q(sel)} || { textContent: '' }).textContent`);
    const setRange = (id, value) => ev(`(() => { const e = document.getElementById(${J(id)}); e.value = ${J(String(value))}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const setSelect = (id, value) => ev(`(() => { const e = document.getElementById(${J(id)}); e.value = ${J(String(value))}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const previewSig = () => ev("document.getElementById('exp-prev-img').getAttribute('src') || ''");
    const pixels = (sel, fx0, fy0, r = 2) => ev(`(() => {
      const img = ${q(sel)}; const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const x = Math.round(${fx0} * (c.width - 1)); const y = Math.round(${fy0} * (c.height - 1));
      const d = g.getImageData(Math.max(0, x - ${r}), Math.max(0, y - ${r}), ${2 * r + 1}, ${2 * r + 1}).data; let s = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; }
      const n = d.length / 4; return s.map((v) => v / n);
    })()`);
    let previews = 0;
    const nextPreview = async (before) => { previews += 1; await waitFor(page, `(document.getElementById('exp-prev-img').getAttribute('src') || '') !== ${J(before)}`, 25000, `nova prévia (#${previews})`); await sleep(150); return previewSig(); };
    const change = async (fn) => { const before = await previewSig(); await fn(); return nextPreview(before); };
    const waitPreview = (what = 'prévia') => waitFor(page, "(document.getElementById('exp-prev-img').getAttribute('src') || '').startsWith('data:image/png') && !document.querySelector('.exp-stage').classList.contains('is-loading')", 25000, what);
    const waitQc = (re) => waitFor(page, `${re}.test(document.getElementById('exp-qc-status').textContent)`, 25000, `conferência ${re}`);
    const project = () => ev('JSON.parse(JSON.stringify(BF.state.project))');
    const cutRow = (id) => `#exp-cuts li[data-id="${id}"]`;
    const origin = (id) => ev(`(() => { const c = document.querySelector(${J(`${cutRow(id)} .exp-origin`)}); return c ? [c.dataset.origin, c.textContent, c.dataset.layout] : null; })()`);
    const sub = (id) => text(`${cutRow(id)} .exp-cut-sub`);
    const toast = () => ev("document.getElementById('toasts').textContent");
    const pick = (id) => click(`${cutRow(id)} .exp-cut-main`);
    // os avisos (toasts) do teste ficam por cima da tela: nas capturas só aparece a interface
    const shot = async (name) => { if (shots) { await ev("document.getElementById('toasts').replaceChildren(); true"); await sleep(250); await h.screenshot(page, path.join(shots, name)); } };
    const scrollTo = (sel) => ev(`${q(sel)}.scrollIntoView({ block: 'start' }); true`);
    // intercepta o envio à fila e o pedido de conferência (para ler os Jobs e os layouts enviados pela aba)
    await ev(`(() => {
      window.__enq = []; window.__prep = []; window.__enqReply = { ok: true, jobs: [] };
      const original = BF.api.bind(BF);
      BF.api = async (channel, payload, opts) => {
        if (channel === 'queue:enqueue') { window.__enq.push(JSON.parse(JSON.stringify(payload))); return window.__enqReply; }
        if (channel === 'export:prepare') window.__prep.push(JSON.parse(JSON.stringify(payload)));
        return original(channel, payload, opts);
      };
    })()`);

    // ---------- projeto com cortes: dois com layout da análise, um manual e um pendente ----------
    await ev(`BF.openSource(${J(coded)})`);
    await waitFor(page, "BF.state.project && !document.getElementById('app').classList.contains('no-project')", 20000, 'projeto aberto');
    await ev(`(() => {
      const mk = (fields, status) => { const c = BF.project.addCut(fields); if (status) BF.project.update(() => { c.status = status; }, { reason: 'teste' }); return c.id; };
      window.__ids = [
        mk({ title: 'Jogo da IA', start: 2, end: 6, layout: 'jogo' }, 'approved'),
        mk({ title: 'Conversa da IA', start: 8, end: 12, layout: 'conversa' }, 'approved'),
        mk({ title: 'Manual', start: 13, end: 16 }, 'approved'),
        mk({ title: 'Pendente', start: 17, end: 19, layout: 'jogo' }, null)
      ];
      BF.bus.emit('cuts:changed', {});
    })()`);
    const [c1, c2, c3, c4] = await ev('window.__ids');
    await ev("BF.ui.selectTab('export')");
    await waitFor(page, "document.querySelectorAll('#exp-profile option').length >= 12", 15000, 'perfis carregados');
    await waitPreview();

    // ---------- interruptor e chips de origem ----------
    assert.equal(await ev("document.getElementById('exp-suggest').checked"), true, 'ligado por padrão');
    assert.equal(await ev("document.getElementById('exp-suggest').getAttribute('role')"), 'switch');
    assert.match(await text('#exp-suggest-label'), /Usar o enquadramento sugerido pela análise/);
    assert.match(await text('#exp-suggest-note'), /3 de 4 cortes têm layout sugerido \(3 pela IA\).*palpite da IA vem só do texto: ela não vê a imagem/);
    assert.deepEqual((await origin(c1)).slice(0, 2), ['suggested', 'sugerido: Jogo']);
    assert.deepEqual((await origin(c2)).slice(0, 2), ['suggested', 'sugerido: Conversa']);
    assert.deepEqual((await origin(c3)).slice(0, 2), ['default', 'padrão'], 'corte manual sem layout segue o padrão');
    assert.deepEqual((await origin(c4)).slice(0, 2), ['suggested', 'sugerido: Jogo']);
    assert.match(await sub(c1), /palpite da IA/, 'o palpite da IA é marcado como tal');
    assert.doesNotMatch(await sub(c3), /palpite/);
    assert.equal(await ev("document.querySelectorAll('#exp-cuts .exp-badge').length"), 0, 'nenhum corte personalizado ainda');
    assert.equal(await ev("document.getElementById('exp-layouts').open"), false, 'Layouts do canal começam recolhidos');
    assert.equal(await ev("document.getElementById('exp-detect').open"), false);
    assert.equal(await ev("document.getElementById('exp-cut-layout').hidden"), true, 'o seletor de layout só aparece com um corte escolhido');
    // o interruptor e a escolha moram no projeto
    assert.equal(await ev('BF.state.project.ext && BF.state.project.ext.export && BF.state.project.ext.export.useSuggestedLayout'), undefined, 'sem escolha do usuário, nada gravado (vale o padrão: ligado)');
    step('interruptor ligado por padrão, chips de origem em cada corte e o palpite da IA marcado como palpite');

    // ---------- prévia real do layout de cada corte ----------
    await change(() => pick(c1));
    await waitFor(page, "/Só o corte 01/.test(document.querySelector('.exp-target').textContent)", 5000, 'alvo = corte 01');
    assert.equal(await ev("document.getElementById('exp-cut-layout').hidden"), false);
    assert.equal(await ev("document.querySelector('#exp-cut-layout [data-layout=jogo]').getAttribute('aria-pressed')"), 'true');
    assert.match(await text('#exp-origin-note'), /Layout Jogo sugerido: palpite da IA: ela só lê o texto, não vê a imagem\./);
    await waitFor(page, "document.querySelector('#tabpanel-export [data-mode=stack]').getAttribute('aria-pressed') === 'true'", 10000, 'modo webcam + jogo pelo layout');
    await sleep(300);
    // faixa de cima = a câmera (canto superior esquerdo da fonte: R de 0 a 78, G de 0 a 77); faixa de baixo = o jogo logo depois da câmera
    const camTop = await pixels('#exp-prev-img', 0.5, 0.05);
    near(camTop[0], 39, 14, 'câmera: R no meio da faixa');
    near(camTop[1], 13, 14, 'câmera: G perto do topo');
    const gameMid = await pixels('#exp-prev-img', 0.5, 0.65);
    near(gameMid[0], 137, 14, 'jogo: R no meio da faixa (de 31% a 77% da largura da fonte)');
    near(gameMid[1], 126, 14, 'jogo: G no meio da altura');
    near((await pixels('#exp-prev-img', 0.02, 0.8))[0], 255 * 0.306, 14, 'jogo: começa logo depois da câmera');
    await shot('export-layouts-0-jogo.png');
    await change(() => pick(c2));
    await waitFor(page, "/Só o corte 02/.test(document.querySelector('.exp-target').textContent)", 5000);
    await waitFor(page, "document.querySelector('#tabpanel-export [data-mode=center]').getAttribute('aria-pressed') === 'true'", 10000);
    await sleep(300);
    near((await pixels('#exp-prev-img', 0.5, 0.5))[0], 255 * (0.63 * (1 - 1080 / 1920 / (1920 / 1080)) + 1080 / 1920 / (1920 / 1080) / 2), 14, 'conversa: janela no rosto (foco 0,63)');
    near((await pixels('#exp-prev-img', 0.5, 0.5))[1], 127, 14, 'conversa: altura toda');
    step('prévia real: Jogo = câmera em cima e jogo embaixo; Conversa = recorte vertical no rosto (o mesmo filtro da exportação)');

    // ---------- interruptor desligado: as sugestões deixam de valer ----------
    await click('#exp-suggest');
    await waitFor(page, 'BF.state.project.ext.export.useSuggestedLayout === false', 5000, 'interruptor gravado no projeto');
    for (const id of [c1, c2, c3, c4]) assert.deepEqual((await origin(id)).slice(0, 2), ['default', 'padrão'], 'sem o interruptor tudo segue o padrão');
    assert.match(await text('#exp-suggest-note'), /3 de 4 cortes têm layout sugerido/, 'a frase continua dizendo o que existe');
    await pick(c1);
    await waitFor(page, "/Só o corte 01/.test(document.querySelector('.exp-target').textContent)", 5000);
    assert.match(await text('#exp-origin-note'), /A análise sugeriu Jogo, mas "Usar o enquadramento sugerido pela análise" está desligado: vale o padrão do projeto\./);
    await waitFor(page, "document.querySelector('#tabpanel-export [data-mode=center]').getAttribute('aria-pressed') === 'true'", 10000);
    await click('#exp-suggest');
    await waitFor(page, 'BF.state.project.ext.export.useSuggestedLayout === true', 5000);
    assert.deepEqual((await origin(c1)).slice(0, 2), ['suggested', 'sugerido: Jogo']);
    step('desligar o interruptor devolve todos os cortes ao padrão; ligar de novo restaura as sugestões');

    // ---------- trocar o layout de um corte (Conversa | Jogo | Padrão) e restaurar ----------
    const profileBefore = await ev('JSON.stringify([BF.state.project.ext.export.overrides || null, BF.state.project.profileId])');
    await pick(c3);
    await waitFor(page, "/Só o corte 03/.test(document.querySelector('.exp-target').textContent)", 5000);
    assert.match(await text('#exp-origin-note'), /Sem layout sugerido: vale o padrão do projeto\./);
    await click('#exp-cut-layout [data-layout=jogo]');
    await waitFor(page, `BF.project.cut(${J(c3)}).layoutChoice === 'jogo'`, 5000, 'escolha gravada no corte');
    assert.deepEqual((await origin(c3)).slice(0, 3), ['chosen', 'escolhido: Jogo', 'jogo']);
    assert.match(await text('#exp-origin-note'), /Layout Jogo escolhido por você\./);
    assert.equal(await ev("document.getElementById('exp-restore').hidden"), false);
    assert.equal(await text('#exp-restore'), 'Restaurar padrão', 'sem sugestão, restaurar volta ao padrão');
    await waitFor(page, "document.querySelector('#tabpanel-export [data-mode=stack]').getAttribute('aria-pressed') === 'true'", 10000);
    await click('#exp-restore');
    await waitFor(page, `BF.project.cut(${J(c3)}).layoutChoice === undefined`, 5000, 'escolha removida');
    assert.deepEqual((await origin(c3)).slice(0, 2), ['default', 'padrão']);

    await pick(c1);
    await waitFor(page, "/Só o corte 01/.test(document.querySelector('.exp-target').textContent)", 5000);
    await click('#exp-cut-layout [data-layout=padrao]');
    await waitFor(page, `BF.project.cut(${J(c1)}).layoutChoice === 'padrao'`, 5000);
    assert.deepEqual((await origin(c1)).slice(0, 2), ['default', 'padrão']);
    assert.match(await text('#exp-origin-note'), /Você escolheu o padrão para este corte\. A análise sugeria Jogo\./);
    await click('#exp-cut-layout [data-layout=conversa]');
    await waitFor(page, `BF.project.cut(${J(c1)}).layoutChoice === 'conversa'`, 5000);
    assert.deepEqual((await origin(c1)).slice(0, 2), ['chosen', 'escolhido: Conversa']);
    assert.match(await text('#exp-origin-note'), /Layout Conversa escolhido por você\. A análise sugeria Jogo\./);
    assert.equal(await text('#exp-restore'), 'Restaurar para o sugerido');
    // escolher o que a análise sugere só tira a escolha: o corte volta a seguir a sugestão
    await click('#exp-cut-layout [data-layout=jogo]');
    await waitFor(page, `BF.project.cut(${J(c1)}).layoutChoice === undefined`, 5000, 'voltou à sugestão');
    assert.deepEqual((await origin(c1)).slice(0, 2), ['suggested', 'sugerido: Jogo']);
    step('trocar o layout do corte (Conversa, Jogo, Padrão) e voltar ao sugerido, sem mexer no perfil');

    // ---------- personalizar um corte sem alterar preset nem perfil ----------
    await pick(c2);
    await waitFor(page, "/Só o corte 02/.test(document.querySelector('.exp-target').textContent)", 5000);
    await change(() => setRange('exp-focusx', 20));
    await waitFor(page, `BF.project.cut(${J(c2)}).framing && BF.project.cut(${J(c2)}).framing.focusX === 0.2`, 5000, 'ajuste gravado só no corte');
    assert.deepEqual((await origin(c2)).slice(0, 2), ['custom', 'personalizado']);
    assert.equal(await ev(`!!document.querySelector(${J(`${cutRow(c2)} .exp-badge`)})`), true, 'marca de personalizado');
    assert.match(await text('#exp-origin-note'), /Enquadramento personalizado só deste corte\. Parte do layout Conversa \(palpite da IA/);
    near((await pixels('#exp-prev-img', 0.5, 0.5))[0], 255 * (0.2 * (1 - 0.3164) + 0.3164 / 2), 14, 'a prévia segue o ajuste do corte');
    const afterEdit = await project();
    assert.equal(afterEdit.ext.export.layouts, undefined, 'o preset de Conversa não foi alterado pelo ajuste do corte');
    assert.equal(afterEdit.ext.export.framing, undefined, 'nem o padrão do projeto');
    assert.equal(await ev('JSON.stringify([BF.state.project.ext.export.overrides || null, BF.state.project.profileId])'), profileBefore, 'nem o perfil');
    assert.equal(afterEdit.cuts.find((c) => c.id === c1).framing, null, 'os outros cortes ficaram como estavam');
    assert.equal(await text('#exp-restore'), 'Restaurar para o sugerido');
    await click('#exp-restore');
    await waitFor(page, `BF.project.cut(${J(c2)}).framing === null`, 5000, 'corte restaurado');
    assert.deepEqual((await origin(c2)).slice(0, 2), ['suggested', 'sugerido: Conversa']);
    step('personalizar um corte muda só ele (chip "personalizado"); "Restaurar para o sugerido" devolve o layout');

    // ---------- ação em lote: Definir layout dos cortes selecionados ----------
    assert.equal(await ev("document.getElementById('exp-bulk-layout').disabled"), false);
    assert.equal(await ev("document.getElementById('exp-bulk-layout').getAttribute('aria-label')"), 'Definir layout dos cortes selecionados');
    assert.deepEqual(await ev("[...document.querySelectorAll('#exp-cuts input')].map((i) => i.checked)"), [true, true, true, false], 'aprovados marcados; o pendente não');
    await setSelect('exp-bulk-layout', 'conversa');
    await waitFor(page, `BF.project.cut(${J(c1)}).layoutChoice === 'conversa' && BF.project.cut(${J(c3)}).layoutChoice === 'conversa'`, 5000, 'layout definido nos selecionados');
    assert.equal(await ev(`BF.project.cut(${J(c2)}).layoutChoice`), undefined, 'o corte 02 já era Conversa pela sugestão: não ganha escolha');
    assert.equal(await ev(`BF.project.cut(${J(c4)}).layoutChoice`), undefined, 'o pendente (não selecionado) não muda');
    assert.deepEqual((await origin(c1)).slice(0, 2), ['chosen', 'escolhido: Conversa']);
    assert.deepEqual((await origin(c2)).slice(0, 2), ['suggested', 'sugerido: Conversa']);
    assert.deepEqual((await origin(c3)).slice(0, 2), ['chosen', 'escolhido: Conversa']);
    assert.deepEqual((await origin(c4)).slice(0, 2), ['suggested', 'sugerido: Jogo']);
    assert.match(await toast(), /2 cortes agora usam o layout Conversa\./);
    assert.equal(await ev("document.getElementById('exp-bulk-layout').value"), '', 'o seletor volta ao título');
    await setSelect('exp-bulk-layout', 'jogo');
    await waitFor(page, `BF.project.cut(${J(c1)}).layoutChoice === undefined && BF.project.cut(${J(c2)}).layoutChoice === 'jogo' && BF.project.cut(${J(c3)}).layoutChoice === 'jogo'`, 5000, 'layout Jogo nos selecionados');
    assert.deepEqual((await origin(c1)).slice(0, 2), ['suggested', 'sugerido: Jogo'], 'o corte 01 volta a seguir a sugestão (Jogo)');
    await setSelect('exp-bulk-layout', 'padrao');
    await waitFor(page, `BF.project.cut(${J(c1)}).layoutChoice === 'padrao' && BF.project.cut(${J(c2)}).layoutChoice === 'padrao' && BF.project.cut(${J(c3)}).layoutChoice === undefined`, 5000, 'padrão nos selecionados');
    assert.deepEqual((await origin(c3)).slice(0, 2), ['default', 'padrão']);
    // voltar ao sugerido: sem ajustes próprios não pergunta nada; com ajuste próprio pede confirmação antes de descartar
    await setSelect('exp-bulk-layout', 'sugerido');
    await waitFor(page, `BF.project.cut(${J(c1)}).layoutChoice === undefined && BF.project.cut(${J(c2)}).layoutChoice === undefined`, 5000, 'voltou ao sugerido');
    assert.equal(await h.modalOpen(page), false, 'sem enquadramento próprio não há o que confirmar');
    assert.deepEqual((await origin(c1)).slice(0, 2), ['suggested', 'sugerido: Jogo']);
    assert.deepEqual((await origin(c2)).slice(0, 2), ['suggested', 'sugerido: Conversa']);
    await ev(`BF.project.update(() => { BF.project.cut(${J(c2)}).framing = { zoom: 1.4 }; }, { reason: 'teste' }); BF.bus.emit('cuts:changed', { ids: [${J(c2)}] })`);
    await waitFor(page, `!!document.querySelector(${J(`${cutRow(c2)} .exp-badge`)})`, 5000, 'corte 02 personalizado');
    ev("(() => { const s = document.getElementById('exp-bulk-layout'); s.value = 'sugerido'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    const asked = await answerModal(page, false);
    assert.equal(asked.title, 'Voltar ao sugerido?');
    assert.match(asked.message, /1 corte tem enquadramento personalizado, que será descartado/);
    assert.deepEqual(await ev(`BF.project.cut(${J(c2)}).framing`), { zoom: 1.4 }, 'cancelar não descarta nada');
    ev("(() => { const s = document.getElementById('exp-bulk-layout'); s.value = 'sugerido'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await answerModal(page, true);
    await waitFor(page, `BF.project.cut(${J(c2)}).framing === null`, 5000, 'enquadramento próprio descartado após confirmar');
    step('ação em lote: define Conversa, Jogo e Padrão nos selecionados, volta ao sugerido e só descarta ajustes depois de confirmar');

    // ---------- Layouts do canal: presets com prévia, deste projeto, voltar ao padrão ----------
    await click('#exp-layouts summary');
    assert.equal(await ev("document.getElementById('exp-layouts').open"), true);
    const rows = await ev("[...document.querySelectorAll('#exp-layout-list li')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim())");
    assert.equal(rows.length, 2);
    assert.match(rows[0], /Conversa.*Câmera em tela cheia.*padrão do app.*1 corte$/);
    assert.match(rows[1], /Jogo.*Webcam em cima e o jogo embaixo.*padrão do app.*2 cortes$/);
    await change(() => click('#exp-layout-list li[data-layout=jogo] .exp-cut-main'));
    await waitFor(page, "document.querySelector('#exp-layout-list li[data-layout=jogo] .exp-cut-main').getAttribute('aria-pressed') === 'true'", 5000, 'preset Jogo escolhido');
    assert.match(await text('.exp-target'), /Layout Jogo · vale para os cortes com esse layout/);
    assert.equal(await ev("document.getElementById('exp-cut-layout').hidden"), true, 'um preset não tem seletor de layout');
    assert.equal(await ev("document.getElementById('exp-use-player').hidden"), false);
    assert.equal(await ev("document.getElementById('exp-restore').hidden"), true, 'ainda sem ajuste do projeto');
    await waitFor(page, "document.querySelector('#tabpanel-export [data-mode=stack]').getAttribute('aria-pressed') === 'true'", 10000);
    await sleep(300);
    near((await pixels('#exp-prev-img', 0.5, 0.05))[0], 39, 14, 'preset Jogo na prévia: câmera em cima');
    // ajusta o preset: faixa da câmera de 31% para 45% (vale para os cortes Jogo, não para o perfil nem para o padrão do projeto)
    const sigBefore = await previewSig();
    await setRange('exp-pct', 45);
    await nextPreview(sigBefore);
    const saved = await project();
    assert.equal(saved.ext.export.layouts.jogo.framing.stack.webcamHeightPct, 45);
    assert.deepEqual(saved.ext.export.layouts.jogo.ref, { w: 1920, h: 1080 }, 'o preset lembra o tamanho da fonte em que foi medido');
    assert.equal(saved.ext.export.layouts.conversa, undefined);
    assert.equal(saved.ext.export.framing, undefined, 'o padrão do projeto não mudou');
    assert.equal(await ev('JSON.stringify([BF.state.project.ext.export.overrides || null, BF.state.project.profileId])'), profileBefore, 'o perfil não mudou');
    assert.match(await text('#exp-layout-list li[data-layout=jogo] .exp-cut-sub'), /deste projeto/);
    assert.equal(await ev("document.getElementById('exp-restore').hidden"), false);
    assert.equal(await text('#exp-restore'), 'Voltar ao padrão do app');
    // o corte com layout Jogo usa o preset ajustado (faixa da câmera mais alta: o limite entre as faixas desce)
    await pick(c1);
    await waitFor(page, "/Só o corte 01/.test(document.querySelector('.exp-target').textContent)", 5000);
    await waitPreview();
    await sleep(300);
    const jogo45 = await pixels('#exp-prev-img', 0.5, 0.40);
    assert.ok(jogo45[0] < 100, `com a câmera em 45% da altura o ponto de 40% ainda é câmera (R=${jogo45[0].toFixed(0)})`);
    // voltar ao padrão do app
    await click('#exp-layout-list li[data-layout=jogo] .exp-cut-main');
    await waitFor(page, "document.querySelector('#exp-layout-list li[data-layout=jogo] .exp-cut-main').getAttribute('aria-pressed') === 'true'", 5000);
    await click('#exp-restore');
    await waitFor(page, '!BF.state.project.ext.export.layouts', 5000, 'preset restaurado');
    assert.match(await text('#exp-layout-list li[data-layout=jogo] .exp-cut-sub'), /padrão do app/);
    step('Layouts do canal: preset editável com prévia real, "deste projeto", sem mexer no perfil, e "Voltar ao padrão do app"');

    // ---------- Jobs enviados à fila: origem do enquadramento e QC da câmera ----------
    await ev("document.getElementById('exp-layouts').open = false; BF.ui.selectTab('export'); true");
    await pick(c1);
    await waitQc(/pronto/);
    await click('#exp-enqueue');
    await waitFor(page, 'window.__enq.length === 1', 20000, 'queue:enqueue chamado');
    const enq = (await ev('window.__enq'))[0].jobs;
    const labels = Object.fromEntries(enq.map((j) => [j.cut.id, j.framingSource.label]));
    assert.deepEqual(labels, { [c1]: 'sugerido: Jogo', [c2]: 'sugerido: Conversa', [c3]: 'padrão' });
    const jb = Object.fromEntries(enq.map((j) => [j.cut.id, j]));
    assert.equal(jb[c1].framing.mode, 'stack');
    assert.equal(jb[c1].framingSource.via, 'ia');
    assert.equal(jb[c2].framing.mode, 'center');
    assert.equal(jb[c2].framing.focusX, 0.63);
    assert.equal(jb[c3].framing.mode, 'center');
    assert.equal(jb[c3].framing.focusX, 0.5);
    const prep = (await ev('window.__prep')).pop();
    assert.equal(prep.layouts.useSuggested, true);
    assert.deepEqual(Object.keys(prep.layouts.presets), ['conversa', 'jogo']);
    assert.equal(prep.layouts.presets.jogo.framing.mode, 'stack');
    step('Adicionar à fila: os Jobs levam o enquadramento do layout e a origem (sugerido, padrão) em framingSource');

    // fonte de outra proporção: aviso (nunca bloqueio) de que a câmera pode não estar na região escolhida
    await ev("BF.ui.selectTab('export'); true");
    await ev("window.__infoKeep = { ...BF.state.info }; BF.state.info = { ...BF.state.info, width: 1440, height: 1080 }; BF.bus.emit('cuts:changed', {}); true");
    await waitFor(page, "!!document.querySelector('#exp-qc .exp-issue.warn[data-code=CAMERA_RECT]')", 25000, 'aviso da câmera');
    assert.match(await text('#exp-qc .exp-issue.warn[data-code=CAMERA_RECT]'), /layout Jogo foi definido para vídeos 16:9 \(2560×1440\).*1440×1080 \(4:3\).*câmera pode não estar na região escolhida/);
    assert.equal(await ev("document.getElementById('exp-enqueue').disabled"), false, 'o aviso não bloqueia');
    assert.equal(await ev("document.querySelectorAll('#exp-qc .exp-issue.error').length"), 0);
    await ev("BF.state.info = window.__infoKeep; BF.bus.emit('cuts:changed', {}); true");
    await waitFor(page, "!document.querySelector('#exp-qc .exp-issue.warn[data-code=CAMERA_RECT]')", 25000, 'aviso some com a proporção certa');
    step('QC: câmera fora da fonte (outra proporção) vira aviso que não bloqueia');

    // ---------- salvar como padrão do canal e herdar em outro projeto ----------
    await ev(`BF.project.update((p) => { p.meta.channel = 'Canal Teste'; p.meta.game = 'Jogo Teste'; }, { reason: 'teste' }); BF.prefs.reload()`);
    await waitFor(page, "BF.prefs.scope().channel === 'Canal Teste'", 10000, 'preferências com o canal do projeto');
    await click('#exp-layouts summary');
    await click('#exp-layout-list li[data-layout=conversa] .exp-cut-main');
    await waitFor(page, "document.querySelector('#exp-layout-list li[data-layout=conversa] .exp-cut-main').getAttribute('aria-pressed') === 'true'", 5000);
    await change(() => setRange('exp-focusx', 50));
    await waitFor(page, 'BF.state.project.ext.export.layouts && BF.state.project.ext.export.layouts.conversa.framing.focusX === 0.5', 5000, 'preset de Conversa ajustado');
    const scopeOptions = await ev("[...document.getElementById('exp-layout-scope').options].map((o) => [o.value, o.textContent, o.disabled])");
    assert.deepEqual(scopeOptions, [['channel', 'Canal: Canal Teste', false], ['game', 'Jogo: Jogo Teste', false], ['general', 'Geral (todos os vídeos)', false]]);
    assert.equal(await ev("document.getElementById('exp-layout-scope').value"), 'channel', 'o canal é a escolha natural');
    await shot('export-layouts-0b-salvar.png');
    await click('#exp-layout-save');
    await waitFor(page, "/Layouts salvos como padrão/.test(document.getElementById('toasts').textContent)", 15000, 'aviso de padrão salvo');
    assert.match(await toast(), /Layouts salvos como padrão \(Canal: Canal Teste\)\. Novos projetos começam com eles\./);
    const stored = await ev("BF.prefs.get('export.layout.conversa', null)");
    assert.equal(stored.framing.focusX, 0.5);
    assert.deepEqual(stored.ref, { w: 1920, h: 1080 });
    assert.equal((await ev("BF.prefs.explain('export.layout.conversa')")).scope, 'channel');
    assert.equal((await ev("BF.prefs.get('export.layout.jogo', null)")).framing.mode, 'stack', 'o preset de Jogo também foi salvo');
    await waitFor(page, '!BF.state.project.ext.export.layouts', 10000, 'o projeto passa a herdar o padrão salvo');
    assert.match(await text('#exp-layout-list li[data-layout=conversa] .exp-cut-sub'), /padrão do canal Canal Teste/);
    // o arquivo de preferências do app tem o valor no escopo do canal (e nada na pasta de vídeos de verdade: o app de teste usa BF_VIDEOS_DIR)
    const prefsFile = JSON.parse(fs.readFileSync(path.join(userData, 'preferences.json'), 'utf8'));
    assert.equal(prefsFile.channels['canal teste'].values['export.layout.conversa'].framing.focusX, 0.5);
    assert.ok(prefsFile.channels['canal teste'].values['export.layout.jogo'], 'os dois layouts foram salvos');

    // outro projeto do mesmo canal herda os layouts (e a prévia do preset de Conversa usa o foco salvo)
    await ev("BF.project.flush()");
    await ev(`BF.openSource(${J(layouts)})`);
    await waitFor(page, `BF.state.project && BF.state.project.source.path === ${J(layouts)}`, 20000, 'segundo projeto aberto');
    await ev(`(() => {
      BF.project.update((p) => { p.meta.channel = 'canal  teste'; }, { reason: 'teste' });
      const mk = (fields, status) => { const c = BF.project.addCut(fields); BF.project.update(() => { c.status = status; }, { reason: 'teste' }); return c.id; };
      const s = ${J(lay.segments)};
      window.__ids2 = [
        // o palpite da IA erra de propósito em dois cortes para o detector mostrar o valor dele
        mk({ title: 'Conversa (IA diz jogo)', start: s[2].start + 1, end: s[2].end - 1, layout: 'jogo' }, 'approved'),
        mk({ title: 'Jogo (IA diz conversa)', start: s[3].start + 1, end: s[3].end - 1, layout: 'conversa' }, 'approved'),
        mk({ title: 'Outra cena (IA diz jogo)', start: s[4].start + 1, end: s[4].end - 1, layout: 'jogo' }, 'approved')
      ];
      BF.bus.emit('cuts:changed', {});
      BF.prefs.reload();
    })()`);
    const [d1, d2, d3] = await ev('window.__ids2');
    await waitFor(page, "BF.prefs.scope().channel === 'canal teste'", 10000, 'preferências do segundo projeto (nome normalizado)');
    await ev("BF.ui.selectTab('export')");
    await waitFor(page, "document.querySelectorAll('#exp-profile option').length >= 12", 15000);
    await ev("document.getElementById('exp-layouts').open = true; true");
    assert.match(await text('#exp-layout-list li[data-layout=conversa] .exp-cut-sub'), /padrão do canal Canal Teste|padrão do canal canal teste/i, 'novo projeto do mesmo canal herda o layout salvo');
    await click('#exp-layout-list li[data-layout=conversa] .exp-cut-main');
    await waitFor(page, "document.querySelector('#exp-layout-list li[data-layout=conversa] .exp-cut-main').getAttribute('aria-pressed') === 'true'", 5000);
    await waitFor(page, "Number(document.getElementById('exp-focusx').value) === 50", 5000, 'o foco salvo no canal aparece no preset do novo projeto');
    await waitPreview();
    step('salvar como padrão do canal: preferência por escopo gravada; um novo projeto do mesmo canal herda os layouts');

    // ---------- detector local: referências pelo player, detecção por imagem ----------
    await ev("document.getElementById('exp-detect').open = true; true");
    await waitFor(page, "document.getElementById('exp-detect-run').disabled === true", 5000);
    assert.match(await text('#exp-detect-status'), /Escolha pelo menos 2 quadros de cada layout\./);
    await ev("document.getElementById('exp-detect').scrollIntoView({ block: 'start' }); true");
    await shot('export-layouts-1-deteccao-antes.png');
    const seek = async (t) => {
      await ev(`BF.player.seek(${t}); true`);
      await waitFor(page, `Math.abs(BF.player.time() - ${t}) < 0.3`, 10000, `player em ${t}s`);
    };
    const addRef = async (layout, t) => {
      await seek(t);
      await click(`#exp-ref-add-${layout}`);
    };
    const refCount = (layout) => ev(`document.querySelectorAll('.exp-ref-group[data-layout=${layout}] .exp-ref').length`);
    const s = lay.segments;
    await addRef('conversa', s[0].start + 1.5);
    await waitFor(page, "document.querySelectorAll('.exp-ref-group[data-layout=conversa] .exp-ref').length === 1", 15000, 'primeira referência de Conversa');
    assert.match(await text('.exp-ref-group[data-layout=conversa] .exp-ref-head'), /1 de 4 quadros · falta 1 para detectar/);
    assert.equal(await ev("document.getElementById('exp-detect-run').disabled"), true, 'com um quadro só não detecta');
    // o mesmo quadro duas vezes não vale como "momento diferente"
    await click('#exp-ref-add-conversa');
    await waitFor(page, "/já é uma referência/.test(document.getElementById('toasts').textContent)", 15000, 'aviso de quadro repetido');
    assert.equal(await refCount('conversa'), 1);
    await addRef('conversa', s[2].start + 3);
    await waitFor(page, "document.querySelectorAll('.exp-ref-group[data-layout=conversa] .exp-ref').length === 2", 15000);
    await addRef('jogo', s[1].start + 1.5);
    await waitFor(page, "document.querySelectorAll('.exp-ref-group[data-layout=jogo] .exp-ref').length === 1", 15000);
    await addRef('jogo', s[3].start + 3);
    await waitFor(page, "document.querySelectorAll('.exp-ref-group[data-layout=jogo] .exp-ref').length === 2", 15000, 'duas referências de Jogo');
    const refs = await ev('JSON.parse(JSON.stringify(BF.state.project.ext.export.layoutRefs))');
    assert.equal(refs.conversa.length, 2);
    assert.equal(refs.jogo.length, 2);
    assert.ok([...refs.conversa, ...refs.jogo].every((t) => /^[A-Za-z0-9+/]{3072}$/.test(t)), 'miniaturas 64x36 em base64 guardadas no projeto');
    assert.equal(await ev("document.getElementById('exp-detect-run').disabled"), false);
    // antes de detectar: vale o palpite da IA (errado de propósito)
    assert.deepEqual((await origin(d1)).slice(0, 2), ['suggested', 'sugerido: Jogo']);
    assert.match(await sub(d1), /palpite da IA/);
    await click('#exp-detect-run');
    await waitFor(page, "BF.state.project.cuts.every((c) => c.layoutLocal)", 90000, 'detecção concluída');
    await waitFor(page, "!document.getElementById('exp-detect-run').disabled", 30000);
    const detected = Object.fromEntries((await project()).cuts.map((c) => [c.id, c.layoutLocal]));
    assert.equal(detected[d1].layout, 'conversa', 'a imagem corrige o palpite do texto');
    assert.equal(detected[d2].layout, 'jogo');
    assert.equal(detected[d3].layout, null, 'a terceira cena não é nenhum dos dois: incerto, nunca chuta');
    assert.ok(detected[d1].confidence >= 0.66);
    assert.match(detected[d1].key, /^[0-9a-f]{8}:/);
    assert.deepEqual((await origin(d1)).slice(0, 2), ['suggested', 'sugerido: Conversa']);
    assert.match(await sub(d1), /detectado pela imagem/);
    assert.deepEqual((await origin(d2)).slice(0, 2), ['suggested', 'sugerido: Jogo']);
    assert.match(await sub(d2), /detectado pela imagem/);
    assert.deepEqual((await origin(d3)).slice(0, 2), ['suggested', 'sugerido: Jogo'], 'incerto: segue valendo o palpite da IA');
    assert.match(await sub(d3), /palpite da IA/);
    assert.match(await ev(`document.querySelector(${J(`${cutRow(d3)} .exp-origin`)}).title`), /O detector não teve certeza do layout deste corte/);
    assert.match(await text('#exp-detect-status'), /2 detectados · 1 incerto de 3 cortes\./);
    assert.match(await text('#exp-suggest-note'), /3 de 3 cortes têm layout sugerido \(1 pela IA, 2 pela imagem\)/);
    await pick(d1);
    await waitFor(page, "/Só o corte 01/.test(document.querySelector('.exp-target').textContent)", 5000);
    assert.match(await text('#exp-origin-note'), /Layout Conversa sugerido: detectado pela imagem \(\d+% de confiança\)\./);
    await shot('export-layouts-2-deteccao-depois.png');
    // os Jobs registram quem sugeriu
    await ev('window.__enq = []; window.__enqReply = { ok: true, jobs: [] }; true');
    await ev("BF.ui.selectTab('export')");
    await waitQc(/pronto|aviso/);
    await click('#exp-enqueue');
    await waitFor(page, 'window.__enq.length === 1', 20000, 'queue:enqueue com os cortes detectados');
    const jobs2 = Object.fromEntries((await ev('window.__enq'))[0].jobs.map((j) => [j.cut.id, j]));
    assert.equal(jobs2[d1].framingSource.via, 'detector');
    assert.equal(jobs2[d1].framing.mode, 'center');
    assert.equal(jobs2[d2].framingSource.via, 'detector');
    assert.equal(jobs2[d2].framing.mode, 'stack');
    assert.equal(jobs2[d3].framingSource.via, 'ia');
    // o enquadramento do corte 01 usa o foco salvo do canal (0,5), herdado pelo projeto
    assert.equal(jobs2[d1].framing.focusX, 0.5);
    await waitFor(page, "document.getElementById('tab-queue').getAttribute('aria-selected') === 'true'", 20000);
    await ev("BF.ui.selectTab('export'); true");

    // mudar as referências: a detecção fica desatualizada e volta a valer o palpite da IA
    await ev("document.getElementById('exp-layouts').open = true; document.getElementById('exp-detect').open = true; true");
    await ev("document.querySelector('.exp-ref-group[data-layout=conversa] .exp-ref-del').click()");
    await waitFor(page, "document.querySelectorAll('.exp-ref-group[data-layout=conversa] .exp-ref').length === 1", 5000, 'referência removida');
    assert.match(await text('#exp-detect-status'), /Escolha pelo menos 2 quadros de cada layout\./);
    assert.deepEqual((await origin(d1)).slice(0, 2), ['suggested', 'sugerido: Jogo'], 'detecção velha não vale: volta o palpite da IA');
    assert.match(await sub(d1), /palpite da IA/);
    await pick(d1);
    await waitFor(page, "/Só o corte 01/.test(document.querySelector('.exp-target').textContent)", 5000);
    assert.match(await text('#exp-origin-note'), /A detecção pela imagem ficou desatualizada.*detecte de novo/);
    step('detector local: referências pelo player, detecção por imagem (vence o palpite errado da IA), incerto não chuta e referências novas invalidam a detecção');

    // ---------- em Preferências o padrão salvo aparece e pode ser removido com "Limpar" ----------
    await ev("BF.ui.selectTab('prefs')");
    await waitFor(page, "!!document.querySelector('.prefs-seg[data-scope=channel]')", 15000, 'aba Preferências');
    await click('.prefs-seg[data-scope=channel]');
    await waitFor(page, "!!document.querySelector('.prefs-row[data-key=\"export.layout.conversa\"] .prefs-clear')", 15000, 'linha do layout Conversa no escopo do canal');
    await ev("document.querySelector('.prefs-more').open = true; document.querySelector('.prefs-row[data-key=\"export.layout.conversa\"]').scrollIntoView({ block: 'center' }); true");
    const prefRow = await text('.prefs-row[data-key="export.layout.conversa"]');
    assert.match(prefRow, /Layout Conversa/);
    assert.match(prefRow, /definido na aba Exportar/, 'a tela de Preferências manda editar na aba certa');
    assert.match(prefRow, /Defina na aba Exportar, em Layouts do canal./);
    assert.doesNotMatch(prefRow, /aba Legendas/);
    assert.match(await text('.prefs-row[data-key="export.layout.refs"]'), /Quadros de referência dos layouts/);
    await shot('export-layouts-prefs.png');
    await click('.prefs-row[data-key="export.layout.conversa"] .prefs-clear');
    await waitFor(page, "BF.prefs.get('export.layout.conversa', null) === null", 15000, 'padrão removido do escopo do canal');
    await ev("BF.ui.selectTab('export'); true");
    await waitFor(page, "/padrão do app/.test(document.querySelector('#exp-layout-list li[data-layout=conversa] .exp-cut-sub').textContent)", 15000, 'o preset volta ao padrão do app');
    step('Preferências: o padrão salvo aparece como "definido na aba Exportar" e "Limpar" devolve o preset ao padrão do app');

    // ---------- capturas nos dois temas ----------
    if (shots) {
      // estado bonito para as capturas: refaz as referências e a detecção
      await addRef('conversa', s[0].start + 3.3);
      await waitFor(page, "document.querySelectorAll('.exp-ref-group[data-layout=conversa] .exp-ref').length === 2", 15000);
      await click('#exp-detect-run');
      await waitFor(page, "BF.state.project.cuts.every((c) => c.layoutLocal) && !document.getElementById('exp-detect-run').disabled", 90000, 'detecção refeita');
      await pick(d2);
      await waitFor(page, "/Só o corte 02/.test(document.querySelector('.exp-target').textContent)", 5000);
      await waitPreview();
      for (const theme of ['dark', 'light']) {
        await ev(`BF.ui.setTheme(${J(theme)}); true`);
        await sleep(400);
        await ev("document.querySelector('.tabpanels').scrollTop = 0; true");
        await scrollTo('#tabpanel-export .exp-h');
        await shot(`export-layouts-${theme}-1-interruptor-e-corte.png`);
        await ev("document.getElementById('exp-layouts').open = true; document.getElementById('exp-detect').open = false; true");
        await scrollTo('#exp-layouts');
        await shot(`export-layouts-${theme}-2-layouts-do-canal.png`);
        await ev("document.getElementById('exp-detect').open = true; true");
        await scrollTo('#exp-detect');
        await shot(`export-layouts-${theme}-3-deteccao.png`);
        await scrollTo('#exp-cuts');
        await shot(`export-layouts-${theme}-4-cortes-com-chips.png`);
        await ev("document.getElementById('exp-detect').open = false; true");
      }
      await ev("BF.ui.setTheme('dark'); document.querySelector('.tabpanels').scrollTop = 0; true");
    }

    h.assertNoConsoleErrors(page);
    step('nenhum erro de console durante toda a sessão');
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

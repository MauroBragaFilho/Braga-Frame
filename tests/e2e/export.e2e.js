'use strict';

/**
 * E2E da aba Exportar: abre o app Electron de verdade (perfil de usuário temporário, vídeo gerado com o ffmpeg) e confere
 *  - perfis embutidos e do usuário, "Detalhes" recolhido, bitrate por barra (padrão 10 Mbps) e ajustes por projeto;
 *  - prévia REAL do enquadramento (PNG gerado pelo mesmo filtro da exportação) mudando ao ajustar centro, zoom, desfoque,
 *    webcam + jogo e retângulos arrastados com o mouse;
 *  - enquadramento por corte ("personalizado") sem alterar o perfil nem o padrão do projeto, e "Restaurar padrão";
 *  - relatório de QC (avisos que não bloqueiam, erro que bloqueia com a solução);
 *  - montagem dos Jobs (3.3) enviados a queue:enqueue (interceptando BF.api), a ida para a aba Fila e o erro claro quando a fila
 *    não existe ou recusa (nunca fingir que enfileirou);
 *  - persistência ao reiniciar o app e as preferências export.profileId / export.framing.mode.
 * Uso: node tests/e2e/export.e2e.js     (BF_E2E_SHOTDIR=C:\pasta guarda capturas da janela)
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

const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: obtido ${actual}, esperado ${expected} (±${tol})`);
const kbpsToSlider = (k) => Math.round((Math.log(k / 500) / Math.log(300)) * 1000);

async function main() {
  assert.ok(tools.ffmpeg && tools.ffprobe, 'ffmpeg/ffprobe necessários para o teste');
  const tmp = h.mkTemp('e2e-export');
  const userData = path.join(tmp, 'userdata');
  const source = path.join(tmp, 'gameplay.mp4');
  const second = path.join(tmp, 'segundo.mp4');
  const out = path.join(tmp, 'Cortes');
  const shots = process.env.BF_E2E_SHOTDIR;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const shot = async (page, name) => { if (shots) await h.screenshot(page, path.join(shots, `export-${name}.png`)); };

  try {
    fx.makeCodedSource(source, { width: 1920, height: 1080, fps: 10, seconds: 20 });
    fx.makeCodedSource(second, { width: 1280, height: 720, fps: 10, seconds: 6 });
    step('vídeos de teste gerados (fonte codificada por posição: R = x, G = y)');

    let app = await h.launchApp(userData);
    let page = app.page;
    const ev = (expr) => page.eval(expr);
    const q = (sel) => `document.querySelector(${J(sel)})`;
    const setRange = (id, value) => ev(`(() => { const e = document.getElementById(${J(id)}); e.value = ${J(String(value))}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const setSelect = (id, value) => ev(`(() => { const e = document.getElementById(${J(id)}); e.value = ${J(String(value))}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const click = (sel) => ev(`${q(sel)}.click()`);
    const mode = (m) => click(`#tabpanel-export [data-mode="${m}"]`);
    const text = (sel) => ev(`(${q(sel)} || { textContent: '' }).textContent`);
    const previewSig = () => ev("document.getElementById('exp-prev-img').getAttribute('src') || ''");
    const pixels = (sel, fx0, fy0, r = 2) => ev(`(() => {
      const img = ${q(sel)}; const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const x = Math.round(${fx0} * (c.width - 1)); const y = Math.round(${fy0} * (c.height - 1));
      const d = g.getImageData(Math.max(0, x - ${r}), Math.max(0, y - ${r}), ${2 * r + 1}, ${2 * r + 1}).data; let s = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; }
      const n = d.length / 4; return s.map((v) => v / n);
    })()`);
    /** Espera uma NOVA prévia (diferente de `before`) e devolve o src. */
    let previews = 0;
    const nextPreview = async (before) => { previews += 1; await waitFor(page, `(document.getElementById('exp-prev-img').getAttribute('src') || '') !== ${J(before)}`, 25000, `nova prévia (#${previews})`); await sleep(150); return previewSig(); };
    const change = async (fn) => { const before = await previewSig(); await fn(); return nextPreview(before); };
    const waitPreview = (what = 'prévia') => waitFor(page, "(document.getElementById('exp-prev-img').getAttribute('src') || '').startsWith('data:image/png') && !document.querySelector('.exp-stage').classList.contains('is-loading')", 25000, what);
    const waitQc = (re) => waitFor(page, `${re}.test(document.getElementById('exp-qc-status').textContent)`, 25000, `conferência ${re}`);
    const project = () => ev('JSON.parse(JSON.stringify(BF.state.project))');
    const mouse = (type, x, y, extra = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
    const rectOf = (sel) => ev(`(() => { const r = ${q(sel)}.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);

    // ---------- sem projeto aberto ----------
    assert.equal(await ev("document.getElementById('tab-export').disabled"), true, 'a base desabilita a aba sem vídeo');
    assert.match(await text('#tabpanel-export'), /Abra um vídeo e aprove cortes/, 'o painel não quebra sem projeto');
    assert.equal(await ev('typeof BF.state.project'), 'object');
    assert.equal(await ev('BF.state.project'), null);
    step('sem projeto: a aba Exportar não quebra (texto orientando o usuário)');

    // ---------- abrir vídeo e criar cortes ----------
    await ev(`BF.openSource(${J(source)})`);
    await waitFor(page, "BF.state.project && !document.getElementById('app').classList.contains('no-project')", 20000, 'projeto aberto');
    await ev(`(() => {
      const mk = (title, start, end, status) => { const c = BF.project.addCut({ title, start, end }); if (status) { BF.project.update(() => { c.status = status; }, { reason: 'teste' }); } return c.id; };
      window.__ids = [mk('Clutch final', 2, 6, 'approved'), mk('Ace no bomb', 8, 13, 'approved'), mk('Quase', 15, 18, null), mk('Ruim', 18.5, 19.5, 'rejected')];
      BF.bus.emit('cuts:changed', {});
    })()`);
    const ids = await ev('window.__ids');
    assert.equal(ids.length, 4);

    await ev("BF.ui.selectTab('export')");
    await waitFor(page, "document.querySelectorAll('#exp-profile option').length >= 12", 15000, 'perfis carregados');
    assert.equal(await ev("document.getElementById('tabpanel-export').hidden"), false);
    assert.equal(await ev("document.querySelector('#tab-export .tab-badge').textContent"), '2', 'a aba mostra os 2 cortes aprovados');

    // ---------- perfil: embutidos, padrão 9:16 1080p H.264 10 Mbps, Detalhes recolhidos ----------
    const options = await ev("[...document.querySelectorAll('#exp-profile option')].map((o) => [o.value, o.textContent, o.parentElement.label])");
    assert.equal(options.length, 12);
    assert.deepEqual(options.map((o) => o[2]).filter((v, i, a) => a.indexOf(v) === i), ['Vertical 9:16', 'Horizontal 16:9']);
    assert.equal(options[0][0], 'vertical-1080-h264');
    assert.equal(await ev("document.getElementById('exp-profile').value"), 'vertical-1080-h264', 'padrão obrigatório: 9:16 1080p H.264');
    assert.equal(await ev("document.getElementById('exp-details').open"), false, 'Detalhes começam recolhidos');
    assert.match(await text('#exp-details summary'), /Detalhes · 1080×1920 · H\.264 · 10 Mbps/);
    assert.equal(await ev("document.getElementById('exp-bitrate-label').textContent"), '10 Mbps');
    assert.equal(await ev("Number(document.getElementById('exp-bitrate').value)"), kbpsToSlider(10000), 'barra de bitrate no padrão de 10 Mbps');
    assert.match(await text('#tabpanel-export'), /Exportação gera arquivos locais; publique manualmente\./);
    assert.deepEqual(await ev("[...document.querySelectorAll('#tabpanel-export .exp-main > .exp-foot button')].map((b) => b.textContent)"), ['Adicionar à fila (2)'], 'um único botão de ação');
    step('perfis embutidos (9:16 e 16:9), padrão 1080p H.264 10 Mbps, Detalhes recolhidos, botão único');

    // ---------- prévia real do enquadramento ----------
    await waitPreview();
    const dims = await ev("(() => { const i = document.getElementById('exp-prev-img'); return [i.naturalWidth, i.naturalHeight]; })()");
    near(dims[0] / dims[1], 9 / 16, 0.01, 'a prévia é 9:16');
    assert.equal(await ev("document.getElementById('exp-src-img').getAttribute('src').startsWith('data:image/jpeg')"), true, 'quadro da fonte');
    const srcDims = await ev("(() => { const i = document.getElementById('exp-src-img'); return [i.naturalWidth, i.naturalHeight]; })()");
    near(srcDims[0] / srcDims[1], 16 / 9, 0.01, 'a fonte é 16:9');
    assert.equal(await ev("document.querySelectorAll('.exp-rect').length"), 1, 'sobreposição com o retângulo do recorte');
    await shot(page, '1-padrao');

    // centro: foco horizontal 0% e 100% mudam o conteúdo (R = posição horizontal da fonte)
    await change(() => setRange('exp-focusx', 0));
    const left0 = await pixels('#exp-prev-img', 0.01, 0.5);
    near(left0[0], 0, 14, 'foco 0%: borda esquerda mostra x=0 da fonte');
    await change(() => setRange('exp-focusx', 100));
    const left100 = await pixels('#exp-prev-img', 0.01, 0.5);
    near(left100[0], 255 * (1 - 1080 / 1920 / (1920 / 1080)), 14, 'foco 100%: borda esquerda mostra x=0,68');
    assert.ok(left100[0] - left0[0] > 140, 'os dois focos mostram partes bem diferentes');
    assert.equal(await ev('BF.state.project.ext.export.framing.focusX'), 1, 'gravado como padrão do projeto');
    step('centro: o foco horizontal muda a prévia real e é gravado no padrão do projeto');

    // zoom
    await change(() => setRange('exp-zoom', 2));
    const z = await pixels('#exp-prev-img', 0.97, 0.5);
    near(z[0], 255, 14, 'zoom 2 com foco 100%: borda direita continua na borda da fonte');
    const zl = await pixels('#exp-prev-img', 0.01, 0.5);
    near(zl[0], 255 * (1 - 0.5 * (1080 / 1920 / (1920 / 1080))), 14, 'zoom 2: janela metade da largura');
    assert.equal(await text('#tabpanel-export .exp-ctl strong'), '2,00×');

    // arrastar o retângulo com o mouse (eventos reais de mouse)
    // o painel rola e cada aba abre no topo: leva o quadro da fonte ao meio da janela, como o usuário faria, antes de medir e arrastar
    await ev("document.querySelector('.exp-src').scrollIntoView({ block: 'center' })");
    await sleep(150);
    const box = await rectOf('.exp-src');
    const r0 = await rectOf('.exp-rect');
    await mouse('mouseMoved', r0.x + r0.w / 2, r0.y + r0.h / 2);
    await mouse('mousePressed', r0.x + r0.w / 2, r0.y + r0.h / 2);
    const sigBeforeDrag = await previewSig();
    await mouse('mouseMoved', r0.x + r0.w / 2 - box.w * 0.2, r0.y + r0.h / 2);
    await mouse('mouseMoved', r0.x + r0.w / 2 - box.w * 0.9, r0.y + r0.h / 2);
    await mouse('mouseReleased', r0.x + r0.w / 2 - box.w * 0.9, r0.y + r0.h / 2);
    await nextPreview(sigBeforeDrag);
    const focusAfterDrag = await ev('BF.state.project.ext.export.framing.focusX');
    near(focusAfterDrag, 0, 0.02, 'arrastar o retângulo para a esquerda leva o foco a 0');
    near((await pixels('#exp-prev-img', 0.01, 0.5))[0], 0, 14, 'a prévia acompanhou o arrasto');
    near((await rectOf('.exp-rect')).x, box.x, 3, 'o retângulo ficou encostado na esquerda');
    step('zoom e arrasto do retângulo (mouse de verdade) mudam o enquadramento e a prévia');

    // fundo desfocado
    await change(() => setRange('exp-zoom', 1));
    await change(() => mode('blur'));
    assert.equal(await ev("document.querySelector('#tabpanel-export [data-mode=blur]').getAttribute('aria-pressed')"), 'true');
    assert.equal(await ev("document.querySelectorAll('.exp-rect').length"), 0, 'blur sem zoom mostra a imagem inteira (nada a arrastar)');
    const whole = await pixels('#exp-prev-img', 0.02, 0.5);
    near(whole[0], 0, 18, 'blur: a gameplay inteira (borda esquerda = x 0)');
    const whole2 = await pixels('#exp-prev-img', 0.98, 0.5);
    near(whole2[0], 255, 18, 'blur: a gameplay inteira (borda direita = x 1)');
    const bgTop = await pixels('#exp-prev-img', 0.5, 0.03);
    assert.ok(bgTop[1] < 60, `fundo do topo vem do alto do vídeo (G=${bgTop[1].toFixed(0)})`);
    await shot(page, '2-blur');
    step('fundo desfocado: a gameplay inteira por cima do próprio vídeo desfocado');

    // webcam + jogo
    const sigBlur = await previewSig();
    await mode('stack');
    await nextPreview(sigBlur);
    assert.equal(await ev("document.querySelectorAll('.exp-rect').length"), 2, 'dois retângulos: webcam e gameplay');
    assert.equal(await ev("document.querySelector('.exp-rect.webcam .exp-rect-tag').textContent"), 'Webcam');
    // webcam padrão = canto inferior esquerdo (x 0..0,25, y 0,7..1): em cima, G alto e R baixo
    const cam = await pixels('#exp-prev-img', 0.1, 0.1);
    assert.ok(cam[1] > 150, `faixa de cima = webcam (G=${cam[1].toFixed(0)})`);
    assert.ok(cam[0] < 70, `faixa de cima = webcam, canto esquerdo (R=${cam[0].toFixed(0)})`);
    const sigStack = await previewSig();
    await click('#tabpanel-export [data-pos="bottom"]');
    await nextPreview(sigStack);
    const camBottom = await pixels('#exp-prev-img', 0.1, 0.92);
    assert.ok(camBottom[1] > 150 && camBottom[0] < 70, 'webcam embaixo: a faixa de baixo é a webcam');
    // altura da webcam
    const sigPos = await previewSig();
    await setRange('exp-pct', 50);
    await nextPreview(sigPos);
    assert.equal(await text('#tabpanel-export .exp-ctl:not([hidden]) strong'), '50%');
    assert.equal(await ev('BF.state.project.ext.export.framing.stack.webcamHeightPct'), 50);
    // mover o retângulo da webcam com o mouse: leva a webcam para o canto superior direito da fonte
    await click('#tabpanel-export [data-part="webcam"]');
    const camRect = await rectOf('.exp-rect.webcam');
    const srcBox = await rectOf('.exp-src');
    const sigBefore = await previewSig();
    const fromX = camRect.x + camRect.w / 2;
    const fromY = camRect.y + camRect.h / 2;
    await mouse('mouseMoved', fromX, fromY);
    await mouse('mousePressed', fromX, fromY);
    await mouse('mouseMoved', fromX + srcBox.w * 0.3, fromY - srcBox.h * 0.3);
    await mouse('mouseMoved', fromX + srcBox.w * 0.6, fromY - srcBox.h * 0.8);
    await mouse('mouseReleased', fromX + srcBox.w * 0.6, fromY - srcBox.h * 0.8);
    await nextPreview(sigBefore);
    const moved = await ev('BF.state.project.ext.export.framing.stack.webcamRect');
    assert.ok(moved.x > 0.5 && moved.y < 0.1, `a webcam foi para o canto superior direito: ${J(moved)}`);
    const camMoved = await pixels('#exp-prev-img', 0.1, 0.92);
    assert.ok(camMoved[0] > 150 && camMoved[1] < 100, `a faixa da webcam agora mostra o canto superior direito (R=${camMoved[0].toFixed(0)} G=${camMoved[1].toFixed(0)})`);
    await shot(page, '3-stack');
    step('webcam + jogo: posição, altura e retângulo da webcam arrastado com o mouse mudam a prévia');

    // livre
    const sigBeforeCustom = await previewSig();
    await mode('custom');
    await nextPreview(sigBeforeCustom);
    assert.equal(await ev("document.querySelectorAll('.exp-rect').length"), 1);
    assert.equal(await ev("!!document.querySelector('.exp-rect .exp-handle')"), true, 'o retângulo livre tem o canto para redimensionar');
    const sigCustom = await previewSig();
    const cr = await rectOf('.exp-rect');
    const handleX = cr.x + cr.w - 4;
    const handleY = cr.y + cr.h - 4;
    await mouse('mouseMoved', handleX, handleY);
    await mouse('mousePressed', handleX, handleY);
    await mouse('mouseMoved', handleX - srcBox.w * 0.1, handleY - srcBox.h * 0.1);
    await mouse('mouseMoved', handleX - srcBox.w * 0.2, handleY - srcBox.h * 0.2);
    await mouse('mouseReleased', handleX - srcBox.w * 0.2, handleY - srcBox.h * 0.2);
    await nextPreview(sigCustom);
    const custom = await ev('BF.state.project.ext.export.framing.custom');
    assert.ok(custom.w < 1 && custom.w > 0.04, `o canto encolheu o retângulo: ${J(custom)}`);
    near((custom.w * 1920) / (custom.h * 1080), 1080 / 1920, 0.02, 'o redimensionamento mantém a proporção do quadro');
    step('modo livre: o canto redimensiona mantendo a proporção do perfil');

    // volta ao centro e restaura o padrão do projeto
    await change(() => mode('center'));
    assert.equal(await ev("document.getElementById('exp-restore').hidden"), false, 'há ajuste no padrão do projeto');
    await change(() => click('#exp-restore'));
    await waitFor(page, "!BF.state.project.ext.export.framing", 5000, 'padrão do projeto restaurado');
    assert.equal(await ev("document.getElementById('exp-restore').hidden"), true);
    near((await pixels('#exp-prev-img', 0.01, 0.5))[0], 255 * (1 - 1080 / 1920 / (1920 / 1080)) / 2, 14, 'padrão restaurado: foco no centro');
    step('Restaurar padrão limpa o enquadramento do projeto');

    // teclado: com o retângulo focado, as setas movem a janela e o foco continua nele
    await ev("document.querySelector('.exp-rect').focus()");
    await page.press('ArrowRight');
    await waitFor(page, "BF.state.project.ext.export.framing && BF.state.project.ext.export.framing.focusX > 0.5", 5000, 'seta moveu o enquadramento');
    assert.equal(await ev('document.activeElement.dataset.rect'), 'window', 'o foco do teclado ficou no retângulo');
    await click('#exp-restore');
    await waitFor(page, "!BF.state.project.ext.export.framing", 5000);
    step('teclado: setas movem o retângulo sem perder o foco');

    // ---------- rodapé fixo "Adicionar à fila" fica POR CIMA dos retângulos de enquadramento ao rolar ----------
    {
      let placed = null;
      for (const height of [420, 360, 300]) {
        await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height, deviceScaleFactor: 1, mobile: false });
        await sleep(250);
        placed = await ev(`(() => {
          const sc = document.querySelector('.tabpanels'); const btn = document.getElementById('exp-enqueue'); const rect = document.querySelector('#tabpanel-export .exp-rect');
          sc.scrollTop = 0;
          const r = rect.getBoundingClientRect(); const b = btn.getBoundingClientRect();
          const delta = r.top + r.height / 2 - (b.top + b.height / 2);
          if (delta < 0 || delta > sc.scrollHeight - sc.clientHeight) return null;
          sc.scrollTop = delta;
          const r2 = rect.getBoundingClientRect(); const b2 = btn.getBoundingClientRect();
          const x = r2.left + r2.width / 2; const y = b2.top + b2.height / 2;
          const stack = document.elementsFromPoint(x, y);
          return { x, y, rectUnder: stack.includes(rect), top: stack[0] ? (stack[0].closest('.exp-foot') ? 'rodape' : stack[0].className) : null, height: window.innerHeight };
        })()`);
        if (placed) break;
      }
      assert.ok(placed, 'foi possível rolar a aba até o retângulo ficar sob o rodapé');
      assert.equal(placed.rectUnder, true, `o retângulo de enquadramento está na mesma posição do botão (${J(placed)})`);
      assert.equal(placed.top, 'rodape', `o rodapé (botão) fica por cima do retângulo, que não pode cobrir o botão: ${J(placed)}`);
      assert.equal(await ev("getComputedStyle(document.querySelector('#tabpanel-export .exp-foot')).backgroundColor !== 'rgba(0, 0, 0, 0)'"), true, 'fundo sólido, sem transparência por baixo do botão');
      await shot(page, '1b-rodape-sobre-retangulo');
      await ev("document.querySelector('.tabpanels').scrollTop = 0; true");
      await page.send('Emulation.clearDeviceMetricsOverride', {});
      step('rodapé fixo: o botão "Adicionar à fila" fica por cima dos retângulos de enquadramento ao rolar a aba');
    }

    // ---------- enquadramento por corte ----------
    const profileBefore = await ev('JSON.stringify(BF.state.project.ext.export.overrides || null) + BF.state.project.profileId');
    const rows = await ev("[...document.querySelectorAll('#exp-cuts li')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim())");
    assert.equal(rows.length, 4, 'padrão + 3 cortes (o rejeitado fica de fora)');
    assert.match(rows[0], /Padrão do projeto/);
    assert.match(rows[1], /01 · Clutch final/);
    assert.match(rows[3], /03 · Quase.*pendente/);
    assert.deepEqual(await ev("[...document.querySelectorAll('#exp-cuts input')].map((i) => i.checked)"), [true, true, false], 'aprovados marcados; pendente não');
    await click(`#exp-cuts li[data-id="${ids[0]}"] .exp-cut-main`);
    await waitFor(page, "/Só o corte 01/.test(document.querySelector('.exp-target').textContent)", 5000, 'alvo = corte 01');
    const sigCut0 = await previewSig();
    await mode('blur');
    await nextPreview(sigCut0);
    let proj = await project();
    assert.deepEqual(proj.cuts.find((c) => c.id === ids[0]).framing, { mode: 'blur' }, 'o ajuste ficou no corte');
    assert.equal(proj.cuts.find((c) => c.id === ids[1]).framing, null, 'outros cortes intactos');
    assert.equal(proj.ext.export.framing, undefined, 'o padrão do projeto não mudou');
    assert.equal(await ev('JSON.stringify(BF.state.project.ext.export.overrides || null) + BF.state.project.profileId'), profileBefore, 'o perfil não mudou');
    assert.equal(await ev(`!!document.querySelector('#exp-cuts li[data-id="${ids[0]}"] .exp-badge')`), true, 'marca de personalizado');
    assert.equal(await text(`#exp-cuts li[data-id="${ids[0]}"] .exp-badge`), 'personalizado');
    assert.equal(await ev("document.getElementById('exp-restore').hidden"), false);
    // o corte 02 continua no padrão (centro)
    await click(`#exp-cuts li[data-id="${ids[1]}"] .exp-cut-main`);
    await waitFor(page, "/Só o corte 02/.test(document.querySelector('.exp-target').textContent)", 5000);
    assert.equal(await ev("document.querySelector('#tabpanel-export [data-mode=center]').getAttribute('aria-pressed')"), 'true');
    assert.equal(await ev("document.getElementById('exp-restore').hidden"), true, 'sem ajuste próprio, sem botão de restaurar');
    // ajuste de zoom só no corte 02
    await setRange('exp-zoom', 1.5);
    await waitFor(page, `BF.project.cut(${J(ids[1])}).framing && BF.project.cut(${J(ids[1])}).framing.zoom === 1.5`, 5000);
    // volta ao corte 01 e restaura
    await click(`#exp-cuts li[data-id="${ids[0]}"] .exp-cut-main`);
    await waitFor(page, "/Só o corte 01/.test(document.querySelector('.exp-target').textContent)", 5000);
    await click('#exp-restore');
    await waitFor(page, `BF.project.cut(${J(ids[0])}).framing === null`, 5000, 'corte restaurado');
    assert.equal(await ev(`!!document.querySelector('#exp-cuts li[data-id="${ids[0]}"] .exp-badge')`), false);
    assert.equal(await ev(`!!document.querySelector('#exp-cuts li[data-id="${ids[1]}"] .exp-badge')`), true, 'o corte 02 segue personalizado');
    step('enquadramento por corte: marca "personalizado", não altera perfil nem padrão, Restaurar padrão');

    // ---------- bitrate por barra e ajustes por projeto ----------
    await click('#exp-details summary');
    assert.equal(await ev("document.getElementById('exp-details').open"), true);
    await setRange('exp-bitrate', kbpsToSlider(20000));
    await waitFor(page, "BF.state.project.ext.export.overrides && BF.state.project.ext.export.overrides['vertical-1080-h264'] && BF.state.project.ext.export.overrides['vertical-1080-h264'].bitrateKbps === 20000", 5000, 'bitrate gravado');
    assert.equal(await text('#exp-bitrate-label'), '20 Mbps');
    assert.match(await text('#exp-details summary'), /20 Mbps · ajustado/);
    assert.equal(await ev("document.getElementById('exp-reset-profile').hidden"), false);
    await click('#exp-reset-profile');
    await waitFor(page, "!BF.state.project.ext.export.overrides", 5000, 'ajustes do perfil descartados');
    assert.equal(await text('#exp-bitrate-label'), '10 Mbps');
    await setRange('exp-bitrate', kbpsToSlider(14000));
    await waitFor(page, "BF.state.project.ext.export.overrides && BF.state.project.ext.export.overrides['vertical-1080-h264'].bitrateKbps === 14000", 5000);
    await setSelect('exp-codec', 'h265');
    await setSelect('exp-encoder', 'software');
    await waitFor(page, "BF.state.project.ext.export.overrides['vertical-1080-h264'].codec === 'h265' && BF.state.project.ext.export.overrides['vertical-1080-h264'].encoder === 'software'", 5000);
    assert.match(await text('#exp-encoder-hint'), /Placa NVIDIA (disponível|indisponível)/, 'diz se a placa NVIDIA foi detectada de verdade');
    step('bitrate por barra (padrão 10 Mbps), codec e codificador: ajustes por projeto, voltando ao perfil');

    // ---------- perfil do usuário ----------
    // (a conferência passa a registrar o perfil efetivo enviado ao motor: o nome muda quando a proporção deixa de ser 9:16)
    await ev(`(() => { window.__prep = []; window.__apiKeep = BF.api; const o = BF.api.bind(BF); BF.api = async (c, p, opts) => { if (c === 'export:prepare') window.__prep.push(JSON.parse(JSON.stringify(p.profile))); return o(c, p, opts); }; })()`);
    await ev("document.getElementById('exp-width').value = '1080'; document.getElementById('exp-height').value = '1350'; document.getElementById('exp-height').dispatchEvent(new Event('change', { bubbles: true }))");
    await waitFor(page, "BF.state.project.ext.export.overrides['vertical-1080-h264'].height === 1350", 5000);
    await waitFor(page, "(() => { const i = document.getElementById('exp-prev-img'); return i.naturalHeight > 0 && Math.abs(i.naturalWidth / i.naturalHeight - 0.8) < 0.02; })()", 25000, 'prévia 4:5');
    await waitFor(page, 'window.__prep.some((p) => p.height === 1350)', 25000, 'conferência com a altura ajustada');
    assert.equal(await ev('window.__prep.filter((p) => p.height === 1350).pop().name'), 'Personalizado (1080×1350)', 'ajustar as medidas tira o perfil do 9:16: o nome deixa de ser "Vertical 9:16"');
    assert.match(await text('#exp-profile-hint'), /1080×1350.*mudaram a proporção.*Voltar aos valores do perfil/, 'a tela explica o que aconteceu');
    await waitFor(page, "!!document.querySelector('#exp-qc .exp-issue.warn[data-code=NOT_9X16]')", 25000, 'aviso NOT_9X16 na conferência');
    assert.match(await text('#exp-qc .exp-issue.warn[data-code=NOT_9X16]'), /1080×1350.*não são 9:16/);
    assert.equal(await ev("document.getElementById('exp-enqueue').disabled"), false, 'o aviso não bloqueia');
    await ev('BF.api = window.__apiKeep; true');
    await ev("document.getElementById('exp-width').value = '1081'; document.getElementById('exp-width').dispatchEvent(new Event('change', { bubbles: true }))");
    assert.match(await text('#tabpanel-export .exp-details .exp-msg.error'), /inteiros pares/, 'medida ímpar é recusada com explicação');
    assert.equal(await ev('BF.state.project.ext.export.overrides["vertical-1080-h264"].width'), undefined, 'a medida inválida não foi gravada');
    await ev("document.getElementById('exp-width').value = '1080'; document.getElementById('exp-width').dispatchEvent(new Event('change', { bubbles: true }))");
    const dims45 = await ev("(() => { const i = document.getElementById('exp-prev-img'); return [i.naturalWidth, i.naturalHeight]; })()");
    near(dims45[0] / dims45[1], 1080 / 1350, 0.02, 'a prévia passou a 4:5');
    ev("document.getElementById('exp-save-profile').click()");
    assert.equal((await answerModal(page, true, { text: 'Meu 4x5' })).title, 'Salvar como meu perfil');
    await waitFor(page, "[...document.querySelectorAll('#exp-profile option')].some((o) => o.textContent === 'Meu 4x5')", 10000, 'perfil do usuário na lista');
    assert.equal(await ev("[...document.querySelectorAll('#exp-profile option')].find((o) => o.textContent === 'Meu 4x5').parentElement.label"), 'Meus perfis');
    assert.match(await ev("document.getElementById('exp-profile').value"), /^user-meu-4x5-/);
    assert.equal(await ev("document.getElementById('exp-delete-profile').hidden"), false);
    assert.equal(await ev("document.getElementById('exp-reset-profile').hidden"), true, 'perfil salvo = sem ajustes pendentes');
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'profiles.json'), 'utf8'));
    assert.deepEqual(saved.profiles.map((p) => [p.name, p.width, p.height, p.codec, p.bitrateKbps, p.encoder]), [['Meu 4x5', 1080, 1350, 'h265', 14000, 'software']]);
    assert.equal(await ev("(() => { const o = BF.state.project.ext.export.overrides; return !o || !o['vertical-1080-h264']; })()"), true, 'o ajuste virou perfil e saiu dos ajustes do embutido');
    // vale para outro projeto: o perfil aparece também no segundo vídeo
    step('perfil do usuário salvo em profiles.json (vale para todos os projetos)');

    // ---------- QC ----------
    await setSelect('exp-profile', 'vertical-2160-h265');
    await waitFor(page, "/2160×3840/.test((document.querySelector('#exp-qc .exp-issue[data-code=UPSCALE]') || { textContent: '' }).textContent)", 25000, 'aviso de ampliação para 4K');
    const warnCodes = await ev("[...document.querySelectorAll('#exp-qc .exp-issue.warn')].map((li) => li.dataset.code).sort()");
    assert.ok(warnCodes.includes('UPSCALE') && warnCodes.includes('HEVC_COMPAT'), `avisos: ${warnCodes}`);
    assert.match(await text('#exp-qc .exp-issue.warn[data-code="UPSCALE"]'), /1920×1080.*ampliada.*2160×3840/);
    assert.equal(await ev("document.getElementById('exp-enqueue').disabled"), false, 'avisos não bloqueiam');
    assert.equal(await ev("document.querySelectorAll('#exp-qc .exp-issue.error').length"), 0);
    await shot(page, '4-qc-avisos');
    // erro: pasta de destino impossível (já existe um arquivo com o nome da pasta)
    const fileAsDir = path.join(tmp, 'eu-sou-arquivo');
    fs.writeFileSync(fileAsDir, 'x');
    await ev(`BF.project.update((p) => { p.exportDir = ${J(path.join(fileAsDir, 'dentro'))}; }, { reason: 'export:dir' }); document.getElementById('exp-pick-dir').dispatchEvent(new Event('x'))`);
    await ev("(() => { const t = document.getElementById('exp-template'); t.value = t.value + ' '; t.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await waitQc(/não serão exportados/);
    const err = await ev("(() => { const li = document.querySelector('#exp-qc .exp-issue.error'); return li ? [li.dataset.code, li.textContent] : null; })()");
    assert.equal(err[0], 'OUTPUT_NOT_WRITABLE');
    assert.match(err[1], /Como resolver:.*pasta de destino/);
    assert.equal(await ev("document.getElementById('exp-enqueue').disabled"), true, 'erro em todos os cortes bloqueia o envio');
    assert.match(await text('#exp-enqueue-why'), /corrija os problemas/);
    await ev("BF.project.update((p) => { p.exportDir = null; }, { reason: 'export:dir' }); (() => { const t = document.getElementById('exp-template'); t.value = t.value.trim(); t.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await waitFor(page, "document.getElementById('exp-enqueue').disabled === false", 20000, 'botão liberado após corrigir');
    step('conferência: avisos (ampliação, H.265) não bloqueiam; erro bloqueia com causa e solução');

    // ---------- montagem dos Jobs e envio à fila (BF.api interceptado) ----------
    await setSelect('exp-profile', 'vertical-1080-h264');
    await waitQc(/pronto/);
    await ev(`(() => {
      window.__enq = []; window.__enqReply = { ok: true, jobs: [] };
      const original = BF.api.bind(BF);
      BF.api = async (channel, payload, opts) => { if (channel === 'queue:enqueue') { window.__enq.push(JSON.parse(JSON.stringify(payload))); return window.__enqReply; } return original(channel, payload, opts); };
      window.__origApi = original;
    })()`);
    await ev("BF.ui.selectTab('export')");
    // seleção: desmarca o 02 e marca o pendente 03 (selecionados em vez de só os aprovados)
    await ev(`document.querySelector('#exp-cuts li[data-id="${ids[1]}"] input').click()`);
    await ev(`document.querySelector('#exp-cuts li[data-id="${ids[2]}"] input').click()`);
    await waitFor(page, "/Adicionar à fila \\(2\\)/.test(document.getElementById('exp-enqueue').textContent)", 20000, 'contagem = selecionados');
    assert.match(await text('#exp-cuts li.exp-cut-default ~ li:last-child'), /03 · Quase/);
    await waitQc(/pronto/);
    await click('#exp-enqueue');
    await waitFor(page, 'window.__enq.length === 1', 20000, 'queue:enqueue chamado');
    const enq = (await ev('window.__enq'))[0];
    assert.deepEqual(Object.keys(enq), ['jobs']);
    assert.deepEqual(enq.jobs.map((j) => j.cut.id), [ids[0], ids[2]], 'os selecionados (01 e 03), em ordem cronológica');
    const [j1, j3] = enq.jobs;
    assert.deepEqual(Object.keys(j1).sort(), ['baseName', 'createdAt', 'cut', 'framing', 'framingSource', 'id', 'onConflict', 'outputDir', 'profile', 'projectId', 'projectTitle', 'sourceInfo', 'sourcePath']);
    assert.equal(j1.sourcePath, source);
    assert.deepEqual(j1.sourceInfo, { width: 1920, height: 1080, fps: 10, duration: 20, hasAudio: true });
    assert.equal(j1.projectId, (await project()).id);
    assert.equal(j1.projectTitle, 'gameplay');
    assert.equal(j1.baseName, 'gameplay - corte 01 - Clutch final');
    assert.equal(j3.baseName, 'gameplay - corte 03 - Quase');
    assert.equal(j1.outputDir, out);
    assert.equal(j1.onConflict, 'ask');
    assert.equal(j1.profile.id, 'vertical-1080-h264');
    assert.deepEqual([j1.profile.width, j1.profile.height, j1.profile.codec, j1.profile.bitrateKbps], [1080, 1920, 'h264', 10000]);
    assert.equal(j1.cut.title, 'Clutch final');
    assert.equal(j1.cut.start, 2);
    assert.equal(j1.cut.framing, null);
    assert.equal(j1.framing.mode, 'center');
    assert.equal(j1.framing.zoom, 1);
    assert.equal(j3.framing.mode, 'center');
    assert.equal(await ev("document.getElementById('tab-queue').getAttribute('aria-selected')"), 'true', 'levou à aba Fila');
    step('Adicionar à fila: Jobs (3.3) montados só com os cortes selecionados, nome pelo modelo, perfil e enquadramento resolvidos; vai para a aba Fila');

    // o corte 02 tem zoom próprio: o Job leva o enquadramento do corte, e o perfil/padrão não mudam
    await ev("BF.ui.selectTab('export')");
    await ev(`document.querySelector('#exp-cuts li[data-id="${ids[1]}"] input').click()`);
    await ev(`document.querySelector('#exp-cuts li[data-id="${ids[2]}"] input').click()`);
    await waitFor(page, "/Adicionar à fila \\(2\\)/.test(document.getElementById('exp-enqueue').textContent)", 20000);
    await waitQc(/pronto/);
    await click('#exp-enqueue');
    await waitFor(page, 'window.__enq.length === 2', 20000);
    const enq2 = (await ev('window.__enq'))[1];
    assert.deepEqual(enq2.jobs.map((j) => j.cut.id), [ids[0], ids[1]]);
    assert.equal(enq2.jobs[1].framing.zoom, 1.5, 'zoom do corte 02');
    assert.deepEqual(enq2.jobs[1].cut.framing, { zoom: 1.5 });
    assert.equal(enq2.jobs[0].framing.zoom, 1);

    // fila ausente: erro claro, sem fingir
    await ev("BF.ui.selectTab('export')");
    await ev("window.__enqReply = { ok: false, code: 'IPC_ERROR', message: \"Falha na comunicação com o app (queue:enqueue): No handler registered for 'queue:enqueue'\" }; BF.ui.selectTab('export'); true");
    await waitQc(/pronto/);
    await click('#exp-enqueue');
    await waitFor(page, "document.getElementById('exp-msg').classList.contains('error')", 20000, 'mensagem de erro da fila');
    assert.match(await text('#exp-msg'), /fila de exportação não está disponível.*nada foi enviado/);
    assert.equal(await ev("document.getElementById('tab-export').getAttribute('aria-selected')"), 'true', 'continua na aba Exportar');
    assert.equal(await ev('window.__enq.length'), 3);
    // fila que recusa
    await ev("window.__enqReply = { ok: false, code: 'INVALID_JOB', message: 'Trabalho inválido na posição 1.' }");
    await click('#exp-enqueue');
    await waitFor(page, "/não aceitou os cortes: Trabalho inválido/.test(document.getElementById('exp-msg').textContent)", 20000);
    // fila que pula um já exportado
    await ev("window.__enqReply = { ok: true, jobs: [{ state: 'queued' }, { state: 'skipped' }] }");
    await click('#exp-enqueue');
    await waitFor(page, "document.getElementById('tab-queue').getAttribute('aria-selected') === 'true'", 20000);
    assert.match(await ev("document.getElementById('toasts').textContent"), /1 corte\(s\) na fila; 1 já estava/);
    step('fila ausente ou recusando: mensagem clara e nenhuma falsa confirmação; "já exportado" é informado');
    await ev("BF.api = window.__origApi; BF.ui.selectTab('export'); true");

    // ---------- de ponta a ponta com a fila de verdade (sem interceptar) ----------
    const queueUp = await ev("BF.api('queue:list').then((r) => r.ok === true)");
    if (!queueUp) {
      step('(pulado) a fila do processo principal ainda não está registrada neste build');
    } else {
      await ev("BF.ui.selectTab('export')");
      try {
        await waitFor(page, "/Adicionar à fila \\(2\\)/.test(document.getElementById('exp-enqueue').textContent) && !document.getElementById('exp-enqueue').disabled", 25000, 'botão pronto');
      } catch (err) {
        throw new Error(`${err.message} | estado: ${J(await ev("({ b: document.getElementById('exp-enqueue').textContent, d: document.getElementById('exp-enqueue').disabled, why: document.getElementById('exp-enqueue-why').textContent, qc: document.getElementById('exp-qc-status').textContent, checks: [...document.querySelectorAll('#exp-cuts input')].map((i) => i.checked) })"))}`);
      }
      await click('#exp-enqueue');
      const f1 = path.join(out, 'gameplay - corte 01 - Clutch final.mp4');
      const f2 = path.join(out, 'gameplay - corte 02 - Ace no bomb.mp4');
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline && !(fs.existsSync(f1) && fs.existsSync(f2) && !fs.readdirSync(out).some((n) => n.endsWith('.part')))) await sleep(300);
      assert.ok(fs.existsSync(f1) && fs.existsSync(f2), `a fila exportou os dois cortes (pasta: ${fs.existsSync(out) ? fs.readdirSync(out) : 'não existe'})`);
      assert.deepEqual(fs.readdirSync(out).sort(), ['gameplay - corte 01 - Clutch final.mp4', 'gameplay - corte 02 - Ace no bomb.mp4']);
      const i1 = await fx.probe(f1);
      const i2 = await fx.probe(f2);
      assert.deepEqual([i1.width, i1.height, i1.videoCodec, i1.hasAudio], [1080, 1920, 'h264', true]);
      near(i1.duration, 4, 0.3, 'duração do corte 01');
      near(i2.duration, 5, 0.3, 'duração do corte 02');
      // o enquadramento chegou ao arquivo: o corte 02 tem zoom 1,5 (mostra menos da altura da fonte que o corte 01)
      const top1 = fx.avg(fx.decodeFile(f1, 1080, 1920, { ss: 1 }), 540, 6, 1);
      const top2 = fx.avg(fx.decodeFile(f2, 1080, 1920, { ss: 1 }), 540, 6, 1);
      near(top1, 0, 14, 'corte 01 (zoom 1): topo mostra y=0 da fonte');
      near(top2, 255 * (0.5 - 1 / 1.5 / 2), 14, 'corte 02 (zoom 1,5): topo mostra y=0,17 da fonte');
      // a aba Fila anota a exportação no corte
      await waitFor(page, `BF.project.cut(${J(ids[0])}).exports.length === 1 && BF.project.cut(${J(ids[1])}).exports.length === 1`, 30000, 'exportações anotadas nos cortes');
      assert.equal((await project()).cuts.find((c) => c.id === ids[0]).exports[0].path, f1);
      step('de ponta a ponta com a fila de verdade: QC + runExportJob geram os dois arquivos com o enquadramento certo');
    }

    // ---------- sem FFmpeg (some depois de aberto): ação desabilitada com o motivo ----------
    await ev("BF.ui.selectTab('export'); window.__tools = { ...BF.state.tools }; BF.state.tools = { ...BF.state.tools, ffmpeg: null }; BF.bus.emit('tools:changed', { tools: BF.state.tools }); true");
    await waitFor(page, "document.getElementById('exp-enqueue').disabled && /FFmpeg não encontrado/.test(document.getElementById('exp-enqueue-why').textContent)", 10000, 'ação desabilitada sem FFmpeg');
    assert.equal(await ev("document.getElementById('exp-encoder-recheck').hidden"), true);
    await ev("BF.state.tools = window.__tools; BF.bus.emit('tools:changed', { tools: BF.state.tools }); true");
    await waitFor(page, "!document.getElementById('exp-enqueue').disabled", 25000, 'ação liberada com o FFmpeg de volta');
    step('sem FFmpeg: botão desabilitado explicando o motivo; volta ao normal quando ele reaparece');

    // ---------- persistência ----------
    await ev("BF.project.flush()");
    await shot(page, '5-final');
    const savedProject = await project();
    assert.equal(savedProject.ext.export.profileId, 'vertical-1080-h264');
    assert.equal(savedProject.cuts.find((c) => c.id === ids[1]).framing.zoom, 1.5);
    h.assertNoConsoleErrors(page);
    await app.stop();

    app = await h.launchApp(userData);
    page = app.page;
    await ev(`BF.openSource(${J(source)})`);
    await waitFor(page, "BF.state.project && BF.state.project.cuts.length === 4", 20000, 'projeto reaberto');
    await ev("BF.ui.selectTab('export')");
    await waitFor(page, "document.querySelectorAll('#exp-profile option').length === 13", 15000, 'perfis (incl. o do usuário)');
    assert.equal(await ev("document.getElementById('exp-profile').value"), 'vertical-1080-h264', 'perfil escolhido restaurado');
    await waitFor(page, `!!document.querySelector('#exp-cuts li[data-id="${ids[1]}"] .exp-badge')`, 5000);
    await waitPreview();
    step('após reiniciar: perfil, perfis do usuário e enquadramentos por corte restaurados');

    // ---------- preferências: export.profileId e export.framing.mode para um projeto novo ----------
    await ev(`(() => { const base = BF.prefs.get; BF.prefs.get = (k, f) => (k === 'export.profileId' ? 'vertical-1440-h264' : k === 'export.framing.mode' ? 'blur' : base(k, f)); })()`);
    await ev(`BF.openSource(${J(second)})`);
    await waitFor(page, `BF.state.project && BF.state.project.source.path === ${J(second)}`, 20000);
    await ev("BF.project.addCut({ title: 'Único', start: 1, end: 3 }); BF.project.update((p) => { p.cuts[0].status = 'approved'; }, { reason: 'teste' }); BF.bus.emit('cuts:changed', {})");
    await ev("BF.ui.selectTab('export')");
    await waitFor(page, "document.getElementById('exp-profile').value === 'vertical-1440-h264'", 15000, 'perfil das preferências');
    assert.equal(await ev("document.querySelector('#tabpanel-export [data-mode=blur]').getAttribute('aria-pressed')"), 'true', 'modo das preferências');
    await waitPreview();
    await waitQc(/aviso|pronto/);
    assert.match(await text('#exp-qc'), /1280×720.*ampliada/, 'fonte menor que a saída: aviso de ampliação (blur cabe inteiro, mas o fundo...)');
    step('preferências export.profileId e export.framing.mode valem para projeto novo');

    h.assertNoConsoleErrors(page);
    step('nenhum erro de console durante toda a sessão');
    await app.stop();

    // ---------- profiles.json ilegível: os perfis do app continuam utilizáveis, com aviso na tela ----------
    const profilesFile = path.join(userData, 'profiles.json');
    fs.renameSync(profilesFile, `${profilesFile}.guardado`);
    fs.mkdirSync(profilesFile); // uma pasta no lugar do arquivo: ler dá EISDIR, e reiniciar não resolve
    app = await h.launchApp(userData);
    page = app.page;
    await ev(`BF.openSource(${J(source)})`);
    await waitFor(page, 'BF.state.project && BF.state.project.cuts.length === 4', 20000, 'projeto reaberto');
    await ev("BF.ui.selectTab('export')");
    await waitFor(page, "document.querySelectorAll('#exp-profile option').length === 12", 15000, 'os 12 perfis do app, mesmo sem ler o arquivo');
    await waitFor(page, "!document.getElementById('exp-profile-warn').hidden", 5000, 'aviso de perfis salvos que não carregaram');
    assert.match(await text('#exp-profile-warn'), /Seus perfis salvos não puderam ser carregados.*só os perfis do app aparecem/);
    assert.equal(await ev("document.getElementById('exp-profile').disabled"), false, 'o seletor continua utilizável');
    await waitFor(page, "document.getElementById('exp-enqueue').disabled === false", 30000, 'dá para exportar com os perfis do app');
    assert.doesNotMatch(await text('#exp-enqueue-why'), /não carregaram: reinicie/);
    h.assertNoConsoleErrors(page);
    step('profiles.json ilegível: os 12 perfis do app aparecem com um aviso, e a exportação continua possível');
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

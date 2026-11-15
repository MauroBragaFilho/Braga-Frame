'use strict';

/**
 * E2E da aba Legendas: abre o app Electron de verdade (perfil de usuário temporário) e percorre o fluxo inteiro:
 * o que falta (motor e modelo) -> instalar pela própria aba (downloads reais das fontes oficiais) -> gerar a legenda
 * automática de um corte (fala sintetizada pelo Windows) -> revisar (editar, dividir, juntar, excluir, adicionar,
 * desfazer, sincronia fina e grossa, tempos) -> o intervalo do corte muda e as falas acompanham (e são sinalizadas)
 * -> aparência -> prévia sobre o player -> exportação com o ffmpeg de verdade (legenda queimada e arquivos separados)
 * -> reabrir o app e achar tudo salvo.
 *
 * Uso: node tests/e2e/subtitles.e2e.js
 *   BF_E2E_SHOTDIR=C:\pasta            guarda capturas da janela
 *   BF_SUBTITLES_TEST_CACHE=C:\pasta   (desenvolvimento) pré-instala motor e modelo copiados de um cache para não baixar de novo;
 *                                       sem isto o teste baixa de verdade (motor ~8 MB, modelo tiny ~31 MB)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../subtitles-helpers');
const h = require('./helpers');
const B = require('../../src/core/subtitles/burnIn');
const F = require('../../src/core/subtitles/formats');

const { sleep, waitFor, answerModal } = h;
const CACHE = process.env.BF_SUBTITLES_TEST_CACHE || '';
const PANEL = '#tabpanel-subtitles';
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const norm = (s) => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);

async function main() {
  assert.ok(H.tools.ffmpeg && H.tools.ffprobe, 'ffmpeg/ffprobe necessários para o teste');
  const voices = H.listVoices();
  const voice = voices.find((v) => /^pt/i.test(v.culture)) || voices.find((v) => /^en/i.test(v.culture));
  assert.ok(voice, 'o Windows precisa de uma voz (System.Speech) pt-BR ou en-US para sintetizar a fala do teste');
  const lang = /^pt/i.test(voice.culture) ? 'pt' : 'en';
  const sentence = lang === 'pt'
    ? 'Olá pessoal, bem-vindos ao nosso canal. Hoje vamos jogar uma partida muito divertida. Vamos lá!'
    : 'Hello everyone, welcome to my channel. Today we are going to play a very fun game. Let us go!';
  const keywords = lang === 'pt' ? ['pessoal', 'canal', 'hoje', 'vamos', 'partida', 'divertida'] : ['everyone', 'welcome', 'channel', 'today', 'play', 'game'];

  const tmp = h.mkTemp('e2e-subs');
  const shotDir = process.env.BF_E2E_SHOTDIR;
  const shot = async (page, name) => { if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); await h.screenshot(page, path.join(shotDir, `${name}.png`)); } };
  const step = (m) => console.log(`✔ ${m}`);
  const userData = path.join(tmp, 'userdata');
  const env = { CORTE_WHISPER: '', NODE_ENV: '' };
  let app = null;

  try {
    // ---------- material: vídeo 1280x720 com 3 s de silêncio, a fala, 3 s de silêncio e 4 s de ruído ----------
    const speechWav = path.join(tmp, 'fala.wav');
    H.synthesize(sentence, voice.name, speechWav);
    const video = H.makeVideo(path.join(tmp, 'gameplay.mp4'), [{ silence: 3 }, { wav: speechWav }, { silence: 3 }, { noise: 4, amp: 0.2 }], { size: '1280x720' });
    const speechStart = video.parts[1].start;
    step(`vídeo de teste gerado (${video.duration.toFixed(1)} s; fala "${voice.name}" a partir de ${speechStart} s)`);

    if (CACHE && fs.existsSync(path.join(CACHE, 'tools', 'whisper')) && fs.existsSync(path.join(CACHE, 'models'))) {
      H.copyDir(path.join(CACHE, 'tools', 'whisper'), path.join(userData, 'tools', 'whisper'));
      H.copyDir(path.join(CACHE, 'models'), path.join(userData, 'models'));
      step('(desenvolvimento) motor e modelo pré-instalados a partir do cache; os passos de instalação pela interface são pulados');
    }
    const preinstalled = fs.existsSync(path.join(userData, 'tools', 'whisper'));

    app = await h.launchApp(userData, { env });
    let page = app.page;
    await page.eval('window.__decisions = []; BF.bus.on("decision", (d) => window.__decisions.push(d)); true');

    const open = async (file = video.file) => {
      await page.eval(`BF.openSource(${JSON.stringify(file)})`);
      await waitFor(page, "!document.getElementById('app').classList.contains('no-project')", 30000, 'vídeo aberto');
    };
    await open();
    assert.equal(await page.eval('BF.state.project.cuts.length'), 0);
    const cutId = await page.eval('BF.project.addCut({ start: 2, end: 16.5, title: "Corte da fala" }).id');
    await page.eval('BF.project.flush()');

    // ---------- a aba, sem nada instalado ----------
    assert.equal(await page.eval("document.getElementById('tab-subtitles').disabled"), false, 'com projeto a aba Legendas está liberada');
    await page.eval("BF.ui.selectTab('subtitles')");
    await waitFor(page, `!!${q(`${PANEL} .subs-cut`)} && !!${q(`${PANEL} [data-act="generate"]`)}`, 20000, 'aba desenhada');
    assert.equal(await page.eval(`${q(`${PANEL} .subs-cut`)}.value`), cutId, 'com um corte só, ele já vem escolhido');
    if (!preinstalled) {
      const needs = await page.eval(`[...document.querySelectorAll('${PANEL} .subs-need')].map((n) => n.dataset.need)`);
      assert.deepEqual(needs, ['engine', 'model'], 'a aba mostra o que falta: motor e modelo');
      const setupText = await page.eval(`${q(`${PANEL} .subs-setup`)}.textContent`);
      assert.match(setupText, /Motor de transcrição \(Whisper\)/);
      assert.match(setupText, /8,2 MB · fonte oficial/);
      assert.match(setupText, /Modelo Pequeno/);
      assert.match(setupText, /181 MB/);
      assert.equal(await page.eval(`${q(`${PANEL} [data-act="generate"]`)}.disabled`), true, 'gerar fica desabilitado até instalar');
      assert.equal(await page.eval(`${q(`${PANEL} [data-act="generate"]`)}.title`), 'Instale o motor de transcrição.');
      assert.equal(await page.eval(`${q(`${PANEL} [data-act="install-engine"]`)}.disabled`), false);
      assert.doesNotMatch(await page.eval(`${q(PANEL)}.textContent`), /Em construção|undefined|\bnull\b/);
    }
    // sem erro de console até aqui, e nenhum botão sem ação: tudo que é <button> tem ação ligada
    assert.deepEqual(await page.eval(`[...document.querySelectorAll('${PANEL} button')].filter((b) => !b.dataset.act && !b.getAttribute('aria-label') && !b.title && !b.textContent.trim()).length`), 0);
    await shot(page, 'legendas-1-faltando');
    h.assertNoConsoleErrors(page);
    step('a aba mostra o que falta (motor e modelo), com tamanho e fonte oficial, e a geração fica desabilitada');

    // ---------- instalar pela interface (downloads reais) ----------
    if (!preinstalled) {
      await page.eval(`${q(`${PANEL} [data-act="install-engine"]`)}.click()`);
      const seen = new Set();
      const end = Date.now() + 180000;
      while (Date.now() < end) {
        const v = await page.eval(`(() => { const p = ${q(`${PANEL} .subs-progress[data-kind="engine"] progress`)}; return p ? (p.hasAttribute('value') ? p.value : 'indet') : null; })()`);
        if (v === null) { if (!(await page.eval(`!!${q(`${PANEL} [data-need="engine"]`)}`))) break; } else seen.add(v);
        await sleep(40);
      }
      assert.ok([...seen].some((v) => typeof v === 'number' && v > 0 && v < 100), `a barra de download do motor mostrou progresso real: ${[...seen].slice(0, 10)}`);
      await waitFor(page, `!${q(`${PANEL} [data-need="engine"]`)}`, 60000, 'motor instalado');
      const tools = await page.eval("BF.api('tools:status')");
      const whisper = tools.tools.find((t) => t.id === 'whisper');
      assert.equal(whisper.installed, true, 'a aba Ferramentas também vê o motor instalado');
      assert.equal(whisper.active.origin, 'app');
      assert.equal(whisper.version, 'b5130');
      assert.ok(await page.eval('!!BF.state.tools.whisper'), 'BF.state.tools.whisper atualizado');
      step('motor oficial instalado pelo botão da aba (barra de progresso real); a aba Ferramentas e BF.state.tools acompanham');

      // escolher o modelo tiny (mais rápido de baixar) e baixar
      await page.eval(`(() => { const s = ${q(`${PANEL} select[data-fid="model"]`)}; s.value = 'tiny'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await waitFor(page, `/Modelo Tiny/.test(${q(`${PANEL} .subs-setup`)}.textContent)`, 10000, 'modelo tiny escolhido');
      assert.equal(await page.eval(`${q(`${PANEL} [data-act="generate"]`)}.disabled`), true);
      await page.eval(`${q(`${PANEL} [data-act="install-model"]`)}.click()`);
      const seenModel = new Set();
      const endModel = Date.now() + 180000;
      while (Date.now() < endModel) {
        const v = await page.eval(`(() => { const p = ${q(`${PANEL} .subs-progress[data-kind="model"] progress`)}; return p ? (p.hasAttribute('value') ? p.value : 'indet') : null; })()`);
        if (v === null) { if (!(await page.eval(`!!${q(`${PANEL} [data-need="model"]`)}`))) break; } else seenModel.add(v);
        await sleep(40);
      }
      assert.ok([...seenModel].some((v) => typeof v === 'number' && v > 0 && v < 100), `a barra de download do modelo mostrou progresso real: ${[...seenModel].slice(0, 10)}`);
      await waitFor(page, `!${q(`${PANEL} .subs-setup`)}`, 60000, 'nada mais falta');
      const st = await page.eval("BF.api('subtitles:status')");
      assert.equal(st.models.find((m) => m.id === 'tiny').installed, true);
      step('modelo tiny baixado da fonte oficial pelo botão da aba (SHA-256 conferido pelo instalador); a aba deixa de listar pendências');
    } else {
      await page.eval(`(() => { const s = ${q(`${PANEL} select[data-fid="model"]`)}; s.value = 'tiny'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await waitFor(page, `!${q(`${PANEL} .subs-setup`)}`, 20000, 'nada mais falta');
    }
    assert.equal(await page.eval(`${q(`${PANEL} [data-act="generate"]`)}.disabled`), false, 'agora dá para gerar');
    assert.equal(await page.eval(`${q(`${PANEL} select[data-fid="language"]`)}.value`), 'pt', 'idioma padrão: português');
    assert.equal(await page.eval(`${q(`${PANEL} select[data-fid="model"]`)}.value`), 'tiny');
    assert.equal(await page.eval(`${q(`${PANEL} select[data-fid="model"]`)}.querySelector('option[value="tiny"]').textContent`), 'Tiny ✓');
    if (lang !== 'pt') {
      await page.eval(`(() => { const s = ${q(`${PANEL} select[data-fid="language"]`)}; s.value = 'en'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await waitFor(page, `${q(`${PANEL} select[data-fid="language"]`)}.value === 'en'`);
    }
    assert.equal(await page.eval('BF.state.project.ext.subtitles.modelId'), 'tiny', 'a escolha fica no projeto (project.ext.subtitles)');

    // ---------- gerar ----------
    await page.eval(`${q(`${PANEL} [data-act="generate"]`)}.click()`);
    await waitFor(page, `!!${q(`${PANEL} .subs-gen.busy progress`)}`, 10000, 'geração começou (barra de progresso)');
    const pct = new Set();
    const gEnd = Date.now() + 120000;
    while (Date.now() < gEnd && (await page.eval(`!!${q(`${PANEL} .subs-gen.busy`)}`))) {
      pct.add(await page.eval(`(${q(`${PANEL} .subs-gen.busy progress`)} || { value: -1 }).value`));
      await sleep(30);
    }
    assert.ok([...pct].filter((v) => v >= 0).length >= 2, `o progresso da geração andou: ${[...pct]}`);
    await waitFor(page, `document.querySelectorAll('${PANEL} .cues .cue').length >= 3`, 20000, 'falas na lista');
    const subs = await page.eval('JSON.parse(JSON.stringify(BF.state.project.cuts[0].subtitles))');
    assert.equal(subs.enabled, true, 'gerar liga a legenda do corte');
    assert.deepEqual(subs.basedOn, { start: 2, end: 16.5, revision: 1 });
    assert.equal(subs.mode, 'burn');
    assert.equal(subs.generated.model, 'tiny');
    assert.equal(subs.generated.language, lang);
    assert.ok(subs.generated.start === 2 && subs.generated.end === 16.5);
    assert.ok(subs.cues.length >= 3);
    assert.deepEqual(subs.style, {
      fontFamily: 'Arial', fontSize: 64, bold: true, color: '#FFFFFF', outlineColor: '#000000', outlineWidth: 5,
      background: 'shadow', backgroundColor: '#000000', backgroundOpacity: 0.55, position: 'bottom', maxCharsPerLine: 22
    });
    const spoken = norm(subs.cues.map((c) => c.text).join(' '));
    const hit = keywords.filter((w) => spoken.includes(w));
    assert.ok(hit.length >= keywords.length - 1, `palavras reconhecidas ${hit} | ${spoken.join(' ')}`);
    assert.ok(subs.cues.every((c) => c.start >= 0 && c.end <= 14.5 + 0.01), 'tempos relativos ao corte (0 = início do corte)');
    assert.ok(Math.abs(subs.cues[0].start - (speechStart - 2)) < 0.8, `a primeira fala em ${subs.cues[0].start} s relativo ao corte (fala real em ${speechStart - 2})`);
    assert.equal(await page.eval(`${q(`${PANEL} input[data-fid="enabled"]`)}.checked`), true);
    assert.match(await page.eval("document.getElementById('log').textContent"), /Legenda gerada: \d+ falas?/);
    assert.equal(await page.eval(`${q(`${PANEL} [data-act="undo"]`)}.disabled`), false, 'dá para desfazer a geração');
    await shot(page, 'legendas-2-geradas');
    step(`legenda automática gerada: ${subs.cues.length} falas, "${subs.cues.map((c) => c.text).join(' | ')}"`);

    // ---------- prévia sobre o player ----------
    const overlay = () => page.eval(`(() => {
      const o = document.querySelector('.sub-overlay'); const f = o.querySelector('.sub-frame'); const t = o.querySelector('.sub-text');
      const fr = f.getBoundingClientRect(); const v = document.getElementById('video').getBoundingClientRect();
      const lines = [...t.querySelectorAll('.sub-line')];
      const rects = lines.map((l) => l.getBoundingClientRect());
      const box = rects.length ? { x0: Math.min(...rects.map((r) => r.left)), y0: Math.min(...rects.map((r) => r.top)), x1: Math.max(...rects.map((r) => r.right)), y1: Math.max(...rects.map((r) => r.bottom)) } : null;
      const cs = getComputedStyle(t);
      return { hidden: o.hidden, textHidden: t.hidden, lines: lines.map((l) => l.textContent), frame: { x: fr.left, y: fr.top, w: fr.width, h: fr.height }, video: { x: v.left, y: v.top, w: v.width, h: v.height },
        box, font: cs.fontFamily, size: parseFloat(cs.fontSize), weight: cs.fontWeight, color: cs.color, stroke: cs.getPropertyValue('-webkit-text-stroke-width'), shadow: cs.textShadow, guide: f.classList.contains('guide'), sample: f.classList.contains('sample') };
    })()`);
    const seekTo = async (t) => { await page.eval(`BF.player.seek(${t})`); await sleep(250); };
    const first = subs.cues[0];
    await seekTo(2 + first.start + 0.25);
    await waitFor(page, `!${q('.sub-overlay')}.hidden && !${q('.sub-text')}.hidden`, 10000, 'texto na prévia');
    let ov = await overlay();
    assert.equal(ov.hidden, false);
    assert.equal(ov.lines.join(' ').replace(/\s+/g, ' '), first.text.replace(/\s+/g, ' '), 'a prévia mostra a fala do tempo atual do player');
    assert.equal(ov.guide, true, 'com a aba aberta, o quadro de saída aparece tracejado');
    assert.ok(Math.abs(ov.frame.w / ov.frame.h - 9 / 16) < 0.01, `quadro 9:16 sobre o player (${ov.frame.w}x${ov.frame.h})`);
    assert.ok(Math.abs((ov.frame.x + ov.frame.w / 2) - (ov.video.x + ov.video.w / 2)) < 2, 'centralizado no vídeo');
    const shownH = Math.min(ov.video.h, (ov.video.w * 720) / 1280); // altura do vídeo exibido (sem as barras pretas)
    assert.ok(Math.abs(ov.frame.h - shownH) < 2, `o quadro ocupa a altura do vídeo exibido (${ov.frame.h} x ${shownH})`);
    assert.match(ov.font, /Arial/);
    assert.equal(ov.weight, '700');
    assert.ok(ov.box.y0 > ov.frame.y + ov.frame.h * 0.6 && ov.box.y1 < ov.frame.y + ov.frame.h * 0.9, 'texto na parte inferior do quadro (posição padrão)');
    assert.ok(Math.abs((ov.box.x0 + ov.box.x1) / 2 - (ov.frame.x + ov.frame.w / 2)) < ov.frame.w * 0.03, 'texto centralizado');
    await shot(page, 'legendas-3-previa');
    // fora de qualquer fala e fora do corte a prévia some
    await seekTo(2 + 0.01);
    await waitFor(page, `${q('.sub-text')}.hidden`, 5000, 'sem texto antes da primeira fala');
    await seekTo(1);
    await waitFor(page, `${q('.sub-text')}.hidden`, 5000, 'sem texto fora do corte');
    // tocando de verdade: o texto acompanha o tempo do player (amostra o que está na tela enquanto o vídeo toca)
    await page.eval(`BF.player.playRange(${2 + first.start - 0.3}, ${2 + subs.cues[1].end + 0.2}); true`);
    const shown = new Set();
    const playEnd = Date.now() + 15000;
    while (Date.now() < playEnd && !(await page.eval('BF.player.video.paused'))) {
      const o = await overlay();
      if (!o.textHidden) shown.add(o.lines.join(' ').replace(/\s+/g, ' '));
      await sleep(40);
    }
    const expectedTexts = [subs.cues[0].text, subs.cues[1].text].map((t) => t.replace(/\s+/g, ' '));
    for (const t of expectedTexts) assert.ok([...shown].includes(t), `a prévia mostrou "${t}" durante a reprodução; viu: ${[...shown]}`);
    step('prévia HTML sobre o player: quadro 9:16, fala certa em cada tempo (parado, fora do corte e tocando), posição inferior padrão');

    // ---------- revisão: editar, dividir, juntar, excluir, adicionar, desfazer ----------
    const cuesNow = () => page.eval('JSON.parse(JSON.stringify(BF.state.project.cuts[0].subtitles.cues))');
    const rows = () => page.eval(`document.querySelectorAll('${PANEL} .cues .cue').length`);
    const rowBtn = (i, act) => page.eval(`${q(`${PANEL} .cue[data-cue="${i}"] [data-act="${act}"]`)}.click()`);
    const typeText = (i, text) => page.eval(`(() => { const ta = ${q(`${PANEL} textarea[data-fid="cue${i}t"]`)}; ta.focus(); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true })); })()`);

    const before = await cuesNow();
    await typeText(0, 'Texto corrigido pelo usuário');
    await waitFor(page, `BF.state.project.cuts[0].subtitles.cues[0].text === 'Texto corrigido pelo usuário'`, 5000, 'texto salvo no projeto');
    assert.equal((await cuesNow()).length, before.length);
    await seekTo(2 + before[0].start + 0.2);
    await waitFor(page, `[...document.querySelectorAll('.sub-text .sub-line')].map((l) => l.textContent).join(' ') === 'Texto corrigido pelo usuário'`, 5000, 'prévia com o texto editado');
    assert.equal(await page.eval(`document.activeElement.dataset.fid`), 'cue0t', 'editar o texto não tira o foco do campo');

    // dividir no cursor
    const n0 = await rows();
    const t1 = (await cuesNow())[1].text;
    const caret = t1.indexOf(' '); // cursor logo depois da primeira palavra
    await page.eval(`(() => { const ta = ${q(`${PANEL} textarea[data-fid="cue1t"]`)}; ta.dispatchEvent(new Event('mouseup')); ta.setSelectionRange(${caret}, ${caret}); })()`);
    await rowBtn(1, 'split');
    await waitFor(page, `document.querySelectorAll('${PANEL} .cues .cue').length === ${n0 + 1}`, 5000, 'fala dividida');
    const afterSplit = await cuesNow();
    assert.equal(afterSplit[1].text, t1.slice(0, caret).trim());
    assert.equal(afterSplit[2].text, t1.slice(caret).trim());
    assert.equal(afterSplit[1].end, afterSplit[2].start, 'sem buraco entre as metades');
    assert.equal(await page.eval(`document.activeElement.dataset.fid`), 'cue2t', 'o foco vai para a segunda metade');
    // juntar de volta
    await rowBtn(1, 'merge');
    await waitFor(page, `document.querySelectorAll('${PANEL} .cues .cue').length === ${n0}`, 5000, 'falas juntadas');
    assert.equal((await cuesNow())[1].text.replace(/\s+/g, ' '), t1.replace(/\s+/g, ' '));
    assert.equal(await page.eval(`${q(`${PANEL} .cue[data-cue="${n0 - 1}"] [data-act="merge"]`)}.disabled`), true, 'a última não tem seguinte');
    // excluir e desfazer
    await rowBtn(0, 'delete');
    await waitFor(page, `document.querySelectorAll('${PANEL} .cues .cue').length === ${n0 - 1}`, 5000, 'fala excluída');
    await page.eval(`${q(`${PANEL} [data-act="undo"]`)}.click()`);
    await waitFor(page, `document.querySelectorAll('${PANEL} .cues .cue').length === ${n0}`, 5000, 'desfeito');
    assert.equal((await cuesNow())[0].text, 'Texto corrigido pelo usuário', 'o desfazer devolveu a fala com a edição');
    // adicionar
    await seekTo(2 + 9.5);
    await page.eval(`${q(`${PANEL} [data-act="add"]`)}.click()`);
    await waitFor(page, `document.querySelectorAll('${PANEL} .cues .cue').length === ${n0 + 1}`, 5000, 'fala adicionada');
    const added = (await cuesNow()).find((c) => c.text === '');
    assert.ok(added && Math.abs(added.start - 9.5) < 0.6 && added.end - added.start >= 1.9, `fala nova no ponto do player: ${JSON.stringify(added)}`);
    const addedIdx = (await cuesNow()).findIndex((c) => c.text === '');
    assert.equal(await page.eval(`document.activeElement.dataset.fid`), `cue${addedIdx}t`, 'o foco vai para o texto da nova fala');
    await typeText(addedIdx, 'Fala escrita à mão');
    // tempos pelo campo: aceita m:ss.cc, recusa lixo
    await page.eval(`(() => { const i = ${q(`${PANEL} input[data-fid="cue${addedIdx}s"]`)}; i.value = '0:11,25'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(page, `BF.state.project.cuts[0].subtitles.cues.some((c) => c.text === 'Fala escrita à mão' && c.start === 11.25)`, 5000, 'início ajustado por campo');
    const idxAfterTime = (await cuesNow()).findIndex((c) => c.text === 'Fala escrita à mão');
    await page.eval(`(() => { const i = ${q(`${PANEL} input[data-fid="cue${idxAfterTime}e"]`)}; i.value = 'lixo'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(page, `/formato m:ss/.test(document.getElementById('toasts').textContent)`, 5000, 'aviso de tempo inválido');
    assert.equal(await page.eval(`${q(`${PANEL} input[data-fid="cue${idxAfterTime}e"]`)}.value`).then((v) => /^\d+:\d\d\.\d\d$/.test(v)), true, 'o campo volta ao valor válido');
    // apagar a fala escrita à mão deixa a lista como estava
    await rowBtn(idxAfterTime, 'delete');
    await waitFor(page, `document.querySelectorAll('${PANEL} .cues .cue').length === ${n0}`, 5000);

    // sincronia fina e grossa
    const base = await cuesNow();
    const shiftBtn = (d) => page.eval(`${q(`${PANEL} [data-act="shift"][data-delta="${d}"]`)}.click()`);
    await shiftBtn(0.1); await shiftBtn(0.1); await shiftBtn(0.1);
    await waitFor(page, `Math.abs(BF.state.project.cuts[0].subtitles.cues[0].start - ${base[0].start + 0.3}) < 0.001`, 5000, '+0,3 s');
    await shiftBtn(-1);
    await waitFor(page, `Math.abs(BF.state.project.cuts[0].subtitles.cues[0].start - ${base[0].start - 0.7}) < 0.001`, 5000, '-1 s');
    const shifted = await cuesNow();
    assert.ok(shifted.every((c, i) => Math.abs(c.start - (base[i].start - 0.7)) < 0.002 && Math.abs(c.end - (base[i].end - 0.7)) < 0.002), 'todas as falas deslocaram juntas');
    await shiftBtn(1); await shiftBtn(0.1); await shiftBtn(-0.1); // +1, e a fina de ida e volta
    await waitFor(page, `Math.abs(BF.state.project.cuts[0].subtitles.cues[0].start - ${base[0].start + 0.3}) < 0.002`, 5000);
    // desfazer em sequência volta aos poucos
    for (let i = 0; i < 3; i++) await page.eval(`${q(`${PANEL} [data-act="undo"]`)}.click()`);
    await waitFor(page, `Math.abs(BF.state.project.cuts[0].subtitles.cues[0].start - ${base[0].start - 0.7}) < 0.002`, 5000, 'desfez 3 deslocamentos');
    await page.eval(`${q(`${PANEL} [data-act="shift"][data-delta="1"]`)}.click()`);
    await page.eval(`${q(`${PANEL} [data-act="shift"][data-delta="-0.1"]`)}.click()`);
    await page.eval(`${q(`${PANEL} [data-act="shift"][data-delta="-0.1"]`)}.click()`);
    await page.eval(`${q(`${PANEL} [data-act="shift"][data-delta="-0.1"]`)}.click()`);
    await waitFor(page, `Math.abs(BF.state.project.cuts[0].subtitles.cues[0].start - ${base[0].start}) < 0.002`, 5000, 'de volta ao original');
    const shiftDecisions = await page.eval('window.__decisions.filter((d) => d.type === "adjust" && d.after.action === "shift").length');
    assert.ok(shiftDecisions >= 5, `o ajuste de sincronia gera "decision" do tipo adjust (${shiftDecisions})`);
    assert.ok(await page.eval('window.__decisions.every((d) => d.type !== "adjust" || d.after.what === "subtitles")'), 'os adjust da legenda se identificam com what: subtitles');
    step('revisão: editar texto (foco mantido), dividir no cursor, juntar, excluir + desfazer, adicionar no ponto do player, tempos por campo (válido e inválido), sincronia fina e grossa com desfazer');

    // ---------- gerar de novo: pede confirmação (substitui as edições) e dá para desfazer ----------
    const editedNow = await cuesNow();
    await page.eval(`${q(`${PANEL} [data-act="generate"]`)}.click()`);
    const asked = await answerModal(page, false);
    assert.equal(asked.title, 'Gerar a legenda de novo?');
    assert.match(asked.message, new RegExp(`As ${editedNow.length} falas atuais`));
    assert.match(asked.message, /Desfazer/);
    await sleep(300);
    assert.deepEqual(await cuesNow(), editedNow, 'cancelar a confirmação não muda nada');
    assert.equal(await page.eval(`!!${q(`${PANEL} .subs-gen.busy`)}`), false);
    await page.eval(`${q(`${PANEL} [data-act="generate"]`)}.click()`);
    await answerModal(page, true);
    await waitFor(page, `!${q(`${PANEL} .subs-gen.busy`)} && BF.state.project.cuts[0].subtitles.cues[0].text !== 'Texto corrigido pelo usuário'`, 60000, 'geração de novo concluída');
    assert.ok(!(await cuesNow()).some((c) => c.text === 'Texto corrigido pelo usuário'), 'as falas foram substituídas pelas novas');
    await page.eval(`${q(`${PANEL} [data-act="undo"]`)}.click()`);
    await waitFor(page, `BF.state.project.cuts[0].subtitles.cues[0].text === 'Texto corrigido pelo usuário'`, 5000, 'desfazer devolve as edições');
    assert.deepEqual(await cuesNow(), editedNow, 'o desfazer devolveu exatamente as falas de antes da nova geração');
    step('gerar de novo pede confirmação (cancelar não muda nada) e o Desfazer devolve as edições');

    // ---------- fala para revisar ----------
    await page.eval(`BF.project.update((p) => { p.cuts[0].subtitles.cues[1].needsReview = true; }, { reason: 'teste' }); BF.bus.emit('cuts:changed', { ids: ['${cutId}'] }); true`);
    await waitFor(page, `!!${q(`${PANEL} .cue.review [data-act="reviewed"]`)}`, 5000, 'fala marcada para revisão');
    assert.match(await page.eval(`${q(`${PANEL} [data-note="review"]`)}.textContent`), /1 fala para revisar/);
    assert.equal(await page.eval("document.querySelector('#tab-subtitles .tab-badge').textContent"), '1', 'a aba mostra quantas falas pedem revisão');
    await page.eval(`${q(`${PANEL} [data-act="reviewed"]`)}.click()`);
    await waitFor(page, `!${q(`${PANEL} .cue.review`)}`, 5000, 'marcada como revisada');
    assert.equal(await page.eval("document.querySelector('#tab-subtitles .tab-badge').hidden"), true);
    assert.equal((await cuesNow())[1].needsReview, undefined);

    // ---------- o intervalo do corte muda: as falas acompanham e as afetadas são sinalizadas ----------
    const snap = await cuesNow();
    await page.eval(`BF.project.update((p) => { const c = p.cuts[0]; c.start = 5; c.revision += 1; }, { reason: 'review:time' }); BF.bus.emit('cuts:changed', { ids: ['${cutId}'], from: 'cuts:time' }); true`);
    await waitFor(page, `BF.state.project.cuts[0].subtitles.basedOn.start === 5`, 5000, 'falas acompanharam o novo início');
    const moved = await cuesNow();
    assert.equal(moved.length, snap.length, 'nada foi descartado');
    const dur2 = 16.5 - 5;
    assert.ok(moved.every((c, i) => Math.abs(c.text === snap[i].text ? 0 : 1) === 0), 'o texto continua o mesmo');
    snap.forEach((c, i) => {
      const s = c.start - 3; const e = c.end - 3; // o corte começa 3 s depois: tudo desloca 3 s para trás
      const inside = s >= 0 && e <= dur2;
      if (inside) {
        assert.ok(Math.abs(moved[i].start - s) < 0.002 && !moved[i].needsReview, `fala ${i} só foi deslocada`);
      } else {
        assert.equal(moved[i].needsReview, true, `fala ${i} afetada pelo recorte foi sinalizada`);
      }
    });
    const flagged = moved.filter((c) => c.needsReview).length;
    assert.ok(flagged >= 1 && flagged < moved.length, `algumas falas afetadas (${flagged} de ${moved.length})`);
    assert.equal(await page.eval(`document.querySelectorAll('${PANEL} .cue.review').length`), flagged);
    assert.ok(await page.eval(`document.querySelectorAll('${PANEL} .cue.outside').length`) >= 1, 'a que ficou totalmente fora continua na lista, identificada como fora do corte');
    assert.match(await page.eval(`${q(`${PANEL} .cue.outside .cue-tag`)}.textContent`), /fora do corte/);
    assert.match(await page.eval(`${q(`${PANEL} [data-note="outside"]`)}.textContent`), /fora do corte e não entra/);
    assert.match(await page.eval(`${q(`${PANEL} [data-note="rebase"]`)}.textContent`), /O intervalo do corte mudou/);
    assert.match(await page.eval("document.getElementById('toasts').textContent"), /Marquei para revisão; nada foi apagado/);
    assert.deepEqual(await page.eval('BF.state.project.cuts[0].subtitles.basedOn'), { start: 5, end: 16.5, revision: 2 });
    await shot(page, 'legendas-4-corte-mudou');
    // o corte volta ao início de antes: as falas que tinham saído voltam aos tempos originais (e continuam marcadas)
    await page.eval(`BF.project.update((p) => { const c = p.cuts[0]; c.start = 2; c.revision += 1; }, { reason: 'review:time' }); BF.bus.emit('cuts:changed', { ids: ['${cutId}'], from: 'cuts:time' }); true`);
    await waitFor(page, `BF.state.project.cuts[0].subtitles.basedOn.start === 2`, 5000);
    const back = await cuesNow();
    assert.ok(back.every((c, i) => Math.abs(c.start - snap[i].start) < 0.002 && Math.abs(c.end - snap[i].end) < 0.002), 'as falas voltaram EXATAMENTE aos tempos de antes (nada foi recortado de forma permanente)');
    // o fim passa a cobrir mais do que foi legendado: aviso de trecho sem transcrição (não bloqueia)
    await page.eval(`BF.project.update((p) => { const c = p.cuts[0]; c.start = 0; c.revision += 1; }, { reason: 'review:time' }); BF.bus.emit('cuts:changed', { ids: ['${cutId}'], from: 'cuts:time' }); true`);
    await waitFor(page, `!!${q(`${PANEL} [data-note="uncovered"]`)}`, 5000, 'aviso de trecho sem legenda automática');
    assert.match(await page.eval(`${q(`${PANEL} [data-note="uncovered"]`)}.textContent`), /2,0 s no início/);
    await page.eval(`BF.project.update((p) => { const c = p.cuts[0]; c.start = 2; c.revision += 1; }, { reason: 'review:time' }); BF.bus.emit('cuts:changed', { ids: ['${cutId}'], from: 'cuts:time' }); true`);
    await waitFor(page, `BF.state.project.cuts[0].subtitles.basedOn.start === 2 && !${q(`${PANEL} [data-note="uncovered"]`)}`, 5000);
    step('o intervalo do corte muda: as falas acompanham (deslocadas, sem recorte permanente), as afetadas ficam marcadas, nada é descartado, o trecho novo sem transcrição é avisado e tudo volta quando o corte volta');

    // marcar as afetadas pelo intervalo como revisadas para os próximos passos
    for (let i = 0; i < 12; i++) {
      if (!(await page.eval(`!!${q(`${PANEL} [data-act="reviewed"]`)}`))) break;
      await page.eval(`${q(`${PANEL} [data-act="reviewed"]`)}.click()`);
      await sleep(80);
    }

    // ---------- aparência ----------
    await page.eval(`${q(`${PANEL} details[data-section="style"] summary`)}.click()`);
    await waitFor(page, `${q(`${PANEL} details[data-section="style"]`)}.open`, 5000);
    await seekTo(2 + 0.02); // sem fala no ar: a prévia mostra um exemplo enquanto a aparência está aberta
    await waitFor(page, `!${q('.sub-text')}.hidden && ${q('.sub-frame')}.classList.contains('sample')`, 5000, 'exemplo na prévia');
    const setSel = (fid, v) => page.eval(`(() => { const s = ${q(`${PANEL} [data-fid="${fid}"]`)}; s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const setRange = (fid, v) => page.eval(`(() => { const s = ${q(`${PANEL} [data-fid="${fid}"]`)}; s.value = ${v}; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const setColor = (fid, v) => page.eval(`(() => { const s = ${q(`${PANEL} [data-fid="${fid}"]`)}; s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const styleNow = () => page.eval('JSON.parse(JSON.stringify(BF.state.project.cuts[0].subtitles.style))');

    await setSel('position', 'top');
    await setRange('size', 96);
    await setColor('color', '#ffcc00');
    await setSel('bg', 'box');
    await waitFor(page, `${q(`${PANEL} [data-fid="bg-color"]`)} !== null`, 5000, 'campos da caixa');
    await setColor('bg-color', '#112233');
    await setRange('bg-opacity', 80);
    await setRange('outline', 3);
    await setRange('chars', 16);
    await setSel('font', 'Impact');
    await page.eval(`(() => { const c = ${q(`${PANEL} [data-fid="bold"]`)}; c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(300);
    const st = await styleNow();
    assert.deepEqual(st, { fontFamily: st.fontFamily, fontSize: 96, bold: false, color: '#FFCC00', outlineColor: '#000000', outlineWidth: 3, background: 'box', backgroundColor: '#112233', backgroundOpacity: 0.8, position: 'top', maxCharsPerLine: 16 });
    const fontAvailable = await page.eval("BF.api('subtitles:status').then((s) => s.fonts.find((f) => f.name === 'Impact').available)");
    assert.equal(st.fontFamily, fontAvailable ? 'Impact' : 'Arial', 'só oferece fontes que existem neste computador');
    ov = await overlay();
    assert.ok(ov.sample, 'exemplo na prévia');
    assert.equal(ov.weight, '400');
    assert.equal(ov.color, 'rgb(255, 204, 0)');
    assert.ok(ov.box.y1 < ov.frame.y + ov.frame.h * 0.35, 'posição superior');
    // a prévia escala com o quadro do player: tamanho do ASS (96) x lado menor do quadro / 1080 x fator do CSS (0,89); legível (>= 8 px)
    const expectedSize = 96 * (Math.min(ov.frame.w, ov.frame.h) / 1080) * 0.89;
    assert.ok(Math.abs(ov.size - expectedSize) / expectedSize < 0.05, `a fonte da prévia acompanha o quadro (${ov.size.toFixed(2)}px; esperado ${expectedSize.toFixed(2)}px para um quadro de ${ov.frame.w.toFixed(0)}x${ov.frame.h.toFixed(0)})`);
    assert.ok(ov.size >= 8, `e continua legível (${ov.size}px)`);
    assert.ok(ov.lines.length >= 1 && ov.lines.every((l) => l.length <= 16), `máximo de 16 caracteres por linha: ${ov.lines}`);
    const adjusts = await page.eval('window.__decisions.filter((d) => d.type === "adjust" && d.after.style).length');
    assert.ok(adjusts >= 8, `cada ajuste de aparência vira um adjust no histórico (${adjusts})`);
    assert.equal(await page.eval('BF.state.project.ext.subtitles.style.position'), 'top', 'a última aparência vira o padrão dos próximos cortes (project.ext.subtitles.style)');
    await page.eval(`${q(`${PANEL} details[data-section="style"]`)}.scrollIntoView({ block: 'start' }); true`);
    await sleep(200);
    await shot(page, 'legendas-5-aparencia');

    // volta ao visual padrão para a comparação com o ffmpeg abaixo (posição inferior, texto branco com contorno)
    await setSel('position', 'bottom'); await setSel('bg', 'shadow'); await setSel('font', 'Arial'); await setRange('size', 64);
    await setColor('color', '#ffffff'); await setRange('outline', 5); await setRange('chars', 22);
    await page.eval(`(() => { const c = ${q(`${PANEL} [data-fid="bold"]`)}; c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(200);
    await page.eval(`${q(`${PANEL} details[data-section="style"] summary`)}.click()`);
    step('aparência: fonte, tamanho, cor, contorno, fundo (sombra/caixa), posição, negrito e caracteres por linha mudam o estilo do corte, a prévia e o histórico (adjust)');

    // ---------- entrega ----------
    await setSel('mode', 'both');
    await page.eval(`${q(`${PANEL} details[data-section="more"] summary`)}.click()`);
    await setSel('sidecar', 'ass');
    await waitFor(page, `BF.state.project.cuts[0].subtitles.sidecarFormat === 'ass' && BF.state.project.cuts[0].subtitles.mode === 'both'`, 5000);
    assert.match(await page.eval(`${q(`${PANEL} [data-note="summary"]`)}.textContent`), /gravada no vídeo e arquivo \.ass ao lado/);
    await setSel('sidecar', 'srt');
    await setSel('mode', 'sidecar');
    assert.match(await page.eval(`${q(`${PANEL} [data-note="summary"]`)}.textContent`), /arquivo \.srt ao lado do vídeo/);
    await setSel('mode', 'both');
    await page.eval('BF.project.flush()');

    // ---------- exportação de verdade (com o ffmpeg) a partir do estado que a interface gravou ----------
    const cutData = await page.eval('JSON.parse(JSON.stringify(BF.state.project.cuts[0]))');
    const W = 1080; const Hh = 1920;
    const work = path.join(tmp, 'job');
    const job = B.prepareBurnIn(cutData, { tmpDir: work, width: W, height: Hh });
    assert.ok(job.vfFilter && job.sidecars.length === 1 && job.sidecars[0].ext === 'srt');
    const exported = path.join(tmp, 'export.mp4');
    const dur = cutData.end - cutData.start;
    H.ffmpeg(['-ss', String(cutData.start), '-t', String(dur), '-i', video.file, '-filter_complex',
      `[0:v]scale=${W}:${Hh}:force_original_aspect_ratio=increase,crop=${W}:${Hh},setsar=1,${job.vfFilter},format=yuv420p[vout]`, '-map', '[vout]', '-an', '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', exported]);
    const plain = path.join(tmp, 'plain.mp4');
    H.ffmpeg(['-ss', String(cutData.start), '-t', String(dur), '-i', video.file, '-filter_complex',
      `[0:v]scale=${W}:${Hh}:force_original_aspect_ratio=increase,crop=${W}:${Hh},setsar=1,format=yuv420p[vout]`, '-map', '[vout]', '-an', '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', plain]);
    const c0 = cutData.subtitles.cues[0];
    const mid = (c0.start + c0.end) / 2;
    const withText = H.diffBox(H.grayFrame(plain, mid, { width: W, height: Hh }), H.grayFrame(exported, mid, { width: W, height: Hh }), W, Hh, 40);
    assert.ok(withText && withText.count > 800, 'o vídeo exportado tem a legenda na fala');
    const gapStart = cutData.subtitles.cues.at(-1).end + 0.4;
    if (gapStart < dur - 0.3) assert.equal(H.diffBox(H.grayFrame(plain, gapStart, { width: W, height: Hh }), H.grayFrame(exported, gapStart, { width: W, height: Hh }), W, Hh, 40), null, 'sem legenda depois da última fala');
    assert.ok(withText.y0 > Hh * 0.7 && withText.y1 < Hh * 0.9, `legenda embaixo no vídeo exportado (y ${withText.y0}..${withText.y1})`);
    const srt = F.parseSrt(fs.readFileSync(job.sidecars[0].path, 'utf8'));
    assert.deepEqual(srt.map((c) => c.text.replace(/\s+/g, ' ')), cutData.subtitles.cues.map((c) => c.text.replace(/\s+/g, ' ')), 'o arquivo separado tem as mesmas falas');
    step('exportação real a partir do estado da interface: legenda queimada na hora e no lugar certos e arquivo .srt separado com as mesmas falas');

    // ---------- prévia x exportação: mesma posição e tamanho ----------
    await seekTo(2 + mid);
    await waitFor(page, `!${q('.sub-text')}.hidden && ${q('.sub-text')}.textContent.trim().length > 0 && !${q('.sub-frame')}.classList.contains('sample')`, 5000, 'texto da fala na prévia');
    ov = await overlay();
    const fr = (v, a, size) => (v - a) / size;
    const prevCenterY = fr((ov.box.y0 + ov.box.y1) / 2, ov.frame.y, ov.frame.h);
    const prevW = (ov.box.x1 - ov.box.x0) / ov.frame.w;
    const prevH = (ov.box.y1 - ov.box.y0) / ov.frame.h;
    const exCenterY = (withText.y0 + withText.y1) / 2 / Hh;
    const exW = withText.w / W;
    const exH = withText.h / Hh;
    const info = `prévia: centro ${prevCenterY.toFixed(3)} largura ${prevW.toFixed(3)} altura ${prevH.toFixed(3)} | exportado: centro ${exCenterY.toFixed(3)} largura ${exW.toFixed(3)} altura ${exH.toFixed(3)}`;
    console.log(`   ${info}`);
    assert.ok(Math.abs(prevCenterY - exCenterY) < 0.03, `posição vertical da prévia bate com a exportação. ${info}`);
    assert.ok(Math.abs(prevW - exW) / exW < 0.12, `largura do texto da prévia bate com a exportação (±12%). ${info}`);
    assert.ok(Math.abs(prevH - exH) / exH < 0.2, `altura do texto da prévia bate com a exportação (±20%). ${info}`);
    step('a prévia sobre o player bate com o vídeo exportado (posição e tamanho do texto)');

    // ---------- cancelar a geração pela interface (vídeo longo, outro projeto) ----------
    {
      await page.eval('BF.project.flush()');
      const longVideo = H.makeVideo(path.join(tmp, 'longo.mp4'), Array.from({ length: 8 }, () => ({ wav: speechWav })), { size: '640x360' });
      await open(longVideo.file);
      const longCut = await page.eval(`BF.project.addCut({ start: 0, end: ${longVideo.duration.toFixed(1)}, title: 'Longo' }).id`);
      await page.eval("BF.ui.selectTab('subtitles')");
      await waitFor(page, `!!${q(`${PANEL} [data-act="generate"]`)} && !${q(`${PANEL} [data-act="generate"]`)}.disabled`, 20000, 'botão de gerar liberado');
      await page.eval(`${q(`${PANEL} [data-act="generate"]`)}.click()`); // sem falas: sem confirmação
      await waitFor(page, `!!${q(`${PANEL} [data-act="cancel-generate"]`)}`, 10000, 'botão Cancelar da geração');
      await waitFor(page, `/Transcrevendo/.test(${q(`${PANEL} .subs-gen.busy`)}.textContent)`, 30000, 'transcrevendo');
      await page.eval(`${q(`${PANEL} [data-act="cancel-generate"]`)}.click()`);
      await waitFor(page, `!${q(`${PANEL} .subs-gen.busy`)}`, 30000, 'geração cancelada');
      assert.match(await page.eval(`${q(PANEL)}.textContent`), /Geração cancelada. Nada foi alterado./);
      assert.equal(await page.eval('BF.state.project.cuts[0].subtitles'), null, 'cancelar não deixa legenda nenhuma no corte');
      assert.equal(await page.eval(`${q(`${PANEL} [data-act="generate"]`)}.disabled`), false, 'dá para gerar de novo depois de cancelar');
      assert.deepEqual(H.listTree(path.join(userData, 'cache')).filter((p) => /sub-/.test(p)), [], 'nenhuma pasta de trabalho sobrou');
      void longCut;
      await page.eval('BF.project.flush()');
      await open();
      await page.eval("BF.ui.selectTab('subtitles')");
      await waitFor(page, `document.querySelectorAll('${PANEL} .cues .cue').length > 0`, 20000, 'voltou ao projeto da fala');
      step('cancelar a geração pelo botão: nada é alterado, nada sobra, dá para gerar de novo');
    }

    // ---------- FFmpeg sem libass: a aba mostra o motivo e não oferece a entrega incorporada ----------
    {
      // a resposta de subtitles:status é adulterada na página (o ffmpeg desta máquina tem libass; o lado do processo principal é testado com o suporte injetado)
      await page.eval(`(() => { window.__realApi = BF.api; BF.api = async (channel, payload, opts) => { const res = await window.__realApi(channel, payload, opts); if (channel === 'subtitles:status' && res.ok) res.burnIn = { supported: false, reason: ${JSON.stringify(B.UNSUPPORTED_REASON)} }; return res; }; })()`);
      await page.eval("BF.bus.emit('tools:changed', { tools: BF.state.tools }); true");
      await waitFor(page, `/libass/.test(${q(PANEL)}.textContent)`, 5000, 'aviso de que este FFmpeg não incorpora legenda');
      assert.deepEqual(await page.eval(`[...${q(`${PANEL} select[data-fid="mode"]`)}.options].map((o) => [o.value, o.disabled])`), [['burn', true], ['sidecar', false], ['both', true]], 'incorporada fica desabilitada; arquivo separado continua disponível');
      const warn = await page.eval(`${q(`${PANEL} .subs-top + .subs-warn`)}.textContent`);
      assert.match(warn, /filtro de legendas \(libass\)/);
      assert.match(warn, /vai falhar até você escolher "Arquivo separado"/);
      await setSel('mode', 'sidecar');
      await waitFor(page, `!${q(`${PANEL} .subs-top + .subs-warn`)}`, 5000, 'aviso some ao escolher o arquivo separado');
      assert.match(await page.eval(`${q(`${PANEL} [data-note="summary"]`)}.textContent`), /arquivo \.srt ao lado do vídeo/);
      await page.eval('BF.api = window.__realApi; BF.bus.emit("tools:changed", { tools: BF.state.tools }); true');
      await setSel('mode', 'both');
      step('sem suporte a legenda incorporada o motivo aparece com a solução, a opção fica desabilitada e o arquivo separado continua disponível');
    }

    // ---------- desligar, reabrir o app, tudo salvo ----------
    await page.eval(`(() => { const c = ${q(`${PANEL} input[data-fid="enabled"]`)}; c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(page, `BF.state.project.cuts[0].subtitles.enabled === false`, 5000);
    await waitFor(page, `${q('.sub-text')}.hidden`, 5000, 'sem legenda na prévia quando desligada');
    const cutOff = await page.eval('JSON.parse(JSON.stringify(BF.state.project.cuts[0]))');
    assert.equal(B.prepareBurnIn(cutOff, { tmpDir: path.join(tmp, 'off'), width: W, height: Hh }), null, 'legenda desligada: a exportação não aplica nada');
    await page.eval(`(() => { const c = ${q(`${PANEL} input[data-fid="enabled"]`)}; c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(page, `BF.state.project.cuts[0].subtitles.enabled === true`, 5000);
    await page.eval('BF.project.flush()');
    const saved = await page.eval('JSON.parse(JSON.stringify(BF.state.project.cuts[0].subtitles))');
    h.assertNoConsoleErrors(page);
    await app.stop();

    app = await h.launchApp(userData, { env });
    page = app.page;
    await open();
    await page.eval("BF.ui.selectTab('subtitles')");
    await waitFor(page, `document.querySelectorAll('${PANEL} .cues .cue').length === ${saved.cues.length}`, 20000, 'falas salvas');
    assert.deepEqual(await page.eval('JSON.parse(JSON.stringify(BF.state.project.cuts[0].subtitles))'), saved, 'a legenda do corte voltou exatamente como foi gravada');
    assert.equal(await page.eval(`${q(`${PANEL} select[data-fid="model"]`)}.value`), 'tiny', 'idioma e modelo escolhidos continuam');
    assert.equal(await page.eval(`!${q(`${PANEL} .subs-setup`)}`), true, 'motor e modelo continuam instalados depois de reiniciar');
    h.assertNoConsoleErrors(page);
    await shot(page, 'legendas-6-reaberto');
    step('depois de reiniciar o app: legenda, estilo, entrega, idioma e modelo continuam, motor e modelo instalados');

    // ---------- remover um modelo baixado (liberar espaço) ----------
    await page.eval(`${q(`${PANEL} details[data-section="more"] summary`)}.click()`);
    await waitFor(page, `!!${q(`${PANEL} .subs-model-row[data-model="tiny"] [data-act="remove-model"]`)}`, 10000, 'lista de modelos baixados');
    assert.match(await page.eval(`${q(`${PANEL} .subs-model-row[data-model="tiny"]`)}.textContent`), /Tiny · \d+(,\d)? MB/);
    await page.eval(`${q(`${PANEL} .subs-model-row[data-model="tiny"] [data-act="remove-model"]`)}.click()`);
    const confirmRemove = await answerModal(page, false);
    assert.equal(confirmRemove.title, 'Remover o modelo Tiny?');
    assert.match(confirmRemove.message, /baixar de novo/);
    await sleep(300);
    assert.equal(fs.existsSync(path.join(userData, 'models', 'whisper-tiny')), true, 'cancelar a confirmação não remove');
    await page.eval(`${q(`${PANEL} .subs-model-row[data-model="tiny"] [data-act="remove-model"]`)}.click()`);
    await answerModal(page, true);
    await waitFor(page, `!${q(`${PANEL} .subs-model-row[data-model="tiny"]`)} && !!${q(`${PANEL} [data-need="model"]`)}`, 15000, 'modelo removido: a aba volta a pedir o modelo');
    assert.equal(fs.existsSync(path.join(userData, 'models', 'whisper-tiny')), false, 'o arquivo do modelo foi apagado do disco');
    assert.equal(await page.eval(`${q(`${PANEL} [data-act="generate"]`)}.disabled`), true, 'sem o modelo não dá para gerar');
    assert.equal(await page.eval("BF.api('tools:status').then((t) => t.tools.find((x) => x.id === 'whisper').installed)"), true, 'o motor continua instalado (se remove na aba Ferramentas)');
    step('remover um modelo baixado pela aba: confirmação, arquivo apagado, a aba volta a pedir o modelo');

    // ---------- limpeza: nada sobrou na pasta de trabalho ----------
    await app.stop();
    app = null;
    const leftovers = H.listTree(userData).filter((p) => /\.part$|(^|\/)\.tmp\/|(^|\/)cache\/subtitles\/sub-/.test(p));
    assert.deepEqual(leftovers, [], 'nenhum .part nem pasta de trabalho esquecidos');
    console.log('\nE2E OK');
  } finally {
    await h.cleanupAll();
    await sleep(500);
    try { h.removeDir(tmp); } catch (err) { console.warn(`(aviso) não foi possível apagar ${tmp}: ${err.message}`); }
  }
}

main().then(() => process.exit(0), (err) => {
  console.error(`\n✖ E2E FALHOU: ${err.stack || err.message}`);
  h.cleanupAll().finally(() => process.exit(1));
});

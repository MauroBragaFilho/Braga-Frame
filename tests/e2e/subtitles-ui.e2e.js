'use strict';

/**
 * E2E da aba Legendas que NÃO precisa do motor nem de modelo (nada é baixado): abre o app Electron de verdade (perfil de
 * usuário temporário, vídeo gerado com o ffmpeg) e confere, pela interface, o que os testes unitários só provam por dentro:
 *
 *   1. A preferência subtitles.enabled (Preferências > Legendas) liga "Legendar este corte na exportação" nos cortes
 *      que ainda não têm legenda (antes a caixa não fazia nada);
 *   2. "Usar esta aparência nos próximos vídeos" grava a preferência subtitles.style e um projeto novo já nasce com ela
 *      (antes a preferência "definida na aba Legendas" nunca era definida);
 *   3. aparar o corte (Cortes) e desfazer (Ctrl+Z) devolve as falas das bordas com os tempos EXATOS de antes;
 *   4. fala com linha em branco no texto: o arquivo .srt separado sai inteiro (sem bloco órfão);
 *   5. fonte grande: a prévia sobre o player quebra a linha como o libass na exportação (não corta o texto) e a altura do texto
 *      bate com o vídeo exportado;
 *   6. legenda ligada sem nenhuma fala: o QC da aba Exportar AVISA (não bloqueia) que o vídeo sai sem legenda.
 *
 * Uso: node tests/e2e/subtitles-ui.e2e.js     (BF_E2E_SHOTDIR=C:\pasta guarda capturas da janela)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../subtitles-helpers');
const h = require('./helpers');
const B = require('../../src/core/subtitles/burnIn');
const F = require('../../src/core/subtitles/formats');

const { sleep, waitFor } = h;
const PANEL = '#tabpanel-subtitles';
const J = JSON.stringify;
const q = (sel) => `document.querySelector(${J(sel)})`;
const step = (m) => console.log(`✔ ${m}`);

async function main() {
  assert.ok(H.tools.ffmpeg && H.tools.ffprobe, 'ffmpeg/ffprobe necessários para o teste');
  const support = B.detectBurnInSupport(H.tools.ffmpeg);
  const tmp = h.mkTemp('e2e-subs-ui');
  const shotDir = process.env.BF_E2E_SHOTDIR;
  const shot = async (page, name) => { if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); await h.screenshot(page, path.join(shotDir, `${name}.png`)); } };
  const userData = path.join(tmp, 'userdata');
  let app = null;

  try {
    const video1 = H.makeVideo(path.join(tmp, 'um.mp4'), [{ tone: 24 }], { size: '1280x720', still: true });
    const video2 = H.makeVideo(path.join(tmp, 'dois.mp4'), [{ tone: 8 }], { size: '1280x720', still: true });
    step(`vídeos de teste gerados (${video1.duration} s e ${video2.duration} s, 1280x720)`);

    app = await h.launchApp(userData, { args: ['--mute-audio'], env: { CORTE_WHISPER: '', NODE_ENV: '' } });
    const { page } = app;
    const ev = (expr) => page.eval(expr);
    const open = async (file) => {
      await ev(`BF.openSource(${J(file)})`);
      await waitFor(page, "!document.getElementById('app').classList.contains('no-project')", 30000, 'vídeo aberto');
    };
    const addCut = (start, end, title) => ev(`BF.project.addCut({ start: ${start}, end: ${end}, title: ${J(title)} }).id`);
    const selectCut = async (id) => { await ev(`BF.bus.emit('cut:selected', { id: ${J(id)} }); true`); await waitFor(page, `${q(`${PANEL} .subs-cut`)} && ${q(`${PANEL} .subs-cut`)}.value === ${J(id)}`, 10000, 'corte escolhido na aba'); };
    const cutNow = (id) => ev(`JSON.parse(JSON.stringify(BF.project.cut(${J(id)})))`);
    const setRange = (fid, v) => ev(`(() => { const s = ${q(`${PANEL} [data-fid="${fid}"]`)}; s.value = ${v}; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const setColor = (fid, v) => ev(`(() => { const s = ${q(`${PANEL} [data-fid="${fid}"]`)}; s.value = ${J(v)}; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const toggleEnabled = (on) => ev(`(() => { const c = ${q(`${PANEL} input[data-fid="enabled"]`)}; c.checked = ${on}; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const typeText = (i, text) => ev(`(() => { const ta = ${q(`${PANEL} textarea[data-fid="cue${i}t"]`)}; ta.focus(); ta.value = ${J(text)}; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const openDetails = async (section) => {
      if (!(await ev(`${q(`${PANEL} details[data-section="${section}"]`)}.open`))) await ev(`${q(`${PANEL} details[data-section="${section}"] summary`)}.click()`);
      await waitFor(page, `${q(`${PANEL} details[data-section="${section}"]`)}.open`, 5000, `seção ${section} aberta`);
    };
    const checked = () => ev(`${q(`${PANEL} input[data-fid="enabled"]`)}.checked`);

    // ---------- 1. subtitles.enabled (Preferências) liga a legenda dos cortes que ainda não têm ----------
    await open(video1.file);
    const cut1 = await addCut(2, 12, 'Corte um');
    const cut2 = await addCut(14, 20, 'Corte dois');
    await ev('BF.project.flush()');
    await ev("BF.ui.selectTab('subtitles')");
    await selectCut(cut1);
    assert.equal(await checked(), false, 'sem preferência, a legenda do corte novo começa desligada');
    assert.equal(await ev('BF.prefs.get("subtitles.enabled", false)'), false);
    assert.equal((await ev('BF.prefs.set("subtitles.enabled", true)')).ok, true);
    await waitFor(page, `${q(`${PANEL} input[data-fid="enabled"]`)}.checked === true`, 10000, 'caixa ligada pela preferência');
    assert.equal((await cutNow(cut1)).subtitles, null, 'só mostra: nada é gravado no corte até o usuário mexer');
    await selectCut(cut2);
    assert.equal(await checked(), true, 'o outro corte novo também nasce ligado');
    await toggleEnabled(false);
    await waitFor(page, `BF.project.cut(${J(cut2)}).subtitles && BF.project.cut(${J(cut2)}).subtitles.enabled === false`, 10000, 'o usuário desligou este corte');
    await selectCut(cut1);
    assert.equal(await checked(), true, 'o escolhido do usuário vale só para o corte dele');
    await toggleEnabled(false);
    await toggleEnabled(true);
    await waitFor(page, `BF.project.cut(${J(cut1)}).subtitles && BF.project.cut(${J(cut1)}).subtitles.enabled === true`, 10000, 'ligada de novo');
    assert.equal(await ev('BF.prefs.get("subtitles.enabled", false)'), true, 'mexer no corte não muda a preferência');
    assert.equal((await ev('BF.prefs.set("subtitles.enabled", false)')).ok, true);
    const cut3 = await addCut(21, 23, 'Corte três');
    await selectCut(cut3);
    assert.equal(await checked(), false, 'com a preferência desligada, o corte novo volta a nascer desligado');
    step('a preferência subtitles.enabled liga a legenda dos cortes novos (e só deles); o usuário decide corte a corte');

    // ---------- 2. "Usar esta aparência nos próximos vídeos" grava subtitles.style ----------
    await selectCut(cut1);
    await openDetails('style');
    await setRange('size', 90);
    await setColor('color', '#ffcc00');
    await waitFor(page, `BF.project.cut(${J(cut1)}).subtitles.style.fontSize === 90 && BF.project.cut(${J(cut1)}).subtitles.style.color === '#FFCC00'`, 10000, 'estilo do corte');
    assert.equal(await ev('BF.prefs.explain("subtitles.style") ? BF.prefs.explain("subtitles.style").source : null'), 'default', 'antes: nenhuma preferência de estilo');
    await openDetails('more');
    await ev(`${q(`${PANEL} [data-act="style-default"]`)}.click()`);
    await waitFor(page, 'BF.prefs.explain("subtitles.style") && BF.prefs.explain("subtitles.style").source === "explicit"', 10000, 'preferência de estilo gravada');
    const pref = await ev('BF.prefs.get("subtitles.style", null)');
    assert.equal(pref.fontSize, 90);
    assert.equal(pref.color, '#FFCC00');
    await waitFor(page, "/padrão das legendas dos próximos vídeos/.test(document.getElementById('toasts').textContent)", 10000, 'aviso de que a aparência virou o padrão');
    // um projeto novo nasce com essa aparência
    await ev('BF.project.flush()');
    await open(video2.file);
    const other = await addCut(1, 6, 'Outro vídeo');
    await ev("BF.ui.selectTab('subtitles')");
    await selectCut(other);
    await openDetails('style');
    assert.equal(await ev(`${q(`${PANEL} [data-fid="size"]`)}.value`), '90', 'o tamanho do projeto novo é o da preferência');
    assert.equal(await ev(`${q(`${PANEL} [data-fid="color"]`)}.value`), '#ffcc00');
    assert.equal(await ev('BF.state.project.ext.subtitles || null'), null, 'nada do projeto antigo vazou para o novo');
    await toggleEnabled(true);
    await waitFor(page, `BF.project.cut(${J(other)}).subtitles && BF.project.cut(${J(other)}).subtitles.enabled === true`, 10000, 'legenda criada no corte do projeto novo');
    const born = (await cutNow(other)).subtitles;
    assert.equal(born.style.fontSize, 90, 'a legenda do corte nasce com o estilo da preferência (o que a tela mostrava é o que foi gravado)');
    assert.equal(born.style.color, '#FFCC00');
    step('"Usar esta aparência nos próximos vídeos" define subtitles.style (explícita) e um projeto novo já abre com ela');
    await ev('BF.prefs.unset("subtitles.style")');

    // ---------- 3. aparar o corte e desfazer: as falas das bordas voltam exatas ----------
    await open(video1.file);
    await ev("BF.ui.selectTab('subtitles')");
    await selectCut(cut1);
    const original = [
      { start: 0.5, end: 2.5, text: 'Fala colada no começo' },
      { start: 5, end: 6, text: 'Fala do meio' },
      { start: 8, end: 10, text: 'Fala colada no fim' }
    ];
    await ev(`BF.project.update((p) => { const c = p.cuts.find((x) => x.id === ${J(cut1)}); c.subtitles = { enabled: true, mode: 'sidecar', sidecarFormat: 'srt', basedOn: { start: c.start, end: c.end, revision: c.revision }, cues: ${J(original)}, style: {} }; }, { reason: 'teste' }); BF.bus.emit('cuts:changed', { ids: [${J(cut1)}], from: 'teste' }); true`);
    await waitFor(page, `document.querySelectorAll('${PANEL} .cues .cue').length === 3`, 10000, 'três falas na lista');
    const cutTimes = async () => (await cutNow(cut1)).subtitles.cues.map((c) => [c.start, c.end]);
    const rangeNow = async () => { const c = await cutNow(cut1); return [c.start, c.end]; };
    assert.deepEqual(await rangeNow(), [2, 12]);
    await ev(`BF.review.adjust(${J(cut1)}, { start: 3 })`);
    await waitFor(page, `BF.project.cut(${J(cut1)}).subtitles.basedOn.start === 3`, 10000, 'falas acompanharam o novo início');
    await ev(`BF.review.adjust(${J(cut1)}, { end: 11 })`);
    await waitFor(page, `BF.project.cut(${J(cut1)}).subtitles.basedOn.end === 11`, 10000, 'falas acompanharam o novo fim');
    assert.deepEqual(await rangeNow(), [3, 11]);
    const trimmed = (await cutNow(cut1)).subtitles.cues;
    assert.deepEqual(trimmed.map((c) => [c.start, c.end]), [[-0.5, 1.5], [4, 5], [7, 9]], 'tempos deslocados, SEM recorte permanente');
    assert.deepEqual(trimmed.map((c) => c.needsReview === true), [true, false, true], 'as duas das bordas ficam para revisão');
    assert.equal(await ev(`document.querySelectorAll('${PANEL} .cue.partial').length`), 2, 'a lista mostra "parte fora" nas duas');
    assert.match(await ev(`${q(`${PANEL} [data-note="partial"]`)}.textContent`), /2 falas passam do início ou do fim do corte/);
    await shot(page, 'legendas-ui-1-aparado');
    // Ctrl+Z da aba Cortes, duas vezes: o fim e o início voltam
    await ev('BF.review.engine.undo()');
    await ev('BF.review.engine.undo()');
    await waitFor(page, `BF.project.cut(${J(cut1)}).start === 2 && BF.project.cut(${J(cut1)}).end === 12 && BF.project.cut(${J(cut1)}).subtitles.basedOn.start === 2 && BF.project.cut(${J(cut1)}).subtitles.basedOn.end === 12`, 15000, 'corte de volta a 2–12 e falas acompanhando');
    assert.deepEqual(await cutTimes(), original.map((c) => [c.start, c.end]), 'as falas voltaram EXATAMENTE aos tempos de antes de aparar');
    step('aparar o corte e desfazer (Ctrl+Z) devolve as falas das bordas com os tempos exatos; durante o corte aparado elas ficam marcadas, sem recorte');

    // ---------- 4. linha em branco no texto: o .srt separado sai inteiro ----------
    await typeText(1, 'primeira linha\n\nsegunda linha');
    await waitFor(page, `BF.project.cut(${J(cut1)}).subtitles.cues[1].text === 'primeira linha\\n\\nsegunda linha'`, 5000, 'texto com linha em branco salvo');
    const withBlank = await cutNow(cut1);
    const job = B.prepareBurnIn(withBlank, { tmpDir: path.join(tmp, 'job-srt'), width: 1080, height: 1920, support });
    assert.equal(job.vfFilter, null);
    const srtBlocks = fs.readFileSync(job.sidecars[0].path, 'utf8').trim().split(/\r?\n\r?\n/);
    assert.equal(srtBlocks.length, 3, 'três blocos: nenhuma linha em branco partiu uma fala em duas');
    assert.ok(srtBlocks.every((b) => b.split(/\r?\n/).length >= 3 && b.split(/\r?\n/).every((l) => l.trim() !== '')));
    assert.deepEqual(F.parseSrt(fs.readFileSync(job.sidecars[0].path, 'utf8')).map((c) => c.text), ['Fala colada no começo', 'primeira linha\nsegunda linha', 'Fala colada no fim']);
    step('fala com linha em branco: o arquivo .srt separado sai com as três falas, sem bloco órfão');

    // ---------- 5. prévia com fonte grande quebra a linha como o libass ----------
    const longText = 'Olá pessoal, bem-vindos ao nosso canal hoje';
    await typeText(1, longText);
    await waitFor(page, `BF.project.cut(${J(cut1)}).subtitles.cues[1].text === ${J(longText)}`, 5000, 'texto longo salvo');
    await ev(`BF.project.update((p) => { const s = p.cuts.find((x) => x.id === ${J(cut1)}).subtitles; s.mode = 'burn'; }, { reason: 'teste' }); true`);
    await openDetails('style');
    await setRange('size', 140);
    await waitFor(page, `BF.project.cut(${J(cut1)}).subtitles.style.fontSize === 140`, 5000, 'tamanho 140');
    await ev('BF.project.flush()');
    await ev('BF.player.seek(2 + 5.5)'); // meio da fala do meio
    await sleep(400);
    await waitFor(page, `!${q('.sub-overlay')}.hidden && !${q('.sub-text')}.hidden && ${q('.sub-text')}.textContent.trim().length > 0`, 10000, 'texto na prévia');
    const overlay = () => ev(`(() => {
      const f = document.querySelector('.sub-frame').getBoundingClientRect();
      const lines = [...document.querySelectorAll('.sub-text .sub-line')];
      const rects = lines.map((l) => l.getBoundingClientRect());
      return { frame: { x: f.left, y: f.top, w: f.width, h: f.height },
        box: { x0: Math.min(...rects.map((r) => r.left)), y0: Math.min(...rects.map((r) => r.top)), x1: Math.max(...rects.map((r) => r.right)), y1: Math.max(...rects.map((r) => r.bottom)) },
        lines: lines.length, fontPx: parseFloat(getComputedStyle(document.querySelector('.sub-text')).fontSize), whiteSpace: getComputedStyle(document.querySelector('.sub-line')).whiteSpace };
    })()`);
    const ov = await overlay();
    assert.equal(ov.whiteSpace, 'pre-wrap', 'a linha da prévia quebra quando passa da largura do quadro');
    assert.ok(ov.box.x0 >= ov.frame.x - 1 && ov.box.x1 <= ov.frame.x + ov.frame.w + 1, `o texto cabe no quadro (texto ${ov.box.x0.toFixed(0)}..${ov.box.x1.toFixed(0)}, quadro ${ov.frame.x.toFixed(0)}..${(ov.frame.x + ov.frame.w).toFixed(0)}); antes passava de 1450 px num quadro de 1080`);
    assert.ok((ov.box.x1 - ov.box.x0) <= ov.frame.w * 0.88 + 2, 'e fica dentro das margens de 6% do ASS');
    if (!support.supported) {
      console.log(`(pulado) comparação com o libass: ${support.reason}`);
    } else {
      // o mesmo corte exportado de verdade (libass) tem o texto na mesma altura
      const cutData = await cutNow(cut1);
      const W = 1080; const Hh = 1920;
      const work = path.join(tmp, 'job');
      const prepared = B.prepareBurnIn(cutData, { tmpDir: work, width: W, height: Hh, support });
      assert.ok(prepared && prepared.vfFilter, 'a exportação leva a legenda incorporada');
      const dur = cutData.end - cutData.start;
      const render = (name, vf) => {
        const out = path.join(tmp, name);
        H.ffmpeg(['-ss', String(cutData.start), '-t', String(dur), '-i', video1.file, '-filter_complex',
          `[0:v]scale=${W}:${Hh}:force_original_aspect_ratio=increase,crop=${W}:${Hh},setsar=1${vf ? `,${vf}` : ''},format=yuv420p[vout]`, '-map', '[vout]', '-an', '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', out]);
        return out;
      };
      const exported = render('exportado.mp4', prepared.vfFilter);
      const plain = render('sem-legenda.mp4', null);
      const mid = 5.5; // relativo ao corte (3 s de início atual não importa: as falas voltaram ao corte 2–12 no passo 3, a do meio fica em 5–6 s)
      const exBox = H.diffBox(H.grayFrame(plain, mid, { width: W, height: Hh }), H.grayFrame(exported, mid, { width: W, height: Hh }), W, Hh, 40);
      assert.ok(exBox && exBox.count > 800, 'o vídeo exportado tem a legenda');
      const prevH = (ov.box.y1 - ov.box.y0) / ov.frame.h;
      const exH = exBox.h / Hh;
      const prevW = (ov.box.x1 - ov.box.x0) / ov.frame.w;
      const exW = exBox.w / W;
      console.log(`   prévia: altura ${prevH.toFixed(3)} largura ${prevW.toFixed(3)} (${ov.lines} blocos) | exportado: altura ${exH.toFixed(3)} largura ${exW.toFixed(3)}`);
      assert.ok(Math.abs(prevH - exH) / exH < 0.3, `a altura do texto na prévia bate com a do vídeo exportado (±30%): prévia ${prevH.toFixed(3)}, exportado ${exH.toFixed(3)}`);
      assert.ok(exBox.x0 >= W * 0.05 && exBox.x1 <= W * 0.95, 'no vídeo exportado o texto também fica dentro das margens');
      await shot(page, 'legendas-ui-2-fonte-grande');
      step(`fonte 140: a prévia quebra a linha dentro das margens (largura ${prevW.toFixed(2)} do quadro) e a altura do texto bate com o libass (${prevH.toFixed(3)} x ${exH.toFixed(3)})`);
    }

    // ---------- 6. legenda ligada sem falas: o QC avisa, não bloqueia ----------
    await selectCut(cut3);
    await toggleEnabled(true);
    await waitFor(page, `BF.project.cut(${J(cut3)}).subtitles && BF.project.cut(${J(cut3)}).subtitles.enabled === true && BF.project.cut(${J(cut3)}).subtitles.cues.length === 0`, 10000, 'legenda ligada sem falas');
    await ev(`BF.project.update((p) => { for (const c of p.cuts) c.status = (c.id === ${J(cut3)}) ? 'approved' : 'pending'; }, { reason: 'teste' }); BF.bus.emit('cuts:changed', { ids: [${J(cut3)}], from: 'teste' }); true`);
    await ev("BF.ui.selectTab('export')");
    await waitFor(page, "!!document.querySelector('#exp-qc li.exp-issue.warn[data-code=\"SUBTITLES_WARNING\"]')", 60000, 'aviso de legenda sem falas no QC');
    const qcText = await ev("document.querySelector('#exp-qc li.exp-issue.warn[data-code=\"SUBTITLES_WARNING\"]').textContent");
    assert.match(qcText, /ligada, mas nenhuma fala aparece neste corte/);
    assert.match(qcText, /sai sem legenda/);
    assert.equal(await ev("document.querySelectorAll('#exp-qc li.exp-issue.error').length"), 0, 'é aviso, não erro');
    assert.equal(await ev("document.getElementById('exp-enqueue').disabled"), false, 'o aviso não bloqueia o botão');
    await shot(page, 'legendas-ui-3-qc');
    step('legenda ligada sem nenhuma fala: o QC da aba Exportar mostra o aviso e o botão de enfileirar continua habilitado');

    h.assertNoConsoleErrors(page);
    await app.stop();
    app = null;
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

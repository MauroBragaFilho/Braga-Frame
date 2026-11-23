'use strict';

/**
 * E2E: a legenda de um corte aproveitando a TRANSCRIÇÃO do vídeo inteiro (sem rodar o Whisper), no app de verdade. Importa um .srt como transcrição, e na
 * aba Legendas: o botão aparece só com transcrição válida, "Usar a transcrição do vídeo" põe as falas do corte (relativas ao corte, as da borda cortadas e
 * marcadas para revisão), e "Legendar os cortes com a transcrição do vídeo" faz o lote nos aprovados sem legenda, sem mexer em quem já tem.
 * Uso: node tests/e2e/subtitles-transcript.e2e.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { locateTools } = require('../../src/core/ffmpeg/locate');
const h = require('./helpers');

const { waitFor, answerModal } = h;
const j = JSON.stringify;

async function main() {
  const ffmpeg = locateTools().ffmpeg;
  assert.ok(ffmpeg, 'ffmpeg necessário');
  const tmp = h.mkTemp('e2e-subtr');
  let app = null;
  try {
    const video = path.join(tmp, 'live.mp4');
    h.makeSampleVideo(ffmpeg, video, { seconds: 40, size: '320x180', rate: 15 });
    const srt = path.join(tmp, 'live.srt');
    fs.writeFileSync(srt, ['1', '00:00:08,000 --> 00:00:12,000', 'antes e dentro', '', '2', '00:00:20,000 --> 00:00:24,000', 'só dentro', '', '3', '00:00:28,000 --> 00:00:35,000', 'dentro e depois', '', '4', '00:00:36,000 --> 00:00:38,000', 'segundo corte', ''].join('\n'));
    app = await h.launchApp(path.join(tmp, 'ud'), { env: { CORTE_WHISPER: '' } });
    const { page } = app;
    const ev = (x) => page.eval(x);
    await ev(`BF.openSource(${j(video)})`);
    await waitFor(page, "BF.state.project && document.getElementById('video').readyState >= 1", 30000, 'vídeo aberto');
    await ev("BF.project.addCut({ title: 'A', start: 10, end: 30, status: 'approved' })");
    await ev("BF.project.addCut({ title: 'B', start: 35, end: 39, status: 'approved' })");
    await ev("BF.project.addCut({ title: 'C', start: 1, end: 5, status: 'pending' })");
    const ids = await ev('BF.state.project.cuts.map((c) => c.title + ":" + c.id)');
    const idOf = (t) => ids.find((x) => x.startsWith(`${t}:`)).slice(2);

    // sem transcrição: o botão não existe
    await ev("BF.ui.selectTab('subtitles')");
    await ev(`BF.review.select(${j(idOf('A'))}, { seek: false })`);
    await waitFor(page, "!!document.querySelector('#tabpanel-subtitles [data-act=\"generate\"]')", 15000, 'aba Legendas');
    assert.equal(await ev("!!document.querySelector('#tabpanel-subtitles [data-act=\"use-transcript\"]')"), false, 'sem transcrição não há botão');

    // importa o .srt como transcrição do vídeo (o que a aba Análise faz)
    const p = await ev('({ projectId: BF.state.project.id, path: BF.state.project.source.path, size: BF.state.project.source.size || 0, duration: BF.state.project.source.duration })');
    const imp = await ev(`BF.api('analysis:transcriptImport', ${j({ ...p, subtitlePath: srt })})`);
    assert.equal(imp.ok, true, j(imp));
    await ev("BF.ui.selectTab('analysis')");
    await ev("BF.ui.selectTab('subtitles')");
    await waitFor(page, "!!document.querySelector('#tabpanel-subtitles [data-act=\"use-transcript\"]')", 15000, 'botão da transcrição');

    // um corte: falas relativas ao corte, bordas cortadas e marcadas
    await ev("document.querySelector('#tabpanel-subtitles [data-act=\"use-transcript\"]').click()");
    await waitFor(page, `BF.project.cut(${j(idOf('A'))}).subtitles && BF.project.cut(${j(idOf('A'))}).subtitles.cues.length === 3`, 10000, 'falas do corte A');
    const cues = await ev(`BF.project.cut(${j(idOf('A'))}).subtitles.cues.map((c) => [c.start, c.end, c.text, !!c.needsReview])`);
    assert.deepEqual(cues, [[0, 2, 'antes e dentro', true], [10, 14, 'só dentro', false], [18, 20, 'dentro e depois', true]]);
    assert.equal(await ev(`BF.project.cut(${j(idOf('A'))}).subtitles.enabled`), true);

    // lote: A já tem falas (não muda), B ganha, C (pendente) fica de fora porque há aprovados
    await ev("document.querySelector('#tabpanel-subtitles .subs-details[data-section=\"more\"]').open = true");
    await waitFor(page, "!!document.querySelector('#tabpanel-subtitles [data-act=\"transcript-all\"]')", 10000, 'ação em lote');
    await ev("document.querySelector('#tabpanel-subtitles [data-act=\"transcript-all\"]').click()");
    const asked = await answerModal(page, true);
    assert.match(asked.message, /1 corte aprovado\(s\) sem legenda recebe/);
    await waitFor(page, `BF.project.cut(${j(idOf('B'))}).subtitles && BF.project.cut(${j(idOf('B'))}).subtitles.cues.length === 1`, 10000, 'falas do corte B');
    assert.equal(await ev(`BF.project.cut(${j(idOf('B'))}).subtitles.cues[0].text`), 'segundo corte');
    assert.equal(await ev(`BF.project.cut(${j(idOf('A'))}).subtitles.cues.length`), 3, 'quem já tinha legenda não mudou');
    assert.equal(await ev(`(BF.project.cut(${j(idOf('C'))}).subtitles || { cues: [] }).cues.length`), 0, 'o pendente não entrou');
    h.assertNoConsoleErrors(page);
    await app.stop(); app = null;
    console.log('✔ transcrição do vídeo vira legenda do corte e do lote, sem Whisper\n\nE2E OK');
  } finally {
    try { if (app) await app.stop(); } catch { /* fechado */ }
    await h.cleanupAll();
    h.removeDir(tmp);
  }
}

main().then(() => process.exit(0), (err) => { console.error(`\n✖ E2E FALHOU: ${err.stack || err.message}`); h.cleanupAll().finally(() => process.exit(1)); });

'use strict';

/**
 * E2E da transcrição pela placa de vídeo na interface: abre o app Electron de verdade e confere, na aba Legendas, que
 *   - a GPU NVIDIA é detectada e mostrada de forma discreta ("GPU NVIDIA GeForce GTX 1650 · 4 GB — a transcrição pode usar a placa");
 *   - o ajuste do motor (Automático / Placa / Processador) fica recolhido e o motor em uso aparece ("GPU" ou "CPU");
 *   - gerar a legenda no automático usa a placa e o resultado diz "Transcrito na placa (...) em X s · Nx o tempo real";
 *   - trocar para "Processador (CPU)" gera no processador e o resultado diz isso;
 *   - a aba Ferramentas mostra a placa e o pacote CUDA (grande, sem baixar nada) com o aviso de tamanho.
 * O motor é o CUDA OFICIAL que o BDS já tem instalado (apontado por CORTE_WHISPER): nada de ~675 MB é baixado. O modelo tiny
 * (32 MB, fonte oficial) é baixado pela própria aba, como no e2e de Legendas. Pula sem placa NVIDIA / motor CUDA / voz do Windows.
 * Uso: node tests/e2e/subtitles-gpu.e2e.js   (BF_GPU_CUDA_DIR muda a pasta do motor CUDA; BF_E2E_SHOTDIR guarda capturas)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../subtitles-helpers');
const h = require('./helpers');
const gpu = require('../../src/core/subtitles/gpu');
const eng = require('../../src/core/subtitles/engine');

const { sleep, waitFor, answerModal } = h;
const PANEL = '#tabpanel-subtitles';
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const BDS = path.join(process.env.APPDATA || '', 'braga-digital-studio', 'data', 'modules', 'whisper');
const cudaExe = path.join(process.env.BF_GPU_CUDA_DIR || path.join(BDS, 'cuda'), 'whisper-cli.exe');

async function main() {
  const hw = await gpu.detectNvidia({ refresh: true });
  const voice = H.listVoices().find((v) => /^pt/i.test(v.culture));
  const skip = !H.tools.ffmpeg ? 'ffmpeg não encontrado' : !hw.available ? `sem placa NVIDIA utilizável: ${hw.reason}`
    : !fs.existsSync(cudaExe) || eng.engineKindOf(cudaExe) !== 'cuda' ? `sem motor CUDA em ${cudaExe}` : !voice ? 'sem voz pt-BR do Windows' : null;
  if (skip) { console.log(`PULADO: ${skip}`); return; }

  const tmp = h.mkTemp('e2e-subs-gpu');
  const shotDir = process.env.BF_E2E_SHOTDIR;
  const shot = async (page, name) => { if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); await h.screenshot(page, path.join(shotDir, `${name}.png`)); } };
  const step = (m) => console.log(`✔ ${m}`);
  let app = null;
  try {
    const wav = path.join(tmp, 'fala.wav');
    H.synthesize('Olá pessoal, bem-vindos ao nosso canal. Hoje vamos jogar uma partida muito divertida. Vamos lá!', voice.name, wav);
    const video = H.makeVideo(path.join(tmp, 'gameplay.mp4'), [{ silence: 3 }, { wav }, { silence: 3 }], { size: '1280x720' });

    app = await h.launchApp(path.join(tmp, 'userdata'), { env: { CORTE_WHISPER: cudaExe, NODE_ENV: '' } });
    const page = app.page;
    await page.eval(`BF.openSource(${JSON.stringify(video.file)})`);
    await waitFor(page, "!document.getElementById('app').classList.contains('no-project')", 30000, 'vídeo aberto');
    await page.eval('BF.project.addCut({ start: 2, end: 12, title: "Corte da fala" }).id');
    await page.eval('BF.project.flush()');
    await page.eval("BF.ui.selectTab('subtitles')");
    await waitFor(page, `!!${q(`${PANEL} [data-act="generate"]`)}`, 20000, 'aba desenhada');

    // modelo tiny pela própria aba
    await page.eval(`(() => { const s = ${q(`${PANEL} select[data-fid="model"]`)}; s.value = 'tiny'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(page, `!!${q(`${PANEL} [data-act="install-model"]`)}`, 10000, 'botão de baixar o modelo');
    assert.equal(await page.eval(`!!${q(`${PANEL} [data-need="engine"]`)}`), false, 'o motor (CUDA do BDS, via CORTE_WHISPER) já conta como instalado: nenhum motor é pedido');
    await page.eval(`${q(`${PANEL} [data-act="install-model"]`)}.click()`);
    await waitFor(page, `!${q(`${PANEL} .subs-setup`)}`, 180000, 'modelo tiny baixado');

    // ---------- GPU detectada, discreta; ajuste recolhido ----------
    const hint = await page.eval(`${q(`${PANEL} [data-gpu="hint"]`)}.textContent`);
    assert.match(hint, /GPU NVIDIA GeForce GTX 1650 · 4 GB — a transcrição pode usar a placa/);
    assert.equal(await page.eval(`${q(`${PANEL} details[data-section="engine"]`)}.open`), false, 'o ajuste do motor começa recolhido');
    assert.equal(await page.eval(`document.querySelectorAll('${PANEL} .subs-gen button').length`), 1, 'a linha de geração continua com um só botão');
    await page.eval(`${q(`${PANEL} details[data-section="engine"] summary`)}.click()`);
    await waitFor(page, `${q(`${PANEL} details[data-section="engine"]`)}.open`, 5000, 'seção do motor aberta');
    const options = await page.eval(`[...${q(`${PANEL} select[data-fid="engine"]`)}.options].map((o) => [o.value, o.disabled])`);
    assert.deepEqual(options, [['auto', false], ['gpu', false], ['cpu', false]], 'Automático / Placa (GPU) / Processador (CPU)');
    assert.equal(await page.eval(`${q(`${PANEL} select[data-fid="engine"]`)}.value`), 'auto', 'automático é o padrão');
    assert.match(await page.eval(`${q(`${PANEL} [data-engine="summary"]`)}.textContent`), /GPU/, 'o motor em uso é de GPU');
    assert.equal(await page.eval(`!!${q(`${PANEL} [data-engine="cuda"]`)}`), false, 'com o motor CUDA presente, não se oferece baixar outro');
    await shot(page, 'gpu-1-motor');
    step('a aba mostra a GPU detectada (nome, memória), o ajuste do motor recolhido com Automático/Placa/Processador e o motor em uso');

    // ---------- gerar no automático: placa ----------
    await page.eval(`${q(`${PANEL} [data-act="generate"]`)}.click()`);
    await waitFor(page, `document.querySelectorAll('${PANEL} .cues .cue').length >= 3`, 120000, 'falas geradas');
    await waitFor(page, `!!${q(`${PANEL} [data-note="device"]`)}`, 10000, 'aviso do dispositivo');
    const noteGpu = await page.eval(`${q(`${PANEL} [data-note="device"]`)}.textContent`);
    assert.match(noteGpu, /Transcrito na placa \(NVIDIA GeForce GTX 1650\) em \d+,\d s · [\d,]+× o tempo real/, noteGpu);
    assert.equal(await page.eval(`!!${q(`${PANEL} [data-note="gpufail"]`)}`), false);
    await shot(page, 'gpu-2-resultado-gpu');
    step(`automático usou a placa: "${noteGpu}"`);

    // ---------- Processador (CPU) ----------
    await page.eval(`(() => { const s = ${q(`${PANEL} select[data-fid="engine"]`)}; s.value = 'cpu'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(page, `${q(`${PANEL} select[data-fid="engine"]`)}.value === 'cpu'`, 5000, 'CPU escolhida');
    assert.equal(await page.eval('BF.state.project.ext.subtitles.engine'), 'cpu', 'a escolha fica no projeto');
    await page.eval(`${q(`${PANEL} [data-act="generate"]`)}.click()`);
    await answerModal(page, true); // "substituir as falas atuais"
    await waitFor(page, `/no processador/.test((${q(`${PANEL} [data-note="device"]`)} || { textContent: '' }).textContent)`, 120000, 'aviso do processador');
    const noteCpu = await page.eval(`${q(`${PANEL} [data-note="device"]`)}.textContent`);
    assert.match(noteCpu, /Transcrito no processador em \d+,\d s/);
    step(`"Processador (CPU)" gerou no processador: "${noteCpu}"`);

    // ---------- aba Ferramentas ----------
    await page.eval("BF.ui.selectTab('tools')");
    await waitFor(page, `!!document.querySelector('[data-tool="whisper-cuda"]')`, 20000, 'linha do pacote CUDA');
    const gpuLine = await page.eval("document.querySelector('[data-gpu=\"line\"]').textContent");
    assert.match(gpuLine, /Placa NVIDIA GeForce GTX 1650 · 4 GB — a transcrição pode usar a placa/);
    const row = await page.eval("document.querySelector('[data-tool=\"whisper-cuda\"]').textContent");
    assert.match(row, /Whisper para placa NVIDIA/);
    assert.match(row, /download de 643 MB/, 'tamanho oficial do pacote (674539285 bytes)');
    assert.match(row, /Download grande/);
    assert.equal(await page.eval("document.querySelector('[data-tool=\"whisper-cuda\"] [data-act=\"install\"]').disabled"), false);
    await shot(page, 'gpu-3-ferramentas');
    step('a aba Ferramentas mostra a placa e o pacote CUDA com o aviso de download grande (nada foi baixado)');

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

'use strict';

/**
 * E2E de INTEGRAÇÃO exportação x áudio x legendas x fila, no app Electron de verdade (perfil temporário, vídeo gerado com o
 * ffmpeg, nada simulado): um corte aprovado, com enquadramento personalizado, ganho de +6 dB e uma legenda manual,
 * enviado pela aba Exportar à Fila, e o arquivo final conferido por fora, com ffprobe, volumedetect e pixels.
 *
 *   1. perfil vertical 9:16 + legenda incorporada: resolução, codec, duração, áudio (+6 dB medido), enquadramento
 *      personalizado (pixel central vindo do retângulo livre, não do centro da fonte) e o texto da legenda no quadro;
 *   2. a mesma exportação com a legenda em arquivo separado: o vídeo sai SEM texto, o .srt nasce ao lado e o arquivo
 *      anterior fica intacto (nome repetido -> "Salvar com outro nome");
 *   3. arquivo .srt que já existe ao lado: não é sobrescrito (aviso SIDECAR_EXISTS);
 *   4. perfil horizontal 16:9 com a legenda incorporada;
 *   5. corte alterado depois da legenda: o QC avisa (aviso, não bloqueio) que a legenda precisa de revisão.
 * Uso: node tests/e2e/integration-export.e2e.js     (BF_E2E_SHOTDIR=C:\pasta guarda capturas da janela)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const fx = require('../export-fixtures');
const afx = require('../audio-fixtures');

const { sleep, waitFor } = h;
const J = JSON.stringify;
const step = (m) => console.log(`✔ ${m}`);
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: obtido ${actual}, esperado ${expected} (±${tol})`);

/** Pixels "de texto": a fonte de teste tem B = 0 em todo o quadro, então branco (R, G e B altos) só pode ser legenda. */
function whiteStats(frame) {
  let count = 0;
  let minX = Infinity; let maxX = -1; let minY = Infinity; let maxY = -1;
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const i = (y * frame.width + x) * 3;
      if (frame.data[i] > 170 && frame.data[i + 1] > 170 && frame.data[i + 2] > 170) {
        count++;
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return { count, minX, maxX, minY, maxY };
}

/** Pixels que mudaram de verdade entre dois quadros do mesmo tamanho (soma dos canais > limite), com a caixa onde estão. */
function diffStats(a, b, limit = 90) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let count = 0;
  let minX = Infinity; let maxX = -1; let minY = Infinity; let maxY = -1;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 3;
      const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (d > limit) {
        count++;
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return { count, minX, maxX, minY, maxY };
}

async function main() {
  assert.ok(fx.tools.ffmpeg && fx.tools.ffprobe, 'ffmpeg/ffprobe necessários para o teste');
  const tmp = h.mkTemp('e2e-integ-export');
  const userData = path.join(tmp, 'userdata');
  const source = path.join(tmp, 'gameplay.mp4');
  const outDir = path.join(tmp, 'Cortes');
  const shots = process.env.BF_E2E_SHOTDIR;
  if (shots) fs.mkdirSync(shots, { recursive: true });

  try {
    fx.makeCodedSource(source, { width: 1920, height: 1080, fps: 10, seconds: 9 });
    const sourceHash = afx.sha256(source);
    step('vídeo de teste gerado (1920x1080, R = x, G = y, B = 0; tom de 440 Hz)');

    const app = await h.launchApp(userData, { args: ['--mute-audio'] });
    const { page } = app;
    const ev = (expr) => page.eval(expr);
    const shot = async (name) => { if (shots) await h.screenshot(page, path.join(shots, `integration-export-${name}.png`)); };
    const setValue = (selector, value, events = ['input', 'change']) => ev(`(() => { const e = document.querySelector(${J(selector)}); e.value = ${J(String(value))}; for (const t of ${J(events)}) e.dispatchEvent(new Event(t, { bubbles: true })); })()`);
    const click = (selector) => ev(`document.querySelector(${J(selector)}).click()`);
    const queueJobs = () => ev('JSON.parse(JSON.stringify(BF.queue.state.jobs))');
    /** Botões visíveis e habilitados de uma aba sem NENHUM ouvinte de clique (nem em si nem nos ancestrais). */
    async function deadButtons(tabId) {
      const expression = `(() => {
        const panel = document.getElementById('tabpanel-${tabId}');
        const listens = (n) => { try { const l = getEventListeners(n); return Boolean(l.click && l.click.length) || typeof n.onclick === 'function'; } catch { return false; } };
        const dead = [];
        for (const b of panel.querySelectorAll('button')) {
          if (b.disabled || b.getClientRects().length === 0 || b.closest('[hidden]')) continue;
          let node = b; let ok = false;
          while (node && !ok) { ok = listens(node); node = node.parentNode; }
          if (!ok) dead.push((b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 40));
        }
        return dead;
      })()`;
      const r = await page.send('Runtime.evaluate', { expression, includeCommandLineAPI: true, returnByValue: true });
      return r.result.result.value;
    }

    // ---------- abrir o vídeo, criar e aprovar o corte pela interface ----------
    await ev(`BF.openSource(${J(source)})`);
    await waitFor(page, "BF.state.project && !document.getElementById('app').classList.contains('no-project') && document.getElementById('video').readyState >= 1", 30000, 'vídeo carregado');
    const cutId = await ev("BF.project.addCut({ start: 1, end: 5, title: 'Corte de teste' }).id");
    await waitFor(page, `!!document.querySelector('#cuts .cut[data-id="${cutId}"]')`, 15000, 'corte na aba Cortes');
    await ev(`(() => { const li = document.querySelector('#cuts .cut[data-id="${cutId}"]'); [...li.querySelectorAll('button')].find((b) => b.textContent === 'Aprovar').click(); })()`);
    await waitFor(page, `BF.project.cut(${J(cutId)}).status === 'approved'`, 10000, 'corte aprovado');
    step('corte criado e aprovado pela aba Cortes');

    // ---------- enquadramento personalizado (retângulo livre deste corte) ----------
    const rect = { x: 0.1, y: 0.55, w: 0.4, h: 0.3 };
    await ev(`(() => {
      BF.project.update(() => { const c = BF.project.cut(${J(cutId)}); c.framing = { mode: 'custom', custom: ${J(rect)} }; c.updatedAt = new Date().toISOString(); }, { reason: 'teste' });
      BF.bus.emit('cuts:changed', { ids: [${J(cutId)}], from: 'teste' });
    })()`);

    // ---------- ganho de +6 dB pela aba Áudio ----------
    await ev("BF.ui.selectTab('audio')");
    await ev(`BF.bus.emit('cut:selected', { id: ${J(cutId)} })`);
    await waitFor(page, "document.getElementById('audioGainNum') && !document.querySelector('#tabpanel-audio .audio-body').hidden", 15000, 'painel de áudio do corte');
    await setValue('#audioGainNum', '6', ['change']);
    await waitFor(page, `BF.project.cut(${J(cutId)}).audio.gainDb === 6`, 10000, 'ganho gravado');
    step('ganho de +6 dB aplicado pela aba Áudio');

    // ---------- legenda manual pela aba Legendas ----------
    await ev("BF.ui.selectTab('subtitles')");
    await ev(`BF.bus.emit('cut:selected', { id: ${J(cutId)} })`);
    await waitFor(page, "!!document.querySelector('#tabpanel-subtitles [data-act=\"add\"]')", 20000, 'aba Legendas do corte');
    await click('#tabpanel-subtitles [data-act="add"]');
    await waitFor(page, "!!document.querySelector('#tabpanel-subtitles textarea.cue-text')", 10000, 'primeira fala');
    await setValue('#tabpanel-subtitles textarea.cue-text', 'LEGENDA DE TESTE');
    const subs = await ev(`JSON.parse(JSON.stringify(BF.project.cut(${J(cutId)}).subtitles))`);
    assert.equal(subs.enabled, true);
    assert.equal(subs.mode, 'burn', 'padrão: legenda incorporada ao vídeo');
    assert.equal(subs.cues.length, 1);
    assert.equal(subs.cues[0].text, 'LEGENDA DE TESTE');
    near(subs.cues[0].start, 0, 0.01, 'início da fala (relativo ao corte)');
    near(subs.cues[0].end, 2, 0.01, 'fim da fala (relativo ao corte)');
    step('legenda manual criada pela aba Legendas (0 a 2 s do corte, incorporada)');

    // ---------- 1. vertical, legenda incorporada: enviado pela aba Exportar à Fila ----------
    const seen = new Set();
    async function exportViaTab() {
      await ev("BF.ui.selectTab('export')");
      await waitFor(page, "!document.getElementById('exp-enqueue').disabled && /Adicionar à fila \\(1\\)/.test(document.getElementById('exp-enqueue').textContent) && !document.getElementById('exp-qc-status').textContent.includes('Conferindo')", 60000, 'conferência pronta e botão habilitado');
      await click('#exp-enqueue');
      return settle();
    }
    /** Espera o trabalho novo terminar (responde ao diálogo de nome repetido com "Salvar com outro nome"). */
    async function settle() {
      const end = Date.now() + 240000;
      let renamed = 0;
      while (Date.now() < end) {
        const jobs = await queueJobs();
        const failed = jobs.find((j) => j.state === 'failed' && !seen.has(j.id));
        if (failed) throw new Error(`O trabalho falhou: ${JSON.stringify(failed.error)}`);
        const done = jobs.find((j) => j.state === 'done' && !seen.has(j.id));
        if (done) { seen.add(done.id); return { job: done, renamed }; }
        if (await ev("!!document.querySelector('.q-conflict [data-act=\"rename\"]')")) {
          await click('.q-conflict [data-act="rename"]');
          renamed++;
        }
        await sleep(300);
      }
      throw new Error('Tempo esgotado esperando o trabalho da fila terminar');
    }

    const first = await exportViaTab();
    const videoB = first.job.output;
    assert.equal(first.renamed, 0, 'primeira exportação: nada a renomear');
    assert.equal(path.dirname(videoB), outDir, 'pasta padrão "Cortes" ao lado do vídeo');
    assert.ok(fs.existsSync(videoB));
    await waitFor(page, `BF.project.cut(${J(cutId)}).exports.length === 1`, 15000, 'a fila anotou a exportação no corte');
    // formato real de cut.exports[].profile (o que o aprendizado de perfil das Preferências lê): o perfil efetivo do trabalho, com id
    const exported = await ev(`JSON.parse(JSON.stringify(BF.project.cut(${J(cutId)}).exports[0]))`);
    assert.equal(typeof exported.profile, 'object');
    assert.equal(exported.profile.id, 'vertical-1080-h264');
    assert.deepEqual([exported.start, exported.end, exported.path], [1, 5, videoB]);
    await shot('1-fila');

    const probeB = fx.probeStreams(videoB);
    const vB = probeB.streams.find((s) => s.codec_type === 'video');
    const aB = probeB.streams.find((s) => s.codec_type === 'audio');
    assert.equal(vB.codec_name, 'h264');
    assert.equal(`${vB.width}x${vB.height}`, '1080x1920');
    assert.ok(aB && aB.codec_name === 'aac', 'o áudio sai em AAC');
    near(Number(probeB.format.duration), 4, 0.25, 'duração do arquivo (corte de 4 s)');
    step(`vertical: ${vB.codec_name} ${vB.width}x${vB.height}, ${Number(probeB.format.duration).toFixed(2)} s, áudio ${aB.codec_name}`);

    // áudio: +6 dB em relação ao mesmo trecho da fonte
    const srcAudio = await afx.measure(source, 1, 5);
    const outAudio = await afx.measure(videoB, 0, 3600);
    near(outAudio.meanDb - srcAudio.meanDb, 6, 0.6, 'ganho médio aplicado (dB)');
    near(outAudio.peakDb - srcAudio.peakDb, 6, 0.8, 'ganho de pico aplicado (dB)');
    step(`volumedetect: média ${srcAudio.meanDb} -> ${outAudio.meanDb} dB, pico ${srcAudio.peakDb} -> ${outAudio.peakDb} dB (ganho de +6 dB aplicado)`);

    // enquadramento personalizado: o centro do quadro vem do retângulo livre (R ~ 0,30 e G ~ 0,70), não do centro da fonte
    const frameB1 = fx.decodeFile(videoB, 1080, 1920, { ss: 1.0 });
    const center = [fx.avg(frameB1, 540, 700, 0), fx.avg(frameB1, 540, 700, 1)];
    const expectR = 255 * (rect.x + rect.w / 2); // a janela visível é centrada no retângulo (proporção 9:16 dentro dele)
    const expectG = 255 * (rect.y + rect.h * (700 / 1919));
    near(center[0], expectR, 8, 'R no centro (retângulo livre)');
    near(center[1], expectG, 8, 'G a 700 px do topo (retângulo livre)');
    assert.ok(Math.abs(center[0] - 127) > 30, 'não é o recorte central da fonte (que teria R ~ 127)');
    step(`enquadramento personalizado no arquivo: pixel (R ${center[0].toFixed(0)}, G ${center[1].toFixed(0)}) vem do retângulo livre`);

    // legenda incorporada: texto branco no terço de baixo, centralizado, só enquanto a fala está no ar (0 a 2 s)
    const withText = whiteStats(frameB1);
    assert.ok(withText.count > 400, `deveria haver texto branco no quadro (achei ${withText.count} pixels)`);
    assert.ok(withText.minY > 1920 * 0.6, `o texto fica na parte de baixo (y mínimo ${withText.minY})`);
    near((withText.minX + withText.maxX) / 2, 540, 60, 'texto centralizado na horizontal');
    const frameB3 = fx.decodeFile(videoB, 1080, 1920, { ss: 3.0 });
    assert.ok(whiteStats(frameB3).count < 40, 'depois da fala (3 s) não há texto');
    step(`legenda incorporada: ${withText.count} pixels de texto em y ${withText.minY}..${withText.maxY}, só de 0 a 2 s`);

    // ---------- 2. legenda em arquivo separado (nome repetido -> outro nome; o anterior não muda) ----------
    const hashB = afx.sha256(videoB);
    await ev("BF.ui.selectTab('subtitles')");
    await waitFor(page, "!!document.querySelector('#tabpanel-subtitles select[data-fid=\"mode\"]')", 10000, 'seletor de entrega');
    await setValue('#tabpanel-subtitles select[data-fid="mode"]', 'sidecar', ['change']);
    await waitFor(page, `BF.project.cut(${J(cutId)}).subtitles.mode === 'sidecar'`, 10000, 'entrega em arquivo separado');
    const second = await exportViaTab();
    const videoC = second.job.output;
    assert.equal(second.renamed, 1, 'o nome já existia: a fila perguntou e o teste escolheu "Salvar com outro nome"');
    assert.notEqual(videoC, videoB);
    assert.match(path.basename(videoC), / \(2\)\.mp4$/);
    assert.equal(afx.sha256(videoB), hashB, 'o arquivo anterior continua byte a byte igual (nada sobrescrito)');
    const srtC = videoC.replace(/\.mp4$/, '.srt');
    assert.ok(fs.existsSync(srtC), 'o .srt foi criado ao lado do vídeo');
    const srt = fs.readFileSync(srtC, 'utf8');
    assert.match(srt, /LEGENDA DE TESTE/);
    assert.match(srt, /00:00:00,000 --> 00:00:02,000/);
    const frameC1 = fx.decodeFile(videoC, 1080, 1920, { ss: 1.0 });
    assert.ok(whiteStats(frameC1).count < 40, 'arquivo separado: o vídeo sai SEM texto gravado');
    const probeC = fx.probeStreams(videoC);
    assert.equal(`${probeC.streams[0].width}x${probeC.streams[0].height}`, '1080x1920');
    // diferença de pixels entre as duas exportações: só a região da legenda muda
    const diff = diffStats(frameB1, frameC1);
    assert.ok(diff.count > 400, `a legenda incorporada muda pixels (achei ${diff.count})`);
    assert.ok(diff.minY > 1920 * 0.6, `a diferença fica na região da legenda (y mínimo ${diff.minY})`);
    near((diff.minX + diff.maxX) / 2, 540, 80, 'diferença centralizada');
    const upper = { ...frameB1, height: 1100, data: frameB1.data.subarray(0, 1080 * 1100 * 3) };
    const upperC = { ...frameC1, height: 1100, data: frameC1.data.subarray(0, 1080 * 1100 * 3) };
    assert.equal(diffStats(upper, upperC, 60).count, 0, 'acima da legenda as duas exportações são iguais');
    step(`arquivo separado: ${path.basename(srtC)} criado; vídeo sem texto; ${diff.count} pixels diferem da incorporada, todos na região da legenda`);

    // ---------- 3. .srt que já existe ao lado: nunca é sobrescrito ----------
    const sentinel = 'NÃO MEXER: arquivo do usuário\n';
    const expectedThird = videoC.replace(/ \(2\)\.mp4$/, ' (3).mp4');
    const sentinelPath = expectedThird.replace(/\.mp4$/, '.srt');
    fs.writeFileSync(sentinelPath, sentinel);
    await setValue('#tabpanel-subtitles textarea.cue-text', 'OUTRA LEGENDA'); // texto novo: o trabalho é outro (não é "já exportado")
    const third = await exportViaTab();
    assert.equal(third.renamed, 1);
    assert.equal(third.job.output, expectedThird);
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), sentinel, 'o .srt que já existia ficou intacto');
    assert.ok(third.job.warnings.some((w) => w.code === 'SIDECAR_EXISTS'), `deveria avisar SIDECAR_EXISTS: ${J(third.job.warnings)}`);
    step('um .srt que já existia ao lado não foi sobrescrito (aviso SIDECAR_EXISTS na fila)');

    // ---------- 4. perfil horizontal com a legenda incorporada ----------
    await ev("BF.ui.selectTab('subtitles')");
    await setValue('#tabpanel-subtitles select[data-fid="mode"]', 'burn', ['change']);
    await waitFor(page, `BF.project.cut(${J(cutId)}).subtitles.mode === 'burn'`, 10000, 'entrega incorporada');
    await ev("BF.ui.selectTab('export')");
    await waitFor(page, "[...document.querySelectorAll('#exp-profile option')].some((o) => o.value === 'horizontal-1080-h264')", 15000, 'perfis carregados');
    await setValue('#exp-profile', 'horizontal-1080-h264', ['change']);
    await waitFor(page, "BF.state.project.ext.export && BF.state.project.ext.export.profileId === 'horizontal-1080-h264'", 10000, 'perfil horizontal escolhido');
    const fourth = await exportViaTab();
    const videoD = fourth.job.output;
    const probeD = fx.probeStreams(videoD);
    const vD = probeD.streams.find((s) => s.codec_type === 'video');
    assert.equal(`${vD.width}x${vD.height}`, '1920x1080');
    assert.equal(vD.codec_name, 'h264');
    near(Number(probeD.format.duration), 4, 0.25, 'duração (horizontal)');
    await waitFor(page, `BF.project.cut(${J(cutId)}).exports.slice(-1)[0].profile.id === 'horizontal-1080-h264'`, 15000, 'a exportação horizontal anotou o perfil horizontal');
    const outAudioD = await afx.measure(videoD, 0, 3600);
    near(outAudioD.meanDb - srcAudio.meanDb, 6, 0.6, 'ganho também no perfil horizontal');
    const frameD1 = fx.decodeFile(videoD, 1920, 1080, { ss: 1.0 });
    const textD = whiteStats(frameD1);
    assert.ok(textD.count > 400, `texto na exportação horizontal (achei ${textD.count} pixels)`);
    assert.ok(textD.minY > 1080 * 0.6, `texto na parte de baixo (y mínimo ${textD.minY})`);
    near((textD.minX + textD.maxX) / 2, 960, 80, 'texto centralizado (horizontal)');
    assert.ok(whiteStats(fx.decodeFile(videoD, 1920, 1080, { ss: 3.0 })).count < 40, 'depois da fala não há texto');
    step(`horizontal: ${vD.codec_name} ${vD.width}x${vD.height}, legenda incorporada (${textD.count} pixels de texto), +6 dB`);

    // ---------- 5. corte alterado depois da legenda: o QC AVISA (não bloqueia) ----------
    await ev(`BF.review.adjust(${J(cutId)}, { start: 2 })`); // a fala de 0 a 2 s passa a começar 1 s antes do corte
    await ev("BF.ui.selectTab('export')");
    await waitFor(page, "!!document.querySelector('#exp-qc li.exp-issue.warn[data-code=\"SUBTITLES_WARNING\"]')", 40000, 'aviso de revisão da legenda no QC');
    const qcText = await ev("document.querySelector('#exp-qc li.exp-issue.warn[data-code=\"SUBTITLES_WARNING\"]').textContent");
    assert.match(qcText, /legenda/i);
    assert.match(qcText, /revisão/i);
    assert.equal(await ev("document.querySelectorAll('#exp-qc li.exp-issue.error').length"), 0, 'não é erro');
    assert.equal(await ev("document.getElementById('exp-enqueue').disabled"), false, 'aviso não bloqueia o botão');
    step('QC: legenda marcada para revisão depois de mudar o corte aparece como AVISO e o botão continua habilitado');

    // ---------- a tela Exportações com trabalhos concluídos: nenhum botão sem ação e nada no console ----------
    await ev("BF.ui.selectTab('queue')");
    await waitFor(page, "document.querySelectorAll('#tabpanel-queue .q-job').length >= 4", 15000, 'trabalhos na tela Exportações');
    await ev("document.querySelector('#tabpanel-queue [data-tab=\"done\"]').click()"); // os concluídos moram na pílula Concluídos
    await ev("document.querySelectorAll('#tabpanel-queue details').forEach((d) => { d.open = true; })");
    await sleep(300);
    assert.deepEqual(await deadButtons('queue'), [], 'botões sem ação na tela Exportações');
    assert.ok((await ev("[...document.querySelectorAll('#tabpanel-queue .q-job button')].filter((b) => !b.disabled && b.getClientRects().length).length")) >= 4, 'a pílula Concluídos mostra as ações dos trabalhos');

    // ---------- fonte intacta e console limpo ----------
    assert.equal(afx.sha256(source), sourceHash, 'o vídeo de origem não foi tocado');
    assert.deepEqual(fs.readdirSync(outDir).filter((n) => n.endsWith('.part')), [], 'nenhum .part sobrando');
    h.assertNoConsoleErrors(page);
    await shot('fim');
    await app.stop();
    step('console sem erros; origem intacta; nenhum .part');
  } finally {
    await h.cleanupAll();
    h.removeDir(tmp);
  }
}

main().then(() => console.log('OK: integration-export'), (err) => { console.error(err); process.exitCode = 1; });

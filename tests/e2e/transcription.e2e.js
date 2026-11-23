'use strict';

/**
 * E2E da instalação da transcrição (Whisper), no app Electron de verdade (perfil temporário, vídeo gerado, servidores HTTP locais: nenhum
 * download real). O motor vem de uma entrada de teste (BF_TEST_TOOL_ENTRIES) e os modelos de um catálogo falso (BF_TEST_MODELS); as duas
 * variáveis só valem com NODE_ENV=test e o app não empacotado. Confere:
 *  - com um vídeo aberto mas SEM corte (a aba Legendas não tinha onde instalar) e na aba Análise: o botão "Instalar a transcrição";
 *  - recusar a confirmação não baixa nada; aceitar leva à aba Ferramentas, mostra "Passo 1 de 2" (motor) e "Passo 2 de 2" (modelo) com progresso
 *    real e DEVOLVE o usuário à Análise, já com "Transcrever o vídeo" liberado e os arquivos no lugar;
 *  - o cartão da aba Ferramentas (estado, lista de modelos, o motor fora da lista comum), baixar e remover modelos, erro de SHA-256 explicado,
 *    "Baixar o modelo" quando só falta ele, "Instalar" quando só falta o motor e cancelar no meio sem deixar nada;
 *  - nome acessível, alvos e contraste nos estados do cartão.
 * Uso: node tests/e2e/transcription.e2e.js     (BF_E2E_SHOTDIR=C:\pasta guarda capturas da janela)
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { locateTools } = require('../../src/core/ffmpeg/locate');
const { MODELS } = require('../../src/core/subtitles/models');
const { makeZip, startServer, makeEntry, listTree } = require('../tools-fixtures');
const { CONTRAST, SMALL, NAMELESS } = require('./a11y');
const h = require('./helpers');

const { sleep, waitFor, answerModal } = h;
const KEY = `${process.platform}-${process.arch}`;
const CARD = '#tabpanel-tools [data-card="transcription"]';
const REV = 'a'.repeat(40);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const j = JSON.stringify;

/** Manda o arquivo aos poucos, para a barra de progresso ter o que mostrar. */
function slowSend(res, buf, { chunk = 32 * 1024, everyMs = 100 } = {}) {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length });
  let offset = 0;
  const timer = setInterval(() => {
    if (res.destroyed) { clearInterval(timer); return; }
    res.write(buf.subarray(offset, offset + chunk));
    offset += chunk;
    if (offset >= buf.length) { clearInterval(timer); res.end(); }
  }, everyMs);
  res.on('close', () => clearInterval(timer));
}

async function main() {
  const ffmpeg = locateTools().ffmpeg;
  assert.ok(ffmpeg, 'ffmpeg necessário para o teste');
  const tmp = h.mkTemp('e2e-transcricao');
  const shotDir = process.env.BF_E2E_SHOTDIR;
  const shot = async (page, name) => { if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); await h.screenshot(page, path.join(shotDir, `${name}.png`)); } };
  const step = (m) => console.log(`✔ ${m}`);
  const video = path.join(tmp, 'amostra.mp4');
  const servers = [];
  let app = null;

  try {
    h.makeSampleVideo(ffmpeg, video, { seconds: 3, size: '320x180', rate: 10 });

    // o motor: um zip com um "whisper-cli.exe" de mentira; os modelos: o mesmo arquivo para qualquer nome (o catálogo diz o SHA-256 dele),
    // menos o "tiny", cujo SHA-256 no catálogo não bate de propósito (erro de integridade)
    const engineZip = makeZip([{ name: 'whisper-cli.exe', data: crypto.randomBytes(400 * 1024) }, { name: 'LEIAME.txt', data: 'pacote de teste' }]);
    const modelData = crypto.randomBytes(600 * 1024);
    const engineSrv = await startServer((req, res) => {
      if (req.url === '/whisper.zip') slowSend(res, engineZip, { everyMs: 120 });
      else { res.writeHead(404); res.end(); }
    });
    servers.push(engineSrv);
    const modelSrv = await startServer((req, res) => {
      const m = /^\/ggerganov\/whisper\.cpp\/resolve\/a{40}\/(ggml-[\w.-]+\.bin)$/.exec(req.url);
      if (m) slowSend(res, modelData);
      else { res.writeHead(404); res.end(); }
    });
    servers.push(modelSrv);
    const entry = { ...makeEntry({ base: engineSrv.base, buf: engineZip, id: 'whisper', version: 'b9999', file: 'whisper.zip', exe: 'whisper-cli.exe', key: KEY }), label: 'Whisper (legendas automáticas)' };
    const catalog = MODELS.map((m) => ({ ...m, revision: REV, sizeBytes: modelData.length, sha256: m.id === 'tiny' ? sha256(Buffer.from('outro conteúdo')) : sha256(modelData) }));
    const env = {
      NODE_ENV: 'test', CORTE_WHISPER: '',
      BF_TEST_TOOL_ENTRIES: j([entry]), BF_TEST_MODELS: j({ baseUrl: modelSrv.base, catalog })
    };

    const userData = path.join(tmp, 'ud');
    const toolsDir = path.join(userData, 'tools');
    const modelsDir = path.join(userData, 'models');
    const exe = path.join(toolsDir, 'whisper', 'b9999', 'whisper-cli.exe');
    const smallFile = path.join(modelsDir, 'whisper-small', `r${REV.slice(0, 12)}`, 'ggml-small-q5_1.bin');

    app = await h.launchApp(userData, { env });
    const { page } = app;
    const ev = (x) => page.eval(x);
    assert.equal(await ev('BF.state.tools.whisper'), null, 'perfil novo: sem motor de transcrição (nem o do PATH)');
    await ev(`BF.openSource(${j(video)})`);
    await waitFor(page, "!document.getElementById('app').classList.contains('no-project')", 20000, 'vídeo aberto');
    const tab = () => ev("document.getElementById('app').dataset.activeTab");
    const cardState = () => ev(`(document.querySelector('${CARD}') || { dataset: {} }).dataset.state || null`);
    const cardText = () => ev(`(document.querySelector('${CARD}') || {}).textContent || ''`);
    const waitCard = (state, ms = 40000) => waitFor(page, `(document.querySelector('${CARD}') || { dataset: {} }).dataset.state === ${j(state)}`, ms, `o cartão da transcrição no estado "${state}"`);
    const click = (act, model) => ev(`document.querySelector('${CARD} button[data-act="${act}"]${model ? `[data-model="${model}"]` : ''}').click()`);
    const exists = (act, model) => ev(`!!document.querySelector('${CARD} button[data-act="${act}"]${model ? `[data-model="${model}"]` : ''}')`);
    const modelRow = (id) => `${CARD} li.tr-model[data-model="${id}"]`;
    const modelState = (id) => ev(`(document.querySelector('${modelRow(id)}') || { dataset: {} }).dataset.state || null`);
    const showTools = async () => { await ev("BF.ui.selectTab('tools')"); await waitFor(page, `!!document.querySelector('${CARD} li.tr-model')`, 20000, 'o cartão da transcrição com a lista de modelos'); };
    const a11y = async (where) => {
      await sleep(500); // as cores do app têm transição: a medição só vale depois dela (o ux.e2e.js espera o mesmo tempo)
      assert.deepEqual(JSON.parse(await ev(NAMELESS)), [], `${where}: controles sem nome para o leitor de tela`);
      assert.deepEqual(JSON.parse(await ev(SMALL)), [], `${where}: alvos com menos de 24 px`);
      assert.deepEqual(JSON.parse(await ev(CONTRAST)), [], `${where}: contraste abaixo do mínimo`);
    };
    /** Amostras do bloco "instalando" (passo, barra e aba ativa) até `until(amostra)`. */
    const watch = async (until, timeoutMs = 40000) => {
      const samples = [];
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const s = await ev(`(() => {
          const c = document.querySelector('${CARD}');
          if (!c) return null;
          const flow = c.querySelector('[data-block="flow"]');
          const bar = c.querySelector('[data-block="flow"] progress');
          return { state: c.dataset.state, flow: flow ? flow.querySelector('.tr-main-text').textContent : null, value: bar && bar.hasAttribute('value') ? bar.value : null, tab: document.getElementById('app').dataset.activeTab };
        })()`);
        samples.push(s);
        if (s && until(s)) return samples;
        await sleep(50);
      }
      throw new Error(`Tempo esgotado (últimas amostras: ${j(samples.slice(-3))})`);
    };

    // ---------- 1) Legendas com vídeo e SEM corte, e a Análise: o botão que instala ----------
    await ev("BF.ui.selectTab('subtitles')");
    await waitFor(page, "!!document.querySelector('#tabpanel-subtitles [data-hint=\"install\"]')", 20000, 'o aviso de instalar a transcrição na aba Legendas');
    const hint = await ev("document.querySelector('#tabpanel-subtitles [data-hint=\"install\"]').textContent");
    assert.match(hint, /Falta instalar a transcrição/);
    assert.match(hint, /motor Whisper e de um modelo/);
    assert.match(hint, /\d[\d.,]* (KB|MB)/, 'diz o tamanho');
    assert.match(await ev("document.querySelector('#tabpanel-subtitles').textContent"), /Nenhum corte ainda/, 'o aviso convive com o estado "sem corte"');
    assert.equal(await ev("document.querySelectorAll('#tabpanel-subtitles [data-hint=\"install\"] button').length"), 1);
    await a11y('Legendas sem corte');
    step('Legendas, com vídeo e sem corte: o aviso com o botão "Instalar a transcrição" (antes não havia onde instalar)');

    await ev("BF.ui.selectTab('analysis')");
    await waitFor(page, "document.getElementById('anTGenerate') && /Instalar e transcrever/.test(document.getElementById('anTGenerate').textContent)", 20000, 'o botão "Instalar e transcrever o vídeo" na Análise');
    assert.equal(await ev("document.getElementById('anTGenerate').disabled"), false, 'sem motor, o botão único instala e transcreve (não fica desabilitado)');
    assert.equal(await ev("document.getElementById('anTInstall').hidden"), true, 'não há mais um botão de instalar separado');
    assert.match(await ev("document.getElementById('anTSub').textContent"), /aba Ferramentas/, 'o texto aponta para a aba Ferramentas');
    await a11y('Análise sem transcrição');
    step('Análise: o botão único vira "Instalar e transcrever o vídeo" (habilitado) e o texto aponta a aba Ferramentas');

    // ---------- 2) recusar a confirmação: nada é baixado ----------
    await ev("document.getElementById('anTGenerate').click()");
    const asked = await answerModal(page, false);
    assert.equal(asked.title, 'Instalar a transcrição?');
    assert.match(asked.message, /motor Whisper \(.*(KB|MB).*GitHub/);
    assert.match(asked.message, /modelo Pequeno \(.*(KB|MB).*Hugging Face/);
    assert.match(asked.message, /no total/);
    assert.match(asked.message, /SHA-256/);
    assert.match(asked.message, /cancelar/i);
    await sleep(400);
    assert.equal(await tab(), 'analysis', 'recusar não tira o usuário da Análise');
    assert.equal(fs.existsSync(toolsDir) && fs.existsSync(path.join(toolsDir, 'whisper')), false, 'recusar não instala o motor');
    assert.equal(engineSrv.requests.filter((r) => r.url === '/whisper.zip').length, 0, 'recusar não baixa nada');
    assert.equal(modelSrv.requests.length, 0);
    step('recusar a confirmação (que diz motor, modelo, tamanho total, origem, SHA-256 e cancelar) não baixa nada nem sai da Análise');

    // ---------- 3) aceitar: Ferramentas, "Passo 1 de 2" e "Passo 2 de 2", e volta para a Análise ----------
    await ev("BF.transcription.install({ modelId: null }); true"); // só a instalação: o botão da Análise também começaria a transcrever, e o motor deste teste é de mentira
    await answerModal(page, true);
    const samples = await watch((s) => s.state === 'ready' && s.tab === 'analysis', 60000);
    const flows = samples.filter((s) => s && s.flow);
    assert.ok(flows.some((s) => /Passo 1 de 2 · Motor de transcrição \(Whisper\)/.test(s.flow) && s.tab === 'tools'), 'passo 1 (o motor), já na aba Ferramentas');
    assert.ok(flows.some((s) => /Passo 2 de 2 · Modelo Pequeno/.test(s.flow)), 'passo 2 (o modelo recomendado)');
    for (const n of [1, 2]) {
      const partial = flows.filter((s) => new RegExp(`Passo ${n} de 2`).test(s.flow) && s.value > 0 && s.value < 100);
      assert.ok(new Set(partial.map((s) => s.value)).size >= 2, `passo ${n}: a barra mostrou progresso parcial crescente (${j(partial.map((s) => s.value))})`);
    }
    assert.equal(await tab(), 'analysis', 'terminou: o usuário volta para a Análise, de onde saiu');
    await waitFor(page, "document.getElementById('anTInstall').hidden && !document.getElementById('anTGenerate').disabled", 20000, '"Transcrever o vídeo" liberado e o botão de instalar escondido');
    assert.equal(await ev("document.getElementById('anTGenerate').textContent"), 'Transcrever o vídeo');
    assert.ok(fs.existsSync(exe), 'o motor no lugar');
    assert.ok(fs.existsSync(smallFile), `o modelo Pequeno no lugar (${smallFile})`);
    assert.ok(samePath(await ev('BF.state.tools.whisper'), exe), 'BF.state.tools.whisper aponta o motor instalado');
    assert.deepEqual(listTree(toolsDir).filter((p) => p.startsWith('.tmp') || p.endsWith('.part')), [], 'sem pasta de trabalho nem .part');
    await waitFor(page, "/Transcrição pronta para usar/.test(document.getElementById('toasts').textContent)", 5000, 'o aviso de pronta');
    await ev("BF.ui.selectTab('subtitles')");
    await waitFor(page, "!document.querySelector('#tabpanel-subtitles [data-hint=\"install\"]')", 15000, 'o aviso some das Legendas');
    step('aceitar: vai à aba Ferramentas, motor (passo 1) e modelo (passo 2) com progresso real, volta à Análise com "Transcrever o vídeo" liberado; o aviso das Legendas some');

    // ---------- 4) o cartão pronto ----------
    await showTools();
    assert.equal(await cardState(), 'ready');
    assert.deepEqual(await ev(`[...document.querySelectorAll('#tabpanel-tools h2')].map((n) => n.textContent)`), ['No seu computador', 'Transcrição (legendas automáticas)', 'Instaladas pelo app'], 'o cartão entre as duas seções');
    assert.equal(await ev("!!document.querySelector('#tabpanel-tools li.tool[data-tool=\"whisper\"], #tabpanel-tools li.tool[data-tool=\"whisper-cuda\"]')"), false, 'o motor e o pacote NVIDIA não aparecem de novo na lista comum');
    assert.match(await ev(`document.querySelector('${CARD} .tr-status').textContent`), /^Pronta$/);
    const text = await cardText();
    assert.match(text, /Pronta para transcrever/);
    assert.match(text, /motor do app/);
    assert.match(text, /1 modelo baixado/);
    assert.deepEqual(await ev(`[...document.querySelectorAll('${CARD} li.tr-model')].map((li) => li.dataset.model)`), MODELS.map((m) => m.id), 'a lista traz os cinco modelos do catálogo');
    assert.equal(await modelState('small'), 'installed');
    for (const id of ['tiny', 'base', 'medium', 'large-v3-turbo']) assert.equal(await modelState(id), 'missing', `${id}: ainda não baixado`);
    assert.equal(await exists('remove-engine'), true);
    assert.equal(await exists('install-all'), false, 'pronta: sem o botão de instalar tudo');
    assert.equal(await ev(`document.querySelectorAll('${CARD} .tr-tag').length`), 1, 'só um modelo recomendado');
    assert.match(await ev(`document.querySelector('${modelRow('small')} .tr-tag').textContent`), /Recomendado/);
    // a aceleração pela placa NVIDIA (só onde há placa utilizável): oferece, pergunta com o aviso da licença e recusar não baixa os ~640 MB
    const hw = await ev("BF.api('subtitles:hardware')");
    if (hw.ok && hw.gpu && hw.gpu.available) {
      assert.equal(await exists('install-cuda'), true, 'com placa utilizável o cartão oferece a aceleração');
      assert.match(await ev(`document.querySelector('${CARD} [data-block="cuda"]').textContent`), /Download grande .*opcional/);
      await click('install-cuda');
      const nv = await answerModal(page, false);
      assert.equal(nv.title, 'Baixar a aceleração pela placa NVIDIA?');
      assert.match(nv.message, /licença própria/);
      assert.match(nv.message, /termos da NVIDIA/);
      assert.match(nv.message, /opcional/);
      await sleep(300);
      assert.equal(fs.existsSync(path.join(toolsDir, 'whisper-cuda')), false, 'recusar não baixa nada');
      step('com placa NVIDIA: a aceleração é oferecida (opcional), a confirmação cita a licença da NVIDIA e recusar não baixa nada');
    } else {
      step('(sem placa NVIDIA utilizável neste computador: o bloco da aceleração não foi exercitado)');
    }
    await a11y('cartão pronto');
    await shot(page, 'transcricao-pronta');
    step('cartão pronto: estado, resumo, os cinco modelos (Pequeno baixado e recomendado), o motor fora da lista comum, acessível');

    // ---------- 5) modelos: erro de integridade, baixar e remover ----------
    await click('install-model', 'tiny');
    await waitFor(page, `!!document.querySelector('${modelRow('tiny')} .tr-error')`, 40000, 'o erro de integridade do modelo Tiny');
    assert.match(await ev(`document.querySelector('${modelRow('tiny')} .tr-error').textContent`), /integridade|SHA-256/i);
    assert.equal(await modelState('tiny'), 'missing');
    assert.deepEqual(listTree(modelsDir).filter((p) => p.includes('tiny')), [], 'o modelo que não confere não deixa nada');
    await click('install-model', 'base');
    await waitFor(page, `(() => { const li = document.querySelector('${modelRow('base')}'); if (li && li.querySelector('progress')) window.__bar = true; return li && li.dataset.state === 'installed'; })()`, 40000, 'o modelo Base baixado');
    assert.equal(await ev('window.__bar'), true, 'a linha do modelo mostrou a barra de progresso enquanto baixava');
    assert.ok(fs.existsSync(path.join(modelsDir, 'whisper-base', `r${REV.slice(0, 12)}`, 'ggml-base-q5_1.bin')));
    assert.match(await cardText(), /2 modelos baixados/);
    await click('remove-model', 'base');
    const rm = await answerModal(page, true);
    assert.equal(rm.title, 'Remover o modelo Base?');
    assert.doesNotMatch(rm.message, /único modelo/, 'há outro modelo: o aviso do último não aparece');
    await waitFor(page, `document.querySelector('${modelRow('base')}').dataset.state === 'missing'`, 20000, 'o modelo Base removido');
    assert.equal(fs.existsSync(path.join(modelsDir, 'whisper-base')), false, 'a pasta do modelo foi apagada');
    step('modelos: SHA-256 que não bate vira erro na linha e não deixa arquivo; baixar mostra a barra e grava; remover pede confirmação e apaga');

    // ---------- 6) só falta o modelo: "Baixar o modelo" ----------
    await click('remove-model', 'small');
    const last = await answerModal(page, true);
    assert.match(last.message, /único modelo baixado/, 'avisa que é o último');
    await waitCard('no-model');
    assert.match(await ev(`document.querySelector('${CARD} .tr-status').textContent`), /Falta um modelo/);
    assert.equal(await ev(`document.querySelector('${CARD} button[data-act="install-all"]').textContent`), 'Baixar o modelo Pequeno');
    assert.equal(fs.existsSync(smallFile), false);
    await a11y('cartão sem modelo');
    await ev("BF.ui.selectTab('analysis')");
    await waitFor(page, "/Instalar e transcrever/.test(document.getElementById('anTGenerate').textContent)", 15000, 'a Análise percebe que o modelo saiu');
    assert.match(await ev("document.getElementById('anTSub').textContent"), /modelo Pequeno.*aba Ferramentas/);
    await ev("BF.transcription.install({ modelId: null }); true");
    const onlyModel = await answerModal(page, true);
    assert.match(onlyModel.message, /modelo Pequeno/);
    assert.doesNotMatch(onlyModel.message, /motor Whisper/, 'o motor já está instalado: só o modelo entra na conta');
    const s2 = await watch((s) => s.state === 'ready' && s.tab === 'analysis', 60000);
    assert.ok(s2.some((s) => s && s.flow && /Passo 1 de 1 · Modelo Pequeno/.test(s.flow)), 'um passo só');
    assert.ok(fs.existsSync(smallFile));
    step('só falta o modelo: o botão diz "Baixar o modelo Pequeno", a confirmação só fala dele, um passo, e volta à Análise');

    // ---------- 7) só falta o motor ----------
    await showTools();
    await click('remove-engine');
    const re = await answerModal(page, true);
    assert.match(re.message, /modelos baixados .* continuam no disco/);
    await waitCard('missing');
    assert.equal(await ev('BF.state.tools.whisper'), null, 'o motor sumiu do ctx.tools');
    assert.equal(fs.existsSync(path.join(toolsDir, 'whisper')), false);
    assert.ok(fs.existsSync(smallFile), 'o modelo continua');
    assert.match(await cardText(), /Baixa o motor \(.*(KB|MB)\), só desta vez/, 'só o motor entra na conta');
    assert.doesNotMatch(await cardText(), /e o modelo/);
    await click('install-all');
    const eo = await answerModal(page, true);
    assert.match(eo.message, /motor Whisper/);
    assert.doesNotMatch(eo.message, /modelo Pequeno/);
    const s3 = await watch((s) => s.state === 'ready');
    assert.ok(s3.some((s) => s && s.flow && /Passo 1 de 1 · Motor de transcrição/.test(s.flow)));
    assert.ok(samePath(await ev('BF.state.tools.whisper'), exe));
    step('só falta o motor: remover o motor deixa o modelo; reinstalar baixa só o motor (um passo)');

    // ---------- 8) cancelar no meio: nada fica ----------
    await click('remove-model', 'small');
    await answerModal(page, true);
    await waitFor(page, `document.querySelector('${modelRow('small')}').dataset.state === 'missing'`, 20000, 'o modelo Pequeno removido');
    await click('remove-engine');
    await answerModal(page, true);
    await waitCard('missing');
    assert.deepEqual(listTree(toolsDir).concat(listTree(modelsDir)), [], 'nada sobrou (nem motor nem modelos)');
    await ev(`document.querySelector('${CARD} button[data-act="install-all"]').focus()`);
    await click('install-all');
    await answerModal(page, true);
    await watch((s) => s.flow && /Passo 1 de 2/.test(s.flow) && s.value >= 10);
    assert.equal(await ev('document.activeElement && document.activeElement.dataset.act'), 'cancel-flow', 'o foco acompanha o botão (o teclado não se perde)');
    await click('cancel-flow');
    await waitCard('missing');
    assert.match(await cardText(), /Instalação cancelada/);
    assert.equal(await ev(`(document.querySelector('${CARD} .tr-main .tr-error') || {}).textContent || null`), null, 'cancelar não é erro (o do modelo Tiny, do passo 5, fica na linha dele até a próxima tentativa)');
    assert.equal(await tab(), 'tools', 'cancelou: continua na aba Ferramentas');
    assert.deepEqual(listTree(toolsDir).concat(listTree(modelsDir)), [], 'cancelar não deixa arquivo (nem .tmp, nem .part)');
    assert.equal(modelSrv.requests.length > 0, true);
    assert.equal(modelSrv.requests.filter((r) => /small/.test(r.url)).length, 2, 'o modelo Pequeno só foi pedido nas duas instalações completas (a cancelada nem chegou nele)');
    assert.equal(await ev('BF.state.tools.whisper'), null);
    await shot(page, 'transcricao-cancelada');
    step('cancelar no passo 1: mensagem neutra, sem erro, nada no disco e o modelo nem é pedido');

    h.assertNoConsoleErrors(page);
    await app.stop(); app = null;
    console.log('\nE2E DA TRANSCRIÇÃO OK');
  } finally {
    try { if (app) await app.stop(); } catch { /* já fechado */ }
    for (const s of servers) { try { await s.close(); } catch { /* já fechado */ } }
    await h.cleanupAll();
    h.removeDir(tmp);
  }
}

main().then(() => process.exit(0), (err) => {
  console.error(`\n✖ E2E FALHOU: ${err.stack || err.message}`);
  h.cleanupAll().finally(() => process.exit(1));
});

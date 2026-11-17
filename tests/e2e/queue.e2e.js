'use strict';

/**
 * E2E da aba Fila: abre o app Electron de verdade (perfil de usuário temporário), manda trabalhos reais para
 * a fila (vídeo gerado com ffmpeg, motor de exportação REAL) e controla a interface pelo DevTools Protocol:
 * reordenar (botões e arrastar), pausar/retomar/interromper, cancelar, pular concluído, conflito de nome,
 * tentativas automáticas, recuperação depois de uma queda (kill do processo) e do fechamento do app, e a anotação
 * das exportações no projeto. Uso: node tests/e2e/queue.e2e.js   (BF_E2E_SHOTDIR=<pasta> guarda capturas)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { locateTools } = require('../../src/core/ffmpeg/locate');
const { probeMedia } = require('../../src/core/ffmpeg/probe');
const { projectIdFor } = require('../../src/core/projects/projectStore');
const h = require('./helpers');

const { sleep, waitFor, answerModal } = h;
const tools = locateTools();
const RUNNER = path.resolve(__dirname, '..', 'queue-e2e-runner.js');
const step = (m) => console.log(`✔ ${m}`);

/** Perfis: pequeno (rápido) e grande (demora o bastante para dar tempo de agir na interface). Software, para não depender de GPU. */
const SMALL = { id: 'e2e-360', name: 'Teste 360×640', kind: 'custom', width: 360, height: 640, codec: 'h264', bitrateKbps: 1500, encoder: 'software', fps: 'source', container: 'mp4' };
const BIG = { id: 'e2e-1080', name: 'Teste 1080×1920', kind: 'custom', width: 1080, height: 1920, codec: 'h264', bitrateKbps: 12000, encoder: 'software', fps: 'source', container: 'mp4' };

// ---------- auxiliares de interface ----------

const jq = JSON.stringify;
const rows = (page) => page.eval(`[...document.querySelectorAll('#tabpanel-queue li.q-job')].map((li) => ({
  id: li.dataset.id, state: li.dataset.state, name: li.querySelector('.q-name').textContent,
  chip: li.querySelector('.q-chip').textContent, text: li.textContent,
  buttons: [...li.querySelectorAll('button')].filter((b) => !b.disabled).map((b) => b.dataset.act),
  list: li.parentElement.getAttribute('aria-label')
}))`);
const names = async (page, list) => (await rows(page)).filter((r) => !list || r.list === list).map((r) => r.name);
const stateOf = async (page, name) => ((await rows(page)).find((r) => r.name === name) || {}).state;
const clickRow = (page, name, act) => page.eval(`(() => {
  const li = [...document.querySelectorAll('#tabpanel-queue li.q-job')].find((l) => l.querySelector('.q-name').textContent === ${jq(name)});
  const b = li && li.querySelector('button[data-act=${jq(act)}]');
  if (!b || b.disabled) throw new Error('botão ${act} indisponível em ${name}');
  b.click();
})()`);
const clickPanel = (page, act) => page.eval(`(() => {
  const b = document.querySelector('#tabpanel-queue [data-act=${jq(act)}]:not([data-id])');
  if (!b || b.disabled || b.hidden) throw new Error('botão ${act} indisponível');
  b.click();
})()`);
const panelText = (page) => page.eval("document.getElementById('tabpanel-queue').textContent");
/** As pílulas da tela Exportações com a contagem ("Fila (3)") e o clique numa delas ('queue' | 'done' | 'failed'). */
const pills = (page) => page.eval("[...document.querySelectorAll('#tabpanel-queue .q-pill')].map((b) => b.textContent)");
const clickPill = (page, key) => page.eval(`document.querySelector('#tabpanel-queue [data-tab=${jq(key)}]').click()`);
const shownList = (page) => page.eval("[...document.querySelectorAll('#tabpanel-queue ul.q-list')].filter((u) => !u.hidden).map((u) => u.dataset.list).join()");
const waitState = (page, name, state, timeout = 90000) => waitFor(page, `[...document.querySelectorAll('#tabpanel-queue li.q-job')].some((l) => l.querySelector('.q-name').textContent === ${jq(name)} && l.dataset.state === ${jq(state)})`, timeout, `"${name}" ficar ${state}`);
const waitNoModal = (page) => waitFor(page, "!document.querySelector('.bf-modal')", 10000, 'fechar o diálogo');
const api = (page, channel, payload) => page.eval(`BF.api(${jq(channel)}, ${jq(payload || {})})`);

const processAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

/** Mata o app e toda a árvore de processos (como falta de energia) e espera ele sumir de verdade. */
async function kill(app) {
  try { execFileSync('taskkill', ['/PID', String(app.proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* já tinha terminado */ }
  const end = Date.now() + 60000;
  while (processAlive(app.proc.pid) && Date.now() < end) await sleep(100);
}

/**
 * Espera o perfil ficar livre. O Chromium segura o `lockfile` da pasta de dados enquanto algum processo do app anterior ainda existe:
 * num computador ocupado um app morto à força (ou fechado) leva segundos para sumir de verdade, e um app novo aberto nesse intervalo
 * encerra na hora ("Lock file can not be created") — isso não é defeito da fila, só pressa do teste.
 */
async function waitProfileFree(userData, timeout = 60000) {
  const lock = path.join(userData, 'lockfile');
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (!fs.existsSync(lock)) return true;
    try { fs.rmSync(lock); return true; } catch { /* ainda aberto por um processo do app anterior */ }
    await sleep(250);
  }
  return false;
}

/**
 * Apaga a pasta temporária do teste. No Windows um antivírus/indexador pode segurar um arquivo por alguns segundos depois de o app
 * fechar (EPERM/EBUSY): tenta de novo por um tempo e, se ainda não der, só avisa onde ficou. Nunca reprova um teste que passou.
 */
function removeTemp(dir) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try { h.removeDir(dir); return; } catch (err) {
      if (attempt === 8) { console.warn(`! não foi possível apagar ${dir} (${err.code || err.message}); apague a pasta à mão.`); return; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * attempt);
    }
  }
}

async function launch(userData, extra = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await waitProfileFree(userData);
    try {
      // prazo generoso para a janela aparecer: com o computador ocupado (outros testes, antivírus) 40 s podem não bastar e isso não é defeito da fila
      return await h.launchApp(userData, { env: { NODE_ENV: 'test', BF_TEST_QUEUE_RUNNER: RUNNER, ...extra }, timeout: 120000 });
    } catch (err) {
      lastError = err;
      if (!/janela do app não apareceu|porta de depuração|fechou antes/.test(err.message)) throw err;
      console.warn(`! o app não abriu (${err.message}); tentando de novo (${attempt}/3)`);
    }
  }
  throw lastError;
}

async function main() {
  assert.ok(tools.ffmpeg && tools.ffprobe, 'ffmpeg/ffprobe necessários para o teste');
  const tmp = h.mkTemp('e2e-queue');
  const userData = path.join(tmp, 'userdata');
  const source = path.join(tmp, 'gameplay.mp4');
  const other = path.join(tmp, 'outra-live.mp4');
  const out = path.join(tmp, 'Cortes');
  const shotDir = process.env.BF_E2E_SHOTDIR;

  try {
    h.makeSampleVideo(tools.ffmpeg, source, { seconds: 70, size: '1280x720', rate: 30 });
    h.makeSampleVideo(tools.ffmpeg, other, { seconds: 8, size: '640x360', rate: 15 });
    step('vídeos de teste gerados (70 s em 720p e 8 s em 360p)');

    const info = { width: 1280, height: 720, fps: 30, duration: 70, hasAudio: true };
    let seq = 0;
    const job = (name, start, end, extra = {}) => {
      seq += 1;
      return {
        id: `e2e-${seq}`, projectId: 'sem-projeto', projectTitle: 'gameplay', sourcePath: source, sourceInfo: info,
        cut: { id: `corte-${seq}`, title: name, start, end, revision: 1, audio: { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0, history: [] }, subtitles: null, framing: null, exports: [] },
        profile: { ...SMALL }, framing: null, outputDir: out, baseName: name, onConflict: 'ask', createdAt: new Date().toISOString(), ...extra
      };
    };
    const enqueue = (page, jobs, extra = {}) => api(page, 'queue:enqueue', { jobs, ...extra });

    // =====================================================================================
    // 1) aba sem projeto, vazia, com Ajustes recolhidos
    // =====================================================================================
    let app = await launch(userData);
    let page = app.page;
    assert.equal(await page.eval("document.getElementById('app').classList.contains('no-project')"), true);
    assert.equal(await page.eval("document.getElementById('tab-queue').disabled"), false, 'a aba Fila funciona sem projeto');
    await page.eval("BF.ui.selectTab('queue')");
    assert.equal(await page.eval("document.getElementById('tabpanel-queue').hidden"), false);
    await waitFor(page, "(() => { const e = document.querySelector('#tabpanel-queue .q-empty'); return !e.hidden && /Nada na fila/.test(e.textContent); })()", 15000, 'o estado vazio visível');
    assert.equal(await page.eval("document.querySelector('#tab-queue .tab-badge').hidden"), true, 'sem selo quando não há nada ativo');
    assert.equal(await page.eval("document.querySelector('#tabpanel-queue details.q-settings').open"), false, 'Ajustes recolhidos');
    assert.equal(await page.eval("[...document.querySelectorAll('#tabpanel-queue button')].filter((b) => !b.disabled && b.getClientRects().length).length"), 0, 'tela vazia sem botões soltos');
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#tabpanel-queue details.q-settings select')].map((s) => s.value)"), ['2', 'ask', 'ask', 'low', '0', '1024']);
    assert.equal(await page.eval("document.getElementById('q-parallel').value"), '', 'o limite de fila mora na barra de saída (padrão das Preferências)');
    assert.match(await page.eval("document.querySelector('#q-parallel option[value=\"\"]').textContent"), /Padrão das Preferências \(1\)/);
    assert.equal(await page.eval("document.querySelector('#tabpanel-queue .q-bar').hidden"), true, 'sem trabalhos as pílulas nem aparecem');
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#tabpanel-queue .q-out-item')].map((i) => !i.hidden)"), [false, false, true], 'sem projeto a barra de saída mostra só o limite de fila');
    assert.match(await page.eval("document.querySelector('#tabpanel-queue .q-intro').textContent"), /Acompanhe o progresso dos seus cortes e exportações/);
    assert.equal(await page.eval("document.getElementById('pageTitle').textContent"), 'Exportações');
    step('tela Exportações abre sem projeto: vazia, sem botões soltos, só o limite na barra de saída e Ajustes recolhidos com os padrões (1 por vez, 2 tentativas, perguntar)');

    // ajuste pela interface vai para o queue.json
    await page.eval("document.querySelector('#tabpanel-queue details.q-settings').open = true");
    await page.eval("(() => { const s = document.getElementById('q-retries'); s.value = '3'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await waitFor(page, "BF.queue.state.settings && BF.queue.state.settings.retries === 3");
    await page.eval("(() => { const s = document.getElementById('q-parallel'); s.value = '2'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await waitFor(page, "BF.queue.state.settings.parallel === 2");
    await sleep(300);
    const saved0 = JSON.parse(fs.readFileSync(path.join(userData, 'queue.json'), 'utf8'));
    assert.deepEqual(saved0.settings, { parallel: 2, retries: 3, recovery: 'ask', onConflict: 'ask', lowPriority: true, encodeThreads: 0, minFreeMemoryMb: 1024 });
    step('ajustes alterados na interface foram gravados em queue.json');
    await page.eval("(() => { const s = document.getElementById('q-parallel'); s.value = '1'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await waitFor(page, "BF.queue.state.settings.parallel === 1");

    // =====================================================================================
    // 2) fila pausada: reordenar (botões e arrastar), remover; depois retomar e exportar de verdade
    // =====================================================================================
    await api(page, 'queue:pause');
    const batch = [job('Alfa', 2, 5), job('Bravo', 8, 11), job('Charlie', 14, 17), job('Delta', 20, 23), job('Eco', 26, 29)];
    const enq = await enqueue(page, batch);
    assert.equal(enq.ok, true, enq.message);
    await waitFor(page, "document.querySelectorAll('#tabpanel-queue li.q-job').length === 5");
    assert.deepEqual(await names(page), ['Alfa', 'Bravo', 'Charlie', 'Delta', 'Eco'], 'ordem de entrada');
    assert.equal(await page.eval("document.querySelector('#tab-queue .tab-badge').textContent"), '5', 'selo com a contagem de ativos');
    assert.deepEqual(await pills(page), ['Fila (5)', 'Concluídos (0)', 'Falhas (0)'], 'as pílulas contam o que há em cada uma');
    assert.equal(await page.eval("document.querySelector('#tabpanel-queue .q-bar').hidden"), false);
    assert.equal(await shownList(page), 'queue', 'a Fila é a pílula mostrada');
    assert.equal(await page.eval("(() => { const n = document.querySelector('#tabpanel-queue .q-paused'); return !n.hidden && n.textContent.startsWith('Fila pausada: nada começa até você retomar'); })()"), true, 'aviso visível de fila pausada');
    assert.equal(await page.eval("document.getElementById('q-pause').textContent"), 'Retomar');
    assert.ok((await rows(page)).every((r) => r.chip === 'Na fila'));
    await waitFor(page, "document.querySelector('#tabpanel-queue li.q-job').getAttribute('draggable') === 'true'");

    // a 2ª chamada de queue:reorder demora 150 ms (máquina carregada): o queue:update do 1º pedido chega ANTES da resposta do 2º
    // e não pode desfazer a tela nem fazer o movimento seguinte partir de uma base velha
    await page.eval(`(() => { const orig = BF.api; let n = 0; window.__bfApiOriginal = orig; BF.api = async (c, p, o) => { if (c === 'queue:reorder' && ++n === 2) await new Promise((r) => setTimeout(r, 150)); return orig(c, p, o); }; })()`);
    const listNames = () => page.eval("[...document.querySelectorAll('#tabpanel-queue li.q-job .q-name')].map((n) => n.textContent).join()");
    await clickRow(page, 'Eco', 'up');
    await waitFor(page, "document.querySelectorAll('#tabpanel-queue li.q-job .q-name')[3].textContent === 'Eco'");
    await clickRow(page, 'Eco', 'up');
    await sleep(100); // o queue:update do 1º pedido já chegou (o main o emite ~40 ms depois)
    assert.equal(await listNames(), 'Alfa,Bravo,Eco,Charlie,Delta', 'a tela não volta atrás quando o queue:update antigo chega');
    await clickRow(page, 'Alfa', 'down');
    await waitFor(page, "[...document.querySelectorAll('#tabpanel-queue li.q-job .q-name')].map((n) => n.textContent).join() === 'Bravo,Alfa,Eco,Charlie,Delta'", 8000, 'ordem após ↑↑↓');
    await sleep(300); // nenhum update tardio muda a ordem depois
    assert.equal(await listNames(), 'Bravo,Alfa,Eco,Charlie,Delta');
    await page.eval('BF.api = window.__bfApiOriginal');
    let order = (await api(page, 'queue:list')).jobs.map((j) => j.cut.title);
    assert.deepEqual(order, ['Bravo', 'Alfa', 'Eco', 'Charlie', 'Delta'], 'o main confirma a nova ordem');
    assert.equal(await page.eval("document.activeElement.dataset.act + ':' + document.activeElement.dataset.id").then((v) => v.startsWith('down:') || v.startsWith('up:')), true, 'o foco do teclado fica no botão usado');
    step('reordenar com ↑/↓ (mesmo com um pedido atrasado) muda a ordem na tela e no main, sem voltar atrás nem perder movimento (e o foco não se perde)');

    // arrastar: Delta (último) para antes de Alfa (2º)
    await page.eval(`(() => {
      const li = (n) => [...document.querySelectorAll('#tabpanel-queue li.q-job')].find((l) => l.querySelector('.q-name').textContent === n);
      const dt = new DataTransfer();
      const from = li('Delta'); const to = li('Alfa');
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const box = to.getBoundingClientRect();
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: box.top + 2 }));
      to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: box.top + 2 }));
      from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    })()`);
    await waitFor(page, "[...document.querySelectorAll('#tabpanel-queue li.q-job .q-name')].map((n) => n.textContent).join() === 'Bravo,Delta,Alfa,Eco,Charlie'", 8000, 'ordem após arrastar');
    order = (await api(page, 'queue:list')).jobs.map((j) => j.cut.title);
    assert.deepEqual(order, ['Bravo', 'Delta', 'Alfa', 'Eco', 'Charlie']);
    step('reordenar arrastando (arrastar e soltar antes do alvo) funciona e o main confirma');

    // remover um da fila
    await clickRow(page, 'Charlie', 'remove');
    await waitFor(page, "document.querySelectorAll('#tabpanel-queue li.q-job').length === 4");
    assert.deepEqual(await names(page), ['Bravo', 'Delta', 'Alfa', 'Eco']);
    assert.equal(await page.eval("document.querySelector('#tab-queue .tab-badge').textContent"), '4');

    // retomar: roda um por vez, na ordem escolhida, de verdade
    await clickPanel(page, 'pause'); // "Retomar"
    await waitState(page, 'Bravo', 'running', 30000);
    assert.equal(await page.eval("document.getElementById('q-pause').textContent"), 'Pausar fila', 'o botão diz que a pausa é da fila');
    assert.match(await page.eval("document.getElementById('q-pause').title"), /o que já está exportando vai até o fim/);
    await waitFor(page, "/\\d+%/.test(document.querySelector('#tabpanel-queue li.q-job[data-state=running] .q-prog-text').textContent)", 30000, 'texto de progresso com porcentagem');
    assert.equal(await page.eval("document.querySelector('#tabpanel-queue li.q-job[data-state=running] progress').max"), 1);
    assert.equal(await page.eval("document.querySelectorAll('#tabpanel-queue li.q-job[data-state=running]').length"), 1, 'um por vez');
    await waitFor(page, "[...document.querySelectorAll('#tabpanel-queue li.q-job')].every((l) => l.dataset.state === 'done')", 120000, 'as 4 exportações terminarem');
    assert.deepEqual((await rows(page)).map((r) => r.chip), ['Concluído', 'Concluído', 'Concluído', 'Concluído']);
    await waitFor(page, "/Fila concluída: 4 exportado/.test(document.getElementById('toasts').textContent)", 5000, 'aviso de fila concluída');
    const doneJobs = (await api(page, 'queue:list')).jobs;
    assert.deepEqual(doneJobs.map((j) => j.cut.title), ['Bravo', 'Delta', 'Alfa', 'Eco'], 'exportou na ordem reordenada');
    for (const j of doneJobs) {
      const probe = await probeMedia(tools.ffprobe, j.output);
      assert.deepEqual([probe.width, probe.height, probe.hasAudio], [360, 640, true], j.output);
      assert.ok(Math.abs(probe.duration - 3) < 0.5, `duração ${probe.duration}`);
    }
    assert.deepEqual(fs.readdirSync(out).sort(), ['Alfa.mp4', 'Bravo.mp4', 'Delta.mp4', 'Eco.mp4'], 'só os 4 arquivos, sem .part');
    step('retomar exporta de verdade, um por vez, na ordem reordenada: 4 arquivos 360×640 com áudio e 3 s');

    // as pílulas: o que terminou saiu da Fila e está em Concluídos; cada pílula mostra só a sua lista e as suas ações
    assert.deepEqual(await pills(page), ['Fila (0)', 'Concluídos (4)', 'Falhas (0)']);
    assert.match(await page.eval("document.querySelector('#tabpanel-queue .q-empty').textContent"), /Nada na fila/);
    assert.equal(await page.eval("document.querySelector('#tabpanel-queue .q-empty').hidden"), false, 'a Fila vazia explica o que aparece nela');
    await clickPill(page, 'done');
    assert.equal(await shownList(page), 'done');
    assert.equal(await page.eval("document.querySelectorAll('#tabpanel-queue ul[data-list=done] li.q-job').length"), 4);
    assert.equal(await page.eval("document.querySelector('#tabpanel-queue .q-empty').hidden"), true);
    assert.equal(await page.eval("document.querySelector('#tabpanel-queue [data-act=clear]').hidden"), false, '"Limpar concluídos" aparece na pílula Concluídos');
    assert.equal(await page.eval("document.querySelector('#tabpanel-queue [data-tab=done]').getAttribute('aria-pressed')"), 'true');
    if (shotDir) await h.screenshot(page, path.join(shotDir, 'exportacoes-concluidos.png'));
    await clickPill(page, 'failed');
    assert.equal(await shownList(page), 'failed');
    assert.match(await page.eval("document.querySelector('#tabpanel-queue .q-empty').textContent"), /Nenhuma falha/);
    await clickPill(page, 'queue');
    assert.equal(await shownList(page), 'queue');
    assert.equal(await page.eval("document.querySelector('#tabpanel-queue [data-act=clear]').hidden"), true, 'fora de Concluídos o botão some');
    step('pílulas Fila (0) | Concluídos (4) | Falhas (0): cada uma mostra só a sua lista, o estado vazio certo e as ações que valem nela');
    if (shotDir) await h.screenshot(page, path.join(shotDir, 'fila-concluida.png'));

    // =====================================================================================
    // 3) pular concluído, conflito de nome (renomear / decidir depois / pular / substituir)
    // =====================================================================================
    await enqueue(page, [job('Bravo', 8, 11)]); // igual ao que já foi exportado
    await waitFor(page, "[...document.querySelectorAll('#tabpanel-queue li.q-job')].some((l) => l.dataset.state === 'skipped')");
    let skipped = (await rows(page)).find((r) => r.state === 'skipped');
    assert.equal(skipped.chip, 'Pulado');
    assert.match(skipped.text, /Já exportado/);
    assert.ok(skipped.buttons.includes('retry') && skipped.buttons.includes('reveal') && skipped.buttons.includes('remove'));
    step('um trabalho já exportado (mesma fonte, intervalo, perfil…) entra como "Pulado", com o motivo e "Exportar de novo"');

    await api(page, 'queue:clearFinished');
    await waitFor(page, "document.querySelectorAll('#tabpanel-queue li.q-job').length === 0");

    // conflito: três arquivos do usuário já na pasta de destino
    for (const n of ['Foxtrot', 'Golf', 'Hotel']) fs.writeFileSync(path.join(out, `${n}.mp4`), `ARQUIVO DO USUARIO ${n}`);
    await enqueue(page, [job('Foxtrot', 30, 33), job('Golf', 34, 37), job('Hotel', 38, 41)]);
    await waitFor(page, "document.querySelector('.bf-modal.q-conflict')", 15000, 'o diálogo de conflito');
    const dlg = await page.eval(`(() => { const d = document.querySelector('.q-conflict'); return {
      role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'), title: d.querySelector('h2').textContent, msg: d.querySelector('.bf-modal-msg').textContent,
      buttons: [...d.querySelectorAll('button')].map((b) => b.textContent), focus: document.activeElement.dataset.act, inert: document.getElementById('app').inert,
      all: !!d.querySelector('#q-conflict-all') } })()`);
    assert.deepEqual([dlg.role, dlg.modal, dlg.title, dlg.inert, dlg.focus, dlg.all], ['dialog', 'true', 'Já existe um arquivo com este nome', true, 'rename', true]);
    assert.deepEqual(dlg.buttons, ['Pular', 'Substituir…', 'Salvar com outro nome']);
    assert.match(dlg.msg, /Foxtrot\.mp4/);
    assert.match(dlg.msg, /Nada será sobrescrito/);
    assert.deepEqual((await rows(page)).map((r) => r.chip), ['Precisa de você', 'Precisa de você', 'Precisa de você']);
    for (const n of ['Foxtrot', 'Golf', 'Hotel']) assert.equal(fs.readFileSync(path.join(out, `${n}.mp4`), 'utf8'), `ARQUIVO DO USUARIO ${n}`, 'nada tocado antes da decisão');
    step('conflito de nome: o diálogo abre (role=dialog, foco em "outro nome"), a tela fica inerte e nenhum arquivo do usuário é tocado');

    // Esc = decidir depois (de todos): os trabalhos continuam esperando e a faixa de aviso oferece "Resolver…"
    await page.press('Escape');
    await waitNoModal(page);
    await sleep(500);
    assert.equal(await page.eval("!!document.querySelector('.bf-modal')"), false, 'Esc adia todos, não só o primeiro');
    await waitFor(page, "/3 exportação\\(ões\\) esperam a sua decisão/.test(document.getElementById('tabpanel-queue').textContent)");
    assert.equal(await page.eval("document.getElementById('app').inert"), false);
    assert.equal(await stateOf(page, 'Foxtrot'), 'needsAction');
    await page.eval("document.querySelector('#tabpanel-queue [data-act=resolve-first]').click()");
    await waitFor(page, "document.querySelector('.bf-modal.q-conflict')", 8000, 'o diálogo reabrir pelo aviso');

    // renomear (só este)
    await page.eval("document.querySelector('.q-conflict [data-act=rename]').click()");
    await waitState(page, 'Foxtrot', 'done', 60000);
    assert.ok(fs.existsSync(path.join(out, 'Foxtrot (2).mp4')), 'salvou como "(2)"');
    assert.equal(fs.readFileSync(path.join(out, 'Foxtrot.mp4'), 'utf8'), 'ARQUIVO DO USUARIO Foxtrot', 'o original ficou intacto');
    assert.equal((await probeMedia(tools.ffprobe, path.join(out, 'Foxtrot (2).mp4'))).width, 360);
    step('"Salvar com outro nome" grava "Foxtrot (2).mp4" e preserva o arquivo do usuário');

    // pular (o diálogo do próximo conflito abre sozinho)
    await waitFor(page, "document.querySelector('.bf-modal.q-conflict')", 8000);
    assert.match(await page.eval("document.querySelector('.q-conflict .bf-modal-msg').textContent"), /Golf\.mp4/);
    await page.eval("document.querySelector('.q-conflict [data-act=skip]').click()");
    await waitState(page, 'Golf', 'skipped');
    assert.equal(fs.readFileSync(path.join(out, 'Golf.mp4'), 'utf8'), 'ARQUIVO DO USUARIO Golf');

    // substituir exige confirmação extra; voltar mantém o diálogo; confirmar troca só depois do sucesso
    await waitFor(page, "document.querySelector('.bf-modal.q-conflict')", 8000);
    assert.match(await page.eval("document.querySelector('.q-conflict .bf-modal-msg').textContent"), /Hotel\.mp4/);
    await page.eval("document.querySelector('.q-conflict [data-act=replace]').click()");
    const sure = await answerModal(page, false); // "Voltar"
    assert.equal(sure.title, 'Substituir o arquivo existente?');
    assert.match(sure.message, /só quando a exportação terminar com sucesso/);
    await waitFor(page, "document.querySelector('.bf-modal.q-conflict')", 8000, 'voltar ao diálogo de escolha');
    assert.equal(fs.readFileSync(path.join(out, 'Hotel.mp4'), 'utf8'), 'ARQUIVO DO USUARIO Hotel', 'sem confirmar nada muda');
    await page.eval("document.querySelector('.q-conflict [data-act=replace]').click()");
    await answerModal(page, true);
    await waitState(page, 'Hotel', 'done', 60000);
    const replaced = await probeMedia(tools.ffprobe, path.join(out, 'Hotel.mp4'));
    assert.deepEqual([replaced.width, replaced.height], [360, 640], 'Hotel.mp4 agora é o vídeo novo');
    assert.ok(!fs.readdirSync(out).some((f) => f.endsWith('.part')));
    step('"Pular" mantém o arquivo; "Substituir…" pede confirmação extra (voltar não muda nada) e só troca ao concluir');

    // "Exportar de novo" explícito num pulado: o arquivo existe, então a fila pergunta de novo (nunca sobrescreve em silêncio)
    await clickRow(page, 'Golf', 'retry');
    await waitFor(page, "document.querySelector('.bf-modal.q-conflict')", 8000);
    await page.eval("document.querySelector('.q-conflict [data-act=skip]').click()");
    await waitNoModal(page);
    await waitState(page, 'Golf', 'skipped');
    await api(page, 'queue:clearFinished');
    await waitFor(page, "document.querySelectorAll('#tabpanel-queue li.q-job').length === 0");

    // =====================================================================================
    // 4) tentativas automáticas (falha passageira injetada no executor) e falha com causa e solução
    // =====================================================================================
    await api(page, 'queue:setSettings', { retries: 2 });
    await enqueue(page, [job('Instável', 42, 45)]);
    await waitFor(page, "/Nova tentativa em \\d+ s \\(tentativa 2 de 3\\)/.test(document.getElementById('tabpanel-queue').textContent)", 20000, 'a contagem regressiva da nova tentativa');
    assert.equal(await stateOf(page, 'Instável'), 'queued');
    await waitState(page, 'Instável', 'done', 60000);
    assert.equal((await api(page, 'queue:list')).jobs.find((j) => j.cut.title === 'Instável').runs, 3, '1 execução + 2 tentativas automáticas');
    step('falha passageira: a tela mostra "Nova tentativa em N s (tentativa 2 de 3)" e o trabalho conclui na terceira execução');

    await api(page, 'queue:setSettings', { retries: 1 });
    await enqueue(page, [job('Instável 5', 46, 49)]); // falha mais vezes que o limite
    await waitState(page, 'Instável 5', 'failed', 60000);
    let failed = (await rows(page)).find((r) => r.name === 'Instável 5');
    assert.match(failed.text, /ffmpeg encerrou de forma inesperada/);
    assert.match(failed.text, /Se repetir, abra o vídeo de origem/, 'a solução aparece junto da causa');
    assert.ok(failed.buttons.includes('retry') && failed.buttons.includes('remove'));
    assert.equal((await api(page, 'queue:list')).jobs.find((j) => j.cut.title === 'Instável 5').runs, 2, 'limitado: 1 + 1 tentativa');
    assert.equal(await page.eval("document.querySelectorAll('#tabpanel-queue .q-tech').length > 0"), true, 'detalhes técnicos recolhidos');
    assert.equal((await pills(page)).at(-1), 'Falhas (1)');
    assert.equal(await page.eval("document.querySelector('#tabpanel-queue [data-tab=failed]').classList.contains('q-pill-bad')"), true, 'a pílula Falhas chama a atenção');
    await clickPill(page, 'failed');
    assert.equal(await shownList(page), 'failed');
    assert.match(await page.eval("document.querySelector('#tabpanel-queue ul[data-list=failed]').textContent"), /Se repetir, abra o vídeo de origem/, 'a falha, a causa e a solução estão na pílula Falhas');
    if (shotDir) await h.screenshot(page, path.join(shotDir, 'exportacoes-falhas.png'));
    await clickPill(page, 'queue');
    step('depois do limite de tentativas o trabalho vira "Falhou", com causa, solução e detalhes técnicos recolhidos, e aparece na pílula Falhas (1)');

    // falha não recuperável: perfil inválido (largura ímpar) bloqueia só aquele trabalho
    await enqueue(page, [job('Quebrado', 50, 53, { profile: { ...SMALL, width: 361 } }), job('Depois', 54, 57)]);
    await waitState(page, 'Quebrado', 'failed', 30000);
    await waitState(page, 'Depois', 'done', 60000);
    failed = (await rows(page)).find((r) => r.name === 'Quebrado');
    assert.match(failed.text, /precisa ser par/i);
    assert.equal((await api(page, 'queue:list')).jobs.find((j) => j.cut.title === 'Quebrado').runs, 1, 'não recuperável: sem nova tentativa');
    step('falha não recuperável (perfil inválido) vai direto para "Falhou" com a solução; o resto da fila segue');
    await api(page, 'queue:clearFinished', { includeFailed: true });
    await waitFor(page, "document.querySelectorAll('#tabpanel-queue li.q-job').length === 0");

    // =====================================================================================
    // 5) pausar e interromper / cancelar com exportações longas
    // =====================================================================================
    const long = (name, extra = {}) => job(name, 5, 45, { profile: { ...BIG }, ...extra });
    await enqueue(page, [long('Longo 1'), long('Longo 2', { cut: { ...job('x', 0, 1).cut, id: 'l2', title: 'Longo 2', start: 10, end: 50 } })]);
    await waitState(page, 'Longo 1', 'running', 30000);
    await waitFor(page, "[...BF.queue.state.progress.values()].some((v) => v.p > 0.03)", 60000, 'a exportação longa andar');
    await clickPanel(page, 'pause');
    await waitFor(page, "(() => { const note = document.querySelector('#tabpanel-queue .q-paused'); return !note.hidden && /Fila pausada: nada novo começa\\. 1 exportação\\(ões\\) em andamento vão até o fim/.test(note.textContent) && !document.querySelector('#tabpanel-queue [data-act=interrupt]').hidden; })()", 15000, 'o aviso de fila pausada com "Interromper os atuais"');
    assert.equal(await stateOf(page, 'Longo 1'), 'running', 'pausar sozinho não interrompe o que já está rodando');
    await clickPanel(page, 'interrupt');
    const ask = await answerModal(page, true);
    assert.match(ask.message, /recomeça do início quando você retomar/);
    assert.doesNotMatch(ask.message, /ffmpeg/i, 'sem jargão no diálogo');
    await waitState(page, 'Longo 1', 'interrupted', 30000);
    assert.match((await rows(page)).find((r) => r.name === 'Longo 1').text, /Volta à fila ao retomar e a exportação recomeça do início/);
    assert.deepEqual(fs.readdirSync(out).filter((f) => f.endsWith('.part')), [], 'nenhum .part sobrou');
    assert.equal(await stateOf(page, 'Longo 2'), 'queued');
    step('pausar e interromper: o em andamento vira "Interrompido" (com aviso de que recomeça do início) e nenhum .part sobra');

    await clickPanel(page, 'pause'); // Retomar
    await waitState(page, 'Longo 1', 'running', 30000);
    await waitFor(page, "[...BF.queue.state.progress.values()].some((v) => v.p > 0.03)", 60000);
    await clickRow(page, 'Longo 1', 'cancel');
    await waitState(page, 'Longo 1', 'cancelled', 30000);
    await waitState(page, 'Longo 2', 'running', 30000);
    await waitFor(page, "[...BF.queue.state.progress.values()].some((v) => v.p > 0.03)", 60000);
    // com um só ativo o "Cancelar tudo" nem aparece: cancela pela linha
    await clickRow(page, 'Longo 2', 'cancel');
    await waitState(page, 'Longo 2', 'cancelled', 30000);
    await sleep(500);
    assert.deepEqual(fs.readdirSync(out).filter((f) => f.endsWith('.part') || /Longo/.test(f)), [], 'cancelar mata o ffmpeg e limpa o .part; nada de "Longo" pela metade');
    assert.deepEqual((await rows(page)).filter((r) => /Longo/.test(r.name)).map((r) => r.chip), ['Cancelado', 'Cancelado']);
    step('cancelar pela linha interrompe o ffmpeg de verdade e não deixa .part nem arquivo pela metade; o próximo da fila assume');
    await api(page, 'queue:clearFinished');

    // "Cancelar tudo" (com confirmação)
    await enqueue(page, [long('Tudo 1', { cut: { ...job('x', 0, 1).cut, id: 't1', title: 'Tudo 1', start: 3, end: 40 } }), long('Tudo 2', { cut: { ...job('x', 0, 1).cut, id: 't2', title: 'Tudo 2', start: 4, end: 41 } }), long('Tudo 3', { cut: { ...job('x', 0, 1).cut, id: 't3', title: 'Tudo 3', start: 5, end: 42 } })]);
    await waitState(page, 'Tudo 1', 'running', 30000);
    await waitFor(page, "!!document.querySelector('#tabpanel-queue [data-act=cancel-all]') && !document.querySelector('#tabpanel-queue [data-act=cancel-all]').hidden");
    await clickPanel(page, 'cancel-all');
    assert.match((await answerModal(page, true)).title, /Cancelar 3 trabalho/);
    await waitFor(page, "[...document.querySelectorAll('#tabpanel-queue li.q-job')].every((l) => l.dataset.state === 'cancelled')", 30000, 'tudo cancelado');
    await sleep(500);
    assert.deepEqual(fs.readdirSync(out).filter((f) => f.endsWith('.part') || /Tudo/.test(f)), []);
    await api(page, 'queue:clearFinished');
    step('"Cancelar tudo" pede confirmação, cancela os 3 e não deixa nada pela metade');
    h.assertNoConsoleErrors(page);

    // =====================================================================================
    // 6) projeto: o arquivo exportado é anotado em cut.exports (inclusive o que terminou com outro projeto aberto)
    // =====================================================================================
    await page.eval(`BF.openSource(${jq(source)})`);
    await waitFor(page, "BF.state.project && !document.getElementById('app').classList.contains('no-project')", 30000);
    const projectA = await page.eval("BF.state.project.id");
    await page.eval("BF.project.addCut({ start: 60, end: 63, title: 'Do projeto' }); BF.project.addCut({ start: 64, end: 67, title: 'Do projeto B' })");
    const cutIds = await page.eval("BF.state.project.cuts.map((c) => c.id)");

    // barra de saída: o perfil e o destino do PROJETO ABERTO (os mesmos da aba Exportar) e o limite da fila, nos dois sentidos
    const sameDir = (a, b) => String(a).replace(/\//g, '\\').toLowerCase() === String(b).replace(/\//g, '\\').toLowerCase();
    await page.eval("BF.ui.selectTab('queue')");
    await waitFor(page, "[...document.querySelectorAll('#tabpanel-queue .q-out-item')].every((i) => !i.hidden) && document.querySelectorAll('#q-profile option').length > 3 && !document.getElementById('q-profile').disabled", 30000, 'a barra de saída com o perfil e o destino do projeto');
    const bar = () => page.eval(`({ profile: document.getElementById('q-profile').value, dir: document.getElementById('q-dir').title, shown: document.getElementById('q-dir').textContent, tabProfile: document.getElementById('exp-profile').value, tabDir: document.getElementById('exp-dir').textContent })`);
    const start = await bar();
    assert.equal(start.profile, 'vertical-1080-h264', 'o perfil padrão do projeto');
    assert.equal(start.tabProfile, start.profile, 'a barra e a aba Exportar mostram o mesmo perfil');
    assert.ok(sameDir(start.dir, path.join(tmp, 'Cortes')), `destino padrão: a pasta Cortes ao lado do vídeo (${start.dir})`);
    assert.ok(sameDir(start.tabDir, start.dir), 'a barra e a aba Exportar mostram o mesmo destino');
    const otherProfile = await page.eval("[...document.getElementById('q-profile').options].map((o) => o.value).find((v) => v !== document.getElementById('q-profile').value)");
    await page.eval(`(() => { const s = document.getElementById('q-profile'); s.value = ${jq(otherProfile)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(page, `!!BF.state.project.ext.export && BF.state.project.ext.export.profileId === ${jq(otherProfile)} && document.getElementById('exp-profile').value === ${jq(otherProfile)}`, 15000, 'o perfil escolhido na barra chegar ao projeto e à aba Exportar');
    await page.eval(`(() => { const s = document.getElementById('exp-profile'); s.value = ${jq(start.profile)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(page, `document.getElementById('q-profile').value === ${jq(start.profile)}`, 15000, 'a escolha feita na aba Exportar chegar à barra');
    const newDir = path.join(tmp, 'Outra pasta de cortes');
    await page.eval(`(() => { window.__apiAntes = BF.api; BF.api = async (c, p, o) => (c === 'export:pickDir' ? { ok: true, path: ${jq(newDir)} } : window.__apiAntes(c, p, o)); })()`);
    await page.eval("document.getElementById('q-pick-dir').click()");
    await waitFor(page, `BF.state.project.exportDir === ${jq(newDir)} && document.getElementById('q-dir').title === ${jq(newDir)}`, 15000, 'o destino escolhido na barra chegar ao projeto');
    assert.ok(sameDir(await page.eval("document.getElementById('exp-dir').textContent"), newDir), 'a aba Exportar mostra o mesmo destino');
    await page.eval('BF.api = window.__apiAntes; BF.project.update((p) => { delete p.exportDir; }, { reason: "export:dir" }); true');
    await waitFor(page, "document.getElementById('q-dir').title === BF.util.joinPath(BF.util.dirOf(BF.state.project.source.path), 'Cortes')", 15000, 'o destino voltar ao padrão');
    if (shotDir) await h.screenshot(page, path.join(shotDir, 'exportacoes-barra-de-saida.png'));
    h.assertNoConsoleErrors(page);
    step('barra de saída com projeto aberto: perfil e destino são os da aba Exportar, e escolher em um lugar atualiza o outro');
    const pjob = (index, title) => job(title, 60 + index * 4, 63 + index * 4, { projectId: projectA, cut: { ...job('x', 0, 1).cut, id: cutIds[index], title, start: 60 + index * 4, end: 63 + index * 4 } });
    await enqueue(page, [pjob(0, 'Do projeto')]);
    await waitFor(page, "BF.state.project.cuts[0].exports.length === 1", 60000, 'o corte ganhar a exportação');
    const exp = await page.eval("BF.state.project.cuts[0].exports[0]");
    assert.equal(exp.path, path.join(out, 'Do projeto.mp4'));
    assert.deepEqual([exp.start, exp.end, exp.profile.id], [60, 63, 'e2e-360']);
    await page.eval('BF.project.flush()');
    const onDisk = JSON.parse(fs.readFileSync(path.join(userData, 'projects', `${projectIdFor(source)}.json`), 'utf8'));
    assert.equal(onDisk.cuts[0].exports[0].path, exp.path, 'a anotação foi salva no projeto');
    step('com o projeto aberto, o arquivo exportado é anotado em cut.exports e salvo no projeto');

    // termina com OUTRO projeto aberto -> reconcilia ao abrir o projeto original
    await page.eval(`BF.openSource(${jq(other)})`);
    await waitFor(page, `BF.state.project && BF.state.project.source.path === ${jq(other)}`, 30000);
    await enqueue(page, [pjob(1, 'Do projeto B')]);
    await waitFor(page, "BF.queue.state.jobs.some((j) => j.cut.title === 'Do projeto B' && j.state === 'done')", 60000);
    await sleep(300);
    await page.eval(`BF.openSource(${jq(source)})`);
    await waitFor(page, `BF.state.project && BF.state.project.source.path === ${jq(source)} && BF.state.project.cuts.length === 2 && BF.state.project.cuts[1].exports.length === 1`, 30000, 'a reconciliação anotar o que terminou com outro projeto aberto');
    assert.deepEqual(await page.eval("BF.state.project.cuts.map((c) => c.exports.map((e) => e.path.split('\\\\').pop()))"), [['Do projeto.mp4'], ['Do projeto B.mp4']]);
    step('o que terminou com outro projeto aberto é anotado ao reabrir o projeto original (reconciliação com queue:list)');
    await api(page, 'queue:clearFinished');
    h.assertNoConsoleErrors(page);

    // =====================================================================================
    // 7) fechar o app (graceful) com exportação em andamento -> "interrupted" -> banner -> Descartar
    // =====================================================================================
    const lg = (name, id, shift = 0) => long(name, { cut: { ...job('x', 0, 1).cut, id, title: name, start: 6 + shift, end: 50 + shift } }); // intervalos diferentes: o mesmo trabalho já concluído seria pulado
    await enqueue(page, [lg('Queda 1', 'q1'), job('Depois da queda', 15, 18)]);
    await waitState(page, 'Queda 1', 'running', 30000);
    await waitFor(page, "[...BF.queue.state.progress.values()].some((v) => v.p > 0.03)", 60000);
    assert.ok(fs.readdirSync(out).some((f) => f.endsWith('.part')), 'há um .part no meio da exportação');
    await app.stop(); // fecha a janela: before-quit grava o estado e limpa o .part do que estava rodando
    assert.deepEqual(fs.readdirSync(out).filter((f) => f.endsWith('.part')), [], 'fechar o app no meio da exportação não deixa .part na pasta do usuário');
    const closed = JSON.parse(fs.readFileSync(path.join(userData, 'queue.json'), 'utf8'));
    assert.deepEqual(closed.jobs.map((j) => [j.cut.title, j.state]), [['Queda 1', 'interrupted'], ['Depois da queda', 'queued']]);
    assert.equal(closed.jobs[0].interruptedBy, 'shutdown');
    app = await launch(userData);
    page = app.page;
    await page.eval("BF.ui.selectTab('queue')");
    await waitFor(page, "/A fila foi interrompida quando o app fechou: 1 exportação/.test(document.getElementById('tabpanel-queue').textContent)", 20000, 'o aviso de recuperação');
    assert.equal(await stateOf(page, 'Queda 1'), 'interrupted');
    assert.equal(await stateOf(page, 'Depois da queda'), 'queued');
    assert.match(await panelText(page), /A fila está em espera/);
    assert.equal(await page.eval("document.getElementById('q-pause').textContent"), 'Retomar');
    await sleep(500);
    assert.equal(await stateOf(page, 'Depois da queda'), 'queued', 'nada recomeça sem a decisão');
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#tabpanel-queue .q-notice [data-act]')].map((b) => b.textContent)"), ['Retomar', 'Descartar']);
    await page.eval("document.querySelector('#tabpanel-queue [data-act=recover-discard]').click()");
    await waitState(page, 'Queda 1', 'cancelled', 15000);
    await waitState(page, 'Depois da queda', 'done', 60000);
    assert.match((await rows(page)).find((r) => r.name === 'Queda 1').text, /Descartado ao reabrir/);
    assert.deepEqual(fs.readdirSync(out).filter((f) => f.endsWith('.part')), [], 'nenhum .part na pasta depois de descartar');
    assert.equal(await page.eval("!!document.querySelector('#tabpanel-queue .q-notice')"), false, 'o aviso some depois da decisão');
    step('fechar o app com exportação em andamento: o .part não fica na pasta; ao reabrir aparece o aviso (Retomar/Descartar), nada recomeça sozinho; "Descartar" cancela só o interrompido e a fila segue');
    await api(page, 'queue:clearFinished');

    // =====================================================================================
    // 8) queda de verdade (kill do processo, como falta de energia) -> Retomar recomeça do início
    // =====================================================================================
    await enqueue(page, [lg('Queda 2', 'q2', 1)]);
    await waitState(page, 'Queda 2', 'running', 30000);
    await waitFor(page, "[...BF.queue.state.progress.values()].some((v) => v.p > 0.03)", 60000);
    assert.ok(fs.readdirSync(out).some((f) => f.endsWith('.part')), 'há um .part no meio da exportação');
    await sleep(600); // o estado "running" já foi gravado
    await kill(app);
    await sleep(300);
    const crashed = JSON.parse(fs.readFileSync(path.join(userData, 'queue.json'), 'utf8'));
    assert.equal(crashed.jobs.find((j) => j.cut.title === 'Queda 2').state, 'running', 'o disco ficou com "running": o app não teve chance de gravar nada');
    app = await launch(userData);
    page = app.page;
    await page.eval("BF.ui.selectTab('queue')");
    await waitFor(page, "/A fila foi interrompida quando o app fechou/.test(document.getElementById('tabpanel-queue').textContent)", 20000, 'o aviso de recuperação depois da queda');
    assert.equal(await stateOf(page, 'Queda 2'), 'interrupted');
    assert.match((await rows(page)).find((r) => r.name === 'Queda 2').text, /O app foi fechado com este trabalho em andamento/);
    await page.eval("document.querySelector('#tabpanel-queue [data-act=recover-resume]').click()");
    await waitState(page, 'Queda 2', 'running', 30000);
    await waitState(page, 'Queda 2', 'done', 180000);
    const recovered = await probeMedia(tools.ffprobe, path.join(out, 'Queda 2.mp4'));
    assert.deepEqual([recovered.width, recovered.height], [1080, 1920]);
    assert.ok(Math.abs(recovered.duration - 44) < 1, `duração ${recovered.duration}`);
    assert.deepEqual(fs.readdirSync(out).filter((f) => f.endsWith('.part')), [], 'o .part da queda foi descartado');
    step('queda de verdade (processo morto): ao reabrir o job está "Interrompido"; "Retomar" refaz do início e o arquivo final é válido, sem .part');

    // recuperação automática (configuração "resume")
    await api(page, 'queue:setSettings', { recovery: 'resume' });
    await api(page, 'queue:clearFinished');
    await enqueue(page, [lg('Queda 3', 'q3', 2)]);
    await waitState(page, 'Queda 3', 'running', 30000);
    await waitFor(page, "[...BF.queue.state.progress.values()].some((v) => v.p > 0.03)", 60000);
    await sleep(600);
    await kill(app);
    await sleep(300);
    app = await launch(userData);
    page = app.page;
    await page.eval("BF.ui.selectTab('queue')");
    await waitState(page, 'Queda 3', 'running', 30000);
    assert.equal(await page.eval("!!document.querySelector('#tabpanel-queue [data-act=recover-resume]')"), false, 'sem pergunta quando a configuração é "retomar sozinho"');
    await clickRow(page, 'Queda 3', 'cancel');
    await waitState(page, 'Queda 3', 'cancelled', 30000);
    step('com a recuperação em "Retomar sozinho", o app reabre e continua sem perguntar');
    await api(page, 'queue:setSettings', { recovery: 'ask' });

    // =====================================================================================
    // 9) finalização
    // =====================================================================================
    const errors = page.errors.filter((e) => !/Failed to load resource: net::ERR_FILE_NOT_FOUND/.test(e));
    assert.deepEqual(errors, [], `erros de console: ${errors.join(' | ')}`);
    h.assertNoConsoleErrors(page);
    step('nenhum erro de console no app');
    if (shotDir) await h.screenshot(page, path.join(shotDir, 'fila-final.png'));
    await app.stop();
    console.log('\nE2E DA FILA OK');
  } finally {
    await h.cleanupAll();
    removeTemp(tmp);
  }
}

main().then(() => process.exit(0), (err) => {
  console.error(`\n✖ E2E DA FILA FALHOU: ${err.stack || err.message}`);
  h.cleanupAll().finally(() => process.exit(1));
});

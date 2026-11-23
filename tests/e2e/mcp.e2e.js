'use strict';

/**
 * E2E do servidor MCP (agentes de IA externos), no app Electron de verdade (perfil temporário, vídeo gerado). Um "agente" de mentira fala JSON-RPC por
 * HTTP com o servidor local, exatamente como o Antigravity ou o Claude fariam. Confere:
 *  - desligado por padrão; o cartão "Agentes de IA (MCP)" da tela Geral liga o servidor, mostra a porta e só então os botões de copiar;
 *  - segurança: sem token, com token errado, com Origin de navegador, com Host que não é o local e com método errado, tudo recusado;
 *  - initialize e a lista FIXA de ferramentas (leitura e ação, com as anotações);
 *  - as ferramentas de leitura devolvem o que está na janela e NENHUM caminho de arquivo;
 *  - as de ação: confirmação NO APP (recusar não muda nada; aceitar muda o projeto aberto e dá para desfazer), erro direto sem janela quando o pedido
 *    é impossível, e a confirmação dispensada (aviso na tela em vez da janela);
 *  - a ponte stdio, o token novo (o antigo deixa de valer) e o desligamento.
 * Uso: node tests/e2e/mcp.e2e.js     (BF_E2E_SHOTDIR=C:\pasta guarda capturas da janela)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { locateTools } = require('../../src/core/ffmpeg/locate');
const { CONTRAST, SMALL, NAMELESS } = require('./a11y');
const h = require('./helpers');

const { sleep, waitFor, answerModal, modalOpen } = h;
const j = JSON.stringify;

const READ_TOOLS = ['app_overview', 'projects_list', 'project_get', 'transcript_get', 'transcription_status', 'analysis_status', 'queue_status'];
const ACTION_TOOLS = ['project_open', 'cut_create', 'cut_decide', 'cut_edit', 'transcribe_run', 'analysis_run', 'analysis_add_cuts', 'export_enqueue'];

async function main() {
  const ffmpeg = locateTools().ffmpeg;
  assert.ok(ffmpeg, 'ffmpeg necessário para o teste');
  const tmp = h.mkTemp('e2e-mcp');
  const shotDir = process.env.BF_E2E_SHOTDIR;
  const shot = async (page, name) => { if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); await h.screenshot(page, path.join(shotDir, `${name}.png`)); } };
  const step = (m) => console.log(`✔ ${m}`);
  const videoA = path.join(tmp, 'Partida de teste A.mp4');
  const videoB = path.join(tmp, 'Partida de teste B.mp4');
  let app = null;

  try {
    h.makeSampleVideo(ffmpeg, videoA, { seconds: 20, size: '320x180', rate: 15 });
    h.makeSampleVideo(ffmpeg, videoB, { seconds: 12, size: '320x180', rate: 15 });
    const userData = path.join(tmp, 'ud');
    app = await h.launchApp(userData, { env: { CORTE_WHISPER: '' } });
    const { page } = app;
    const ev = (x) => page.eval(x);
    const a11y = async (where) => {
      await sleep(500); // as cores do app têm transição: a medição só vale depois dela (o ux.e2e.js espera o mesmo tempo)
      assert.deepEqual(JSON.parse(await ev(NAMELESS)), [], `${where}: controles sem nome para o leitor de tela`);
      assert.deepEqual(JSON.parse(await ev(SMALL)), [], `${where}: alvos com menos de 24 px`);
      assert.deepEqual(JSON.parse(await ev(CONTRAST)), [], `${where}: contraste abaixo do mínimo`);
    };

    // dois projetos (A com três cortes pendentes; B vazio), A aberto
    await ev(`BF.openSource(${j(videoB)})`);
    await waitFor(page, "BF.state.project && BF.state.project.source.path.endsWith('B.mp4')", 30000, 'vídeo B aberto');
    const idB = await ev('BF.state.project.id');
    await ev(`BF.openSource(${j(videoA)})`);
    await waitFor(page, "BF.state.project && BF.state.project.source.path.endsWith('A.mp4') && document.getElementById('video').readyState >= 1", 30000, 'vídeo A aberto');
    for (const [title, start, end] of [['Largada', 1, 5], ['Curva fechada', 7, 11], ['Chegada', 14, 19]]) await ev(`BF.project.addCut({ title: ${j(title)}, start: ${start}, end: ${end}, status: 'pending' })`);
    const idA = await ev('BF.state.project.id');
    const cutIds = await ev('BF.state.project.cuts.map((c) => c.id)');
    const statuses = () => ev("BF.state.project.cuts.map((c) => c.title.slice(0, 1) + ':' + c.status).join(' ')");
    assert.equal(await statuses(), 'L:pending C:pending C:pending');

    // ---------- 1) desligado por padrão; o cartão liga o servidor ----------
    assert.deepEqual(await ev("BF.api('mcp:status')").then((s) => [s.ok, s.available, s.enabled, s.running]), [true, true, false, false], 'desligado por padrão');
    assert.equal(fs.existsSync(path.join(userData, 'mcp.json')), false, 'sem arquivo de configuração enquanto nunca foi ligado');
    await ev("BF.ui.selectTab('general')");
    await waitFor(page, "!!document.getElementById('genMcpSwitch')", 15000, 'o cartão dos agentes de IA');
    assert.equal(await ev("document.getElementById('genMcpSwitch').checked"), false);
    assert.match(await ev("document.querySelector('[data-section=\"mcp\"]').textContent"), /Desligado\. Nenhum agente consegue se conectar\./);
    assert.equal(await ev("document.querySelector('[data-section=\"mcp\"] .gen-mcp-running').hidden"), true, 'sem botões de copiar enquanto desligado');
    await ev("document.getElementById('genMcpSwitch').click()");
    await waitFor(page, "/Ligado em 127\\.0\\.0\\.1:\\d+/.test(document.querySelector('[data-section=\"mcp\"]').textContent)", 15000, 'servidor ligado');
    const cfg = JSON.parse(fs.readFileSync(path.join(userData, 'mcp.json'), 'utf8'));
    assert.equal(cfg.enabled, true);
    assert.match(cfg.token, /^[0-9a-f]{64}$/);
    assert.ok(cfg.port >= 1024);
    assert.ok(fs.existsSync(path.join(userData, 'mcp-bridge.js')), 'a ponte stdio foi gravada ao lado');
    assert.equal(await ev("document.querySelector('[data-section=\"mcp\"] .gen-mcp-running').hidden"), false);
    assert.deepEqual(await ev("[...document.querySelectorAll('[data-section=\"mcp\"] button')].map((b) => b.dataset.act)"), ['copy-antigravity', 'copy-http', 'copy-stdio', 'new-token']);
    assert.equal(await ev("document.getElementById('genMcpAutoSwitch').checked"), false, 'a confirmação das ações vem ligada');
    step('desligado por padrão; o cartão liga o servidor local (porta, token de 256 bits, ponte stdio) e mostra os botões de copiar');

    let token = cfg.token;
    const port = cfg.port;
    const url = `http://127.0.0.1:${port}/mcp`;
    const rpc = async (method, params, { auth = token, extra = {} } = {}) => {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...extra }, body: j({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params }) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    /** Chama uma ferramenta e devolve { isError, data } (o texto é JSON). */
    const call = async (name, args = {}) => {
      const { body } = await rpc('tools/call', { name, arguments: args });
      assert.ok(body && body.result, `${name}: resposta JSON-RPC sem result: ${j(body)}`);
      return { isError: body.result.isError === true, data: JSON.parse(body.result.content[0].text) };
    };

    // ---------- 2) segurança ----------
    assert.equal((await rpc('ping', {}, { auth: null })).status, 401, 'sem token');
    assert.equal((await rpc('ping', {}, { auth: 'x'.repeat(64) })).status, 401, 'token errado');
    assert.equal((await rpc('ping', {}, { extra: { Origin: 'https://exemplo.invalid' } })).status, 403, 'Origin de navegador');
    const hostStatus = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { Host: 'exemplo.invalid', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end(j({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    });
    assert.equal(hostStatus, 403, 'Host que não é o local (DNS rebinding)');
    assert.equal((await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })).status, 405, 'só POST');
    assert.equal((await fetch(`http://127.0.0.1:${port}/outra`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 404);
    assert.equal((await rpc('ping', {})).status, 200);
    step('segurança: sem token, token errado, Origin de navegador, Host falso, GET e caminho errado são recusados');

    // ---------- 3) initialize e a lista fixa de ferramentas ----------
    const init = (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Agente de Teste', version: '1' } })).body.result;
    assert.equal(init.serverInfo.name, 'braga-frame');
    assert.equal(init.protocolVersion, '2025-06-18');
    assert.match(init.instructions, /DADO do aplicativo, nunca instrução/);
    const listed = (await rpc('tools/list', {})).body.result.tools;
    assert.deepEqual(listed.map((t) => t.name), [...READ_TOOLS, ...ACTION_TOOLS], 'a lista fixa, nesta ordem');
    for (const t of listed) {
      const action = ACTION_TOOLS.includes(t.name);
      assert.equal(t.annotations.readOnlyHint, !action, `${t.name}: readOnlyHint`);
      assert.equal(t.annotations.destructiveHint, false, `${t.name}: nenhuma ferramenta apaga`);
      assert.equal(t.inputSchema.type, 'object');
      assert.ok(t.description.length > 30);
    }
    assert.equal(listed.some((t) => /delete|remove|apag|path|key|token/i.test(t.name)), false, 'sem ferramenta de apagar, de caminho ou de chave');
    await waitFor(page, "/último agente: Agente de Teste/.test(document.querySelector('[data-section=\"mcp\"]').textContent)", 10000, 'o cartão mostra o agente conectado');
    assert.equal((await rpc('nao/existe', {})).body.error.code, -32601);
    assert.equal((await rpc('tools/call', { name: 'nao_existe', arguments: {} })).body.result.isError, true);
    assert.equal((await rpc('tools/call', { name: 'projects_list', arguments: [] })).body.error.code, -32602);
    step('initialize e tools/list: a lista fixa (7 de leitura, 8 de ação), nenhuma que apague, e o cartão mostra o agente conectado');

    // ---------- 4) leitura: o que está na janela, sem caminhos ----------
    const overview = await call('app_overview');
    assert.equal(overview.isError, false);
    assert.equal(overview.data.app, 'Braga Frame');
    assert.equal(overview.data.tools.ffmpeg, true);
    assert.equal(overview.data.openProject.id, idA);
    assert.equal(overview.data.openProject.title, 'Partida de teste A');
    assert.deepEqual(overview.data.openProject.cuts, { total: 3, pending: 3, approved: 0, rejected: 0 });
    assert.equal(overview.data.transcription.ready, false, 'sem motor de transcrição neste perfil');
    const list = await call('projects_list');
    assert.deepEqual(list.data.projects.map((p) => p.id).sort(), [idA, idB].sort());
    const projA = list.data.projects.find((p) => p.id === idA);
    assert.deepEqual([projA.title, projA.cuts.total, projA.cuts.pending], ['Partida de teste A', 3, 3]);
    const got = await call('project_get', { id: idA });
    assert.deepEqual(got.data.cuts.map((c) => [c.title, c.start, c.end, c.status]), [['Largada', 1, 5, 'pending'], ['Curva fechada', 7, 11, 'pending'], ['Chegada', 14, 19, 'pending']]);
    assert.deepEqual(got.data.cuts.map((c) => c.id), cutIds);
    assert.equal(got.data.durationSec, 20);
    assert.equal(got.data.videoFileMissing, false);
    assert.equal(got.data.transcript.exists, false);
    assert.equal((await call('project_get', { id: 'abc' })).isError, true, 'id inválido');
    assert.match((await call('project_get', { id: 'a'.repeat(16) })).data.error, /Projeto não encontrado/);
    assert.match((await call('transcript_get', { projectId: idA })).data.error, /ainda não tem transcrição/);
    const tr = await call('transcription_status');
    assert.deepEqual([tr.data.ready, tr.data.needs.engine, tr.data.needs.model, tr.data.running], [false, true, true, null]);
    assert.equal((await call('queue_status')).data.jobs.length, 0);
    assert.equal((await call('analysis_status')).data.running, null);
    // NENHUM caminho de arquivo em lugar nenhum
    const everything = [overview, list, got, tr].map((r) => j(r.data)).join('\n');
    assert.equal(everything.includes(tmp), false, 'nenhum resultado traz o caminho da pasta de teste');
    assert.doesNotMatch(everything, /[A-Za-z]:\\\\|\.mp4/, 'nem letras de unidade nem nomes de arquivo de vídeo');
    step('leitura: visão geral, lista e projeto (cortes, tempos, status) batem com a janela; erros claros; nenhum caminho de arquivo nos resultados');

    // ---------- 5) decidir cortes: a confirmação é NO APP ----------
    const act = async (name, args, accept) => {
      const pending = call(name, args); // o servidor espera a janela: só termina depois que o usuário responde
      const asked = await answerModal(page, accept);
      return { asked, result: await pending };
    };
    const noModal = async (what) => { await sleep(150); assert.equal(await modalOpen(page), false, `${what}: erro direto, sem incomodar o usuário com uma janela`); };
    {
      const { asked, result } = await act('cut_decide', { cutIds: [cutIds[0], cutIds[1]], status: 'approved' }, false);
      assert.equal(asked.title, 'Aprovar 2 cortes?');
      assert.match(asked.message, /O agente “Agente de Teste” pede para aprovar/);
      assert.match(asked.message, /• “Largada” \(0:01–0:05\)/);
      assert.match(asked.message, /• “Curva fechada” \(0:07–0:11\)/);
      assert.match(asked.message, /Ctrl\+Z/);
      assert.equal(result.data.declined, true);
      assert.match(result.data.message, /não insista/);
      assert.equal(await statuses(), 'L:pending C:pending C:pending', 'recusar não muda nada');
    }
    {
      const { result } = await act('cut_decide', { cutIds: [cutIds[0], cutIds[1]], status: 'approved' }, true);
      assert.equal(result.isError, false);
      assert.deepEqual([result.data.changed, result.data.unchanged, result.data.missing], [2, 0, []]);
      assert.deepEqual(result.data.cuts.map((c) => c.status), ['approved', 'approved']);
      assert.equal(await statuses(), 'L:approved C:approved C:pending');
      assert.equal(await ev('BF.review.engine.canUndo()'), true);
      await ev('BF.review.engine.undo(); true');
      assert.equal(await statuses(), 'L:pending C:pending C:pending', 'UM Ctrl+Z desfaz tudo o que o agente decidiu na chamada');
      await ev('BF.review.engine.redo(); true');
      assert.equal(await statuses(), 'L:approved C:approved C:pending');
    }
    {
      const same = await call('cut_decide', { cutIds: [cutIds[0]], status: 'approved' });
      assert.deepEqual([same.data.changed, same.data.unchanged], [0, 1], 'já estava aprovado: nada a fazer');
      await noModal('cut_decide sem mudança');
      const bad = await call('cut_decide', { cutIds: ['nao-existe'], status: 'approved' });
      assert.match(bad.data.error, /Nenhum dos cortes informados existe/);
      assert.equal(bad.isError, true);
      await noModal('cut_decide de corte inexistente');
      assert.match((await call('cut_decide', { cutIds: [cutIds[2]], status: 'talvez' })).data.error, /deve ser pending, approved, rejected|"status" deve ser/);
      assert.match((await call('cut_decide', { cutIds: [], status: 'approved' })).data.error, /lista com pelo menos um id/);
      await noModal('argumento inválido');
    }
    step('cut_decide: a janela pergunta (agente, cortes, tempos, Ctrl+Z); recusar não muda nada; aceitar aprova em UM passo de histórico; o impossível dá erro direto, sem janela');

    // ---------- 6) criar e editar cortes ----------
    assert.match((await call('cut_create', { start: 10, end: 5 })).data.error, /fim do corte precisa ser maior/);
    assert.match((await call('cut_create', { start: 10, end: 10.4 })).data.error, /pelo menos 1 segundo/);
    assert.match((await call('cut_create', { start: 10, end: 99 })).data.error, /passa da duração do vídeo \(0:20\)/);
    await noModal('cut_create impossível');
    {
      const { asked, result } = await act('cut_create', { title: 'Melhor momento', start: 3, end: 6 }, false);
      assert.equal(asked.title, 'Criar um corte?');
      assert.match(asked.message, /“Melhor momento” de 0:03 a 0:06 \(3 s\)/);
      assert.match(asked.message, /“Partida de teste A”/);
      assert.equal(result.data.declined, true);
      assert.equal(await ev('BF.state.project.cuts.length'), 3);
    }
    let newId;
    {
      const { result } = await act('cut_create', { title: 'Melhor momento', start: 3, end: 6 }, true);
      assert.equal(result.isError, false);
      newId = result.data.created.id;
      assert.deepEqual([result.data.created.title, result.data.created.start, result.data.created.end, result.data.created.status], ['Melhor momento', 3, 6, 'pending']);
      assert.equal(await ev('BF.state.project.cuts.length'), 4);
      assert.equal(await ev(`BF.project.cut(${j(newId)}).origin`), 'manual');
    }
    {
      const { asked, result } = await act('cut_edit', { cutId: newId, title: 'Melhor momento (ajustado)', start: 3.5, end: 6.5 }, true);
      assert.equal(asked.title, 'Alterar o corte?');
      assert.match(asked.message, /“Melhor momento” \(0:03–0:06\): título “Melhor momento \(ajustado\)” e 0:04 a 0:07/);
      assert.deepEqual([result.data.cut.title, result.data.cut.start, result.data.cut.end], ['Melhor momento (ajustado)', 3.5, 6.5]);
      await ev('BF.review.engine.undo(); true'); // o título volta
      assert.equal(await ev(`BF.project.cut(${j(newId)}).title`), 'Melhor momento');
      await ev('BF.review.engine.undo(); true'); // e o tempo
      assert.deepEqual(await ev(`[BF.project.cut(${j(newId)}).start, BF.project.cut(${j(newId)}).end]`), [3, 6]);
    }
    assert.match((await call('cut_edit', { cutId: 'nao-existe', title: 'x' })).data.error, /não existe no projeto aberto/);
    assert.match((await call('cut_edit', { cutId: newId })).data.error, /Informe o que mudar/);
    assert.match((await call('cut_edit', { cutId: newId, start: 9, end: 8 })).data.error, /fim do corte precisa ser maior/);
    await noModal('cut_edit impossível');
    step('cut_create e cut_edit: validam antes de perguntar (início/fim, duração, corte existente); a janela explica; título e tempo desfazem em passos separados');

    // ---------- 7) análise local: roda de verdade; as sugestões viram cortes pendentes ----------
    assert.match((await call('analysis_add_cuts', {})).data.error, /Informe suggestionIds ou top/);
    assert.match((await call('analysis_add_cuts', { top: 3 })).data.error, /Não há sugestões pendentes/);
    await noModal('analysis_add_cuts sem sugestões');
    {
      const { asked, result } = await act('analysis_run', {}, false);
      assert.equal(asked.title, 'Procurar momentos interessantes?');
      assert.match(asked.message, /análise local/);
      assert.match(asked.message, /nada é enviado para fora/);
      assert.equal(result.data.declined, true);
    }
    {
      const { result } = await act('analysis_run', {}, true);
      assert.equal(result.isError, false, j(result.data));
      assert.equal(result.data.started, true);
      await waitFor(page, "!document.getElementById('anRun') || !document.getElementById('anRun').disabled", 60000, 'a análise terminou');
      let state = null;
      for (let i = 0; i < 120; i += 1) {
        state = (await call('analysis_status')).data;
        if (!state.running && state.openProject && !state.openProject.running && state.openProject.lastRunAt) break;
        await sleep(500);
      }
      assert.equal(state.running, null);
      assert.ok(state.openProject.lastRunAt, 'a análise terminou e guardou o resultado');
      assert.equal(state.openProject.id, idA);
    }
    // sugestões conhecidas, para o resto do teste não depender do que o algoritmo achou no vídeo de teste
    await ev(`BF.project.update((p) => { p.ext = p.ext || {}; p.ext.analysis = { source: { path: p.source.path, size: p.source.size, duration: p.source.duration }, runAt: new Date().toISOString(), suggestions: [
      { id: 's1', start: 11.5, end: 13.8, peak: 12.5, relevance: 0.91, reasons: ['pico de áudio 5σ'] },
      { id: 's2', start: 19.2, end: 20, peak: 19.5, relevance: 0.62, reasons: ['mudança de imagem'] } ] }; }, { reason: 'test' })`);
    {
      const st = (await call('analysis_status')).data.openProject;
      assert.deepEqual(st.suggestions.map((s) => [s.id, s.start, s.end, s.relevance]), [['s1', 11.5, 13.8, 0.91], ['s2', 19.2, 20, 0.62]], 'em ordem de relevância');
      assert.deepEqual(st.suggestions[0].reasons, ['pico de áudio 5σ']);
      const { asked, result } = await act('analysis_add_cuts', { top: 1 }, true);
      assert.equal(asked.title, 'Criar 1 corte a partir da análise?');
      assert.match(asked.message, /nenhum é aprovado/);
      assert.deepEqual(result.data.created.map((c) => [c.start, c.end, c.status]), [[11.5, 13.8, 'pending']]);
      assert.equal(await ev("BF.state.project.cuts.filter((c) => c.origin === 'auto' && c.start === 11.5).length"), 1);
      const again = await call('analysis_add_cuts', { suggestionIds: ['s1'] });
      assert.match(again.data.error, /Nenhuma das sugestões informadas está pendente/, 'a sugestão que virou corte não volta');
      await noModal('sugestão já usada');
    }
    step('análise: roda de verdade só com o algoritmo local (a janela diz que nada sai do computador); as sugestões viram cortes PENDENTES, mais relevantes primeiro, sem repetir');

    // ---------- 8) exportar os aprovados de verdade ----------
    {
      assert.match((await call('export_enqueue', { cutIds: [newId] })).data.error, /Nenhum dos cortes informados está aprovado/);
      await noModal('export sem aprovados');
      const approvedIds = [cutIds[0], cutIds[1]]; // aprovados no passo 5
      assert.equal(await ev(`BF.state.project.cuts.filter((c) => ${j(approvedIds)}.includes(c.id)).every((c) => c.status === 'approved')`), true, 'os dois cortes do passo 5 continuam aprovados');
      const { asked, result } = await act('export_enqueue', { cutIds: [...approvedIds, newId] }, true);
      assert.equal(asked.title, 'Enviar 2 cortes para a fila?');
      assert.match(asked.message, /• “Largada”/);
      assert.match(asked.message, /Perfil: .*Pasta de destino: .*Cortes/s);
      assert.deepEqual([result.data.queued, result.data.alreadyQueuedOrExported, result.data.notApproved], [2, 0, [newId]], 'só os aprovados; o pendente fica de fora e é dito');
      let q = null;
      for (let i = 0; i < 240; i += 1) {
        q = (await call('queue_status')).data;
        if (q.jobs.length === 2 && q.jobs.every((x) => ['done', 'failed'].includes(x.state))) break;
        await sleep(500);
      }
      assert.deepEqual(q.jobs.map((x) => x.state), ['done', 'done'], j(q));
      assert.deepEqual(q.jobs.map((x) => x.cut.title).sort(), ['Curva fechada', 'Largada']);
      const outDir = path.join(tmp, 'Cortes');
      const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.mp4'));
      assert.equal(files.length, 2, `dois cortes exportados em ${outDir}`);
      assert.equal(j(q).includes(tmp), false, 'a fila também sai sem caminhos');
      // a janela pergunta de novo (ela não sabe que a fila já tem esses cortes) e, ENQUANTO o usuário não responde, a chamada fica esperando: nada roda sozinho
      const waiting = call('export_enqueue', {});
      await waitFor(page, "!!document.querySelector('.bf-modal')", 15000, 'a janela de confirmação');
      assert.equal(await Promise.race([waiting.then(() => 'respondeu'), sleep(2500).then(() => 'esperando')]), 'esperando', 'sem resposta do usuário a chamada NÃO termina');
      assert.equal(await ev('BF.api("queue:list").then((q) => q.jobs.length)'), 2, 'e nada novo entrou na fila');
      await answerModal(page, true);
      const again = await waiting;
      assert.equal(again.isError, false, j(again.data));
      assert.deepEqual([again.data.queued, again.data.alreadyQueuedOrExported], [0, 2], `de novo: já exportados, nada duplicado (${j(again.data)})`);
    }
    step('export_enqueue: só os aprovados vão (o pendente é dito), a janela mostra perfil e pasta, a fila exporta de verdade, de novo não duplica');

    // ---------- 9) trocar de projeto e transcrever sem motor ----------
    {
      assert.match((await call('project_open', { id: 'a'.repeat(16) })).data.error, /Projeto não encontrado/);
      await noModal('project_open de projeto inexistente');
      const { asked, result } = await act('project_open', { id: idB }, false);
      assert.equal(asked.title, 'Abrir outro projeto?');
      assert.match(asked.message, /“Partida de teste B”/);
      assert.equal(result.data.declined, true);
      assert.equal(await ev('BF.state.project.id'), idA, 'recusar mantém o projeto aberto');
      const ok = await act('project_open', { id: idB }, true);
      assert.deepEqual([ok.result.data.opened, ok.result.data.id], [true, idB]);
      assert.equal(await ev('BF.state.project.id'), idB);
      assert.equal((await call('app_overview')).data.openProject.id, idB);
      const t = await call('transcribe_run', {});
      assert.equal(t.isError, true);
      assert.match(t.data.error, /motor de transcrição/);
      assert.match(t.data.error, /Configurações > Ferramentas > Transcrição/, 'diz onde o usuário instala');
      assert.equal(t.data.needs.engine, true);
      await noModal('transcribe_run sem motor');
      const other = await call('transcribe_run', { projectId: idA });
      assert.match(other.data.error, /motor de transcrição/);
    }
    step('project_open: a janela pergunta, recusar mantém o projeto, aceitar troca; transcribe_run sem motor explica e aponta onde instalar, sem janela');

    // ---------- 10) a confirmação dispensada: aviso na tela, nada de janela ----------
    await ev("BF.ui.selectTab('general')");
    await ev("document.getElementById('genMcpAutoSwitch').click()");
    const warnAsked = await answerModal(page, false);
    assert.equal(warnAsked.title, 'Não pedir confirmação ao agente?');
    assert.match(warnAsked.message, /continua sem poder apagar nada/);
    assert.equal(await ev("document.getElementById('genMcpAutoSwitch').checked"), false, 'recusar o aviso mantém a confirmação');
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'mcp.json'), 'utf8')).autoConfirm, false);
    await ev("document.getElementById('genMcpAutoSwitch').click()");
    await answerModal(page, true);
    await waitFor(page, "!document.querySelector('.gen-mcp-warn').hidden", 10000, 'o aviso de confirmação dispensada');
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'mcp.json'), 'utf8')).autoConfirm, true);
    const auto = await call('cut_create', { title: 'Sem janela', start: 2, end: 5 });
    assert.equal(auto.isError, false, j(auto.data));
    assert.equal(auto.data.created.title, 'Sem janela');
    await noModal('com a confirmação dispensada');
    await waitFor(page, "/criou o corte “Sem janela”/.test(document.getElementById('toasts').textContent)", 5000, 'o aviso do que o agente fez');
    assert.equal(await ev("BF.state.project.cuts.some((c) => c.title === 'Sem janela')"), true);
    await a11y('Geral com o MCP ligado e a confirmação dispensada');
    await shot(page, 'mcp-cartao');
    step('confirmação dispensada: o aviso explica o risco, a ação roda sem janela e a tela mostra o que o agente fez; o cartão é acessível');
    await ev("document.getElementById('genMcpAutoSwitch').click()"); // volta a pedir (desligar não pergunta)
    await waitFor(page, "document.querySelector('.gen-mcp-warn').hidden", 10000, 'a confirmação voltou');

    // ---------- 11) a ponte stdio ----------
    {
      const child = spawn(process.execPath, [path.join(userData, 'mcp-bridge.js'), path.join(userData, 'mcp.json')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const lines = [];
      let buf = '';
      child.stdout.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) lines.push(JSON.parse(l)); } });
      const ask = async (msg) => { child.stdin.write(`${j(msg)}\n`); await waitFor2(() => lines.find((l) => l.id === msg.id), 15000, `resposta ${msg.method}`); return lines.find((l) => l.id === msg.id); };
      const waitFor2 = async (fn, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await sleep(30); } throw new Error(`Tempo esgotado: ${what}`); };
      try {
        assert.equal((await ask({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'Ponte de Teste' } } })).result.serverInfo.name, 'braga-frame');
        child.stdin.write(`${j({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        const tl = await ask({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        assert.equal(tl.result.tools.length, 15);
        const ov = await ask({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'app_overview', arguments: {} } });
        assert.equal(JSON.parse(ov.result.content[0].text).openProject.id, idB);
      } finally { child.kill(); }
    }
    step('a ponte stdio (para agentes que só sabem rodar um comando) repassa initialize, tools/list e uma chamada ao servidor');

    // ---------- 12) token novo, desligar, religar e reiniciar o app ----------
    await ev("document.querySelector('[data-act=\"new-token\"]').click()");
    const tokAsked = await answerModal(page, true);
    assert.equal(tokAsked.title, 'Gerar um token novo?');
    await sleep(300);
    const fresh = JSON.parse(fs.readFileSync(path.join(userData, 'mcp.json'), 'utf8')).token;
    assert.notEqual(fresh, token);
    assert.equal((await rpc('ping', {})).status, 401, 'o token antigo deixa de valer');
    token = fresh;
    assert.equal((await rpc('ping', {})).status, 200, 'o novo vale');
    await ev("document.getElementById('genMcpSwitch').click()");
    await waitFor(page, "/Desligado\\./.test(document.querySelector('[data-section=\"mcp\"]').textContent)", 10000, 'desligado');
    await assert.rejects(() => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}' }), 'desligado: a porta não atende');
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'mcp.json'), 'utf8')).enabled, false);
    await ev("document.getElementById('genMcpSwitch').click()");
    await waitFor(page, "/Ligado em 127/.test(document.querySelector('[data-section=\"mcp\"]').textContent)", 10000, 'ligado de novo');
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'mcp.json'), 'utf8')).token, token, 'religar mantém o token');
    h.assertNoConsoleErrors(page);
    await app.stop();
    app = await h.launchApp(userData, { env: { CORTE_WHISPER: '' } });
    const back = JSON.parse(fs.readFileSync(path.join(userData, 'mcp.json'), 'utf8'));
    await waitFor(app.page, "BF.api('mcp:status').then((s) => s.running)", 15000, 'o servidor volta sozinho depois de reiniciar o app');
    const res2 = await fetch(`http://127.0.0.1:${back.port}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: j({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    assert.equal(res2.status, 200);
    h.assertNoConsoleErrors(app.page);
    await app.stop(); app = null;
    step('token novo (o antigo deixa de valer), desligar fecha a porta, religar mantém o token, e o servidor volta sozinho ao reiniciar o app');

    console.log('\nE2E DO MCP OK');
  } finally {
    try { if (app) await app.stop(); } catch { /* já fechado */ }
    await h.cleanupAll();
    h.removeDir(tmp);
  }
}

main().then(() => process.exit(0), (err) => {
  console.error(`\n✖ E2E FALHOU: ${err.stack || err.message}`);
  h.cleanupAll().finally(() => process.exit(1));
});

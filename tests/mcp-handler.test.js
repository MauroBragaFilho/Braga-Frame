'use strict';

/**
 * A ligação do MCP com o app (src/ipc/handlers/mcp.js) e o `ctx.call` que ela usa, com os handlers REAIS do app carregados (projetos, fila, análise,
 * legendas) e uma janela de mentira: os canais mcp:*, o servidor ligando e desligando, a configuração pronta na área de transferência (sem o token
 * passar pelo canal), a resposta da janela (mcp:reply), ferramentas de verdade sobre um projeto salvo de verdade e o módulo embutido (sem servidor).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const H = require('./subtitles-helpers');
const { createContext } = require('../src/ipc/context');
const { loadHandlers } = require('../src/ipc');
const { newProject } = require('../src/core/projects/projectStore');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function post(port, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** O app com todos os handlers reais; `window` guarda o que o main mandou à janela. */
function setup({ host = null, available = true, appListeners = null } = {}) {
  const userData = H.tmpDir('bf-mcp-h-');
  const clipboard = { text: '', writeText(t) { this.text = t; } };
  const window = [];
  const fe = H.fakeElectron(userData, {
    resolveTools: () => ({ ffmpeg: H.tools.ffmpeg, ffprobe: H.tools.ffprobe, whisper: null }),
    ...(host ? { host } : {})
  });
  if (appListeners) fe.deps.app.on = (event, fn) => { (appListeners[event] = appListeners[event] || []).push(fn); };
  const ctx = createContext(fe.deps);
  ctx.mcpOptions = { send: (channel, payload) => window.push([channel, payload]), available: () => available, clipboard, version: '9.9.9' };
  const loaded = loadHandlers(ctx);
  return { ctx, fe, userData, clipboard, window, loaded, done: async () => { if (ctx.mcp) await ctx.mcp.service.shutdown(); H.cleanup(userData); } };
}

test('ctx.call: chama o handler do canal por dentro com a mesma conversão do IPC (ok implícito, erro padronizado, canal desconhecido, payload ausente)', async () => {
  const dir = H.tmpDir('bf-ctxcall-');
  try {
    const fe = H.fakeElectron(dir, { resolveTools: () => ({ ffmpeg: null, ffprobe: null }) });
    const ctx = createContext(fe.deps);
    const seen = [];
    ctx.handle('teste:soma', (p) => { seen.push(p); return { total: (p.a || 0) + (p.b || 0) }; });
    ctx.handle('teste:vazio', () => undefined);
    ctx.handle('teste:erro', () => { throw Object.assign(new Error('Não deu.'), { code: 'NAO_DEU' }); });
    assert.deepEqual(await ctx.call('teste:soma', { a: 1, b: 2 }), { ok: true, total: 3 });
    assert.deepEqual(await ctx.call('teste:vazio'), { ok: true });
    assert.deepEqual(await ctx.call('teste:soma'), { ok: true, total: 0 });
    assert.deepEqual(seen.at(-1), {}, 'sem payload: objeto vazio, como no IPC');
    const err = await ctx.call('teste:erro', {});
    assert.deepEqual([err.ok, err.code, err.message], [false, 'NAO_DEU', 'Não deu.']);
    const unknown = await ctx.call('nada:aqui', {});
    assert.deepEqual([unknown.ok, unknown.code], [false, 'UNKNOWN_CHANNEL']);
    assert.match(unknown.message, /Canal desconhecido: nada:aqui/);
    // o mesmo resultado que o canal IPC dá
    assert.deepEqual(await ctx.call('teste:soma', { a: 5, b: 5 }), await fe.call('teste:soma', { a: 5, b: 5 }));
  } finally { H.cleanup(dir); }
});

test('os canais mcp:* existem, nascem DESLIGADOS (sem arquivo, sem porta) e carregam sem falhas junto dos outros handlers', async () => {
  const s = setup();
  try {
    assert.deepEqual(s.loaded.failed, []);
    assert.ok(s.loaded.loaded.includes('mcp.js'));
    for (const channel of ['mcp:status', 'mcp:setEnabled', 'mcp:regenerateToken', 'mcp:setOptions', 'mcp:copyConfig', 'mcp:reply']) assert.ok(s.fe.handlers.has(channel), channel);
    const st = await s.fe.call('mcp:status');
    assert.deepEqual([st.ok, st.available, st.enabled, st.running, st.url, st.autoConfirm, st.error], [true, true, false, false, '', false, '']);
    assert.equal(fs.existsSync(path.join(s.userData, 'mcp.json')), false, 'nada é criado enquanto ninguém liga');
    assert.deepEqual(s.window, [], 'e nenhum evento sai à toa na abertura do app');
  } finally { await s.done(); }
});

test('ligar pelo canal: o servidor sobe, a janela é avisada (mcp:state), copiar manda a configuração à área de transferência SEM o token no canal; token novo, opção e desligar', async () => {
  const s = setup();
  try {
    const on = await s.fe.call('mcp:setEnabled', { enabled: true });
    assert.deepEqual([on.ok, on.running, on.enabled], [true, true, true]);
    assert.match(on.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const token = JSON.parse(fs.readFileSync(path.join(s.userData, 'mcp.json'), 'utf8')).token;
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(on).includes(token), false, 'o token nunca sai por mcp:status');
    assert.ok(fs.existsSync(path.join(s.userData, 'mcp-bridge.js')));
    // um agente conecta: a janela fica sabendo
    s.window.length = 0;
    const init = await post(on.port, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'Antigravity' } } });
    assert.equal(init.json.result.serverInfo.name, 'braga-frame');
    assert.equal(init.json.result.serverInfo.version, '9.9.9');
    const state = s.window.filter(([c]) => c === 'mcp:state').at(-1)[1];
    assert.deepEqual([state.client, state.running, state.available], ['Antigravity', true, true]);
    assert.equal(JSON.stringify(s.window).includes(token), false);
    // copiar
    for (const kind of ['antigravity', 'http', 'stdio']) {
      const res = await s.fe.call('mcp:copyConfig', { kind });
      assert.deepEqual(res, { ok: true, kind });
      assert.ok(JSON.parse(s.clipboard.text).mcpServers['braga-frame']);
    }
    assert.equal(JSON.parse(s.clipboard.text).mcpServers['braga-frame'].command, 'node');
    s.clipboard.text = '';
    const bad = await s.fe.call('mcp:copyConfig', { kind: 'xyz' });
    assert.deepEqual([bad.ok, bad.code, bad.message], [false, 'MCP_CONFIG', 'Formato de agente desconhecido.']);
    assert.equal(s.clipboard.text, '', 'formato inválido: nada é copiado');
    // opção e token novo
    assert.equal((await s.fe.call('mcp:setOptions', { autoConfirm: true })).autoConfirm, true);
    assert.equal((await s.fe.call('mcp:setOptions', { autoConfirm: 'sim' })).autoConfirm, true, 'só booleano: não muda');
    assert.equal((await s.fe.call('mcp:setOptions', { autoConfirm: false })).autoConfirm, false);
    await s.fe.call('mcp:regenerateToken');
    assert.equal((await post(on.port, token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401, 'o token antigo deixa de valer');
    // desligar
    const off = await s.fe.call('mcp:setEnabled', { enabled: false });
    assert.deepEqual([off.running, off.enabled], [false, false]);
    await assert.rejects(post(on.port, token, { jsonrpc: '2.0', id: 1, method: 'ping' }));
    assert.equal((await s.fe.call('mcp:setEnabled', {})).enabled, false, 'sem "enabled: true" não liga');
  } finally { await s.done(); }
});

test('religar na abertura: o app que fechou com o servidor ligado volta com ele ligado (e avisa a janela); fechar o app desliga e recusa o que esperava a janela', async () => {
  const first = setup();
  const userData = first.userData;
  await first.fe.call('mcp:setEnabled', { enabled: true });
  await first.ctx.mcp.service.shutdown(); // o app fecha (a pasta de dados fica: o próximo contexto a reaproveita)
  // "reiniciar": outro contexto sobre a mesma pasta de dados
  const listeners = {};
  const window = [];
  const fe = H.fakeElectron(userData, { resolveTools: () => ({ ffmpeg: H.tools.ffmpeg, ffprobe: H.tools.ffprobe, whisper: null }) });
  fe.deps.app.on = (event, fn) => { (listeners[event] = listeners[event] || []).push(fn); };
  const ctx = createContext(fe.deps);
  ctx.mcpOptions = { send: (c, p) => window.push([c, p]), available: () => true, clipboard: { writeText() {} } };
  try {
    loadHandlers(ctx);
    await sleep(300);
    const st = await fe.call('mcp:status');
    assert.equal(st.running, true, 'voltou ligado');
    assert.ok(window.some(([c, p]) => c === 'mcp:state' && p.running === true), 'a janela foi avisada');
    assert.ok(listeners['before-quit'].length >= 1);
    // um pedido esperando a janela é recusado ao fechar o app
    const pending = ctx.mcp.bridge.request('context', {}, { timeoutMs: 5000 });
    await sleep(20);
    for (const fn of listeners['before-quit']) fn();
    await assert.rejects(pending, (e) => e.code === 'NO_WINDOW' && /está fechando/.test(e.message));
    await sleep(100);
    assert.equal(ctx.mcp.service.status().running, false, 'e o servidor desliga');
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'mcp.json'), 'utf8')).enabled, true, 'mas a escolha do usuário (ligado) continua guardada para a próxima abertura');
  } finally { await ctx.mcp.service.shutdown(); H.cleanup(userData); }
});

test('a janela responde por mcp:reply: o pedido da ferramenta espera a resposta e a usa; resposta repetida ou lixo não é aceita', async () => {
  const s = setup();
  try {
    const run = s.ctx.mcp.toolbox.execute('app_overview', {}, { agent: 'Claude' });
    await sleep(50);
    const request = s.window.find(([c]) => c === 'mcp:request');
    assert.ok(request, 'o pedido saiu para a janela');
    const { id, op } = request[1];
    assert.equal(op, 'context');
    assert.deepEqual(await s.fe.call('mcp:reply', { id: 'desconhecido', ok: true }), { ok: true, accepted: false });
    assert.deepEqual(await s.fe.call('mcp:reply', 'lixo'), { ok: true, accepted: false });
    assert.deepEqual(await s.fe.call('mcp:reply', { id, ok: true, result: { id: 'p1', title: 'Live', durationSec: 60, cuts: { total: 0, pending: 0, approved: 0, rejected: 0 }, exportProfile: null } }), { ok: true, accepted: true });
    assert.deepEqual(await s.fe.call('mcp:reply', { id, ok: true }), { ok: true, accepted: false }, 'repetida');
    const out = JSON.parse(await run);
    assert.equal(out.openProject.title, 'Live');
    assert.equal(out.app, 'Braga Frame');
    assert.equal(out.version, '9.9.9');
    assert.equal(out.tools.ffmpeg, Boolean(H.tools.ffmpeg));
  } finally { await s.done(); }
});

test('ferramentas de verdade sobre um projeto salvo de verdade, pelo servidor HTTP: lista, projeto com cortes, status da fila e da transcrição; nada com caminho', async () => {
  const s = setup({ available: false }); // sem janela: tudo vem do disco e dos módulos
  try {
    const video = path.join(s.userData, 'Gravação da final.mp4');
    fs.writeFileSync(video, 'x');
    const saved = s.ctx.projectStore.save({ ...newProject(video, { size: 1, duration: 300, width: 1280, height: 720 }, null), cuts: [
      { id: 'c1', title: 'Gol', start: 10, end: 25, status: 'approved', origin: 'manual' },
      { id: 'c2', title: 'Defesa', start: 100, end: 120, status: 'pending', origin: 'auto', relevance: 0.8, reasons: ['pico de áudio'] }
    ] });
    const { port } = await s.fe.call('mcp:setEnabled', { enabled: true });
    const token = JSON.parse(fs.readFileSync(path.join(s.userData, 'mcp.json'), 'utf8')).token;
    const call = async (name, args = {}) => {
      const r = await post(port, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
      return { isError: r.json.result.isError, data: JSON.parse(r.json.result.content[0].text) };
    };
    const list = await call('projects_list');
    assert.equal(list.isError, false);
    assert.equal(list.data.total, 1);
    assert.deepEqual([list.data.projects[0].id, list.data.projects[0].title, list.data.projects[0].durationSec, list.data.projects[0].videoFileMissing], [saved.id, 'Gravação da final', 300, false]);
    assert.deepEqual(list.data.projects[0].cuts, { total: 2, pending: 1, approved: 1, rejected: 0 });
    const got = await call('project_get', { id: saved.id });
    assert.deepEqual(got.data.cuts.map((c) => [c.id, c.title, c.status, c.start, c.end]), [['c1', 'Gol', 'approved', 10, 25], ['c2', 'Defesa', 'pending', 100, 120]]);
    assert.deepEqual([got.data.width, got.data.height, got.data.transcript.exists], [1280, 720, false]);
    assert.equal((await call('queue_status')).data.jobs.length, 0);
    const tr = await call('transcription_status');
    assert.equal(tr.data.ready, false);
    assert.equal(tr.data.needs.engine, true);
    assert.equal((await call('analysis_status')).data.running, null);
    // sem janela as ações explicam em vez de travar
    const act = await call('cut_decide', { cutIds: ['c2'], status: 'approved' });
    assert.equal(act.isError, true);
    assert.match(act.data.error, /janela do Braga Frame não está aberta/);
    assert.doesNotMatch(JSON.stringify([list, got]), /Gravação da final\.mp4|bf-mcp-h-|[A-Za-z]:\\\\/);
    // o projeto aberto é lido do disco sem tocar nele
    const before = fs.readFileSync(path.join(s.ctx.paths.projects, `${saved.id}.json`), 'utf8');
    await call('project_get', { id: saved.id });
    await call('projects_list');
    assert.equal(fs.readFileSync(path.join(s.ctx.paths.projects, `${saved.id}.json`), 'utf8'), before, 'ler não grava nada');
    // transcrição de verdade guardada: aparece em project_get e em transcript_get
    const { TranscriptStore } = require('../src/core/analysis/transcript/store');
    const { buildDocument } = require('../src/core/analysis/transcript/format');
    const store = new TranscriptStore(path.join(s.ctx.paths.userData, 'transcripts'));
    store.save(saved.id, buildDocument({ projectId: saved.id, origin: 'imported', source: { path: video, size: 1, duration: 300 }, cues: [{ start: 12, end: 15, text: 'olha o gol' }, { start: 101, end: 104, text: 'que defesa' }], dropped: { invalid: 0, beyond: 0, repeats: 0 } }));
    const withTr = await call('project_get', { id: saved.id });
    assert.deepEqual([withTr.data.transcript.exists, withTr.data.transcript.stale, withTr.data.transcript.cues], [true, false, 2]);
    const text = await call('transcript_get', { projectId: saved.id, fromSec: 100 });
    assert.deepEqual(text.data.cues, [{ start: 101, end: 104, text: 'que defesa' }]);
    assert.equal(text.data.totalCues, 2);
  } finally { await s.done(); }
});

test('módulo embutido (dentro do BDS): sem servidor, `available:false` com o motivo, nenhum canal liga nada e ctx.mcp não existe', async () => {
  const s = setup({ host: { embedded: true, name: 'BDS', tool: () => null, whisperModels: null, ai: null } });
  try {
    assert.equal(s.ctx.mcp, undefined);
    const st = await s.fe.call('mcp:status');
    assert.deepEqual([st.ok, st.available, st.running], [true, false, false]);
    assert.match(st.reason, /Braga Frame está dentro do BDS: os agentes de IA se conectam pelo MCP dele\./);
    for (const [channel, payload] of [['mcp:setEnabled', { enabled: true }], ['mcp:regenerateToken', {}], ['mcp:setOptions', { autoConfirm: true }], ['mcp:copyConfig', { kind: 'http' }]]) {
      const res = await s.fe.call(channel, payload);
      assert.deepEqual([res.ok, res.code], [false, 'MCP_UNAVAILABLE'], channel);
      assert.match(res.message, /dentro do BDS/);
    }
    assert.deepEqual(await s.fe.call('mcp:reply', { id: 'x', ok: true }), { ok: true, accepted: false });
    assert.equal(fs.existsSync(path.join(s.userData, 'mcp.json')), false);
  } finally { await s.done(); }
});


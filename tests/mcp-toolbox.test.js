'use strict';

/**
 * As ferramentas do MCP (src/mcp/toolbox.js) e a ponte com a janela (src/mcp/RendererBridge.js), com um contexto e uma janela de mentira: o que cada
 * ferramenta devolve (e que NUNCA traz caminho de arquivo), a validação dos argumentos ANTES de qualquer pedido à janela, a confirmação (o agente é
 * nomeado; recusar não faz nada; dispensada, `ask` vai falso), o cancelamento e o fluxo da transcrição. O app de verdade está em tests/e2e/mcp.e2e.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createToolbox, TOOLS, safeText, titleOf, clock, queueSummary } = require('../src/mcp/toolbox');
const { RendererBridge, BridgeError } = require('../src/mcp/RendererBridge');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ID_A = '0123456789abcdef';
const ID_B = 'fedcba9876543210';
const VIDEO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-mcp-tb-'));
const REAL_VIDEO = path.join(VIDEO_DIR, 'Partida final da liga.mp4');
fs.writeFileSync(REAL_VIDEO, 'video de mentira');
test.after(() => fs.rmSync(VIDEO_DIR, { recursive: true, force: true }));

const cut = (id, start, end, over = {}) => ({ id, title: `Corte ${id}`, start, end, status: 'pending', origin: 'manual', ...over });

function project(id, over = {}) {
  return {
    id,
    source: { path: REAL_VIDEO, size: 1000, duration: 600, width: 1920, height: 1080, origin: null },
    cuts: [cut('c2', 30, 50, { status: 'approved' }), cut('c1', 5, 20, { relevance: 0.876, reasons: ['pico de áudio 5σ', 'risada', 'a', 'b', 'c', 'd'], category: 'engraçado', origin: 'auto', exports: [{ file: 'C:\\Users\\Ana\\Cortes\\x.mp4' }] })],
    ...over
  };
}

/**
 * Janela de mentira: `ops[nome](args, opts)` responde a cada operação; sem ela, BridgeError UNKNOWN_OP. `calls` guarda o que foi pedido.
 */
function fakeBridge(ops = {}, { available = true } = {}) {
  const calls = [];
  return {
    calls,
    available: () => available,
    async request(op, args, opts = {}) {
      calls.push({ op, args, opts });
      if (!available) throw new BridgeError('NO_WINDOW', 'A janela do Braga Frame não está aberta. Abra o aplicativo e tente de novo.');
      if (!ops[op]) throw new BridgeError('UNKNOWN_OP', `Operação desconhecida: ${op}.`);
      return typeof ops[op] === 'function' ? ops[op](args, opts) : ops[op];
    },
    opNames: () => calls.map((c) => c.op)
  };
}

function fakeCtx({ projects = { [ID_A]: project(ID_A) }, channels = {}, extra = {} } = {}) {
  const channelCalls = [];
  const logs = [];
  const ctx = {
    tools: { ffmpeg: 'C:\\Program Files\\ffmpeg\\ffmpeg.exe', ffprobe: 'C:\\Program Files\\ffmpeg\\ffprobe.exe', ytdlp: null, whisper: null, twitchDownloader: null },
    projectStore: { peekById: (id) => (projects[id] ? { project: JSON.parse(JSON.stringify(projects[id])) } : { error: new Error('não existe') }) },
    async call(channel, payload) {
      channelCalls.push([channel, payload]);
      const h = channels[channel];
      if (!h) return { ok: false, code: 'UNKNOWN_CHANNEL', message: `Canal desconhecido: ${channel}.` };
      return typeof h === 'function' ? h(payload) : h;
    },
    analysis: {
      ai: {
        transcriptManager: { summary: () => ({ exists: false }), status: () => null },
        store: { get: () => null }
      }
    },
    transcription: { readiness: async () => ({ ready: true, reason: '', needs: { ffmpeg: false, engine: false, model: false }, modelId: 'small', modelLabel: 'Pequeno', device: 'CPU', busy: false }) },
    queue: { snapshot: () => ({ jobs: [], paused: false, running: 0, active: 0 }) },
    log: (level, message) => logs.push([level, message]),
    ...extra
  };
  return { ctx, channelCalls, logs };
}

/** Roda uma ferramenta e devolve o objeto (o toolbox devolve texto JSON). */
async function run(box, name, args = {}, opts = {}) {
  return JSON.parse(await box.execute(name, args, { agent: 'Antigravity', ...opts }));
}

const NO_PATHS = /[A-Za-z]:\\|\\\\|\.mp4|Users|\/home\//;

// ---------------------------------------------------------------- o catálogo

test('catálogo: a lista fixa, na ordem, com tipo (leitura ou ação), descrição e esquema; nada que apague, escolha caminho ou toque em chave', () => {
  const box = createToolbox({ ctx: fakeCtx().ctx, bridge: fakeBridge() });
  const defs = box.definitions();
  assert.deepEqual(defs.map((d) => d.name), ['app_overview', 'projects_list', 'project_get', 'transcript_get', 'transcription_status', 'analysis_status', 'queue_status', 'project_open', 'cut_create', 'cut_decide', 'cut_edit', 'transcribe_run', 'analysis_run', 'analysis_add_cuts', 'export_enqueue']);
  assert.deepEqual(defs.filter((d) => d.kind === 'read').map((d) => d.name), ['app_overview', 'projects_list', 'project_get', 'transcript_get', 'transcription_status', 'analysis_status', 'queue_status']);
  assert.equal(defs.filter((d) => d.kind === 'action').length, 8);
  for (const d of defs) {
    assert.ok(['read', 'action'].includes(d.kind), d.name);
    assert.ok(d.description.length > 40 && /[.]$/.test(d.description), `${d.name}: descrição em português com ponto final`);
    assert.equal(d.inputSchema.type, 'object', d.name);
    assert.equal(d.inputSchema.additionalProperties, false, `${d.name}: o agente não pode inventar argumentos`);
    for (const required of d.inputSchema.required || []) assert.ok(d.inputSchema.properties[required], `${d.name}: "${required}" é obrigatório e está descrito`);
  }
  assert.equal(defs.some((d) => /delete|remove|apag|path|caminho|key|chave|token|install|prefs/i.test(d.name)), false);
  for (const d of defs.filter((x) => x.kind === 'action')) assert.match(d.description, /confirma|confirmação/i, `${d.name}: avisa que o usuário confirma no app`);
  assert.equal(box.kindOf('cut_decide'), 'action');
  assert.equal(box.kindOf('projects_list'), 'read');
  assert.equal(box.kindOf('nao_existe'), null);
  assert.equal(TOOLS.length, 15);
  assert.deepEqual(defs.find((d) => d.name === 'cut_decide').inputSchema.properties.status.enum, ['pending', 'approved', 'rejected']);
});

test('safeText, titleOf, clock: caminhos (Windows, UNC, Unix) somem, controles viram espaço, o limite vale; o título é o da origem ou o nome do arquivo sem pasta nem extensão', () => {
  assert.equal(safeText('Falhou ao abrir C:\\Users\\Ana\\Vídeos\\live.mp4 agora'), 'Falhou ao abrir [caminho] agora');
  assert.equal(safeText('Sem acesso a \\\\servidor\\pasta\\x.mp4!'), 'Sem acesso a [caminho]!');
  assert.equal(safeText('Não achei /home/ana/videos/live.mp4 aqui'), 'Não achei [caminho] aqui');
  assert.equal(safeText('Lendo C:\\Users\\Ana\\v.mp4…'), 'Lendo [caminho]…', 'a reticência final não é do caminho');
  assert.equal(safeText('Falhou em C:\\a\\b.mp4: sem corte.'), 'Falhou em [caminho]: sem corte.');
  assert.equal(safeText('ver (/home/ana/x.mp4).'), 'ver ([caminho]).');
  assert.equal(safeText('proporção 16/9 e 1/2 ficam'), 'proporção 16/9 e 1/2 ficam');
  assert.equal(safeText('https://exemplo.com/a/b não é caminho'), 'https://exemplo.com/a/b não é caminho');
  assert.equal(safeText('linha 1\nlinha 2\t\u0000fim'), 'linha 1 linha 2 fim');
  assert.equal(safeText('x'.repeat(500)).length, 300);
  assert.equal(safeText('x'.repeat(500), 20).length, 20);
  assert.equal(safeText(null), '');
  assert.equal(titleOf({ source: { path: 'C:\\Users\\Ana\\Vídeos\\Minha live 01.mkv', origin: { title: 'Título do VOD' } } }), 'Título do VOD');
  assert.equal(titleOf({ source: { path: path.join('C:', 'Users', 'Ana', 'Minha live 01.mkv') } }).includes('Users'), false);
  assert.equal(titleOf({ source: { path: '' } }), 'Vídeo');
  assert.equal(clock(65), '1:05');
  assert.equal(clock(3723), '1:02:03');
  assert.equal(clock(-5), '0:00');
});

// ---------------------------------------------------------------- leitura

test('app_overview: versão, programas (só se existem, nunca o caminho), transcrição, fila e o projeto aberto; sem janela o resto continua valendo', async () => {
  const { ctx } = fakeCtx({ extra: { queue: { snapshot: () => ({ jobs: [{ id: 'j1', state: 'done' }, { id: 'j2', state: 'queued' }], paused: false, running: 0, active: 1 }) } } });
  const open = { id: ID_A, title: 'Partida', durationSec: 600, cuts: { total: 2, pending: 1, approved: 1, rejected: 0 }, exportProfile: 'Vertical 1080p' };
  const box = createToolbox({ ctx, bridge: fakeBridge({ context: open }), version: '1.2.3' });
  const out = await run(box, 'app_overview');
  assert.equal(out.app, 'Braga Frame');
  assert.equal(out.version, '1.2.3');
  assert.deepEqual(out.tools, { ffmpeg: true, ffprobe: true, ytdlp: false, whisper: false, twitchDownloader: false });
  assert.deepEqual(out.transcription, { ready: true, reason: '', needs: { ffmpeg: false, engine: false, model: false }, model: 'Pequeno', device: 'CPU' });
  assert.deepEqual(out.queue, { paused: false, running: 0, active: 1, byState: { done: 1, queued: 1 } });
  assert.deepEqual(out.openProject, open);
  assert.match(out.hint, /projeto aberto/);
  assert.doesNotMatch(JSON.stringify(out), NO_PATHS);

  const offline = createToolbox({ ctx, bridge: fakeBridge({}, { available: false }) });
  const noWindow = await run(offline, 'app_overview');
  assert.equal(noWindow.openProject, null);
  assert.match(noWindow.hint, /Nenhum projeto aberto/);
  assert.equal(noWindow.tools.ffmpeg, true, 'o resto da visão vale sem janela');
});

test('projects_list: pede para a janela gravar antes (o disco fica em dia), resume cada projeto sem caminho e respeita o limite', async () => {
  const list = [
    { id: ID_A, source: { path: 'C:\\Users\\Ana\\Videos\\Live da noite.mp4', duration: 600.04, origin: { title: 'Live da noite (VOD)' } }, cutCount: 5, counts: { pending: 3, approved: 1, rejected: 1 }, exportedCount: 1, updatedAt: '2026-11-20T10:00:00.000Z', fileMissing: false },
    { id: ID_B, source: { path: 'D:\\Gravações\\treino 2.mkv', duration: 90 }, cutCount: 0, counts: { pending: 0, approved: 0, rejected: 0 }, exportedCount: 0, updatedAt: '2026-11-19T10:00:00.000Z', fileMissing: true }
  ];
  const { ctx, channelCalls } = fakeCtx({ channels: { 'project:list': { projects: list } } });
  const bridge = fakeBridge({ flush: { saved: true } });
  const box = createToolbox({ ctx, bridge });
  const out = await run(box, 'projects_list');
  assert.deepEqual(bridge.opNames(), ['flush'], 'a janela grava o projeto aberto antes de a lista ser lida do disco');
  assert.equal(out.total, 2);
  assert.deepEqual(out.projects[0], { id: ID_A, title: 'Live da noite (VOD)', durationSec: 600, cuts: { total: 5, pending: 3, approved: 1, rejected: 1 }, exportedCuts: 1, updatedAt: '2026-11-20T10:00:00.000Z', videoFileMissing: false });
  assert.equal(out.projects[1].title, 'treino 2');
  assert.equal(out.projects[1].videoFileMissing, true);
  assert.doesNotMatch(JSON.stringify(out), NO_PATHS);
  assert.deepEqual(channelCalls, [['project:list', {}]]);
  assert.equal((await run(box, 'projects_list', { limit: 1 })).projects.length, 1);
  assert.match((await run(box, 'projects_list', { limit: 0 })).error, /"limit" deve ficar entre 1 e 100/);
  assert.match((await run(box, 'projects_list', { limit: 'x' })).error, /deve ser um número/);
  // sem janela: lista o que há no disco
  const offline = createToolbox({ ctx, bridge: fakeBridge({}, { available: false }) });
  assert.equal((await run(offline, 'projects_list')).projects.length, 2);
});

test('project_get: valida o id, diz quando não acha, devolve os cortes em ordem de tempo com os campos certos e a transcrição, sem caminho', async () => {
  const many = Array.from({ length: 205 }, (_, i) => cut(`m${i}`, i, i + 1));
  const { ctx } = fakeCtx({ projects: { [ID_A]: project(ID_A), [ID_B]: project(ID_B, { cuts: many }) } });
  ctx.analysis.ai.transcriptManager.summary = (id, source) => { assert.equal(id, ID_A); assert.equal(source.duration, 600); return { exists: true, stale: false, cues: 120, coveredSec: 590.04 }; };
  const bridge = fakeBridge({ flush: {} });
  const box = createToolbox({ ctx, bridge });
  const out = await run(box, 'project_get', { id: ID_A });
  assert.deepEqual(bridge.opNames(), ['flush']);
  assert.equal(out.title, 'Partida final da liga');
  assert.deepEqual([out.durationSec, out.width, out.height, out.videoFileMissing], [600, 1920, 1080, false]);
  assert.deepEqual(out.counts, { total: 2, pending: 1, approved: 1, rejected: 0 });
  assert.deepEqual(out.cuts.map((c) => c.id), ['c1', 'c2'], 'em ordem de tempo (a lista guardada tinha c2 primeiro)');
  assert.deepEqual(out.cuts[0], { id: 'c1', title: 'Corte c1', start: 5, end: 20, durationSec: 15, status: 'pending', origin: 'auto', relevance: 0.88, reasons: ['pico de áudio 5σ', 'risada', 'a', 'b', 'c'], category: 'engraçado', exported: true });
  assert.equal(out.cuts[1].exported, false);
  assert.deepEqual(out.transcript, { exists: true, stale: false, cues: 120, coveredSec: 590 });
  assert.doesNotMatch(JSON.stringify(out), NO_PATHS, 'nem o caminho da exportação anotada no corte');
  const big = await run(box, 'project_get', { id: ID_B });
  assert.deepEqual([big.cuts.length, big.cutsTruncated], [200, true]);
  assert.match((await run(box, 'project_get', { id: 'abc' })).error, /não é um identificador de projeto válido/);
  assert.match((await run(box, 'project_get', {})).error, /Informe "id"/);
  assert.match((await run(box, 'project_get', { id: 'a'.repeat(16) })).error, /Projeto não encontrado/);
  assert.match((await run(box, 'project_get', { id: 7 })).error, /deve ser um texto/);
  // vídeo que sumiu
  const moved = fakeCtx({ projects: { [ID_A]: project(ID_A, { source: { path: path.join(VIDEO_DIR, 'sumiu.mp4'), duration: 10 } }) } });
  assert.equal((await run(createToolbox({ ctx: moved.ctx, bridge: fakeBridge() }), 'project_get', { id: ID_A })).videoFileMissing, true);
});

test('transcript_get: erros claros (sem transcrição, de outro arquivo), janela de tempo, limite de caracteres com "nextFromSec" e texto limpo', async () => {
  const cues = Array.from({ length: 50 }, (_, i) => ({ start: i * 10, end: i * 10 + 8, text: `fala número ${i} ${'x'.repeat(40)}` }));
  cues[3].text = `veja C:\\Users\\Ana\\a.mp4 e\nquebra ${'y'.repeat(900)}`;
  const { ctx } = fakeCtx();
  const box = createToolbox({ ctx, bridge: fakeBridge() });
  assert.match((await run(box, 'transcript_get', { projectId: ID_A })).error, /ainda não tem transcrição/);
  ctx.analysis.ai.transcriptManager.summary = () => ({ exists: true, stale: true });
  assert.match((await run(box, 'transcript_get', { projectId: ID_A })).error, /de outro arquivo de vídeo/);
  ctx.analysis.ai.transcriptManager.summary = () => ({ exists: true, stale: false });
  ctx.analysis.ai.store.get = () => ({ cues });
  const all = await run(box, 'transcript_get', { projectId: ID_A, maxChars: 20000 });
  assert.equal(all.cues.length, 50);
  assert.equal(all.truncated, false);
  assert.equal(all.nextFromSec, null);
  assert.doesNotMatch(JSON.stringify(all), /Users|\\n/, 'caminho e quebra de linha saem do texto falado');
  assert.ok(all.cues[3].text.length <= 500, 'cada fala é limitada');
  const win = await run(box, 'transcript_get', { projectId: ID_A, fromSec: 100, toSec: 130, maxChars: 20000 });
  assert.deepEqual(win.cues.map((c) => c.start), [100, 110, 120], 'só a janela pedida');
  const cut = await run(box, 'transcript_get', { projectId: ID_A, maxChars: 400 });
  assert.equal(cut.truncated, true);
  assert.ok(cut.cues.length >= 1 && cut.cues.length < 50);
  assert.equal(cut.nextFromSec, 10 * cut.cues.length, 'diz de onde continuar');
  const next = await run(box, 'transcript_get', { projectId: ID_A, fromSec: cut.nextFromSec, maxChars: 400 });
  assert.equal(next.cues[0].start, cut.nextFromSec);
  assert.match((await run(box, 'transcript_get', { projectId: ID_A, maxChars: 50 })).error, /"maxChars" deve ficar entre 200 e 20000/);
  assert.match((await run(box, 'transcript_get', {})).error, /Informe "projectId"/);
  assert.match((await run(box, 'transcript_get', { projectId: ID_A, fromSec: -1 })).error, /"fromSec" deve ficar entre/);
});

test('transcription_status e analysis_status: repassam o que o app sabe (sem caminhos) e toleram a janela ausente', async () => {
  const { ctx } = fakeCtx({ channels: { 'analysis:status': { running: { jobId: 'j', path: 'C:\\Users\\Ana\\v.mp4', p: 0.4567, stage: 'audio', message: 'Lendo C:\\Users\\Ana\\v.mp4…', engine: 'algorithm' } } } });
  ctx.analysis.ai.transcriptManager.status = () => ({ jobId: 't', projectId: ID_A, p: 0.5, doneUntil: 123.45, message: 'Transcrevendo…' });
  ctx.transcription.readiness = async ({ modelId }) => ({ ready: false, reason: `O modelo ${modelId || 'Pequeno'} ainda não foi baixado. Baixe-o na aba Ferramentas.`, needs: { ffmpeg: false, engine: false, model: true }, modelLabel: 'Pequeno', device: 'CPU' });
  const state = { id: ID_A, running: false, progress: null, lastRunAt: '2026-11-20T10:00:00.000Z', suggestionCount: 1, suggestions: [{ id: 's1', start: 1, end: 9, relevance: 0.9 }] };
  const box = createToolbox({ ctx, bridge: fakeBridge({ analysis_state: state }) });
  const tr = await run(box, 'transcription_status', { modelId: 'tiny' });
  assert.deepEqual([tr.ready, tr.needs.model, tr.model], [false, true, 'Pequeno']);
  assert.match(tr.reason, /modelo tiny ainda não foi baixado/);
  assert.deepEqual(tr.running, { projectId: ID_A, progress: 0.5, doneUntilSec: 123.5, message: 'Transcrevendo…' });
  const an = await run(box, 'analysis_status');
  assert.deepEqual(an.running, { progress: 0.46, stage: 'audio', message: 'Lendo [caminho]…', engine: 'algorithm' });
  assert.deepEqual(an.openProject, state);
  assert.doesNotMatch(JSON.stringify([tr, an]), NO_PATHS);
  const offline = createToolbox({ ctx, bridge: fakeBridge({}, { available: false }) });
  assert.equal((await run(offline, 'analysis_status')).openProject, null);
  const noEngine = createToolbox({ ctx: { ...ctx, transcription: undefined, analysis: undefined }, bridge: fakeBridge() });
  const none = await run(noEngine, 'transcription_status');
  assert.deepEqual([none.ready, none.running], [false, null]);
  assert.match(none.reason, /não está disponível/);
});

test('queue_status: estados, os 30 últimos, corte resumido e erro sem caminho; sem fila é erro claro', async () => {
  const jobs = Array.from({ length: 35 }, (_, i) => ({ id: `j${i}`, state: i === 34 ? 'failed' : 'done', progress: i === 34 ? 0.123 : 1, projectId: ID_A, cut: { id: `c${i}`, title: `Corte ${i}`, start: i, end: i + 5.55, revision: 3, category: 'x', status: 'approved' }, ...(i === 34 ? { lastError: { message: 'Falhou ao gravar C:\\Users\\Ana\\Cortes\\x.mp4: disco cheio' }, etaSec: 12 } : {}) }));
  const { ctx } = fakeCtx({ extra: { queue: { snapshot: () => ({ jobs, paused: true, running: 1, active: 2 }) } } });
  const out = await run(createToolbox({ ctx, bridge: fakeBridge() }), 'queue_status');
  assert.deepEqual([out.paused, out.running, out.active], [true, 1, 2]);
  assert.deepEqual(out.byState, { done: 34, failed: 1 });
  assert.equal(out.jobs.length, 30);
  assert.equal(out.jobs.at(-1).id, 'j34');
  assert.deepEqual(out.jobs.at(-1), { id: 'j34', state: 'failed', progress: 0.12, cut: { id: 'c34', title: 'Corte 34', start: 34, end: 39.6 }, projectId: ID_A, etaSec: 12, error: 'Falhou ao gravar [caminho]: disco cheio' });
  assert.doesNotMatch(JSON.stringify(out), NO_PATHS);
  assert.deepEqual(queueSummary(null).jobs, []);
  const none = createToolbox({ ctx: { ...ctx, queue: undefined }, bridge: fakeBridge() });
  assert.match((await run(none, 'queue_status')).error, /fila de exportação não está disponível/);
});

// ---------------------------------------------------------------- ações

test('ações: o nome do agente e `ask` vão à janela; dispensada a confirmação `ask` é falso; recusa vira "não insista"; erro da janela vira mensagem limpa; cancelar é repassado', async () => {
  const { ctx } = fakeCtx();
  const bridge = fakeBridge({ cut_decide: { changed: 1, unchanged: 0, missing: [], cuts: [] } });
  const box = createToolbox({ ctx, bridge });
  await run(box, 'cut_decide', { cutIds: ['c1'], status: 'approved' }, { agent: 'Claude' });
  assert.deepEqual(bridge.calls.at(-1).args, { cutIds: ['c1'], status: 'approved', agent: 'O agente “Claude”', ask: true });
  assert.equal(bridge.calls.at(-1).opts.timeoutMs, 10 * 60 * 1000, 'a janela espera o usuário por minutos');
  await run(box, 'cut_decide', { cutIds: ['c1'], status: 'approved' }, { agent: '', autoConfirm: true });
  assert.deepEqual(bridge.calls.at(-1).args, { cutIds: ['c1'], status: 'approved', agent: 'Um agente de IA', ask: false });
  // recusa
  const refuse = createToolbox({ ctx, bridge: fakeBridge({ cut_decide: { declined: true } }) });
  const declined = await run(refuse, 'cut_decide', { cutIds: ['c1'], status: 'rejected' });
  assert.equal(declined.declined, true);
  assert.match(declined.message, /recusou no aplicativo\. Nada foi feito: não insista\./);
  assert.equal(declined.error, undefined, 'recusar não é erro');
  // erro da janela, sem caminho
  const broken = createToolbox({ ctx, bridge: fakeBridge({ cut_decide: () => { throw new BridgeError('CUT_NOT_FOUND', 'Falhou em C:\\Users\\Ana\\x.mp4: sem corte.'); } }) });
  const err = await run(broken, 'cut_decide', { cutIds: ['c1'], status: 'approved' });
  assert.equal(err.error, 'Falhou em [caminho]: sem corte.', 'o caminho some, a pontuação da frase fica');
  assert.equal(err.code, 'CUT_NOT_FOUND');
  // sem janela
  const noWin = createToolbox({ ctx, bridge: fakeBridge({}, { available: false }) });
  assert.match((await run(noWin, 'cut_decide', { cutIds: ['c1'], status: 'approved' })).error, /janela do Braga Frame não está aberta/);
  // cancelar (o agente desconectou): o servidor decide, o toolbox só repassa
  const cancelled = createToolbox({ ctx, bridge: fakeBridge({ cut_decide: () => { throw new BridgeError('CANCELLED', 'Cancelado.'); } }) });
  await assert.rejects(() => cancelled.execute('cut_decide', { cutIds: ['c1'], status: 'approved' }, {}), (e) => e.code === 'CANCELLED');
});

test('validação ANTES de incomodar a janela: argumentos ruins viram erro sem nenhum pedido à janela', async () => {
  const { ctx } = fakeCtx();
  const bridge = fakeBridge({});
  const box = createToolbox({ ctx, bridge });
  const bad = [
    ['cut_create', {}, /Informe "start"/],
    ['cut_create', { start: 5 }, /Informe "end"/],
    ['cut_create', { start: 10, end: 5 }, /fim do corte precisa ser maior/],
    ['cut_create', { start: '1', end: 5 }, /deve ser um número/],
    ['cut_create', { start: -1, end: 5 }, /deve ficar entre/],
    ['cut_create', { start: 1, end: 5, title: 7 }, /deve ser um texto/],
    ['cut_create', { start: 1, end: 5, title: 'x'.repeat(121) }, /longo demais/],
    ['cut_decide', {}, /Informe "cutIds"/],
    ['cut_decide', { cutIds: 'c1', status: 'approved' }, /lista com pelo menos um id/],
    ['cut_decide', { cutIds: [], status: 'approved' }, /lista com pelo menos um id/],
    ['cut_decide', { cutIds: ['c1'] }, /Informe "status"/],
    ['cut_decide', { cutIds: ['c1'], status: 'talvez' }, /deve ser pending, approved, rejected/],
    ['cut_decide', { cutIds: Array.from({ length: 51 }, (_, i) => `c${i}`), status: 'approved' }, /no máximo 50/],
    ['cut_decide', { cutIds: [1], status: 'approved' }, /id inválido/],
    ['cut_edit', {}, /Informe "cutId"/],
    ['cut_edit', { cutId: 'c1' }, /Informe o que mudar/],
    ['cut_edit', { cutId: 'c1', start: 9, end: 8 }, /fim do corte precisa ser maior/],
    ['project_open', {}, /Informe "id"/],
    ['project_open', { id: 'curto' }, /não é um identificador de projeto válido/],
    ['analysis_add_cuts', {}, /Informe suggestionIds ou top/],
    ['analysis_add_cuts', { top: 21 }, /deve ficar entre 1 e 20/],
    ['analysis_add_cuts', { suggestionIds: [] }, /lista com pelo menos um id/],
    ['export_enqueue', { cutIds: [] }, /lista com pelo menos um id/]
  ];
  for (const [name, args, re] of bad) assert.match((await run(box, name, args)).error, re, `${name} ${JSON.stringify(args)}`);
  assert.deepEqual(bridge.calls, [], 'nenhum pedido chegou à janela');
  // e os válidos passam os campos limpos (título sem quebra de linha nem espaços sobrando)
  const ok = fakeBridge({ cut_create: { created: { id: 'n1' } } });
  const out = await run(createToolbox({ ctx, bridge: ok }), 'cut_create', { start: 1, end: 5, title: '  Meu\n  corte  ' });
  assert.deepEqual(out, { created: { id: 'n1' } });
  assert.equal(ok.calls[0].args.title, 'Meu corte');
  const edit = fakeBridge({ cut_edit: { cut: { id: 'c1' } } });
  await run(createToolbox({ ctx, bridge: edit }), 'cut_edit', { cutId: 'c1', start: 1 });
  assert.deepEqual(Object.keys(edit.calls[0].args).sort(), ['agent', 'ask', 'cutId', 'start'], 'só o que foi pedido segue');
});

test('project_open: o caminho vem do projeto guardado (nunca do agente), confere o arquivo e devolve só id e título', async () => {
  const gone = project(ID_B, { source: { path: path.join(VIDEO_DIR, 'sumiu.mp4'), duration: 10 } });
  const { ctx } = fakeCtx({ projects: { [ID_A]: project(ID_A), [ID_B]: gone } });
  const bridge = fakeBridge({ open_project: { opened: true } });
  const box = createToolbox({ ctx, bridge });
  const out = await run(box, 'project_open', { id: ID_A, path: 'C:\\outro\\lugar.mp4' });
  assert.deepEqual(out, { opened: true, id: ID_A, title: 'Partida final da liga' });
  assert.deepEqual(bridge.calls[0].args, { id: ID_A, path: REAL_VIDEO, title: 'Partida final da liga', agent: 'O agente “Antigravity”', ask: true }, 'o "path" do agente é ignorado');
  assert.doesNotMatch(JSON.stringify(out), NO_PATHS);
  assert.match((await run(box, 'project_open', { id: ID_B })).error, /arquivo de vídeo deste projeto não foi encontrado/);
  assert.match((await run(box, 'project_open', { id: 'a'.repeat(16) })).error, /Projeto não encontrado/);
  assert.equal(bridge.calls.length, 1, 'nos erros a janela não foi incomodada');
});

test('transcribe_run: projeto aberto ou informado, confere tudo antes, pergunta (modelo, placa, duração) e só então manda o canal; recusar não inicia nada', async () => {
  const started = [];
  const channels = { 'analysis:transcriptGenerate': (payload) => { started.push(payload); return { jobId: 'job-1' }; } };
  const { ctx, channelCalls } = fakeCtx({ channels });
  ctx.transcription.readiness = async ({ modelId }) => ({ ready: true, reason: '', needs: { ffmpeg: false, engine: false, model: false }, modelId: modelId || 'small', modelLabel: modelId === 'tiny' ? 'Tiny' : 'Pequeno', device: 'GPU' });
  const bridge = fakeBridge({ context: { id: ID_A }, confirm: { accepted: true }, refresh_transcript: {} });
  const box = createToolbox({ ctx, bridge });
  const out = await run(box, 'transcribe_run', { modelId: 'tiny', language: 'en' }, { agent: 'Claude' });
  assert.deepEqual(out, { started: true, jobId: 'job-1', projectId: ID_A, model: 'Tiny', note: 'Acompanhe com transcription_status.' });
  assert.deepEqual(bridge.opNames(), ['context', 'confirm', 'refresh_transcript']);
  const ask = bridge.calls[1];
  assert.equal(ask.args.title, 'Transcrever o vídeo?');
  assert.equal(ask.args.okLabel, 'Transcrever');
  assert.match(ask.args.message, /O agente “Claude” pede para transcrever “Partida final da liga” \(10:00\) com o modelo Tiny, na placa de vídeo\./);
  assert.match(ask.args.message, /dá para cancelar na aba Análise/);
  assert.equal(ask.opts.timeoutMs, 10 * 60 * 1000);
  assert.deepEqual(started, [{ projectId: ID_A, path: REAL_VIDEO, size: 1000, duration: 600, modelId: 'tiny', language: 'en' }], 'o canal recebe o caminho do projeto guardado e o idioma');
  assert.equal(JSON.stringify(out).includes(REAL_VIDEO), false);
  // sem informar: o padrão do idioma é pt e o modelo fica por conta do app
  started.length = 0;
  await run(box, 'transcribe_run', { projectId: ID_A });
  assert.deepEqual(started[0], { projectId: ID_A, path: REAL_VIDEO, size: 1000, duration: 600, language: 'pt' });
  // confirmação dispensada: sem janela de confirmação
  const auto = fakeBridge({ refresh_transcript: {} });
  await run(createToolbox({ ctx, bridge: auto }), 'transcribe_run', { projectId: ID_A }, { autoConfirm: true });
  assert.deepEqual(auto.opNames(), ['refresh_transcript']);
  // recusa
  const before = channelCalls.length;
  const refuse = createToolbox({ ctx, bridge: fakeBridge({ confirm: { accepted: false } }) });
  const declined = await run(refuse, 'transcribe_run', { projectId: ID_A });
  assert.equal(declined.declined, true);
  assert.equal(channelCalls.length, before, 'recusou: o canal nem foi chamado');
});

test('transcribe_run: os erros vêm antes de qualquer janela (sem projeto, sem duração, vídeo sumido, motor ou modelo faltando) e a falha do canal é explicada', async () => {
  const { ctx, channelCalls } = fakeCtx({
    projects: { [ID_A]: project(ID_A), [ID_B]: project(ID_B, { source: { path: path.join(VIDEO_DIR, 'sumiu.mp4'), duration: 30 } }), '1111111111111111': project('1111111111111111', { source: { path: REAL_VIDEO, duration: 0 } }) },
    channels: { 'analysis:transcriptGenerate': { ok: false, code: 'BUSY', message: 'Já existe uma transcrição em andamento. Espere terminar ou cancele-a.' } }
  });
  const bridge = fakeBridge({ context: null, confirm: { accepted: true }, refresh_transcript: {} });
  const box = createToolbox({ ctx, bridge });
  assert.match((await run(box, 'transcribe_run', {})).error, /Nenhum projeto aberto: informe projectId/);
  assert.match((await run(box, 'transcribe_run', { projectId: '1111111111111111' })).error, /Não sei a duração/);
  assert.match((await run(box, 'transcribe_run', { projectId: ID_B })).error, /arquivo de vídeo deste projeto não foi encontrado/);
  assert.match((await run(box, 'transcribe_run', { projectId: 'a'.repeat(16) })).error, /Projeto não encontrado/);
  ctx.transcription.readiness = async () => ({ ready: false, reason: 'O motor de transcrição (Whisper) não está instalado. Instale-o na aba Ferramentas.', needs: { ffmpeg: false, engine: true, model: true } });
  const notReady = await run(box, 'transcribe_run', { projectId: ID_A });
  assert.match(notReady.error, /motor de transcrição \(Whisper\) não está instalado/);
  assert.match(notReady.error, /Configurações > Ferramentas > Transcrição/, 'diz onde o usuário instala');
  assert.deepEqual(notReady.needs, { ffmpeg: false, engine: true, model: true });
  ctx.transcription.readiness = async () => ({ ready: false, reason: 'O FFmpeg não foi encontrado.', needs: { ffmpeg: true, engine: false, model: false } });
  assert.doesNotMatch((await run(box, 'transcribe_run', { projectId: ID_A })).error, /Configurações > Ferramentas/, 'faltar só o FFmpeg não manda instalar a transcrição');
  assert.equal(bridge.opNames().includes('confirm'), false, 'nenhum erro acima chegou a perguntar');
  ctx.transcription.readiness = async () => ({ ready: true, reason: '', modelLabel: 'Pequeno', device: 'CPU' });
  const busy = await run(box, 'transcribe_run', { projectId: ID_A });
  assert.match(busy.error, /Já existe uma transcrição em andamento/);
  assert.equal(busy.code, 'BUSY');
  assert.equal(channelCalls.length, 1);
  const none = createToolbox({ ctx: { ...ctx, transcription: undefined }, bridge });
  assert.match((await run(none, 'transcribe_run', { projectId: ID_A })).error, /não está disponível/);
});

test('execute: ferramenta desconhecida, argumentos que não são objeto e falha inesperada (genérica no resultado, detalhada só no registro)', async () => {
  const { ctx, logs } = fakeCtx({ channels: { 'project:list': () => { throw new Error('C:\\Users\\Ana\\segredo.json: EPERM'); } } });
  const box = createToolbox({ ctx, bridge: fakeBridge() });
  assert.match((await run(box, 'apagar_tudo')).error, /Ferramenta desconhecida: apagar_tudo\./);
  assert.match((await run(box, '<script>'.repeat(20))).error, /Ferramenta desconhecida/);
  assert.equal(JSON.parse(await box.execute('app_overview', null, {})).app, 'Braga Frame', 'argumentos nulos valem como {}');
  assert.equal(JSON.parse(await box.execute('app_overview', [1], {})).app, 'Braga Frame');
  const failing = await run(box, 'projects_list');
  assert.deepEqual(failing, { error: 'A ferramenta falhou. Tente de novo.' }, 'nenhum detalhe interno chega ao agente');
  assert.equal(logs.length, 1);
  assert.match(logs[0][1], /mcp: a ferramenta projects_list falhou/);
});

// ---------------------------------------------------------------- a ponte com a janela

test('RendererBridge: manda { id, op, args } por mcp:request e resolve com a resposta do renderer; resposta repetida ou de id desconhecido não faz nada', async () => {
  const sent = [];
  const bridge = new RendererBridge({ send: (channel, payload) => sent.push([channel, payload]) });
  const p = bridge.request('context', { a: 1 });
  assert.equal(bridge.pendingCount, 1);
  assert.equal(sent[0][0], 'mcp:request');
  const { id, op, args } = sent[0][1];
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.deepEqual([op, args], ['context', { a: 1 }]);
  assert.equal(bridge.reply({ id, ok: true, result: { x: 2 } }), true);
  assert.deepEqual(await p, { x: 2 });
  assert.equal(bridge.pendingCount, 0);
  assert.equal(bridge.reply({ id, ok: true, result: 3 }), false, 'repetida');
  assert.equal(bridge.reply({ id: 'nao-existe', ok: true }), false);
  assert.equal(bridge.reply(null), false);
  assert.equal(bridge.reply({ ok: true }), false);
  const q = bridge.request('x', {});
  bridge.reply({ id: sent[1][1].id, ok: true });
  assert.equal(await q, null, 'sem result: null');
});

test('RendererBridge: erro do renderer vira BridgeError com o código e a mensagem; prazo, cancelamento, janela ausente, envio que falha e fechar tudo', async () => {
  const sent = [];
  let available = true;
  const bridge = new RendererBridge({ send: (c, p) => sent.push(p), available: () => available, timeoutMs: 60 });
  const failing = bridge.request('x');
  bridge.reply({ id: sent[0].id, ok: false, code: 'CUT_NOT_FOUND', message: 'Esse corte não existe.' });
  await assert.rejects(failing, (e) => e instanceof BridgeError && e.code === 'CUT_NOT_FOUND' && e.message === 'Esse corte não existe.');
  const vague = bridge.request('x');
  bridge.reply({ id: sent[1].id, ok: false });
  await assert.rejects(vague, (e) => e.code === 'RENDERER_ERROR' && /A operação falhou no app/.test(e.message));
  // prazo
  const slow = bridge.request('lenta');
  await assert.rejects(slow, (e) => e.code === 'TIMEOUT' && /não respondeu a tempo/.test(e.message));
  assert.equal(bridge.pendingCount, 0);
  assert.equal(bridge.reply({ id: sent[2].id, ok: true }), false, 'a resposta que chega depois do prazo é descartada');
  // prazo próprio de uma chamada
  const long = bridge.request('confirm', {}, { timeoutMs: 5000 });
  await sleep(120);
  assert.equal(bridge.pendingCount, 1, 'a confirmação espera mais que o prazo padrão');
  bridge.reply({ id: sent[3].id, ok: true, result: { accepted: true } });
  assert.deepEqual(await long, { accepted: true });
  // cancelamento (o agente desconectou)
  const ctl = new AbortController();
  const aborted = bridge.request('confirm', {}, { timeoutMs: 5000, signal: ctl.signal });
  ctl.abort();
  await assert.rejects(aborted, (e) => e.code === 'CANCELLED');
  assert.equal(bridge.pendingCount, 0);
  const already = new AbortController();
  already.abort();
  const before = sent.length;
  await assert.rejects(bridge.request('x', {}, { signal: already.signal }), (e) => e.code === 'CANCELLED');
  assert.equal(sent.length, before, 'já cancelado: nada é enviado');
  // janela ausente
  available = false;
  await assert.rejects(bridge.request('x'), (e) => e.code === 'NO_WINDOW' && /janela do Braga Frame não está aberta/.test(e.message));
  assert.equal(sent.length, before);
  available = true;
  // envio que lança
  const throwing = new RendererBridge({ send: () => { throw new Error('janela destruída'); } });
  await assert.rejects(throwing.request('x'), (e) => e.code === 'NO_WINDOW' && /janela destruída/.test(e.message));
  assert.equal(throwing.pendingCount, 0);
  // fechar tudo
  const a = bridge.request('x', {}, { timeoutMs: 5000 });
  const b = bridge.request('y', {}, { timeoutMs: 5000 });
  bridge.rejectAll('NO_WINDOW', 'O Braga Frame está fechando.');
  await assert.rejects(a, (e) => e.message === 'O Braga Frame está fechando.');
  await assert.rejects(b, (e) => e.code === 'NO_WINDOW');
  assert.equal(bridge.pendingCount, 0);
});

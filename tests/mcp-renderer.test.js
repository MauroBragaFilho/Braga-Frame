'use strict';

/**
 * O lado da JANELA do MCP (renderer/features/mcp.js), com o arquivo de verdade rodando num DOM de mentira e o motor de revisão de verdade
 * (src/core/review/engine.js): as operações que o servidor pede (decidir cortes em UM passo de histórico, criar, editar, analisar, exportar, abrir),
 * a validação ANTES de perguntar ao usuário, a confirmação ("O agente X pede para…"), o aviso quando a confirmação foi dispensada, as respostas de
 * `handle` e o cartão de Configurações. O app inteiro (servidor de verdade, janela de verdade) está em tests/e2e/mcp.e2e.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../src/core/projects/model');
const review = require('../src/core/review/engine');
const { createDocument, makeEl } = require('./prefs-fakedom');
const { extendFakeDom } = require('./fakedom-extra');

extendFakeDom();

const CODE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features', 'mcp.js'), 'utf8');
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const idle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };
const AGENT = 'O agente “Antigravity”';

/**
 * Carrega o módulo com um BF de mentira. `answers`: o que cada confirmação responde (padrão: sim). `extra`: acrescenta ou troca peças do BF.
 */
function load({ project: withProject = true, answers = [], duration = 120, extra = {}, status = null } = {}) {
  const doc = createDocument();
  const el = makeEl(doc);
  const bus = new Map();
  const channels = new Map();
  const confirms = [];
  const toasts = [];
  const logs = [];
  const apiCalls = [];
  const queue = [...answers];
  const BF = {
    util: { el, baseOf: (p) => path.basename(String(p), path.extname(String(p))) },
    bus: { on: (n, fn) => { bus.set(n, [...(bus.get(n) || []), fn]); return () => {}; }, emit: (n, d) => { for (const fn of bus.get(n) || []) fn(d); } },
    on: (channel, fn) => { channels.set(channel, [...(channels.get(channel) || []), fn]); },
    ui: {
      confirm: async (opts) => { confirms.push(plain(opts)); return queue.length ? queue.shift() : true; },
      toast: (message, kind) => { toasts.push([message, kind]); },
      log: (message, kind) => { logs.push([message, kind]); }
    },
    state: { project: null, info: { duration } },
    api: async (channel, payload) => {
      apiCalls.push([channel, plain(payload)]);
      if (channel === 'mcp:status') return status || { ok: true, available: true, enabled: false, running: false, port: 47822, url: '', calls: 0, client: '', autoConfirm: false, error: '' };
      return { ok: true };
    },
    ...extra
  };
  const emitted = [];
  const origEmit = BF.bus.emit;
  BF.bus.emit = (n, d) => { emitted.push(n); origEmit(n, d); };
  if (withProject) {
    BF.state.project = {
      id: 'p1',
      source: { path: 'C:\\Videos\\Live da noite.mp4', size: 1, duration, origin: null },
      cuts: [model.newCut({ id: 'c1', title: 'Largada', start: 5, end: 20 }), model.newCut({ id: 'c2', title: 'Curva fechada', start: 30, end: 50 }), model.newCut({ id: 'c3', title: 'Chegada', start: 70, end: 95, status: 'approved' })],
      ext: {}
    };
    BF.project = {
      update(fn, { reason } = {}) { const r = fn(BF.state.project); BF.bus.emit('project:changed', { reason }); return r; },
      flush: async () => true,
      cut: (id) => BF.state.project.cuts.find((c) => c.id === id) || null,
      addCut(fields) {
        let created = null;
        BF.project.update((p) => { created = model.newCut({ title: `Corte ${p.cuts.length + 1}`, ...fields }, { index: p.cuts.length }); p.cuts.push(created); p.cuts.sort((a, b) => a.start - b.start); }, { reason: 'cut:create' });
        return created;
      }
    };
    BF.review = { engine: review.createEngine({ getProject: () => BF.state.project, update: (fn, reason) => BF.project.update(fn, { reason }), emit: (n, d) => BF.bus.emit(n, d), uid: (p) => model.uid(p), duration: () => duration }) };
    BF.review.engine.reset('p1');
    if (extra.review !== undefined) BF.review = extra.review; // um motor de mentira (ou nenhum), no lugar do de verdade
  }
  vm.runInContext(CODE, vm.createContext({ window: { BF }, document: doc }), { filename: 'mcp.js' });
  const replies = [];
  BF.api = ((orig) => async (channel, payload, ...rest) => { if (channel === 'mcp:reply') { replies.push(plain(payload)); return { ok: true }; } return orig(channel, payload, ...rest); })(BF.api);
  // os resultados vêm de outro contexto (vm): para comparar com deepEqual viram dados simples; erros e síncrono/assíncrono ficam como são
  const ops = Object.fromEntries(Object.keys(BF.mcp.ops).map((name) => [name, (...args) => { const r = BF.mcp.ops[name](...args); return r && typeof r.then === 'function' ? r.then(plain) : plain(r); }]));
  const statuses = () => BF.state.project.cuts.map((c) => `${c.id}:${c.status}`).join(' ');
  return {
    BF, ops, doc, confirms, toasts, logs, apiCalls, replies, emitted, statuses,
    request: (op, args, id = 'r1') => channels.get('mcp:request')[0]({ id, op, args }),
    pushState: (s) => (channels.get('mcp:state') || []).forEach((fn) => fn(s))
  };
}

const ASK = { ask: true, agent: AGENT };
const AUTO = { ask: false, agent: AGENT };

// ---------------------------------------------------------------- resposta ao servidor

test('handle: responde SEMPRE por mcp:reply (resultado, erro com código e mensagem, operação desconhecida); pedido malformado é ignorado', async () => {
  const env = load();
  await env.request('context', {}, 'a1');
  assert.deepEqual(env.replies[0], { id: 'a1', ok: true, result: plain(env.ops.context()) });
  await env.request('cut_decide', { cutIds: ['x'], status: 'approved' }, 'a2');
  assert.equal(env.replies[1].ok, false);
  assert.equal(env.replies[1].code, 'CUT_NOT_FOUND');
  assert.match(env.replies[1].message, /Nenhum dos cortes informados existe/);
  await env.request('apagar_tudo', {}, 'a3');
  assert.deepEqual(env.replies[2], { id: 'a3', ok: false, code: 'UNKNOWN_OP', message: 'Operação desconhecida: apagar_tudo.' });
  await env.request('toString', {}, 'a4');
  assert.equal(env.replies[3].code, 'UNKNOWN_OP', 'nada do protótipo do objeto vira operação');
  await env.request('context', 'não é objeto', 'a5');
  assert.equal(env.replies[4].ok, true, 'argumentos que não são um objeto valem como {}');
  const before = env.replies.length;
  await env.BF.mcp.handle(null);
  await env.BF.mcp.handle({ id: 5, op: 'context' });
  await env.BF.mcp.handle({ id: 'x' });
  assert.equal(env.replies.length, before, 'sem id texto e op texto: ignorado');
  // erro inesperado dentro de uma operação
  const broken = load({ extra: { review: { get engine() { throw new Error('quebrou por dentro'); } } } });
  await broken.request('cut_decide', { cutIds: ['c1'], status: 'approved' }, 'b1');
  assert.deepEqual([broken.replies[0].ok, broken.replies[0].code, broken.replies[0].message], [false, 'ERROR', 'quebrou por dentro']);
});

test('context, flush, confirm e refresh_transcript: o projeto aberto (ou nada), gravar agora, a confirmação genérica e o aviso à aba Análise', async () => {
  const env = load({ extra: { exportOut: { summary: () => ({ profileId: 'v1', profiles: [{ id: 'v1', name: 'Vertical 1080p' }], dir: 'C:\\Cortes' }) } } });
  assert.deepEqual(env.ops.context(), { id: 'p1', title: 'Live da noite', durationSec: 120, cuts: { total: 3, pending: 2, approved: 1, rejected: 0 }, exportProfile: 'Vertical 1080p' });
  assert.deepEqual(await env.ops.flush(), { saved: true });
  assert.deepEqual(await env.ops.confirm({ title: 'T', message: 'M', okLabel: 'Fazer' }), { accepted: true });
  assert.deepEqual(env.confirms[0], { title: 'T', message: 'M', okLabel: 'Fazer' });
  assert.deepEqual(await load({ answers: [false] }).ops.confirm({}), { accepted: false });
  assert.deepEqual(env.ops.refresh_transcript(), {});
  assert.ok(env.emitted.includes('transcription:changed'));
  const none = load({ project: false });
  assert.equal(none.ops.context(), null);
  assert.deepEqual(await none.ops.flush(), { saved: true });
  const title = load({}); title.BF.state.project.source.origin = { title: 'VOD da Twitch' };
  assert.equal(title.ops.context().title, 'VOD da Twitch');
  const broken = load({ extra: { exportOut: { summary: () => { throw new Error('x'); } } } });
  assert.equal(broken.ops.context().exportProfile, null, 'sem perfil legível: null, sem quebrar');
});

// ---------------------------------------------------------------- cortes

test('cut_create: valida tudo antes de perguntar; a janela explica; recusar não cria; aceitar cria PENDENTE e em ordem; dispensada, avisa em vez de perguntar', async () => {
  const env = load();
  await assert.rejects(env.ops.cut_create({ ...ASK, start: 9, end: 3 }), (e) => e.code === 'INVALID_RANGE' && /fim do corte precisa ser maior/.test(e.message));
  await assert.rejects(env.ops.cut_create({ ...ASK, start: 9, end: 9.4 }), (e) => e.code === 'INVALID_RANGE' && /pelo menos 1 segundo/.test(e.message));
  await assert.rejects(env.ops.cut_create({ ...ASK, start: 100, end: 130 }), (e) => e.code === 'OUT_OF_RANGE' && /passa da duração do vídeo \(2:00\)/.test(e.message));
  await assert.rejects(env.ops.cut_create({ ...ASK, start: 'a', end: 3 }), (e) => e.code === 'INVALID_RANGE');
  await assert.rejects(load({ project: false }).ops.cut_create({ ...ASK, start: 1, end: 5 }), (e) => e.code === 'NO_PROJECT' && /use project_open/.test(e.message));
  assert.deepEqual(env.confirms, [], 'nenhum erro acima incomodou o usuário');
  assert.equal(env.BF.state.project.cuts.length, 3);

  const declined = load({ answers: [false] });
  assert.deepEqual(await declined.ops.cut_create({ ...ASK, title: 'Melhor momento', start: 61, end: 69.5 }), { declined: true });
  assert.equal(declined.BF.state.project.cuts.length, 3);
  assert.equal(declined.confirms[0].title, 'Criar um corte?');
  assert.equal(declined.confirms[0].okLabel, 'Criar o corte');
  assert.equal(declined.confirms[0].message, `${AGENT} pede para criar o corte “Melhor momento” de 1:01 a 1:10 (8.5 s) no vídeo aberto, “Live da noite”. Ele nasce pendente: você decide se aprova.`);

  const ok = await env.ops.cut_create({ ...ASK, title: 'Melhor momento', start: 25, end: 29 });
  assert.deepEqual([ok.created.title, ok.created.start, ok.created.end, ok.created.status], ['Melhor momento', 25, 29, 'pending']);
  assert.deepEqual(env.BF.state.project.cuts.map((c) => c.id).slice(0, 3), ['c1', ok.created.id, 'c2'], 'em ordem de tempo');
  assert.deepEqual(env.toasts, [], 'com a janela de confirmação não há aviso extra');
  // sem título: o app dá o nome; confirmação dispensada: nada de janela, aviso na tela e no registro
  const auto = load();
  const made = await auto.ops.cut_create({ ...AUTO, start: 40, end: 44 });
  assert.equal(auto.confirms.length, 0);
  assert.match(made.created.title, /^Corte \d+$/);
  assert.deepEqual(auto.toasts, [[`${AGENT}: criou o corte “${made.created.title}”.`, 'ok']]);
  assert.equal(auto.logs.length, 1);
});

test('cut_decide: decide em LOTE num passo só de histórico (um Ctrl+Z desfaz tudo), lista os cortes na janela, diz os que não existem e o que já estava', async () => {
  const env = load();
  const res = await env.ops.cut_decide({ ...ASK, cutIds: ['c1', 'c2', 'c3', 'nao-existe'], status: 'approved' });
  assert.deepEqual([res.changed, res.unchanged, res.missing], [2, 1, ['nao-existe']], 'c3 já estava aprovado');
  assert.equal(env.statuses(), 'c1:approved c2:approved c3:approved');
  assert.deepEqual(res.cuts.map((c) => [c.id, c.status]), [['c1', 'approved'], ['c2', 'approved'], ['c3', 'approved']]);
  assert.equal(env.confirms[0].title, 'Aprovar 2 cortes?');
  assert.equal(env.confirms[0].okLabel, 'Aprovar');
  assert.equal(env.confirms[0].message, `${AGENT} pede para aprovar:\n• “Largada” (0:05–0:20)\n• “Curva fechada” (0:30–0:50)\nDá para desfazer com Ctrl+Z na aba Cortes.`);
  assert.equal(env.BF.review.engine.groups().length, 1, 'UM grupo de histórico para o lote');
  env.BF.review.engine.undo();
  assert.equal(env.statuses(), 'c1:pending c2:pending c3:approved', 'um desfazer volta os dois');
  env.BF.review.engine.redo();
  assert.equal(env.statuses(), 'c1:approved c2:approved c3:approved');
  // rejeitar e redefinir
  const rej = await env.ops.cut_decide({ ...ASK, cutIds: ['c3'], status: 'rejected' });
  assert.equal(rej.changed, 1);
  assert.equal(env.confirms.at(-1).title, 'Rejeitar 1 corte?');
  assert.equal(env.confirms.at(-1).okLabel, 'Rejeitar');
  await env.ops.cut_decide({ ...ASK, cutIds: ['c3', 'c1'], status: 'pending' });
  assert.equal(env.confirms.at(-1).title, 'Redefinir 2 cortes?');
  assert.match(env.confirms.at(-1).message, /pede para voltar para pendente:/);
  assert.equal(env.statuses(), 'c1:pending c2:approved c3:pending');
});

test('cut_decide: o impossível vira erro SEM janela; já decidido não pergunta; recusar não muda nada; dispensada, avisa; mais de 6 cortes viram "e mais N"', async () => {
  const env = load();
  await assert.rejects(env.ops.cut_decide({ ...ASK, cutIds: ['x'], status: 'approved' }), (e) => e.code === 'CUT_NOT_FOUND');
  await assert.rejects(env.ops.cut_decide({ ...ASK, cutIds: ['c1'], status: 'talvez' }), (e) => e.code === 'INVALID_ARGS' && /approved, rejected ou pending/.test(e.message));
  await assert.rejects(env.ops.cut_decide({ ...ASK, cutIds: [], status: 'approved' }), (e) => e.code === 'CUT_NOT_FOUND');
  await assert.rejects(load({ project: false }).ops.cut_decide({ ...ASK, cutIds: ['c1'], status: 'approved' }), (e) => e.code === 'NO_PROJECT');
  const noEngine = load({ extra: { review: {} } });
  await assert.rejects(noEngine.ops.cut_decide({ ...ASK, cutIds: ['c1'], status: 'approved' }), (e) => e.code === 'NOT_READY');
  const same = await env.ops.cut_decide({ ...ASK, cutIds: ['c3'], status: 'approved' });
  assert.deepEqual([same.changed, same.unchanged], [0, 1]);
  assert.deepEqual(env.confirms, [], 'nada a fazer e erros: nenhuma janela');
  const declined = load({ answers: [false] });
  assert.deepEqual(await declined.ops.cut_decide({ ...ASK, cutIds: ['c1'], status: 'rejected' }), { declined: true });
  assert.equal(declined.statuses(), 'c1:pending c2:pending c3:approved');
  const auto = load();
  await auto.ops.cut_decide({ ...AUTO, cutIds: ['c1', 'c2'], status: 'rejected' });
  assert.equal(auto.confirms.length, 0);
  assert.deepEqual(auto.toasts, [[`${AGENT}: rejeitou 2 cortes.`, 'ok']]);
  const many = load();
  many.BF.state.project.cuts = Array.from({ length: 9 }, (_, i) => model.newCut({ id: `m${i}`, title: `Corte ${i}`, start: i * 10, end: i * 10 + 5 }));
  many.BF.review.engine.reset('p1');
  await many.ops.cut_decide({ ...ASK, cutIds: many.BF.state.project.cuts.map((c) => c.id), status: 'approved' });
  assert.match(many.confirms[0].message, /… e mais 3/);
  assert.equal(many.confirms[0].message.split('\n').filter((l) => l.startsWith('•')).length, 6);
});

test('cut_edit: confere o intervalo e o corte antes de perguntar, aplica o TEMPO primeiro (se falhar nada muda) e depois o título, cada um desfazível', async () => {
  const env = load();
  await assert.rejects(env.ops.cut_edit({ ...ASK, cutId: 'nao-existe', title: 'x' }), (e) => e.code === 'CUT_NOT_FOUND');
  await assert.rejects(env.ops.cut_edit({ ...ASK, cutId: 'c1' }), (e) => e.code === 'INVALID_ARGS' && /Informe o que mudar/.test(e.message));
  await assert.rejects(env.ops.cut_edit({ ...ASK, cutId: 'c1', start: 30 }), (e) => e.code === 'INVALID_RANGE', 'o início novo passa do fim (20)');
  await assert.rejects(env.ops.cut_edit({ ...ASK, cutId: 'c1', end: 500 }), (e) => e.code === 'OUT_OF_RANGE');
  await assert.rejects(env.ops.cut_edit({ ...ASK, cutId: 'c1', title: '   ' }), (e) => e.code === 'INVALID_ARGS');
  assert.deepEqual(env.confirms, []);
  const res = await env.ops.cut_edit({ ...ASK, cutId: 'c1', title: 'Largada perfeita', start: 4.5, end: 21 });
  assert.deepEqual([res.cut.title, res.cut.start, res.cut.end], ['Largada perfeita', 4.5, 21]);
  assert.equal(env.confirms[0].title, 'Alterar o corte?');
  assert.equal(env.confirms[0].message, `${AGENT} pede para alterar “Largada” (0:05–0:20): título “Largada perfeita” e 0:05 a 0:21. Dá para desfazer com Ctrl+Z na aba Cortes.`);
  env.BF.review.engine.undo();
  assert.equal(env.BF.project.cut('c1').title, 'Largada', 'o título volta primeiro');
  env.BF.review.engine.undo();
  assert.deepEqual([env.BF.project.cut('c1').start, env.BF.project.cut('c1').end], [5, 20], 'depois o tempo');
  // só o título
  const t = await env.ops.cut_edit({ ...AUTO, cutId: 'c2', title: '  Curva  ' });
  assert.equal(t.cut.title, 'Curva');
  assert.deepEqual(env.toasts.at(-1), [`${AGENT}: alterou “Curva fechada”.`, 'ok']);
  // recusar
  const declined = load({ answers: [false] });
  assert.deepEqual(await declined.ops.cut_edit({ ...ASK, cutId: 'c1', title: 'X' }), { declined: true });
  assert.equal(declined.BF.project.cut('c1').title, 'Largada');
});

// ---------------------------------------------------------------- análise e exportação

test('analysis_state: as sugestões ainda pendentes (as 30 mais relevantes), o andamento e a última execução; sem projeto, nada', () => {
  const sug = Array.from({ length: 35 }, (_, i) => ({ id: `s${i}`, start: i, end: i + 5.55, relevance: i / 100, reasons: ['a', 'b', 'c', 'd', 'e'], ...(i === 34 ? { title: 'Melhor' } : {}) }));
  const env = load({ extra: { analysis: { mcpState: () => ({ running: true, progress: { p: 0.4567, message: 'x' }, lastRunAt: '2026-11-20T10:00:00.000Z', suggestions: sug }) } } });
  const out = env.ops.analysis_state();
  assert.deepEqual([out.id, out.running, out.progress, out.lastRunAt, out.suggestionCount], ['p1', true, 0.46, '2026-11-20T10:00:00.000Z', 35]);
  assert.equal(out.suggestions.length, 30);
  assert.deepEqual(out.suggestions[0], { id: 's34', start: 34, end: 39.6, relevance: 0.34, reasons: ['a', 'b', 'c', 'd'], title: 'Melhor' }, 'a mais relevante primeiro, no máximo 4 motivos');
  assert.equal(load({ project: false }).ops.analysis_state(), null);
  assert.equal(load({ extra: { analysis: { mcpState: () => null } } }).ops.analysis_state(), null);
  assert.equal(load().ops.analysis_state(), null, 'sem o módulo da análise: null');
});

test('analysis_run: pergunta (diz que é local e nada sai do computador), roda só o algoritmo, e os motivos de não começar viram erro em português', async () => {
  const runs = [];
  const env = load({ extra: { analysis: { runLocal: async () => { runs.push(1); return { ok: true }; }, mcpState: () => ({ suggestions: [] }) } } });
  const res = await env.ops.analysis_run(ASK);
  assert.deepEqual(res, { started: true, note: 'Acompanhe com analysis_status e, quando terminar, use analysis_add_cuts.' });
  assert.deepEqual(runs, [1]);
  assert.equal(env.confirms[0].title, 'Procurar momentos interessantes?');
  assert.match(env.confirms[0].message, /pede para analisar “Live da noite”/);
  assert.match(env.confirms[0].message, /análise local \(algoritmo\), no seu computador: nada é enviado para fora/);
  const declined = load({ answers: [false], extra: { analysis: { runLocal: async () => { throw new Error('não devia rodar'); } } } });
  assert.deepEqual(await declined.ops.analysis_run(ASK), { declined: true });
  const busy = load({ extra: { analysis: { runLocal: async () => ({ ok: false, reason: 'Já existe uma análise em andamento.' }) } } });
  await assert.rejects(busy.ops.analysis_run(ASK), (e) => e.code === 'ANALYSIS_NOT_STARTED' && /Já existe uma análise em andamento/.test(e.message));
  await assert.rejects(load().ops.analysis_run(ASK), (e) => e.code === 'NOT_READY');
  await assert.rejects(load({ project: false, extra: { analysis: { runLocal: async () => ({ ok: true }) } } }).ops.analysis_run(ASK), (e) => e.code === 'NO_PROJECT');
  const auto = load({ extra: { analysis: { runLocal: async () => ({ ok: true }) } } });
  await auto.ops.analysis_run(AUTO);
  assert.equal(auto.confirms.length, 0);
  assert.deepEqual(auto.toasts, [[`${AGENT}: começou a análise.`, 'ok']]);
});

test('analysis_add_cuts: por ids ou pelas N mais relevantes, a janela lista e diz que nenhum é aprovado, e o que já virou corte não repete', async () => {
  const sug = [{ id: 's1', start: 10, end: 14, relevance: 0.9 }, { id: 's2', start: 40, end: 44, relevance: 0.5, title: 'Plot twist' }, { id: 's3', start: 90, end: 99, relevance: 0.7 }];
  const added = [];
  const make = (extraCtx = {}) => load({ extra: { analysis: { mcpState: () => ({ suggestions: sug }), addSuggestions: (list) => { added.push(list.map((s) => s.id)); return list.map((s) => model.newCut({ id: `n-${s.id}`, title: s.title || 'Sugestão', start: s.start, end: s.end, origin: 'auto' })); }, ...extraCtx } } });
  const env = make();
  const byTop = await env.ops.analysis_add_cuts({ ...ASK, top: 2 });
  assert.deepEqual(added.at(-1), ['s1', 's3'], 'as duas mais relevantes');
  assert.deepEqual(byTop.created.map((c) => c.id), ['n-s1', 'n-s3']);
  assert.equal(byTop.alreadyCovered, 0);
  assert.equal(env.confirms[0].title, 'Criar 2 cortes a partir da análise?');
  assert.match(env.confirms[0].message, /transformar 2 sugestões da análise em cortes pendentes \(nenhum é aprovado\):\n• “Sugestão 0:10” \(0:10–0:14\)\n• “Sugestão 1:30” \(1:30–1:39\)/);
  await env.ops.analysis_add_cuts({ ...ASK, suggestionIds: ['s2', 'nao-existe'] });
  assert.deepEqual(added.at(-1), ['s2'], 'só as que existem');
  assert.match(env.confirms.at(-1).message, /• “Plot twist”/);
  await assert.rejects(env.ops.analysis_add_cuts({ ...ASK, suggestionIds: ['nao-existe'] }), (e) => e.code === 'NO_SUGGESTIONS' && /Nenhuma das sugestões informadas está pendente/.test(e.message));
  const empty = load({ extra: { analysis: { mcpState: () => ({ suggestions: [] }), addSuggestions: () => [] } } });
  await assert.rejects(empty.ops.analysis_add_cuts({ ...ASK, top: 3 }), (e) => e.code === 'NO_SUGGESTIONS' && /rode analysis_run/.test(e.message));
  assert.deepEqual(empty.confirms, []);
  const declined = load({ answers: [false], extra: { analysis: { mcpState: () => ({ suggestions: sug }), addSuggestions: () => { throw new Error('não devia criar'); } } } });
  assert.deepEqual(await declined.ops.analysis_add_cuts({ ...ASK, top: 1 }), { declined: true });
  const covered = make({ addSuggestions: () => [] });
  assert.equal((await covered.ops.analysis_add_cuts({ ...AUTO, top: 1 })).alreadyCovered, 1, 'a sugestão já coberta por um corte não repete');
  await assert.rejects(load().ops.analysis_add_cuts({ ...ASK, top: 1 }), (e) => e.code === 'NOT_READY');
});

test('export_enqueue: só cortes APROVADOS, os outros são ditos; a janela mostra perfil e pasta; erro da conferência volta com os motivos; recusar não envia', async () => {
  const sent = [];
  const exportOut = (over = {}) => ({
    ensureProfiles: async () => {},
    summary: () => ({ profileId: 'v1', profiles: [{ id: 'v1', name: 'Vertical 1080p' }], dir: 'C:\\Videos\\Cortes' }),
    enqueueCuts: async (ids) => { sent.push(ids); return { ok: true, sent: ids.length, skipped: 0, failed: [] }; },
    ...over
  });
  const env = load({ extra: { exportOut: exportOut() } });
  const all = await env.ops.export_enqueue(ASK);
  assert.deepEqual(sent.at(-1), ['c3'], 'sem cutIds: todos os aprovados');
  assert.deepEqual(all, { queued: 1, alreadyQueuedOrExported: 0, rejectedByQualityCheck: [], notApproved: [] });
  assert.equal(env.confirms[0].title, 'Enviar 1 corte para a fila?');
  assert.equal(env.confirms[0].okLabel, 'Enviar para a fila');
  assert.match(env.confirms[0].message, new RegExp(`^${AGENT} pede para exportar:\\n• “Chegada” \\(1:10–1:35\\)\\nPerfil: Vertical 1080p\\. Pasta de destino: C:\\\\Videos\\\\Cortes\\. A exportação roda em segundo plano e você acompanha na aba Exportações\\.$`));
  env.BF.state.project.cuts[0].status = 'approved';
  const some = await env.ops.export_enqueue({ ...ASK, cutIds: ['c1', 'c2', 'c3', 'nao-existe'] });
  assert.deepEqual(sent.at(-1), ['c1', 'c3']);
  assert.deepEqual(some.notApproved, ['c2'], 'o pendente fica de fora e é dito');
  await assert.rejects(env.ops.export_enqueue({ ...ASK, cutIds: ['c2'] }), (e) => e.code === 'NO_APPROVED_CUTS' && /Nenhum dos cortes informados está aprovado/.test(e.message));
  const none = load({ extra: { exportOut: exportOut() } });
  none.BF.state.project.cuts[2].status = 'pending';
  await assert.rejects(none.ops.export_enqueue(ASK), (e) => e.code === 'NO_APPROVED_CUTS' && /aprove antes \(cut_decide\)/.test(e.message));
  assert.deepEqual(none.confirms, [], 'erros: nenhuma janela');
  const quality = load({ extra: { exportOut: exportOut({ enqueueCuts: async () => ({ ok: false, message: 'Nenhum corte pode ser exportado: a conferência de qualidade recusou todos.', failed: [{ cutId: 'c3', reasons: ['o corte é curto demais', 'sem áudio'] }] }) }) } });
  await assert.rejects(quality.ops.export_enqueue(ASK), (e) => e.code === 'EXPORT_FAILED' && /recusou todos\. \(o corte é curto demais; sem áudio\)/.test(e.message));
  const partial = load({ extra: { exportOut: exportOut({ enqueueCuts: async () => ({ ok: true, sent: 1, skipped: 2, failed: [{ cutId: 'c9', reasons: ['x'] }] }) }) } });
  assert.deepEqual(await partial.ops.export_enqueue(AUTO), { queued: 1, alreadyQueuedOrExported: 2, rejectedByQualityCheck: [{ cutId: 'c9', reasons: ['x'] }], notApproved: [] });
  assert.deepEqual(partial.toasts, [[`${AGENT}: mandou 1 corte para a fila de exportação.`, 'ok']]);
  const declined = load({ answers: [false], extra: { exportOut: exportOut({ enqueueCuts: async () => { throw new Error('não devia enviar'); } }) } });
  assert.deepEqual(await declined.ops.export_enqueue(ASK), { declined: true });
  await assert.rejects(load().ops.export_enqueue(ASK), (e) => e.code === 'NOT_READY');
  const noSummary = load({ extra: { exportOut: exportOut({ ensureProfiles: async () => { throw new Error('x'); } }) } });
  await noSummary.ops.export_enqueue(ASK);
  assert.doesNotMatch(noSummary.confirms[0].message, /Perfil:/, 'sem o perfil legível a janela ainda pergunta, só sem essa linha');
});

test('open_project: a janela avisa que o vídeo da tela será trocado; recusar não abre; erro de abertura volta em português', async () => {
  const opened = [];
  const env = load({ extra: { openSource: async (p) => { opened.push(p); return { ok: true }; } } });
  assert.deepEqual((await env.ops.open_project({ ...ASK, path: 'C:\\Videos\\Outro.mp4', title: 'Outra live' })), { opened: true });
  assert.deepEqual(opened, ['C:\\Videos\\Outro.mp4']);
  assert.equal(env.confirms[0].title, 'Abrir outro projeto?');
  assert.equal(env.confirms[0].message, `${AGENT} pede para abrir “Outra live”. O vídeo que está na tela vai ser trocado (o projeto atual continua salvo).`);
  const declined = load({ answers: [false], extra: { openSource: async (p) => { opened.push(p); return { ok: true }; } } });
  opened.length = 0;
  assert.deepEqual(await declined.ops.open_project({ ...ASK, path: 'C:\\x.mp4', title: 'x' }), { declined: true });
  assert.deepEqual(opened, []);
  const failing = load({ extra: { openSource: async () => ({ ok: false, code: 'BUSY', message: 'Já existe um vídeo sendo aberto.' }) } });
  await assert.rejects(failing.ops.open_project({ ...ASK, path: 'C:\\x.mp4' }), (e) => e.code === 'BUSY' && /Já existe um vídeo sendo aberto/.test(e.message));
  await assert.rejects(env.ops.open_project({ ...ASK }), (e) => e.code === 'INVALID_ARGS');
  const auto = load({ extra: { openSource: async () => ({ ok: true }) } });
  await auto.ops.open_project({ ...AUTO, path: 'C:\\x.mp4', title: 'Outra' });
  assert.deepEqual(auto.toasts, [[`${AGENT}: abriu “Outra”.`, 'ok']]);
});

// ---------------------------------------------------------------- o cartão

/** O cartão desenhado e uma forma de achar os botões/campos pelo que eles fazem. */
async function card(status) {
  const env = load({ status });
  const node = env.BF.mcp.card();
  await idle();
  const all = (sel) => node.querySelectorAll(sel);
  const byAct = (act) => all('button').find((b) => b.dataset.act === act) || null;
  return { ...env, node, all, byAct, sw: () => all('input').find((i) => i.id === 'genMcpSwitch'), auto: () => all('input').find((i) => i.id === 'genMcpAutoSwitch'), text: () => node.textContent };
}

const RUNNING = { ok: true, available: true, enabled: true, running: true, port: 47822, url: 'http://127.0.0.1:47822/mcp', calls: 12, client: 'Antigravity', autoConfirm: false, error: '' };

test('cartão: desligado por padrão (interruptor desmarcado, sem botões de copiar), com o texto de segurança; lê a situação ao nascer', async () => {
  const c = await card();
  assert.equal(c.node.dataset.section, 'mcp');
  assert.match(c.text(), /Agentes de IA \(MCP\)/);
  assert.match(c.text(), /Fica desligado até você ligar, só aceita conexões daqui e exige um token/);
  assert.match(c.text(), /Ele não apaga nada e nunca vê as suas chaves/);
  assert.match(c.text(), /Desligado\. Nenhum agente consegue se conectar\./);
  assert.equal(c.sw().checked, false);
  assert.equal(c.sw().attrs.role, 'switch');
  assert.equal(c.node.querySelector('.gen-mcp-running').hidden, true);
  assert.equal(c.apiCalls[0][0], 'mcp:status');
  assert.equal(c.BF.mcp.card(), c.node, 'o mesmo elemento sempre');
  assert.equal(c.apiCalls.filter(([ch]) => ch === 'mcp:status').length, 1, 'e só lê uma vez');
});

test('cartão ligado: mostra porta, agente e chamadas, os três botões de copiar, o aviso do token e a confirmação das ações vem ligada; mcp:state atualiza ao vivo', async () => {
  const c = await card(RUNNING);
  assert.equal(c.sw().checked, true);
  assert.match(c.text(), /Ligado em 127\.0\.0\.1:47822 · último agente: Antigravity · 12 chamadas/);
  assert.equal(c.node.querySelector('.gen-mcp-running').hidden, false);
  assert.deepEqual(c.all('button').map((b) => b.dataset.act), ['copy-antigravity', 'copy-http', 'copy-stdio', 'new-token']);
  assert.equal(c.auto().checked, false);
  assert.equal(c.node.querySelector('.gen-mcp-warn').hidden, true);
  assert.match(c.text(), /Como conectar/);
  assert.match(c.text(), /o token, que é a senha: não compartilhe/);
  c.pushState({ ...RUNNING, calls: 1, client: '' });
  assert.match(c.text(), /nenhum agente conectou ainda · 1 chamada(?!s)/);
  c.pushState({ ...RUNNING, autoConfirm: true });
  assert.equal(c.node.querySelector('.gen-mcp-warn').hidden, false);
  assert.equal(c.auto().checked, true);
  c.pushState({ ...RUNNING, running: false, enabled: false });
  assert.match(c.text(), /Desligado/);
  assert.equal(c.node.querySelector('.gen-mcp-running').hidden, true);
  c.pushState({ ...RUNNING, running: false, enabled: true, error: 'Não foi possível abrir a porta local para os agentes.' });
  assert.match(c.text(), /Ligado, mas o servidor não abriu\./);
  assert.equal(c.node.querySelector('.gen-mcp-message').hidden, false);
  assert.match(c.node.querySelector('.gen-mcp-message').textContent, /Não foi possível abrir a porta local/);
  assert.equal(c.node.querySelector('.gen-mcp-message').attrs.role, 'alert');
  c.pushState(null);
  c.pushState('x');
});

test('cartão: o interruptor liga e desliga pelo processo principal; a falha aparece em português; copiar manda o formato certo (o token nem passa pela tela)', async () => {
  const c = await card();
  const calls = () => c.apiCalls.map(([ch, p]) => [ch, p]);
  c.sw().checked = true;
  c.sw().dispatch('change');
  await idle();
  assert.deepEqual(calls().at(-1), ['mcp:setEnabled', { enabled: true }]);
  // o servidor respondeu o estado novo: o cartão o usa
  const on = load({ status: RUNNING });
  const node = on.BF.mcp.card();
  await idle();
  const copy = (act) => node.querySelectorAll('button').find((b) => b.dataset.act === act);
  for (const [act, kind] of [['copy-antigravity', 'antigravity'], ['copy-http', 'http'], ['copy-stdio', 'stdio']]) {
    copy(act).click();
    await idle();
    assert.deepEqual(on.apiCalls.at(-1), ['mcp:copyConfig', { kind }]);
  }
  assert.equal(on.toasts.length, 3);
  assert.match(on.toasts[0][0], /Configuração copiada\. Cole no arquivo de configuração do agente \(ela tem o token: não compartilhe\)\./);
  assert.equal(JSON.stringify(on.apiCalls).includes('Bearer'), false, 'nenhum token passou pela janela');
  // falha ao ligar
  const fail = load();
  fail.BF.api = async (ch) => (ch === 'mcp:setEnabled' ? { ok: false, message: 'Não foi possível abrir a porta local para os agentes.' } : { ok: true, available: true, enabled: false, running: false, port: 1, url: '', calls: 0, client: '', autoConfirm: false, error: '' });
  const f = fail.BF.mcp.card();
  await idle();
  const sw = f.querySelectorAll('input').find((i) => i.id === 'genMcpSwitch');
  sw.checked = true;
  sw.dispatch('change');
  await idle();
  assert.match(f.textContent, /Não foi possível abrir a porta local para os agentes\./);
  assert.equal(sw.checked, false, 'não ligou: o interruptor volta');
});

test('cartão: dispensar a confirmação exige um aviso claro (recusar mantém), e o token novo pede confirmação antes de trocar', async () => {
  const c = await card(RUNNING);
  const confirmsBefore = c.confirms.length;
  // recusar o aviso
  const refuse = load({ status: RUNNING, answers: [false] });
  const rn = refuse.BF.mcp.card();
  await idle();
  const ra = rn.querySelectorAll('input').find((i) => i.id === 'genMcpAutoSwitch');
  ra.checked = true;
  ra.dispatch('change');
  await idle();
  assert.equal(refuse.confirms[0].title, 'Não pedir confirmação ao agente?');
  assert.match(refuse.confirms[0].message, /SEM perguntar antes/);
  assert.match(refuse.confirms[0].message, /continua sem poder apagar nada nem ler suas chaves/);
  assert.equal(ra.checked, false, 'recusou: continua pedindo');
  assert.equal(refuse.apiCalls.some(([ch]) => ch === 'mcp:setOptions'), false);
  // aceitar o aviso
  c.auto().checked = true;
  c.auto().dispatch('change');
  await idle();
  assert.equal(c.confirms.length, confirmsBefore + 1);
  assert.deepEqual(c.apiCalls.at(-1), ['mcp:setOptions', { autoConfirm: true }]);
  // desmarcar não pergunta
  c.auto().checked = false;
  c.auto().dispatch('change');
  await idle();
  assert.equal(c.confirms.length, confirmsBefore + 1, 'voltar a pedir confirmação não precisa de aviso');
  assert.deepEqual(c.apiCalls.at(-1), ['mcp:setOptions', { autoConfirm: false }]);
  // token novo
  c.byAct('new-token').click();
  await idle();
  assert.equal(c.confirms.at(-1).title, 'Gerar um token novo?');
  assert.match(c.confirms.at(-1).message, /Quem usava o token atual perde o acesso/);
  assert.deepEqual(c.apiCalls.at(-1), ['mcp:regenerateToken', undefined]);
  assert.match(c.toasts.at(-1)[0], /Token novo gerado\. Copie a configuração de novo no agente\./);
  const no = load({ status: RUNNING, answers: [false] });
  const nn = no.BF.mcp.card();
  await idle();
  nn.querySelectorAll('button').find((b) => b.dataset.act === 'new-token').click();
  await idle();
  assert.equal(no.apiCalls.some(([ch]) => ch === 'mcp:regenerateToken'), false, 'recusou: o token fica');
});

test('cartão: onde não há servidor (módulo embutido: available:false) o cartão se esconde', async () => {
  const c = await card({ ok: true, available: false, reason: 'O Braga Frame está dentro do BDS.', enabled: false, running: false, port: 0, url: '', calls: 0, client: '', autoConfirm: false, error: '' });
  assert.equal(c.node.hidden, true);
  assert.equal(c.sw().disabled, true);
  const ok = await card(RUNNING);
  assert.equal(ok.node.hidden, false);
});

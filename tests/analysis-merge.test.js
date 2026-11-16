'use strict';

/**
 * MODO "ALGORITMO + IA" (docs/recursos/analysis.md, "Algoritmo + IA"): a junção das listas (merge.js) e a execução em sequência dos dois
 * motores (combo.js), com gerenciadores falsos (sem ffmpeg e sem rede).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { mergeResults, sameMoment } = require('../src/core/analysis/merge');
const { ComboAnalysis, ALGORITHM_SHARE } = require('../src/core/analysis/combo');

const A = (start, end, relevance, extra = {}) => ({ id: `${start * 10}_${end * 10}`, start, end, peak: (start + end) / 2, relevance, reasons: ['volume acima do normal'], evidence: ['audio:level'], ...extra });
const I = (start, end, relevance, extra = {}) => ({ id: `${start * 10}_${end * 10}`, start, end, peak: end - 2, relevance, reasons: ['piada com desfecho'], title: `IA ${start}`, category: 'Humor', layout: 'jogo', ...extra });
const algoResult = (suggestions, extra = {}) => ({
  version: 9, engine: undefined, at: '2026-11-16T10:00:00.000Z', fromCache: true, tookMs: 4000, params: { maxDurationSec: 60 }, signals: { audio: { used: true } },
  usedSignals: ['audio', 'text'], limit: 12, warnings: [{ code: 'X', message: 'aviso do algoritmo' }], episodes: [], breaks: [], suggestions, ...extra
});
const aiResult = (suggestions, extra = {}) => ({
  version: 2, engine: 'ai', at: '2026-11-16T10:05:00.000Z', fromCache: false, tookMs: 60000, params: { maxDurationSec: 60 }, usedSignals: ['ai'], limit: 12,
  warnings: [], suggestions, ai: { provider: 'Google Gemini', model: 'm', calls: 3 }, ...extra
});

test('mesmo momento: começo a até 5 s ou metade da menor sobreposta (a regra do placar)', () => {
  assert.equal(sameMoment({ start: 100, end: 130 }, { start: 104, end: 160 }), true, 'começos a 4 s');
  assert.equal(sameMoment({ start: 100, end: 130 }, { start: 112, end: 140 }), true, '18 de 28 s sobrepostos');
  assert.equal(sameMoment({ start: 100, end: 130 }, { start: 125, end: 160 }), false, 'só 5 s sobrepostos');
});

test('junção: o momento dos dois vira um só (bordas da união, relevância combinada, motivos dos dois, título da IA); o resto entra como veio', () => {
  const algo = algoResult([A(100, 130, 0.7), A(500, 530, 0.9), A(900, 925, 0.4)]);
  const ai = aiResult([I(95, 128, 0.8), I(2000, 2030, 0.6)]);
  const r = mergeResults(algo, ai);
  assert.equal(r.engine, 'both');
  assert.deepEqual(r.merge, { algorithm: 2, ai: 1, both: 1 });
  assert.equal(r.suggestions.length, 4);
  const both = r.suggestions[0];
  assert.deepEqual(both.engines, ['algorithm', 'ai'], 'o que os dois acharam vem primeiro');
  assert.deepEqual([both.start, both.end], [95, 130], 'do começo mais cedo ao fim mais tarde');
  assert.equal(both.relevance, 0.94, '1 - (1 - 0,7)(1 - 0,8)');
  assert.deepEqual(both.reasons, ['piada com desfecho', 'volume acima do normal']);
  assert.equal(both.title, 'IA 95');
  assert.equal(both.category, 'Humor');
  assert.deepEqual(both.evidence, ['audio:level'], 'a evidência do algoritmo continua');
  // depois: alterna IA e algoritmo, cada um na própria ordem de relevância
  assert.deepEqual(r.suggestions.slice(1).map((s) => [s.engines.join('+'), s.start]), [['ai', 2000], ['algorithm', 500], ['algorithm', 900]]);
  assert.ok(!('title' in r.suggestions[2]), 'a sugestão só do algoritmo não ganha título');
  assert.equal(r.limit, 24);
  assert.equal(r.tookMs, 64000);
  assert.equal(r.fromCache, false);
  assert.deepEqual(r.usedSignals, ['audio', 'text', 'ai']);
  assert.deepEqual(r.ai, ai.ai);
  assert.deepEqual(r.warnings, algo.warnings);
  assert.equal(new Set(r.suggestions.map((s) => s.id)).size, r.suggestions.length, 'ids únicos');
});

test('junção: a união que passaria da duração máxima fica com as bordas da IA; ids iguais nos dois motores não se repetem', () => {
  const r = mergeResults(algoResult([A(100, 150, 0.5)]), aiResult([I(120, 175, 0.5)]));
  assert.deepEqual([r.suggestions[0].start, r.suggestions[0].end], [120, 175], 'a união daria 75 s (máximo 60)');
  const twins = mergeResults(algoResult([A(10, 40, 0.5)]), aiResult([I(600, 630, 0.5, { id: '100_400' })]));
  assert.deepEqual(twins.suggestions.map((s) => s.id).sort(), ['100_400', '100_400b']);
});

test('junção: cada sugestão casa com uma só do outro motor (a de maior sobreposição); a da IA ganha o episódio pelo pico', () => {
  const algo = algoResult([A(100, 130, 0.5), A(128, 160, 0.5)], { episodes: [{ start: 0, end: 1000 }, { start: 1200, end: 3000 }] });
  const r = mergeResults(algo, aiResult([I(126, 158, 0.5), I(1500, 1530, 0.5)]));
  assert.equal(r.merge.both, 1);
  const paired = r.suggestions.find((s) => s.engines.length === 2);
  assert.equal(paired.id, '1280_1600', 'casou com a que mais sobrepõe');
  assert.equal(r.suggestions.find((s) => s.start === 1500).episode, 2);
});

test('junção: se um motor falhou, fica o outro, com aviso', () => {
  const onlyAlgo = mergeResults(algoResult([A(100, 130, 0.5)]), null, { aiError: { code: 'QUOTA', message: 'cota esgotada' } });
  assert.equal(onlyAlgo.engine, 'both');
  assert.deepEqual(onlyAlgo.merge, { algorithm: 1, ai: 0, both: 0, aiFailed: true });
  assert.match(onlyAlgo.warnings[0].message, /A parte da IA falhou \(cota esgotada\); ficaram só as sugestões do algoritmo/);
  assert.ok(!('ai' in onlyAlgo) || onlyAlgo.ai === undefined);
  const onlyAi = mergeResults(null, aiResult([I(100, 130, 0.5)]), { algorithmError: { code: 'NO_SIGNALS', message: 'sem sinais' } });
  assert.deepEqual(onlyAi.merge, { algorithm: 0, ai: 1, both: 0, algorithmFailed: true });
  assert.equal(onlyAi.warnings[0].code, 'ALGORITHM_FAILED');
  assert.throws(() => mergeResults(null, null), /falta o resultado/);
});

// ---------- execução em sequência (combo.js) ----------

/** Gerenciador falso: start devolve um jobId e guarda o pedido; o teste dispara os eventos. */
class FakeManager extends EventEmitter {
  constructor(prefix, { check } = {}) {
    super();
    this.prefix = prefix;
    this.starts = [];
    this.cancelled = [];
    this.n = 0;
    this.checkFn = check || null;
    this.job = null;
  }
  check(p) { if (this.checkFn) this.checkFn(p); return {}; }
  start(p) {
    this.n += 1;
    const jobId = `${this.prefix}${this.n}`;
    this.starts.push(p);
    this.job = jobId;
    this.emit('progress', { jobId, p: 0, stage: 'prepare', message: 'Preparando…' }); // como o gerenciador da IA: o primeiro andamento sai antes de devolver
    return { jobId };
  }
  cancel(jobId) { if (this.job !== jobId) return false; this.cancelled.push(jobId); setImmediate(() => this.emit('failed', { jobId, code: 'CANCELLED', message: 'cancelada' })); return true; }
}

function setup(opts = {}) {
  const algo = new FakeManager('a');
  const ai = new FakeManager('i', opts);
  const combo = new ComboAnalysis({ algo, ai });
  const events = [];
  for (const type of ['progress', 'done', 'failed']) combo.on(type, (ev) => events.push([type, ev]));
  return { algo, ai, combo, events };
}
const PAYLOAD = { engine: 'both', path: 'C:/v.mp4', params: { perHour: 6 }, chatPath: null, fresh: true, transcript: { cues: [] }, projectId: 'p1', size: 10, duration: 600, meta: { title: 'x' }, existingCuts: [{ start: 1, end: 2 }], profile: { criteria: 'c' } };

test('combo: roda o algoritmo, depois a IA, e entrega a junção com o próprio jobId; os eventos internos são dele', () => {
  const { algo, ai, combo, events } = setup();
  const { jobId } = combo.start(PAYLOAD);
  assert.match(jobId, /^c/);
  assert.deepEqual(algo.starts[0], { path: 'C:/v.mp4', params: { perHour: 6 }, chatPath: null, fresh: true, transcript: { cues: [] } });
  assert.equal(combo.owns('a1'), true);
  assert.equal(combo.status().engine, 'both');
  algo.emit('progress', { jobId: 'a1', p: 0.5, stage: 'audio', stageP: 0.3, message: 'Lendo o áudio…' });
  const half = events.filter(([t]) => t === 'progress').pop()[1];
  assert.equal(half.jobId, jobId);
  assert.equal(half.p, ALGORITHM_SHARE * 0.5);
  assert.equal(half.message, 'Algoritmo: Lendo o áudio…');
  assert.deepEqual([half.phase, half.stage, half.stageP], ['algorithm', 'audio', 0.3], 'a etapa do motor da vez segue para a tela (o tempo restante é por ela)');
  algo.emit('done', { jobId: 'a1', result: algoResult([A(100, 130, 0.7)]) });
  assert.equal(ai.starts.length, 1, 'a IA começa quando o algoritmo termina');
  assert.deepEqual(ai.starts[0], { projectId: 'p1', path: 'C:/v.mp4', size: 10, duration: 600, params: { perHour: 6 }, chatPath: null, meta: { title: 'x' }, existingCuts: [{ start: 1, end: 2 }], profile: { criteria: 'c' } });
  assert.equal(combo.owns('i1'), true);
  ai.emit('progress', { jobId: 'i1', p: 1, stage: 'ai2', message: 'Escolhendo…' });
  assert.equal(events.filter(([t]) => t === 'progress').pop()[1].message, 'IA: Escolhendo…');
  ai.emit('done', { jobId: 'i1', result: aiResult([I(98, 128, 0.8), I(400, 430, 0.6)]) });
  const done = events.find(([t]) => t === 'done')[1];
  assert.equal(done.jobId, jobId);
  assert.equal(done.result.engine, 'both');
  assert.deepEqual(done.result.merge, { algorithm: 0, ai: 1, both: 1 });
  assert.equal(combo.status(), null);
  assert.equal(combo.owns('i1'), false, 'terminou: nada mais é dele');
});

test('combo: sem o que a IA precisa, falha na hora, sem rodar o algoritmo', () => {
  const { algo, combo } = setup({ check: () => { throw Object.assign(new Error('Antes de enviar qualquer trecho, confirme o aviso de privacidade.'), { code: 'CONSENT_REQUIRED' }); } });
  assert.throws(() => combo.start(PAYLOAD), (err) => err.code === 'CONSENT_REQUIRED');
  assert.equal(algo.starts.length, 0);
  assert.equal(combo.status(), null);
});

test('combo: a IA falha no meio -> fica o algoritmo, com aviso; o algoritmo falha -> a IA roda e fica sozinha', () => {
  const one = setup();
  one.combo.start(PAYLOAD);
  one.algo.emit('done', { jobId: 'a1', result: algoResult([A(100, 130, 0.7)]) });
  one.ai.emit('failed', { jobId: 'i1', code: 'NETWORK', message: 'Sem conexão.' });
  const done = one.events.find(([t]) => t === 'done')[1].result;
  assert.equal(done.merge.aiFailed, true);
  assert.equal(done.suggestions.length, 1);
  assert.match(done.warnings[0].message, /Sem conexão/);

  const two = setup();
  two.combo.start(PAYLOAD);
  two.algo.emit('failed', { jobId: 'a1', code: 'NO_SIGNALS', message: 'Nenhum sinal.' });
  assert.equal(two.ai.starts.length, 1);
  two.ai.emit('done', { jobId: 'i1', result: aiResult([I(98, 128, 0.8)]) });
  assert.equal(two.events.find(([t]) => t === 'done')[1].result.merge.algorithmFailed, true);

  const three = setup();
  three.combo.start(PAYLOAD);
  three.algo.emit('failed', { jobId: 'a1', code: 'NO_SIGNALS', message: 'Nenhum sinal.' });
  three.ai.emit('failed', { jobId: 'i1', code: 'AUTH', message: 'Chave recusada.' });
  const failed = three.events.find(([t]) => t === 'failed')[1];
  assert.equal(failed.code, 'AUTH', 'os dois falharam: vale o erro da IA');
});

test('combo: cancelar cancela o trabalho da vez e o combo termina como cancelado', async () => {
  const { algo, ai, combo, events } = setup();
  const { jobId } = combo.start(PAYLOAD);
  assert.equal(combo.cancel('outro'), false);
  assert.equal(combo.cancel(jobId), true);
  assert.deepEqual(algo.cancelled, ['a1']);
  await new Promise((resolve) => setImmediate(resolve));
  const failed = events.find(([t]) => t === 'failed')[1];
  assert.equal(failed.code, 'CANCELLED');
  assert.equal(failed.jobId, jobId);
  assert.equal(ai.starts.length, 0, 'a IA nem começa');
  assert.equal(combo.status(), null);
});


test('combo: a data e a duração são as desta execução, mesmo com o algoritmo vindo do cache e a IA falhando', () => {
  const before = Date.now();
  const one = setup();
  one.combo.start(PAYLOAD);
  const cached = algoResult([A(100, 130, 0.7)]); // resultado guardado: data antiga, fromCache
  one.algo.emit('done', { jobId: 'a1', result: cached });
  one.ai.emit('failed', { jobId: 'i1', code: 'RATE_LIMIT', message: 'O provedor atingiu o limite de uso.' });
  const done = one.events.find(([t]) => t === 'done')[1].result;
  assert.equal(done.merge.aiFailed, true);
  assert.notEqual(done.at, cached.at, 'não herda a data de quando o algoritmo rodou');
  assert.ok(Date.parse(done.at) >= before && Date.parse(done.at) <= Date.now());
  assert.ok(done.tookMs >= 0 && done.tookMs < cached.tookMs, 'o tempo é o que esta execução levou');

  const two = setup();
  two.combo.start(PAYLOAD);
  two.algo.emit('done', { jobId: 'a1', result: algoResult([A(100, 130, 0.7)]) });
  two.ai.emit('done', { jobId: 'i1', result: aiResult([I(98, 128, 0.8)]) });
  const ok = two.events.find(([t]) => t === 'done')[1].result;
  assert.ok(Date.parse(ok.at) >= before && ok.tookMs < 4000, 'vale também quando os dois dão certo');
});

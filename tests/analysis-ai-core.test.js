'use strict';

/**
 * Núcleo da análise por IA, sem rede: leitura do JSON do modelo (cercas, texto em volta, resposta cortada), conferência local
 * (horários, desfecho, durações, margens, repetição), blocos com sobreposição e estimativa de custo, e a regra de tentativas.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const parse = require('../src/core/analysis/ai/parse');
const { verifyCandidate, dedupe, findPunchline, coveredBy } = require('../src/core/analysis/ai/verify');
const { buildWindows, estimate, describeEstimate, OVERLAP_SEC } = require('../src/core/analysis/ai/chunking');
const { callWithRetry, failureMessage } = require('../src/core/analysis/ai/analyze');
const { buildBlockMessage, SYSTEM_PROMPT } = require('../src/core/analysis/ai/prompt');
const { AiError, classify } = require('../src/core/ai/errors');
const F = require('./ai-fakes');

// ---------- leitura do JSON ----------

test('parseClock: m:ss, h:mm:ss, minutos acima de 59, decimais e números', () => {
  assert.equal(parse.parseClock('49:33'), 2973);
  assert.equal(parse.parseClock('121:41'), 7301);
  assert.equal(parse.parseClock('1:02:03'), 3723);
  assert.equal(parse.parseClock('0:05.5'), 5.5);
  assert.equal(parse.parseClock('12,5'), 12.5);
  assert.equal(parse.parseClock(90), 90);
  for (const bad of ['', 'abc', '1:75', '12:3:4:5', null, undefined, NaN]) assert.ok(Number.isNaN(parse.parseClock(bad)), String(bad));
});

test('extractJson: puro, cerca ```json, texto em volta, cerca aberta e resposta cortada', () => {
  const obj = { cuts: [{ start: '1:00', end: '1:30', punchline: 'oi' }] };
  assert.deepEqual(parse.extractJson(JSON.stringify(obj)).value, obj);
  assert.deepEqual(parse.extractJson('```json\n' + JSON.stringify(obj) + '\n```').value, obj);
  assert.deepEqual(parse.extractJson('Aqui está:\n```\n' + JSON.stringify(obj) + '\n```\nAbraços').value, obj);
  assert.deepEqual(parse.extractJson('Claro! ' + JSON.stringify(obj) + ' Espero ter ajudado {não é json}').value, obj);
  assert.deepEqual(parse.extractJson('```json\n' + JSON.stringify(obj)).value, obj, 'cerca que não fechou (cortada)');
  const cut = parse.extractJson('{"cuts":[{"start":"1:00","end":"1:30"},{"start":"2:00","end":"2:3');
  assert.equal(cut.salvaged, true);
  assert.equal(cut.value.cuts.length, 1);
  assert.throws(() => parse.extractJson(''), (e) => e.code === 'BAD_JSON');
  assert.throws(() => parse.extractJson('nenhum json aqui'), (e) => e.code === 'BAD_JSON');
  assert.throws(() => parse.extractJson(null), (e) => e.code === 'BAD_JSON');
});

test('parseCandidates: normaliza campos, limita textos, confere listas fechadas e conta os inválidos', () => {
  const raw = JSON.stringify({
    cuts: [
      { start: '49:00', end: '49:33', title: '  Obrigado,   jogo  ', category: 'engraçado', relevance: 95, hook: 'h', punchline: 'p', reasons: ['a', 'b', 'c', 'd'], layout: 'JOGO', flags: ['revisar_sensivel', 'outra'] },
      { start: 'x', end: '1:00' },
      'texto solto',
      { start: 100, end: 160, relevance: '0,8', reasons: 'um só' },
      { start: '0:10', end: '0:40', category: 'Inventada', layout: 'tela' }
    ]
  });
  const { items, invalid } = parse.parseCandidates(raw);
  assert.equal(items.length, 3);
  assert.equal(invalid, 2);
  assert.equal(items[0].title, 'Obrigado, jogo');
  assert.equal(items[0].category, 'Engraçado');
  assert.equal(items[0].relevance, 0.95);
  assert.deepEqual(items[0].reasons, ['a', 'b', 'c']);
  assert.equal(items[0].layout, 'jogo');
  assert.deepEqual(items[0].flags, ['revisar_sensivel']);
  assert.equal(items[1].relevance, 0.8);
  assert.deepEqual(items[1].reasons, ['um só']);
  assert.equal(items[2].layout, '');
  assert.equal(items[2].category, 'Inventada');
  assert.deepEqual(parse.parseCandidates('[{"start":"0:01","end":"0:09"}]').items.length, 1, 'lista pura');
  assert.throws(() => parse.parseCandidates('{"nada":1}'), (e) => e.code === 'BAD_JSON');
});

test('parsePicks: só ids, ignora lixo; aceita lista de ids', () => {
  const { picks } = parse.parsePicks('{"picks":[{"id":"c2","relevance":0.7,"title":"t"},{"semid":1},"c9"]}');
  assert.deepEqual(picks.map((p) => p.id), ['c2', 'c9']);
  assert.equal(picks[0].relevance, 0.7);
  assert.deepEqual(parse.parsePicks('["c1","c2"]').picks.map((p) => p.id), ['c1', 'c2']);
  assert.throws(() => parse.parsePicks('{"x":1}'), (e) => e.code === 'BAD_JSON');
});

// ---------- conferência local ----------

const PREFS = { minDurationSec: 15, maxDurationSec: 60, padBeforeSec: 2, padAfterSec: 1, minRelevance: 0.5 };
const tr = F.makeTranscript({ minutes: 30, moments: [{ at: 300, punch: 'o bicho nem dropou couro' }, { at: 900, punch: 'eu vou clipar essa parte agora mesmo' }] });
const MOMENT = tr.moments[0];
const base = (over = {}) => ({ start: MOMENT.start, end: MOMENT.end, title: 't', category: 'Engraçado', relevance: 0.9, hook: 'h', punchline: MOMENT.punch, reasons: ['r'], layout: 'conversa', flags: [], ...over });
const ctx = (over = {}) => ({ cues: tr.cues, duration: tr.duration, window: { from: 0, to: 1800 }, prefs: PREFS, existing: [], ...over });

test('findPunchline: exata, com pontuação/caixa/acento diferentes, quase exata e inexistente', () => {
  const cues = [{ start: 10, end: 14, text: 'Eu preciso de couro, velho!' }, { start: 14, end: 18, text: 'O bicho nem dropou couro.' }];
  assert.deepEqual(findPunchline('o BICHO nem dropou couro', cues), { start: 14, end: 18 });
  assert.deepEqual(findPunchline('Eu preciso de couro velho o bicho nem dropou couro', cues), { start: 10, end: 18 });
  assert.ok(findPunchline('o bicho nem dropou couro hoje', cues), 'uma palavra a mais/menos ainda vale (>= 75%)');
  assert.equal(findPunchline('ele comprou uma espada por vinte reais', cues), null);
  assert.equal(findPunchline('couro', [{ start: 0, end: 2, text: 'sem isso' }]), null);
  assert.equal(findPunchline('', cues), null);
  assert.deepEqual(findPunchline('velho', cues), { start: 10, end: 14 }, 'frase curta só vale exata');
  assert.equal(findPunchline('couro muito', cues), null, 'frase curta que não é exata não passa pelo critério aproximado');
});

test('verifyCandidate: caso bom é ajustado às falas, ganha margens e fica nas durações', () => {
  const r = verifyCandidate(base({ start: MOMENT.start + 1.2, end: MOMENT.end - 1 }), ctx());
  assert.equal(r.ok, true, JSON.stringify(r));
  const s = r.suggestion;
  assert.ok(s.start >= MOMENT.start - 2 - 0.01 && s.start <= MOMENT.start + 0.01, `início ${s.start}`);
  assert.ok(s.end <= MOMENT.end + 1 + 0.01 && s.end >= MOMENT.end - 1);
  assert.ok(s.end - s.start >= 15 && s.end - s.start <= 60);
  assert.ok(s.peak >= s.start && s.peak <= s.end);
  assert.equal(s.id, `${Math.round(s.start * 10)}_${Math.round(s.end * 10)}`);
  assert.equal(r.adjusted, true);
});

test('verifyCandidate: cada motivo de rejeição', () => {
  const why = (c, x) => { const r = verifyCandidate(c, ctx(x)); return r.ok ? 'ok' : r.reason; };
  assert.equal(why(base({ start: Number.NaN })), 'time');
  assert.equal(why(base({ start: 500, end: 400 })), 'time');
  assert.equal(why(base({ start: MOMENT.start, end: MOMENT.start + 2 })), 'time', 'curto demais');
  assert.equal(why(base({ start: 5000, end: 5040 })), 'range');
  assert.equal(why(base({ start: 1790, end: 1830 })), 'range');
  assert.equal(why(base(), { window: { from: 1000, to: 1800 } }), 'window');
  assert.equal(why(base({ start: 100, end: 400 })), 'duration', 'bem mais longo que o máximo');
  assert.equal(why(base({ punchline: '' })), 'punchline');
  assert.equal(why(base({ punchline: 'isso nunca foi dito por ninguém' })), 'punchline');
  assert.equal(why(base({ relevance: 0.3 })), 'relevance');
  assert.equal(why(base(), { existing: [{ start: MOMENT.start - 5, end: MOMENT.end + 5 }] }), 'existing');
  // sem fala no intervalo: transcrição com buraco
  const gap = { cues: tr.cues.filter((c) => c.end < 1000 || c.start > 1200), duration: tr.duration };
  assert.equal(verifyCandidate(base({ start: 1010, end: 1050, punchline: 'qualquer' }), ctx(gap)).reason, 'nospeech');
});

test('verifyCandidate: ajusta a duração mínima e a máxima sem perder o desfecho', () => {
  // intervalo curto de 6 s no desfecho: estende até a duração mínima
  const short = verifyCandidate(base({ start: MOMENT.start + 10, end: MOMENT.start + 16 }), ctx({ prefs: { ...PREFS, padBeforeSec: 0, padAfterSec: 0 } }));
  assert.equal(short.ok, true, JSON.stringify(short));
  assert.ok(short.suggestion.end - short.suggestion.start >= 15 - 0.01);
  assert.ok(short.suggestion.start <= MOMENT.start + 10 && short.suggestion.end >= MOMENT.start + 14, 'o desfecho continua dentro');
  // intervalo de 80 s com o desfecho no começo: encolhe ao máximo
  const long = verifyCandidate(base({ start: MOMENT.start, end: MOMENT.start + 80 }), ctx({ prefs: { ...PREFS, maxDurationSec: 30 } }));
  assert.equal(long.ok, true, JSON.stringify(long));
  assert.ok(long.suggestion.end - long.suggestion.start <= 30 + 0.01);
  // desfecho que só termina depois do máximo: rejeita
  const late = verifyCandidate(base({ start: MOMENT.start - 20, end: MOMENT.start + 20 }), ctx({ prefs: { ...PREFS, maxDurationSec: 15, minDurationSec: 5 } }));
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'duration');
  // nunca passa do vídeo nem fica negativo
  const edge = F.makeTranscript({ minutes: 3, moments: [{ at: 5, punch: 'o bicho nem dropou couro' }] });
  const m0 = edge.moments[0];
  const r = verifyCandidate({ ...base(), start: m0.start, end: m0.end }, { cues: edge.cues, duration: edge.duration, window: { from: 0, to: 180 }, prefs: PREFS, existing: [] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.suggestion.start >= 0 && r.suggestion.end <= edge.duration);
});

test('dedupe: o mesmo momento achado em dois blocos fica uma vez só (o de maior relevância)', () => {
  const a = { id: 'a', start: 100, end: 140, peak: 120, relevance: 0.7 };
  const b = { id: 'b', start: 105, end: 145, peak: 125, relevance: 0.9 };
  const c = { id: 'c', start: 300, end: 340, peak: 320, relevance: 0.5 };
  const { kept, dropped } = dedupe([a, b, c]);
  assert.deepEqual(kept.map((x) => x.id), ['b', 'c']);
  assert.deepEqual(dropped.map((x) => x.id), ['a']);
});

test('coveredBy: mesma regra da aba (pico dentro, 20% do trecho, 50% do menor)', () => {
  const cut = { start: 100, end: 130 };
  assert.equal(coveredBy({ start: 90, end: 140, peak: 115 }, [cut]), true);
  assert.equal(coveredBy({ start: 125, end: 200, peak: 190 }, [cut]), false, 'só 5 de 75 s');
  assert.equal(coveredBy({ start: 120, end: 160, peak: 150 }, [cut]), true, '10 de 40 s = 25% >= 20%');
  assert.equal(coveredBy({ start: 400, end: 440, peak: 420 }, [cut]), false);
});

// ---------- blocos e estimativa ----------

test('buildWindows: blocos de 35 min com 90 s de sobreposição, sem lacunas, e cada fala em algum bloco', () => {
  const t = F.makeTranscript({ minutes: 100 });
  const w = buildWindows(t.cues, t.duration, { windowSec: 35 * 60, maxInputTokens: 60000 });
  assert.equal(w.length, 3);
  assert.equal(w[0].from, 0);
  for (let i = 1; i < w.length; i += 1) assert.equal(w[i].from, w[i - 1].to - OVERLAP_SEC);
  assert.equal(w[w.length - 1].to, t.duration);
  const covered = new Set();
  for (const win of w) for (const line of win.lines) covered.add(line);
  assert.ok(t.cues.every((c) => covered.has(`${Math.floor(c.start / 60)}:${String(Math.round(c.start % 60)).padStart(2, '0')} ${c.text}`)));
  assert.ok(w.every((x, i) => x.index === i && x.total === w.length));
});

test('buildWindows: o teto de tokens encolhe os blocos; blocos sem fala não geram chamada', () => {
  const t = F.makeTranscript({ minutes: 100 });
  const big = buildWindows(t.cues, t.duration, { windowSec: 35 * 60, maxInputTokens: 60000 });
  const small = buildWindows(t.cues, t.duration, { windowSec: 35 * 60, maxInputTokens: 5000 });
  assert.ok(small.length > big.length);
  assert.ok(small.every((x) => x.tokens <= 5000 + 600), small.map((x) => x.tokens).join());
  // 20 min de fala, depois 60 min mudos: só os blocos com fala
  const gap = F.makeTranscript({ minutes: 20 });
  const w = buildWindows(gap.cues, 80 * 60, { windowSec: 35 * 60, maxInputTokens: 60000 });
  assert.equal(w.length, 1);
  assert.deepEqual(buildWindows([], 3600, {}), []);
});

test('buildWindows: o chat entra no bloco do período, com amostragem e formato; nenhuma dica de volume sai do computador', () => {
  const t = F.makeTranscript({ minutes: 40 });
  const messages = Array.from({ length: 400 }, (_, i) => ({ t: 100 + i * 4, user: `@usuario${i}`, text: `mensagem ${i} lol` }));
  const w = buildWindows(t.cues, t.duration, { windowSec: 35 * 60, maxInputTokens: 60000, chat: { messages }, hints: [30, 99999] });
  assert.ok(w[0].chatLines.length <= 150 && w[0].chatLines.length > 50);
  assert.match(w[0].chatLines[0], /^\d+:\d{2} usuario\d+: mensagem \d+ lol$/);
  // decisão do dono: a energia do áudio não é pista para a IA (o volume sozinho engana). Mesmo que alguém passe `hints`, ela é ignorada.
  assert.equal('hintLines' in w[0], false);
  assert.equal(JSON.stringify(w[0]).includes('subida de volume'), false);
  const msg = buildBlockMessage({ window: w[0], meta: {}, duration: t.duration, prefs: { minDurationSec: 15, maxDurationSec: 60, keywords: [] }, maxCandidates: 8 });
  assert.doesNotMatch(msg, /DICAS|subida de volume|volume/i, 'o pedido não traz dica de áudio');
  assert.doesNotMatch(SYSTEM_PROMPT, /dicas? de (áudio|volume)|volume/i, 'a mensagem de sistema também não fala em volume');
});

test('estimate e describeEstimate: chamadas = blocos + 1 escolha; texto "~N chamadas, ~X mil tokens"', () => {
  const t = F.makeTranscript({ minutes: 180 });
  const w = buildWindows(t.cues, t.duration, { windowSec: 35 * 60, maxInputTokens: 24000 });
  const est = estimate(w);
  assert.equal(est.calls, w.length + 1);
  assert.ok(est.totalTokens > est.inputTokens && est.inputTokens > 0);
  assert.match(describeEstimate(est), /^~\d+ chamadas, ~[\d.]+ mil tokens$/);
  assert.equal(describeEstimate({ calls: 1, totalTokens: 400 }), '~1 chamada, ~1 mil tokens');
  assert.equal(describeEstimate(estimate([])), 'nada para enviar');
});

// ---------- tentativas ----------

const stats0 = () => ({ calls: 0, retries: 0, promptTokens: 0, completionTokens: 0 });

test('callWithRetry: espera em escada, respeita Retry-After, para na primeira recusa de chave e no limite de tentativas', async () => {
  const sleeps = [];
  const sleepFn = async (ms) => { sleeps.push(ms); };
  const retry = { baseDelayMs: 1000, maxDelayMs: 4000 };
  let n = 0;
  const flaky = async () => { n += 1; if (n < 3) throw new AiError('SERVER', 'x'); return { text: '{"cuts":[]}', usage: {} }; };
  const ok = await callWithRetry({ chat: flaky, system: 's', userContent: 'u', maxTokens: 10, parse: parse.parseCandidates, sleepFn, attempts: 3, retry, stats: stats0() });
  assert.deepEqual(ok.parsed.items, []);
  assert.deepEqual(sleeps, [1000, 2000]);

  sleeps.length = 0;
  let calls = 0;
  const rate = async () => { calls += 1; throw Object.assign(new AiError('RATE_LIMIT', 'limite'), { status: 429, retryAfterSec: 12 }); };
  await assert.rejects(() => callWithRetry({ chat: rate, system: 's', userContent: 'u', maxTokens: 10, parse: parse.parseCandidates, sleepFn, attempts: 3, retry, stats: stats0() }), (e) => e.code === 'RATE_LIMIT' && e.details.attempts === 3);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [12000, 12000]);

  sleeps.length = 0;
  calls = 0;
  const auth = async () => { calls += 1; throw Object.assign(new AiError('AUTH', 'recusada'), { status: 401 }); };
  await assert.rejects(() => callWithRetry({ chat: auth, system: 's', userContent: 'u', maxTokens: 10, parse: parse.parseCandidates, sleepFn, attempts: 5, retry, stats: stats0() }), (e) => e.code === 'AUTH');
  assert.equal(calls, 1);
  assert.equal(sleeps.length, 0);

  // erro no estilo do hospedeiro (BDS): só status
  calls = 0;
  const host = async () => { calls += 1; throw Object.assign(new Error('Servidor (503)'), { status: 503 }); };
  await assert.rejects(() => callWithRetry({ chat: host, system: 's', userContent: 'u', maxTokens: 10, parse: parse.parseCandidates, sleepFn, attempts: 2, retry, stats: stats0() }));
  assert.equal(calls, 2);
});

test('classify e mensagens de falha: nunca vazam, sempre oferecem o algoritmo', () => {
  assert.equal(classify(new AiError('AUTH', 'x')).retry, false);
  assert.equal(classify({ status: 429 }).kind, 'rate');
  assert.equal(classify({ status: 500 }).retry, true);
  assert.equal(classify({ status: 400 }).retry, false);
  assert.equal(classify({ code: 'CANCELLED' }).kind, 'cancelled');
  assert.equal(classify(null).retry, false);
  for (const code of ['AUTH', 'MODEL', 'QUOTA', 'RATE_LIMIT', 'NETWORK', 'TIMEOUT', 'SERVER', 'BAD_JSON', 'OTHER']) {
    assert.match(failureMessage({ code, message: 'm' }), /algoritmo/i, code);
  }
});

test('callWithRetry: resposta cortada pelo limite de saída (modelos que pensam) pede mais espaço na tentativa seguinte', async () => {
  const limits = [];
  const sleeps = [];
  const chat = async ({ maxTokens }) => {
    limits.push(maxTokens);
    return limits.length < 3 ? { text: '', usage: {}, finishReason: 'length' } : { text: '{"cuts":[]}', usage: {}, finishReason: 'stop' };
  };
  const r = await callWithRetry({ chat, system: 's', userContent: 'u', maxTokens: 6000, parse: parse.parseCandidates, sleepFn: async (ms) => { sleeps.push(ms); }, attempts: 3, retry: { baseDelayMs: 10, maxDelayMs: 10 }, stats: stats0() });
  assert.deepEqual(r.parsed.items, []);
  assert.deepEqual(limits, [6000, 9600, 15360], 'cada tentativa pede 60% mais, até o teto de 16000');
  assert.equal(sleeps.length, 2);
  // um JSON ruim que NÃO foi cortado não aumenta o limite
  const seen = [];
  const bad = async ({ maxTokens }) => { seen.push(maxTokens); return { text: 'lixo', usage: {}, finishReason: 'stop' }; };
  await assert.rejects(() => callWithRetry({ chat: bad, system: 's', userContent: 'u', maxTokens: 6000, parse: parse.parseCandidates, sleepFn: async () => {}, attempts: 2, stats: stats0() }), (e) => e.code === 'BAD_JSON');
  assert.deepEqual(seen, [6000, 6000]);
});

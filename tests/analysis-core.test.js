'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmp, rmrf, makeChat, rng } = require('./analysis-fixtures');
const stats = require('../src/core/analysis/stats');
const params = require('../src/core/analysis/params');
const { combine } = require('../src/core/analysis/combine');
const { loadChat, scoreChat, chatFingerprint } = require('../src/core/analysis/chatSignal');
const { AnalysisCache, sourceKey } = require('../src/core/analysis/cache');

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// ---------- estatística ----------

test('mediana e MAD ignoram valores extremos; z robusto não é enganado pelo próprio pico', () => {
  const values = [10, 11, 9, 10, 12, 10, 11, 9, 10, 500];
  const med = stats.median(values);
  approx(med, 10);
  const spread = stats.mad(values, med);
  assert.ok(spread <= 1, `MAD ${spread}`);
  const zRobust = (500 - med) / Math.max(0.5, stats.MAD_TO_SIGMA * spread);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  const zClassic = (500 - mean) / sd;
  assert.ok(zRobust > 100, `z robusto ${zRobust}`);
  assert.ok(zClassic < 3.1, `z clássico ${zClassic}: o pico infla o próprio desvio-padrão`);
  assert.equal(stats.median([]), 0);
  assert.equal(stats.median([1, 3]), 2);
});

test('trimmedMean descarta só as maiores; slidingMax dilata; prefixSums soma janelas', () => {
  approx(stats.trimmedMean([1, 1, 1, 1, 1, 1, 1, 1, 1, 1000], 0.1), 1);
  assert.ok(stats.trimmedMean([1, 2, 3], 0) > 1.9);
  assert.deepEqual([...stats.slidingMax([0, 0, 1, 0, 0], 1)], [0, 1, 1, 1, 0]);
  assert.deepEqual([...stats.slidingMax([3, 0, 0, 0, 0, 2], 0)], [3, 0, 0, 0, 0, 2]);
  assert.deepEqual([...stats.slidingMax([1, 5, 2, 2, 2, 9, 1], 2)], [5, 5, 5, 9, 9, 9, 9]);
  const p = stats.prefixSums([1, 2, 3, 4]);
  assert.equal(p[4] - p[1], 9);
});

test('localBaseline: bloco único para série curta e interpolação entre blocos para série longa', () => {
  const med = (b) => ({ center: stats.median(b), scale: 1 });
  const short = stats.localBaseline(new Float64Array(100).fill(5), 100, med);
  assert.ok([...short.center].every((v) => v === 5));
  // metade baixa, metade alta: a linha de base acompanha sem degrau
  const values = new Float64Array(400);
  values.fill(0, 0, 200);
  values.fill(100, 200);
  const b = stats.localBaseline(values, 100, med);
  assert.ok(b.center[10] < 5 && b.center[390] > 95);
  for (let i = 1; i < 400; i += 1) assert.ok(Math.abs(b.center[i] - b.center[i - 1]) <= 100 / 100 + 1e-9, `degrau em ${i}`);
});

// ---------- parâmetros ----------

test('normalizeParams: padrões, limites, tipos errados e palavras-chave', () => {
  const d = params.normalizeParams(undefined);
  assert.equal(d.sensitivity, 3);
  assert.deepEqual(d.signals, { audio: true, image: true, chat: true, text: true, calm: true });
  assert.deepEqual(d.weights, { audio: 0.8, image: 0.6, chat: 1, text: 1, calm: 0.7 });
  assert.deepEqual(d.textWeights, { laugh: 1, exclaim: 1, pace: 1, repeat: 1, meta: 1, humor: 1, structure: 1 });
  assert.equal(d.profile, 'gameplay', 'sem escolha: o perfil de sempre');
  assert.deepEqual(d.humor, { phrases: [], reactions: [] }, 'sem perfil do canal: nenhuma expressão');
  assert.deepEqual(d.spread, { windowSec: 600, perWindow: null, minGapSec: 5 });
  assert.deepEqual(d.chat.keywords, [...params.DEFAULT_KEYWORDS]);
  assert.equal(d.minRelevance, 0.5);

  const p = params.normalizeParams({
    sensitivity: 99, perHour: -4, minDurationSec: '20', maxDurationSec: 5, padBeforeSec: 'abc', minRelevance: 7,
    weights: { audio: 5, image: -1, chat: 'x', text: 9 }, textWeights: { laugh: 0, pace: 'x', meta: 7 },
    spread: { windowSec: 5, perWindow: 0, minGapSec: 9999 }, signals: { audio: 'sim', chat: false, text: false },
    chat: { keywords: ['  CLIP ', 'Pôg', 'pog', '', 3, 'a'.repeat(60)], lagSec: 1000 }, image: { fast: 'true' }
  });
  assert.equal(p.sensitivity, 5);
  assert.equal(p.perHour, 1);
  assert.equal(p.minDurationSec, 20);
  assert.equal(p.maxDurationSec, 20, 'máximo nunca fica abaixo do mínimo');
  assert.equal(p.padBeforeSec, 3, 'texto inválido volta ao padrão');
  assert.equal(p.minRelevance, 1);
  assert.deepEqual(p.weights, { audio: 2, image: 0, chat: 1, text: 2, calm: 0.7 });
  assert.deepEqual(p.textWeights, { laugh: 0, exclaim: 1, pace: 1, repeat: 1, meta: 2, humor: 1, structure: 1 }, 'cada pista limitada a 0..2; texto inválido volta ao padrão');
  assert.equal(params.normalizeParams({ profile: 'conversa' }).profile, 'conversa');
  assert.equal(params.normalizeParams({ profile: 'podcast' }).profile, 'gameplay', 'perfil desconhecido volta ao padrão');
  assert.deepEqual(p.spread, { windowSec: 120, perWindow: 1, minGapSec: 300 }, 'a distribuição também é validada');
  assert.deepEqual(p.signals, { audio: true, image: true, chat: false, text: false, calm: true });
  assert.deepEqual(p.chat.keywords, ['clip', 'pog'], 'sem acento, sem repetidas, sem vazias, sem não-texto, sem gigantes');
  assert.equal(p.chat.lagSec, 60);
  assert.equal(p.image.fast, false);
  assert.deepEqual(params.normalizeParams({ chat: { keywords: 'clip, POG;omg\nwtf' } }).chat.keywords, ['clip', 'pog', 'omg', 'wtf']);
  assert.deepEqual(params.normalizeParams({ chat: { keywords: [] } }).chat.keywords, [], 'lista vazia é respeitada (sem critério)');
});

test('limiares ficam mais baixos quando a sensibilidade sobe; limite de sugestões por hora', () => {
  let prev = null;
  for (const s of [1, 2, 3, 4, 5]) {
    const t = params.thresholds(s);
    if (prev) {
      assert.ok(t.audioZ0 < prev.audioZ0 && t.chatRatio0 < prev.chatRatio0 && t.sceneScore0 < prev.sceneScore0 && t.motionZ0 < prev.motionZ0, `sens ${s}`);
    }
    prev = t;
  }
  approx(params.thresholds(2.5).audioZ0, (params.thresholds(2).audioZ0 + params.thresholds(3).audioZ0) / 2);
  const p = params.normalizeParams({ perHour: 6 });
  assert.equal(params.suggestionLimit(p, 3600), 6);
  assert.equal(params.suggestionLimit(p, 4 * 3600), 24);
  assert.equal(params.suggestionLimit(p, 60), 3, 'mínimo de 3');
  assert.equal(params.suggestionLimit(params.normalizeParams({ maxSuggestions: 2 }), 7200), 2);
  assert.equal(params.canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), params.canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
});

// ---------- combinação ----------

/** Sinal falso (só números) para testar a combinação isoladamente. */
function fake(id, n, spec) {
  const score = new Float64Array(n);
  for (const [from, to, v] of spec) for (let k = from; k <= to; k += 1) score[k] = v;
  return { id, score, describe: () => [{ text: `motivo ${id}`, strength: 1 }] };
}
// pesos 1 em todos os sinais: estes testes são da MECÂNICA da combinação (a relevância é o ou-ruidoso dos sinais), não dos pesos padrão
const P = (over = {}) => params.normalizeParams({ minDurationSec: 5, maxDurationSec: 60, padBeforeSec: 3, padAfterSec: 2, minRelevance: 0.5, alignToleranceSec: 0, maxSuggestions: 50, weights: { audio: 1, image: 1, chat: 1, text: 1 }, spread: { minGapSec: 0 }, ...over });

test('combine: um pico vira um trecho com as margens de antes e depois', () => {
  const out = combine({ n: 300, duration: 300, signals: [fake('audio', 300, [[100, 102, 1]])], params: P() });
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].start, out[0].end], [97, 105]);
  assert.equal(out[0].relevance, 1);
  assert.deepEqual(out[0].reasons, ['motivo audio']);
  assert.ok(out[0].peak >= 100 && out[0].peak <= 103);
});

test('combine: duração mínima estende para os dois lados; máxima recorta em volta do pico', () => {
  const short = combine({ n: 300, duration: 300, signals: [fake('audio', 300, [[100, 100, 1]])], params: P({ minDurationSec: 20 }) });
  assert.equal(short[0].end - short[0].start, 20);
  assert.ok(short[0].start < 100 && short[0].end > 101);
  // platô de 100 s: nenhum trecho passa de 30 s e nenhum se sobrepõe
  const plateau = combine({ n: 300, duration: 300, signals: [fake('audio', 300, [[100, 199, 0.8]])], params: P({ maxDurationSec: 30, minDurationSec: 10 }) });
  assert.ok(plateau.length >= 3);
  for (const s of plateau) assert.ok(s.end - s.start <= 30 + 1e-9, `${s.start}-${s.end}`);
  assertDisjoint(plateau);
});

function assertDisjoint(list) {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i].start >= sorted[i - 1].end - 1e-9, `sobreposição: ${JSON.stringify(sorted[i - 1])} x ${JSON.stringify(sorted[i])}`);
}

test('combine: picos próximos viram um trecho só; picos distantes viram dois; ordem por relevância', () => {
  const near = combine({ n: 300, duration: 300, signals: [fake('audio', 300, [[100, 101, 1], [104, 105, 0.9]])], params: P() });
  assert.equal(near.length, 1, 'eventos a poucos segundos fazem parte do mesmo momento');
  const far = combine({ n: 400, duration: 400, signals: [fake('audio', 400, [[50, 52, 0.7], [250, 252, 0.95]])], params: P() });
  assert.equal(far.length, 2);
  assert.ok(far[0].relevance > far[1].relevance && far[0].start > 200, 'a mais relevante vem primeiro');
});

test('combine: relevância mínima, teto de quantidade e pesos', () => {
  const sig = [fake('audio', 500, [[50, 51, 0.4], [150, 151, 0.8], [250, 251, 0.9], [350, 351, 0.7]])];
  assert.equal(combine({ n: 500, duration: 500, signals: sig, params: P({ minRelevance: 0.5 }) }).length, 3, '0,4 fica de fora');
  assert.equal(combine({ n: 500, duration: 500, signals: sig, params: P({ minRelevance: 0.3 }) }).length, 4);
  const capped = combine({ n: 500, duration: 500, signals: sig, params: P({ maxSuggestions: 2 }) });
  assert.deepEqual(capped.map((s) => s.relevance), [0.9, 0.8], 'o teto corta os menos relevantes');
  const off = combine({ n: 500, duration: 500, signals: sig, params: P({ weights: { audio: 0, image: 1, chat: 1, text: 1 } }) });
  assert.equal(off.length, 0, 'peso 0 desliga o sinal');
  const half = combine({ n: 500, duration: 500, signals: sig, params: P({ weights: { audio: 0.5, image: 1, chat: 1, text: 1 }, minRelevance: 0.4 }) });
  assert.deepEqual(half.map((s) => s.relevance), [0.45, 0.4], 'peso 0,5 reduz a evidência');
});

test('combine: sinais que concordam somam evidência (ou ruidoso) e os motivos aparecem', () => {
  const a = fake('audio', 300, [[100, 102, 0.5]]);
  const c = fake('chat', 300, [[100, 102, 0.5]]);
  const alone = combine({ n: 300, duration: 300, signals: [a], params: P({ minRelevance: 0.3 }) });
  const both = combine({ n: 300, duration: 300, signals: [a, c], params: P({ minRelevance: 0.3 }) });
  approx(alone[0].relevance, 0.5);
  approx(both[0].relevance, 0.75, 1e-3);
  assert.deepEqual([...both[0].reasons].sort(), ['motivo audio', 'motivo chat']);
  assert.equal(combine({ n: 300, duration: 300, signals: [a], params: P({ minRelevance: 0.6 }) }).length, 0);
});

test('combine: tolerância de tempo faz sinais ligeiramente defasados concordarem', () => {
  const a = fake('audio', 300, [[100, 100, 0.5]]);
  const c = fake('chat', 300, [[102, 102, 0.5]]);
  const strict = combine({ n: 300, duration: 300, signals: [a, c], params: P({ alignToleranceSec: 0, minRelevance: 0.7 }) });
  const tolerant = combine({ n: 300, duration: 300, signals: [a, c], params: P({ alignToleranceSec: 2, minRelevance: 0.7 }) });
  assert.equal(strict.length, 0);
  assert.equal(tolerant.length, 1);
});

test('combine: a "sombra" da dilatação de um evento já usado não vira falso evento (sem motivo, relevância máxima)', () => {
  const sig = [fake('chat', 120, [[36, 54, 1]])];
  const out = combine({ n: 120, duration: 120, signals: sig, params: P({ alignToleranceSec: 2, padBeforeSec: 2, padAfterSec: 1, minDurationSec: 10, maxDurationSec: 30, maxSuggestions: 5 }) });
  assert.equal(out.length, 1, JSON.stringify(out.map((s) => [s.start, s.end, s.reasons])));
  assert.ok(out[0].reasons.length > 0);
  // evento longo repartido em vários trechos: todos têm evidência própria
  const long = combine({ n: 300, duration: 300, signals: [fake('audio', 300, [[100, 140, 1]])], params: P({ alignToleranceSec: 2, minDurationSec: 5, maxDurationSec: 12, maxSuggestions: 20 }) });
  assert.ok(long.length >= 3);
  for (const s of long) assert.ok(s.reasons.length > 0 && s.signals.audio > 0, JSON.stringify(s));
  assertDisjoint(long);
});

test('combine: limites do vídeo, vídeo curto e sem sinais', () => {
  const edge = combine({ n: 60, duration: 60, signals: [fake('audio', 60, [[0, 0, 1], [59, 59, 1]])], params: P({ minDurationSec: 10 }) });
  assert.equal(edge.length, 2);
  for (const s of edge) assert.ok(s.start >= 0 && s.end <= 60 && s.end - s.start >= 10 - 1e-9, `${s.start}-${s.end}`);
  assert.deepEqual(combine({ n: 8, duration: 8, signals: [fake('audio', 8, [[3, 3, 1]])], params: P({ minDurationSec: 15 }) }), [], 'vídeo mais curto que a duração mínima não gera trecho');
  assert.deepEqual(combine({ n: 100, duration: 100, signals: [], params: P() }), []);
  assert.deepEqual(combine({ n: 0, duration: 0, signals: [fake('audio', 0, [])], params: P() }), []);
});

test('combine (propriedades): trechos sempre disjuntos, dentro do vídeo, com duração válida e ordenados', () => {
  const rand = rng(99);
  for (let round = 0; round < 40; round += 1) {
    const n = 200 + Math.floor(rand() * 600);
    const spec = [];
    for (let i = 0; i < 25; i += 1) {
      const from = Math.floor(rand() * n);
      spec.push([from, Math.min(n - 1, from + Math.floor(rand() * 8)), 0.2 + rand() * 0.8]);
    }
    const minDur = 5 + Math.floor(rand() * 20);
    const maxDur = minDur + Math.floor(rand() * 40);
    const out = combine({
      n, duration: n,
      signals: [fake('audio', n, spec), fake('chat', n, spec.map(([a, b, v]) => [Math.min(n - 1, a + 2), Math.min(n - 1, b + 2), v * 0.8]))],
      params: P({ minDurationSec: minDur, maxDurationSec: maxDur, minRelevance: 0.3, maxSuggestions: 100, alignToleranceSec: 2 })
    });
    assertDisjoint(out);
    for (let i = 0; i < out.length; i += 1) {
      const s = out[i];
      assert.ok(s.start >= 0 && s.end <= n + 1e-9, `fora do vídeo: ${s.start}-${s.end} de ${n}`);
      assert.ok(s.end - s.start <= maxDur + 1e-9, `acima do máximo: ${s.end - s.start} > ${maxDur}`);
      assert.ok(s.end - s.start >= minDur - 1e-9 || n < minDur, `abaixo do mínimo: ${s.end - s.start} < ${minDur}`);
      assert.ok(s.relevance >= 0.3 && s.relevance <= 1);
      if (i) assert.ok(out[i - 1].relevance >= s.relevance, 'ordem por relevância');
    }
  }
});

test('combine: duração fracionária (vídeo de 40,46 s): o fim nunca passa da duração e o pico fica dentro do vídeo', () => {
  // 41 segundos de grade (ceil), mas o vídeo acaba em 40,46: o arredondamento para 0,1 s antes levava o fim a 40,5
  const out = combine({ n: 41, duration: 40.46, signals: [fake('audio', 41, [[36, 40, 1]])], params: P({ minDurationSec: 5 }) });
  assert.equal(out.length, 1);
  assert.ok(out[0].end <= 40.46, `fim ${out[0].end} depois do fim do vídeo (40,46)`);
  assert.equal(out[0].end, 40.4, 'o teto é a duração truncada a 0,1 s');
  assert.ok(out[0].peak <= 40.46, `pico ${out[0].peak}`);
  // pico na última fração de segundo (grade 40..41, vídeo até 40,46)
  const tail = combine({ n: 41, duration: 40.46, signals: [fake('audio', 41, [[40, 40, 1]])], params: P({ minDurationSec: 5 }) });
  assert.equal(tail.length, 1);
  assert.ok(tail[0].end <= 40.46 && tail[0].peak <= 40.46, JSON.stringify(tail[0]));
});

test('combine (propriedades): com duração fracionária nenhum trecho termina depois do fim do vídeo', () => {
  const rand = rng(2024);
  for (let round = 0; round < 40; round += 1) {
    const duration = 50 + rand() * 400;
    const n = Math.ceil(duration);
    const spec = [];
    for (let i = 0; i < 12; i += 1) {
      const from = Math.floor(rand() * n);
      spec.push([from, Math.min(n - 1, from + Math.floor(rand() * 6)), 0.5 + rand() * 0.5]);
    }
    spec.push([n - 3, n - 1, 1]); // sempre há evento no fim do vídeo
    const out = combine({ n, duration, signals: [fake('audio', n, spec)], params: P({ minDurationSec: 5, maxDurationSec: 40, minRelevance: 0.3, maxSuggestions: 100 }) });
    assert.ok(out.length > 0);
    for (const s of out) {
      assert.ok(s.start >= 0 && s.end <= duration, `fim ${s.end} passa da duração ${duration}`);
      assert.ok(s.peak <= duration, `pico ${s.peak} passa da duração ${duration}`);
    }
    assertDisjoint(out);
  }
});

// ---------- chat ----------

function chatOf(messages) { return { platform: 'twitch', messages }; }

test('scoreChat: rajada de mensagens vira pico no instante certo, deslocado pelo atraso do chat', () => {
  const tmp = mkTmp('chat');
  try {
    const file = path.join(tmp, 'chat.json');
    makeChat(file, { duration: 300, baseRate: 0.3, bursts: [{ at: 100, dur: 8, rate: 6 }] });
    const chat = JSON.parse(fs.readFileSync(file, 'utf8'));
    const p = params.normalizeParams({ chat: { lagSec: 0, windowSec: 10, keywords: [] } });
    const th = params.thresholds(3);
    const s = scoreChat(chatOf(chat.messages), { n: 300, th, params: p });
    const above = (series, thr) => [...series].map((v, k) => (v >= thr ? k : -1)).filter((k) => k >= 0);
    const region = above(s.score, 0.5);
    assert.ok(region.length > 0 && region[0] >= 90 && region[region.length - 1] <= 118, `região ${region[0]}..${region[region.length - 1]}`);
    assert.ok(region.includes(104), 'o centro da rajada (100-108) está dentro da região');
    assert.equal(s.score[20], 0, 'chat normal não pontua');
    assert.ok(s.describe(95, 112).some((r) => /^chat \d+(,\d)?× a média$/.test(r.text)), JSON.stringify(s.describe(95, 112)));

    // com atraso de 6 s, o "lance" fica 6 s ANTES da reação do chat
    const lagged = scoreChat(chatOf(chat.messages), { n: 300, th, params: params.normalizeParams({ chat: { lagSec: 6, windowSec: 10, keywords: [] } }) });
    const regionLag = above(lagged.score, 0.5);
    assert.equal(region[0] - regionLag[0], 6, 'a região anda exatamente o atraso para trás');
  } finally { rmrf(tmp); }
});

test('scoreChat: chat quase parado não explode com poucas mensagens (mínimo de mensagens)', () => {
  const msgs = [{ t: 100, text: 'oi' }, { t: 101, text: 'oi' }, { t: 102, text: 'oi' }];
  const p = params.normalizeParams({ chat: { lagSec: 0, windowSec: 10, minMessages: 6, keywords: [] } });
  const s = scoreChat(chatOf(msgs), { n: 300, th: params.thresholds(5), params: p });
  assert.ok([...s.score].every((v) => v === 0));
});

test('scoreChat: palavras-chave (sem acento, início de palavra) pontuam sem precisar de aceleração do chat', () => {
  const msgs = [];
  for (let t = 0; t < 300; t += 5) msgs.push({ t, text: 'conversa normal' });
  msgs.push({ t: 150, text: 'CLIPA isso' }, { t: 151, text: 'pogchamp' }, { t: 152, text: 'olha o clip!' }, { t: 153, text: 'poggers' }, { t: 154, text: 'cliparam' });
  // minMessages alto: isola o critério de palavras-chave do da velocidade do chat
  const p = params.normalizeParams({ chat: { lagSec: 0, windowSec: 10, minMessages: 100, keywords: ['clip', 'pog'] } });
  const s = scoreChat(chatOf(msgs), { n: 300, th: params.thresholds(3), params: p });
  assert.equal(s.stats.keywordMessages, 5);
  let best = 0;
  for (let k = 0; k < 300; k += 1) if (s.score[k] > s.score[best]) best = k;
  assert.ok(best >= 146 && best <= 154, `pico em ${best}`);
  assert.ok(s.score[best] > 0.4);
  const reasons = s.describe(145, 156).map((r) => r.text);
  assert.ok(reasons.some((r) => r.startsWith('palavras-chave no chat: ') && r.includes('clip') && r.includes('pog')), reasons.join('|'));
  // sem lista de palavras o critério não existe
  const none = scoreChat(chatOf(msgs), { n: 300, th: params.thresholds(3), params: params.normalizeParams({ chat: { lagSec: 0, minMessages: 100, keywords: [] } }) });
  assert.equal(none.stats.keywordMessages, 0);
  assert.ok([...none.score].every((v) => v === 0));
  // "acento": palavra-chave com acento casa texto sem acento e vice-versa
  const acc = scoreChat(chatOf([{ t: 10, text: 'Lendário' }, { t: 11, text: 'LENDARIO' }, { t: 12, text: 'lendário!' }]),
    { n: 60, th: params.thresholds(3), params: params.normalizeParams({ chat: { lagSec: 0, keywords: ['lendário'] } }) });
  assert.equal(acc.stats.keywordMessages, 3);
});

test('scoreChat ignora mensagens fora do vídeo e a linha de base é local', () => {
  const msgs = [{ t: -5, text: 'x' }, { t: 9999, text: 'x' }];
  const s = scoreChat(chatOf(msgs), { n: 100, th: params.thresholds(3), params: params.normalizeParams({ chat: { keywords: [] } }) });
  assert.ok([...s.score].every((v) => v === 0));
});

test('loadChat: lê bf-chat-1 e recusa arquivo ausente, JSON quebrado e formato desconhecido (sem lançar o que não é erro de chat)', async () => {
  const tmp = mkTmp('chat-load');
  try {
    const ok = path.join(tmp, 'ok.json');
    fs.writeFileSync(ok, JSON.stringify({ format: 'bf-chat-1', platform: 'twitch', videoId: 'v', messages: [{ t: 1, user: 'a', text: 'oi' }, { t: '2.5', user: 'b', text: 'ola' }, { t: 'x', text: 'ruim' }, { t: -1, text: 'neg' }, null, { t: 3 }] }));
    const chat = await loadChat(ok);
    assert.deepEqual(chat.messages.map((m) => m.t), [1, 2.5, 3]);
    assert.equal(chat.platform, 'twitch');

    await assert.rejects(loadChat(path.join(tmp, 'nao-existe.json')), (e) => e.code === 'CHAT_UNREADABLE' && /não encontrado/.test(e.message));
    const broken = path.join(tmp, 'quebrado.json');
    fs.writeFileSync(broken, '{ nao é json');
    await assert.rejects(loadChat(broken), (e) => e.code === 'CHAT_UNREADABLE' && /JSON inválido/.test(e.message));
    const other = path.join(tmp, 'outro.json');
    fs.writeFileSync(other, JSON.stringify({ format: 'outro-9', messages: [] }));
    await assert.rejects(loadChat(other), (e) => /não reconhecido/.test(e.message));
    const noMessages = path.join(tmp, 'sem.json');
    fs.writeFileSync(noMessages, JSON.stringify({ format: 'bf-chat-1' }));
    await assert.rejects(loadChat(noMessages), (e) => /bf-chat-1/.test(e.message));
    await assert.rejects(loadChat(''), (e) => e.code === 'CHAT_UNREADABLE');
    assert.notEqual(chatFingerprint(ok), chatFingerprint(other));
  } finally { rmrf(tmp); }
});

test('loadChat usa o leitor oficial (sources/chatFormat.readChat) quando ele existir, e cai para o JSON direto se ele falhar', async () => {
  const Module = require('node:module');
  const tmp = mkTmp('chat-official');
  const original = Module._load;
  const file = path.join(tmp, 'chat.json');
  fs.writeFileSync(file, JSON.stringify({ format: 'bf-chat-1', platform: 'twitch', messages: [{ t: 5, text: 'do arquivo' }] }));
  const calls = [];
  let mode = 'ok';
  const official = {
    readChat: async (p) => {
      calls.push(p);
      if (mode === 'throw') throw new Error('leitor oficial quebrou');
      return { format: 'bf-chat-1', platform: 'youtube', messages: [{ t: 1, user: 'a', text: 'do leitor oficial' }, { t: 2, user: 'b', text: 'outra' }] };
    }
  };
  Module._load = function patched(request, parent, ...rest) {
    if (request === '../sources/chatFormat' && parent && /chatSignal\.js$/.test(parent.filename)) return official;
    return original.call(this, request, parent, ...rest);
  };
  try {
    const viaOfficial = await loadChat(file);
    assert.deepEqual(calls, [file]);
    assert.deepEqual(viaOfficial.messages.map((m) => m.text), ['do leitor oficial', 'outra']);
    assert.equal(viaOfficial.platform, 'youtube');
    mode = 'throw';
    const fallback = await loadChat(file);
    assert.deepEqual(fallback.messages.map((m) => m.text), ['do arquivo'], 'leitura direta defensiva quando o oficial falha');
  } finally {
    Module._load = original;
    rmrf(tmp);
  }
});

// ---------- cache ----------

test('sourceKey: mesmo conteúdo = mesma chave (mesmo copiado/renomeado); conteúdo ou tamanho diferente = outra', () => {
  const tmp = mkTmp('cache-key');
  try {
    const big = Buffer.alloc(2 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 31 + (i >> 8)) & 0xff;
    const a = path.join(tmp, 'a.bin');
    const b = path.join(tmp, 'copia com outro nome.bin');
    fs.writeFileSync(a, big);
    fs.writeFileSync(b, big);
    assert.equal(sourceKey(a), sourceKey(b));
    const other = Buffer.from(big);
    other[1024 * 1024] ^= 0xff; // meio do arquivo
    fs.writeFileSync(path.join(tmp, 'c.bin'), other);
    assert.notEqual(sourceKey(a), sourceKey(path.join(tmp, 'c.bin')));
    fs.writeFileSync(path.join(tmp, 'd.bin'), Buffer.concat([big, Buffer.from([1])]));
    assert.notEqual(sourceKey(a), sourceKey(path.join(tmp, 'd.bin')), 'gravação ainda crescendo muda a chave');
    fs.writeFileSync(path.join(tmp, 'pequeno.bin'), 'oi');
    assert.match(sourceKey(path.join(tmp, 'pequeno.bin')), /^[a-f0-9]{32}$/);
    assert.throws(() => sourceKey(path.join(tmp, 'nao-existe')));
  } finally { rmrf(tmp); }
});

test('AnalysisCache: grava e lê, ignora arquivo corrompido ou de outra versão e limita a quantidade', () => {
  const tmp = mkTmp('cache');
  try {
    const cache = new AnalysisCache(path.join(tmp, 'analysis'), { maxFiles: 100 });
    assert.equal(cache.get('res', 'abc123'), null);
    cache.set('res', 'abc123', { x: 1, lista: [1, 2] });
    assert.deepEqual(cache.get('res', 'abc123'), { x: 1, lista: [1, 2] });
    assert.ok(!fs.readdirSync(path.join(tmp, 'analysis')).some((f) => f.endsWith('.tmp')), 'gravação atômica não deixa .tmp');

    fs.writeFileSync(path.join(tmp, 'analysis', 'res-dead.json'), '{ corrompido');
    assert.equal(cache.get('res', 'dead'), null);
    fs.writeFileSync(path.join(tmp, 'analysis', 'res-beef.json'), JSON.stringify({ v: 9999, data: { velho: true } }));
    assert.equal(cache.get('res', 'beef'), null, 'versão do algoritmo diferente invalida');

    assert.throws(() => cache.get('../fora', 'abc'), /inválida/);
    assert.throws(() => cache.get('res', '../../x'), /inválida/);

    // mais que maxFiles: sobram os mais recentes
    for (const [i, key] of ['a1', 'a2', 'a3', 'a4', 'a5'].entries()) {
      cache.set('sig-audio', key, { i });
      const stamp = new Date(Date.now() + i * 1000);
      fs.utimesSync(path.join(tmp, 'analysis', `sig-audio-${key}.json`), stamp, stamp);
    }
    cache.maxFiles = 3;
    cache.prune();
    const left = fs.readdirSync(path.join(tmp, 'analysis')).filter((f) => /^(sig|res)-/.test(f));
    assert.ok(left.length <= 3, left.join(','));
    assert.ok(left.includes('sig-audio-a5.json') && !left.includes('sig-audio-a1.json'));
  } finally { rmrf(tmp); }
});

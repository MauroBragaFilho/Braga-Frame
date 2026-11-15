'use strict';

/**
 * Recalibragem do algoritmo de reserva (ALGO_VERSION 4, docs/recursos/analise-ia.md seção 13). Cada teste prova um COMPORTAMENTO que a linha de
 * base não tinha (na live real todas as sugestões ficavam na abertura, com relevância 100% e motivos como "pico de áudio 37σ"):
 *   - de silêncio para fala (porta de ruído do microfone) NÃO vira pico; o volume é medido contra o nível normal de FALA do trecho;
 *   - a pontuação é logística: nunca chega a 1,0 e valores enormes não empatam com valores só acima do limiar;
 *   - o empate se resolve pela pontuação, não pela ordem do tempo, e as sugestões se distribuem por toda a duração;
 *   - com transcrição, o corte começa e termina em limites de falas.
 * Funções puras sobre séries sintéticas (nada de mock do que está sendo testado). A mídia de verdade (ffmpeg) está em analysis-media.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const params = require('../src/core/analysis/params');
const stats = require('../src/core/analysis/stats');
const { scoreAudio, noiseFloor } = require('../src/core/analysis/audioSignal');
const { combine } = require('../src/core/analysis/combine');
const { rng } = require('./analysis-fixtures');

const TH = params.thresholds(3);
const maxIn = (series, from, to) => { let m = 0; for (let k = Math.max(0, Math.floor(from)); k <= Math.min(series.length - 1, Math.ceil(to)); k += 1) if (series[k] > m) m = series[k]; return m; };

/**
 * Áudio com porta de ruído: `onSec` de fala a `speakDb` (com variação) e `offSec` de silêncio digital (-100 dB), em quadros de 0,5 s.
 * `silentUntil`: segundos de silêncio no começo. `shouts`: [{ at, dur, db }] trechos de grito (substituem a fala).
 */
function gatedDb({ seconds, speakDb = -38, jitter = 4, onSec = 3, offSec = 3, silentUntil = 0, shouts = [], seed = 5 }) {
  const rand = rng(seed);
  const db = [];
  for (let i = 0; i < seconds * 2; i += 1) {
    const t = i / 2;
    const shout = shouts.find((s) => t >= s.at && t < s.at + s.dur);
    if (shout) { db.push(shout.db + (rand() - 0.5) * 2); continue; }
    const on = t >= silentUntil && (t % (onSec + offSec)) < onSec;
    db.push(on ? speakDb + (rand() - 0.5) * 2 * jitter : -100);
  }
  return { windowSec: 0.5, db };
}

// ---------- pontuação logística ----------

test('softRamp: zero até o limiar, ~metade no meio da rampa, nunca 1,0 e crescente (valores enormes não empatam)', () => {
  assert.equal(stats.softRamp(0, 2.6, 3), 0);
  assert.equal(stats.softRamp(2.6, 2.6, 3), 0, 'no limiar ainda é zero');
  assert.equal(stats.softRamp(-5, 2.6, 3), 0);
  assert.equal(stats.softRamp(Number.NaN, 2.6, 3), 0);
  const mid = stats.softRamp(2.6 + 1.5, 2.6, 3);
  assert.ok(mid > 0.45 && mid < 0.55, `meio da rampa: ${mid}`);
  let prev = 0;
  for (const x of [2.7, 3, 3.5, 4.1, 5, 5.6, 8, 12, 40, 1e6]) {
    const v = stats.softRamp(x, 2.6, 3);
    assert.ok(v >= prev, `crescente em ${x}`);
    assert.ok(v <= stats.SCORE_MAX && v < 1, `limitado em ${x}`);
    prev = v;
  }
  assert.ok(stats.softRamp(5.6, 2.6, 3) > 0.88, 'a rampa chega a ~90% uma extensão depois do limiar');
  assert.ok(stats.softRamp(5.6, 2.6, 3) < stats.softRamp(10, 2.6, 3), 'um pouco acima do limiar ainda perde para muito acima');
  // a rampa antiga (linear) dava 1,0 a 37σ e a 5,6σ: iguais
  assert.notEqual(stats.softRamp(37, 2.6, 3), 1);
});

test('percentile e noisyOr', () => {
  assert.equal(stats.percentile([], 0.5), 0);
  assert.equal(stats.percentile([5, 1, 3, 2, 4], 0), 1);
  assert.equal(stats.percentile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(stats.percentile([5, 1, 3, 2, 4], 1), 5);
  assert.ok(Math.abs(stats.noisyOr([0.5, 0.5]) - 0.75) < 1e-12);
  assert.equal(stats.noisyOr([]), 0);
  assert.equal(stats.noisyOr([2, -1]), 1, 'valores fora de 0..1 são limitados');
});

// ---------- áudio: nível de fala, não silêncio ----------

test('áudio: de silêncio para fala (porta de ruído do microfone) não vira pico, nem na abertura nem em cada frase', () => {
  // 5 min de silêncio digital e depois 25 min de fala "com porta": cada frase começa com um salto de ~60 dB sobre o silêncio anterior
  const extracted = gatedDb({ seconds: 1800, silentUntil: 300 });
  const n = 1800;
  const s = scoreAudio(extracted, { n, th: TH, baselineSec: 600 });
  assert.equal(s.id, 'audio');
  const worst = maxIn(s.score, 0, n - 1);
  assert.ok(worst < 0.15, `fala normal, de ponta a ponta: o maior valor é ${worst} (a linha de base antiga saturava em 1,0 em cada início de frase)`);
  assert.ok(maxIn(s.score, 295, 330) < 0.15, 'o instante em que a fala começa depois de 5 min de silêncio não é destaque');
  assert.ok(maxIn(s.score, 0, 295) === 0, 'silêncio não pontua');
  assert.deepEqual(s.describe(300, 330), []);
});

test('áudio: um grito sustentado ACIMA do normal de fala é destaque, com pontuação alta mas menor que 1 e motivo legível', () => {
  const extracted = gatedDb({ seconds: 1800, silentUntil: 120, shouts: [{ at: 900, dur: 6, db: -22 }] });
  const n = 1800;
  const s = scoreAudio(extracted, { n, th: TH, baselineSec: 600 });
  const peak = maxIn(s.score, 895, 910);
  assert.ok(peak > 0.7 && peak < 1, `grito: ${peak}`);
  assert.ok(maxIn(s.score, 0, 880) < 0.15 && maxIn(s.score, 920, n - 1) < 0.15, 'e nada mais pontua');
  const reasons = s.describe(895, 910).map((r) => r.text);
  assert.ok(reasons.some((r) => /^volume acima do normal de fala \(\+\d+ dB\)$/.test(r)), reasons.join('|'));
  // dois gritos de intensidades diferentes NÃO empatam em 1,0: a ordem se mantém
  const two = gatedDb({ seconds: 1800, silentUntil: 120, shouts: [{ at: 600, dur: 6, db: -26 }, { at: 1200, dur: 6, db: -16 }] });
  const t = scoreAudio(two, { n, th: TH, baselineSec: 600 });
  assert.ok(maxIn(t.score, 1195, 1210) > maxIn(t.score, 595, 610), 'o grito mais forte pontua mais');
  assert.ok(maxIn(t.score, 1195, 1210) < 1);
});

test('áudio: o fundo constante (jogo, música) é o normal; um estouro sobre ele continua sendo destaque', () => {
  const rand = rng(11);
  const db = [];
  for (let i = 0; i < 3600 * 2; i += 1) {
    const t = i / 2;
    db.push(t >= 1800 && t < 1804 ? -20 : -50 + (rand() - 0.5) * 2);
  }
  const s = scoreAudio({ windowSec: 0.5, db }, { n: 3600, th: TH, baselineSec: 600 });
  assert.ok(maxIn(s.score, 1795, 1810) > 0.7, 'estouro de +30 dB sobre o fundo');
  assert.ok(maxIn(s.score, 0, 1780) === 0 && maxIn(s.score, 1830, 3599) === 0, 'o fundo estacionário não pontua');
  assert.ok(noiseFloor(db) <= -60 && noiseFloor(db) >= -75, `piso de ruído ${noiseFloor(db)}: o fundo (-50) fica ACIMA dele`);
});

test('áudio: fundo quase mudo (-61 dB) com estouros RAROS: o estouro é destaque; com som frequente o normal é o som (a fala)', () => {
  const rand = rng(21);
  // raro: 3 s de estouro a cada 60 s (5% do tempo) sobre um chiado de -61 dB: pouquíssimo passa do piso, então o chiado é o normal
  const rare = [];
  for (let i = 0; i < 3600 * 2; i += 1) { const t = i / 2; rare.push(t % 60 >= 30 && t % 60 < 33 ? -27 + (rand() - 0.5) : -61 + (rand() - 0.5)); }
  const r = scoreAudio({ windowSec: 0.5, db: rare }, { n: 3600, th: TH, baselineSec: 600 });
  assert.ok(noiseFloor(rare) === -75, `o piso desce ao mínimo (${noiseFloor(rare)}) para o chiado contar como normal`);
  for (const at of [30, 930, 3330]) assert.ok(maxIn(r.score, at - 2, at + 6) > 0.9, `estouro em ${at}`);
  assert.ok(maxIn(r.score, 40, 80) === 0, 'o chiado não pontua');
  // frequente: som por 40% do tempo (8 s sim, 12 s não) sobre o mesmo chiado: é fala normal e NENHUM trecho vira destaque
  const often = [];
  for (let i = 0; i < 3600 * 2; i += 1) { const t = i / 2; often.push(t % 20 < 8 ? -30 + (rand() - 0.5) * 6 : -61 + (rand() - 0.5)); }
  const o = scoreAudio({ windowSec: 0.5, db: often }, { n: 3600, th: TH, baselineSec: 600 });
  assert.equal(noiseFloor(often), -60, 'fala em 40% do tempo: o piso fica onde está');
  assert.ok(maxIn(o.score, 0, 3599) < 0.15, `fala frequente não é destaque: ${maxIn(o.score, 0, 3599)}`);
});

test('áudio: exige nível absoluto mínimo e limita o desvio (z) a um teto', () => {
  // gravação baixíssima: a "explosão" relativa (+14 dB) continua abaixo de -45 dBFS e não é destaque
  const quiet = [];
  for (let i = 0; i < 1200; i += 1) quiet.push(i >= 1000 && i < 1010 ? -58 : -72);
  const q = scoreAudio({ windowSec: 0.5, db: quiet }, { n: 600, th: TH, baselineSec: 600 });
  assert.equal(maxIn(q.score, 0, 599), 0, 'abaixo do nível absoluto mínimo');
  // desvio absurdo (fundo muito regular e estouro enorme): a pontuação é limitada, nunca "37σ"
  const flat = [];
  for (let i = 0; i < 2400; i += 1) flat.push(i >= 1200 && i < 1208 ? -3 : -55);
  const f = scoreAudio({ windowSec: 0.5, db: flat }, { n: 1200, th: TH, baselineSec: 600 });
  const peak = maxIn(f.score, 595, 610);
  assert.ok(peak > 0.9 && peak <= stats.SCORE_MAX, `${peak}`);
  assert.ok(f.describe(595, 610).every((r) => !/σ/.test(r.text)), 'o motivo mostra dB, não desvios gigantes');
});

// ---------- combinação: desempate, distribuição, espaçamento e limites de falas ----------

function fake(id, n, spec) {
  const score = new Float64Array(n);
  for (const [from, to, v] of spec) for (let k = from; k <= to; k += 1) score[k] = v;
  return { id, score, describe: () => [{ text: `motivo ${id}`, strength: 1 }] };
}
const P = (over = {}) => params.normalizeParams({ minDurationSec: 10, maxDurationSec: 40, padBeforeSec: 2, padAfterSec: 2, minRelevance: 0.3, alignToleranceSec: 0, weights: { audio: 1, image: 1, chat: 1, text: 1 }, ...over });
const disjoint = (list) => {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i].start >= sorted[i - 1].end - 1e-9, `sobreposição ${JSON.stringify(sorted[i - 1])} x ${JSON.stringify(sorted[i])}`);
};

test('empate de pontuação: vence quem tem mais pontuação ao redor, NUNCA quem veio primeiro no tempo', () => {
  // dois platôs de 0,8 iguais; o do fim do vídeo tem evidência fraca ao redor (um evento mais "rico")
  const sig = fake('audio', 2000, [[100, 104, 0.8], [1500, 1504, 0.8], [1480, 1498, 0.3], [1506, 1524, 0.3]]);
  const out = combine({ n: 2000, duration: 2000, signals: [sig], params: P({ maxSuggestions: 1, spread: { minGapSec: 0 } }) });
  assert.equal(out.length, 1);
  assert.ok(out[0].start > 1400, `escolheu ${out[0].start}: o platô do começo só ganhava por vir antes`);
  // sem nada que desempate, a ordem não importa e os dois são escolhidos
  const both = combine({ n: 2000, duration: 2000, signals: [fake('audio', 2000, [[100, 104, 0.8], [1500, 1504, 0.8]])], params: P({ maxSuggestions: 5, spread: { minGapSec: 0 } }) });
  assert.equal(both.length, 2);
});

test('distribuição: uma abertura cheia de eventos fortes não consome a cota inteira; nenhuma janela de 10 min passa de N', () => {
  const n = 7200; // 2 h; 12 sugestões (6 por hora): no máximo 2 por janela de 10 min
  const strong = [];
  for (let t = 20; t < 300; t += 20) strong.push([t, t + 1, 0.96]); // 14 eventos fortes nos primeiros 5 min
  const later = [[1300, 1301, 0.7], [2500, 2501, 0.7], [3700, 3701, 0.7], [4900, 4901, 0.7], [6100, 6101, 0.7], [6900, 6901, 0.7]];
  const p = P({ perHour: 6, minDurationSec: 10, spread: {} });
  assert.equal(params.suggestionLimit(p, n), 12);
  assert.equal(params.perWindowLimit(p, n), 2);
  const out = combine({ n, duration: n, signals: [fake('audio', n, [...strong, ...later])], params: p });
  assert.equal(out.length, 8, `2 na abertura + os 6 eventos moderados: ${JSON.stringify(out.map((s) => s.start))}`);
  const perWindow = new Map();
  for (const s of out) perWindow.set(Math.floor(s.peak / 600), (perWindow.get(Math.floor(s.peak / 600)) || 0) + 1);
  assert.ok([...perWindow.values()].every((c) => c <= 2), JSON.stringify([...perWindow]));
  assert.ok(perWindow.size >= 6, `distribuído em ${perWindow.size} janelas`);
  assert.ok(later.every(([a]) => out.some((s) => s.start <= a + 1 && s.end >= a)), 'os eventos moderados do resto da live foram escolhidos');
  disjoint(out);
  // a cota é configurável e vale o mesmo número em qualquer parte
  const loose = combine({ n, duration: n, signals: [fake('audio', n, [...strong, ...later])], params: P({ perHour: 6, spread: { perWindow: 20 } }) });
  assert.equal(loose.length, 12);
  assert.ok(loose.filter((s) => s.peak < 600).length > 2, 'sem a cota a abertura leva tudo');
});

test('perWindowLimit: o dobro da média por janela, no mínimo 2; configurável', () => {
  const p = (over) => params.normalizeParams(over);
  assert.equal(params.perWindowLimit(p({}), 11090), 2, '18 sugestões em 3 h: média ~1 por janela de 10 min');
  assert.equal(params.perWindowLimit(p({ perHour: 30 }), 11090), 10);
  assert.equal(params.perWindowLimit(p({}), 300), 12, 'vídeo curto: a janela é maior que o vídeo');
  assert.equal(params.perWindowLimit(p({ spread: { perWindow: 3 } }), 11090), 3);
  assert.equal(params.perWindowLimit(p({ perHour: 1 }), 3600), 2);
});

test('espaçamento mínimo: nenhuma sugestão começa colada na anterior', () => {
  const sig = fake('audio', 600, [[100, 101, 0.9], [126, 127, 0.88], [150, 151, 0.86], [400, 401, 0.8]]);
  const out = combine({ n: 600, duration: 600, signals: [sig], params: P({ spread: { minGapSec: 20 }, maxSuggestions: 10, minDurationSec: 6 }) });
  const sorted = [...out].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i].start - sorted[i - 1].end >= 20 - 1e-9, `folga ${sorted[i].start - sorted[i - 1].end} entre ${JSON.stringify([sorted[i - 1].start, sorted[i - 1].end])} e ${JSON.stringify([sorted[i].start, sorted[i].end])}`);
  assert.ok(out.some((s) => s.start <= 400 && s.end >= 400));
  const touching = combine({ n: 600, duration: 600, signals: [sig], params: P({ spread: { minGapSec: 0 }, maxSuggestions: 10, minDurationSec: 6 }) });
  assert.ok(touching.length >= out.length, 'sem folga cabem mais sugestões coladas');
});

test('com transcrição, o corte começa no começo de uma fala e termina no fim de uma fala (dentro das durações)', () => {
  const starts = [];
  const ends = [];
  for (let t = 0; t < 600; t += 7) { starts.push(t + 1.3); ends.push(t + 5.9); }
  const sig = fake('text', 600, [[300, 316, 0.9]]);
  const aligned = combine({ n: 600, duration: 600, signals: [sig], params: P({ minDurationSec: 12, maxDurationSec: 40, maxSuggestions: 3, spread: { minGapSec: 0 } }), alignTo: { starts, ends } });
  assert.equal(aligned.length, 1);
  const s = aligned[0];
  assert.ok(starts.some((t) => Math.abs(t - s.start) <= 0.05), `início ${s.start} não é começo de fala`);
  assert.ok(ends.some((t) => Math.abs(t - s.end) <= 0.05), `fim ${s.end} não é fim de fala`);
  assert.ok(s.end - s.start >= 12 - 1e-9 && s.end - s.start <= 40 + 1e-9);
  const plain = combine({ n: 600, duration: 600, signals: [sig], params: P({ minDurationSec: 12, maxDurationSec: 40, maxSuggestions: 3, spread: { minGapSec: 0 } }) });
  assert.ok(!starts.some((t) => Math.abs(t - plain[0].start) <= 0.05) || !ends.some((t) => Math.abs(t - plain[0].end) <= 0.05), 'sem transcrição o corte não está alinhado (controle do teste)');
  // o alinhamento nunca estraga a duração máxima nem sai do vídeo
  const tight = combine({ n: 600, duration: 600, signals: [fake('text', 600, [[0, 30, 0.9]])], params: P({ minDurationSec: 10, maxDurationSec: 15, maxSuggestions: 2, spread: { minGapSec: 0 } }), alignTo: { starts, ends } });
  for (const t of tight) assert.ok(t.start >= 0 && t.end <= 600 && t.end - t.start <= 15 + 1e-9 && t.end - t.start >= 10 - 1e-9, JSON.stringify(t));
});

test('propriedades (dados aleatórios, com distribuição e alinhamento): disjuntas, dentro do vídeo, durações válidas, cota por janela', () => {
  const rand = rng(77);
  for (let round = 0; round < 30; round += 1) {
    const n = 1200 + Math.floor(rand() * 5000);
    const spec = [];
    for (let i = 0; i < 40; i += 1) { const from = Math.floor(rand() * n); spec.push([from, Math.min(n - 1, from + Math.floor(rand() * 10)), 0.3 + rand() * 0.69]); }
    const starts = []; const ends = [];
    for (let t = 0; t < n; t += 4 + rand() * 6) { starts.push(t); ends.push(t + 2 + rand() * 3); }
    const minDur = 8 + Math.floor(rand() * 10);
    const p = P({ minDurationSec: minDur, maxDurationSec: minDur + 30, perHour: 12, minRelevance: 0.3, alignToleranceSec: 2 });
    const out = combine({ n, duration: n, signals: [fake('audio', n, spec), fake('text', n, spec.map(([a, b, v]) => [Math.min(n - 1, a + 3), Math.min(n - 1, b + 3), v * 0.7]))], params: p, alignTo: { starts, ends } });
    disjoint(out);
    const cap = params.perWindowLimit(p, n);
    const perWindow = new Map();
    for (const s of out) {
      assert.ok(s.start >= 0 && s.end <= n + 1e-9 && s.end - s.start <= minDur + 30 + 1e-9 && s.end - s.start >= minDur - 1e-9, JSON.stringify(s));
      assert.ok(s.relevance >= 0.3 && s.relevance < 1);
      const w = Math.floor(s.peak / 600);
      perWindow.set(w, (perWindow.get(w) || 0) + 1);
    }
    assert.ok([...perWindow.values()].every((c) => c <= cap), `cota ${cap}: ${JSON.stringify([...perWindow])}`);
  }
});

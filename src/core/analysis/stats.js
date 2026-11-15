'use strict';

/**
 * Estatística robusta usada pelos sinais: mediana/MAD (não se deixa enganar pelos próprios picos),
 * linha de base local por blocos e suavizações simples. Tudo puro e sem dependências.
 */

/** 1,4826 faz o MAD ser comparável ao desvio-padrão de uma distribuição normal. */
const MAD_TO_SIGMA = 1.4826;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Mediana (não altera o array). Vazio -> 0. */
function median(values) {
  const n = values.length;
  if (!n) return 0;
  const sorted = Float64Array.from(values).sort();
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Desvio absoluto mediano em torno de `med` (calculada se não vier). */
function mad(values, med = median(values)) {
  if (!values.length) return 0;
  const dev = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) dev[i] = Math.abs(values[i] - med);
  return median(dev);
}

/** Média sem os `trim` (fração) maiores valores: uma rajada não infla a "média" de referência. */
function trimmedMean(values, trim = 0.05) {
  const n = values.length;
  if (!n) return 0;
  const sorted = Float64Array.from(values).sort();
  const keep = Math.max(1, Math.ceil(n * (1 - clamp(trim, 0, 0.5))));
  let sum = 0;
  for (let i = 0; i < keep; i += 1) sum += sorted[i];
  return sum / keep;
}

/**
 * Linha de base local: divide a série em blocos de ~`blockLen` itens, calcula `stat(bloco)` (um número
 * ou { center, scale }) em cada um e interpola linearmente entre os centros dos blocos (sem degraus).
 * Série curta (até 1,5 bloco) usa um bloco só. Devolve `{ center: Float64Array, scale: Float64Array }`.
 */
function localBaseline(values, blockLen, stat) {
  const n = values.length;
  const center = new Float64Array(n);
  const scale = new Float64Array(n);
  if (!n) return { center, scale };
  const asPair = (v) => (typeof v === 'number' ? { center: v, scale: 1 } : v);
  const block = Math.max(1, Math.floor(blockLen));
  const blocks = n <= block * 1.5 ? 1 : Math.max(1, Math.round(n / block));
  if (blocks === 1) {
    const s = asPair(stat(values));
    center.fill(s.center);
    scale.fill(s.scale);
    return { center, scale };
  }
  const size = n / blocks;
  const centers = [];
  const stats = [];
  for (let b = 0; b < blocks; b += 1) {
    const from = Math.floor(b * size);
    const to = b === blocks - 1 ? n : Math.floor((b + 1) * size);
    centers.push((from + to - 1) / 2);
    stats.push(asPair(stat(values.subarray ? values.subarray(from, to) : values.slice(from, to))));
  }
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    while (j < blocks - 2 && i > centers[j + 1]) j += 1;
    const a = centers[j];
    const b = centers[j + 1];
    const t = clamp((i - a) / (b - a || 1), 0, 1);
    center[i] = stats[j].center + (stats[j + 1].center - stats[j].center) * t;
    scale[i] = stats[j].scale + (stats[j + 1].scale - stats[j].scale) * t;
  }
  return { center, scale };
}

/** Máximo deslizante de raio `radius` (dilatação): tolera pequenas diferenças de tempo entre sinais. */
function slidingMax(values, radius) {
  const n = values.length;
  const r = Math.max(0, Math.floor(radius));
  if (!r) return Float64Array.from(values);
  const out = new Float64Array(n);
  // deque monotônico de índices com valores decrescentes: O(n)
  const dq = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < n; i += 1) {
    const hi = Math.min(n - 1, i + r);
    while (next <= hi) {
      while (tail > head && values[dq[tail - 1]] <= values[next]) tail -= 1;
      dq[tail] = next;
      tail += 1;
      next += 1;
    }
    while (dq[head] < i - r) head += 1;
    out[i] = values[dq[head]];
  }
  return out;
}

/** Soma acumulada (prefix[i] = soma dos i primeiros) para somas de janela em O(1). */
function prefixSums(values) {
  const out = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i += 1) out[i + 1] = out[i] + values[i];
  return out;
}

/** Valor no percentil `q` (0..1) de uma lista (não altera o array). Vazio -> 0. */
function percentile(values, q) {
  const n = values.length;
  if (!n) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(n - 1, Math.max(0, Math.floor(clamp(q, 0, 1) * n)))];
}

/** Teto de qualquer pontuação de um sinal: nunca chega a 1, então nenhum sinal sozinho "empata" com a certeza. */
const SCORE_MAX = 0.97;

/**
 * Pontuação saturante controlada (curva logística, 0..SCORE_MAX): vale 0 até `x0`, vale cerca de metade do teto no meio da rampa
 * (`x0 + span/2`, como a rampa linear que ela substitui) e se aproxima de SCORE_MAX bem depois de `x0 + span` (nessa marca vale cerca
 * de 90% do teto). Diferente da rampa linear, valores enormes (um desvio de 37σ) não empatam em 1,0 com valores só um pouco acima do
 * limiar, e a ordem entre eles se mantém.
 */
function softRamp(x, x0, span, max = SCORE_MAX) {
  if (!Number.isFinite(x) || !(x > x0)) return 0;
  const width = Math.max(1e-9, span);
  const mid = x0 + 0.45 * width;
  const k = 5 / width;
  const s = (v) => 1 / (1 + Math.exp(-k * (v - mid)));
  const lo = s(x0);
  return max * Math.max(0, (s(x) - lo) / (1 - lo));
}

/** Soma de evidências independentes: 1 - Π(1 - v). Cada v em 0..1. */
function noisyOr(values) {
  let rest = 1;
  for (const v of values) rest *= 1 - clamp01(v);
  return 1 - rest;
}

module.exports = { MAD_TO_SIGMA, SCORE_MAX, clamp, clamp01, median, mad, trimmedMean, percentile, localBaseline, slidingMax, prefixSums, softRamp, noisyOr };

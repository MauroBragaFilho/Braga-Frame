'use strict';

const { AnalysisError } = require('./errors');
const { runFfmpeg, lastLine } = require('./proc');
const { MAD_TO_SIGMA, clamp, median, mad, percentile, localBaseline, softRamp } = require('./stats');

/**
 * Sinal de ÁUDIO: energia (RMS, em dBFS) por janela de 0,5 s, a partir do PCM 16 kHz mono decodificado
 * pelo ffmpeg EM FLUXO (nada do áudio fica em memória: só um número por janela).
 *
 * Pontuação (v4, docs/recursos/analise-ia.md, seção 13): o volume é medido contra o NÍVEL DE FALA do trecho, nunca contra o silêncio.
 * Muitas lives têm porta de ruído no microfone (o nível cai a -100 dB entre as frases): contra uma linha de base que inclui esse
 * silêncio, TODA frase que começa parece uma subida de dezenas de dB e a pontuação saturava na abertura da live. Agora:
 *  - só contam os quadros acima de um piso de ruído (os "ativos"); a linha de base (mediana/MAD) é calculada só sobre eles, por bloco;
 *  - o destaque é o nível SUSTENTADO (média dos quadros ativos em ~5 s), não um quadro isolado: fala animada dura, um estalo não;
 *  - exige nível absoluto mínimo e limita o desvio (z) a um teto; a pontuação é logística (nunca 1,0);
 *  - "subida brusca" só vale se os ~10 s anteriores TINHAM fala (silêncio para fala é início de frase, não destaque).
 * Heurística simples e explicável; não é IA.
 */

const SAMPLE_RATE = 16000;
const WINDOW_SEC = 0.5;
const WINDOW_SAMPLES = SAMPLE_RATE * WINDOW_SEC;
const FLOOR_DB = -100; // silêncio digital
const NOISE_FLOOR_MIN_DB = -75; // o piso de ruído (abaixo dele é silêncio) fica entre -75 e -60 dBFS...
const NOISE_FLOOR_MAX_DB = -60;
const NOISE_FLOOR_BELOW_LOUD_DB = 30; // ... e acompanha a trilha: 30 dB abaixo do percentil 95 (gravação baixa = piso mais baixo)
const RARE_ACTIVE_FRACTION = 0.2; // se menos que isto do áudio passa do piso, o que passa é RARO (um evento), não a fala normal
const MIN_PEAK_DB = -45; // nível absoluto mínimo (dBFS) para um trecho contar como destaque
const SUSTAIN_HALF_SEC = 2; // nível sustentado = média dos quadros ativos em ±2 s (5 s)
const SUSTAIN_MIN_ACTIVE = 0.4; // ... exigindo 40% de quadros ativos na janela
const SUSTAIN_MIN_FRAMES = 4; // ... e pelo menos 4 quadros (2 s) de fala
const MIN_SCALE_DB = 3; // piso do desvio robusto do nível de fala
const MIN_BASELINE_SECONDS = 40; // segundos de fala para o bloco ter linha de base própria
const Z_CAP = 6; // limite superior do desvio (um valor absurdo não vira "37σ")
const RISE_LOOKBACK_SEC = 12; // a subida é medida contra os ~10 s de fala anteriores (de 12 s até 2 s antes)
const RISE_GAP_SEC = 2;
const RISE_MIN_ACTIVE = 0.4;
const RISE_MIN_FRAMES = 8;

/**
 * Decodifica o áudio e devolve { windowSec, db: number[] } (dBFS por janela de 0,5 s).
 * `duration` só serve para o progresso. Lança AUDIO_FAILED se nada pôde ser lido.
 */
async function extractAudio({ ffmpeg, file, duration = 0, signal, onProgress, spawn, onSpawn, inputArgs = [] }) {
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', ...inputArgs,
    '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-af', `aresample=${SAMPLE_RATE}:async=1:first_pts=0`, '-ac', '1', '-f', 's16le', '-'
  ];
  const db = [];
  let acc = 0;
  let count = 0;
  let total = 0;
  let carry = null; // sobra de 1 byte entre blocos
  const expected = duration > 0 ? duration * SAMPLE_RATE : 0;

  const pushWindow = (n) => {
    const rms = Math.sqrt(acc / n) / 32768;
    db.push(Math.round(Math.max(FLOOR_DB, 20 * Math.log10(rms || 1e-12)) * 100) / 100);
    acc = 0;
    count = 0;
  };

  const onStdout = (chunk) => {
    const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
    const usable = buf.length - (buf.length % 2);
    carry = usable < buf.length ? Buffer.from(buf.subarray(usable)) : null;
    for (let i = 0; i < usable; i += 2) {
      const v = buf.readInt16LE(i);
      acc += v * v;
      count += 1;
      if (count === WINDOW_SAMPLES) pushWindow(WINDOW_SAMPLES);
    }
    total += usable / 2;
    if (onProgress && expected) onProgress(Math.min(1, total / expected));
  };

  const { code, stderrTail } = await runFfmpeg(ffmpeg, args, { onStdout, signal, spawn, onSpawn });
  if (count >= WINDOW_SAMPLES / 2) pushWindow(count); // sobra final de pelo menos 1/4 s
  if (!db.length) {
    throw new AnalysisError('AUDIO_FAILED', `Não foi possível ler o áudio do vídeo${lastLine(stderrTail) ? ` (${lastLine(stderrTail)})` : ''}. O sinal de áudio foi ignorado.`, { code });
  }
  return { windowSec: WINDOW_SEC, db, partial: code !== 0, tail: code !== 0 ? lastLine(stderrTail) : '' };
}

/**
 * Piso de ruído (dBFS): quadros abaixo dele são silêncio (porta de ruído fechada, ambiente quase mudo) e não entram no "nível normal".
 * O fundo constante de uma trilha (jogo, música, sala) fica ACIMA do piso e é o normal contra o qual um grito ou uma risada aparece.
 */
function noiseFloor(db) {
  const floor = clamp(percentile(db, 0.95) - NOISE_FLOOR_BELOW_LOUD_DB, NOISE_FLOOR_MIN_DB, NOISE_FLOOR_MAX_DB);
  if (!db.length) return floor;
  // quase tudo abaixo do piso (um ambiente de -61 dB com estouros raros): o fundo é o normal e o estouro é o destaque, então o piso
  // desce ao mínimo para o fundo contar. Com fala em 20% do tempo ou mais, o normal é a fala e o piso fica onde está.
  let above = 0;
  for (const x of db) if (x > floor) above += 1;
  return above / db.length < RARE_ACTIVE_FRACTION ? NOISE_FLOOR_MIN_DB : floor;
}

/**
 * Pontuação por segundo (0..1) a partir das janelas. `th` = thresholds(sensitivity);
 * `n` = número de segundos da grade. Devolve { id, score, describe(from, to), stats }.
 */
function scoreAudio(extracted, { n, th, baselineSec }) {
  const { db, windowSec } = extracted;
  const perSec = Math.max(1, Math.round(1 / windowSec));
  const w = db.length;
  const floor = noiseFloor(db);

  // somas acumuladas dos quadros ATIVOS (acima do piso): nível total e quantidade
  const sumLevel = new Float64Array(w + 1);
  const sumActive = new Float64Array(w + 1);
  for (let i = 0; i < w; i += 1) {
    const on = db[i] > floor;
    sumLevel[i + 1] = sumLevel[i] + (on ? db[i] : 0);
    sumActive[i + 1] = sumActive[i] + (on ? 1 : 0);
  }
  /** Média dos quadros ativos em [a, b) (em quadros), ou NaN se a janela tem pouca fala. */
  const activeMean = (a, b, minFraction, minFrames) => {
    const lo = Math.max(0, a);
    const hi = Math.min(w, b);
    if (hi <= lo) return Number.NaN;
    const count = sumActive[hi] - sumActive[lo];
    if (count < minFrames || count / (hi - lo) < minFraction) return Number.NaN;
    return (sumLevel[hi] - sumLevel[lo]) / count;
  };

  // nível sustentado de fala em cada segundo e o nível dos ~10 s de fala que o antecedem
  const sustained = new Float64Array(n).fill(Number.NaN);
  const before = new Float64Array(n).fill(Number.NaN);
  for (let k = 0; k < n; k += 1) {
    const from = k * perSec;
    sustained[k] = activeMean(from - SUSTAIN_HALF_SEC * perSec, from + (SUSTAIN_HALF_SEC + 1) * perSec, SUSTAIN_MIN_ACTIVE, SUSTAIN_MIN_FRAMES);
    before[k] = activeMean((k - RISE_LOOKBACK_SEC) * perSec, (k - RISE_GAP_SEC) * perSec, RISE_MIN_ACTIVE, RISE_MIN_FRAMES);
  }

  // linha de base = NÍVEL NORMAL DE FALA do trecho: mediana/MAD só dos segundos com fala, por bloco (interpolado entre os blocos)
  const speech = [];
  for (let k = 0; k < n; k += 1) if (Number.isFinite(sustained[k])) speech.push(sustained[k]);
  const globalStat = { center: median(speech), scale: Math.max(MIN_SCALE_DB, MAD_TO_SIGMA * mad(speech)) };
  const base = localBaseline(sustained, baselineSec, (block) => {
    const sp = [];
    for (let k = 0; k < block.length; k += 1) if (Number.isFinite(block[k])) sp.push(block[k]);
    if (sp.length < MIN_BASELINE_SECONDS) return globalStat; // bloco quase mudo: vale o nível de fala do vídeo todo
    const center = median(sp);
    return { center, scale: Math.max(MIN_SCALE_DB, MAD_TO_SIGMA * mad(sp, center)) };
  });

  const z = new Float64Array(n).fill(-Infinity); // desvio do nível sustentado em relação ao normal de fala do trecho
  const rise = new Float64Array(n).fill(-Infinity); // dB acima dos ~10 s de fala anteriores
  const peakScore = new Float64Array(n);
  const riseScore = new Float64Array(n);
  const score = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    if (!Number.isFinite(sustained[k]) || sustained[k] < MIN_PEAK_DB) continue; // sem fala ou baixo demais: não pode ser destaque
    z[k] = Math.min(Z_CAP, (sustained[k] - base.center[k]) / base.scale[k]);
    peakScore[k] = softRamp(z[k], th.audioZ0, th.audioZSpan);
    // subida brusca: só se havia fala logo antes (de silêncio para fala é começo de frase) e o nível já passou do normal
    if (Number.isFinite(before[k]) && z[k] >= 1) {
      rise[k] = sustained[k] - before[k];
      riseScore[k] = softRamp(rise[k], th.audioRise0, th.audioRiseSpan);
    }
    score[k] = Math.max(peakScore[k], riseScore[k]);
  }

  const fmtDb = (x) => String(Math.round(x));
  function describe(from, to) {
    const out = [];
    let bk = -1;
    let rk = -1;
    for (let k = from; k <= to && k < n; k += 1) {
      // o maior valor real (não o primeiro segundo da série)
      if (peakScore[k] > 0 && (bk < 0 || z[k] > z[bk])) bk = k;
      if (riseScore[k] > 0 && (rk < 0 || rise[k] > rise[rk])) rk = k;
    }
    if (bk >= 0) out.push({ kind: 'level', text: `volume acima do normal de fala (+${fmtDb(sustained[bk] - base.center[bk])} dB)`, strength: peakScore[bk] });
    if (rk >= 0) out.push({ kind: 'rise', text: `subida brusca de volume (+${fmtDb(rise[rk])} dB)`, strength: riseScore[rk] });
    return out;
  }

  return { id: 'audio', score, describe, stats: { noiseFloorDb: floor, speechSeconds: speech.length } };
}

module.exports = { extractAudio, scoreAudio, noiseFloor, SAMPLE_RATE, WINDOW_SEC };

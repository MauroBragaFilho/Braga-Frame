'use strict';

const { AnalysisError } = require('./errors');
const { runFfmpeg, lastLine } = require('./proc');
const { MAD_TO_SIGMA, median, mad, localBaseline, softRamp } = require('./stats');

/**
 * Sinal de IMAGEM: mudança de cena e movimento. O ffmpeg reduz o vídeo (2 quadros/s, 160 px de largura,
 * só luminância) e o filtro `scdet` mede, quadro a quadro, a diferença média absoluta (`mafd`) e a
 * pontuação de mudança de cena (`score` = menor entre a diferença atual e a variação dela, 0..100).
 * Agregado por segundo: `scene` = maior pontuação do segundo; `motion` = `mafd` médio do segundo.
 * Mudança só de cor com a mesma luminância não aparece (o filtro olha o brilho).
 */

const FPS = 2;
const WIDTH = 160;
const MIN_MOTION_SCALE = 1; // piso do desvio robusto do movimento (em % de diferença média)
const MOTION_Z_CAP = 8; // limite superior do desvio do movimento
const CUT_GUARD_SEC = 2; // perfil de conversa: o movimento a até 2 s de uma troca de câmera não conta (a fusão mexe na imagem inteira)

/**
 * Devolve { seconds, scene: number[], motion: number[] } (um valor por segundo do vídeo).
 * `fast`: só quadros-chave (muito mais rápido; a resolução no tempo fica igual ao intervalo de
 * quadros-chave do vídeo).
 */
async function extractImage({ ffmpeg, file, duration = 0, fast = false, signal, onProgress, spawn, onSpawn, inputArgs = [] }) {
  const filters = [
    fast ? null : `fps=${FPS}`,
    `scale=${WIDTH}:-2:flags=fast_bilinear`,
    'format=gray',
    'scdet=t=100:sc_pass=0',
    'metadata=mode=print:file=-'
  ].filter(Boolean).join(',');
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    // noref: pula os quadros que nenhum outro usa como referência (decodificação exata dos demais, mais rápida);
    // nokey (modo rápido): só quadros-chave
    '-skip_frame', fast ? 'nokey' : 'noref', ...inputArgs,
    '-i', file, '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', filters, ...(fast ? ['-fps_mode', 'passthrough'] : []), '-f', 'null', '-'
  ];

  const scene = [];
  const motionSum = [];
  const motionCount = [];
  let frames = 0;
  let lastT = 0;
  let curT = null;
  let curMafd = null;
  let rest = '';

  const put = (t, mafd, score) => {
    const sec = Math.max(0, Math.floor(t));
    while (scene.length <= sec) { scene.push(0); motionSum.push(0); motionCount.push(0); }
    if (score > scene[sec]) scene[sec] = score;
    motionSum[sec] += mafd;
    motionCount[sec] += 1;
    frames += 1;
    if (t > lastT) lastT = t;
  };

  const onLine = (line) => {
    let m = /pts_time:(-?[\d.]+)/.exec(line);
    if (m) { curT = Number(m[1]); curMafd = null; return; }
    m = /lavfi\.scd\.mafd=([\d.]+)/.exec(line);
    if (m) { curMafd = Number(m[1]); return; }
    m = /lavfi\.scd\.score=([\d.]+)/.exec(line);
    if (m && curT !== null && curMafd !== null && Number.isFinite(curT)) {
      put(curT, curMafd, Number(m[1]));
      curT = null;
      curMafd = null;
    }
  };

  const onStdout = (chunk) => {
    const lines = (rest + chunk.toString('latin1')).split('\n');
    rest = lines.pop();
    for (const line of lines) onLine(line);
    if (onProgress && duration > 0) onProgress(Math.min(1, lastT / duration));
  };

  const { code, stderrTail } = await runFfmpeg(ffmpeg, args, { onStdout, signal, spawn, onSpawn });
  if (rest) onLine(rest);
  if (!frames) {
    throw new AnalysisError('IMAGE_FAILED', `Não foi possível ler a imagem do vídeo${lastLine(stderrTail) ? ` (${lastLine(stderrTail)})` : ''}. O sinal de imagem foi ignorado.`, { code });
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    seconds: scene.length,
    scene: scene.map(r2),
    motion: motionSum.map((s, i) => (motionCount[i] ? r2(s / motionCount[i]) : 0)),
    fast,
    partial: code !== 0,
    tail: code !== 0 ? lastLine(stderrTail) : ''
  };
}

/**
 * Pontuação por segundo (0..1). Devolve { id, score, describe(from, to) }.
 * `ignoreCuts` (perfil de conversa): num podcast ou numa live com várias câmeras, a imagem troca de câmera o tempo todo, com corte seco ou
 * fusão, e isso é decisão de quem dirige, não um acontecimento. Então a mudança de cena não pontua, e o movimento a até CUT_GUARD_SEC de
 * uma troca também não (a fusão dura até ~1 s e mexe na imagem inteira). Sobra o movimento de verdade: gente gesticulando, levantando.
 */
function scoreImage(extracted, { n, th, baselineSec, ignoreCuts = false }) {
  const scene = new Float64Array(n);
  const motion = new Float64Array(n);
  for (let k = 0; k < n && k < extracted.seconds; k += 1) { scene[k] = extracted.scene[k]; motion[k] = extracted.motion[k]; }

  // movimento = mediana de 3 s vizinhos: uma mudança de cena (1 s de diferença enorme) não conta como
  // movimento; só conta quando a imagem continua mexendo por 2 s ou mais
  const motionSmooth = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    const a = motion[Math.max(0, k - 1)];
    const b = motion[k];
    const c = motion[Math.min(n - 1, k + 1)];
    motionSmooth[k] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }
  const base = localBaseline(motionSmooth, baselineSec, (block) => {
    const med = median(block);
    return { center: med, scale: Math.max(MIN_MOTION_SCALE, MAD_TO_SIGMA * mad(block, med)) };
  });

  const nearCut = new Uint8Array(n);
  if (ignoreCuts) {
    for (let k = 0; k < n; k += 1) {
      if (scene[k] < th.sceneScore0) continue;
      for (let j = Math.max(0, k - CUT_GUARD_SEC); j <= Math.min(n - 1, k + CUT_GUARD_SEC); j += 1) nearCut[j] = 1;
    }
  }
  const sceneScore = new Float64Array(n);
  const motionScore = new Float64Array(n);
  const motionZ = new Float64Array(n);
  const score = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    sceneScore[k] = ignoreCuts ? 0 : softRamp(scene[k], th.sceneScore0, th.sceneScoreSpan);
    motionZ[k] = Math.min(MOTION_Z_CAP, (motionSmooth[k] - base.center[k]) / base.scale[k]);
    motionScore[k] = nearCut[k] ? 0 : softRamp(motionZ[k], th.motionZ0, th.motionZSpan);
    score[k] = Math.max(sceneScore[k], motionScore[k]);
  }

  const fmt1 = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
  function describe(from, to) {
    const out = [];
    let sk = -1;
    let mk = -1;
    let motionBins = 0;
    for (let k = from; k <= to && k < n; k += 1) {
      if (sceneScore[k] > 0 && (sk < 0 || scene[k] > scene[sk])) sk = k;
      if (motionScore[k] > 0) {
        motionBins += 1;
        if (mk < 0 || motionZ[k] > motionZ[mk]) mk = k;
      }
    }
    if (sk >= 0) out.push({ kind: 'scene', text: 'mudança de cena', strength: sceneScore[sk] });
    // movimento só vira motivo se durar (a mediana de 3 s já descarta picos isolados)
    if (mk >= 0 && motionBins >= 2) out.push({ kind: 'motion', text: `movimento intenso na imagem (${fmt1(motionZ[mk])}σ)`, strength: motionScore[mk] });
    return out;
  }

  return { id: 'image', score, describe };
}

module.exports = { extractImage, scoreImage, FPS, WIDTH };

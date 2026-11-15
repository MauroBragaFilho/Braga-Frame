'use strict';

const { median, percentile, softRamp } = require('./stats');
const { noiseFloor } = require('./audioSignal');

/**
 * Sinal de MOMENTO CALMO: um trecho tranquilo, sem fala e sem pico, mas "vivo" (o jogo continua e o som continua): um jogador construindo,
 * explorando uma paisagem, uma cena de história com música baixa. É o oposto dos outros sinais, que procuram o que se destaca PARA CIMA:
 * este procura o que se destaca por ser CALMO perto do resto do vídeo. Não sabe se o trecho é bonito: só sabe que ele é calmo e que
 * alguém talvez queira cortá-lo; quem decide é o usuário (a sugestão vem pendente, como todas).
 *
 * Por segundo, numa janela de ~12 s ao redor:
 *  - nível: mediana do volume da janela; o "normal" é a mediana dos níveis do vídeo todo (em uma live, a fala por cima do jogo);
 *    o quanto o trecho está abaixo desse normal é a pontuação (`softRamp(queda em dB, calmDrop0, calmSpan)`, logística, nunca 1,0);
 *  - sem pico: o percentil 90 da janela tem de ficar pelo menos PEAK_MARGIN_DB abaixo do normal (um grito ou um estouro no meio desclassifica);
 *  - vivo: pelo menos ALIVE_MIN dos quadros de som acima do piso de ruído e o nível da janela AUDIBLE_ABOVE_FLOOR_DB acima dele (som quase mudo
 *    é pausa, menu ou microfone mudo, não clima) e, quando
 *    há imagem, a imagem se mexe (mediana do movimento acima de MOTION_MIN: tela parada, pausa e carregamento não valem);
 *  - sem fala: com transcrição, uma janela com fala cobrindo SPEECH_MAX ou mais dela não vale (alguém conversando não é um momento calmo).
 *    Sem transcrição o sinal não sabe distinguir fala baixa de música baixa: o nível baixo e sem pico é o que vale.
 * Heurística simples e explicável; não é IA. Calibrada num short real (Minecraft, sem fala) e numa live de 4,7 h (docs/recursos/analysis.md).
 */

const HALF_SEC = 6; // janela de ~12 s: um trecho calmo precisa durar
const PEAK_MARGIN_DB = 4;
const ALIVE_MIN = 0.6;
const AUDIBLE_ABOVE_FLOOR_DB = 6; // o nível da janela precisa estar pelo menos isto acima do piso de ruído: abaixo disso é quase mudo (pausa, sala vazia), não clima
const MOTION_MIN = 0.4; // mafd mediano do scdet: abaixo disto a imagem está parada
const SPEECH_MAX = 0.2;
const MIN_WINDOW_FRACTION = 0.5; // janelas cortadas pelo começo ou fim do vídeo precisam ter pelo menos metade do tamanho

/**
 * `extracted` = { audio: { db, windowSec }, image?: { motion, seconds } }; `cues` = falas da transcrição ([{ start, end }]) ou vazio.
 * Devolve { id: 'calm', score (0..1 por segundo), describe(from, to), stats }.
 */
function scoreCalm(extracted, { n, th, cues = [] }) {
  const { db, windowSec } = extracted.audio;
  const image = extracted.image || null;
  const perSec = Math.max(1, Math.round(1 / windowSec));
  const floor = noiseFloor(db);

  const level = new Float64Array(n).fill(Number.NaN);
  const peak = new Float64Array(n).fill(Number.NaN);
  const alive = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    const a = Math.max(0, (k - HALF_SEC) * perSec);
    const b = Math.min(db.length, (k + HALF_SEC) * perSec);
    if (b - a < 2 * HALF_SEC * perSec * MIN_WINDOW_FRACTION) continue;
    const seg = db.slice(a, b);
    level[k] = median(seg);
    peak[k] = percentile(seg, 0.9);
    let on = 0;
    for (const x of seg) if (x > floor) on += 1;
    alive[k] = on / seg.length;
  }
  const normal = median(Array.from(level).filter(Number.isFinite));

  // fala: fração de cada janela coberta pelas falas (somas acumuladas por segundo)
  const speech = new Float64Array(n + 1);
  if (cues.length) {
    const covered = new Float64Array(n);
    for (const cue of cues) {
      for (let k = Math.max(0, Math.floor(cue.start)); k < Math.min(n, Math.ceil(cue.end)); k += 1) {
        covered[k] += Math.max(0, Math.min(cue.end, k + 1) - Math.max(cue.start, k));
      }
    }
    for (let k = 0; k < n; k += 1) speech[k + 1] = speech[k] + Math.min(1, covered[k]);
  }
  const speechFraction = (k) => {
    const a = Math.max(0, k - HALF_SEC);
    const b = Math.min(n, k + HALF_SEC + 1);
    return b > a ? (speech[b] - speech[a]) / (b - a) : 0;
  };
  const motionAround = (k) => {
    const from = Math.max(0, k - HALF_SEC);
    const to = Math.min(image.seconds - 1, k + HALF_SEC);
    return to >= from ? median(image.motion.slice(from, to + 1)) : 0;
  };

  const score = new Float64Array(n);
  const drop = new Float64Array(n);
  let calmSeconds = 0;
  for (let k = 0; k < n; k += 1) {
    if (!Number.isFinite(level[k]) || alive[k] < ALIVE_MIN || level[k] < floor + AUDIBLE_ABOVE_FLOOR_DB) continue;
    if (peak[k] > normal - PEAK_MARGIN_DB) continue;
    if (image && motionAround(k) < MOTION_MIN) continue;
    if (cues.length && speechFraction(k) >= SPEECH_MAX) continue;
    drop[k] = normal - level[k];
    score[k] = softRamp(drop[k], th.calmDrop0, th.calmSpan);
    if (score[k] >= 0.5) calmSeconds += 1;
  }

  // o motivo diz quanto o trecho está abaixo do normal (a média dos segundos calmos do evento: o evento pode vir da dilatação, então olha um pouco além)
  function describe(from, to) {
    let sum = 0;
    let count = 0;
    let strength = 0;
    for (let k = Math.max(0, from - 3); k <= Math.min(n - 1, to + 3); k += 1) {
      if (!(score[k] >= 0.5)) continue;
      sum += drop[k];
      count += 1;
      if (score[k] > strength) strength = score[k];
    }
    if (!count) return [];
    const noSpeech = cues.length ? ', sem fala' : '';
    return [{ text: `momento calmo: som baixo e contínuo, sem picos${noSpeech} (${Math.round(sum / count)} dB abaixo do normal)`, strength }];
  }

  return { id: 'calm', score, describe, stats: { calmSeconds, normalDb: Math.round(normal * 10) / 10 } };
}

module.exports = { scoreCalm, HALF_SEC, PEAK_MARGIN_DB, ALIVE_MIN, MOTION_MIN, SPEECH_MAX };

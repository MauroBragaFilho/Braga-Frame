'use strict';

/**
 * Detecção de silêncio e corte dos trechos sem fala ANTES da transcrição (sem mudar os tempos finais).
 *
 * Adaptado de src/core/transcription/silenceTrim.js do BDS (somente leitura). Por quê: o whisper costuma
 * "alucinar" frases em silêncio, e a regra deste produto é nunca inventar fala. Aqui:
 *   1. `detectSpeechRanges` roda o `silencedetect` do ffmpeg no WAV e devolve os trechos com som (com folga);
 *      lista vazia = o áudio todo é silêncio -> "nenhuma fala detectada", sem nem chamar o whisper;
 *   2. `buildTrimmedWav` junta só esses trechos num WAV menor e devolve o mapa de tempo (cortado -> original);
 *   3. depois da transcrição, `remapResult` leva segmentos e palavras de volta ao tempo do WAV original.
 *
 * O corte é feito em Node, copiando as amostras PCM do WAV de trabalho (mono 16 kHz, 16 bits, que o ffmpeg gera
 * aqui): exato por amostra (o mapa de tempo não tem erro) e sem limite de tamanho de comando.
 *
 * Os limiares são CONSERVADORES de propósito (só o que é praticamente silêncio sai): fala baixinha nunca pode
 * ser tratada como silêncio. O volume do jogo/música não é "silêncio": isso quem filtra são as regras de
 * confiança e de alucinação (hallucinations.js).
 */

const fs = require('node:fs');
const { runProcess } = require('./proc');
const { SubtitlesError, cancelled } = require('./errors');

const DEFAULTS = Object.freeze({ noiseDb: -50, minSilence: 1.0, pad: 0.3 });
const LIMITS = Object.freeze({ noiseDb: [-90, 0], minSilence: [0.1, 10], pad: [0, 2] });
const MIN_SPEECH_SECONDS = 0.12; // som mais curto que isso (antes da folga) não conta como fala
const MIN_RANGE_SECONDS = 0.05; // trechos menores que isso somem (ruído)
const MERGE_GAP_SECONDS = 0.05; // trechos separados por menos que isso viram um só
const COPY_CHUNK_BYTES = 1 << 20;
const EPS = 1e-9;

const round3 = (n) => Math.round(n * 1000) / 1000;

/** Número real dentro de [min, max]; qualquer outra coisa (texto, NaN, fora da faixa) volta ao padrão. */
function limited(value, [min, max], fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/**
 * Filtro `-af` do ffmpeg que detecta silêncio. Os limiares entram no texto do filtro, então só valem números reais dentro de
 * faixas sensatas (ruído -90..0 dB, duração 0,1..10 s): qualquer outra coisa (um texto com ":" ou ",", por exemplo, viraria
 * outro filtro, como `ametadata` gravando num arquivo) volta ao padrão.
 */
function silenceFilter({ noiseDb, minSilence } = {}) {
  return `silencedetect=noise=${limited(noiseDb, LIMITS.noiseDb, DEFAULTS.noiseDb)}dB:d=${limited(minSilence, LIMITS.minSilence, DEFAULTS.minSilence)}`;
}

/**
 * Trechos com som = o que sobra fora dos silêncios, alargado por `pad` nos dois lados e com vizinhos mesclados.
 * @param {Array<{start:number,end:number|null}>} silences  end null/ausente: silêncio até o fim do arquivo
 * @returns {Array<{start:number,end:number}>} em milissegundos de precisão, em ordem, sem sobreposição
 */
function speechFromSilences(silences, duration, { pad = DEFAULTS.pad, minSpeech = MIN_SPEECH_SECONDS } = {}) {
  const total = Number(duration);
  if (!(total > 0)) return [];
  const sil = silences
    .map((s) => ({
      start: Math.max(0, Number(s.start) || 0),
      end: s.end === null || s.end === undefined || !Number.isFinite(Number(s.end)) ? total : Math.min(total, Number(s.end))
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const speech = [];
  let at = 0;
  for (const s of sil) {
    if (s.start > at) speech.push({ start: at, end: s.start });
    at = Math.max(at, s.end);
  }
  if (at < total) speech.push({ start: at, end: total });

  const merged = [];
  // "som" de poucos milissegundos nas pontas (diferença de arredondamento entre o fim do silêncio e a duração do
  // arquivo, ou um estalo) não é fala: sem isto, um áudio todo mudo viraria um trecho de 0,3 s com a folga
  for (const r of speech.filter((x) => x.end - x.start >= minSpeech)) {
    const start = Math.max(0, r.start - pad);
    const end = Math.min(total, r.end + pad);
    const last = merged[merged.length - 1];
    if (last && start - last.end <= MERGE_GAP_SECONDS) last.end = Math.max(last.end, end);
    else merged.push({ start, end });
  }
  return merged
    .map((r) => ({ start: round3(r.start), end: round3(r.end) }))
    .filter((r) => r.end - r.start >= MIN_RANGE_SECONDS);
}

/** Duração (s) do WAV pelo tamanho do arquivo (mono, 16 kHz, 16 bits, cabeçalho de 44 bytes). */
function wavSeconds(wavPath) {
  return Math.max(0, (fs.statSync(wavPath).size - 44) / 32000);
}

/**
 * Roda `ffmpeg -af silencedetect` no WAV.
 * @returns {Promise<{ silences:Array<{start:number,end:number|null}>, speech:Array<{start:number,end:number}>, duration:number }>}
 *   speech vazio = o áudio inteiro é silêncio.
 */
async function analyzeSilence(wavPath, { ffmpeg, noiseDb = DEFAULTS.noiseDb, minSilence = DEFAULTS.minSilence, pad = DEFAULTS.pad, signal = null } = {}) {
  if (!ffmpeg) throw new SubtitlesError('NO_FFMPEG', 'O FFmpeg não foi encontrado. Instale-o e use "Verificar de novo" na aba Ferramentas.');
  pad = limited(pad, LIMITS.pad, DEFAULTS.pad);
  const duration = wavSeconds(wavPath);
  const silences = [];
  let open = null;
  const onLine = (line) => {
    if (line.indexOf('silence_') === -1) return;
    const a = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (a && Number.isFinite(parseFloat(a[1]))) open = parseFloat(a[1]);
    const b = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (b && open !== null && Number.isFinite(parseFloat(b[1]))) {
      silences.push({ start: Math.max(0, open), end: parseFloat(b[1]) });
      open = null;
    }
  };
  const { code, tail } = await runProcess({
    command: ffmpeg,
    args: ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-i', wavPath, '-vn', '-sn', '-dn',
      '-af', silenceFilter({ noiseDb, minSilence }), '-f', 'null', '-'],
    signal,
    onLine
  });
  if (code !== 0) throw new SubtitlesError('DETECT', `A detecção de silêncio falhou: ${tail.trim().split('\n').pop() || `código ${code}`}`);
  if (open !== null) silences.push({ start: Math.max(0, open), end: null }); // silêncio até o fim: só há silence_start
  return { silences, speech: speechFromSilences(silences, duration, { pad }), duration };
}

/** Lê o cabeçalho do WAV: onde ficam os dados e o formato. */
function readWavInfo(fd, fileSize) {
  const head = Buffer.alloc(Math.min(4096, fileSize));
  fs.readSync(fd, head, 0, head.length, 0);
  if (head.length < 12 || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') {
    throw new SubtitlesError('BAD_WAV', 'O áudio de trabalho não é um WAV.');
  }
  let fmt = null;
  let pos = 12;
  while (pos + 8 <= head.length) {
    const id = head.toString('latin1', pos, pos + 4);
    const size = head.readUInt32LE(pos + 4);
    if (id === 'fmt ' && pos + 8 + 16 <= head.length) {
      fmt = { format: head.readUInt16LE(pos + 8), channels: head.readUInt16LE(pos + 10), rate: head.readUInt32LE(pos + 12), bits: head.readUInt16LE(pos + 22) };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16 || !fmt.channels || !fmt.rate) throw new SubtitlesError('BAD_WAV', 'Formato de WAV não suportado para o corte.');
      const offset = pos + 8;
      const bytes = Math.min(size, fileSize - offset); // dado de tamanho "desconhecido" (0xFFFFFFFF) vai até o fim
      return { ...fmt, offset, blockAlign: fmt.channels * 2, samples: Math.floor(bytes / (fmt.channels * 2)) };
    }
    pos += 8 + size + (size % 2);
  }
  throw new SubtitlesError('BAD_WAV', 'WAV sem dados de áudio.');
}

/**
 * Mapa de tempo (cortado -> original) de uma lista de trechos mantidos.
 * @returns {Array<{cutStart:number,cutEnd:number,origStart:number,origEnd:number}>}
 */
function makeTimeMap(ranges) {
  const map = [];
  let cut = 0;
  for (const r of ranges) {
    const len = r.end - r.start;
    if (!(len > 0)) continue;
    map.push({ cutStart: cut, cutEnd: cut + len, origStart: r.start, origEnd: r.end });
    cut += len;
  }
  return map;
}

/**
 * Tempo do áudio cortado -> tempo no original (monotônico não decrescente). Numa fronteira entre trechos,
 * `edge:'start'` (padrão) vale para o início de algo e fica no trecho seguinte; `edge:'end'` vale para o fim de algo
 * e fica no trecho anterior. Fora do intervalo, trava nas pontas.
 */
function mapToOriginal(timeMap, t, { edge = 'start' } = {}) {
  if (!timeMap.length) return Number(t) || 0;
  const time = Number(t);
  const first = timeMap[0];
  const last = timeMap[timeMap.length - 1];
  if (!(time > first.cutStart)) return first.origStart;
  if (time >= last.cutEnd) return last.origEnd;
  let lo = 0;
  let hi = timeMap.length - 1;
  while (lo < hi) { // primeiro trecho cujo fim passa de t (ou alcança, para fins)
    const mid = (lo + hi) >> 1;
    const after = edge === 'end' ? timeMap[mid].cutEnd >= time - EPS : timeMap[mid].cutEnd > time + EPS;
    if (after) hi = mid; else lo = mid + 1;
  }
  const seg = timeMap[lo];
  return Math.min(seg.origEnd, Math.max(seg.origStart, seg.origStart + (time - seg.cutStart)));
}

/**
 * Junta só os trechos de som do WAV (mono/16 bits) num novo WAV.
 * @returns {Promise<{timeMap:Array, duration:number}>} duration: segundos do WAV cortado
 */
async function buildTrimmedWav(wavPath, ranges, outPath, { signal = null } = {}) {
  if (!Array.isArray(ranges) || !ranges.length) throw new SubtitlesError('NO_RANGES', 'Nenhum trecho com som para montar o áudio.');
  const inFd = fs.openSync(wavPath, 'r');
  let outFd = null;
  try {
    const info = readWavInfo(inFd, fs.fstatSync(inFd).size);
    // Trechos em amostras inteiras: o mapa de tempo sai do que foi realmente copiado.
    const snapped = [];
    for (const r of ranges) {
      const s = Math.min(info.samples, Math.max(0, Math.round(r.start * info.rate)));
      const e = Math.min(info.samples, Math.max(0, Math.round(r.end * info.rate)));
      if (e > s) snapped.push({ s, e });
    }
    if (!snapped.length) throw new SubtitlesError('NO_RANGES', 'Nenhum trecho com som dentro do áudio.');

    const totalSamples = snapped.reduce((n, r) => n + (r.e - r.s), 0);
    const dataBytes = totalSamples * info.blockAlign;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVE', 8, 'latin1');
    header.write('fmt ', 12, 'latin1'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(info.channels, 22);
    header.writeUInt32LE(info.rate, 24); header.writeUInt32LE(info.rate * info.blockAlign, 28); header.writeUInt16LE(info.blockAlign, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36, 'latin1'); header.writeUInt32LE(dataBytes, 40);

    outFd = fs.openSync(outPath, 'w');
    fs.writeSync(outFd, header);
    const buf = Buffer.alloc(COPY_CHUNK_BYTES - (COPY_CHUNK_BYTES % info.blockAlign));
    for (const r of snapped) {
      let pos = info.offset + r.s * info.blockAlign;
      let left = (r.e - r.s) * info.blockAlign;
      while (left > 0) {
        if (signal && signal.aborted) throw cancelled();
        const want = Math.min(left, buf.length);
        const got = fs.readSync(inFd, buf, 0, want, pos);
        if (got <= 0) throw new SubtitlesError('BAD_WAV', 'O WAV terminou antes do esperado.');
        fs.writeSync(outFd, buf, 0, got);
        pos += got;
        left -= got;
      }
    }
    const timeMap = makeTimeMap(snapped.map((r) => ({ start: r.s / info.rate, end: r.e / info.rate })));
    return { timeMap, duration: totalSamples / info.rate };
  } catch (err) {
    if (outFd !== null) { try { fs.closeSync(outFd); } catch { /* ignorar */ } outFd = null; }
    try { fs.rmSync(outPath, { force: true }); } catch { /* ignorar */ }
    throw err;
  } finally {
    try { fs.closeSync(inFd); } catch { /* ignorar */ }
    if (outFd !== null) { try { fs.closeSync(outFd); } catch { /* ignorar */ } }
  }
}

/** Leva uma lista de itens {start,end,...} ao tempo original, sem start>end e sem sobreposição. */
function remapItems(items, timeMap, { clampAcross = false } = {}) {
  const out = [];
  let prevEnd = 0;
  for (const it of items) {
    let start = mapToOriginal(timeMap, it.start, { edge: 'start' });
    let end = mapToOriginal(timeMap, it.end, { edge: 'end' });
    if (clampAcross) {
      // Palavra que cruza a emenda entre dois trechos não pode "esticar" por cima do silêncio cortado.
      const seg = timeMap.find((m) => m.origEnd >= start - EPS && m.origStart <= start + EPS && m.origEnd - start > EPS) || null;
      if (seg && end > seg.origEnd) end = seg.origEnd;
    }
    if (start < prevEnd) start = prevEnd;
    if (end < start) end = start;
    out.push({ ...it, start: round3(start), end: round3(Math.max(end, start)) });
    prevEnd = out[out.length - 1].end;
  }
  return out;
}

/** Aplica o mapa de tempo ao resultado de parseWhisperCppJson ({language, segments, words, hasTokens}). */
function remapResult(result, timeMap) {
  if (!timeMap || !timeMap.length) return result;
  return {
    ...result,
    segments: remapItems(result.segments || [], timeMap),
    words: remapItems(result.words || [], timeMap, { clampAcross: true })
  };
}

module.exports = {
  DEFAULTS, LIMITS, silenceFilter, speechFromSilences, analyzeSilence, wavSeconds, buildTrimmedWav, makeTimeMap, mapToOriginal, remapResult, remapItems
};

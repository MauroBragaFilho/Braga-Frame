'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * Forma de onda REAL do áudio do vídeo (dono: review): o ffmpeg decodifica o áudio para PCM de 16 bits
 * mono e o app guarda o pico (valor absoluto máximo, 0 a 255) de cada 10 ms. Esse "mestre" de 100 picos
 * por segundo vai para `<cache>/wf-<hash>.bfwf` (a chave inclui caminho, tamanho e data do arquivo, então
 * mudou o vídeo, recalcula) e cada pedido recebe só o trecho e a resolução que a timeline precisa
 * (redução por máximo). Adaptado da ideia do WaveformService do BDS, bem mais simples: uma faixa (a
 * primeira), sem fila de prioridades.
 */

const SAMPLE_RATE = 8000;
const MASTER_PPS = 100; // picos por segundo (divide 8000: 80 amostras por pico)
const MAX_PEAKS = 3_000_000; // acima disso o mestre é reduzido (vídeos de dezenas de horas)
const MAGIC = 'BFW2'; // BFW2: o áudio que começa depois do vídeo ganha o silêncio do começo (BFW1 não tinha; esses caches são refeitos)
const HEADER_BYTES = 16; // magic(4) | count u32 | pps f64
const STALL_MS = 120_000; // sem nenhuma saída do ffmpeg por tanto tempo = travou
const MAX_CACHE_FILES = 60;
const MAX_HINT_SEC = 7 * 24 * 3600; // `durationHint` acima disso (ou negativo, ou NaN) é lixo e é ignorado: serve só para dimensionar o buffer e o progresso

/** `durationHint` utilizável (segundos, 0 < x <= 7 dias) ou undefined. */
function sanitizeHint(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= MAX_HINT_SEC ? n : undefined;
}

function problem(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

/** Reduz por máximo: cada saída cobre `factor` entradas (preserva os picos, ao contrário da média). */
function poolMax(input, factor) {
  if (factor <= 1) return input;
  const out = new Uint8Array(Math.ceil(input.length / factor));
  for (let i = 0; i < out.length; i++) {
    let max = 0;
    const end = Math.min(input.length, (i + 1) * factor);
    for (let j = i * factor; j < end; j++) if (input[j] > max) max = input[j];
    out[i] = max;
  }
  return out;
}

function encode(peaks, pps) {
  const out = Buffer.allocUnsafe(HEADER_BYTES + peaks.length);
  out.write(MAGIC, 0, 'ascii');
  out.writeUInt32LE(peaks.length, 4);
  out.writeDoubleLE(pps, 8);
  Buffer.from(peaks.buffer, peaks.byteOffset, peaks.length).copy(out, HEADER_BYTES);
  return out;
}

function decode(buf) {
  if (!buf || buf.length < HEADER_BYTES || buf.toString('ascii', 0, 4) !== MAGIC) return null;
  const count = buf.readUInt32LE(4);
  const pps = buf.readDoubleLE(8);
  if (!(pps > 0) || buf.length !== HEADER_BYTES + count) return null;
  return { pps, peaks: new Uint8Array(buf.subarray(HEADER_BYTES)) };
}

/**
 * Recorte [start, end) do mestre em no máximo `buckets` colunas (máximo de cada faixa).
 * Devolve { peaks: number[0..255], start, end, buckets, secPerBucket } com start/end já ajustados ao áudio.
 */
function slicePeaks(master, buckets, start = 0, end = Infinity) {
  const { peaks, pps } = master;
  const total = peaks.length;
  const from = Math.min(total, Math.max(0, Math.floor((Number.isFinite(start) ? start : 0) * pps)));
  const to = Math.min(total, Math.max(from, Math.ceil((Number.isFinite(end) ? end : total / pps) * pps)));
  const span = to - from;
  const n = Math.max(0, Math.min(Math.floor(buckets), span));
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = from + Math.floor((i * span) / n);
    const b = Math.max(a + 1, from + Math.floor(((i + 1) * span) / n));
    let max = 0;
    for (let j = a; j < b && j < total; j++) if (peaks[j] > max) max = peaks[j];
    out[i] = max;
  }
  return { peaks: out, start: from / pps, end: to / pps, buckets: n, secPerBucket: n ? span / pps / n : 0 };
}

class WaveformService {
  /**
   * @param {object} opts { getFfmpeg(): caminho do ffmpeg ou null, cacheDir, maxCacheFiles?, log?(nivel, msg) }
   */
  constructor({ getFfmpeg, cacheDir, maxCacheFiles = MAX_CACHE_FILES, log = () => {} }) {
    this.getFfmpeg = getFfmpeg;
    this.cacheDir = cacheDir;
    this.maxCacheFiles = maxCacheFiles;
    this.log = log;
    this.inflight = new Map(); // chave -> { promise, abort, sourcePath, waiters }
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  _key(sourcePath) {
    let stat;
    try { stat = fs.statSync(sourcePath); } catch {
      throw problem('INPUT_MISSING', `O arquivo de vídeo não foi encontrado: ${sourcePath}. Confira se ele não foi movido ou apagado.`);
    }
    if (!stat.isFile()) throw problem('INPUT_MISSING', `Este caminho não é um arquivo de vídeo: ${sourcePath}`);
    const hash = crypto.createHash('sha1').update(`${path.resolve(sourcePath)}|${stat.size}|${Math.round(stat.mtimeMs)}`).digest('hex').slice(0, 24);
    return { hash, file: path.join(this.cacheDir, `wf-${hash}.bfwf`) };
  }

  _readCache(file) {
    try {
      const decoded = decode(fs.readFileSync(file));
      if (decoded) return decoded;
      this.log('warn', `waveform: cache inválido (${path.basename(file)}), será refeito`);
      fs.rmSync(file, { force: true });
    } catch (err) {
      if (err.code !== 'ENOENT') this.log('warn', `waveform: não foi possível ler o cache: ${err.message}`);
    }
    return null;
  }

  _writeCache(file, master) {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, encode(master.peaks, master.pps));
      fs.renameSync(tmp, file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      this.log('warn', `waveform: não foi possível guardar o cache: ${err.message}`); // o resultado ainda vale
      return;
    }
    this._prune();
  }

  /** O cache é só aceleração (regerável): guarda no máximo `maxCacheFiles`, apagando os menos recentes. */
  _prune() {
    try {
      const files = fs.readdirSync(this.cacheDir).filter((f) => /^wf-[0-9a-f]+\.bfwf$/.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join(this.cacheDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const old of files.slice(this.maxCacheFiles)) fs.rmSync(path.join(this.cacheDir, old.f), { force: true });
    } catch { /* limpeza é opcional */ }
  }

  /** Decodifica o áudio e calcula o mestre. `onProgress(0..1)` só se `durationHint` for conhecida. */
  _decode(sourcePath, { signal, durationHint, onProgress }) {
    const ffmpeg = this.getFfmpeg();
    if (!ffmpeg) {
      return Promise.reject(problem('NO_FFMPEG', 'ffmpeg não encontrado, então a forma de onda não pode ser calculada. Instale o FFmpeg e deixe-o no PATH (ou defina CORTE_FFMPEG) e use "Verificar de novo". A timeline continua funcionando sem a onda.'));
    }
    const samplesPerPeak = SAMPLE_RATE / MASTER_PPS;
    const hint = sanitizeHint(durationHint);
    // aresample async=1 + first_pts=0: se o áudio começa depois do vídeo (start_time > 0), o começo vira silêncio e a onda cai no
    // mesmo eixo de tempo do player; sem isso o PCM começaria na primeira amostra e a onda ficaria adiantada pelo atraso do áudio
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', sourcePath, '-map', '0:a:0', '-vn', '-sn', '-dn',
      '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'];
    // o buffer nasce ANTES do ffmpeg: se a alocação falhar não sobra processo filho sem dono
    let capacity = Math.min(MAX_PEAKS + 64, Math.max(4096, Math.ceil((hint || 60) * MASTER_PPS * 1.02) + 64));
    let peaks;
    try {
      peaks = new Uint8Array(capacity);
    } catch (err) {
      return Promise.reject(problem('WAVEFORM_FAILED', `Não há memória suficiente para calcular a forma de onda deste vídeo (${err.message}). Feche outros programas e tente de novo; a timeline continua funcionando sem a onda.`));
    }
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let count = 0;
      let max = 0;
      let inPeak = 0;
      let carry = -1;
      let stderr = '';
      let settled = false;
      let stallTimer = null;
      let lastProgress = 0;

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(stallTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (err) reject(err); else resolve(value);
      };
      const kill = () => { try { child.kill('SIGKILL'); } catch { /* já terminou */ } };
      const armStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => { kill(); finish(problem('WAVEFORM_FAILED', 'O ffmpeg parou de responder ao calcular a forma de onda. Tente de novo; se persistir, o arquivo pode estar corrompido ou numa unidade lenta.')); }, STALL_MS);
      };
      const onAbort = () => { kill(); finish(problem('CANCELLED', 'O cálculo da forma de onda foi cancelado.')); };

      const push = (value) => {
        if (count === capacity) {
          capacity *= 2;
          const bigger = new Uint8Array(capacity);
          bigger.set(peaks);
          peaks = bigger;
        }
        peaks[count++] = value;
      };
      // qualquer exceção ao processar a saída (ex.: sem memória para crescer o buffer) encerra o ffmpeg e rejeita com causa e solução
      const guard = (fn) => (...a) => {
        try { fn(...a); } catch (err) {
          kill();
          finish(problem('WAVEFORM_FAILED', `Não foi possível calcular a forma de onda: ${err.message}. A timeline continua funcionando sem a onda.`));
        }
      };
      const sample = (v) => {
        const abs = v < 0 ? -v : v;
        if (abs > max) max = abs;
        if (++inPeak >= samplesPerPeak) { push(Math.min(255, Math.round((max / 32768) * 255))); max = 0; inPeak = 0; }
      };

      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      armStall();
      child.on('error', (err) => finish(problem('WAVEFORM_FAILED', `Não foi possível executar o ffmpeg: ${err.message}`)));
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
      child.stdout.on('data', guard((buf) => {
        armStall();
        let i = 0;
        if (carry >= 0) { sample(((carry | (buf[0] << 8)) << 16) >> 16); carry = -1; i = 1; }
        for (; i + 1 < buf.length; i += 2) sample(buf.readInt16LE(i));
        if (i < buf.length) carry = buf[i];
        if (onProgress && hint) {
          const t = Date.now();
          if (t - lastProgress > 250) { lastProgress = t; onProgress(Math.min(0.99, count / (hint * MASTER_PPS))); }
        }
      }));
      child.on('close', guard((code) => {
        if (settled) return;
        if (inPeak > 0) push(Math.min(255, Math.round((max / 32768) * 255)));
        if (count === 0) {
          const noAudio = /matches no streams|does not contain any stream|Stream map/i.test(stderr) || code === 0;
          finish(problem(noAudio ? 'NO_AUDIO' : 'WAVEFORM_FAILED', noAudio
            ? 'Este vídeo não tem faixa de áudio, então não há forma de onda para desenhar. A timeline continua funcionando, só sem a onda.'
            : `O ffmpeg não conseguiu ler o áudio (código ${code}): ${stderr.trim().split('\n').pop() || 'sem detalhes'}`));
          return;
        }
        if (code !== 0 && count < 10) {
          finish(problem('WAVEFORM_FAILED', `O ffmpeg terminou com erro ao ler o áudio (código ${code}): ${stderr.trim().split('\n').pop() || 'sem detalhes'}`));
          return;
        }
        let master = { pps: MASTER_PPS, peaks: peaks.slice(0, count), partial: code !== 0 };
        if (master.peaks.length > MAX_PEAKS) {
          const factor = Math.ceil(master.peaks.length / MAX_PEAKS);
          master = { pps: MASTER_PPS / factor, peaks: poolMax(master.peaks, factor), partial: master.partial };
        }
        if (onProgress) onProgress(1);
        finish(null, master);
      }));
    });
  }

  /** Mestre do vídeo: do cache ou calculado (um só cálculo por vez por vídeo, pedidos repetidos esperam o mesmo). */
  async master(sourcePath, { durationHint, onProgress } = {}) {
    const { hash, file } = this._key(sourcePath);
    const cached = this._readCache(file);
    if (cached) return { ...cached, cached: true };
    let job = this.inflight.get(hash);
    if (!job) {
      const controller = new AbortController();
      const waiters = new Set();
      job = { sourcePath, controller, waiters, promise: null };
      job.promise = this._decode(sourcePath, {
        signal: controller.signal, durationHint,
        onProgress: (p) => { for (const fn of [...waiters]) fn(p); }
      }).then((master) => { if (!master.partial) this._writeCache(file, master); return master; }).finally(() => { this.inflight.delete(hash); });
      this.inflight.set(hash, job);
    }
    if (onProgress) job.waiters.add(onProgress);
    try {
      return { ...(await job.promise), cached: false };
    } finally {
      if (onProgress) job.waiters.delete(onProgress);
    }
  }

  /**
   * Picos de um trecho: { duration, start, end, buckets, secPerBucket, peaks, cached }.
   * `buckets` = quantas colunas a tela tem para o trecho [start, end) (padrão: o vídeo todo).
   */
  async peaks({ sourcePath, buckets = 1000, start = 0, end = Infinity, durationHint, onProgress }) {
    const master = await this.master(sourcePath, { durationHint, onProgress });
    return { duration: master.peaks.length / master.pps, masterPps: master.pps, cached: master.cached, partial: Boolean(master.partial), ...slicePeaks(master, buckets, start, end) };
  }

  /** Cancela o cálculo em andamento deste vídeo (quem esperava recebe CANCELLED). */
  cancel(sourcePath) {
    let cancelled = false;
    for (const job of this.inflight.values()) {
      if (job.sourcePath === sourcePath) { job.controller.abort(); cancelled = true; }
    }
    return cancelled;
  }

  /** Cancela tudo (ao fechar o app). */
  cancelAll() {
    for (const job of this.inflight.values()) job.controller.abort();
  }
}

module.exports = { WaveformService, slicePeaks, poolMax, encode, decode, sanitizeHint, MASTER_PPS, SAMPLE_RATE, MAX_PEAKS, MAX_HINT_SEC };

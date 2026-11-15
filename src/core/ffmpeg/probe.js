'use strict';

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const { promisify } = require('node:util');

const execFileP = promisify(execFile);

const PROBE_TIMEOUT_MS = 30000;
const SCAN_TIMEOUT_MS = 120000;
const HEAD = 'Não foi possível ler o vídeo';

function probeError(code, message, details) {
  const e = new Error(message);
  e.code = code;
  if (details) e.details = details;
  return e;
}

/**
 * Traduz a falha do ffprobe para uma mensagem em português com causa e solução. O texto técnico do ffprobe (em inglês, com a
 * linha de comando e os caminhos) NÃO vai para a mensagem: fica em `details.raw` para quem quiser investigar.
 */
function explainFailure(err) {
  const stderr = String((err && err.stderr) || '');
  const raw = (stderr || String((err && err.message) || '')).replace(/\s+$/, '').slice(-2000);
  let why;
  if (err && err.code === 'ENOENT') {
    why = 'não foi possível executar o ffprobe (o programa não está mais no lugar indicado). Use "Verificar de novo" no aviso do topo ou reinstale o FFmpeg.';
  } else if (err && (err.killed || err.signal === 'SIGTERM')) {
    why = `a leitura demorou mais de ${PROBE_TIMEOUT_MS / 1000} s e foi interrompida. Confira se o disco ou a rede está respondendo e tente de novo.`;
  } else if (/No such file or directory/i.test(stderr)) {
    why = 'o arquivo não foi encontrado. Confira se ele não foi movido, renomeado ou apagado.';
  } else if (/Permission denied|Is a directory/i.test(stderr)) {
    why = 'este caminho não pôde ser aberto como arquivo (é uma pasta ou o acesso foi negado). Escolha o arquivo do vídeo e confira se você tem permissão para lê-lo.';
  } else if (/moov atom not found|Invalid data found|End of file|truncated|could not find codec parameters|Invalid argument/i.test(stderr)) {
    why = 'o arquivo não parece ser um vídeo válido ou está incompleto (por exemplo, uma gravação que ainda não terminou, foi interrompida ou foi baixada pela metade). Espere a gravação ou o download terminar, ou use uma cópia íntegra, e tente de novo.';
  } else {
    why = 'o ffprobe não reconheceu o conteúdo do arquivo. Confira se ele não está danificado nem em uso exclusivo por outro programa e tente de novo.';
  }
  return probeError('PROBE_FAILED', `${HEAD}: ${why}`, { raw });
}

/** "00:01:02.500000000" (tag DURATION do Matroska) -> segundos; 0 se não for um relógio. */
function parseClock(text) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(String(text || '').trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

/** Duração que o próprio arquivo declara: a do contêiner, senão a maior dos fluxos (campo ou tag DURATION). 0 = não declara. */
function declaredDuration(data) {
  const fromFormat = Number(data.format && data.format.duration);
  if (fromFormat > 0) return { seconds: fromFormat, source: 'format' };
  let best = parseClock(data.format && data.format.tags && (data.format.tags.DURATION || data.format.tags.duration));
  for (const stream of data.streams || []) {
    best = Math.max(best, Number(stream.duration) || 0);
    const tags = stream.tags || {};
    best = Math.max(best, parseClock(tags.DURATION || tags['DURATION-eng'] || tags.duration));
  }
  return best > 0 ? { seconds: best, source: 'stream' } : { seconds: 0, source: 'unknown' };
}

const scanCache = new Map(); // arquivo|tamanho|data -> segundos (só resultados bons)
const SCAN_CACHE_MAX = 20;

/**
 * Descobre a duração lendo os pacotes de vídeo do arquivo inteiro. É o último recurso para arquivos que não gravam a
 * duração no cabeçalho (MKV/WebM escritos em tempo real e nunca finalizados, como a gravação que ficou aberta quando o
 * programa caiu): custa uma leitura completa do arquivo, por isso só roda quando todo o resto falhou e o resultado
 * fica em memória. Devolve 0 se não conseguiu (tempo esgotado, nenhum pacote).
 */
function scanDuration(ffprobePath, filePath, { timeoutMs = SCAN_TIMEOUT_MS } = {}) {
  let key = null;
  try {
    const stat = fs.statSync(filePath);
    key = `${filePath}|${stat.size}|${stat.mtimeMs}`;
    if (scanCache.has(key)) return Promise.resolve(scanCache.get(key));
  } catch { /* o ffprobe explica */ }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', filePath],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { resolve(0); return; }
    let end = 0;
    let rest = '';
    let timedOut = false;
    const take = (line) => {
      const [pts, dur] = line.split(',');
      const t = Number.parseFloat(pts);
      if (Number.isFinite(t)) end = Math.max(end, t + (Number.parseFloat(dur) || 0));
    };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.setEncoding('latin1');
    child.stdout.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) take(line);
    });
    const finish = () => {
      clearTimeout(timer);
      if (rest) take(rest);
      rest = '';
      const seconds = !timedOut && end > 0 ? end : 0;
      if (seconds > 0 && key) {
        if (scanCache.size >= SCAN_CACHE_MAX) scanCache.delete(scanCache.keys().next().value);
        scanCache.set(key, seconds);
      }
      resolve(seconds);
    };
    child.once('error', finish);
    child.once('close', finish);
  });
}

/**
 * Analisa um arquivo com ffprobe (adaptado do FFProbe do BDS, sem cache nem logger).
 * Duração: a do contêiner; se o arquivo não a declara, a dos fluxos; por último (opts.scan !== false) a leitura dos pacotes.
 * `durationSource` diz de onde veio ('format' | 'stream' | 'scan' | 'unknown'); 'unknown' devolve duration 0 e quem chama decide.
 */
async function probeMedia(ffprobePath, filePath, opts = {}) {
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath];
  let data;
  try {
    const { stdout } = await execFileP(ffprobePath, args, { maxBuffer: 10 * 1024 * 1024, timeout: PROBE_TIMEOUT_MS, windowsHide: true });
    data = JSON.parse(stdout);
  } catch (err) {
    throw explainFailure(err);
  }
  const video = (data.streams || []).find((s) => s.codec_type === 'video');
  const audioStreams = (data.streams || []).filter((s) => s.codec_type === 'audio');
  const audio = audioStreams[0];
  if (!video) throw probeError('NO_VIDEO', 'O arquivo não contém vídeo (só áudio ou outro conteúdo). Escolha um arquivo de vídeo.');
  let fps = 0;
  if (video.r_frame_rate) {
    const [n, d] = video.r_frame_rate.split('/');
    fps = d && Number(d) ? Number(n) / Number(d) : 0;
  }
  let { seconds: duration, source: durationSource } = declaredDuration(data);
  if (!duration && opts.scan !== false) {
    duration = await scanDuration(ffprobePath, filePath, { timeoutMs: opts.scanTimeoutMs });
    if (duration > 0) durationSource = 'scan';
  }
  return {
    duration,
    durationSource,
    width: video.width || 0,
    height: video.height || 0,
    fps: Math.round(fps * 100) / 100,
    videoCodec: video.codec_name || null,
    audioCodec: audio ? audio.codec_name : null,
    hasAudio: Boolean(audio),
    audioTracks: audioStreams.length, // faixas de áudio (a exportação usa só a primeira: o QC avisa quando há mais)
    colorTransfer: video.color_transfer || null, // 'smpte2084' (HDR10) e 'arib-std-b67' (HLG) = HDR
    bitrate: Number(data.format?.bit_rate) || 0,
    size: Number(data.format?.size) || 0
  };
}

module.exports = { probeMedia, scanDuration, explainFailure, declaredDuration, PROBE_TIMEOUT_MS };

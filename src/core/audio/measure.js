'use strict';

const { spawn } = require('node:child_process');

class AudioError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AudioError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const KEEP_HEAD = 12000; // a lista de fluxos de entrada fica no começo da saída do ffmpeg
const KEEP_TAIL = 12000; // o resultado do volumedetect fica no fim

/** Valor em dB do volumedetect ("-18.3", "-inf") -> número finito ou null. */
function parseDb(text) {
  if (text === undefined) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * Lê a saída (stderr) do ffmpeg com `-af volumedetect`. Devolve:
 *   { hasAudio, samples, peakDb, meanDb }
 * hasAudio vem da lista de fluxos da entrada; peakDb/meanDb são null quando o trecho não tem amostras.
 * O pico é o pico de amostra (max_volume), não o "true peak": picos entre amostras podem ser um pouco maiores.
 */
function parseVolumeDetect(stderr) {
  // o ffmpeg imprime "n_samples: 0" ao montar o filtro e o resultado de verdade no fim: vale a última ocorrência
  const last = (source) => {
    const matches = [...stderr.matchAll(new RegExp(source, 'gi'))];
    return matches.length ? matches[matches.length - 1][1] : undefined;
  };
  const samples = last('n_samples:\\s*(\\d+)');
  return {
    hasAudio: /Stream #\d+:\d+[^\n]*: Audio:/.test(stderr),
    samples: samples === undefined ? 0 : Number(samples),
    peakDb: parseDb(last('max_volume:\\s*(-?[\\d.]+|-?inf)\\s*dB')),
    meanDb: parseDb(last('mean_volume:\\s*(-?[\\d.]+|-?inf)\\s*dB'))
  };
}

const READ_PREFIX = 'O ffmpeg não conseguiu ler o áudio deste trecho';

/**
 * Causa provável de uma falha de leitura, em português e com o que fazer (a saída do ffmpeg vem em inglês e fica só
 * em `details`). A ordem importa: permissão e arquivo ausente antes de "corrompido", que é o caso mais comum.
 */
function describeReadFailure(output) {
  const text = String(output || '');
  if (/permission denied|access is denied|being used by another process|sharing violation/i.test(text)) {
    return `${READ_PREFIX}: sem permissão para ler o arquivo, ou ele está em uso por outro programa. Feche o programa que o está usando, confira as permissões do arquivo e tente de novo.`;
  }
  if (/no such file or directory|cannot find the (file|path)|is a directory/i.test(text)) {
    return `${READ_PREFIX}: o arquivo não foi encontrado (foi movido ou apagado?). Reabra o vídeo pelo app.`;
  }
  if (/decoder .{0,80}not found|unknown decoder|unsupported codec|codec not currently supported|unrecognized codec/i.test(text)) {
    return `${READ_PREFIX}: o áudio está em um formato que o ffmpeg não reconhece. Confira se o vídeo toca no player; se tocar, converta o arquivo para MP4 com áudio AAC e abra de novo.`;
  }
  if (/invalid data found|moov atom not found|could not find codec parameters|end of file|trunc\w*|corrupt|invalid sample rate|error while decoding/i.test(text)) {
    return `${READ_PREFIX}: o arquivo parece corrompido ou incompleto (gravação interrompida?). Confira se ele abre no player: se abrir, reabra o vídeo no app; se não abrir, ele precisa ser regravado ou recuperado.`;
  }
  return `${READ_PREFIX}. Confira se o arquivo abre no player e reabra o vídeo no app; se o problema continuar, o arquivo pode estar com defeito.`;
}

/** Falha ao iniciar o processo do ffmpeg (Node devolve `ENOENT`, `EACCES`…): causa e solução em português. */
function describeStartFailure(err, ffmpeg) {
  const code = err && err.code;
  if (code === 'ENOENT') return `O ffmpeg não foi encontrado em “${ffmpeg}” (foi movido ou desinstalado?). Instale-o de novo e use “Verificar de novo” no aviso do topo.`;
  if (code === 'EACCES' || code === 'EPERM') return `O Windows não deixou iniciar o ffmpeg em “${ffmpeg}” (sem permissão ou bloqueado pelo antivírus). Libere o arquivo e use “Verificar de novo” no aviso do topo.`;
  return `Não foi possível iniciar o ffmpeg (${code || 'erro desconhecido'}). Use “Verificar de novo” no aviso do topo; se continuar, reinstale o FFmpeg.`;
}

/** Argumentos do ffmpeg que decodificam só o áudio do trecho, medem e descartam o resultado. */
function measureArgs({ sourcePath, start, end }) {
  return [
    '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info',
    '-ss', start.toFixed(3), '-to', end.toFixed(3), '-i', sourcePath,
    '-map', '0:a:0?', '-vn', '-sn', '-dn', // a mesma faixa que a exportação usa (a primeira de áudio)
    '-af', 'volumedetect',
    '-f', 'null', '-'
  ];
}

/**
 * Mede o trecho [start, end] do áudio da fonte (somente leitura; nada é gravado). Mede a primeira faixa de
 * áudio (0:a:0), a mesma que a exportação usa.
 *
 * @param {object} o { ffmpeg, sourcePath, start, end, signal?, timeoutMs? }
 * @returns {Promise<{hasAudio:boolean, samples:number, peakDb:number|null, meanDb:number|null, start:number, end:number}>}
 * @throws AudioError: NO_FFMPEG, INVALID_RANGE, MEASURE_TIMEOUT, CANCELLED, MEASURE_FAILED
 */
function measureAudio({ ffmpeg, sourcePath, start, end, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!ffmpeg) {
    return Promise.reject(new AudioError('NO_FFMPEG', 'FFmpeg não encontrado, então não dá para medir o áudio. Instale o FFmpeg (ffmpeg.org/download.html), deixe-o no PATH e use “Verificar de novo” no aviso do topo.'));
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    return Promise.reject(new AudioError('INVALID_RANGE', 'O trecho a medir é inválido: o fim precisa ser maior que o início.'));
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpeg, measureArgs({ sourcePath, start, end }), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      reject(new AudioError('MEASURE_FAILED', describeStartFailure(err, ffmpeg), { cause: String(err && err.message) }));
      return;
    }
    let head = '';
    let tail = '';
    let settled = false;
    let timer = null;
    let reason = null; // 'timeout' | 'cancelled'

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const kill = (why) => { reason = reason || why; try { child.kill(); } catch { /* já terminou */ } };
    const onAbort = () => kill('cancelled');

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (head.length < KEEP_HEAD) head += chunk.slice(0, KEEP_HEAD - head.length);
      tail = (tail + chunk).slice(-KEEP_TAIL);
    });
    child.on('error', (err) => finish(reject, new AudioError('MEASURE_FAILED', describeStartFailure(err, ffmpeg), { cause: String(err && err.message) })));
    child.on('close', (code) => {
      if (reason === 'cancelled') return finish(reject, new AudioError('CANCELLED', 'Medição cancelada.'));
      if (reason === 'timeout') return finish(reject, new AudioError('MEASURE_TIMEOUT', 'A medição do áudio demorou demais e foi interrompida. Tente um trecho menor.'));
      const output = `${head}\n${tail}`;
      const parsed = parseVolumeDetect(output);
      const opened = /Input #0/.test(output); // o ffmpeg chegou a ler o arquivo
      if (opened && !parsed.hasAudio) return finish(resolve, { hasAudio: false, samples: 0, peakDb: null, meanDb: null, start, end });
      if (code !== 0 || !opened) {
        // o texto do ffmpeg (em inglês) fica só em `details`; a mensagem para a tela é a causa provável e o que fazer
        const lines = tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        return finish(reject, new AudioError('MEASURE_FAILED', describeReadFailure(tail), { exitCode: code, ffmpeg: lines.slice(-1)[0] || `código ${code}`, stderr: tail.slice(-2000) }));
      }
      return finish(resolve, { ...parsed, start, end });
    });

    if (signal) {
      if (signal.aborted) kill('cancelled'); else signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => kill('timeout'), timeoutMs);
  });
}

module.exports = { measureAudio, parseVolumeDetect, measureArgs, describeReadFailure, describeStartFailure, AudioError };

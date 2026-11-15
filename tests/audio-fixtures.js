'use strict';

/**
 * Ajudantes dos testes de áudio: geram mídia de verdade com o ffmpeg (nada de simulação) e medem com a
 * mesma ferramenta de produção (src/core/audio/measure.js).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { locateTools } = require('../src/core/ffmpeg/locate');
const { measureAudio } = require('../src/core/audio/measure');

const tools = locateTools();

/** Pico (dBFS) do `sine` do ffmpeg: amplitude 1/8. A média (RMS) de uma senoide fica 3 dB abaixo do pico. */
const SINE_PEAK_DB = 20 * Math.log10(0.125);
const SINE_MEAN_DB = SINE_PEAK_DB - 3.0103;

const tmpDir = (name = 'audio') => fs.mkdtempSync(path.join(os.tmpdir(), `bf-${name}-`));
const removeDir = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

function run(args) {
  execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
}

/** WAV de 16 bits só com uma senoide de 440 Hz (nível constante: dá para prever as medidas). */
function makeTone(file, { seconds = 10, volumeDb = 0, freq = 440 } = {}) {
  run(['-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=${seconds}`, '-af', `volume=${volumeDb}dB`, '-c:a', 'pcm_s16le', file]);
  return file;
}

/** MP4 de verdade (vídeo H.264 + áudio AAC com a senoide), como as gravações do OBS. `audio:false` gera sem áudio. */
function makeVideo(file, { seconds = 10, volumeDb = 0, audio = true, size = '320x180', rate = 15 } = {}) {
  const args = ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`, '-af', `volume=${volumeDb}dB`, '-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-shortest', file);
  run(args);
  return file;
}

/**
 * Exporta o trecho como a exportação real faz (`-ss` e `-to` ANTES do `-i`), aplicando `filter` quando houver.
 * Saída em WAV (sem perdas) por padrão, ou o que `extra` pedir.
 */
function exportAudio(source, out, { start, end, filter = null, extra = ['-c:a', 'pcm_s16le'], outputSeek = false }) {
  const input = outputSeek ? ['-i', source, '-ss', String(start), '-to', String(end)] : ['-ss', String(start), '-to', String(end), '-i', source];
  run([...input, '-vn', ...(filter ? ['-af', filter] : []), ...extra, out]);
  return out;
}

/** Mede o arquivo (ou um trecho dele) com o volumedetect de produção. */
function measure(file, start = 0, end = 3600) {
  return measureAudio({ ffmpeg: tools.ffmpeg, sourcePath: file, start, end });
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Duração (s) do arquivo, lida com o ffprobe. */
function duration(file) {
  const out = execFileSync(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8', windowsHide: true });
  return Number(out.trim());
}

module.exports = { tools, SINE_PEAK_DB, SINE_MEAN_DB, tmpDir, removeDir, makeTone, makeVideo, exportAudio, measure, sha256, duration };

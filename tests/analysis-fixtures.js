'use strict';

/**
 * Mídia e chat SINTÉTICOS de verdade para os testes da análise (nada de mock do que está sendo testado):
 * o ffmpeg gera vídeo com luminância e áudio controlados em instantes conhecidos.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { locateTools } = require('../src/core/ffmpeg/locate');

const tools = locateTools();
const skipMedia = !tools.ffmpeg || !tools.ffprobe ? 'ffmpeg/ffprobe não encontrados' : false;

const mkTmp = (name = 'analysis') => fs.mkdtempSync(path.join(os.tmpdir(), `bf-${name}-`));

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const leftovers = new Set();
process.on('exit', () => {
  for (const dir of leftovers) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* resta em %TEMP% (pasta bf-*) */ } }
});

/**
 * Apaga a pasta temporária do teste. No Windows, com o computador ocupado, um ffmpeg recém-encerrado ou o antivírus
 * ainda podem segurar um arquivo por alguns segundos (EPERM/EBUSY): tenta de novo por até 20 s. Se continuar preso,
 * não derruba o teste (a limpeza não é o que está sendo testado): avisa e tenta de novo ao encerrar o processo.
 */
function rmrf(dir) {
  const end = Date.now() + 20000;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes(err.code)) throw err;
      if (Date.now() > end) {
        leftovers.add(dir);
        console.warn(`# aviso: não foi possível apagar ${dir} agora (${err.code}); nova tentativa ao encerrar`);
        return;
      }
      sleepSync(400);
    }
  }
}

// ruído branco com amplitude 1 tem RMS 1/sqrt(3) = -4,77 dBFS; o ganho leva ao nível desejado
const gainFor = (db) => Math.pow(10, (db + 4.77) / 20);

/**
 * Gera um MP4.
 *  seconds, size, rate, gop
 *  audio: null (sem faixa) | { baseDb, bursts:[{ at, dur, db }], wobbleDb }  (wobbleDb: variação lenta do fundo)
 *  luma:  { base, steps:[{ at, level }], flashes:[{ at, dur, level }], noise:[{ at, dur }] }  (luminância 0..255 do
 *         quadro todo; noise = chuvisco aleatório = movimento contínuo e intenso)
 *  motion: true -> troca o fundo por padrão em movimento constante (testsrc2)
 */
function makeMedia(file, { seconds = 60, size = '160x90', rate = 10, gop = 20, audio = null, luma = { base: 60 }, motion = false } = {}) {
  const inputs = [];
  if (motion) {
    inputs.push('-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`);
  } else {
    let expr = String(luma.base ?? 60);
    for (const step of luma.steps || []) expr = `if(gte(T,${step.at}),${step.level},${expr})`;
    for (const f of luma.flashes || []) expr = `if(between(T,${f.at},${f.at + f.dur}),${f.level},${expr})`;
    for (const z of luma.noise || []) expr = `if(between(T,${z.at},${z.at + z.dur}),random(1)*255,${expr})`;
    inputs.push('-f', 'lavfi', '-i', `color=c=black:s=${size}:r=${rate}:d=${seconds},format=gray,geq=lum='${expr}'`);
  }
  if (audio) {
    const base = gainFor(audio.baseDb ?? -50);
    let gain = String(base);
    for (const b of audio.bursts || []) gain += `+${gainFor(b.db) - base}*between(t,${b.at},${b.at + b.dur})`;
    const wobble = audio.wobbleDb ? `*pow(10,${audio.wobbleDb}*sin(t*1.7)/20)` : '';
    inputs.push('-f', 'lavfi', '-i', `anoisesrc=d=${seconds}:c=white:r=44100:a=1,volume='(${gain})${wobble}':eval=frame,aformat=channel_layouts=mono`);
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-y', ...inputs,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-g', String(gop)];
  if (audio) args.push('-c:a', 'aac', '-b:a', '96k', '-shortest');
  args.push(file);
  execFileSync(tools.ffmpeg, args, { windowsHide: true });
  return file;
}

/**
 * Áudio (m4a, sem imagem) de FALA COM PORTA DE RUÍDO, como o microfone de uma live: `onSec` de fala a `speakDb`, `offSec` de silêncio digital,
 * `silentUntil` segundos de silêncio no começo e `shouts` ([{ at, dur }]) trechos de grito a `shoutDb`. Serve para provar que de silêncio para
 * fala NÃO é destaque (a linha de base antiga saturava em cada início de frase) e que um grito de verdade é.
 */
function makeGatedAudio(file, { seconds = 120, speakDb = -32, shoutDb = -16, onSec = 3, offSec = 3, silentUntil = 0, shouts = [] } = {}) {
  const speak = gainFor(speakDb);
  const shout = gainFor(shoutDb);
  const sh = shouts.length ? shouts.map((x) => `between(t,${x.at},${x.at + (x.dur ?? 6)})`).join('+') : '0';
  const expr = `(${speak}*gt(t,${silentUntil})*lt(mod(t,${onSec + offSec}),${onSec}))*(1-(${sh}))+${shout}*(${sh})`;
  execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `anoisesrc=d=${seconds}:c=white:r=44100:a=1,volume='${expr}':eval=frame,aformat=channel_layouts=mono`,
    '-c:a', 'aac', '-b:a', '96k', file], { windowsHide: true });
  return file;
}

/** Gerador pseudo-aleatório determinístico (LCG): os testes não variam de uma execução para outra. */
function rng(seed = 7) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * Chat bf-chat-1 sintético: taxa de base (msg/s) e rajadas { at, dur, rate, text? } em instantes conhecidos.
 * `extra` mensagens avulsas: [{ t, text, user }].
 */
function makeChat(file, { duration = 60, baseRate = 0.3, bursts = [], extra = [], seed = 7, platform = 'twitch' } = {}) {
  const rand = rng(seed);
  const words = ['boa', 'vai', 'nossa', 'jogando bem', 'oi', 'lag?', 'qual jogo', 'haha', 'ata'];
  const messages = [];
  const emit = (t, text, user) => messages.push({ t: Math.round(t * 1000) / 1000, user: user || `user${Math.floor(rand() * 40)}`, text: text || words[Math.floor(rand() * words.length)] });
  for (let t = 0; t < duration; t += 0.5) {
    if (rand() < baseRate * 0.5) emit(t + rand() * 0.5);
  }
  for (const b of bursts) {
    const count = Math.round(b.dur * b.rate);
    for (let i = 0; i < count; i += 1) emit(b.at + (i / count) * b.dur, b.text);
  }
  for (const m of extra) emit(m.t, m.text, m.user);
  messages.sort((a, b) => a.t - b.t);
  fs.writeFileSync(file, JSON.stringify({ format: 'bf-chat-1', platform, videoId: 'teste', messages }));
  return messages.length;
}

/** A sugestão cobre o instante `t` (com folga `tol` em segundos)? */
const covers = (s, t, tol = 0) => s.start - tol <= t && t <= s.end + tol;
/** Alguma sugestão cujo pico está a até `tol` s de `t`. */
const peakNear = (list, t, tol) => list.find((s) => Math.abs(s.peak - t) <= tol);

module.exports = { tools, skipMedia, mkTmp, rmrf, makeMedia, makeGatedAudio, makeChat, rng, covers, peakNear, gainFor };

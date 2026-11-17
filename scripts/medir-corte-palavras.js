#!/usr/bin/env node
'use strict';

/**
 * Mede o AJUSTE ÀS PALAVRAS (src/core/analysis/words.js) com fala de verdade: o Whisper real transcreve trechos de uma live e o script sorteia cortes,
 * ajusta o início e o fim de três jeitos e confere, no ÁUDIO (e não nas palavras do próprio Whisper, que seria circular), quantas bordas caem
 * no meio de voz:
 *   A  sem ajuste (a borda sorteada)
 *   B  ajuste às falas (o que o app fazia antes: snapStart/snapEnd de src/core/analysis/ai/verify.js)
 *   C  ajuste às palavras (o novo: snapWithin)
 * Uma borda "corta voz" quando o nível do áudio (RMS de 20 ms, ±40 ms em volta da borda) passa de --threshold dBFS. Vale para uma fonte com
 * porta de ruído no microfone (o nível cai a -90 dB ou menos entre as frases: o caso da live de referência); numa fonte com música ou jogo ao fundo
 * o nível nunca cai e a medida não serve.
 *
 *   node scripts/medir-corte-palavras.js --video <arquivo> --whisper <whisper-cli.exe> --model <modelo.bin> --ffmpeg <ffmpeg.exe>
 *        [--cuda] [--segments 10] [--per 40] [--len 120] [--threshold -50] [--from 600] [--to <seg>] [--json]
 * Os caminhos nunca ficam no repositório (vídeo e modelo são do dono). Usa o mesmo motor das Legendas (generateSubtitles, returnWords).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { generateSubtitles } = require('../src/core/subtitles/generate');
const { snapStart, snapEnd } = require('../src/core/analysis/ai/verify');
const { normalizeWords, snapWithin } = require('../src/core/analysis/words');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);
let seed = 4242;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

function pcmDb(ffmpeg, video, start, seconds) {
  const buf = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(seconds), '-i', video, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  const frame = 320; // 20 ms a 16 kHz
  const out = [];
  for (let i = 0; i + frame * 2 <= buf.length; i += frame * 2) {
    let acc = 0;
    for (let k = 0; k < frame; k += 1) { const v = buf.readInt16LE(i + k * 2) / 32768; acc += v * v; }
    out.push(Math.max(-100, 20 * Math.log10(Math.sqrt(acc / frame) || 1e-12)));
  }
  return out;
}

const loudAt = (db, t, threshold) => {
  const a = Math.max(0, Math.round((t - 0.04) / 0.02));
  const b = Math.min(db.length - 1, Math.round((t + 0.04) / 0.02));
  for (let i = a; i <= b; i += 1) if (db[i] > threshold) return true;
  return false;
};

async function main() {
  const video = opt('video');
  const whisper = opt('whisper');
  const model = opt('model');
  const ffmpeg = opt('ffmpeg', 'ffmpeg');
  if (!video || !whisper || !model || !fs.existsSync(video) || !fs.existsSync(whisper) || !fs.existsSync(model)) {
    console.error('Uso: node scripts/medir-corte-palavras.js --video <arquivo> --whisper <whisper-cli.exe> --model <modelo.bin> --ffmpeg <ffmpeg.exe> [--cuda] [--segments 10] [--per 40] [--len 120] [--threshold -50]');
    process.exit(2);
  }
  const segments = Number(opt('segments', 10));
  const per = Number(opt('per', 40));
  const len = Number(opt('len', 120));
  const threshold = Number(opt('threshold', -50));
  const probe = JSON.parse(execFileSync(opt('ffprobe', ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')), ['-v', 'error', '-print_format', 'json', '-show_format', video], { windowsHide: true }).toString());
  const duration = Number(probe.format.duration);
  const from = Number(opt('from', 600));
  const to = Number(opt('to', duration - 600));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-cortes-'));
  const mk = () => ({ starts: 0, ends: 0, shiftS: [], shiftE: [] });
  const strategies = { A: mk(), B: mk(), C: mk() };
  let total = 0;
  let usedSegments = 0;
  let wordsTotal = 0;
  let transcribeMs = 0;
  let audioSec = 0;
  try {
    for (let s = 0; s < segments; s += 1) {
      const start = Math.round(from + ((to - from - len) * s) / Math.max(1, segments - 1));
      const res = await generateSubtitles({
        ffmpeg, whisper, modelPath: model, input: video, start, end: start + len, language: 'pt', maxChars: 60, returnWords: true,
        useGpu: flag('cuda'), cudaEngine: flag('cuda'), workRoot: work
      });
      if (res.noSpeech || !res.words || res.words.length < 40) { console.error(`segmento ${start}: pouca fala, pulado`); continue; }
      usedSegments += 1;
      transcribeMs += res.transcribeMs || 0;
      audioSec += res.audioSec || 0;
      const words = normalizeWords(res.words);
      wordsTotal += words.length;
      const db = pcmDb(ffmpeg, video, start, len);
      for (let k = 0; k < per; k += 1) {
        const rawStart = 3 + rnd() * (len * 0.45);
        const rawEnd = Math.min(len - 3, rawStart + 12 + rnd() * 16);
        const b = { start: snapStart(rawStart, res.cues), end: snapEnd(rawEnd, res.cues) };
        const c = snapWithin(rawStart, rawEnd, words, { minSec: 10, maxSec: 60, duration: len });
        const pick = { A: [rawStart, rawEnd], B: [b.start, b.end], C: [c.start, c.end] };
        for (const [name, [st, en]] of Object.entries(pick)) {
          if (loudAt(db, st, threshold)) strategies[name].starts += 1;
          if (loudAt(db, en, threshold)) strategies[name].ends += 1;
          strategies[name].shiftS.push(Math.abs(st - rawStart));
          strategies[name].shiftE.push(Math.abs(en - rawEnd));
        }
        total += 1;
      }
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const rows = Object.entries(strategies).map(([name, v]) => ({
    estrategia: { A: 'sem ajuste', B: 'ajuste às falas (antes)', C: 'ajuste às palavras (novo)' }[name],
    inicioCortaVoz: `${v.starts}/${total} (${((100 * v.starts) / total).toFixed(1)}%)`, fimCortaVoz: `${v.ends}/${total} (${((100 * v.ends) / total).toFixed(1)}%)`,
    deslocamentoMedioInicioS: Math.round(mean(v.shiftS) * 100) / 100, deslocamentoMedioFimS: Math.round(mean(v.shiftE) * 100) / 100
  }));
  const info = { video: path.basename(video), segmentos: usedSegments, palavras: wordsTotal, bordasSorteadas: total, limiarDbfs: threshold, velocidadeWhisper: transcribeMs ? Math.round((audioSec / (transcribeMs / 1000)) * 10) / 10 : null };
  if (flag('json')) { console.log(JSON.stringify({ info, rows }, null, 2)); return; }
  console.log(`\n${usedSegments} trechos de ${len} s (${wordsTotal} palavras do Whisper), ${total} cortes sorteados, limiar ${threshold} dBFS${info.velocidadeWhisper ? `, Whisper a ${info.velocidadeWhisper}x o tempo real` : ''}`);
  for (const r of rows) console.log(`  ${r.estrategia.padEnd(28)} início corta voz ${r.inicioCortaVoz.padEnd(16)} fim corta voz ${r.fimCortaVoz.padEnd(16)} deslocamento médio ${r.deslocamentoMedioInicioS} s / ${r.deslocamentoMedioFimS} s`);
}

main().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });

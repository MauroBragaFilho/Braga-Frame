'use strict';

/**
 * Desempenho e memória da análise:
 *  - uma versão CURTA (vídeo de 3 minutos em baixa resolução, gerado na hora) que roda sempre, no `npm test`;
 *  - a versão LONGA (20 minutos), que só roda com BF_PERF_TESTS=1 (ou `npm run test:perf`), porque leva alguns minutos e
 *    os números só fazem sentido com o computador sem outra carga pesada (a análise usa prioridade abaixo do normal);
 *  - um fluxo de PCM de 3 horas (simulado, rápido) para provar que a decodificação não acumula memória.
 * Os números medidos são impressos (`# perf: ...`) e ficam registrados em docs/recursos/analysis.md.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const EventEmitter = require('node:events');
const path = require('node:path');
const { Readable } = require('node:stream');
const { tools, skipMedia, mkTmp, rmrf } = require('./analysis-fixtures');
const { analyzeSource } = require('../src/core/analysis/analyze');
const { extractAudio } = require('../src/core/analysis/audioSignal');

const PERF = process.env.BF_PERF_TESTS === '1';
const T = { skip: skipMedia, timeout: 900000 };
const MB = 1024 * 1024;

/**
 * Memória (working set) de um processo no Windows, em bytes; null se não deu para ler. ASSÍNCRONA de
 * propósito: uma leitura síncrona travaria o loop de eventos e, com ele, a leitura do ffmpeg (distorce o tempo).
 */
function processMemory(pid) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    childProcess.execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }, (err, out) => {
      const m = !err && /"([\d.,\s]+) K"/.exec(out);
      resolve(m ? Number(m[1].replace(/[^\d]/g, '')) * 1024 : null);
    });
  });
}

/** Amostra a memória do processo node e dos ffmpeg filhos enquanto `fn` roda. */
async function measure(fn) {
  const kids = new Set();
  let nodePeak = process.memoryUsage().rss;
  let kidPeak = 0;
  let stop = false;
  const sampler = (async () => {
    while (!stop) {
      nodePeak = Math.max(nodePeak, process.memoryUsage().rss);
      for (const pid of kids) { const m = await processMemory(pid); if (m) kidPeak = Math.max(kidPeak, m); }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  const t0 = process.hrtime.bigint();
  let value;
  try { value = await fn((child) => { if (child.pid) kids.add(child.pid); }); } finally { stop = true; await sampler; }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  nodePeak = Math.max(nodePeak, process.memoryUsage().rss);
  return { value, ms, nodePeak, kidPeak };
}

/**
 * Vídeo de baixa resolução (320x180, 15 quadros/s) com áudio de fundo baixo e uma rajada de 3 s a cada `period`
 * segundos, a partir de `first`; devolve quantas rajadas cabem. A análise tem que achar exatamente essas rajadas.
 */
function makeBurstVideo(file, { seconds, period, first }) {
  const bursts = Math.floor((seconds - first - 3) / period) + 1;
  childProcess.execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=15:duration=${seconds}`,
    '-f', 'lavfi', '-i', `anoisesrc=d=${seconds}:c=pink:r=44100:a=0.5,volume='0.01+0.5*between(mod(t,${period}),${first},${first + 3})':eval=frame,aformat=channel_layouts=mono`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-shortest', file], { windowsHide: true });
  return bursts;
}

/**
 * Gera o vídeo, analisa nos modos normal e rápido e confere: as rajadas certas nos instantes certos, o tempo (`maxMs`) e
 * a memória (que não pode crescer com a duração). `maxMs` é o único valor que depende da carga da máquina.
 */
async function burstScenario(t, { name, seconds, period, first, maxMs }) {
  const dir = mkTmp('analysis-perf');
  try {
    const video = path.join(dir, 'perf.mp4');
    const g0 = Date.now();
    const bursts = makeBurstVideo(video, { seconds, period, first });
    const genSec = (Date.now() - g0) / 1000;

    const memBefore = process.memoryUsage().rss;
    const run = (fast) => measure((onSpawn) => analyzeSource(
      { file: video, duration: seconds, hasAudio: true, params: { maxSuggestions: 20, image: { fast }, signals: { chat: false } } },
      { ffmpeg: tools.ffmpeg, cacheDir: path.join(dir, `cache-${fast}`), onSpawn }
    ));
    const normal = await run(false);
    const fast = await run(true);

    for (const [label, m] of [['normal', normal], ['rápido', fast]]) {
      const r = m.value;
      const line = `# perf: vídeo ${name} (320x180, 15 fps): modo ${label}: ${(m.ms / 1000).toFixed(1)} s (${(seconds / (m.ms / 1000)).toFixed(0)}x tempo real); pico de memória: node ${(m.nodePeak / MB).toFixed(0)} MB RSS (+${((m.nodePeak - memBefore) / MB).toFixed(0)} MB), ffmpeg ${m.kidPeak ? `${(m.kidPeak / MB).toFixed(0)} MB` : 'n/d'}; geração do vídeo ${genSec.toFixed(1)} s`;
      console.log(line);
      t.diagnostic(line);
      assert.equal(r.suggestions.length, bursts, `modo ${label}: ${JSON.stringify(r.suggestions.map((s) => s.peak))}`);
      const peaks = r.suggestions.map((s) => s.peak).sort((a, b) => a - b);
      peaks.forEach((p, i) => assert.ok(Math.abs(p - (first + period * i + 1.5)) <= 3, `rajada ${i}: pico em ${p}`));
      assert.ok(m.ms < maxMs, `levou ${m.ms} ms (limite ${maxMs} ms)`);
      assert.ok(m.nodePeak - memBefore < 250 * MB, `memória do node subiu ${(m.nodePeak - memBefore) / MB} MB`);
      if (m.kidPeak) assert.ok(m.kidPeak < 1500 * MB, `ffmpeg usou ${m.kidPeak / MB} MB`);
    }
  } finally { rmrf(dir); }
}

// versão curta (sempre): 3 min, rajadas em 30, 90 e 150 s. O prazo é folgado de propósito: aqui o que se confere é achar as
// rajadas certas com pouca memória; o tempo "de verdade" (10x o tempo real) é medido na versão longa.
test('3 minutos de vídeo em baixa resolução: acha as 3 rajadas, com pouca memória e sem demorar demais', T, async (t) => {
  await burstScenario(t, { name: '3 min', seconds: 180, period: 60, first: 30, maxMs: 120000 });
});

// versão longa (BF_PERF_TESTS=1 ou npm run test:perf): 20 min, rajadas a cada 180 s a partir de 100 s; tem que ser rápido
test('20 minutos de vídeo em baixa resolução: acha as 7 rajadas, rápido e com pouca memória', { ...T, skip: skipMedia || (PERF ? false : 'desempenho: BF_PERF_TESTS=1 (ou npm run test:perf)') }, async (t) => {
  await burstScenario(t, { name: '20 min', seconds: 1200, period: 180, first: 100, maxMs: 120000 });
});

test('3 horas de áudio em fluxo: a memória não cresce com a duração (decodificação sem acumular)', async (t) => {
  // ffmpeg falso: despeja 3 h de PCM 16 kHz mono (ruído leve + um estrondo no meio) em blocos de 64 KB
  const hours = 3;
  const totalSamples = hours * 3600 * 16000;
  const CHUNK = 32768; // amostras por bloco
  const chunk = Buffer.alloc(CHUNK * 2);
  const loud = Buffer.alloc(CHUNK * 2);
  for (let i = 0; i < CHUNK; i += 1) { chunk.writeInt16LE(((i * 7919) % 400) - 200, i * 2); loud.writeInt16LE(((i * 7919) % 20000) - 10000, i * 2); }
  let sent = 0;
  const middle = Math.floor(totalSamples / 2);
  function fakeSpawn() {
    const child = new EventEmitter();
    child.pid = 0;
    child.kill = () => {};
    child.stderr = Readable.from([]);
    child.stdout = new Readable({
      highWaterMark: 64 * 1024,
      read() {
        if (sent >= totalSamples) { this.push(null); return; }
        const isLoud = sent >= middle && sent < middle + 16000 * 4;
        sent += CHUNK;
        this.push(isLoud ? loud : chunk);
      }
    });
    child.stdout.on('end', () => setImmediate(() => child.emit('close', 0)));
    return child;
  }
  const before = process.memoryUsage();
  let peakRss = before.rss;
  const timer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
  const t0 = Date.now();
  const res = await extractAudio({ ffmpeg: 'ffmpeg-falso', file: 'x', duration: hours * 3600, spawn: fakeSpawn });
  clearInterval(timer);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const sec = (Date.now() - t0) / 1000;
  const line = `# perf: ${hours} h de PCM em fluxo: ${res.db.length} janelas em ${sec.toFixed(1)} s; RSS ${(before.rss / MB).toFixed(0)} -> pico ${(peakRss / MB).toFixed(0)} MB (+${((peakRss - before.rss) / MB).toFixed(0)} MB) para ${(totalSamples * 2 / MB).toFixed(0)} MB de PCM`;
  console.log(line);
  t.diagnostic(line);
  assert.ok(Math.abs(res.db.length - hours * 3600 * 2) <= 2, `${res.db.length} janelas`);
  assert.ok(peakRss - before.rss < 120 * MB, `a memória subiu ${(peakRss - before.rss) / MB} MB`);
  const maxDb = Math.max(...res.db);
  assert.ok(maxDb > -20 && res.db.indexOf(maxDb) >= middle / 8000 - 1 && res.db.indexOf(maxDb) <= middle / 8000 + 9, 'o estrondo está na posição certa');
});

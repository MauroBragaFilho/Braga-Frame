'use strict';

/**
 * Integração exportação x áudio x legendas x QC com o ffmpeg de verdade (o fluxo pela interface está em
 * tests/e2e/integration-export.e2e.js):
 *
 *  - o ganho do áudio vale o que a aba Áudio promete, em fonte MONO ou ESTÉREO (o upmix do ffmpeg não pode comer 3 dB);
 *  - QC x legendas: legenda que precisa de revisão depois de mudar o corte é AVISO (não bloqueia); sem o libass no FFmpeg a
 *    entrega incorporada é um erro com causa e solução (a exportação não teria como incorporar), a entrega em arquivo
 *    separado não depende dele e uma legenda sem falas visíveis não bloqueia nada. O FFmpeg "sem libass" é um programa
 *    de verdade (lançador .exe) que repassa tudo ao ffmpeg real e só esconde o filtro `subtitles` de `-filters`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const fx = require('./export-fixtures');
const afx = require('./audio-fixtures');
const fakes = require('./sources-fakes');
const { buildJobs } = require('../src/core/export/jobs');
const { runExportJob } = require('../src/core/export/jobRunner');
const { preflight } = require('../src/core/export/qc');
const { listBuiltinProfiles } = require('../src/core/export/profiles');

const { tools } = fx;
const skipMedia = fx.skipMedia;
const skipFake = skipMedia || fakes.fakeExeSkipReason();
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: obtido ${actual}, esperado ${expected} (±${tol})`);

const PROFILE = { id: 'teste-pequeno', name: 'Teste pequeno', kind: 'custom', width: 360, height: 640, codec: 'h264', bitrateKbps: 2000, encoder: 'software', fps: 'source', container: 'mp4' };

/** Vídeo 320x180 com tom de 440 Hz em 1 canal (mono) ou 2 (estéreo). */
function makeSource(file, channels, seconds = 4) {
  const pan = channels === 2 ? ['-af', 'pan=stereo|c0=c0|c1=c0'] : [];
  fx.ffmpeg(['-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=10:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-map', '0:v', '-map', '1:a', ...pan, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  const info = JSON.parse(execFileSync(tools.ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'json', file], { encoding: 'utf8', windowsHide: true }));
  assert.equal(info.streams[0].channels, channels, 'a fonte de teste tem o número de canais pedido');
}

function jobFor(source, outDir, cut, { profile = PROFILE, duration = 4 } = {}) {
  const project = { id: 'p1', source: { path: source, width: 320, height: 180, duration }, cuts: [{ id: 'c1', title: 'Corte', status: 'approved', start: 0.5, end: 3.5, ...cut }] };
  const { jobs } = buildJobs({
    project, info: { width: 320, height: 180, fps: 10, duration, hasAudio: true }, cutIds: ['c1'], profile, framing: null, outputDir: outDir, nameTemplate: '{titulo}'
  });
  jobs[0].onConflict = 'rename';
  return jobs[0];
}

// ---------- áudio ----------

for (const channels of [1, 2]) {
  test(`ganho de +6 dB vale +6 dB no arquivo exportado (fonte ${channels === 1 ? 'mono' : 'estéreo'})`, { skip: skipMedia, timeout: 120000 }, async () => {
    const dir = fx.tmpDir('bf-integ-aud-');
    try {
      const source = path.join(dir, 'fonte.mp4');
      makeSource(source, channels);
      const truth = await afx.measure(source, 0.5, 3.5);
      const outDir = path.join(dir, 'out');
      const plain = await runExportJob(jobFor(source, outDir, { audio: { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0 } }), { tools });
      const boosted = await runExportJob(jobFor(source, outDir, { title: 'Com ganho', audio: { gainDb: 6, mute: false, fadeInSec: 0, fadeOutSec: 0, history: [] } }), { tools });
      const a0 = await afx.measure(plain.output, 0, 3600);
      const a6 = await afx.measure(boosted.output, 0, 3600);
      near(a0.meanDb - truth.meanDb, 0, 0.5, `sem ganho o nível não muda (${channels} canal(is))`);
      near(a6.meanDb - truth.meanDb, 6, 0.5, `com +6 dB (${channels} canal(is))`);
      near(a6.peakDb - truth.peakDb, 6, 0.8, `pico com +6 dB (${channels} canal(is))`);
      const out = fx.probeStreams(boosted.output).streams.find((s) => s.codec_type === 'audio');
      assert.equal(out.channels, 2, 'o arquivo exportado sempre sai estéreo');
    } finally { fx.cleanup(dir); }
  });
}

// ---------- QC x legendas ----------

const cues = [{ start: 0, end: 1, text: 'primeira' }, { start: 1.5, end: 2.5, text: 'segunda' }, { start: 2.6, end: 3, text: 'terceira' }];

test('QC: legenda que precisa de revisão depois de o corte mudar é AVISO (não bloqueia) e a exportação segue', { skip: skipMedia, timeout: 120000 }, async () => {
  const dir = fx.tmpDir('bf-integ-qc-');
  try {
    const source = path.join(dir, 'fonte.mp4');
    makeSource(source, 2);
    // legenda feita para o corte 0,5 a 3,5; depois o corte passa a ser 1,0 a 2,5: a 1ª fala (0 a 1) é cortada no começo, a 2ª no fim
    // (1,5 s de duração) e a 3ª fica totalmente fora; nada é apagado, tudo vira aviso
    const subtitles = { enabled: true, mode: 'burn', basedOn: { start: 0.5, end: 3.5, revision: 1 }, cues };
    const job = jobFor(source, path.join(dir, 'out'), { start: 1, end: 2.5, revision: 2, subtitles });
    const report = preflight(job, { tools });
    assert.deepEqual(report.errors, [], 'nada bloqueia');
    const texts = report.warnings.filter((w) => w.code === 'SUBTITLES_WARNING').map((w) => w.message);
    assert.ok(texts.some((t) => /marcadas para revisão/.test(t)), `avisa que há falas para revisar: ${JSON.stringify(texts)}`);
    assert.ok(texts.some((t) => /fora do corte/.test(t)), `avisa das falas fora do corte: ${JSON.stringify(texts)}`);
    // e o trabalho exporta mesmo assim (aviso nunca impede), com as falas alinhadas ao corte novo
    const done = await runExportJob(job, { tools });
    assert.ok(fs.existsSync(done.output));
    assert.ok(done.warnings.some((w) => w.code === 'SUBTITLES_WARNING'), 'o runner repassa o aviso');
  } finally { fx.cleanup(dir); }
});

test('QC x FFmpeg sem libass: incorporar é erro com causa e solução; arquivo separado e legenda sem falas visíveis não bloqueiam', { skip: skipFake, timeout: 240000 }, async () => {
  const dir = fx.tmpDir('bf-integ-libass-');
  try {
    process.env.BF_FAKE_NODE = process.execPath;
    process.env.BF_REAL_FFMPEG = tools.ffmpeg;
    const noLibass = fakes.makeFakeExe(path.join(dir, 'bin'), 'ffmpeg', String.raw`
const { spawnSync } = require('child_process');
const real = process.env.BF_REAL_FFMPEG;
const args = process.argv.slice(2);
if (args.includes('-filters')) {
  const r = spawnSync(real, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  process.stdout.write(r.stdout.split(/\r?\n/).filter((l) => !/^\s*\S+\s+(subtitles|ass)\s+V->V/.test(l)).join('\n'));
  process.exit(r.status === null ? 1 : r.status);
}
const r = spawnSync(real, args, { stdio: 'inherit', maxBuffer: 1 << 26 });
process.exit(r.status === null ? 1 : r.status);
`);
    const fakeTools = { ffmpeg: noLibass, ffprobe: tools.ffprobe };
    const source = path.join(dir, 'fonte.mp4');
    makeSource(source, 2);
    const base = { start: 0.5, end: 3.5, revision: 1 };
    const sub = (mode, list = cues) => ({ enabled: true, mode, basedOn: { start: 0.5, end: 3.5, revision: 1 }, cues: list });

    const burn = preflight(jobFor(source, path.join(dir, 'o1'), { ...base, subtitles: sub('burn') }), { tools: fakeTools });
    assert.equal(burn.errors.length, 1, JSON.stringify(burn.errors));
    assert.equal(burn.errors[0].code, 'CODEC_UNSUPPORTED');
    assert.match(burn.errors[0].message, /libass/);
    assert.match(burn.errors[0].solution, /arquivo separado/, 'a solução diz o que fazer');

    const both = preflight(jobFor(source, path.join(dir, 'o2'), { ...base, subtitles: sub('both') }), { tools: fakeTools });
    assert.equal(both.errors[0] && both.errors[0].code, 'CODEC_UNSUPPORTED');

    const sidecar = preflight(jobFor(source, path.join(dir, 'o3'), { ...base, subtitles: sub('sidecar') }), { tools: fakeTools });
    assert.deepEqual(sidecar.errors, [], 'arquivo separado não depende do libass');

    const noVisible = preflight(jobFor(source, path.join(dir, 'o4'), { ...base, subtitles: sub('burn', [{ start: 9, end: 10, text: 'fora do corte' }]) }), { tools: fakeTools });
    assert.deepEqual(noVisible.errors, [], 'sem falas visíveis nada é incorporado: não há o que bloquear');

    // a exportação de verdade confirma: incorporar falha com a mesma causa e solução; arquivo separado exporta e cria o .srt
    const outDir = path.join(dir, 'saida');
    await assert.rejects(runExportJob(jobFor(source, outDir, { ...base, subtitles: sub('burn') }), { tools: fakeTools }), (err) => {
      assert.equal(err.code, 'CODEC_UNSUPPORTED');
      assert.match(err.details.solution, /arquivo separado/);
      return true;
    });
    assert.deepEqual(fs.existsSync(outDir) ? fs.readdirSync(outDir) : [], [], 'a falha não deixa arquivo nenhum');
    const ok = await runExportJob(jobFor(source, outDir, { ...base, subtitles: sub('sidecar') }), { tools: fakeTools });
    assert.ok(fs.existsSync(ok.output));
    assert.match(fs.readFileSync(ok.output.replace(/\.mp4$/, '.srt'), 'utf8'), /primeira/);
  } finally {
    delete process.env.BF_REAL_FFMPEG;
    fx.cleanup(dir);
  }
});

test('os perfis embutidos continuam à mão para o QC (sanidade do teste)', () => {
  assert.ok(listBuiltinProfiles().some((p) => p.id === 'vertical-1080-h264'));
});

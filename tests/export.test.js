'use strict';

/**
 * Fluxo básico da exportação (o que a versão mínima da base já cobria), agora sobre o motor novo
 * (src/core/export/profiles.js, jobRunner.js, qc.js). Os detalhes ficam em tests/export-*.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runExportJob } = require('../src/core/export/jobRunner');
const { findProfile, validateProfile, DEFAULT_PROFILE_ID } = require('../src/core/export/profiles');
const { preflight } = require('../src/core/export/qc');
const fx = require('./export-fixtures');

const { tools, skipMedia } = fx;

test('perfil padrão: 9:16 1080x1920, H.264, 10 Mbps', () => {
  const profile = findProfile(DEFAULT_PROFILE_ID);
  assert.deepEqual([profile.width, profile.height, profile.codec, profile.bitrateKbps], [1080, 1920, 'h264', 10000]);
  assert.deepEqual(validateProfile(profile).errors, []);
});

test('perfil rejeita medidas, codec e bitrate inválidos', () => {
  const { errors } = validateProfile({ width: 720.5, height: 1281, codec: 'vp9', bitrateKbps: 10 });
  assert.ok(errors.length >= 4, errors.join(' | '));
});

test('aviso quando a fonte é menor que a exportação', () => {
  const job = {
    sourcePath: __filename, sourceInfo: { width: 1920, height: 1080 }, cut: { start: 0, end: 5 },
    profile: findProfile('vertical-2160-h264'), outputDir: os.tmpdir(), baseName: 'x'
  };
  const { warnings } = preflight(job, { tools: { ffmpeg: null } });
  assert.ok(warnings.some((w) => w.code === 'UPSCALE'));
});

test('exporta um corte 9:16 real, válido, sem sobrescrever', { skip: skipMedia }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-export-basico-'));
  try {
    const src = path.join(dir, 'fonte.mp4');
    fx.makeCodedSource(src, { width: 1920, height: 1080, fps: 30, seconds: 6 });
    const job = {
      id: 'j', sourcePath: src, sourceInfo: { width: 1920, height: 1080, fps: 30, duration: 6, hasAudio: true },
      cut: { id: 'c', title: 'corte 1', start: 1, end: 3.5 }, profile: findProfile(DEFAULT_PROFILE_ID), framing: null,
      outputDir: path.join(dir, 'saida'), baseName: 'corte 1', onConflict: 'fail'
    };
    const progress = [];
    const out = await runExportJob(job, { tools, onProgress: (p) => progress.push(p) });
    assert.ok(fs.existsSync(out.output));
    assert.ok(!fs.existsSync(`${out.output}.part`));
    assert.ok(progress.length > 0);

    const info = await fx.probe(out.output);
    assert.equal(info.width, 1080);
    assert.equal(info.height, 1920);
    assert.equal(info.videoCodec, 'h264');
    assert.ok(info.hasAudio);
    assert.ok(Math.abs(info.duration - 2.5) < 0.2, `duração ${info.duration}`);

    const before = fs.statSync(out.output).mtimeMs;
    await assert.rejects(runExportJob(job, { tools }), { code: 'OUTPUT_EXISTS' });
    assert.equal(fs.statSync(out.output).mtimeMs, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('intervalo inválido e arquivo ausente geram erros claros', { skip: skipMedia }, async () => {
  const base = { id: 'j', sourcePath: path.join(os.tmpdir(), 'nao-existe.mp4'), sourceInfo: {}, profile: findProfile(DEFAULT_PROFILE_ID), outputDir: os.tmpdir(), baseName: 'z', onConflict: 'fail' };
  await assert.rejects(runExportJob({ ...base, cut: { start: 5, end: 2 } }, { tools }), { code: 'INVALID_RANGE' });
  await assert.rejects(runExportJob({ ...base, cut: { start: 0, end: 2 } }, { tools }), { code: 'INPUT_MISSING' });
});

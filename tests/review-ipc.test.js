'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { locateTools } = require('../src/core/ffmpeg/locate');
const { createContext } = require('../src/ipc/context');
const review = require('../src/ipc/handlers/review');

const real = locateTools();
const skip = !real.ffmpeg ? 'ffmpeg não encontrado' : false;
const silent = { log() {}, info() {}, warn() {}, error() {} };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bf-review-ipc-')); }

/** ipcMain/app/dialog/shell falsos (mesmo desenho de tests/ipc-base.test.js). */
function setup(dir, extra = {}) {
  const handlers = new Map();
  const sent = [];
  const quit = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } };
  const deps = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: () => dir, getVersion: () => '9.9.9', on: (name, fn) => quit.push([name, fn]) },
    dialog: {}, shell: {}, getWindow: () => win, logger: silent,
    resolveTools: () => ({ ffmpeg: real.ffmpeg, ffprobe: real.ffprobe }),
    ...extra
  };
  const ctx = createContext(deps);
  review.register(ctx);
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  return { ctx, handlers, sent, quit, call };
}

function beepVideo(file) {
  execFileSync(real.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=6',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=6', '-af', "volume='6.4*between(t,2,3)':eval=frame",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { windowsHide: true });
}

test('o handler registra os canais do contrato da revisão', () => {
  const dir = tmp();
  try {
    const t = setup(dir);
    for (const channel of ['review:waveform', 'review:waveformCancel', 'review:historyLoad', 'review:historyAppend', 'review:historyCopy']) {
      assert.ok(t.handlers.has(channel), channel);
      assert.ok(t.ctx.channels.has(channel), channel);
    }
    assert.equal(t.quit[0][0], 'before-quit');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('review:waveform devolve picos reais, evento de progresso e usa o cache em userData/cache', { skip }, async () => {
  const dir = tmp();
  try {
    const video = path.join(dir, 'v.mp4');
    beepVideo(video);
    const t = setup(path.join(dir, 'ud'));
    const res = await t.call('review:waveform', { sourcePath: video, buckets: 60, durationHint: 6 });
    assert.equal(res.ok, true);
    assert.equal(res.buckets, 60);
    assert.ok(Math.abs(res.duration - 6) < 0.2);
    assert.ok(res.peaks.slice(21, 29).every((v) => v > 150), 'bipe de 2 a 3 s');
    assert.ok(Math.max(...res.peaks.slice(0, 18)) < 12, 'silêncio antes do bipe');
    assert.ok(t.sent.some(([ch, p]) => ch === 'review:waveformProgress' && p.sourcePath === video && p.p === 1));
    assert.equal(fs.readdirSync(path.join(dir, 'ud', 'cache', 'waveform')).filter((f) => f.endsWith('.bfwf')).length, 1);
    const zoom = await t.call('review:waveform', { sourcePath: video, buckets: 30, start: 1.5, end: 3.5 });
    assert.equal(zoom.cached, true);
    assert.deepEqual([zoom.start, zoom.end], [1.5, 3.5]);
    // JSON puro: atravessa o IPC
    assert.doesNotThrow(() => JSON.stringify(res));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('review:waveform: durationHint absurdo (cabeçalho de duração corrompido) é ignorado em vez de virar RangeError', { skip }, async () => {
  const dir = tmp();
  try {
    const video = path.join(dir, 'v.mp4');
    beepVideo(video);
    const t = setup(path.join(dir, 'ud'));
    for (const hint of [1e13, -5, 0, 'abc', Number.MAX_SAFE_INTEGER]) {
      const res = await t.call('review:waveform', { sourcePath: video, buckets: 60, durationHint: hint });
      assert.equal(res.ok, true, `durationHint ${String(hint)}: ${res.message || ''}`);
      assert.ok(Math.abs(res.duration - 6) < 0.2);
      assert.ok(res.peaks.slice(21, 29).every((v) => v > 150), 'o bipe de 2 a 3 s está no lugar');
    }
    assert.ok(t.sent.every(([ch, p]) => ch !== 'review:waveformProgress' || (p.p >= 0 && p.p <= 1)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('review:waveform: argumentos inválidos, arquivo ausente e sem ffmpeg explicam o que fazer', async () => {
  const dir = tmp();
  try {
    const t = setup(dir);
    assert.equal((await t.call('review:waveform', {})).code, 'INVALID_ARGS');
    assert.equal((await t.call('review:waveform', { sourcePath: 'x.mp4', buckets: 0 })).code, 'INVALID_ARGS');
    assert.equal((await t.call('review:waveform', { sourcePath: 'x.mp4', buckets: 99999 })).code, 'INVALID_ARGS');
    assert.equal((await t.call('review:waveform', { sourcePath: 'x.mp4', start: 'abc' })).code, 'INVALID_ARGS');
    const missing = await t.call('review:waveform', { sourcePath: path.join(dir, 'nao-existe.mp4') });
    assert.deepEqual([missing.ok, missing.code], [false, 'INPUT_MISSING']);
    assert.match(missing.message, /não foi encontrado/);
    const file = path.join(dir, 'v.mp4');
    fs.writeFileSync(file, 'x');
    const noTool = setup(path.join(dir, 'ud2'), { resolveTools: () => ({}) });
    const res = await noTool.call('review:waveform', { sourcePath: file });
    assert.deepEqual([res.ok, res.code], [false, 'NO_FFMPEG']);
    assert.match(res.message, /Instale o FFmpeg/);
    assert.deepEqual(await t.call('review:waveformCancel', { sourcePath: file }), { ok: true, cancelled: false });
    assert.deepEqual(await t.call('review:waveformCancel', {}), { ok: true, cancelled: false });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('review:historyLoad e review:historyAppend: gravam em userData/history/<projectId>.json', async () => {
  const dir = tmp();
  try {
    const t = setup(dir);
    const g = (id) => ({ id, at: '2026-10-21T12:00:00.000Z', label: 'Aprovou “A”', source: 'user', items: [{ cutId: 'c', cutTitle: 'A', type: 'approve', before: { status: 'pending' }, after: { status: 'approved' }, cut: null }] });
    assert.deepEqual(await t.call('review:historyLoad', { projectId: 'abcdef0123456789' }), { ok: true, groups: [], dropped: 0 });
    assert.deepEqual(await t.call('review:historyAppend', { projectId: 'abcdef0123456789', groups: [g('g1')] }), { ok: true, count: 1, dropped: 0 });
    await t.call('review:historyAppend', { projectId: 'abcdef0123456789', groups: [g('g2')] });
    const loaded = await t.call('review:historyLoad', { projectId: 'abcdef0123456789' });
    assert.deepEqual(loaded.groups.map((x) => x.id), ['g1', 'g2']);
    assert.ok(fs.existsSync(path.join(dir, 'history', 'abcdef0123456789.json')));
    for (const bad of ['..\\fora', '../fora', '', undefined]) {
      assert.equal((await t.call('review:historyLoad', { projectId: bad })).code, 'INVALID_ARGS', String(bad));
      assert.equal((await t.call('review:historyAppend', { projectId: bad, groups: [g('x')] })).code, 'INVALID_ARGS', String(bad));
    }
    assert.equal((await t.call('review:historyAppend', { projectId: 'abc', groups: 'x' })).code, 'INVALID_ARGS');
    // copiar o histórico para o projeto de uma versão nova do vídeo
    assert.deepEqual(await t.call('review:historyCopy', { fromProjectId: 'abcdef0123456789', toProjectId: '0123456789abcdef' }), { ok: true, copied: true, count: 2 });
    assert.deepEqual((await t.call('review:historyLoad', { projectId: '0123456789abcdef' })).groups.map((x) => x.id), ['g1', 'g2']);
    assert.equal((await t.call('review:historyCopy', { fromProjectId: 'abcdef0123456789', toProjectId: '0123456789abcdef' })).copied, false, 'nunca sobrescreve');
    assert.equal((await t.call('review:historyCopy', { fromProjectId: '../x', toProjectId: 'abc' })).code, 'INVALID_ARGS');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

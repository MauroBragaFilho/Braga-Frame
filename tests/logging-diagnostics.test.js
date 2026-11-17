'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createFileLogger, installCrashHandlers } = require('../src/logging');
const { collectDiagnostics, formatDiagnostics } = require('../src/diagnostics');

const silent = { info() {}, warn() {}, error() {}, log() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bf-log-'));

test('logger grava linhas com nível e data', () => {
  const dir = tmp();
  const log = createFileLogger({ dir, mirror: silent, now: () => new Date('2026-11-16T10:00:00Z') });
  log.info('olá');
  log.error('falhou', new Error('boom'));
  const text = fs.readFileSync(log.file, 'utf8');
  assert.match(text, /2026-11-16T10:00:00.000Z \[info\] olá/);
  assert.match(text, /\[error\] falhou Error: boom/);
});

test('logger faz rotação por tamanho e mantém só `keep` arquivos', () => {
  const dir = tmp();
  const log = createFileLogger({ dir, mirror: silent, maxBytes: 200, keep: 2 });
  for (let i = 0; i < 40; i += 1) log.info(`linha ${i} ${'x'.repeat(30)}`);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['bragaframe.log', 'bragaframe.log.1', 'bragaframe.log.2']);
});

test('logger não lança com pasta impossível', () => {
  const file = path.join(tmp(), 'arquivo');
  fs.writeFileSync(file, 'x');
  const log = createFileLogger({ dir: path.join(file, 'sub'), mirror: silent });
  assert.doesNotThrow(() => log.warn('sem pasta'));
});

test('installCrashHandlers registra e desfaz', () => {
  const dir = tmp();
  const log = createFileLogger({ dir, mirror: silent });
  const proc = new EventEmitter();
  const off = installCrashHandlers(log, proc);
  proc.emit('unhandledRejection', new Error('x'));
  assert.match(fs.readFileSync(log.file, 'utf8'), /unhandledRejection/);
  off();
  assert.equal(proc.listenerCount('uncaughtException'), 0);
});

test('diagnóstico lista ferramentas e marca as ausentes', () => {
  const d = collectDiagnostics({
    version: '1.2.3', userDataDir: tmp(), isPackaged: true,
    findToolsImpl: () => ({ ffmpeg: 'C:\\ff\\ffmpeg.exe', ffprobe: null, ytdlp: null })
  });
  assert.equal(d.data.writable, true);
  assert.equal(d.tools.ffprobe, null);
  const text = formatDiagnostics(d);
  assert.match(text, /Braga Frame 1\.2\.3/);
  assert.match(text, /ffmpeg: C:\\ff\\ffmpeg\.exe/);
  assert.match(text, /ffprobe: NÃO ENCONTRADA/);
  assert.doesNotMatch(text, /desenvolvimento/);
});

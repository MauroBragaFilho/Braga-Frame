'use strict';

/** Relatório de suporte (src/diagnostics.js + canal app:support): placas de vídeo, codificadores, pasta pessoal escondida, sem segredos. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../src/diagnostics');
const { createContext } = require('../src/ipc/context');
const { register } = require('../src/ipc/handlers/app');

const BASE = { appName: 'Braga Frame', version: '1.2.3', electron: '43', chrome: '140', node: '24', userDataDir: 'C:\\Users\\Ana Maria\\AppData\\Roaming\\braga-frame', isPackaged: true, findToolsImpl: () => ({ ffmpeg: 'C:\\Users\\Ana Maria\\ffmpeg\\ffmpeg.exe', ffprobe: null, ytdlp: null }) };

test('summarizeGpus: tira repetidas (a mesma placa aparece por perfil de energia), diz o fabricante e aguenta entrada ruim', () => {
  const gpus = D.summarizeGpus({ gpuDevice: [
    { deviceString: 'NVIDIA GeForce GTX 1650', vendorId: 0x10de, deviceId: 8093, driverVersion: '32.0.16.2101' },
    { deviceString: 'Intel(R) Iris(R) Xe Graphics', vendorId: 0x8086, deviceId: 39497, driverVersion: '32.0.101.7092' },
    { deviceString: 'NVIDIA GeForce GTX 1650', vendorId: 0x10de, deviceId: 8093, driverVersion: '32.0.16.2101' },
    { vendorId: 0x1002, deviceId: 0x73bf }, null, 'x'
  ] });
  assert.deepEqual(gpus.map((g) => [g.name, g.vendor, g.driver]), [
    ['NVIDIA GeForce GTX 1650', 'NVIDIA', '32.0.16.2101'], ['Intel(R) Iris(R) Xe Graphics', 'Intel', '32.0.101.7092'], ['Placa 1002:73bf', 'AMD', null]
  ]);
  for (const bad of [null, undefined, {}, { gpuDevice: 'x' }]) assert.deepEqual(D.summarizeGpus(bad), []);
});

test('describeEncoders: software e NVENC, com o motivo do NVENC que falhou; sem FFmpeg diz isso', () => {
  const text = D.describeEncoders({ ffmpeg: 'x', software: { h264: true, h265: false }, nvenc: { h264: { available: true }, h265: { available: false, reason: 'Cannot load nvcuda.dll\nsegunda linha' } } });
  assert.match(text, /H\.264 por software: sim/);
  assert.match(text, /H\.265 por software: não/);
  assert.match(text, /H\.264 NVENC \(placa NVIDIA\): sim/);
  assert.match(text, /H\.265 NVENC: não \(Cannot load nvcuda\.dll\)/);
  assert.doesNotMatch(text, /segunda linha/);
  assert.match(D.describeEncoders(null), /FFmpeg não encontrado/);
  assert.match(D.describeEncoders({ ffmpeg: null }), /FFmpeg não encontrado/);
});

test('redactHome: o nome de usuário some (com / ou \\, maiúsculas à vontade); pasta curta demais não é tocada', () => {
  assert.equal(D.redactHome('C:\\Users\\Ana Maria\\a e c:/users/ana maria/b', 'C:\\Users\\Ana Maria'), process.platform === 'win32' ? '~\\a e ~/b' : 'C:\\Users\\Ana Maria\\a e c:/users/ana maria/b');
  assert.equal(D.redactHome('/home/ana/x', '/home/ana/'), '~/x');
  assert.equal(D.redactHome('texto', ''), 'texto');
  assert.equal(D.redactHome('C:\\ coisa', 'C:\\'), 'C:\\ coisa', 'raiz do disco não é pasta pessoal');
  assert.equal(D.redactHome('a.b(c)', 'x.y(z)'), 'a.b(c)', 'caracteres especiais do caminho são literais');
});

test('formatSupportReport: versão, sistema, placas, codificação, registro e hora; a pasta pessoal sai como ~', () => {
  const d = D.collectDiagnostics(BASE);
  const text = D.formatSupportReport(d, {
    gpus: [{ name: 'NVIDIA GeForce GTX 1650', vendor: 'NVIDIA', driver: '32.0.16.2101' }],
    encoders: { ffmpeg: 'x', software: { h264: true, h265: true }, nvenc: { h264: { available: true }, h265: { available: true } } },
    logFile: 'C:\\Users\\Ana Maria\\AppData\\Roaming\\braga-frame\\logs\\bragaframe.log', home: 'C:\\Users\\Ana Maria', now: new Date('2026-11-17T12:00:00Z')
  });
  assert.match(text, /^Braga Frame 1\.2\.3\n/);
  assert.match(text, /NVIDIA GeForce GTX 1650 \(driver 32\.0\.16\.2101\)/);
  assert.match(text, /Codificação: H\.264 por software: sim/);
  assert.match(text, /Registro: ~.*bragaframe\.log/);
  assert.match(text, /Gerado em 2026-11-17T12:00:00\.000Z/);
  assert.doesNotMatch(text, /Ana Maria/, 'o nome de usuário não vai no relatório');
  assert.match(D.formatSupportReport(d, { home: 'C:\\Users\\Ana Maria' }), /Placas de vídeo:\n {2}não informadas pelo sistema/);
});

function makeCtx(t, extra = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-support-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const handlers = new Map();
  const app = { getVersion: () => '9.9.9', getPath: () => userData, isPackaged: true, getGPUInfo: async () => ({ gpuDevice: [{ deviceString: 'GPU de teste', vendorId: 0x10de, driverVersion: '1.0' }] }), ...extra };
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler() {} };
  const ctx = createContext({ ipcMain, app, dialog: {}, shell: {}, getWindow: () => null, userDataDir: userData, resolveTools: () => ({ ffmpeg: null, ffprobe: null, ytdlp: null, whisper: null, twitchDownloader: null }), logger: { info() {}, warn() {}, error() {}, log() {} } });
  register(ctx);
  return { ctx, handlers, userData };
}

test('app:support: devolve o texto com a versão e as placas; registro só se o arquivo existe; falha na placa não derruba o relatório', async (t) => {
  const { handlers, userData } = makeCtx(t);
  const first = await handlers.get('app:support')({}, {});
  assert.equal(first.ok, true);
  assert.match(first.text, /Braga Frame 9\.9\.9/);
  assert.match(first.text, /GPU de teste \(driver 1\.0\)/);
  assert.match(first.text, /FFmpeg não encontrado/);
  assert.equal(first.logFile, null, 'sem arquivo de registro, sem caminho');
  fs.mkdirSync(path.join(userData, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'logs', 'bragaframe.log'), 'x');
  const second = await handlers.get('app:support')({}, {});
  assert.equal(second.logFile, path.join(userData, 'logs', 'bragaframe.log'));

  const broken = makeCtx(t, { getGPUInfo: async () => { throw new Error('sem placa'); } });
  const res = await broken.handlers.get('app:support')({}, {});
  assert.equal(res.ok, true);
  assert.match(res.text, /não informadas pelo sistema/);
});

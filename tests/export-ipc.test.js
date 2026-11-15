'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createContext } = require('../src/ipc/context');
const exportHandler = require('../src/ipc/handlers/export');
const encoders = require('../src/core/export/encoders');
const { pngSize, jpegSize } = require('../src/core/export/preview');
const fx = require('./export-fixtures');

const { skipMedia } = fx;
const silent = { log() {}, info() {}, warn() {}, error() {} };

/** ipcMain/app/dialog falsos: guardam os handlers para chamá-los direto (o mesmo estilo de tests/ipc-base.test.js). */
function setup(userData, extra = {}) {
  const handlers = new Map();
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } };
  const dialogs = { next: { canceled: true, filePaths: [] }, calls: [] };
  const ctx = createContext({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: () => userData, getVersion: () => '9.9.9', isPackaged: true },
    dialog: { showOpenDialog: async (_w, opts) => { dialogs.calls.push(opts); return dialogs.next; } },
    shell: {}, getWindow: () => win, logger: silent, ...extra
  });
  exportHandler.register(ctx);
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  return { ctx, handlers, sent, dialogs, call };
}

async function withEnv(fn) {
  const dir = fx.tmpDir('bf-export-ipc-');
  try {
    const src = path.join(dir, 'gameplay 01.mp4');
    fx.makeCodedSource(src, { width: 1920, height: 1080, fps: 10, seconds: 4 });
    const app = setup(path.join(dir, 'userdata'));
    return await fn({ dir, src, ...app });
  } finally {
    encoders.resetCache();
    encoders.configure({ cacheDir: null });
    encoders.forgetMemory();
    fx.cleanup(dir);
  }
}

const project = (src) => ({
  id: 'p-1', version: 2, source: { path: src, duration: 4, width: 1920, height: 1080 },
  cuts: [
    { id: 'c2', title: 'Segundo', start: 2, end: 3.5, status: 'approved' },
    { id: 'c1', title: 'Primeiro', start: 0.5, end: 1.5, status: 'approved', framing: { mode: 'blur' } },
    { id: 'c3', title: 'Pendente', start: 3, end: 3.8, status: 'pending' }
  ]
});

test('canais registrados: os novos e os legados da exportação mínima', () => {
  const dir = fx.tmpDir('bf-export-ipc-');
  try {
    const { handlers } = setup(dir);
    for (const channel of ['export:pickDir', 'export:listProfiles', 'export:saveProfile', 'export:deleteProfile', 'export:encoders', 'export:framePreview',
      'export:sourceFrame', 'export:prepare', 'export:preflight', 'export:warnings', 'export:run', 'export:cancel']) {
      assert.ok(handlers.has(channel), channel);
    }
  } finally { fx.cleanup(dir); }
});

test('export:pickDir devolve a pasta escolhida ou canceled', async () => {
  const dir = fx.tmpDir('bf-export-ipc-');
  try {
    const { call, dialogs } = setup(dir);
    assert.deepEqual(await call('export:pickDir'), { ok: true, canceled: true });
    dialogs.next = { canceled: false, filePaths: ['D:\\Cortes'] };
    assert.deepEqual(await call('export:pickDir'), { ok: true, path: 'D:\\Cortes' });
    assert.ok(dialogs.calls[1].properties.includes('openDirectory') && dialogs.calls[1].properties.includes('createDirectory'));
  } finally { fx.cleanup(dir); }
});

test('perfis: lista embutidos + meus, salva em profiles.json, recusa embutido e exclui', async () => {
  const dir = fx.tmpDir('bf-export-ipc-');
  try {
    const { call } = setup(dir);
    const list = await call('export:listProfiles');
    assert.equal(list.ok, true);
    assert.equal(list.profiles.length, 12);
    assert.equal(list.defaultId, 'vertical-1080-h264');
    assert.ok(list.profiles.every((p) => p.builtin === true));

    const saved = await call('export:saveProfile', { profile: { name: 'Meu 4:5', width: 1080, height: 1350, codec: 'h265', bitrateKbps: 9000, encoder: 'software' } });
    assert.equal(saved.ok, true);
    assert.equal(saved.profile.builtin, false);
    assert.equal(saved.profiles.length, 13);
    assert.ok(fs.existsSync(path.join(dir, 'profiles.json')), 'userData/profiles.json');

    const again = await call('export:listProfiles');
    assert.equal(again.profiles[12].name, 'Meu 4:5');
    // outro "app" com a mesma pasta de dados vê o mesmo perfil (vale para qualquer projeto)
    assert.equal((await setup(dir).call('export:listProfiles')).profiles.length, 13);

    const bad = await call('export:saveProfile', { profile: { name: 'x', width: 1081, height: 1920 } });
    assert.deepEqual([bad.ok, bad.code], [false, 'INVALID_PROFILE']);
    assert.match(bad.message, /par/);
    assert.equal((await call('export:saveProfile', { profile: { id: 'vertical-1080-h264', name: 'x', width: 1080, height: 1920 } })).code, 'PROFILE_BUILTIN');
    assert.equal((await call('export:deleteProfile', { id: 'vertical-1080-h264' })).code, 'PROFILE_BUILTIN');
    assert.equal((await call('export:deleteProfile', { id: 'user-nao-existe' })).code, 'PROFILE_NOT_FOUND');
    const del = await call('export:deleteProfile', { id: saved.profile.id });
    assert.deepEqual([del.ok, del.profiles.length], [true, 12]);
  } finally { fx.cleanup(dir); }
});

test('export:encoders testa o NVENC de verdade e guarda em userData/cache/encoders.json', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('bf-export-ipc-');
  try {
    const { call, ctx } = setup(dir);
    const res = await call('export:encoders', {});
    assert.equal(res.ok, true);
    assert.equal(res.ffmpeg, true);
    assert.deepEqual(res.detection.software, { h264: true, h265: true });
    assert.equal(res.detection.cached, false);
    assert.ok(fs.existsSync(path.join(ctx.paths.cache, 'encoders.json')));
    assert.equal((await call('export:encoders', {})).detection.cached, true);
    assert.equal((await call('export:encoders', { force: true })).detection.cached, false);
  } finally {
    encoders.resetCache();
    encoders.configure({ cacheDir: null });
    encoders.forgetMemory();
    fx.cleanup(dir);
  }
});

test('sem ffmpeg: os canais que dependem dele explicam o que fazer', async () => {
  const dir = fx.tmpDir('bf-export-ipc-');
  try {
    const { call } = setup(dir, { resolveTools: () => ({}) });
    const enc = await call('export:encoders', {});
    assert.deepEqual([enc.ok, enc.ffmpeg], [true, false]);
    assert.match(enc.message, /Instale o FFmpeg/);
    for (const channel of ['export:framePreview', 'export:sourceFrame']) {
      const res = await call(channel, { sourcePath: 'x.mp4', profile: { width: 1080, height: 1920 } });
      assert.deepEqual([res.ok, res.code], [false, 'NO_FFMPEG'], channel);
      assert.match(res.message, /Instale o FFmpeg/);
    }
  } finally { fx.cleanup(dir); }
});

test('export:framePreview: PNG do enquadramento real, nas medidas do perfil, e muda com o ajuste', { skip: skipMedia }, () => withEnv(async ({ src, call }) => {
  const profile = { width: 1080, height: 1920, codec: 'h264', bitrateKbps: 10000 };
  const png = (res) => Buffer.from(res.dataUrl.split(',')[1], 'base64');

  const small = await call('export:framePreview', { sourcePath: src, timeSec: 1, profile, framing: { mode: 'center', focusX: 0 } });
  assert.equal(small.ok, true);
  assert.match(small.dataUrl, /^data:image\/png;base64,/);
  assert.deepEqual([small.width, small.height], [360, 640], 'reduzido só para ficar leve (9:16 mantido)');
  assert.deepEqual(pngSize(png(small)), { width: 360, height: 640 });
  assert.match(small.graph, /^\[0:v\]/, 'devolve o grafo usado (o mesmo da exportação)');

  const full = await call('export:framePreview', { sourcePath: src, timeSec: 1, profile, framing: { mode: 'center', focusX: 0 }, maxSide: 0 });
  assert.deepEqual([full.width, full.height], [1080, 1920], 'sem redução: medidas exatas do perfil');

  const right = await call('export:framePreview', { sourcePath: src, timeSec: 1, profile, framing: { mode: 'center', focusX: 1 } });
  assert.notEqual(small.dataUrl, right.dataUrl, 'focusX diferente = quadro diferente');
  for (const mode of ['blur', 'stack', 'custom']) {
    const r = await call('export:framePreview', { sourcePath: src, timeSec: 1, profile, framing: { mode } });
    assert.deepEqual([r.ok, r.width, r.height], [true, 360, 640], mode);
  }
  const wide = await call('export:framePreview', { sourcePath: src, timeSec: 1, profile: { width: 1920, height: 1080 }, framing: {} });
  assert.deepEqual([wide.width, wide.height], [640, 360], 'perfil horizontal');

  assert.equal((await call('export:framePreview', { sourcePath: src, timeSec: 1, profile: { width: 1081, height: 1920 } })).code, 'INVALID_PROFILE');
  assert.equal((await call('export:framePreview', { sourcePath: path.join(path.dirname(src), 'nao-existe.mp4'), profile })).code, 'INPUT_MISSING');
  assert.equal((await call('export:framePreview', { sourcePath: src, timeSec: 900, profile })).code, 'NO_FRAME');
}));

test('export:framePreview: um pedido novo com a mesma key substitui o anterior', { skip: skipMedia }, () => withEnv(async ({ src, call }) => {
  const profile = { width: 1080, height: 1920 };
  const req = (focusX) => ({ sourcePath: src, timeSec: 1, profile, framing: { focusX }, key: 'prévia' });
  const first = call('export:framePreview', req(0));
  const second = call('export:framePreview', req(1));
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.ok, a.code], [false, 'SUPERSEDED']);
  assert.equal(b.ok, true);
}));

test('export:sourceFrame: quadro JPEG da fonte, reduzido', { skip: skipMedia }, () => withEnv(async ({ src, call }) => {
  const res = await call('export:sourceFrame', { sourcePath: src, timeSec: 2 });
  assert.equal(res.ok, true);
  assert.match(res.dataUrl, /^data:image\/jpeg;base64,/);
  assert.deepEqual([res.width, res.height], [960, 540]);
  assert.deepEqual(jpegSize(Buffer.from(res.dataUrl.split(',')[1], 'base64')), { width: 960, height: 540 });
  const small = await call('export:sourceFrame', { sourcePath: src, timeSec: 2, maxWidth: 480 });
  assert.deepEqual([small.width, small.height], [480, 270]);
  assert.equal((await call('export:sourceFrame', { sourcePath: '', timeSec: 0 })).code, 'INPUT_MISSING');
}));

test('export:prepare: monta os Jobs (3.3) dos cortes escolhidos, com nome, enquadramento resolvido e QC de cada um', { skip: skipMedia }, () => withEnv(async ({ dir, src, call }) => {
  const profile = { id: 'vertical-1080-h264', name: 'Vertical', kind: 'vertical', width: 1080, height: 1920, codec: 'h264', bitrateKbps: 10000, encoder: 'software', fps: 'source', container: 'mp4' };
  const outputDir = path.join(dir, 'Cortes');
  const res = await call('export:prepare', {
    project: project(src), info: { width: 1920, height: 1080, fps: 10, duration: 4, hasAudio: true },
    cutIds: ['c1', 'c2'], profile, framing: { zoom: 1.4 }, outputDir, nameTemplate: '{fonte} - corte {n} - {titulo}'
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.jobs.map((j) => j.cut.id), ['c1', 'c2'], 'ordem cronológica');
  assert.deepEqual(res.jobs.map((j) => j.baseName), ['gameplay 01 - corte 01 - Primeiro', 'gameplay 01 - corte 02 - Segundo']);
  const [j1, j2] = res.jobs;
  assert.deepEqual(Object.keys(j1).sort(), ['baseName', 'createdAt', 'cut', 'framing', 'framingSource', 'id', 'onConflict', 'outputDir', 'profile', 'projectId', 'projectTitle', 'sourceInfo', 'sourcePath']);
  assert.equal(j1.onConflict, 'ask');
  assert.equal(j1.sourcePath, src);
  assert.deepEqual(j1.sourceInfo, { width: 1920, height: 1080, fps: 10, duration: 4, hasAudio: true });
  assert.equal(j1.framing.mode, 'blur', 'ajuste do corte');
  assert.equal(j2.framing.mode, 'center');
  assert.equal(j2.framing.zoom, 1.4, 'padrão do projeto');
  assert.equal(j1.profile.bitrateKbps, 10000);
  assert.equal(res.reports.length, 2);
  assert.deepEqual(res.reports.map((r) => r.jobId), [j1.id, j2.id]);
  for (const r of res.reports) {
    assert.deepEqual(r.errors, []);
    assert.ok(Array.isArray(r.warnings));
  }
  assert.ok(res.reports[0].warnings.length === 0 || res.reports[0].warnings.every((w) => typeof w.message === 'string'));
  assert.ok(!fs.existsSync(outputDir), 'preparar não cria nada na pasta de destino');

  // um corte que não existe volta em `missing`; nome repetido do lote vira aviso
  const dup = await call('export:prepare', { project: project(src), cutIds: ['c1', 'c2', 'zzz'], profile, outputDir, nameTemplate: 'mesmo nome' });
  assert.deepEqual(dup.missing, ['zzz']);
  for (const r of dup.reports) assert.ok(r.warnings.some((w) => w.code === 'NAME_DUPLICATE'));

  // erros do QC aparecem por corte e não impedem os outros
  const mixed = project(src);
  mixed.cuts[0].end = 99;
  const q = await call('export:prepare', { project: mixed, info: { width: 1920, height: 1080, fps: 10, duration: 4, hasAudio: true }, cutIds: ['c1', 'c2'], profile, outputDir });
  assert.deepEqual(q.reports.map((r) => r.errors.length), [0, 1]);
  assert.equal(q.reports[1].errors[0].code, 'INVALID_RANGE');
  assert.equal(q.reports[1].cutId, 'c2');

  // entradas inválidas
  assert.equal((await call('export:prepare', { project: project(src), cutIds: ['c1'], profile: { ...profile, width: 1081 }, outputDir })).code, 'INVALID_PROFILE');
  assert.equal((await call('export:prepare', { project: project(src), cutIds: ['c1'], profile, outputDir: '' })).code, 'OUTPUT_NOT_WRITABLE');
  assert.equal((await call('export:prepare', { project: null, cutIds: [], profile, outputDir })).code, 'INVALID_PROJECT');
  assert.equal((await call('export:prepare', { project: project(src), profile, outputDir })).code, 'INVALID_ARGS');
}));

test('export:preflight: confere Jobs já montados (o que a fila usa antes de rodar)', { skip: skipMedia }, () => withEnv(async ({ dir, src, call }) => {
  const profile = { id: 'v', name: 'V', kind: 'vertical', width: 1080, height: 1920, codec: 'h265', bitrateKbps: 10000, encoder: 'auto', fps: 'source', container: 'mp4' };
  const prep = await call('export:prepare', { project: project(src), cutIds: ['c1'], profile, outputDir: path.join(dir, 'Cortes') });
  const job = prep.jobs[0];
  const res = await call('export:preflight', { jobs: [job, { ...job, id: 'ruim', sourcePath: path.join(dir, 'sumiu.mp4') }] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.reports[0].errors, []);
  assert.ok(res.reports[0].warnings.some((w) => w.code === 'HEVC_COMPAT'));
  assert.deepEqual(res.reports[1].errors.map((e) => e.code), ['INPUT_MISSING']);
  assert.equal((await call('export:preflight', {})).code, 'INVALID_ARGS');
}));

test('os Jobs montados por export:prepare rodam de ponta a ponta no jobRunner (contrato 3.3)', { skip: skipMedia }, () => withEnv(async ({ dir, src, call, ctx }) => {
  const { runExportJob } = require('../src/core/export/jobRunner');
  const profile = { id: 'v', name: 'V', kind: 'vertical', width: 720, height: 1280, codec: 'h264', bitrateKbps: 6000, encoder: 'software', fps: 'source', container: 'mp4' };
  const prep = await call('export:prepare', { project: project(src), info: { width: 1920, height: 1080, fps: 10, duration: 4, hasAudio: true }, cutIds: ['c1', 'c2'], profile, outputDir: path.join(dir, 'Cortes') });
  for (const job of prep.jobs) {
    const res = await runExportJob({ ...job, onConflict: 'rename' }, { tools: ctx.tools });
    const info = await fx.probe(res.output);
    assert.deepEqual([info.width, info.height], [720, 1280]);
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, 'Cortes')).sort(), ['gameplay 01 - corte 01 - Primeiro.mp4', 'gameplay 01 - corte 02 - Segundo.mp4']);
}));

test('canais legados da exportação mínima continuam funcionando sobre o motor novo', { skip: skipMedia }, () => withEnv(async ({ dir, src, call, sent }) => {
  const w = await call('export:warnings', { profile: { resolution: 2160, codec: 'h265' }, source: { width: 1920, height: 1080 } });
  assert.deepEqual([w.ok, w.errors.length, w.warnings.length], [true, 0, 2]);
  assert.equal((await call('export:warnings', { profile: { resolution: 720 }, source: { width: 1920, height: 1080 } })).errors.length, 1);
  const req = { input: src, outputDir: path.join(dir, 'Legado'), baseName: 'corte 01', startSec: 0.5, endSec: 2, profile: { resolution: 1080, codec: 'h264', bitrateKbps: 4000 }, onConflict: 'fail' };
  const run = await call('export:run', req);
  assert.equal(run.ok, true);
  assert.ok(sent.some(([channel]) => channel === 'export:progress'));
  assert.equal((await call('export:run', req)).code, 'OUTPUT_EXISTS');
  assert.match((await call('export:run', { ...req, onConflict: 'rename' })).output, /\(2\)\.mp4$/);
  assert.equal((await call('export:cancel')).ok, true);
}));

// ---------- perfis: arquivo ilegível não derruba a lista ----------

test('export:listProfiles: profiles.json ilegível (pasta no lugar do arquivo) não zera a lista: os 12 embutidos voltam com um aviso em português', async () => {
  const dir = fx.tmpDir('bf-export-ipc-');
  try {
    const { call } = setup(dir);
    fs.mkdirSync(path.join(dir, 'profiles.json')); // EISDIR ao ler
    const res = await call('export:listProfiles');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.profiles.length, 12, 'os embutidos não dependem do arquivo');
    assert.ok(res.profiles.every((p) => p.builtin === true));
    assert.equal(res.defaultId, 'vertical-1080-h264');
    assert.match(res.warning, /Seus perfis salvos não puderam ser carregados.*só os perfis do app aparecem/);
    // com o arquivo saudável não há aviso
    fs.rmSync(path.join(dir, 'profiles.json'), { recursive: true });
    const ok = await call('export:listProfiles');
    assert.equal(ok.warning, undefined);
    assert.equal(ok.profiles.length, 12);
  } finally { fx.cleanup(dir); }
});

test('export:saveProfile preserva entradas que o app não entende no profiles.json', async () => {
  const dir = fx.tmpDir('bf-export-ipc-');
  try {
    const { call } = setup(dir);
    const file = path.join(dir, 'profiles.json');
    const future = { id: 'user-futuro', name: 'Futuro', width: 1080, height: 1920, codec: 'av1', bitrateKbps: 8000 };
    fs.writeFileSync(file, JSON.stringify({ version: 2, profiles: [future] }));
    assert.equal((await call('export:listProfiles')).profiles.length, 12, 'a entrada de codec desconhecido não aparece na lista');
    const saved = await call('export:saveProfile', { profile: { name: 'Meu 4:5', width: 1080, height: 1350 } });
    assert.equal(saved.ok, true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.version, 2);
    assert.deepEqual(onDisk.profiles.find((p) => p.id === 'user-futuro'), future, 'a entrada continua no arquivo');
    assert.equal(onDisk.profiles.length, 2);
  } finally { fx.cleanup(dir); }
});

// ---------- quadros nos últimos instantes do vídeo ----------

test('export:framePreview e export:sourceFrame funcionam até o último instante do vídeo (o controle da prévia chega ao fim do corte)', { skip: skipMedia }, () => withEnv(async ({ src, call }) => {
  const profile = { width: 1080, height: 1920, codec: 'h264', bitrateKbps: 10000 };
  // o vídeo tem 4,000 s a 10 quadros/s: o último quadro está em 3,9 s
  for (const timeSec of [3.9, 3.95, 3.99, 4]) {
    const prev = await call('export:framePreview', { sourcePath: src, timeSec, profile, framing: { mode: 'center' } });
    assert.equal(prev.ok, true, `framePreview em ${timeSec}: ${JSON.stringify({ ...prev, dataUrl: undefined })}`);
    assert.deepEqual([prev.width, prev.height], [360, 640]);
    const frame = await call('export:sourceFrame', { sourcePath: src, timeSec });
    assert.equal(frame.ok, true, `sourceFrame em ${timeSec}: ${JSON.stringify({ ...frame, dataUrl: undefined })}`);
    assert.deepEqual([frame.width, frame.height], [960, 540]);
  }
  // bem depois do fim continua sendo "sem quadro", com a mensagem de sempre
  const far = await call('export:sourceFrame', { sourcePath: src, timeSec: 900 });
  assert.deepEqual([far.ok, far.code], [false, 'NO_FRAME']);
  assert.match(far.message, /Não foi possível ler um quadro/);
}));

// ---------- QC pelo canal: faixas de áudio da fonte ----------

test('export:prepare: fonte com 2 faixas de áudio (info do probe de verdade) devolve o aviso AUDIO_TRACKS no relatório do corte, sem erro', { skip: skipMedia }, () => withEnv(async ({ dir, call, ctx }) => {
  const multi = path.join(dir, 'obs.mkv');
  fx.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=10:d=4', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', multi]);
  const { probeMedia } = require('../src/core/ffmpeg/probe');
  const info = await probeMedia(ctx.tools.ffprobe, multi);
  assert.equal(info.audioTracks, 2);
  const profile = { id: 'v', name: 'V', kind: 'custom', width: 360, height: 640, codec: 'h264', bitrateKbps: 4000, encoder: 'software', fps: 'source', container: 'mp4' };
  const proj = { id: 'p', version: 2, source: { path: multi, duration: 4, width: 640, height: 360 }, cuts: [{ id: 'c1', title: 'Um', start: 0.5, end: 2, status: 'approved' }] };
  const res = await call('export:prepare', { project: proj, info, cutIds: ['c1'], profile, outputDir: path.join(dir, 'Cortes') });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.jobs[0].sourceInfo, { width: 640, height: 360, fps: 10, duration: info.duration, hasAudio: true, audioTracks: 2 });
  assert.deepEqual(res.reports[0].errors, []);
  assert.ok(res.reports[0].warnings.some((w) => w.code === 'AUDIO_TRACKS' && /2 faixas de áudio/.test(w.message)), JSON.stringify(res.reports[0].warnings));
}));

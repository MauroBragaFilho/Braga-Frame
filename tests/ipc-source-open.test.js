'use strict';

/**
 * source:open com o ffprobe SIMULADO (não precisa de FFmpeg): projeto corrompido (o app precisa avisar, nunca fazer os cortes
 * sumirem em silêncio), leitura passageira falhando (EBUSY não é corrupção) e fonte sem duração no cabeçalho.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// o handler pega `probeMedia` na hora em que é carregado: troca antes de carregar o src/ipc
const probe = require('../src/core/ffmpeg/probe');
let nextInfo = null;
probe.probeMedia = async () => ({ ...nextInfo });
const { setupIpc } = require('../src/ipc');
const { newProject, projectIdFor } = require('../src/core/projects/projectStore');

const silent = { log() {}, info() {}, warn() {}, error() {} };
const INFO = { duration: 60, width: 1920, height: 1080, fps: 30, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, bitrate: 0, size: 10, durationSource: 'format' };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-srcopen-'));
  const video = path.join(dir, 'live.mp4');
  fs.writeFileSync(video, 'x');
  const handlers = new Map();
  const deps = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: () => path.join(dir, 'ud'), getVersion: () => '1.0.0' },
    dialog: {}, shell: {},
    getWindow: () => null,
    logger: silent,
    resolveTools: () => ({ ffmpeg: 'ffmpeg', ffprobe: process.execPath })
  };
  const ctx = setupIpc(deps);
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  return { dir, video, ctx, call, file: ctx.projectStore.fileFor(video) };
}

function savedProjectWithCuts(ctx, video) {
  const project = newProject(video, INFO);
  project.cuts.push({ id: 'c1', title: 'Clutch final', start: 5, end: 20, status: 'approved' }, { id: 'c2', title: 'Falha', start: 30, end: 40, status: 'rejected' });
  return ctx.projectStore.save(project);
}

test('projeto truncado (queda de energia) e sem cópia: o app abre um projeto novo MAS avisa, com o caminho do arquivo guardado', async () => {
  const { dir, video, ctx, call, file } = setup();
  try {
    nextInfo = INFO;
    savedProjectWithCuts(ctx, video);
    const whole = fs.readFileSync(file, 'utf8');
    fs.rmSync(`${file}.bak`, { force: true });
    fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)));

    const res = await call('source:open', { path: video });
    assert.equal(res.ok, true);
    assert.equal(res.restored, false);
    assert.equal(res.project.cuts.length, 0, 'sem cópia, o projeto recomeça vazio');
    assert.ok(res.recovered, 'a interface recebe o aviso (antes o usuário só via os cortes sumirem)');
    assert.equal(res.recovered.restoredFromBackup, false);
    assert.ok(res.recovered.file.endsWith('.corrupt') && fs.existsSync(res.recovered.file), 'o arquivo danificado foi preservado');
    assert.equal(fs.readFileSync(res.recovered.file, 'utf8'), whole.slice(0, Math.floor(whole.length / 2)), 'intacto, byte a byte');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2, 'o projeto novo foi gravado normalmente');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('projeto truncado COM a cópia da última versão boa: os cortes voltam e o aviso diz que foi da cópia', async () => {
  const { dir, video, ctx, call, file } = setup();
  try {
    nextInfo = INFO;
    savedProjectWithCuts(ctx, video);
    // o app grava mais de uma vez: a segunda gravação guarda a primeira como .bak
    const second = ctx.projectStore.load(video);
    second.cuts[0].title = 'Clutch final (editado)';
    ctx.projectStore.save(second);
    assert.ok(fs.existsSync(`${file}.bak`), 'a gravação guardou a versão anterior');
    const whole = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, whole.slice(0, 120));

    // a conferência de "fonte atualizada" (prefs:inspect) carrega o projeto ANTES de source:open e faz a recuperação sozinha:
    // o aviso não pode ficar com ela
    assert.equal(ctx.projectStore.load(video).cuts.length, 2);

    const res = await call('source:open', { path: video });
    assert.equal(res.ok, true);
    assert.equal(res.restored, true);
    assert.deepEqual(res.project.cuts.map((c) => c.title), ['Clutch final', 'Falha'], 'a versão boa anterior à edição que se perdeu');
    assert.equal(res.recovered.restoredFromBackup, true);
    assert.match(res.recovered.backupAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(fs.readFileSync(res.recovered.file, 'utf8'), whole.slice(0, 120), 'o danificado fica guardado');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).cuts.length, 2, 'e o principal voltou a ser um projeto válido');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('projeto íntegro: sem aviso de recuperação', async () => {
  const { dir, video, ctx, call } = setup();
  try {
    nextInfo = INFO;
    savedProjectWithCuts(ctx, video);
    const res = await call('source:open', { path: video });
    assert.equal(res.restored, true);
    assert.equal(res.recovered, undefined);
    assert.equal(res.warnings, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('leitura passageira falhando (EBUSY de antivírus) NÃO é corrupção: erro claro e o arquivo bom continua no lugar', async () => {
  const { dir, video, ctx, call, file } = setup();
  try {
    nextInfo = INFO;
    savedProjectWithCuts(ctx, video);
    const before = fs.readFileSync(file, 'utf8');
    const realFs = ctx.projectStore.fs;
    ctx.projectStore.retries = 1;
    ctx.projectStore.retryDelayMs = 1;
    ctx.projectStore.fs = new Proxy(realFs, {
      get(target, prop) {
        if (prop === 'readFileSync') return (f, ...rest) => { if (String(f) === file) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); return target.readFileSync(f, ...rest); };
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const res = await call('source:open', { path: video });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'PROJECT_UNREADABLE');
    assert.match(res.message, /em uso por outro programa.*Nada foi alterado/s);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.corrupt')), [], 'nada foi movido para .corrupt');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'o arquivo bom ficou como estava');

    ctx.projectStore.fs = realFs; // passou o susto: abre normalmente
    const again = await call('source:open', { path: video });
    assert.equal(again.ok, true);
    assert.equal(again.project.cuts.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fonte sem duração no cabeçalho (nem pela leitura dos pacotes): abre e AVISA com a causa e o que fazer', async () => {
  const { dir, video, call } = setup();
  try {
    nextInfo = { ...INFO, duration: 0, durationSource: 'unknown' };
    const res = await call('source:open', { path: video });
    assert.equal(res.ok, true);
    assert.equal(res.info.duration, 0);
    assert.deepEqual(res.warnings.map((w) => w.code), ['DURATION_UNKNOWN']);
    assert.match(res.warnings[0].message, /não informa a duração.*Remux de Gravações/s);

    nextInfo = { ...INFO, duration: 61.5, durationSource: 'scan' };
    const found = await call('source:open', { path: video });
    assert.equal(found.warnings, undefined, 'duração achada: nada a avisar');
    assert.equal(found.project.source.duration, 61.5);
    assert.equal(projectIdFor(video), found.project.id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

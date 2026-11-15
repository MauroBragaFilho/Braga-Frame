'use strict';

/**
 * Apagar um projeto (lixeira da aba Projetos) e a miniatura dele. Pastas temporárias de verdade, arquivos de verdade e os handlers de verdade
 * (setupIpc com um Electron falso); só o erro passageiro do Windows (arquivo em uso) é simulado, porque não dá para provocá-lo à vontade.
 *
 * O que estes testes protegem, nesta ordem de importância:
 *   1. o vídeo do usuário, a legenda dele e qualquer arquivo que o app não possa PROVAR que é dele nunca saem, mesmo com "apagar os arquivos";
 *   2. nada é apagado com exportação na fila ou análise/transcrição em andamento, e nada grava o projeto de volta no meio da exclusão;
 *   3. o projeto, os dados dele e o rastro na fila saem por inteiro, com o arquivo do projeto por último.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setupIpc } = require('../src/ipc');
const { ProjectStore, newProject, projectIdFor } = require('../src/core/projects/projectStore');
const projectFiles = require('../src/core/projects/projectFiles');
const { locateTools } = require('../src/core/ffmpeg/locate');

const silent = { log() {}, info() {}, warn() {}, error() {} };
const ffmpegPath = locateTools().ffmpeg;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmp = (t, name = 'prjdel') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bf-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
};
const write = (file, size = 100) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size, 7));
  return file;
};
const names = (dir) => fs.readdirSync(dir).sort();
const exists = (file) => fs.existsSync(file);

// ---------- ProjectStore: remove e peekById ----------

test('ProjectStore.remove: apaga o principal, a cópia, a .v1.bak, os .corrupt e os .tmp DESTE projeto (o principal por último) e nada de outro', (t) => {
  const dir = tmp(t);
  const unlinked = [];
  const spy = new Proxy(fs, { get: (target, prop) => (prop === 'unlinkSync' ? (f) => { unlinked.push(path.basename(f)); return target.unlinkSync(f); } : target[prop]) });
  const store = new ProjectStore(dir, { fsImpl: spy });
  const a = store.save(newProject(path.join(dir, 'a.mp4'), { size: 1, duration: 60 }));
  const b = store.save(newProject(path.join(dir, 'b.mp4'), { size: 1, duration: 60 }));
  store.save({ ...a, title: 'segunda gravação (cria a cópia .bak)' });
  write(path.join(dir, `${a.id}.json.v1.bak`), 10);
  write(path.join(dir, `${a.id}.json.1700000000.corrupt`), 20);
  write(path.join(dir, `${a.id}.json.99.tmp`), 5);
  write(path.join(dir, 'leia-me.txt'), 3); // não é de projeto nenhum
  assert.ok(names(dir).includes(`${a.id}.json.bak`), 'a segunda gravação criou a cópia');
  const out = store.remove(a.id);
  assert.equal(out.files, 5);
  assert.ok(out.bytes > 0);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(names(dir).filter((n) => n.startsWith(a.id)), []);
  assert.deepEqual(names(dir).sort(), [`${b.id}.json`, 'leia-me.txt'].concat(names(dir).filter((n) => n.startsWith(b.id) && n !== `${b.id}.json`)).sort(), 'o outro projeto e o arquivo alheio ficam');
  assert.equal(unlinked[unlinked.length - 1], `${a.id}.json`, 'o arquivo principal é o último a sair');
  assert.equal(store.loadById(b.id).id, b.id);
  assert.equal(store.remove(a.id).files, 0, 'apagar de novo não acha nada e não falha');
  for (const bad of [undefined, null, '', '../x', 'zz', 'ABCDEFABCDEFABCD', `${b.id}0`]) assert.throws(() => store.remove(bad), (err) => err.code === 'INVALID_ARGS', String(bad));
});

test('ProjectStore.remove: um arquivo que não sai (em uso) é relatado e os outros saem; o principal só sai se o resto já saiu da frente', (t) => {
  const dir = tmp(t);
  const real = fs;
  const spy = new Proxy(fs, {
    get: (target, prop) => (prop === 'unlinkSync'
      ? (f) => { if (f.endsWith('.bak')) throw Object.assign(new Error('em uso'), { code: 'EPERM' }); return real.unlinkSync(f); }
      : target[prop])
  });
  const store = new ProjectStore(dir, { fsImpl: spy, retries: 1, retryDelayMs: 1 });
  const p = store.save(newProject(path.join(dir, 'a.mp4'), { size: 1, duration: 60 }));
  store.save({ ...p });
  const out = store.remove(p.id);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].name, `${p.id}.json.bak`);
  assert.equal(out.failed[0].code, 'EPERM');
  assert.equal(exists(path.join(dir, `${p.id}.json`)), false, 'o principal saiu');
  assert.equal(exists(path.join(dir, `${p.id}.json.bak`)), true, 'a cópia em uso ficou e foi relatada');
});

test('ProjectStore.peekById: lê sem mexer em nada (arquivo corrompido continua no lugar) e devolve o erro; id inválido não lança', (t) => {
  const dir = tmp(t);
  const store = new ProjectStore(dir);
  const p = store.save(newProject(path.join(dir, 'a.mp4'), { size: 1, duration: 60 }));
  assert.equal(store.peekById(p.id).project.id, p.id);
  const file = path.join(dir, `${p.id}.json`);
  fs.writeFileSync(file, '{ quebrado');
  const before = names(dir);
  const bad = store.peekById(p.id);
  assert.equal(bad.project, undefined);
  assert.equal(bad.error.code, 'INVALID_PROJECT');
  assert.deepEqual(names(dir), before, 'nenhum .corrupt foi criado e nenhuma cópia foi restaurada (loadById faria isso)');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ quebrado');
  assert.equal(store.peekById('0123456789abcdef').error.code, 'PROJECT_UNREADABLE', 'arquivo que não existe');
  assert.equal(store.peekById('xx').error.code, 'INVALID_ARGS');
});

// ---------- projectFiles ----------

test('exportFiles: só entra o que o projeto anotou, é caminho absoluto de vídeo, existe como arquivo comum e não é vídeo de origem; as legendas ao lado acompanham', async (t) => {
  const dir = tmp(t);
  const out = path.join(dir, 'Cortes');
  const a = write(path.join(out, 'a.mp4'), 100);
  write(path.join(out, 'a.srt'), 10);
  write(path.join(out, 'a.ass'), 7);
  const b = write(path.join(out, 'b.MP4'), 50);
  const notes = write(path.join(dir, 'notas.txt'), 5);
  const source = write(path.join(dir, 'origem.mp4'), 300);
  const folder = path.join(dir, 'pasta.mp4');
  fs.mkdirSync(folder);
  let linked = null;
  try { fs.symlinkSync(a, path.join(out, 'atalho.mp4'), 'file'); linked = path.join(out, 'atalho.mp4'); } catch { /* sem privilégio para criar link: o resto do teste vale igual */ }
  const project = {
    cuts: [
      { id: 'c1', exports: [{ path: a }, { path: a }, { path: b }, { path: path.join(out, 'sumiu.mp4') }] },
      { id: 'c2', exports: [{ path: notes }, { path: source }, { path: folder }, { path: 'relativo/x.mp4' }, { path: '' }, { path: 42 }, null, ...(linked ? [{ path: linked }] : [])] }
    ]
  };
  const res = await projectFiles.exportFiles(project, { protectedPaths: new Set([projectFiles.normPath(source)]) });
  assert.deepEqual(res.files.map((f) => `${f.kind}:${path.basename(f.file)}`).sort(), ['export:a.mp4', 'export:b.MP4', 'sidecar:a.ass', 'sidecar:a.srt']);
  assert.equal(res.missing, 1, 'só a exportação que já não existe conta como sumida (o usuário costuma apagar à mão)');
  assert.equal(projectFiles.sumBytes(res.files), 100 + 10 + 7 + 50);
  assert.deepEqual(res.files.filter((f) => f.kind === 'export').map((f) => f.cutId), ['c1', 'c1']);
  assert.deepEqual(await projectFiles.exportFiles({ cuts: [] }), { files: [], missing: 0 });
  assert.deepEqual(await projectFiles.exportFiles(null), { files: [], missing: 0 });
  // o que não entrou continua intacto
  for (const kept of [notes, source, folder]) assert.ok(exists(kept), kept);
});

test('downloadFiles: só com o registro de download do app apontando para o vídeo DESTE projeto; o chat só se for .json; sem registro nada é do app', async (t) => {
  const dir = tmp(t);
  const video = write(path.join(dir, 'vod.mp4'), 500);
  const chat = write(path.join(dir, 'vod.chat.json'), 40);
  const project = { source: { path: video } };
  assert.equal(await projectFiles.downloadFiles(project, null), null);
  assert.equal(await projectFiles.downloadFiles(project, undefined), null);
  assert.equal(await projectFiles.downloadFiles(project, { path: path.join(dir, 'outro.mp4'), chat: { path: chat } }), null, 'registro de outro vídeo não prova nada');
  const ok = await projectFiles.downloadFiles(project, { path: video, chat: { path: chat } });
  assert.deepEqual(ok, { video: { file: video, bytes: 500 }, chat: { file: chat, bytes: 40 } });
  const txt = write(path.join(dir, 'vod.chat.txt'), 9);
  assert.equal((await projectFiles.downloadFiles(project, { path: video, chat: { path: txt } })).chat, null, 'chat que não é .json não entra');
  assert.equal((await projectFiles.downloadFiles(project, { path: video, chat: { path: video } })).chat, null, 'o chat nunca é o próprio vídeo');
  assert.equal((await projectFiles.downloadFiles(project, { path: video, chat: { path: path.join(dir, 'nao-existe.json') } })).chat, null);
  fs.rmSync(video);
  assert.deepEqual(await projectFiles.downloadFiles(project, { path: video, chat: { path: chat } }), { video: null, chat: { file: chat, bytes: 40 } }, 'vídeo que já sumiu não é listado');
});

test('dataFiles: só <pasta>/<id>.* de cada pasta própria; id inválido ou outro projeto não casa', async (t) => {
  const dir = tmp(t);
  const id = '0123456789abcdef';
  const other = 'fedcba9876543210';
  write(path.join(dir, 'history', `${id}.json`), 11);
  write(path.join(dir, 'transcripts', `${id}.json`), 22);
  write(path.join(dir, 'transcripts', `${id}.partial.json`), 33);
  write(path.join(dir, 'thumbs', `${id}.abcdef0123.jpg`), 44);
  write(path.join(dir, 'history', `${other}.json`), 55);
  write(path.join(dir, 'history', `${id}x.json`), 66); // não começa com "<id>."
  const dirs = { history: path.join(dir, 'history'), transcripts: path.join(dir, 'transcripts'), thumbs: path.join(dir, 'thumbs'), ausente: path.join(dir, 'nao-existe') };
  const found = await projectFiles.dataFiles(id, dirs);
  assert.deepEqual(found.map((f) => `${f.kind}:${path.basename(f.file)}`).sort(), [`history:${id}.json`, `thumbs:${id}.abcdef0123.jpg`, `transcripts:${id}.json`, `transcripts:${id}.partial.json`].sort());
  assert.equal(projectFiles.sumBytes(found), 11 + 22 + 33 + 44);
  for (const bad of ['', 'xx', '../etc', 'ABCDEFABCDEFABCD', null, undefined]) assert.deepEqual(await projectFiles.dataFiles(bad, dirs), [], String(bad));
});

test('removeFile: repete o erro passageiro do Windows, aceita arquivo que já sumiu e relata o que não deu, sem lançar', async (t) => {
  const dir = tmp(t);
  const file = write(path.join(dir, 'x.mp4'), 10);
  const original = fs.promises.unlink;
  t.after(() => { fs.promises.unlink = original; });
  let calls = 0;
  fs.promises.unlink = async (f) => { calls += 1; if (calls <= 2) throw Object.assign(new Error('em uso'), { code: 'EBUSY' }); return original(f); };
  assert.deepEqual(await projectFiles.removeFile(file, { delayMs: 1 }), { ok: true });
  assert.equal(calls, 3, 'duas recusas passageiras e a terceira tentativa apagou');
  assert.equal(exists(file), false);
  assert.deepEqual(await projectFiles.removeFile(file), { ok: true, missing: true }, 'o arquivo já sumiu: nada a fazer');
  fs.promises.unlink = async () => { throw Object.assign(new Error('x'), { code: 'EBUSY' }); };
  const busy = await projectFiles.removeFile(write(path.join(dir, 'y.mp4'), 1), { retries: 2, delayMs: 1 });
  assert.equal(busy.ok, false);
  assert.equal(busy.code, 'EBUSY');
  assert.match(busy.message, /em uso por outro programa/);
  fs.promises.unlink = async () => { throw Object.assign(new Error('falha de leitura no disco'), { code: 'EIO' }); };
  const other = await projectFiles.removeFile(write(path.join(dir, 'z.mp4'), 1), { retries: 3, delayMs: 1 });
  assert.deepEqual([other.ok, other.code], [false, 'EIO']);
  assert.match(other.message, /falha de leitura no disco/);
  const all = await projectFiles.removeAll([{ file: path.join(dir, 'y.mp4'), kind: 'export' }, { file: path.join(dir, 'z.mp4'), kind: 'export' }]);
  assert.equal(all.removed.length, 0);
  assert.equal(all.failed.length, 2, 'uma falha não impede de tentar as outras');
});

test('pruneDefaultExportDir: tira a pasta "Cortes" padrão só se ficou vazia; nunca uma pasta com arquivo nem a que o usuário escolheu', async (t) => {
  const dir = tmp(t);
  const video = write(path.join(dir, 'live.mp4'), 10);
  const project = { source: { path: video }, exportDir: null };
  const cortes = path.join(dir, 'Cortes');
  fs.mkdirSync(cortes);
  assert.equal(await projectFiles.pruneDefaultExportDir(project), true);
  assert.equal(exists(cortes), false);
  write(path.join(cortes, 'de-outro-projeto.mp4'), 1);
  assert.equal(await projectFiles.pruneDefaultExportDir(project), false, 'com arquivo dentro a pasta fica');
  assert.ok(exists(path.join(cortes, 'de-outro-projeto.mp4')));
  fs.rmSync(cortes, { recursive: true });
  fs.mkdirSync(cortes);
  assert.equal(await projectFiles.pruneDefaultExportDir({ ...project, exportDir: path.join(dir, 'Minhas exportações') }), false, 'pasta escolhida pelo usuário: nada a fazer com a padrão');
  assert.equal(await projectFiles.pruneDefaultExportDir({ ...project, exportDir: cortes }), true, 'a escolha igual à padrão conta como padrão');
  assert.equal(await projectFiles.pruneDefaultExportDir(null), false);
});

// ---------- os canais do handler ----------

function world(t, { tools = false } = {}) {
  const dir = tmp(t);
  const ud = path.join(dir, 'ud');
  const videos = path.join(dir, 'Videos');
  fs.mkdirSync(videos, { recursive: true });
  const handlers = new Map();
  const saved = process.env.BF_VIDEOS_DIR;
  process.env.BF_VIDEOS_DIR = videos; // nada deste teste chega perto da pasta Vídeos de verdade
  const ctx = setupIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: (name) => (name === 'videos' ? videos : ud), getVersion: () => '1.0.0', on() {} },
    dialog: {}, shell: {}, getWindow: () => null, logger: silent,
    resolveTools: () => ({ ffmpeg: tools ? ffmpegPath : null, ffprobe: null })
  });
  if (saved === undefined) delete process.env.BF_VIDEOS_DIR; else process.env.BF_VIDEOS_DIR = saved;
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  return { dir, ud, videos, ctx, call };
}

let exportSeq = 0;
const exportEntry = (file) => { exportSeq += 1; return { path: file, at: '2026-10-23T10:00:00.000Z', start: 0, end: 10, profile: { id: 'vertical-1080-h264' }, jobId: `j${exportSeq}`, key: `k${exportSeq}`, revision: 1 }; };

/** Projeto salvo para um vídeo de mentira (2 KB) na pasta Vídeos de teste. */
function addProject(w, name, { cuts = [], origin = null, exportDir = null } = {}) {
  const file = write(path.join(w.videos, `${name}.mp4`), 2048);
  const project = newProject(file, { size: 2048, duration: 600 }, origin);
  project.cuts = cuts;
  if (exportDir) project.exportDir = exportDir;
  const saved = w.ctx.projectStore.save(project);
  return { file, id: saved.id, project: saved };
}
const cut = (id, status, exports = []) => ({ id, title: `Corte ${id}`, start: 0, end: 10, status, exports });

/** Dados do projeto fora da pasta de projetos: histórico, transcrição (e rascunho) e miniatura. */
function addData(w, id) {
  return [
    write(path.join(w.ud, 'history', `${id}.json`), 30),
    write(path.join(w.ud, 'transcripts', `${id}.json`), 40),
    write(path.join(w.ud, 'transcripts', `${id}.partial.json`), 20),
    write(path.join(w.ud, 'cache', 'thumbs', `${id}.0123456789.jpg`), 50)
  ];
}

/** O mundo do teste principal: um VOD baixado pelo app (com chat e exportações) e um vídeo do usuário (com a legenda dele ao lado). */
function scenario(t) {
  const w = world(t);
  const out = path.join(w.videos, 'Cortes');
  const e1 = write(path.join(out, 'vod - corte 01.mp4'), 1000);
  const e1s = write(path.join(out, 'vod - corte 01.srt'), 10);
  const e2 = write(path.join(out, 'vod - corte 02.mp4'), 2000);
  const gone = path.join(out, 'vod - corte 03.mp4'); // anotada, mas o usuário já apagou
  const vod = addProject(w, 'vod baixado', {
    origin: { type: 'vod', platform: 'youtube', title: 'Live de teste', channel: 'Canal' },
    cuts: [cut('c1', 'approved', [exportEntry(e1)]), cut('c2', 'approved', [exportEntry(e2), exportEntry(gone)]), cut('c3', 'pending'), cut('c4', 'rejected')]
  });
  const chat = write(path.join(w.videos, 'vod baixado.chat.json'), 300);
  const userSrt = write(path.join(w.videos, 'vod baixado.srt'), 15); // legenda do USUÁRIO ao lado do vídeo baixado
  w.ctx.sources.store.recordDownload({ path: vod.file, origin: { type: 'vod', title: 'Live de teste' }, chat: { path: chat }, meta: {} });
  const own = addProject(w, 'minha gravacao', { cuts: [cut('d1', 'approved')] });
  const ownSrt = write(path.join(w.videos, 'minha gravacao.srt'), 12);
  return { w, out, e1, e1s, e2, gone, vod, chat, userSrt, own, ownSrt, vodData: addData(w, vod.id), ownData: addData(w, own.id) };
}

test('project:deletePreview conta o que sairia sem apagar nada: dados, exportações com legendas, vídeo e chat baixados; o vídeo do usuário fica', async (t) => {
  const s = scenario(t);
  const before = names(s.w.videos);
  const vod = (await s.w.call('project:deletePreview', { id: s.vod.id })).plan;
  assert.equal(vod.title, 'Live de teste');
  assert.deepEqual(vod.cuts, { total: 4, pending: 1, approved: 2, rejected: 1 });
  assert.equal(vod.busy, null);
  assert.equal(vod.unreadable, false);
  assert.equal(vod.data.files, 4);
  assert.equal(vod.data.bytes, 30 + 40 + 20 + 50);
  assert.deepEqual(vod.exports, { files: 2, sidecars: 1, bytes: 1000 + 10 + 2000, missing: 1 });
  assert.deepEqual(vod.download, { video: { name: 'vod baixado.mp4', bytes: 2048 }, chat: { name: 'vod baixado.chat.json', bytes: 300 } });
  assert.equal(vod.keepsSource, false, 'o vídeo baixado pelo app sai junto (se a pessoa quiser)');
  const own = (await s.w.call('project:deletePreview', { id: s.own.id })).plan;
  assert.equal(own.download, null, 'sem registro de download: o vídeo é do usuário');
  assert.equal(own.keepsSource, true);
  assert.equal(own.sourceName, 'minha gravacao.mp4');
  assert.deepEqual(own.exports, { files: 0, sidecars: 0, bytes: 0, missing: 0 });
  assert.deepEqual(names(s.w.videos), before, 'visualizar não mexe em nada');
  for (const f of [...s.vodData, ...s.ownData, s.e1, s.e2, s.vod.file, s.chat]) assert.ok(exists(f), f);
  assert.equal(s.w.ctx.projectStore.loadById(s.vod.id).id, s.vod.id);
  // erros: id inválido e projeto que não existe
  assert.equal((await s.w.call('project:deletePreview', { id: 'xx' })).code, 'INVALID_ARGS');
  assert.equal((await s.w.call('project:deletePreview', {})).code, 'INVALID_ARGS');
  assert.equal((await s.w.call('project:deletePreview', { id: '0123456789abcdef' })).code, 'PROJECT_NOT_FOUND');
});

test('project:delete sem "arquivos": apaga o projeto e os dados dele; cortes exportados, vídeo e chat ficam onde estão', async (t) => {
  const s = scenario(t);
  const res = await s.w.call('project:delete', { id: s.vod.id });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.result.projectRemoved, true);
  assert.equal(res.result.keptSource, true);
  assert.deepEqual(res.result.failed, []);
  assert.deepEqual([res.result.removed.exports, res.result.removed.video, res.result.removed.chat], [0, 0, 0]);
  assert.ok(res.result.removed.dataFiles >= 5, 'os 4 arquivos de dados e o arquivo do projeto');
  assert.deepEqual(names(path.join(s.w.ud, 'projects')).filter((n) => n.startsWith(s.vod.id)), []);
  for (const f of s.vodData) assert.equal(exists(f), false, f);
  for (const f of [s.e1, s.e1s, s.e2, s.vod.file, s.chat, s.userSrt]) assert.ok(exists(f), `${f} continua`);
  assert.equal(s.w.ctx.sources.downloadRecord(s.vod.file) !== null, true, 'o registro de download continua (o arquivo continua)');
  assert.equal(s.w.ctx.projectStore.peekById(s.vod.id).project, undefined);
  // o outro projeto não foi tocado
  assert.equal(s.w.ctx.projectStore.loadById(s.own.id).id, s.own.id);
  for (const f of s.ownData) assert.ok(exists(f), f);
  assert.equal((await s.w.call('project:delete', { id: s.vod.id })).code, 'PROJECT_NOT_FOUND', 'apagar de novo');
});

test('project:delete com "arquivos": sai o que o app prova ser dele (exportações, legendas ao lado, vídeo e chat baixados); o vídeo e a legenda do usuário NUNCA', async (t) => {
  const s = scenario(t);
  const res = await s.w.call('project:delete', { id: s.vod.id, files: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  const r = res.result;
  assert.equal(r.projectRemoved, true);
  assert.deepEqual(r.failed, []);
  assert.deepEqual([r.removed.exports, r.removed.sidecars, r.removed.video, r.removed.chat], [2, 1, 1, 1]);
  assert.equal(r.keptSource, false);
  assert.ok(r.removed.bytes >= 1000 + 10 + 2000 + 2048 + 300 + (30 + 40 + 20 + 50), 'os bytes liberados somam os arquivos apagados e os dados');
  for (const f of [s.e1, s.e1s, s.e2, s.vod.file, s.chat, ...s.vodData]) assert.equal(exists(f), false, `${f} saiu`);
  assert.equal(exists(s.out), false, 'a pasta Cortes padrão ficou vazia e saiu');
  assert.ok(exists(s.userSrt), 'a legenda do usuário ao lado do vídeo baixado fica');
  assert.equal(s.w.ctx.sources.downloadRecord(s.vod.file), null, 'o registro de download foi esquecido junto com o arquivo');
  // o projeto do vídeo do usuário e os arquivos dele seguem intactos
  assert.ok(exists(s.own.file) && exists(s.ownSrt));
  for (const f of s.ownData) assert.ok(exists(f), f);
  // "arquivos" num projeto cujo vídeo é do usuário: sai o projeto e os dados, o vídeo fica
  const mine = await s.w.call('project:delete', { id: s.own.id, files: true });
  assert.equal(mine.ok, true);
  assert.equal(mine.result.keptSource, true);
  assert.deepEqual([mine.result.removed.video, mine.result.removed.exports], [0, 0]);
  assert.ok(exists(s.own.file), 'o vídeo do usuário NUNCA sai, nem com "apagar os arquivos"');
  assert.ok(exists(s.ownSrt));
  for (const f of s.ownData) assert.equal(exists(f), false, f);
});

test('project:delete com "arquivos": registro que aponta para o vídeo de origem de qualquer projeto, arquivo que não é vídeo, pasta ou caminho relativo NÃO são apagados', async (t) => {
  const w = world(t);
  const victim = addProject(w, 'outro projeto', { cuts: [cut('v1', 'approved')] }); // o vídeo de origem de outro projeto
  const notes = write(path.join(w.videos, 'notas importantes.txt'), 9);
  const folder = path.join(w.videos, 'pasta.mp4');
  fs.mkdirSync(folder);
  write(path.join(folder, 'dentro.txt'), 4);
  const real = write(path.join(w.videos, 'Cortes', 'certo.mp4'), 77);
  const doc = addProject(w, 'live com registro estranho', {
    cuts: [cut('c1', 'approved', [exportEntry(victim.file), exportEntry(notes), exportEntry(folder), exportEntry('relativo/x.mp4'), exportEntry(real)])]
  });
  const preview = (await w.call('project:deletePreview', { id: doc.id })).plan;
  assert.deepEqual(preview.exports, { files: 1, sidecars: 0, bytes: 77, missing: 0 }, 'só o corte exportado de verdade entra');
  const res = await w.call('project:delete', { id: doc.id, files: true });
  assert.equal(res.ok, true);
  assert.equal(res.result.removed.exports, 1);
  assert.equal(exists(real), false);
  for (const kept of [victim.file, notes, path.join(folder, 'dentro.txt')]) assert.ok(exists(kept), `${kept} continua`);
  assert.equal(w.ctx.projectStore.loadById(victim.id).id, victim.id, 'o outro projeto continua');
});

test('project:delete com "arquivos": um corte exportado que OUTRO projeto também anotou (um "substituir" no conflito de nome) não é só deste e fica, com a legenda; quando o outro sai, ele sai', async (t) => {
  const w = world(t);
  const shared = write(path.join(w.videos, 'Cortes', 'compartilhado.mp4'), 500);
  const sharedSrt = write(path.join(w.videos, 'Cortes', 'compartilhado.srt'), 11);
  const mine = write(path.join(w.videos, 'Cortes', 'so deste.mp4'), 300);
  const a = addProject(w, 'live a', { cuts: [cut('a1', 'approved', [exportEntry(shared), exportEntry(mine)])] });
  const b = addProject(w, 'live b', { cuts: [cut('b1', 'approved', [exportEntry(shared)])] });
  const preview = (await w.call('project:deletePreview', { id: a.id })).plan;
  assert.deepEqual(preview.exports, { files: 1, sidecars: 0, bytes: 300, missing: 0 }, 'o arquivo que o outro projeto também cita não entra');
  const first = await w.call('project:delete', { id: a.id, files: true });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.result.removed.exports, 1);
  assert.equal(exists(mine), false);
  assert.ok(exists(shared) && exists(sharedSrt), 'o arquivo compartilhado e a legenda dele ficam');
  assert.equal(w.ctx.projectStore.loadById(b.id).id, b.id, 'o outro projeto continua e ainda aponta para o arquivo');
  const second = await w.call('project:delete', { id: b.id, files: true });
  assert.equal(second.result.removed.exports, 1, 'agora ninguém mais cita o arquivo: ele sai');
  assert.equal(exists(shared), false);
  assert.equal(exists(sharedSrt), false);
});

test('com exportação na fila ou em andamento o projeto NÃO é apagado (nada sai), e o rastro dos trabalhos terminados sai junto com o projeto', async (t) => {
  const s = scenario(t);
  const q = s.w.ctx.queue;
  const job = (id, state, projectId, output = null) => ({ id, state, projectId, projectTitle: 't', sourcePath: projectId === s.vod.id ? s.vod.file : s.own.file, cut: { id: 'c1', start: 0, end: 10 }, profile: {}, outputDir: s.out, baseName: id, key: `key-${id}`, output, warnings: [], onConflict: 'ask' });
  q.jobs.push(job('feito', 'done', s.vod.id, s.e1), job('falhou', 'failed', s.vod.id), job('esperando', 'queued', s.vod.id), job('do-outro', 'done', s.own.id));
  q.completed['key-feito'] = { output: s.e1, at: '2026-10-23T10:00:00.000Z', dir: s.out };
  q.completed['key-outro'] = { output: path.join(s.w.videos, 'outra-saida.mp4'), at: '2026-10-23T10:00:00.000Z', dir: s.w.videos };
  const preview = (await s.w.call('project:deletePreview', { id: s.vod.id })).plan;
  assert.match(preview.busy, /Há uma exportação deste projeto na fila ou em andamento\. Cancele-a na aba Exportações/);
  const refused = await s.w.call('project:delete', { id: s.vod.id, files: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'PROJECT_BUSY');
  for (const f of [s.e1, s.e2, s.vod.file, s.chat, ...s.vodData]) assert.ok(exists(f), `${f} continua`);
  assert.equal(s.w.ctx.projectStore.loadById(s.vod.id).id, s.vod.id);
  assert.equal(q.jobs.length, 4, 'a fila não mudou');
  // o trabalho esperando é cancelado (como o usuário faria na aba Exportações): agora pode
  q.cancel({ id: 'esperando' });
  assert.equal((await s.w.call('project:deletePreview', { id: s.vod.id })).plan.busy, null);
  const ok = await s.w.call('project:delete', { id: s.vod.id, files: true });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(q.jobs.map((j) => j.id), ['do-outro'], 'os trabalhos terminados deste projeto saíram da lista; o do outro projeto ficou');
  assert.equal(q.completed['key-feito'], undefined, 'e o registro de "já exportado" do arquivo apagado também');
  assert.ok(q.completed['key-outro'], 'o de outro arquivo ficou');
});

test('análise do vídeo, análise por IA e transcrição em andamento também seguram a exclusão (o ffmpeg lê o vídeo; a transcrição recriaria o arquivo)', async (t) => {
  const s = scenario(t);
  const { manager, ai } = s.w.ctx.analysis;
  const project = s.w.ctx.projectStore.loadById(s.vod.id);
  assert.equal(s.w.ctx.projectBusy(project), null);
  // os gerenciadores têm um `job` enquanto trabalham e status() lê dele: é só esse campo que é simulado, a verificação e a resposta são as de verdade
  const withJob = async (holder, job, expected) => {
    holder.job = job;
    try {
      assert.match(s.w.ctx.projectBusy(project), expected);
      const preview = (await s.w.call('project:deletePreview', { id: s.vod.id })).plan;
      assert.match(preview.busy, expected);
      const refused = await s.w.call('project:delete', { id: s.vod.id, files: true });
      assert.deepEqual([refused.ok, refused.code], [false, 'PROJECT_BUSY']);
      for (const f of [s.e1, s.e2, s.vod.file, s.chat, ...s.vodData]) assert.ok(exists(f), `${f} continua`);
      assert.equal(s.w.ctx.projectStore.loadById(s.vod.id).id, s.vod.id);
    } finally {
      holder.job = null;
    }
  };
  await withJob(manager, { id: 'a1', path: s.vod.file.replace(/\\/g, '/').toUpperCase(), startedAt: 1, p: 0.2, stage: 'audio', message: '' }, /análise deste vídeo em andamento\. Cancele-a na aba Análise/);
  await withJob(ai.aiManager, { id: 'i1', path: s.vod.file, startedAt: 1, p: 0.2, stage: 'ai1', message: '' }, /análise deste vídeo em andamento/);
  await withJob(ai.transcriptManager, { id: 't1', projectId: s.vod.id, startedAt: 1, p: 0.2, doneUntil: 10, message: '' }, /transcrição deste vídeo está sendo gerada/);
  // o trabalho de OUTRO vídeo/projeto não segura este
  manager.job = { id: 'a2', path: s.own.file, startedAt: 1, p: 0, stage: 'audio', message: '' };
  ai.transcriptManager.job = { id: 't2', projectId: s.own.id, startedAt: 1, p: 0, doneUntil: 0, message: '' };
  assert.equal(s.w.ctx.projectBusy(project), null);
  manager.job = null;
  ai.transcriptManager.job = null;
  // um verificador com defeito nunca bloqueia nem derruba
  s.w.ctx.busyChecks.push(() => { throw new Error('verificador com defeito'); });
  assert.equal(s.w.ctx.projectBusy(project), null);
  s.w.ctx.busyChecks.pop();
  const ok = await s.w.call('project:delete', { id: s.vod.id });
  assert.equal(ok.ok, true, 'sem nada rodando, apaga');
});

test('project:save recusa gravar o projeto enquanto ele está sendo apagado (nada recria o arquivo no meio) e volta a aceitar depois', async (t) => {
  const s = scenario(t);
  const original = fs.promises.unlink;
  t.after(() => { fs.promises.unlink = original; });
  let started = false;
  fs.promises.unlink = async (f) => { started = true; await sleep(120); return original(f); };
  const deleting = s.w.call('project:delete', { id: s.vod.id, files: true });
  while (!started) await sleep(5); // o primeiro arquivo já está sendo apagado: a exclusão começou de verdade
  const refused = await s.w.call('project:save', { project: s.vod.project });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'PROJECT_DELETING');
  assert.match(refused.message, /sendo apagado/);
  assert.equal((await s.w.call('project:delete', { id: s.vod.id, files: true })).code, 'PROJECT_DELETING', 'não apaga duas vezes ao mesmo tempo');
  const done = await deleting;
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.result.projectRemoved, true);
  fs.promises.unlink = original;
  assert.equal((await s.w.call('project:save', { project: s.vod.project })).ok, true, 'terminou: abrir o vídeo de novo cria o projeto normalmente');
});

test('um arquivo em uso não impede o resto: o projeto sai, o arquivo teimoso é relatado com o motivo e o vídeo do usuário continua', async (t) => {
  const s = scenario(t);
  const original = fs.promises.unlink;
  t.after(() => { fs.promises.unlink = original; });
  fs.promises.unlink = async (f) => {
    if (f === s.e2) throw Object.assign(new Error('em uso'), { code: 'EBUSY' });
    return original(f);
  };
  const res = await s.w.call('project:delete', { id: s.vod.id, files: true });
  fs.promises.unlink = original;
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.result.projectRemoved, true);
  assert.equal(res.result.failed.length, 1);
  assert.equal(res.result.failed[0].name, 'vod - corte 02.mp4');
  assert.match(res.result.failed[0].message, /em uso por outro programa/);
  assert.ok(exists(s.e2), 'o que não saiu continua para a pessoa apagar à mão');
  assert.equal(exists(s.e1), false);
  assert.equal(exists(s.out), true, 'a pasta Cortes ficou porque ainda tem um arquivo');
  assert.ok(exists(s.userSrt));
});

test('projeto danificado (JSON quebrado) ainda pode ser apagado: só os dados dele; visualizar não cria .corrupt nem restaura cópia', async (t) => {
  const w = world(t);
  const p = addProject(w, 'quebrado', { cuts: [cut('c1', 'approved')] });
  const data = addData(w, p.id);
  const projects = path.join(w.ud, 'projects');
  fs.writeFileSync(path.join(projects, `${p.id}.json`), '{ nada de JSON');
  const before = names(projects);
  const plan = (await w.call('project:deletePreview', { id: p.id })).plan;
  assert.equal(plan.unreadable, true);
  assert.equal(plan.title, '');
  assert.equal(plan.download, null);
  assert.equal(plan.exports.files, 0);
  assert.equal(plan.data.files, 4);
  assert.deepEqual(names(projects), before, 'a conferência não mexeu no arquivo danificado');
  const res = await w.call('project:delete', { id: p.id, files: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.result.projectRemoved, true);
  assert.deepEqual(names(projects).filter((n) => n.startsWith(p.id)), [], 'o principal, a cópia e tudo o que era dele saíram');
  for (const f of data) assert.equal(exists(f), false, f);
  assert.ok(exists(p.file), 'o vídeo continua');
});

// ---------- miniaturas pelo IPC ----------

test('project:thumbnail: o id precisa ser o do caminho; sem o ffmpeg do sistema diz NO_FFMPEG; vídeo que sumiu diz "missing"', async (t) => {
  const w = world(t, { tools: false });
  const file = write(path.join(w.videos, 'a.mp4'), 100);
  const id = projectIdFor(file);
  assert.equal((await w.call('project:thumbnail', { id: 'xx', path: file })).code, 'INVALID_ARGS');
  assert.equal((await w.call('project:thumbnail', { id: '0123456789abcdef', path: file })).code, 'INVALID_ARGS', 'id de outro caminho');
  assert.equal((await w.call('project:thumbnail', { id, path: '' })).code, 'INVALID_ARGS');
  assert.equal((await w.call('project:thumbnail', {})).code, 'INVALID_ARGS');
  const noTool = await w.call('project:thumbnail', { id, path: file, size: 100, duration: 60 });
  assert.deepEqual([noTool.ok, noTool.state, noTool.reason], [true, 'none', 'NO_FFMPEG']);
  const ghost = path.join(w.videos, 'sumiu.mp4');
  const missing = await w.call('project:thumbnail', { id: projectIdFor(ghost), path: ghost, size: 1, duration: 60 });
  assert.deepEqual([missing.ok, missing.state], [true, 'missing']);
});

test('project:thumbnail com o ffmpeg do sistema: um JPEG de verdade em userData/cache/thumbs, a mesma URL na segunda vez, e a lixeira leva a miniatura junto', { skip: ffmpegPath ? false : 'ffmpeg não encontrado' }, async (t) => {
  const w = world(t, { tools: true });
  const file = path.join(w.videos, 'real.mp4');
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=10:duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file], { windowsHide: true });
  const project = newProject(file, { size: fs.statSync(file).size, duration: 8, width: 640, height: 360 });
  const saved = w.ctx.projectStore.save(project);
  const payload = { id: saved.id, path: file, size: saved.source.size, duration: 8 };
  const res = await w.call('project:thumbnail', payload);
  assert.deepEqual([res.ok, res.state], [true, 'ready'], JSON.stringify(res));
  assert.ok(res.url.startsWith('file:'), res.url);
  const thumbs = path.join(w.ud, 'cache', 'thumbs');
  const [jpg] = names(thumbs);
  assert.ok(jpg.startsWith(`${saved.id}.`) && jpg.endsWith('.jpg'), jpg);
  const head = fs.readFileSync(path.join(thumbs, jpg)).subarray(0, 2);
  assert.deepEqual([...head], [0xff, 0xd8], 'JPEG de verdade');
  assert.equal((await w.call('project:thumbnail', payload)).url, res.url);
  assert.deepEqual(names(thumbs), [jpg], 'continua uma só');
  const preview = (await w.call('project:deletePreview', { id: saved.id })).plan;
  assert.equal(preview.data.files, 1, 'a miniatura conta como dado do projeto');
  const del = await w.call('project:delete', { id: saved.id });
  assert.equal(del.ok, true);
  assert.deepEqual(names(thumbs), [], 'a lixeira apagou a miniatura');
  assert.ok(exists(file), 'o vídeo continua');
});

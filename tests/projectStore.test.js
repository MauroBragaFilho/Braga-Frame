'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProjectStore, newProject, projectIdFor } = require('../src/core/projects/projectStore');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bf-proj-')); }
const INFO = { size: 10, duration: 60, width: 1920, height: 1080 };

function v1For(src, extra = {}) {
  return {
    version: 1, id: projectIdFor(src),
    source: { path: path.resolve(src), size: 10, duration: 60, width: 1920, height: 1080 },
    cuts: [{ id: 'c1', title: 'Clutch', start: 5, end: 20, status: 'approved', exports: [{ path: 'x.mp4', at: 't', start: 5, end: 20, profile: {} }] }],
    exportDir: null, profile: { resolution: 1080, codec: 'h264', bitrateKbps: 10000 }, updatedAt: '2026-10-01T00:00:00.000Z', ...extra
  };
}

test('salva e reabre o projeto com cortes e decisões', () => {
  const dir = tmp();
  try {
    const store = new ProjectStore(dir);
    const src = path.join(dir, 'live.mp4');
    assert.equal(store.load(src), null);
    const p = newProject(src, INFO);
    p.cuts.push({ id: 'c1', title: 'Clutch', start: 5, end: 20, status: 'approved', exports: [] });
    store.save(p);
    const again = store.load(src);
    assert.equal(again.version, 2);
    assert.equal(again.cuts[0].title, 'Clutch');
    assert.equal(again.cuts[0].status, 'approved');
    assert.equal(again.cuts[0].audio.gainDb, 0, 'o corte é normalizado ao gravar');
    assert.equal(again.source.duration, 60);
    assert.equal(again.id, projectIdFor(src));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('status inválido vira pendente e o id sempre acompanha o caminho do vídeo', () => {
  const dir = tmp();
  try {
    const store = new ProjectStore(dir);
    const src = path.join(dir, 'a.mp4');
    const p = newProject(src, INFO);
    p.id = 'id-errado';
    p.cuts.push({ id: 'c1', title: 'x', start: 1, end: 2, status: 'qualquer', exports: [] });
    const saved = store.save(p);
    assert.equal(saved.id, projectIdFor(src));
    assert.equal(store.load(src).cuts[0].status, 'pending');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('arquivo corrompido é preservado, não apagado, e quem abre fica sabendo (loadDetailed.recovered)', () => {
  const dir = tmp();
  try {
    const store = new ProjectStore(dir);
    const src = path.join(dir, 'x.mp4');
    fs.writeFileSync(store.fileFor(src), '{ quebrado');
    const loaded = store.loadDetailed(src);
    assert.equal(loaded.project, null);
    assert.ok(loaded.recovered, 'o aviso existe: sem ele os cortes sumiam em silêncio');
    assert.equal(loaded.recovered.restoredFromBackup, false);
    assert.ok(loaded.recovered.file.endsWith('.corrupt'));
    assert.equal(fs.readFileSync(loaded.recovered.file, 'utf8'), '{ quebrado', 'o conteúdo original foi guardado');
    assert.equal(fs.existsSync(store.fileFor(src)), false, 'o arquivo danificado saiu do caminho');
    assert.equal(store.loadDetailed(src).recovered, null, 'depois de separado, não há mais o que avisar');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('quem carregou primeiro (a conferência antes de abrir) faz a recuperação, mas o aviso continua pendente para quem abre o vídeo', () => {
  const dir = tmp();
  try {
    const store = new ProjectStore(dir);
    const src = path.join(dir, 'x.mp4');
    const p = newProject(src, INFO);
    p.cuts.push({ id: 'c1', title: 'Importante', start: 1, end: 2, status: 'approved' });
    store.save(p);
    store.save(store.load(src)); // a 2ª gravação deixa a 1ª como .bak
    const file = store.fileFor(src);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(0, 60));

    assert.equal(store.load(src).cuts[0].title, 'Importante', 'a 1ª leitura (load comum) já recuperou da cópia');
    const opened = store.loadDetailed(src);
    assert.equal(opened.project.cuts[0].title, 'Importante');
    assert.ok(opened.recovered && opened.recovered.restoredFromBackup, 'o aviso não se perdeu na 1ª leitura');
    assert.equal(store.loadDetailed(src).recovered, null, 'e é contado uma vez só');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('estrutura irreconhecível (JSON válido, mas não é um projeto) também é preservada e avisada', () => {
  const dir = tmp();
  try {
    const store = new ProjectStore(dir);
    const src = path.join(dir, 'y.mp4');
    fs.writeFileSync(store.fileFor(src), JSON.stringify({ version: 2, cuts: 'nao-e-lista', source: { path: src } }));
    const loaded = store.loadDetailed(src);
    assert.equal(loaded.project, null);
    assert.ok(loaded.recovered.file.endsWith('.corrupt'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** fs com falhas programadas: `faults[nome]` é uma lista de códigos de erro, consumida uma a uma antes de chamar o fs de verdade. */
function faultyFs(faults, calls = []) {
  const wrapped = { ...fs };
  for (const name of ['readFileSync', 'renameSync', 'writeSync', 'fsyncSync']) {
    wrapped[name] = (...args) => {
      calls.push(name);
      const code = (faults[name] || []).shift();
      if (code) throw Object.assign(new Error(`${code}: falha simulada em ${name}`), { code });
      return fs[name](...args);
    };
  }
  return wrapped;
}

test('falha de leitura passageira (EBUSY) NÃO é corrupção: repete, abre o arquivo bom e não move nada', () => {
  const dir = tmp();
  try {
    const src = path.join(dir, 'a.mp4');
    const p = newProject(src, INFO);
    p.cuts.push({ id: 'c1', title: 'Importante', start: 1, end: 2, status: 'approved' });
    new ProjectStore(dir).save(p);
    // o antivírus segura o arquivo na 1ª e na 2ª leitura
    const store = new ProjectStore(dir, { fsImpl: faultyFs({ readFileSync: ['EBUSY', 'EPERM'] }), retryDelayMs: 1 });
    const loaded = store.loadDetailed(src);
    assert.equal(loaded.project.cuts[0].title, 'Importante', 'o projeto bom foi aberto na repetição');
    assert.equal(loaded.recovered, null);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.corrupt')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('leitura que continua falhando (arquivo preso) vira PROJECT_UNREADABLE em português e o arquivo bom fica onde está', () => {
  const dir = tmp();
  try {
    const src = path.join(dir, 'a.mp4');
    const p = newProject(src, INFO);
    p.cuts.push({ id: 'c1', title: 'Importante', start: 1, end: 2, status: 'approved' });
    new ProjectStore(dir).save(p);
    const file = new ProjectStore(dir).fileFor(src);
    const before = fs.readFileSync(file, 'utf8');
    const store = new ProjectStore(dir, { fsImpl: faultyFs({ readFileSync: Array(20).fill('EBUSY') }), retries: 3, retryDelayMs: 1 });
    assert.throws(() => store.load(src), (err) => {
      assert.equal(err.code, 'PROJECT_UNREADABLE');
      assert.match(err.message, /em uso por outro programa.*Nada foi alterado/s);
      return true;
    });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.corrupt')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('save: fsync antes do rename, rename repetido em EPERM/EBUSY e a última versão boa fica em .bak', () => {
  const dir = tmp();
  try {
    const src = path.join(dir, 'a.mp4');
    const calls = [];
    const store = new ProjectStore(dir, { fsImpl: faultyFs({ renameSync: ['EPERM', 'EBUSY'] }, calls), retryDelayMs: 1 });
    const first = newProject(src, INFO);
    first.cuts.push({ id: 'c1', title: 'Versão 1', start: 1, end: 2 });
    store.save(first);
    const sync = calls.indexOf('fsyncSync');
    assert.ok(sync >= 0 && sync < calls.indexOf('renameSync'), `fsync deve vir antes do rename: ${calls.join(',')}`);
    assert.equal(calls.filter((c) => c === 'renameSync').length, 3, 'duas falhas passageiras e a terceira tentativa passou');
    const file = store.fileFor(src);
    assert.equal(fs.existsSync(`${file}.bak`), false, 'a primeira gravação não tem versão anterior');

    const second = store.load(src);
    second.cuts[0].title = 'Versão 2';
    store.save(second);
    assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).cuts[0].title, 'Versão 1', '.bak = a versão anterior');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).cuts[0].title, 'Versão 2');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'nenhum temporário sobra');

    // um arquivo principal ilegível NÃO pode virar a cópia: o .bak continua sendo a última versão boa
    fs.writeFileSync(file, '{ meio');
    const third = newProject(src, INFO);
    third.cuts.push({ id: 'c1', title: 'Versão 3', start: 1, end: 2 });
    store.save(third);
    assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).cuts[0].title, 'Versão 1');
    assert.equal(store.list().length, 1, 'o .bak não aparece como projeto na lista');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('save que não consegue gravar lança PROJECT_WRITE_FAILED em português e não toca no arquivo bom nem deixa .tmp', () => {
  const dir = tmp();
  try {
    const src = path.join(dir, 'a.mp4');
    const good = new ProjectStore(dir);
    const p = newProject(src, INFO);
    p.cuts.push({ id: 'c1', title: 'Bom', start: 1, end: 2 });
    good.save(p);
    const file = good.fileFor(src);
    const before = fs.readFileSync(file, 'utf8');

    const locked = new ProjectStore(dir, { fsImpl: faultyFs({ renameSync: Array(20).fill('EBUSY') }), retries: 2, retryDelayMs: 1 });
    assert.throws(() => locked.save(locked.load(src)), (err) => {
      assert.equal(err.code, 'PROJECT_WRITE_FAILED');
      assert.match(err.message, /^Não foi possível salvar o projeto: .*em uso por outro programa.*tenta salvar de novo sozinho/s);
      assert.match(err.details.raw, /EBUSY/);
      return true;
    });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);

    // (a 1ª escrita é a da cópia .bak, que falha sem atrapalhar; a 2ª é a do projeto: disco cheio)
    const full = new ProjectStore(dir, { fsImpl: faultyFs({ writeSync: [null, 'ENOSPC'] }), retryDelayMs: 1 });
    assert.throws(() => full.save(good.load(src)), (err) => err.code === 'PROJECT_WRITE_FAILED' && /disco está cheio/.test(err.message));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lê um projeto v1 gravado pelo app antigo, migra para v2 e guarda cópia do original', () => {
  const dir = tmp();
  try {
    const store = new ProjectStore(dir);
    const src = path.join(dir, 'gameplay.mp4');
    const file = store.fileFor(src);
    const original = JSON.stringify(v1For(src, { campoExtra: [1, 2] }), null, 2);
    fs.writeFileSync(file, original);

    const p = store.load(src);
    assert.equal(p.version, 2);
    assert.equal(p.cuts[0].title, 'Clutch');
    assert.equal(p.cuts[0].exports.length, 1);
    assert.deepEqual(p.campoExtra, [1, 2]);
    assert.equal(p.profileId, 'vertical-1080-h264');
    assert.equal(fs.readFileSync(`${file}.v1.bak`, 'utf8'), original, 'cópia do v1 intacta');

    const saved = store.save(p);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
    assert.deepEqual(saved.campoExtra, [1, 2]);
    assert.equal(fs.readFileSync(`${file}.v1.bak`, 'utf8'), original, 'a cópia não é regravada');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('projeto de versão mais nova não é tocado nem marcado como corrompido', () => {
  const dir = tmp();
  try {
    const store = new ProjectStore(dir);
    const src = path.join(dir, 'novo.mp4');
    const file = store.fileFor(src);
    const text = JSON.stringify({ version: 9, source: { path: src }, cuts: [] });
    fs.writeFileSync(file, text);
    assert.throws(() => store.load(src), { code: 'PROJECT_VERSION_UNSUPPORTED' });
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.deepEqual(fs.readdirSync(dir), [path.basename(file)]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('list: resumo de todos os projetos, do mais recente ao mais antigo, ignorando lixo', async () => {
  const dir = tmp();
  try {
    const store = new ProjectStore(dir);
    const a = path.join(dir, 'a.mp4');
    const b = path.join(dir, 'b.mp4');
    assert.deepEqual(store.list(), []);
    const pa = newProject(a, INFO);
    pa.meta = { game: 'Valorant', channel: 'liz' };
    pa.cuts.push({ id: '1', start: 1, end: 2, status: 'approved' }, { id: '2', start: 3, end: 4, status: 'approved' }, { id: '3', start: 5, end: 6, status: 'rejected' }, { id: '4', start: 7, end: 8 });
    store.save(pa);
    await new Promise((r) => setTimeout(r, 15));
    store.save(newProject(b, INFO));
    fs.writeFileSync(path.join(dir, 'lixo.json'), '{}');
    fs.writeFileSync(path.join(dir, `${'f'.repeat(16)}.json`), '{ quebrado');
    fs.writeFileSync(path.join(dir, `${projectIdFor(a)}.json.1.corrupt`), 'x');

    const list = store.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].source.path, path.resolve(b));
    const first = list[1];
    assert.equal(first.id, projectIdFor(a));
    assert.deepEqual(first.meta, { game: 'Valorant', channel: 'liz' });
    assert.equal(first.cutCount, 4);
    assert.deepEqual(first.counts, { pending: 1, approved: 2, rejected: 1 });
    assert.equal(first.cuts, undefined, 'o resumo não carrega os cortes');
    assert.ok(first.updatedAt);
    assert.ok(fs.existsSync(path.join(dir, `${'f'.repeat(16)}.json`)), 'list não mexe em arquivos ilegíveis');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadById só aceita ids válidos', () => {
  const dir = tmp();
  try {
    const store = new ProjectStore(dir);
    const src = path.join(dir, 'a.mp4');
    const saved = store.save(newProject(src, INFO));
    assert.equal(store.loadById(saved.id).source.path, path.resolve(src));
    assert.equal(store.loadById('../../etc/passwd'), null);
    assert.equal(store.loadById('0000000000000000'), null);
    assert.equal(store.loadById(undefined), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('adopt copia cortes e decisões para outra fonte sem alterar o original', () => {
  const dir = tmp();
  try {
    const store = new ProjectStore(dir);
    const oldSrc = path.join(dir, 'live-parcial.mp4');
    const newSrc = path.join(dir, 'live-completa.mp4');
    const base = newProject(oldSrc, INFO, { type: 'vod', platform: 'twitch', videoId: '1' });
    base.meta = { game: 'CS2', channel: 'liz' };
    base.exportDir = 'D:\\Saida';
    base.chat = { path: 'chat.json', format: 'bf-chat-1', count: 3 };
    base.analysis = { lastRun: { at: 'x', signals: [], params: {}, count: 1 } };
    base.ext = { prefs: { aprendido: true } };
    base.cuts.push(
      { id: 'a', title: 'Clutch', start: 10, end: 30, status: 'approved', category: 'clutch', exports: [{ path: 'o.mp4', at: 't', start: 10, end: 30, profile: {} }] },
      { id: 'b', title: 'Falha', start: 50, end: 60, status: 'rejected', exports: [] }
    );
    const original = store.save(base);
    const fileBefore = fs.readFileSync(store.fileFor(oldSrc), 'utf8');
    const memBefore = JSON.stringify(original);

    const adopted = store.adopt(original, newSrc, { info: { size: 99, duration: 7200, width: 2560, height: 1440 } });

    assert.equal(adopted.id, projectIdFor(newSrc));
    assert.notEqual(adopted.id, original.id);
    assert.equal(adopted.source.path, path.resolve(newSrc));
    assert.deepEqual([adopted.source.duration, adopted.source.width], [7200, 2560]);
    assert.equal(adopted.source.origin, null);
    assert.deepEqual(adopted.cuts.map((c) => [c.id, c.title, c.status, c.category, c.start, c.end]), [['a', 'Clutch', 'approved', 'clutch', 10, 30], ['b', 'Falha', 'rejected', '', 50, 60]]);
    assert.deepEqual(adopted.cuts.map((c) => c.exports), [[], []], 'exportações são do vídeo antigo');
    assert.deepEqual(adopted.meta, { game: 'CS2', channel: 'liz' });
    assert.equal(adopted.exportDir, 'D:\\Saida');
    assert.deepEqual(adopted.ext, { prefs: { aprendido: true } });
    assert.deepEqual([adopted.chat, adopted.analysis.lastRun, adopted.history], [null, null, []]);

    // persistido
    assert.equal(store.load(newSrc).cuts.length, 2);
    // original intacto, em memória e em disco
    assert.equal(JSON.stringify(original), memBefore);
    assert.equal(fs.readFileSync(store.fileFor(oldSrc), 'utf8'), fileBefore);
    assert.equal(store.load(oldSrc).cuts[0].exports.length, 1);
    // editar o adotado não afeta o original
    adopted.cuts[0].title = 'Outro';
    assert.equal(store.load(oldSrc).cuts[0].title, 'Clutch');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('adopt não sobrescreve projeto com cortes, mas substitui um projeto vazio; mesma fonte é recusada', () => {
  const dir = tmp();
  try {
    const store = new ProjectStore(dir);
    const a = path.join(dir, 'a.mp4');
    const b = path.join(dir, 'b.mp4');
    const pa = newProject(a, INFO);
    pa.cuts.push({ id: '1', title: 'x', start: 1, end: 2 });
    const savedA = store.save(pa);

    store.save(newProject(b, INFO)); // já aberto no app, ainda sem cortes
    const adopted = store.adopt(savedA, b, { info: INFO });
    assert.equal(adopted.cuts.length, 1);

    const pb = store.load(b);
    pb.cuts[0].title = 'Trabalho do usuário';
    store.save(pb);
    const fileB = fs.readFileSync(store.fileFor(b), 'utf8');
    assert.throws(() => store.adopt(savedA, b, { info: INFO }), { code: 'PROJECT_EXISTS' });
    assert.equal(fs.readFileSync(store.fileFor(b), 'utf8'), fileB, 'nada foi alterado');

    assert.throws(() => store.adopt(savedA, a), { code: 'ADOPT_SAME_SOURCE' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

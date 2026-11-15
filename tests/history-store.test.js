'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HistoryStore } = require('../src/core/history/store');
const history = require('../src/core/history/log');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bf-history-')); }
const group = (id, extra = {}) => ({ id, at: '2026-10-21T12:00:00.000Z', label: `Aprovou ${id}`, source: 'user', items: [{ cutId: 'c1', cutTitle: 'C', type: 'approve', before: { status: 'pending' }, after: { status: 'approved' }, cut: null }], ...extra });

test('append grava de forma atômica e load devolve na ordem; reinício do store lê o mesmo arquivo', async () => {
  const dir = tmp();
  try {
    const store = new HistoryStore(path.join(dir, 'history'));
    assert.deepEqual(store.load('abc123'), { groups: [], dropped: 0 });
    assert.deepEqual(await store.append('abc123', [group('g1'), group('g2')]), { count: 2, dropped: 0 });
    assert.deepEqual(await store.append('abc123', [group('g3')]), { count: 3, dropped: 0 });
    const file = path.join(dir, 'history', 'abc123.json');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.projectId, 'abc123');
    assert.deepEqual(onDisk.groups.map((g) => g.id), ['g1', 'g2', 'g3']);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'history')), ['abc123.json'], 'sem .tmp sobrando');
    const again = new HistoryStore(path.join(dir, 'history')).load('abc123');
    assert.deepEqual(again.groups.map((g) => g.id), ['g1', 'g2', 'g3']);
    // projetos separados não se misturam
    await store.append('outro', [group('x1')]);
    assert.deepEqual(store.load('outro').groups.map((g) => g.id), ['x1']);
    assert.equal(history.normalizeGroups(again.groups).length, 3, 'o formato gravado é o que o histórico entende');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('grupos repetidos não duplicam; gravações simultâneas não se perdem', async () => {
  const dir = tmp();
  try {
    const store = new HistoryStore(dir);
    await store.append('p', [group('g1')]);
    await store.append('p', [group('g1'), group('g2')]);
    assert.deepEqual(store.load('p').groups.map((g) => g.id), ['g1', 'g2']);
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.append('p', [group(`par${i}`)])));
    const ids = store.load('p').groups.map((g) => g.id);
    assert.equal(ids.length, 27);
    assert.equal(new Set(ids).size, 27);
    assert.deepEqual(ids.slice(0, 2), ['g1', 'g2']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('passando do limite, saem os mais antigos e a contagem aparece em "dropped"', async () => {
  const dir = tmp();
  try {
    const store = new HistoryStore(dir, { maxGroups: 3 });
    await store.append('p', [group('g1'), group('g2'), group('g3')]);
    const res = await store.append('p', [group('g4'), group('g5')]);
    assert.deepEqual(res, { count: 3, dropped: 2 });
    const loaded = store.load('p');
    assert.deepEqual(loaded.groups.map((g) => g.id), ['g3', 'g4', 'g5']);
    assert.equal(loaded.dropped, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('arquivo corrompido é preservado como .corrupt e o histórico recomeça sem perder a gravação nova', async () => {
  const dir = tmp();
  try {
    const store = new HistoryStore(dir);
    fs.writeFileSync(path.join(dir, 'p.json'), '{ isto nao é json');
    const loaded = store.load('p');
    assert.deepEqual([loaded.groups, loaded.recovered], [[], true]);
    const kept = fs.readdirSync(dir).filter((f) => f.endsWith('.corrupt'));
    assert.equal(kept.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), '{ isto nao é json', 'conteúdo preservado intacto');
    await store.append('p', [group('g1')]);
    assert.deepEqual(store.load('p').groups.map((g) => g.id), ['g1']);
    // formato de versão futura também é preservado, não sobrescrito
    fs.writeFileSync(path.join(dir, 'q.json'), JSON.stringify({ version: 99, groups: [] }));
    assert.deepEqual(store.load('q').groups, []);
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('q.json.') && f.endsWith('.corrupt')).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ids de projeto perigosos e grupos inválidos são recusados', async () => {
  const dir = tmp();
  try {
    const store = new HistoryStore(path.join(dir, 'h'));
    for (const bad of ['..\\x', '../x', 'a/b', '', null, 5, 'x'.repeat(100)]) {
      assert.throws(() => store.load(bad), (err) => err.code === 'INVALID_ARGS', String(bad));
    }
    assert.throws(() => store.append('..\\x', [group('g')]), (err) => err.code === 'INVALID_ARGS');
    await assert.rejects(store.append('p', [{ id: 5 }]), (err) => err.code === 'INVALID_ARGS');
    await assert.rejects(store.append('p', 'texto'), (err) => err.code === 'INVALID_ARGS');
    assert.equal(fs.existsSync(path.join(dir, 'h', 'p.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'x.json')), false, 'nada escrito fora da pasta');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('copy leva o histórico para outro projeto sem sobrescrever nem alterar a origem', async () => {
  const dir = tmp();
  try {
    const store = new HistoryStore(dir);
    await store.append('antigo', [group('g1'), group('g2')]);
    assert.deepEqual(await store.copy('antigo', 'novo'), { copied: true, count: 2 });
    const copy = JSON.parse(fs.readFileSync(path.join(dir, 'novo.json'), 'utf8'));
    assert.equal(copy.projectId, 'novo');
    assert.deepEqual(copy.groups.map((g) => g.id), ['g1', 'g2']);
    assert.deepEqual(store.load('antigo').groups.map((g) => g.id), ['g1', 'g2'], 'a origem continua igual');
    // o destino já tem histórico: não mexe
    await store.append('novo', [group('g3')]);
    assert.deepEqual(await store.copy('antigo', 'novo'), { copied: false, count: 0, reason: 'TARGET_HAS_HISTORY' });
    assert.deepEqual(store.load('novo').groups.map((g) => g.id), ['g1', 'g2', 'g3']);
    // sem histórico na origem, o mesmo projeto e id perigoso
    assert.equal((await store.copy('vazio', 'outro')).reason, 'EMPTY');
    assert.equal((await store.copy('antigo', 'antigo')).reason, 'SAME_PROJECT');
    assert.throws(() => store.copy('antigo', '..\\fora'), (err) => err.code === 'INVALID_ARGS');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('normalizeGroups ignora lixo do disco sem lançar', () => {
  const out = history.normalizeGroups([group('ok'), null, 7, { id: 'x' }, { id: 'y', label: 'l', items: 'não é lista' }, group('src', { source: 'inventado' }), group('of', { of: 'ok' })]);
  assert.deepEqual(out.map((g) => g.id), ['ok', 'src', 'of']);
  assert.equal(out[1].source, 'user');
  assert.equal(out[2].of, 'ok');
  assert.deepEqual(history.normalizeGroups('nada'), []);
});

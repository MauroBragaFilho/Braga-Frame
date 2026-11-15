'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../src/core/projects/model');

const { normalizeProject, normalizeCut, newCut, blankProject } = model;

/** Projeto no formato v1 exatamente como o app antigo gravava (mais campos extras de futuros recursos). */
function realV1() {
  return {
    version: 1,
    id: '0123456789abcdef',
    source: { path: 'D:\\Gravações\\live 2026-10-01.mkv', size: 1234567, duration: 3600.5, width: 1920, height: 1080, plataforma: 'obs' },
    cuts: [
      {
        id: 'cabc1', title: 'Clutch final', start: 120.5, end: 150, status: 'approved',
        exports: [{ path: 'D:\\Cortes\\live - corte 01 - Clutch final.mp4', at: '2026-10-02T10:00:00.000Z', start: 120.5, end: 150, profile: { resolution: 1080, codec: 'h264', bitrateKbps: 10000 } }],
        corRotulo: 'verde'
      },
      { id: 'cabc2', title: 'Corte 2', start: 10, end: 25, status: 'rejected', exports: [] }
    ],
    exportDir: 'D:\\Cortes',
    profile: { resolution: 1440, codec: 'h265', bitrateKbps: 20000 },
    updatedAt: '2026-10-02T10:05:00.000Z',
    campoDeOutroApp: { a: 1 }
  };
}

test('migra um projeto v1 real para v2 sem perder nada', () => {
  const v1 = realV1();
  const snapshot = JSON.parse(JSON.stringify(v1));
  const p = normalizeProject(v1);

  assert.equal(p.version, 2);
  assert.equal(p.id, '0123456789abcdef');
  assert.equal(p.updatedAt, '2026-10-02T10:05:00.000Z');
  assert.deepEqual([p.source.path, p.source.size, p.source.duration, p.source.width, p.source.height], [snapshot.source.path, 1234567, 3600.5, 1920, 1080]);
  assert.equal(p.source.origin, null);
  assert.deepEqual(p.meta, { game: '', channel: '' });
  assert.equal(p.exportDir, 'D:\\Cortes');
  assert.deepEqual(p.profile, snapshot.profile, 'perfil legado mantido');
  assert.equal(p.profileId, 'vertical-1440-h265', 'perfil embutido equivalente ao legado');
  assert.deepEqual([p.customProfiles, p.chat, p.history, p.ext], [[], null, [], {}]);
  assert.deepEqual(p.analysis, { lastRun: null });

  assert.equal(p.cuts.length, 2);
  const [a, b] = p.cuts;
  assert.deepEqual([a.id, a.title, a.start, a.end, a.status], ['cabc1', 'Clutch final', 120.5, 150, 'approved']);
  assert.deepEqual(a.exports, snapshot.cuts[0].exports);
  assert.deepEqual([b.status, b.exports], ['rejected', []]);
  // padrões dos campos novos do corte
  assert.deepEqual([a.category, a.relevance, a.origin, a.reasons, a.revision, a.framing, a.subtitles, a.notes], ['', null, 'manual', [], 1, null, null, '']);
  assert.deepEqual(a.audio, { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0, history: [] });
  assert.equal(a.createdAt, '2026-10-02T10:05:00.000Z', 'cortes v1 herdam a data do projeto');
  assert.equal(a.reviewedAt, null);

  assert.deepEqual(v1, snapshot, 'a entrada não é modificada');
});

test('campos desconhecidos são preservados em todos os níveis', () => {
  const p = normalizeProject(realV1());
  assert.deepEqual(p.campoDeOutroApp, { a: 1 });
  assert.equal(p.source.plataforma, 'obs');
  assert.equal(p.cuts[0].corRotulo, 'verde');

  const v2 = normalizeProject({
    ...p,
    meta: { game: 'Valorant', channel: 'liz', extra: 1 },
    analysis: { lastRun: null, outro: 2 },
    cuts: [{ ...p.cuts[0], audio: { gainDb: 3, desconhecido: true }, futuro: 'x' }]
  });
  assert.equal(v2.meta.extra, 1);
  assert.equal(v2.analysis.outro, 2);
  assert.equal(v2.cuts[0].futuro, 'x');
  assert.equal(v2.cuts[0].audio.desconhecido, true);
  assert.equal(v2.cuts[0].audio.gainDb, 3);
});

test('normalizar é idempotente e v2 passa intacto', () => {
  const once = normalizeProject(realV1());
  const twice = normalizeProject(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
  const c = normalizeCut({ start: 1, end: 2 }, { now: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(normalizeCut(c), c);
});

test('chave __proto__ vinda do JSON não contamina o objeto', () => {
  const raw = JSON.parse('{"version":2,"source":{"path":"x.mp4"},"__proto__":{"admin":true}}');
  const p = normalizeProject(raw);
  assert.equal(p.admin, undefined);
  assert.equal(Object.getPrototypeOf(p), Object.prototype);
});

test('projeto sem id usa idFor; com id mantém o id', () => {
  const p = normalizeProject({ version: 2, source: { path: 'a.mp4' } }, { idFor: (s) => `id-${s}` });
  assert.equal(p.id, 'id-a.mp4');
  assert.equal(normalizeProject({ version: 2, id: 'zz', source: { path: 'a.mp4' } }).id, 'zz');
  assert.match(normalizeProject({ source: { path: 'a.mp4' } }).id, /^p/);
});

test('rejeita estruturas irreconhecíveis e versões mais novas, com código', () => {
  assert.throws(() => normalizeProject(null), { code: 'INVALID_PROJECT' });
  assert.throws(() => normalizeProject([]), { code: 'INVALID_PROJECT' });
  assert.throws(() => normalizeProject({ version: 1, source: {} }), { code: 'INVALID_PROJECT' });
  assert.throws(() => normalizeProject({ version: 1, source: { path: 'a' }, cuts: 'x' }), { code: 'INVALID_PROJECT' });
  assert.throws(() => normalizeProject({ version: 'x', source: { path: 'a' } }), { code: 'INVALID_PROJECT' });
  assert.throws(() => normalizeProject({ version: 3, source: { path: 'a' } }), { code: 'PROJECT_VERSION_UNSUPPORTED' });
});

test('normalizeCut preenche padrões e corrige valores inválidos', () => {
  const c = normalizeCut({ id: 5, title: '   ', start: -4, end: '7.5', status: 'xyz', relevance: 4, origin: 'robo', revision: 0, audio: { gainDb: 'a', mute: 'sim', fadeInSec: -1 }, exports: [1, { path: 'x' }, null], reasons: ['ok', 3] }, { index: 2, now: '2026-01-01T00:00:00.000Z' });
  assert.equal(c.id, '5');
  assert.equal(c.title, 'Corte 3');
  assert.deepEqual([c.start, c.end], [0, 7.5]);
  assert.equal(c.status, 'pending');
  assert.equal(c.relevance, 1);
  assert.equal(c.origin, 'manual');
  assert.equal(c.revision, 1);
  assert.deepEqual(c.audio, { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0, history: [] });
  assert.deepEqual(c.exports, [{ path: 'x' }]);
  assert.deepEqual(c.reasons, ['ok']);
  assert.equal(c.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(c.updatedAt, c.createdAt);
  assert.equal(normalizeCut(null).start, 0);
});

test('newCut cria corte pendente, manual e completo, com ids diferentes', () => {
  const a = newCut({ start: 2, end: 6.5, title: 'Meu corte' });
  const b = newCut({ start: 2, end: 6.5 }, { index: 1 });
  assert.deepEqual([a.title, a.status, a.origin, a.revision, a.exports], ['Meu corte', 'pending', 'manual', 1, []]);
  assert.equal(b.title, 'Corte 2');
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^c/);
  assert.ok(Date.parse(a.createdAt) > 0);
  assert.equal(newCut({ id: 'fixo', start: 1, end: 2 }).id, 'fixo');
});

test('ids de corte duplicados ou ausentes são refeitos, descartando entradas que não são cortes', () => {
  const p = normalizeProject({
    version: 2, source: { path: 'a.mp4' },
    cuts: [{ id: 'x', start: 1, end: 2 }, { id: 'x', start: 3, end: 4 }, { start: 5, end: 6 }, null, 'lixo']
  });
  assert.equal(p.cuts.length, 3);
  assert.equal(new Set(p.cuts.map((c) => c.id)).size, 3);
  assert.equal(p.cuts[0].id, 'x');
});

test('origem da fonte: normaliza o tipo e mantém os campos', () => {
  const p = normalizeProject({ version: 2, source: { path: 'a.mp4', origin: { type: 'vod', platform: 'twitch', videoId: '123' } } });
  assert.deepEqual(p.source.origin, { type: 'vod', platform: 'twitch', videoId: '123' });
  assert.equal(normalizeProject({ version: 2, source: { path: 'a.mp4', origin: { type: '???' } } }).source.origin.type, 'file');
  assert.equal(normalizeProject({ version: 2, source: { path: 'a.mp4', origin: 'texto' } }).source.origin, null);
});

test('blankProject: v2 vazio com os padrões do contrato', () => {
  const p = blankProject({ path: 'x.mp4', size: 10, duration: 60, width: 1920, height: 1080 }, { idFor: () => 'abc' });
  assert.deepEqual(Object.keys(p).slice(0, 14), ['version', 'id', 'updatedAt', 'source', 'meta', 'cuts', 'exportDir', 'profileId', 'profile', 'customProfiles', 'chat', 'analysis', 'history', 'ext']);
  assert.equal(p.profileId, 'vertical-1080-h264');
  assert.deepEqual(p.cuts, []);
  assert.equal(p.exportDir, null);
});

test('carregado como <script> no renderer (sem module), expõe window.BFModel com o mesmo comportamento', () => {
  const sandbox = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'projects', 'model.js'), 'utf8'), sandbox);
  const { BFModel } = sandbox;
  assert.ok(BFModel, 'BFModel definido');
  assert.deepEqual(Object.keys(BFModel).sort(), Object.keys(model).sort());
  const cut = BFModel.newCut({ start: 1, end: 3 }, { index: 4 });
  assert.equal(cut.title, 'Corte 5');
  assert.deepEqual(JSON.parse(JSON.stringify(cut.audio)), { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0, history: [] });
  assert.equal(BFModel.normalizeProject({ version: 1, source: { path: 'a.mp4' } }).version, 2);
  assert.equal(sandbox.module, undefined, 'não vaza variáveis globais além de BFModel');
  assert.deepEqual(Object.keys(sandbox), ['BFModel']);
});

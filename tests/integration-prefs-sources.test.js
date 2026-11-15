'use strict';

/**
 * Integração prefs x Fontes: a comparação de "fonte atualizada" e a correspondência de lives usam `origin.duration`
 * (campo extra que o recurso Fontes grava em `source.origin` ao consultar um VOD) quando a duração medida não existe; e o
 * aprendizado pode corrigir só o que já observou (`onlyKnown`), que é como desfazer/refazer/restaurar entram.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { compareSource, knownDuration } = require('../src/core/projects/compare');
const { matchOne, findMatches } = require('../src/core/projects/matcher');
const { LearnedStore } = require('../src/core/preferences/learnedStore');
const { rm, setupMain, makeVideo, saveProject, mkTmp, cutState, skipMedia } = require('./prefs-helpers');

const cut = (id, start, end) => ({ id, title: id, start, end });

test('knownDuration: a medida vale; sem ela, a que a plataforma informou em origin.duration', () => {
  assert.equal(knownDuration({ duration: 120, origin: { duration: 3600 } }), 120);
  assert.equal(knownDuration({ duration: 0, origin: { duration: 3600 } }), 3600);
  assert.equal(knownDuration({ origin: { duration: 90.5 } }), 90.5);
  assert.equal(knownDuration({ origin: { duration: 'x' } }), 0);
  assert.equal(knownDuration({}), 0);
  assert.equal(knownDuration(null), 0);
});

test('compareSource: fonte sem duração medida compara pela origin.duration (encurtou, cresceu, igual)', () => {
  const project = { source: { size: 0, duration: 0, origin: { type: 'vod', duration: 40 } }, cuts: [cut('a', 0, 10), cut('b', 12, 25), cut('c', 30, 38)] };
  const shorter = compareSource(project, { duration: 20, size: 1000 });
  assert.equal(shorter.changed, true);
  assert.equal(shorter.direction, 'shorter');
  assert.deepEqual([shorter.duration.before, shorter.duration.after], [40, 20]);
  assert.deepEqual(shorter.cuts.outside.map((c) => [c.id, c.kind]), [['b', 'parcial'], ['c', 'fora']]);
  assert.match(shorter.lines.join(' '), /mais curto/);

  const longer = compareSource(project, { duration: 100, size: 1000 });
  assert.equal(longer.direction, 'longer');
  assert.equal(longer.cuts.outside.length, 0);

  const same = compareSource(project, { duration: 40.2, size: 1000 });
  assert.equal(same.changed, false, 'dentro da tolerância');

  // do lado do arquivo novo: sem medida (ffprobe sem duração), vale a origem informada
  const viaOrigin = compareSource({ source: { duration: 40, size: 0 }, cuts: [] }, { duration: null, size: 0, origin: { duration: 20 } });
  assert.equal(viaOrigin.direction, 'shorter');
  // a medida sempre vence a origem
  const measured = compareSource({ source: { duration: 40, size: 0, origin: { duration: 9999 } }, cuts: [] }, { duration: 40, origin: { duration: 1 } });
  assert.equal(measured.changed, false);
});

test('matcher: duração parecida também vale pela origin.duration (nome do arquivo + duração = correspondência fraca)', () => {
  const summary = {
    id: 'p1', cutCount: 4, meta: {}, updatedAt: '2026-10-01T00:00:00.000Z',
    source: { path: 'D:\\Lives\\Live do Canal.mp4', size: 0, duration: 0, origin: { type: 'vod', duration: 3600 } }
  };
  const incoming = { path: 'E:\\Outra pasta\\Live do Canal.mp4', size: 0, duration: null, origin: { type: 'vod', duration: 3600.4 } };
  const hit = matchOne(incoming, summary);
  assert.equal(hit.level, 'weak');
  assert.equal(hit.reasons.length, 2);
  assert.ok(hit.reasons.some((r) => /duração parecida/.test(r)));
  assert.equal(findMatches(incoming, [summary]).length, 1);
  const other = matchOne({ ...incoming, origin: { type: 'vod', duration: 7200 } }, summary);
  assert.equal(other.level, 'none', 'durações diferentes: só o nome não basta');
});

test('LearnedStore.apply com onlyKnown: corrige/retira o que já era observado e ignora o resto', () => {
  const dir = mkTmp('learned');
  try {
    const store = new LearnedStore(path.join(dir, 'learned.json'));
    assert.equal(store.apply('proj1', {}, [{ id: 'a', state: cutState() }, { id: 'b', state: cutState({ duration: 40 }) }]), true);
    assert.equal(store.count(), 2);
    // retirar (estado que não conta mais) e atualizar só valem para os conhecidos; "c" não existe e não nasce
    assert.equal(store.apply('proj1', {}, [{ id: 'a', state: cutState({ status: 'pending' }) }, { id: 'b', state: cutState({ duration: 45 }) }, { id: 'c', state: cutState() }], { onlyKnown: true }), true);
    assert.equal(store.count(), 1);
    assert.deepEqual(Object.keys(store.all().proj1.cuts), ['b']);
    assert.equal(store.all().proj1.cuts.b.duration, 45);
    // projeto desconhecido: nada nasce
    assert.equal(store.apply('proj2', {}, [{ id: 'x', state: cutState() }], { onlyKnown: true }), false);
    assert.equal(store.all().proj2, undefined);
    // sem onlyKnown nasce como sempre
    assert.equal(store.apply('proj2', {}, [{ id: 'x', state: cutState() }]), true);
    assert.equal(store.count(), 2);
    // persistência
    assert.equal(new LearnedStore(path.join(dir, 'learned.json')).count(), 2);
  } finally { rm(dir); }
});

test('prefs:inspect com handlers e ffprobe de verdade: projeto só com origin.duration compara com o arquivo e acusa os cortes fora', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const file = path.join(main.dir, 'v', 'live.mp4');
    makeVideo(file, 6);
    const saved = saveProject(main.ctx, file, { cuts: [{ start: 0, end: 4 }, { start: 4, end: 9 }, { start: 30, end: 38 }], origin: { type: 'vod', platform: 'twitch', videoId: '42', title: 'Live', duration: 40 } });
    // o que a base gravou na primeira abertura: sem duração/tamanho medidos (por exemplo, abertura com o arquivo ainda baixando)
    main.ctx.projectStore.save({ ...saved, source: { ...saved.source, duration: 0, size: 0 } });
    const res = await main.call('prefs:inspect', { path: file });
    assert.equal(res.ok, true);
    assert.ok(res.compare, 'comparou usando a origin.duration como "antes"');
    assert.equal(res.compare.direction, 'shorter');
    assert.equal(res.compare.duration.before, 40);
    assert.ok(Math.abs(res.compare.duration.after - 6) < 0.5);
    assert.deepEqual(res.compare.cuts.outside.map((c) => c.kind).sort(), ['fora', 'parcial'], 'o corte de 4 a 9 s (parcial) e o de 30 a 38 s (fora)');
    assert.match(res.compare.message, /mais curto/);
    // o inspect só olha: o projeto guardado continua exatamente como estava
    const after = main.ctx.projectStore.load(file);
    assert.equal(after.source.duration, 0);
    assert.equal(after.cuts.length, 3);
  } finally { rm(main.dir); }
});

// ---------- Fontes: afterOpen não escreve no projeto errado ----------

test('Fontes afterOpen: se outro vídeo abriu durante a conferência do chat, nada do VOD anterior é gravado no projeto novo', async () => {
  const vm = require('node:vm');
  const code = require('node:fs').readFileSync(path.join(__dirname, '..', 'renderer', 'features', 'sources.js'), 'utf8');
  const hooks = {};
  const updates = [];
  let release;
  const project = { id: 'p1', source: { path: 'D:\\VODs\\Live [123].mp4' }, meta: { game: '', channel: '' }, chat: null, cuts: [] };
  const BF = {
    util: { el: () => ({}), nameOf: (p) => String(p).split(/[\\/]/).pop() },
    state: { project, tools: {} },
    ui: { registerTab() {}, refreshTabs() {}, log() {}, toast() {}, confirm: async () => true, selectTab: () => true },
    on: () => () => {},
    bus: { on: () => () => {}, emit() {} },
    hooks: { add: (name, fn) => { hooks[name] = fn; } },
    api: async (channel) => {
      if (channel === 'sources:chatCheck') await new Promise((resolve) => { release = resolve; }); // a conferência demora
      return { ok: true, exists: true, count: 3 };
    },
    project: { update(fn) { updates.push(BF.state.project.id); fn(BF.state.project); } },
    ready: Promise.resolve()
  };
  vm.runInNewContext(code, { window: { BF }, document: {}, setTimeout, clearTimeout, console, Date, Map, Promise, Intl }, { filename: 'sources.js' });
  const chat = { path: 'C:\\chats\\twitch-123.json', format: 'bf-chat-1', count: 3, platform: 'twitch' };
  BF.sources.known.set('d:\\vods\\live [123].mp4', { kind: 'vod', origin: {}, chat, meta: { game: 'Minecraft', channel: 'Canal' } });
  const done = hooks.afterOpen({ path: 'D:\\VODs\\Live [123].mp4' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const other = { id: 'p2', source: { path: 'D:\\Outro.mp4' }, meta: { game: '', channel: '' }, chat: null, cuts: [] };
  BF.state.project = other; // o usuário abriu outro vídeo enquanto o chat era conferido
  release();
  await done;
  assert.deepEqual(updates, [], 'nenhuma gravação');
  assert.equal(other.meta.game, '');
  assert.equal(other.chat, null);
});

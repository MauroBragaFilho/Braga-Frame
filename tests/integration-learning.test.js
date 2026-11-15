'use strict';

/**
 * Integração prefs x review x áudio x legendas x análise: o aprendizado (renderer/features/prefs.js, ligado aos handlers
 * REAIS do main) só pode tratar como decisão do usuário o que é decisão do usuário.
 *
 *  - 'adjust' de áudio (scope 'audio') e de legendas (what 'subtitles') não são tempo de corte: não contam;
 *  - 'create' de cortes sugeridos (origin 'auto') que a análise cria em lote não contam;
 *  - desfazer/refazer/restaurar (source undo|redo|restore) não viram evidência nova: só retiram o que foi desfeito;
 *  - 'adjust' de tempo (before/after { start, end }) conta (a duração do corte muda);
 *  - cut.exports[].profile, como a fila grava (objeto com id) ou como texto, alimenta o aprendizado de perfil.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../src/core/projects/model');
const { rm, setupMain, makeVideo, saveProject, skipMedia } = require('./prefs-helpers');
const { FakeNode, createDocument, makeEl } = require('./prefs-fakedom');

const code = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features', 'prefs.js'), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** prefs.js num vm com um BF falso ligado ao main de verdade (mesmo desenho de prefs-renderer.test.js). */
function createEnv(main) {
  const doc = createDocument();
  doc.register('app');
  const modalRoot = doc.register('modalRoot');
  const el = makeEl(doc);
  const calls = [];
  const listeners = new Map();
  const hookMap = new Map();
  const bus = {
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
      return () => listeners.get(evt).delete(fn);
    },
    emit(evt, data) { for (const fn of [...(listeners.get(evt) || [])]) fn(data); }
  };
  const BF = {
    util: { el },
    bus,
    state: { project: null, info: null, url: null, tools: {}, app: {}, loadErrors: [] },
    model,
    prefs: { get: (k, f) => f, resolve: () => ({}), explain: () => null },
    hooks: {
      add(name, fn) { hookMap.set(name, [...(hookMap.get(name) || []), fn]); },
      async run(name, ctx) {
        for (const fn of [...(hookMap.get(name) || [])]) { if ((await fn(ctx)) === false) return false; }
        return true;
      }
    },
    async api(channel, payload) {
      calls.push([channel, plain(payload)]);
      return main.call(channel, payload);
    },
    ui: {
      toast() {}, log() {}, refreshTabs() {}, selectTab() { return true; },
      async confirm() { return true; },
      registerTab(def) { const panel = new FakeNode('section', doc); doc.body.append(panel); def.render(panel); }
    },
    project: {
      update(fn, { reason = 'update' } = {}) { const r = fn(BF.state.project); bus.emit('project:changed', { reason }); return r; },
      cut: (id) => (BF.state.project ? BF.state.project.cuts.find((c) => c.id === id) || null : null),
      async flush() { if (BF.state.project) await main.call('project:save', { project: BF.state.project }); return true; }
    }
  };
  BF.openSource = async function openSource(file, origin = null) {
    const ctx = { path: file, origin, info: null };
    if ((await BF.hooks.run('beforeOpen', ctx)) === false) return { ok: false, canceled: true };
    await BF.project.flush();
    const res = await BF.api('source:open', { path: ctx.path, origin: ctx.origin });
    if (!res.ok) return res;
    BF.state.project = res.project;
    BF.state.info = res.info;
    bus.emit('project:loaded', { project: res.project, restored: res.restored });
    await BF.hooks.run('afterOpen', { ...ctx, info: res.info, project: res.project, restored: res.restored });
    return res;
  };
  vm.runInNewContext(code, { window: { BF }, document: doc, setTimeout, clearTimeout, console, Date, JSON }, { filename: 'prefs.js' });
  return { BF, calls, bus, modalRoot };
}

const observeCalls = (env) => env.calls.filter(([channel]) => channel === 'prefs:observe').map(([, payload]) => payload);

/** Muda o corte como o app faria e avisa 'decision' com o formato do contrato (extra: source, scope…). */
function decide(env, cut, type, patch, extra = {}) {
  const before = JSON.parse(JSON.stringify(cut));
  Object.assign(cut, patch);
  const field = { approve: 'status', reject: 'status', reset: 'status' }[type];
  const detail = field
    ? { before: before.status, after: cut.status }
    : (type === 'adjust' ? { before: { start: before.start, end: before.end }, after: { start: cut.start, end: cut.end } } : { before: null, after: null });
  env.BF.bus.emit('decision', { cutId: cut.id, type, ...detail, ...extra });
}

const flush = () => sleep(700); // o aprendizado agrupa as decisões por ~0,4 s

async function observed(main) {
  return (await main.call('prefs:learned', {})).observed;
}

async function openWithCuts(env, main, count, { duration = 30, status = 'pending', extra = {} } = {}) {
  const file = path.join(main.dir, 'v', `video-${Math.random().toString(36).slice(2, 6)}.mp4`);
  makeVideo(file, 4);
  await env.BF.prefs.ready;
  const res = await env.BF.openSource(file);
  assert.equal(res.ok, true);
  const project = env.BF.state.project;
  for (let i = 0; i < count; i++) {
    project.cuts.push(model.newCut({ id: `c${i}`, title: `Corte ${i + 1}`, start: i * 100, end: i * 100 + duration, status, ...extra }, { index: i }));
  }
  return project;
}

test('ajustes de áudio e de legendas (adjust com scope/what) nunca chegam ao aprendizado', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const env = createEnv(main);
    const project = await openWithCuts(env, main, 2, { status: 'approved' });
    const [a, b] = project.cuts;
    env.BF.bus.emit('decision', { cutId: a.id, type: 'adjust', scope: 'audio', before: { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0 }, after: { gainDb: 6, mute: false, fadeInSec: 0, fadeOutSec: 0 } });
    env.BF.bus.emit('decision', { cutId: b.id, type: 'adjust', before: { what: 'subtitles', enabled: false }, after: { what: 'subtitles', enabled: true } });
    env.BF.bus.emit('decision', { cutId: b.id, type: 'adjust', before: { what: 'subtitles', action: 'shift', seconds: 0 }, after: { what: 'subtitles', action: 'shift', seconds: 0.1 } });
    env.BF.bus.emit('decision', { cutId: a.id, type: 'adjust', before: { gainDb: 6 }, after: { gainDb: 3 } }); // sem scope mas sem tempo: também não é ajuste de corte
    env.BF.bus.emit('decision', { cutId: a.id, type: 'retitle', before: 'Corte 1', after: 'Outro' });
    await flush();
    assert.deepEqual(observeCalls(env), [], 'nenhuma observação foi enviada');
    assert.equal(await observed(main), 0);
  } finally { rm(main.dir); }
});

test('cortes sugeridos criados em lote pela análise (create, origin auto) não contam; o create manual e a aprovação depois contam', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const env = createEnv(main);
    const project = await openWithCuts(env, main, 0);
    const created = [];
    for (let i = 0; i < 20; i++) {
      const cut = model.newCut({ id: `auto${i}`, title: `Sugestão ${i}`, start: i * 50, end: i * 50 + 30, origin: 'auto', relevance: 0.7, category: 'Hype' }, { index: i });
      project.cuts.push(cut);
      created.push(cut);
      env.BF.bus.emit('decision', { cutId: cut.id, type: 'create', before: null, after: plain(cut) }); // formato de analysis.addSuggestions
    }
    await flush();
    assert.deepEqual(observeCalls(env), [], 'sugestões da análise não são decisão do usuário (mesmo categorizadas)');
    assert.equal(await observed(main), 0);

    // o usuário aprova uma delas: AÍ vira evidência (com a relevância e a origem para a regra de relevância mínima)
    decide(env, created[0], 'approve', { status: 'approved' });
    await flush();
    assert.equal(observeCalls(env).length, 1);
    assert.equal(observeCalls(env)[0].cuts.length, 1);
    assert.equal(observeCalls(env)[0].cuts[0].state.origin, 'auto');
    assert.equal(observeCalls(env)[0].cuts[0].state.relevance, 0.7);
    assert.equal(await observed(main), 1);

    // corte manual categorizado: "Salvar corte" emite create (origin manual) e a categoria é uma escolha do usuário
    const manual = model.newCut({ id: 'm1', title: 'Corte manual', start: 2000, end: 2030, origin: 'manual', category: 'Clutch' }, { index: 30 });
    project.cuts.push(manual);
    env.BF.bus.emit('decision', { cutId: manual.id, type: 'create', before: null, after: plain(manual), source: 'user' });
    await flush();
    assert.equal(await observed(main), 2);
  } finally { rm(main.dir); }
});

test('desfazer/refazer/restaurar não viram evidência: o que foi desfeito deixa de contar e refazer não conta de novo', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const env = createEnv(main);
    const project = await openWithCuts(env, main, 3);
    const [a, b, c] = project.cuts;

    decide(env, a, 'approve', { status: 'approved' }, { source: 'user' });
    decide(env, b, 'approve', { status: 'approved' }, { source: 'batch' }); // lote do usuário também é decisão dele
    await flush();
    assert.equal(await observed(main), 2);

    // Ctrl+Z na aprovação de A: o review emite 'reset' com source 'undo'
    decide(env, a, 'reset', { status: 'pending' }, { source: 'undo' });
    await flush();
    const last = observeCalls(env).pop();
    assert.equal(last.onlyKnown, true, 'desfazer só corrige o que já era observado');
    assert.equal(await observed(main), 1, 'a aprovação desfeita deixou de contar');

    // Ctrl+Y: refazer a aprovação NÃO é uma decisão nova
    decide(env, a, 'approve', { status: 'approved' }, { source: 'redo' });
    await flush();
    assert.equal(await observed(main), 1, 'refazer não cria evidência');

    // restaurar um estado antigo: B volta a pendente (retirado) e C, que nunca foi observado, vira aprovado por restauração (não conta)
    decide(env, b, 'reset', { status: 'pending' }, { source: 'restore' });
    decide(env, c, 'approve', { status: 'approved' }, { source: 'restore' });
    await flush();
    assert.equal(await observed(main), 0);

    // mas a decisão do usuário na mesma janela vale mais que a restauração
    decide(env, c, 'reject', { status: 'rejected' }, { source: 'user' });
    decide(env, c, 'approve', { status: 'approved' }, { source: 'restore' });
    await flush();
    assert.equal(await observed(main), 1);
  } finally { rm(main.dir); }
});

test("ajuste de TEMPO do corte (adjust com before/after { start, end }) conta e muda a duração observada", { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const env = createEnv(main);
    const project = await openWithCuts(env, main, 1, { duration: 30, status: 'approved' });
    const cut = project.cuts[0];
    decide(env, cut, 'approve', {});
    await flush();
    assert.equal(observeCalls(env).pop().cuts[0].state.duration, 30);
    decide(env, cut, 'adjust', { end: cut.start + 45 }, { source: 'user' });
    await flush();
    const sent = observeCalls(env).pop();
    assert.equal(sent.cuts[0].state.duration, 45);
    assert.notEqual(sent.onlyKnown, true);
    // só o início mudou (end vem null no evento do review): também é tempo
    decide(env, cut, 'adjust', { start: cut.start + 5 }, { source: 'user' });
    env.BF.bus.emit('decision', { cutId: cut.id, type: 'adjust', before: { start: 0, end: null }, after: { start: 5, end: null } });
    await flush();
    assert.equal(observeCalls(env).pop().cuts[0].state.duration, 40);
  } finally { rm(main.dir); }
});

test('perfil aprendido: cut.exports[].profile como a fila grava (objeto com id, inclusive "user-…") ou como texto', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const env = createEnv(main);
    const project = await openWithCuts(env, main, 3, { status: 'pending' });
    const queueProfile = (id) => ({ id, name: `${id} (ajustado)`, kind: 'custom', width: 1080, height: 1920, codec: 'h264', bitrateKbps: 12000, encoder: 'auto', fps: 'source', container: 'mp4' });
    const [a, b, c] = project.cuts;
    a.exports = [{ path: 'x.mp4', at: new Date().toISOString(), start: 0, end: 30, profile: queueProfile('user-meu-perfil-lq2x1abc'), jobId: 'j1', key: 'k', revision: 1 }];
    b.exports = [{ path: 'y.mp4', start: 0, end: 30, profile: 'vertical-1440-h264' }];
    c.exports = [{ path: 'z.mp4', start: 0, end: 30, profile: { name: 'sem id' } }];
    decide(env, a, 'approve', { status: 'approved' });
    decide(env, b, 'approve', { status: 'approved' });
    decide(env, c, 'approve', { status: 'approved' });
    await flush();
    const sent = observeCalls(env).pop();
    const byId = Object.fromEntries(sent.cuts.map((x) => [x.id, x.state.profileId]));
    assert.equal(byId.c0, 'user-meu-perfil-lq2x1abc', 'objeto do perfil: usa o id');
    assert.equal(byId.c1, 'vertical-1440-h264', 'texto: o próprio id');
    assert.equal(byId.c2, 'vertical-1080-h264', 'perfil sem id: cai no perfil do projeto (nada inventado)');
    // o id de um perfil do usuário passa na validação do aprendizado e da preferência export.profileId
    assert.equal((await main.call('prefs:set', { scope: { type: 'general' }, key: 'export.profileId', value: 'user-meu-perfil-lq2x1abc' })).ok, true);
  } finally { rm(main.dir); }
});

// ---------- Fontes x abertura: a ordem dos ganchos não importa ----------

test('o gancho das Preferências reconhece o VOD baixado pelas Fontes mesmo se o gancho das Fontes ainda não rodou (sources:originFor)', { skip: skipMedia }, async () => {
  const origin = { type: 'vod', platform: 'twitch', videoId: '987654321', url: 'https://www.twitch.tv/videos/987654321', channel: 'CanalTeste', title: 'Live de teste', duration: 24 };
  let downloaded = null;
  const main = setupMain({
    beforeCreate: (dir) => {
      downloaded = path.join(dir, 'v', 'baixado.mp4');
      fs.mkdirSync(path.dirname(downloaded), { recursive: true });
      fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify({ version: 1, downloads: [{ path: downloaded, origin, chat: null, meta: { game: 'Jogo', channel: 'CanalTeste' }, at: '2026-10-02T10:00:00.000Z' }] }));
    }
  });
  try {
    const original = path.join(main.dir, 'v', 'original.mp4');
    makeVideo(original, 5, '160x90');
    makeVideo(downloaded, 3, '128x72'); // outra duração e outra resolução: só a origem identifica a live
    saveProject(main.ctx, original, { cuts: [{ start: 0, end: 2 }, { start: 2, end: 4 }], origin });
    const env = createEnv(main);
    await env.BF.prefs.ready;
    // só o gancho das Preferências está carregado (ctx.origin chega vazio, como se o das Fontes ainda não tivesse rodado)
    const opening = env.BF.openSource(downloaded);
    const modal = await (async () => {
      const end = Date.now() + 15000;
      while (Date.now() < end) { const m = env.modalRoot.querySelector('.bf-modal'); if (m) return m; await sleep(25); }
      throw new Error('a pergunta não apareceu');
    })();
    assert.match(modal.textContentDeep, /mesmo vídeo d[ao] Twitch .código 987654321./);
    modal.querySelector('[data-act="cancel"]').click();
    assert.equal((await opening).canceled, true, 'cancelar não abre nada');
  } finally { rm(main.dir); }
});

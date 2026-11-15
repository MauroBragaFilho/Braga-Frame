'use strict';

/**
 * Aba/hooks de preferências (renderer/features/prefs.js) sem abrir o Electron: o script roda num contexto `vm`
 * com um DOM mínimo e um BF que repete o comportamento do app.js (ganchos, projeto, abertura), ligado aos handlers
 * REAIS do processo principal (createContext + handlers/*.js, ffprobe e projectStore de verdade, vídeos gerados
 * com o ffmpeg). O desenho real (CSS, foco, teclado) é conferido em tests/e2e/prefs.e2e.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../src/core/projects/model');
const { rm, setupMain, makeVideo, saveProject, skipMedia } = require('./prefs-helpers');
const { FakeNode, createDocument, makeEl } = require('./prefs-fakedom');

const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'renderer', 'features', 'prefs.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'renderer', 'features', 'prefs.css'), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = (v) => JSON.parse(JSON.stringify(v));

async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(20);
  }
  throw new Error(`Tempo esgotado esperando: ${what}`);
}

/** Carrega a feature com um BF falso ligado ao main de verdade. `overrides`: { canal: (payload) => resposta } */
function createEnv(main, { overrides = {} } = {}) {
  const doc = createDocument();
  const app = doc.register('app');
  const modalRoot = doc.register('modalRoot');
  const el = makeEl(doc);
  const calls = [];
  const events = [];
  const toasts = [];
  const confirms = [];
  const listeners = new Map();
  const hookMap = new Map();
  let tab = null;
  let panel = null;
  const state = { confirmAnswer: true };

  const bus = {
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
      return () => listeners.get(evt).delete(fn);
    },
    emit(evt, data) {
      events.push([evt, data]);
      for (const fn of [...(listeners.get(evt) || [])]) fn(data);
    }
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
        for (const fn of [...(hookMap.get(name) || [])]) {
          let result;
          try { result = await fn(ctx); } catch { continue; }
          if (result === false) return false;
        }
        return true;
      }
    },
    async api(channel, payload, opts = {}) {
      calls.push([channel, payload]);
      const res = overrides[channel] ? await overrides[channel](payload) : await main.call(channel, payload);
      if (res.ok === false && opts.toast) BF.ui.toast(res.message, 'error');
      return res;
    },
    ui: {
      toast(message, kind) { toasts.push({ message, kind }); },
      log() {},
      refreshTabs() {},
      selectTab(id) { events.push(['selectTab', id]); return true; },
      async confirm(opts) { confirms.push(opts); return state.confirmAnswer; },
      registerTab(def) {
        tab = def;
        panel = new FakeNode('section', doc);
        doc.body.append(panel);
        def.render(panel);
      }
    },
    project: {
      update(fn, { reason = 'update' } = {}) {
        const result = fn(BF.state.project);
        bus.emit('project:changed', { reason });
        return result;
      },
      cut: (id) => (BF.state.project ? BF.state.project.cuts.find((c) => c.id === id) || null : null),
      async flush() {
        if (BF.state.project) await main.call('project:save', { project: BF.state.project });
        return true;
      }
    }
  };

  /** Mesmo caminho de abertura do renderer/app.js. */
  BF.openSource = async function openSource(file, origin = null) {
    const ctx = { path: file, origin, info: null };
    if ((await BF.hooks.run('beforeOpen', ctx)) === false) return { ok: false, code: 'CANCELLED', message: 'Abertura cancelada.', canceled: true };
    await BF.project.flush();
    const res = await BF.api('source:open', { path: ctx.path, origin: ctx.origin });
    if (!res.ok) return res;
    BF.state.project = res.project;
    BF.state.info = res.info;
    BF.state.url = res.url;
    bus.emit('project:loaded', { project: res.project, restored: res.restored });
    await BF.hooks.run('afterOpen', { ...ctx, info: res.info, project: res.project, restored: res.restored });
    return res;
  };

  const context = { window: { BF }, document: doc, setTimeout, clearTimeout, console, Date, JSON };
  vm.runInNewContext(code, context, { filename: 'prefs.js' });
  return { BF, doc, app, modalRoot, calls, events, toasts, confirms, state, hookMap, tab: () => tab, panel: () => panel, bus };
}

const eventNames = (env, name) => env.events.filter(([n]) => n === name).map(([, d]) => d);
const modalOf = (env) => env.modalRoot.querySelector('.bf-modal');
const buttonsOf = (env) => env.modalRoot.querySelectorAll('button').map((b) => ({ act: b.dataset.act, label: b.textContentDeep }));

/** Abre sem esperar (o diálogo bloqueia até alguém responder); devolve { promise, modal }. */
async function openAndWaitModal(env, file, origin) {
  const promise = env.BF.openSource(file, origin);
  const modal = await until(() => modalOf(env), 'diálogo de pergunta');
  return { promise, modal };
}

const origin = (extra) => ({ type: 'vod', platform: 'youtube', videoId: 'abc123XYZ_1', url: 'https://www.youtube.com/watch?v=abc123XYZ_1', channel: 'Fulano', title: 'Minha live', ...extra });

// ---------- registro e BF.prefs ----------

test('carrega a feature: aba Preferências (ordem 80), ganchos de abertura e BF.prefs com a mesma identidade do stub', async () => {
  const main = setupMain();
  try {
    const env = createEnv(main);
    const stubIdentity = env.BF.prefs;
    assert.equal(env.tab().id, 'prefs');
    assert.equal(env.tab().order, 80);
    assert.equal(env.tab().title, 'Preferências');
    assert.equal(typeof env.tab().badge, 'function');
    assert.equal(env.hookMap.get('beforeOpen').length, 1);
    assert.equal(env.hookMap.get('afterOpen').length, 1);
    await env.BF.prefs.ready;
    assert.equal(env.BF.prefs, stubIdentity, 'quem guardou BF.prefs continua com o objeto certo');
    for (const fn of ['get', 'resolve', 'explain', 'set', 'unset', 'scope', 'reload']) assert.equal(typeof env.BF.prefs[fn], 'function', fn);
    assert.equal(env.BF.prefs.get('queue.parallel', 9), 9, 'sem preferência vale o fallback de quem pergunta');
    assert.equal(env.BF.prefs.get('queue.parallel'), 1, 'sem fallback vale o padrão do contrato');
    assert.equal(env.BF.prefs.resolve()['analysis.maxDurationSec'], 60);
    assert.deepEqual(plain(env.BF.prefs.explain('queue.parallel')), { value: 1, scope: 'default', source: 'default', scopeName: '', label: 'padrão', evidence: '' });
    assert.equal(env.BF.prefs.explain('nao.existe'), null);
    assert.equal(env.tab().badge(), '');
    assert.ok(css.includes('.prefs-row') && css.includes('.prefs-pill'), 'o CSS da aba existe');
  } finally { rm(main.dir); }
});

test('a aba funciona SEM projeto aberto: desenha geral, aprendizado, histórico e avançado', async () => {
  const main = setupMain();
  try {
    const env = createEnv(main);
    await env.BF.prefs.ready;
    env.tab().onShow();
    const panel = env.panel();
    await until(() => panel.textContentDeep.includes('Histórico de mudanças'), 'aba desenhada');
    const text = panel.textContentDeep;
    assert.match(text, /Abra um vídeo para definir o jogo e o canal do projeto/);
    assert.match(text, /Perfil de exportação/);
    assert.match(text, /Relevância mínima/);
    assert.match(text, /Aprender com minhas decisões/);
    assert.match(text, /Ainda nada aprendido/);
    assert.match(text, /Evidência mínima para aprender/);
    assert.match(text, /Mais ajustes/);
    // todos os controles de preferência existem (um por chave visível), sem botão fictício
    const keys = panel.querySelectorAll('.prefs-row').map((r) => r.dataset.key).filter(Boolean);
    assert.ok(keys.includes('export.profileId') && keys.includes('review.categories') && keys.includes('subtitles.style'));
    assert.equal(env.toasts.length, 0);
  } finally { rm(main.dir); }
});

test('BF.prefs.set/unset gravam no escopo, atualizam o cache e emitem prefs:changed; erros voltam explicados', async () => {
  const main = setupMain();
  try {
    const env = createEnv(main);
    await env.BF.prefs.ready;
    const res = await env.BF.prefs.set('queue.parallel', 3);
    assert.equal(res.ok, true);
    assert.equal(env.BF.prefs.get('queue.parallel', 1), 3);
    assert.deepEqual(plain(env.BF.prefs.explain('queue.parallel')), { value: 3, scope: 'general', source: 'explicit', scopeName: '', label: 'geral', evidence: '' });
    const changed = eventNames(env, 'prefs:changed');
    assert.deepEqual(plain(changed[changed.length - 1].keys), ['queue.parallel']);

    const bad = await env.BF.prefs.set('queue.parallel', 99);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'INVALID_VALUE');
    assert.equal(env.BF.prefs.get('queue.parallel', 1), 3, 'valor inválido não muda nada');

    const noScope = await env.BF.prefs.set('queue.parallel', 2, 'game');
    assert.equal(noScope.code, 'NO_SCOPE');
    assert.match(noScope.message, /Defina o jogo ou o canal/);

    assert.equal((await env.BF.prefs.unset('queue.parallel')).ok, true);
    assert.equal(env.BF.prefs.get('queue.parallel', 1), 1);
    assert.equal(env.BF.prefs.explain('queue.parallel').source, 'default');
  } finally { rm(main.dir); }
});

test('abrir vídeo novo: sem pergunta; jogo/canal do projeto definem o cache e a prioridade vale', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const file = path.join(main.dir, 'v', 'novo.mp4');
    makeVideo(file, 3);
    const env = createEnv(main);
    await env.BF.prefs.ready;
    await env.BF.prefs.set('analysis.padBeforeSec', 4); // geral
    const res = await env.BF.openSource(file, { type: 'vod', platform: 'twitch', videoId: '99', channel: 'Fulano', game: 'Valorant' });
    assert.equal(res.ok, true);
    assert.equal(modalOf(env), null, 'vídeo novo não pergunta nada');
    assert.deepEqual(plain(env.BF.prefs.scope()), { game: 'Valorant', channel: 'Fulano' }, 'jogo/canal vêm da origem quando o projeto não tem meta');
    assert.equal(env.BF.prefs.get('analysis.padBeforeSec', 3), 4);

    assert.equal((await env.BF.prefs.set('analysis.padBeforeSec', 8, 'game')).ok, true);
    assert.equal(env.BF.prefs.get('analysis.padBeforeSec', 3), 8);
    assert.equal(env.BF.prefs.explain('analysis.padBeforeSec').scope, 'game');
    assert.equal((await env.BF.prefs.set('analysis.padBeforeSec', 11, 'channel')).ok, true);
    assert.equal(env.BF.prefs.get('analysis.padBeforeSec', 3), 11, 'canal vence jogo');
    assert.equal(env.BF.prefs.explain('analysis.padBeforeSec').label, 'canal Fulano');

    // o usuário escreve o jogo/canal na aba (project.meta): o cache acompanha sem reabrir
    env.BF.project.update((p) => { p.meta.channel = 'Outro Canal'; }, { reason: 'prefs:meta' });
    await until(() => env.BF.prefs.scope().channel === 'Outro Canal', 'cache acompanha project.meta');
    assert.equal(env.BF.prefs.get('analysis.padBeforeSec', 3), 8, 'canal novo não tem valor: cai no jogo');
  } finally { rm(main.dir); }
});

// ---------- aprendizado ----------

test('decisões simuladas viram aprendizado: aviso visível, evidência na aba, vale no BF.prefs e pode ser desativado pela aba', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const file = path.join(main.dir, 'v', 'aprende.mp4');
    makeVideo(file, 3);
    const env = createEnv(main);
    await env.BF.prefs.ready;
    await env.BF.openSource(file);
    const project = env.BF.state.project;
    const durations = [30, 34, 36, 40, 44, 50];
    for (const [i, d] of durations.entries()) {
      const cut = model.newCut({ title: `C${i}`, start: i, end: i + d });
      project.cuts.push(cut);
      cut.status = 'approved';
      env.bus.emit('decision', { cutId: cut.id, type: 'approve', before: 'pending', after: 'approved' });
    }
    await until(() => env.toasts.some((t) => /Preferência aprendida/.test(t.message) || /preferências aprendidas/.test(t.message)), 'aviso de aprendizado');
    assert.equal(env.calls.filter(([c]) => c === 'prefs:observe').length, 1, 'as 6 decisões saem juntas, numa chamada só');
    const observe = env.calls.find(([c]) => c === 'prefs:observe')[1];
    assert.equal(observe.projectId, project.id);
    assert.equal(observe.cuts.length, 6);
    assert.deepEqual(plain(observe.cuts[0].state), { status: 'approved', duration: 30, category: '', relevance: null, origin: 'manual', profileId: 'vertical-1080-h264' });

    await until(() => env.BF.prefs.explain('analysis.maxDurationSec').source === 'learned', 'valor aprendido no cache');
    assert.equal(env.BF.prefs.get('analysis.maxDurationSec', 60), 57);
    assert.equal(env.BF.prefs.explain('analysis.maxDurationSec').label, 'aprendida · geral');
    assert.ok(eventNames(env, 'prefs:changed').some((e) => e.reason === 'learned' && e.keys.includes('analysis.maxDurationSec')), 'prefs:changed avisa os outros recursos');
    assert.equal(env.tab().badge(), '2', 'a aba mostra quantas aprendidas novas ainda não foram vistas');

    env.tab().onShow();
    const panel = env.panel();
    await until(() => panel.textContentDeep.includes('6 cortes aprovados, mediana 38 s'), 'evidência na aba');
    assert.equal(env.tab().badge(), '', 'ao abrir a aba o contador zera');
    const card = panel.querySelectorAll('.prefs-learned').find((c) => c.textContentDeep.includes('Duração máxima'));
    assert.ok(card, 'cartão da preferência aprendida');
    assert.match(card.textContentDeep, /aprendida/);
    assert.match(card.textContentDeep, /em vigor/);

    // desativar pelo controle da própria aba
    const toggle = card.querySelector(`[data-focus="learned-on-${card.dataset.id}"]`);
    toggle.checked = false;
    toggle.dispatch('change');
    await until(() => env.BF.prefs.explain('analysis.maxDurationSec').source === 'default', 'desativada: volta ao padrão');
    assert.equal(env.BF.prefs.get('analysis.maxDurationSec', 60), 60);
    await until(() => panel.querySelectorAll('.prefs-learned').find((c) => c.textContentDeep.includes('Duração máxima') && c.textContentDeep.includes('desativada')), 'cartão mostra desativada');

    // o histórico mostra o que aconteceu e permite desfazer
    const history = panel.querySelector('.prefs-history');
    assert.match(history.textContentDeep, /Desativou a preferência aprendida "Duração máxima"/);
    assert.match(history.textContentDeep, /Nova preferência aprendida/);

    // chave geral
    const master = panel.querySelector('[data-focus="learning-on"]');
    master.checked = false;
    master.dispatch('change');
    await until(() => panel.textContentDeep.includes('Desligado: nada novo é observado'), 'chave geral desligada na aba');
    assert.equal(env.BF.prefs.explain('analysis.minDurationSec').source, 'default', 'nada aprendido vale com a chave desligada');
    env.bus.emit('decision', { cutId: project.cuts[0].id, type: 'reject', before: 'approved', after: 'rejected' });
    await sleep(600);
    assert.equal(env.calls.filter(([c]) => c === 'prefs:observe').length, 1, 'desligado: nada novo é enviado');
    assert.equal(env.toasts.filter((t) => t.kind === 'error').length, 0);
  } finally { rm(main.dir); }
});

test('as decisões pendentes saem antes de abrir outro vídeo (nada se perde ao trocar de projeto)', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const a = path.join(main.dir, 'v', 'a.mp4');
    const b = path.join(main.dir, 'v', 'b.mp4');
    makeVideo(a, 3);
    makeVideo(b, 4, '320x180');
    const env = createEnv(main);
    await env.BF.prefs.ready;
    await env.BF.openSource(a);
    const projectA = env.BF.state.project;
    const cut = model.newCut({ title: 'X', start: 0, end: 1, category: 'Hype' });
    projectA.cuts.push(cut);
    env.bus.emit('decision', { cutId: cut.id, type: 'recategorize', before: '', after: 'Hype' });
    await env.BF.openSource(b); // dentro dos 400 ms de espera
    const observed = env.calls.filter(([c]) => c === 'prefs:observe');
    assert.equal(observed.length, 1);
    assert.equal(observed[0][1].projectId, projectA.id, 'enviado para o projeto de ONDE veio a decisão');
    const learned = await main.call('prefs:learned', {});
    assert.equal(learned.observed, 1);
  } finally { rm(main.dir); }
});

// ---------- correspondência ----------

async function seedOriginal(main, name = 'live.mp4', seconds = 4) {
  const original = path.join(main.dir, 'lives', name);
  makeVideo(original, seconds);
  const saved = saveProject(main.ctx, original, {
    cuts: [{ start: 0, end: 2, status: 'approved', title: 'Primeiro' }, { start: 2, end: 3, status: 'rejected', title: 'Segundo' }],
    origin: origin(), meta: { game: 'Valorant', channel: 'Fulano' }
  });
  const projectFile = path.join(main.ctx.paths.projects, `${saved.id}.json`);
  return { original, saved, projectFile };
}

test('fonte duplicada: pergunta com 3 saídas; CANCELAR não abre nem cria projeto', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const { original, projectFile } = await seedOriginal(main);
    const copy = path.join(main.dir, 'backup', 'live.mp4');
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(original, copy);
    const before = fs.readFileSync(projectFile, 'utf8');
    const env = createEnv(main);
    await env.BF.prefs.ready;

    const { promise, modal } = await openAndWaitModal(env, copy, origin());
    assert.equal(modal.querySelector('h2').textContentDeep, 'Esta live já foi analisada?');
    const message = modal.querySelector('.bf-modal-msg').textContentDeep;
    assert.match(message, /^Parece a live “Minha live”, já analisada \(2 cortes\)\./);
    assert.match(message, /Motivo: mesmo vídeo do YouTube \(código abc123XYZ_1\)\./);
    assert.ok(message.includes(`Projeto existente: ${path.resolve(original)}`));
    assert.match(message, /o projeto original não é alterado/);
    assert.deepEqual(buttonsOf(env), [
      { act: 'cancel', label: 'Cancelar' }, { act: 'new', label: 'Criar novo' }, { act: 'ok', label: 'Abrir o projeto existente' }
    ]);
    assert.equal(env.app.inert, true, 'o fundo fica inerte enquanto pergunta');
    assert.equal(env.BF.state.project, null, 'nada abriu antes da resposta');

    modal.querySelector('[data-act="cancel"]').click();
    const res = await promise;
    assert.equal(res.ok, false);
    assert.equal(res.code, 'CANCELLED');
    assert.equal(env.BF.state.project, null, 'recusar não abre');
    assert.equal(main.ctx.projectStore.load(copy), null, 'nem cria projeto para a cópia');
    assert.equal(fs.readFileSync(projectFile, 'utf8'), before, 'o projeto original não foi tocado');
    assert.equal(modalOf(env), null);
    assert.equal(env.app.inert, false);
    assert.equal(env.calls.filter(([c]) => c === 'project:adopt').length, 0);
    assert.equal(env.calls.filter(([c]) => c === 'source:open').length, 0);
  } finally { rm(main.dir); }
});

test('Esc e clique fora também cancelam (nunca abre sem confirmar)', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const { original } = await seedOriginal(main);
    const copy = path.join(main.dir, 'backup', 'live.mp4');
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(original, copy);
    const env = createEnv(main);
    await env.BF.prefs.ready;

    let { promise } = await openAndWaitModal(env, copy, origin());
    env.doc.dispatch('keydown', { key: 'Escape' });
    assert.equal((await promise).code, 'CANCELLED');
    assert.equal(modalOf(env), null);

    ({ promise } = await openAndWaitModal(env, copy, origin()));
    const backdrop = env.modalRoot.querySelector('.bf-modal-backdrop');
    backdrop.dispatch('mousedown', { target: backdrop });
    assert.equal((await promise).code, 'CANCELLED');
    assert.equal(env.BF.state.project, null);
  } finally { rm(main.dir); }
});

test('CRIAR NOVO abre um projeto vazio, registra a decisão e não pergunta de novo', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const { original } = await seedOriginal(main);
    const copy = path.join(main.dir, 'backup', 'live.mp4');
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(original, copy);
    const env = createEnv(main);
    await env.BF.prefs.ready;

    const { promise, modal } = await openAndWaitModal(env, copy, origin());
    modal.querySelector('[data-act="new"]').click();
    const res = await promise;
    assert.equal(res.ok, true);
    assert.equal(res.restored, false, 'projeto criado agora');
    assert.equal(env.BF.state.project.cuts.length, 0);
    assert.equal(env.BF.state.project.ext.prefs.match.decision, 'new');
    assert.equal(env.calls.filter(([c]) => c === 'project:adopt').length, 0);

    // reabrir (mesmo sem cortes): o usuário já respondeu, não pergunta de novo
    await env.BF.project.flush();
    const again = await env.BF.openSource(copy, origin());
    assert.equal(again.ok, true);
    assert.equal(modalOf(env), null);
  } finally { rm(main.dir); }
});

test('ABRIR O EXISTENTE copia cortes e decisões para o arquivo novo sem alterar o original', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const { original, saved, projectFile } = await seedOriginal(main);
    const copy = path.join(main.dir, 'backup', 'outro nome.mp4');
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(original, copy);
    const before = fs.readFileSync(projectFile, 'utf8');
    const env = createEnv(main);
    await env.BF.prefs.ready;
    await env.BF.prefs.set('analysis.padAfterSec', 9, { type: 'channel', name: 'Fulano' });

    const { promise, modal } = await openAndWaitModal(env, copy, origin());
    modal.querySelector('[data-act="ok"]').click();
    const res = await promise;
    assert.equal(res.ok, true);
    assert.equal(res.restored, true, 'abre o projeto adotado');
    const project = env.BF.state.project;
    assert.equal(path.resolve(project.source.path), path.resolve(copy));
    assert.deepEqual(project.cuts.map((c) => [c.id, c.title, c.status]), saved.cuts.map((c) => [c.id, c.title, c.status]), 'mesmos cortes e decisões');
    assert.equal(project.meta.game, 'Valorant');
    assert.equal(project.ext.prefs.adoptedFrom.projectId, saved.id);
    assert.equal(project.ext.prefs.adoptedFrom.label, 'Minha live');
    assert.equal(project.ext.prefs.adoptedFrom.level, 'strong');
    assert.deepEqual(plain(env.calls.find(([c]) => c === 'project:adopt')[1]), { fromId: saved.id, path: copy, origin: origin() });
    assert.equal(fs.readFileSync(projectFile, 'utf8'), before, 'o original continua byte a byte igual');
    assert.ok(env.toasts.some((t) => /copiados de “Minha live”/.test(t.message)));
    assert.equal(env.BF.prefs.get('analysis.padAfterSec', 2), 9, 'as preferências do canal do projeto adotado já valem');
    assert.ok(env.calls.some(([c, p]) => c === 'review:historyCopy' && p.fromProjectId === saved.id), 'tenta levar o histórico de decisões junto (melhor esforço)');
  } finally { rm(main.dir); }
});

/** Projeto da live "Minha live" (6 s) com um corte dentro e outro depois dos 3 s; o arquivo novo (3 s) é o mesmo VOD baixado de novo. */
async function seedLongOriginal(main) {
  const original = path.join(main.dir, 'lives', 'live-a.mp4');
  makeVideo(original, 6);
  const saved = saveProject(main.ctx, original, {
    cuts: [{ start: 0, end: 2, status: 'approved', title: 'Dentro' }, { start: 3.2, end: 5.5, status: 'approved', title: 'Fora', notes: 'ajuste manual' }],
    origin: origin(), meta: { game: 'Valorant', channel: 'Fulano' }
  });
  const redownload = path.join(main.dir, 'downloads', 'live-a (2).mp4');
  makeVideo(redownload, 3);
  return { original, saved, redownload, projectFile: path.join(main.ctx.paths.projects, `${saved.id}.json`) };
}

test('ABRIR O EXISTENTE com o VOD baixado de novo (mais curto): a pergunta mostra a diferença, os cortes fora do intervalo ficam sinalizados e nada é apagado', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const { saved, redownload, projectFile } = await seedLongOriginal(main);
    const before = fs.readFileSync(projectFile, 'utf8');
    const env = createEnv(main);
    await env.BF.prefs.ready;

    const { promise, modal } = await openAndWaitModal(env, redownload, origin());
    const message = modal.querySelector('.bf-modal-msg').textContentDeep;
    assert.match(message, /^Parece a live “Minha live”, já analisada \(2 cortes\)\./);
    assert.match(message, /Este arquivo é diferente do que foi analisado:/);
    assert.match(message, /• O vídeo ficou mais curto: /);
    assert.match(message, /• 1 corte fica fora do novo intervalo \(“Fora”\)/);
    assert.match(message, /nada é apagado/);
    assert.ok(message.indexOf('Este arquivo é diferente') < message.indexOf('Abrir o existente copia'), 'a diferença vem antes da escolha');
    modal.querySelector('[data-act="ok"]').click();
    const res = await promise;
    assert.equal(res.ok, true);

    const project = env.BF.state.project;
    assert.equal(path.resolve(project.source.path), path.resolve(redownload));
    assert.deepEqual(project.cuts.map((c) => [c.title, c.status, c.start, c.end, c.notes]), saved.cuts.map((c) => [c.title, c.status, c.start, c.end, c.notes]), 'cortes e decisões intactos, inclusive o que passa do fim');
    const change = project.ext.prefs.sourceChange;
    assert.equal(change.direction, 'shorter');
    assert.equal(change.dismissed, false);
    assert.ok(change.before.duration > change.after.duration + 2);
    assert.equal(project.ext.prefs.adoptedFrom.projectId, saved.id);
    assert.equal(env.tab().badge(), '!', 'o selo da aba chama atenção enquanto há corte fora do intervalo');
    const toast = env.toasts.find((t) => /copiados de “Minha live”/.test(t.message));
    assert.ok(toast && toast.kind === 'error' && /1 corte ficou fora do novo intervalo/.test(toast.message), 'um aviso só: copiou e há corte fora');
    assert.equal(env.toasts.filter((t) => /Fonte atualizada/.test(t.message)).length, 0);
    assert.equal(fs.readFileSync(projectFile, 'utf8'), before, 'o projeto original continua byte a byte igual');

    env.tab().onShow();
    const panel = env.panel();
    await until(() => panel.textContentDeep.includes('Fonte atualizada'), 'card de fonte atualizada na aba');
    const notice = panel.querySelector('.prefs-notice');
    assert.match(notice.textContentDeep, /1 corte está fora do novo intervalo \(não apagados\)/);
    assert.match(notice.textContentDeep, /Fora · 0:03–0:06/);
  } finally { rm(main.dir); }
});

test('ABRIR O EXISTENTE com o VOD que cresceu: diz que o trecho novo não foi analisado e não há corte fora', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const original = path.join(main.dir, 'lives', 'live-b.mp4');
    makeVideo(original, 3);
    saveProject(main.ctx, original, { cuts: [{ start: 0, end: 2, status: 'approved', title: 'Único' }], origin: origin(), meta: { channel: 'Fulano' } });
    const grown = path.join(main.dir, 'downloads', 'live-b (2).mp4');
    makeVideo(grown, 7);
    const env = createEnv(main);
    await env.BF.prefs.ready;
    const { promise, modal } = await openAndWaitModal(env, grown, origin());
    const message = modal.querySelector('.bf-modal-msg').textContentDeep;
    assert.match(message, /• O vídeo ficou mais longo: /);
    assert.match(message, /• O trecho novo \(de 0:03 em diante\) ainda não foi analisado\./);
    modal.querySelector('[data-act="ok"]').click();
    assert.equal((await promise).ok, true);
    assert.equal(env.BF.state.project.ext.prefs.sourceChange.direction, 'longer');
    assert.equal(env.tab().badge(), '', 'nenhum corte fora: só o card informativo, sem alerta');
    assert.ok(env.toasts.some((t) => t.kind === 'ok' && /copiados de “Minha live”\. O projeto original continua como estava\.$/.test(t.message)));
  } finally { rm(main.dir); }
});

test('cópia idêntica ou CRIAR NOVO: a pergunta não cita diferenças e nenhuma mudança de fonte é gravada', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const { original } = await seedOriginal(main);
    const copy = path.join(main.dir, 'backup', 'live.mp4');
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(original, copy);
    const env = createEnv(main);
    await env.BF.prefs.ready;
    let { promise, modal } = await openAndWaitModal(env, copy, origin());
    assert.ok(!modal.querySelector('.bf-modal-msg').textContentDeep.includes('diferente do que foi analisado'));
    modal.querySelector('[data-act="ok"]').click();
    assert.equal((await promise).ok, true);
    assert.equal(env.BF.state.project.ext.prefs.sourceChange, undefined, 'arquivo igual: nada mudou');
    assert.equal(env.tab().badge(), '');

    // criar novo com uma fonte diferente: não adota nada, então não há o que sinalizar
    const { redownload } = await seedLongOriginal(main);
    ({ promise, modal } = await openAndWaitModal(env, redownload, origin({ videoId: 'abc123XYZ_1' })));
    assert.match(modal.querySelector('.bf-modal-msg').textContentDeep, /Este arquivo é diferente do que foi analisado:/);
    modal.querySelector('[data-act="new"]').click();
    assert.equal((await promise).ok, true);
    assert.equal(env.BF.state.project.cuts.length, 0);
    assert.equal(env.BF.state.project.ext.prefs.sourceChange, undefined);
    assert.equal(env.BF.state.project.ext.prefs.match.decision, 'new');
  } finally { rm(main.dir); }
});

test('o aviso de aprendizado (toast e contador da aba) é só do que é novo ou mudou muito; a mudança pequena atualiza o valor sem aviso', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const file = path.join(main.dir, 'v', 'aviso.mp4');
    makeVideo(file, 3);
    let answer = [];
    const env = createEnv(main, { overrides: { 'prefs:observe': () => ({ ok: true, ignored: false, changes: answer }) } });
    await env.BF.prefs.ready;
    await env.BF.openSource(file);
    const project = env.BF.state.project;
    const change = (extra) => ({
      itemId: 'general::analysis.maxDurationSec', key: 'analysis.maxDurationSec', label: 'Duração máxima', scope: { type: 'general', key: '', name: '' },
      value: 57, evidence: '6 cortes aprovados, mediana 38 s', fresh: false, notify: false, text: '"Duração máxima" = 57 s (geral) — 6 cortes aprovados, mediana 38 s', ...extra
    });
    const count = (channel) => env.calls.filter(([c]) => c === channel).length;
    const decide = async (n) => {
      const cut = model.newCut({ title: `C${n}`, start: 0, end: 30, status: 'approved' });
      project.cuts.push(cut);
      env.bus.emit('decision', { cutId: cut.id, type: 'approve', before: 'pending', after: 'approved' });
      await until(() => count('prefs:observe') === n, `observe ${n}`);
    };
    const learnedToasts = () => env.toasts.filter((t) => /Preferência aprendida|preferências aprendidas/.test(t.message));

    answer = [change({ notify: false })]; // a mediana andou um pouco
    const reloads = count('prefs:resolve');
    await decide(1);
    await until(() => count('prefs:resolve') > reloads, 'o valor novo chega ao cache mesmo sem aviso');
    assert.equal(learnedToasts().length, 0, 'sem toast');
    assert.equal(env.tab().badge(), '', 'e sem contador de novidade');

    answer = [change({ notify: true, value: 90 })]; // mudou muito
    await decide(2);
    await until(() => learnedToasts().length === 1, 'toast da mudança relevante');
    assert.match(learnedToasts()[0].message, /^Preferência aprendida: "Duração máxima"/);
    assert.equal(env.tab().badge(), '1');

    answer = [change({ fresh: true, notify: true }), change({ itemId: 'general::analysis.minDurationSec', key: 'analysis.minDurationSec', label: 'Duração mínima', notify: false })];
    await decide(3);
    await until(() => learnedToasts().length === 2, 'toast do que é novo');
    assert.match(learnedToasts()[1].message, /^Preferência aprendida: "Duração máxima"/, 'só o que merece aviso entra no texto');
    assert.equal(env.tab().badge(), '2');
  } finally { rm(main.dir); }
});

test('se a adoção falhar, o motivo aparece e nada abre', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const { original } = await seedOriginal(main);
    const copy = path.join(main.dir, 'backup', 'live.mp4');
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(original, copy);
    const env = createEnv(main, { overrides: { 'project:adopt': () => ({ ok: false, code: 'PROJECT_EXISTS', message: 'Já existe um projeto com cortes para este vídeo; nada foi alterado.' }) } });
    await env.BF.prefs.ready;
    const { promise, modal } = await openAndWaitModal(env, copy, origin());
    modal.querySelector('[data-act="ok"]').click();
    const res = await promise;
    assert.equal(res.code, 'CANCELLED');
    assert.ok(env.toasts.some((t) => t.kind === 'error' && /Já existe um projeto com cortes/.test(t.message)));
    assert.equal(env.BF.state.project, null);
    assert.equal(env.calls.filter(([c]) => c === 'source:open').length, 0);
  } finally { rm(main.dir); }
});

test('correspondência fraca (arquivo copiado, sem origem): pergunta com texto mais cauteloso e motivos', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const { original } = await seedOriginal(main);
    const copy = path.join(main.dir, 'backup', 'live.mp4');
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(original, copy);
    const env = createEnv(main);
    await env.BF.prefs.ready;
    const { promise, modal } = await openAndWaitModal(env, copy, null);
    const message = modal.querySelector('.bf-modal-msg').textContentDeep;
    assert.match(message, /^Pode ser a live “Minha live”, já analisada \(2 cortes\)\./);
    assert.match(message, /Motivo: mesmo tamanho (.*); duração parecida/, 'o nome "live.mp4" é genérico e não conta como sinal');
    modal.querySelector('[data-act="cancel"]').click();
    assert.equal((await promise).code, 'CANCELLED');
  } finally { rm(main.dir); }
});

test('vídeo diferente ou sem informação suficiente não pergunta nada; falha da checagem nunca bloqueia a abertura', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    await seedOriginal(main);
    const different = path.join(main.dir, 'backup', 'diferente.mp4');
    makeVideo(different, 5, '320x180');
    const env = createEnv(main);
    await env.BF.prefs.ready;
    assert.equal((await env.BF.openSource(different)).ok, true);
    assert.equal(modalOf(env), null);

    const other = path.join(main.dir, 'backup', 'outro.mp4');
    makeVideo(other, 6, '320x180');
    const broken = createEnv(main, { overrides: { 'prefs:inspect': () => ({ ok: false, code: 'X', message: 'falhou' }) } });
    await broken.BF.prefs.ready;
    assert.equal((await broken.BF.openSource(other)).ok, true, 'a checagem falhou, o vídeo abre mesmo assim');
  } finally { rm(main.dir); }
});

// ---------- fonte atualizada ----------

test('fonte regravada mais curta: mostra a diferença, só aplica após confirmar e sinaliza (sem apagar) os cortes fora', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const file = path.join(main.dir, 'v', 'live.mp4');
    makeVideo(file, 6);
    const env = createEnv(main);
    await env.BF.prefs.ready;
    await env.BF.openSource(file);
    const p = env.BF.state.project;
    p.cuts.push(model.newCut({ title: 'Dentro', start: 0, end: 2, status: 'approved', category: 'Hype' }));
    p.cuts.push(model.newCut({ title: 'Fora', start: 3.2, end: 5.5, status: 'approved', notes: 'ajuste manual' }));
    await env.BF.project.flush();
    const projectFile = path.join(main.ctx.paths.projects, `${p.id}.json`);
    const stored = fs.readFileSync(projectFile, 'utf8');
    const oldDuration = p.source.duration;

    makeVideo(file, 3); // regravado
    env.state.confirmAnswer = false;
    const declined = await env.BF.openSource(file);
    assert.equal(declined.code, 'CANCELLED');
    assert.equal(env.confirms.length, 1);
    assert.equal(env.confirms[0].title, 'A fonte mudou desde a última análise');
    assert.equal(env.confirms[0].okLabel, 'Atualizar e abrir');
    assert.match(env.confirms[0].message, /O vídeo ficou mais curto/);
    assert.match(env.confirms[0].message, /1 corte fica fora do novo intervalo \(“Fora”\)/);
    assert.match(env.confirms[0].message, /Suas decisões, títulos e ajustes manuais continuam como estão/);
    assert.equal(fs.readFileSync(projectFile, 'utf8'), stored, 'recusar não altera o projeto salvo');
    assert.equal(env.BF.state.project.source.duration, oldDuration, 'nem o aberto');
    assert.equal(env.calls.filter(([c]) => c === 'source:open').length, 1, 'só a abertura inicial');

    env.state.confirmAnswer = true;
    const accepted = await env.BF.openSource(file);
    assert.equal(accepted.ok, true);
    const after = env.BF.state.project;
    assert.ok(after.source.duration < oldDuration - 2, 'a base atualizou a duração depois da confirmação');
    assert.deepEqual(after.cuts.map((c) => [c.title, c.status, c.category, c.notes, c.start, c.end]), [
      ['Dentro', 'approved', 'Hype', '', 0, 2], ['Fora', 'approved', '', 'ajuste manual', 3.2, 5.5]
    ], 'decisões e ajustes preservados; o corte fora NÃO foi apagado nem ajustado');
    const change = after.ext.prefs.sourceChange;
    assert.equal(change.direction, 'shorter');
    assert.equal(change.dismissed, false);
    assert.ok(change.before.duration > change.after.duration);
    assert.ok(env.toasts.some((t) => t.kind === 'error' && /1 corte ficou fora do novo intervalo/.test(t.message)));
    assert.equal(env.tab().badge(), '!', 'a aba chama atenção enquanto há corte fora do intervalo');

    // a aba mostra o aviso e deixa ver o corte
    env.tab().onShow();
    const panel = env.panel();
    await until(() => panel.textContentDeep.includes('Fonte atualizada'), 'aviso na aba');
    const notice = panel.querySelector('.prefs-notice');
    assert.equal(notice.hidden, false);
    assert.match(notice.textContentDeep, /1 corte está fora do novo intervalo \(não apagados\)/);
    assert.match(notice.textContentDeep, /Fora · 0:03–0:06/);
    const ver = notice.querySelectorAll('button').find((b) => b.textContentDeep === 'Ver');
    ver.click();
    assert.ok(eventNames(env, 'selectTab').includes('cuts'));
    assert.equal(eventNames(env, 'cut:selected').pop().id, after.cuts[1].id);

    // dispensar o aviso
    notice.querySelectorAll('button').find((b) => b.textContentDeep === 'Dispensar aviso').click();
    assert.equal(env.BF.state.project.ext.prefs.sourceChange.dismissed, true);
    assert.equal(env.tab().badge(), '');
    assert.equal(panel.querySelector('.prefs-notice').hidden, true);
  } finally { rm(main.dir); }
});

test('VOD que cresceu: confirma, mantém tudo e diz que o trecho novo não foi analisado', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const file = path.join(main.dir, 'v', 'vod.mp4');
    makeVideo(file, 3);
    const env = createEnv(main);
    await env.BF.prefs.ready;
    await env.BF.openSource(file);
    env.BF.state.project.cuts.push(model.newCut({ title: 'Único', start: 0, end: 2 }));
    await env.BF.project.flush();
    makeVideo(file, 7);
    const res = await env.BF.openSource(file);
    assert.equal(res.ok, true);
    assert.match(env.confirms[0].message, /O vídeo ficou mais longo/);
    assert.match(env.confirms[0].message, /O trecho novo \(de 0:03 em diante\) ainda não foi analisado/);
    assert.equal(env.BF.state.project.cuts.length, 1);
    assert.equal(env.BF.state.project.ext.prefs.sourceChange.direction, 'longer');
    assert.ok(env.toasts.some((t) => t.kind === 'ok' && /Fonte atualizada\. Decisões e ajustes foram mantidos/.test(t.message)));
    assert.equal(env.tab().badge(), '', 'nenhum corte fora: sem alerta na aba');
  } finally { rm(main.dir); }
});

test('abrir o mesmo arquivo sem mudança não pergunta nada', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const file = path.join(main.dir, 'v', 'igual.mp4');
    makeVideo(file, 3);
    const env = createEnv(main);
    await env.BF.prefs.ready;
    await env.BF.openSource(file);
    env.BF.state.project.cuts.push(model.newCut({ title: 'Um', start: 0, end: 1 }));
    await env.BF.project.flush();
    assert.equal((await env.BF.openSource(file)).ok, true);
    assert.equal(env.confirms.length, 0);
    assert.equal(modalOf(env), null);
  } finally { rm(main.dir); }
});

test('se o recurso não carregar no processo principal, a aba explica em vez de ficar vazia', async () => {
  const main = setupMain();
  try {
    const env = createEnv(main, { overrides: { 'prefs:schema': () => ({ ok: false, code: 'X', message: 'handler indisponível' }) } });
    await env.BF.prefs.ready;
    env.tab().onShow();
    await until(() => env.panel().textContentDeep.includes('Não foi possível carregar as preferências'), 'mensagem de erro na aba');
    assert.match(env.panel().textContentDeep, /handler indisponível/);
    assert.equal(env.BF.prefs.get('queue.parallel', 7), 7, 'sem esquema o BF.prefs continua respondendo (o resolve não depende dele)');
  } finally { rm(main.dir); }
});

test('o contador da aba não sobe quando a aba já está na tela; aviso de aprendizado único cita o texto com evidência', { skip: skipMedia }, async () => {
  const main = setupMain();
  try {
    const file = path.join(main.dir, 'v', 'contador.mp4');
    makeVideo(file, 3);
    const env = createEnv(main);
    await env.BF.prefs.ready;
    await env.BF.openSource(file);
    // aba "na tela": o painel diz que não está oculto
    env.panel().closest = () => ({ hidden: false });
    const project = env.BF.state.project;
    for (const [i, d] of [30, 34, 36, 40, 44, 50].entries()) {
      const cut = model.newCut({ title: `C${i}`, start: i, end: i + d, status: 'approved' });
      project.cuts.push(cut);
      env.bus.emit('decision', { cutId: cut.id, type: 'approve', before: 'pending', after: 'approved' });
    }
    await until(() => env.toasts.some((t) => /preferências aprendidas \(Duração mínima, Duração máxima\)/.test(t.message)), 'aviso resumido');
    assert.equal(env.tab().badge(), '', 'o usuário está olhando a aba: nada "novo" para ver');
  } finally { rm(main.dir); }
});

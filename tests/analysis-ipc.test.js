'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tools, skipMedia, mkTmp, rmrf, makeMedia } = require('./analysis-fixtures');
const { createContext } = require('../src/ipc/context');
const { loadHandlers } = require('../src/ipc');
const { AnalysisManager } = require('../src/core/analysis/manager');
const { TranscriptStore } = require('../src/core/analysis/transcript/store');
const { buildDocument } = require('../src/core/analysis/transcript/format');

const silent = { log() {}, info() {}, warn() {}, error() {} };
const T = { skip: skipMedia };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Electron falso: guarda handlers e eventos enviados; `app.on` registra os ganchos de fechamento. */
function fakeElectron(userData, extra = {}) {
  const handlers = new Map();
  const sent = [];
  const appEvents = new Map();
  const win = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } };
  const deps = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: () => userData, getVersion: () => '9.9.9', on: (name, fn) => appEvents.set(name, [...(appEvents.get(name) || []), fn]) },
    dialog: {},
    shell: {},
    getWindow: () => win,
    logger: silent,
    ...extra
  };
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  const events = (name) => sent.filter(([channel]) => channel === name).map(([, payload]) => payload);
  return { deps, handlers, sent, appEvents, call, events };
}

// Esperas por CONDIÇÃO (voltam assim que ela acontece): o prazo só existe para não travar para sempre. A análise roda com
// prioridade abaixo do normal, então com o computador ocupado ela fica muito mais lenta que em repouso (~10x já foi medido).
const WAIT = 180000;
async function waitFor(fn, ms = WAIT, what = 'condição') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`Tempo esgotado esperando: ${what}`);
}

function setup(extra) {
  const dir = mkTmp('analysis-ipc');
  const fe = fakeElectron(path.join(dir, 'ud'), extra);
  const ctx = createContext(fe.deps);
  const res = loadHandlers(ctx);
  assert.deepEqual(res.failed, []);
  return { dir, fe, ctx };
}

test('o handler de análise carrega junto dos outros e registra os canais do contrato', () => {
  const { dir, fe } = setup();
  try {
    for (const channel of ['analysis:defaults', 'analysis:start', 'analysis:cancel', 'analysis:status']) assert.ok(fe.handlers.has(channel), channel);
    assert.ok(fe.appEvents.has('before-quit'), 'encerra o ffmpeg ao fechar o app');
  } finally { rmrf(dir); }
});

test('analysis:defaults devolve os padrões e limites dos parâmetros', async () => {
  const { dir, fe } = setup();
  try {
    const res = await fe.call('analysis:defaults');
    assert.equal(res.ok, true);
    assert.equal(res.defaults.sensitivity, 3);
    assert.deepEqual(res.defaults.weights, { audio: 0.8, image: 0.6, chat: 1, text: 1, calm: 0.7 });
    assert.deepEqual(res.defaults.textWeights, { laugh: 1, exclaim: 1, pace: 1, repeat: 1, meta: 1, humor: 1, structure: 1 });
    assert.equal(res.defaults.profile, 'gameplay');
    assert.deepEqual(res.defaults.humor, { phrases: [], reactions: [] });
    assert.deepEqual(res.defaults.signals, { audio: true, image: true, chat: true, text: true, calm: true });
    assert.equal(res.version, 5);
    assert.equal(res.defaults.minDurationSec, 15);
    assert.equal(res.defaults.maxDurationSec, 60);
    assert.deepEqual(res.ranges.sensitivity, [1, 5]);
    assert.ok(Array.isArray(res.defaults.chat.keywords));
    assert.deepEqual((await fe.call('analysis:status')), { ok: true, running: null });
    assert.deepEqual((await fe.call('analysis:cancel', {})), { ok: true, cancelled: false });
  } finally { rmrf(dir); }
});

test('analysis:start valida: caminho, arquivo ausente e FFmpeg ausente (com a solução)', async () => {
  const { dir, fe } = setup();
  const noTools = setup({ resolveTools: () => ({}) });
  try {
    assert.equal((await fe.call('analysis:start', {})).code, 'INVALID_ARGS');
    const missing = await fe.call('analysis:start', { path: path.join(dir, 'nao-existe.mp4') });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'INPUT_MISSING');
    assert.match(missing.message, /não foi encontrado/);
    const file = path.join(dir, 'x.mp4');
    fs.writeFileSync(file, 'x');
    const none = await noTools.fe.call('analysis:start', { path: file });
    assert.equal(none.code, 'NO_FFMPEG');
    assert.match(none.message, /Instale o FFmpeg/);
    assert.match(none.message, /Verificar de novo/);
  } finally { rmrf(dir); rmrf(noTools.dir); }
});

test('analysis:start roda em segundo plano: volta na hora, manda progresso e o resultado; uma por vez; não grava o projeto', T, async () => {
  const { dir, fe, ctx } = setup();
  try {
    const video = makeMedia(path.join(dir, 'v.mp4'), { seconds: 60, audio: { baseDb: -50, bursts: [{ at: 20, dur: 3, db: -20 }] } });
    const t0 = Date.now();
    const started = await fe.call('analysis:start', { path: video, params: { signals: { image: false } } });
    assert.equal(started.ok, true);
    assert.match(started.jobId, /^a/);
    assert.ok(Date.now() - t0 < 5000, 'a chamada volta logo (o que prova o segundo plano é o analysis:done ainda não existir, logo abaixo)');
    assert.equal(fe.events('analysis:done').length, 0, 'ainda não terminou quando a chamada volta');

    // segunda análise enquanto a primeira roda
    const busy = await fe.call('analysis:start', { path: video });
    assert.equal(busy.ok, false);
    assert.equal(busy.code, 'BUSY');
    assert.match(busy.message, /em andamento/);
    const status = await fe.call('analysis:status');
    assert.equal(status.running.jobId, started.jobId);

    const done = await waitFor(() => fe.events('analysis:done')[0], WAIT, 'analysis:done');
    assert.equal(done.jobId, started.jobId);
    assert.equal(done.result.suggestions.length, 1);
    assert.ok(done.result.suggestions[0].peak > 20 && done.result.suggestions[0].peak < 24);
    assert.deepEqual(done.result.usedSignals, ['audio', 'calm']);
    const progress = fe.events('analysis:progress');
    assert.ok(progress.length >= 2 && progress.every((p) => p.jobId === started.jobId && p.p >= 0 && p.p <= 1));
    assert.equal(progress.at(-1).p, 1);
    assert.deepEqual((await fe.call('analysis:status')).running, null);
    assert.equal(fe.events('analysis:failed').length, 0);

    // o resultado ficou em cache dentro de userData/cache/analysis; o main não gravou projeto nenhum
    assert.ok(fs.readdirSync(path.join(ctx.paths.cache, 'analysis')).some((f) => f.startsWith('res-')));
    assert.deepEqual(fs.readdirSync(ctx.paths.projects), [], 'quem grava o projeto é o renderer');

    // de novo: vem do cache
    await fe.call('analysis:start', { path: video, params: { signals: { image: false } } });
    const again = await waitFor(() => fe.events('analysis:done')[1], WAIT, 'segunda análise');
    assert.equal(again.result.fromCache, true);

    // fresh:true (o "Analisar de novo" da aba) ignora o que está guardado e lê o vídeo outra vez
    await fe.call('analysis:start', { path: video, params: { signals: { image: false } }, fresh: true });
    const refreshed = await waitFor(() => fe.events('analysis:done')[2], WAIT, 'análise com fresh');
    assert.equal(refreshed.result.fromCache, false);
    assert.equal(refreshed.result.signals.audio.cached, false);
    assert.deepEqual(refreshed.result.suggestions.map((s) => [s.start, s.end]), done.result.suggestions.map((s) => [s.start, s.end]));
  } finally { rmrf(dir); }
});

test('analysis:start com projectId: o processo principal acha a transcrição do vídeo e o algoritmo a usa como sinal de texto (conferida com o arquivo)', T, async () => {
  const { dir, fe, ctx } = setup();
  try {
    const video = makeMedia(path.join(dir, 'v.mp4'), { seconds: 60, audio: { baseDb: -45, wobbleDb: 2 } });
    const size = fs.statSync(video).size;
    const cues = [];
    for (let t = 0; t < 30; t += 6) cues.push({ start: t, end: t + 5, text: `hoje a gente explora essa região do mapa ${t}` });
    const lively = ['Nossa, olha isso!', 'Não acredito!', 'Caralho, morri de novo!', 'Que foda, véi, que foda, véi!'];
    for (let t = 30, i = 0; t < 45; t += 3, i += 1) cues.push({ start: t, end: t + 2.5, text: `${lively[i % 4]} ${lively[(i + 1) % 4]} ${lively[(i + 2) % 4]}` });
    for (let t = 45; t < 60; t += 6) cues.push({ start: t, end: t + 5, text: `depois eu volto aqui para conferir o que sobrou ${t}` });
    const store = new TranscriptStore(path.join(ctx.paths.userData, 'transcripts'));
    store.save('p1', buildDocument({ projectId: 'p1', origin: 'imported', source: { path: video, size, duration: 60 }, cues, dropped: { invalid: 0, beyond: 0, repeats: 0 }, importedFrom: 'a.srt' }));

    // inicia uma análise só com o sinal de texto e espera o fim dela (resultado ou falha)
    const outcome = async (payload) => {
      const doneBefore = fe.events('analysis:done').length;
      const failedBefore = fe.events('analysis:failed').length;
      const started = await fe.call('analysis:start', { path: video, params: { signals: { audio: false, image: false, chat: false } }, ...payload });
      assert.equal(started.ok, true, JSON.stringify(started));
      await waitFor(() => fe.events('analysis:done').length > doneBefore || fe.events('analysis:failed').length > failedBefore, WAIT, 'fim da análise');
      return fe.events('analysis:done').length > doneBefore ? { done: fe.events('analysis:done').at(-1).result } : { failed: fe.events('analysis:failed').at(-1) };
    };
    const withText = (await outcome({ projectId: 'p1', size, duration: 60 })).done;
    assert.ok(withText, 'a transcrição do projeto foi encontrada e usada');
    assert.equal(withText.signals.text.used, true);
    assert.equal(withText.signals.text.cues, cues.length);
    assert.deepEqual(withText.usedSignals, ['text']);
    assert.ok(withText.suggestions.some((s) => s.start <= 32 && s.end >= 42), JSON.stringify(withText.suggestions));
    assert.ok(withText.suggestions[0].reasons.includes('exclamações e reações'), withText.suggestions[0].reasons.join('|'));

    // transcrição de OUTRO arquivo (tamanho diferente): não vale, e a resposta diz por quê
    const stale = (await outcome({ projectId: 'p1', size: size + 1, duration: 60 })).failed;
    assert.equal(stale.code, 'NO_SIGNALS');
    assert.match(stale.message, /Texto: a transcrição guardada é de outro arquivo de vídeo/);
    // sem projectId, ou com um identificador inválido: segue sem texto (nada quebra)
    const noId = (await outcome({})).failed;
    assert.match(noId.message, /Texto: este vídeo não tem transcrição/);
    const invalid = (await outcome({ projectId: '../fora', size, duration: 60 })).failed;
    assert.match(invalid.message, /Texto: este vídeo não tem transcrição/);
    // projeto sem transcrição guardada
    const other = (await outcome({ projectId: 'p2', size, duration: 60 })).failed;
    assert.match(other.message, /Texto: este vídeo não tem transcrição/);
  } finally { rmrf(dir); }
});

test('analysis:cancel interrompe a análise e avisa com CANCELLED (sem erro de log)', T, async () => {
  const { dir, fe } = setup();
  try {
    const video = makeMedia(path.join(dir, 'v.mp4'), { seconds: 120, audio: { baseDb: -45, wobbleDb: 2 } });
    const started = await fe.call('analysis:start', { path: video });
    const cancel = await fe.call('analysis:cancel', { jobId: started.jobId });
    assert.deepEqual(cancel, { ok: true, cancelled: true });
    const failed = await waitFor(() => fe.events('analysis:failed')[0], WAIT, 'analysis:failed');
    assert.equal(failed.code, 'CANCELLED');
    assert.equal(failed.jobId, started.jobId);
    assert.match(failed.message, /Nada foi alterado/);
    assert.equal(fe.events('analysis:done').length, 0);
    assert.deepEqual((await fe.call('analysis:cancel', { jobId: 'outro' })), { ok: true, cancelled: false });
    // liberou para uma nova análise
    const next = await fe.call('analysis:start', { path: video, params: { signals: { image: false } } });
    assert.equal(next.ok, true);
    await waitFor(() => fe.events('analysis:done')[0], WAIT, 'análise seguinte');
  } finally { rmrf(dir); }
});

test('before-quit encerra a análise em andamento', T, async () => {
  const { dir, fe } = setup();
  try {
    const video = makeMedia(path.join(dir, 'v.mp4'), { seconds: 120, audio: { baseDb: -45 } });
    await fe.call('analysis:start', { path: video });
    for (const fn of fe.appEvents.get('before-quit')) fn(); // todos os handlers que se registraram para o fechamento
    const failed = await waitFor(() => fe.events('analysis:failed')[0], WAIT, 'analysis:failed');
    assert.equal(failed.code, 'CANCELLED');
  } finally { rmrf(dir); }
});

test('arquivo que não é vídeo: falha clara (PROBE_FAILED) sem derrubar nada', T, async () => {
  const { dir, fe } = setup();
  try {
    const bogus = path.join(dir, 'texto.mp4');
    fs.writeFileSync(bogus, 'isto não é um vídeo');
    await fe.call('analysis:start', { path: bogus });
    const failed = await waitFor(() => fe.events('analysis:failed')[0], WAIT, 'analysis:failed');
    assert.equal(failed.code, 'PROBE_FAILED');
    assert.match(failed.message, /Não foi possível ler o vídeo/);
    assert.deepEqual((await fe.call('analysis:status')).running, null);
  } finally { rmrf(dir); }
});

test('AnalysisManager: cancelar no meio encerra todos os ffmpeg; progresso limitado (throttle)', T, async () => {
  const dir = mkTmp('analysis-mgr');
  try {
    const video = makeMedia(path.join(dir, 'v.mp4'), { seconds: 40, audio: { baseDb: -45 } });
    const mgr = new AnalysisManager({ getTools: () => tools, cacheDir: path.join(dir, 'cache'), inputArgs: ['-re'] });
    const progress = [];
    const failed = [];
    mgr.on('progress', (e) => progress.push(e));
    mgr.on('failed', (e) => failed.push(e));
    const { jobId } = mgr.start({ path: video });
    await waitFor(() => progress.some((e) => e.stage === 'audio' || e.stage === 'image'), WAIT, 'andamento da extração');
    assert.ok(mgr.children.size >= 1, 'há ffmpeg rodando');
    const kids = [...mgr.children];
    assert.equal(mgr.cancel(jobId), true);
    await waitFor(() => failed.length === 1, WAIT, 'falha CANCELLED');
    assert.equal(failed[0].code, 'CANCELLED');
    await waitFor(() => mgr.children.size === 0, 60000, 'filhos encerrados');
    for (const child of kids) assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(mgr.status(), null);
    // o progresso não inunda o canal: no máximo ~5 eventos por segundo
    const times = progress.length;
    assert.ok(times <= 60, `${times} eventos de progresso`);
  } finally { rmrf(dir); }
});

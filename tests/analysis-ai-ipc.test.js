'use strict';

/**
 * Os canais `analysis:*` da IA e da transcrição, com o ctx de verdade (createContext) e um Electron falso: configuração do provedor,
 * aceite de privacidade, estimativa, importar legenda, gerar a transcrição (por pedaços, com rascunho e retomada), análise por IA com
 * os mesmos eventos do algoritmo, uma de cada vez, cancelamento e o provedor do hospedeiro (BDS).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createContext } = require('../src/ipc/context');
const { loadHandlers } = require('../src/ipc');
const { REASONS } = require('../src/core/subtitles/hallucinations');
const { newProject } = require('../src/core/projects/projectStore');
const F = require('./ai-fakes');

const silent = { log() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeElectron(userData) {
  const handlers = new Map();
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } };
  const dialog = { picked: null, showOpenDialog: async () => (dialog.picked ? { canceled: false, filePaths: [dialog.picked] } : { canceled: true, filePaths: [] }) };
  const deps = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: () => userData, getVersion: () => '9.9.9', on() {} },
    dialog, shell: {}, getWindow: () => win, logger: silent
  };
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  const events = (name) => sent.filter(([channel]) => channel === name).map(([, payload]) => payload);
  return { deps, handlers, sent, call, events, dialog };
}

async function waitFor(fn, ms = 15000, what = 'condição') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(15); }
  throw new Error(`Tempo esgotado esperando: ${what}`);
}

/** Vídeo "falso" (um arquivo de verdade, pequeno) + transcrição sintética. */
function setup(t, { aiOptions = {}, host, minutes = 40, moments } = {}) {
  const dir = F.tmpDir();
  t.after(() => F.cleanup(dir));
  const video = path.join(dir, 'live.mp4');
  fs.writeFileSync(video, Buffer.alloc(2048, 7));
  const fe = fakeElectron(path.join(dir, 'ud'));
  const ctx = createContext({ ...fe.deps, ...(host ? { host } : {}) });
  ctx.analysisAiOptions = { safeStorage: F.fakeSafeStorage(), restrict: () => {}, sleep: async () => {}, ...aiOptions };
  const res = loadHandlers(ctx);
  assert.deepEqual(res.failed, []);
  const tr = F.makeTranscript({ minutes, moments });
  const src = { projectId: 'proj1', path: video, size: 2048, duration: tr.duration };
  return { dir, video, fe, ctx, tr, src };
}

const srtOf = (cues) => cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');
const stamp = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')},${String(Math.round((s % 1) * 1000)).padStart(3, '0')}`;

test('todos os canais da IA e da transcrição carregam junto do handler de análise', (t) => {
  const s = setup(t);
  for (const c of ['aiState', 'aiSave', 'aiTest', 'aiAccept', 'aiEstimate', 'humorExamples', 'transcriptStatus', 'transcriptImport', 'transcriptGenerate', 'transcriptCancel', 'transcriptRemove', 'defaults', 'start', 'cancel', 'status']) {
    assert.ok(s.fe.handlers.has(`analysis:${c}`), c);
  }
});

test('configurar o provedor pelo IPC: a chave entra por aiSave e nunca volta; testar conexão; aceite', async (t) => {
  const mock = await F.startMockAi(() => ({ json: F.chatBody('ok') }));
  t.after(() => mock.close());
  const s = setup(t);
  const st0 = await s.fe.call('analysis:aiState');
  assert.equal(st0.ok, true);
  assert.equal(st0.ai.provider.ready, false);
  assert.equal(st0.ai.encryption, 'safeStorage');
  const saved = await s.fe.call('analysis:aiSave', { provider: 'custom', baseUrl: mock.base, model: 'fake-model', apiKey: F.KEY });
  assert.equal(saved.ok, true);
  assert.equal(saved.ai.provider.hasKey, true);
  assert.ok(!F.mentions(saved, F.KEY));
  assert.ok(!F.mentions(await s.fe.call('analysis:aiState'), F.KEY));
  const bad = await s.fe.call('analysis:aiSave', { apiKey: 'curta' });
  assert.equal(bad.ok, false);
  assert.ok(!F.mentions(bad, 'curta') || /formato/.test(bad.message));
  const test1 = await s.fe.call('analysis:aiTest');
  assert.equal(test1.ok, true);
  assert.match(test1.message, /Conexão ok/);
  assert.equal(mock.calls[0].headers.authorization, `Bearer ${F.KEY}`);
  const acc = await s.fe.call('analysis:aiAccept', { accepted: true });
  assert.equal(acc.ai.accepted, true);
  assert.equal((await s.fe.call('analysis:aiAccept', { accepted: false })).ai.accepted, false);
  for (const f of F.readAll(path.join(s.dir, 'ud'))) assert.ok(!f.text.includes(F.KEY), f.file);
  const fail = await s.fe.call('analysis:aiSave', { provider: 'nenhum' });
  assert.equal(fail.ok, false);
  assert.equal(fail.code, 'INVALID_ARGS');
});

test('importar legenda (.srt) pelo seletor e por caminho; status; remover; erros com código', async (t) => {
  const s = setup(t);
  const srt = path.join(s.dir, 'live.srt');
  fs.writeFileSync(srt, srtOf(s.tr.cues));
  // pelo seletor
  s.fe.dialog.picked = srt;
  const imp = await s.fe.call('analysis:transcriptImport', { projectId: 'proj1', path: s.video, size: 2048, duration: s.tr.duration });
  assert.equal(imp.ok, true);
  assert.equal(imp.canceled, false);
  assert.equal(imp.status.origin, 'imported');
  assert.equal(imp.status.importedFrom, 'live.srt');
  assert.equal(imp.status.stale, false);
  assert.ok(imp.status.coverage > 0.95);
  assert.ok(imp.status.laughs >= 1);
  const status = await s.fe.call('analysis:transcriptStatus', s.src);
  assert.equal(status.transcript.exists, true);
  assert.equal(status.running, null);
  assert.equal(status.engine.ready, false, 'sem o motor do Whisper neste teste');
  // vídeo diferente: a mesma transcrição aparece como "de outro arquivo"
  const other = await s.fe.call('analysis:transcriptStatus', { ...s.src, size: 5 });
  assert.equal(other.transcript.stale, true);
  // cancelar o seletor
  s.fe.dialog.picked = null;
  assert.deepEqual(await s.fe.call('analysis:transcriptImport', s.src), { ok: true, canceled: true });
  // por caminho, arquivos inválidos
  const bad = path.join(s.dir, 'ruim.srt');
  fs.writeFileSync(bad, 'nada de legenda aqui');
  const r1 = await s.fe.call('analysis:transcriptImport', { ...s.src, subtitlePath: bad });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'EMPTY');
  const txt = path.join(s.dir, 'x.txt');
  fs.writeFileSync(txt, 'x');
  assert.equal((await s.fe.call('analysis:transcriptImport', { ...s.src, subtitlePath: txt })).code, 'BAD_FORMAT');
  assert.equal((await s.fe.call('analysis:transcriptImport', { ...s.src, subtitlePath: path.join(s.dir, 'nao-existe.srt') })).code, 'INPUT_MISSING');
  assert.equal((await s.fe.call('analysis:transcriptImport', { ...s.src, subtitlePath: 'relativo.srt' })).code, 'INVALID_ARGS');
  assert.equal((await s.fe.call('analysis:transcriptImport', { path: s.video })).code, 'INVALID_ARGS');
  // a transcrição boa continua lá; remover
  assert.equal((await s.fe.call('analysis:transcriptStatus', s.src)).transcript.exists, true);
  assert.equal((await s.fe.call('analysis:transcriptRemove', { projectId: 'proj1' })).removed, true);
  assert.equal((await s.fe.call('analysis:transcriptStatus', s.src)).transcript.exists, false);
  assert.equal((await s.fe.call('analysis:transcriptRemove', {})).code, 'INVALID_ARGS');
});

// ---------- gerar a transcrição ----------

function fakeEngine(log) {
  const runs = [];
  return {
    runs,
    defaultModelId: 'large-v3-turbo',
    prepareRun: async ({ key, modelId }) => {
      if (runs.some((r) => !r.released)) throw Object.assign(new Error('Já existe uma legenda sendo gerada.'), { code: 'BUSY' });
      const run = { key, modelId, released: false, controller: new AbortController(), model: { label: 'Large v3 Turbo' }, genOptions: { fake: true } };
      runs.push(run);
      log.push(['prepare', key, modelId]);
      return run;
    },
    releaseRun: (run) => { run.released = true; log.push(['release', run.key]); },
    describeRun: () => ({ deviceLabel: 'placa de teste', deviceNote: null })
  };
}

/** `generate` falso no lugar do generateSubtitles: uma fala por pedaço, mais uma risada descartada como anotação. */
function fakeGenerate(calls, { delay = 0, failAt = null } = {}) {
  return async (o) => {
    calls.push({ start: o.start, end: o.end, language: o.language, maxChars: o.maxChars });
    if (o.onProgress) o.onProgress({ phase: 'transcribe', percent: 50, message: 'x' });
    if (delay) await sleep(delay);
    if (o.signal && o.signal.aborted) throw Object.assign(new Error('Cancelado.'), { code: 'CANCELLED' });
    if (failAt !== null && o.start >= failAt) throw Object.assign(new Error('O motor de transcrição falhou.'), { code: 'ENGINE_FAILED' });
    return {
      cues: [{ start: 1, end: 4, text: `fala do pedaço que começa em ${o.start}` }],
      discarded: [{ start: 6, end: 8, text: '*Risos*', reason: REASONS.annotation }, { start: 9, end: 10, text: '[Música]', reason: REASONS.annotation }],
      noSpeech: false, device: 'GPU', deviceName: 'GTX', fellBack: false, transcribeMs: 1000, audioSec: 50
    };
  };
}

test('gerar a transcrição: pedaços, progresso pelo tempo do vídeo, risadas preservadas, documento versionado, motor liberado', async (t) => {
  const log = [];
  const calls = [];
  const engine = fakeEngine(log);
  const s = setup(t, { aiOptions: { engine, generate: fakeGenerate(calls) }, minutes: 25 });
  const start = await s.fe.call('analysis:transcriptGenerate', { ...s.src, modelId: 'large-v3-turbo', language: 'pt' });
  assert.equal(start.ok, true);
  const done = await waitFor(() => s.fe.events('analysis:transcriptDone')[0], 15000, 'transcrição pronta');
  assert.equal(done.projectId, 'proj1');
  assert.equal(done.status.origin, 'generated');
  assert.equal(done.status.engine.modelId, 'large-v3-turbo');
  assert.equal(done.status.engine.device, 'GPU');
  assert.equal(done.status.laughs, 3, 'uma risada por pedaço (3 pedaços de 10 min)');
  assert.deepEqual(calls.map((c) => [c.start, c.end]), [[0, 600], [600, 1200], [1200, 1500]]);
  assert.ok(calls.every((c) => c.maxChars === 60 && c.language === 'pt'));
  // horários absolutos no vídeo
  const doc = JSON.parse(fs.readFileSync(path.join(s.dir, 'ud', 'transcripts', 'proj1.json'), 'utf8'));
  assert.equal(doc.format, 'bf-transcript-1');
  assert.equal(doc.version, 1);
  assert.ok(doc.cues.some((c) => c.start === 601 && /começa em 600/.test(c.text)));
  assert.ok(doc.cues.some((c) => c.laugh && c.start === 606));
  assert.ok(!doc.cues.some((c) => /Música/.test(c.text)), 'anotação que não é risada fica de fora');
  assert.equal(fs.existsSync(path.join(s.dir, 'ud', 'transcripts', 'proj1.partial.json')), false, 'rascunho some quando termina');
  // progresso crescente
  const progress = s.fe.events('analysis:transcriptProgress');
  assert.ok(progress.length >= 1);
  const ps = progress.map((p) => p.p);
  assert.deepEqual([...ps].sort((a, b) => a - b), ps);
  assert.equal(ps[ps.length - 1], 1);
  assert.deepEqual(log.filter((l) => l[0] !== 'prepare'), [['release', 'transcript:proj1']]);
  assert.equal((await s.fe.call('analysis:transcriptStatus', s.src)).transcript.cues, doc.cues.length);
});

test('transcrição: uma por vez, cancelamento guarda o rascunho e a próxima retoma de onde parou', async (t) => {
  const log = [];
  const calls = [];
  const engine = fakeEngine(log);
  const s = setup(t, { aiOptions: { engine, generate: fakeGenerate(calls, { delay: 120 }) }, minutes: 35 });
  const a = await s.fe.call('analysis:transcriptGenerate', s.src);
  assert.equal(a.ok, true);
  const busy = await s.fe.call('analysis:transcriptGenerate', s.src);
  assert.equal(busy.ok, false);
  assert.equal(busy.code, 'BUSY');
  const running = (await s.fe.call('analysis:transcriptStatus', s.src)).running;
  assert.equal(running.jobId, a.jobId);
  await waitFor(() => calls.length >= 2, 15000, 'segundo pedaço começou');
  assert.equal((await s.fe.call('analysis:transcriptCancel', { jobId: a.jobId })).cancelled, true);
  const failed = await waitFor(() => s.fe.events('analysis:transcriptFailed')[0], 15000, 'cancelamento');
  assert.equal(failed.code, 'CANCELLED');
  assert.equal(failed.resumable, true);
  assert.ok(failed.doneUntil >= 600 && failed.doneUntil < 2100, `doneUntil ${failed.doneUntil}`);
  const st = (await s.fe.call('analysis:transcriptStatus', s.src)).transcript;
  assert.equal(st.exists, false);
  assert.equal(st.draft.doneUntil, failed.doneUntil);
  // retoma: não repete os pedaços prontos
  const before = calls.length;
  const b = await s.fe.call('analysis:transcriptGenerate', s.src);
  assert.equal(b.ok, true);
  await waitFor(() => s.fe.events('analysis:transcriptDone')[0], 15000, 'retomada pronta');
  const resumed = calls.slice(before).map((c) => c.start);
  assert.equal(resumed[0], failed.doneUntil);
  assert.ok(!resumed.includes(0));
  const doc = JSON.parse(fs.readFileSync(path.join(s.dir, 'ud', 'transcripts', 'proj1.json'), 'utf8'));
  assert.ok(doc.cues.some((c) => /começa em 0/.test(c.text)), 'as falas do primeiro pedaço vieram do rascunho');
  assert.ok(engine.runs.every((r) => r.released), 'o motor sempre é liberado');
});

test('transcrição: erro do motor vira mensagem com código e mantém o que já foi feito; argumentos inválidos', async (t) => {
  const log = [];
  const calls = [];
  const s = setup(t, { aiOptions: { engine: fakeEngine(log), generate: fakeGenerate(calls, { failAt: 600 }) }, minutes: 25 });
  assert.equal((await s.fe.call('analysis:transcriptGenerate', { ...s.src, duration: 0 })).code, 'INVALID_ARGS');
  assert.equal((await s.fe.call('analysis:transcriptGenerate', { ...s.src, path: path.join(s.dir, 'nao.mp4') })).code, 'INPUT_MISSING');
  assert.equal((await s.fe.call('analysis:transcriptGenerate', { ...s.src, projectId: '' })).code, 'INVALID_ARGS');
  await s.fe.call('analysis:transcriptGenerate', s.src);
  const failed = await waitFor(() => s.fe.events('analysis:transcriptFailed')[0], 15000, 'falha');
  assert.equal(failed.code, 'ENGINE_FAILED');
  assert.equal(failed.resumable, true);
  assert.equal(failed.doneUntil, 600);
});

test('sem o serviço do motor de legendas a transcrição diz o motivo em vez de quebrar', async (t) => {
  const s = setup(t);
  const r = await s.fe.call('analysis:transcriptGenerate', s.src);
  assert.equal(r.ok, true);
  const failed = await waitFor(() => s.fe.events('analysis:transcriptFailed')[0], 5000, 'falha');
  assert.ok(['NO_ENGINE', 'NO_MODEL', 'NO_FFMPEG'].includes(failed.code), failed.code);
});

// ---------- análise por IA pelo IPC ----------

async function configure(s, mock, { accept = true } = {}) {
  assert.equal((await s.fe.call('analysis:aiSave', { provider: 'custom', baseUrl: mock.base, model: 'fake-model', apiKey: F.KEY })).ok, true);
  if (accept) assert.equal((await s.fe.call('analysis:aiAccept', { accepted: true })).ok, true);
  const srt = path.join(s.dir, 'live.srt');
  fs.writeFileSync(srt, srtOf(s.tr.cues));
  assert.equal((await s.fe.call('analysis:transcriptImport', { ...s.src, subtitlePath: srt })).ok, true);
}

const startAi = (s, extra = {}) => s.fe.call('analysis:start', {
  engine: 'ai', ...s.src, params: { minDurationSec: 15, maxDurationSec: 60, padBeforeSec: 2, padAfterSec: 1, minRelevance: 0.4, perHour: 20 }, meta: { title: 'Teste' }, existingCuts: [], ...extra
});

test('analysis:start engine ai: mesmos eventos do algoritmo, estimativa antes, uma análise por vez e cancelamento', async (t) => {
  const s = setup(t, { moments: [{ at: 300, punch: 'o bicho nem dropou couro' }] });
  const m = s.tr.moments[0];
  let gate = null;
  const mock = await F.startMockAi(async (call) => {
    if (call.body.messages[call.body.messages.length - 1].content.includes('=== CANDIDATOS ===')) return { json: F.chatBody('{"picks":[]}') };
    if (gate) await gate;
    return { json: F.chatBody(F.cutsJson([{ start: m.start, end: m.end, punchline: m.punch, title: 'Do bicho' }])) };
  });
  t.after(() => mock.close());
  await configure(s, mock);
  const est = await s.fe.call('analysis:aiEstimate', s.src);
  assert.equal(est.ok, true);
  assert.equal(est.estimate.calls, 3, 'dois blocos de 35 min e a escolha final');
  assert.match(est.estimate.label, /^~3 chamadas, ~\d+ mil tokens$/);
  assert.equal(est.estimate.exceedsLimit, false);
  assert.equal(mock.calls.length, 0, 'estimar não envia nada');

  // uma por vez, e o algoritmo também respeita
  let release;
  gate = new Promise((r) => { release = r; });
  const a = await startAi(s);
  assert.equal(a.ok, true);
  assert.equal((await startAi(s)).code, 'BUSY');
  assert.equal((await s.fe.call('analysis:start', { path: s.video })).code, 'BUSY');
  const status = await s.fe.call('analysis:status');
  assert.equal(status.running.engine, 'ai');
  assert.equal(status.running.jobId, a.jobId);
  release();
  const done = await waitFor(() => s.fe.events('analysis:done')[0], 15000, 'análise por IA pronta');
  assert.equal(done.jobId, a.jobId);
  assert.equal(done.result.engine, 'ai');
  assert.equal(done.result.suggestions.length, 1);
  assert.equal(done.result.suggestions[0].title, 'Do bicho');
  assert.ok(s.fe.events('analysis:progress').length >= 1);
  assert.deepEqual((await s.fe.call('analysis:status')).running, null);

  // cancelar uma análise por IA
  s.fe.sent.length = 0;
  gate = new Promise(() => {});
  const b = await startAi(s);
  await waitFor(() => mock.calls.length >= 3, 5000, 'chamada em andamento');
  assert.equal((await s.fe.call('analysis:cancel', { jobId: b.jobId })).cancelled, true);
  const failed = await waitFor(() => s.fe.events('analysis:failed')[0], 5000, 'cancelamento');
  assert.equal(failed.code, 'CANCELLED');
  assert.equal(failed.engine, 'ai');
  assert.equal((await s.fe.call('analysis:cancel', {})).cancelled, false);
});

test('analysis:start engine ai: sem aceite nada é enviado; sem transcrição, sem provedor e transcrição de outro vídeo dão erro com código', async (t) => {
  const s = setup(t);
  const mock = await F.startMockAi(() => ({ json: F.chatBody('{"cuts":[]}') }));
  t.after(() => mock.close());
  const none = await startAi(s);
  assert.equal(none.code, 'NOT_CONFIGURED', 'nenhum provedor escolhido (o usuário escolhe; nada vem pré-selecionado)');
  assert.match(none.message, /Escolha o provedor/);
  // sem provedor escolhido também não dá para configurar chave/modelo nem aceitar o aviso
  const orphan = await s.fe.call('analysis:aiSave', { apiKey: F.KEY });
  assert.equal(orphan.ok, false);
  assert.equal(orphan.code, 'INVALID_ARGS');
  assert.ok(!F.mentions(orphan, F.KEY), 'o erro não repete a chave');
  const orphanAccept = await s.fe.call('analysis:aiAccept', { accepted: true });
  assert.equal(orphanAccept.ok, false);
  assert.equal(orphanAccept.code, 'NOT_CONFIGURED');
  assert.equal((await s.fe.call('analysis:aiState')).ai.selected, null);
  // escolhido o provedor e o modelo, falta a chave
  await s.fe.call('analysis:aiSave', { provider: 'groq' });
  assert.equal((await startAi(s)).code, 'NOT_CONFIGURED', 'sem modelo');
  await s.fe.call('analysis:aiSave', { model: 'llama-x' });
  assert.equal((await startAi(s)).code, 'NO_KEY', 'sem chave');
  assert.equal(mock.calls.length, 0);
  await configure(s, mock, { accept: false });
  const noConsent = await startAi(s);
  assert.equal(noConsent.ok, false);
  assert.equal(noConsent.code, 'CONSENT_REQUIRED');
  assert.equal(mock.calls.length, 0);
  await s.fe.call('analysis:aiAccept', { accepted: true });
  assert.equal((await startAi(s, { projectId: 'sem-transcricao' })).code, 'NO_TRANSCRIPT');
  assert.equal((await startAi(s, { size: 1 })).code, 'NO_TRANSCRIPT');
  assert.equal((await startAi(s, { duration: 0 })).code, 'INVALID_ARGS');
  assert.equal(mock.calls.length, 0);
});

test('provedor do hospedeiro: o ctx.host.ai entrega a requisição; o Braga Frame não guarda chave nenhuma', async (t) => {
  const requests = [];
  const host = {
    embedded: true, name: 'BDS', tool: () => null, whisperModels: null,
    ai: {
      describe: () => ({ id: 'groq', label: 'Groq', model: 'llama', hasKey: true, ready: true, serverHost: 'api.groq.com' }),
      chat: async (params) => {
        requests.push(params);
        if (params.messages[0].content.includes('=== CANDIDATOS ===')) return { text: '{"picks":[]}', usage: { prompt_tokens: 10, completion_tokens: 5 } };
        const m = F.makeTranscript({ minutes: 20, moments: [{ at: 300, punch: 'o bicho nem dropou couro' }] }).moments[0];
        return { text: F.cutsJson([{ start: m.start, end: m.end, punchline: m.punch }]), usage: { prompt_tokens: 100, completion_tokens: 30 } };
      }
    }
  };
  const s = setup(t, { host, minutes: 20, moments: [{ at: 300, punch: 'o bicho nem dropou couro' }] });
  const st = (await s.fe.call('analysis:aiState')).ai;
  assert.equal(st.source, 'host');
  assert.equal(st.readOnly, true);
  assert.equal(st.provider.label, 'Groq');
  assert.equal((await s.fe.call('analysis:aiSave', { provider: 'gemini' })).ok, false);
  const srt = path.join(s.dir, 'live.srt');
  fs.writeFileSync(srt, srtOf(s.tr.cues));
  await s.fe.call('analysis:transcriptImport', { ...s.src, subtitlePath: srt });
  assert.equal((await startAi(s)).code, 'CONSENT_REQUIRED');
  assert.equal(requests.length, 0);
  await s.fe.call('analysis:aiAccept', { accepted: true });
  assert.equal((await startAi(s)).ok, true);
  const done = await waitFor(() => s.fe.events('analysis:done')[0], 15000, 'análise');
  assert.equal(done.result.suggestions.length, 1);
  assert.equal(done.result.ai.provider, 'Groq');
  assert.ok(requests.length >= 1 && requests.every((r) => r.jsonMode === true));
  assert.ok(!fs.existsSync(path.join(s.dir, 'ud', 'ai', 'secrets.json')));
});

test('perfil de humor do canal pelo IPC: os exemplos que iriam são mostrados sem enviar nada, a estimativa os inclui e o analysis:start leva o perfil à IA', async (t) => {
  const s = setup(t, { minutes: 20, moments: [{ at: 300, punch: 'o bicho nem dropou couro' }] });
  const m = s.tr.moments[0];
  const mock = await F.startMockAi((call) => {
    const text = call.body.messages[call.body.messages.length - 1].content;
    if (text.includes('=== CANDIDATOS ===')) return { json: F.chatBody('{"picks":[]}') };
    return { json: F.chatBody(F.cutsJson([{ start: m.start, end: m.end, punchline: m.punch, title: 'Do bicho' }])) };
  });
  t.after(() => mock.close());
  await configure(s, mock);
  // projeto atual (do canal) + dois projetos antigos com cortes decididos e transcrição importada
  const mk = (name, channel, cuts) => {
    const video = path.join(s.dir, name + '.mp4');
    fs.writeFileSync(video, Buffer.alloc(2048, 3));
    const p = newProject(video, { size: 2048, duration: 600 });
    p.meta.channel = channel;
    p.cuts = cuts.map((c, i) => ({ id: name + '-c' + i, title: c.title, start: c.start, end: c.start + 30, status: c.status, exports: [] }));
    const saved = s.ctx.projectStore.save(p);
    return { id: saved.id, video, cues: cuts.map((c) => ({ start: c.start + 1, end: c.start + 29, text: c.text })) };
  };
  const current = mk('atual', 'Canal Braga', []);
  const old1 = mk('antiga1', 'canal braga', [
    { title: 'Susto no corredor', status: 'approved', start: 10, text: 'eu abri a porta e tinha um bicho gigante parado ali olhando pra mim cara' },
    { title: 'Papo de servidor', status: 'rejected', start: 60, text: 'depois eu vejo a configuração do servidor com calma e a gente testa de novo' }
  ]);
  const other = mk('outro', 'Outro Canal', [{ title: 'Do outro canal', status: 'approved', start: 10, text: 'isto é de outro canal e não pode aparecer como exemplo de jeito nenhum aqui' }]);
  for (const p of [current, old1, other]) {
    const srt = path.join(s.dir, p.id + '.srt');
    fs.writeFileSync(srt, srtOf(p.cues.length ? p.cues : [{ start: 1, end: 5, text: 'oi' }]));
    assert.equal((await s.fe.call('analysis:transcriptImport', { projectId: p.id, path: p.video, size: 2048, duration: 600, subtitlePath: srt })).ok, true);
  }
  const live = { ...s.src, projectId: current.id };
  const srt = path.join(s.dir, 'live.srt');
  assert.equal((await s.fe.call('analysis:transcriptImport', { ...live, subtitlePath: srt })).ok, true);

  const shown = await s.fe.call('analysis:humorExamples', { projectId: current.id });
  assert.equal(shown.ok, true);
  assert.deepEqual(shown.examples.approved.map((e) => e.title), ['Susto no corredor'], 'só o mesmo canal (sem diferenciar caixa)');
  assert.deepEqual(shown.examples.rejected.map((e) => e.title), ['Papo de servidor']);
  assert.ok(shown.examples.approved[0].text.includes('bicho gigante'));
  assert.deepEqual((await s.fe.call('analysis:humorExamples', {})).examples.approved.length, 2, 'sem projeto, qualquer canal');
  assert.equal((await s.fe.call('analysis:humorExamples')).ok, true);
  assert.equal(mock.calls.length, 0, 'mostrar os exemplos não envia nada');

  const profile = { criteria: 'Humor seco e inesperado.', catchphrases: ['bora'], reactions: ['eita'], examples: true };
  const plain = await s.fe.call('analysis:aiEstimate', live);
  const withProfile = await s.fe.call('analysis:aiEstimate', { ...live, profile });
  assert.ok(withProfile.estimate.inputTokens > plain.estimate.inputTokens);
  assert.equal(mock.calls.length, 0, 'estimar não envia nada');

  const started = await startAi(s, { projectId: current.id, profile });
  assert.equal(started.ok, true);
  const done = await waitFor(() => s.fe.events('analysis:done')[0], 15000, 'análise com o perfil');
  assert.deepEqual(done.result.ai.profile, { criteria: true, catchphrases: 1, reactions: 1, themes: 0, examples: { approved: 1, rejected: 1 } });
  const first = mock.calls[0].body.messages[mock.calls[0].body.messages.length - 1].content;
  assert.ok(first.includes('Humor seco e inesperado.') && first.includes('Susto no corredor') && first.includes('Papo de servidor'));
  assert.ok(!first.includes('Do outro canal'), 'exemplo de outro canal nunca vai');
  assert.ok(!F.mentions(mock.calls.map((c) => c.body), F.KEY));
});

test('analysis:start engine both (Algoritmo + IA): confere a IA antes de tudo; só os eventos do combo chegam à tela; algoritmo que falha deixa a IA sozinha', async (t) => {
  const s = setup(t, { moments: [{ at: 300, punch: 'o bicho nem dropou couro' }] });
  const m = s.tr.moments[0];
  const mock = await F.startMockAi(async (call) => {
    if (call.body.messages[call.body.messages.length - 1].content.includes('=== CANDIDATOS ===')) return { json: F.chatBody('{"picks":[]}') };
    return { json: F.chatBody(F.cutsJson([{ start: m.start, end: m.end, punchline: m.punch, title: 'Do bicho' }])) };
  });
  t.after(() => mock.close());
  await configure(s, mock, { accept: false });
  // ffmpeg "instalado" mas que não roda: o algoritmo começa e falha ao ler o vídeo (sem depender do ffmpeg da máquina)
  s.ctx.tools = { ...(s.ctx.tools || {}), ffmpeg: path.join(s.dir, 'sem-ffmpeg.exe'), ffprobe: path.join(s.dir, 'sem-ffprobe.exe') };
  const both = (extra = {}) => s.fe.call('analysis:start', {
    engine: 'both', ...s.src, params: { minDurationSec: 15, maxDurationSec: 60, padBeforeSec: 2, padAfterSec: 1, minRelevance: 0.4, perHour: 20 }, meta: { title: 'Teste' }, existingCuts: [], ...extra
  });
  const refused = await both();
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'CONSENT_REQUIRED', 'sem o aceite, falha antes de rodar o algoritmo');
  assert.equal((await s.fe.call('analysis:status')).running, null);
  assert.equal((await s.fe.call('analysis:aiAccept', { accepted: true })).ok, true);
  const started = await both();
  assert.equal(started.ok, true);
  assert.match(started.jobId, /^c/);
  const status = await s.fe.call('analysis:status');
  assert.equal(status.running.engine, 'both');
  assert.equal(status.running.jobId, started.jobId);
  assert.equal((await startAi(s)).code, 'BUSY');
  const done = await waitFor(() => s.fe.events('analysis:done')[0] || s.fe.events('analysis:failed')[0], 30000, 'fim do combo');
  assert.equal(done.jobId, started.jobId);
  assert.ok(done.result, `terminou sem resultado: ${done.message}`);
  for (const name of ['analysis:progress', 'analysis:done', 'analysis:failed']) {
    for (const ev of s.fe.events(name)) assert.equal(ev.jobId, started.jobId, `${name} de um trabalho interno chegou à tela`);
  }
  assert.ok(s.fe.events('analysis:progress').some((ev) => /^IA: /.test(ev.message)));
  const r = done.result;
  assert.equal(r.engine, 'both');
  assert.equal(r.merge.algorithmFailed, true);
  assert.equal(r.warnings[0].code, 'ALGORITHM_FAILED');
  assert.deepEqual(r.suggestions.map((x) => x.engines), [['ai']]);
  assert.equal(r.suggestions[0].title, 'Do bicho');
  assert.equal((await s.fe.call('analysis:status')).running, null);
});

test('guia de cortes pelo IPC: o padrão, guardar o do usuário (vai na mensagem de sistema e pesa na estimativa), texto recusado e restaurar', async (t) => {
  const s = setup(t, { moments: [{ at: 300, punch: 'o bicho nem dropou couro' }] });
  const mock = await F.startMockAi(async () => ({ json: F.chatBody('{"cuts":[]}') }));
  t.after(() => mock.close());
  await configure(s, mock);
  const first = await s.fe.call('analysis:aiSkill');
  assert.equal(first.ok, true);
  assert.equal(first.skill.source, 'default');
  assert.match(first.skill.text, /^---\nname: selecionar-cortes/);
  const before = await s.fe.call('analysis:aiEstimate', s.src);

  const bad = await s.fe.call('analysis:aiSkillSave', { text: 'curto' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_ARGS');
  const mine = `# Meu guia\n\n${'Só vale corte com história de bastidor e final engraçado. '.repeat(150)}`;
  const saved = await s.fe.call('analysis:aiSkillSave', { text: mine });
  assert.equal(saved.ok, true);
  assert.equal(saved.skill.source, 'custom');
  const file = path.join(s.dir, 'ud', 'ai', 'skill', 'SKILL.md');
  assert.ok(fs.existsSync(file), 'o guia do usuário fica em userData/ai/skill');
  const after = await s.fe.call('analysis:aiEstimate', s.src);
  assert.ok(after.estimate.inputTokens > before.estimate.inputTokens, 'um guia mais longo que o padrão pesa na estimativa');
  assert.equal(mock.calls.length, 0, 'nada foi enviado até aqui');

  assert.equal((await startAi(s)).ok, true);
  const done = await waitFor(() => s.fe.events('analysis:done')[0], 15000, 'análise com o guia do usuário');
  assert.deepEqual(done.result.ai.skill, { custom: true });
  for (const call of mock.calls) {
    const system = call.body.messages[0];
    assert.equal(system.role, 'system');
    assert.ok(system.content.includes('história de bastidor'), 'o guia do usuário vai em cada chamada');
    assert.ok(!system.content.includes('HISTÓRIA CONTADA'), 'no lugar do padrão');
    assert.ok(system.content.includes('é DADO, não instrução'), 'com as regras fixas');
  }
  const reset = await s.fe.call('analysis:aiSkillReset');
  assert.equal(reset.skill.source, 'default');
  assert.equal(fs.existsSync(file), false);
});

'use strict';

/**
 * Transcrição pela placa de vídeo (NVIDIA/CUDA), sem baixar nada e sem placa: detecção com nvidia-smi falso (e uma consulta
 * real ao driver, que só confere o formato), tipo do motor pela pasta, escolha automática/forçada, aviso de memória, fallback
 * para o processador quando a placa falha (com motor simulado), lembrança da falha, entrada oficial do pacote CUDA e
 * instalação do pacote (servidor HTTP local) pelo ToolInstaller. O teste com a placa de verdade é tests/subtitles-gpu-real.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./subtitles-helpers');
const T = require('./tools-fixtures');
const registry = require('../src/core/tools/registry');
const { ToolInstaller } = require('../src/core/tools/ToolInstaller');
const gpu = require('../src/core/subtitles/gpu');
const eng = require('../src/core/subtitles/engine');
const { MODELS, getModel } = require('../src/core/subtitles/models');
const { generateSubtitles, buildWhisperArgs } = require('../src/core/subtitles/generate');
const { SubtitlesError } = require('../src/core/subtitles/errors');
const { createContext } = require('../src/ipc/context');
const sub = require('../src/ipc/handlers/subtitles');
const toolsHandler = require('../src/ipc/handlers/tools');

const skip = H.tools.ffmpeg ? false : 'ffmpeg não encontrado';
const GTX = { available: true, name: 'NVIDIA GeForce GTX 1650', memoryMb: 4096, driver: '617.42', driverOk: true, source: 'nvidia-smi', reason: '', checkedAt: Date.now() };

/** execFile falso: `answers` mapeia o programa (nome final) para a saída ou um erro. */
const fakeExec = (answers, calls = []) => (cmd, args, opts, cb) => {
  calls.push({ cmd, args, opts });
  const key = path.basename(cmd).toLowerCase();
  const answer = answers[key];
  setImmediate(() => (answer instanceof Error ? cb(answer) : (answer === undefined ? cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) : cb(null, answer))));
};

// ---------- detecção da placa ----------

test('nvidia-smi: a saída vira nome, memória e driver (várias placas, linhas estranhas e vazio)', () => {
  assert.deepEqual(gpu.parseNvidiaSmi('NVIDIA GeForce GTX 1650, 4096, 617.42\n'), [{ name: 'NVIDIA GeForce GTX 1650', memoryMb: 4096, driver: '617.42' }]);
  assert.equal(gpu.parseNvidiaSmi('NVIDIA A, 8192, 551.61\r\nNVIDIA B, 24576, 551.61\r\n').length, 2);
  assert.deepEqual(gpu.parseNvidiaSmi(''), []);
  assert.deepEqual(gpu.parseNvidiaSmi('NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver.'), []);
  assert.deepEqual(gpu.parseNvidiaSmi('Nome, abc, 1.2'), [], 'memória que não é número é ignorada');
  assert.equal(gpu.describeGpu({ name: 'NVIDIA GeForce GTX 1650', memoryMb: 4096 }), 'NVIDIA GeForce GTX 1650 · 4 GB');
  assert.equal(gpu.describeGpu({ name: 'NVIDIA RTX 4090', memoryMb: 24576 }), 'NVIDIA RTX 4090 · 24 GB');
  assert.equal(gpu.describeGpu({ name: 'NVIDIA GTX 1050', memoryMb: 2048 }), 'NVIDIA GTX 1050 · 2 GB');
  assert.equal(gpu.describeGpu({ name: 'NVIDIA GTX 1060', memoryMb: 6144 }), 'NVIDIA GTX 1060 · 6 GB');
  assert.equal(gpu.describeGpu(null), '');
});

test('detecção com nvidia-smi falso: placa boa, driver antigo, várias placas, sem driver e prazo curto', async () => {
  const calls = [];
  const ok = await gpu.queryNvidia({ platform: 'win32', exists: () => true, execFile: fakeExec({ 'nvidia-smi.exe': 'NVIDIA GeForce GTX 1650, 4096, 617.42\n' }, calls) });
  assert.deepEqual([ok.available, ok.name, ok.memoryMb, ok.driver, ok.source], [true, 'NVIDIA GeForce GTX 1650', 4096, '617.42', 'nvidia-smi']);
  assert.deepEqual(calls[0].args, gpu.QUERY);
  assert.ok(calls[0].opts.timeout > 0 && calls[0].opts.timeout <= 5000, 'prazo curto');
  assert.equal(calls[0].opts.windowsHide, true);

  const old = await gpu.queryNvidia({ platform: 'win32', exists: () => true, execFile: fakeExec({ 'nvidia-smi.exe': 'NVIDIA GeForce GTX 750, 2048, 391.35\n' }) });
  assert.equal(old.available, false);
  assert.equal(old.driverOk, false);
  assert.match(old.reason, /driver.*antigo/i);

  const two = await gpu.queryNvidia({ platform: 'win32', exists: () => true, execFile: fakeExec({ 'nvidia-smi.exe': 'NVIDIA Pequena, 2048, 551.61\nNVIDIA Grande, 12288, 551.61\n' }) });
  assert.equal(two.name, 'NVIDIA Grande', 'várias placas: a de mais memória');

  // sem nvidia-smi, mas o sistema lista uma placa NVIDIA: existe, só não dá para usar sem driver
  const noDriver = await gpu.queryNvidia({ platform: 'win32', exists: () => false, execFile: fakeExec({ 'powershell.exe': 'NVIDIA GeForce GTX 1650\r\n' }) });
  assert.equal(noDriver.available, false);
  assert.equal(noDriver.name, 'NVIDIA GeForce GTX 1650');
  assert.equal(noDriver.source, 'system');
  assert.match(noDriver.reason, /driver/);

  // sem placa nenhuma
  const none = await gpu.queryNvidia({ platform: 'win32', exists: () => false, execFile: fakeExec({}) });
  assert.deepEqual([none.available, none.name], [false, null]);
  assert.match(none.reason, /processador/);
  const linux = await gpu.queryNvidia({ platform: 'linux', execFile: fakeExec({ 'nvidia-smi': 'NVIDIA RTX 3060, 12288, 550.54\n' }) });
  assert.equal(linux.available, true);

  // driver que não responde / erro: nunca lança
  const broken = await gpu.queryNvidia({ platform: 'win32', exists: () => true, execFile: fakeExec({ 'nvidia-smi.exe': new Error('timeout') }) });
  assert.equal(broken.available, false);
  const throwing = await gpu.queryNvidia({ platform: 'linux', execFile: () => { throw new Error('spawn UNKNOWN'); } });
  assert.equal(throwing.available, false);
});

test('detectNvidia guarda em cache (uma consulta só) e refresh consulta de novo', async () => {
  gpu.resetGpuCache();
  const calls = [];
  const opts = { platform: 'linux', execFile: fakeExec({ 'nvidia-smi': 'NVIDIA RTX 3060, 12288, 550.54\n' }, calls) };
  const [a, b] = await Promise.all([gpu.detectNvidia(opts), gpu.detectNvidia(opts)]);
  assert.equal(a, b, 'consultas ao mesmo tempo dividem o resultado');
  await gpu.detectNvidia(opts);
  assert.equal(calls.length, 1, 'cache');
  await gpu.detectNvidia({ ...opts, refresh: true });
  assert.equal(calls.length, 2);
  gpu.resetGpuCache();
});

test('detecção REAL: consulta o driver deste computador sem travar (sem placa NVIDIA: "indisponível" com motivo)', async () => {
  gpu.resetGpuCache();
  const t0 = Date.now();
  const r = await gpu.detectNvidia({ refresh: true });
  assert.ok(Date.now() - t0 < 15000, 'respondeu dentro do prazo');
  assert.equal(typeof r.available, 'boolean');
  if (r.available) {
    assert.match(r.name, /NVIDIA/i);
    assert.ok(r.memoryMb >= 512, `memória ${r.memoryMb}`);
    assert.match(r.driver, /^\d+\.\d+/);
    assert.equal(r.source, 'nvidia-smi');
  } else {
    assert.ok(r.reason.length > 10);
  }
  gpu.resetGpuCache();
});

// ---------- tipo do motor, escolha, memória ----------

test('engineKindOf: motor com ggml-cuda na pasta é CUDA; senão é CPU (também para o motor do hospedeiro)', () => {
  const dir = H.tmpDir('bf-kind-');
  try {
    const cpu = path.join(dir, 'cpu'); const cuda = path.join(dir, 'cuda');
    fs.mkdirSync(cpu); fs.mkdirSync(cuda);
    for (const d of [cpu, cuda]) fs.writeFileSync(path.join(d, 'whisper-cli.exe'), 'x');
    fs.writeFileSync(path.join(cuda, 'ggml-cuda.dll'), 'x');
    assert.equal(eng.engineKindOf(path.join(cpu, 'whisper-cli.exe')), 'cpu');
    assert.equal(eng.engineKindOf(path.join(cuda, 'whisper-cli.exe')), 'cuda');
    assert.equal(eng.engineKindOf(null), 'cpu');
    assert.equal(eng.engineKindOf('/x/whisper-cli', { exists: (p) => p.endsWith('libggml-cuda.so') }), 'cuda');
  } finally { H.cleanup(dir); }
});

test('aviso de memória: GTX 1650 (4 GB) comporta o Large v3 Turbo q5; um modelo completo grande não', () => {
  const g = { memoryMb: 4096 };
  for (const m of MODELS) assert.equal(eng.gpuMemoryAdvice(m, g).level, 'ok', `${m.id} cabe em 4 GB`);
  const big = { id: 'large-v3', label: 'Large v3', sizeBytes: 3094623691 }; // ggml-large-v3.bin (f16), ~3,1 GB
  const advice = eng.gpuMemoryAdvice(big, g);
  assert.equal(advice.level, 'no');
  assert.match(advice.message, /provavelmente não cabe/);
  assert.match(advice.message, /Large v3 Turbo/);
  const tight = eng.gpuMemoryAdvice({ id: 'x', label: 'Médio f16', sizeBytes: 1.6 * 1024 ** 3 }, { memoryMb: 3072 });
  assert.equal(tight.level, 'tight');
  assert.equal(eng.gpuMemoryAdvice(big, { memoryMb: 12288 }).level, 'ok');
  assert.equal(eng.gpuMemoryAdvice(big, null).level, 'unknown');
});

test('planDevice: automático usa a placa só com NVIDIA + motor CUDA; GPU/CPU forçados; falha lembrada; sem memória', () => {
  const cuda = { engineKind: 'cuda', gpu: GTX };
  assert.deepEqual(eng.planDevice({ mode: 'auto', ...cuda }), { useGpu: true, why: null, note: null });
  assert.deepEqual(eng.planDevice({ ...cuda }).useGpu, true, 'padrão é automático');
  assert.equal(eng.planDevice({ mode: 'auto', engineKind: 'cpu', gpu: GTX }).why, 'no-cuda-engine');
  assert.equal(eng.planDevice({ mode: 'auto', engineKind: 'cuda', gpu: { ...GTX, available: false } }).why, 'no-gpu');
  assert.equal(eng.planDevice({ mode: 'auto', engineKind: 'cuda', gpu: null }).why, 'no-gpu');
  assert.equal(eng.planDevice({ mode: 'cpu', ...cuda }).useGpu, false);
  assert.equal(eng.planDevice({ mode: 'cpu', ...cuda }).why, 'forced-cpu');
  // GPU forçada: tenta mesmo sem detecção; sem motor CUDA, cai no processador e explica
  assert.equal(eng.planDevice({ mode: 'gpu', engineKind: 'cuda', gpu: null }).useGpu, true);
  const noEngine = eng.planDevice({ mode: 'gpu', engineKind: 'cpu', gpu: GTX });
  assert.deepEqual([noEngine.useGpu, noEngine.why], [false, 'no-cuda-engine']);
  assert.match(noEngine.note, /não está instalado/);
  // falha lembrada: automático não insiste; forçado tenta de novo
  const failed = eng.planDevice({ mode: 'auto', ...cuda, failure: { reason: 'out of memory' } });
  assert.deepEqual([failed.useGpu, failed.why], [false, 'remembered-failure']);
  assert.match(failed.note, /falhou antes \(out of memory\)/);
  assert.equal(eng.planDevice({ mode: 'gpu', ...cuda, failure: { reason: 'x' } }).useGpu, true);
  // modelo que não cabe: automático vai direto ao processador, com o aviso
  const noMem = eng.planDevice({ mode: 'auto', ...cuda, advice: { level: 'no', message: 'O modelo X precisa de 4 GB.' } });
  assert.deepEqual([noMem.useGpu, noMem.why], [false, 'no-memory']);
  assert.match(noMem.note, /Usando o processador/);
  assert.equal(eng.planDevice({ mode: 'auto', ...cuda, advice: { level: 'tight', message: '…' } }).useGpu, true, 'por pouco: tenta a placa');
  assert.equal(eng.normalizeMode('qualquer'), 'auto');
});

test('GpuFailureMemory: por motor + modelo, limpa e informa a última', () => {
  const m = new eng.GpuFailureMemory();
  assert.equal(m.get('C:/a/whisper-cli.exe', 'tiny'), null);
  m.set('C:/A/whisper-cli.exe', 'tiny', 'CUDA error');
  assert.equal(m.get('c:/a/whisper-cli.exe', 'tiny').reason, 'CUDA error', 'maiúsculas do caminho não importam');
  assert.equal(m.get('C:/A/whisper-cli.exe', 'small'), null, 'outro modelo não é afetado');
  assert.equal(m.last().reason, 'CUDA error');
  m.clear('C:/A/whisper-cli.exe', 'tiny');
  assert.equal(m.last(), null);
});

test('log do whisper-cli: reconhece placa usada, nome da placa e erro do CUDA', () => {
  const ok = eng.createLogWatcher();
  for (const l of ['ggml_cuda_init: found 1 CUDA devices:', '  Device 0: NVIDIA GeForce GTX 1650, compute capability 7.5, VMM: yes', 'whisper_backend_init_gpu: using CUDA0 backend']) ok.feed(l);
  assert.deepEqual([ok.state.sawGpu, ok.state.device, ok.state.cudaError], [true, 'NVIDIA GeForce GTX 1650', false]);
  const cpu = eng.createLogWatcher();
  cpu.feed('whisper_backend_init_gpu: using CPU backend');
  assert.equal(cpu.state.sawGpu, false);
  for (const line of ['CUDA error: out of memory', 'ggml_cuda_init: failed to initialize CUDA', 'whisper_init_state: failed to allocate memory', 'cudaMalloc failed: out of memory']) {
    const w = eng.createLogWatcher(); w.feed(line);
    assert.equal(w.state.cudaError, true, line);
  }
});

test('argumentos do whisper-cli: -ng só quando o motor CUDA roda no processador', () => {
  const base = { model: 'm.bin', audio: 'a.wav', language: 'pt', dtw: 'tiny', threads: 4 };
  assert.ok(!buildWhisperArgs(base).includes('-ng'));
  assert.ok(buildWhisperArgs({ ...base, noGpu: true }).includes('-ng'));
  assert.ok(buildWhisperArgs({ ...base, noGpu: true }).includes('-nfa'), 'DTW continua (flash attention desligada)');
});

// ---------- geração: placa, processador e fallback (motor simulado) ----------

const stub = (calls, { failOnGpu = false, device = undefined } = {}) => async (o) => {
  calls.push({ useGpu: o.useGpu, noGpu: o.noGpu, whisper: o.whisper });
  if (o.useGpu && failOnGpu) throw new SubtitlesError('GPU_FAILED', 'A placa de vídeo falhou na transcrição.', { detail: 'CUDA error: out of memory', cudaError: true });
  const words = [{ word: 'olá', start: 0.1, end: 0.5, p: 0.95, seg: 0 }, { word: 'mundo', start: 0.5, end: 1, p: 0.95, seg: 0 }];
  return { language: 'pt', segments: [{ start: 0.1, end: 1, text: 'olá mundo', p: 0.95 }], words, hasTokens: true, ...(device ? { device } : {}) };
};

async function withTone(fn) {
  const dir = H.tmpDir('bf-gpu-unit-');
  try {
    const video = H.makeVideo(path.join(dir, 'tom.mp4'), [{ tone: 3 }]);
    await fn({ dir, video, base: { ffmpeg: H.tools.ffmpeg, whisper: process.execPath, modelPath: process.execPath, input: video.file, start: 0, end: 3, language: 'pt', workRoot: path.join(dir, 'w') } });
  } finally { H.cleanup(dir); }
}

test('geração na placa: informa GPU, tempo e velocidade; o motor recebe useGpu', { skip }, async () => {
  await withTone(async ({ base }) => {
    const calls = [];
    const res = await generateSubtitles({ ...base, useGpu: true, cudaEngine: true, engine: stub(calls) });
    assert.deepEqual(calls.map((c) => [c.useGpu, c.noGpu]), [[true, false]]);
    assert.equal(res.device, 'GPU');
    assert.equal(res.fellBack, false);
    assert.equal(res.fallbackReason, null);
    assert.ok(res.transcribeMs >= 0 && res.audioSec > 2.5 && res.audioSec <= 3.01, `áudio ${res.audioSec}`);
    assert.ok(res.speed === null || res.speed > 0);
    assert.equal(res.cues.map((c) => c.text).join(' '), 'olá mundo');
  });
});

test('geração no processador com o motor CUDA: noGpu (-ng); com motor de CPU próprio: sem -ng', { skip }, async () => {
  await withTone(async ({ base }) => {
    const calls = [];
    const res = await generateSubtitles({ ...base, useGpu: false, cudaEngine: true, engine: stub(calls) });
    assert.deepEqual(calls.map((c) => [c.useGpu, c.noGpu]), [[false, true]]);
    assert.equal(res.device, 'CPU');
    calls.length = 0;
    await generateSubtitles({ ...base, useGpu: false, cudaEngine: false, engine: stub(calls) });
    assert.deepEqual(calls.map((c) => [c.useGpu, c.noGpu]), [[false, false]]);
  });
});

test('a placa falha: repete no processador (motor de CPU se houver), avisa o motivo e a legenda sai igual', { skip }, async () => {
  await withTone(async ({ base, dir }) => {
    const cpuExe = path.join(dir, 'cpu-whisper.exe');
    fs.writeFileSync(cpuExe, 'x');
    const calls = [];
    const reasons = [];
    const phases = [];
    const res = await generateSubtitles({ ...base, useGpu: true, cudaEngine: true, cpuWhisper: cpuExe, engine: stub(calls, { failOnGpu: true }), onGpuFailed: (r) => reasons.push(r), onProgress: (e) => phases.push(e.message) });
    assert.deepEqual(calls.map((c) => [c.useGpu, c.noGpu, c.whisper === cpuExe]), [[true, false, false], [false, false, true]]);
    assert.equal(res.device, 'CPU');
    assert.equal(res.fellBack, true);
    assert.match(res.fallbackReason, /out of memory/);
    assert.deepEqual(reasons, [res.fallbackReason]);
    assert.equal(res.cues.map((c) => c.text).join(' '), 'olá mundo');
    assert.ok(phases.some((m) => /A placa falhou: usando o processador/.test(m)));

    // sem motor de CPU próprio: repete o mesmo motor CUDA com -ng
    calls.length = 0;
    const res2 = await generateSubtitles({ ...base, useGpu: true, cudaEngine: true, engine: stub(calls, { failOnGpu: true }) });
    assert.deepEqual(calls.map((c) => [c.useGpu, c.noGpu]), [[true, false], [false, true]]);
    assert.equal(res2.fellBack, true);

    // erro que não é da placa, ou falha do processador, NÃO é mascarada; cancelar não repete
    const boom = async (o) => { throw new SubtitlesError(o.useGpu ? 'ENGINE_FAILED' : 'GPU_FAILED', 'x'); };
    await assert.rejects(generateSubtitles({ ...base, useGpu: true, cudaEngine: true, engine: boom }), (e) => e.code === 'ENGINE_FAILED');
    const cancel = new AbortController();
    const n = [];
    await assert.rejects(generateSubtitles({ ...base, useGpu: true, cudaEngine: true, signal: cancel.signal, engine: async (o) => { n.push(o.useGpu); cancel.abort(); throw new SubtitlesError('CANCELLED', 'Cancelado.'); } }), (e) => e.code === 'CANCELLED');
    assert.deepEqual(n, [true]);
  });
});

// ---------- IPC: escolha automática, fallback e memória ----------

function fakeEngines(dir) {
  const cudaDir = path.join(dir, 'cuda'); const cpuDir = path.join(dir, 'cpu');
  fs.mkdirSync(cudaDir); fs.mkdirSync(cpuDir);
  fs.writeFileSync(path.join(cudaDir, 'whisper-cli.exe'), 'x'); fs.writeFileSync(path.join(cudaDir, 'ggml-cuda.dll'), 'x');
  fs.writeFileSync(path.join(cpuDir, 'whisper-cli.exe'), 'x');
  return { cuda: path.join(cudaDir, 'whisper-cli.exe'), cpu: path.join(cpuDir, 'whisper-cli.exe') };
}

async function ipcSetup({ whisper, detect = GTX, hub, host = null, engine } = {}) {
  const userData = H.tmpDir('bf-gpu-ipc-');
  const fe = H.fakeElectron(userData, { resolveTools: () => ({ ffmpeg: H.tools.ffmpeg, ffprobe: H.tools.ffprobe, whisper }), ...(host ? { host } : {}) });
  const ctx = createContext(fe.deps);
  const calls = [];
  ctx.subtitlesOptions = {
    detectGpu: async () => detect,
    engine: engine || stub(calls, { failOnGpu: false }),
    ...(hub ? { models: { baseUrl: hub.base, catalog: H.pinnedCatalog(hub), allowLoopbackHttp: true } } : {})
  };
  toolsHandler.register(ctx);
  sub.register(ctx);
  if (hub) assert.equal((await fe.call('subtitles:installModel', { id: 'tiny' })).ok, true);
  return { ctx, fe, calls, userData, done: () => H.cleanup(userData) };
}

test('status: GPU detectada, motor CUDA e CPU; automático escolhe a placa, CPU forçada usa o processador (-ng)', { skip }, async () => {
  const dir = H.tmpDir('bf-gpu-eng-');
  const hub = await H.fakeHub({ data: crypto.randomBytes(40 * 1024) });
  const engines = fakeEngines(dir);
  const t = await ipcSetup({ whisper: engines.cuda, hub });
  try {
    const s = await t.fe.call('subtitles:status');
    assert.equal(s.hardware.gpu.name, 'NVIDIA GeForce GTX 1650');
    assert.equal(s.hardware.gpu.summary, 'NVIDIA GeForce GTX 1650 · 4 GB');
    assert.equal(s.hardware.canUseGpu, true);
    assert.equal(s.hardware.engineKind, 'cuda');
    assert.equal(s.engine.kind, 'cuda');
    assert.equal(s.engine.cuda.installed, true);
    assert.equal(s.engine.cuda.sizeBytes, 674539285, 'tamanho oficial do pacote CUDA, para o aviso de download');
    assert.ok(s.models.every((m) => m.gpuFit.level === 'ok'), 'todos os modelos do catálogo cabem em 4 GB');
    const hw = await t.fe.call('subtitles:hardware');
    assert.equal(hw.ok, true);
    assert.equal(hw.gpu.available, true);

    const video = H.makeVideo(path.join(dir, 'tom.mp4'), [{ tone: 3 }]);
    const gen = (extra = {}) => t.fe.call('subtitles:generate', { cutId: 'c1', input: video.file, start: 0, end: 3, modelId: 'tiny', language: 'pt', ...extra });

    let r = await gen();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(t.calls.map((c) => [c.useGpu, c.noGpu]), [[true, false]], 'automático + NVIDIA + CUDA = placa');
    assert.equal(r.device, 'GPU');
    assert.match(r.deviceLabel, /NVIDIA GeForce GTX 1650/);
    assert.equal(r.fellBack, false);

    t.calls.length = 0;
    r = await gen({ engine: 'cpu' });
    assert.deepEqual(t.calls.map((c) => [c.useGpu, c.noGpu]), [[false, true]]);
    assert.equal(r.device, 'CPU');
    assert.equal(r.deviceLabel, 'processador');

    t.calls.length = 0;
    r = await gen({ engine: 'valor-invalido' });
    assert.equal(t.calls[0].useGpu, true, 'valor desconhecido = automático');
    assert.equal(t.ctx.toolUsage.inUse('whisper', 'whisper'), null);
  } finally { await hub.close(); t.done(); H.cleanup(dir); }
});

test('a placa falha: processador assume, avisa, a falha é lembrada (automático não insiste; "Placa (GPU)" tenta de novo)', { skip }, async () => {
  const dir = H.tmpDir('bf-gpu-eng-');
  const hub = await H.fakeHub({ data: crypto.randomBytes(40 * 1024) });
  const engines = fakeEngines(dir);
  const calls = [];
  const t = await ipcSetup({ whisper: engines.cuda, hub, engine: stub(calls, { failOnGpu: true }) });
  try {
    const video = H.makeVideo(path.join(dir, 'tom.mp4'), [{ tone: 3 }]);
    const gen = (extra = {}) => t.fe.call('subtitles:generate', { cutId: 'c1', input: video.file, start: 0, end: 3, modelId: 'tiny', language: 'pt', ...extra });

    let r = await gen();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(calls.map((c) => c.useGpu), [true, false]);
    assert.equal(r.device, 'CPU');
    assert.equal(r.fellBack, true);
    assert.match(r.fallbackReason, /out of memory/);
    assert.match(r.deviceNote, /A placa falhou: usando o processador/);
    assert.equal(r.cues.map((c) => c.text).join(' '), 'olá mundo');

    const s = await t.fe.call('subtitles:status');
    assert.match(s.hardware.gpuFailure, /out of memory/, 'a falha aparece no status');

    calls.length = 0;
    r = await gen(); // automático: lembra e não tenta a placa
    assert.deepEqual(calls.map((c) => c.useGpu), [false]);
    assert.equal(r.fellBack, false);
    assert.match(r.deviceNote, /falhou antes/);

    calls.length = 0;
    r = await gen({ engine: 'gpu' }); // escolha explícita: tenta de novo (e cai de novo no processador)
    assert.deepEqual(calls.map((c) => c.useGpu), [true, false]);
    assert.equal(r.fellBack, true);
  } finally { await hub.close(); t.done(); H.cleanup(dir); }
});

test('sem NVIDIA ou só com motor de CPU: sempre o processador, sem tentar a placa', { skip }, async () => {
  const dir = H.tmpDir('bf-gpu-eng-');
  const hub = await H.fakeHub({ data: crypto.randomBytes(40 * 1024) });
  const engines = fakeEngines(dir);
  try {
    // motor CUDA, mas sem placa
    const noGpu = await ipcSetup({ whisper: engines.cuda, hub, detect: { available: false, name: null, memoryMb: null, driver: null, reason: 'Nenhuma placa NVIDIA' } });
    const video = H.makeVideo(path.join(dir, 'tom.mp4'), [{ tone: 3 }]);
    const payload = { cutId: 'c1', input: video.file, start: 0, end: 3, modelId: 'tiny', language: 'pt' };
    assert.equal((await noGpu.fe.call('subtitles:generate', payload)).device, 'CPU');
    assert.deepEqual(noGpu.calls.map((c) => [c.useGpu, c.noGpu]), [[false, true]]);
    assert.equal((await noGpu.fe.call('subtitles:status')).hardware.canUseGpu, false);
    noGpu.done();

    // placa, mas só o motor de CPU
    const cpuOnly = await ipcSetup({ whisper: engines.cpu, hub });
    const s = await cpuOnly.fe.call('subtitles:status');
    assert.equal(s.engine.kind, 'cpu');
    assert.equal(s.hardware.canUseGpu, false, 'placa detectada, mas falta o motor CUDA');
    assert.equal(s.engine.cuda.installed, false);
    assert.equal(s.engine.cuda.available, process.platform === 'win32' && process.arch === 'x64');
    let r = await cpuOnly.fe.call('subtitles:generate', payload);
    assert.deepEqual(cpuOnly.calls.map((c) => [c.useGpu, c.noGpu]), [[false, false]]);
    assert.equal(r.deviceNote, null, 'automático sem motor CUDA não incomoda');
    cpuOnly.calls.length = 0;
    r = await cpuOnly.fe.call('subtitles:generate', { ...payload, engine: 'gpu' });
    assert.equal(r.device, 'CPU');
    assert.match(r.deviceNote, /não está instalado/);
    cpuOnly.done();
  } finally { await hub.close(); H.cleanup(dir); }
});

test('memória de 1 GB: o status avisa que o modelo grande não cabe (o automático então não usa a placa: veja planDevice)', { skip }, async () => {
  const dir = H.tmpDir('bf-gpu-eng-');
  const hub = await H.fakeHub({ data: crypto.randomBytes(40 * 1024) });
  const engines = fakeEngines(dir);
  const t = await ipcSetup({ whisper: engines.cuda, hub, detect: { ...GTX, name: 'NVIDIA GeForce GT 1030', memoryMb: 1024 } });
  try {
    const s = await t.fe.call('subtitles:status');
    const levels = Object.fromEntries(s.models.map((m) => [m.id, m.gpuFit.level]));
    assert.equal(levels['large-v3-turbo'], 'no');
    assert.equal(levels.tiny, 'ok');
    assert.match(s.models.find((m) => m.id === 'large-v3-turbo').gpuFit.message, /provavelmente não cabe/);
    assert.equal(getModel('large-v3-turbo').sizeBytes, 574041195);
  } finally { await hub.close(); t.done(); H.cleanup(dir); }
});

test('módulo embutido: o motor do hospedeiro (CUDA ou CPU) é usado sem baixar motor próprio', { skip }, async () => {
  const dir = H.tmpDir('bf-gpu-eng-');
  const hub = await H.fakeHub({ data: crypto.randomBytes(40 * 1024) });
  const engines = fakeEngines(dir);
  const video = H.makeVideo(path.join(dir, 'tom.mp4'), [{ tone: 3 }]);
  try {
    for (const kind of ['cuda', 'cpu']) {
      const exe = engines[kind];
      const host = { embedded: true, name: 'BDS', tool: (k) => (k === 'whisper' ? exe : null), whisperModels: null };
      const t = await ipcSetup({ whisper: exe, hub, host });
      const s = await t.fe.call('subtitles:status');
      assert.equal(s.engine.origin, 'host');
      assert.equal(s.engine.hostName, 'BDS');
      assert.equal(s.engine.kind, kind);
      assert.equal(s.engine.cuda.managedByHost, true);
      assert.equal(s.engine.cuda.available, false, 'não oferece baixar motor próprio');
      assert.equal(s.hardware.canUseGpu, kind === 'cuda');

      const tools = await t.fe.call('tools:status');
      assert.ok(!tools.tools.some((x) => x.id === 'whisper-cuda'), 'a aba Ferramentas não oferece o pacote CUDA');
      const install = await t.fe.call('tools:install', { id: 'whisper-cuda' });
      assert.equal(install.code, 'HOST_PROVIDED');

      const r = await t.fe.call('subtitles:generate', { cutId: 'c1', input: video.file, start: 0, end: 3, modelId: 'tiny', language: 'pt' });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(t.calls.map((c) => [c.useGpu, c.whisper === exe]), [[kind === 'cuda', true]]);
      assert.equal(r.device, kind === 'cuda' ? 'GPU' : 'CPU');
      t.done();
    }
  } finally { await hub.close(); H.cleanup(dir); }
});

// ---------- entrada oficial do pacote CUDA e instalação ----------

test('entrada oficial whisper-cuda: pacote, tamanho e SHA-256 da release oficial b5130; só Windows 64 bits; não alimenta ctx.tools', () => {
  const reg = registry.loadRegistry({ strict: true });
  const entry = reg.entries.find((e) => e.id === 'whisper-cuda');
  assert.ok(entry, 'src/core/tools/entries/whisper-cuda.js carregou');
  assert.deepEqual(registry.validateEntry(entry), []);
  assert.deepEqual(Object.keys(entry.assets), ['win32-x64']);
  const a = registry.assetFor(entry, 'win32', 'x64');
  assert.equal(a.name, 'whisper-cublas-12.4.0-bin-x64.zip');
  assert.equal(a.size, 674539285);
  assert.equal(a.sha256, 'af520ddd034d985b55dfeea3e465ed93653ba2aee1a55e865033edc548c272a7');
  assert.equal(a.url, 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-cublas-12.4.0-bin-x64.zip');
  assert.equal(a.stripComponents, 1);
  assert.equal(a.exe, 'whisper-cli.exe');
  assert.match(entry.source, /^oficial: https:\/\/github\.com\/ggml-org\/whisper\.cpp\/releases\/tag\/b5130$/);
  assert.equal(registry.assetFor(entry, 'linux', 'x64'), null, 'o projeto oficial não publica CUDA para Linux');
  assert.equal(registry.assetFor(entry, 'darwin', 'arm64'), null);
  assert.equal(require('../src/core/tools/catalog').toolKeyFor('whisper-cuda'), null, 'o motor CPU continua sendo o ctx.tools.whisper');
});

test('instala o pacote CUDA (zip com Release/ de mentira, servidor local): vira motor CUDA e o status mostra o tamanho do aviso', async () => {
  const base = T.tmpDir();
  const zip = T.makeZip([
    { name: 'Release/' },
    { name: 'Release/whisper-cli.exe', data: 'MZ-whisper-cuda-de-teste' },
    { name: 'Release/ggml-cuda.dll', data: 'cuda' },
    { name: 'Release/ggml-cpu-x64.dll', data: 'cpu' }
  ]);
  const srv = await T.startServer((req, res) => T.sendBuffer(res, zip));
  try {
    const entry = T.makeEntry({ base: srv.base, buf: zip, id: 'whisper-cuda', version: 'b5130', file: 'whisper-cublas-test.zip', exe: 'whisper-cli.exe', asset: { stripComponents: 1 } });
    const toolsDir = path.join(base, 'tools');
    const inst = new ToolInstaller({ toolsDir, entries: [entry], platform: 'win32', arch: 'x64', allowLoopbackHttp: true, attempts: 1, backoffMs: 1 });
    const events = [];
    inst.on('progress', (e) => events.push(e.phase));
    const res = await inst.install('whisper-cuda');
    assert.equal(res.alreadyInstalled, false);
    assert.equal(eng.engineKindOf(res.exe), 'cuda', 'a pasta instalada tem ggml-cuda: é motor CUDA');
    assert.ok(events.includes('download') && events.includes('verify') && events.includes('extract'));
    assert.equal(registry.resolveInstalled(toolsDir, 'whisper-cuda', { entries: [entry], platform: 'win32', arch: 'x64' }), res.exe);
    assert.equal(fs.existsSync(path.join(toolsDir, 'whisper-cuda', 'b5130', 'ggml-cpu-x64.dll')), true, 'as DLLs de CPU vêm junto (roda sem placa com -ng)');
    // SHA-256 errado: recusa
    const bad = { ...entry, assets: { 'win32-x64': { ...entry.assets['win32-x64'], sha256: '0'.repeat(64) } }, version: 'b9999' };
    await assert.rejects(inst.install(bad), (e) => e.code === 'SHA256_MISMATCH' || /SHA/i.test(e.message));
  } finally { await srv.close(); T.cleanup(base); }
});

test('motor CUDA instalado pelo app (sem motor de CPU): o status usa-o, a placa vira o padrão e o app não pede o motor de CPU', { skip }, async () => {
  const base = T.tmpDir();
  const zip = T.makeZip([
    { name: 'Release/whisper-cli.exe', data: 'MZ-whisper-cuda-de-teste' },
    { name: 'Release/ggml-cuda.dll', data: 'cuda' }
  ]);
  const srv = await T.startServer((req, res) => T.sendBuffer(res, zip));
  const hub = await H.fakeHub({ data: crypto.randomBytes(40 * 1024) });
  const dir = H.tmpDir('bf-gpu-eng-');
  try {
    const entry = T.makeEntry({ base: srv.base, buf: zip, id: 'whisper-cuda', version: 'b5130', file: 'whisper-cublas-test.zip', exe: 'whisper-cli.exe', asset: { stripComponents: 1 } });
    const userData = H.tmpDir('bf-gpu-ipc-');
    const fe = H.fakeElectron(userData, { resolveTools: () => ({ ffmpeg: H.tools.ffmpeg, ffprobe: H.tools.ffprobe, whisper: null }) });
    const ctx = createContext(fe.deps);
    ctx.toolCatalog = { entries: [...registry.getEntries().filter((e) => e.id !== 'whisper-cuda'), entry], allowLoopbackHttp: true, testIds: [] };
    const calls = [];
    ctx.subtitlesOptions = { detectGpu: async () => GTX, engine: stub(calls), models: { baseUrl: hub.base, catalog: H.pinnedCatalog(hub), allowLoopbackHttp: true } };
    toolsHandler.register(ctx);
    sub.register(ctx);
    try {
      assert.equal((await fe.call('subtitles:status')).engine.installed, false);
      assert.equal((await fe.call('tools:install', { id: 'whisper-cuda' })).ok, true);
      assert.equal((await fe.call('subtitles:installModel', { id: 'tiny' })).ok, true);
      const s = await fe.call('subtitles:status');
      assert.equal(s.engine.installed, true);
      assert.equal(s.engine.kind, 'cuda');
      assert.equal(s.engine.origin, 'app');
      assert.equal(s.hardware.canUseGpu, true);
      const video = H.makeVideo(path.join(dir, 'tom.mp4'), [{ tone: 3 }]);
      const r = await fe.call('subtitles:generate', { cutId: 'c1', input: video.file, start: 0, end: 3, modelId: 'tiny', language: 'pt' });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(calls.map((c) => c.useGpu), [true]);
      // durante a geração o pacote CUDA também conta como em uso (não dá para remover)
      assert.equal(ctx.toolUsage.inUse(null, 'whisper-cuda'), null, 'ocioso depois da geração');
      assert.equal((await fe.call('tools:remove', { id: 'whisper-cuda' })).ok, true);
    } finally { H.cleanup(userData); }
  } finally { await srv.close(); await hub.close(); T.cleanup(base); H.cleanup(dir); }
});

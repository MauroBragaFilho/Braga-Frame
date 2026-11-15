'use strict';

/**
 * Transcrição do vídeo inteiro (src/core/analysis/transcript/transcribe.js): divisão em pedaços e retomada (com o gerador trocado por
 * um falso) e, de verdade, com o Whisper REAL que o BDS já tem instalado neste computador (fala sintetizada pelo Windows):
 * horários absolutos entre pedaços, trecho mudo sem fala inventada, GPU automática quando há placa e cancelamento.
 * Pula (com o motivo) sem ffmpeg, sem motor, sem modelo ou sem voz pt-BR do Windows. Variáveis: BF_WHISPER_DIR (pasta
 * `modules/whisper` do BDS), BF_WHISPER_SKIP=1.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./subtitles-helpers');
const gpu = require('../src/core/subtitles/gpu');
const eng = require('../src/core/subtitles/engine');
const { getModel } = require('../src/core/subtitles/models');
const { REASONS } = require('../src/core/subtitles/hallucinations');
const { transcribeVideo, planChunks } = require('../src/core/analysis/transcript/transcribe');
const { normalizeCues } = require('../src/core/analysis/transcript/format');

// ---------- sem o Whisper ----------

test('planChunks: pedaços de 10 min, sobra pequena no fim vai para o último, retomada a partir de um ponto', () => {
  assert.deepEqual(planChunks(1500, 600), [[0, 600], [600, 1200], [1200, 1500]]);
  assert.deepEqual(planChunks(1205, 600), [[0, 600], [600, 1205]], 'sobra de 5 s (< 10% do pedaço) fica no último');
  assert.deepEqual(planChunks(100, 600), [[0, 100]]);
  assert.deepEqual(planChunks(1500, 600, 600), [[600, 1200], [1200, 1500]]);
  assert.deepEqual(planChunks(1500, 600, 1500), []);
  assert.deepEqual(planChunks(0, 600), []);
  assert.equal(planChunks(11090, 600).length, 19);
  const ch = planChunks(11089.85, 600);
  assert.equal(ch[0][0], 0);
  assert.equal(ch[ch.length - 1][1], 11089.85);
  for (let i = 1; i < ch.length; i += 1) assert.equal(ch[i][0], ch[i - 1][1], 'sem lacunas nem sobreposição');
});

test('transcribeVideo com gerador falso: horários absolutos, risadas voltam, rascunho a cada pedaço, retomada e cancelamento', async () => {
  const calls = [];
  const generate = async (o) => {
    calls.push([o.start, o.end]);
    if (o.signal && o.signal.aborted) throw Object.assign(new Error('c'), { code: 'CANCELLED' });
    return {
      cues: [{ start: 2, end: 5, text: `fala ${o.start}` }, { start: 5.1, end: 5.9, text: 'Obrigado.' }],
      discarded: [{ start: 7, end: 9, text: '*Risos*', reason: REASONS.annotation }, { start: 10, end: 11, text: '[Música]', reason: REASONS.annotation }, { start: 12, end: 13, text: '*Risos*', reason: REASONS.silence }],
      device: 'CPU', transcribeMs: 100, audioSec: 10
    };
  };
  const chunks = [];
  const progress = [];
  const r = await transcribeVideo({ input: 'v.mp4', duration: 1500, genOptions: { x: 1 }, generate, onChunk: (c) => chunks.push([c.doneUntil, c.cues.length]), onProgress: (p) => progress.push(p) });
  assert.deepEqual(calls, [[0, 600], [600, 1200], [1200, 1500]]);
  assert.deepEqual(chunks, [[600, 3], [1200, 6], [1500, 9]]);
  assert.deepEqual(r.cues.filter((c) => c.laugh).map((c) => c.start), [7, 607, 1207], 'só a anotação de risada volta; [Música] e o descartado por silêncio não');
  assert.equal(r.cues.find((c) => /fala 600/.test(c.text)).start, 602);
  assert.equal(r.chunks, 3);
  assert.ok(progress.every((p, i) => i === 0 || p.p >= progress[i - 1].p - 0.0001), 'progresso não anda para trás');
  assert.equal(progress[progress.length - 1].p, 1);

  // retomada: pula o que já está pronto e mantém as falas do rascunho
  calls.length = 0;
  const initial = [{ start: 2, end: 5, text: 'fala 0' }];
  const resumed = await transcribeVideo({ input: 'v.mp4', duration: 1500, genOptions: {}, generate, startAt: 1200, initialCues: initial });
  assert.deepEqual(calls, [[1200, 1500]]);
  assert.ok(resumed.cues.some((c) => c.text === 'fala 0'));

  // cancelamento
  const ctrl = new AbortController();
  const slow = async (o) => { ctrl.abort(); return generate({ ...o, signal: ctrl.signal }); };
  await assert.rejects(() => transcribeVideo({ input: 'v.mp4', duration: 1500, genOptions: {}, generate: slow, signal: ctrl.signal }), (e) => e.code === 'CANCELLED');

  // erro do motor sobe como veio
  await assert.rejects(() => transcribeVideo({ input: 'v.mp4', duration: 100, genOptions: {}, generate: async () => { throw Object.assign(new Error('motor'), { code: 'ENGINE_FAILED' }); } }), (e) => e.code === 'ENGINE_FAILED');
  // normalização final (laço de repetição vindo do motor)
  assert.equal(normalizeCues(Array.from({ length: 10 }, (_, i) => ({ start: i, end: i + 0.9, text: 'Tchau.' }))).cues.length, 3);
});

// ---------- Whisper REAL ----------

function findWhisperDir() {
  const candidates = [process.env.BF_WHISPER_DIR, path.join(process.env.APPDATA || '', 'braga-digital-studio', 'data', 'modules', 'whisper'), path.resolve(__dirname, '..', '..', 'Braga Digital Studio', 'data', 'modules', 'whisper')].filter(Boolean);
  return candidates.find((d) => fs.existsSync(path.join(d, 'models', 'large-v3-turbo', 'model.bin')) && (fs.existsSync(path.join(d, 'cuda', 'whisper-cli.exe')) || fs.existsSync(path.join(d, 'engine', 'whisper-cli.exe')))) || null;
}

test('transcrição do vídeo com o Whisper REAL (BDS): horários absolutos entre pedaços, trecho mudo sem fala inventada, GPU automática', { timeout: 900000 }, async (t) => {
  const dir = process.env.BF_WHISPER_SKIP === '1' ? null : findWhisperDir();
  const why = process.env.BF_WHISPER_SKIP === '1' ? 'BF_WHISPER_SKIP=1' : !H.tools.ffmpeg ? 'ffmpeg não encontrado' : !dir ? 'sem motor/modelo do Whisper do BDS (defina BF_WHISPER_DIR)' : null;
  if (why) { t.skip(why); return; }
  const pt = H.listVoices().find((v) => /^pt/i.test(v.culture));
  if (!pt) { t.skip('o Windows não tem voz pt-BR (System.Speech) neste computador'); return; }

  const cudaExe = path.join(dir, 'cuda', 'whisper-cli.exe');
  const cpuExe = path.join(dir, 'engine', 'whisper-cli.exe');
  const modelPath = path.join(dir, 'models', 'large-v3-turbo', 'model.bin');
  const model = getModel('large-v3-turbo');
  assert.equal(fs.statSync(modelPath).size, model.sizeBytes, 'o modelo do BDS é o do catálogo daqui');
  gpu.resetGpuCache();
  const hw = await gpu.detectNvidia({ refresh: true });
  const hasCuda = fs.existsSync(cudaExe) && eng.engineKindOf(cudaExe) === 'cuda';
  const useGpu = Boolean(hasCuda && hw.available);
  const exe = useGpu || (hasCuda && !fs.existsSync(cpuExe)) ? cudaExe : (fs.existsSync(cpuExe) ? cpuExe : cudaExe);
  t.diagnostic(`motor: ${exe} · ${useGpu ? `placa ${gpu.describeGpu(hw)}` : 'processador'}`);

  const media = H.tmpDir('bf-transcribe-');
  const release = await H.acquireWhisperLock();
  try {
    const wavA = path.join(media, 'a.wav');
    const wavB = path.join(media, 'b.wav');
    H.synthesize('Olá pessoal, bem-vindos ao nosso canal. Hoje vamos jogar uma partida muito divertida.', pt.name, wavA);
    H.synthesize('Primeiro vamos escolher o personagem, depois explorar o mapa com calma. No final eu mostro as melhores jogadas.', pt.name, wavB);
    // 0-2 mudo | fala A | 55 s mudos (a fronteira de 60 s cai aqui) | fala B (já no 2º pedaço) | 2 s mudos
    const v = H.makeVideo(path.join(media, 'live.mkv'), [{ silence: 2 }, { wav: wavA }, { silence: 55 }, { wav: wavB }, { silence: 2 }], { pcm: true });
    const aEnd = v.parts[1].end;
    const bStart = v.parts[3].start;
    t.diagnostic(`vídeo de ${v.duration.toFixed(1)} s: fala A ${v.parts[1].start.toFixed(1)}–${aEnd.toFixed(1)}, mudo até ${bStart.toFixed(1)}, fala B ${bStart.toFixed(1)}–${v.parts[3].end.toFixed(1)}`);
    assert.ok(v.duration > 60, 'o vídeo precisa passar de 1 pedaço mínimo (60 s) para cruzar a fronteira entre pedaços');

    const genOptions = { ffmpeg: H.tools.ffmpeg, whisper: exe, modelPath, dtw: model.dtw, useGpu, cudaEngine: exe === cudaExe, cpuWhisper: fs.existsSync(cpuExe) ? cpuExe : null, workRoot: path.join(media, 'w') };
    const progress = [];
    const drafts = [];
    const res = await transcribeVideo({
      input: v.file, duration: v.duration, genOptions, language: 'pt', chunkSec: 60,
      onProgress: (p) => progress.push(p), onChunk: (c) => drafts.push(c.doneUntil)
    });
    t.diagnostic(`${res.chunks} pedaços · ${res.device} · ${(res.elapsedMs / 1000).toFixed(1)} s para ${v.duration.toFixed(0)} s de vídeo · ${res.cues.length} falas`);
    assert.equal(res.chunks, 2);
    assert.deepEqual(drafts, [60, v.duration].map((x) => Math.round(x * 1000) / 1000));
    if (useGpu) assert.equal(res.device, 'GPU', 'com placa e motor CUDA a transcrição usa a placa');
    const norm = (s) => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
    const text = norm(res.cues.map((c) => c.text).join(' '));
    for (const w of ['pessoal', 'canal', 'partida', 'personagem', 'mapa', 'jogadas']) assert.ok(text.includes(w), `"${w}" em: ${text}`);
    // horários absolutos: a fala B está no segundo pedaço e cai perto de onde foi colocada
    const second = res.cues.filter((c) => norm(c.text).includes('personagem') || norm(c.text).includes('mapa'));
    assert.ok(second.length >= 1);
    assert.ok(second[0].start >= bStart - 3 && second[0].start <= bStart + 12, `fala B em ${second[0].start} (colocada em ${bStart.toFixed(1)})`);
    // nenhuma fala inventada no trecho mudo (com folga de 2 s nas pontas)
    const invented = res.cues.filter((c) => !c.laugh && c.start > aEnd + 2 && c.end < bStart - 2);
    assert.deepEqual(invented, [], `falas no trecho mudo: ${JSON.stringify(invented)}`);
    assert.ok(res.cues.every((c) => c.start >= 0 && c.end <= v.duration + 0.01 && c.end > c.start));
    assert.ok(progress.length >= 2 && progress[progress.length - 1].p === 1);

    // cancelamento no meio: o pedaço em andamento é encerrado
    const ctrl = new AbortController();
    let chunkDone = 0;
    const cancelled = transcribeVideo({ input: v.file, duration: v.duration, genOptions, language: 'pt', chunkSec: 60, signal: ctrl.signal, onChunk: () => { chunkDone += 1; ctrl.abort(); } });
    await assert.rejects(() => cancelled, (e) => e.code === 'CANCELLED');
    assert.equal(chunkDone, 1, 'parou depois do primeiro pedaço');
    // nada ficou na pasta de trabalho
    assert.deepEqual(fs.readdirSync(path.join(media, 'w')).filter((n) => n.startsWith('sub-')), []);
  } finally { H.cleanup(media); release(); }
});

'use strict';

/**
 * Teste REAL da transcrição na placa NVIDIA. Usa o motor CUDA OFICIAL que o BDS já tem instalado neste computador
 * (nada é baixado: <dados do BDS>/modules/whisper/cuda) e o modelo que ele já baixou (large-v3-turbo q5, que cabe nos 4 GB
 * de uma GTX 1650). Gera fala sintetizada pelo Windows (System.Speech) e confere:
 *   - o texto é reconhecido na placa E no processador (-ng), com o mesmo resultado;
 *   - a placa foi usada de verdade: o log do whisper-cli ("CUDA", device) e a memória da placa subindo no nvidia-smi durante
 *     a execução; no modo processador a memória da placa não sobe;
 *   - mede e registra a velocidade (segundos de áudio por segundo de relógio) de cada modo;
 *   - se o motor da placa falha de verdade (programa que sai com erro), o processador assume e o resultado sai igual.
 * Pula (com o motivo) sem placa NVIDIA, sem motor CUDA, sem modelo ou sem voz pt-BR do Windows.
 * Variáveis: BF_GPU_CUDA_DIR (pasta do motor CUDA), BF_GPU_MODEL (arquivo .bin do modelo), BF_GPU_SKIP=1 (pula).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const H = require('./subtitles-helpers');
const gpu = require('../src/core/subtitles/gpu');
const eng = require('../src/core/subtitles/engine');
const { generateSubtitles } = require('../src/core/subtitles/generate');
const { getModel } = require('../src/core/subtitles/models');

const BDS = path.join(process.env.APPDATA || '', 'braga-digital-studio', 'data', 'modules', 'whisper');
const cudaDir = process.env.BF_GPU_CUDA_DIR || path.join(BDS, 'cuda');
const exe = path.join(cudaDir, 'whisper-cli.exe');
const modelPath = process.env.BF_GPU_MODEL || path.join(BDS, 'models', 'large-v3-turbo', 'model.bin');
const norm = (s) => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);

/** Amostra a memória usada da placa (nvidia-smi) enquanto `fn` roda. Devolve { result, maxUsedMb, baselineMb }. */
async function withGpuSampling(smi, fn) {
  const lines = [];
  const child = spawn(smi, ['--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader,nounits', '-lms', '250'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.on('data', (d) => { for (const l of d.toString().split(/\r?\n/)) if (l.trim()) lines.push(l.trim()); });
  await new Promise((r) => setTimeout(r, 800));
  const baselineMb = Math.max(0, ...lines.map((l) => Number(l.split(',')[0])).filter(Number.isFinite));
  lines.length = 0;
  let result;
  try { result = await fn(); } finally { child.kill(); }
  const used = lines.map((l) => Number(l.split(',')[0])).filter(Number.isFinite);
  const util = lines.map((l) => Number(l.split(',')[1])).filter(Number.isFinite);
  return { result, baselineMb, maxUsedMb: Math.max(0, ...used), maxUtil: Math.max(0, ...util), samples: used.length };
}

test('whisper REAL na placa NVIDIA: texto reconhecido, GPU realmente usada (nvidia-smi + log) e velocidade GPU x CPU', { timeout: 1200000 }, async (t) => {
  const why = process.env.BF_GPU_SKIP === '1' ? 'BF_GPU_SKIP=1'
    : !H.tools.ffmpeg ? 'ffmpeg não encontrado'
      : !fs.existsSync(exe) ? `sem motor CUDA em ${cudaDir} (instale a aceleração NVIDIA no BDS ou aponte BF_GPU_CUDA_DIR)`
        : eng.engineKindOf(exe) !== 'cuda' ? 'a pasta indicada não é de um motor CUDA (sem ggml-cuda)'
          : !fs.existsSync(modelPath) ? `sem modelo em ${modelPath}`
            : null;
  if (why) { t.skip(why); return; }
  gpu.resetGpuCache();
  const hw = await gpu.detectNvidia({ refresh: true });
  if (!hw.available) { t.skip(`sem placa NVIDIA utilizável: ${hw.reason}`); return; }
  const pt = H.listVoices().find((v) => /^pt/i.test(v.culture));
  if (!pt) { t.skip('o Windows não tem voz pt-BR (System.Speech) neste computador'); return; }
  const smi = gpu.candidates().find((p) => path.isAbsolute(p) && fs.existsSync(p)) || 'nvidia-smi';
  const model = getModel('large-v3-turbo');
  assert.equal(fs.statSync(modelPath).size, model.sizeBytes, 'o modelo do BDS é o mesmo arquivo do catálogo daqui (tamanho)');
  t.diagnostic(`placa: ${gpu.describeGpu(hw)} · driver ${hw.driver} · motor: ${cudaDir} · modelo: large-v3-turbo q5_0`);

  const media = H.tmpDir('bf-gpu-media-');
  const releaseLock = await H.acquireWhisperLock();
  try {
    const text = 'Olá pessoal, bem-vindos ao nosso canal. Hoje vamos jogar uma partida muito divertida. Vamos lá! Primeiro vamos escolher o personagem, depois explorar o mapa com calma. No final eu mostro as melhores jogadas e vocês deixam o comentário.';
    const wav = path.join(media, 'fala.wav');
    H.synthesize(text, pt.name, wav);
    const v = H.makeVideo(path.join(media, 'fala.mp4'), [{ silence: 2 }, { wav }, { silence: 2 }]);
    const base = { ffmpeg: H.tools.ffmpeg, whisper: exe, modelPath, dtw: model.dtw, input: v.file, start: 1, end: v.duration - 1, language: 'pt', workRoot: path.join(media, 'w'), cudaEngine: true };
    const words = ['ola', 'pessoal', 'bem-vindos', 'canal', 'hoje', 'vamos', 'jogar', 'partida', 'divertida', 'personagem', 'explorar', 'mapa', 'jogadas', 'comentario'];
    const found = (res) => words.filter((w) => norm(res.cues.map((c) => c.text).join(' ')).includes(w));
    const phases = [];

    // 1) placa (primeira vez: carrega o CUDA e o modelo) e de novo (cache do driver aquecido)
    const gpu1 = await withGpuSampling(smi, () => generateSubtitles({ ...base, useGpu: true, onProgress: (e) => phases.push(e.phase) }));
    const g1 = gpu1.result;
    assert.equal(g1.device, 'GPU', 'o log do whisper-cli confirmou o backend CUDA');
    assert.match(g1.deviceName, /NVIDIA/i, `placa informada pelo log: ${g1.deviceName}`);
    assert.equal(g1.fellBack, false);
    assert.ok(found(g1).length >= 11, `palavras reconhecidas na placa: ${found(g1).join(', ')} | ${g1.cues.map((c) => c.text).join(' ')}`);
    assert.ok(gpu1.maxUsedMb - gpu1.baselineMb >= 300, `a memória da placa subiu durante a execução: ${gpu1.baselineMb} -> ${gpu1.maxUsedMb} MB (${gpu1.samples} amostras)`);
    assert.ok(phases.includes('transcribe'), 'progresso real do motor');
    const g2 = (await withGpuSampling(smi, () => generateSubtitles({ ...base, useGpu: true }))).result;
    assert.equal(g2.device, 'GPU');
    assert.deepEqual(g2.cues.map((c) => c.text), g1.cues.map((c) => c.text), 'a placa dá o mesmo texto nas duas vezes');

    // 2) processador (mesmo motor com -ng): mesmo texto, memória da placa não sobe
    const cpu = await withGpuSampling(smi, () => generateSubtitles({ ...base, useGpu: false }));
    const c1 = cpu.result;
    assert.equal(c1.device, 'CPU');
    assert.equal(c1.deviceName, null);
    assert.ok(found(c1).length >= 11, `palavras reconhecidas no processador: ${found(c1).join(', ')}`);
    assert.ok(cpu.maxUsedMb - cpu.baselineMb < 300, `no modo processador a placa não é usada: ${cpu.baselineMb} -> ${cpu.maxUsedMb} MB`);
    const gpuText = norm(g1.cues.map((c) => c.text).join(' '));
    const cpuText = norm(c1.cues.map((c) => c.text).join(' '));
    const same = words.filter((w) => gpuText.includes(w) === cpuText.includes(w)).length;
    assert.ok(same >= words.length - 1, 'placa e processador reconhecem as mesmas palavras');

    // 3) a placa falha de verdade (o programa sai com erro): o processador assume e a legenda sai igual
    const broken = path.join(media, 'quebrado.exe');
    fs.copyFileSync(process.execPath, broken); // node.exe com argumentos do whisper = erro (saída diferente de 0)
    const reasons = [];
    const fb = await generateSubtitles({ ...base, whisper: broken, cudaEngine: true, useGpu: true, cpuWhisper: exe, onGpuFailed: (r) => reasons.push(r) });
    assert.equal(fb.fellBack, true);
    assert.equal(fb.device, 'CPU');
    assert.equal(reasons.length, 1);
    assert.ok(found(fb).length >= 11, 'o processador entregou a legenda depois da falha da placa');

    // medições
    const fmt = (r) => `${(r.transcribeMs / 1000).toFixed(1)} s para ${r.audioSec.toFixed(1)} s de áudio = ${r.speed}x o tempo real`;
    t.diagnostic(`GPU (1ª vez, carrega CUDA): ${fmt(g1)} | GPU (2ª vez): ${fmt(g2)} | CPU (-ng, ${require('node:os').cpus().length} núcleos lógicos): ${fmt(c1)}`);
    t.diagnostic(`memória da placa na execução: ${gpu1.baselineMb} -> ${gpu1.maxUsedMb} MB (uso máx. ${gpu1.maxUtil}%) | no modo processador: ${cpu.baselineMb} -> ${cpu.maxUsedMb} MB`);
    t.diagnostic(`GPU ${(c1.transcribeMs / g2.transcribeMs).toFixed(1)}x mais rápida que a CPU (2ª vez); ${(c1.transcribeMs / g1.transcribeMs).toFixed(1)}x (1ª vez)`);
    assert.ok(g2.transcribeMs < c1.transcribeMs, 'a placa é mais rápida que o processador');
    console.log(`MEDICAO gpu1=${g1.transcribeMs}ms gpu2=${g2.transcribeMs}ms cpu=${c1.transcribeMs}ms audio=${g1.audioSec}s speedGpu1=${g1.speed} speedGpu2=${g2.speed} speedCpu=${c1.speed} vram=${gpu1.baselineMb}->${gpu1.maxUsedMb}MB`);
  } finally { H.cleanup(media); releaseLock(); }
});

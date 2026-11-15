'use strict';

/**
 * Escolha do dispositivo da transcrição: GPU (placa NVIDIA, motor CUDA) ou CPU (dono: subtitles).
 *
 *  - engineKindOf(exe): o motor é CUDA se a pasta dele traz a biblioteca `ggml-cuda` (o pacote oficial CUDA do whisper.cpp
 *    traz também as DLLs de CPU, então roda sem placa com `-ng`); senão é CPU. Vale para o motor instalado aqui e para o
 *    que o hospedeiro (BDS) fornece.
 *  - planDevice(): modo 'auto' (padrão) | 'gpu' | 'cpu' + placa detectada + tipo do motor + falha lembrada -> onde rodar.
 *  - gpuMemoryAdvice(): avisa quando o modelo provavelmente não cabe na memória da placa.
 *  - GpuFailureMemory: lembra que a placa falhou (por motor + modelo) para não insistir (como o BDS faz).
 *  - parseWhisperLog(): lê o log do whisper-cli e diz se a placa foi usada ou deu erro.
 */

const fs = require('node:fs');
const path = require('node:path');

const MODES = Object.freeze(['auto', 'gpu', 'cpu']);
const CUDA_LIBS = Object.freeze(['ggml-cuda.dll', 'libggml-cuda.so']);

function normalizeMode(mode) {
  return MODES.includes(mode) ? mode : 'auto';
}

/** 'cuda' se a pasta do executável tem a biblioteca ggml-cuda; 'cpu' no resto. */
function engineKindOf(exe, { exists = (p) => fs.existsSync(p) } = {}) {
  if (!exe) return 'cpu';
  const dir = path.dirname(exe);
  return CUDA_LIBS.some((lib) => exists(path.join(dir, lib))) ? 'cuda' : 'cpu';
}

/**
 * Memória de vídeo estimada para um modelo: o arquivo (ggml) + ~15% de estado + ~0,5 GB de buffers de cálculo.
 * É uma estimativa conservadora para o aviso; quem decide de verdade é o CUDA (e o fallback cobre o erro).
 */
function estimateVramMb(model) {
  if (!model || !Number.isFinite(model.sizeBytes)) return null;
  return Math.round((model.sizeBytes * 1.15) / (1024 * 1024) + 500);
}

/**
 * @returns {{ level:'ok'|'tight'|'no'|'unknown', needMb:number|null, memoryMb:number|null, message:string }}
 *   no     provavelmente NÃO cabe (no modo automático vai direto para o processador)
 *   tight  cabe por pouco (usa a placa; se faltar memória, o fallback cuida)
 */
function gpuMemoryAdvice(model, gpu) {
  const needMb = estimateVramMb(model);
  const memoryMb = gpu && gpu.memoryMb ? gpu.memoryMb : null;
  if (!needMb || !memoryMb) return { level: 'unknown', needMb, memoryMb, message: '' };
  const gb = (mb) => (Math.round(mb / 102.4) / 10).toLocaleString('pt-BR');
  const label = model.label || model.id;
  if (needMb > memoryMb * 0.92) {
    return { level: 'no', needMb, memoryMb, message: `O modelo ${label} precisa de ~${gb(needMb)} GB e a placa tem ${gb(memoryMb)} GB: provavelmente não cabe. Use um modelo menor (ex.: Large v3 Turbo) para usar a placa.` };
  }
  if (needMb > memoryMb * 0.75) {
    return { level: 'tight', needMb, memoryMb, message: `O modelo ${label} usa quase toda a memória da placa (~${gb(needMb)} de ${gb(memoryMb)} GB); feche outros programas pesados. Se faltar memória, o processador assume sozinho.` };
  }
  return { level: 'ok', needMb, memoryMb, message: '' };
}

/** Lembra falhas da placa. Chave: motor + modelo (falta de memória é do modelo; driver quebrado cai em todos). */
class GpuFailureMemory {
  constructor() { this.map = new Map(); }
  key(exe, modelId) { return `${String(exe || '').toLowerCase()}|${modelId || ''}`; }
  get(exe, modelId) { return this.map.get(this.key(exe, modelId)) || null; }
  set(exe, modelId, reason) { this.map.set(this.key(exe, modelId), { reason: String(reason || 'erro da placa'), at: Date.now() }); }
  clear(exe, modelId) { this.map.delete(this.key(exe, modelId)); }
  clearAll() { this.map.clear(); }
  last() { let out = null; for (const v of this.map.values()) out = v; return out; }
}

/**
 * @param {{ mode?:string, gpu?:object|null, engineKind:'cuda'|'cpu', failure?:{reason:string}|null, advice?:{level:string,message:string}|null }} o
 * @returns {{ useGpu:boolean, why:string|null, note:string|null }}
 *   why   código do motivo de NÃO usar a placa: 'forced-cpu' | 'no-cuda-engine' | 'no-gpu' | 'remembered-failure' | 'no-memory'
 *   note  frase em português para mostrar ao usuário quando a placa deixou de ser usada por um motivo que ele precisa saber
 */
function planDevice({ mode = 'auto', gpu = null, engineKind = 'cpu', failure = null, advice = null } = {}) {
  const m = normalizeMode(mode);
  if (m === 'cpu') return { useGpu: false, why: 'forced-cpu', note: null };
  if (engineKind !== 'cuda') {
    return { useGpu: false, why: 'no-cuda-engine', note: m === 'gpu' ? 'O motor com placa NVIDIA não está instalado: usando o processador.' : null };
  }
  if (m === 'gpu') return { useGpu: true, why: null, note: null }; // escolha explícita: tenta (o fallback cobre o erro)
  if (!gpu || !gpu.available) return { useGpu: false, why: 'no-gpu', note: null };
  if (failure) return { useGpu: false, why: 'remembered-failure', note: `A placa falhou antes (${failure.reason}): usando o processador. Escolha "Placa (GPU)" nos ajustes do motor para tentar de novo.` };
  if (advice && advice.level === 'no') return { useGpu: false, why: 'no-memory', note: advice.message ? `${advice.message} Usando o processador.` : 'O modelo não cabe na memória da placa: usando o processador.' };
  return { useGpu: true, why: null, note: null };
}

/** Linhas do log do whisper-cli -> { sawGpu, cudaError, device }. Chame com cada linha; leia `state` no fim. */
function createLogWatcher() {
  const state = { sawGpu: false, cudaError: false, device: null };
  const feed = (line) => {
    const dev = /^\s*Device \d+: (.+?), compute capability/.exec(line);
    if (dev && !state.device) state.device = dev[1];
    const backend = /whisper_backend_init_gpu: using (\S+) backend/.exec(line);
    if (backend && !/CPU/i.test(backend[1])) state.sawGpu = true;
    if (/ggml_cuda_init: failed|CUDA error|cudaMalloc failed|failed to allocate|out of memory|CUBLAS_STATUS|cudaGetDeviceCount|no CUDA-capable device/i.test(line)) state.cudaError = true;
  };
  return { state, feed };
}

module.exports = { MODES, CUDA_LIBS, normalizeMode, engineKindOf, estimateVramMb, gpuMemoryAdvice, GpuFailureMemory, planDevice, createLogWatcher };

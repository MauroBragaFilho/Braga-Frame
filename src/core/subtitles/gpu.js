'use strict';

/**
 * Detecção da placa de vídeo NVIDIA para a transcrição (dono: subtitles). Consulta REAL do driver: roda o `nvidia-smi`
 * (que só existe com o driver instalado) com prazo curto; sem ele, no Windows, só confirma pelo sistema se há uma
 * placa NVIDIA (sem driver não há CUDA). O resultado fica em cache (não consulta a cada abertura da aba) e nunca trava:
 * qualquer falha vira "sem placa utilizável" com o motivo.
 *
 * Resultado: { available, name, memoryMb, driver, driverOk, source, reason, checkedAt }
 *   available  a placa pode ser usada pelo CUDA (driver presente e novo o bastante)
 *   source     'nvidia-smi' | 'system' | null
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const QUERY = ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'];
const TIMEOUT_MS = 4000;
const OK_TTL_MS = 10 * 60 * 1000;
const FAIL_TTL_MS = 60 * 1000;
/** Driver mínimo (Windows) para os pacotes CUDA 12.x do whisper.cpp (compatibilidade entre versões menores do CUDA 12). */
const MIN_DRIVER_MAJOR = 527;

function candidates(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return ['nvidia-smi'];
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  const pf = env.ProgramFiles || 'C:\\Program Files';
  return [path.join(root, 'System32', 'nvidia-smi.exe'), path.join(pf, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'), 'nvidia-smi'];
}

/** Saída do nvidia-smi (CSV sem cabeçalho) -> [{ name, memoryMb, driver }]. Linhas que não fazem sentido são ignoradas. */
function parseNvidiaSmi(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 3 || !parts[0]) continue;
    const memoryMb = Number(parts[1]);
    if (!Number.isFinite(memoryMb) || memoryMb <= 0 || !/^\d+(\.\d+)*$/.test(parts[2])) continue;
    out.push({ name: parts[0], memoryMb: Math.round(memoryMb), driver: parts[2] });
  }
  return out;
}

const driverMajor = (driver) => Number(String(driver || '').split('.')[0]) || 0;

function run(execFileFn, command, args, timeout) {
  return new Promise((resolve) => {
    try {
      execFileFn(command, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch { resolve(null); }
  });
}

/** Sem nvidia-smi (Windows): há alguma placa NVIDIA no sistema? Devolve o nome ou null. */
async function systemAdapterName(execFileFn, timeout) {
  const script = "Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA' } | Select-Object -First 1 -ExpandProperty Name";
  const out = await run(execFileFn, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], timeout * 2);
  const name = out && out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return name || null;
}

/**
 * Consulta a placa agora (sem cache).
 * @param {{ execFile?:Function, platform?:string, env?:object, timeoutMs?:number, exists?:(p:string)=>boolean }} [o]
 */
async function queryNvidia(o = {}) {
  const execFileFn = o.execFile || execFile;
  const platform = o.platform || process.platform;
  const timeout = o.timeoutMs || TIMEOUT_MS;
  const exists = o.exists || ((p) => fs.existsSync(p));
  const base = { available: false, name: null, memoryMb: null, driver: null, driverOk: false, source: null, reason: '', checkedAt: Date.now() };

  for (const exe of candidates(platform, o.env || process.env)) {
    if (path.isAbsolute(exe) && !exists(exe)) continue;
    const text = await run(execFileFn, exe, QUERY, timeout);
    const gpus = text ? parseNvidiaSmi(text) : [];
    if (!gpus.length) continue;
    const best = gpus.reduce((a, b) => (b.memoryMb > a.memoryMb ? b : a)); // várias placas: a de mais memória
    const driverOk = driverMajor(best.driver) >= MIN_DRIVER_MAJOR;
    return {
      ...base, available: driverOk, name: best.name, memoryMb: best.memoryMb, driver: best.driver, driverOk, source: 'nvidia-smi',
      reason: driverOk ? '' : `O driver da NVIDIA (${best.driver}) é antigo demais para a aceleração; atualize o driver para usar a placa.`
    };
  }
  if (platform === 'win32') {
    const name = await systemAdapterName(execFileFn, timeout);
    if (name) return { ...base, name, source: 'system', reason: 'Há uma placa NVIDIA, mas o driver dela não respondeu (nvidia-smi ausente). Instale ou atualize o driver para usar a placa.' };
  }
  return { ...base, reason: 'Nenhuma placa NVIDIA com driver foi encontrada; a transcrição usa o processador.' };
}

let cache = null;
let inflight = null;

/** Como queryNvidia, com cache (10 min se achou a placa, 1 min se não) e uma única consulta por vez. */
async function detectNvidia(o = {}) {
  const now = Date.now();
  if (!o.refresh && cache && now - cache.checkedAt < (cache.name ? OK_TTL_MS : FAIL_TTL_MS)) return cache;
  if (!inflight) {
    inflight = queryNvidia(o).then((r) => { cache = r; return r; }).finally(() => { inflight = null; });
  }
  return inflight;
}

function resetGpuCache() { cache = null; inflight = null; }

/** "NVIDIA GeForce GTX 1650 · 4 GB" */
function describeGpu(gpu) {
  if (!gpu || !gpu.name) return '';
  if (!gpu.memoryMb) return gpu.name;
  const gb = gpu.memoryMb / 1024;
  const text = gb >= 10 ? String(Math.round(gb)) : String(Math.round(gb * 10) / 10).replace('.', ',');
  return `${gpu.name} · ${text} GB`;
}

module.exports = { parseNvidiaSmi, queryNvidia, detectNvidia, resetGpuCache, describeGpu, candidates, MIN_DRIVER_MAJOR, QUERY };

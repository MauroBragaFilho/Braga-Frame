'use strict';

/**
 * Monitor de recursos do computador (CPU, memória, disco, placa NVIDIA), para a fila de exportação e a tela Exportações.
 * Só LÊ: nada aqui muda o sistema, a não ser `lowerPriority`, que baixa a prioridade de um processo nosso (o ffmpeg).
 *
 *   sample({ dirs })  -> { at, cpu:{ percent|null, cores }, memory:{ totalMb, freeMb }, disks:[{ dir, freeMb|null }], gpu:{ name, utilPercent, memUsedMb, memTotalMb }|null }
 *   freeMemoryMb()    -> número (síncrono, para a fila decidir na hora de abrir uma vaga)
 *
 * A porcentagem de CPU é a média entre duas leituras (a primeira devolve null). A placa vem do `nvidia-smi`, com prazo curto e cache de
 * alguns segundos; sem driver ou com qualquer falha, `gpu` é null (nunca lança). Os módulos do sistema entram por parâmetro para os testes.
 */

const os = require('node:os');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { candidates } = require('../subtitles/gpu');

const GPU_QUERY = ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'];
const GPU_TIMEOUT_MS = 2500;
const GPU_TTL_MS = 2000;
const MB = 1024 * 1024;

/** Saída do nvidia-smi (CSV sem cabeçalho) -> [{ name, utilPercent, memUsedMb, memTotalMb }]. Linhas ilegíveis são ignoradas. */
function parseGpuUsage(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 4 || !parts[0]) continue;
    const [util, used, total] = parts.slice(1, 4).map(Number);
    if (![util, used, total].every(Number.isFinite) || total <= 0) continue;
    out.push({ name: parts[0], utilPercent: Math.min(100, Math.max(0, Math.round(util))), memUsedMb: Math.round(used), memTotalMb: Math.round(total) });
  }
  return out;
}

/** Soma dos tempos de todos os núcleos: { idle, total }. */
function cpuTimes(osModule) {
  let idle = 0;
  let total = 0;
  for (const cpu of osModule.cpus() || []) {
    const t = cpu.times || {};
    const sum = (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
    idle += t.idle || 0;
    total += sum;
  }
  return { idle, total };
}

function createResourceMonitor({ osModule = os, fsModule = fs, execFileFn = execFile, platform = process.platform, env = process.env, now = Date.now, existsFn = (p) => fs.existsSync(p) } = {}) {
  let lastCpu = null;
  let gpuCache = { at: -Infinity, value: null };

  const freeMemoryMb = () => Math.round(osModule.freemem() / MB);

  function cpuPercent() {
    const cur = cpuTimes(osModule);
    const prev = lastCpu;
    lastCpu = cur;
    if (!prev) return null;
    const total = cur.total - prev.total;
    if (!(total > 0)) return null;
    return Math.min(100, Math.max(0, Math.round((1 - (cur.idle - prev.idle) / total) * 100)));
  }

  function diskFreeMb(dir) {
    try {
      const st = fsModule.statfsSync(dir);
      const bytes = Number(st.bavail) * Number(st.bsize);
      return Number.isFinite(bytes) ? Math.round(bytes / MB) : null;
    } catch { return null; }
  }

  function queryGpu() {
    return new Promise((resolve) => {
      const tryNext = (list) => {
        const exe = list.shift();
        if (!exe) { resolve(null); return; }
        if (/[\\/]/.test(exe) && !existsFn(exe)) { tryNext(list); return; }
        try {
          execFileFn(exe, GPU_QUERY, { timeout: GPU_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout) => {
            const gpus = err ? [] : parseGpuUsage(stdout);
            if (!gpus.length) { tryNext(list); return; }
            resolve(gpus.reduce((a, b) => (b.memTotalMb > a.memTotalMb ? b : a))); // várias placas: a de mais memória
          });
        } catch { tryNext(list); }
      };
      tryNext([...candidates(platform, env)]);
    });
  }

  async function gpu() {
    const t = now();
    if (t - gpuCache.at < GPU_TTL_MS) return gpuCache.value;
    const value = await queryGpu();
    gpuCache = { at: now(), value };
    return value;
  }

  async function sample({ dirs = [] } = {}) {
    const list = [...new Set((Array.isArray(dirs) ? dirs : []).filter((d) => typeof d === 'string' && d))].slice(0, 6);
    return {
      at: now(),
      cpu: { percent: cpuPercent(), cores: (osModule.cpus() || []).length },
      memory: { totalMb: Math.round(osModule.totalmem() / MB), freeMb: freeMemoryMb() },
      disks: list.map((dir) => ({ dir, freeMb: diskFreeMb(dir) })),
      gpu: await gpu()
    };
  }

  return { sample, freeMemoryMb, diskFreeMb };
}

/**
 * Baixa a prioridade de um processo nosso (melhor esforço: sem permissão ou processo já encerrado, nada acontece).
 * @returns {boolean} true se mudou
 */
function lowerPriority(pid, osModule = os) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    osModule.setPriority(pid, osModule.constants.priority.PRIORITY_BELOW_NORMAL);
    return true;
  } catch { return false; }
}

module.exports = { createResourceMonitor, parseGpuUsage, lowerPriority, GPU_QUERY };

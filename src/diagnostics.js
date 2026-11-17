'use strict';

/**
 * Diagnóstico de ambiente: texto sem segredos (nada de chaves nem do conteúdo dos projetos) para o suporte.
 * `collectDiagnostics` é puro: recebe os dados; quem chama (main.js) fornece os valores do Electron.
 */

const os = require('node:os');
const fs = require('node:fs');
const { findTools } = require('./core/ffmpeg/locate');

const TOOLS = [
  { key: 'ffmpeg', name: 'ffmpeg', envVar: 'CORTE_FFMPEG' },
  { key: 'ffprobe', name: 'ffprobe', envVar: 'CORTE_FFPROBE' },
  { key: 'ytdlp', name: 'yt-dlp', envVar: 'CORTE_YTDLP' }
];

function collectDiagnostics({ appName, version, electron, chrome, node, userDataDir, isPackaged, env = process.env, findToolsImpl = findTools } = {}) {
  const tools = findToolsImpl(TOOLS, env);
  const cpus = os.cpus() || [];
  let writable = false;
  if (userDataDir) {
    try { fs.mkdirSync(userDataDir, { recursive: true }); fs.accessSync(userDataDir, fs.constants.W_OK); writable = true; } catch { /* mostrado no relatório */ }
  }
  return {
    app: { name: appName || 'Braga Frame', version: version || 'desconhecida', packaged: Boolean(isPackaged) },
    runtime: { electron: electron || process.versions.electron || null, chrome: chrome || process.versions.chrome || null, node: node || process.versions.node },
    system: {
      platform: process.platform, release: os.release(), arch: process.arch,
      cpu: cpus[0] ? cpus[0].model.trim() : null, cores: cpus.length,
      ramGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10, freeRamGB: Math.round((os.freemem() / 1024 ** 3) * 10) / 10
    },
    data: { userDataDir: userDataDir || null, writable },
    tools: Object.fromEntries(TOOLS.map((spec) => [spec.key, tools[spec.key] || null]))
  };
}

function formatDiagnostics(d) {
  const lines = [
    `${d.app.name} ${d.app.version}${d.app.packaged ? '' : ' (desenvolvimento)'}`,
    `Electron ${d.runtime.electron} · Chromium ${d.runtime.chrome} · Node ${d.runtime.node}`,
    `Sistema: ${d.system.platform} ${d.system.release} ${d.system.arch} · ${d.system.cpu || 'CPU desconhecida'} (${d.system.cores} núcleos) · RAM ${d.system.freeRamGB}/${d.system.ramGB} GB livres`,
    `Dados: ${d.data.userDataDir || 'indefinido'} (${d.data.writable ? 'gravável' : 'SEM permissão de escrita'})`,
    'Ferramentas:'
  ];
  for (const [key, file] of Object.entries(d.tools)) lines.push(`  ${key}: ${file || 'NÃO ENCONTRADA'}`);
  return lines.join('\n');
}

const GPU_VENDORS = Object.freeze({ 0x10de: 'NVIDIA', 0x8086: 'Intel', 0x1002: 'AMD', 0x1022: 'AMD', 0x1414: 'Microsoft' });

/** As placas de vídeo de `app.getGPUInfo('basic')` do Electron, sem repetição: [{ name, vendor, driver }]. */
function summarizeGpus(info) {
  const devices = info && Array.isArray(info.gpuDevice) ? info.gpuDevice : [];
  const seen = new Set();
  const out = [];
  for (const d of devices) {
    if (!d || typeof d !== 'object') continue;
    const name = String(d.deviceString || '').trim() || `Placa ${Number(d.vendorId || 0).toString(16)}:${Number(d.deviceId || 0).toString(16)}`;
    const driver = d.driverVersion ? String(d.driverVersion) : null;
    const key = `${name}|${driver}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, vendor: GPU_VENDORS[d.vendorId] || null, driver });
  }
  return out;
}

/** O que o FFmpeg consegue codificar (resultado de encoders.detectEncoders) em uma linha; sem FFmpeg diz isso. */
function describeEncoders(detection) {
  if (!detection || !detection.ffmpeg) return 'FFmpeg não encontrado: sem exportação.';
  const yes = (ok) => (ok ? 'sim' : 'não');
  const nv = (kind) => {
    const e = detection.nvenc && detection.nvenc[kind];
    return e && e.available ? 'sim' : `não${e && e.reason ? ` (${String(e.reason).split('\n')[0].slice(0, 90)})` : ''}`;
  };
  const sw = detection.software || {};
  return `H.264 por software: ${yes(sw.h264)} · H.265 por software: ${yes(sw.h265)} · H.264 NVENC (placa NVIDIA): ${nv('h264')} · H.265 NVENC: ${nv('h265')}`;
}

/** Troca a pasta pessoal (que carrega o nome do usuário do Windows) por `~`, sem diferenciar maiúsculas no Windows. */
function redactHome(text, home) {
  const dir = String(home || '').replace(/[\\/]+$/, '');
  if (dir.length < 4) return String(text);
  // cada trecho do caminho vira texto literal e as barras (\ ou /) casam com qualquer uma das duas
  const pattern = dir.split(/[\\/]/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]');
  return String(text).replace(new RegExp(pattern, process.platform === 'win32' ? 'gi' : 'g'), '~');
}

/**
 * O relatório que o usuário copia e manda para o suporte (tela Geral > Suporte): o diagnóstico de sempre mais as placas de vídeo e o que o
 * FFmpeg codifica. Sem segredos nem conteúdo de projetos; a pasta pessoal sai como "~" (o nome de usuário do Windows não vai junto).
 */
function formatSupportReport(diagnostics, { gpus = [], encoders = null, logFile = null, home = os.homedir(), now = new Date() } = {}) {
  const lines = [formatDiagnostics(diagnostics), 'Placas de vídeo:'];
  if (gpus.length) for (const g of gpus) lines.push(`  ${g.name}${g.driver ? ` (driver ${g.driver})` : ''}`);
  else lines.push('  não informadas pelo sistema');
  lines.push(`Codificação: ${describeEncoders(encoders)}`);
  if (logFile) lines.push(`Registro: ${logFile}`);
  lines.push(`Gerado em ${now.toISOString()}`);
  return redactHome(lines.join('\n'), home);
}

module.exports = { collectDiagnostics, formatDiagnostics, summarizeGpus, describeEncoders, redactHome, formatSupportReport };

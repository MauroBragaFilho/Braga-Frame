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

module.exports = { collectDiagnostics, formatDiagnostics };

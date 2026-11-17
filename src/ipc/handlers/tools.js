'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const registry = require('../../core/tools/registry');
const { toolKeyFor } = require('../../core/tools/catalog');
const { ToolInstaller } = require('../../core/tools/ToolInstaller');

/**
 * FFmpeg e FFprobe: a primeira parte da tela ("No seu computador") mostra o que está em uso, venha de onde vier: do sistema (PATH ou CORTE_*), do
 * hospedeiro ou da instalação do app (a entrada `ffmpeg` do catálogo, com o ffprobe do mesmo pacote).
 */
const SYSTEM_TOOLS = Object.freeze([
  { key: 'ffmpeg', label: 'FFmpeg' },
  { key: 'ffprobe', label: 'FFprobe' }
]);

const VERSION_TIMEOUT_MS = 5000;
const VERSION_RETRY_MS = 60 * 1000; // versão que não saiu: não insiste a cada chamada

function fail(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

/**
 * "ffmpeg version 7.1.1-essentials_build-www.gyan.dev Copyright…" -> "7.1.1-essentials_build-www.gyan.dev".
 * Compilações por data ou git viram um nome curto ("build 2026-02-09", "build N-125875").
 */
function parseVersion(text) {
  const m = /\bversion\s+(\S+)/i.exec(String(text || '').split(/\r?\n/)[0]);
  if (!m) return null;
  const token = m[1].replace(/^n(?=\d)/, ''); // versões de tag git: "n7.1.1" -> "7.1.1"
  const byDate = /^(\d{4}-\d{2}-\d{2})-git-/.exec(token);
  if (byDate) return `build ${byDate[1]}`;
  const byGit = /^(N-\d+)-g[0-9a-f]+/i.exec(token);
  if (byGit) return `build ${byGit[1]}`;
  return token;
}

/** "2026.03.17" (yt-dlp --version) ou "deno 2.1.4 (stable)" (deno --version) -> "2026.03.17" / "2.1.4". */
function parseSimpleVersion(text) {
  const first = String(text || '').split(/\r?\n/)[0].trim();
  const m = /^(?:deno\s+)?(\d[\w.+-]*)/i.exec(first);
  return m ? m[1] : null;
}

/** Como obter a versão de uma ferramenta fornecida pelo hospedeiro (que não tem registro de instalação do app). */
const VERSION_ARGS = Object.freeze({ ytdlp: ['--version'], deno: ['--version'] });

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

function register(ctx) {
  const catalog = ctx.toolCatalog || { entries: registry.getEntries(), allowLoopbackHttp: false, testIds: [] };
  const testIds = new Set(catalog.testIds || []);
  const installer = new ToolInstaller({
    toolsDir: ctx.paths.tools,
    entries: catalog.entries,
    allowLoopbackHttp: Boolean(catalog.allowLoopbackHttp)
  });
  installer.cleanupStaging(); // resíduos de uma instalação que o app não chegou a terminar

  // progresso -> renderer (e para quem escuta o bus do processo principal)
  installer.on('progress', (ev) => {
    const payload = {
      id: ev.id, label: ev.label, phase: ev.phase, message: ev.message, percent: ev.percent,
      received: ev.receivedBytes, total: ev.totalBytes, speedBps: ev.speedBps
    };
    ctx.bus.emit('tools:progress', payload);
    ctx.send('tools:progress', payload);
  });
  // fechar o app no meio de uma instalação a cancela (a pasta de trabalho sobra no máximo até a próxima abertura)
  if (ctx.app && typeof ctx.app.on === 'function') ctx.app.on('before-quit', () => { installer.cancelAll(); });

  // ---------- auxiliares ----------

  function entryOf(id) {
    if (typeof id !== 'string' || !id) throw fail('INVALID_ARGS', 'Informe qual ferramenta (id).');
    const entry = catalog.entries.find((e) => e.id === id);
    if (!entry) throw fail('UNKNOWN_TOOL', `Ferramenta desconhecida: ${id}.`);
    return entry;
  }

  /** Recusa a operação enquanto algum módulo (fila, legendas, fontes…) declara que usa a ferramenta. */
  function assertNotInUse(entry, verb) {
    const why = ctx.toolUsage ? ctx.toolUsage.inUse(toolKeyFor(entry.id), entry.id) : null;
    if (why) {
      throw fail('TOOL_IN_USE', `Não é possível ${verb} ${entry.label} agora: ${why}. Espere terminar (ou cancele) e tente de novo.`);
    }
  }

  /** Reconfere as ferramentas e avisa o renderer (tools:changed) mesmo que `ctx.tools` não tenha mudado. */
  const announce = () => ctx.refreshTools({ force: true });

  const versionCache = new Map(); // "caminho|mtime|tamanho" -> { version, at }
  async function versionOf(exe, args = ['-version']) {
    let st;
    try { st = await fs.promises.stat(exe); } catch { return null; }
    const key = `${exe}|${st.mtimeMs}|${st.size}|${args.join(' ')}`;
    const cached = versionCache.get(key);
    if (cached && (cached.version || Date.now() - cached.at < VERSION_RETRY_MS)) return cached.version;
    const output = await new Promise((resolve) => {
      try {
        execFile(exe, args, { timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
      } catch {
        resolve(null); // no Windows um arquivo que não é programa lança na hora (spawn UNKNOWN)
      }
    });
    const version = args[0] === '-version' ? parseVersion(output) : parseSimpleVersion(output);
    versionCache.set(key, { version, at: Date.now() });
    return version;
  }

  const host = ctx.host || { embedded: false, name: null, tool: () => null };
  /** Chave da ferramenta no hospedeiro (as de ctx.tools e o Deno), ou null. */
  const hostKeyOf = (entry) => toolKeyFor(entry.id) || (String(entry.id).toLowerCase() === 'deno' ? 'deno' : null);
  /** Caminho que o hospedeiro fornece para a ferramenta (ele é o dono: o app não instala outra cópia), ou null. */
  const providedByHost = (entry) => {
    const key = hostKeyOf(entry);
    return key ? host.tool(key) : null;
  };
  /** O motor com placa NVIDIA (whisper-cuda) não é instalado aqui quando o hospedeiro já fornece o motor do Whisper (ele é o dono). */
  const cudaSuppressedByHost = (entry) => entry.id === 'whisper-cuda' && Boolean(host.tool('whisper'));

  /** Caminho do ffmpeg ou do ffprobe que o APP instalou (o ffprobe vem do mesmo pacote), ou null. */
  function appInstalled(key) {
    if (key === 'ffmpeg') return (installer.status().find((row) => row.id === 'ffmpeg') || {}).path || null;
    return registry.resolveExtras(ctx.paths.tools, 'ffmpeg', { entries: catalog.entries })[key] || null;
  }

  async function buildStatus() {
    const system = await Promise.all(SYSTEM_TOOLS.map(async ({ key, label }) => {
      const exe = ctx.tools[key] || null;
      const fromHost = Boolean(exe) && samePath(exe, host.tool(key));
      let origin = null;
      if (exe) origin = fromHost ? 'host' : (samePath(exe, appInstalled(key)) ? 'app' : 'system');
      return { id: key, label, found: Boolean(exe), path: exe, version: exe ? await versionOf(exe) : null, origin };
    }));

    const tools = await Promise.all(installer.status().filter((row) => !cudaSuppressedByHost(row)).map(async (row) => {
      const key = toolKeyFor(row.id);
      const hostPath = providedByHost(row);
      const active = hostPath || (key ? ctx.tools[key] || null : row.path);
      let origin = null;
      if (active) origin = hostPath ? 'host' : (samePath(active, row.path) ? 'app' : 'system');
      const hostKey = hostKeyOf(row);
      return {
        id: row.id, label: row.label, version: row.version, source: row.source, sizeBytes: row.sizeBytes,
        available: row.available, unavailableReason: row.unavailableReason,
        installed: row.installed, installedVersion: row.installedVersion, outdated: row.outdated, installedAt: row.installedAt,
        busy: row.busy,
        active: { origin, path: active, ...(origin === 'host' ? { version: VERSION_ARGS[hostKey] ? await versionOf(active, VERSION_ARGS[hostKey]) : null } : {}) },
        test: testIds.has(row.id.toLowerCase())
      };
    }));
    return { platform: process.platform, host: { embedded: Boolean(host.embedded), name: host.name || null }, system, tools };
  }

  // ---------- canais ----------

  // situação de tudo: ffmpeg/ffprobe do sistema (com versão) + ferramentas do registro
  ctx.handle('tools:status', () => buildStatus());

  // instala (ou atualiza) a ferramenta oficial; resolve quando termina (o progresso vai por tools:progress)
  ctx.handle('tools:install', async ({ id, force }) => {
    const entry = entryOf(id);
    if (cudaSuppressedByHost(entry)) {
      throw fail('HOST_PROVIDED', `O motor do Whisper vem do ${host.name || 'aplicativo que abriu o Braga Frame'}: o Braga Frame não baixa um motor próprio. A aceleração por placa depende do motor dele.`);
    }
    const hostPath = providedByHost(entry);
    if (hostPath) {
      throw fail('HOST_PROVIDED', `${entry.label} já vem do ${host.name || 'aplicativo que abriu o Braga Frame'} (${hostPath}). Para atualizar ou trocar, use as configurações dele: o Braga Frame não guarda uma segunda cópia.`);
    }
    const row = installer.status().find((s) => s.id === entry.id);
    if (force === true || (row && row.outdated)) assertNotInUse(entry, force === true ? 'reinstalar' : 'atualizar');
    ctx.log('info', `ferramentas: instalando ${entry.id} ${entry.version}`);
    const res = await installer.install(entry.id, { force: force === true });
    announce();
    return { id: res.id, version: res.version, path: res.exe, alreadyInstalled: res.alreadyInstalled };
  });

  // cancela a instalação em andamento (a chamada de tools:install volta com CANCELLED)
  ctx.handle('tools:cancel', ({ id }) => ({ cancelled: installer.cancel(entryOf(id).id) }));

  // remove tudo que o app instalou dessa ferramenta; o app volta a usar a do sistema, se houver
  ctx.handle('tools:remove', async ({ id }) => {
    const entry = entryOf(id);
    if (fs.existsSync(path.join(ctx.paths.tools, entry.id))) assertNotInUse(entry, 'remover');
    const res = await installer.remove(entry.id);
    if (res.removed) ctx.log('info', `ferramentas: ${entry.id} removido`);
    announce();
    return res;
  });
}

module.exports = { register, parseVersion, SYSTEM_TOOLS };

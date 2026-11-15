'use strict';

/**
 * Registro das ferramentas oficiais (docs/arquitetura.md 3.7 e docs/recursos/tools.md).
 *
 *  - Carrega as entradas de src/core/tools/entries/<id>.js e valida o formato de cada uma.
 *  - Escolhe o pacote certo para o sistema ("win32-x64", "linux-arm64"...).
 *  - Diz o que está instalado de verdade: resolveInstalled() reconfere o manifesto e o executável
 *    no disco a cada chamada (nunca confia em estado em memória).
 *
 * Este arquivo não baixa nem grava nada; quem instala é o ToolInstaller.
 */

const fs = require('node:fs');
const path = require('node:path');

const ENTRIES_DIR = path.join(__dirname, 'entries');
const MANIFEST_NAME = 'manifest.json';
const MANIFEST_SCHEMA = 1;
const KINDS = ['zip', 'tar.gz', 'file'];

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const PLATFORM_KEY_RE = /^(win32|linux|darwin)-(x64|arm64|ia32|arm)$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;

class ToolError extends Error {
  constructor(message, code = 'TOOL_ERROR', extra = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/** Nome de arquivo simples (sem pasta, sem dois-pontos, sem "." nem ".."). */
function isSafeFileName(name) {
  return nonEmptyString(name) && !/[\\/:\0]/.test(name) && name !== '.' && name !== '..';
}

/** Caminho relativo seguro, com "/" como separador: sem "..", sem raiz, sem letra de unidade. */
function isSafeRelPath(p) {
  if (!nonEmptyString(p) || /[\\:\0]/.test(p) || p.startsWith('/')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1';
}

/** Extensão do pacote -> tipo. Sem extensão de arquivo compactado, o próprio arquivo é o executável. */
function inferKind(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.zip')) return 'zip';
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tar.gz';
  return 'file';
}

// ------------------------------------------------------------------ validação

function validateAsset(key, asset, { allowLoopbackHttp = false } = {}) {
  const at = `assets["${key}"]`;
  const errors = [];
  if (!PLATFORM_KEY_RE.test(key)) errors.push(`${at}: chave inválida (use "<sistema>-<arquitetura>", ex.: "win32-x64")`);
  if (!isPlainObject(asset)) return [...errors, `${at}: deve ser um objeto`];

  if (!nonEmptyString(asset.url)) {
    errors.push(`${at}.url ausente`);
  } else {
    let u = null;
    try { u = new URL(asset.url); } catch { errors.push(`${at}.url não é uma URL válida`); }
    if (u && u.protocol !== 'https:' && !(allowLoopbackHttp && u.protocol === 'http:' && isLoopbackHost(u.hostname))) {
      errors.push(`${at}.url precisa ser https`);
    }
  }
  if (!isSafeFileName(asset.name)) errors.push(`${at}.name inválido (nome de arquivo simples, ex.: "whisper-bin-x64.zip")`);
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) errors.push(`${at}.size deve ser o tamanho exato do pacote, em bytes (inteiro positivo)`);
  if (typeof asset.sha256 !== 'string' || !SHA256_RE.test(asset.sha256)) errors.push(`${at}.sha256 deve ter 64 caracteres hexadecimais`);
  if (!isSafeRelPath(asset.exe)) errors.push(`${at}.exe inválido (caminho relativo com "/", sem "..", ex.: "bin/tool.exe")`);
  if (asset.kind !== undefined && !KINDS.includes(asset.kind)) errors.push(`${at}.kind deve ser um de: ${KINDS.join(', ')}`);

  const kind = KINDS.includes(asset.kind) ? asset.kind : inferKind(asset.name);
  if (asset.stripComponents !== undefined) {
    if (!Number.isInteger(asset.stripComponents) || asset.stripComponents < 0 || asset.stripComponents > 5) {
      errors.push(`${at}.stripComponents deve ser um inteiro de 0 a 5`);
    } else if (kind === 'file' && asset.stripComponents > 0) {
      errors.push(`${at}.stripComponents não se aplica a arquivo único`);
    }
  }
  if (kind === 'file' && isSafeRelPath(asset.exe) && asset.exe.includes('/')) {
    errors.push(`${at}.exe de arquivo único deve ser só o nome do arquivo (sem pastas)`);
  }
  return errors;
}

/** Lista de problemas da entrada (vazia = válida). */
function validateEntry(entry, opts = {}) {
  if (!isPlainObject(entry)) return ['a entrada deve ser um objeto'];
  const errors = [];
  if (typeof entry.id !== 'string' || !ID_RE.test(entry.id)) errors.push('id inválido (começa com letra; letras, números, "-" e "_"; até 40 caracteres)');
  if (!nonEmptyString(entry.label)) errors.push('label ausente');
  if (typeof entry.version !== 'string' || !VERSION_RE.test(entry.version)) errors.push('version inválida (ex.: "2025.01.15" ou "b5130"; sem barras)');
  if (!nonEmptyString(entry.source)) errors.push('source ausente (ex.: "oficial: https://github.com/…")');
  if (!isPlainObject(entry.assets) || Object.keys(entry.assets).length === 0) {
    errors.push('assets deve ter ao menos uma plataforma (ex.: "win32-x64")');
  } else {
    for (const [key, asset] of Object.entries(entry.assets)) errors.push(...validateAsset(key, asset, opts));
  }
  return errors;
}

function assertValidEntry(entry, opts = {}) {
  const errors = validateEntry(entry, opts);
  if (errors.length) {
    const who = isPlainObject(entry) && entry.id ? entry.id : '(sem id)';
    throw new ToolError(`Entrada de ferramenta inválida (${who}): ${errors.join('; ')}.`, 'INVALID_ENTRY', { details: errors });
  }
  return entry;
}

// ------------------------------------------------------------------ carga das entradas

/**
 * Carrega todo `<dir>/*.js` (menos arquivos que começam com "_" ou "."). Cada arquivo exporta a entrada.
 * O nome do arquivo precisa ser o id da entrada. Entrada inválida é descartada e vai para `errors`
 * (com `strict: true` lança em vez de descartar).
 * @returns {{ entries: object[], errors: {file:string, message:string}[] }}
 */
function loadRegistry({ dir = ENTRIES_DIR, strict = false, allowLoopbackHttp = false } = {}) {
  const entries = [];
  const errors = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_') && !f.startsWith('.')).sort(); } catch { files = []; }

  const seen = new Set();
  for (const file of files) {
    const full = path.join(dir, file);
    try {
      delete require.cache[require.resolve(full)];
      const loaded = require(full);
      const entry = isPlainObject(loaded) && isPlainObject(loaded.default) ? loaded.default : loaded;
      assertValidEntry(entry, { allowLoopbackHttp });
      if (path.basename(file, '.js').toLowerCase() !== entry.id.toLowerCase()) {
        throw new ToolError(`o arquivo deve se chamar ${entry.id}.js (o nome precisa ser o id da entrada)`, 'INVALID_ENTRY');
      }
      const key = entry.id.toLowerCase();
      if (seen.has(key)) throw new ToolError(`id repetido: ${entry.id}`, 'INVALID_ENTRY');
      seen.add(key);
      entries.push(entry);
    } catch (err) {
      const message = `${file}: ${err.message}`;
      if (strict) throw new ToolError(message, 'INVALID_ENTRY', { file });
      errors.push({ file, message });
    }
  }
  return { entries, errors };
}

let defaultRegistry = null;

/** Registro padrão (entries/ do app), carregado uma vez. `reload: true` recarrega do disco. */
function getRegistry({ reload = false } = {}) {
  if (!defaultRegistry || reload) defaultRegistry = loadRegistry();
  return defaultRegistry;
}

const getEntries = () => getRegistry().entries;
const getEntry = (id, entries = getEntries()) => entries.find((e) => e.id === id) || null;

// ------------------------------------------------------------------ plataforma

const SYSTEM_NAMES = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };
const ARCH_NAMES = { x64: '64 bits', arm64: 'ARM 64 bits', ia32: '32 bits', arm: 'ARM 32 bits' };

/** Pacote oficial para o sistema/arquitetura, já normalizado (kind, stripComponents, sha256 em minúsculas), ou null. */
function assetFor(entry, platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const asset = entry && entry.assets && entry.assets[key];
  if (!isPlainObject(asset)) return null;
  return {
    ...asset,
    key,
    kind: KINDS.includes(asset.kind) ? asset.kind : inferKind(asset.name),
    stripComponents: asset.stripComponents || 0,
    sha256: String(asset.sha256).toLowerCase()
  };
}

function unavailableReason(entry, platform = process.platform, arch = process.arch) {
  const sys = SYSTEM_NAMES[platform] || String(platform);
  const bits = ARCH_NAMES[arch] || String(arch);
  return `O projeto oficial não publica ${entry.label} para ${sys} (${bits}).`;
}

// ------------------------------------------------------------------ o que está instalado

const installDir = (toolsDir, id, version) => path.join(toolsDir, id, version);
const exePath = (dir, relExe) => path.join(dir, ...String(relExe).split('/'));

/** Lê o manifest.json de uma pasta de instalação; null se não existir ou não for de uma instalação nossa. */
function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), 'utf8'));
    return isPlainObject(m) && m.schema === MANIFEST_SCHEMA ? m : null;
  } catch {
    return null;
  }
}

/**
 * Confere no disco se a versão fixada da entrada está instalada e íntegra: manifesto presente e
 * coerente (id, versão, SHA-256 do pacote e executável iguais aos da entrada) e executável existente
 * com o tamanho gravado na instalação. Devolve { dir, exe, manifest } ou null.
 */
function checkInstalled(toolsDir, entry, asset) {
  if (!toolsDir || !entry || !asset) return null;
  const dir = installDir(toolsDir, entry.id, entry.version);
  const manifest = readManifest(dir);
  if (!manifest) return null;
  if (manifest.id !== entry.id || manifest.version !== entry.version) return null;
  if (String(manifest.sha256 || '').toLowerCase() !== asset.sha256) return null;
  if (manifest.exe !== asset.exe) return null;
  const exe = exePath(dir, asset.exe);
  let st;
  try { st = fs.statSync(exe); } catch { return null; }
  if (!st.isFile()) return null;
  if (Number.isSafeInteger(manifest.exeSize) && st.size !== manifest.exeSize) return null;
  return { dir, exe, manifest };
}

/** Versões instaladas de um id (qualquer uma com manifesto legível), mesmo que não seja a fixada hoje. */
function listInstalledVersions(toolsDir, id) {
  const base = path.join(toolsDir, id);
  let names = [];
  try { names = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  const out = [];
  for (const version of names) {
    const dir = path.join(base, version);
    const manifest = readManifest(dir);
    if (manifest && manifest.id === id && manifest.version === version) out.push({ version, dir, manifest });
  }
  return out;
}

function resolveOptions(opts = {}) {
  return {
    entries: opts.entries || getEntries(),
    platform: opts.platform || process.platform,
    arch: opts.arch || process.arch
  };
}

/**
 * Caminho do executável da ferramenta instalada (versão fixada na entrada) ou null.
 * Reconfere o manifesto e o arquivo no disco a cada chamada.
 */
function resolveInstalled(toolsDir, id, opts = {}) {
  const { entries, platform, arch } = resolveOptions(opts);
  const entry = getEntry(id, entries);
  if (!entry) return null;
  const asset = assetFor(entry, platform, arch);
  const found = asset ? checkInstalled(toolsDir, entry, asset) : null;
  return found ? found.exe : null;
}

/** { id: caminho|null } para todas as entradas (base do `ctx.tools`). */
function resolveAll(toolsDir, opts = {}) {
  const { entries } = resolveOptions(opts);
  const out = {};
  for (const e of entries) out[e.id] = resolveInstalled(toolsDir, e.id, { ...opts, entries });
  return out;
}

/**
 * Situação de cada ferramenta:
 * { id, label, version, installed, path, available, unavailableReason, source, sizeBytes,
 *   installedVersion, outdated, installedAt }
 *  - available: o projeto oficial publica pacote para este sistema/arquitetura;
 *  - installed: a versão fixada está instalada e íntegra (path = executável);
 *  - outdated: há uma versão antiga instalada, mas não a fixada (instalar atualiza).
 */
function status(toolsDir, opts = {}) {
  const { entries, platform, arch } = resolveOptions(opts);
  return entries.map((entry) => {
    const asset = assetFor(entry, platform, arch);
    const found = asset ? checkInstalled(toolsDir, entry, asset) : null;
    let installedVersion = found ? entry.version : null;
    if (!found) {
      const older = listInstalledVersions(toolsDir, entry.id)[0];
      installedVersion = older ? older.version : null;
    }
    return {
      id: entry.id,
      label: entry.label,
      version: entry.version,
      installed: Boolean(found),
      path: found ? found.exe : null,
      available: Boolean(asset),
      unavailableReason: asset ? null : unavailableReason(entry, platform, arch),
      source: entry.source,
      sizeBytes: asset ? asset.size : 0,
      installedVersion,
      outdated: !found && installedVersion !== null,
      installedAt: found ? found.manifest.installedAt || null : null
    };
  });
}

module.exports = {
  ToolError,
  ENTRIES_DIR, MANIFEST_NAME, MANIFEST_SCHEMA, KINDS, ID_RE,
  validateEntry, assertValidEntry, loadRegistry, getRegistry, getEntries, getEntry,
  assetFor, unavailableReason, inferKind, isLoopbackHost, isSafeFileName, isSafeRelPath,
  installDir, exePath, readManifest, checkInstalled, listInstalledVersions,
  resolveInstalled, resolveAll, status
};

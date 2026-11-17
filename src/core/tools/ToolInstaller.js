'use strict';

/**
 * ToolInstaller — instala ferramentas externas oficiais (whisper.cpp, yt-dlp, TwitchDownloaderCLI…).
 *
 * Contrato: docs/arquitetura.md 3.7. Detalhes e exemplos: docs/recursos/tools.md.
 *
 * Fluxo de install(): baixa o pacote oficial por HTTPS para "<nome>.part" numa pasta de trabalho,
 * confere tamanho E SHA-256 antes de aceitar, extrai (zip e tar.gz com o `tar` do sistema; ou usa o
 * arquivo único), confere o executável, grava o manifest.json e só então move a pasta pronta para
 * <toolsDir>/<id>/<versão>/ com um rename. Qualquer falha ou cancelamento apaga a pasta de trabalho:
 * a instalação existente (se houver) continua intacta e nunca fica uma instalação pela metade.
 *
 * Adaptado do FileDownloader/ZipExtractor/ModuleManager do BDS, sem depender do logger nem da
 * infraestrutura dele. Diferenças de propósito: não retoma download parcial (descarta e recomeça, para
 * não deixar resíduo) e só aceita https (http apenas em loopback, com `allowLoopbackHttp`, para testes).
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const appInfo = require('../../appInfo');
const registry = require('./registry');

const { ToolError } = registry;

const STAGING_DIR = '.tmp';
const TRASH_PREFIX = 'trash-'; // lixo por construção (versão antiga, ferramenta removida): pode ser varrido a qualquer momento
const DEFAULTS = Object.freeze({
  attempts: 3,               // tentativas de download (falhas transitórias)
  backoffMs: 1500,
  maxRedirects: 5,
  idleTimeoutMs: 30000,      // sem receber nada por este tempo = TIMEOUT
  extractTimeoutMs: 10 * 60 * 1000,
  staleStagingMs: 6 * 60 * 60 * 1000,
  diskFactor: 3              // espaço livre exigido = tamanho do pacote x fator (pacote + extraído + folga)
});

const USER_AGENT = `${appInfo.name.replace(/[^A-Za-z0-9]+/g, '')}-Tools/1`;

const cancelledError = () => new ToolError('Instalação cancelada.', 'CANCELLED');
const isCancel = (err) => Boolean(err) && err.code === 'CANCELLED';
/** Apaga uma pasta/arquivo. `quick`: sem repetir quando algo está em uso (não trava o processo principal). */
const rmrf = (p, { quick = false } = {}) => {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: quick ? 0 : 8, retryDelay: 150 }); return true; } catch { return false; }
};
const randomSuffix = () => crypto.randomBytes(4).toString('hex');

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(cancelledError());
    const onAbort = () => { clearTimeout(timer); reject(cancelledError()); };
    const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** rename com repetição: no Windows o antivírus/indexador pode segurar a pasta recém-escrita por instantes. */
async function renameRetry(from, to, tries = 6) {
  for (let i = 1; ; i++) {
    try { fs.renameSync(from, to); return; } catch (err) {
      const transient = ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(err.code);
      if (!transient || i >= tries) throw err;
      await sleep(150 * i);
    }
  }
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

// ------------------------------------------------------------------ download

/** Valida a URL: https sempre; http só em loopback e só quando permitido (testes). */
function checkUrl(target, allowLoopbackHttp) {
  let u;
  try { u = new URL(target); } catch { throw new ToolError('Endereço de download inválido.', 'BAD_URL'); }
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && allowLoopbackHttp && registry.isLoopbackHost(u.hostname)) return u;
  if (u.protocol === 'http:') throw new ToolError('Download recusado: só são aceitos endereços seguros (https).', 'INSECURE_URL');
  throw new ToolError('Download recusado: protocolo não suportado.', 'BAD_URL');
}

/** Próximo salto de um redirecionamento (absoluto ou relativo); bloqueia https -> http. */
function nextHop(fromUrl, location, allowLoopbackHttp = false) {
  const from = fromUrl instanceof URL ? fromUrl : new URL(fromUrl);
  const next = new URL(location, from);
  if (from.protocol === 'https:' && next.protocol !== 'https:') {
    throw new ToolError('Redirecionamento de https para http bloqueado.', 'REDIRECT_DOWNGRADE');
  }
  return checkUrl(next.toString(), allowLoopbackHttp);
}

function networkError(err, state) {
  if (err instanceof ToolError) return err;
  if (state.timedOut) return new ToolError('Tempo esgotado: o servidor parou de responder. Verifique sua conexão e tente de novo.', 'TIMEOUT');
  const code = err && err.code;
  if (code === 'ENOSPC') return new ToolError('Sem espaço em disco para baixar a ferramenta. Libere espaço e tente de novo.', 'DISK_SPACE');
  if (code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE' || (err && err.message === 'aborted')) {
    return new ToolError('O download foi interrompido antes do fim (a conexão caiu). Tente de novo.', 'INCOMPLETE');
  }
  if (typeof code === 'string' && /^(CERT_|ERR_TLS|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|ERR_SSL)/.test(code)) {
    return new ToolError('Não foi possível confirmar a segurança da conexão (certificado inválido). A instalação foi recusada.', 'TLS');
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new ToolError(`Sem permissão para gravar na pasta de ferramentas (${code}).`, 'WRITE_FAILED');
  }
  return new ToolError(`Falha de rede ao baixar: ${(err && err.message) || 'erro desconhecido'}.`, 'NETWORK');
}

const isRetryable = (err) => ['TIMEOUT', 'INCOMPLETE', 'NETWORK'].includes(err.code)
  || err.status >= 500 || err.status === 408 || err.status === 429;

/** Abre a conexão e segue redirecionamentos (limitados) até a resposta 200. */
function openResponse(startUrl, { signal, maxRedirects, idleTimeoutMs, allowLoopbackHttp, state }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    function onAbort() { if (req) req.destroy(); done(reject, cancelledError()); }
    if (signal) {
      if (signal.aborted) return reject(cancelledError());
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const go = (target, hops) => {
      let parsed;
      try { parsed = target instanceof URL ? target : checkUrl(target, allowLoopbackHttp); } catch (err) { return done(reject, err); }
      const client = parsed.protocol === 'http:' ? http : https;
      req = client.get(parsed, {
        agent: false, // sem keep-alive: nada de socket pendurado depois do download
        timeout: idleTimeoutMs,
        headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity', Accept: '*/*' }
      }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (hops >= maxRedirects) return done(reject, new ToolError('O servidor redirecionou o download vezes demais.', 'TOO_MANY_REDIRECTS'));
          let next;
          try { next = nextHop(parsed, res.headers.location, allowLoopbackHttp); } catch (err) { return done(reject, err); }
          return go(next, hops + 1);
        }
        if (status !== 200) {
          res.resume();
          return done(reject, new ToolError(`O servidor recusou o download (HTTP ${status} em ${parsed.host}).`, `HTTP_${status}`, { status }));
        }
        done(resolve, res);
      });
      req.on('timeout', () => { state.timedOut = true; req.destroy(); });
      req.on('error', (err) => done(reject, networkError(err, state)));
    };
    go(startUrl, 0);
  });
}

/** Conta os bytes, calcula o SHA-256 e impede que o servidor mande mais que o tamanho declarado. */
class Meter extends Transform {
  constructor(limit, onBytes) {
    super();
    this.limit = limit;
    this.onBytes = onBytes;
    this.hash = crypto.createHash('sha256');
    this.received = 0;
  }

  _transform(chunk, _enc, cb) {
    this.received += chunk.length;
    if (this.received > this.limit) {
      return cb(new ToolError(`O arquivo baixado é maior que o esperado (esperado ${fmtBytes(this.limit)}). A instalação foi recusada.`, 'SIZE_MISMATCH'));
    }
    this.hash.update(chunk);
    this.onBytes(this.received);
    return cb(null, chunk);
  }
}

/** Uma tentativa de download para `partPath`, já conferindo tamanho e SHA-256. */
async function downloadOnce(url, partPath, { expectedSize, expectedSha256, signal, onBytes, ...net }) {
  const state = { timedOut: false };
  const res = await openResponse(url, { signal, ...net, state });

  const declared = Number(res.headers['content-length']);
  if (res.headers['content-length'] !== undefined && Number.isFinite(declared) && declared !== expectedSize) {
    res.destroy();
    throw new ToolError(`O servidor informou ${fmtBytes(declared)}, mas o esperado é ${fmtBytes(expectedSize)}. A instalação foi recusada.`, 'SIZE_MISMATCH');
  }

  const meter = new Meter(expectedSize, onBytes);
  const file = fs.createWriteStream(partPath, { flags: 'w' });
  try {
    await pipeline(res, meter, file, { signal });
  } catch (err) {
    if (signal && signal.aborted) throw cancelledError();
    throw networkError(err, state);
  }
  if (!file.closed) await once(file, 'close'); // no Windows o arquivo precisa estar fechado antes do rename

  if (meter.received !== expectedSize) {
    throw new ToolError(`Tamanho inesperado: recebi ${fmtBytes(meter.received)} e o esperado é ${fmtBytes(expectedSize)}. A instalação foi recusada.`, 'SIZE_MISMATCH');
  }
  const sha256 = meter.hash.digest('hex');
  if (sha256 !== expectedSha256) {
    throw new ToolError('O arquivo baixado não passou na verificação de integridade (SHA-256 diferente do oficial). A instalação foi recusada; tente de novo.', 'CHECKSUM_MISMATCH');
  }
  return { size: meter.received, sha256 };
}

async function downloadVerified(url, partPath, opts) {
  const { attempts, backoffMs, signal, onRetry } = opts;
  for (let attempt = 1; ; attempt++) {
    try {
      return await downloadOnce(url, partPath, opts);
    } catch (err) {
      if (isCancel(err) || !isRetryable(err) || attempt >= attempts) throw err;
      if (onRetry) onRetry(attempt, attempts, err);
      await sleep(backoffMs * attempt, signal);
    }
  }
}

// ------------------------------------------------------------------ extração

const unsafeError = (name) => new ToolError(
  `Pacote recusado por segurança: a entrada "${name}" tenta sair da pasta de instalação.`, 'EXTRACT_UNSAFE'
);

/**
 * Proteção contra zip-slip: toda entrada precisa ficar dentro de destDir (sem "..", sem caminho
 * absoluto, sem letra de unidade e, no Windows, sem ":" que abriria fluxos alternativos do NTFS).
 * @param {string[]} entries nomes das entradas, como listados pelo descompactador
 */
function assertSafeEntries(entries, destDir, { platform = process.platform } = {}) {
  for (const raw of entries) {
    const name = String(raw).replace(/\r$/, '');
    if (!name) continue;
    const norm = name.replace(/\\/g, '/');
    if (name.includes('\0') || /^([A-Za-z]:|\/)/.test(norm) || norm.split('/').includes('..') || (platform === 'win32' && norm.includes(':'))) {
      throw unsafeError(name);
    }
    if (!isInside(destDir, path.resolve(destDir, norm))) throw unsafeError(name);
  }
}

/**
 * Depois de extrair: todo link simbólico (ou junção) precisa ser relativo e continuar dentro da pasta
 * extraída. Devolve a quantidade de itens encontrados.
 */
function assertNoEscapingLinks(root) {
  const realRoot = fs.realpathSync(root);
  let files = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        const link = fs.readlinkSync(full);
        if (path.isAbsolute(link) || !isInside(root, path.resolve(path.dirname(full), link))) throw unsafeError(path.relative(root, full));
        let real = null;
        try { real = fs.realpathSync(full); } catch { /* link quebrado dentro da pasta: inofensivo */ }
        if (real && !isInside(realRoot, real)) throw unsafeError(path.relative(root, full));
        files++;
      } else if (e.isDirectory()) {
        stack.push(full);
      } else {
        files++;
      }
    }
  }
  return files;
}

function tarExecutable(platform = process.platform) {
  if (platform === 'win32') {
    // Só o tar do próprio Windows (bsdtar, lê zip e tar.gz). Um "tar" do PATH poderia ser outro programa.
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const sys = path.join(root, 'System32', 'tar.exe');
    return fs.existsSync(sys) ? sys : null;
  }
  return 'tar';
}

/** Comandos de listagem e extração para o tipo de pacote; null se o sistema não tem o descompactador. */
function archiveCommands(kind, archive, dest, platform = process.platform) {
  if (kind === 'zip' && platform === 'linux') {
    return {
      list: { cmd: 'unzip', args: ['-Z1', archive] },
      extract: { cmd: 'unzip', args: ['-o', '-q', archive, '-d', dest] }
    };
  }
  const tar = tarExecutable(platform);
  if (!tar) return null;
  const z = kind === 'tar.gz' ? 'z' : '';
  return {
    list: { cmd: tar, args: [`-t${z}f`, archive] },
    extract: { cmd: tar, args: [`-x${z}f`, archive, '-C', dest] }
  };
}

/** Executa um programa (cancelável, com limite de tempo). Só devolve depois que o processo terminou de fato. */
function runProcess(command, args, { signal = null, timeoutMs = DEFAULTS.extractTimeoutMs, capture = false, maxOutput = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(cancelledError());
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
    } catch (err) {
      return reject(new ToolError(`Não foi possível iniciar o descompactador (${err.message}).`, 'EXTRACT_UNAVAILABLE'));
    }
    const out = [];
    let outBytes = 0;
    let stderr = '';
    let reason = null;
    let finished = false;

    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const stop = (why) => { reason = reason || why; try { child.kill(); } catch { /* já terminou */ } };
    function onAbort() { stop('cancelled'); }
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    if (timer.unref) timer.unref();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    if (capture) {
      child.stdout.on('data', (d) => {
        outBytes += d.length;
        if (outBytes > maxOutput) return stop('overflow');
        out.push(d);
        return undefined;
      });
    }
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-4000); });
    child.on('error', (err) => finish(reject, new ToolError(
      err.code === 'ENOENT'
        ? `O descompactador "${path.basename(command)}" não está disponível neste sistema.`
        : `Não foi possível iniciar o descompactador (${err.message}).`,
      err.code === 'ENOENT' ? 'EXTRACT_UNAVAILABLE' : 'EXTRACT_FAILED'
    )));
    child.on('close', (code) => {
      if (reason === 'cancelled') return finish(reject, cancelledError());
      if (reason === 'timeout') return finish(reject, new ToolError('Tempo esgotado ao extrair o pacote.', 'EXTRACT_FAILED'));
      if (reason === 'overflow') return finish(reject, new ToolError('A lista de arquivos do pacote é grande demais; pacote recusado.', 'EXTRACT_UNSAFE'));
      if (code === 0) return finish(resolve, Buffer.concat(out).toString('utf8'));
      const last = stderr.trim().split(/\r?\n/).pop() || '';
      return finish(reject, new ToolError(`Falha ao abrir o pacote (código ${code}). ${last}`.trim(), 'EXTRACT_FAILED'));
    });
  });
}

/** Valida as entradas (zip-slip) ANTES de extrair e extrai para destDir. */
async function extractArchive(kind, archive, dest, { signal = null, timeoutMs = DEFAULTS.extractTimeoutMs, platform = process.platform } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  const cmds = archiveCommands(kind, archive, dest, platform);
  if (!cmds) {
    throw new ToolError('Este Windows não tem o tar.exe (disponível no Windows 10 versão 1803 ou mais nova). Atualize o Windows para instalar ferramentas.', 'EXTRACT_UNAVAILABLE');
  }
  const listing = await runProcess(cmds.list.cmd, cmds.list.args, { signal, timeoutMs: 60000, capture: true });
  assertSafeEntries(listing.split('\n'), dest, { platform });
  await runProcess(cmds.extract.cmd, cmds.extract.args, { signal, timeoutMs });
}

/** Entra `levels` pastas (cada nível precisa ter exatamente uma pasta e mais nada). */
function descend(root, levels) {
  let current = root;
  for (let i = 0; i < levels; i++) {
    const children = fs.readdirSync(current, { withFileTypes: true });
    if (children.length !== 1 || !children[0].isDirectory()) {
      throw new ToolError('O pacote tem uma estrutura de pastas diferente da esperada (stripComponents). O pacote oficial pode ter mudado.', 'EXE_MISSING');
    }
    current = path.join(current, children[0].name);
  }
  return current;
}

// ------------------------------------------------------------------ instalador

class ToolInstaller extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.toolsDir  pasta das ferramentas (ctx.paths.tools)
   * @param {object[]} [opts.entries]  entradas (padrão: as de entries/)
   * @param {string} [opts.platform] @param {string} [opts.arch]  (padrão: o sistema atual)
   * @param {boolean} [opts.allowLoopbackHttp]  aceita http em localhost (só para testes)
   * @param {number} [opts.attempts] @param {number} [opts.backoffMs] @param {number} [opts.maxRedirects]
   * @param {number} [opts.idleTimeoutMs] @param {number} [opts.extractTimeoutMs]
   *
   * Evento 'progress': { id, label, phase, message, percent, receivedBytes, totalBytes, speedBps }
   * com phase em prepare | download | verify | extract | install | done | cancelled | error.
   */
  constructor({ toolsDir, entries = null, platform = process.platform, arch = process.arch, allowLoopbackHttp = false, ...rest } = {}) {
    super();
    if (!toolsDir) throw new ToolError('ToolInstaller: toolsDir é obrigatório.', 'INVALID_ARGUMENT');
    this.toolsDir = path.resolve(toolsDir);
    this.stagingRoot = path.join(this.toolsDir, STAGING_DIR);
    this._entries = entries;
    this.platform = platform;
    this.arch = arch;
    this.allowLoopbackHttp = allowLoopbackHttp;
    this.config = { ...DEFAULTS, ...Object.fromEntries(Object.entries(rest).filter(([k, v]) => k in DEFAULTS && v !== undefined)) };
    this._active = new Map(); // id -> { controller, staging }
    this._removing = 0;       // remoções em andamento (a pasta .tmp não pode sumir debaixo delas)
  }

  get entries() { return this._entries || registry.getEntries(); }

  /** Entrada pelo id (ou a própria entrada), sempre validada: nada de URL, caminho ou tamanho sem conferência. */
  _lookup(toolOrId) {
    let entry = toolOrId;
    if (!toolOrId || typeof toolOrId !== 'object') {
      entry = registry.getEntry(toolOrId, this.entries);
      if (!entry) throw new ToolError(`Ferramenta desconhecida: ${toolOrId}.`, 'UNKNOWN_TOOL');
    }
    return registry.assertValidEntry(entry, { allowLoopbackHttp: this.allowLoopbackHttp });
  }

  _regOpts() { return { entries: this.entries, platform: this.platform, arch: this.arch }; }

  /** Situação de todas as ferramentas (registry.status) + `busy` para as que estão sendo instaladas agora. */
  status() {
    return registry.status(this.toolsDir, this._regOpts()).map((s) => ({ ...s, busy: this._active.has(s.id) }));
  }

  /** Caminho do executável instalado (versão fixada) ou null. */
  resolveInstalled(id) { return registry.resolveInstalled(this.toolsDir, id, this._regOpts()); }

  isBusy(id) { return this._active.has(id); }

  /** Cancela a instalação em andamento dessa ferramenta. Devolve false se não havia nenhuma. */
  cancel(id) {
    const op = this._active.get(id);
    if (!op) return false;
    op.controller.abort();
    return true;
  }

  cancelAll() {
    let n = 0;
    for (const id of [...this._active.keys()]) if (this.cancel(id)) n++;
    return n;
  }

  /**
   * Apaga resíduos de instalações interrompidas (queda de energia, app fechado no meio) e o lixo que ficou
   * porque um programa antigo ainda estava em uso (Windows) em <toolsDir>/.tmp. Não mexe nas pastas de
   * instalações em andamento. `maxAgeMs` só poupa pastas de trabalho recentes (o lixo "trash-*" sempre sai).
   * Chame sem argumentos ao iniciar o app. Devolve quantas pastas foram apagadas.
   */
  cleanupStaging({ maxAgeMs = 0 } = {}) {
    const inUse = new Set([...this._active.values()].map((op) => op.staging).filter(Boolean));
    let removed = 0;
    let names = [];
    try { names = fs.readdirSync(this.stagingRoot); } catch { return 0; }
    for (const name of names) {
      const full = path.join(this.stagingRoot, name);
      if (inUse.has(full)) continue;
      try {
        if (maxAgeMs > 0 && !name.startsWith(TRASH_PREFIX) && Date.now() - fs.statSync(full).mtimeMs < maxAgeMs) continue;
      } catch { continue; }
      if (rmrf(full, { quick: true })) removed++;
    }
    this._dropStagingRoot();
    return removed;
  }

  _dropStagingRoot() {
    if (this._removing > 0) return;
    try { fs.rmdirSync(this.stagingRoot); } catch { /* não está vazia ou não existe */ }
  }

  async _ensureSpace(neededBytes) {
    let free = null;
    try {
      const s = await fs.promises.statfs(this.toolsDir);
      free = s.bavail * s.bsize;
    } catch { return; /* sem statfs: segue sem a checagem */ }
    if (free < neededBytes) {
      throw new ToolError(`Espaço em disco insuficiente: são necessários cerca de ${fmtBytes(neededBytes)} e há ${fmtBytes(free)} livres.`, 'DISK_SPACE');
    }
  }

  /**
   * Instala (ou reinstala) a ferramenta. Resolve com { id, version, dir, exe, manifest, alreadyInstalled }.
   * @param {string|object} toolOrId  id de uma entrada do registro (ou a própria entrada, validada)
   * @param {{ signal?:AbortSignal, force?:boolean, onProgress?:Function }} [opts]
   *   force: refaz o download e substitui a instalação atual (de forma segura); sem force, uma instalação
   *   íntegra da versão fixada é devolvida como está (alreadyInstalled: true) sem baixar nada.
   * Rejeita com ToolError (code: PLATFORM_UNAVAILABLE, BUSY, CANCELLED, DISK_SPACE, HTTP_xxx, TIMEOUT,
   * INCOMPLETE, SIZE_MISMATCH, CHECKSUM_MISMATCH, EXTRACT_UNSAFE, EXE_MISSING…). Falhou = nada mudou.
   */
  async install(toolOrId, { signal = null, force = false, onProgress = null } = {}) {
    const entry = this._lookup(toolOrId);
    const asset = registry.assetFor(entry, this.platform, this.arch);
    if (!asset) throw new ToolError(`${registry.unavailableReason(entry, this.platform, this.arch)} Instale a ferramenta por outro meio.`, 'PLATFORM_UNAVAILABLE');
    if (this._active.has(entry.id)) throw new ToolError(`${entry.label} já está sendo instalado. Aguarde ou cancele.`, 'BUSY');
    if (signal && signal.aborted) throw cancelledError();

    const controller = new AbortController();
    const op = { controller, staging: null };
    this._active.set(entry.id, op);
    const onOuterAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });

    const report = (patch) => {
      const ev = { id: entry.id, label: entry.label, phase: 'prepare', message: '', percent: null, receivedBytes: 0, totalBytes: asset.size, speedBps: 0, ...patch };
      for (const fn of [(e) => this.emit('progress', e), onProgress]) {
        if (typeof fn === 'function') { try { fn(ev); } catch { /* ouvinte com defeito não derruba a instalação */ } }
      }
    };

    try {
      if (!force) {
        const have = registry.checkInstalled(this.toolsDir, entry, asset);
        if (have) {
          report({ phase: 'done', message: `${entry.label} já está instalado.`, percent: 100 });
          return { id: entry.id, version: entry.version, dir: have.dir, exe: have.exe, manifest: have.manifest, alreadyInstalled: true };
        }
      }
      const result = await this._doInstall(entry, asset, op, report);
      report({ phase: 'done', message: `${entry.label} instalado.`, percent: 100, receivedBytes: asset.size });
      return result;
    } catch (err) {
      const e = this._normalizeError(err, entry, controller.signal);
      report({ phase: e.code === 'CANCELLED' ? 'cancelled' : 'error', message: e.code === 'CANCELLED' ? 'Cancelado.' : e.message });
      throw e;
    } finally {
      if (signal) signal.removeEventListener('abort', onOuterAbort);
      if (op.staging) rmrf(op.staging);
      this._active.delete(entry.id);
      this._dropStagingRoot();
    }
  }

  _normalizeError(err, entry, signal) {
    if (err instanceof ToolError) return err;
    if (signal.aborted) return cancelledError();
    return new ToolError(`Não foi possível instalar ${entry.label}: ${err && err.message ? err.message : err}`, 'INSTALL_FAILED', { cause: err });
  }

  async _doInstall(entry, asset, op, report) {
    const { signal } = op.controller;
    const cfg = this.config;

    report({ phase: 'prepare', message: 'Preparando a instalação…' });
    fs.mkdirSync(this.toolsDir, { recursive: true });
    await this._ensureSpace(asset.size * cfg.diskFactor);
    // (sem await daqui até criar a pasta de trabalho: outra instalação não consegue apagar a .tmp no meio)
    this.cleanupStaging({ maxAgeMs: cfg.staleStagingMs });
    fs.mkdirSync(this.stagingRoot, { recursive: true });
    const staging = fs.mkdtempSync(path.join(this.stagingRoot, `${entry.id}-`));
    op.staging = staging;

    // 1) download -> <nome>.part, conferido (tamanho + SHA-256) antes de virar o arquivo final
    const archive = path.join(staging, asset.name);
    const part = `${archive}.part`;
    const startedAt = { t: Date.now() };
    let lastEmit = 0;
    const onBytes = (received) => {
      const now = Date.now();
      if (received !== asset.size && now - lastEmit < 100) return;
      lastEmit = now;
      const seconds = Math.max((now - startedAt.t) / 1000, 0.001);
      report({
        phase: 'download', message: `Baixando ${entry.label}…`, receivedBytes: received, totalBytes: asset.size,
        percent: Math.min(100, (received / asset.size) * 100), speedBps: Math.round(received / seconds)
      });
    };
    report({ phase: 'download', message: `Baixando ${entry.label}…`, percent: 0 });
    await downloadVerified(asset.url, part, {
      expectedSize: asset.size, expectedSha256: asset.sha256, signal, onBytes,
      attempts: cfg.attempts, backoffMs: cfg.backoffMs, maxRedirects: cfg.maxRedirects, idleTimeoutMs: cfg.idleTimeoutMs,
      allowLoopbackHttp: this.allowLoopbackHttp,
      onRetry: (attempt, total) => {
        startedAt.t = Date.now();
        report({ phase: 'download', message: `Conexão instável. Tentando de novo (${attempt + 1} de ${total})…`, percent: 0 });
      }
    });
    report({ phase: 'verify', message: 'Integridade conferida (tamanho e SHA-256).', percent: 100, receivedBytes: asset.size });
    await renameRetry(part, archive);

    // 2) conteúdo pronto em <staging>/files
    const filesDir = path.join(staging, 'files');
    if (asset.kind === 'file') {
      fs.mkdirSync(filesDir);
      await renameRetry(archive, path.join(filesDir, asset.exe));
    } else {
      report({ phase: 'extract', message: `Extraindo ${entry.label}…` });
      const extractDir = path.join(staging, 'extract');
      await extractArchive(asset.kind, archive, extractDir, { signal, timeoutMs: cfg.extractTimeoutMs });
      const root = descend(extractDir, asset.stripComponents);
      if (assertNoEscapingLinks(root) === 0) throw new ToolError('O pacote baixado está vazio.', 'EXE_MISSING');
      await renameRetry(root, filesDir);
    }

    // 3) executável presente (e, no Linux/macOS, executável)
    const exe = registry.exePath(filesDir, asset.exe);
    let exeStat = null;
    try { exeStat = fs.statSync(exe); } catch { /* tratado abaixo */ }
    if (!exeStat || !exeStat.isFile()) {
      throw new ToolError(`O pacote baixado não contém o programa esperado (${asset.exe}). O pacote oficial pode ter mudado; atualize o ${appInfo.name}.`, 'EXE_MISSING');
    }
    if (process.platform !== 'win32') { try { fs.chmodSync(exe, 0o755); } catch { /* sem permissão para mudar o modo */ } }
    // programas extras do mesmo pacote (ex.: o ffprobe junto do ffmpeg): sem qualquer um deles o pacote não serve
    for (const rel of Object.values(asset.alsoExe || {})) {
      const extra = registry.exePath(filesDir, rel);
      let extraStat = null;
      try { extraStat = fs.statSync(extra); } catch { /* tratado abaixo */ }
      if (!extraStat || !extraStat.isFile()) {
        throw new ToolError(`O pacote baixado não contém um dos programas esperados (${rel}). O pacote oficial pode ter mudado; atualize o ${appInfo.name}.`, 'EXE_MISSING');
      }
      if (process.platform !== 'win32') { try { fs.chmodSync(extra, 0o755); } catch { /* sem permissão para mudar o modo */ } }
    }

    // 4) manifesto (gravado dentro da pasta ainda em staging: a pasta publicada já nasce completa)
    report({ phase: 'install', message: 'Instalando…' });
    const manifestPath = path.join(filesDir, registry.MANIFEST_NAME);
    if (fs.existsSync(manifestPath)) {
      throw new ToolError(`O pacote já traz um arquivo ${registry.MANIFEST_NAME} na raiz, que conflita com o manifesto da instalação. Use stripComponents na entrada para ignorar a pasta externa.`, 'INSTALL_FAILED');
    }
    const manifest = {
      schema: registry.MANIFEST_SCHEMA,
      id: entry.id, label: entry.label, version: entry.version,
      file: asset.name, sha256: asset.sha256, size: asset.size,
      exe: asset.exe, exeSize: exeStat.size,
      ...(asset.alsoExe ? { alsoExe: asset.alsoExe } : {}),
      platform: asset.key, url: asset.url, source: entry.source,
      installedAt: new Date().toISOString()
    };
    fs.writeFileSync(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2));
    fs.renameSync(`${manifestPath}.tmp`, manifestPath);

    // 5) publica (a partir daqui não dá mais para cancelar): uma instalação anterior da mesma versão
    // vai para o staging e volta se der erro
    if (signal.aborted) throw cancelledError();
    const idDir = path.join(this.toolsDir, entry.id);
    const finalDir = registry.installDir(this.toolsDir, entry.id, entry.version);
    fs.mkdirSync(idDir, { recursive: true });
    let previous = null;
    try {
      if (fs.existsSync(finalDir)) {
        previous = path.join(staging, 'previous');
        await renameRetry(finalDir, previous);
      }
    } catch (err) {
      throw new ToolError(`Não foi possível substituir a instalação atual (${err.code || err.message}). Feche ${entry.label}, se estiver em uso, e tente de novo. A versão instalada continua como estava.`, 'INSTALL_FAILED', { cause: err });
    }
    try {
      await renameRetry(filesDir, finalDir);
    } catch (err) {
      let restored = !previous;
      if (previous) { try { await renameRetry(previous, finalDir); restored = true; } catch { /* avisa abaixo */ } }
      this._dropIdDirIfEmpty(idDir);
      throw new ToolError(restored
        ? `Não foi possível concluir a instalação (${err.code || err.message}). Nada foi alterado.`
        : `Não foi possível concluir a instalação (${err.code || err.message}) e a versão anterior não pôde ser restaurada. Instale ${entry.label} de novo.`, 'INSTALL_FAILED', { cause: err });
    }

    // 6) versões antigas da mesma ferramenta saem (a que foi instalada agora é a única)
    if (previous) this._discard(previous);
    this._removeOtherVersions(idDir, entry.version);

    return { id: entry.id, version: entry.version, dir: finalDir, exe: registry.exePath(finalDir, asset.exe), manifest, alreadyInstalled: false };
  }

  _removeOtherVersions(idDir, keepVersion) {
    let names = [];
    try { names = fs.readdirSync(idDir); } catch { return; }
    for (const name of names) if (name !== keepVersion) this._discard(path.join(idDir, name));
  }

  /**
   * Descarta uma pasta que não serve mais: ela sai de cena com um rename e só então é apagada, sem esperar.
   * No Windows um programa em execução não deixa apagar seus arquivos: o que sobrar fica em .tmp/trash-*
   * e é varrido na próxima instalação ou por cleanupStaging().
   */
  _discard(dir) {
    let target = dir;
    try {
      fs.mkdirSync(this.stagingRoot, { recursive: true });
      target = path.join(this.stagingRoot, `${TRASH_PREFIX}${randomSuffix()}`);
      fs.renameSync(dir, target);
    } catch { target = dir; }
    rmrf(target, { quick: true });
  }

  _dropIdDirIfEmpty(idDir) { try { fs.rmdirSync(idDir); } catch { /* tem conteúdo */ } }

  /**
   * Remove a ferramenta (todas as versões). A pasta sai de <toolsDir>/<id> com um rename antes de ser
   * apagada: se o programa estiver em uso (Windows) nada é alterado e a remoção falha com uma mensagem clara.
   * Resolve com { id, removed } (removed=false = não havia nada instalado).
   */
  async remove(id) {
    if (typeof id !== 'string' || !registry.ID_RE.test(id)) throw new ToolError('Ferramenta inválida.', 'UNKNOWN_TOOL');
    if (this._active.has(id)) throw new ToolError('Essa ferramenta está sendo instalada. Cancele a instalação antes de remover.', 'BUSY');
    const dir = path.join(this.toolsDir, id);
    if (!fs.existsSync(dir)) return { id, removed: false };
    this._removing++;
    try {
      fs.mkdirSync(this.stagingRoot, { recursive: true });
      const trash = path.join(this.stagingRoot, `${TRASH_PREFIX}${id}-${randomSuffix()}`);
      try {
        await renameRetry(dir, trash);
      } catch (err) {
        throw new ToolError(`Não foi possível remover (${err.code || err.message}). Feche o programa que está usando a ferramenta e tente de novo.`, 'REMOVE_FAILED', { cause: err });
      }
      rmrf(trash, { quick: true });
      return { id, removed: true };
    } finally {
      this._removing--;
      this._dropStagingRoot();
    }
  }
}

module.exports = {
  ToolInstaller, ToolError, DEFAULTS, STAGING_DIR,
  assertSafeEntries, assertNoEscapingLinks, nextHop, checkUrl, extractArchive, archiveCommands, runProcess
};

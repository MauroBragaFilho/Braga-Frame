'use strict';

/**
 * Atualização do Braga Frame (dono: base; docs/atualizacao.md): consulta a última Release, baixa o instalador em segundo plano, CONFERE (tamanho, SHA-256 da
 * Release e assinatura digital) e instala quando o USUÁRIO escolhe: "agora" (fecha, instala em silêncio e reabre) ou "quando eu fechar o app". Nunca instala
 * sozinho, sem uma escolha dele.
 *
 * Estados (`phase`): idle · checking · downloading · ready (verificado, esperando a escolha) · installing.
 * O arquivo verificado fica em `<dir>/` com um `pending.json` (versão, tamanho, SHA-256 e assinatura): sobrevive a reiniciar o app, e é conferido de novo
 * (tamanho e SHA-256) imediatamente antes de ser executado. Sem Electron aqui: tudo que depende dele (sair do app, abrir o instalador, a rede, a assinatura)
 * entra por parâmetro, para testar com instalador de mentira.
 */

const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const check = require('./check');
const dl = require('./download');
const sig = require('./signature');

const CACHE_MS = 6 * 60 * 60 * 1000;
const PENDING = 'pending.json';
const SCHEMA = 1;
const INSTALLER_NAME = /^braga-frame-\d+\.\d+\.\d+-windows-x64-setup\.exe$/;

class InstallError extends Error {
  constructor(code, message) { super(message); this.name = 'InstallError'; this.code = code; }
}

const MESSAGES = Object.freeze({
  NO_UPDATE: 'Não há atualização para baixar. Use "Verificar agora".',
  NO_ASSET: 'A Release não traz um instalador que dê para conferir (faltam o tamanho ou o SHA-256). Baixe pela página da Release.',
  NO_READY: 'Não há atualização baixada e verificada para instalar.',
  TAMPERED: 'O arquivo da atualização mudou depois de ser conferido e foi descartado. Baixe de novo.',
  BUSY: (why) => `Não dá para instalar agora: ${why}. Espere terminar, ou escolha "Instalar quando eu fechar".`,
  INSTALL_FAILED: 'Não consegui abrir o instalador. A atualização continua baixada: tente de novo, ou abra a página da Release.'
});

class UpdateManager extends EventEmitter {
  /**
   * @param {{ currentVersion: string, repo: string, dir: string, fetchImpl?: Function, base?: string, embedded?: boolean, testMode?: boolean,
   *           spawnImpl?: Function, quitApp?: Function, readSignature?: Function, runningSignature?: (()=>Promise<object>)|null,
   *           busy?: ()=>string|null, allowHost?: Function, log?: Function, now?: ()=>number, cacheMs?: number, free?: Function }} o
   */
  constructor(o = {}) {
    super();
    this.current = String(o.currentVersion);
    this.repo = o.repo;
    this.dir = o.dir;
    this.fetchImpl = o.fetchImpl;
    this.base = o.base || check.API;
    this.embedded = Boolean(o.embedded);
    this.testMode = Boolean(o.testMode);
    this.spawnImpl = o.spawnImpl || spawn;
    this.quitApp = o.quitApp || (() => {});
    this.readSignature = o.readSignature || sig.readSignature;
    this.runningSignature = o.runningSignature || null;
    this.busy = o.busy || (() => null);
    this.allowHost = o.allowHost || dl.GITHUB_HOST;
    this.log = o.log || (() => {});
    this.now = o.now || Date.now;
    this.cacheMs = o.cacheMs === undefined ? CACHE_MS : o.cacheMs;
    this.free = o.free;

    this.phase = 'idle';
    this.last = null;        // { at, result } da última consulta sem erro
    this.progress = null;    // { received, total, percent } durante o download
    this.ready = null;       // { version, tag, name, file, size, sha256, signature, downloadedAt }
    this.error = null;       // { code, message } da última tentativa que falhou
    this.installOnQuit = false;
    this.spawned = [];       // só no modo de teste: o que SERIA executado
    this.controller = null;
    this._running = undefined;
  }

  // ---------------------------------------------------------------- estado

  snapshot() {
    const r = this.ready;
    return JSON.parse(JSON.stringify({
      phase: this.phase,
      check: this.last ? this.last.result : null,
      download: this.phase === 'downloading' ? this.progress : null,
      ready: r ? { version: r.version, tag: r.tag, name: r.name, sizeBytes: r.size, sha256: r.sha256, signature: { ...r.signature, text: sig.describeSignature(r.signature) } } : null,
      error: this.error,
      installOnQuit: this.installOnQuit
    }));
  }

  _emit() { this.emit('state', this.snapshot()); }

  _setError(code, message) { this.error = { code, message }; this.log('warn', `atualização: ${code}`); }

  // ---------------------------------------------------------------- consulta

  /** Consulta a última Release (resultado sem erro vale 6 h; `force` ignora). Nunca lança. */
  async check({ force = false } = {}) {
    if (this.embedded) return { status: 'disabled', reason: 'embedded', current: this.current };
    if (['downloading', 'installing'].includes(this.phase) && this.last) return { ...this.last.result, cached: true };
    if (!force && this.last && this.now() - this.last.at < this.cacheMs) return { ...this.last.result, cached: true };
    const before = this.phase;
    this.phase = 'checking';
    this._emit();
    const result = await check.checkForUpdate({ currentVersion: this.current, repo: this.repo, fetchImpl: this.fetchImpl, base: this.base });
    this.phase = before === 'checking' ? 'idle' : before;
    if (result.status !== 'error') {
      this.last = { at: this.now(), result };
      // uma Release MAIS NOVA que a já baixada: descarta a antiga (o download seguinte pega a nova)
      if (this.ready && result.status === 'available' && check.compareVersions(result.latest.version, this.ready.version) > 0) this._discard();
    } else this.log('warn', `app:updateCheck: ${result.reason}`);
    this._emit();
    return result;
  }

  // ---------------------------------------------------------------- download

  async _runningSig() {
    if (this._running === undefined) this._running = this.runningSignature ? await this.runningSignature().catch(() => null) : null;
    return this._running;
  }

  /** Baixa e confere o instalador da última consulta ('available'). O andamento e o resultado vêm pelo evento 'state'. Nunca lança. */
  async download() {
    if (this.embedded) return { ok: false, code: 'EMBEDDED' };
    if (this.phase === 'downloading' || this.phase === 'installing') return { ok: true, already: true };
    const found = this.last && this.last.result.status === 'available' ? this.last.result.latest : null;
    if (!found) { this._setError('NO_UPDATE', MESSAGES.NO_UPDATE); this._emit(); return { ok: false, code: 'NO_UPDATE' }; }
    if (!found.asset) { this._setError('NO_ASSET', MESSAGES.NO_ASSET); this._emit(); return { ok: false, code: 'NO_ASSET' }; }
    if (this.ready && this.ready.version === found.version) return { ok: true, already: true };

    this.error = null;
    this.phase = 'downloading';
    this.progress = { received: 0, total: found.asset.size, percent: 0 };
    this.controller = new AbortController();
    this._emit();
    try {
      const got = await dl.downloadInstaller({
        asset: found.asset, dir: this.dir, fetchImpl: this.fetchImpl, signal: this.controller.signal, allowHost: this.allowHost, free: this.free,
        onProgress: (p) => { this.progress = p; this._emit(); }
      });
      const next = await this.readSignature(got.file);
      const verdict = sig.trustPolicy(next, await this._runningSig());
      if (!verdict.allow) { this._removeFile(got.file); throw new InstallError(verdict.reason, sig.REASONS[verdict.reason]); }
      this.ready = { version: found.version, tag: found.tag, name: found.asset.name, file: got.file, size: got.size, sha256: got.sha256, signature: next, downloadedAt: new Date(this.now()).toISOString() };
      this._writePending();
      this._pruneDir();
      this.phase = 'ready';
      this.progress = null;
      this._emit();
      return { ok: true };
    } catch (err) {
      this.phase = this.ready ? 'ready' : 'idle';
      this.progress = null;
      if (!(err instanceof dl.UpdateError && err.code === 'CANCELLED')) this._setError(err.code || 'NETWORK', err.message);
      this._emit();
      return { ok: false, code: err.code || 'NETWORK' };
    } finally {
      this.controller = null;
    }
  }

  cancel() {
    if (this.controller) { this.controller.abort(); return true; }
    return false;
  }

  // ---------------------------------------------------------------- instalar

  /** O arquivo ainda é exatamente o que foi conferido? (tamanho e SHA-256). Se não, é descartado. */
  async _verifyReady() {
    const r = this.ready;
    if (!r) throw new InstallError('NO_READY', MESSAGES.NO_READY);
    let ok = false;
    try { ok = fs.statSync(r.file).size === r.size && (await dl.hashFile(r.file)) === r.sha256; } catch { ok = false; }
    if (!ok) { this._discard(); this._setError('TAMPERED', MESSAGES.TAMPERED); this._emit(); throw new InstallError('TAMPERED', MESSAGES.TAMPERED); }
  }

  _verifyReadySync() {
    const r = this.ready;
    try { return Boolean(r) && fs.statSync(r.file).size === r.size && dl.hashFileSync(r.file) === r.sha256; } catch { return false; }
  }

  /**
   * @param {{ when: 'now'|'quit'|'none' }} o  now: fecha o app, instala em silêncio e reabre; quit: instala quando o usuário fechar o app; none: desfaz o "quit".
   * @throws {InstallError} NO_READY | TAMPERED | BUSY | INSTALL_FAILED
   */
  async install({ when = 'now' } = {}) {
    if (when === 'none') { this.installOnQuit = false; this._emit(); return { scheduled: false }; }
    await this._verifyReady();
    if (when === 'quit') { this.installOnQuit = true; this._emit(); return { scheduled: true }; }
    const why = this.busy();
    if (why) throw new InstallError('BUSY', MESSAGES.BUSY(why));
    try {
      await this._launch(['/S', '--updated', '--force-run']); // silencioso, e o instalador reabre o app quando termina
    } catch {
      this._setError('INSTALL_FAILED', MESSAGES.INSTALL_FAILED);
      this._emit();
      throw new InstallError('INSTALL_FAILED', MESSAGES.INSTALL_FAILED);
    }
    this.phase = 'installing';
    this.installOnQuit = false;
    this._emit();
    if (!this.testMode) {
      // o instalador JÁ está rodando e espera o app sair; se pedir para sair falhar, ele encerra o app por conta própria (menos gracioso): registra e segue
      try { this.quitApp(); } catch (err) { this.log('warn', `atualização: não consegui fechar o app (${err && err.message}); o instalador o encerra`); }
    }
    return this.testMode ? { installing: true, test: { executed: false, args: this.spawned.at(-1).args } } : { installing: true }; // no teste: o que SERIA executado
  }

  /** Chamado no evento "quit" do app (síncrono): se o usuário escolheu "quando eu fechar", instala em silêncio, sem reabrir. */
  onQuit() {
    if (!this.installOnQuit || !this.ready || this.phase === 'installing') return false;
    if (!this._verifyReadySync()) { this.log('warn', 'atualização: o arquivo mudou; instalação ao fechar cancelada'); return false; }
    this.phase = 'installing';
    this._launchDetached(['/S', '--updated']);
    return true;
  }

  /** Abre o instalador desligado do app (o instalador espera o app fechar). No modo de teste só registra. */
  _launch(args) {
    if (this.testMode) { this.spawned.push({ file: this.ready.file, args }); return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.ready.file, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }

  _launchDetached(args) {
    if (this.testMode) { this.spawned.push({ file: this.ready.file, args }); return; }
    try {
      const child = this.spawnImpl(this.ready.file, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {});
      child.unref();
    } catch (err) { this.log('warn', `atualização: não abriu o instalador ao fechar (${err && err.message}) `); }
  }

  // ---------------------------------------------------------------- disco

  _pendingPath() { return path.join(this.dir, PENDING); }

  _writePending() {
    const r = this.ready;
    fs.mkdirSync(this.dir, { recursive: true });
    const data = { schema: SCHEMA, version: r.version, tag: r.tag, file: path.basename(r.file), size: r.size, sha256: r.sha256, signature: r.signature, downloadedAt: r.downloadedAt };
    const tmp = `${this._pendingPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this._pendingPath());
  }

  _removeFile(file) { try { fs.rmSync(file, { force: true }); } catch { /* ignorar */ } }

  _discard() {
    if (this.ready) this._removeFile(this.ready.file);
    this._removeFile(this._pendingPath());
    this.ready = null;
    this.installOnQuit = false;
    if (this.phase === 'ready') this.phase = 'idle';
  }

  /** Apaga da pasta tudo que não é o instalador verificado e o pending.json (restos de tentativas, versões antigas). */
  _pruneDir() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    const keep = new Set(this.ready ? [PENDING, path.basename(this.ready.file)] : []);
    for (const name of names) if (!keep.has(name)) this._removeFile(path.join(this.dir, name));
  }

  /**
   * Ao abrir o app: acha a atualização já baixada de uma execução anterior, se ainda vale (versão mais nova que a instalada, nome no padrão, tamanho e
   * SHA-256 conferem); senão limpa a pasta (inclusive depois de uma atualização bem-sucedida). Nunca lança.
   */
  async load() {
    if (this.embedded) return;
    try {
      let pending = null;
      try { pending = JSON.parse(fs.readFileSync(this._pendingPath(), 'utf8')); } catch { pending = null; }
      const file = pending && typeof pending.file === 'string' ? path.join(this.dir, path.basename(pending.file)) : null;
      const valid = pending && pending.schema === SCHEMA && file && path.basename(pending.file) === pending.file && INSTALLER_NAME.test(pending.file)
        && check.compareVersions(pending.version, this.current) === 1 && Number.isSafeInteger(pending.size) && /^[0-9a-f]{64}$/.test(String(pending.sha256));
      if (!valid) { this._pruneDir(); this._removeFile(this._pendingPath()); return; }
      if (fs.statSync(file).size !== pending.size || (await dl.hashFile(file)) !== pending.sha256) { this._pruneDir(); this._removeFile(this._pendingPath()); this._removeFile(file); return; }
      this.ready = { version: pending.version, tag: pending.tag, name: pending.file, file, size: pending.size, sha256: pending.sha256, signature: pending.signature || { status: 'Unknown', subject: null }, downloadedAt: pending.downloadedAt };
      this.phase = 'ready';
      this._pruneDir();
      this._emit();
    } catch (err) {
      this.log('warn', `atualização: não consegui reler a pasta (${err && err.message})`);
    }
  }
}

module.exports = { UpdateManager, InstallError, MESSAGES, CACHE_MS };

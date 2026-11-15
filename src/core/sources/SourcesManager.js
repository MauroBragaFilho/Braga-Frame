'use strict';

/**
 * Orquestra o recurso Fontes no processo principal (dono: sources), sem depender do Electron:
 *   - gravações do OBS (pasta detectada na configuração real do OBS ou escolhida à mão);
 *   - VOD do YouTube/Twitch por link: metadados, download com progresso/cancelamento/retomada e chat;
 *   - registro dos VODs baixados (para reabrir com origem e chat) em userData/sources.json.
 *
 * Um único "trabalho" (download de VOD ou de chat) por vez. Quem usa isto (handler) injeta `getTools` (objeto vivo
 * ctx.tools) e `getDenoPath` (Deno instalado pelo app). Eventos: 'progress' (payload de `publicProgress`).
 *
 * Retomada: o download vai para uma pasta própria dentro da pasta de destino (".bf-vod-<plataforma>-<id>"); o
 * yt-dlp deixa ali os ".part" quando é cancelado ou interrompido e os retoma na próxima vez. O arquivo final só
 * aparece na pasta de destino no fim, com nome único (nada existente é sobrescrito ou apagado).
 */

const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { findTool } = require('../ffmpeg/locate');
const { detectObs, detectObsAsync, candidateFolders } = require('./obsConfig');
const { checkFolder } = require('./fsGuard');
const { listRecordings, probeFiles } = require('./recordings');
const { parseVodUrl } = require('./urls');
const yt = require('./ytdlp');
const { runProcess } = require('./proc');
const { mapYtdlpError, warningsFromStderr } = require('./ytdlpErrors');
const { SettingsStore, norm } = require('./settingsStore');
const { SourcesError, fromMapped, cancelled } = require('./errors');
const { vodFileBase, moveUnique, freeBytes, sumFiles } = require('./naming');
const chatFormat = require('./chatFormat');
const { downloadTwitchChat } = require('./twitchChat');
const { downloadYoutubeChat } = require('./youtubeChat');
const { ProgressTracker } = require('./progress');

// depois de falhar a leitura dos cookies, o app segue sem eles por este tempo (o navegador pode ser fechado nesse meio-tempo)
const COOKIES_RETRY_AFTER_MS = 10 * 60 * 1000;
const META_TTL_MS = 10 * 60 * 1000;
const META_TIMEOUT_MS = 120 * 1000;
const EMIT_EVERY_MS = 250;
const WORKDIR_PREFIX = '.bf-vod-';
const MB = 1024 * 1024;

const fmtBytes = (n) => {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n >= 1024 * MB) return `${(n / (1024 * MB)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB`;
  return `${Math.max(1, Math.round(n / MB)).toLocaleString('pt-BR')} MB`;
};

/**
 * Espaço livre x o que falta baixar. 'block' = claramente não cabe (o download é recusado); 'low' = cabe, mas fica justo
 * (juntar vídeo e áudio usa até o dobro): só aviso; 'ok'; 'unknown' = sem tamanho estimado ou sem como medir o disco.
 */
function assessDisk({ free, estBytes, resumeBytes = 0, dir }) {
  if (free === null || free === undefined || !estBytes) return { level: 'unknown', freeBytes: free ?? null, estBytes: estBytes || null, message: '' };
  const remaining = Math.max(0, estBytes - resumeBytes);
  if (free < remaining * 1.05) {
    return {
      level: 'block', freeBytes: free, estBytes,
      message: `Não há espaço suficiente em ${dir}: o vídeo ocupa cerca de ${fmtBytes(estBytes)} e restam ${fmtBytes(free)}. Libere espaço ou escolha outra pasta em "Salvar em".`
    };
  }
  if (free < remaining * 2.2) {
    return {
      level: 'low', freeBytes: free, estBytes,
      message: `Pouco espaço livre em ${dir} (${fmtBytes(free)}): para juntar vídeo e áudio o programa precisa de até o dobro do tamanho do vídeo (~${fmtBytes(estBytes)}). O download continua possível; se faltar espaço, escolha outra pasta em "Salvar em".`
    };
  }
  return { level: 'ok', freeBytes: free, estBytes, message: '' };
}

class SourcesManager extends EventEmitter {
  /**
   * @param {{ paths:{userData:string, cache:string, downloads?:string}, getTools:()=>object,
   *   getDenoPath?:()=>string|null, findSystemDeno?:()=>string|null, env?:object, platform?:string,
   *   parseUrl?:(url:string)=>object, videosDir?:string|null, now?:()=>number, obsDir?:string|null,
   *   recordingsOptions?:object, obsTimeoutMs?:number, ytdlpVersionTimeoutMs?:number }} opts
   *   `parseUrl`, `recordingsOptions` e `obsTimeoutMs` existem para os testes (links locais, amostragem mais rápida, prazos curtos).
   */
  constructor(opts) {
    super();
    this.paths = opts.paths;
    this.getTools = opts.getTools;
    this.getDenoPath = opts.getDenoPath || (() => null);
    // módulo embutido: `hostTool(chave)` = caminho que o hospedeiro fornece (ou null); `hostName` = nome dele para as mensagens
    this.hostTool = opts.hostTool || (() => null);
    this.hostName = opts.hostName || null;
    this.env = opts.env || process.env;
    this.platform = opts.platform || process.platform;
    this.findSystemDeno = opts.findSystemDeno || (() => findTool('deno', 'CORTE_DENO', this.env));
    this.parseUrl = opts.parseUrl || parseVodUrl;
    this.videosDir = opts.videosDir || null;
    this.now = opts.now || Date.now;
    this.obsDir = opts.obsDir || null;
    this.recordingsOptions = opts.recordingsOptions || {};
    this.obsTimeoutMs = opts.obsTimeoutMs || undefined; // prazo para conferir cada pasta de gravação (padrão em fsGuard)
    this.store = new SettingsStore(path.join(this.paths.userData, 'sources.json'));
    this.chatsDir = path.join(this.paths.userData, 'chats');
    this.workRoot = path.join(this.paths.cache, 'sources');
    this.tmpRoot = path.join(this.paths.cache, 'yt-dlp-tmp'); // TEMP próprio de cada execução do yt-dlp (veja _makeTemp)
    this.metaCache = new Map();
    this.job = null;
    this.aborters = new Map(); // consultas e verificações fora de um "trabalho": id -> AbortController
    this.active = { ytdlp: 0, twitch: 0 };
    this._sysDeno = { at: 0, value: null };
    this._versions = new Map();
    this._obsPaths = null; // { at, folders } (veja _obsFolders)
    this._seq = 0;
    this._tmpSeq = 0;
  }

  /** Na inicialização: apaga o que uma execução anterior deixou (chats pela metade e as pastas TEMP do yt-dlp interrompido). */
  sweepTemp() {
    for (const dir of [this.workRoot, this.tmpRoot]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch { /* em uso: fica para a próxima */ }
    }
  }

  /** Pasta TEMP exclusiva de uma execução do yt-dlp (null se não der para criar: o yt-dlp usa o TEMP normal). */
  async _makeTemp() {
    this._tmpSeq += 1;
    const dir = path.join(this.tmpRoot, `${process.pid.toString(36)}-${this._tmpSeq.toString(36)}`);
    try { await fs.promises.mkdir(dir, { recursive: true }); } catch { return null; }
    return dir;
  }

  async _removeTemp(dir) {
    if (!dir) return;
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }).catch(() => {});
  }

  /**
   * Roda um programa do yt-dlp com TEMP próprio, apagado no fim MESMO se foi cancelado ou deu erro: o yt-dlp.exe oficial é
   * "onefile" e se extrai em %TEMP%\_MEI<n> (~22 MB); `taskkill /F` não o deixa limpar e cada cancelamento vazaria uma pasta.
   */
  async _runWithTemp(command, env, args, options = {}) {
    const dir = await this._makeTemp();
    try {
      return await runProcess({ command, args, env: dir ? yt.withTempDir(env, dir) : env, ...options });
    } finally {
      await this._removeTemp(dir);
    }
  }

  /**
   * Cancelamento de algo que roda fora de um "trabalho" (consulta de metadados, versão). `id` opcional: quem pede pode
   * cancelar só a sua consulta; `outer` encadeia outro sinal (o do download que consulta o vídeo antes de baixar).
   */
  _aborter(id, outer) {
    const ctl = new AbortController();
    const key = typeof id === 'string' && id && !this.aborters.has(id) ? id : `q${++this._seq}`;
    this.aborters.set(key, ctl);
    let unlink = null;
    if (outer) {
      if (outer.aborted) ctl.abort();
      else {
        const onAbort = () => ctl.abort();
        outer.addEventListener('abort', onAbort, { once: true });
        unlink = () => outer.removeEventListener('abort', onAbort);
      }
    }
    return { signal: ctl.signal, release: () => { this.aborters.delete(key); if (unlink) unlink(); } };
  }

  // ------------------------------------------------------------------ ferramentas e configurações

  _tools() {
    const t = this.getTools() || {};
    return { ytdlp: t.ytdlp || null, twitch: t.twitchDownloader || null, ffmpeg: t.ffmpeg || null, ffprobe: t.ffprobe || null };
  }

  _systemDeno() {
    if (this.now() - this._sysDeno.at > 60 * 1000) {
      let value = null;
      try { value = this.findSystemDeno() || null; } catch { value = null; }
      this._sysDeno = { at: this.now(), value };
    }
    return this._sysDeno.value;
  }

  /** Deno que o yt-dlp usará: o instalado pelo app, senão o do sistema (o yt-dlp o acha sozinho no PATH). */
  jsRuntime() {
    const app = this.getDenoPath() || null;
    if (app) return { found: true, origin: 'app', path: app };
    const system = this._systemDeno();
    return system ? { found: true, origin: 'system', path: system } : { found: false, origin: null, path: null };
  }

  /** Quais ferramentas deste recurso estão em uso agora (para ctx.toolUsage). */
  usage() {
    const ytdlp = this.active.ytdlp > 0;
    return {
      ytdlp: ytdlp ? 'o yt-dlp está baixando ou consultando um vídeo' : null,
      twitchdownloader: this.active.twitch > 0 ? 'o TwitchDownloaderCLI está baixando um chat' : null,
      // o Deno só está em uso se é o do app (um Deno do sistema não é do app) e o yt-dlp está rodando
      deno: ytdlp && this.getDenoPath() ? 'o yt-dlp está usando o Deno' : null
    };
  }

  async getState() {
    const t = this._tools();
    const settings = this.store.get();
    return {
      settings,
      defaultDownloadDir: this.defaultDownloadDir(),
      downloadDir: this.downloadDir(),
      tools: {
        ytdlp: { found: Boolean(t.ytdlp), path: t.ytdlp, hostProvided: this._ytdlpFromHost(), hostName: this._ytdlpFromHost() ? this.hostName : null, ...(t.ytdlp ? await this.ytdlpAge() : { version: null, ageDays: null, outdated: false }) },
        twitchDownloader: { found: Boolean(t.twitch), path: t.twitch },
        ffmpeg: { found: Boolean(t.ffmpeg), path: t.ffmpeg },
        ffprobe: { found: Boolean(t.ffprobe), path: t.ffprobe },
        jsRuntime: this.jsRuntime()
      },
      job: this.job ? this.publicJob() : null
    };
  }

  /** Pasta onde os VODs são salvos agora (a escolhida ou a padrão). */
  downloadDir() {
    return this.store.get().downloadDir || this.defaultDownloadDir();
  }

  defaultDownloadDir() {
    if (this.videosDir) return path.join(this.videosDir, 'Braga Frame');
    return this.paths.downloads || path.join(this.paths.userData, 'downloads');
  }

  /** Valida e grava as configurações: { obsFolder?, downloadDir?, cookiesBrowser?, lastQuality? }. null limpa a pasta. */
  setSettings(patch = {}) {
    const next = {};
    if (patch.obsFolder !== undefined) {
      if (patch.obsFolder === null || patch.obsFolder === '') next.obsFolder = null;
      else {
        if (typeof patch.obsFolder !== 'string' || !path.isAbsolute(patch.obsFolder)) throw new SourcesError('INVALID_PATH', 'Escolha uma pasta de gravações válida (caminho completo).');
        let isDir = false;
        try { isDir = fs.statSync(patch.obsFolder).isDirectory(); } catch { isDir = false; }
        if (!isDir) throw new SourcesError('FOLDER_MISSING', 'Essa pasta não existe. Escolha uma pasta que exista no computador.');
        next.obsFolder = patch.obsFolder;
      }
    }
    if (patch.downloadDir !== undefined) {
      if (patch.downloadDir === null || patch.downloadDir === '') next.downloadDir = null;
      else {
        if (typeof patch.downloadDir !== 'string' || !path.isAbsolute(patch.downloadDir)) throw new SourcesError('INVALID_PATH', 'Escolha uma pasta de downloads válida (caminho completo).');
        next.downloadDir = patch.downloadDir;
      }
    }
    if (patch.lastQuality !== undefined) {
      if (patch.lastQuality !== '' && patch.lastQuality !== null && !/^(best|h\d{3,4})$/.test(String(patch.lastQuality))) {
        throw new SourcesError('INVALID_QUALITY', 'Qualidade inválida.');
      }
      next.lastQuality = patch.lastQuality || '';
    }
    if (patch.cookiesBrowser !== undefined) {
      if (patch.cookiesBrowser !== '' && patch.cookiesBrowser !== null && !yt.BROWSERS.includes(patch.cookiesBrowser)) {
        throw new SourcesError('INVALID_BROWSER', `Navegador não suportado. Escolha entre: ${yt.BROWSERS.join(', ')}.`);
      }
      next.cookiesBrowser = patch.cookiesBrowser || '';
    }
    return this.store.set(next);
  }

  /** Versão do yt-dlp em uso e se ela é antiga demais (mais velha que a versão oficial fixada pelo app; veja isOutdated em ytdlp.js). */
  async ytdlpAge() {
    const version = await this.ytdlpVersion();
    const ageDays = yt.versionAgeDays(version, this.now());
    let pinned = null;
    try { pinned = require('../tools/entries/ytdlp').version; } catch { pinned = null; }
    return { version, ageDays, outdated: yt.isOutdated(version, pinned, this.now()) };
  }

  /** O yt-dlp em uso é o que o hospedeiro fornece (o app não instala outra cópia)? */
  _ytdlpFromHost() {
    const exe = this._tools().ytdlp;
    let host = null;
    try { host = this.hostTool('ytdlp') || null; } catch { host = null; }
    return Boolean(exe && host && path.resolve(exe).toLowerCase() === path.resolve(host).toLowerCase());
  }

  /** { version, ageDays } se o yt-dlp em uso é antigo (causa comum de HTTP 403 no YouTube); senão null. `hostName`: ele vem do hospedeiro. */
  async ytdlpOutdated() {
    const a = await this.ytdlpAge();
    return a.outdated ? { version: a.version, ageDays: a.ageDays, ...(this._ytdlpFromHost() ? { hostName: this.hostName || 'aplicativo que abriu o Braga Frame' } : {}) } : null;
  }

  async ytdlpVersion() {
    const exe = this._tools().ytdlp;
    if (!exe) return null;
    let key = exe;
    try { const st = fs.statSync(exe); key = `${exe}|${st.size}|${Math.round(st.mtimeMs)}`; } catch { return null; }
    if (this._versions.has(key)) return this._versions.get(key);
    let version = null;
    const abort = this._aborter(); // fechar o app no meio não deixa o yt-dlp da verificação para trás
    try {
      const res = await this._runWithTemp(exe, yt.ytdlpEnv(this.env), ['--version'], { timeoutMs: 15000, captureStdout: true, signal: abort.signal });
      if (res.code === 0) version = res.stdout.trim().split(/\r?\n/)[0] || null;
    } catch { version = null; } finally { abort.release(); }
    if (abort.signal.aborted) return null; // interrompida: não guarda "sem versão" no cache
    this._versions.set(key, version);
    return version;
  }

  // ------------------------------------------------------------------ OBS

  _obsOptions() {
    return { env: this.env, platform: this.platform, ...(this.obsDir ? { obsDir: this.obsDir } : {}) };
  }

  /**
   * Pastas de gravação do OBS (todos os perfis) + a escolhida à mão + qual mostrar primeiro. Nunca trava o app: a existência
   * de cada pasta é conferida de forma assíncrona e com prazo (uma pasta de rede fora do ar vira `exists: null`, "não consegui
   * acessar", em vez de congelar o processo principal por ~21 s).
   */
  async detectObs() {
    const timeoutMs = this.obsTimeoutMs;
    const detected = await detectObsAsync({ ...this._obsOptions(), timeoutMs });
    const folders = candidateFolders(detected);
    const manual = this.store.get().obsFolder;
    const manualExists = manual ? (await checkFolder(manual, { timeoutMs })).exists : false; // true | false | null (não consegui acessar)
    let selected = null;
    let selectedBy = null;
    if (manual && manualExists === true) { selected = manual; selectedBy = 'manual'; }
    else {
      const pick = folders.find((f) => f.active && f.exists) || folders.find((f) => f.exists);
      if (pick) { selected = pick.folder; selectedBy = 'obs'; }
      else if (manual && manualExists === null) { selected = manual; selectedBy = 'manual'; } // escolha do usuário; a listagem explica o que houve
    }
    return { ...detected, folders, manual, manualExists, selected, selectedBy };
  }

  async listObs({ folder } = {}) {
    const target = folder || (await this.detectObs()).selected;
    if (!target) throw new SourcesError('NO_FOLDER', 'Nenhuma pasta de gravações foi encontrada. Escolha a pasta onde o OBS grava os vídeos.');
    if (typeof target !== 'string' || !path.isAbsolute(target)) throw new SourcesError('INVALID_PATH', 'Caminho de pasta inválido.');
    return listRecordings(target, { ffprobe: this._tools().ffprobe, ...this.recordingsOptions });
  }

  /** Durações (ffprobe) de arquivos de uma lista que veio com "pendentes": { caminho: segundos|null }. */
  async probeDurations(paths) {
    return { durations: await probeFiles(this._tools().ffprobe, paths) };
  }

  /**
   * Pastas de gravação conhecidas (perfis do OBS + a escolhida à mão), para reconhecer um arquivo no gancho de abertura.
   * Roda em TODA abertura de vídeo: lê só os .ini do OBS (cache de 5 s) e NUNCA toca nas pastas de gravação, que podem ser
   * compartilhamentos de rede fora do ar. Um arquivo que o usuário está abrindo prova, por si só, que a pasta existe.
   */
  _obsFolders() {
    if (!this._obsPaths || this.now() - this._obsPaths.at > 5000) {
      const folders = candidateFolders(detectObs({ ...this._obsOptions(), checkFolders: false })).map((f) => f.folder);
      this._obsPaths = { at: this.now(), folders };
    }
    const manual = this.store.get().obsFolder;
    return manual ? [...this._obsPaths.folders, manual] : this._obsPaths.folders;
  }

  /**
   * Para o gancho beforeOpen/afterOpen do renderer: o que se sabe sobre um arquivo que o usuário vai abrir.
   * @returns {null | { kind:'vod'|'obs', origin:object, chat:object|null, meta:object }}
   */
  /**
   * O registro de download deste arquivo ({ path, origin, chat, meta, at }) se o PRÓPRIO app o baixou (aba Novo projeto (sources)); senão null.
   * É a prova de que o arquivo é do app: só por ela a exclusão de um projeto apaga o vídeo (nunca o que o usuário trouxe).
   */
  downloadRecord(filePath) {
    if (typeof filePath !== 'string' || !filePath) return null;
    return this.store.findDownload(filePath);
  }

  /** Esquece o registro de um download cujo arquivo foi apagado. */
  forgetDownload(filePath) {
    if (typeof filePath !== 'string' || !filePath) return false;
    return this.store.forgetDownload(filePath);
  }

  originFor(filePath) {
    if (typeof filePath !== 'string' || !filePath) return null;
    const known = this.store.findDownload(filePath);
    if (known) return { kind: 'vod', origin: known.origin, chat: known.chat, meta: known.meta };
    const dir = norm(path.dirname(path.resolve(filePath)));
    if (this._obsFolders().some((f) => norm(f) === dir)) return { kind: 'obs', origin: { type: 'obs' }, chat: null, meta: {} };
    return null;
  }

  // ------------------------------------------------------------------ VOD: metadados

  _parse(url) {
    try { return this.parseUrl(url); } catch (err) {
      throw new SourcesError(err.code || 'INVALID_URL', err.message);
    }
  }

  _ytContext() {
    const t = this._tools();
    if (!t.ytdlp) {
      throw new SourcesError('NO_YTDLP', 'O yt-dlp não está instalado. Abra a aba Ferramentas e instale o yt-dlp (programa oficial, baixado com conferência de SHA-256).');
    }
    const js = this.jsRuntime();
    // se o navegador escolhido não pôde ser lido há pouco (aberto, sem perfil…), segue SEM cookies por um tempo em vez de falhar
    const cookiesBrowser = this._cookiesBlocked() ? '' : this.store.get().cookiesBrowser;
    return {
      exe: t.ytdlp,
      ffmpeg: t.ffmpeg,
      common: yt.commonArgs({
        ffmpegPath: t.ffmpeg,
        denoPath: js.origin === 'app' ? js.path : null,
        cacheDir: path.join(this.paths.cache, 'yt-dlp'),
        cookiesBrowser
      }),
      env: yt.ytdlpEnv(this.env),
      hasJsRuntime: js.found,
      usedCookies: Boolean(cookiesBrowser)
    };
  }

  async _runYtdlp(y, args, o = {}) {
    this.active.ytdlp += 1;
    try {
      return await this._runWithTemp(y.exe, y.env, args, o);
    } catch (err) {
      if (err.code === 'SPAWN') throw new SourcesError('YTDLP_START_FAILED', `Não foi possível iniciar o yt-dlp (${err.message.replace(/^Não foi possível iniciar o programa \(|\)\.$/g, '')}). Reinstale o yt-dlp na aba Ferramentas.`);
      throw err;
    } finally {
      this.active.ytdlp -= 1;
    }
  }

  _cookiesBlocked() { return this._cookiesBlockedUntil && this.now() < this._cookiesBlockedUntil; }

  /**
   * Roda `attempt()`; se o yt-dlp não conseguir ler os cookies do navegador escolhido (o navegador aberto trava o banco de
   * cookies), repete UMA vez sem cookies e avisa no resultado. Vídeos públicos funcionam sem eles; se o vídeo exigir login,
   * o erro normal (com a explicação) aparece na repetição.
   */
  async _withCookieFallback(attempt) {
    try {
      return await attempt();
    } catch (err) {
      const browser = this.store.get().cookiesBrowser;
      if (!(err && err.code === 'COOKIES_BROWSER' && browser && !this._cookiesBlocked())) throw err;
      this._cookiesBlockedUntil = this.now() + COOKIES_RETRY_AFTER_MS;
      const result = await attempt();
      const note = { code: 'COOKIES_SKIPPED', level: 'info', message: `Não foi possível ler os cookies do navegador (${browser}); provavelmente ele está aberto. O app seguiu sem eles. Se este vídeo exigir login, feche o navegador e tente de novo.` };
      if (result && Array.isArray(result.warnings)) result.warnings = [...result.warnings, note];
      return result;
    }
  }

  /**
   * Consulta o link e devolve { meta, qualities, chat, warnings, fetchedAt, fromCache }.
   * Impedimentos (live no ar, sem nenhuma qualidade liberada) vêm em `warnings` com level 'block'.
   */
  async fetchVod(url, opts = {}) {
    return this._withCookieFallback(() => this._fetchVodOnce(url, opts));
  }

  async _fetchVodOnce(url, { refresh = false, signal, queryId } = {}) {
    const parsed = this._parse(url);
    const cached = this.metaCache.get(parsed.url);
    if (cached && !refresh && this.now() - cached.at < META_TTL_MS) return { ...cached.result, fromCache: true };

    const y = this._ytContext();
    // a consulta pode demorar (até META_TIMEOUT_MS): quem pediu a cancela por `queryId` (sources:cancel) e fechar o app a encerra
    const abort = this._aborter(queryId, signal);
    let res;
    try {
      res = await this._runYtdlp(y, yt.metadataArgs(parsed.url, y.common), { captureStdout: true, timeoutMs: META_TIMEOUT_MS, signal: abort.signal });
    } finally { abort.release(); }
    if (res.reason === 'cancelled') throw cancelled('Consulta cancelada.');
    if (res.reason === 'timeout') {
      throw new SourcesError('TIMEOUT', 'A consulta ao vídeo demorou demais. Confira a internet e tente de novo.', { retryable: true });
    }
    if (res.code !== 0 || !res.stdout.trim()) {
      throw fromMapped(mapYtdlpError(res.stderr, { exitCode: res.code, platform: parsed.platform, usedCookies: y.usedCookies, hasJsRuntime: y.hasJsRuntime, outdatedYtdlp: await this.ytdlpOutdated() }));
    }
    let info;
    try { info = JSON.parse(res.stdout); } catch {
      throw new SourcesError('YTDLP_BAD_OUTPUT', 'O yt-dlp respondeu algo que o app não entendeu. Tente de novo; se repetir, reinstale o yt-dlp na aba Ferramentas.');
    }
    if (info && info._type === 'playlist' && Array.isArray(info.entries) && info.entries[0]) info = info.entries[0];

    const meta = yt.normalizeMetadata(info, { ...parsed, now: this.now() });
    const qualities = yt.buildQualities(info);
    const warnings = [...yt.videoWarnings(meta)];
    const noFormats = !(Array.isArray(info.formats) && info.formats.length);
    if (noFormats && meta.liveStatus !== 'is_live' && meta.liveStatus !== 'is_upcoming') {
      warnings.push({ level: 'block', code: 'NO_FORMATS', message: 'A fonte não liberou nenhuma qualidade de vídeo para este link. Isso depende de acesso, permissões ou disponibilidade (vídeo só para inscritos/membros, restrito por idade ou região). Veja "Avançado" para usar os cookies do navegador.' });
    }
    for (const w of warningsFromStderr(res.stderr, { platform: parsed.platform, hasJsRuntime: y.hasJsRuntime })) warnings.push({ level: 'warn', ...w });

    const sizeByFormat = new Map();
    const duration = meta.duration;
    for (const f of Array.isArray(info.formats) ? info.formats : []) {
      const size = Number(f.filesize) || Number(f.filesize_approx) || (Number(f.tbr) > 0 && duration > 0 ? Math.round(Number(f.tbr) * 125 * duration) : 0);
      if (f.format_id && size > 0) sizeByFormat.set(String(f.format_id), size);
    }
    const result = { meta, qualities, chat: yt.chatAvailability(meta), warnings, fetchedAt: meta.fetchedAt, fromCache: false };
    this.metaCache.set(parsed.url, { at: this.now(), result, sizeByFormat });
    return result;
  }

  /** O `origin` de projeto (arquitetura 2.1) para os metadados de um VOD. */
  originOf(meta) {
    return {
      type: 'vod', platform: meta.platform, url: meta.url, videoId: meta.videoId,
      channel: meta.channel, title: meta.title, game: meta.game, uploadDate: meta.uploadDate,
      fetchedAt: meta.fetchedAt, duration: meta.duration
    };
  }

  /** IPC sources:refreshMeta: consulta de novo (sem cache) e devolve também o origin pronto para comparar. */
  async refreshMeta(url) {
    const result = await this.fetchVod(url, { refresh: true });
    return { ...result, origin: this.originOf(result.meta) };
  }

  // ------------------------------------------------------------------ trabalho em andamento

  _newJob(kind, extra) {
    if (this.job) {
      throw new SourcesError('BUSY', `Já existe ${this.job.kind === 'download' ? 'um download de VOD' : 'um download de chat'} em andamento. Espere terminar ou cancele.`);
    }
    this._seq += 1;
    this.job = {
      id: `${kind}-${this.now().toString(36)}-${this._seq}`, kind, startedAt: this.now(), controller: new AbortController(),
      phase: 'prepare', percent: null, message: '', lastEmit: 0, last: null, ...extra
    };
    return this.job;
  }

  publicJob() {
    const j = this.job;
    return j ? { ...(j.last || {}), jobId: j.id, kind: j.kind, url: j.url, videoId: j.videoId, platform: j.platform, title: j.title || '', startedAt: j.startedAt } : null;
  }

  _emit(job, patch, { force = false } = {}) {
    const payload = {
      jobId: job.id, kind: job.kind, url: job.url, videoId: job.videoId, platform: job.platform,
      phase: job.phase, percent: null, downloaded: null, total: null, speed: null, eta: null, message: '',
      resumed: Boolean(job.resumeBytes), resumeBytes: job.resumeBytes || 0, ...patch
    };
    job.last = payload;
    if (patch.phase) job.phase = patch.phase;
    const t = this.now();
    if (force || t - job.lastEmit >= EMIT_EVERY_MS) {
      job.lastEmit = t;
      this.emit('progress', payload);
    }
  }

  /** Cancela o trabalho em andamento (download de vídeo ou de chat); com `jobId`, só se for esse. */
  cancel(jobId) {
    if (!this.job || (jobId && this.job.id !== jobId)) return false;
    this.job.cancelRequested = true;
    this.job.controller.abort();
    return true;
  }

  /** Cancela uma consulta de metadados (ou verificação) pelo `queryId` que quem pediu informou em fetchVod. */
  cancelQuery(queryId) {
    const ctl = typeof queryId === 'string' ? this.aborters.get(queryId) : null;
    if (!ctl) return false;
    ctl.abort();
    return true;
  }

  /** Fechar o app: encerra o trabalho em andamento E as consultas soltas (nenhum yt-dlp fica para trás). */
  cancelAll() {
    let any = this.job ? this.cancel() : false;
    for (const ctl of [...this.aborters.values()]) { ctl.abort(); any = true; }
    return any;
  }

  // ------------------------------------------------------------------ VOD: download

  /**
   * Pasta de trabalho de UM vídeo em UMA qualidade. A qualidade faz parte do nome porque, quando o formato é um arquivo
   * só (Twitch, links diretos), o yt-dlp usa o mesmo nome de ".part" para qualquer qualidade e retomaria o pedaço de uma
   * qualidade com o fluxo de outra, corrompendo o vídeo.
   */
  _workDirFor(dir, parsed, qualityId = 'best') {
    const q = String(qualityId || 'best').replace(/[^A-Za-z0-9_-]/g, '') || 'best';
    return path.join(dir, `${WORKDIR_PREFIX}${parsed.platform}-${parsed.videoId}-${q}`);
  }

  /** Todas as pastas de trabalho deste vídeo na pasta de destino (uma por qualidade já tentada). */
  _workDirsOf(dir, parsed) {
    const prefix = `${WORKDIR_PREFIX}${parsed.platform}-${parsed.videoId}-`;
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith(prefix)).map((d) => path.join(dir, d.name));
    } catch { return []; }
  }

  /**
   * Quanto já foi baixado deste vídeo nesta pasta (.part e arquivos já completos que ainda não foram juntados), para oferecer "Retomar".
   * `bytes` = na qualidade pedida (é a que será retomada); `otherBytes` = em outras qualidades (não serão reaproveitadas).
   */
  partialInfo({ url, dir, quality } = {}) {
    const parsed = this._parse(url);
    const target = dir || this.downloadDir();
    const work = this._workDirFor(target, parsed, quality || 'best');
    const bytes = sumFiles(work);
    const otherBytes = this._workDirsOf(target, parsed).filter((d) => d !== work).reduce((sum, d) => sum + sumFiles(d), 0);
    return { bytes, otherBytes, dir: target, workDir: work, exists: fs.existsSync(work) };
  }

  /**
   * Espaço livre na pasta de destino x tamanho estimado da qualidade escolhida, ANTES de baixar (a aba mostra o aviso ao lado
   * de "Salvar em", quando o usuário ainda pode trocar a pasta ou a qualidade). Mesmos limites do download():
   * { level:'ok'|'low'|'block'|'unknown', freeBytes, estBytes, message }. Só informa; quem recusa é o download().
   */
  async diskCheck({ url, dir, quality } = {}) {
    const parsed = this._parse(url);
    const target = dir || this.downloadDir();
    const cached = this.metaCache.get(parsed.url);
    const qualities = cached ? cached.result.qualities : [];
    const picked = qualities.find((q) => q.id === quality) || qualities[0] || null;
    const resumeBytes = sumFiles(this._workDirFor(target, parsed, picked ? picked.id : 'best'));
    return assessDisk({ free: await freeBytes(target), estBytes: picked && picked.estBytes, resumeBytes, dir: target });
  }

  /** Apaga o que foi baixado pela metade deste vídeo, em todas as qualidades (só as pastas ".bf-vod-…" criadas por este recurso). */
  async discardPartial({ url, dir } = {}) {
    if (this.job) throw new SourcesError('BUSY', 'Há um download em andamento. Cancele-o antes de descartar o que foi baixado.');
    const parsed = this._parse(url);
    const target = dir || this.downloadDir();
    let freed = 0;
    for (const work of this._workDirsOf(target, parsed)) {
      if (!path.basename(work).startsWith(WORKDIR_PREFIX)) continue;
      freed += sumFiles(work);
      await fs.promises.rm(work, { recursive: true, force: true });
    }
    return { freed };
  }

  /**
   * Baixa o VOD. `quality`: id de uma qualidade devolvida por fetchVod ('best', 'h720'…). Resolve só no fim.
   * @returns {Promise<{ path, bytes, origin, meta, chat, chatNote, warnings, resumed }>}
   */
  async download(args = {}) {
    return this._withCookieFallback(() => this._downloadOnce(args));
  }

  async _downloadOnce({ url, quality = 'best', dir, withChat = false } = {}) {
    const parsed = this._parse(url);
    const y = this._ytContext();
    if (!y.ffmpeg) {
      throw new SourcesError('NO_FFMPEG', 'O FFmpeg não foi encontrado: ele junta o vídeo e o áudio baixados. Instale o FFmpeg (veja a aba Ferramentas) e use "Verificar de novo".');
    }
    const job = this._newJob('download', { url: parsed.url, videoId: parsed.videoId, platform: parsed.platform });
    const warnings = [];
    try {
      this._emit(job, { phase: 'prepare', message: 'Consultando o vídeo…' }, { force: true });
      const info = await this.fetchVod(parsed.url, { signal: job.controller.signal });
      const blocker = info.warnings.find((w) => w.level === 'block');
      if (blocker) throw new SourcesError(blocker.code, blocker.message);
      job.title = info.meta.title;
      const picked = info.qualities.find((q) => q.id === quality) || info.qualities[0];

      const destDir = dir || this.downloadDir();
      if (typeof destDir !== 'string' || !path.isAbsolute(destDir)) throw new SourcesError('INVALID_PATH', 'Escolha uma pasta de destino válida (caminho completo).');
      try { await fs.promises.mkdir(destDir, { recursive: true }); } catch (err) {
        throw fromMapped(mapYtdlpError(`ERROR: ${err.code === 'EACCES' || err.code === 'EPERM' ? 'permission denied' : err.message}`, { platform: parsed.platform }));
      }
      const workDir = this._workDirFor(destDir, parsed, picked ? picked.id : 'best');
      const resumeBytes = sumFiles(workDir);
      job.resumeBytes = resumeBytes;

      // espaço em disco: impede só o que é impossível; o resto é aviso (a aba já mostrou o mesmo aviso antes de baixar: diskCheck)
      const disk = assessDisk({ free: await freeBytes(destDir), estBytes: picked && picked.estBytes, resumeBytes, dir: destDir });
      if (disk.level === 'block') throw new SourcesError('NO_DISK_SPACE', disk.message);
      if (disk.level === 'low') warnings.push({ code: 'LOW_DISK', message: disk.message });

      await fs.promises.mkdir(workDir, { recursive: true });
      const cached = this.metaCache.get(parsed.url);
      const tracker = new ProgressTracker({ sizeByFormat: cached ? cached.sizeByFormat : new Map() });
      this._emit(job, {
        phase: 'download', message: resumeBytes > 0 ? `Retomando o download (${fmtBytes(resumeBytes)} já baixados)…` : 'Iniciando o download…'
      }, { force: true });

      const args = yt.downloadArgs({ url: parsed.url, common: y.common, quality: picked && picked.height ? { height: picked.height } : 'best', workDir });
      const res = await this._runYtdlp(y, args, {
        signal: job.controller.signal,
        timeoutMs: 0,
        onStdoutLine: (line) => {
          const evt = yt.parseOutputLine(line);
          if (!evt) return;
          const snap = tracker.feed(evt);
          if (evt.type === 'progress' || evt.type === 'post' || evt.type === 'plan') {
            this._emit(job, {
              phase: snap.phase, percent: snap.percent, downloaded: snap.downloaded, total: snap.total, speed: snap.speed, eta: snap.eta,
              message: snap.phase === 'merge' ? 'Juntando vídeo e áudio…' : ''
            }, { force: evt.type === 'post' });
          }
        }
      });

      if (res.reason === 'cancelled' || job.controller.signal.aborted) {
        throw cancelled('Download cancelado. O que já foi baixado ficou guardado e será retomado na próxima vez.');
      }
      if (res.code !== 0) {
        throw fromMapped(mapYtdlpError(res.stderr, { exitCode: res.code, platform: parsed.platform, usedCookies: y.usedCookies, hasJsRuntime: y.hasJsRuntime, outdatedYtdlp: await this.ytdlpOutdated() }));
      }

      const produced = this._findOutput(workDir);
      if (!produced) {
        throw new SourcesError('YTDLP_NO_OUTPUT', 'O yt-dlp terminou, mas não gerou o vídeo. Tente de novo; o que foi baixado fica guardado para continuar.');
      }
      this._emit(job, { phase: 'finishing', percent: 99.9, message: 'Guardando o arquivo…' }, { force: true });
      const meta = info.meta;
      const base = vodFileBase({ title: meta.title, id: meta.videoId, dir: destDir, ext: path.extname(produced) });
      let finalPath;
      try {
        finalPath = await moveUnique(produced, destDir, base, path.extname(produced));
      } catch (err) {
        throw new SourcesError('MOVE_FAILED', `O vídeo foi baixado, mas não foi possível guardá-lo em ${destDir} (${err.code || err.message}). Ele continua na pasta ".bf-vod-…" dentro dela; tente de novo para concluir.`);
      }
      // o arquivo final já está guardado; a pasta de trabalho pode demorar a soltar se um antivírus/OneDrive ainda segura o original
      await fs.promises.rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
      if (fs.existsSync(workDir)) {
        warnings.push({ code: 'WORKDIR_LEFT', message: `O vídeo foi guardado, mas não consegui apagar a pasta temporária ${path.basename(workDir)} em ${destDir} (algum programa ainda está usando o arquivo). Pode apagá-la depois; ela não é mais necessária.` });
      }
      const bytes = fs.statSync(finalPath).size;

      let chat = null;
      let chatNote = null;
      if (withChat) {
        this._emit(job, { phase: 'chat', percent: null, message: 'Baixando o chat…' }, { force: true });
        const got = await this._fetchChatSafe(job, parsed);
        chat = got.chat;
        chatNote = got.note;
      }

      const origin = this.originOf(meta);
      this.store.recordDownload({ path: finalPath, origin, chat, meta: { game: meta.game, channel: meta.channel }, at: new Date(this.now()).toISOString() });
      this._emit(job, { phase: 'done', percent: 100, downloaded: bytes, total: bytes, message: 'Pronto.' }, { force: true });
      return { path: finalPath, bytes, origin, meta, chat, chatNote, warnings, resumed: resumeBytes > 0 };
    } catch (err) {
      const code = err && err.code ? err.code : 'ERROR';
      this._emit(job, { phase: code === 'CANCELLED' ? 'cancelled' : 'error', message: err.message }, { force: true });
      throw err;
    } finally {
      this.job = null;
    }
  }

  /** Arquivo de vídeo gerado na pasta de trabalho (video.mp4; se o yt-dlp usar outro contêiner, o maior video.*). */
  _findOutput(workDir) {
    let best = null;
    try {
      for (const name of fs.readdirSync(workDir)) {
        if (!/^video\.[A-Za-z0-9]+$/.test(name) || /\.(part|ytdl|temp)$/i.test(name)) continue;
        const size = fs.statSync(path.join(workDir, name)).size;
        if (size > 0 && (!best || size > best.size)) best = { name, size };
      }
    } catch { return null; }
    return best ? path.join(workDir, best.name) : null;
  }

  // ------------------------------------------------------------------ chat

  chatFile(platform, videoId) {
    const safe = `${platform}-${videoId}`.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(this.chatsDir, `${safe}.json`);
  }

  /** Chat dentro de um download de vídeo: qualquer falha vira uma nota, nunca derruba o vídeo já salvo. */
  async _fetchChatSafe(job, parsed) {
    try {
      const got = await this._fetchChat(job, parsed);
      return { chat: got.chat, note: got.chat ? null : got.reason };
    } catch (err) {
      return { chat: null, note: err.code === 'CANCELLED' ? 'O download do chat foi cancelado; o vídeo já está salvo.' : err.message };
    }
  }

  /**
   * Baixa o chat, converte para bf-chat-1 e grava em userData/chats/<plataforma>-<id>.json.
   * Devolve { chat:{ path, format, count, fetchedAt, platform } } ou { chat:null, reason } quando não há chat.
   * Falhas reais lançam SourcesError.
   */
  async _fetchChat(job, parsed) {
    const t = this._tools();
    const signal = job.controller.signal;
    const workDir = path.join(this.workRoot, `chat-${job.id}`);
    const progress = (percent, message) => this._emit(job, { phase: 'chat', percent, message: message || 'Baixando o chat…' });
    try {
      let converted;
      if (parsed.platform === 'twitch') {
        if (!t.twitch) {
          return { chat: null, reason: 'Para baixar o chat da Twitch, instale o TwitchDownloaderCLI na aba Ferramentas e baixe o chat depois.', code: 'NO_TWITCHDOWNLOADER' };
        }
        this.active.twitch += 1;
        try {
          converted = await downloadTwitchChat({ exe: t.twitch, videoId: parsed.videoId, workDir, signal, onProgress: (p) => progress(p), version: undefined });
        } finally { this.active.twitch -= 1; }
      } else {
        const y = this._ytContext();
        this.active.ytdlp += 1;
        const tempDir = await this._makeTemp(); // TEMP só deste yt-dlp (veja _runWithTemp)
        try {
          converted = await downloadYoutubeChat({
            exe: y.exe, url: parsed.url, videoId: parsed.videoId, common: y.common, workDir, signal, env: tempDir ? yt.withTempDir(y.env, tempDir) : y.env,
            usedCookies: y.usedCookies, hasJsRuntime: y.hasJsRuntime,
            onActivity: (bytes) => progress(null, `Baixando o chat… ${fmtBytes(bytes)}`)
          });
        } finally {
          await this._removeTemp(tempDir);
          this.active.ytdlp -= 1;
        }
        if (!converted.chat) return { chat: null, reason: converted.reason };
      }
      if (converted.chat.messages.length === 0) {
        return { chat: null, reason: 'O chat deste vídeo não tem mensagens: ele estava desativado ou ninguém escreveu.' };
      }
      const file = this.chatFile(parsed.platform, parsed.videoId);
      const written = await chatFormat.writeChat(file, converted.chat);
      return { chat: { path: file, format: chatFormat.FORMAT, count: written.count, fetchedAt: converted.chat.fetchedAt, platform: parsed.platform }, skipped: converted.skipped };
    } finally {
      await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** IPC sources:chat: baixa só o chat de um VOD (por exemplo, de um projeto aberto sem chat). */
  async downloadChat({ url } = {}) {
    const parsed = this._parse(url);
    const job = this._newJob('chat', { url: parsed.url, videoId: parsed.videoId, platform: parsed.platform });
    try {
      this._emit(job, { phase: 'chat', message: 'Baixando o chat…' }, { force: true });
      const got = await this._fetchChat(job, parsed);
      if (!got.chat) throw new SourcesError(got.code || 'NO_CHAT', got.reason, { dependsOnAccess: true });
      // vincula ao VOD baixado por aqui (se houver) para a próxima abertura já trazer o chat
      for (const d of this.store.data.downloads) if (d.origin && d.origin.videoId === parsed.videoId && d.origin.platform === parsed.platform) this.store.updateChat(d.path, got.chat);
      this._emit(job, { phase: 'done', percent: 100, message: `Chat baixado: ${got.chat.count} mensagens.` }, { force: true });
      return { chat: got.chat };
    } catch (err) {
      this._emit(job, { phase: err.code === 'CANCELLED' ? 'cancelled' : 'error', message: err.message }, { force: true });
      throw err;
    } finally {
      this.job = null;
    }
  }

  /** Confere o arquivo de chat de um projeto: { exists, count } ou { exists:false, reason }. */
  async chatCheck(file) {
    try {
      const chat = await chatFormat.readChat(file);
      return { exists: true, count: chat.messages.length, platform: chat.platform };
    } catch (err) {
      return { exists: false, reason: err.message, code: err.code };
    }
  }
}

module.exports = { SourcesManager, WORKDIR_PREFIX, fmtBytes, assessDisk };

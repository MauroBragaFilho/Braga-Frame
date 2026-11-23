'use strict';

const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { findTools } = require('../core/ffmpeg/locate');
const { ProjectStore } = require('../core/projects/projectStore');
const registry = require('../core/tools/registry');
const { loadToolCatalog, toolKeyFor } = require('../core/tools/catalog');

/** Mesmo formato aceito pelo preload (arquitetura 1.2): "<recurso>:<acao>". */
const CHANNEL_RE = /^[a-z][a-zA-Z0-9]*:[a-zA-Z0-9]+$/;
const TOOL_KEYS = Object.freeze(['ffmpeg', 'ffprobe', 'ytdlp', 'whisper', 'twitchDownloader']);

/**
 * Onde procurar no sistema as ferramentas que o app também sabe instalar: nome no PATH e variável de
 * ambiente que aponta direto para o executável. (ffmpeg/ffprobe têm a procura própria em resolveTools: vêm do mesmo pacote.)
 */
const SYSTEM_LOOKUP = Object.freeze({
  ytdlp: { name: 'yt-dlp', env: 'CORTE_YTDLP' },
  whisper: { name: 'whisper-cli', env: 'CORTE_WHISPER' },
  twitchDownloader: { name: 'TwitchDownloaderCLI', env: 'CORTE_TWITCHDOWNLOADER' }
});

/**
 * Descobre onde estão as ferramentas externas, nesta ordem:
 *   1. a ferramenta instalada pelo app em `paths.tools` (conferida no disco a cada chamada) tem preferência, inclusive o ffmpeg e o ffprobe
 *      (que o botão "Instalar" da aba Ferramentas traz do mesmo pacote);
 *   2. sem ela, a variável CORTE_* (CORTE_FFMPEG, CORTE_FFPROBE, CORTE_YTDLP…) e depois o PATH.
 * Devolve { ffmpeg, ffprobe, ytdlp, whisper, twitchDownloader } com caminho ou null.
 */
function resolveTools({ paths, env = process.env, entries } = {}) {
  const out = { ffmpeg: null, ffprobe: null, ytdlp: null, whisper: null, twitchDownloader: null };

  const installed = {};
  if (paths && paths.tools) {
    const list = entries || registry.getEntries();
    const byId = registry.resolveAll(paths.tools, { entries: list });
    for (const entry of list) {
      const key = toolKeyFor(entry.id);
      if (!key || !byId[entry.id]) continue;
      installed[key] = byId[entry.id];
      // programas extras do mesmo pacote (o ffprobe vem junto do ffmpeg)
      for (const [extraKey, file] of Object.entries(registry.resolveExtras(paths.tools, entry.id, { entries: list }))) {
        if (TOOL_KEYS.includes(extraKey)) installed[extraKey] = file;
      }
    }
  }
  // uma única varredura do PATH para tudo o que ainda não foi achado (veja locate.js)
  const specs = [
    { key: 'ffmpeg', name: 'ffmpeg', envVar: 'CORTE_FFMPEG' },
    { key: 'ffprobe', name: 'ffprobe', envVar: 'CORTE_FFPROBE' },
    ...Object.entries(SYSTEM_LOOKUP).map(([key, spec]) => ({ key, name: spec.name, envVar: spec.env }))
  ].filter((spec) => !installed[spec.key]);
  Object.assign(out, findTools(specs, env), installed);
  return out;
}

/** Valor seguro para atravessar o IPC (clonável); descarta o que não for JSON. */
function plain(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch { return undefined; }
}

/** Erro -> resposta padronizada { ok:false, code, message, details? }. */
function failure(err) {
  const e = err instanceof Error ? err : new Error(String(err));
  const res = { ok: false, code: typeof e.code === 'string' && e.code ? e.code : 'ERROR', message: e.message || 'Erro inesperado.' };
  const details = plain(e.details);
  if (details !== undefined) res.details = details;
  return res;
}

/**
 * Monta o `ctx` entregue a cada handler (arquitetura 1.1). As dependências do Electron entram por
 * parâmetro, o que permite testar tudo sem abrir o app.
 *
 * @param {object} deps { ipcMain, app, dialog, shell, getWindow, userDataDir?, resolveTools?, logger?, env?, toolCatalog?, send? }
 *   host: { embedded, name, tool(chave), whisperModels } do hospedeiro (src/host/index.js); sem ele, o app é dono de tudo;
 *   env: ambiente consultado (padrão: process.env); toolCatalog: catálogo de ferramentas pronto (testes);
 *   send(canal, payload): destino alternativo dos eventos (módulo embutido, veja src/host/index.js)
 */
function createContext(deps) {
  const { ipcMain, app, dialog, shell } = deps;
  const getWindow = deps.getWindow || (() => null);
  const logger = deps.logger || console;
  const resolver = deps.resolveTools || resolveTools;
  const env = deps.env || process.env;

  const userData = deps.userDataDir || app.getPath('userData');
  const paths = {
    userData,
    projects: path.join(userData, 'projects'),
    tools: path.join(userData, 'tools'),
    cache: path.join(userData, 'cache'),
    downloads: path.join(userData, 'downloads')
  };
  for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });

  const host = deps.host || { embedded: false, name: null, tool: () => null, whisperModels: null, ai: null };

  const bus = new EventEmitter();
  const registered = new Set();

  function log(level, msg) {
    const fn = typeof logger[level] === 'function' ? logger[level] : logger.log;
    fn.call(logger, `[bf][${level}] ${msg}`);
  }

  // `deps.send` (src/host: módulo embutido em outro app) troca o destino dos eventos; sem ele, vão para a janela do app
  const customSend = typeof deps.send === 'function' ? deps.send : null;
  function send(channel, payload) {
    if (customSend) {
      try { customSend(channel, payload); } catch (err) { log('warn', `evento ${channel} não foi entregue: ${err && err.message}`); }
      return;
    }
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  // catálogo das ferramentas instaláveis (entries/*.js; as de teste só fora de produção, veja catalog.js)
  const toolCatalog = deps.toolCatalog || loadToolCatalog({ env, isPackaged: app ? app.isPackaged : undefined });
  for (const { file, message } of toolCatalog.errors) log('warn', `ferramentas: ${file}: ${message}`);
  if (toolCatalog.testIds.length) log('warn', `ferramentas: entradas de TESTE ativas (${toolCatalog.testIds.join(', ')}); isto nunca deve ocorrer em produção`);

  // objeto vivo: quem guardou `ctx.tools` sempre enxerga o estado atual
  const tools = Object.fromEntries(TOOL_KEYS.map((key) => [key, null]));
  function updateTools(notify, force = false) {
    const found = resolver({ paths, env, entries: toolCatalog.entries }) || {};
    const before = JSON.stringify(tools);
    for (const key of TOOL_KEYS) tools[key] = found[key] || null;
    if (notify && (force || JSON.stringify(tools) !== before)) {
      bus.emit('tools:changed', tools);
      send('tools:changed', { tools: { ...tools } });
    }
    return tools;
  }
  /**
   * Procura as ferramentas de novo (atualiza `ctx.tools` no lugar) e avisa se algo mudou.
   * `{ force: true }` avisa mesmo sem mudança em `ctx.tools` (a tela de Ferramentas precisa recarregar
   * depois de instalar/remover, mesmo quando a ferramenta não alimenta o `ctx.tools`).
   */
  const refreshTools = (opts) => updateTools(true, Boolean(opts && opts.force));

  // Quem usa uma ferramenta (fila, legendas, fontes…) se registra aqui para que ela não seja removida
  // ou substituída no meio do trabalho: fn(chave, id) devolve o motivo (texto) se está em uso, ou null.
  const usageChecks = new Set();
  const toolUsage = {
    register(fn) {
      if (typeof fn !== 'function') throw new Error('toolUsage.register(fn): informe uma função.');
      usageChecks.add(fn);
      return () => { usageChecks.delete(fn); };
    },
    inUse(key, id) {
      for (const fn of [...usageChecks]) {
        let why = null;
        try { why = fn(key, id); } catch (err) { log('warn', `toolUsage: verificação falhou (${err.message})`); }
        if (why) return String(why);
      }
      return null;
    }
  };

  /**
   * Registra `ipcMain.handle(channel)`. `fn(payload, event)` devolve um objeto (ganha `ok:true` se não
   * trouxer `ok`); exceções viram { ok:false, code, message, details? } — a mensagem deve estar em
   * português e dizer causa e possível solução.
   */
  const handlers = new Map(); // canal -> fn (para `ctx.call`)

  /** Roda o handler de um canal com a mesma conversão de resultado e de erro do IPC. */
  async function run(channel, fn, payload, event) {
    try {
      const out = await fn(payload === undefined || payload === null ? {} : payload, event);
      if (out === undefined || out === null) return { ok: true };
      return typeof out === 'object' && !Array.isArray(out) && out.ok === undefined ? { ok: true, ...out } : out;
    } catch (err) {
      log(err && err.code ? 'warn' : 'error', `${channel}: ${err && err.message}${err && err.code ? ` (${err.code})` : ''}`);
      return failure(err);
    }
  }

  function handle(channel, fn) {
    if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) {
      throw new Error(`Canal IPC inválido: "${channel}". Use "<recurso>:<acao>" (ex.: queue:enqueue).`);
    }
    if (registered.has(channel)) throw new Error(`Canal IPC já registrado por outro handler: ${channel}`);
    registered.add(channel);
    handlers.set(channel, fn);
    ipcMain.handle(channel, (event, payload) => run(channel, fn, payload, event));
  }

  /**
   * Chama um canal por dentro do processo principal (sem passar pelo renderer): o que o servidor MCP usa para reaproveitar `project:list`,
   * `queue:list`, `analysis:transcriptGenerate`… com a mesma validação e os mesmos erros. Resolve sempre com `{ ok, … }` / `{ ok:false, code, message }`.
   */
  async function call(channel, payload) {
    const fn = handlers.get(channel);
    if (!fn) return failure(Object.assign(new Error(`Canal desconhecido: ${channel}.`), { code: 'UNKNOWN_CHANNEL' }));
    return run(channel, fn, payload, null);
  }

  // Quem tem trabalho em andamento sobre um projeto (fila de exportação, análise, transcrição…) registra aqui `(project) => texto | null`: o texto diz,
  // em português, o que ainda está rodando. Apagar o projeto (project:delete) espera por isso, para nada recriar o arquivo do projeto depois de apagado
  // nem tentar apagar um vídeo que o ffmpeg está lendo.
  const busyChecks = [];
  /** Por que o projeto não pode ser apagado agora (o primeiro aviso dos `busyChecks`), ou null. Um verificador com defeito nunca bloqueia nem derruba. */
  function projectBusy(project) {
    for (const check of busyChecks) {
      try {
        const why = check(project);
        if (why) return String(why);
      } catch (err) {
        log('warn', `verificação de uso do projeto falhou: ${err && err.message}`);
      }
    }
    return null;
  }

  const ctx = {
    ipcMain, app, dialog, shell,
    getWindow, send, paths, tools, refreshTools, toolCatalog, toolUsage,
    // o que o hospedeiro fornece (módulo embutido, src/host): ferramentas e modelos dele; sem hospedeiro, tudo vazio
    host,
    projectStore: new ProjectStore(paths.projects),
    bus, log, handle, call,
    busyChecks, projectBusy,
    channels: registered,
    env, // o ambiente consultado (padrão: process.env); os handlers o usam para as variáveis só de teste
    fetch: typeof deps.fetch === 'function' ? deps.fetch : null // rede dos handlers (testes injetam a deles; sem ela vale o fetch global)
  };
  updateTools(false);
  return ctx;
}

module.exports = { createContext, resolveTools, failure, CHANNEL_RE, TOOL_KEYS, SYSTEM_LOOKUP };

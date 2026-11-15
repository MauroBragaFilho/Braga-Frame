'use strict';

/**
 * Camada de acoplamento do Braga Frame (processo principal).
 *
 * `createBfModule(options)` empacota tudo o que o Braga Frame faz no processo principal (contexto, handlers de `src/ipc`,
 * ferramentas, fila, projetos…) num objeto que quem hospeda decide como usar:
 *
 *   - app próprio (main.js): registra os canais direto no `ipcMain`, sem prefixo;
 *   - embutido em outro app (Braga Digital Studio): NÃO registra nada no `ipcMain`; o hospedeiro cria UM canal genérico
 *     (ex.: `bf:invoke`) que repassa para `module.invoke(canal, payload)` e entrega os eventos de `options.send`.
 *
 * Contrato completo, trechos prontos para o BDS e riscos: docs/modulo-bds.md.
 *
 * Garantias:
 *   - todo o estado do módulo vive em `userDataDir` (projetos, fila, preferências, cache, ferramentas instaladas…);
 *   - nenhum estado em variável global do módulo: duas instâncias (pastas diferentes) coexistem. A única exceção conhecida é o
 *     cache de codificadores (`core/export/encoders.js`), que guarda a pasta do ÚLTIMO módulo registrado e só tem conteúdo
 *     regenerável (veja docs/modulo-bds.md, "Riscos");
 *   - `dispose()` para processos, filas e instalações, solta os canais do `ipcMain` e os ouvintes do `app`; depois dele a
 *     instância não responde mais (para ligar de novo, crie outra com createBfModule).
 */

const fs = require('node:fs');
const path = require('node:path');
const appInfo = require('../appInfo');
const { createContext, resolveTools, CHANNEL_RE, TOOL_KEYS } = require('../ipc/context');
const { loadHandlers } = require('../ipc');
const { OpenRequests } = require('./openRequests');
const { validateVideoPath } = require('./cli');

const MODULE_ID = 'frame';
const PREFIX_RE = /^(?:[a-zA-Z][a-zA-Z0-9]*:)?$/;
const WINDOW_CHANNEL_RE = /^window:/;

let packageVersion = '0.0.0';
try { packageVersion = require('../../package.json').version || packageVersion; } catch { /* empacotado sem o package.json: a versão vem de options.version */ }

function fail(code, message) {
  return { ok: false, code, message };
}

const disposedResult = () => fail('MODULE_DISPOSED', 'O Braga Frame foi desligado. Ligue o módulo de novo para usá-lo.');

/** Ferramentas que o hospedeiro pode fornecer: as de `ctx.tools` e o Deno (runtime JavaScript do yt-dlp, que não é de `ctx.tools`). */
const HOST_TOOL_KEYS = Object.freeze([...TOOL_KEYS, 'deno']);

/** Ferramentas do hospedeiro: cada valor é um caminho (texto) ou uma função que devolve o caminho (ou null). */
function normalizeHostTools(tools) {
  const out = {};
  if (!tools || typeof tools !== 'object') return out;
  for (const key of HOST_TOOL_KEYS) {
    const value = tools[key];
    if (typeof value === 'string' || typeof value === 'function') out[key] = value;
  }
  return out;
}

/**
 * Sobrepõe o que o Braga Frame achou sozinho com as ferramentas do hospedeiro. Só vale caminho absoluto de um arquivo que
 * existe: um caminho do hospedeiro que sumiu (ferramenta desinstalada) cai de volta para a resolução normal do app.
 */
function applyHostTools(found, hostTools, log) {
  const out = { ...found };
  for (const [key, source] of Object.entries(hostTools)) {
    let value = null;
    try { value = typeof source === 'function' ? source() : source; } catch (err) { log('warn', `ferramenta ${key} do hospedeiro: ${err && err.message}`); }
    if (typeof value === 'string' && path.isAbsolute(value) && fs.existsSync(value)) out[key] = value;
  }
  return out;
}

/**
 * Modelos do Whisper do hospedeiro (`options.whisperModels`): `resolve(id)` devolve o caminho absoluto do arquivo do modelo já instalado
 * no hospedeiro (ou null) e `install(id, { signal, onProgress })` pede a ele que instale (ele é o dono da pasta, do download e da conferência).
 * Sem as duas funções a opção é ignorada.
 */
function normalizeWhisperModels(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.resolve !== 'function' || typeof value.install !== 'function') return null;
  return Object.freeze({ resolve: value.resolve.bind(value), install: value.install.bind(value), cancel: typeof value.cancel === 'function' ? value.cancel.bind(value) : null });
}

/**
 * Provedor de IA do hospedeiro (`options.ai`): `describe()` devolve { id, label, model, hasKey, ready, reason?, serverHost?, isLocal? } (ou null se
 * não há provedor) e `chat({ system, messages, maxTokens, temperature, jsonMode, signal })` faz a requisição e devolve
 * { text, usage?, finishReason?, model? }. O HOSPEDEIRO é o dono da chave e da requisição: o Braga Frame nunca a recebe nem a guarda.
 * Sem as duas funções a opção é ignorada.
 */
function normalizeAiProvider(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.describe !== 'function' || typeof value.chat !== 'function') return null;
  return Object.freeze({ describe: value.describe.bind(value), chat: value.chat.bind(value) });
}

/** `options.log` (função (nivel, mensagem) ou objeto tipo console) -> objeto com log/info/warn/error. */
function makeLogger(log) {
  if (log && typeof log === 'object') return log;
  if (typeof log !== 'function') return console;
  const bind = (level) => (message) => log(level, message);
  return { log: bind('info'), info: bind('info'), warn: bind('warn'), error: bind('error') };
}

function requireObject(options, key) {
  const value = options[key];
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new TypeError(`createBfModule: a opção "${key}" é obrigatória.`);
  }
  return value;
}

/**
 * @param {object} options
 * @param {object}   options.app            `app` do Electron (usa-se só getPath('videos'), on/removeListener('before-quit') e isPackaged)
 * @param {object}   options.dialog         `dialog` do Electron (escolher vídeo/pasta)
 * @param {object}   options.shell          `shell` do Electron (mostrar no Explorer)
 * @param {string}   options.userDataDir    pasta PRÓPRIA do módulo (absoluta). Ex.: <userData do hospedeiro>/braga-frame
 * @param {Function} [options.getWindow]    janela usada como pai dos diálogos e destino padrão dos eventos
 * @param {object}   [options.ipcMain]      se informado, cada canal também é registrado nele (com `channelPrefix`)
 * @param {Function} [options.send]         send(canal, payload): destino dos eventos (nomes SEM prefixo). Sem ela, vão a getWindow()
 * @param {string}   [options.channelPrefix] '' (padrão) ou "bf:": prefixo dos canais no `ipcMain` e dos eventos enviados à janela
 * @param {object}   [options.tools]        { ffmpeg, ffprobe, ytdlp, whisper, twitchDownloader }: caminho ou função que devolve o
 *                                          caminho. Valem ANTES do que o Braga Frame resolveria sozinho; o hospedeiro é o dono delas
 * @param {object}   [options.whisperModels] { resolve(id), install(id, { signal, onProgress }), cancel?(id) }: modelos do Whisper do hospedeiro
 *                                          (o Braga Frame os usa em vez de baixar os seus e delega a ele a instalação de outros)
 * @param {object}   [options.ai]           { describe(), chat(params) }: provedor de IA do hospedeiro (a chave e a requisição ficam com ele; veja normalizeAiProvider)
 * @param {string}   [options.hostName]     nome curto do hospedeiro para a interface ("BDS": "Fornecida pelo BDS")
 * @param {boolean}  [options.embedded]     true quando roda dentro de outro app (a interface mostra o que vem do hospedeiro)
 * @param {boolean}  [options.windowControls] registra os canais window:* (minimizar/maximizar/fechar a janela). Só o app próprio
 *                                          precisa; embutido, deixe desligado (senão a interface fecharia a janela do hospedeiro)
 * @param {Function|object} [options.log]   (nivel, mensagem) ou objeto tipo console
 * @param {string}   [options.version]      versão mostrada em app:info (padrão: a do package.json do Braga Frame)
 * @param {object}   [options.env]          ambiente consultado para achar ferramentas (padrão: process.env)
 * @param {object}   [options.toolCatalog]  catálogo de ferramentas pronto (testes)
 * @param {string}   [options.handlersDir]  pasta de handlers (testes)
 */
function createBfModule(options = {}) {
  if (!options || typeof options !== 'object') throw new TypeError('createBfModule: informe as opções.');
  const app = requireObject(options, 'app');
  const dialog = requireObject(options, 'dialog');
  const shell = requireObject(options, 'shell');
  const { userDataDir } = options;
  if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir)) {
    throw new TypeError('createBfModule: "userDataDir" precisa ser o caminho absoluto da pasta própria do módulo.');
  }
  const prefix = options.channelPrefix === undefined || options.channelPrefix === null ? '' : options.channelPrefix;
  if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) {
    throw new TypeError('createBfModule: "channelPrefix" deve ser vazio ou do tipo "bf:".');
  }
  if (options.send !== undefined && typeof options.send !== 'function') throw new TypeError('createBfModule: "send" precisa ser uma função.');
  const realIpc = options.ipcMain || null;
  const getWindow = typeof options.getWindow === 'function' ? options.getWindow : () => null;
  const windowControls = options.windowControls === true;
  const hostTools = normalizeHostTools(options.tools);
  const whisperModels = normalizeWhisperModels(options.whisperModels);
  const aiProvider = normalizeAiProvider(options.ai);
  const logger = makeLogger(options.log);
  const version = typeof options.version === 'string' && options.version ? options.version : packageVersion;

  const meta = Object.freeze({
    id: MODULE_ID,
    title: appInfo.name,
    description: appInfo.tagline,
    version
  });

  const handlers = new Map(); // canal (sem prefixo) -> listener(event, payload), o mesmo que iria para o ipcMain
  const realChannels = []; // nomes (com prefixo) registrados no ipcMain real
  const beforeQuit = new Set(); // ouvintes de 'before-quit' dos handlers (chamados no dispose, no máximo uma vez)
  const appListeners = []; // [evento, função] registrados no app real, para soltar no dispose
  const openRequests = new OpenRequests();
  let ctx = null;
  let registration = null;
  let disposed = false;

  const log = (level, message) => {
    const fn = typeof logger[level] === 'function' ? logger[level] : logger.log;
    if (typeof fn === 'function') { try { fn.call(logger, `[bf][${level}] ${message}`); } catch { /* log nunca derruba */ } }
  };

  // ---------- "ipcMain" do módulo: guarda os listeners (para invoke) e, se houver, repassa ao ipcMain real ----------

  const ipcFacade = {
    handle(channel, listener) {
      if (!windowControls && WINDOW_CHANNEL_RE.test(channel)) return; // controles da janela só no app próprio
      if (handlers.has(channel)) throw new Error(`Canal IPC já registrado: ${channel}`);
      handlers.set(channel, listener);
      if (realIpc) {
        realIpc.handle(prefix + channel, listener);
        realChannels.push(prefix + channel);
      }
    }
  };

  // ---------- "app" do módulo: os handlers pedem a pasta de dados e se registram para o fechamento ----------

  const appFacade = {
    get isPackaged() { return app.isPackaged; },
    getVersion: () => version,
    // a pasta de dados é sempre a do módulo; as demais (ex.: 'videos', usada como sugestão de onde salvar downloads) são do sistema
    getPath: (name) => (name === 'userData' ? userDataDir : app.getPath(name)),
    on(event, listener) {
      let fn = listener;
      if (event === 'before-quit') {
        let fired = false;
        fn = (...args) => { if (fired) return undefined; fired = true; return listener(...args); };
        beforeQuit.add(fn);
      }
      if (typeof app.on === 'function') {
        app.on(event, fn);
        appListeners.push([event, fn]);
      }
      return appFacade;
    }
  };

  function removeAppListener(event, fn) {
    try {
      if (typeof app.removeListener === 'function') app.removeListener(event, fn);
      else if (typeof app.off === 'function') app.off(event, fn);
    } catch { /* o app pode já estar encerrando */ }
  }

  // ---------- eventos main -> interface ----------

  function emit(channel, payload) {
    if (disposed) return;
    try {
      if (options.send) {
        options.send(channel, payload);
        return;
      }
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send(prefix + channel, payload);
    } catch (err) { // a janela do hospedeiro pode ter fechado no meio: um evento perdido não derruba o módulo
      log('warn', `evento ${channel} não foi entregue: ${err && err.message}`);
    }
  }

  // ---------- o que o hospedeiro fornece ----------

  /** Caminho atual de uma ferramenta do hospedeiro (consultado na hora; só vale arquivo absoluto que existe) ou null. */
  function hostTool(key) {
    return applyHostTools({}, Object.hasOwn(hostTools, key) ? { [key]: hostTools[key] } : {}, log)[key] || null;
  }

  const hostInfo = Object.freeze({
    embedded: options.embedded === true || Boolean(options.tools) || Boolean(whisperModels) || Boolean(aiProvider),
    name: typeof options.hostName === 'string' && options.hostName.trim() ? options.hostName.trim().slice(0, 40) : null,
    tool: hostTool,
    whisperModels,
    ai: aiProvider
  });

  // ---------- registro ----------

  function resolver(args) {
    return applyHostTools(resolveTools(args), hostTools, log);
  }

  /** Canais que só existem para o encaixe (não pertencem a nenhum recurso). */
  function registerHostChannels(context) {
    // a interface busca aqui os vídeos pedidos de fora (linha de comando, hospedeiro); cada pedido sai uma única vez
    context.handle('app:takeOpenRequest', () => ({ requests: openRequests.take() }));
    // o hospedeiro (ou qualquer parte da interface) pede para abrir um vídeo: { path } -> confere e entra na fila; a interface abre
    context.handle('app:requestOpen', (payload) => {
      const checked = validateVideoPath(payload && payload.path);
      if (!checked.ok) {
        const err = new Error(checked.message);
        err.code = checked.code;
        throw err;
      }
      requestOpen({ videoPath: checked.path });
      return { path: checked.path };
    });
  }

  function register() {
    if (disposed) throw new Error(disposedResult().message);
    if (registration) return registration;
    ctx = createContext({
      ipcMain: ipcFacade,
      app: appFacade,
      dialog,
      shell,
      getWindow,
      userDataDir,
      resolveTools: resolver,
      logger,
      env: options.env,
      toolCatalog: options.toolCatalog,
      host: hostInfo,
      send: emit
    });
    ctx.handlers = loadHandlers(ctx, options.handlersDir);
    registerHostChannels(ctx);
    registration = Object.freeze({
      loaded: ctx.handlers.loaded.slice(),
      failed: ctx.handlers.failed.slice(),
      channels: [...handlers.keys()].sort()
    });
    log('info', `módulo ${MODULE_ID} registrado: ${handlers.size} canais, pasta ${userDataDir}${prefix ? `, prefixo "${prefix}"` : ''}`);
    if (openRequests.size) emit('app:openRequest', { count: openRequests.size });
    return registration;
  }

  // ---------- chamada direta ----------

  /** Resolve o nome do canal: aceita o nome simples ("tools:status") ou, se houver prefixo, o completo ("bf:tools:status"). */
  function resolveChannel(channel) {
    if (typeof channel !== 'string') return null;
    if (CHANNEL_RE.test(channel)) return channel;
    if (prefix && channel.startsWith(prefix) && CHANNEL_RE.test(channel.slice(prefix.length))) return channel.slice(prefix.length);
    return null;
  }

  /**
   * Chama um handler SEM passar pelo ipcMain. `event` (opcional) é o evento do ipcMain do hospedeiro, repassado ao handler.
   * Nunca lança: erros viram { ok:false, code, message }, igual aos canais reais. O módulo se registra sozinho na primeira chamada.
   */
  async function invoke(channel, payload, event) {
    if (disposed) return disposedResult();
    const name = resolveChannel(channel);
    if (!name) return fail('INVALID_CHANNEL', `Canal inválido: "${String(channel)}". Use "<recurso>:<acao>".`);
    if (!registration) {
      try { register(); } catch (err) { return fail('MODULE_START_FAILED', `O Braga Frame não conseguiu iniciar: ${err && err.message}`); }
    }
    const listener = handlers.get(name);
    if (!listener) return fail('UNKNOWN_CHANNEL', `Canal desconhecido: ${name}.`);
    try {
      return await listener(event || { sender: null, senderFrame: null, synthetic: true }, payload);
    } catch (err) { // o listener já trata os erros do handler; isto só cobre falhas inesperadas
      return fail('ERROR', (err && err.message) || 'Erro inesperado.');
    }
  }

  // ---------- pedidos de abrir vídeo ----------

  /**
   * Pede para a interface abrir um vídeo. `input` = caminho (texto, conferido aqui) ou o resultado de `parseCli`
   * (src/host/cli.js). Devolve true se o pedido ficou na fila (o aviso à interface sai junto).
   */
  function requestOpen(input) {
    if (disposed) return false;
    let request = input;
    if (typeof input === 'string') {
      const checked = validateVideoPath(input);
      request = checked.ok ? { videoPath: checked.path } : { error: { code: checked.code, message: checked.message } };
    }
    const stored = openRequests.push(request);
    if (stored && registration) emit('app:openRequest', { count: openRequests.size });
    return stored;
  }

  // ---------- desligar ----------

  /**
   * Desliga o módulo: roda o fechamento de cada recurso (fila grava o estado e marca o que rodava como interrompido, processos
   * do ffmpeg/yt-dlp/whisper param, instalações e downloads são cancelados), solta os canais do ipcMain e os ouvintes do app.
   * Idempotente. Não apaga nenhum dado do usuário.
   */
  function dispose() {
    if (disposed) return;
    for (const listener of [...beforeQuit]) {
      try { listener(); } catch (err) { log('warn', `falha ao encerrar um recurso: ${err && err.message}`); }
    }
    disposed = true;
    beforeQuit.clear();
    for (const [event, fn] of appListeners) removeAppListener(event, fn);
    appListeners.length = 0;
    if (realIpc && typeof realIpc.removeHandler === 'function') {
      for (const name of realChannels) {
        try { realIpc.removeHandler(name); } catch { /* já solto */ }
      }
    }
    realChannels.length = 0;
    handlers.clear();
    openRequests.take();
    if (ctx && ctx.bus) ctx.bus.removeAllListeners();
    log('info', `módulo ${MODULE_ID} desligado`);
  }

  return {
    meta,
    register,
    invoke,
    dispose,
    requestOpen,
    /** Envia um evento à interface do módulo (mesmo caminho dos eventos dos handlers). */
    send: emit,
    /** Canais aceitos por invoke(), sem prefixo (ordenados). `{ prefixed: true }` devolve os nomes do ipcMain real. */
    channels({ prefixed = false } = {}) {
      const names = [...handlers.keys()].sort();
      return prefixed ? names.map((n) => prefix + n) : names;
    },
    get ctx() { return ctx; },
    get registered() { return Boolean(registration); },
    get disposed() { return disposed; },
    get channelPrefix() { return prefix; },
    get userDataDir() { return userDataDir; }
  };
}

module.exports = { createBfModule, MODULE_ID, applyHostTools, normalizeHostTools, normalizeWhisperModels, normalizeAiProvider, HOST_TOOL_KEYS };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createContext } = require('./context');

const HANDLERS_DIR = path.join(__dirname, 'handlers');

/**
 * Carrega todo `handlers/*.js` (em ordem alfabética); cada arquivo exporta `register(ctx)`.
 * Um handler que falha ao carregar não derruba os demais: o erro fica registrado em `failed`
 * (e no log) e o app avisa o usuário.
 */
function loadHandlers(ctx, dir = HANDLERS_DIR) {
  const loaded = [];
  const failed = [];
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort() : [];
  for (const file of files) {
    try {
      const mod = require(path.join(dir, file));
      if (typeof mod.register !== 'function') throw new Error('o arquivo não exporta register(ctx)');
      mod.register(ctx);
      loaded.push(file);
    } catch (err) {
      failed.push({ file, message: err.message });
      ctx.log('error', `handler ${file} não carregou: ${err.stack || err.message}`);
    }
  }
  return { loaded, failed };
}

/** Cria o ctx e registra todos os handlers. Chamado por main.js depois de `app.whenReady()`. */
function setupIpc(deps) {
  const ctx = createContext(deps);
  ctx.handlers = loadHandlers(ctx, deps.handlersDir);
  return ctx;
}

module.exports = { setupIpc, loadHandlers, HANDLERS_DIR };

'use strict';

const McpService = require('../../mcp/McpService');
const { RendererBridge } = require('../../mcp/RendererBridge');
const { createToolbox } = require('../../mcp/toolbox');

/**
 * Conexão de agentes de IA externos (servidor MCP local; dono: base). Canais:
 *   mcp:status                     -> { available, reason?, enabled, running, port, url, calls, client, autoConfirm, error }
 *   mcp:setEnabled { enabled }     -> o mesmo; liga ou desliga o servidor (DESLIGADO por padrão)
 *   mcp:regenerateToken            -> o mesmo; quem usava o token antigo perde o acesso
 *   mcp:setOptions { autoConfirm } -> o mesmo; dispensa (ou volta a pedir) a janela de confirmação das ações do agente
 *   mcp:copyConfig { kind }        -> { kind }; copia a configuração pronta (antigravity | http | stdio) para a área de transferência; o token NÃO passa pelo renderer
 *   mcp:reply { id, ok, result | code, message } -> o renderer responde a uma operação pedida pelo servidor (evento mcp:request, veja src/mcp/RendererBridge.js)
 * Eventos (main -> renderer): mcp:state { …status } (um agente conectou, uma chamada terminou, ligou/desligou) e mcp:request { id, op, args }.
 *
 * O servidor, o token e as ferramentas estão em src/mcp/. Módulo embutido (ctx.host.embedded): não há servidor (o hospedeiro tem o dele): `available:false`.
 * Pontos de injeção só para testes (nunca definidos no app): `ctx.mcpOptions = { send, available, clipboard, configDir, version }`.
 */
function register(ctx) {
  const options = ctx.mcpOptions || {};
  const embedded = Boolean(ctx.host && ctx.host.embedded);
  const NOT_AVAILABLE = embedded ? `O Braga Frame está dentro do ${ctx.host.name || 'aplicativo'}: os agentes de IA se conectam pelo MCP dele.` : null;

  let service = null;
  let bridge = null;

  if (!embedded) {
    const send = options.send || ((channel, payload) => ctx.send(channel, payload));
    const available = options.available || (() => {
      const win = ctx.getWindow();
      return Boolean(win && !win.isDestroyed());
    });
    bridge = new RendererBridge({ send, available });
    let clipboard = options.clipboard || ctx.clipboard || null;
    if (!clipboard) {
      try { const electron = require('electron'); clipboard = electron && electron.clipboard ? electron.clipboard : null; } catch { clipboard = null; }
    }
    let version = options.version || null;
    if (!version) { try { version = ctx.app.getVersion(); } catch { version = null; } }
    const toolbox = createToolbox({ ctx, bridge, version });
    const log = { info: (m) => ctx.log('info', m), warn: (m) => ctx.log('warn', m) };
    service = new McpService({
      configDir: options.configDir || ctx.paths.userData,
      getToolbox: () => toolbox,
      log, version: version || '0.0.0', clipboard,
      onChange: () => { try { send('mcp:state', status()); } catch { /* a tela é só um espelho */ } }
    });
    ctx.mcp = { service, bridge, toolbox };
    service.init().then(() => { if (service.status().running) { try { send('mcp:state', status()); } catch { /* idem */ } } }, () => {}); // só avisa se o servidor voltou a ligar
    if (ctx.app && typeof ctx.app.on === 'function') {
      ctx.app.on('before-quit', () => { bridge.rejectAll('NO_WINDOW', 'O Braga Frame está fechando.'); service.shutdown().catch(() => {}); });
    }
  }

  function status() {
    if (!service) return { available: false, reason: NOT_AVAILABLE, enabled: false, running: false, port: 0, url: '', calls: 0, client: '', autoConfirm: false, error: '' };
    return { available: true, ...service.status() };
  }

  const need = () => {
    if (!service) throw Object.assign(new Error(NOT_AVAILABLE), { code: 'MCP_UNAVAILABLE' });
    return service;
  };

  ctx.handle('mcp:status', () => status());

  ctx.handle('mcp:setEnabled', async (payload) => {
    await need().setEnabled(Boolean(payload && payload.enabled === true));
    return status();
  });

  ctx.handle('mcp:regenerateToken', () => {
    need().regenerateToken();
    return status();
  });

  ctx.handle('mcp:setOptions', (payload) => {
    need().setOptions({ autoConfirm: payload && typeof payload.autoConfirm === 'boolean' ? payload.autoConfirm : undefined });
    return status();
  });

  ctx.handle('mcp:copyConfig', (payload) => {
    const kind = payload && payload.kind;
    try {
      return need().copyConfig(kind);
    } catch (err) {
      if (err && err.code) throw err;
      throw Object.assign(err, { code: 'MCP_CONFIG' }); // as mensagens do serviço já estão em português
    }
  });

  // o renderer responde a uma operação (o servidor espera a resposta pelo id)
  ctx.handle('mcp:reply', (payload) => ({ accepted: bridge ? bridge.reply(payload) : false }));
}

module.exports = { register };

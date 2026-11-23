'use strict';

/**
 * Configuração do servidor MCP (conexão de agentes de IA externos), guardada em <pasta de dados do app>/mcp.json:
 *   { enabled:boolean, port:number, token:string, autoConfirm:boolean }
 *
 * - DESLIGADO por padrão: o usuário liga em Configurações > Geral > Agentes de IA (MCP).
 * - O token (aleatório, 256 bits) é a "senha" que o agente precisa enviar. Fica neste arquivo, na pasta do usuário (só ele lê), e o renderer
 *   nunca o recebe: o processo principal copia a configuração pronta para a área de transferência. O token é SEMPRE exigido.
 * - `autoConfirm` (padrão false): o usuário pode dispensar a janela de confirmação das ações do agente.
 * - A mesma pasta recebe a ponte stdio (`mcp-bridge.js`) para agentes que só sabem iniciar um comando.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_PORT = 47822; // o BDS usa 47821: os dois podem ficar ligados ao mesmo tempo
const FILE = 'mcp.json';
const BRIDGE_FILE = 'mcp-bridge.js';

const newToken = () => crypto.randomBytes(32).toString('hex');
const validPort = (n) => Number.isInteger(n) && n >= 1024 && n <= 65535;

class McpConfig {
  /** @param {{ dir:string }} opts  pasta de dados do app */
  constructor({ dir }) {
    this.dir = dir;
    this.file = path.join(dir, FILE);
    this.bridgeFile = path.join(dir, BRIDGE_FILE);
    this._data = null;
  }

  load() {
    if (this._data) return this._data;
    let stored = {};
    try { stored = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { stored = {}; }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
    this._data = {
      enabled: stored.enabled === true,
      port: validPort(stored.port) ? stored.port : DEFAULT_PORT,
      autoConfirm: stored.autoConfirm === true,
      token: typeof stored.token === 'string' && /^[0-9a-f]{64}$/.test(stored.token) ? stored.token : ''
    };
    return this._data;
  }

  _save() {
    const d = this.load();
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  isEnabled() { return this.load().enabled === true; }
  get port() { return this.load().port; }
  getToken() { return this.load().token; }
  autoConfirms() { return this.load().autoConfirm === true; }

  /** Garante que exista um token (gera na primeira vez) e devolve-o. */
  ensureToken() {
    const d = this.load();
    if (!d.token) { d.token = newToken(); this._save(); }
    return d.token;
  }

  /** Opções do usuário: `autoConfirm` (true = as ações do agente rodam sem a janela de confirmação). */
  setOptions({ autoConfirm } = {}) {
    const d = this.load();
    if (typeof autoConfirm === 'boolean') d.autoConfirm = autoConfirm;
    this._save();
  }

  setEnabled(on) {
    const d = this.load();
    d.enabled = on === true;
    if (d.enabled && !d.token) d.token = newToken();
    this._save();
    return d.enabled;
  }

  /** Porta efetivamente usada (a preferida estava ocupada): vale até o próximo início. */
  setPort(port) {
    const d = this.load();
    if (!validPort(port) || d.port === port) return;
    d.port = port;
    this._save();
  }

  /** Novo token: o agente que usava o anterior perde o acesso. */
  regenerateToken() {
    const d = this.load();
    d.token = newToken();
    this._save();
    return d.token;
  }

  /** Grava a ponte stdio ao lado do mcp.json (o Node comum não lê de dentro do app.asar). Devolve o caminho. */
  writeBridge() {
    const src = fs.readFileSync(path.join(__dirname, 'bridge.js'), 'utf8');
    fs.mkdirSync(this.dir, { recursive: true });
    let current = null;
    try { current = fs.readFileSync(this.bridgeFile, 'utf8'); } catch { current = null; }
    if (current !== src) fs.writeFileSync(this.bridgeFile, src, 'utf8');
    return this.bridgeFile;
  }
}

module.exports = McpConfig;
module.exports.DEFAULT_PORT = DEFAULT_PORT;

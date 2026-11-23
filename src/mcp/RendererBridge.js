'use strict';

/**
 * Ponte do servidor MCP com a JANELA do app (renderer). O projeto aberto, a revisão de cortes, a análise e a exportação vivem no renderer (só ele grava
 * o projeto: veja docs/arquitetura.md), então as ações do agente passam por ele, uma "operação" de cada vez:
 *
 *   main -> renderer  `mcp:request` { id, op, args }          (ctx.send)
 *   renderer -> main  `mcp:reply`   { id, ok, result | code+message }   (canal IPC; o renderer chama BF.api('mcp:reply', …))
 *
 * `request()` resolve com o `result` ou rejeita com BridgeError (code: NO_WINDOW, TIMEOUT, CANCELLED ou o código que o renderer devolveu).
 */

const crypto = require('node:crypto');

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

class RendererBridge {
  /**
   * @param {{ send:(channel:string, payload:object)=>void, available?:()=>boolean, timeoutMs?:number }} deps
   *   available: a janela existe? (sem ela nenhuma operação pode rodar); timeoutMs: prazo padrão de uma operação (a confirmação pede um maior)
   */
  constructor({ send, available = () => true, timeoutMs = 30000 }) {
    this.send = send;
    this.available = available;
    this.timeoutMs = timeoutMs;
    this.pending = new Map(); // id -> { resolve, reject, timer, off }
  }

  get pendingCount() { return this.pending.size; }

  request(op, args = {}, { timeoutMs = this.timeoutMs, signal = null } = {}) {
    if (!this.available()) return Promise.reject(new BridgeError('NO_WINDOW', 'A janela do Braga Frame não está aberta. Abra o aplicativo e tente de novo.'));
    if (signal && signal.aborted) return Promise.reject(new BridgeError('CANCELLED', 'Cancelado.'));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const entry = { resolve, reject, timer: null, off: null };
      const finish = (fn, value) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(entry.timer);
        if (entry.off) entry.off();
        fn(value);
      };
      entry.timer = setTimeout(() => finish(reject, new BridgeError('TIMEOUT', 'O Braga Frame não respondeu a tempo (a janela está ocupada ou travada).')), timeoutMs);
      if (signal) {
        const onAbort = () => finish(reject, new BridgeError('CANCELLED', 'Cancelado.'));
        signal.addEventListener('abort', onAbort, { once: true });
        entry.off = () => signal.removeEventListener('abort', onAbort);
      }
      this.pending.set(id, { ...entry, finish, ok: (v) => finish(resolve, v), fail: (e) => finish(reject, e) });
      try {
        this.send('mcp:request', { id, op, args });
      } catch (err) {
        finish(reject, new BridgeError('NO_WINDOW', `Não foi possível falar com a janela do app: ${err && err.message}`));
      }
    });
  }

  /** Resposta do renderer. Devolve false se o pedido já tinha acabado (prazo, cancelamento) ou o id é desconhecido. */
  reply(message) {
    const m = message && typeof message === 'object' ? message : {};
    const entry = typeof m.id === 'string' ? this.pending.get(m.id) : null;
    if (!entry) return false;
    if (m.ok === true) entry.ok(m.result === undefined ? null : m.result);
    else entry.fail(new BridgeError(typeof m.code === 'string' && m.code ? m.code : 'RENDERER_ERROR', typeof m.message === 'string' && m.message ? m.message : 'A operação falhou no app.'));
    return true;
  }

  /** Recusa tudo o que está esperando (a janela fechou). */
  rejectAll(code = 'NO_WINDOW', message = 'A janela do Braga Frame foi fechada.') {
    for (const entry of [...this.pending.values()]) entry.fail(new BridgeError(code, message));
  }
}

module.exports = { RendererBridge, BridgeError };

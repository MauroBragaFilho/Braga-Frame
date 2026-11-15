'use strict';

/**
 * Fila de pedidos de "abrir este vídeo" que chegam de fora da interface: a linha de comando (primeira ou segunda
 * instância) e o app hospedeiro (Braga Digital Studio) por `module.requestOpen(...)`.
 *
 * Por que uma fila em vez de enviar o caminho direto à tela: o pedido pode chegar ANTES de a interface ter carregado (abrir
 * o programa já com um vídeo) e um evento enviado nessa hora se perderia. O processo principal guarda o pedido e avisa a
 * interface (`app:openRequest`, só um aviso, sem dados); a interface busca o que está pendente com `app:takeOpenRequest`
 * — logo que carrega e a cada aviso. Cada pedido é entregue uma única vez.
 */

const MAX_PENDING = 8;

class OpenRequests {
  constructor() {
    this.items = [];
  }

  /**
   * Guarda um pedido. Aceita o resultado de `parseCli` (`videoPath`/`error`) ou `{ path }`/`{ error }` já prontos.
   * Só vale abrir um vídeo por vez: um pedido novo de vídeo substitui o anterior que ainda não foi entregue; os erros ficam
   * (até MAX_PENDING) para a interface avisar o usuário. Devolve true se algo foi guardado.
   */
  push(request) {
    if (!request || typeof request !== 'object') return false;
    const videoPath = typeof request.videoPath === 'string' ? request.videoPath : (typeof request.path === 'string' ? request.path : null);
    const error = request.error && typeof request.error.message === 'string' ? { code: request.error.code || 'ERROR', message: request.error.message } : null;
    if (!videoPath && !error) return false;
    if (videoPath) {
      this.items = this.items.filter((item) => !item.path);
      this.items.push({ path: videoPath });
    } else {
      this.items.push({ error });
    }
    while (this.items.length > MAX_PENDING) this.items.shift();
    return true;
  }

  /** Entrega (e esvazia) os pedidos pendentes, na ordem em que chegaram. */
  take() {
    const out = this.items;
    this.items = [];
    return out;
  }

  get size() {
    return this.items.length;
  }
}

module.exports = { OpenRequests, MAX_PENDING };

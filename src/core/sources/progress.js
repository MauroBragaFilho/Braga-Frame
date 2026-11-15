'use strict';

/**
 * Junta o progresso do yt-dlp em UM percentual para o download inteiro (dono: sources).
 * O yt-dlp baixa vídeo e áudio em arquivos separados (cada um vai de 0 a 100%) e depois junta; aqui somamos os
 * bytes de todos os arquivos do "plano" (a linha "Downloading 2 format(s): 399+251") e, para os que ainda não
 * começaram, usamos o tamanho informado nos metadados. Sem nenhum tamanho conhecido o percentual fica `null`
 * (barra indeterminada) e só os bytes são mostrados: nunca inventamos um número.
 */

class ProgressTracker {
  /**
   * @param {{ sizeByFormat?:Map<string,number>|object }} [o]
   *   sizeByFormat: id do formato -> bytes estimados (dos metadados).
   */
  constructor({ sizeByFormat } = {}) {
    this.sizes = sizeByFormat instanceof Map ? sizeByFormat : new Map(Object.entries(sizeByFormat || {}));
    this.planned = [];
    this.files = new Map(); // formatId -> { downloaded, total }
    this.percent = null;
    this.speed = null;
    this.phase = 'download';
  }

  /** Alimenta com um evento de ytdlp.parseOutputLine; devolve o retrato atual. */
  feed(evt) {
    if (!evt) return this.snapshot();
    if (evt.type === 'plan') {
      this.planned = evt.formats;
    } else if (evt.type === 'progress') {
      const id = evt.formatId || '_';
      const prev = this.files.get(id) || { downloaded: 0, total: 0 };
      const total = evt.total || evt.totalEstimate || this.sizes.get(id) || prev.total || 0; // 0 = tamanho desconhecido
      const downloaded = evt.status === 'finished' ? (evt.total || evt.downloaded || prev.downloaded) : (evt.downloaded ?? prev.downloaded);
      this.files.set(id, { downloaded, total: total > 0 ? Math.max(total, downloaded) : 0 });
      if (evt.speed) this.speed = evt.speed;
      this.phase = 'download';
    } else if (evt.type === 'post') {
      if (evt.status === 'started') this.phase = 'merge';
    }
    return this.snapshot();
  }

  snapshot() {
    let downloaded = 0;
    let total = 0;
    let unknownRemaining = false; // algum arquivo (já iniciado ou ainda não) sem tamanho conhecido
    for (const f of this.files.values()) {
      downloaded += f.downloaded;
      total += f.total;
      if (f.total === 0) unknownRemaining = true;
    }
    // arquivos do plano que ainda não começaram
    for (const id of this.planned) {
      if (this.files.has(id)) continue;
      const size = this.sizes.get(id);
      if (size) total += size; else unknownRemaining = true;
    }
    let percent = null;
    if (total > 0 && !unknownRemaining) percent = Math.min(99.9, (downloaded / total) * 100);
    // nunca anda para trás (a estimativa de fragmentos muda durante o download)
    if (percent !== null) {
      if (this.percent !== null && percent < this.percent) percent = this.percent;
      this.percent = percent;
    }
    const remaining = Math.max(0, total - downloaded);
    const eta = this.speed > 0 && total > 0 && !unknownRemaining ? Math.round(remaining / this.speed) : null;
    return {
      phase: this.phase,
      percent: this.percent === null ? null : Math.round(this.percent * 10) / 10,
      downloaded,
      total: total > 0 && !unknownRemaining ? total : null,
      speed: this.speed,
      eta
    };
  }
}

module.exports = { ProgressTracker };

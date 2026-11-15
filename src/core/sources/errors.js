'use strict';

/**
 * Erro do recurso Fontes. `message` sempre em português com causa e solução; `details` (JSON) pode trazer
 * `solution`, `dependsOnAccess` (depende de acesso, permissões ou disponibilidade da fonte), `retryable` e `raw`
 * (trecho curto da saída original, sem caminhos do computador).
 */
class SourcesError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SourcesError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Converte o resultado de mapYtdlpError / mapTwitchDownloaderError em SourcesError. */
function fromMapped(mapped) {
  return new SourcesError(mapped.code, mapped.message, {
    solution: mapped.solution, dependsOnAccess: mapped.dependsOnAccess, retryable: mapped.retryable, raw: mapped.raw
  });
}

const cancelled = (message = 'Cancelado.') => new SourcesError('CANCELLED', message);

module.exports = { SourcesError, fromMapped, cancelled };

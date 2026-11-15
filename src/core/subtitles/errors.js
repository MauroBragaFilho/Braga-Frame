'use strict';

/**
 * Erro das legendas: `code` estável (para a interface e os testes) e `message` em português, com a causa e,
 * quando houver, o que fazer. `details` precisa ser JSON (atravessa o IPC).
 */
class SubtitlesError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SubtitlesError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const cancelled = () => new SubtitlesError('CANCELLED', 'Cancelado.');
const isCancelled = (err) => Boolean(err) && err.code === 'CANCELLED';

module.exports = { SubtitlesError, cancelled, isCancelled };

'use strict';

/**
 * Erro da análise. `code` é estável (a interface decide o que fazer por ele); `message` está em
 * português e diz causa e possível solução.
 *
 * Códigos: CANCELLED, INVALID_ARGS, INPUT_MISSING, NO_FFMPEG, NO_FFPROBE, BUSY, PROBE_FAILED,
 * NO_SIGNALS, FFMPEG_START_FAILED, AUDIO_FAILED, IMAGE_FAILED.
 */
class AnalysisError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AnalysisError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const cancelled = () => new AnalysisError('CANCELLED', 'Análise cancelada. Nada foi alterado no projeto.');

module.exports = { AnalysisError, cancelled };

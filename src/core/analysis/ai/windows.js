'use strict';

/**
 * Modo JANELAS CANDIDATAS, lado do manager: junta os sinais LOCAIS (volume do áudio, picos de chat, risadas da transcrição) e devolve as
 * janelas de 45 a 90 s que a IA vai ver (candidates.js). Nada daqui sai do computador: o volume só decide ONDE olhar.
 *
 * `audioDb({ file, duration, signal, allowExtract, onProgress })` devolve { windowSec, db } (do cache de sinais do algoritmo ou extraído
 * agora) ou null. Na ESTIMATIVA `allowExtract` é false: não faz ninguém esperar minutos só para ver um número.
 */

const { audioEvents, chatEvents, laughEvents, buildCandidateWindows, windowsFromSuggestions, mergeWindows, DEFAULTS } = require('../candidates');

// orçamento de cobertura (janela + contexto) quando as sugestões do algoritmo são a fonte: medido em 17 lives reais, 20% do vídeo dá ~13% de
// janelas, toca 49% dos picos mais reassistidos (o acaso: 24%) e poupa ~67% do texto enviado à IA
const ALGORITHM_COVERAGE = 0.2;

async function findCandidateWindows({ doc, chat, duration, hasAudio = true, file, audioDb, algorithm = null, chatPath = null, params = null, signal = null, allowExtract = true, onProgress = null, opts = {} }) {
  const info = { audio: 'off', audioEvents: 0, chatEvents: 0, laughEvents: 0, algorithm: 'off', algorithmSuggestions: 0, windows: 0, coveredSec: 0 };
  const events = [];
  if (hasAudio !== false && typeof audioDb === 'function') {
    try {
      const data = await audioDb({ file, duration, signal, allowExtract, onProgress });
      if (data && Array.isArray(data.db) && data.db.length) {
        const found = audioEvents(data.db, { frameSec: data.windowSec || 0.5, ...opts });
        info.audio = 'ok';
        info.audioEvents = found.length;
        events.push(...found);
      } else info.audio = allowExtract ? 'unavailable' : 'not-cached';
    } catch (err) {
      if (err && err.code === 'CANCELLED') throw err;
      info.audio = 'failed';
    }
  }
  const messages = chat && Array.isArray(chat.messages) ? chat.messages : [];
  const chatFound = chatEvents(messages, duration, opts);
  info.chatEvents = chatFound.length;
  events.push(...chatFound);
  const laughs = laughEvents(doc && doc.cues);
  info.laughEvents = laughs.length;
  events.push(...laughs);
  const local = buildCandidateWindows({ events, duration }, opts);
  // fonte principal: as sugestões do algoritmo (áudio + texto + chat); sem elas, ou se falharem, valem só os sinais locais
  let windows = local;
  if (typeof algorithm === 'function') {
    try {
      const suggestions = await algorithm({ file, duration, hasAudio, doc, signal, allowExtract, chatPath, params });
      if (Array.isArray(suggestions) && suggestions.length) {
        const primary = windowsFromSuggestions(suggestions, duration, { ...opts, maxCoverage: ALGORITHM_COVERAGE });
        windows = mergeWindows(primary, local, duration, { ...opts, maxCoverage: ALGORITHM_COVERAGE });
        info.algorithm = 'ok';
        info.algorithmSuggestions = suggestions.length;
      } else info.algorithm = suggestions ? 'empty' : (allowExtract ? 'unavailable' : 'not-cached');
    } catch (err) {
      if (err && err.code === 'CANCELLED') throw err;
      info.algorithm = 'failed';
    }
  }
  info.windows = windows.length;
  info.coveredSec = Math.round(windows.reduce((n, w) => n + (w.to - w.from), 0));
  return { windows, info, enough: windows.length >= (opts.minWindows || DEFAULTS.minWindows) };
}

module.exports = { findCandidateWindows, ALGORITHM_COVERAGE };

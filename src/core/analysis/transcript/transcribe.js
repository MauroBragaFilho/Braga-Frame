'use strict';

/**
 * Transcreve o vídeo INTEIRO com o motor Whisper que as legendas já usam (placa NVIDIA automática ou processador, modelo escolhido).
 * Em vez de um motor novo, reaproveita `generateSubtitles` (src/core/subtitles/generate.js) por pedaços de `chunkSec`:
 * cada pedaço passa pela detecção de silêncio (trecho mudo não chama o motor nem inventa fala), pelas regras anti-alucinação
 * (anotações, frases típicas de ruído, laços de repetição e confiança muito baixa saem) e vira falas com horário no vídeo.
 *
 * - Progresso pelo tempo do vídeo; cancelamento por AbortSignal (o pedaço em andamento é encerrado).
 * - Retomada: depois de cada pedaço `onChunk` recebe as falas acumuladas e até onde foi; quem chama guarda o rascunho e, na próxima vez,
 *   passa `startAt` e `initialCues`.
 * - Marcas de risada (*Risos*) viram falas `laugh` (o motor as descarta como "anotação"; aqui elas são pista para a IA).
 * - Limite de um pedaço: o de generateSubtitles (30 min); o padrão é 10 min. Uma fala que atravessa a fronteira entre dois pedaços pode
 *   sair cortada em duas.
 */

const { generateSubtitles } = require('../../subtitles/generate');
const { REASONS } = require('../../subtitles/hallucinations');
const { isCancelled } = require('../../subtitles/errors');
const { normalizeCues, isLaughter, round3 } = require('./format');

const DEFAULT_CHUNK_SEC = 600;
const MIN_TAIL_SEC = 0.5; // sobra menor que isto no fim do vídeo não vale um pedaço

/** Chunks [start, end] de `from` até `duration`. A sobra pequena do fim é incorporada ao pedaço anterior. */
function planChunks(duration, chunkSec = DEFAULT_CHUNK_SEC, from = 0) {
  const out = [];
  let t = Math.max(0, from);
  while (t < duration - MIN_TAIL_SEC) {
    let end = Math.min(duration, t + chunkSec);
    if (duration - end < Math.max(MIN_TAIL_SEC, chunkSec * 0.1)) end = duration;
    out.push([round3(t), round3(end)]);
    t = end;
  }
  return out;
}

/**
 * @param {object} o
 * @param {string} o.input        vídeo
 * @param {number} o.duration     duração (s)
 * @param {object} o.genOptions   opções de generateSubtitles que dependem do motor (ffmpeg, whisper, modelPath, dtw, useGpu, workRoot…)
 * @param {string} [o.language]
 * @param {number} [o.chunkSec]
 * @param {number} [o.startAt]    retomada: começa neste tempo
 * @param {object[]} [o.initialCues]  falas já prontas (de antes de startAt)
 * @param {AbortSignal} [o.signal]
 * @param {(ev:{p:number, doneUntil:number, message:string})=>void} [o.onProgress]
 * @param {(ev:{cues:object[], doneUntil:number})=>void} [o.onChunk]   chamado depois de cada pedaço
 * @param {Function} [o.generate]  só para testes
 */
async function transcribeVideo(o) {
  const { input, duration, genOptions, signal = null } = o;
  const generate = o.generate || generateSubtitles;
  const chunkSec = Math.min(1500, Math.max(60, o.chunkSec || DEFAULT_CHUNK_SEC));
  const chunks = planChunks(duration, chunkSec, o.startAt || 0);
  const cues = Array.isArray(o.initialCues) ? o.initialCues.map((c) => ({ ...c })) : [];
  const info = { device: 'CPU', deviceName: null, fellBack: false, fallbackReason: null, transcribeMs: 0, audioSec: 0, discarded: 0 };
  const t0 = Date.now();
  const report = (p, doneUntil, message) => { if (o.onProgress) { try { o.onProgress({ p: p >= 1 - 1e-6 ? 1 : Math.min(1, Math.max(0, p)), doneUntil, message }); } catch { /* ouvinte com defeito */ } } };
  if (!chunks.length) report(1, duration, 'Transcrição pronta.');

  for (let i = 0; i < chunks.length; i += 1) {
    if (signal && signal.aborted) throw Object.assign(new Error('Cancelado.'), { code: 'CANCELLED' });
    const [from, to] = chunks[i];
    const label = chunks.length > 1 ? ` (parte ${i + 1} de ${chunks.length})` : '';
    report(from / duration, from, `Transcrevendo${label}…`);
    let res;
    try {
      res = await generate({
        ...genOptions, input, start: from, end: to, language: o.language || 'pt', maxChars: 60, signal,
        onProgress: (ev) => report((from + ((ev.percent || 0) / 100) * (to - from)) / duration, from, `Transcrevendo${label}… ${Math.round(((from + ((ev.percent || 0) / 100) * (to - from)) / duration) * 100)}%`)
      });
    } catch (err) {
      if (isCancelled(err)) throw Object.assign(new Error('Cancelado.'), { code: 'CANCELLED', doneUntil: from });
      throw err;
    }
    for (const c of res.cues || []) cues.push({ start: from + c.start, end: from + c.end, text: c.text });
    // o motor descarta "*Risos*" como anotação de áudio; para a análise a risada é uma pista valiosa: volta como fala marcada
    for (const d of res.discarded || []) {
      if (d.reason === REASONS.annotation && isLaughter(d.text)) cues.push({ start: from + d.start, end: from + d.end, text: String(d.text).trim() });
    }
    info.device = res.device === 'GPU' || info.device === 'GPU' ? 'GPU' : 'CPU';
    info.deviceName = res.deviceName || info.deviceName;
    info.fellBack = info.fellBack || Boolean(res.fellBack);
    info.fallbackReason = res.fallbackReason || info.fallbackReason;
    info.transcribeMs += res.transcribeMs || 0;
    info.audioSec += res.audioSec || 0;
    info.discarded += (res.discarded || []).length;
    if (o.onChunk) o.onChunk({ cues: cues.map((c) => ({ ...c })), doneUntil: to });
    report(to >= duration - 0.01 ? 1 : to / duration, to, to >= duration - 0.01 ? 'Transcrição pronta.' : `Transcrevendo${label}… concluído`);
  }

  const { cues: finalCues, dropped } = normalizeCues(cues, { duration });
  return { cues: finalCues, dropped, ...info, elapsedMs: Date.now() - t0, chunks: chunks.length };
}

module.exports = { transcribeVideo, planChunks, DEFAULT_CHUNK_SEC };

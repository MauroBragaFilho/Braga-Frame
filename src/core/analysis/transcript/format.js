'use strict';

/**
 * Transcrição do vídeo inteiro (a base da análise por IA). Formato versionado `bf-transcript-1`, guardado em
 * userData/transcripts/<projectId>.json:
 *
 *   { format: 'bf-transcript-1', version: 1, projectId, origin: 'generated' | 'imported',
 *     source: { path, size, duration },            // o vídeo a que ela pertence
 *     engine?: { modelId, modelLabel, language, device },   // só quando gerada
 *     importedFrom?: 'nome.srt',                             // só quando importada
 *     createdAt, updatedAt, coveredSec,                      // coveredSec = fim da última fala
 *     stats: { cues, speechSec, laughs, dropped: { invalid, beyond, repeats } },
 *     cues: [{ start, end, text, laugh? }] }                 // segundos desde o início do vídeo, em ordem
 *
 * Funções puras (sem disco) para validar e normalizar as falas, venham do Whisper ou de um .srt/.vtt.
 */

const FORMAT = 'bf-transcript-1';
const VERSION = 1;
const MAX_CUES = 60000;
const MAX_TEXT = 600;
const MAX_REPEAT = 3; // mais que isto de falas seguidas iguais é laço do reconhecimento: fica o começo

const round3 = (n) => Math.round(n * 1000) / 1000;

/** "*Risos*", "[risos]", "(Risada)", "*Risos de fulano*": marca de risada do Whisper (a fala toda é só isso). */
function isLaughter(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 60) return false;
  if (!/^[*[(♪\s]*\s*ris(?:o|os|ada|adas|inho|inhos)\b/i.test(t)) return false;
  return /^[*[(]/.test(t) || /[*\])]$/.test(t) || t.length <= 14;
}

function cleanText(text) {
  const plain = String(text == null ? '' : text)
    .replace(/<\/?[a-zA-Z][^<>]*>/g, '')
    .replace(/\{\\an?\d\}/g, '');
  // tira caracteres de controle (menos tab/quebra de linha, que viram espaço logo abaixo)
  let out = '';
  for (const ch of plain) { const code = ch.charCodeAt(0); out += code < 32 && code !== 9 && code !== 10 && code !== 13 ? ' ' : ch; }
  return out.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

const normText = (text) => String(text).normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Valida e normaliza as falas: números finitos, início < fim, texto limpo, em ordem, sem passar do fim do vídeo (se conhecido),
 * sem laço de repetição. Devolve { cues, dropped:{invalid, beyond, repeats} }.
 */
function normalizeCues(raw, { duration = 0, tolerance = 5 } = {}) {
  const dropped = { invalid: 0, beyond: 0, repeats: 0 };
  const list = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') { dropped.invalid += 1; continue; }
    let start = Number(item.start);
    let end = Number(item.end);
    const text = cleanText(item.text);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !text || start < 0) { dropped.invalid += 1; continue; }
    if (end <= start) end = start + 0.5;
    if (duration > 0 && start > duration + tolerance) { dropped.beyond += 1; continue; }
    if (duration > 0) { end = Math.min(end, duration); start = Math.min(start, end); }
    if (end - start < 0.05) { dropped.invalid += 1; continue; }
    list.push({ start: round3(start), end: round3(end), text });
    if (list.length > MAX_CUES) break;
  }
  list.sort((a, b) => a.start - b.start || a.end - b.end);

  const cues = [];
  let run = 0;
  let prevKey = '';
  for (const cue of list) {
    const key = normText(cue.text);
    run = key && key === prevKey ? run + 1 : 1;
    prevKey = key;
    if (run > MAX_REPEAT && !isLaughter(cue.text)) { dropped.repeats += 1; continue; }
    const out = { start: cue.start, end: cue.end, text: cue.text };
    if (isLaughter(cue.text)) out.laugh = true;
    cues.push(out);
  }
  return { cues, dropped };
}

function statsOf(cues, dropped) {
  let speechSec = 0;
  let laughs = 0;
  for (const c of cues) {
    if (c.laugh) laughs += 1;
    else speechSec += c.end - c.start;
  }
  return { cues: cues.length, speechSec: round3(speechSec), laughs, dropped: dropped || { invalid: 0, beyond: 0, repeats: 0 } };
}

function buildDocument({ projectId, origin, source, cues, dropped, engine, importedFrom, createdAt }) {
  const now = new Date().toISOString();
  const last = cues.length ? cues[cues.length - 1].end : 0;
  const doc = {
    format: FORMAT,
    version: VERSION,
    projectId,
    origin,
    source: { path: String(source.path || ''), size: Number(source.size) || 0, duration: Number(source.duration) || 0 },
    createdAt: createdAt || now,
    updatedAt: now,
    coveredSec: round3(cues.reduce((m, c) => Math.max(m, c.end), 0) || last),
    stats: statsOf(cues, dropped),
    cues
  };
  if (engine) doc.engine = engine;
  if (importedFrom) doc.importedFrom = String(importedFrom).slice(0, 200);
  return doc;
}

/** O documento lido do disco tem o formato esperado? Normaliza as falas de novo (arquivo editado à mão não quebra a análise). */
function readDocument(data) {
  if (!data || typeof data !== 'object' || data.format !== FORMAT || data.version !== VERSION) return null;
  const { cues, dropped } = normalizeCues(data.cues, { duration: Number(data.source && data.source.duration) || 0 });
  if (!cues.length) return null;
  const doc = buildDocument({
    projectId: String(data.projectId || ''), origin: data.origin === 'imported' ? 'imported' : 'generated',
    source: data.source || {}, cues, dropped: data.stats && data.stats.dropped ? data.stats.dropped : dropped,
    engine: data.engine && typeof data.engine === 'object' ? data.engine : null, importedFrom: data.importedFrom, createdAt: data.createdAt
  });
  if (typeof data.updatedAt === 'string') doc.updatedAt = data.updatedAt;
  return doc;
}

const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

/** A transcrição vale para este vídeo (mesmo caminho, tamanho e duração com folga de 1 s)? */
function sameSource(saved, source) {
  if (!saved || !source) return false;
  if (saved.path && source.path && norm(saved.path) !== norm(source.path)) return false;
  if (saved.size > 0 && source.size > 0 && saved.size !== source.size) return false;
  if (saved.duration > 0 && source.duration > 0 && Math.abs(saved.duration - source.duration) > 1) return false;
  return true;
}

/** Resumo para a interface (sem as falas). */
function summarize(doc, source) {
  if (!doc) return { exists: false };
  const duration = Number(source && source.duration) || doc.source.duration || 0;
  return {
    exists: true,
    origin: doc.origin,
    importedFrom: doc.importedFrom || null,
    engine: doc.engine || null,
    coveredSec: doc.coveredSec,
    duration,
    coverage: duration > 0 ? Math.min(1, doc.coveredSec / duration) : null,
    cues: doc.stats.cues,
    laughs: doc.stats.laughs,
    speechSec: doc.stats.speechSec,
    dropped: doc.stats.dropped,
    updatedAt: doc.updatedAt,
    stale: source ? !sameSource(doc.source, source) : false
  };
}

/** Falas que tocam [from, to]. `cues` está em ordem; busca binária no início. */
function cuesInRange(cues, from, to) {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cues[mid].end < from) lo = mid + 1; else hi = mid; }
  const out = [];
  for (let i = lo; i < cues.length && cues[i].start <= to; i += 1) if (cues[i].end >= from) out.push(cues[i]);
  return out;
}

module.exports = { FORMAT, VERSION, MAX_CUES, MAX_REPEAT, isLaughter, cleanText, normText, normalizeCues, buildDocument, readDocument, sameSource, summarize, cuesInRange, statsOf, round3 };

'use strict';

/**
 * MODO MANUAL da análise por IA: sem chave nem API. O app monta um pedido de texto (guia de cortes + formato + transcrição com UM ID por
 * palavra e o tempo dela), o usuário o cola no GPT, Qwen ou outro chat, e cola a resposta de volta. A IA devolve só IDs de palavra
 * (`start_id`, `end_id`): o horário vem da palavra real, já na grade de quadros do vídeo (wordGrid.js), então a IA não consegue inventar
 * tempo. A conferência local é a mesma da IA por API (verify.js); o que falha volta com o motivo.
 */

const { systemPrompt, clock, metaLine, estimateTokens } = require('./prompt');
const { CATEGORIES, LAYOUTS, FLAGS, extractJson, keywordsOf } = require('./parse');
const { verifyCandidate, dedupe, REASONS } = require('./verify');
const { snapWordsToFrames, exactFps } = require('../wordGrid');
const { AiError } = require('../../ai/errors');

const DEFAULT_WORDS_PER_PART = 2000;
const MIN_WORDS_PER_PART = 300;
const MAX_WORDS_PER_PART = 8000;
const LINE_MAX_WORDS = 14;
const LINE_PAUSE_SEC = 0.6;
const PART_PAUSE_SEC = 0.8; // a parte termina, de preferência, numa pausa deste tamanho
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Palavras com ID (1, 2, 3…) e tempo na grade de quadros. Transcrição gerada: as palavras do Whisper. Transcrição importada (.srt/.vtt,
 * sem palavras): as palavras de cada fala, com o tempo repartido pelo tamanho (`approx: true`: o tempo é aproximado).
 */
function buildWordList(doc, fps) {
  const real = Array.isArray(doc && doc.words) ? doc.words : [];
  let approx = false;
  let raw = real;
  if (!real.length) {
    approx = true;
    raw = [];
    for (const cue of (doc && doc.cues) || []) {
      if (cue.laugh) continue;
      const tokens = String(cue.text || '').split(/\s+/).filter(Boolean);
      const total = tokens.reduce((n, t) => n + t.length + 1, 0);
      let at = cue.start;
      for (const t of tokens) {
        const span = ((t.length + 1) / total) * (cue.end - cue.start);
        raw.push([at, at + span, t]);
        at += span;
      }
    }
  }
  const words = snapWordsToFrames(raw, fps).map((w, i) => ({ id: i + 1, ...w }));
  return { words, approx };
}

/** Divide as palavras em partes de ~`perPart` palavras, cada uma terminando na pausa mais próxima depois do mínimo. */
function splitParts(words, perPart = DEFAULT_WORDS_PER_PART) {
  const size = Math.min(MAX_WORDS_PER_PART, Math.max(MIN_WORDS_PER_PART, Math.round(perPart) || DEFAULT_WORDS_PER_PART));
  const parts = [];
  let from = 0;
  while (from < words.length) {
    let to = Math.min(words.length, from + size);
    if (to < words.length) {
      // procura uma pausa nas últimas 15% da parte; sem pausa, corta onde está
      for (let j = to; j > from + size * 0.85; j -= 1) {
        if (words[j] && words[j - 1] && words[j].start - words[j - 1].end >= PART_PAUSE_SEC) { to = j; break; }
      }
    }
    parts.push({ index: parts.length, from, to, words: words.slice(from, to) });
    from = to;
  }
  return parts;
}

/** Linhas "[m:ss] 12:Esta 13:é 14:uma": uma linha por frase curta, com o ID de cada palavra. */
function formatPartLines(partWords) {
  const lines = [];
  let line = [];
  const flush = () => {
    if (line.length) lines.push(`[${clock(line[0].start)}] ${line.map((w) => `${w.id}:${w.text}`).join(' ')}`);
    line = [];
  };
  partWords.forEach((w, i) => {
    const prev = partWords[i - 1];
    if (line.length >= LINE_MAX_WORDS || (prev && w.start - prev.end > LINE_PAUSE_SEC)) flush();
    line.push(w);
  });
  flush();
  return lines;
}

const MANUAL_SCHEMA = [
  '{ "cuts": [ {',
  '  "start_id": número do ID da PRIMEIRA palavra do corte,',
  '  "end_id": número do ID da ÚLTIMA palavra do corte,',
  '  "title": "título curto e atraente (máx. 80 caracteres)",',
  `  "category": ${CATEGORIES.map((c) => `"${c}"`).join(' | ')},`,
  '  "relevance": 0.0 a 1.0,',
  '  "reasons": ["motivo curto", "..."],   // no máximo 3',
  '  "keywords": ["palavra-chave", "..."],   // de 3 a 5 palavras curtas, sem #',
  '  "layout": "conversa" | "jogo",         // opcional',
  '  "flags": ["revisar_sensivel"]          // opcional; só quando houver conteúdo sensível',
  '} ] }'
].join('\n');

/**
 * O pedido para colar no chat da IA (uma parte). `prefs` = { minDurationSec, maxDurationSec, profile }; `maxCuts` = quantos cortes pedir.
 * Devolve { text, tokens, from, to, firstId, lastId }.
 */
function buildManualPrompt({ part, parts, meta, duration, prefs, skill = '', maxCuts = 8 }) {
  const first = part.words[0];
  const last = part.words[part.words.length - 1];
  const body = [
    systemPrompt(skill),
    '',
    '=== PEDIDO ===',
    metaLine(meta, duration, prefs && prefs.profile),
    `Esta é a parte ${part.index + 1} de ${parts}, de ${clock(first.start)} até ${clock(last.end)}. Cada palavra aparece como ID:palavra e cada linha começa com o tempo (m:ss) da primeira palavra dela.`,
    `Escolha até ${maxCuts} cortes desta parte (menos, se não houver bons), de ${Math.round(prefs.minDurationSec)} a ${Math.round(prefs.maxDurationSec)} segundos. Responda com os IDs das palavras: "start_id" é o ID da primeira palavra do corte e "end_id" o ID da última. Use SOMENTE IDs que aparecem abaixo (de ${first.id} a ${last.id}). NÃO escreva horários: o app calcula o tempo exato pelos IDs.`,
    '',
    'Formato da resposta (somente JSON, sem markdown):',
    MANUAL_SCHEMA,
    '',
    `=== TRANSCRIÇÃO (parte ${part.index + 1} de ${parts}) ===`,
    formatPartLines(part.words).join('\n')
  ].join('\n');
  return { text: body, tokens: estimateTokens(body), from: first.start, to: last.end, firstId: first.id, lastId: last.id };
}

const idOf = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') { const m = /\d+/.exec(v); return m ? Number(m[0]) : null; }
  return null;
};
const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const list = (v, max, len) => (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []).map((x) => str(x, len)).filter(Boolean).slice(0, max);
function relevanceOf(v) {
  let n = typeof v === 'string' ? Number(v.replace(',', '.').replace('%', '')) : v;
  if (!Number.isFinite(n)) return null;
  if (n > 1 && n <= 100) n /= 100;
  return Math.min(1, Math.max(0, n));
}

/**
 * Limpa o que a cópia de uma resposta renderizada (chat, Markdown) deixa no JSON: entidades HTML (&#x20;, &nbsp;, &quot;), barra invertida
 * no fim da linha, espaço sem quebra e aspas com barra dupla (duas barras e aspas viram uma barra e aspas). JSON limpo não muda.
 */
function cleanPasted(text) {
  const entity = (m, code) => { try { return String.fromCodePoint(code); } catch { return m; } };
  const BS = String.fromCharCode(92);
  return String(text == null ? '' : text)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => entity(m, parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => entity(m, Number(d)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/\u00a0/g, ' ')
    .replace(/\\[ \t]*\r?\n/g, '\n')
    .split(BS + BS + '"').join(BS + '"');
}

/** JSON da resposta colada: tenta o texto como veio e, se não ler por inteiro, o texto limpo (cleanPasted). */
function extractPasted(text) {
  let first = null;
  try { first = extractJson(text); } catch (err) { first = { error: err }; }
  if (first.value && !first.salvaged) return first;
  const cleaned = cleanPasted(text);
  if (cleaned !== String(text)) {
    try {
      const second = extractJson(cleaned);
      if (!second.salvaged || !first.value) return second;
    } catch { /* vale o primeiro resultado */ }
  }
  if (first.error) throw first.error;
  return first;
}

/**
 * Lê a resposta colada: JSON puro, com ```json, com texto em volta ou cortado no meio. Devolve
 * { suggestions, dropped:[{ reason, detail, start, end, title }], received, salvaged }. Lança AiError BAD_JSON se não achar nenhum corte.
 */
function parseManualResponse(text, { words, cues, duration, fps, prefs, existing = [] }) {
  const { value, salvaged } = extractPasted(text);
  const items = Array.isArray(value) ? value : (value && (value.cuts || value.clips || value.candidates || value.momentos)) || null;
  if (!Array.isArray(items)) throw new AiError('BAD_JSON', 'A resposta não traz a lista "cuts" pedida. Cole o JSON inteiro que a IA devolveu.');
  const byId = new Map(words.map((w) => [w.id, w]));
  const f = exactFps(fps);
  const dropped = [];
  const accepted = [];
  const drop = (reason, detail, c) => dropped.push({ reason, detail, start: c.start, end: c.end, title: c.title || '' });
  for (const it of items) {
    if (!it || typeof it !== 'object') { drop('format', 'item que não é um objeto', {}); continue; }
    const a = idOf(it.start_id !== undefined ? it.start_id : it.start_word);
    const b = idOf(it.end_id !== undefined ? it.end_id : it.end_word);
    const title = str(it.title, 100);
    if (a === null || b === null) { drop('format', 'faltam start_id e end_id', { title }); continue; }
    const wa = byId.get(a);
    const wb = byId.get(b);
    if (!wa || !wb) { drop('id', `ID inexistente (${a} a ${b}); a transcrição vai de 1 a ${words.length}`, { title }); continue; }
    if (b < a) { drop('id', `end_id (${b}) vem antes de start_id (${a})`, { title }); continue; }
    const category = str(it.category, 30);
    const layout = typeof it.layout === 'string' ? it.layout.trim().toLowerCase() : '';
    const tail = words.slice(Math.max(a - 1, b - 8), b).map((w) => w.text).join(' ');
    const c = {
      start: wa.start, end: wb.end, title,
      category: CATEGORIES.find((x) => x.toLowerCase() === category.toLowerCase()) || category,
      relevance: relevanceOf(it.relevance),
      hook: words.slice(a - 1, Math.min(b, a + 6)).map((w) => w.text).join(' '),
      punchline: tail, // as últimas palavras do trecho escolhido: existem na transcrição por construção
      reasons: list(it.reasons, 3, 90), keywords: keywordsOf(it.keywords), theme: str(it.theme, 60),
      layout: LAYOUTS.includes(layout) ? layout : '',
      flags: list(it.flags, 4, 30).map((x) => x.toLowerCase()).filter((x) => FLAGS.includes(x))
    };
    const v = verifyCandidate(c, { cues, words, duration, window: null, prefs, existing });
    if (!v.ok) { drop(v.reason, v.detail, c); continue; }
    const s = { ...v.suggestion };
    if (f) { // o corte começa e termina num quadro exato
      s.start = round3(Math.max(0, Math.round(s.start * f) / f));
      s.end = round3(Math.min(duration, Math.round(s.end * f) / f));
      s.peak = round3(Math.min(s.end, Math.max(s.start, s.peak)));
      s.id = `${Math.round(s.start * 10)}_${Math.round(s.end * 10)}`;
    }
    accepted.push(s);
  }
  const merged = dedupe(accepted);
  for (const d of merged.dropped) drop('duplicate', REASONS.duplicate, d);
  const suggestions = merged.kept.sort((x, y) => x.start - y.start);
  return { suggestions, dropped, received: items.length, salvaged };
}

/** Texto de toda a transcrição, uma fala por linha com o tempo: "[1:02:03] fala". `withIds`: usa as palavras com ID (igual ao pedido). */
function formatTranscript(doc) {
  const cues = (doc && doc.cues) || [];
  return cues.map((c) => `[${clock(c.start)}] ${c.text}`).join('\n');
}

module.exports = { cleanPasted, buildWordList, splitParts, formatPartLines, buildManualPrompt, parseManualResponse, formatTranscript, MANUAL_SCHEMA, DEFAULT_WORDS_PER_PART };

'use strict';

/**
 * Leitura da resposta do modelo. O modelo pode devolver o JSON puro, cercado por ```json … ```, com texto antes/depois, ou cortado no
 * meio (limite de tokens). Aqui: extrai o primeiro JSON, valida o formato e normaliza cada item. Nada é confiado: horários viram
 * números, textos são limitados e listas fechadas (categoria, layout, flags) são conferidas.
 */

const { AiError } = require('../../ai/errors');

const CATEGORIES = Object.freeze(['Engraçado', 'Hype', 'Fofo', 'Fail', 'Jogada', 'Chat/zoeira', 'Dica']);
const LAYOUTS = Object.freeze(['conversa', 'jogo']);
const FLAGS = Object.freeze(['revisar_sensivel']);

/** "49:33", "1:02:03", "121:41", "49:33.5", "49,5" ou número -> segundos; NaN se inválido. */
function parseClock(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const text = String(value == null ? '' : value).trim().replace(',', '.');
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const m = /^(?:(\d+):)?(\d{1,4}):(\d{1,2}(?:\.\d+)?)$/.exec(text);
  if (!m) return NaN;
  const sec = Number(m[3]);
  if (sec >= 60) return NaN;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + sec;
}

/** Percorre `text` a partir de `from` (um '{' ou '[') e devolve o trecho balanceado, respeitando strings. null se não fecha. */
function balancedFrom(text, from) {
  const open = text[from];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

/** Objetos {…} completos dentro de um texto cortado (para aproveitar o que veio antes do corte). */
function salvageObjects(text) {
  const out = [];
  const start = text.indexOf('[');
  let i = start === -1 ? 0 : start + 1;
  while (i < text.length) {
    const at = text.indexOf('{', i);
    if (at === -1) break;
    const piece = balancedFrom(text, at);
    if (!piece) break;
    try { out.push(JSON.parse(piece)); } catch { /* objeto inválido: ignora */ }
    i = at + piece.length;
  }
  return out;
}

/**
 * Extrai o JSON da resposta. Devolve { value, salvaged }. Lança AiError BAD_JSON se não achar nada aproveitável.
 * `salvaged:true` = o texto estava cortado e só os objetos completos foram aproveitados.
 */
function extractJson(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) throw new AiError('BAD_JSON', 'A IA respondeu vazio.');
  const candidates = [text];
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  if (fence) candidates.unshift(fence[1].trim());
  const open = /```(?:json|JSON)?\s*([\s\S]*)$/.exec(text); // cerca aberta (resposta cortada antes de fechar)
  if (open && !fence) candidates.push(open[1].trim());
  for (const piece of candidates) {
    try { return { value: JSON.parse(piece), salvaged: false }; } catch { /* tenta o próximo */ }
    const at = piece.search(/[{[]/);
    if (at !== -1) {
      const bal = balancedFrom(piece, at);
      if (bal) { try { return { value: JSON.parse(bal), salvaged: false }; } catch { /* segue */ } }
    }
  }
  const objects = salvageObjects(fence ? fence[1] : text);
  if (objects.length) return { value: { cuts: objects }, salvaged: true };
  throw new AiError('BAD_JSON', 'A resposta da IA não veio no formato JSON pedido.');
}

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

function relevanceOf(v) {
  let n = typeof v === 'string' ? Number(v.replace(',', '.').replace('%', '')) : v;
  if (!Number.isFinite(n)) return null;
  if (n > 1 && n <= 100) n /= 100;
  return Math.min(1, Math.max(0, n));
}

function listOf(v, max, maxLen) {
  const list = Array.isArray(v) ? v : (typeof v === 'string' && v ? [v] : []);
  return list.map((x) => str(x, maxLen)).filter(Boolean).slice(0, max);
}

/** Palavras-chave de um corte: até 5, curtas, sem "#", sem repetir (sem diferenciar caixa). */
function keywordsOf(v) {
  const out = [];
  for (const raw of listOf(v, 12, 40)) {
    const word = raw.replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (word && !out.some((x) => x.toLowerCase() === word.toLowerCase())) out.push(word);
    if (out.length >= 5) break;
  }
  return out;
}

/** Candidatos de uma passada de bloco: { items, invalid, salvaged }. Cada item: { start, end, title, category, relevance, hook, punchline, reasons, keywords, theme, layout, flags }. */
function parseCandidates(raw) {
  const { value, salvaged } = extractJson(raw);
  const list = Array.isArray(value) ? value : (value && (value.cuts || value.candidates || value.clips || value.momentos)) || null;
  if (!Array.isArray(list)) throw new AiError('BAD_JSON', 'A resposta da IA não traz a lista "cuts" pedida.');
  const items = [];
  let invalid = 0;
  for (const it of list) {
    if (!it || typeof it !== 'object') { invalid += 1; continue; }
    const start = parseClock(it.start);
    const end = parseClock(it.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) { invalid += 1; continue; }
    const category = str(it.category, 30);
    const layout = typeof it.layout === 'string' ? it.layout.trim().toLowerCase() : '';
    items.push({
      start, end,
      title: str(it.title, 100),
      category: CATEGORIES.find((c) => c.toLowerCase() === category.toLowerCase()) || category,
      relevance: relevanceOf(it.relevance),
      hook: str(it.hook, 200),
      punchline: str(it.punchline, 300),
      reasons: listOf(it.reasons, 3, 90),
      keywords: keywordsOf(it.keywords),
      theme: str(it.theme, 60),
      layout: LAYOUTS.includes(layout) ? layout : '',
      flags: listOf(it.flags, 4, 30).map((f) => f.toLowerCase()).filter((f) => FLAGS.includes(f))
    });
  }
  return { items, invalid, salvaged };
}

/** Categorias do modo janelas ("humor | gameplay | react") nas do app. */
const WINDOW_CATEGORY = Object.freeze({ humor: 'Engraçado', gameplay: 'Jogada', react: 'Hype', reação: 'Hype', reacao: 'Hype' });

/** "true", "sim", 1… -> boolean; null se ilegível. */
function boolOf(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return keepOfText(v);
}
function keepOfText(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (/^(true|sim|yes|1)$/.test(t)) return true;
  if (/^(false|n[aã]o|no|0)$/.test(t)) return false;
  return null;
}

/**
 * Resposta do modo janelas candidatas: { items:[{ id, valid, hookScore (0..10), title, category, startPhrase, endPhrase, start, end, reasons, keywords }], invalid, salvaged }.
 * `start`/`end` (opcionais, em segundos) só existem se o modelo os deu; quem chama os trata como palpite e prefere as frases.
 */
function parseWindowVerdicts(raw) {
  const { value, salvaged } = extractJson(raw);
  const list = Array.isArray(value) ? value : (value && (value.windows || value.janelas || value.cuts || value.clips)) || null;
  if (!Array.isArray(list)) throw new AiError('BAD_JSON', 'A resposta da IA não traz a lista "windows" pedida.');
  const items = [];
  let invalid = 0;
  for (const it of list) {
    if (!it || typeof it !== 'object' || typeof it.id !== 'string' || !it.id.trim()) { invalid += 1; continue; }
    const valid = boolOf(it.is_valid_clip !== undefined ? it.is_valid_clip : it.valid);
    if (valid === null) { invalid += 1; continue; }
    let score = typeof it.hook_score === 'string' ? Number(it.hook_score.replace(',', '.')) : it.hook_score;
    score = Number.isFinite(score) ? Math.min(10, Math.max(0, score)) : null;
    const category = str(it.category, 30).toLowerCase();
    items.push({
      id: it.id.trim().slice(0, 30), valid, hookScore: score,
      title: str(it.suggested_title !== undefined ? it.suggested_title : it.title, 100),
      category: WINDOW_CATEGORY[category] || CATEGORIES.find((c) => c.toLowerCase() === category) || '',
      startPhrase: str(it.start_phrase, 300), endPhrase: str(it.end_phrase, 300),
      start: clockOrNull(it.start), end: clockOrNull(it.end),
      reasons: listOf(it.reasons, 3, 90), keywords: keywordsOf(it.keywords)
    });
  }
  return { items, invalid, salvaged };
}

/** Resposta da passada de escolha: { picks:[{ id, relevance, title, category, reasons }], salvaged }. */
function parsePicks(raw) {
  const { value, salvaged } = extractJson(raw);
  const list = Array.isArray(value) ? value : (value && (value.picks || value.ranking || value.cuts || value.escolhas)) || null;
  if (!Array.isArray(list)) throw new AiError('BAD_JSON', 'A resposta da IA não traz a lista "picks" pedida.');
  const picks = [];
  for (const it of list) {
    const id = typeof it === 'string' ? it : (it && typeof it === 'object' ? it.id : null);
    if (typeof id !== 'string' || !id.trim()) continue;
    const obj = typeof it === 'object' ? it : {};
    const category = str(obj.category, 30);
    picks.push({
      id: id.trim().slice(0, 30),
      relevance: relevanceOf(obj.relevance),
      title: str(obj.title, 100),
      category: CATEGORIES.find((c) => c.toLowerCase() === category.toLowerCase()) || category,
      reasons: listOf(obj.reasons, 3, 90)
    });
  }
  return { picks, salvaged };
}

/** "fica" ou "sai" dito de várias formas; null quando a IA não respondeu isso (o item então conta como não respondido). */
function keepOf(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (/^(true|sim|yes|fica|manter|1)$/.test(t)) return true;
  if (/^(false|n[aã]o|no|sai|descartar|0)$/.test(t)) return false;
  return null;
}

/**
 * Resposta da conferência das sugestões do algoritmo: { reviews:[{ id, keep, relevance, title, category, reasons, start, end }], salvaged }.
 * `start`/`end`: o início e o fim que a IA diz que o corte deve ter, em segundos (null quando ela não deu ou o horário é ilegível; quem
 * chama confere se valem). Item sem `id` ou sem um "keep" legível é ignorado: quem chama trata como não respondido (a sugestão fica na lista).
 */
const clockOrNull = (v) => { if (v == null || v === '') return null; const sec = parseClock(v); return Number.isFinite(sec) && sec >= 0 ? sec : null; };

function parseReviews(raw) {
  const { value, salvaged } = extractJson(raw);
  const list = Array.isArray(value) ? value : (value && (value.reviews || value.avaliacoes || value.results || value.cuts)) || null;
  if (!Array.isArray(list)) throw new AiError('BAD_JSON', 'A resposta da IA não traz a lista "reviews" pedida.');
  const reviews = [];
  for (const it of list) {
    if (!it || typeof it !== 'object' || typeof it.id !== 'string' || !it.id.trim()) continue;
    const keep = keepOf(it.keep);
    if (keep === null) continue;
    const category = str(it.category, 30);
    reviews.push({
      id: it.id.trim().slice(0, 30), keep, relevance: relevanceOf(it.relevance), title: str(it.title, 100),
      category: CATEGORIES.find((c) => c.toLowerCase() === category.toLowerCase()) || category,
      reasons: listOf(it.reasons, 3, 140),
      start: clockOrNull(it.start), end: clockOrNull(it.end)
    });
  }
  return { reviews, salvaged };
}

module.exports = { CATEGORIES, LAYOUTS, FLAGS, keywordsOf, parseClock, extractJson, parseCandidates, parseWindowVerdicts, WINDOW_CATEGORY, parsePicks, parseReviews, balancedFrom };

'use strict';

/**
 * Divide a transcrição em BLOCOS para a 1ª passada: janelas de `windowSec` (padrão 35 min) com 90 s de sobreposição, cada uma limitada
 * por um teto de tokens de ENTRADA (a janela encolhe se a fala for densa). Blocos sem nenhuma fala não geram chamada.
 * Também monta as linhas do pedido (transcrição e chat do período) e estima chamadas e tokens ANTES de rodar.
 */

const { cuesInRange } = require('../transcript/format');
const { clock, estimateTokens, SYSTEM_PROMPT, CUT_SCHEMA } = require('./prompt');

const OVERLAP_SEC = 90;
const DEFAULT_WINDOW_SEC = 35 * 60;
const MIN_WINDOW_SEC = 120;
const MAX_CHAT_LINES = 150;
// instruções fixas de cada chamada (sistema + formato + cabeçalho)
const OVERHEAD_TOKENS = estimateTokens(SYSTEM_PROMPT) + estimateTokens(CUT_SCHEMA) + 220;
const OUTPUT_TOKENS_PER_BLOCK = 1800; // ~8 candidatos
const OUTPUT_TOKENS_PICK = 1500;
const PICK_INPUT_TOKENS_PER_CANDIDATE = 90;

function cueLine(cue) {
  return `${clock(cue.start)} ${cue.text}`;
}

function chatLinesFor(chat, from, to, maxLines = MAX_CHAT_LINES) {
  if (!chat || !Array.isArray(chat.messages)) return [];
  const msgs = chat.messages.filter((m) => m && Number.isFinite(m.t) && m.t >= from && m.t <= to && m.text);
  let picked = msgs;
  if (msgs.length > maxLines) { // amostra uniforme: mantém o formato da distribuição do período
    const step = msgs.length / maxLines;
    picked = Array.from({ length: maxLines }, (_, i) => msgs[Math.floor(i * step)]);
  }
  return picked.map((m) => `${clock(m.t)} ${String(m.user || '').replace(/^@/, '').slice(0, 24)}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 160)}`);
}

/**
 * @param {object[]} cues         falas da transcrição (em ordem)
 * @param {number} duration       duração do vídeo
 * @param {{ windowSec?:number, maxInputTokens?:number, chat?:object|null, profileTokens?:number }} [o]
 *   profileTokens: tokens do perfil de humor do canal (critérios, bordões e exemplos), repetidos em CADA chamada de bloco
 * @returns {Array<{ index:number, total:number, from:number, to:number, lines:string[], chatLines:string[], tokens:number }>}
 */
function buildWindows(cues, duration, { windowSec = DEFAULT_WINDOW_SEC, maxInputTokens = 24000, chat = null, profileTokens = 0 } = {}) {
  // o chat do período (até 150 linhas) também ocupa o pedido: reserva espaço para ele. Com um teto de entrada pequeno (um provedor de
  // limite por minuto baixo, como a Groq no plano gratuito) a reserva e o número de linhas do chat encolhem junto.
  const hasChat = chat && Array.isArray(chat.messages) && chat.messages.length;
  const chatReserve = !hasChat ? 0 : (maxInputTokens >= 20000 ? 3500 : Math.floor(maxInputTokens * 0.15));
  const chatMax = chatReserve >= 3500 ? MAX_CHAT_LINES : Math.max(10, Math.floor(chatReserve / 24));
  const extra = Math.max(0, Math.round(Number(profileTokens) || 0));
  const budget = Math.max(1000, maxInputTokens - OVERHEAD_TOKENS - chatReserve - extra);
  const raw = [];
  let start = 0;
  while (start < duration - 1) {
    let end = Math.min(duration, start + Math.max(MIN_WINDOW_SEC, windowSec));
    let inRange = cuesInRange(cues, start, end);
    // encolhe a janela até caber no teto de tokens (cada fala conta a linha e o chat do período entra na conta)
    let tokens = 0;
    let kept = 0;
    for (; kept < inRange.length; kept += 1) {
      const next = tokens + estimateTokens(cueLine(inRange[kept])) + 1;
      if (next > budget) break;
      tokens = next;
    }
    if (kept < inRange.length && kept > 0) {
      end = Math.max(start + MIN_WINDOW_SEC, Math.min(end, inRange[kept - 1].end));
      inRange = cuesInRange(cues, start, end);
    }
    if (inRange.length) raw.push({ from: start, to: end, cues: inRange });
    if (end >= duration - 1) break;
    const next = end - OVERLAP_SEC;
    start = next > start ? next : end; // sempre avança
  }
  return raw.map((w, index) => {
    const lines = w.cues.map(cueLine);
    const chatLines = chatLinesFor(chat, w.from, w.to, chatMax);
    const tokens = OVERHEAD_TOKENS + extra + estimateTokens(lines.join('\n')) + estimateTokens(chatLines.join('\n'));
    return { index, total: raw.length, from: w.from, to: w.to, lines, chatLines, tokens };
  });
}

/**
 * Modo JANELAS CANDIDATAS: junta as janelas marcadas pelo filtro local (candidates.js) em BLOCOS de chamada, cada um dentro do teto de
 * tokens de entrada e com no máximo `maxPerCall` janelas (poucas chamadas: menos 429 e menos instruções repetidas). Cada janela leva
 * `contextSec` de fala antes e depois do trecho marcado.
 * @returns {Array<{ index, total, from, to, lines:string[], chatLines:string[], tokens:number, packed:object[] }>} (mesma forma de buildWindows)
 */
function packCandidateBlocks(candidates, cues, duration, { maxInputTokens = 24000, chat = null, profileTokens = 0, contextSec = 15, maxPerCall = 6 } = {}) {
  const extra = Math.max(0, Math.round(Number(profileTokens) || 0));
  const budget = Math.max(1000, maxInputTokens - OVERHEAD_TOKENS - extra - 400);
  const items = [...candidates].sort((a, b) => a.from - b.from).map((w) => {
    const ctxFrom = Math.max(0, w.from - contextSec);
    const ctxTo = Math.min(duration, w.to + contextSec);
    const lines = cuesInRange(cues, ctxFrom, ctxTo).map(cueLine);
    const chatLines = chatLinesFor(chat, ctxFrom, ctxTo, 40);
    const tokens = estimateTokens(lines.join('\n')) + estimateTokens(chatLines.join('\n')) + 30;
    return { id: w.id, from: w.from, to: w.to, ctxFrom, ctxTo, lines, chatLines, tokens, score: w.score };
  }).filter((w) => w.lines.length);
  const groups = [];
  let cur = [];
  let used = 0;
  for (const w of items) {
    // uma janela maior que o teto vai sozinha (as falas excedentes ficam de fora, como em buildWindows)
    if (cur.length && (used + w.tokens > budget || cur.length >= maxPerCall)) { groups.push(cur); cur = []; used = 0; }
    cur.push(w); used += w.tokens;
  }
  if (cur.length) groups.push(cur);
  return groups.map((packed, index) => ({
    index, total: groups.length,
    from: packed[0].ctxFrom, to: packed[packed.length - 1].ctxTo,
    lines: packed.flatMap((w) => w.lines), chatLines: packed.flatMap((w) => w.chatLines),
    tokens: OVERHEAD_TOKENS + extra + packed.reduce((n, w) => n + w.tokens, 0),
    packed
  }));
}

/**
 * { windows, calls, inputTokens, outputTokens, totalTokens } para mostrar antes de rodar ("~7 chamadas, ~46 mil tokens").
 * `pickExtraTokens`: o resumo do perfil de humor que vai junto da escolha final.
 */
function estimate(windows, { candidatesPerBlock = 8, pickExtraTokens = 0 } = {}) {
  const inputBlocks = windows.reduce((n, w) => n + w.tokens, 0);
  const picks = Math.min(40, windows.length * candidatesPerBlock);
  const pickIn = OVERHEAD_TOKENS + Math.max(0, Math.round(Number(pickExtraTokens) || 0)) + picks * PICK_INPUT_TOKENS_PER_CANDIDATE;
  const calls = windows.length + (windows.length ? 1 : 0);
  const inputTokens = inputBlocks + (windows.length ? pickIn : 0);
  const outputTokens = windows.length * OUTPUT_TOKENS_PER_BLOCK + (windows.length ? OUTPUT_TOKENS_PICK : 0);
  return { windows: windows.length, calls, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/** "~7 chamadas, ~46 mil tokens" */
function describeEstimate(est) {
  if (!est.calls) return 'nada para enviar';
  const mil = Math.max(1, Math.round(est.totalTokens / 1000));
  return `~${est.calls} chamada${est.calls === 1 ? '' : 's'}, ~${mil.toLocaleString('pt-BR')} mil tokens`;
}

module.exports = { packCandidateBlocks, buildWindows, estimate, describeEstimate, chatLinesFor, cueLine, OVERLAP_SEC, DEFAULT_WINDOW_SEC, OVERHEAD_TOKENS, MAX_CHAT_LINES };

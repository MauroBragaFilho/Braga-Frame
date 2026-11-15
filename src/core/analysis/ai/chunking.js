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

function chatLinesFor(chat, from, to) {
  if (!chat || !Array.isArray(chat.messages)) return [];
  const msgs = chat.messages.filter((m) => m && Number.isFinite(m.t) && m.t >= from && m.t <= to && m.text);
  let picked = msgs;
  if (msgs.length > MAX_CHAT_LINES) { // amostra uniforme: mantém o formato da distribuição do período
    const step = msgs.length / MAX_CHAT_LINES;
    picked = Array.from({ length: MAX_CHAT_LINES }, (_, i) => msgs[Math.floor(i * step)]);
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
  // o chat do período (até 150 linhas) também ocupa o pedido: reserva espaço para ele
  const chatReserve = chat && Array.isArray(chat.messages) && chat.messages.length ? 3500 : 0;
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
    const chatLines = chatLinesFor(chat, w.from, w.to);
    const tokens = OVERHEAD_TOKENS + extra + estimateTokens(lines.join('\n')) + estimateTokens(chatLines.join('\n'));
    return { index, total: raw.length, from: w.from, to: w.to, lines, chatLines, tokens };
  });
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

module.exports = { buildWindows, estimate, describeEstimate, chatLinesFor, OVERLAP_SEC, DEFAULT_WINDOW_SEC, OVERHEAD_TOKENS, MAX_CHAT_LINES };

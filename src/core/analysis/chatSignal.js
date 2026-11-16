'use strict';

const fs = require('node:fs');
const { AnalysisError } = require('./errors');
const { localBaseline, trimmedMean, prefixSums, softRamp } = require('./stats');
const { normalizeKeyword } = require('./params');

/**
 * Sinal de CHAT: velocidade de mensagens por janela (comparada à média local) e palavras-chave opcionais.
 * Lê o formato unificado `bf-chat-1` (arquitetura 3.6): { format, platform, videoId, messages:[{ t, user, text }] }
 * com `t` em segundos desde o início do vídeo.
 *
 * Leitura: usa `readChat` de src/core/sources/chatFormat.js quando esse arquivo existir (é dele o formato);
 * antes disso, ou se ele falhar, lê o JSON direto, de forma defensiva.
 *
 * O público reage ALGUNS segundos depois do lance (atraso da transmissão + digitação): a pontuação do
 * chat é deslocada para trás em `lagSec` (padrão 6 s, ajustável).
 */

const MIN_RATE = 0.02; // msg/s: piso da média de referência (chat quase parado não explode a razão)
// CHAT PEQUENO (poucas pessoas conversando com quem transmite): nunca chega a "6 mensagens em 10 s" nem a "3 com palavra-chave", então a
// velocidade e as palavras-chave não dizem nada. O que diz é a RISADA escrita ("kkkk", "haha", "rsrs", 😂): cada mensagem de riso é uma
// reação ao que aconteceu de REACT_BACK_MIN_SEC a REACT_BACK_MAX_SEC antes (atraso da transmissão + digitar). Uma mensagem pontua pouco
// (não vira sugestão sozinha); duas somam. Medido numa gameplay de 4h18 com 1,5 mensagem por minuto: 35% das risadas do chat caem num
// momento forte ou bom da seleção feita à mão (20% ao acaso) e 15 dos 37 momentos fortes ou bons têm uma.
const SMALL_CHAT_RATE = 0.05; // msg/s na média do vídeo (3 por minuto): abaixo disto é chat pequeno
const REACT_BACK_MIN_SEC = 3;
const REACT_BACK_MAX_SEC = 35;
const LAUGH_ONE = 0.45; // quanto vale UMA mensagem de riso (duas: 0,70; três: 0,83)
const LAUGH_RE = /k{3,}|(?:ha){2,}|(?:he){2,}|(?:hue?){2,}|(?:rs){2,}|(?:ka){2,}|\blol\b|\blmf?ao+\b|[\u{1F602}\u{1F923}\u{1F480}\u{1F639}]/iu;
const RATIO_CAP = 12; // limite superior da razão: um chat quase parado que recebe uma rajada não vira "40× a média"

/** Lê e valida o chat. Devolve { platform, messages:[{ t, text }] } ou lança CHAT_UNREADABLE. */
async function loadChat(chatPath) {
  const bad = (why) => new AnalysisError('CHAT_UNREADABLE', `Não foi possível usar o chat (${why}). O sinal de chat foi ignorado; baixe o chat de novo na aba Novo projeto.`);
  if (typeof chatPath !== 'string' || !chatPath) throw bad('caminho do arquivo ausente');
  if (!fs.existsSync(chatPath)) throw bad(`arquivo não encontrado: ${chatPath}`);

  let data = null;
  let official = null;
  try { official = require('../sources/chatFormat'); } catch { official = null; } // ainda não existe ou não carrega
  if (official && typeof official.readChat === 'function') {
    try { data = await official.readChat(chatPath); } catch { data = null; }
  }
  if (!data || !Array.isArray(data.messages)) {
    try { data = JSON.parse(fs.readFileSync(chatPath, 'utf8')); } catch (err) { throw bad(`JSON inválido: ${err.message}`); }
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.messages)) throw bad('o arquivo não está no formato bf-chat-1');
  if (data.format !== undefined && data.format !== 'bf-chat-1') throw bad(`formato "${data.format}" não reconhecido (esperado bf-chat-1)`);

  const messages = [];
  for (const m of data.messages) {
    if (!m || typeof m !== 'object') continue;
    const t = typeof m.t === 'string' ? Number(m.t) : m.t;
    if (!Number.isFinite(t) || t < 0) continue;
    messages.push({ t, text: typeof m.text === 'string' ? m.text : '' });
  }
  return { platform: typeof data.platform === 'string' ? data.platform : '', messages };
}

/**
 * Mensagens por segundo (índice k = [k, k+1)) nos `n` primeiros segundos. Usa `messagesPerWindow(chat, 1, n)` do formato
 * oficial (sources/chatFormat.js, síncrona: devolve um array de contagens até o fim do vídeo); a contagem própria só entra
 * se esse módulo não existir ou não carregar.
 */
function perSecondCounts(messages, n) {
  const counts = new Float64Array(n);
  let official = null;
  try { official = require('../sources/chatFormat'); } catch { official = null; }
  if (official && typeof official.messagesPerWindow === 'function') {
    try {
      const list = official.messagesPerWindow(messages, 1, n);
      for (let k = 0; k < n && k < list.length; k += 1) counts[k] = list[k];
      return counts;
    } catch { counts.fill(0); }
  }
  for (const msg of messages) {
    const sec = Math.floor(msg.t);
    if (sec >= 0 && sec < n) counts[sec] += 1;
  }
  return counts;
}

/** Identificação leve do arquivo de chat para a chave de cache do resultado. */
function chatFingerprint(chatPath) {
  try {
    const st = fs.statSync(chatPath);
    return `${chatPath}|${st.size}|${Math.round(st.mtimeMs)}`;
  } catch {
    return `${chatPath}|ausente`;
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fmtRatio = (r) => String(r >= 10 ? Math.round(r) : Math.round(r * 10) / 10).replace('.', ',');

/** Pontuação por segundo (0..1). Devolve { id, score, describe(from, to), stats }. */
function scoreChat(chat, { n, th, params }) {
  const { windowSec, lagSec, minMessages, keywords } = params.chat;
  const counts = perSecondCounts(chat.messages, n);
  const kwCounts = new Float64Array(n);
  const kwEvents = []; // { sec, hits:[palavras] } só das mensagens com palavra-chave
  const matchers = keywords.map((word) => ({ word, re: new RegExp(`(?:^|[^a-z0-9])${escapeRe(normalizeKeyword(word))}`) }));
  const small = n > 0 && chat.messages.length / n < SMALL_CHAT_RATE;
  const laughSecs = []; // segundo de cada mensagem de riso (só conta em chat pequeno)

  for (const msg of chat.messages) {
    const sec = Math.floor(msg.t);
    if (sec < 0 || sec >= n) continue;
    if (small && msg.text && LAUGH_RE.test(msg.text)) laughSecs.push(sec);
    if (matchers.length && msg.text) {
      const text = normalizeKeyword(msg.text);
      const hits = [];
      for (const { word, re } of matchers) if (re.test(text)) hits.push(word);
      if (hits.length) { kwCounts[sec] += 1; kwEvents.push({ sec, hits }); }
    }
  }

  const base = localBaseline(counts, params.baselineSec, (block) => trimmedMean(block, 0.05));
  const pc = prefixSums(counts);
  const pk = prefixSums(kwCounts);
  const half = Math.floor(windowSec / 2);
  const winSum = (prefix, k) => prefix[Math.min(n, k + windowSec - half)] - prefix[Math.max(0, k - half)];

  const ratio = new Float64Array(n);
  const inWindow = new Float64Array(n);
  const kwInWindow = new Float64Array(n);
  const rateScore = new Float64Array(n);
  const kwScore = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    const sum = winSum(pc, k);
    inWindow[k] = sum;
    ratio[k] = Math.min(RATIO_CAP, (sum / windowSec) / Math.max(base.center[k], MIN_RATE));
    rateScore[k] = sum >= minMessages ? softRamp(ratio[k], th.chatRatio0, th.chatRatioSpan) : 0;
    const kw = winSum(pk, k);
    kwInWindow[k] = kw;
    kwScore[k] = matchers.length && kw >= th.chatKeywords0 ? softRamp(kw, th.chatKeywords0 - 1, th.chatKeywordsSpan) : 0;
  }

  // chat pequeno: cada risada pontua os segundos ANTERIORES a ela (já no tempo do lance, sem o deslocamento de `lagSec`)
  const laughScore = new Float64Array(n);
  for (const sec of laughSecs) {
    for (let k = Math.max(0, sec - REACT_BACK_MAX_SEC); k <= sec - REACT_BACK_MIN_SEC; k += 1) laughScore[k] = 1 - (1 - laughScore[k]) * (1 - LAUGH_ONE);
  }

  // o evento aconteceu `lagSec` ANTES da reação do chat
  const score = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    const c = k + lagSec;
    const burst = c < n ? 1 - (1 - rateScore[c]) * (1 - kwScore[c]) : 0;
    score[k] = 1 - (1 - burst) * (1 - laughScore[k]);
  }

  function describe(from, to) {
    const out = [];
    let rk = -1;
    let kk = -1;
    for (let k = from; k <= to && k + lagSec < n; k += 1) {
      const c = k + lagSec;
      // o maior valor real (não o primeiro segundo saturado em 1,0)
      if (rateScore[c] > 0 && (rk < 0 || ratio[c] > ratio[rk + lagSec])) rk = k;
      if (kwScore[c] > 0 && (kk < 0 || kwInWindow[c] > kwInWindow[kk + lagSec])) kk = k;
    }
    if (rk >= 0) out.push({ kind: 'rate', text: `chat ${fmtRatio(ratio[rk + lagSec])}× a média`, strength: rateScore[rk + lagSec] });
    if (kk >= 0) {
      const c = kk + lagSec;
      const lo = c - half;
      const hi = c - half + windowSec;
      const tally = new Map();
      for (const ev of kwEvents) {
        if (ev.sec < lo || ev.sec >= hi) continue;
        for (const w of ev.hits) tally.set(w, (tally.get(w) || 0) + 1);
      }
      const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, c2]) => `${w} ×${c2}`);
      out.push({ kind: 'keywords', text: `palavras-chave no chat: ${top.join(', ')}`, strength: kwScore[c] });
    }
    if (laughSecs.length) {
      // risadas do chat que reagem a este trecho: as que chegaram de REACT_BACK_MIN_SEC depois do começo até REACT_BACK_MAX_SEC depois do fim
      const count = laughSecs.filter((sec) => sec >= from + REACT_BACK_MIN_SEC && sec <= to + REACT_BACK_MAX_SEC).length;
      let best = 0;
      for (let k = Math.max(0, from); k <= to && k < n; k += 1) if (laughScore[k] > best) best = laughScore[k];
      if (count > 0 && best > 0) out.push({ kind: 'laugh', text: count >= 2 ? `o chat riu (${count} mensagens)` : 'o chat riu', strength: best });
    }
    return out;
  }

  return { id: 'chat', score, describe, stats: { messages: chat.messages.length, keywordMessages: kwEvents.length, small, laughMessages: laughSecs.length } };
}

module.exports = { loadChat, chatFingerprint, scoreChat, perSecondCounts, SMALL_CHAT_RATE, LAUGH_ONE, REACT_BACK_MIN_SEC, REACT_BACK_MAX_SEC };

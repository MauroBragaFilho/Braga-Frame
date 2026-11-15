'use strict';

/**
 * Replay do chat ao vivo do YouTube (dono: sources): o yt-dlp baixa o "live_chat" como legenda
 * (`--write-subs --sub-langs live_chat --skip-download`) para um arquivo JSON Lines; aqui ele é convertido para o
 * formato unificado bf-chat-1 (chatFormat.js).
 *
 * Cada linha do arquivo é uma "ação" do YouTube:
 *   { "replayChatItemAction": { "videoOffsetTimeMsec": "12345", "actions": [ { "addChatItemAction": { "item": {
 *       "liveChatTextMessageRenderer": { "authorName": { "simpleText": "Fulano" },
 *           "message": { "runs": [ { "text": "oi " }, { "emoji": { "emojiId": "😀", "shortcuts": [":sorriso:"] } } ] } } } } } ] } }
 * Valem as mensagens de texto e as de Super Chat/figurinha paga (com o valor na frente). Entradas de sistema
 * (membro novo, avisos, fixadas) são ignoradas. Mensagens com tempo negativo (antes de o vídeo começar) são descartadas.
 */

const fs = require('node:fs');
const path = require('node:path');
const { runProcess } = require('./proc');
const { mapYtdlpError } = require('./ytdlpErrors');
const { ytdlpEnv, liveChatArgs } = require('./ytdlp');
const { FORMAT } = require('./chatFormat');

/** Texto de uma lista de "runs" do YouTube (texto puro e emojis). */
function runsToText(runs) {
  if (!Array.isArray(runs)) return '';
  return runs.map((r) => {
    if (!r || typeof r !== 'object') return '';
    if (typeof r.text === 'string') return r.text;
    if (r.emoji) {
      const e = r.emoji;
      if (typeof e.emojiId === 'string' && e.emojiId && !/^UC|\//.test(e.emojiId)) return e.emojiId; // emoji Unicode
      if (Array.isArray(e.shortcuts) && e.shortcuts[0]) return String(e.shortcuts[0]);
      if (e.image && e.image.accessibility && e.image.accessibility.accessibilityData) return String(e.image.accessibility.accessibilityData.label || '');
    }
    return '';
  }).join('');
}

const simple = (v) => (v && typeof v === 'object' ? (typeof v.simpleText === 'string' ? v.simpleText : runsToText(v.runs)) : '');

/** Item do chat -> { user, text } ou null (mensagens que não são de gente conversando). */
function itemToMessage(item) {
  if (!item || typeof item !== 'object') return null;
  const text = item.liveChatTextMessageRenderer;
  if (text) {
    const body = runsToText(text.message && text.message.runs).trim();
    return body ? { user: simple(text.authorName), text: body } : null;
  }
  const paid = item.liveChatPaidMessageRenderer || item.liveChatPaidStickerRenderer;
  if (paid) {
    const amount = simple(paid.purchaseAmountText).trim();
    const body = runsToText(paid.message && paid.message.runs).trim();
    const joined = [amount ? `[${amount}]` : '', body].filter(Boolean).join(' ');
    return joined ? { user: simple(paid.authorName), text: joined } : null;
  }
  return null;
}

/**
 * Conteúdo do arquivo `.live_chat.json` (JSON Lines) -> { chat (bf-chat-1), skipped }.
 * Linhas ilegíveis são contadas em `skipped` (nunca derrubam a conversão).
 */
function convertYoutubeLiveChat(text, { videoId = '', now = Date.now(), source = 'yt-dlp' } = {}) {
  const messages = [];
  let skipped = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let action;
    try { action = JSON.parse(line); } catch { skipped += 1; continue; }
    const replay = action && action.replayChatItemAction;
    if (!replay) continue;
    const offsetMs = Number(replay.videoOffsetTimeMsec !== undefined ? replay.videoOffsetTimeMsec : action.videoOffsetTimeMsec);
    for (const inner of Array.isArray(replay.actions) ? replay.actions : []) {
      const add = inner && inner.addChatItemAction;
      const message = add && itemToMessage(add.item);
      if (!message) continue;
      if (!Number.isFinite(offsetMs) || offsetMs < 0) { skipped += 1; continue; }
      messages.push({ t: offsetMs / 1000, user: message.user, text: message.text });
    }
  }
  return {
    chat: { format: FORMAT, platform: 'youtube', videoId, fetchedAt: new Date(now).toISOString(), source, messages },
    skipped
  };
}

/**
 * Baixa o replay do chat com o yt-dlp. Devolve { chat, skipped } ou { chat:null, reason } quando o vídeo não tem
 * replay de chat (isso NÃO é erro: é uma resposta honesta). Falhas reais lançam erro com code/message em português.
 * @param {{ exe:string, url:string, videoId:string, common:string[], workDir:string, signal?:AbortSignal, onActivity?:(bytes:number)=>void, env?:object, usedCookies?:boolean, hasJsRuntime?:boolean }} o
 */
async function downloadYoutubeChat({ exe, url, videoId, common, workDir, signal, onActivity, env = ytdlpEnv(), usedCookies = false, hasJsRuntime, version }) {
  fs.mkdirSync(workDir, { recursive: true });
  const outFile = path.join(workDir, 'chat.live_chat.json');
  const watcher = onActivity ? setInterval(() => {
    try { onActivity(fs.statSync(outFile).size); } catch { /* ainda não existe */ }
  }, 700) : null;
  let res;
  try {
    res = await runProcess({
      command: exe, args: liveChatArgs({ url, common, outDir: workDir }), env, signal,
      timeoutMs: 45 * 60 * 1000, captureStdout: false, captureStderr: true
    });
  } finally {
    if (watcher) clearInterval(watcher);
  }
  if (res.reason === 'cancelled') { const e = new Error('Download do chat cancelado.'); e.code = 'CANCELLED'; throw e; }
  if (res.reason === 'timeout') { const e = new Error('O download do chat demorou demais e foi interrompido. Tente de novo.'); e.code = 'TIMEOUT'; throw e; }
  if (res.code !== 0) {
    const mapped = mapYtdlpError(res.stderr, { exitCode: res.code, platform: 'youtube', usedCookies, hasJsRuntime });
    const e = new Error(mapped.message);
    e.code = mapped.code;
    e.details = { raw: mapped.raw, dependsOnAccess: mapped.dependsOnAccess, retryable: mapped.retryable };
    throw e;
  }
  if (!fs.existsSync(outFile)) {
    return { chat: null, reason: 'Este vídeo não tem replay de chat: o chat pode ter sido desativado, a live não guardou o replay ou o vídeo não foi uma transmissão ao vivo.' };
  }
  const converted = convertYoutubeLiveChat(fs.readFileSync(outFile, 'utf8'), { videoId, source: `yt-dlp${version ? ` ${version}` : ''}` });
  if (converted.chat.messages.length === 0) {
    return { chat: null, reason: 'O replay do chat veio vazio: ninguém escreveu no chat durante esta live (ou o canal o manteve desativado).' };
  }
  return converted;
}

module.exports = { convertYoutubeLiveChat, runsToText, itemToMessage, downloadYoutubeChat };

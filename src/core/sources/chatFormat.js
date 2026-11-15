'use strict';

/**
 * Formato unificado de chat `bf-chat-1` (arquitetura 3.6, dono: sources). É o único formato que a análise lê:
 *
 *   { format:'bf-chat-1', platform, videoId, messages:[{ t, user, text }], fetchedAt?, source? }
 *
 * `t` = segundos desde o INÍCIO DO VÍDEO (não da transmissão). Os conversores (twitchChat.js, youtubeChat.js)
 * trazem o chat da plataforma para cá; aqui ficam leitura, gravação atômica e a contagem por janela.
 *
 *   readChat(path)                 -> Promise<{ format, platform, videoId, messages }>   (valida e ordena por t)
 *   writeChat(path, data)          -> Promise<{ path, count }>                           (valida; tmp + rename)
 *   messagesPerWindow(chat, windowSec, durationSec?) -> number[]
 *        contagem de mensagens por janela de `windowSec`: o índice i cobre [i*windowSec, (i+1)*windowSec).
 *        Sem `durationSec` o vetor vai até a janela da última mensagem; com `durationSec`, até o fim do vídeo.
 *        Mensagens com tempo acima de 7 dias são ignoradas (e descartadas por normalizeChat) e o vetor tem no máximo
 *        5 milhões de janelas (CHAT_BAD_ARGS se a janela for pequena demais para o intervalo).
 *
 * Também há readChatSync / writeChatSync. Erros: ChatFormatError com `code` (CHAT_NOT_FOUND, CHAT_UNREADABLE,
 * CHAT_BAD_FORMAT, CHAT_BAD_ARGS) e mensagem em português.
 */

const fs = require('node:fs');
const path = require('node:path');

const FORMAT = 'bf-chat-1';
const MAX_USER = 100;
const MAX_TEXT = 2000;
// Tempo máximo aceito para uma mensagem (7 dias; uma live da Twitch dura no máximo 48 h) e tamanho máximo do vetor de
// janelas: um `t` absurdo num arquivo editado à mão ou num conversor com defeito não pode alocar gigabytes nem derrubar o processo.
const MAX_T_SEC = 7 * 24 * 3600;
const MAX_WINDOWS = 5_000_000;

class ChatFormatError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ChatFormatError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Valida e normaliza: descarta mensagens sem tempo válido (negativo, NaN, acima de 7 dias) e corta textos absurdos;
 * ordena por `t` (estável). Devolve { chat, dropped }.
 */
function normalizeChat(data, { strictFormat = true } = {}) {
  if (!isObj(data)) throw new ChatFormatError('CHAT_BAD_FORMAT', 'O arquivo de chat não contém um objeto JSON.');
  if (data.format !== undefined && data.format !== FORMAT) {
    throw new ChatFormatError('CHAT_BAD_FORMAT', `Formato de chat "${String(data.format)}" não reconhecido (esperado ${FORMAT}). Baixe o chat de novo na aba Novo projeto.`);
  }
  if (strictFormat && data.format !== FORMAT) throw new ChatFormatError('CHAT_BAD_FORMAT', `O arquivo não está no formato ${FORMAT}.`);
  if (!Array.isArray(data.messages)) throw new ChatFormatError('CHAT_BAD_FORMAT', 'O arquivo de chat não tem a lista de mensagens.');

  const messages = [];
  let dropped = 0;
  for (const raw of data.messages) {
    if (!isObj(raw)) { dropped += 1; continue; }
    const t = typeof raw.t === 'string' && raw.t.trim() !== '' ? Number(raw.t) : raw.t;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > MAX_T_SEC) { dropped += 1; continue; }
    messages.push({
      t: Math.round(t * 1000) / 1000,
      user: typeof raw.user === 'string' ? raw.user.slice(0, MAX_USER) : '',
      text: typeof raw.text === 'string' ? raw.text.slice(0, MAX_TEXT) : ''
    });
  }
  // sort estável do Node: mensagens no mesmo segundo mantêm a ordem em que chegaram
  messages.sort((a, b) => a.t - b.t);

  const extras = {};
  for (const key of ['fetchedAt', 'source']) if (typeof data[key] === 'string') extras[key] = data[key];
  return {
    chat: {
      format: FORMAT,
      platform: typeof data.platform === 'string' ? data.platform : '',
      videoId: typeof data.videoId === 'string' ? data.videoId : '',
      ...extras,
      messages
    },
    dropped
  };
}

function parseChatText(text, file) {
  let data;
  try { data = JSON.parse(text); } catch (err) {
    throw new ChatFormatError('CHAT_UNREADABLE', `Não foi possível ler o arquivo de chat (JSON inválido: ${err.message}). Baixe o chat de novo na aba Novo projeto.`, { file });
  }
  return normalizeChat(data).chat;
}

function readChatSync(file) {
  if (typeof file !== 'string' || !file) throw new ChatFormatError('CHAT_BAD_ARGS', 'Informe o caminho do arquivo de chat.');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') throw new ChatFormatError('CHAT_NOT_FOUND', `O arquivo de chat não foi encontrado: ${file}. Baixe o chat de novo na aba Novo projeto.`, { file });
    throw new ChatFormatError('CHAT_UNREADABLE', `Não foi possível abrir o arquivo de chat (${err.message}).`, { file });
  }
  return parseChatText(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text, file);
}

async function readChat(file) {
  if (typeof file !== 'string' || !file) throw new ChatFormatError('CHAT_BAD_ARGS', 'Informe o caminho do arquivo de chat.');
  let text;
  try { text = await fs.promises.readFile(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') throw new ChatFormatError('CHAT_NOT_FOUND', `O arquivo de chat não foi encontrado: ${file}. Baixe o chat de novo na aba Novo projeto.`, { file });
    throw new ChatFormatError('CHAT_UNREADABLE', `Não foi possível abrir o arquivo de chat (${err.message}).`, { file });
  }
  return parseChatText(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text, file);
}

/** Normaliza (com format bf-chat-1 obrigatório no resultado) e serializa. */
function serialize(data) {
  const { chat } = normalizeChat({ ...data, format: FORMAT }, { strictFormat: false });
  return { chat, text: JSON.stringify(chat) };
}

function writeChatSync(file, data) {
  if (typeof file !== 'string' || !file) throw new ChatFormatError('CHAT_BAD_ARGS', 'Informe o caminho do arquivo de chat.');
  const { chat, text } = serialize(data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { path: file, count: chat.messages.length };
}

async function writeChat(file, data) {
  if (typeof file !== 'string' || !file) throw new ChatFormatError('CHAT_BAD_ARGS', 'Informe o caminho do arquivo de chat.');
  const { chat, text } = serialize(data);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await fs.promises.writeFile(tmp, text);
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
  return { path: file, count: chat.messages.length };
}

/**
 * Mensagens por janela de `windowSec` segundos (índice i = [i*windowSec, (i+1)*windowSec)).
 * `chat` pode ser o objeto lido por readChat ou só a lista de mensagens.
 */
function messagesPerWindow(chat, windowSec, durationSec) {
  const win = Number(windowSec);
  if (!Number.isFinite(win) || win <= 0) throw new ChatFormatError('CHAT_BAD_ARGS', 'A janela precisa ser um número de segundos maior que zero.');
  const list = Array.isArray(chat) ? chat : (isObj(chat) && Array.isArray(chat.messages) ? chat.messages : null);
  if (!list) throw new ChatFormatError('CHAT_BAD_ARGS', 'Informe o chat (objeto bf-chat-1 ou lista de mensagens).');

  // mensagens com tempo fora do intervalo plausível (negativo, NaN, acima de 7 dias) não contam nem aumentam o vetor
  const valid = (m) => Boolean(m) && Number.isFinite(m.t) && m.t >= 0 && m.t <= MAX_T_SEC;
  let lastT = -1;
  for (const m of list) if (valid(m) && m.t > lastT) lastT = m.t;
  const fromMessages = lastT < 0 ? 0 : Math.floor(lastT / win) + 1;
  const fromDuration = Number.isFinite(durationSec) && durationSec > 0 ? Math.ceil(durationSec / win) : 0;
  const size = Math.max(fromMessages, fromDuration);
  if (size > MAX_WINDOWS) {
    throw new ChatFormatError('CHAT_BAD_ARGS', `A janela de ${win} s é pequena demais para este intervalo (${size.toLocaleString('pt-BR')} janelas; o máximo é ${MAX_WINDOWS.toLocaleString('pt-BR')}). Use uma janela maior.`);
  }
  const counts = new Array(size).fill(0);
  for (const m of list) {
    if (!valid(m)) continue;
    const index = Math.floor(m.t / win);
    if (index < counts.length) counts[index] += 1;
  }
  return counts;
}

module.exports = { FORMAT, MAX_T_SEC, MAX_WINDOWS, ChatFormatError, normalizeChat, readChat, readChatSync, writeChat, writeChatSync, messagesPerWindow };

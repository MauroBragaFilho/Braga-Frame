'use strict';

/**
 * Chat de VODs da Twitch (dono: sources): baixa com o TwitchDownloaderCLI (release oficial lay295/TwitchDownloader,
 * `chatdownload --id`) e converte o JSON dele para o formato unificado bf-chat-1 (chatFormat.js).
 *
 * JSON do TwitchDownloader (campos usados): `comments[]` com `content_offset_seconds` (segundos desde o início do
 * VOD), `commenter.display_name | name`, `message.body` (ou `message.fragments[].text`), `state`.
 * Os demais campos (emotes embutidos, badges, cores…) são ignorados.
 */

const fs = require('node:fs');
const path = require('node:path');
const { runProcess } = require('./proc');
const { mapTwitchDownloaderError } = require('./ytdlpErrors');
const { FORMAT } = require('./chatFormat');

const str = (v) => (typeof v === 'string' ? v : '');

/** JSON do TwitchDownloader (objeto) -> { chat (bf-chat-1), skipped }. */
function convertTwitchChat(json, { videoId = '', now = Date.now(), source = 'TwitchDownloaderCLI' } = {}) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.comments)) {
    const err = new Error('O arquivo baixado não parece um chat do TwitchDownloader (falta a lista "comments").');
    err.code = 'CHAT_BAD_SOURCE';
    throw err;
  }
  const messages = [];
  let skipped = 0;
  for (const c of json.comments) {
    if (!c || typeof c !== 'object') { skipped += 1; continue; }
    if (c.state && c.state !== 'published') { skipped += 1; continue; }
    const t = Number(c.content_offset_seconds);
    const msg = c.message && typeof c.message === 'object' ? c.message : {};
    let text = str(msg.body);
    if (!text && Array.isArray(msg.fragments)) text = msg.fragments.map((f) => str(f && f.text)).join('');
    text = text.trim();
    if (!Number.isFinite(t) || t < 0 || !text) { skipped += 1; continue; }
    const who = c.commenter && typeof c.commenter === 'object' ? c.commenter : {};
    messages.push({ t, user: str(who.display_name) || str(who.name), text });
  }
  const fromFile = json.video && typeof json.video === 'object' ? str(json.video.id) : '';
  return {
    chat: {
      format: FORMAT,
      platform: 'twitch',
      videoId: videoId || fromFile,
      fetchedAt: new Date(now).toISOString(),
      source,
      messages
    },
    skipped
  };
}

/** Argumentos do `chatdownload` (o arquivo de saída é nosso: pode ser sobrescrito sem perguntar). */
function chatDownloadArgs({ videoId, outFile, tempDir }) {
  return [
    'chatdownload', '--id', String(videoId), '-o', outFile,
    '--collision', 'Overwrite', '--banner', 'false', '--temp-path', tempDir
  ];
}

/**
 * Baixa o chat do VOD para um JSON temporário e devolve o objeto bf-chat-1 (ainda sem gravar).
 * @param {{ exe:string, videoId:string, workDir:string, signal?:AbortSignal, onProgress?:(p:number|null)=>void }} o
 * @returns {Promise<{ chat, skipped }>}
 * @throws erro com `code` e `message` em português (CANCELLED, CHAT_VOD_GONE, NETWORK, CHAT_FAILED…)
 */
async function downloadTwitchChat({ exe, videoId, workDir, signal, onProgress, version }) {
  fs.mkdirSync(workDir, { recursive: true });
  const tempDir = path.join(workDir, 'tmp');
  fs.mkdirSync(tempDir, { recursive: true });
  const outFile = path.join(workDir, `twitch-${videoId}.json`);
  let last = '';
  const res = await runProcess({
    command: exe,
    args: chatDownloadArgs({ videoId, outFile, tempDir }),
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', NO_COLOR: '1' },
    signal,
    timeoutMs: 30 * 60 * 1000,
    onStdoutLine: (line) => {
      last = line;
      const m = /(\d{1,3})\s*%/.exec(line);
      if (m && onProgress) onProgress(Math.min(100, Number(m[1])));
    },
    onStderrLine: () => {},
    captureStdout: true
  });
  if (res.reason === 'cancelled') { const e = new Error('Download do chat cancelado.'); e.code = 'CANCELLED'; throw e; }
  if (res.reason === 'timeout') { const e = new Error('O download do chat demorou demais e foi interrompido. Tente de novo.'); e.code = 'TIMEOUT'; throw e; }
  if (res.code !== 0 || !fs.existsSync(outFile)) {
    const mapped = mapTwitchDownloaderError(`${res.stderr}\n${res.stdout}\n${last}`, res.code);
    const e = new Error(mapped.message);
    e.code = mapped.code;
    e.details = { raw: mapped.raw, dependsOnAccess: mapped.dependsOnAccess, retryable: mapped.retryable };
    throw e;
  }
  let json;
  try { json = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (err) {
    const e = new Error(`O chat foi baixado, mas o arquivo não pôde ser lido (${err.message}). Tente de novo.`);
    e.code = 'CHAT_UNREADABLE';
    throw e;
  }
  return convertTwitchChat(json, { videoId, source: `TwitchDownloaderCLI${version ? ` ${version}` : ''}` });
}

module.exports = { convertTwitchChat, chatDownloadArgs, downloadTwitchChat };

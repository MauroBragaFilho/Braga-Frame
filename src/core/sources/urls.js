'use strict';

/**
 * Reconhece o link de um VOD/vídeo do YouTube ou da Twitch e o normaliza (dono: sources).
 * A URL normalizada é a que vai para o yt-dlp/TwitchDownloaderCLI (sempre depois de "--", nunca como opção) e
 * para o `origin` do projeto. Aceita só http/https, sem usuário/senha e com tamanho limitado.
 */

const MAX_URL_LENGTH = 2048;

const YOUTUBE_HOSTS = /^(?:www\.|m\.|music\.)?youtube\.com$|^youtu\.be$|^(?:www\.)?youtube-nocookie\.com$/i;
const TWITCH_HOSTS = /^(?:www\.|m\.)?twitch\.tv$/i;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

class UrlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UrlError';
    this.code = code;
  }
}

/**
 * @param {string} input
 * @returns {{ platform:'youtube'|'twitch', videoId:string, url:string }}  url = forma canônica
 * @throws {UrlError} INVALID_URL | UNSUPPORTED_URL (mensagens em português que dizem o que colar)
 */
function parseVodUrl(input) {
  if (typeof input !== 'string' || !input.trim()) throw new UrlError('INVALID_URL', 'Cole o link do vídeo (YouTube ou Twitch).');
  const text = input.trim();
  if (text.length > MAX_URL_LENGTH) throw new UrlError('INVALID_URL', 'O link é longo demais para ser de um vídeo do YouTube ou da Twitch.');
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch {
    throw new UrlError('INVALID_URL', 'Isso não parece um link. Cole o endereço completo do vídeo (começa com https://).');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UrlError('INVALID_URL', 'Só links http/https são aceitos.');
  if (u.username || u.password) throw new UrlError('INVALID_URL', 'O link não pode conter usuário e senha.');
  const host = u.hostname;
  const segs = u.pathname.split('/').filter(Boolean);

  if (YOUTUBE_HOSTS.test(host)) {
    let id = null;
    if (/^youtu\.be$/i.test(host)) id = segs[0] || null;
    else if (segs[0] === 'watch') id = u.searchParams.get('v');
    else if (['live', 'shorts', 'embed', 'v'].includes(segs[0])) id = segs[1] || null;
    else if (segs[0] === 'playlist') throw new UrlError('UNSUPPORTED_URL', 'Esse link é de uma playlist. Cole o link de UM vídeo (youtube.com/watch?v=…).');
    else throw new UrlError('UNSUPPORTED_URL', 'Esse link do YouTube não é de um vídeo. Cole o link do vídeo ou da live já encerrada (youtube.com/watch?v=… ou youtube.com/live/…).');
    if (!id || !YOUTUBE_ID.test(id)) throw new UrlError('INVALID_URL', 'Não encontrei o código do vídeo nesse link do YouTube.');
    return { platform: 'youtube', videoId: id, url: `https://www.youtube.com/watch?v=${id}` };
  }

  if (TWITCH_HOSTS.test(host)) {
    let id = null;
    if (segs[0] === 'videos') id = segs[1] || null;
    else if (segs.length >= 3 && (segs[1] === 'v' || segs[1] === 'video')) id = segs[2];
    else if (segs[0] === 'clip' || segs.includes('clip')) throw new UrlError('UNSUPPORTED_URL', 'Clipes da Twitch ainda não são suportados. Cole o link do VOD (twitch.tv/videos/…).');
    else throw new UrlError('UNSUPPORTED_URL', 'Esse link da Twitch não é de um VOD. Cole o link do vídeo gravado (twitch.tv/videos/…).');
    if (!id || !/^\d{1,15}$/.test(id)) throw new UrlError('INVALID_URL', 'Não encontrei o número do VOD nesse link da Twitch.');
    return { platform: 'twitch', videoId: id, url: `https://www.twitch.tv/videos/${id}` };
  }

  throw new UrlError('UNSUPPORTED_URL', 'Só links do YouTube e da Twitch são aceitos aqui. Para outros vídeos, baixe o arquivo e use "Abrir vídeo…".');
}

module.exports = { parseVodUrl, UrlError, MAX_URL_LENGTH };

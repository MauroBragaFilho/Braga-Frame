'use strict';

/**
 * Tudo que é específico do yt-dlp (dono: sources): argumentos, leitura do JSON de metadados, qualidades
 * oferecidas, leitura das linhas de progresso e os avisos da saída. Não executa nada: quem executa é o manager
 * (proc.js). Adaptado do que o Braga Digital Studio já resolve (YtDlpTool/downloadService), sem o logger dele.
 *
 * Decisões:
 *  - `--ignore-config`: o comportamento não depende do arquivo de configuração pessoal do yt-dlp do usuário;
 *  - `--no-playlist`: um link com "&list=" baixa só o vídeo;
 *  - a URL vai sempre depois de "--" (nunca vira opção);
 *  - progresso por `--progress-template` com prefixo próprio (linhas "BFP|…"), que não muda entre versões do yt-dlp;
 *  - formato: tampa de altura escolhida na lista, preferindo H.264/AAC quando a resolução empata (toca em qualquer
 *    lugar e é o que o player do app entende melhor); sem tampa ("melhor"), vale a maior resolução.
 */

const path = require('node:path');

const BROWSERS = Object.freeze(['chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'chromium']);
const PROGRESS_PREFIX = 'BFP|';
const POST_PREFIX = 'BFPP|';
const NA = new Set(['NA', 'None', 'null', 'undefined', '']);

/**
 * O yt-dlp é considerado antigo se é MAIS VELHO que a versão oficial que o app fixa (a mais recente conferida) ou, como
 * reserva, se passou de tantos dias: o YouTube muda sempre e versões velhas passam a levar HTTP 403. Ter exatamente a
 * versão fixada nunca é 'antigo', mesmo que a release já tenha semanas.
 */
const OUTDATED_DAYS = 120;

/** Idade em dias de uma versão do yt-dlp ("2026.07.04" = data da release); null se não der para ler. */
function versionAgeDays(version, nowMs = Date.now()) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(String(version || '').trim());
  if (!m) return null;
  const released = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(released)) return null;
  return Math.max(0, Math.floor((nowMs - released) / 86400000));
}

/** true se `version` é antiga: mais velha que `pinned` (versões AAAA.MM.DD comparam como texto) ou além de OUTDATED_DAYS. */
function isOutdated(version, pinned, nowMs = Date.now()) {
  const v = /^\d{4}\.\d{2}\.\d{2}/.exec(String(version || '').trim());
  if (!v) return false;
  const p = /^\d{4}\.\d{2}\.\d{2}/.exec(String(pinned || '').trim());
  if (p && v[0] < p[0]) return true;
  const age = versionAgeDays(version, nowMs);
  return age !== null && age > OUTDATED_DAYS;
}

/** Ambiente do yt-dlp: saída sempre em UTF-8 (títulos com acento/emoji) e sem cores. */
function ytdlpEnv(base = process.env) {
  return { ...base, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', NO_COLOR: '1' };
}

/**
 * Ambiente com a pasta temporária trocada por `dir`. O yt-dlp.exe oficial é um PyInstaller "onefile": ele se extrai em
 * `%TEMP%\_MEI<n>` (~22 MB) e só apaga isso quando sai sozinho. Cancelar (taskkill /F) ou fechar o app no meio deixaria uma
 * pasta dessas para trás a cada vez; com uma pasta própria por execução, o app apaga tudo no fim, cancelado ou não.
 * No Windows os nomes de variável não diferenciam maiúsculas: remove as variantes antes de definir as novas.
 */
function withTempDir(env, dir) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) if (!/^(temp|tmp|tmpdir)$/i.test(key)) out[key] = value;
  return { ...out, TEMP: dir, TMP: dir, TMPDIR: dir };
}

/**
 * Argumentos comuns a todo uso do yt-dlp.
 * @param {{ ffmpegPath?:string|null, denoPath?:string|null, cacheDir?:string, cookiesBrowser?:string }} o
 */
function commonArgs({ ffmpegPath, denoPath, cacheDir, cookiesBrowser } = {}) {
  const args = ['--ignore-config', '--no-playlist', '--socket-timeout', '30', '--no-mtime'];
  if (ffmpegPath) args.push('--ffmpeg-location', path.dirname(ffmpegPath));
  if (denoPath) args.push('--js-runtimes', `deno:${denoPath}`);
  if (cacheDir) args.push('--cache-dir', cacheDir);
  if (cookiesBrowser && BROWSERS.includes(cookiesBrowser)) args.push('--cookies-from-browser', cookiesBrowser);
  return args;
}

function metadataArgs(url, common) {
  return [...common, '-J', '--', url];
}

/** Seletor de formato + ordenação para a qualidade escolhida ({ height?:number } ou 'best'). */
function formatSelection(quality) {
  const sort = 'res,fps,vcodec:h264,acodec:aac';
  const height = quality && typeof quality === 'object' ? Number(quality.height) : NaN;
  if (Number.isFinite(height) && height > 0) {
    const cap = `[height<=${Math.round(height)}]`;
    return { format: `bv*${cap}+ba/b${cap}`, sort };
  }
  return { format: 'bv*+ba/b', sort };
}

/**
 * Argumentos do download de vídeo para dentro de `workDir` (arquivo `video.<ext>`; o manager move depois).
 * `--continue` retoma os ".part" que já estiverem lá.
 */
function downloadArgs({ url, common, quality, workDir, concurrentFragments = 4 }) {
  const { format, sort } = formatSelection(quality);
  return [
    ...common,
    '--newline', '--continue', '--concurrent-fragments', String(concurrentFragments),
    '-f', format, '-S', sort,
    '--merge-output-format', 'mp4', '--remux-video', 'mp4',
    '--progress-template', `download:${PROGRESS_PREFIX}%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s|%(info.format_id)s`,
    '--progress-template', `postprocess:${POST_PREFIX}%(progress.status)s|%(progress.postprocessor)s`,
    '-o', path.join(workDir, 'video.%(ext)s'),
    '--', url
  ];
}

/** Argumentos para baixar só o replay do chat ao vivo do YouTube (arquivo `chat.live_chat.json` em `outDir`). */
function liveChatArgs({ url, common, outDir }) {
  return [
    ...common,
    '--skip-download', '--write-subs', '--sub-langs', 'live_chat',
    '--newline', '-o', path.join(outDir, 'chat.%(ext)s'),
    '--', url
  ];
}

// ---------- leitura das linhas de saída ----------

const num = (s) => {
  if (s === undefined || NA.has(String(s).trim())) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * Uma linha da saída do yt-dlp -> evento ou null:
 *   { type:'progress', status, downloaded, total, totalEstimate, speed, eta, fragIndex, fragCount, formatId }
 *   { type:'post', status, name }
 *   { type:'plan', formats:[id…] }          "[info] <id>: Downloading 1 format(s): 399+251"
 *   { type:'destination', file }            "[download] Destination: …"
 *   { type:'already', file }                "[download] <arquivo> has already been downloaded"
 */
function parseOutputLine(line) {
  if (line.startsWith(PROGRESS_PREFIX)) {
    const f = line.slice(PROGRESS_PREFIX.length).split('|');
    return {
      type: 'progress',
      status: f[0] || '',
      downloaded: num(f[1]), total: num(f[2]), totalEstimate: num(f[3]),
      speed: num(f[4]), eta: num(f[5]), fragIndex: num(f[6]), fragCount: num(f[7]),
      formatId: f[8] && !NA.has(f[8]) ? f[8] : ''
    };
  }
  if (line.startsWith(POST_PREFIX)) {
    const f = line.slice(POST_PREFIX.length).split('|');
    return { type: 'post', status: f[0] || '', name: f[1] && !NA.has(f[1]) ? f[1] : '' };
  }
  const plan = /Downloading \d+ format\(s\):\s*(\S+)/i.exec(line);
  if (plan) return { type: 'plan', formats: plan[1].split('+') };
  const dest = /^\[download\]\s+Destination:\s+(.+)$/i.exec(line);
  if (dest) return { type: 'destination', file: dest[1].trim() };
  const already = /^\[download\]\s+(.+?)\s+has already been downloaded/i.exec(line);
  if (already) return { type: 'already', file: already[1].trim() };
  return null;
}

// ---------- metadados ----------

const str = (v) => (typeof v === 'string' ? v : '');

/** "20261021" -> "2026-10-21"; sem upload_date usa o timestamp (UTC). */
function uploadDateOf(info) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(str(info.upload_date));
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const ts = Number(info.timestamp || info.release_timestamp);
  if (Number.isFinite(ts) && ts > 0) return new Date(ts * 1000).toISOString().slice(0, 10);
  return '';
}

function formatSize(f, duration) {
  const direct = Number(f.filesize) || Number(f.filesize_approx);
  if (direct > 0) return direct;
  const tbr = Number(f.tbr) || (Number(f.vbr) || 0) + (Number(f.abr) || 0);
  return tbr > 0 && duration > 0 ? Math.round((tbr * 1000 / 8) * duration) : null;
}

const isVideo = (f) => f && f.vcodec && f.vcodec !== 'none' && Number(f.height) > 0;
const hasAudio = (f) => f && f.acodec && f.acodec !== 'none';
const isAudioOnly = (f) => f && hasAudio(f) && (!f.vcodec || f.vcodec === 'none');

function fpsLabel(fps) {
  return Number(fps) >= 50 ? String(Math.round(fps)) : '';
}

/**
 * Qualidades oferecidas (maior para a menor): a primeira é "melhor disponível" (sem tampa de altura).
 * [{ id, height|null, label, estBytes|null }]
 */
function buildQualities(info) {
  const duration = Number(info.duration) || 0;
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const videos = formats.filter(isVideo);
  if (!videos.length) return [];
  const bestAudio = formats.filter(isAudioOnly).map((f) => formatSize(f, duration) || 0).reduce((a, b) => Math.max(a, b), 0);

  const byHeight = new Map();
  for (const f of videos) {
    const h = Math.round(Number(f.height));
    const row = byHeight.get(h) || { height: h, fps: 0, size: 0, combined: false };
    row.fps = Math.max(row.fps, Number(f.fps) || 0);
    const size = formatSize(f, duration) || 0;
    row.size = Math.max(row.size, size);
    if (hasAudio(f)) row.combined = true;
    byHeight.set(h, row);
  }
  const rows = [...byHeight.values()].sort((a, b) => b.height - a.height);
  const est = (r) => (r.size > 0 ? r.size + (r.combined ? 0 : bestAudio) : null);
  const label = (r) => `${r.height}p${fpsLabel(r.fps)}`;
  return rows.map((r, i) => (i === 0
    ? { id: 'best', height: null, label: `Melhor disponível (${label(r)})`, estBytes: est(r) }
    : { id: `h${r.height}`, height: r.height, label: label(r), estBytes: est(r) }));
}

/** Jogo mais presente nos capítulos (Twitch: cada troca de jogo vira um capítulo). */
function gameFromChapters(info) {
  const chapters = Array.isArray(info.chapters) ? info.chapters : [];
  const totals = new Map();
  for (const c of chapters) {
    const title = str(c && c.title).trim();
    if (!title) continue;
    const len = Math.max(0, (Number(c.end_time) || 0) - (Number(c.start_time) || 0));
    totals.set(title, (totals.get(title) || 0) + len);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  return { game: ranked.length ? ranked[0][0] : '', games: ranked.map(([title]) => title) };
}

/**
 * Metadados do VOD no formato do app, a partir do JSON de `yt-dlp -J`.
 * game = só quando a fonte informa um jogo de verdade (campo "game" ou a categoria da Twitch); a categoria
 * genérica do YouTube ("Gaming") fica em `categories` e NÃO vira jogo.
 */
function normalizeMetadata(info, { platform, videoId, url, now = Date.now() }) {
  if (!info || typeof info !== 'object') throw new Error('Resposta do yt-dlp vazia.');
  const chapters = gameFromChapters(info);
  const explicitGame = str(info.game).trim();
  const liveStatus = str(info.live_status) || (info.is_live ? 'is_live' : 'not_live');
  const subs = info.subtitles && typeof info.subtitles === 'object' ? info.subtitles : {};
  return {
    platform,
    videoId,
    url,
    title: str(info.title).trim() || str(info.fulltitle).trim() || `${platform === 'twitch' ? 'VOD' : 'Vídeo'} ${videoId}`,
    channel: str(info.channel).trim() || str(info.uploader).trim() || str(info.creator).trim() || str(info.uploader_id).trim(),
    game: explicitGame || (platform === 'twitch' ? chapters.game : ''),
    games: platform === 'twitch' ? chapters.games : (explicitGame ? [explicitGame] : []),
    categories: Array.isArray(info.categories) ? info.categories.filter((c) => typeof c === 'string') : [],
    duration: Number(info.duration) > 0 ? Number(info.duration) : 0,
    uploadDate: uploadDateOf(info),
    thumbnail: str(info.thumbnail),
    liveStatus,
    isLive: liveStatus === 'is_live' || liveStatus === 'is_upcoming',
    availability: str(info.availability),
    hasChatReplay: Boolean(subs.live_chat),
    fetchedAt: new Date(now).toISOString()
  };
}

/** Situação do chat para a interface (honesta: "não dá para saber" é `available:null`). */
function chatAvailability(meta) {
  if (meta.platform === 'twitch') {
    return { available: null, tool: 'twitchdownloader', note: 'O chat da Twitch é baixado pelo TwitchDownloaderCLI e só existe se o canal manteve o chat ligado e o VOD ainda está no site.' };
  }
  if (meta.hasChatReplay) return { available: true, tool: 'ytdlp', note: 'O YouTube guarda o replay do chat desta live.' };
  const wasLive = ['was_live', 'post_live', 'is_live'].includes(meta.liveStatus);
  if (wasLive) return { available: null, tool: 'ytdlp', note: 'Foi uma transmissão ao vivo; o replay do chat só existe se o canal o manteve. Dá para tentar.' };
  return { available: false, tool: 'ytdlp', note: 'Este vídeo não foi uma transmissão ao vivo, então não tem chat para baixar.' };
}

/** Texto curto de impedimentos/avisos do vídeo (não do download). */
function videoWarnings(meta) {
  const out = [];
  if (meta.liveStatus === 'is_live') out.push({ level: 'block', code: 'LIVE_NOW', message: 'Esta transmissão ainda está no ar. Espere ela terminar e use o link do vídeo gravado (replay).' });
  else if (meta.liveStatus === 'is_upcoming') out.push({ level: 'block', code: 'LIVE_UPCOMING', message: 'Esta transmissão ainda não começou. Volte quando ela terminar.' });
  else if (meta.liveStatus === 'post_live') out.push({ level: 'warn', code: 'POST_LIVE', message: 'A live acabou de terminar e o YouTube ainda está processando o vídeo; as qualidades mais altas podem demorar a aparecer.' });
  if (['needs_auth', 'subscriber_only', 'premium_only', 'private'].includes(meta.availability)) {
    out.push({ level: 'warn', code: 'RESTRICTED', message: 'Este vídeo tem acesso restrito (depende da sua conta). O download só funciona se a conta usada tiver acesso; veja "Avançado".' });
  }
  return out;
}

module.exports = {
  BROWSERS, PROGRESS_PREFIX, POST_PREFIX, OUTDATED_DAYS, versionAgeDays, isOutdated,
  ytdlpEnv, withTempDir, commonArgs, metadataArgs, formatSelection, downloadArgs, liveChatArgs,
  parseOutputLine, normalizeMetadata, buildQualities, chatAvailability, videoWarnings, uploadDateOf, gameFromChapters
};

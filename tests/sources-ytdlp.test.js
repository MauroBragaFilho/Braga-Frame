'use strict';

/**
 * Fontes: links, metadados do yt-dlp, qualidades, argumentos, linhas de progresso, mapeamento de erros (com saídas
 * REAIS do yt-dlp 2026.08.19 guardadas em tests/sources-fixtures/ytdlp-errors), nomes de arquivo e configurações.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseVodUrl } = require('../src/core/sources/urls');
const yt = require('../src/core/sources/ytdlp');
const errors = require('../src/core/sources/ytdlpErrors');
const { vodFileBase, moveUnique, freeBytes, sumFiles } = require('../src/core/sources/naming');
const { ProgressTracker } = require('../src/core/sources/progress');
const { SettingsStore } = require('../src/core/sources/settingsStore');

const FIX = path.join(__dirname, 'sources-fixtures');
const json = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const stderrOf = (name) => fs.readFileSync(path.join(FIX, 'ytdlp-errors', `${name}.stderr.txt`), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bf-src-yt-'));
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });

// ------------------------------------------------------------------ links

test('parseVodUrl aceita as formas de link do YouTube e normaliza', () => {
  const id = 'jNQXAC9IVRw';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`, `youtube.com/watch?v=${id}&list=PL123&t=30s`, `https://m.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?si=abc`, `https://www.youtube.com/live/${id}?feature=share`, `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`, `  https://music.youtube.com/watch?v=${id}  `
  ]) {
    assert.deepEqual(parseVodUrl(url), { platform: 'youtube', videoId: id, url: `https://www.youtube.com/watch?v=${id}` }, url);
  }
});

test('parseVodUrl aceita VODs da Twitch e recusa clipes, canais e playlists com explicação', () => {
  for (const url of ['https://www.twitch.tv/videos/2345678901', 'twitch.tv/videos/2345678901?t=1h2m', 'https://m.twitch.tv/videos/2345678901', 'https://www.twitch.tv/canal/v/2345678901', 'https://www.twitch.tv/canal/video/2345678901']) {
    assert.deepEqual(parseVodUrl(url), { platform: 'twitch', videoId: '2345678901', url: 'https://www.twitch.tv/videos/2345678901' }, url);
  }
  assert.throws(() => parseVodUrl('https://www.twitch.tv/canal/clip/AbCdEf'), (e) => e.code === 'UNSUPPORTED_URL' && /Clipes da Twitch/.test(e.message));
  assert.throws(() => parseVodUrl('https://www.twitch.tv/canal'), (e) => e.code === 'UNSUPPORTED_URL' && /VOD/.test(e.message));
  assert.throws(() => parseVodUrl('https://www.twitch.tv/videos/abc'), (e) => e.code === 'INVALID_URL');
  assert.throws(() => parseVodUrl('https://www.youtube.com/playlist?list=PL1'), (e) => e.code === 'UNSUPPORTED_URL' && /playlist/.test(e.message));
  assert.throws(() => parseVodUrl('https://www.youtube.com/@canal'), (e) => e.code === 'UNSUPPORTED_URL');
  assert.throws(() => parseVodUrl('https://www.youtube.com/watch?v=curto'), (e) => e.code === 'INVALID_URL');
  assert.throws(() => parseVodUrl('https://vimeo.com/123'), (e) => e.code === 'UNSUPPORTED_URL' && /YouTube e da Twitch/.test(e.message));
});

test('parseVodUrl recusa entradas perigosas ou sem sentido (nunca vira opção do yt-dlp)', () => {
  for (const bad of ['', '   ', null, undefined, 42, '--exec calc', '-o x', 'ftp://youtube.com/watch?v=jNQXAC9IVRw', 'file:///C:/x.mp4', `https://${'a'.repeat(3000)}.com`, 'https://user:senha@www.youtube.com/watch?v=jNQXAC9IVRw']) {
    assert.throws(() => parseVodUrl(bad), (e) => /INVALID_URL|UNSUPPORTED_URL/.test(e.code), String(bad).slice(0, 30));
  }
});

// ------------------------------------------------------------------ metadados

test('normalizeMetadata e qualidades com o JSON REAL do yt-dlp (vídeo público "Me at the zoo")', () => {
  const info = json('ytdlp-youtube-zoo.json');
  const parsed = parseVodUrl('https://youtu.be/jNQXAC9IVRw');
  const meta = yt.normalizeMetadata(info, { ...parsed, now: Date.parse('2026-10-21T12:00:00Z') });
  assert.equal(meta.title, 'Me at the zoo');
  assert.equal(meta.channel, 'jawed');
  assert.equal(meta.duration, 19);
  assert.equal(meta.uploadDate, '2005-04-24');
  assert.equal(meta.game, '', 'a categoria "Film & Animation" não vira jogo');
  assert.deepEqual(meta.categories, ['Film & Animation']);
  assert.equal(meta.liveStatus, 'not_live');
  assert.equal(meta.isLive, false);
  assert.equal(meta.availability, 'public');
  assert.equal(meta.hasChatReplay, false);
  assert.equal(meta.fetchedAt, '2026-10-21T12:00:00.000Z');
  assert.equal(meta.url, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  assert.deepEqual(yt.videoWarnings(meta), []);
  assert.equal(yt.chatAvailability(meta).available, false, 'não foi uma live: não há chat');

  const q = yt.buildQualities(info);
  assert.deepEqual(q.map((x) => x.id), ['best', 'h144'], 'o vídeo só existe em 144p e 240p');
  assert.equal(q[0].label, 'Melhor disponível (240p)');
  assert.equal(q[0].height, null);
  assert.equal(q[1].height, 144);
  assert.ok(q[0].estBytes > 300000, 'vídeo + melhor áudio conhecido');
});

test('metadados da Twitch: jogo pelos capítulos (o que mais tempo ocupou), canal, formatos combinados', () => {
  const info = json('ytdlp-twitch-vod.json');
  const parsed = parseVodUrl('https://www.twitch.tv/videos/2345678901');
  const meta = yt.normalizeMetadata(info, { ...parsed, now: 0 });
  assert.equal(meta.channel, 'Canal de Teste');
  assert.equal(meta.game, 'Minecraft');
  assert.deepEqual(meta.games, ['Minecraft', 'Just Chatting']);
  assert.equal(meta.uploadDate, '2026-10-20');
  assert.equal(meta.duration, 7200);
  assert.equal(yt.chatAvailability(meta).available, null, 'Twitch: só dá para saber tentando');
  assert.equal(yt.chatAvailability(meta).tool, 'twitchdownloader');

  const q = yt.buildQualities(info);
  assert.deepEqual(q.map((x) => x.label), ['Melhor disponível (1080p60)', '720p60', '480p', '360p', '160p']);
  assert.deepEqual(q.map((x) => x.id), ['best', 'h720', 'h480', 'h360', 'h160']);
  // formato combinado (já tem áudio): estimativa = taxa × duração, sem somar áudio de novo
  assert.equal(q[0].estBytes, Math.round(6000 * 125 * 7200));
});

test('metadados: jogo explícito, lives, replay de chat e restrições de acesso', () => {
  const base = { id: 'x', title: 'T', formats: [] };
  const yto = (extra) => yt.normalizeMetadata({ ...base, ...extra }, { platform: 'youtube', videoId: 'x', url: 'u', now: 0 });
  assert.equal(yto({ game: 'Hades' }).game, 'Hades');
  assert.equal(yto({ upload_date: undefined, timestamp: 1792526400 }).uploadDate, '2026-10-20');
  assert.equal(yto({}).uploadDate, '');
  assert.equal(yto({ title: '   ' }).title, 'Vídeo x');
  assert.equal(yto({ channel: '', uploader: 'U' }).channel, 'U');

  const live = yto({ live_status: 'is_live' });
  assert.equal(live.isLive, true);
  assert.equal(yt.videoWarnings(live)[0].level, 'block');
  assert.match(yt.videoWarnings(live)[0].message, /ainda está no ar/);
  assert.equal(yt.videoWarnings(yto({ live_status: 'is_upcoming' }))[0].code, 'LIVE_UPCOMING');
  assert.equal(yt.videoWarnings(yto({ live_status: 'post_live' }))[0].level, 'warn');
  assert.equal(yt.videoWarnings(yto({ availability: 'subscriber_only' }))[0].code, 'RESTRICTED');

  const replay = yto({ live_status: 'was_live', subtitles: { live_chat: [{ ext: 'json' }] } });
  assert.equal(replay.hasChatReplay, true);
  assert.equal(yt.chatAvailability(replay).available, true);
  assert.equal(yt.chatAvailability(yto({ live_status: 'was_live' })).available, null, 'foi live, mas o replay do chat não está listado');
  assert.throws(() => yt.normalizeMetadata(null, {}), /vazia/);
});

test('buildQualities sem vídeo, com áudio separado e com fps alto', () => {
  assert.deepEqual(yt.buildQualities({ formats: [] }), []);
  assert.deepEqual(yt.buildQualities({}), []);
  assert.deepEqual(yt.buildQualities({ formats: [{ format_id: 'a', vcodec: 'none', acodec: 'opus' }] }), []);
  const q = yt.buildQualities({
    duration: 100,
    formats: [
      { format_id: '137', vcodec: 'avc1', acodec: 'none', height: 1080, fps: 60, filesize: 1000 },
      { format_id: '137b', vcodec: 'vp9', acodec: 'none', height: 1080, fps: 30, filesize: 5000 },
      { format_id: '22', vcodec: 'avc1', acodec: 'mp4a', height: 720, fps: 30, filesize: 300 },
      { format_id: '140', vcodec: 'none', acodec: 'mp4a', filesize: 70 },
      { format_id: '251', vcodec: 'none', acodec: 'opus', filesize_approx: 90 }
    ]
  });
  assert.equal(q[0].label, 'Melhor disponível (1080p60)');
  assert.equal(q[0].estBytes, 5000 + 90, 'maior vídeo da altura + melhor áudio separado');
  assert.equal(q[1].label, '720p');
  assert.equal(q[1].estBytes, 300, 'formato com áudio embutido não soma áudio');
});

// ------------------------------------------------------------------ argumentos

test('commonArgs: ignora a configuração pessoal, não baixa playlist e só liga o que foi pedido', () => {
  const plain = yt.commonArgs({});
  assert.deepEqual(plain, ['--ignore-config', '--no-playlist', '--socket-timeout', '30', '--no-mtime']);
  const full = yt.commonArgs({ ffmpegPath: 'C:\\ff\\bin\\ffmpeg.exe', denoPath: 'C:\\t\\deno.exe', cacheDir: 'C:\\c', cookiesBrowser: 'firefox' });
  assert.equal(full[full.indexOf('--ffmpeg-location') + 1], 'C:\\ff\\bin');
  assert.equal(full[full.indexOf('--js-runtimes') + 1], 'deno:C:\\t\\deno.exe');
  assert.equal(full[full.indexOf('--cache-dir') + 1], 'C:\\c');
  assert.equal(full[full.indexOf('--cookies-from-browser') + 1], 'firefox');
  assert.ok(!yt.commonArgs({ cookiesBrowser: 'netscape-navigator' }).includes('--cookies-from-browser'), 'navegador desconhecido é ignorado');
  assert.ok(!yt.commonArgs({ cookiesBrowser: '' }).includes('--cookies-from-browser'));
});

test('a URL vai sempre depois de "--" e o yt-dlp nunca recebe a URL como opção', () => {
  const evil = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  const meta = yt.metadataArgs(evil, ['--ignore-config']);
  assert.deepEqual(meta.slice(-3), ['-J', '--', evil]);
  const dl = yt.downloadArgs({ url: evil, common: ['--ignore-config'], quality: 'best', workDir: 'C:\\w' });
  assert.deepEqual(dl.slice(-2), ['--', evil]);
  const chat = yt.liveChatArgs({ url: evil, common: [], outDir: 'C:\\o' });
  assert.deepEqual(chat.slice(-2), ['--', evil]);
  assert.ok(chat.includes('--skip-download') && chat.includes('--write-subs'));
  assert.equal(chat[chat.indexOf('--sub-langs') + 1], 'live_chat');
});

test('formatSelection: tampa de altura, H.264 quando a resolução empata, "melhor" sem tampa', () => {
  assert.deepEqual(yt.formatSelection('best'), { format: 'bv*+ba/b', sort: 'res,fps,vcodec:h264,acodec:aac' });
  assert.equal(yt.formatSelection({ height: 720 }).format, 'bv*[height<=720]+ba/b[height<=720]');
  assert.equal(yt.formatSelection({ height: 0 }).format, 'bv*+ba/b');
  assert.equal(yt.formatSelection(undefined).format, 'bv*+ba/b');
  const dl = yt.downloadArgs({ url: 'u', common: [], quality: { height: 480 }, workDir: 'C:\\w' });
  assert.equal(dl[dl.indexOf('-f') + 1], 'bv*[height<=480]+ba/b[height<=480]');
  assert.equal(dl[dl.indexOf('-o') + 1], path.join('C:\\w', 'video.%(ext)s'));
  assert.ok(dl.includes('--continue') && dl.includes('--newline'));
  assert.equal(dl[dl.indexOf('--merge-output-format') + 1], 'mp4');
});

// ------------------------------------------------------------------ saída do yt-dlp

test('parseOutputLine: progresso, pós-processamento, plano de formatos e destino (formato real)', () => {
  const p = yt.parseOutputLine('BFP|downloading|3072|1501237|NA|1537210.9|0|NA|NA|mp4');
  assert.deepEqual(p, { type: 'progress', status: 'downloading', downloaded: 3072, total: 1501237, totalEstimate: null, speed: 1537210.9, eta: 0, fragIndex: null, fragCount: null, formatId: 'mp4' });
  const frag = yt.parseOutputLine('BFP|downloading|1048576|NA|52428800|2097152.5|20|3|50|1080p60');
  assert.equal(frag.total, null);
  assert.equal(frag.totalEstimate, 52428800);
  assert.equal(frag.fragIndex, 3);
  assert.equal(frag.fragCount, 50);
  assert.equal(frag.formatId, '1080p60');
  assert.deepEqual(yt.parseOutputLine('BFPP|started|VideoRemuxer'), { type: 'post', status: 'started', name: 'VideoRemuxer' });
  assert.deepEqual(yt.parseOutputLine('[info] clip: Downloading 2 format(s): 399+251'), { type: 'plan', formats: ['399', '251'] });
  assert.deepEqual(yt.parseOutputLine('[info] x: Downloading 1 format(s): 1080p60'), { type: 'plan', formats: ['1080p60'] });
  assert.deepEqual(yt.parseOutputLine('[download] Destination: C:\\w\\video.f399.mp4'), { type: 'destination', file: 'C:\\w\\video.f399.mp4' });
  assert.deepEqual(yt.parseOutputLine('[download] C:\\w\\video.mp4 has already been downloaded'), { type: 'already', file: 'C:\\w\\video.mp4' });
  assert.equal(yt.parseOutputLine('[youtube] Extracting URL: x'), null);
  assert.equal(yt.parseOutputLine(''), null);
});

test('ProgressTracker junta vídeo e áudio em um só percentual que nunca recua', () => {
  const t = new ProgressTracker({ sizeByFormat: new Map([['399', 800], ['251', 200]]) });
  t.feed(yt.parseOutputLine('[info] x: Downloading 2 format(s): 399+251'));
  assert.equal(t.snapshot().percent, 0, 'nada baixado, mas o total já é conhecido pelos metadados');
  let s = t.feed(yt.parseOutputLine('BFP|downloading|400|800|NA|100|4|NA|NA|399'));
  assert.equal(s.total, 1000, 'inclui o áudio que ainda não começou, pelo tamanho dos metadados');
  assert.equal(s.percent, 40);
  assert.equal(s.eta, 6);
  t.feed(yt.parseOutputLine('BFP|finished|800|800|NA|100|NA|NA|NA|399'));
  s = t.feed(yt.parseOutputLine('BFP|downloading|50|200|NA|50|3|NA|NA|251'));
  assert.equal(s.percent, 85);
  s = t.feed(yt.parseOutputLine('BFP|finished|200|200|NA|50|NA|NA|NA|251'));
  assert.equal(s.percent, 99.9, 'só chega a 100 quando tudo termina (junção)');
  s = t.feed(yt.parseOutputLine('BFPP|started|Merger'));
  assert.equal(s.phase, 'merge');
  // estimativa que encolhe não faz a barra andar para trás
  const t2 = new ProgressTracker();
  t2.feed({ type: 'progress', status: 'downloading', downloaded: 500, total: null, totalEstimate: 1000, speed: 10, formatId: 'a' });
  const before = t2.snapshot().percent;
  const after = t2.feed({ type: 'progress', status: 'downloading', downloaded: 520, total: null, totalEstimate: 5000, speed: 10, formatId: 'a' }).percent;
  assert.equal(before, 50);
  assert.ok(after >= before);
});

test('ProgressTracker sem nenhum tamanho conhecido deixa o percentual vazio (barra indeterminada)', () => {
  const t = new ProgressTracker();
  const s = t.feed({ type: 'progress', status: 'downloading', downloaded: 12345, total: null, totalEstimate: null, speed: 1000, formatId: 'x' });
  assert.equal(s.percent, null);
  assert.equal(s.total, null);
  assert.equal(s.downloaded, 12345);
  // dois arquivos no plano e um tamanho que ninguém sabe: também sem percentual
  const t2 = new ProgressTracker();
  t2.feed({ type: 'plan', formats: ['1', '2'] });
  assert.equal(t2.feed({ type: 'progress', status: 'downloading', downloaded: 10, total: 100, formatId: '1' }).percent, null);
});

// ------------------------------------------------------------------ erros

test('erros REAIS do yt-dlp (guardados em fixtures) viram mensagens em português com causa e solução', () => {
  const missing = errors.mapYtdlpError(stderrOf('yt-missing'), { platform: 'youtube' });
  assert.equal(missing.code, 'UNAVAILABLE');
  assert.match(missing.cause, /removido|indisponível/);
  assert.match(missing.solution, /Confira o link/);
  assert.equal(missing.dependsOnAccess, true);
  assert.equal(missing.message, `${missing.cause} ${missing.solution}`);
  assert.match(missing.raw, /This video is unavailable/);

  const tw = errors.mapYtdlpError(stderrOf('twitch-missing'), { platform: 'twitch' });
  assert.equal(tw.code, 'UNAVAILABLE');
  assert.match(tw.cause, /Twitch apaga VODs/);

  const dns = errors.mapYtdlpError(stderrOf('dns-fail'), { platform: 'youtube' });
  assert.equal(dns.code, 'NETWORK');
  assert.equal(dns.retryable, true);
  assert.equal(dns.dependsOnAccess, false);
  assert.match(dns.message, /Sem conexão/);

  const proxy = errors.mapYtdlpError(stderrOf('proxy-down'), { platform: 'youtube' });
  assert.equal(proxy.code, 'NETWORK', 'as linhas WARNING de nova tentativa não confundem o diagnóstico');
  assert.ok(!/fulano/.test(proxy.raw) && proxy.raw.length <= 290);

  const edge = errors.mapYtdlpError(stderrOf('edge-cookie'), { platform: 'youtube', usedCookies: true });
  assert.equal(edge.code, 'COOKIES_BROWSER');
  assert.match(edge.solution, /Feche o navegador|outro/);
  assert.ok(!/fulano|C:\\Users/.test(edge.raw), 'sem caminhos do computador');

  const bad = errors.mapYtdlpError(stderrOf('browser-cookie'), { platform: 'youtube' });
  assert.equal(bad.code, 'COOKIES_BROWSER');
  assert.match(bad.cause, /não é suportado/);

  const unsupported = errors.mapYtdlpError(stderrOf('unsupported'), { platform: 'youtube' });
  assert.equal(unsupported.code, 'UNAVAILABLE', 'HTTP 404 do site');
});

test('mapYtdlpError: privado, membros, inscritos, idade, região, bot, live, runtime JS e demais casos', () => {
  const map = (text, ctx = {}) => errors.mapYtdlpError(`ERROR: [youtube] abc: ${text}`, { platform: 'youtube', ...ctx });
  const cases = [
    ['Private video. Sign in if you\'ve been granted access to this video', 'PRIVATE'],
    ['Join this channel to get access to members-only content like this video, and other exclusive perks.', 'MEMBERS_ONLY'],
    ['Sign in to confirm your age. This video may be inappropriate for some users.', 'AGE_RESTRICTED'],
    ['Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.', 'BOT_CHECK'],
    ['Sign in to confirm you\'re not a bot', 'BOT_CHECK'],
    ['The uploader has not made this video available in your country', 'GEO_BLOCKED'],
    ['This video is not available in your country', 'GEO_BLOCKED'],
    ['This live event will begin in 3 hours.', 'NOT_STARTED'],
    ['Premieres in 5 minutes', 'NOT_STARTED'],
    ['Video unavailable. This video has been removed by the uploader', 'UNAVAILABLE'],
    ['n challenge solving failed: Some formats may be missing. Ensure you have a supported JavaScript runtime', 'NO_JS_RUNTIME'],
    ['Requested format is not available. Use --list-formats for a list of available formats', 'NO_FORMAT'],
    ['No video formats found!; please report this issue', 'NO_FORMAT'],
    ['Unsupported URL: https://example.com/x', 'UNSUPPORTED_URL'],
    ['unable to download video data: HTTP Error 403: Forbidden', 'FORBIDDEN'],
    ['HTTP Error 429: Too Many Requests', 'RATE_LIMITED'],
    ['[Errno 28] No space left on device', 'DISK_FULL'],
    ['[Errno 13] Permission denied: \'C:\\x\\video.mp4.part\'', 'PERMISSION'],
    ['ffprobe and ffmpeg not found. Please install or provide the path using --ffmpeg-location', 'NO_FFMPEG'],
    ['Postprocessing: Conversion failed!', 'MERGE_FAILED'],
    ['[WinError 206] The filename or extension is too long', 'PATH_TOO_LONG'],
    ['Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>', 'NETWORK'],
    ['Read timed out.', 'NETWORK'],
    ['HTTP Error 401: Unauthorized', 'LOGIN_REQUIRED']
  ];
  for (const [text, code] of cases) {
    const r = map(text);
    assert.equal(r.code, code, `${text} -> ${r.code}`);
    assert.ok(r.cause && r.solution, `${code} precisa de causa e solução`);
    assert.ok(/[À-ÿa-z]/i.test(r.message) && !/[A-Z]{2,}:/.test(r.cause), 'mensagem em português, não o texto cru');
  }
  // o que depende da fonte é dito como tal; o que é do computador não
  assert.equal(map('Private video').dependsOnAccess, true);
  assert.equal(map('No space left on device').dependsOnAccess, false);
  // Twitch: assinantes
  assert.equal(map('This video is only available for subscribers', { platform: 'twitch' }).code, 'SUBSCRIBERS_ONLY');
  assert.match(map('This video is only available for subscribers', { platform: 'twitch' }).cause, /inscritos \(subs\) do canal/);
  // cookies já ligados mudam a solução (não manda ligar de novo)
  assert.match(map('Sign in to confirm you’re not a bot', { usedCookies: false }).solution, /Avançado/);
  assert.doesNotMatch(map('Sign in to confirm you’re not a bot', { usedCookies: true }).solution, /ligue/);
  // formato indisponível no YouTube sem runtime JS aponta o Deno
  assert.match(map('Requested format is not available', { hasJsRuntime: false }).solution, /Deno/);
  assert.doesNotMatch(map('Requested format is not available', { hasJsRuntime: true }).solution, /Deno/);
});

test('mapYtdlpError: erro desconhecido, sem ERROR e com caminhos locais', () => {
  const unknown = errors.mapYtdlpError('ERROR: [youtube] x: Algo muito esquisito em C:\\Users\\fulano\\AppData\\yt\\cache aconteceu', { exitCode: 1 });
  assert.equal(unknown.code, 'YTDLP_FAILED');
  assert.match(unknown.message, /Detalhe:/);
  assert.ok(!/fulano/.test(unknown.message), 'sem o nome do usuário do Windows');
  assert.match(unknown.message, /<caminho>/);
  const silent = errors.mapYtdlpError('', { exitCode: 7 });
  assert.equal(silent.code, 'YTDLP_FAILED');
  assert.match(silent.cause, /sem dizer o motivo/);
  assert.match(silent.cause, /código 7/);
  const long = errors.mapYtdlpError(`ERROR: ${'x'.repeat(2000)}`, {});
  assert.ok(long.raw.length <= 290);
});

test('mapTwitchDownloaderError com a saída REAL do programa para um VOD que não existe', () => {
  const real = 'Unhandled exception. System.AggregateException: One or more errors occurred. (Invalid VOD, deleted/expired VOD possibly?)\n ---> System.NullReferenceException: Invalid VOD, deleted/expired VOD possibly?\n   at TwitchDownloaderCore.ChatDownloader.InitChatRoot(DownloadType downloadType) in /home/runner/work/x.cs:line 375';
  const r = errors.mapTwitchDownloaderError(real, 127);
  assert.equal(r.code, 'CHAT_VOD_GONE');
  assert.equal(r.dependsOnAccess, true);
  assert.match(r.message, /apagado ou expirado/);
  assert.match(r.message, /VODs que ainda existem/);
  assert.match(r.raw, /Invalid VOD/);
  assert.equal(errors.mapTwitchDownloaderError('Unable to connect to the remote server', 1).code, 'NETWORK');
  assert.equal(errors.mapTwitchDownloaderError('HTTP 403 Forbidden', 1).code, 'FORBIDDEN');
  assert.equal(errors.mapTwitchDownloaderError('No space left on device', 1).code, 'DISK_FULL');
  const other = errors.mapTwitchDownloaderError('algo inesperado', 3);
  assert.equal(other.code, 'CHAT_FAILED');
  assert.equal(other.retryable, true);
});

test('warningsFromStderr: Deno ausente e verificação extra do YouTube viram avisos que não impedem', () => {
  const noJs = 'WARNING: [youtube] No supported JavaScript runtime could be found. Only deno is enabled by default';
  assert.deepEqual(errors.warningsFromStderr(noJs, { platform: 'youtube', hasJsRuntime: false }).map((w) => w.code), ['NO_JS_RUNTIME']);
  assert.deepEqual(errors.warningsFromStderr(noJs, { platform: 'youtube', hasJsRuntime: true }), [], 'com Deno o aviso não se aplica');
  assert.deepEqual(errors.warningsFromStderr(noJs, { platform: 'twitch', hasJsRuntime: false }), [], 'Twitch não precisa de Deno');
  assert.match(errors.warningsFromStderr(noJs, { platform: 'youtube', hasJsRuntime: false })[0].message, /Instale o Deno na aba Ferramentas/);
  assert.deepEqual(errors.warningsFromStderr('WARNING: mweb client https formats require a GVS PO Token', { platform: 'youtube' }).map((w) => w.code), ['PO_TOKEN']);
  assert.deepEqual(errors.warningsFromStderr('', {}), []);
});

// ------------------------------------------------------------------ nomes e disco

test('vodFileBase: só o título da transmissão (sem o código do vídeo), seguro no Windows e sem estourar o caminho', () => {
  assert.equal(vodFileBase({ title: 'Live: "teste" <1>/2 | ação?', id: 'abc123', dir: 'C:\\V' }), 'Live teste 1 2 ação', 'o id do YouTube não entra no nome');
  assert.equal(vodFileBase({ title: '  ...  ', dir: 'C:\\V' }), 'video');
  assert.equal(vodFileBase({ title: 'CON', dir: 'C:\\V' }), '_CON');
  assert.equal(vodFileBase({ title: 'Título com ponto final...', dir: 'C:\\V' }), 'Título com ponto final');
  assert.equal(vodFileBase({ title: 'a\u200bb\u202ec', dir: 'C:\\V' }), 'abc', 'marcas invisíveis saem');
  const longDir = 'C:\\Users\\alguem\\Videos\\Braga Frame\\Pasta comprida\\Outra pasta\\Mais uma';
  const base = vodFileBase({ title: 'x'.repeat(500), id: 'jNQXAC9IVRw', dir: longDir });
  assert.ok(longDir.length + 1 + base.length + ' (999).mp4'.length <= 260, `caminho de ${longDir.length + 1 + base.length} caracteres`);
  assert.equal(base.includes('jNQXAC9IVRw'), false);
  assert.equal(Array.from(vodFileBase({ title: '😀'.repeat(300), id: 'x', dir: 'C:\\V' })).filter((c) => c === '😀').length > 10, true, 'corta por caractere, sem partir um emoji ao meio');
});

test('moveUnique nunca sobrescreve: usa "(2)", "(3)"…, mesmo com o nome já tomado', async () => {
  const dir = tmp();
  try {
    const src = (n, text) => { const f = path.join(dir, 'work', `v${n}.mp4`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
    const out = path.join(dir, 'saida');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'Vídeo [x].mp4'), 'DO USUÁRIO');
    const a = await moveUnique(src(1, 'primeiro'), out, 'Vídeo [x]', '.mp4');
    const b = await moveUnique(src(2, 'segundo'), out, 'Vídeo [x]', '.mp4');
    const c = await moveUnique(src(3, 'terceiro'), out, 'Outro [y]', '.mp4');
    assert.equal(path.basename(a), 'Vídeo [x] (2).mp4');
    assert.equal(path.basename(b), 'Vídeo [x] (3).mp4');
    assert.equal(path.basename(c), 'Outro [y].mp4');
    assert.equal(fs.readFileSync(path.join(out, 'Vídeo [x].mp4'), 'utf8'), 'DO USUÁRIO', 'o arquivo do usuário continua intacto');
    assert.equal(fs.readFileSync(a, 'utf8'), 'primeiro');
    assert.equal(fs.readFileSync(b, 'utf8'), 'segundo');
    assert.ok(!fs.existsSync(path.join(dir, 'work', 'v1.mp4')), 'a origem foi movida, não copiada');
    // pasta de destino que ainda não existe é criada
    const d = await moveUnique(src(4, 'quarto'), path.join(dir, 'nova', 'sub'), 'Z', '.mp4');
    assert.equal(fs.readFileSync(d, 'utf8'), 'quarto');
  } finally { rm(dir); }
});

/** Segura `file` aberto SEM permitir apagar/renomear (como antivírus, indexador e OneDrive fazem com arquivos recém-gravados). */
async function lockFile(file) {
  const { spawn } = require('node:child_process');
  const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `$f = [System.IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); Write-Output locked; Start-Sleep -Seconds 60`], { windowsHide: true });
  await new Promise((resolve, reject) => {
    ps.stdout.once('data', resolve);
    ps.once('error', reject);
    ps.once('exit', () => reject(new Error('o PowerShell saiu antes de segurar o arquivo')));
  });
  return async () => {
    ps.removeAllListeners('exit');
    ps.kill();
    await new Promise((resolve) => setTimeout(resolve, 600)); // o Windows solta o arquivo quando o processo termina
  };
}

test('moveUnique: original preso por outro programa (EBUSY) não vira erro nem deixa uma segunda cópia ("(2)") para trás', { skip: process.platform === 'win32' ? false : 'a trava de arquivo sem compartilhar exclusão é do Windows' }, async () => {
  const dir = tmp();
  let unlock = null;
  try {
    const work = path.join(dir, 'work');
    const out = path.join(dir, 'saida');
    fs.mkdirSync(work);
    fs.mkdirSync(out);
    const src = path.join(work, 'video.mp4');
    const body = Buffer.alloc(200000, 7);
    fs.writeFileSync(src, body);
    unlock = await lockFile(src);

    // antes: lançava EBUSY (o app mostrava MOVE_FAILED) com 'Video [abc].mp4' já completo na pasta; nova tentativa gerava "(2)"
    const dest = await moveUnique(src, out, 'Video [abc]', '.mp4');
    assert.equal(path.basename(dest), 'Video [abc].mp4');
    assert.deepEqual(fs.readdirSync(out), ['Video [abc].mp4'], 'um só arquivo final');
    assert.ok(fs.readFileSync(dest).equals(body), 'o arquivo final está inteiro');
    assert.ok(fs.existsSync(src), 'o original preso fica na pasta de trabalho para ser apagada depois');

    // nome já tomado pelo usuário + original preso: avança uma vez para "(2)" e para por aí (um arquivo por tentativa, nenhum a mais)
    fs.writeFileSync(path.join(out, 'Outro [x].mp4'), 'DO USUÁRIO');
    const second = await moveUnique(src, out, 'Outro [x]', '.mp4');
    assert.equal(path.basename(second), 'Outro [x] (2).mp4');
    assert.deepEqual(fs.readdirSync(out).sort(), ['Outro [x] (2).mp4', 'Outro [x].mp4', 'Video [abc].mp4']);
    assert.equal(fs.readFileSync(path.join(out, 'Outro [x].mp4'), 'utf8'), 'DO USUÁRIO');

    // solto o arquivo, o resto some normalmente
    await unlock();
    unlock = null;
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    assert.ok(!fs.existsSync(work));
  } finally {
    if (unlock) await unlock();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});

test('freeBytes e sumFiles', async () => {
  const dir = tmp();
  try {
    const free = await freeBytes(path.join(dir, 'ainda', 'nao', 'existe'));
    assert.ok(free > 0, 'usa a primeira pasta existente acima');
    fs.writeFileSync(path.join(dir, 'a.part'), Buffer.alloc(100));
    fs.writeFileSync(path.join(dir, 'b.mp4'), Buffer.alloc(40));
    fs.mkdirSync(path.join(dir, 'c.part'));
    assert.equal(sumFiles(dir), 140);
    assert.equal(sumFiles(dir, (n) => n.includes('.part')), 100);
    assert.equal(sumFiles(path.join(dir, 'nao')), 0);
  } finally { rm(dir); }
});

// ------------------------------------------------------------------ configurações

test('SettingsStore: grava de forma atômica, valida e guarda o histórico de downloads', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'sources.json');
    const store = new SettingsStore(file);
    assert.deepEqual(store.get(), { obsFolder: null, downloadDir: null, cookiesBrowser: '', lastQuality: '' });
    store.set({ obsFolder: 'D:\\REC', cookiesBrowser: 'firefox' });
    store.set({ downloadDir: 'D:\\VODs' });
    store.recordDownload({ path: 'D:\\VODs\\a.mp4', origin: { type: 'vod', videoId: '1' }, chat: { path: 'c', count: 3 }, meta: { game: 'G' } });
    store.recordDownload({ path: 'd:\\vods\\A.MP4', origin: { type: 'vod', videoId: '1' }, chat: null, meta: {} });
    assert.deepEqual(fs.readdirSync(dir), ['sources.json'], 'sem .tmp');

    const again = new SettingsStore(file);
    assert.deepEqual(again.get(), { obsFolder: 'D:\\REC', downloadDir: 'D:\\VODs', cookiesBrowser: 'firefox', lastQuality: '' });
    assert.equal(again.data.downloads.length, 1, 'o mesmo arquivo (maiúsculas diferentes) não duplica no Windows');
    assert.equal(again.findDownload('D:\\VODs\\a.mp4').origin.videoId, '1');
    assert.equal(again.findDownload('D:\\VODs\\outro.mp4'), null);
    assert.equal(again.updateChat('D:\\VODs\\a.mp4', { path: 'novo' }), true);
    assert.equal(again.updateChat('D:\\VODs\\nada.mp4', { path: 'x' }), false);
    again.set({ obsFolder: null, cookiesBrowser: '' });
    assert.equal(new SettingsStore(file).get().obsFolder, null);
    assert.equal(new SettingsStore(file).data.downloads.length, 1, 'limpar configurações não apaga o histórico');
  } finally { rm(dir); }
});

test('SettingsStore: arquivo corrompido é guardado como .corrupt e recomeça vazio; navegador inválido é descartado', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'sources.json');
    fs.writeFileSync(file, '{ quebrado');
    const store = new SettingsStore(file);
    assert.deepEqual(store.get(), { obsFolder: null, downloadDir: null, cookiesBrowser: '', lastQuality: '' });
    assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('.corrupt')), 'o original não é apagado');
    fs.writeFileSync(file, JSON.stringify({ cookiesBrowser: 'navegador-fantasma', obsFolder: 5, downloads: [{ path: 'x' }, { nada: 1 }, 'lixo'] }));
    const clean = new SettingsStore(file);
    assert.equal(clean.get().cookiesBrowser, '');
    assert.equal(clean.get().obsFolder, null);
    assert.equal(clean.data.downloads.length, 1);
  } finally { rm(dir); }
});

// ------------------------------------------------------------------ yt-dlp antigo (causa comum de HTTP 403 no YouTube)
test('versionAgeDays lê a data da versão do yt-dlp e recusa o que não é versão', () => {
  const now = Date.UTC(2026, 9, 21); // 21/10/2026
  assert.equal(yt.versionAgeDays('2026.07.04', now), 109);
  assert.equal(yt.versionAgeDays('2026.08.19\n', now), 63);
  assert.equal(yt.versionAgeDays('2026.10.21', now), 0);
  assert.equal(yt.versionAgeDays('2027.01.01', now), 0, 'versão "do futuro" não dá idade negativa');
  assert.equal(yt.versionAgeDays('nightly', now), null);
  assert.equal(yt.versionAgeDays(null, now), null);
});

test('HTTP 403 com yt-dlp antigo aponta a causa provável e a solução (Ferramentas); sem isso mantém a mensagem geral', () => {
  const stderr = 'ERROR: unable to download video data: HTTP Error 403: Forbidden';
  const old = errors.mapYtdlpError(stderr, { platform: 'youtube', outdatedYtdlp: { version: '2026.07.04', ageDays: 109 } });
  assert.equal(old.code, 'FORBIDDEN');
  assert.match(old.cause, /desatualizado/);
  assert.match(old.cause, /2026\.07\.04/);
  assert.match(old.solution, /aba Ferramentas/);
  assert.equal(old.retryable, true);
  const plain = errors.mapYtdlpError(stderr, { platform: 'youtube' });
  assert.equal(plain.code, 'FORBIDDEN');
  assert.doesNotMatch(plain.cause, /desatualizado/);
});

test('isOutdated: a versão fixada pelo app nunca é "antiga"; só a mais velha que ela (ou muito velha)', () => {
  const now = Date.UTC(2026, 9, 21);
  assert.equal(yt.isOutdated('2026.08.19', '2026.08.19', now), false, 'a própria versão fixada (63 dias) não é antiga');
  assert.equal(yt.isOutdated('2026.09.30', '2026.08.19', now), false, 'mais nova que a fixada');
  assert.equal(yt.isOutdated('2026.07.04', '2026.08.19', now), true, 'mais velha que a fixada');
  assert.equal(yt.isOutdated('2026.05.01', null, now), true, 'sem versão fixada, passou de 120 dias');
  assert.equal(yt.isOutdated('2026.08.19', null, now), false);
  assert.equal(yt.isOutdated('nightly', '2026.08.19', now), false);
});

test('SettingsStore guarda a última qualidade e recusa valores inválidos', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'sources.json');
    const store = new SettingsStore(file);
    assert.equal(store.get().lastQuality, '');
    store.set({ lastQuality: 'h720' });
    assert.equal(new SettingsStore(file).get().lastQuality, 'h720', 'sobrevive a reabrir');
    store.set({ lastQuality: 'best' });
    assert.equal(store.get().lastQuality, 'best');
    store.set({ lastQuality: 'nada; rm -rf' });
    assert.equal(store.get().lastQuality, '', 'valor inválido é descartado');
  } finally { rm(dir); }
});

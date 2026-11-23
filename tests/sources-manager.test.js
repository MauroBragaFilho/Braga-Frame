'use strict';

/**
 * Fontes: o SourcesManager de ponta a ponta no processo principal, SEM o Electron.
 *
 *  A) yt-dlp REAL (o do PATH) contra um servidor HTTP local de verdade (extrator genérico do yt-dlp): metadados em UTF-8,
 *     download com progresso real, nomes únicos, cancelamento (sobra o .part, nenhum processo fica), retomada
 *     ("Resuming download at byte"), pasta de trabalho, ocupado/BUSY e uso das ferramentas.
 *  B) programas FALSOS (lançador .exe + script Node que imita a saída real do yt-dlp e do TwitchDownloaderCLI) para o que
 *     só existiria com YouTube/Twitch: erros reais da fonte, chat do YouTube e da Twitch, cookies, Deno, ffmpeg-location.
 *  Nada aqui depende de rede externa.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { locateTools, findTool } = require('../src/core/ffmpeg/locate');
const { SourcesManager } = require('../src/core/sources/SourcesManager');
const { parseVodUrl } = require('../src/core/sources/urls');
const { readChat } = require('../src/core/sources/chatFormat');
const fakes = require('./sources-fakes');

const FIX = path.join(__dirname, 'sources-fixtures');
const tools = locateTools();
const realYtdlp = findTool('yt-dlp', 'CORTE_YTDLP');
const skipMedia = !tools.ffmpeg || !tools.ffprobe ? 'ffmpeg/ffprobe não encontrados' : false;
const skipReal = skipMedia || (!realYtdlp ? 'yt-dlp não encontrado no PATH' : false);
const skipFake = skipMedia || fakes.fakeExeSkipReason();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (name = 'mgr') => fs.mkdtempSync(path.join(os.tmpdir(), `bf-src-${name}-`));
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function waitUntil(fn, ms = 15000, what = 'condição') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(40); }
  throw new Error(`Tempo esgotado esperando: ${what}`);
}

/** Processos cuja linha de comando cita `needle` (para provar que nada ficou rodando depois de cancelar). */
function processesMentioning(needle) {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle.replace(/'/g, "''")}') -and -not $_.CommandLine.Contains('Get-CimInstance') -and $_.ProcessId -ne ${process.pid} } | Select-Object -ExpandProperty ProcessId`;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((id) => Number(id) !== process.pid);
}

/** Cria um manager com pastas temporárias. `t` = ferramentas; `extra` = opções do construtor. */
function mkManager(root, t, extra = {}) {
  const paths = { userData: path.join(root, 'userData'), cache: path.join(root, 'cache'), downloads: path.join(root, 'userData', 'downloads') };
  for (const d of Object.values(paths)) fs.mkdirSync(d, { recursive: true });
  const events = [];
  const manager = new SourcesManager({
    paths,
    getTools: () => ({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, ...t }),
    findSystemDeno: () => null,
    videosDir: path.join(root, 'Videos'),
    recordingsOptions: { sampleMs: 200 },
    ...extra
  });
  manager.on('progress', (ev) => events.push(ev));
  return { manager, paths, events };
}

/** Parser permissivo: aceita o link do servidor local (o parser de verdade só aceita YouTube e Twitch). */
const localParse = (url) => {
  const u = new URL(url);
  return { platform: 'generic', videoId: path.basename(u.pathname, path.extname(u.pathname)).replace(/\W+/g, '') || 'x', url: u.toString() };
};

// =====================================================================================================
// A) yt-dlp real + servidor local
// =====================================================================================================

test('A: metadados do yt-dlp real em UTF-8 (título com acento, símbolo e japonês)', { skip: skipReal }, async () => {
  const root = tmp();
  const clip = path.join(root, 'clip.mp4');
  fakes.sampleVideo(tools.ffmpeg, clip, { seconds: 4 });
  const server = await fakes.startMediaServer(clip);
  try {
    const { manager } = mkManager(root, { ytdlp: realYtdlp }, { parseUrl: localParse });
    const page = await manager.fetchVod(server.url('/page'));
    assert.equal(page.meta.title, 'Ação ✓ 日本語 — teste', 'sem PYTHONIOENCODING o yt-dlp trocaria por "?"');
    assert.equal(page.fromCache, false);
    const again = await manager.fetchVod(server.url('/page'));
    assert.equal(again.fromCache, true, 'a segunda consulta vem do cache');
    const fresh = await manager.refreshMeta(server.url('/page'));
    assert.equal(fresh.fromCache, false);
    assert.equal(fresh.origin.type, 'vod');
    assert.equal(fresh.origin.title, 'Ação ✓ 日本語 — teste');
    assert.deepEqual(Object.keys(fresh.origin).sort(), ['channel', 'duration', 'fetchedAt', 'game', 'platform', 'title', 'type', 'uploadDate', 'url', 'videoId'].sort());
  } finally { await server.close(); rm(root); }
});

test('A: download real com progresso, nome único e nada sobrescrito; pasta de trabalho some', { skip: skipReal, timeout: 120000 }, async () => {
  const root = tmp();
  const clip = path.join(root, 'clip.mp4');
  fakes.sampleVideo(tools.ffmpeg, clip, { seconds: 8 });
  const server = await fakes.startMediaServer(clip, { rate: 600000 });
  try {
    const { manager, events } = mkManager(root, { ytdlp: realYtdlp }, { parseUrl: localParse });
    const dest = path.join(root, 'VODs');
    const url = server.url('/clip.mp4');

    const first = await manager.download({ url, dir: dest });
    assert.equal(path.dirname(first.path), dest);
    assert.equal(path.basename(first.path), 'clip.mp4');
    assert.equal(sha(first.path), sha(clip), 'o arquivo baixado é idêntico ao original');
    assert.equal(first.bytes, fs.statSync(clip).size);
    assert.equal(first.resumed, false);
    assert.equal(first.origin.type, 'vod');
    assert.deepEqual(fs.readdirSync(dest), ['clip.mp4'], 'nenhuma pasta .bf-vod nem .part sobra');

    // progresso real: bytes crescem, percentual nunca recua, termina em 100 e passa por "done"
    const mine = events.filter((e) => e.kind === 'download');
    const withBytes = mine.filter((e) => e.phase === 'download' && e.downloaded > 0);
    assert.ok(withBytes.length >= 2, `eventos de progresso: ${withBytes.length}`);
    for (let i = 1; i < withBytes.length; i++) assert.ok(withBytes[i].downloaded >= withBytes[i - 1].downloaded);
    const percents = mine.map((e) => e.percent).filter((p) => p !== null);
    for (let i = 1; i < percents.length; i++) assert.ok(percents[i] >= percents[i - 1], `percentual recuou: ${percents.join(',')}`);
    assert.equal(mine[mine.length - 1].phase, 'done');
    assert.equal(mine[mine.length - 1].percent, 100);
    assert.ok(withBytes.some((e) => e.speed > 0), 'velocidade informada');

    // segundo e terceiro download do mesmo vídeo: nomes únicos, o primeiro continua intacto
    const stat = fs.statSync(first.path);
    const second = await manager.download({ url, dir: dest });
    const third = await manager.download({ url, dir: dest });
    assert.equal(path.basename(second.path), 'clip (2).mp4');
    assert.equal(path.basename(third.path), 'clip (3).mp4');
    assert.equal(fs.statSync(first.path).mtimeMs, stat.mtimeMs);
    assert.equal(sha(first.path), sha(clip));
    assert.equal(fs.readdirSync(dest).length, 3);
    assert.equal(manager.job, null, 'nenhum trabalho fica pendurado');
    assert.deepEqual(manager.usage(), { ytdlp: null, twitchdownloader: null, deno: null });
  } finally { await server.close(); rm(root); }
});

test('A: cancelar para o yt-dlp (sem processo restante), guarda o .part; baixar de novo RETOMA do mesmo ponto', { skip: skipReal, timeout: 180000 }, async () => {
  const root = tmp('cancel');
  const clip = path.join(root, 'clip.mp4');
  fakes.sampleVideo(tools.ffmpeg, clip, { seconds: 10, size: '960x540' });
  const server = await fakes.startMediaServer(clip, { rate: 150000 });
  try {
    const { manager, events } = mkManager(root, { ytdlp: realYtdlp }, { parseUrl: localParse });
    const dest = path.join(root, 'VODs');
    const url = server.url('/clip.mp4');
    const info = manager.partialInfo({ url, dir: dest });
    assert.equal(info.bytes, 0);
    assert.equal(info.exists, false);

    const running = manager.download({ url, dir: dest });
    const outcome = running.then(() => null, (e) => e);
    await waitUntil(() => events.some((e) => e.phase === 'download' && e.downloaded > 120000), 30000, 'download começar de verdade');
    assert.deepEqual(manager.usage().ytdlp && 'em uso', 'em uso', 'enquanto baixa, a aba Ferramentas sabe que o yt-dlp está em uso');
    assert.equal(manager.cancel('outro-id'), false, 'id de outro trabalho não cancela este');
    assert.equal(manager.cancel(manager.job.id), true);
    const err = await outcome;
    assert.equal(err.code, 'CANCELLED');
    assert.match(err.message, /guardado e será retomado/);
    assert.equal(events[events.length - 1].phase, 'cancelled');
    assert.equal(manager.job, null);
    assert.equal(manager.usage().ytdlp, null);

    const after = manager.partialInfo({ url, dir: dest });
    assert.ok(after.bytes > 100000, `o .part ficou (${after.bytes} bytes)`);
    assert.deepEqual(fs.readdirSync(dest).filter((n) => !n.startsWith('.bf-vod-')), [], 'nada no destino além da pasta de trabalho');
    await sleep(500);
    assert.deepEqual(processesMentioning(path.basename(root)), [], 'nenhum yt-dlp/ffmpeg ficou rodando depois de cancelar');

    // retomar: o servidor vê um pedido com Range e o arquivo final é idêntico ao original
    const before = server.requests.length;
    server.setRate(0);
    const total = await manager.download({ url, dir: dest });
    assert.equal(total.resumed, true);
    const resumedEvent = events.filter((e) => e.kind === 'download' && e.resumed);
    assert.ok(resumedEvent.length > 0 && resumedEvent[0].resumeBytes >= after.bytes - 1);
    assert.match(resumedEvent.find((e) => e.phase === 'download').message, /Retomando o download/);
    assert.ok(server.requests.slice(before).some((r) => r.range && /^bytes=\d+-/.test(r.range)), 'pediu só o que faltava (Range)');
    assert.equal(sha(total.path), sha(clip), 'o vídeo retomado é idêntico ao original');
    assert.deepEqual(fs.readdirSync(dest), [path.basename(total.path)], 'pasta de trabalho removida no fim');
  } finally { await server.close(); rm(root); }
});

test('A: descartar o que foi baixado pela metade apaga só a pasta de trabalho; trabalho ocupado devolve BUSY', { skip: skipReal, timeout: 120000 }, async () => {
  const root = tmp('discard');
  const clip = path.join(root, 'clip.mp4');
  fakes.sampleVideo(tools.ffmpeg, clip, { seconds: 10, size: '960x540' });
  const server = await fakes.startMediaServer(clip, { rate: 150000 });
  try {
    const { manager, events } = mkManager(root, { ytdlp: realYtdlp }, { parseUrl: localParse });
    const dest = path.join(root, 'VODs');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'do-usuario.mp4'), 'não encosta');
    const url = server.url('/clip.mp4');

    const running = manager.download({ url, dir: dest }).catch((e) => e);
    await waitUntil(() => events.some((e) => e.phase === 'download' && e.downloaded > 50000), 30000, 'download começar');
    await assert.rejects(manager.download({ url, dir: dest }), (e) => e.code === 'BUSY' && /em andamento/.test(e.message));
    await assert.rejects(manager.downloadChat({ url }), (e) => e.code === 'BUSY');
    await assert.rejects(manager.discardPartial({ url, dir: dest }), (e) => e.code === 'BUSY');
    manager.cancel();
    assert.equal((await running).code, 'CANCELLED');

    const freed = await manager.discardPartial({ url, dir: dest });
    assert.ok(freed.freed > 0);
    assert.deepEqual(fs.readdirSync(dest), ['do-usuario.mp4'], 'o arquivo do usuário continua lá');
    assert.equal(fs.readFileSync(path.join(dest, 'do-usuario.mp4'), 'utf8'), 'não encosta');
    assert.deepEqual(await manager.discardPartial({ url, dir: dest }), { freed: 0 }, 'sem nada a descartar não é erro');
  } finally { await server.close(); rm(root); }
});

test('A: yt-dlp falhando de verdade (link local que não existe) vira mensagem em português', { skip: skipReal }, async () => {
  const root = tmp('err');
  const clip = path.join(root, 'clip.mp4');
  fakes.sampleVideo(tools.ffmpeg, clip, { seconds: 2 });
  const server = await fakes.startMediaServer(clip);
  try {
    const { manager } = mkManager(root, { ytdlp: realYtdlp }, { parseUrl: localParse });
    await assert.rejects(manager.fetchVod(server.url('/nao-existe.html')), (e) => {
      assert.ok(e.code === 'UNAVAILABLE' || e.code === 'YTDLP_FAILED', e.code);
      assert.ok(/[a-zç]/i.test(e.message) && e.details && e.details.solution, 'tem causa e solução');
      return true;
    });
    await server.close();
    await assert.rejects(manager.fetchVod('http://127.0.0.1:9/qualquer.mp4', { refresh: true }), (e) => e.code === 'NETWORK' && /Sem conexão/.test(e.message) && e.details.retryable === true);
  } finally { await server.close().catch(() => {}); rm(root); }
});

// =====================================================================================================
// B) programas falsos
// =====================================================================================================

const YT_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const TW_URL = 'https://www.twitch.tv/videos/2345678901';

/** Monta pasta com yt-dlp falso, TwitchDownloaderCLI falso e um vídeo de amostra. */
function mkFakeEnv(root) {
  const bin = path.join(root, 'bin');
  const ytdlp = fakes.makeFakeYtdlp(bin);
  const tdlDir = path.join(root, 'bin-tdl');
  const twitch = fakes.makeFakeTwitchDownloader(tdlDir);
  const sample = path.join(root, 'amostra.mp4');
  fakes.sampleVideo(tools.ffmpeg, sample, { seconds: 3 });
  const yt = (s) => fakes.fakeScenario(bin, { sampleFile: sample, steps: 6, stepMs: 60, ...s });
  const tw = (s) => fakes.fakeScenario(tdlDir, s);
  const calls = (dir) => {
    try { return fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  return { bin, tdlDir, ytdlp, twitch, sample, yt, tw, ytCalls: () => calls(bin), twCalls: () => calls(tdlDir) };
}

test('B: erros da fonte viram mensagens com causa, solução e "depende de acesso" quando é o caso', { skip: skipFake }, async () => {
  const root = tmp('b-err');
  try {
    const f = mkFakeEnv(root);
    process.env.BF_FAKE_NODE = process.execPath;
    const { manager } = mkManager(root, { ytdlp: f.ytdlp });
    const cases = [
      ['ERROR: [youtube] jNQXAC9IVRw: Private video. Sign in if you\'ve been granted access to this video', 'PRIVATE', true],
      ['ERROR: [youtube] jNQXAC9IVRw: Join this channel to get access to members-only content like this video', 'MEMBERS_ONLY', true],
      ['ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm your age. This video may be inappropriate for some users.', 'AGE_RESTRICTED', true],
      ['ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.', 'BOT_CHECK', true],
      ['ERROR: [youtube] jNQXAC9IVRw: The uploader has not made this video available in your country', 'GEO_BLOCKED', true],
      ['ERROR: [youtube] jNQXAC9IVRw: This video is unavailable', 'UNAVAILABLE', true],
      ['ERROR: [youtube] jNQXAC9IVRw: Unable to download webpage: Failed to resolve \'www.youtube.com\' ([Errno 11001] getaddrinfo failed)', 'NETWORK', false]
    ];
    for (const [stderr, code, access] of cases) {
      f.yt({ metaStderr: stderr, metaCode: 1 });
      await assert.rejects(manager.fetchVod(YT_URL, { refresh: true }), (e) => {
        assert.equal(e.code, code);
        assert.equal(e.details.dependsOnAccess, access, code);
        assert.ok(e.details.solution && e.message.includes(e.details.solution), 'a mensagem traz a solução');
        assert.ok(e.details.raw, 'trecho técnico para pedir ajuda');
        return true;
      });
    }
  } finally { rm(root); }
});

test('B: ferramentas ausentes explicam como resolver (yt-dlp, FFmpeg) e link inválido é recusado antes de rodar qualquer coisa', { skip: skipMedia }, async () => {
  const root = tmp('b-missing');
  try {
    const { manager } = mkManager(root, { ytdlp: null });
    await assert.rejects(manager.fetchVod(YT_URL), (e) => e.code === 'NO_YTDLP' && /aba Ferramentas/.test(e.message) && /SHA-256/.test(e.message));
    await assert.rejects(manager.download({ url: YT_URL }), (e) => e.code === 'NO_YTDLP');
    const noff = mkManager(root, { ytdlp: 'C:\\qualquer\\yt-dlp.exe', ffmpeg: null, ffprobe: null });
    await assert.rejects(noff.manager.download({ url: YT_URL }), (e) => e.code === 'NO_FFMPEG' && /Verificar de novo/.test(e.message));
    await assert.rejects(noff.manager.fetchVod('https://vimeo.com/1'), (e) => e.code === 'UNSUPPORTED_URL' && /YouTube e da Twitch/.test(e.message));
    await assert.rejects(noff.manager.fetchVod(''), (e) => e.code === 'INVALID_URL');
    await assert.rejects(noff.manager.downloadChat({ url: 'lixo' }), (e) => e.code === 'UNSUPPORTED_URL');
    const broken = mkManager(root, { ytdlp: path.join(root, 'nao-existe', 'yt-dlp.exe') });
    await assert.rejects(broken.manager.fetchVod(YT_URL), (e) => e.code === 'YTDLP_START_FAILED' && /Reinstale o yt-dlp/.test(e.message));
  } finally { rm(root); }
});

test('B: metadados da Twitch viram o origin do projeto (jogo e canal preenchidos) e a live no ar é bloqueada', { skip: skipFake }, async () => {
  const root = tmp('b-meta');
  try {
    const f = mkFakeEnv(root);
    process.env.BF_FAKE_NODE = process.execPath;
    const { manager } = mkManager(root, { ytdlp: f.ytdlp });
    f.yt({ metaFile: path.join(FIX, 'ytdlp-twitch-vod.json') });
    const res = await manager.fetchVod(TW_URL);
    assert.equal(res.meta.game, 'Minecraft');
    assert.equal(res.meta.channel, 'Canal de Teste');
    assert.deepEqual(res.qualities.map((q) => q.id), ['best', 'h720', 'h480', 'h360', 'h160']);
    assert.equal(res.chat.available, null);
    const origin = manager.originOf(res.meta);
    assert.equal(origin.type, 'vod');
    assert.equal(origin.platform, 'twitch');
    assert.equal(origin.videoId, '2345678901');
    assert.equal(origin.url, TW_URL);
    assert.equal(origin.uploadDate, '2026-10-20');
    assert.equal(origin.title, 'Live de teste - maratona');

    // live no ar: bloqueia o download com a explicação
    const live = JSON.parse(fs.readFileSync(path.join(FIX, 'ytdlp-twitch-vod.json'), 'utf8'));
    live.live_status = 'is_live';
    fs.writeFileSync(path.join(f.bin, 'live.json'), JSON.stringify(live));
    f.yt({ metaFile: path.join(f.bin, 'live.json') });
    await manager.fetchVod(TW_URL, { refresh: true });
    await assert.rejects(manager.download({ url: TW_URL, dir: path.join(root, 'out') }), (e) => e.code === 'LIVE_NOW' && /ainda está no ar/.test(e.message));
    assert.equal(manager.job, null);

    // nenhuma lista de formatos: bloqueia dizendo que depende de acesso
    fs.writeFileSync(path.join(f.bin, 'sem-formatos.json'), JSON.stringify({ id: 'x', title: 'Fechado', formats: [] }));
    f.yt({ metaFile: path.join(f.bin, 'sem-formatos.json') });
    await manager.fetchVod(YT_URL, { refresh: true });
    await assert.rejects(manager.download({ url: YT_URL, dir: path.join(root, 'out') }), (e) => e.code === 'NO_FORMATS' && /depende de acesso, permissões ou disponibilidade/.test(e.message));
  } finally { rm(root); }
});

test('B: download com chat do YouTube grava bf-chat-1, registra o VOD e o originFor devolve origem e chat', { skip: skipFake, timeout: 90000 }, async () => {
  const root = tmp('b-ytchat');
  try {
    const f = mkFakeEnv(root);
    process.env.BF_FAKE_NODE = process.execPath;
    const zoo = JSON.parse(fs.readFileSync(path.join(FIX, 'ytdlp-youtube-zoo.json'), 'utf8'));
    zoo.live_status = 'was_live';
    zoo.subtitles = { live_chat: [{ ext: 'json' }] };
    fs.writeFileSync(path.join(f.bin, 'live-replay.json'), JSON.stringify(zoo));
    f.yt({ metaFile: path.join(f.bin, 'live-replay.json'), liveChatFile: path.join(FIX, 'youtube-live-chat.jsonl') });
    const { manager, paths, events } = mkManager(root, { ytdlp: f.ytdlp });
    const dest = path.join(root, 'VODs');

    const res = await manager.download({ url: YT_URL, dir: dest, withChat: true });
    assert.equal(path.basename(res.path), 'Me at the zoo.mp4');
    assert.equal(res.chatNote, null);
    assert.equal(res.chat.format, 'bf-chat-1');
    assert.equal(res.chat.platform, 'youtube');
    assert.equal(res.chat.count, 6);
    assert.equal(res.chat.path, path.join(paths.userData, 'chats', 'youtube-jNQXAC9IVRw.json'));
    const chat = await readChat(res.chat.path);
    assert.equal(chat.videoId, 'jNQXAC9IVRw');
    assert.equal(chat.messages[0].text, 'oi pessoal');
    assert.ok(events.some((e) => e.phase === 'chat'), 'passou pela fase do chat');
    assert.ok(events.filter((e) => e.phase === 'chat').some((e) => /Baixando o chat/.test(e.message)));
    assert.deepEqual(fs.readdirSync(path.join(paths.cache, 'sources')), [], 'pasta temporária do chat removida');

    // chamadas do yt-dlp: nada de playlist, URL depois de "--", ffmpeg-location, sem cookies
    const calls = f.ytCalls();
    const chatCall = calls.find((c) => c.includes('--skip-download'));
    assert.deepEqual(chatCall.slice(-2), ['--', YT_URL]);
    assert.ok(chatCall.includes('--ignore-config') && chatCall.includes('--no-playlist'));
    assert.equal(chatCall[chatCall.indexOf('--ffmpeg-location') + 1], path.dirname(tools.ffmpeg));
    assert.ok(!chatCall.includes('--cookies-from-browser'));
    assert.ok(!chatCall.includes('--js-runtimes'));

    // reabrir depois: o gancho do renderer descobre origem, chat e meta pelo caminho
    const known = manager.originFor(res.path);
    assert.equal(known.kind, 'vod');
    assert.equal(known.origin.videoId, 'jNQXAC9IVRw');
    assert.equal(known.chat.count, 6);
    assert.equal(known.meta.channel, 'jawed');
    assert.equal(manager.originFor(path.join(root, 'outro.mp4')), null);
    assert.deepEqual(await manager.chatCheck(res.chat.path), { exists: true, count: 6, platform: 'youtube' });
    const gone = await manager.chatCheck(path.join(root, 'sumiu.json'));
    assert.equal(gone.exists, false);
    assert.equal(gone.code, 'CHAT_NOT_FOUND');
  } finally { rm(root); }
});

test('B: YouTube sem replay de chat é dito com honestidade (e o vídeo é salvo do mesmo jeito)', { skip: skipFake, timeout: 90000 }, async () => {
  const root = tmp('b-nochat');
  try {
    const f = mkFakeEnv(root);
    process.env.BF_FAKE_NODE = process.execPath;
    f.yt({ metaFile: path.join(FIX, 'ytdlp-youtube-zoo.json'), liveChatWarn: true });
    const { manager } = mkManager(root, { ytdlp: f.ytdlp });
    const res = await manager.download({ url: YT_URL, dir: path.join(root, 'V'), withChat: true });
    assert.ok(fs.existsSync(res.path));
    assert.equal(res.chat, null);
    assert.match(res.chatNote, /não tem replay de chat/);
    assert.match(res.chatNote, /desativado|não guardou|não foi uma transmissão/);
    assert.equal(manager.originFor(res.path).chat, null);
    await assert.rejects(manager.downloadChat({ url: YT_URL }), (e) => e.code === 'NO_CHAT' && /não tem replay de chat/.test(e.message));

    // chat vazio (live sem nenhuma mensagem)
    fs.writeFileSync(path.join(f.bin, 'vazio.jsonl'), '{"replayChatItemAction":{"actions":[],"videoOffsetTimeMsec":"0"}}\n');
    f.yt({ metaFile: path.join(FIX, 'ytdlp-youtube-zoo.json'), liveChatFile: path.join(f.bin, 'vazio.jsonl') });
    await assert.rejects(manager.downloadChat({ url: YT_URL }), (e) => e.code === 'NO_CHAT' && /veio vazio/.test(e.message));

    // erro real durante o download do chat também não derruba o vídeo
    f.yt({ metaFile: path.join(FIX, 'ytdlp-youtube-zoo.json'), liveChatFile: path.join(FIX, 'youtube-live-chat.jsonl') });
    const ok = await manager.downloadChat({ url: YT_URL });
    assert.equal(ok.chat.count, 6);
    assert.equal(manager.job, null);
  } finally { rm(root); }
});

test('B: chat da Twitch pelo TwitchDownloaderCLI; sem a ferramenta, VOD apagado e cancelamento são tratados', { skip: skipFake, timeout: 90000 }, async () => {
  const root = tmp('b-twchat');
  try {
    const f = mkFakeEnv(root);
    process.env.BF_FAKE_NODE = process.execPath;
    f.yt({ metaFile: path.join(FIX, 'ytdlp-twitch-vod.json') });
    f.tw({ chatFile: path.join(FIX, 'twitchdownloader-chat.json') });
    const dest = path.join(root, 'V');
    const { manager, paths, events } = mkManager(root, { ytdlp: f.ytdlp, twitchDownloader: f.twitch });

    const res = await manager.download({ url: TW_URL, dir: dest, withChat: true });
    assert.equal(res.meta.game, 'Minecraft');
    assert.equal(res.chat.platform, 'twitch');
    assert.equal(res.chat.count, 5);
    assert.equal(res.chat.path, path.join(paths.userData, 'chats', 'twitch-2345678901.json'));
    assert.equal((await readChat(res.chat.path)).messages[2].text, 'PogChamp');
    const chatEvents = events.filter((e) => e.phase === 'chat' && e.percent !== null);
    assert.ok(chatEvents.length > 0, 'a porcentagem do TwitchDownloaderCLI aparece');
    const call = f.twCalls().find((c) => c[0] === 'chatdownload');
    assert.deepEqual(call.slice(0, 3), ['chatdownload', '--id', '2345678901']);
    assert.equal(call[call.indexOf('--collision') + 1], 'Overwrite');
    assert.ok(path.dirname(call[call.indexOf('-o') + 1]).startsWith(path.join(paths.cache, 'sources')), 'o JSON temporário fica no cache do app');
    assert.deepEqual(fs.readdirSync(path.join(paths.cache, 'sources')), []);

    // sem o TwitchDownloaderCLI: o vídeo é salvo e a nota diz o que fazer
    const noTool = mkManager(path.join(root, 'sem'), { ytdlp: f.ytdlp, twitchDownloader: null });
    const res2 = await noTool.manager.download({ url: TW_URL, dir: path.join(root, 'V2'), withChat: true });
    assert.equal(res2.chat, null);
    assert.match(res2.chatNote, /instale o TwitchDownloaderCLI na aba Ferramentas/);
    await assert.rejects(noTool.manager.downloadChat({ url: TW_URL }), (e) => e.code === 'NO_TWITCHDOWNLOADER');

    // VOD que a Twitch já apagou: saída REAL do programa
    f.tw({ stderr: 'Unhandled exception. System.AggregateException: One or more errors occurred. (Invalid VOD, deleted/expired VOD possibly?)', code: 127 });
    const gone = await manager.download({ url: TW_URL, dir: path.join(root, 'V3'), withChat: true });
    assert.ok(fs.existsSync(gone.path), 'o vídeo foi salvo');
    assert.equal(gone.chat, null);
    assert.match(gone.chatNote, /apagado ou expirado/);
    await assert.rejects(manager.downloadChat({ url: TW_URL }), (e) => e.code === 'CHAT_VOD_GONE' && e.details.dependsOnAccess === true);

    // cancelar o chat
    f.tw({ chatFile: path.join(FIX, 'twitchdownloader-chat.json'), stepMs: 1500 });
    const pending = manager.downloadChat({ url: TW_URL }).catch((e) => e);
    await waitUntil(() => manager.job && manager.job.kind === 'chat' && manager.usage().twitchdownloader, 15000, 'chat em andamento');
    assert.match(manager.usage().twitchdownloader, /TwitchDownloaderCLI/);
    manager.cancel();
    assert.equal((await pending).code, 'CANCELLED');
    assert.equal(manager.usage().twitchdownloader, null);
  } finally { rm(root); }
});

test('B: cookies do navegador e Deno entram nos argumentos só quando escolhidos/instalados', { skip: skipFake }, async () => {
  const root = tmp('b-args');
  try {
    const f = mkFakeEnv(root);
    process.env.BF_FAKE_NODE = process.execPath;
    f.yt({ metaFile: path.join(FIX, 'ytdlp-youtube-zoo.json') });
    let deno = null;
    const { manager } = mkManager(root, { ytdlp: f.ytdlp }, { getDenoPath: () => deno });

    await manager.fetchVod(YT_URL, { refresh: true });
    let args = f.ytCalls().filter((c) => c.includes('-J')).pop();
    assert.ok(!args.includes('--cookies-from-browser'));
    assert.ok(!args.includes('--js-runtimes'));
    assert.equal((await manager.getState()).tools.jsRuntime.found, false);

    manager.setSettings({ cookiesBrowser: 'firefox' });
    deno = 'C:\\tools\\deno\\deno.exe';
    await manager.fetchVod(YT_URL, { refresh: true });
    args = f.ytCalls().filter((c) => c.includes('-J')).pop();
    assert.equal(args[args.indexOf('--cookies-from-browser') + 1], 'firefox');
    assert.equal(args[args.indexOf('--js-runtimes') + 1], 'deno:C:\\tools\\deno\\deno.exe');
    assert.equal(args[args.length - 1], YT_URL);
    assert.deepEqual((await manager.getState()).tools.jsRuntime, { found: true, origin: 'app', path: deno });
    assert.equal(manager.store.get().cookiesBrowser, 'firefox', 'a escolha fica salva');

    manager.setSettings({ cookiesBrowser: '' });
    await manager.fetchVod(YT_URL, { refresh: true });
    args = f.ytCalls().filter((c) => c.includes('-J')).pop();
    assert.ok(!args.includes('--cookies-from-browser'));

    // com cookies ligados, o erro de bot sugere outra coisa (não manda ligar o que já está ligado)
    manager.setSettings({ cookiesBrowser: 'chrome' });
    f.yt({ metaStderr: 'ERROR: [youtube] x: Sign in to confirm you’re not a bot', metaCode: 1 });
    await assert.rejects(manager.fetchVod(YT_URL, { refresh: true }), (e) => e.code === 'BOT_CHECK' && !/ligue/.test(e.details.solution));
    // o erro de cookies do navegador (saída real do yt-dlp quando o Edge não tem perfil) é traduzido
    f.yt({ metaStderr: 'ERROR: could not find edge cookies database in "C:\\Users\\fulano\\AppData\\Local\\Microsoft\\Edge\\User Data"', metaCode: 1 });
    await assert.rejects(manager.fetchVod(YT_URL, { refresh: true }), (e) => e.code === 'COOKIES_BROWSER' && /Feche o navegador/.test(e.message) && !/fulano/.test(JSON.stringify(e.details)));
  } finally { rm(root); }
});

test('B: aviso do Deno ausente aparece sem impedir a consulta', { skip: skipFake }, async () => {
  const root = tmp('b-deno');
  try {
    const f = mkFakeEnv(root);
    process.env.BF_FAKE_NODE = process.execPath;
    f.yt({ metaFile: path.join(FIX, 'ytdlp-youtube-zoo.json'), metaStderr: 'WARNING: [youtube] No supported JavaScript runtime could be found. Only deno is enabled by default' });
    const { manager } = mkManager(root, { ytdlp: f.ytdlp });
    const res = await manager.fetchVod(YT_URL);
    assert.deepEqual(res.warnings.map((w) => [w.level, w.code]), [['warn', 'NO_JS_RUNTIME']]);
    assert.match(res.warnings[0].message, /Instale o Deno na aba Ferramentas/);
    assert.equal(res.meta.title, 'Me at the zoo');
    // com um Deno do sistema o aviso some
    const withSystem = mkManager(path.join(root, 'b'), { ytdlp: f.ytdlp }, { findSystemDeno: () => 'C:\\deno\\deno.exe' });
    const res2 = await withSystem.manager.fetchVod(YT_URL);
    assert.deepEqual(res2.warnings, []);
    assert.deepEqual((await withSystem.manager.getState()).tools.jsRuntime, { found: true, origin: 'system', path: 'C:\\deno\\deno.exe' });
  } finally { rm(root); }
});

test('B: download falso com erro no meio mantém o que baixou; mesmo vídeo nunca perde o arquivo existente', { skip: skipFake, timeout: 90000 }, async () => {
  const root = tmp('b-dl');
  try {
    const f = mkFakeEnv(root);
    process.env.BF_FAKE_NODE = process.execPath;
    const { manager } = mkManager(root, { ytdlp: f.ytdlp });
    const dest = path.join(root, 'V');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'Me at the zoo.mp4'), 'ARQUIVO DO USUÁRIO');

    f.yt({ metaFile: path.join(FIX, 'ytdlp-youtube-zoo.json'), downloadStderr: 'ERROR: [youtube] jNQXAC9IVRw: unable to download video data: HTTP Error 403: Forbidden', downloadCode: 1 });
    await assert.rejects(manager.download({ url: YT_URL, dir: dest }), (e) => e.code === 'FORBIDDEN' && e.details.retryable === true);
    assert.equal(manager.job, null);

    f.yt({ metaFile: path.join(FIX, 'ytdlp-youtube-zoo.json') });
    const ok = await manager.download({ url: YT_URL, dir: dest });
    assert.equal(path.basename(ok.path), 'Me at the zoo (2).mp4');
    assert.equal(fs.readFileSync(path.join(dest, 'Me at the zoo.mp4'), 'utf8'), 'ARQUIVO DO USUÁRIO');
    assert.equal(ok.warnings.length, 0);

    // qualidade escolhida: o filtro de altura chega ao yt-dlp
    await manager.download({ url: YT_URL, dir: dest, quality: 'h144' });
    const dl = f.ytCalls().filter((c) => c.includes('--continue')).pop();
    assert.equal(dl[dl.indexOf('-f') + 1], 'bv*[height<=144]+ba/b[height<=144]');
    await manager.download({ url: YT_URL, dir: dest, quality: 'qualidade-inexistente' });
    const dl2 = f.ytCalls().filter((c) => c.includes('--continue')).pop();
    assert.equal(dl2[dl2.indexOf('-f') + 1], 'bv*+ba/b', 'qualidade desconhecida cai em "melhor"');
  } finally { rm(root); }
});

test('B: configurações validadas (pastas, navegador) e OBS pelo manager', { skip: skipMedia }, async () => {
  const root = tmp('b-set');
  try {
    const rec = path.join(root, 'REC');
    fs.mkdirSync(rec);
    const obsDir = path.join(root, 'obs-studio');
    fs.mkdirSync(path.join(obsDir, 'basic', 'profiles', 'P'), { recursive: true });
    fs.writeFileSync(path.join(obsDir, 'basic', 'profiles', 'P', 'basic.ini'), `[General]\nName=P\n[Output]\nMode=Simple\n[SimpleOutput]\nFilePath=${rec}\n`);
    fakes.sampleVideo(tools.ffmpeg, path.join(rec, '2026-10-20 10-00-00.mp4'), { seconds: 2 });
    const old = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(path.join(rec, '2026-10-20 10-00-00.mp4'), old, old);
    const { manager } = mkManager(root, { ytdlp: null }, { obsDir });

    const det = await manager.detectObs();
    assert.equal(det.found, true);
    assert.equal(det.selected, path.normalize(rec));
    assert.equal(det.selectedBy, 'obs');
    const list = await manager.listObs();
    assert.equal(list.files.length, 1);
    assert.ok(list.files[0].durationSec > 1);
    // arquivo dentro da pasta do OBS: o gancho descobre a origem
    assert.deepEqual(manager.originFor(list.files[0].path), { kind: 'obs', origin: { type: 'obs' }, chat: null, meta: {} });
    assert.equal(manager.originFor(path.join(root, 'fora.mp4')), null);

    // pasta escolhida à mão vale mais que a detectada
    const manual = path.join(root, 'Manual');
    fs.mkdirSync(manual);
    manager.setSettings({ obsFolder: manual });
    assert.equal((await manager.detectObs()).selected, manual);
    assert.equal((await manager.detectObs()).selectedBy, 'manual');
    assert.deepEqual((await manager.listObs()).files, []);
    assert.equal((await manager.listObs({ folder: rec })).files.length, 1);
    manager.setSettings({ obsFolder: null });
    assert.equal((await manager.detectObs()).selectedBy, 'obs');

    assert.throws(() => manager.setSettings({ obsFolder: path.join(root, 'nao-existe') }), (e) => e.code === 'FOLDER_MISSING');
    assert.throws(() => manager.setSettings({ obsFolder: 'relativa' }), (e) => e.code === 'INVALID_PATH');
    assert.throws(() => manager.setSettings({ downloadDir: 'relativa' }), (e) => e.code === 'INVALID_PATH');
    assert.throws(() => manager.setSettings({ cookiesBrowser: 'netscape' }), (e) => e.code === 'INVALID_BROWSER' && /chrome/.test(e.message));
    assert.equal(manager.setSettings({ downloadDir: path.join(root, 'Baixados') }).downloadDir, path.join(root, 'Baixados'));
    assert.equal((await manager.getState()).downloadDir, path.join(root, 'Baixados'));
    manager.setSettings({ downloadDir: null });
    assert.equal((await manager.getState()).downloadDir, path.join(root, 'Videos', 'Braga Frame'), 'padrão: Vídeos\\Braga Frame');
    // sem OBS e sem pasta escolhida: mensagem útil
    const none = mkManager(path.join(root, 'x'), { ytdlp: null }, { obsDir: path.join(root, 'nada') });
    assert.equal((await none.manager.detectObs()).found, false);
    await assert.rejects(none.manager.listObs(), (e) => e.code === 'NO_FOLDER' && /Escolha a pasta/.test(e.message));
  } finally { rm(root); }
});

test('versão do yt-dlp (programa falso responde --version) e estado das ferramentas', { skip: skipFake }, async () => {
  const root = tmp('b-ver');
  try {
    const f = mkFakeEnv(root);
    process.env.BF_FAKE_NODE = process.execPath;
    f.yt({ version: '2026.08.19' });
    const { manager } = mkManager(root, { ytdlp: f.ytdlp, twitchDownloader: f.twitch });
    const state = await manager.getState();
    assert.equal(state.tools.ytdlp.version, '2026.08.19');
    assert.equal(state.tools.ytdlp.found, true);
    assert.equal(state.tools.twitchDownloader.found, true);
    assert.equal(state.tools.ffmpeg.found, true);
    assert.equal(state.job, null);
    const none = mkManager(path.join(root, 'z'), { ytdlp: null });
    const s2 = await none.manager.getState();
    assert.deepEqual(s2.tools.ytdlp, { found: false, path: null, hostProvided: false, hostName: null, version: null, ageDays: null, outdated: false });
    assert.equal(parseVodUrl(YT_URL).videoId, 'jNQXAC9IVRw');
  } finally { rm(root); }
});

test('B: o pedaço baixado de uma qualidade nunca é reaproveitado por outra (uma pasta de trabalho por qualidade)', { skip: skipFake, timeout: 120000 }, async () => {
  const root = tmp('b-quality');
  try {
    const f = mkFakeEnv(root);
    process.env.BF_FAKE_NODE = process.execPath;
    f.yt({ metaFile: path.join(FIX, 'ytdlp-youtube-zoo.json'), steps: 30, stepMs: 150 });
    const { manager, events } = mkManager(root, { ytdlp: f.ytdlp });
    const dest = path.join(root, 'V');

    const first = manager.download({ url: YT_URL, dir: dest, quality: 'best' }).catch((e) => e);
    await waitUntil(() => events.some((e) => e.phase === 'download' && e.downloaded > 0), 20000, 'download da melhor qualidade começar');
    manager.cancel();
    assert.equal((await first).code, 'CANCELLED');

    const best = manager.partialInfo({ url: YT_URL, dir: dest, quality: 'best' });
    assert.ok(best.bytes > 0);
    assert.equal(best.otherBytes, 0);
    assert.match(path.basename(best.workDir), /^\.bf-vod-youtube-jNQXAC9IVRw-best$/);
    const small = manager.partialInfo({ url: YT_URL, dir: dest, quality: 'h144' });
    assert.equal(small.bytes, 0, 'a pasta da outra qualidade está vazia: nada a retomar');
    assert.equal(small.otherBytes, best.bytes, 'o app avisa que há pedaços de outra qualidade guardados');
    assert.match(path.basename(small.workDir), /-h144$/);

    // baixar em 144p não retoma (nem mistura) o pedaço da melhor qualidade
    f.yt({ metaFile: path.join(FIX, 'ytdlp-youtube-zoo.json'), steps: 5, stepMs: 40 });
    const res = await manager.download({ url: YT_URL, dir: dest, quality: 'h144' });
    assert.equal(res.resumed, false);
    const dlCall = f.ytCalls().filter((c) => c.includes('--continue')).pop();
    assert.match(dlCall[dlCall.indexOf('-o') + 1], /-h144[\\/]video\.%\(ext\)s$/);
    assert.equal(manager.partialInfo({ url: YT_URL, dir: dest, quality: 'best' }).bytes, best.bytes, 'o pedaço da melhor qualidade continua intacto');
    assert.deepEqual(fs.readdirSync(dest).sort(), [path.basename(best.workDir), path.basename(res.path)].sort());

    // descartar apaga os pedaços de todas as qualidades daquele vídeo e nada mais
    fs.writeFileSync(path.join(dest, '.bf-vod-youtube-OUTROVIDEO1-best'), 'de outro vídeo (arquivo, não pasta)');
    fs.mkdirSync(path.join(dest, '.bf-vod-youtube-OUTROVIDEO2-best'));
    const freed = await manager.discardPartial({ url: YT_URL, dir: dest });
    assert.ok(freed.freed >= best.bytes);
    assert.deepEqual(fs.readdirSync(dest).sort(), ['.bf-vod-youtube-OUTROVIDEO1-best', '.bf-vod-youtube-OUTROVIDEO2-best', path.basename(res.path)].sort(), 'outros vídeos e o arquivo final ficam');
    assert.deepEqual(await manager.discardPartial({ url: YT_URL, dir: dest }), { freed: 0 });
  } finally { rm(root); }
});

test('B: a pasta de trabalho só nasce depois de o espaço em disco ser conferido e a sonda de duração completa a lista', { skip: skipFake }, async () => {
  const root = tmp('b-probe');
  try {
    const f = mkFakeEnv(root);
    process.env.BF_FAKE_NODE = process.execPath;
    const { manager } = mkManager(root, { ytdlp: f.ytdlp });
    const probe = await manager.probeDurations([f.sample, path.join(root, 'nao-existe.mp4'), path.join(root, 'x.txt')]);
    assert.deepEqual(Object.keys(probe.durations).sort(), [f.sample, path.join(root, 'nao-existe.mp4')].sort());
    assert.ok(Math.abs(probe.durations[f.sample] - 3) < 0.6);
    assert.equal(probe.durations[path.join(root, 'nao-existe.mp4')], null);

    // espaço insuficiente: o app diz quanto falta, bloqueia só este download e não deixa pasta de trabalho
    const huge = JSON.parse(fs.readFileSync(path.join(FIX, 'ytdlp-youtube-zoo.json'), 'utf8'));
    for (const fmt of huge.formats) { if (fmt.vcodec !== 'none') fmt.filesize = 900 * 1024 ** 4; }
    fs.writeFileSync(path.join(f.bin, 'enorme.json'), JSON.stringify(huge));
    f.yt({ metaFile: path.join(f.bin, 'enorme.json') });
    const dest = path.join(root, 'V');
    await assert.rejects(manager.download({ url: YT_URL, dir: dest }), (e) => e.code === 'NO_DISK_SPACE' && /Não há espaço suficiente/.test(e.message) && /Libere espaço ou escolha outra pasta/.test(e.message));
    assert.deepEqual(fs.readdirSync(dest), [], 'nenhuma pasta de trabalho criada');
    assert.equal(manager.job, null);
  } finally { rm(root); }
});

// =====================================================================================================
// C) achados da revisão cruzada: TEMP do yt-dlp, consulta cancelável, aviso de espaço e OBS em rede fora do ar
// =====================================================================================================

test('A: o yt-dlp usa um TEMP só dele, apagado no fim: cancelar não deixa _MEI<n> (~22 MB) para trás', { skip: skipReal, timeout: 180000 }, async () => {
  const root = tmp('mei');
  const clip = path.join(root, 'clip.mp4');
  fakes.sampleVideo(tools.ffmpeg, clip, { seconds: 10, size: '960x540' });
  const server = await fakes.startMediaServer(clip, { rate: 120000 });
  try {
    // o TEMP "do sistema" desta execução é uma pasta de teste: o que o yt-dlp (PyInstaller onefile) extrair ali aparece
    const systemTemp = path.join(root, 'system-temp');
    fs.mkdirSync(systemTemp);
    const env = { ...process.env, TEMP: systemTemp, TMP: systemTemp };
    const { manager, events } = mkManager(root, { ytdlp: realYtdlp }, { parseUrl: localParse, env });
    const dest = path.join(root, 'VODs');
    const url = server.url('/clip.mp4');
    const mei = (dir) => { try { return fs.readdirSync(dir).filter((n) => n.startsWith('_MEI')); } catch { return []; } };

    for (let round = 1; round <= 2; round++) {
      events.length = 0;
      const running = manager.download({ url, dir: dest }).catch((e) => e);
      await waitUntil(() => events.some((e) => e.phase === 'download' && e.downloaded > 60000), 40000, 'download começar');
      // durante a execução o yt-dlp se extraiu na pasta própria do app, não no TEMP do sistema
      const mine = fs.readdirSync(manager.tmpRoot);
      assert.equal(mine.length, 1, `uma pasta TEMP por execução: ${mine}`);
      assert.ok(mei(path.join(manager.tmpRoot, mine[0])).length > 0, 'o yt-dlp.exe se extrai no TEMP próprio');
      assert.deepEqual(mei(systemTemp), [], 'nada no TEMP do sistema');
      assert.equal(manager.cancel(), true);
      assert.equal((await running).code, 'CANCELLED');
    }
    await sleep(500);
    assert.deepEqual(mei(systemTemp), [], 'antes: cada cancelamento deixava um _MEI<n> no TEMP');
    assert.deepEqual(fs.readdirSync(manager.tmpRoot), [], 'as pastas TEMP próprias foram apagadas, canceladas ou não');
    assert.deepEqual(processesMentioning(path.basename(root)), [], 'nenhum processo ficou rodando');

    // execução normal (consulta) também não deixa nada
    await manager.fetchVod(server.url('/page'), { refresh: true });
    assert.deepEqual(mei(systemTemp), []);
    assert.deepEqual(fs.readdirSync(manager.tmpRoot), []);

    // sobras de uma execução anterior (app encerrado à força) são varridas ao iniciar
    fs.mkdirSync(path.join(manager.tmpRoot, 'velho', '_MEI123'), { recursive: true });
    fs.writeFileSync(path.join(manager.tmpRoot, 'velho', '_MEI123', 'x.dll'), 'x');
    manager.sweepTemp();
    assert.equal(fs.existsSync(manager.tmpRoot), false);
  } finally { await server.close(); rm(root); }
});

test('B: a consulta de metadados pode ser cancelada pelo queryId e fechar o app a encerra (nenhum yt-dlp órfão)', { skip: skipFake, timeout: 90000 }, async () => {
  const root = tmp('b-query');
  try {
    const f = mkFakeEnv(root);
    process.env.BF_FAKE_NODE = process.execPath;
    f.yt({ metaFile: path.join(FIX, 'ytdlp-youtube-zoo.json'), delayBeforeMetaMs: 40000 });
    const { manager } = mkManager(root, { ytdlp: f.ytdlp });
    const started = () => f.ytCalls().some((c) => c.includes('-J'));

    // cancelar pelo id
    const first = manager.fetchVod(YT_URL, { refresh: true, queryId: 'minha-consulta' }).catch((e) => e);
    await waitUntil(started, 15000, 'consulta começar');
    assert.equal(manager.cancelQuery('outra'), false, 'id de outra consulta não cancela esta');
    assert.equal(manager.cancel(), false, 'cancel() sem trabalho não mexe na consulta');
    assert.equal(manager.cancelQuery('minha-consulta'), true);
    const err = await first;
    assert.equal(err.code, 'CANCELLED');
    assert.match(err.message, /Consulta cancelada/);
    assert.equal(manager.aborters.size, 0, 'nada fica registrado');
    assert.equal(manager.usage().ytdlp, null);

    // fechar o app (before-quit -> cancelAll): antes só o "trabalho" era cancelado e a consulta seguia rodando
    fs.rmSync(path.join(f.bin, 'calls.log'), { force: true });
    const second = manager.fetchVod(YT_URL, { refresh: true }).catch((e) => e);
    await waitUntil(started, 15000, 'segunda consulta começar');
    assert.equal(manager.cancelAll(), true);
    assert.equal((await second).code, 'CANCELLED');
    assert.equal(manager.cancelAll(), false, 'sem nada em andamento');
    await sleep(600);
    assert.deepEqual(processesMentioning(path.basename(root)), [], 'nenhum yt-dlp ficou rodando depois de cancelar');
    assert.deepEqual(fs.readdirSync(manager.tmpRoot), [], 'TEMP próprio apagado');

    // um download que consulta o vídeo antes de baixar: cancel() também interrompe a consulta
    fs.rmSync(path.join(f.bin, 'calls.log'), { force: true });
    const dl = manager.download({ url: YT_URL, dir: path.join(root, 'V') }).catch((e) => e);
    await waitUntil(started, 15000, 'consulta do download começar');
    assert.equal(manager.cancel(), true);
    assert.equal((await dl).code, 'CANCELLED');
    assert.equal(manager.job, null);
    await sleep(600);
    assert.deepEqual(processesMentioning(path.basename(root)), []);
  } finally { rm(root); }
});

test('B: o espaço livre é avaliado ANTES de baixar (diskCheck), com os mesmos limites do download', { skip: skipFake, timeout: 90000 }, async () => {
  const root = tmp('b-disk');
  try {
    const f = mkFakeEnv(root);
    process.env.BF_FAKE_NODE = process.execPath;
    const { manager } = mkManager(root, { ytdlp: f.ytdlp });
    const dest = path.join(root, 'V');
    const free = await require('../src/core/sources/naming').freeBytes(dest);
    assert.ok(free > 64 * 1024 * 1024, 'precisa de algum espaço livre para o teste');
    const withSize = (bytes) => {
      const info = JSON.parse(fs.readFileSync(path.join(FIX, 'ytdlp-youtube-zoo.json'), 'utf8'));
      for (const fmt of info.formats) { fmt.filesize = fmt.vcodec !== 'none' ? bytes : 0; delete fmt.filesize_approx; }
      fs.writeFileSync(path.join(f.bin, 'tamanho.json'), JSON.stringify(info));
      f.yt({ metaFile: path.join(f.bin, 'tamanho.json') });
    };

    // sem consulta anterior não há tamanho estimado: não inventa aviso
    assert.equal((await manager.diskCheck({ url: YT_URL, dir: dest })).level, 'unknown');

    withSize(1024 * 1024);
    const meta = await manager.fetchVod(YT_URL, { refresh: true });
    const small = await manager.diskCheck({ url: YT_URL, dir: dest, quality: 'best' });
    assert.equal(small.level, 'ok');
    assert.equal(small.message, '');
    assert.equal(small.estBytes, meta.qualities[0].estBytes);

    // cabe, mas fica justo: aviso que NÃO bloqueia (o download continua permitido)
    withSize(Math.floor(free / 1.5));
    await manager.fetchVod(YT_URL, { refresh: true });
    const low = await manager.diskCheck({ url: YT_URL, dir: dest, quality: 'best' });
    assert.equal(low.level, 'low');
    assert.match(low.message, /Pouco espaço livre em .*V/);
    assert.match(low.message, /até o dobro/);
    assert.ok(low.freeBytes > 0);

    // claramente não cabe: o mesmo limite que faz o download recusar
    withSize(free * 2);
    await manager.fetchVod(YT_URL, { refresh: true });
    const block = await manager.diskCheck({ url: YT_URL, dir: dest, quality: 'best' });
    assert.equal(block.level, 'block');
    assert.match(block.message, /Não há espaço suficiente/);
    await assert.rejects(manager.download({ url: YT_URL, dir: dest }), (e) => e.code === 'NO_DISK_SPACE' && /Não há espaço suficiente em .*V/.test(e.message));
  } finally { rm(root); }
});

test('OBS: pasta de gravação num compartilhamento de rede fora do ar não congela o processo principal', { timeout: 60000 }, async () => {
  const root = tmp('obs-net');
  try {
    // perfil do OBS apontando para um IP de documentação (RFC 5737): nunca responde. Antes: statSync parava o processo ~21 s.
    const obsDir = path.join(root, 'obs-studio');
    const profile = path.join(obsDir, 'basic', 'profiles', 'Live');
    fs.mkdirSync(profile, { recursive: true });
    // um endereço diferente a cada execução: o Windows guarda por ~2 min o erro de um endereço já tentado e responderia rápido demais
    const host = `192.0.2.${2 + Math.floor(Math.random() * 252)}`;
    const share = `//${host}/bf-gravacoes-teste`;
    fs.writeFileSync(path.join(profile, 'basic.ini'), `[General]\nName=Live\n[Output]\nMode=Simple\n[SimpleOutput]\nFilePath=${share}\n`);
    fs.writeFileSync(path.join(obsDir, 'user.ini'), '[Basic]\nProfile=Live\nProfileDir=Live\n');
    const good = path.join(root, 'REC');
    fs.mkdirSync(good);

    // o teste roda em outro processo: ele mede o laço de eventos e sai com process.exit (a chamada pendurada do sistema não prende o teste)
    const script = `
      const { SourcesManager } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'core', 'sources', 'SourcesManager.js'))});
      const path = require('node:path');
      const root = ${JSON.stringify(root)};
      const paths = { userData: path.join(root, 'userData'), cache: path.join(root, 'cache') };
      const m = new SourcesManager({ paths, getTools: () => ({}), obsDir: ${JSON.stringify(obsDir)}, env: process.env, obsTimeoutMs: 1000, recordingsOptions: { readdirTimeoutMs: 1000 } });
      let last = Date.now(); let maxGap = 0;
      const timer = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 20);
      (async () => {
        const out = {};
        let t = Date.now();
        const det = await m.detectObs();
        out.detectMs = Date.now() - t;
        out.exists = det.profiles[0].exists; out.note = det.profiles[0].note || ''; out.selected = det.selected; out.folders = det.folders.length;
        t = Date.now();
        const list = await m.listObs({ folder: det.profiles[0].folder });
        out.listMs = Date.now() - t; out.listError = list.error || ''; out.listExists = list.exists;
        // o gancho de abertura roda a cada vídeo aberto: tem de ser instantâneo, com a pasta fora do ar
        t = Date.now();
        const kinds = [];
        for (let i = 0; i < 200; i += 1) kinds.push(m.originFor(path.join(${JSON.stringify(good)}, 'a' + i + '.mp4')));
        out.hookMs = Date.now() - t; out.hookKnown = kinds.filter(Boolean).length;
        out.inShare = m.originFor(path.win32.join('\\\\\\\\' + ${JSON.stringify(host)} + '\\\\bf-gravacoes-teste', '2026-10-21 10-00-00.mkv'));
        clearInterval(timer);
        out.maxGap = maxGap;
        // ao sair, o Node espera a chamada pendurada do sistema terminar (~21 s): grava o resultado e encerra o processo na hora
        process.stdout.write(JSON.stringify(out), () => process.kill(process.pid));
      })();`;
    const { spawnSync } = require('node:child_process');
    const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true, timeout: 50000 });
    assert.ok(res.stdout, `o processo de medição não respondeu: ${res.stderr} (código ${res.status})`);
    const out = JSON.parse(res.stdout);
    assert.ok(out.maxGap < 500, `o laço de eventos parou ${out.maxGap} ms (antes: ~21 000 ms)`);
    assert.ok(out.detectMs < 8000, `detectObs demorou ${out.detectMs} ms`);
    assert.ok(out.listMs < 8000, `listObs demorou ${out.listMs} ms`);
    assert.ok(out.exists === null || out.exists === false, 'a pasta sem resposta nunca vira "existe"');
    if (out.exists === null) assert.match(out.note, /Não consegui acessar a pasta de gravação/);
    assert.equal(out.selected, null, 'não escolhe uma pasta que não respondeu');
    assert.ok(out.listError, 'a listagem explica o problema em vez de ficar esperando');
    assert.equal(out.listExists, false);
    assert.ok(out.hookMs < 500, `o gancho de abertura leva ${out.hookMs} ms para 200 arquivos`);
    assert.equal(out.hookKnown, 0);
    assert.deepEqual(out.inShare, { kind: 'obs', origin: { type: 'obs' }, chat: null, meta: {} }, 'um arquivo da pasta do OBS continua sendo reconhecido, sem consultar a rede');
  } finally { rm(root); }
});

test('cookies do navegador ilegíveis (navegador aberto): a consulta segue SEM cookies, avisa e lembra por um tempo, sem apagar a escolha', async () => {
  const root = tmp('b-cookies');
  try {
    const meta = fs.readFileSync(path.join(FIX, 'ytdlp-youtube-zoo.json'), 'utf8');
    const cookieError = fs.readFileSync(path.join(FIX, 'ytdlp-errors', 'browser-cookie.stderr.txt'), 'utf8');
    let now = 1_000_000;
    const { manager } = mkManager(root, { ytdlp: process.execPath }, { now: () => now });
    manager.setSettings({ cookiesBrowser: 'chrome' });
    const calls = [];
    manager._runYtdlp = async (y, args) => {
      const withCookies = args.includes('--cookies-from-browser');
      calls.push(withCookies);
      return withCookies ? { code: 1, stdout: '', stderr: cookieError } : { code: 0, stdout: meta, stderr: '' };
    };
    const url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
    const res = await manager.fetchVod(url, { refresh: true });
    assert.deepEqual(calls, [true, false], 'tentou com cookies, falhou na leitura e repetiu sem eles');
    const note = res.warnings.find((w) => w.code === 'COOKIES_SKIPPED');
    assert.ok(note && note.level === 'info' && /chrome/.test(note.message), 'avisa que seguiu sem os cookies');
    assert.equal(manager.store.get().cookiesBrowser, 'chrome', 'a escolha do usuário não é apagada');

    calls.length = 0;
    await manager.fetchVod(url, { refresh: true });
    assert.deepEqual(calls, [false], 'enquanto o aviso vale, já vai direto sem cookies (não insiste no navegador)');

    now += 11 * 60 * 1000;
    calls.length = 0;
    await manager.fetchVod(url, { refresh: true });
    assert.deepEqual(calls, [true, false], 'passado o tempo, tenta o navegador de novo (ele pode ter sido fechado)');
  } finally { rm(root); }
});

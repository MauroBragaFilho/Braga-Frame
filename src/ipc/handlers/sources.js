'use strict';

const path = require('node:path');
const registry = require('../../core/tools/registry');
const { SourcesManager } = require('../../core/sources/SourcesManager');
const { SourcesError } = require('../../core/sources/errors');

/**
 * Fontes de entrada (dono: sources): gravações do OBS, VODs do YouTube/Twitch por link e o chat deles.
 * Canais (resposta { ok:true, … } ou { ok:false, code, message, details? }):
 *   sources:state                          -> { settings, defaultDownloadDir, downloadDir, tools, job }
 *   sources:setSettings { obsFolder?, downloadDir?, cookiesBrowser? } -> { settings }
 *   sources:pickFolder { purpose:'obs'|'download' } -> { path, settings } | { canceled:true }
 *   sources:obsDetect                      -> { found, obsDir, reason?, profiles, folders, manual, manualExists, selected, selectedBy }
 *        (exists/manualExists: true | false | null = "não consegui acessar a tempo": rede fora do ar não congela o app)
 *   sources:obsList { folder? }            -> { folder, exists, files, total, truncated, recording, error? }
 *        (file: { name, path, size, startedAt, durationSec|null, durationPending, recording }; só as 40 mais recentes vêm com duração)
 *   sources:probe { paths }                -> { durations: { <caminho>: segundos|null } }   (completa as durações pendentes, até 60 por vez)
 *   sources:fetchVod { url, refresh?, queryId? } -> { meta, qualities, chat, warnings, fetchedAt, fromCache }   (refresh ignora o cache de 10 min;
 *        queryId permite cancelar só esta consulta com sources:cancel { queryId })
 *   sources:refreshMeta { url }            -> igual a fetchVod (sem cache) + { origin } (formato do source.origin do projeto)
 *   sources:partial { url, quality?, dir? } -> { bytes, otherBytes, dir, exists, disk:{ level, freeBytes, estBytes, message } }
 *        (o que já foi baixado nessa qualidade e será retomado; otherBytes = em outras; disk = espaço livre x tamanho estimado, ANTES de baixar)
 *   sources:discardPartial { url, dir? }   -> { freed }   (todas as qualidades deste vídeo nessa pasta)
 *   sources:download { url, quality?, dir?, withChat? } -> { path, bytes, origin, meta, chat, chatNote, warnings, resumed }  (volta ao terminar)
 *   sources:chat { url }                   -> { chat:{ path, format, count, fetchedAt, platform } }
 *   sources:cancel { jobId? | queryId }    -> { cancelled }   (queryId = uma consulta de metadados; sem ele, o download em andamento)
 *   sources:originFor { path }             -> { known:false } | { known:true, kind:'vod'|'obs', origin, chat, meta }
 *   sources:chatCheck { path }             -> { exists, count?, reason? }
 * Evento (main -> renderer): sources:progress { jobId, kind, phase, percent, downloaded, total, speed, eta, message, … }.
 * O handler nunca grava o projeto aberto: quem aplica origem/meta/chat é o renderer.
 */
function register(ctx) {
  let videosDir = null;
  try { videosDir = ctx.app && typeof ctx.app.getPath === 'function' ? ctx.app.getPath('videos') : null; } catch { videosDir = null; }
  // BF_VIDEOS_DIR (caminho absoluto) troca a pasta Vídeos: os testes e2e a apontam para uma pasta temporária, para nunca
  // gravar nem apagar nada na pasta Vídeos de verdade do usuário.
  if (process.env.BF_VIDEOS_DIR && path.isAbsolute(process.env.BF_VIDEOS_DIR)) videosDir = process.env.BF_VIDEOS_DIR;

  const catalog = ctx.toolCatalog || null;
  const manager = new SourcesManager({
    paths: ctx.paths,
    getTools: () => ctx.tools,
    // o Deno do hospedeiro vem antes do instalado pelo app (o app não instala outro se o hospedeiro já tem)
    getDenoPath: () => (ctx.host && ctx.host.tool('deno')) || registry.resolveInstalled(ctx.paths.tools, 'deno', catalog ? { entries: catalog.entries } : {}),
    hostTool: (key) => (ctx.host ? ctx.host.tool(key) : null),
    hostName: ctx.host ? ctx.host.name : null,
    videosDir
  });

  // restos de uma execução anterior (pastas próprias deste recurso): chats baixados pela metade e as pastas TEMP do yt-dlp
  // que foi encerrado à força (veja SourcesManager._runWithTemp)
  manager.sweepTemp();

  // apagar um projeto pergunta aqui se o vídeo dele foi baixado pelo app (o registro de downloads é a prova) e esquece o registro depois
  ctx.sources = manager;

  manager.on('progress', (ev) => {
    ctx.bus.emit('sources:progress', ev);
    ctx.send('sources:progress', ev);
  });

  // a aba Ferramentas não remove/atualiza yt-dlp, TwitchDownloaderCLI nem Deno no meio do trabalho
  ctx.toolUsage.register((key, id) => {
    const usage = manager.usage();
    if (key === 'ytdlp') return usage.ytdlp;
    if (key === 'twitchDownloader') return usage.twitchdownloader;
    if (id === 'deno') return usage.deno;
    return null;
  });
  if (ctx.app && typeof ctx.app.on === 'function') ctx.app.on('before-quit', () => manager.cancelAll());

  const requireString = (value, what) => {
    if (typeof value !== 'string' || !value.trim()) throw new SourcesError('INVALID_ARGS', `Informe ${what}.`);
    return value;
  };

  ctx.handle('sources:state', () => manager.getState());

  ctx.handle('sources:setSettings', (payload) => ({ settings: manager.setSettings(payload) }));

  ctx.handle('sources:pickFolder', async ({ purpose }) => {
    if (purpose !== 'obs' && purpose !== 'download') throw new SourcesError('INVALID_ARGS', 'Informe qual pasta escolher (obs ou download).');
    const current = purpose === 'obs' ? (await manager.detectObs()).selected : manager.downloadDir();
    const res = await ctx.dialog.showOpenDialog(ctx.getWindow(), {
      title: purpose === 'obs' ? 'Escolher a pasta das gravações' : 'Escolher onde salvar os VODs',
      properties: ['openDirectory', ...(purpose === 'download' ? ['createDirectory'] : [])],
      ...(current ? { defaultPath: current } : {})
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { canceled: true };
    const chosen = res.filePaths[0];
    const settings = manager.setSettings(purpose === 'obs' ? { obsFolder: chosen } : { downloadDir: chosen });
    return { path: chosen, settings };
  });

  ctx.handle('sources:obsDetect', () => manager.detectObs());
  ctx.handle('sources:obsList', (payload) => manager.listObs(payload));
  ctx.handle('sources:probe', (payload) => manager.probeDurations(payload.paths));

  // `queryId` (opcional, escolhido por quem pede) permite cancelar só esta consulta com sources:cancel { queryId }
  ctx.handle('sources:fetchVod', ({ url, refresh, queryId }) => manager.fetchVod(requireString(url, 'o link do vídeo'), {
    refresh: refresh === true, queryId: typeof queryId === 'string' ? queryId.slice(0, 80) : undefined
  }));
  ctx.handle('sources:refreshMeta', ({ url }) => manager.refreshMeta(requireString(url, 'o link do vídeo')));
  ctx.handle('sources:partial', async (payload) => {
    const query = { url: requireString(payload.url, 'o link do vídeo'), dir: payload.dir, quality: payload.quality };
    return { ...manager.partialInfo(query), disk: await manager.diskCheck(query) };
  });
  ctx.handle('sources:discardPartial', (payload) => manager.discardPartial({ url: requireString(payload.url, 'o link do vídeo'), dir: payload.dir }));

  ctx.handle('sources:download', (payload) => manager.download({
    url: requireString(payload.url, 'o link do vídeo'), quality: payload.quality, dir: payload.dir, withChat: payload.withChat === true
  }));
  ctx.handle('sources:chat', (payload) => manager.downloadChat({ url: requireString(payload.url, 'o link do vídeo') }));
  ctx.handle('sources:cancel', (payload) => ({ cancelled: typeof payload.queryId === 'string' ? manager.cancelQuery(payload.queryId) : manager.cancel(payload.jobId) }));

  ctx.handle('sources:originFor', (payload) => {
    const found = manager.originFor(requireString(payload.path, 'o caminho do arquivo'));
    return found ? { known: true, ...found } : { known: false };
  });
  ctx.handle('sources:chatCheck', async (payload) => manager.chatCheck(requireString(payload.path, 'o caminho do chat')));

  return manager;
}

module.exports = { register };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ProxyManager, ProxyError } = require('../../core/proxy/ProxyManager');
const { VIDEO_EXTENSIONS } = require('./project');

/**
 * Proxy de visualização (docs/recursos/proxy.md): uma cópia leve do vídeo só para o player do app tocar quando o Chromium não toca o
 * original. Nada aqui escreve na fonte; os proxies ficam em <cache>/proxy e a exportação e a análise seguem usando o arquivo original.
 *
 *   proxy:ensure { path }  -> { state: 'ready'|'running', proxyPath, url, p?, etaSec? }   começa (ou reaproveita) a cópia
 *   proxy:status { path }  -> { state: 'none'|'ready'|'running', proxyPath?, url?, p?, etaSec? }
 *   proxy:cancel           -> { cancelled }
 * Eventos: proxy:progress { path, p, etaSec }, proxy:done { path, proxyPath, url }, proxy:failed { path, code, message }, proxy:cancelled { path }.
 */

const view = (status) => ({ ...status, ...(status.proxyPath && status.state !== 'none' ? { url: pathToFileURL(status.proxyPath).href } : {}) });

function checkPath(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new ProxyError('INVALID_PATH', 'Informe o caminho completo do vídeo.');
  const extension = path.extname(file).slice(1).toLowerCase();
  if (!VIDEO_EXTENSIONS.includes(extension)) throw new ProxyError('UNSUPPORTED_FORMAT', `Formato não suportado${extension ? ` (.${extension})` : ''}.`);
  let stat;
  try { stat = fs.statSync(file); } catch { stat = null; }
  if (!stat || !stat.isFile()) throw new ProxyError('INPUT_MISSING', `O vídeo não foi encontrado: ${file}`);
  return file;
}

function register(ctx) {
  const manager = new ProxyManager({
    dir: path.join(ctx.paths.cache, 'proxy'),
    getTools: () => ctx.tools,
    log: (level, message) => ctx.log(level, message)
  });
  ctx.proxy = manager;

  manager.on('progress', ({ file, p, etaSec }) => ctx.send('proxy:progress', { path: file, p, etaSec }));
  manager.on('done', ({ file, proxyPath }) => ctx.send('proxy:done', { path: file, proxyPath, url: pathToFileURL(proxyPath).href }));
  manager.on('failed', ({ file, code, message }) => ctx.send('proxy:failed', { path: file, code, message }));
  manager.on('cancelled', ({ file }) => ctx.send('proxy:cancelled', { path: file }));

  ctx.handle('proxy:ensure', async (payload) => view(await manager.ensure(checkPath(payload && payload.path))));
  ctx.handle('proxy:status', (payload) => {
    const file = payload && payload.path;
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new ProxyError('INVALID_PATH', 'Informe o caminho completo do vídeo.');
    return view(manager.status(file));
  });
  ctx.handle('proxy:cancel', () => ({ cancelled: manager.cancel() }));

  // o ffmpeg da cópia não pode ficar órfão ao fechar o app
  if (ctx.app && typeof ctx.app.on === 'function') ctx.app.on('before-quit', () => manager.shutdown());
}

module.exports = { register };

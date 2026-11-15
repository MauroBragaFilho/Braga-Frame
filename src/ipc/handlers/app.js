'use strict';

const appInfo = require('../../appInfo');
const controls = require('../../windowControls');

/** Informações do app e utilidades de janela/sistema. */
function register(ctx) {
  // nome, versão, ferramentas encontradas e eventuais handlers que não carregaram
  ctx.handle('app:info', () => ({
    name: appInfo.name,
    tagline: appInfo.tagline,
    version: ctx.app.getVersion(),
    projectsDir: ctx.paths.projects, // onde ficam os projetos (a tela Geral de Configurações mostra)
    tools: { ...ctx.tools },
    loadErrors: (ctx.handlers && ctx.handlers.failed) || []
  }));

  // o usuário instalou o FFmpeg (ou outra ferramenta) com o app aberto: procura de novo
  ctx.handle('app:refreshTools', () => ({ tools: { ...ctx.refreshTools() } }));

  // mostra um arquivo/pasta no Explorer: { path } (ou só o caminho)
  ctx.handle('shell:reveal', (payload) => {
    const target = typeof payload === 'string' ? payload : payload.path;
    if (typeof target !== 'string' || !target) {
      const err = new Error('Caminho inválido para mostrar na pasta.');
      err.code = 'INVALID_PATH';
      throw err;
    }
    ctx.shell.showItemInFolder(target);
    return {};
  });

  // Controles da janela sem moldura (o renderer desenha os botões). Todos respondem com o estado depois da ação
  // ({ maximized, fullscreen, minimized }); mudanças feitas por outros meios (duplo clique na barra, Win+setas)
  // chegam ao renderer pelo evento 'window:changed' (enviado pelo main.js, veja src/windowControls.js).
  ctx.handle('window:state', () => controls.windowState(ctx.getWindow()));
  ctx.handle('window:minimize', () => controls.minimize(ctx.getWindow()));
  ctx.handle('window:maximize', () => controls.toggleMaximize(ctx.getWindow()));
  ctx.handle('window:fullscreen', (payload) => controls.toggleFullscreen(ctx.getWindow(), { exit: Boolean(payload && payload.exit) }));
  ctx.handle('window:close', () => controls.close(ctx.getWindow()));
}

module.exports = { register };

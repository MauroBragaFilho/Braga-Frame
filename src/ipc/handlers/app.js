'use strict';

const fs = require('node:fs');
const path = require('node:path');
const appInfo = require('../../appInfo');
const diagnostics = require('../../diagnostics');
const encoders = require('../../core/export/encoders');
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

  // O que o usuário copia e manda para o suporte (tela Geral > Suporte): versão, sistema, placas de vídeo, ferramentas e o que o FFmpeg codifica.
  // Sem segredos nem conteúdo de projetos; a pasta pessoal sai como "~". `logFile` só vem se o arquivo de registro existe (a tela o mostra na pasta).
  ctx.handle('app:support', async () => {
    let gpus = [];
    try {
      if (typeof ctx.app.getGPUInfo === 'function') gpus = diagnostics.summarizeGpus(await ctx.app.getGPUInfo('basic'));
    } catch (err) { ctx.log('warn', `app:support: placas de vídeo indisponíveis (${err && err.message})`); }
    let detection = null;
    try {
      if (ctx.tools.ffmpeg) detection = await encoders.detectEncoders({ ffmpeg: ctx.tools.ffmpeg });
    } catch (err) { ctx.log('warn', `app:support: codificadores indisponíveis (${err && err.message})`); }
    const candidate = path.join(ctx.paths.userData, 'logs', 'bragaframe.log');
    const logFile = fs.existsSync(candidate) ? candidate : null;
    const report = diagnostics.collectDiagnostics({
      appName: appInfo.name, version: ctx.app.getVersion(), userDataDir: ctx.paths.userData, isPackaged: ctx.app.isPackaged
    });
    return { text: diagnostics.formatSupportReport(report, { gpus, encoders: detection, logFile }), logFile };
  });

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

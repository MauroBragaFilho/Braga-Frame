'use strict';

const fs = require('node:fs');
const path = require('node:path');
const appInfo = require('../../appInfo');
const diagnostics = require('../../diagnostics');
const encoders = require('../../core/export/encoders');
const update = require('../../core/update/check');

const UPDATE_CACHE_MS = 6 * 60 * 60 * 1000;
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

  // Aviso de versão nova (docs/atualizacao.md): consulta a última Release do projeto no GitHub e compara com a versão instalada. SÓ AVISA.
  // Sem erro, o resultado vale por 6 horas (abrir o app várias vezes não consulta várias vezes); `force` (o botão "Verificar agora") sempre consulta.
  // Dentro de outro aplicativo (BDS) o hospedeiro é quem atualiza: não consulta.
  let lastUpdate = null; // { at, result }
  ctx.handle('app:updateCheck', async (payload) => {
    const current = ctx.app.getVersion();
    if (ctx.host && ctx.host.embedded) return { status: 'disabled', reason: 'embedded', current };
    const force = Boolean(payload && payload.force === true);
    if (!force && lastUpdate && Date.now() - lastUpdate.at < UPDATE_CACHE_MS) return { ...lastUpdate.result, cached: true };
    const result = await update.checkForUpdate({
      currentVersion: current, repo: appInfo.repo, fetchImpl: ctx.fetch || undefined,
      base: update.apiBase(ctx.env, ctx.app.isPackaged)
    });
    if (result.status !== 'error') lastUpdate = { at: Date.now(), result };
    if (result.status === 'error') ctx.log('warn', `app:updateCheck: ${result.reason}`);
    return result;
  });

  // abre no navegador a página da Release achada pela última consulta (o endereço NUNCA vem do renderer: o main só abre o que ele mesmo conferiu)
  ctx.handle('app:updateOpen', async () => {
    const url = lastUpdate && lastUpdate.result.status === 'available' ? lastUpdate.result.url : null;
    if (!url || !update.isReleaseUrl(url, appInfo.repo)) {
      const err = new Error('Não há versão nova para abrir. Use "Verificar agora".');
      err.code = 'NO_UPDATE';
      throw err;
    }
    if (update.testMode(ctx.env, ctx.app.isPackaged)) return { opened: false, url, test: true }; // e2e: não abre o navegador da máquina
    await ctx.shell.openExternal(url);
    return { opened: true };
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

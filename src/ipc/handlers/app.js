'use strict';

const fs = require('node:fs');
const path = require('node:path');
const appInfo = require('../../appInfo');
const diagnostics = require('../../diagnostics');
const encoders = require('../../core/export/encoders');
const update = require('../../core/update/check');
const signature = require('../../core/update/signature');
const { UpdateManager } = require('../../core/update/UpdateManager');
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

  // Atualização (docs/atualizacao.md): o UpdateManager consulta a última Release do projeto no GitHub, baixa o instalador em segundo plano, CONFERE (tamanho,
  // SHA-256 da Release e assinatura digital) e instala quando o USUÁRIO escolhe (agora, ou quando fechar o app). Nunca instala sozinho. O resultado da
  // consulta vale 6 horas (`force`, o botão "Verificar agora", ignora). Dentro de outro aplicativo (BDS) o hospedeiro é quem atualiza: nada disto existe.
  const testMode = update.testMode(ctx.env, ctx.app.isPackaged);
  const updates = new UpdateManager({
    currentVersion: ctx.app.getVersion(), repo: appInfo.repo, dir: path.join(ctx.paths.userData, 'updates'),
    fetchImpl: ctx.fetch || undefined, base: update.apiBase(ctx.env, ctx.app.isPackaged), embedded: Boolean(ctx.host && ctx.host.embedded), testMode,
    allowHost: testMode ? (host) => ['127.0.0.1', 'localhost', '[::1]'].includes(host) : undefined, // o "GitHub" local do e2e
    quitApp: () => ctx.app.quit(),
    runningSignature: ctx.app.isPackaged ? () => signature.readSignature(process.execPath) : null, // em desenvolvimento o app em uso é o electron.exe: não vale
    busy: () => (ctx.toolUsage ? ctx.toolUsage.inUse('ffmpeg', 'ffmpeg') : null), // exportação, análise, legendas, cópia leve ou download em andamento
    log: (level, message) => ctx.log(level, message)
  });
  ctx.updates = updates;
  updates.on('state', (snapshot) => ctx.send('update:state', snapshot));
  updates.load().catch(() => {}); // a atualização já baixada de uma execução anterior, se ainda vale
  if (ctx.app && typeof ctx.app.on === 'function') {
    ctx.app.on('before-quit', () => { updates.cancel(); });
    ctx.app.on('quit', () => { updates.onQuit(); }); // "instalar quando eu fechar": abre o instalador em silêncio
  }

  ctx.handle('app:updateCheck', async (payload) => updates.check({ force: Boolean(payload && payload.force === true) }));
  ctx.handle('app:updateState', () => updates.snapshot());
  ctx.handle('app:updateDownload', () => { updates.download().catch(() => {}); return { started: true }; }); // o andamento e o resultado vêm por update:state
  ctx.handle('app:updateCancel', () => ({ cancelled: updates.cancel() }));
  ctx.handle('app:updateInstall', async (payload) => {
    const when = payload && ['now', 'quit', 'none'].includes(payload.when) ? payload.when : 'now';
    return updates.install({ when }); // BUSY, TAMPERED, NO_READY, INSTALL_FAILED viram { ok:false, code, message }
  });

  // abre no navegador a página da Release achada pela última consulta (o endereço NUNCA vem do renderer: o main só abre o que ele mesmo conferiu)
  ctx.handle('app:updateOpen', async () => {
    const last = updates.snapshot().check;
    const url = last && last.status === 'available' ? last.url : null;
    if (!url || !update.isReleaseUrl(url, appInfo.repo)) {
      const err = new Error('Não há versão nova para abrir. Use "Verificar agora".');
      err.code = 'NO_UPDATE';
      throw err;
    }
    if (testMode) return { opened: false, url, test: true }; // e2e: não abre o navegador da máquina
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

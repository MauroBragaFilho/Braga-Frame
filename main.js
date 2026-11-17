'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const appInfo = require('./src/appInfo');
const { createBfModule } = require('./src/host');
const { parseCli } = require('./src/host/cli');
const { setupSingleInstance, focusWindow } = require('./src/singleInstance');
const { watchWindow } = require('./src/windowControls');
const { createFileLogger, installCrashHandlers } = require('./src/logging');
const { collectDiagnostics, formatDiagnostics } = require('./src/diagnostics');

let win = null;
// Os handlers do processo principal vivem no módulo (src/host): o app próprio o usa como o Braga Digital Studio o usaria.
let bf = null;

function createWindow() {
  // Janela sem moldura: a interface desenha a barra e os botões (renderer/index.html), como no Braga Digital Studio.
  // O fundo é o do tema escuro (padrão) para não piscar branco antes de a interface carregar.
  win = new BrowserWindow({
    width: 1360, height: 840, minWidth: 900, minHeight: 600, title: appInfo.name,
    frame: false,
    backgroundColor: '#000000',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.removeMenu();
  // maximizar/restaurar/tela cheia por qualquer meio (duplo clique na barra, Win+setas) chegam ao renderer
  watchWindow(win, (channel, payload) => { if (bf) bf.send(channel, payload); });
  win.on('closed', () => { win = null; });
  // a interface nunca navega para fora de index.html (soltar um arquivo na janela não pode abri-lo)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    // recarregar o próprio index.html (com ou sem ?embedded=1) é permitido; qualquer outro destino não
    const strip = (u) => u.split(/[?#]/)[0];
    if (strip(url) !== strip(win.webContents.getURL())) event.preventDefault();
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Abrir com um vídeo: `BragaFrame.exe "C:\Videos\jogo.mp4"` (ou `npm start -- "C:\Videos\jogo.mp4"`). O argumento é só um caminho,
// conferido em src/host/cli.js; quem decide o que fazer com ele é a interface (ela busca o pedido ao carregar).
const startupRequests = [parseCli(process.argv)]; // + as de segundas instâncias que chegarem antes de o módulo existir

// A segunda instância (por exemplo, o BDS abrindo um vídeo) manda os argumentos dela para esta, que abre o vídeo e vem para a frente.
function onSecondInstance({ argv }) {
  if (bf) bf.requestOpen(parseCli(argv));
  else startupRequests.push(parseCli(argv));
  focusWindow(win);
}

// uma instância por perfil: a segunda só traz a primeira para a frente (e, se veio com um vídeo, passa o caminho) e encerra
// (veja src/singleInstance.js)
if (setupSingleInstance(app, onSecondInstance)) {
  app.whenReady().then(() => {
    const logger = createFileLogger({ dir: path.join(app.getPath('userData'), 'logs') });
    installCrashHandlers(logger);
    logger.info(formatDiagnostics(collectDiagnostics({
      version: app.getVersion(), userDataDir: app.getPath('userData'), isPackaged: app.isPackaged
    })));
    app.on('render-process-gone', (_event, _contents, details) => logger.error('render-process-gone:', details));
    app.on('child-process-gone', (_event, details) => logger.warn('child-process-gone:', details));
    bf = createBfModule({
      ipcMain, app, dialog, shell,
      getWindow: () => win,
      userDataDir: app.getPath('userData'),
      windowControls: true, // janela sem moldura: a interface desenha minimizar/maximizar/fechar
      log: logger
    });
    bf.register();
    for (const request of startupRequests.splice(0)) bf.requestOpen(request);
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

'use strict';

/**
 * Mini "app hospedeiro" de teste: faz o papel do Braga Digital Studio (src/host/index.js e docs/modulo-bds.md).
 * Abre UMA janela com host.html, que carrega o Braga Frame num <iframe ?embedded=1>, e registra UM canal genérico
 * (host:bf-invoke) que repassa para createBfModule().invoke, com channelPrefix "bf:" e uma pasta de dados própria.
 *
 * Parâmetros (linha de comando e ambiente, só para o teste):
 *   --bf-src=<url>            URL de renderer/index.html do Braga Frame (padrão: o da pasta HOST_BF_ROOT, ou da raiz do repositório)
 *   HOST_BF_ROOT              pasta do Braga Frame (padrão: a raiz do repositório)
 *   HOST_PICK_FILE            caminho que o "diálogo de arquivo" falso devolve ao source:pick
 *   HOST_TOOLS                JSON { ffmpeg, ffprobe, … } com as ferramentas do hospedeiro (options.tools)
 *   HOST_PAGE                 página do hospedeiro (padrão host.html)
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
// HOST_BF_ROOT: pasta do Braga Frame a usar (o teste aponta para uma cópia só com renderer/, src/ e package.json, como no BDS)
const BF_ROOT = process.env.HOST_BF_ROOT || ROOT;
const { createBfModule } = require(path.join(BF_ROOT, 'src', 'host'));
const flag = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

let win = null;
let bf = null;
const stats = { invokes: 0, channels: [], refused: 0, events: 0 };

// Como o registrador do BDS: só o frame principal da página do hospedeiro pode chamar (sub-frames são recusados).
function trusted(event) {
  const frame = event && event.senderFrame;
  return Boolean(frame) && frame.parent == null && /host[^/\\]*\.html$/i.test(frame.url.split(/[?#]/)[0]);
}

function setup() {
  const fakeDialog = {
    async showOpenDialog() {
      const file = process.env.HOST_PICK_FILE;
      return file ? { canceled: false, filePaths: [file] } : { canceled: true, filePaths: [] };
    }
  };
  let tools;
  try { tools = process.env.HOST_TOOLS ? JSON.parse(process.env.HOST_TOOLS) : undefined; } catch { tools = undefined; }

  bf = createBfModule({
    app, dialog: fakeDialog, shell,
    getWindow: () => win,
    userDataDir: path.join(app.getPath('userData'), 'braga-frame'),
    channelPrefix: 'bf:',
    tools,
    // eventos do módulo -> um único canal para a página do hospedeiro, que os entrega ao iframe
    send: (channel, payload) => {
      stats.events += 1;
      if (win && !win.isDestroyed()) win.webContents.send('host:bf-event', { channel, payload });
    },
    log: () => {} // silencioso; o teste olha o resultado, não o log
  });

  ipcMain.handle('host:config', (event) => {
    if (!trusted(event)) return null;
    return {
      frameSrc: flag('bf-src') || pathToFileURL(path.join(BF_ROOT, 'renderer', 'index.html')).href,
      userDataDir: bf.userDataDir,
      hostUserData: app.getPath('userData')
    };
  });

  // O canal genérico: tudo do Braga Frame passa por aqui
  ipcMain.handle('host:bf-invoke', (event, channel, payload) => {
    if (!trusted(event)) { stats.refused += 1; return { ok: false, code: 'EFORBIDDEN', message: 'Origem da chamada não autorizada.' }; }
    stats.invokes += 1;
    stats.channels.push(String(channel));
    return bf.invoke(channel, payload, event);
  });

  // auxiliares do teste (não existiriam no BDS)
  ipcMain.handle('host:stats', (event) => {
    if (!trusted(event)) return null;
    return { ...stats, channels: stats.channels.slice(-50), disposed: bf.disposed, registered: bf.registered, moduleChannels: bf.channels().length, prefix: bf.channelPrefix };
  });
  ipcMain.handle('host:emit', (event, channel, payload) => { if (trusted(event)) bf.send(channel, payload); return true; });
  ipcMain.handle('host:open-video', (event, file) => (trusted(event) ? bf.requestOpen(file) : false));
  ipcMain.handle('host:dispose', (event) => {
    if (!trusted(event)) return false;
    bf.dispose();
    return true;
  });
}

function createWindow() {
  // mesmas opções de segurança do BDS: preload com sandbox, sem nodeIntegration (nem nos subframes)
  win = new BrowserWindow({
    width: 1400, height: 860, show: true, title: 'Hospedeiro de teste',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(__dirname, process.env.HOST_PAGE || 'host.html'));
}

app.whenReady().then(() => {
  setup();
  createWindow();
});

app.on('window-all-closed', () => { app.quit(); });

'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Em sandbox o preload só pode usar 'electron': o formato de canal fica aqui, igual ao de src/ipc/context.js.
// Só existe resposta para canais que algum handler registrou no processo principal (essa é a lista permitida).
const CHANNEL_RE = /^[a-z][a-zA-Z0-9]*:[a-zA-Z0-9]+$/;

function assertChannel(channel) {
  if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) {
    throw new Error(`Canal IPC inválido: "${String(channel)}". Use "<recurso>:<acao>".`);
  }
}

contextBridge.exposeInMainWorld('bf', {
  /** Chama um handler do processo principal. Resolve com { ok:true, ... } ou { ok:false, code, message }. */
  invoke: (channel, payload) => {
    try { assertChannel(channel); } catch (err) { return Promise.reject(err); }
    return ipcRenderer.invoke(channel, payload);
  },
  /** Escuta um evento enviado pelo processo principal; devolve a função que cancela a escuta. */
  on: (channel, callback) => {
    assertChannel(channel);
    if (typeof callback !== 'function') throw new Error('on(canal, callback): o callback precisa ser uma função.');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  /** Caminho real de um arquivo solto na janela (arrastar e soltar). */
  pathForFile: (file) => webUtils.getPathForFile(file)
});

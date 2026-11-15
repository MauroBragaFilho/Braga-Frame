'use strict';

// Preload do hospedeiro de teste: o equivalente ao `window.bds` do BDS (bfInvoke / onBfEvent / getPathForFile).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('hostApi', {
  config: () => ipcRenderer.invoke('host:config'),
  // UM canal genérico para tudo do Braga Frame
  invoke: (channel, payload) => ipcRenderer.invoke('host:bf-invoke', channel, payload),
  onEvent: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, evt) => callback(evt);
    ipcRenderer.on('host:bf-event', listener);
    return () => ipcRenderer.removeListener('host:bf-event', listener);
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  // só para o teste
  stats: () => ipcRenderer.invoke('host:stats'),
  emit: (channel, payload) => ipcRenderer.invoke('host:emit', channel, payload),
  openVideo: (file) => ipcRenderer.invoke('host:open-video', file),
  dispose: () => ipcRenderer.invoke('host:dispose')
});

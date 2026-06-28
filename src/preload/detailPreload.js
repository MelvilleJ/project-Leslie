'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('detail', {
  onBegin: (cb) => ipcRenderer.on('detail:begin', (_e, data) => cb(data || {})),
  onChunk: (cb) => ipcRenderer.on('detail:chunk', (_e, text) => cb(text)),
  onEnd: (cb) => ipcRenderer.on('detail:end', () => cb()),
  onUrl: (cb) => ipcRenderer.on('detail:url', (_e, url) => cb(url))
});

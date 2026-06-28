'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the detail window. The main process pushes detailed-answer text
// (begin/chunk/end) or a URL to display in the embedded web view.
contextBridge.exposeInMainWorld('detail', {
  onBegin: (cb) => ipcRenderer.on('detail:begin', (_e, data) => cb(data || {})),
  onChunk: (cb) => ipcRenderer.on('detail:chunk', (_e, text) => cb(text)),
  onEnd: (cb) => ipcRenderer.on('detail:end', () => cb()),
  onUrl: (cb) => ipcRenderer.on('detail:url', (_e, url) => cb(url))
});

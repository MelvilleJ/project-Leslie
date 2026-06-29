'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('detail', {
  onBegin: (cb) => ipcRenderer.on('detail:begin', (_e, data) => cb(data || {})),
  onChunk: (cb) => ipcRenderer.on('detail:chunk', (_e, text) => cb(text)),
  onEnd: (cb) => ipcRenderer.on('detail:end', () => cb()),
  onUrl: (cb) => ipcRenderer.on('detail:url', (_e, url) => cb(url)),

  // --- Theme accent ---------------------------------------------------------
  /** Current accent colour (hex). @returns {Promise<string>} */
  getAccent: () => ipcRenderer.invoke('theme:get'),
  /** Set the accent colour; persists and syncs every window. @returns {Promise<string>} */
  setAccent: (color) => ipcRenderer.invoke('theme:set', color),
  /** Subscribe to accent changes from any window. */
  onTheme: (cb) => ipcRenderer.on('theme:changed', (_e, color) => cb(color))
});

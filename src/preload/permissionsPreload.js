'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('permissions', {
  /** Prompts already waiting when the window loads. @returns {Promise<object[]>} */
  list: () => ipcRenderer.invoke('permissions:list'),
  respond: (id, payload) => ipcRenderer.invoke('permissions:respond', { id, payload }),
  onAdd: (cb) => ipcRenderer.on('permissions:add', (_e, prompt) => cb(prompt)),
  onRemove: (cb) => ipcRenderer.on('permissions:remove', (_e, id) => cb(id)),

  getAccent: () => ipcRenderer.invoke('theme:get'),
  onTheme: (cb) => ipcRenderer.on('theme:changed', (_e, color) => cb(color))
});

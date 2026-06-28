'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceBridge', {
  onInit: (cb) => ipcRenderer.on('voice:init', (_e, cfg) => cb(cfg || {})),
  onControl: (cb) => ipcRenderer.on('voice:control', (_e, msg) => cb(msg || {})),
  wake: (payload) => ipcRenderer.send('voice:wake', payload || {}),
  final: (payload) => ipcRenderer.send('voice:final', payload || {}),
  status: (payload) => ipcRenderer.send('voice:status', payload || {})
});

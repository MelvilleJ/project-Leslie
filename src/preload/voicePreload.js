'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the hidden voice window. The pipeline (bundled voice.js) reports
// wake/command/status to main; main pushes config (init) and controls back.
contextBridge.exposeInMainWorld('voiceBridge', {
  // main -> voice
  onInit: (cb) => ipcRenderer.on('voice:init', (_e, cfg) => cb(cfg || {})),
  onControl: (cb) => ipcRenderer.on('voice:control', (_e, msg) => cb(msg || {})),
  // voice -> main
  wake: (payload) => ipcRenderer.send('voice:wake', payload || {}),
  final: (payload) => ipcRenderer.send('voice:final', payload || {}),
  status: (payload) => ipcRenderer.send('voice:status', payload || {})
});

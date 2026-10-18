'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Every call resolves { ok, data | error } unless noted.
contextBridge.exposeInMainWorld('setupApi', {
  info: () => ipcRenderer.invoke('setup:info'),
  checks: (choices) => ipcRenderer.invoke('setup:checks', choices),
  downloadBytes: (choices) => ipcRenderer.invoke('setup:download-bytes', choices),
  installPackages: (pkgs) => ipcRenderer.invoke('setup:install-packages', pkgs),
  monitors: () => ipcRenderer.invoke('setup:monitors'),
  cameras: () => ipcRenderer.invoke('setup:cameras'),
  /** { kind: 'searxng' | 'server', url } → { ok, error?, models? } */
  testUrl: (kind, url) => ipcRenderer.invoke('setup:test-url', { kind, url }),
  save: (choices) => ipcRenderer.invoke('setup:save', choices),
  prefetch: (choices) => ipcRenderer.invoke('setup:prefetch', choices),
  run: (choices, force) => ipcRenderer.invoke('setup:run', { choices, force }),
  cancel: () => ipcRenderer.invoke('setup:cancel'),
  adopt: () => ipcRenderer.invoke('setup:adopt'),
  finish: (panel) => ipcRenderer.invoke('setup:finish', { panel }),
  /** Resolves { samples, sampleRate } or null. */
  ttsPreview: (voice) => ipcRenderer.invoke('tts:preview', voice),
  /** { type: 'plan', tasks } | { type: 'task', id, status, error? } | { type: 'progress', id, text, fraction? } */
  onEvent: (cb) => {
    const l = (_e, ev) => cb(ev || {});
    ipcRenderer.on('setup:event', l);
    return () => ipcRenderer.removeListener('setup:event', l);
  }
});

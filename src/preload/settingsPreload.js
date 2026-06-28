'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  /** The editable-field schema (plain data) used to build the form. */
  getSchema: () => ipcRenderer.invoke('settings:schema'),
  /** Current values of every editable field + the active mode. */
  getConfig: () => ipcRenderer.invoke('settings:get-all'),
  /** Update one field; returns the coerced/applied value. */
  setConfig: (key, value) => ipcRenderer.invoke('settings:set', { key, value }),
  /** Switch operating mode ('chat'|'plan'|'agent'); returns the applied mode. */
  setMode: (mode) => ipcRenderer.invoke('agent:set-mode', mode),
  /** React to mode changes from elsewhere (tray, companion button). */
  onMode: (cb) => {
    const l = (_e, mode) => cb(mode);
    ipcRenderer.on('agent:mode', l);
    return () => ipcRenderer.removeListener('agent:mode', l);
  },
  /** A config field changed elsewhere (e.g. the tray's learning toggle). */
  onConfigChanged: (cb) => {
    const l = (_e, data) => cb(data || {});
    ipcRenderer.on('settings:config-changed', l);
    return () => ipcRenderer.removeListener('settings:config-changed', l);
  },
  /** The conversation list changed (e.g. a new conversation from the tray). */
  onConversationsChanged: (cb) => {
    const l = () => cb();
    ipcRenderer.on('settings:conversations-changed', l);
    return () => ipcRenderer.removeListener('settings:conversations-changed', l);
  },

  /** List models advertised by the configured server (/v1/models). */
  listModels: () => ipcRenderer.invoke('models:list'),
  /** Probe the configured server; returns { ok } or { ok:false, error }. */
  testConnection: () => ipcRenderer.invoke('models:test'),

  listConversations: () => ipcRenderer.invoke('conv:list'),
  getConversation: (id) => ipcRenderer.invoke('conv:get', id),
  resumeConversation: (id) => ipcRenderer.invoke('conv:resume', id),
  deleteConversation: (id) => ipcRenderer.invoke('conv:delete', id),
  clearConversations: () => ipcRenderer.invoke('conv:clear'),
  newConversation: () => ipcRenderer.invoke('conv:new'),

  listMemories: () => ipcRenderer.invoke('memory:list'),
  deleteMemory: (id) => ipcRenderer.invoke('memory:delete', id),
  clearMemories: () => ipcRenderer.invoke('memory:clear'),

  /** One live CPU/GPU/RAM/app sample. Poll on an interval from the renderer. */
  sampleSystem: () => ipcRenderer.invoke('sys:sample')
});

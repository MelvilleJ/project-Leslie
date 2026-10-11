'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  /** The editable-field schema (plain data) used to build the form. */
  getSchema: () => ipcRenderer.invoke('settings:schema'),
  /** Current values of every editable field + the active mode. */
  getConfig: () => ipcRenderer.invoke('settings:get-all'),
  /** Update one field; returns the coerced/applied value. */
  setConfig: (key, value) => ipcRenderer.invoke('settings:set', { key, value }),
  /** Switch operating mode ('chat'|'plan'|'agent'|'assistant'); returns the applied mode. */
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
  /** Model server (llama.cpp) — each resolves { ok, data | error }. */
  server: {
    status: () => ipcRenderer.invoke('server:status'),
    switchTo: (profile) => ipcRenderer.invoke('server:switch', profile),
    service: (action) => ipcRenderer.invoke('server:service', action),
    unload: () => ipcRenderer.invoke('server:unload'),
    logs: () => ipcRenderer.invoke('server:logs'),
    settings: () => ipcRenderer.invoke('server:settings'),
    save: (patch) => ipcRenderer.invoke('server:save', patch),
    models: () => ipcRenderer.invoke('server:models'),
    /** { type: 'status', status } | { type: 'progress', text } */
    onEvent: (cb) => {
      const l = (_e, ev) => cb(ev || {});
      ipcRenderer.on('server:event', l);
      return () => ipcRenderer.removeListener('server:event', l);
    }
  },
  onShowPanel: (cb) => {
    const l = (_e, panel) => cb(panel);
    ipcRenderer.on('settings:show-panel', l);
    return () => ipcRenderer.removeListener('settings:show-panel', l);
  },
  pi: (name, args) => ipcRenderer.invoke('pi:command', { name, args }),
  onPiEvent: (cb) => {
    const l = (_e, ev) => cb(ev || {});
    ipcRenderer.on('pi:event', l);
    return () => ipcRenderer.removeListener('pi:event', l);
  },
  listModels: () => ipcRenderer.invoke('models:list'),
  /** Probe the configured server; returns { ok } or { ok:false, error }. */
  testConnection: () => ipcRenderer.invoke('models:test'),

  listConversations: () => ipcRenderer.invoke('conv:list'),
  getConversation: (id) => ipcRenderer.invoke('conv:get', id),
  resumeConversation: (id) => ipcRenderer.invoke('conv:resume', id),
  deleteConversation: (id) => ipcRenderer.invoke('conv:delete', id),
  newConversation: () => ipcRenderer.invoke('conv:new'),

  listMemories: () => ipcRenderer.invoke('memory:list'),
  deleteMemory: (id) => ipcRenderer.invoke('memory:delete', id),
  clearMemories: () => ipcRenderer.invoke('memory:clear'),

  /** One live CPU/GPU/RAM/app sample. Poll on an interval from the renderer. */
  sampleSystem: () => ipcRenderer.invoke('sys:sample'),

  // --- Theme accent ---------------------------------------------------------
  /** Current accent colour (hex). @returns {Promise<string>} */
  getAccent: () => ipcRenderer.invoke('theme:get'),
  /** Set the accent colour; persists and syncs every window. @returns {Promise<string>} */
  setAccent: (color) => ipcRenderer.invoke('theme:set', color),
  /** Subscribe to accent changes from any window. */
  onTheme: (cb) => ipcRenderer.on('theme:changed', (_e, color) => cb(color)),

  // --- Speech + shortcuts ----------------------------------------------------
  /** Synthesize the preview line in `voice` (even while muted). */
  ttsPreview: (voice) => ipcRenderer.invoke('tts:preview', voice),
  /** { shortcuts, tools } — tools carry name/description/parameters for the editor. */
  getShortcuts: () => ipcRenderer.invoke('shortcuts:get'),
  saveShortcuts: (list) => ipcRenderer.invoke('shortcuts:save', list),

  // --- Animations -----------------------------------------------------------
  /** Library + bindings: { clips, bindings, states }. */
  getAnimations: () => ipcRenderer.invoke('anim:config'),
  /** Open file dialogs to import a spritesheet (.aseprite, or PNG + optional .css grid). */
  importAnimation: () => ipcRenderer.invoke('anim:import'),
  /** Patch an uploaded clip's name/grid/speed. */
  updateClip: (id, patch) => ipcRenderer.invoke('anim:update', { id, patch }),
  /** Delete an uploaded clip. */
  deleteAnimation: (id) => ipcRenderer.invoke('anim:delete', id),
  /** Bind a state to clip id(s). */
  setBinding: (state, ids) => ipcRenderer.invoke('anim:set-binding', { state, ids }),
  /** Wardrobe: { mode, outfit, schedule, periods, period, current, catalog, slots }. */
  getWardrobe: () => ipcRenderer.invoke('wardrobe:get'),
  /** Patch { mode } | { outfit: { slot: item } } | { schedule: { period: { slot: item } } }; resolves the new state. */
  setWardrobe: (patch) => ipcRenderer.invoke('wardrobe:set', patch),
  /** Subscribe to live animation-config changes. */
  onAnimationsChanged: (cb) => {
    const l = (_e, cfg) => cb(cfg || {});
    ipcRenderer.on('animations:changed', l);
    return () => ipcRenderer.removeListener('animations:changed', l);
  }
});

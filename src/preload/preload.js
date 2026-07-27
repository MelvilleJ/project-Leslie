'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('leslie', {
  sendMessage: (text, mentions) => ipcRenderer.invoke('agent:message', { text, mentions: mentions || [] }),
  suggestPaths: (query) => ipcRenderer.invoke('fs:suggest', query),
  onAgentChunk: (callback) => {
    const listener = (_event, delta) => callback(delta);
    ipcRenderer.on('agent:chunk', listener);
    return () => ipcRenderer.removeListener('agent:chunk', listener);
  },
  onAgentThink: (callback) => {
    const listener = (_event, delta) => callback(delta);
    ipcRenderer.on('agent:think', listener);
    return () => ipcRenderer.removeListener('agent:think', listener);
  },
  onToDetails: (callback) => {
    const listener = (_event, info) => callback(info || {});
    ipcRenderer.on('agent:to-details', listener);
    return () => ipcRenderer.removeListener('agent:to-details', listener);
  },
  resetChat: () => ipcRenderer.invoke('agent:reset'),
  cancel: () => ipcRenderer.send('agent:cancel'),
  runResearch: (query) => ipcRenderer.invoke('research:run', query),
  onResearchProgress: (cb) => {
    const l = (_e, e) => cb(e || {});
    ipcRenderer.on('research:progress', l);
    return () => ipcRenderer.removeListener('research:progress', l);
  },
  onConfirm: (callback) => {
    const listener = (_event, req) => callback(req || {});
    ipcRenderer.on('agent:confirm', listener);
    return () => ipcRenderer.removeListener('agent:confirm', listener);
  },
  confirmResponse: (id, approved) =>
    ipcRenderer.invoke('agent:confirm-response', { id, approved }),
  getMode: () => ipcRenderer.invoke('agent:get-mode'),
  setMode: (mode) => ipcRenderer.invoke('agent:set-mode', mode),
  onMode: (callback) => {
    const listener = (_event, mode) => callback(mode);
    ipcRenderer.on('agent:mode', listener);
    return () => ipcRenderer.removeListener('agent:mode', listener);
  },

  fitHeight: (px) => ipcRenderer.send('window:fit-height', px),

  hide: () => ipcRenderer.send('window:hide'),

  /** Expand (show chat panel) or collapse (mascot only). */
  setExpanded: (on) => ipcRenderer.send('window:set-expanded', !!on),

  onVoiceWake: (cb) => {
    const l = (_e, data) => cb(data || {});
    ipcRenderer.on('leslie:voice-wake', l);
    return () => ipcRenderer.removeListener('leslie:voice-wake', l);
  },
  onVoiceFinal: (cb) => {
    const l = (_e, data) => cb(data || {});
    ipcRenderer.on('leslie:voice-final', l);
    return () => ipcRenderer.removeListener('leslie:voice-final', l);
  },
  onVoiceStatus: (cb) => {
    const l = (_e, data) => cb(data || {});
    ipcRenderer.on('leslie:voice-status', l);
    return () => ipcRenderer.removeListener('leslie:voice-status', l);
  },
  setVoiceActive: (on) => ipcRenderer.send('voice:set-active', on),
  voiceListenOnce: () => ipcRenderer.send('voice:listen-once'),

  openSettings: () => ipcRenderer.send('settings:open'),

  getAccent: () => ipcRenderer.invoke('theme:get'),
  onTheme: (cb) => ipcRenderer.on('theme:changed', (_e, color) => cb(color)),

  getAnimations: () => ipcRenderer.invoke('anim:config'),
  onAnimations: (cb) => {
    const l = (_e, cfg) => cb(cfg || {});
    ipcRenderer.on('animations:changed', l);
    return () => ipcRenderer.removeListener('animations:changed', l);
  },
  /**
   * Tool activity. Callback receives { phase: 'start'|'end', id, name, detail?, ok? }.
   */
  onToolCall: (cb) => {
    const l = (_e, ev) => cb(ev || {});
    ipcRenderer.on('agent:tool', l);
    return () => ipcRenderer.removeListener('agent:tool', l);
  },
  onWindowMoved: (cb) => {
    const l = () => cb();
    ipcRenderer.on('window:moved', l);
    return () => ipcRenderer.removeListener('window:moved', l);
  },
  /** The companion window lost focus (used to auto-collapse to the mascot). */
  onWindowBlur: (cb) => {
    const l = () => cb();
    ipcRenderer.on('window:blur', l);
    return () => ipcRenderer.removeListener('window:blur', l);
  },

  quit: () => ipcRenderer.send('app:quit'),
  onAgentSay: (callback) => {
    const listener = (_event, text) => callback(text);
    ipcRenderer.on('agent:say', listener);
    return () => ipcRenderer.removeListener('agent:say', listener);
  }
});

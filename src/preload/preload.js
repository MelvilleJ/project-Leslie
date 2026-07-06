'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('leslie', {
  /**
   * Send a message to the agent and await its full reply.
   * Token deltas arrive via onAgentChunk while this is pending.
   * @param {string} text
   * @param {{path:string,type:string}[]} [mentions] "@" file/folder attachments to expand into context.
   * @returns {Promise<{ reply: string } | { error: string }>}
   */
  sendMessage: (text, mentions) => ipcRenderer.invoke('agent:message', { text, mentions: mentions || [] }),

  /**
   * Autocomplete file/folder paths for the "@" picker.
   * @param {string} query text typed after "@"
   * @returns {Promise<{ items: {name:string,path:string,type:string}[], sep:string }>}
   */
  suggestPaths: (query) => ipcRenderer.invoke('fs:suggest', query),

  /**
   * Subscribe to streamed answer tokens.
   * @param {(delta: string) => void} callback
   * @returns {() => void} unsubscribe
   */
  onAgentChunk: (callback) => {
    const listener = (_event, delta) => callback(delta);
    ipcRenderer.on('agent:chunk', listener);
    return () => ipcRenderer.removeListener('agent:chunk', listener);
  },

  /**
   * Subscribe to streamed reasoning ("thinking") tokens.
   * @param {(delta: string) => void} callback
   * @returns {() => void} unsubscribe
   */
  onAgentThink: (callback) => {
    const listener = (_event, delta) => callback(delta);
    ipcRenderer.on('agent:think', listener);
    return () => ipcRenderer.removeListener('agent:think', listener);
  },

  /**
   * Subscribe to "answer moved to the details window" notices (fired when a
   * reply grows past the sentence threshold mid-stream).
   * @param {(info: { teaser: string }) => void} callback
   * @returns {() => void} unsubscribe
   */
  onToDetails: (callback) => {
    const listener = (_event, info) => callback(info || {});
    ipcRenderer.on('agent:to-details', listener);
    return () => ipcRenderer.removeListener('agent:to-details', listener);
  },

  /** Clear the conversation history. */
  resetChat: () => ipcRenderer.invoke('agent:reset'),

  /**
   * Subscribe to confirmation requests (agent mode wants to run a command).
   * @param {(req: { id: string, message: string }) => void} callback
   * @returns {() => void} unsubscribe
   */
  onConfirm: (callback) => {
    const listener = (_event, req) => callback(req || {});
    ipcRenderer.on('agent:confirm', listener);
    return () => ipcRenderer.removeListener('agent:confirm', listener);
  },

  /** Answer a confirmation request with the user's choice. */
  confirmResponse: (id, approved) =>
    ipcRenderer.invoke('agent:confirm-response', { id, approved }),

  /** Current operating mode. @returns {Promise<'chat'|'plan'|'agent'>} */
  getMode: () => ipcRenderer.invoke('agent:get-mode'),

  /** Switch mode. @param {'chat'|'plan'|'agent'} mode @returns {Promise<string>} resulting mode. */
  setMode: (mode) => ipcRenderer.invoke('agent:set-mode', mode),

  /**
   * Subscribe to mode changes (e.g. switched from the tray).
   * @param {(mode: 'chat'|'plan'|'agent') => void} callback
   * @returns {() => void} unsubscribe
   */
  onMode: (callback) => {
    const listener = (_event, mode) => callback(mode);
    ipcRenderer.on('agent:mode', listener);
    return () => ipcRenderer.removeListener('agent:mode', listener);
  },

  /** Ask the main process to resize the window to fit content (bottom-pinned). */
  fitHeight: (px) => ipcRenderer.send('window:fit-height', px),

  /** Hide the companion window to the tray. */
  hide: () => ipcRenderer.send('window:hide'),

  /** Wake word heard: { command } (command may be empty). */
  onVoiceWake: (cb) => {
    const l = (_e, data) => cb(data || {});
    ipcRenderer.on('leslie:voice-wake', l);
    return () => ipcRenderer.removeListener('leslie:voice-wake', l);
  },
  /** A dictated command is ready: { text }. */
  onVoiceFinal: (cb) => {
    const l = (_e, data) => cb(data || {});
    ipcRenderer.on('leslie:voice-final', l);
    return () => ipcRenderer.removeListener('leslie:voice-final', l);
  },
  /** Pipeline status: { state, message }. */
  onVoiceStatus: (cb) => {
    const l = (_e, data) => cb(data || {});
    ipcRenderer.on('leslie:voice-status', l);
    return () => ipcRenderer.removeListener('leslie:voice-status', l);
  },
  /** Enable/disable listening. */
  setVoiceActive: (on) => ipcRenderer.send('voice:set-active', on),
  /** Push-to-talk: dictate the next utterance without the wake word. */
  voiceListenOnce: () => ipcRenderer.send('voice:listen-once'),

  /** Open the settings / application menu window. */
  openSettings: () => ipcRenderer.send('settings:open'),

  /** Current accent colour (hex). @returns {Promise<string>} */
  getAccent: () => ipcRenderer.invoke('theme:get'),
  /** Subscribe to accent changes (e.g. picked in the details window). */
  onTheme: (cb) => ipcRenderer.on('theme:changed', (_e, color) => cb(color)),

  // --- Animations -----------------------------------------------------------
  /** The animation library + state bindings. @returns {Promise<{clips,bindings,states}>} */
  getAnimations: () => ipcRenderer.invoke('anim:config'),
  /** Subscribe to live animation-config changes (edited in settings). */
  onAnimations: (cb) => {
    const l = (_e, cfg) => cb(cfg || {});
    ipcRenderer.on('animations:changed', l);
    return () => ipcRenderer.removeListener('animations:changed', l);
  },
  /** A tool call started: callback receives the tool name. */
  onToolCall: (cb) => {
    const l = (_e, name) => cb(name);
    ipcRenderer.on('agent:tool', l);
    return () => ipcRenderer.removeListener('agent:tool', l);
  },
  /** The companion window is being dragged. */
  onWindowMoved: (cb) => {
    const l = () => cb();
    ipcRenderer.on('window:moved', l);
    return () => ipcRenderer.removeListener('window:moved', l);
  },

  /** Quit the whole app (tray included). */
  quit: () => ipcRenderer.send('app:quit'),

  /**
   * Subscribe to unprompted things the agent wants to say.
   * @param {(text: string) => void} callback
   * @returns {() => void} unsubscribe
   */
  onAgentSay: (callback) => {
    const listener = (_event, text) => callback(text);
    ipcRenderer.on('agent:say', listener);
    return () => ipcRenderer.removeListener('agent:say', listener);
  }
});

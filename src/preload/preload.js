'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('leslie', {
  sendMessage: (text, mentions, images) =>
    ipcRenderer.invoke('agent:message', { text, mentions: mentions || [], images: images || [] }),

  presence: () => ipcRenderer.invoke('presence:get'),
  /** A doc comment sent to Leslie: run it as a turn, then hand the reply back. */
  onDocsAsk: (cb) => {
    const l = (_event, ask) => cb(ask);
    ipcRenderer.on('docs:ask', l);
    return () => ipcRenderer.removeListener('docs:ask', l);
  },
  docsAnswer: (id, res) => ipcRenderer.send('docs:answer', { id, reply: res && res.reply, error: res && res.error }),
  /** A finger to the lips: stop speaking (the reply itself carries on). */
  onHush: (cb) => {
    const l = () => cb();
    ipcRenderer.on('leslie:hush', l);
    return () => ipcRenderer.removeListener('leslie:hush', l);
  },
  onPresence: (cb) => {
    const l = (_e, snap) => cb(snap || {});
    ipcRenderer.on('leslie:presence', l);
    return () => ipcRenderer.removeListener('leslie:presence', l);
  },
  recordingState: () => ipcRenderer.invoke('recording:state'),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  onRecording: (cb) => {
    const l = (_e, state) => cb(state || {});
    ipcRenderer.on('recording:state', l);
    return () => ipcRenderer.removeListener('recording:state', l);
  },
  /** Run a pi backend command (model, thinking, compact, fork, …). Resolves { ok, data | error }. */
  pi: (name, args) => ipcRenderer.invoke('pi:command', { name, args }),
  piBash: (command, excludeFromContext) => ipcRenderer.invoke('pi:bash', { command, excludeFromContext }),
  onPiBashChunk: (cb) => {
    const l = (_e, delta) => cb(delta);
    ipcRenderer.on('pi:bash-chunk', l);
    return () => ipcRenderer.removeListener('pi:bash-chunk', l);
  },
  /** pi session events: state, queue, compaction, retry, ui dialogs, notify, status, session. */
  onPiEvent: (cb) => {
    const l = (_e, ev) => cb(ev || {});
    ipcRenderer.on('pi:event', l);
    return () => ipcRenderer.removeListener('pi:event', l);
  },
  suggestPaths: (query) => ipcRenderer.invoke('fs:suggest', query),
  onAgentChunk: (callback) => {
    const listener = (_event, delta) => callback(delta);
    ipcRenderer.on('agent:chunk', listener);
    return () => ipcRenderer.removeListener('agent:chunk', listener);
  },
  /** pi delivered a queued (steer / follow-up) message into the running turn. */
  onUserMessageDelivered: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('agent:user-message', listener);
    return () => ipcRenderer.removeListener('agent:user-message', listener);
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
  onIdleReset: (callback) => {
    const listener = (_event, minutes) => callback(minutes);
    ipcRenderer.on('agent:idle-reset', listener);
    return () => ipcRenderer.removeListener('agent:idle-reset', listener);
  },
  cancel: () => ipcRenderer.send('agent:cancel'),
  getAutoApprove: () => ipcRenderer.invoke('permissions:get-auto'),
  setAutoApprove: (on) => ipcRenderer.invoke('permissions:set-auto', on),
  onAutoApprove: (callback) => {
    const listener = (_event, on) => callback(on);
    ipcRenderer.on('permissions:auto', listener);
    return () => ipcRenderer.removeListener('permissions:auto', listener);
  },
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
  onConversationEnded: (cb) => {
    const l = () => cb();
    ipcRenderer.on('leslie:conversation-ended', l);
    return () => ipcRenderer.removeListener('leslie:conversation-ended', l);
  },
  setVoiceActive: (on) => ipcRenderer.send('voice:set-active', on),
  setConversation: (on) => ipcRenderer.send('voice:conversation', !!on),
  voiceListenOnce: () => ipcRenderer.send('voice:listen-once'),
  voiceFollowUp: () => ipcRenderer.invoke('voice:follow-up'),

  openSettings: (panel) => ipcRenderer.send('settings:open', panel),
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


  getAccent: () => ipcRenderer.invoke('theme:get'),
  onTheme: (cb) => ipcRenderer.on('theme:changed', (_e, color) => cb(color)),

  // --- Spoken replies --------------------------------------------------------
  /** Synthesize one sentence → { samples: Float32Array, sampleRate } or null (muted/cancelled). */
  ttsSpeak: (text) => ipcRenderer.invoke('tts:speak', text),
  ttsCancel: () => ipcRenderer.send('tts:cancel'),
  /** Tell the voice listener she's talking, so it ignores her own voice. */
  ttsPlaying: (playing) => ipcRenderer.send('tts:playing', Boolean(playing)),
  /** What she is about to say, so the voice listener can tell her echo from the user. */
  ttsSaid: (text) => ipcRenderer.send('tts:said', text),
  getTtsEnabled: () => ipcRenderer.invoke('tts:enabled'),
  onTtsEnabled: (cb) => ipcRenderer.on('tts:enabled', (_e, on) => cb(Boolean(on))),

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

'use strict';

// Text-to-speech with Kokoro-82M, synthesized in a utility process (see worker.js).
// The companion window plays the audio; this module owns the worker and the mute state.

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { app, utilityProcess } = require('electron');
const config = require('../config');
const configStore = require('../configStore');
const { VOICES, DEFAULT_VOICE } = require('./voices');

const events = new EventEmitter();
let child = null;
let seq = 0;
const pending = new Map();

function cacheDir() {
  return path.join(app.getPath('userData'), 'models');
}

function settle(id, value) {
  const resolve = pending.get(id);
  if (!resolve) return;
  pending.delete(id);
  resolve(value);
}

function worker() {
  if (child) return child;
  child = utilityProcess.fork(path.join(__dirname, 'worker.js'), [], { serviceName: 'LESLIE speech' });
  child.on('message', (msg) => {
    if (!msg) return;
    if (msg.type === 'audio') {
      if (msg.error) console.warn('[tts]', msg.error);
      settle(msg.id, msg.samples ? { samples: msg.samples, sampleRate: msg.sampleRate } : null);
    } else if (msg.type === 'ready') {
      console.log('[tts] Kokoro-82M ready');
    } else if (msg.type === 'error') {
      console.warn('[tts] model failed to load:', msg.error);
    }
  });
  child.on('exit', () => {
    child = null;
    for (const id of [...pending.keys()]) settle(id, null);
  });
  return child;
}

function voiceId() {
  return VOICES.some((v) => v.id === config.ttsVoice) ? config.ttsVoice : DEFAULT_VOICE;
}

/** Load the model ahead of the first reply (the first run downloads it, ~330 MB). */
function warm() {
  if (config.ttsEnabled) worker().postMessage({ type: 'warm', cacheDir: cacheDir() });
}

/**
 * Synthesize one sentence. Resolves to { samples: Float32Array, sampleRate } or null
 * (muted, cancelled, or failed). Requests are served in the order they arrive.
 * @param {string} text
 * @param {{ force?: boolean, voice?: string }} [opts] force speaks even while muted (settings preview)
 */
function speak(text, { force = false, voice } = {}) {
  const clean = String(text || '').trim();
  if (!clean || (!config.ttsEnabled && !force)) return Promise.resolve(null);
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker().postMessage({
      type: 'speak', id, text: clean, voice: voice || voiceId(), speed: config.ttsSpeed || 1, cacheDir: cacheDir()
    });
  });
}

/** Drop every request made so far that hasn't been synthesized yet. */
function cancel() {
  if (child) child.postMessage({ type: 'cancel', upTo: seq });
  for (const id of [...pending.keys()]) settle(id, null);
}

function isEnabled() {
  return Boolean(config.ttsEnabled);
}

/** Mute/unmute spoken replies (persisted like any other setting). */
function setEnabled(on) {
  configStore.set('ttsEnabled', Boolean(on));
  if (!on) cancel();
  else warm();
  events.emit('enabled', isEnabled());
  return isEnabled();
}

function shutdown() {
  if (child) child.kill();
  child = null;
}

module.exports = {
  speak,
  cancel,
  warm,
  isEnabled,
  setEnabled,
  shutdown,
  onEnabled: (fn) => events.on('enabled', fn)
};

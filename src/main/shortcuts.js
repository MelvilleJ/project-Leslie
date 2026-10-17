'use strict';

// User-defined phrases that run a tool directly, skipping the model: instant and
// exact, which matters for voice ("clip this", "mute"). Persisted in userData.

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { normalize } = require('./intents');

const DEFAULTS = [
  { id: 'clip-this', phrases: ['clip this', 'clip that'], tool: 'screen_record', args: { action: 'start' },
    reply: 'Clipping — say "stop clip" when you\'re done.' },
  { id: 'stop-clip', phrases: ['stop clip', 'stop clipping', 'end clip'], tool: 'screen_record', args: { action: 'stop' },
    reply: '' },
  { id: 'mute', phrases: ['mute', 'mute yourself', 'be quiet'], tool: 'speech', args: { action: 'mute' },
    reply: 'Muted.' },
  { id: 'unmute', phrases: ['unmute', 'unmute yourself'], tool: 'speech', args: { action: 'unmute' },
    reply: 'Voice is back on.' },
  { id: 'pause-media', phrases: ['pause', 'pause it', 'pause that', 'pause the video', 'pause the music', 'hold on'],
    tool: 'media_control', args: { action: 'pause' }, reply: 'Paused.' },
  { id: 'resume-media', phrases: ['resume', 'play', 'unpause', 'continue', 'keep playing', 'resume the video', 'play it'],
    tool: 'media_control', args: { action: 'play' }, reply: 'Resuming.' },
  { id: 'next-media', phrases: ['next', 'skip', 'skip this', 'next song', 'next track', 'next video'],
    tool: 'media_control', args: { action: 'next' }, reply: 'Skipping.' },
  { id: 'previous-media', phrases: ['previous', 'previous song', 'previous track', 'last song'],
    tool: 'media_control', args: { action: 'previous' }, reply: 'Going back.' },
  { id: 'fullscreen', phrases: ['full screen', 'fullscreen', 'make it full screen', 'go full screen'],
    tool: 'window_control', args: { action: 'fullscreen' }, reply: 'Full screen.' },
  { id: 'exit-fullscreen', phrases: ['exit full screen', 'exit fullscreen', 'leave full screen', 'shrink it'],
    tool: 'window_control', args: { action: 'exit_fullscreen' }, reply: '' }
];

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'leslie-shortcuts.json');
}

function sanitize(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((s, i) => ({
      id: String((s && s.id) || `shortcut-${Date.now()}-${i}`),
      phrases: (Array.isArray(s && s.phrases) ? s.phrases : String((s && s.phrases) || '').split(','))
        .map((p) => String(p).trim())
        .filter(Boolean),
      tool: String((s && s.tool) || '').trim(),
      args: s && s.args && typeof s.args === 'object' ? s.args : {},
      reply: String((s && s.reply) || ''),
      enabled: !(s && s.enabled === false)
    }))
    .filter((s) => s.phrases.length && s.tool);
}

function list() {
  if (cache) return cache;
  try {
    cache = sanitize(JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch {
    cache = sanitize(DEFAULTS);
  }
  return cache;
}

function save(next) {
  cache = sanitize(next);
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
  return cache;
}

/** The shortcut whose phrase is the whole message (after "hey leslie", "please", punctuation). */
function match(text) {
  if (/\?/.test(text)) return null;
  const said = normalize(text);
  if (!said) return null;
  return list().find((s) => s.enabled && s.phrases.some((p) => normalize(p) === said)) || null;
}

/** A one-line reply from a tool result when the shortcut doesn't set its own. */
function describe(result) {
  if (result == null) return 'Done.';
  if (typeof result === 'string') return result;
  if (result.output) return String(result.output);
  if (result.title) return String(result.title);
  if (result.file) return `Saved to ${result.file}`;
  if (result.note) return String(result.note);
  return 'Done.';
}

module.exports = { list, save, match, describe, DEFAULTS };

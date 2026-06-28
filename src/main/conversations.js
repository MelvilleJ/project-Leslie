'use strict';

// Conversation history — durable chat transcripts across sessions (the "past
// conversations" the settings window lists). A single JSON file in Electron's
// userData dir, modelled on settings.js / memory.js: in-memory cache +
// best-effort I/O (any failure falls back to memory-only rather than throwing).
//
// The agent keeps a short rolling `history` window for context; this store is
// the full, permanent log. Each finished exchange (one user turn + the
// assistant's reply) is appended to the *current* conversation. `startNew()`
// rolls over to a fresh one (e.g. on /reset); `resume()` reloads an old one so
// follow-ups continue it.

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/** @typedef {{ role: 'user'|'assistant', content: string, ts: number }} Turn */
/** @typedef {{ id: string, title: string, createdAt: number, updatedAt: number, messages: Turn[] }} Conversation */

/** @type {{ conversations: Conversation[], currentId: string|null } | null} */
let cache = null;
let seq = 0;

function file() {
  return path.join(app.getPath('userData'), 'leslie-conversations.json');
}

function load() {
  if (cache) return cache;
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = Array.isArray(data.conversations)
      ? { conversations: data.conversations, currentId: data.currentId ?? null }
      : { conversations: [], currentId: null };
  } catch {
    cache = { conversations: [], currentId: null };
  }
  return cache;
}

function persist() {
  try {
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
  } catch {
    // Non-fatal: the value still applies in-memory for this session.
  }
}

function newId() {
  return `conv${Date.now()}_${++seq}`;
}

// A readable title from the first user message (first line, trimmed to ~60 chars).
function titleFrom(text) {
  const first = String(text || '').trim().split(/\r?\n/)[0].trim();
  if (!first) return 'New conversation';
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}

function findById(id) {
  return load().conversations.find((c) => c.id === id) || null;
}

// The conversation new turns are appended to, creating one on first use.
function ensureCurrent() {
  const data = load();
  let conv = data.currentId ? findById(data.currentId) : null;
  if (!conv) {
    conv = { id: newId(), title: 'New conversation', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    data.conversations.push(conv);
    data.currentId = conv.id;
    persist();
  }
  return conv;
}

/**
 * Record a finished exchange on the current conversation. The title is set from
 * the first user message. @returns {Conversation} the updated conversation.
 */
function appendExchange(userText, assistantText) {
  const conv = ensureCurrent();
  const now = Date.now();
  if (!conv.messages.length) conv.title = titleFrom(userText);
  conv.messages.push({ role: 'user', content: String(userText || ''), ts: now });
  conv.messages.push({ role: 'assistant', content: String(assistantText || ''), ts: now });
  conv.updatedAt = now;
  persist();
  return conv;
}

/** Roll over to a fresh conversation (the next exchange starts it). */
function startNew() {
  const data = load();
  // Drop a current conversation that never received a turn, so /reset spam
  // doesn't litter the list with empties.
  const cur = data.currentId ? findById(data.currentId) : null;
  if (cur && !cur.messages.length) {
    data.conversations = data.conversations.filter((c) => c.id !== cur.id);
  }
  data.currentId = null;
  persist();
}

/** Conversation metadata, newest first (no message bodies). */
function list() {
  return load()
    .conversations.slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.messages.length,
      current: c.id === cache.currentId
    }));
}

/** Full conversation by id (with messages), or null. */
function get(id) {
  const conv = findById(id);
  return conv ? JSON.parse(JSON.stringify(conv)) : null;
}

/** The current conversation's id (may be null before the first turn). */
function currentId() {
  return load().currentId;
}

/**
 * Make `id` the current conversation and return its messages as {role, content}
 * pairs (for loading into the agent's working history). Null if not found.
 */
function resume(id) {
  const conv = findById(id);
  if (!conv) return null;
  load().currentId = id;
  persist();
  return conv.messages.map((m) => ({ role: m.role, content: m.content }));
}

/** Delete one conversation. @returns {boolean} whether one was removed. */
function remove(id) {
  const data = load();
  const before = data.conversations.length;
  data.conversations = data.conversations.filter((c) => c.id !== id);
  if (data.conversations.length === before) return false;
  if (data.currentId === id) data.currentId = null;
  persist();
  return true;
}

/** Delete every conversation. */
function clear() {
  cache = { conversations: [], currentId: null };
  persist();
}

module.exports = {
  appendExchange,
  startNew,
  list,
  get,
  currentId,
  resume,
  remove,
  clear
};

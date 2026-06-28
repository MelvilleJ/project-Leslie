'use strict';

// Long-term memory — durable facts/preferences Leslie remembers across sessions
// (the "learning mode" store). A single JSON file in Electron's userData dir,
// modelled on settings.js: in-memory cache + best-effort I/O (any failure falls
// back to memory-only rather than throwing). Captured two ways: the `remember`
// tool (model-driven) and background extraction (agent/reflect.js), then injected
// into the system prompt each turn via format().

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/** @typedef {{ id: string, text: string, source: 'tool'|'auto', createdAt: number }} Memory */

/** @type {{ memories: Memory[] } | null} */
let cache = null;
let seq = 0;

function file() {
  return path.join(app.getPath('userData'), 'leslie-memory.json');
}

function load() {
  if (cache) return cache;
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = Array.isArray(data.memories) ? data : { memories: [] };
  } catch {
    cache = { memories: [] };
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

/** All stored memories (newest last). */
function list() {
  return load().memories.slice();
}

/**
 * Store a durable fact/preference. Trims, skips near-empty text, and dedups on
 * case-insensitive exact match (so the tool and auto-extraction can't double up).
 * @param {string} text
 * @param {'tool'|'auto'} [source]
 * @returns {Memory|null} the stored entry, or null if it was empty/duplicate.
 */
function add(text, source = 'tool') {
  const clean = String(text || '').trim();
  if (clean.length < 2) return null;
  const data = load();
  const key = clean.toLowerCase();
  if (data.memories.some((m) => m.text.toLowerCase() === key)) return null;
  const entry = { id: `m${Date.now()}_${++seq}`, text: clean, source, createdAt: Date.now() };
  data.memories.push(entry);
  persist();
  return entry;
}

/** Forget one memory by id. @returns {boolean} whether one was removed. */
function remove(id) {
  const data = load();
  const before = data.memories.length;
  data.memories = data.memories.filter((m) => m.id !== id);
  if (data.memories.length === before) return false;
  persist();
  return true;
}

/** Forget everything. */
function clear() {
  cache = { memories: [] };
  persist();
}

/**
 * Render the memories as a system-prompt block. Returns '' when there's nothing
 * to inject, so callers can append unconditionally.
 */
function format() {
  const items = load().memories;
  if (!items.length) return '';
  const lines = items.map((m) => `- ${m.text}`).join('\n');
  return `What you remember about this user (from past sessions):\n${lines}`;
}

module.exports = { list, add, remove, clear, format };

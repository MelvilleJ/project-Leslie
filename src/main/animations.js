'use strict';

// Animation library + state bindings (clips + bindings persisted in userData).

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const STATES = ['toolCall', 'longThink', 'thinking', 'talking', 'listening', 'moving', 'idle'];

const BUILTINS = [
  { id: 'builtin:idle', name: 'Idle (built-in)', builtin: true, sheet: 'idle',
    frameW: 228, frameH: 537, cols: 4, frames: 25, frameMs: 140 },
  { id: 'builtin:thinking', name: 'Thinking (built-in)', builtin: true, sheet: 'thinking',
    frameW: 247, frameH: 537, cols: 4, frames: 12, frameMs: 140 },
  { id: 'builtin:talking', name: 'Talking (built-in)', builtin: true, sheet: 'talking',
    frameW: 211, frameH: 537, cols: 4, frames: 28, frameMs: 140 },
  ...[['idle', 12], ['talking', 10], ['thinking', 8], ['tools', 8], ['listening', 8], ['moving', 10]]
    .map(([name, frames]) => ({
      id: `builtin:pixel-${name}`, name: `Pixel ${name} (built-in)`, builtin: true, pixelArt: true,
      sheet: `pixel/${name}`, frameW: 288, frameH: 560, cols: 4, frames, frameMs: 140
    }))
];

const EDITABLE = ['name', 'frameW', 'frameH', 'cols', 'frames', 'frameMs'];

let cache = null;
let seq = 0;

function file() {
  return path.join(app.getPath('userData'), 'leslie-animations.json');
}

function clipsDir() {
  return path.join(app.getPath('userData'), 'animations');
}

function load() {
  if (cache) return cache;
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = {
      clips: Array.isArray(data.clips) ? data.clips : [],
      bindings: data.bindings && typeof data.bindings === 'object' ? data.bindings : null
    };
  } catch {
    cache = { clips: [], bindings: null };
  }
  return cache;
}

function persist() {
  try {
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
  } catch {
    // Non-fatal: changes still apply in-memory this session.
  }
}

function defaultBindings() {
  return { idle: ['builtin:idle'], thinking: ['builtin:thinking'], talking: ['builtin:talking'],
    longThink: [], toolCall: [], listening: [], moving: [] };
}

function effectiveBindings() {
  const data = load();
  const known = new Set([...BUILTINS.map((c) => c.id), ...data.clips.map((c) => c.id)]);
  const out = defaultBindings();
  if (data.bindings) {
    for (const s of STATES) {
      if (Array.isArray(data.bindings[s])) out[s] = data.bindings[s].filter((id) => known.has(id));
    }
  }
  return out;
}

/** Full config for a renderer: every clip (built-ins first) + resolved bindings. */
function getConfig() {
  const data = load();
  return {
    clips: [...BUILTINS, ...data.clips],
    bindings: effectiveBindings(),
    states: STATES
  };
}

function sanitizeGrid(grid = {}, frameMs) {
  const num = (v, d, min) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= min ? n : d;
  };
  const frames = num(grid.frames, 1, 1);
  return {
    frameW: num(grid.frameW, 100, 1),
    frameH: num(grid.frameH, 100, 1),
    frames,
    cols: num(grid.cols, frames, 1),
    frameMs: num(frameMs, 140, 10)
  };
}

/**
 * Import an uploaded spritesheet: copy the PNG into userData and store its meta.
 * @param {{ name: string, pngPath: string, grid?: object, frameMs?: number }} opts
 * @returns {object} the stored clip
 */
function importClip({ name, pngPath, grid, frameMs } = {}) {
  if (!pngPath || !fs.existsSync(pngPath)) throw new Error('Spritesheet PNG not found');
  const dir = clipsDir();
  fs.mkdirSync(dir, { recursive: true });
  const id = `clip${Date.now()}_${++seq}`;
  const file_ = `${id}.png`;
  fs.copyFileSync(pngPath, path.join(dir, file_));

  const g = sanitizeGrid(grid, frameMs);
  const clip = {
    id,
    name: String(name || 'Animation').trim() || 'Animation',
    file: file_,
    builtin: false,
    ...g
  };
  const data = load();
  data.clips.push(clip);
  persist();
  return clip;
}

/** Patch an uploaded clip's editable fields (name/grid/speed). Built-ins are read-only. */
function updateClip(id, patch = {}) {
  const data = load();
  const clip = data.clips.find((c) => c.id === id);
  if (!clip) return null;
  for (const k of EDITABLE) {
    if (patch[k] === undefined) continue;
    if (k === 'name') clip.name = String(patch.name).trim() || clip.name;
    else {
      const n = Math.round(Number(patch[k]));
      if (Number.isFinite(n) && n > 0) clip[k] = n;
    }
  }
  persist();
  return clip;
}

/** Delete an uploaded clip: remove its PNG and drop it from every binding. */
function removeClip(id) {
  const data = load();
  const clip = data.clips.find((c) => c.id === id);
  if (!clip) return false;
  data.clips = data.clips.filter((c) => c.id !== id);
  try {
    fs.unlinkSync(path.join(clipsDir(), clip.file));
  } catch {
    // ignore: file may already be gone
  }
  if (data.bindings) {
    for (const s of Object.keys(data.bindings)) {
      if (Array.isArray(data.bindings[s])) {
        data.bindings[s] = data.bindings[s].filter((cid) => cid !== id);
      }
    }
  }
  persist();
  return true;
}

/** Bind a state to a list of clip ids (validated against known clips). */
function setBinding(state, ids) {
  if (!STATES.includes(state)) return effectiveBindings();
  const data = load();
  const known = new Set([...BUILTINS.map((c) => c.id), ...data.clips.map((c) => c.id)]);
  const clean = (Array.isArray(ids) ? ids : [ids]).filter((id) => known.has(id));
  if (!data.bindings) data.bindings = defaultBindings();
  // idle keeps the whole list (rotation); other states use a single clip.
  data.bindings[state] = state === 'idle' ? clean : clean.slice(0, 1);
  persist();
  return effectiveBindings();
}

module.exports = {
  STATES,
  clipsDir,
  getConfig,
  importClip,
  updateClip,
  removeClip,
  setBinding
};

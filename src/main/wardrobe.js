'use strict';

// Leslie's outfit: picked by hand, or automatically by time of day. Persisted in userData.

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const aseprite = require('./aseprite');

const SLOTS = aseprite.WARDROBE_SLOTS;
const CATALOG_FILE = path.join(__dirname, '..', '..', 'assets', 'animations', 'pixel', 'wardrobe', 'leslie-idle.aseprite');

// Each period runs from its start hour until the next period's.
const PERIODS = [
  { id: 'morning', label: 'Morning', start: 6 },
  { id: 'afternoon', label: 'Afternoon', start: 12 },
  { id: 'evening', label: 'Evening', start: 18 },
  { id: 'night', label: 'Night', start: 22 }
];

const DEFAULT_STATE = {
  mode: 'manual',
  outfit: { top: 'hoodie', bottom: 'joggers', shoes: 'sneakers' },
  schedule: {
    morning: { top: 'cream-sweater', bottom: 'jeans', shoes: 'sneakers' },
    afternoon: { top: 'striped-tee', bottom: 'overalls', shoes: 'sneakers' },
    evening: { top: 'olive-jacket', bottom: 'khakis', shoes: 'boots' },
    night: { top: 'pink-hoodie', bottom: 'lavender-joggers', shoes: 'pink-sneakers' }
  }
};

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'leslie-wardrobe.json');
}

/** Items available per slot, read from the built-in wardrobe sprite. */
function catalog() {
  try {
    return aseprite.wardrobeItems(CATALOG_FILE);
  } catch {
    return Object.fromEntries(SLOTS.map((slot) => [slot, []]));
  }
}

function cleanOutfit(outfit, fallback) {
  const out = {};
  for (const slot of SLOTS) out[slot] = typeof outfit?.[slot] === 'string' ? outfit[slot] : fallback[slot];
  return out;
}

function load() {
  if (cache) return cache;
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    // First run or unreadable: defaults.
  }
  cache = {
    mode: data.mode === 'auto' ? 'auto' : 'manual',
    outfit: cleanOutfit(data.outfit, DEFAULT_STATE.outfit),
    schedule: Object.fromEntries(PERIODS.map(({ id }) =>
      [id, cleanOutfit(data.schedule?.[id], DEFAULT_STATE.schedule[id])]))
  };
  return cache;
}

function persist() {
  try {
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
  } catch {
    // Non-fatal: the outfit still applies this session.
  }
}

function periodAt(date = new Date()) {
  const hour = date.getHours();
  const started = PERIODS.filter((p) => p.start <= hour);
  return (started.length ? started[started.length - 1] : PERIODS[PERIODS.length - 1]).id;
}

/** The outfit Leslie should be wearing right now. */
function current() {
  const state = load();
  return state.mode === 'auto' ? state.schedule[periodAt()] : state.outfit;
}

/** URL query naming the current outfit, appended to .aseprite sprite URLs. */
function query(outfit = current()) {
  return new URLSearchParams(outfit).toString();
}

function fromQuery(searchParams) {
  return Object.fromEntries(SLOTS.map((slot) => [slot, searchParams.get(slot) || undefined]));
}

function getState() {
  return { ...load(), periods: PERIODS, period: periodAt(), current: current(), catalog: catalog(), slots: SLOTS };
}

/**
 * Apply a partial update: { mode }, { outfit: { slot: item } } or { schedule: { period: { slot: item } } }.
 * @returns {object} the full state
 */
function update(patch = {}) {
  const state = load();
  if (patch.mode === 'manual' || patch.mode === 'auto') state.mode = patch.mode;
  if (patch.outfit) state.outfit = cleanOutfit({ ...state.outfit, ...patch.outfit }, state.outfit);
  for (const { id } of PERIODS) {
    if (patch.schedule?.[id]) state.schedule[id] = cleanOutfit({ ...state.schedule[id], ...patch.schedule[id] }, state.schedule[id]);
  }
  persist();
  return getState();
}

/** Call `onChange` whenever the automatic schedule moves Leslie into a new outfit. */
function watchSchedule(onChange) {
  let last = query();
  return setInterval(() => {
    const now = query();
    if (now !== last) {
      last = now;
      onChange();
    }
  }, 60 * 1000);
}

module.exports = { current, query, fromQuery, getState, update, watchSchedule };

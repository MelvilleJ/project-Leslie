'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'leslie-settings.json');
}

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

/** Read a setting, returning `fallback` when it has never been set. */
function get(key, fallback) {
  const value = load()[key];
  return value === undefined ? fallback : value;
}

/** Persist a setting and return the stored value. */
function set(key, value) {
  const data = load();
  data[key] = value;
  try {
    fs.writeFileSync(file(), JSON.stringify(data, null, 2));
  } catch {
  }
  return value;
}

module.exports = { get, set };

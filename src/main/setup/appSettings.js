'use strict';

// Writes LESLIE's own settings (the cfg.* keys configStore reads) when setup
// runs outside Electron, from bin/leslie-setup. Inside the app, configStore.set
// is used instead so the running config changes too.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');

const file = () => path.join(paths.CONFIG, 'leslie-settings.json');

function writeSettings(values) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
  }
  for (const [key, value] of Object.entries(values)) data[`cfg.${key}`] = value;
  fs.mkdirSync(paths.CONFIG, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(data, null, 2));
}

module.exports = { file, writeSettings };

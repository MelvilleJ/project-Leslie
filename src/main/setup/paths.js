'use strict';

// Where setup puts things. Computed when first required, so tests can point the
// XDG variables at a temp folder before loading it.

const os = require('node:os');
const path = require('node:path');

const home = os.homedir();
const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
const DATA = path.join(dataHome, 'leslie');

// Inside a build the app's own files sit unpacked next to app.asar, where
// programs outside Electron (python, systemd) can read them.
const root = path.resolve(__dirname, '..', '..', '..');

module.exports = {
  CONFIG: path.join(configHome, 'project-leslie'),
  DATA,
  ENGINES: path.join(DATA, 'engines'),
  SIDECARS: path.join(DATA, 'sidecars'),
  MODELS: path.join(DATA, 'models'),
  UNITS: path.join(configHome, 'systemd', 'user'),
  APPS: path.join(dataHome, 'applications'),
  ICONS: path.join(dataHome, 'icons', 'hicolor'),
  ROUTER_PRESETS: path.join(configHome, 'llama-router', 'presets.ini'),
  RESOURCES: root.endsWith('app.asar') ? `${root}.unpacked` : root
};

'use strict';

// Installed-app index for Linux: Steam games (from every Steam library) and
// .desktop launcher entries, matched by spoken name. Steam games all share the
// `steam` binary, so they launch by app id rather than by name.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_MS = 60000;
// Steam installs these as "apps" too; they aren't things to launch.
const STEAM_TOOLS = /^(proton\b|steam linux runtime|steamworks common redistributables)/i;

const home = os.homedir();

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function list(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// --- Steam -------------------------------------------------------------------

const STEAM_ROOTS = [
  path.join(home, '.local/share/Steam'),
  path.join(home, '.steam/steam'),
  path.join(home, '.var/app/com.valvesoftware.Steam/data/Steam')
];

/** Values of `"key" "value"` pairs in a Valve KeyValues (.vdf/.acf) file. */
function vdfValues(text, key) {
  const re = new RegExp(`"${key}"\\s+"([^"]*)"`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push(m[1].replace(/\\\\/g, '\\'));
  return out;
}

function steamLibraries() {
  const libs = new Set();
  for (const root of STEAM_ROOTS) {
    const vdf = read(path.join(root, 'steamapps', 'libraryfolders.vdf'));
    if (!vdf) continue;
    libs.add(fs.realpathSync(root));
    for (const p of vdfValues(vdf, 'path')) libs.add(p);
  }
  return [...libs];
}

function steamGames() {
  const games = new Map();
  for (const lib of steamLibraries()) {
    const dir = path.join(lib, 'steamapps');
    for (const f of list(dir)) {
      if (!/^appmanifest_\d+\.acf$/.test(f)) continue;
      const text = read(path.join(dir, f));
      if (!text) continue;
      const [appid] = vdfValues(text, 'appid');
      const [name] = vdfValues(text, 'name');
      if (!appid || !name || STEAM_TOOLS.test(name)) continue;
      games.set(appid, { kind: 'steam', name: name.trim(), appid });
    }
  }
  return [...games.values()];
}

// --- .desktop entries ----------------------------------------------------------

function desktopDirs() {
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':');
  return [
    path.join(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), 'applications'),
    path.join(home, '.local/share/flatpak/exports/share/applications'),
    '/var/lib/flatpak/exports/share/applications',
    ...dataDirs.map((d) => path.join(d, 'applications'))
  ];
}

function parseDesktop(text) {
  const entry = {};
  let inMain = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inMain = line === '[Desktop Entry]';
      continue;
    }
    if (!inMain) continue;
    const eq = line.indexOf('=');
    if (eq > 0) {
      const key = line.slice(0, eq).trim();
      // Unlocalised keys only (Name, not Name[fr]).
      if (!key.includes('[')) entry[key] = line.slice(eq + 1).trim();
    }
  }
  return entry;
}

function desktopApps() {
  const seen = new Set();
  const apps = [];
  for (const dir of desktopDirs()) {
    for (const f of list(dir)) {
      if (!f.endsWith('.desktop') || seen.has(f)) continue;
      seen.add(f); // earlier dirs (the user's own) shadow system ones
      const e = parseDesktop(read(path.join(dir, f)) || '');
      if (e.Type !== 'Application' || !e.Name || e.NoDisplay === 'true' || e.Hidden === 'true') continue;
      apps.push({ kind: 'desktop', name: e.Name, id: f.replace(/\.desktop$/, ''), aka: e.GenericName || '' });
    }
  }
  return apps;
}

// --- Index + matching ------------------------------------------------------------

let cached = null;
let cachedAt = 0;

function index() {
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
  const steam = steamGames();
  const steamNames = new Set(steam.map((g) => compact(g.name)));
  // Steam also writes .desktop shortcuts for games; keep the Steam entry.
  const desktop = desktopApps().filter((a) => !steamNames.has(compact(a.name)));
  cached = [...steam, ...desktop];
  cachedAt = Date.now();
  return cached;
}

const compact = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');

function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function score(query, app) {
  let best = 0;
  for (const label of [app.name, app.aka, app.id]) {
    const c = compact(label);
    if (!c) continue;
    if (c === query) best = Math.max(best, 100);
    else if (c.startsWith(query) && query.length >= 3) best = Math.max(best, 85);
    else if (c.includes(query) && query.length >= 4) best = Math.max(best, 75);
    else {
      // Speech-to-text slips ("war frame", "bar only").
      const d = levenshtein(query, c);
      const tolerance = Math.floor(c.length / 5);
      if (d <= tolerance) best = Math.max(best, 70 - d * 5);
    }
  }
  return best;
}

/**
 * Find installed apps for a spoken name, best first.
 * @returns {{ match: object|null, candidates: object[] }} match is set only when unambiguous.
 */
function find(name) {
  const query = compact(name);
  if (!query) return { match: null, candidates: [] };
  const ranked = index()
    .map((app) => ({ app, s: score(query, app) }))
    .filter((r) => r.s >= 55)
    .sort((a, b) => b.s - a.s || a.app.name.length - b.app.name.length);
  const [first, second] = ranked;
  const clear = first && (!second || first.s > second.s || first.s === 100);
  return { match: clear ? first.app : null, candidates: ranked.slice(0, 5).map((r) => r.app) };
}

/** Command + args that launch an indexed app. */
function launchCommand(app) {
  if (app.kind === 'steam') return ['steam', [`steam://rungameid/${app.appid}`]];
  return ['gtk-launch', [app.id]];
}

module.exports = { find, launchCommand, index, compact };

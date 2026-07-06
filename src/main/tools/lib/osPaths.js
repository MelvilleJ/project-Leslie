'use strict';

// OS-aware path resolution for the read-only filesystem tools.
//
// Filesystem reads happen on the REAL host, so detection keys off
// process.platform (config.osTarget governs the shell / package-manager tools,
// not where files actually live). This helper turns the loose path specs a
// model produces — a shortcut word ("documents"), a "~" path, an env var, or a
// relative path — into a concrete absolute path, and knows how to enumerate the
// filesystem roots (drive letters on Windows, "/" on Linux/macOS).

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

function isWindows() {
  return process.platform === 'win32';
}

// Well-known per-user locations, resolved for the real OS. os.homedir() is
// already correct on every platform, so the named folders hang off it.
function namedLocations() {
  const home = os.homedir();
  return {
    home,
    documents: path.join(home, 'Documents'),
    downloads: path.join(home, 'Downloads'),
    desktop: path.join(home, 'Desktop'),
    pictures: path.join(home, 'Pictures'),
    music: path.join(home, 'Music'),
    videos: path.join(home, 'Videos'),
    temp: os.tmpdir(),
    cwd: process.cwd()
  };
}

// Filesystem roots: existing drive letters on Windows, "/" elsewhere.
function roots() {
  if (!isWindows()) return ['/'];
  const found = [];
  for (let c = 65; c <= 90; c++) {
    const drive = `${String.fromCharCode(c)}:\\`;
    try {
      fs.accessSync(drive);
      found.push(drive);
    } catch {
      // drive letter not mounted
    }
  }
  return found.length ? found : ['C:\\'];
}

const ROOT_WORDS = new Set(['drives', 'drive', 'root', 'roots']);

/** True when `spec` asks for the list of drives / filesystem roots. */
function isRootsRequest(spec) {
  return ROOT_WORDS.has(String(spec || '').trim().toLowerCase());
}

// Expand %VAR% (Windows) and $VAR / ${VAR} (POSIX), leaving unknown vars as-is.
function expandEnv(s) {
  return s
    .replace(/%([^%]+)%/g, (m, n) => (process.env[n] !== undefined ? process.env[n] : m))
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, n) => (process.env[n] !== undefined ? process.env[n] : m))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, n) => (process.env[n] !== undefined ? process.env[n] : m));
}

/**
 * Resolve a path spec to an absolute path.
 *   - a shortcut keyword (home, documents, downloads, desktop, …)
 *   - "~" or "~/sub" (home expansion)
 *   - %VAR% / $VAR (environment expansion)
 *   - an absolute path (used as-is, normalised)
 *   - anything else is treated as relative to the user's home directory
 * @param {string} spec
 * @returns {string} absolute, normalised path
 */
function resolvePath(spec) {
  let s = String(spec == null ? '' : spec).trim();
  if (!s || s === '~') return os.homedir();

  const named = namedLocations();
  const lower = s.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(named, lower)) return named[lower];

  if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(2));
  s = expandEnv(s);

  if (!path.isAbsolute(s)) s = path.resolve(os.homedir(), s);
  return path.normalize(s);
}

module.exports = { isWindows, namedLocations, roots, isRootsRequest, resolvePath };

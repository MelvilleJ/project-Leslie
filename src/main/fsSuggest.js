'use strict';

// Path autocomplete for the companion's "@" file/folder picker (Claude Code
// style). Given the partial text typed after "@", returns matching files and
// folders so the renderer can show a dropdown. OS-aware via osPaths: shortcut
// names (documents, downloads, …), "~", drive roots, and absolute/relative
// paths all resolve correctly on whichever OS LESLIE runs on.

const fs = require('node:fs');
const path = require('node:path');
const { resolvePath, roots, isWindows, namedLocations } = require('./tools/lib/osPaths');

const MAX = 30;
const SCAN_CAP = 400; // stop scanning a giant directory after this many entries

// The native separator, sent to the renderer so it can append it when the user
// drills into a folder.
const SEP = isWindows() ? '\\' : '/';

// Friendly top-level entries shown before the user types a path (and matched by
// label while they type a bare word). Each resolves to an absolute directory.
function shortcutItems() {
  const n = namedLocations();
  const items = [
    ['Home', n.home], ['Documents', n.documents], ['Downloads', n.downloads],
    ['Desktop', n.desktop], ['Pictures', n.pictures], ['Music', n.music],
    ['Videos', n.videos], ['Temp', n.temp], ['Current folder', n.cwd]
  ].map(([name, abs]) => ({ name, path: abs, type: 'dir' }));
  for (const r of roots()) items.push({ name: r, path: r, type: 'dir' });
  return items;
}

function typeOf(dirent, full) {
  if (dirent.isDirectory()) return 'dir';
  if (dirent.isFile()) return 'file';
  if (dirent.isSymbolicLink()) {
    try {
      return fs.statSync(full).isDirectory() ? 'dir' : 'file';
    } catch {
      return 'file';
    }
  }
  return 'file';
}

// List `dir`, keeping entries whose name starts with `prefix` (case-insensitive).
function listDir(dir, prefix) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const pre = prefix.toLowerCase();
  const out = [];
  let scanned = 0;
  for (const d of ents) {
    if (++scanned > SCAN_CAP && out.length >= MAX) break;
    if (pre && !d.name.toLowerCase().startsWith(pre)) continue;
    const full = path.join(dir, d.name);
    out.push({ name: d.name, path: full, type: typeOf(d, full) });
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return out.slice(0, MAX);
}

/**
 * Suggest files/folders for the text typed after "@".
 * @param {string} query
 * @returns {{ items: {name:string, path:string, type:string}[], sep: string }}
 */
function suggest(query) {
  const q = String(query == null ? '' : query);
  try {
    // Nothing typed yet → offer the shortcut list.
    if (!q.trim()) return { items: shortcutItems().slice(0, MAX), sep: SEP };

    const lastSep = Math.max(q.lastIndexOf('/'), q.lastIndexOf('\\'));
    if (lastSep === -1) {
      // A bare word: match shortcut labels AND list the home folder by prefix.
      const ql = q.toLowerCase();
      const shortcuts = shortcutItems().filter((s) => s.name.toLowerCase().startsWith(ql));
      const homeHits = listDir(namedLocations().home, q);
      // Dedupe by absolute path (shortcuts like "Downloads" are also home children).
      const seen = new Set();
      const merged = [...shortcuts, ...homeHits].filter((i) => {
        if (seen.has(i.path)) return false;
        seen.add(i.path);
        return true;
      });
      return { items: merged.slice(0, MAX), sep: SEP };
    }

    // A path: list the directory part, filtered by the trailing basename.
    const dirSpec = q.slice(0, lastSep);
    const prefix = q.slice(lastSep + 1);
    const dir = resolvePath(dirSpec === '' ? SEP : dirSpec);
    return { items: listDir(dir, prefix), sep: SEP };
  } catch {
    return { items: [], sep: SEP };
  }
}

module.exports = { suggest, SEP };

'use strict';

// Read-only directory listing, OS-aware. Resolves shortcut names ("documents",
// "downloads", "drives", …), "~" paths and relative paths via osPaths, so the
// model can browse the user's filesystem on whichever OS LESLIE is running on.

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { resolvePath, roots, isRootsRequest, isWindows } = require('./lib/osPaths');

function entryFor(dir, name) {
  const full = path.join(dir, name);
  try {
    // lstat first so a broken symlink doesn't throw; report the link itself.
    const ls = fs.lstatSync(full);
    if (ls.isSymbolicLink()) return { name, type: 'symlink' };
    const st = fs.statSync(full);
    if (st.isDirectory()) return { name, type: 'dir' };
    return { name, type: 'file', size: st.size, modified: st.mtime.toISOString().slice(0, 10) };
  } catch {
    return { name, type: 'unknown' };
  }
}

module.exports = {
  name: 'list_directory',
  readOnly: true,
  get description() {
    const ex = isWindows() ? 'C:\\\\Users\\\\You\\\\Documents' : '/home/you/Documents';
    return (
      "List the files and folders in a directory on the user's computer (read-only). " +
      `Accepts an absolute path (e.g. "${ex}"), a "~" path, a path relative to home ` +
      '(e.g. "Documents/Projects"), or a shortcut: home, documents, downloads, desktop, ' +
      'pictures, music, videos, temp, cwd, or "drives" (lists drive letters on Windows / "/" ' +
      'on Linux/macOS). Use this to find files before reading them with read_file. Defaults to home.'
    );
  },
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Directory to list: an absolute path, "~/…", a home-relative path, or a shortcut ' +
          '(home, documents, downloads, desktop, pictures, music, videos, temp, cwd, drives). ' +
          'Omit to list the home folder.'
      }
    }
  },

  async run({ path: spec } = {}) {
    if (isRootsRequest(spec)) {
      return { platform: process.platform, roots: roots() };
    }

    const target = resolvePath(spec == null || spec === '' ? 'home' : spec);

    let stat;
    try {
      stat = fs.statSync(target);
    } catch (err) {
      return { path: target, error: `Cannot access path: ${err.code || err.message}` };
    }
    if (!stat.isDirectory()) {
      return { path: target, error: 'That path is a file, not a directory. Use read_file to read it.' };
    }

    let names;
    try {
      names = fs.readdirSync(target);
    } catch (err) {
      return { path: target, error: `Cannot list directory: ${err.code || err.message}` };
    }

    const max = Math.max(1, Number(config.fsListMaxEntries) || 200);
    const shown = names.slice(0, max).map((name) => entryFor(target, name));
    // Directories first, then alphabetical.
    shown.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
    );

    return {
      path: target,
      count: names.length,
      truncated: names.length > shown.length,
      entries: shown
    };
  }
};

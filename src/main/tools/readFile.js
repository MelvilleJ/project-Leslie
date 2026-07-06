'use strict';

// Read-only text file reader, OS-aware. Resolves the same path specs as
// list_directory (absolute, "~/…", home-relative, shortcut-relative like
// "documents/notes.txt"). Caps the bytes read and refuses binary files so the
// model gets useful text without flooding the context or dumping raw bytes.

const fs = require('node:fs');
const config = require('../config');
const { resolvePath, isRootsRequest, isWindows } = require('./lib/osPaths');

// A NUL byte in the first chunk is a strong "this is binary" signal.
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

module.exports = {
  name: 'read_file',
  readOnly: true,
  get description() {
    const ex = isWindows() ? 'C:\\\\Users\\\\You\\\\notes.txt' : '/home/you/notes.txt';
    return (
      "Read the text contents of a file on the user's computer (read-only). " +
      `Accepts an absolute path (e.g. "${ex}"), a "~" path, or a path relative to a shortcut ` +
      '(e.g. "Documents/notes.txt", "downloads/data.csv"). Returns UTF-8 text, truncated for ' +
      'large files. Not for binary files (images, executables, archives). Use list_directory first ' +
      'to discover the exact path.'
    );
  },
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File to read: an absolute path, "~/…", or a shortcut-relative path like "documents/notes.txt".'
      },
      maxBytes: {
        type: 'number',
        description: 'Optional cap on how many bytes to read from the start of the file.'
      }
    },
    required: ['path']
  },

  async run({ path: spec, maxBytes } = {}) {
    if (!spec || !String(spec).trim()) throw new Error('path is required');
    if (isRootsRequest(spec)) {
      return { error: 'That refers to the drive list, not a file. Use list_directory instead.' };
    }

    const target = resolvePath(spec);

    let stat;
    try {
      stat = fs.statSync(target);
    } catch (err) {
      return { path: target, error: `Cannot access file: ${err.code || err.message}` };
    }
    if (stat.isDirectory()) {
      return { path: target, error: 'That path is a directory. Use list_directory to list it.' };
    }

    const hardCap = Math.max(1, Number(config.fsReadMaxBytes) || 262144);
    const requested = Number(maxBytes) > 0 ? Number(maxBytes) : hardCap;
    const cap = Math.min(requested, hardCap);

    let fd;
    try {
      const length = Math.min(stat.size, cap);
      const buf = Buffer.alloc(length);
      fd = fs.openSync(target, 'r');
      const bytesRead = length > 0 ? fs.readSync(fd, buf, 0, length, 0) : 0;
      const slice = buf.subarray(0, bytesRead);

      if (looksBinary(slice)) {
        return { path: target, bytes: stat.size, error: 'File appears to be binary; not shown as text.' };
      }
      return {
        path: target,
        bytes: stat.size,
        truncated: stat.size > slice.length,
        content: slice.toString('utf8')
      };
    } catch (err) {
      return { path: target, error: `Cannot read file: ${err.code || err.message}` };
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // already closed
        }
      }
    }
  }
};

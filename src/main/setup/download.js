'use strict';

// Resumable HTTPS downloads: data lands in <file>.part and is renamed into place
// only once its sha256 matches, so a half-written file is never mistaken for a
// finished one, and a cancelled or crashed download picks up where it stopped.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');

const PROGRESS_EVERY_MS = 250;

function size(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

/** A finished download is in place, and has the expected size when that is known. */
function present(dest, bytes) {
  const s = size(dest);
  return s >= 0 && (!bytes || s === bytes);
}

async function hashFile(file, hash) {
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
}

async function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  await hashFile(file, hash);
  return hash.digest('hex');
}

/**
 * Fetch url into dest. onProgress({ done, total }) fires a few times a second.
 * Resolves 'present' when dest was already there, 'downloaded' otherwise.
 */
async function download(url, dest, { bytes, sha256, onProgress = () => {}, signal } = {}) {
  if (present(dest, bytes)) return 'present';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let have = Math.max(0, size(part));
  if (bytes && have > bytes) {
    fs.rmSync(part, { force: true });
    have = 0;
  }

  const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal });
  if (res.status === 416 && bytes && have === bytes) {
    // The part file is already complete; only the rename was missed.
  } else if (!res.ok) {
    throw new Error(`Download failed (HTTP ${res.status}) for ${path.basename(dest)}`);
  }
  const resumed = res.status === 206 || res.status === 416;
  if (!resumed) have = 0;

  const hash = crypto.createHash('sha256');
  if (have) await hashFile(part, hash);
  const total = bytes || have + Number(res.headers.get('content-length') || 0);
  let done = have;
  let last = 0;
  onProgress({ done, total });

  if (res.status !== 416) {
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    try {
      for await (const chunk of res.body) {
        hash.update(chunk);
        if (!out.write(chunk)) await once(out, 'drain');
        done += chunk.length;
        if (Date.now() - last > PROGRESS_EVERY_MS) {
          last = Date.now();
          onProgress({ done, total });
        }
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
  }
  onProgress({ done, total });

  const digest = hash.digest('hex');
  if (sha256 && digest !== sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(`${path.basename(dest)} did not match its checksum; it was removed so the next try starts clean.`);
  }
  if (bytes && size(part) !== bytes) throw new Error(`${path.basename(dest)} is incomplete.`);
  fs.renameSync(part, dest);
  return 'downloaded';
}

module.exports = { download, present, sha256Of };

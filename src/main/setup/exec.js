'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

/** Run a program; never rejects. ok is false when it fails to start or exits non-zero. */
function run(cmd, args = [], { timeout = 60000, env, cwd, signal } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, signal, env: env && { ...process.env, ...env }, cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
    );
  });
}

/** Like run, but throws with the program's own error text. */
async function must(cmd, args, opts) {
  const res = await run(cmd, args, opts);
  if (!res.ok) {
    const tail = (res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ');
    throw new Error(`${path.basename(cmd)} failed${tail ? `: ${tail}` : ''}`);
  }
  return res;
}

function which(bin) {
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const full = path.join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      if (fs.statSync(full).isFile()) return full;
    } catch {
    }
  }
  return null;
}

module.exports = { run, must, which };

'use strict';

// Screenshots on Wayland via grim: the main monitor, every monitor, or a region
// picked with slurp. Saved to Pictures/Screenshots and copied to the clipboard.

const { execFile, execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../config');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') reject(new Error(`${cmd} is not installed.`));
        else reject(new Error((stderr || err.message).trim()));
      } else resolve(String(stdout).trim());
    });
  });
}

function picturesDir() {
  try {
    const dir = execFileSync('xdg-user-dir', ['PICTURES'], { encoding: 'utf8' }).trim();
    if (dir && dir !== os.homedir()) return dir;
  } catch {
  }
  return path.join(os.homedir(), 'Pictures');
}

function outputFile() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const dir = path.join(picturesDir(), 'Screenshots');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `Leslie ${stamp}.png`);
}

function copyToClipboard(file) {
  try {
    const child = spawn('wl-copy', ['--type', 'image/png'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    child.on('error', () => {});
    fs.createReadStream(file).pipe(child.stdin);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  name: 'screenshot',
  readOnly: false,
  description:
    "Take a screenshot of the user's screen. Use when the user asks to take a screenshot or capture " +
    'the screen. Defaults to their main monitor; "all" captures every monitor; "region" lets them drag ' +
    'out an area. Saved to Pictures/Screenshots and copied to the clipboard.',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['main', 'all', 'region'],
        description: 'What to capture: the main monitor (default), all monitors, or a region the user selects.'
      }
    }
  },
  async run({ target = 'main' } = {}) {
    if (process.platform !== 'linux') throw new Error('Screenshots are only set up for Linux/Wayland.');
    const file = outputFile();
    if (target === 'region') {
      let geometry;
      try {
        geometry = await run('slurp', []);
      } catch {
        return { saved: false, note: 'Selection cancelled — no screenshot taken.' };
      }
      await run('grim', ['-g', geometry, file]);
    } else if (target === 'all') {
      await run('grim', [file]);
    } else {
      await run('grim', ['-o', config.recordMonitor, file]);
    }
    const copied = copyToClipboard(file);
    return { saved: true, file, copiedToClipboard: copied };
  }
};

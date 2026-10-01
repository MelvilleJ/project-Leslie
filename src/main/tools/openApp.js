'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const linuxApps = require('./lib/linuxApps');

const ALIASES = {
  calculator: { win: 'calc', mac: 'Calculator', linux: 'gnome-calculator' },
  calc: { win: 'calc', mac: 'Calculator', linux: 'gnome-calculator' },
  notepad: { win: 'notepad', mac: 'TextEdit', linux: 'gedit' },
  'text editor': { win: 'notepad', mac: 'TextEdit', linux: 'gedit' },
  paint: { win: 'mspaint', mac: 'Preview', linux: 'gimp' },
  'file explorer': { win: 'explorer', mac: 'Finder', linux: 'xdg-open ~' },
  explorer: { win: 'explorer', mac: 'Finder', linux: 'nautilus' },
  files: { win: 'explorer', mac: 'Finder', linux: 'nautilus' },
  'task manager': { win: 'taskmgr', mac: 'Activity Monitor', linux: 'gnome-system-monitor' },
  settings: { win: 'shell:::{ED7BA470-8E54-465E-825C-99712043E01C}', mac: 'System Settings', linux: 'gnome-control-center' },
  'control panel': { win: 'control', mac: 'System Settings', linux: 'gnome-control-center' },
  terminal: { win: 'wt', mac: 'Terminal', linux: 'gnome-terminal' },
  'command prompt': { win: 'cmd', mac: 'Terminal', linux: 'gnome-terminal' },
  cmd: { win: 'cmd', mac: 'Terminal', linux: 'gnome-terminal' },
  powershell: { win: 'powershell', mac: 'Terminal', linux: 'gnome-terminal' },
  browser: { win: 'msedge', mac: 'Safari', linux: 'xdg-open https://' },
  edge: { win: 'msedge', mac: 'Microsoft Edge', linux: 'microsoft-edge' },
  chrome: { win: 'chrome', mac: 'Google Chrome', linux: 'google-chrome' },
  firefox: { win: 'firefox', mac: 'Firefox', linux: 'firefox' },
  word: { win: 'winword', mac: 'Microsoft Word', linux: 'libreoffice --writer' },
  excel: { win: 'excel', mac: 'Microsoft Excel', linux: 'libreoffice --calc' },
  powerpoint: { win: 'powerpnt', mac: 'Microsoft PowerPoint', linux: 'libreoffice --impress' },
  outlook: { win: 'outlook', mac: 'Microsoft Outlook', linux: 'thunderbird' },
  'vs code': { win: 'code', mac: 'Visual Studio Code', linux: 'code' },
  'visual studio code': { win: 'code', mac: 'Visual Studio Code', linux: 'code' },
  code: { win: 'code', mac: 'Visual Studio Code', linux: 'code' },
  spotify: { win: 'spotify', mac: 'Spotify', linux: 'spotify' },
  discord: { win: 'discord', mac: 'Discord', linux: 'discord' },
  steam: { win: 'steam', mac: 'Steam', linux: 'steam' }
};

function platformKey() {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

function launch(command, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    }, 400);
  });
}

function onPath(bin) {
  return (process.env.PATH || '').split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// Installed apps and Steam games by name first; then the aliases / a command on PATH.
async function launchLinux(requested, key) {
  const { match, candidates } = linuxApps.find(requested);
  if (match) {
    const [bin, args] = linuxApps.launchCommand(match);
    await launch(bin, args);
    return { opened: match.name, via: match.kind === 'steam' ? `Steam (app ${match.appid})` : `${match.id}.desktop` };
  }
  if (candidates.length) {
    return {
      opened: null,
      note: `"${requested}" matches several installed apps — ask the user which one, then call open_app with its exact name.`,
      candidates: candidates.map((c) => c.name)
    };
  }
  const mapped = ALIASES[key];
  const target = (mapped && mapped.linux) || requested;
  const [bin, ...rest] = target.split(' ');
  if (!onPath(bin)) {
    throw new Error(`No installed app or Steam game matches "${requested}". Ask the user for the exact name.`);
  }
  await launch(bin, rest);
  return { opened: requested, launched: target };
}

module.exports = {
  name: 'open_app',
  description:
    "Launch a desktop application or installed game on the user's computer. Use when the user asks to " +
    'open, start, launch, play, or run a program, app, or game (e.g. "open the calculator", ' +
    '"launch Spotify", "play Warframe"). Pass the name as the user said it; installed Steam games ' +
    'and desktop apps are matched by name.',
  parameters: {
    type: 'object',
    properties: {
      app: {
        type: 'string',
        description:
          'The application or game to open, by name, e.g. "calculator", "Spotify", "Warframe".'
      }
    },
    required: ['app']
  },
  async run({ app }) {
    if (!app || !String(app).trim()) throw new Error('app is required');
    const requested = String(app).trim();
    const key = requested.toLowerCase().replace(/\s+/g, ' ');
    if (process.platform === 'linux') return launchLinux(requested, key);

    const mapped = ALIASES[key];
    const target = (mapped && mapped[platformKey()]) || requested;

    if (process.platform === 'win32') {
      await launch('cmd.exe', ['/c', 'start', '', target]);
    } else if (process.platform === 'darwin') {
      await launch('open', ['-a', target]);
    }

    return { opened: requested, launched: target };
  }
};

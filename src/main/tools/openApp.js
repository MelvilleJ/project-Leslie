'use strict';

const { spawn } = require('node:child_process');

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

module.exports = {
  name: 'open_app',
  description:
    "Launch a desktop application on the user's computer. Use when the user asks to " +
    'open, start, launch, or run a program or app (e.g. "open the calculator", ' +
    '"launch Spotify", "start notepad"). Pass the common name of the app.',
  parameters: {
    type: 'object',
    properties: {
      app: {
        type: 'string',
        description:
          'The application to open, by common name or executable, e.g. "calculator", ' +
          '"Spotify", "notepad", "chrome".'
      }
    },
    required: ['app']
  },
  async run({ app }) {
    if (!app || !String(app).trim()) throw new Error('app is required');
    const requested = String(app).trim();
    const key = requested.toLowerCase().replace(/\s+/g, ' ');
    const mapped = ALIASES[key];
    const target = (mapped && mapped[platformKey()]) || requested;

    if (process.platform === 'win32') {
      await launch('cmd.exe', ['/c', 'start', '', target]);
    } else if (process.platform === 'darwin') {
      await launch('open', ['-a', target]);
    } else {
      const [bin, ...rest] = target.split(' ');
      await launch(bin, rest);
    }

    return { opened: requested, launched: target };
  }
};

'use strict';

// Close an application by name: gracefully close its windows through Hyprland
// (matched on window title/class, so Steam games are found by their title), and
// fall back to ending a process with that exact name.

const { run, matchingWindows } = require('./lib/hyprWindows');

module.exports = {
  name: 'close_app',
  readOnly: false,
  description:
    'Close (quit) a running application or game by name. Use when the user asks to close, quit, exit, ' +
    'or kill a program or game (e.g. "close Warframe", "quit Spotify"). Windows are closed gracefully first.',
  parameters: {
    type: 'object',
    properties: {
      app: { type: 'string', description: 'The application or game to close, by name, e.g. "Warframe", "Spotify".' },
      force: { type: 'boolean', description: 'Kill it immediately instead of closing gracefully. Only if the user asks.' }
    },
    required: ['app']
  },
  async run({ app, force }) {
    const name = String(app || '').trim();
    if (!name) throw new Error('app is required');
    const windows = await matchingWindows(name);
    if (windows.length && !force) {
      const batch = windows
        .map((w) => `dispatch hl.dsp.window.close({ window = "address:${w.address}" })`)
        .join(' ; ');
      await run('hyprctl', ['--batch', batch]);
      return { closed: [...new Set(windows.map((w) => w.title || w.class))], windows: windows.length };
    }
    // No window (tray apps, background games) or forced: end processes with this exact name.
    const pids = [...new Set(windows.map((w) => w.pid))];
    if (force && pids.length) {
      for (const pid of pids) process.kill(pid, 'SIGKILL');
      return { killed: pids.length, app: name };
    }
    // Process names (comm) are truncated to 15 characters by the kernel.
    const res = await run('pkill', ['-i', '-x', name.replace(/\s+/g, '').slice(0, 15)]);
    if (res.ok) return { closed: name, via: 'process' };
    return { closed: null, note: `Nothing named "${name}" seems to be running.` };
  }
};

'use strict';

const { targetWindow, sel, dispatch } = require('./lib/hyprWindows');

const FULLSCREEN = {
  fullscreen: ['fullscreen', 'set'],
  exit_fullscreen: ['fullscreen', 'unset'],
  toggle_fullscreen: ['fullscreen', 'toggle'],
  maximize: ['maximized', 'set'],
  unmaximize: ['maximized', 'unset']
};
// Hyprland's eFullscreenMode, as reported in `hyprctl clients`.
const MODE_VALUE = { maximized: 1, fullscreen: 2 };

module.exports = {
  name: 'window_control',
  readOnly: true,
  description:
    'Arrange an open app window: make it full screen, exit full screen, maximize, bring it to the front, or move it ' +
    'to another workspace. Use for "make it full screen", "full screen Firefox", "show me Spotify", "move Discord to workspace 3". ' +
    'With no app it acts on the window the user was last using.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['fullscreen', 'exit_fullscreen', 'toggle_fullscreen', 'maximize', 'unmaximize', 'focus', 'move_to_workspace']
      },
      app: { type: 'string', description: 'App or window title, e.g. "Firefox", "Spotify". Leave empty for the last-used window.' },
      workspace: { type: 'number', description: 'For move_to_workspace: the workspace number.' }
    },
    required: ['action']
  },
  async run({ action, app, workspace }) {
    const name = String(app || '').trim();
    const win = await targetWindow(name);
    if (!win) return { note: name ? `No open window matches "${name}".` : 'There is no window to act on.' };
    const target = sel(win.address);
    const label = win.title || win.class;

    if (FULLSCREEN[action]) {
      const [mode, how] = FULLSCREEN[action];
      const other = mode === 'fullscreen' ? 'maximized' : 'fullscreen';
      // A window can only be in one fullscreen mode; leave the other one first.
      const calls = how !== 'unset' && win.fullscreen === MODE_VALUE[other]
        ? [`hl.dsp.window.fullscreen({ mode = "${other}", action = "unset", window = ${target} })`]
        : [];
      calls.push(`hl.dsp.focus({ window = ${target} })`);
      calls.push(`hl.dsp.window.fullscreen({ mode = "${mode}", action = "${how}", window = ${target} })`);
      await dispatch(...calls);
      return { [action]: label };
    }
    if (action === 'focus') {
      await dispatch(`hl.dsp.focus({ window = ${target} })`);
      return { focused: label };
    }
    if (action === 'move_to_workspace') {
      const ws = Math.trunc(Number(workspace));
      if (!(ws > 0)) throw new Error('workspace is required for move_to_workspace');
      await dispatch(`hl.dsp.window.move({ workspace = ${ws}, follow = false, window = ${target} })`);
      return { moved: label, workspace: ws };
    }
    throw new Error(`Unknown action "${action}"`);
  }
};

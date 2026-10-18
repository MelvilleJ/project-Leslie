'use strict';

// Keeps the companion on one monitor under Hyprland. Wayland doesn't let a
// client place itself, so placement goes through hyprctl (Hyprland 0.55+ Lua
// dispatchers): move there without following, anchor bottom-right, pin so it
// shows on every workspace of that monitor, strip blur/border/shadow, and hand
// focus back if showing the window took it.

const { execFile } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const MARGIN = 24;

const available = () => Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE);

function hyprctl(args) {
  return new Promise((resolve, reject) => {
    execFile('hyprctl', args, { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

const json = async (what) => JSON.parse(await hyprctl(['-j', what]));
const sel = (address) => `"address:${address}"`;

async function findWindow(pid, title, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    const win = (await json('clients')).find((c) => c.pid === pid && c.title === title);
    if (win || Date.now() - started > timeoutMs) return win || null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function activeAddress() {
  try {
    return (await json('activewindow')).address || null;
  } catch {
    return null;
  }
}

// The companion draws its own panels over a transparent window, so Hyprland's
// blur, border and shadow would frame empty space around her.
const UNDECORATED_PROPS = { no_blur: '1', border_size: '0', no_shadow: '1' };
// Window addresses already stripped; a re-mapped window gets a new address.
const undecorated = new Set();

async function undecorate(address) {
  if (undecorated.has(address)) return;
  const cmds = Object.entries(UNDECORATED_PROPS).map(
    ([prop, value]) => `dispatch hl.dsp.window.set_prop({ prop = "${prop}", value = "${value}", window = ${sel(address)} })`
  );
  await hyprctl(['--batch', cmds.join(' ; ')]);
  undecorated.add(address);
}

const PLACE_ATTEMPTS = 12;
const PLACE_RETRY_MS = 250;
let generation = 0;
// A focus hand-back still owed by a superseded call.
let owedFocus = null;

/**
 * Put the window (found by pid + title) in the bottom-right corner of `monitor`,
 * pinned. `size()` returns the window's current {width, height}; a newer call
 * supersedes an older one still retrying. Pass `previousFocus` (from
 * focusedWindow()) to restore focus after a show. Resolves false when not on
 * Hyprland or the monitor isn't connected.
 */
async function pinToMonitor({ pid, title, monitor, size, previousFocus }) {
  if (!available() || !monitor) return false;
  const mine = ++generation;
  const focusBack = previousFocus || owedFocus;
  owedFocus = focusBack;
  const mon = (await json('monitors')).find((m) => m.name === monitor);
  if (!mon) return false;

  // A freshly mapped window gets Hyprland's own placement a moment after it
  // appears, which can undo ours; re-apply until it sticks.
  for (let attempt = 0; attempt < PLACE_ATTEMPTS && mine === generation; attempt++) {
    const win = await findWindow(pid, title);
    if (!win) return false;
    await undecorate(win.address).catch(() => {});
    const { width: w, height: h } = size();
    const x = Math.round(mon.x + mon.width / mon.scale - w - MARGIN);
    const y = Math.round(mon.y + mon.height / mon.scale - h - MARGIN);
    const placed = win.monitor === mon.id && win.floating && win.pinned && win.at[0] === x && win.at[1] === y;
    const focusTaken = focusBack && focusBack !== win.address && (await activeAddress()) !== focusBack;
    if (placed && !focusTaken) {
      owedFocus = null;
      return true;
    }

    const target = sel(win.address);
    const cmds = [];
    if (win.monitor !== mon.id) cmds.push(`hl.dsp.window.move({ monitor = "${monitor}", follow = false, window = ${target} })`);
    if (!win.floating) cmds.push(`hl.dsp.window.float({ action = "on", window = ${target} })`);
    cmds.push(`hl.dsp.window.move({ x = ${x}, y = ${y}, window = ${target} })`);
    if (!win.pinned) cmds.push(`hl.dsp.window.pin({ action = "on", window = ${target} })`);
    if (focusTaken) cmds.push(`hl.dsp.focus({ window = ${sel(focusBack)} })`);
    await hyprctl(['--batch', cmds.map((c) => `dispatch ${c}`).join(' ; ')]);
    await new Promise((r) => setTimeout(r, PLACE_RETRY_MS));
  }
  return false;
}

/** The focused window's address, to hand focus back after a silent show. */
const focusedWindow = () => (available() ? activeAddress() : Promise.resolve(null));

// Events after which a pinned window may have been carried off its monitor:
// workspace switches (a script that moves workspaces between monitors takes
// pinned windows along), window moves, and monitor hotplug.
const DISPLACING = new Set(['workspacev2', 'moveworkspacev2', 'movewindowv2', 'monitoradded', 'monitoraddedv2']);

/**
 * Call `onChange` (debounced) when the window titled `title` (re)opens or might
 * have been displaced. Electron re-maps its window shortly after the first
 * show, so one-off placement isn't enough. Reconnects if Hyprland restarts.
 */
function watch(title, onChange) {
  if (!available()) return;
  const socket = path.join(
    process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`,
    'hypr',
    process.env.HYPRLAND_INSTANCE_SIGNATURE,
    '.socket2.sock'
  );
  let timer = null;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 250);
  };
  const connect = () => {
    const conn = net.createConnection(socket);
    let buffer = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const [event, data = ''] = line.split('>>');
        if (event === 'openwindow' && data.split(',').slice(3).join(',') === title) fire();
        else if (event === 'windowtitlev2' && data.split(',').slice(1).join(',') === title) fire();
        else if (DISPLACING.has(event)) fire();
      }
    });
    conn.on('error', () => {});
    conn.on('close', () => setTimeout(connect, 2000).unref());
    conn.unref();
  };
  connect();
}

async function focusedMonitor() {
  if (!available()) return null;
  try {
    return ((await json('monitors')).find((m) => m.focused) || {}).name || null;
  } catch {
    return null;
  }
}

module.exports = { available, pinToMonitor, focusedWindow, focusedMonitor, watch };

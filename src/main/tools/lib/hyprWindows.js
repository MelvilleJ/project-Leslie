'use strict';

// Finding and driving other apps' windows through Hyprland (0.55+ Lua dispatchers).

const { execFile } = require('node:child_process');
const hyprland = require('../../hyprland');
const { compact } = require('./linuxApps');

function run(cmd, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout) => resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout) }));
  });
}

// LESLIE's own windows are never driven this way.
const isLeslie = (c) => c.class === 'project-leslie' || c.pid === process.pid;

async function clients() {
  if (!hyprland.available()) return [];
  const res = await run('hyprctl', ['-j', 'clients']);
  if (!res.ok) return [];
  return JSON.parse(res.stdout).filter((c) => !isLeslie(c));
}

/** Windows whose title or class matches `name` (Steam games are found by their title). */
async function matchingWindows(name) {
  const q = compact(name);
  return (await clients()).filter((c) =>
    [c.title, c.class, c.initialClass, c.initialTitle].some((label) => {
      const l = compact(label);
      return l && (l === q || (q.length >= 4 && l.includes(q)));
    })
  );
}

const byRecentFocus = (a, b) => a.focusHistoryID - b.focusHistoryID;

/**
 * The window the user means: the most recently focused one matching `name`, or
 * with no name, the last one they used. Talking to LESLIE focuses her, so her
 * window is skipped.
 */
async function targetWindow(name) {
  const list = name ? await matchingWindows(name) : await clients();
  return list.sort(byRecentFocus)[0] || null;
}

const sel = (address) => `"address:${address}"`;

async function dispatch(...calls) {
  const res = await run('hyprctl', ['--batch', calls.map((c) => `dispatch ${c}`).join(' ; ')]);
  if (!res.ok || /error/i.test(res.stdout)) throw new Error(`Hyprland refused: ${res.stdout.trim() || 'hyprctl failed'}`);
}

module.exports = { run, clients, matchingWindows, targetWindow, sel, dispatch };

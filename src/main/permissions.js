'use strict';

// Approval prompts (Leslie's own confirms and pi extension dialogs) live in a
// window of their own so they never interleave with the chat transcript.

const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const ROOT = path.join(__dirname, '..', '..');

/** @type {BrowserWindow | null} */
let win = null;
let icon;
// id -> { prompt, respond, timer }
const pending = new Map();

function createWindow() {
  win = new BrowserWindow({
    icon,
    width: 440,
    height: 380,
    minWidth: 320,
    minHeight: 200,
    show: false,
    alwaysOnTop: true,
    title: 'LESLIE — Permissions',
    backgroundColor: '#161619',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1d1d21', symbolColor: '#c9c9cf', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'permissionsPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'permissions.html'));

  // Closing the window is a "no" to everything still waiting.
  win.on('close', (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
    for (const id of [...pending.keys()]) settle(id, declinePayload(pending.get(id).prompt));
    win.hide();
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function reveal() {
  if (!win || win.isDestroyed()) createWindow();
  if (!win.isVisible()) win.show();
  win.focus();
}

function declinePayload(prompt) {
  if (prompt.method === 'approve') return { approved: false };
  if (prompt.method === 'confirm') return { confirmed: false };
  return { cancelled: true };
}

function drop(id) {
  const entry = pending.get(id);
  if (!entry) return null;
  clearTimeout(entry.timer);
  pending.delete(id);
  send('permissions:remove', id);
  if (!pending.size && win && !win.isDestroyed()) win.hide();
  return entry;
}

function settle(id, payload) {
  const entry = drop(id);
  if (entry) entry.respond(payload || declinePayload(entry.prompt));
}

/**
 * Queue a prompt and show the window.
 * @param {{id:string, method:'approve'|'confirm'|'select'|'input'|'editor', source:'leslie'|'pi',
 *          title?:string, message?:string, options?:string[], placeholder?:string, prefill?:string}} prompt
 * @param {(payload:object) => void} respond called once with the user's answer
 * @param {number} [timeoutMs] retire the prompt unanswered (its owner times out on its own)
 */
function request(prompt, respond, timeoutMs) {
  const timer = timeoutMs ? setTimeout(() => drop(prompt.id), timeoutMs) : null;
  pending.set(prompt.id, { prompt, respond, timer });
  reveal();
  send('permissions:add', prompt);
}

function decline(id) {
  const entry = pending.get(id);
  if (entry) settle(id, declinePayload(entry.prompt));
}

/** Decline every open prompt from `source` (e.g. the turn was cancelled). */
function declineAll(source) {
  for (const [id, { prompt }] of pending) if (prompt.source === source) settle(id, declinePayload(prompt));
}

function init(opts) {
  icon = opts.icon;
  ipcMain.handle('permissions:list', () => [...pending.values()].map((e) => e.prompt));
  ipcMain.handle('permissions:respond', (_event, { id, payload } = {}) => settle(id, payload));
}

function window() {
  return win;
}

module.exports = { init, request, decline, declineAll, window };

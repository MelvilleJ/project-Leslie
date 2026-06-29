'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, session, shell, protocol, net, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const agent = require('./agent');
const config = require('./config');
const settings = require('./settings');
const memory = require('./memory');
const configStore = require('./configStore');
const conversations = require('./conversations');
const sysmon = require('./sysmon');
const animations = require('./animations');
const { parseSpriteCss } = require('./spriteGrid');

const isDev = process.argv.includes('--dev');

const ROOT = path.join(__dirname, '..', '..');

// Custom scheme that serves uploaded spritesheet PNGs from userData to the
// renderers. Must be registered as privileged BEFORE the app is ready so it can
// be used as an <img>/background-image source under a strict CSP.
protocol.registerSchemesAsPrivileged([
  { scheme: 'leslie-sprite', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

/** @type {BrowserWindow | null} */
let companionWindow = null;
/** @type {BrowserWindow | null} */
let detailWindow = null;
/** @type {BrowserWindow | null} */
let voiceWindow = null;
/** @type {BrowserWindow | null} */
let settingsWindow = null;
/** @type {Tray | null} */
let tray = null;

const WINDOW_WIDTH = 260;
const WINDOW_HEIGHT = 620;

// --- Theme accent ----------------------------------------------------------
// A single user-chosen accent colour drives the whole UI (--accent in CSS).
// Persisted, and broadcast live to every window when changed from the picker.
const DEFAULT_ACCENT = '#9b7bff';
const isHex = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);

function getAccent() {
  const v = settings.get('theme.accent', DEFAULT_ACCENT);
  return isHex(v) ? v.toLowerCase() : DEFAULT_ACCENT;
}

function broadcastTheme(color) {
  for (const w of [companionWindow, detailWindow, settingsWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send('theme:changed', color);
  }
}

function setAccent(color) {
  const v = isHex(color) ? color.toLowerCase() : DEFAULT_ACCENT;
  settings.set('theme.accent', v);
  broadcastTheme(v);
  return v;
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const margin = 24;
  const x = workArea.x + workArea.width - WINDOW_WIDTH - margin;
  const y = workArea.y + workArea.height - WINDOW_HEIGHT - margin;

  companionWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  companionWindow.setAlwaysOnTop(true, 'screen-saver');
  companionWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  companionWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

  if (isDev) {
    companionWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Tell the renderer the companion is being dragged so it can play a "moving"
  // animation. The frameless window is dragged natively (-webkit-app-region:
  // drag), so the renderer never sees the mouse — this 'move' event is the only
  // hook. Coalesced to one message per frame.
  let movePending = false;
  companionWindow.on('move', () => {
    if (movePending) return;
    movePending = true;
    setImmediate(() => {
      movePending = false;
      toCompanion('window:moved');
    });
  });

  companionWindow.on('closed', () => {
    companionWindow = null;
  });
}

// Push the current animation library + bindings to whichever windows care.
function broadcastAnimations() {
  const cfg = animations.getConfig();
  for (const w of [companionWindow, settingsWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send('animations:changed', cfg);
  }
}

function buildTrayMenu() {
  const modeItem = (label, mode) => ({
    label,
    type: 'radio',
    checked: currentMode() === mode,
    click: () => applyMode(mode)
  });
  return Menu.buildFromTemplate([
    {
      label: 'Show / Hide',
      click: () => {
        if (!companionWindow) return;
        companionWindow.isVisible() ? companionWindow.hide() : companionWindow.show();
      }
    },
    { label: 'Settings…', click: () => showSettingsWindow() },
    {
      label: 'New conversation',
      click: () => {
        agent.reset();
        toSettings('settings:conversations-changed');
      }
    },
    {
      label: 'Mode',
      submenu: [
        modeItem('Chat', 'chat'),
        modeItem('Plan (read-only, propose)', 'plan'),
        modeItem('Agent (run commands)', 'agent')
      ]
    },
    { type: 'separator' },
    {
      label: 'Learning mode',
      type: 'checkbox',
      checked: config.learningMode,
      click: (item) => {
        configStore.set('learningMode', item.checked);
        if (tray) tray.setContextMenu(buildTrayMenu());
        toSettings('settings:config-changed', { key: 'learningMode', value: config.learningMode });
      }
    },
    {
      label: 'Memories',
      submenu: [
        { label: 'View memories…', click: () => showMemories() },
        {
          label: 'Forget all memories',
          click: () => {
            memory.clear();
            showMemories();
          }
        }
      ]
    },
    { type: 'separator' },
    { label: 'Quit LESLIE', click: () => app.quit() }
  ]);
}

function createTray() {
  const icon = nativeImage
    .createFromPath(path.join(ROOT, 'assets', 'spritesheet.png'))
    .resize({ width: 16, height: 16 });

  tray = new Tray(icon);
  tray.setToolTip('LESLIE - desktop companion');
  tray.setContextMenu(buildTrayMenu());
}

function currentMode() {
  if (config.planMode) return 'plan';
  if (config.agentMode) return 'agent';
  return 'chat';
}

function applyMode(mode) {
  const m = ['chat', 'plan', 'agent'].includes(mode) ? mode : 'chat';
  config.planMode = m === 'plan';
  config.agentMode = m === 'agent';
  settings.set('planMode', config.planMode);
  settings.set('agentMode', config.agentMode);
  if (tray) tray.setContextMenu(buildTrayMenu());
  toCompanion('agent:mode', currentMode());
  toSettings('agent:mode', currentMode());
  return currentMode();
}

function createDetailWindow() {
  detailWindow = new BrowserWindow({
    width: 760,
    height: 640,
    show: false,
    title: 'LESLIE — Details',
    backgroundColor: '#161619',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      // Match the neutral #bar so the native caption area blends with it.
      color: '#1d1d21',
      symbolColor: '#c9c9cf',
      height: 44
    },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'detailPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  });

  detailWindow.setMenuBarVisibility(false);
  detailWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'detail.html'));

  detailWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      detailWindow.hide();
    }
  });
}

function showDetailWindow() {
  if (!detailWindow || detailWindow.isDestroyed()) createDetailWindow();
  if (!detailWindow.isVisible()) detailWindow.show();
  return detailWindow;
}

function showMemories() {
  const items = memory.list();
  const body = items.length
    ? items.map((m) => `- ${m.text}  _(${m.source})_`).join('\n')
    : '_Nothing remembered yet. Tell Leslie a preference, or just keep chatting._';
  const md = `# What Leslie remembers\n\n${body}`;
  const win = showDetailWindow();
  win.webContents.send('detail:begin', { question: 'Memories' });
  win.webContents.send('detail:chunk', md);
  win.webContents.send('detail:end');
}

function createSettingsWindow() {
  settingsWindow = new BrowserWindow({
    width: 880,
    height: 680,
    minWidth: 560,
    minHeight: 480,
    show: false,
    title: 'LESLIE — Settings',
    backgroundColor: '#161619',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1d1d21',
      symbolColor: '#c9c9cf',
      height: 44
    },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settingsPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'settings.html'));

  settingsWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      settingsWindow.hide();
    }
  });
}

function showSettingsWindow() {
  if (!settingsWindow || settingsWindow.isDestroyed()) createSettingsWindow();
  if (!settingsWindow.isVisible()) settingsWindow.show();
  settingsWindow.focus();
  return settingsWindow;
}

function toSettings(channel, payload) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(channel, payload);
  }
}

function createVoiceWindow() {
  voiceWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'voicePreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  voiceWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'voice.html'));

  voiceWindow.webContents.on('did-finish-load', () => {
    voiceWindow.webContents.send('voice:init', {
      sttBackend: config.sttBackend,
      sttModel: config.sttModel,
      sttServerUrl: config.sttServerUrl,
      sttServerModel: config.sttServerModel,
      sttServerApiKey: config.sttServerApiKey,
      wakeWord: config.wakeWord,
      wakeTimeoutMs: config.wakeTimeoutMs
    });
  });

  voiceWindow.on('closed', () => {
    voiceWindow = null;
  });
}

function controlVoice(action, value) {
  if (voiceWindow && !voiceWindow.isDestroyed()) {
    voiceWindow.webContents.send('voice:control', { action, value });
  }
}

function reinitVoice() {
  if (!voiceWindow || voiceWindow.isDestroyed()) return;
  voiceWindow.webContents.send('voice:init', {
    sttBackend: config.sttBackend,
    sttModel: config.sttModel,
    sttServerUrl: config.sttServerUrl,
    sttServerModel: config.sttServerModel,
    sttServerApiKey: config.sttServerApiKey,
    wakeWord: config.wakeWord,
    wakeTimeoutMs: config.wakeTimeoutMs
  });
}

function toCompanion(channel, payload) {
  if (companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.webContents.send(channel, payload);
  }
}

function countSentences(text) {
  const t = (text || '').trim();
  if (!t) return 0;
  const terminators = (t.match(/[.!?]+(?=\s|$)/g) || []).length;
  const trailing = /[.!?]["')\]]*\s*$/.test(t) ? 0 : 1;
  return terminators + trailing;
}

function firstSentence(text) {
  const t = (text || '').trim();
  const m = t.match(/^[\s\S]*?[.!?]["')\]]*(?=\s|$)/);
  return (m ? m[0] : t).trim();
}

ipcMain.handle('agent:message', async (event, text) => {
  const sender = event.sender;
  let detailOpen = false;
  let detailPending = '';

  let summaryBuf = '';
  let summaryPromoted = false;

  const openDetailText = (chunk) => {
    const win = showDetailWindow();
    if (!detailOpen) {
      win.webContents.send('detail:begin', { question: text });
      detailOpen = true;
    }
    win.webContents.send('detail:chunk', chunk);
  };

  try {
    const reply = await agent.sendMessage(text, (ev) => {
      if (sender.isDestroyed()) return;
      switch (ev.type) {
        case 'thinking':
          sender.send('agent:think', ev.text);
          break;
        case 'summary':
          summaryBuf += ev.text;
          if (summaryPromoted) {
            openDetailText(ev.text);
          } else if (countSentences(summaryBuf) > config.detailSentenceThreshold) {
            summaryPromoted = true;
            openDetailText(summaryBuf);
            sender.send('agent:to-details', { teaser: firstSentence(summaryBuf) });
          } else {
            sender.send('agent:chunk', ev.text);
          }
          break;
        case 'details':
          if (!detailOpen) {
            detailPending += ev.text;
            if (detailPending.trim()) {
              openDetailText(detailPending);
              detailPending = '';
            }
          } else {
            openDetailText(ev.text);
          }
          break;
        case 'open-url':
          // Open web pages in the user's real default browser, not the in-app
          // detail window (handles auth, extensions, sites that block embedding).
          shell.openExternal(ev.url).catch((err) => {
            console.warn('[open-url] openExternal failed:', err && err.message);
          });
          break;
        case 'tool':
          // A tool call started — let the companion flash a "tool-call" animation.
          sender.send('agent:tool', ev.name);
          break;
        case 'confirm':
          sender.send('agent:confirm', { id: ev.id, message: ev.message });
          break;
      }
    });

    if (detailOpen && detailWindow && !detailWindow.isDestroyed()) {
      detailWindow.webContents.send('detail:end');
    }
    return summaryPromoted
      ? { reply, openedInDetails: true, teaser: firstSentence(summaryBuf) }
      : { reply };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('agent:reset', () => {
  agent.reset();
  return { ok: true };
});

ipcMain.handle('agent:confirm-response', (_event, { id, approved } = {}) => {
  agent.resolveConfirm(id, approved);
  return { ok: true };
});

ipcMain.handle('agent:get-mode', () => currentMode());
ipcMain.handle('agent:set-mode', (_event, mode) => applyMode(mode));

ipcMain.handle('theme:get', () => getAccent());
ipcMain.handle('theme:set', (_event, color) => setAccent(color));

ipcMain.handle('settings:schema', () => configStore.schema());
ipcMain.handle('settings:get-all', () => ({
  values: configStore.snapshot(),
  mode: currentMode()
}));
ipcMain.handle('settings:set', (_event, { key, value } = {}) => {
  const res = configStore.set(key, value);
  if (res.ok) {
    if (configStore.VOICE_KEYS.includes(key)) reinitVoice();
    if (key === 'learningMode' && tray) tray.setContextMenu(buildTrayMenu());
  }
  return res;
});

ipcMain.handle('models:list', async () => {
  try {
    const headers = {};
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const res = await fetch(`${config.baseURL}/models`, { headers });
    if (!res.ok) return { ok: false, error: `Server responded ${res.status} ${res.statusText}` };
    const data = await res.json();
    const ids = (data.data || data.models || [])
      .map((m) => (typeof m === 'string' ? m : m.id || m.name))
      .filter(Boolean);
    return { ok: true, models: ids };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});
ipcMain.handle('models:test', async () => {
  try {
    const headers = {};
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const res = await fetch(`${config.baseURL}/models`, { headers });
    return res.ok
      ? { ok: true }
      : { ok: false, error: `Server responded ${res.status} ${res.statusText}` };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('conv:list', () => conversations.list());
ipcMain.handle('conv:get', (_event, id) => conversations.get(id));
ipcMain.handle('conv:resume', (_event, id) => {
  const ok = agent.resume(id);
  return { ok };
});
ipcMain.handle('conv:delete', (_event, id) => ({ ok: conversations.remove(id) }));
ipcMain.handle('conv:clear', () => {
  conversations.clear();
  agent.reset();
  return { ok: true };
});
ipcMain.handle('conv:new', () => {
  agent.reset();
  return { ok: true };
});

ipcMain.handle('memory:list', () => memory.list());
ipcMain.handle('memory:delete', (_event, id) => ({ ok: memory.remove(id) }));
ipcMain.handle('memory:clear', () => {
  memory.clear();
  return { ok: true };
});

ipcMain.handle('sys:sample', () => sysmon.sample());

// --- Animations ------------------------------------------------------------
// Library + state bindings for the companion sprite. Mutations broadcast the
// fresh config to the companion (and settings) so the change applies live.
ipcMain.handle('anim:config', () => animations.getConfig());

ipcMain.handle('anim:import', async () => {
  const parent = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : undefined;
  const png = await dialog.showOpenDialog(parent, {
    title: 'Choose a spritesheet PNG',
    filters: [{ name: 'PNG image', extensions: ['png'] }],
    properties: ['openFile']
  });
  if (png.canceled || !png.filePaths[0]) return { cancelled: true };
  const pngPath = png.filePaths[0];

  // Optional: the matching spritesheet.css to auto-derive the grid. Cancel to
  // enter the grid by hand afterwards.
  const cssPick = await dialog.showOpenDialog(parent, {
    title: 'Choose the matching spritesheet.css (Cancel to enter the grid manually)',
    filters: [{ name: 'CSS', extensions: ['css'] }],
    properties: ['openFile']
  });
  let grid = {};
  if (!cssPick.canceled && cssPick.filePaths[0]) {
    try {
      grid = parseSpriteCss(fs.readFileSync(cssPick.filePaths[0], 'utf8'));
    } catch {
      grid = {};
    }
  }

  try {
    const name = path.basename(pngPath).replace(/\.png$/i, '');
    const clip = animations.importClip({ name, pngPath, grid, frameMs: 140 });
    broadcastAnimations();
    return { ok: true, clip, config: animations.getConfig() };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('anim:update', (_event, { id, patch } = {}) => {
  const clip = animations.updateClip(id, patch || {});
  broadcastAnimations();
  return { ok: Boolean(clip), clip, config: animations.getConfig() };
});

ipcMain.handle('anim:delete', (_event, id) => {
  const ok = animations.removeClip(id);
  broadcastAnimations();
  return { ok, config: animations.getConfig() };
});

ipcMain.handle('anim:set-binding', (_event, { state, ids } = {}) => {
  const bindings = animations.setBinding(state, ids);
  broadcastAnimations();
  return { ok: true, bindings, config: animations.getConfig() };
});

ipcMain.on('settings:open', () => showSettingsWindow());

ipcMain.on('window:fit-height', (_event, desiredHeight) => {
  if (!companionWindow) return;
  const bounds = companionWindow.getBounds();
  const { workArea } = screen.getDisplayMatching(bounds);
  const minH = WINDOW_HEIGHT;
  const maxH = Math.max(minH, Math.min(workArea.height - 16, 720));
  const height = Math.round(Math.min(maxH, Math.max(minH, desiredHeight)));
  if (height === bounds.height) return;

  const bottom = bounds.y + bounds.height;
  let y = bottom - height;
  if (y < workArea.y) y = workArea.y;
  companionWindow.setBounds({ x: bounds.x, y, width: bounds.width, height });
});

ipcMain.on('window:hide', () => {
  if (companionWindow) companionWindow.hide();
});

ipcMain.on('app:quit', () => app.quit());

ipcMain.on('voice:wake', (_event, payload) => {
  if (companionWindow) companionWindow.show();
  toCompanion('leslie:voice-wake', payload || {});
});
ipcMain.on('voice:final', (_event, payload) => {
  toCompanion('leslie:voice-final', { ...(payload || {}), autoSend: config.voiceAutoSend });
});
ipcMain.on('voice:status', (_event, payload) => {
  toCompanion('leslie:voice-status', payload || {});
});

ipcMain.on('voice:set-active', (_event, value) => controlVoice('set-active', !!value));
ipcMain.on('voice:listen-once', () => controlVoice('listen-once'));

app.whenReady().then(() => {
  // Serve uploaded spritesheets: leslie-sprite://clips/<id>.png -> userData file.
  // basename guards against path traversal in the URL.
  protocol.handle('leslie-sprite', (request) => {
    try {
      const url = new URL(request.url);
      const file = path.join(animations.clipsDir(), path.basename(url.pathname));
      return net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  const allowMedia = (permission) => permission === 'media' || permission === 'audioCapture';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowMedia(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  config.agentMode = settings.get('agentMode', config.agentMode);
  config.planMode = settings.get('planMode', config.planMode);
  config.learningMode = settings.get('learningMode', config.learningMode);
  if (config.planMode) config.agentMode = false;

  configStore.applyPersisted();

  createWindow();
  createDetailWindow();
  if (config.voiceEnabled) createVoiceWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('window-all-closed', () => {
});

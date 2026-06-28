'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, session } = require('electron');
const path = require('node:path');
const agent = require('./agent');
const config = require('./config');
const settings = require('./settings');
const memory = require('./memory');
const configStore = require('./configStore');
const conversations = require('./conversations');
const sysmon = require('./sysmon');

const isDev = process.argv.includes('--dev');

// Project root (two levels up from src/main).
const ROOT = path.join(__dirname, '..', '..');

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

// Window size. Tall enough for the 537px-tall sprite plus the input row;
// the speech/thought bubbles grow the window further via window:fit-height.
const WINDOW_WIDTH = 260;
const WINDOW_HEIGHT = 620;

function createWindow() {
  // Anchor the companion to the bottom-right of the primary display's work area.
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
    // Keeps the companion above normal windows but it can still be focused for input.
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Float above fullscreen apps too.
  companionWindow.setAlwaysOnTop(true, 'screen-saver');
  companionWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  companionWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

  if (isDev) {
    companionWindow.webContents.openDevTools({ mode: 'detach' });
  }

  companionWindow.on('closed', () => {
    companionWindow = null;
  });
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
  // Reuse the spritesheet for a quick tray icon (cropped to the first frame, squished to 16px).
  // TODO: replace with a dedicated tray icon asset.
  const icon = nativeImage
    .createFromPath(path.join(ROOT, 'assets', 'spritesheet.png'))
    .resize({ width: 16, height: 16 });

  tray = new Tray(icon);
  tray.setToolTip('LESLIE - desktop companion');
  tray.setContextMenu(buildTrayMenu());
}

// LESLIE has three mutually-exclusive operating modes, derived from the two
// underlying config flags (so there is a single source of truth):
//   chat  — conversation only, no shell tools     (agentMode off, planMode off)
//   plan  — read-only investigate, propose a plan (planMode on)
//   agent — may run commands / install software    (agentMode on)
function currentMode() {
  if (config.planMode) return 'plan';
  if (config.agentMode) return 'agent';
  return 'chat';
}

// Switch mode at runtime: update the config flags (the tools registry + agent
// loop read them live), persist them, and keep the tray + companion UI in sync.
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

// ---------------------------------------------------------------------------
// Detail window — shows long answers, or an opened URL / search results.
// Created hidden up front so it's loaded and ready; hidden (not destroyed) on
// close so it can be reused.
// ---------------------------------------------------------------------------
function createDetailWindow() {
  detailWindow = new BrowserWindow({
    width: 760,
    height: 640,
    show: false,
    title: 'LESLIE — Details',
    backgroundColor: '#1a1a2e',
    // Hide the native title bar but keep the OS min/max/close controls, themed
    // dark to blend with the glass UI. The in-page #bar becomes the drag handle.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#16162b',
      symbolColor: '#c6c6d6',
      height: 44
    },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'detailPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true // allow the <webview> used for the web view
    }
  });

  detailWindow.setMenuBarVisibility(false);
  detailWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'detail.html'));

  // Hide instead of close so the window (and its loaded renderer) survives.
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

// Render the learned memories as markdown in the detail window, reusing the same
// begin/chunk/end protocol long answers use.
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

// ---------------------------------------------------------------------------
// Settings window — the "application menu": past conversations, live system
// monitor (CPU/GPU/RAM), model + behaviour configuration, and memory management.
// Created on demand; hidden (not destroyed) on close so it stays loaded.
// ---------------------------------------------------------------------------
function createSettingsWindow() {
  settingsWindow = new BrowserWindow({
    width: 880,
    height: 680,
    minWidth: 560,
    minHeight: 480,
    show: false,
    title: 'LESLIE — Settings',
    backgroundColor: '#16162b',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#16162b',
      symbolColor: '#c6c6d6',
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

// Relay an event to the settings window if it's open (no-op otherwise).
function toSettings(channel, payload) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// Voice window — hidden worker that runs the mic + VAD + Whisper pipeline and
// reports wake/command/status over IPC. Kept off-screen; never shown.
// ---------------------------------------------------------------------------
function createVoiceWindow() {
  voiceWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'voicePreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep listening while hidden/minimised
      autoplayPolicy: 'no-user-gesture-required' // let the mic AudioContext start
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

// Forward a control message to the voice window (no-op if voice is disabled).
function controlVoice(action, value) {
  if (voiceWindow && !voiceWindow.isDestroyed()) {
    voiceWindow.webContents.send('voice:control', { action, value });
  }
}

// Re-push voice config (e.g. wake word changed in settings) so the running
// pipeline picks it up without restarting the app.
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

// Relay a voice event to the companion renderer.
function toCompanion(channel, payload) {
  if (companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.webContents.send(channel, payload);
  }
}

// Count sentences in a blob of text. A terminator (. ! ?) followed by space or
// end closes a sentence; an unterminated trailing clause counts as one more, so
// "A. B. C. D" reads as 4. Decimals like "3.5" don't trip it (no trailing space).
function countSentences(text) {
  const t = (text || '').trim();
  if (!t) return 0;
  const terminators = (t.match(/[.!?]+(?=\s|$)/g) || []).length;
  const trailing = /[.!?]["')\]]*\s*$/.test(t) ? 0 : 1;
  return terminators + trailing;
}

// First sentence (or the whole thing if it has no terminator) — used as the
// bubble teaser when a long answer is moved to the details window.
function firstSentence(text) {
  const t = (text || '').trim();
  const m = t.match(/^[\s\S]*?[.!?]["')\]]*(?=\s|$)/);
  return (m ? m[0] : t).trim();
}

// ---------------------------------------------------------------------------
// IPC: agent bridge
// ---------------------------------------------------------------------------
// The renderer sends a message and awaits the summary; meanwhile we stream
// deltas live: reasoning -> 'agent:think', summary -> 'agent:chunk', and the
// details -> the detail window (opened automatically). A tool may also ask to
// open a URL, which switches the detail window to its web view.
ipcMain.handle('agent:message', async (event, text) => {
  const sender = event.sender;
  let detailOpen = false;
  let detailPending = ''; // buffer leading whitespace until real detail arrives

  // Summary-to-details promotion: once the running summary exceeds the sentence
  // threshold, the whole answer belongs in the details window, not the small
  // bubble. We then divert all further summary text there and leave a teaser.
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
            openDetailText(ev.text); // already promoted — route to details
          } else if (countSentences(summaryBuf) > config.detailSentenceThreshold) {
            // Just crossed the threshold: move the summary-so-far to details,
            // tell the renderer to collapse the bubble to a teaser, and divert
            // the rest of the summary to the details window.
            summaryPromoted = true;
            openDetailText(summaryBuf);
            sender.send('agent:to-details', { teaser: firstSentence(summaryBuf) });
          } else {
            sender.send('agent:chunk', ev.text); // short so far — bubble as usual
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
          showDetailWindow().webContents.send('detail:url', ev.url);
          break;
        case 'confirm':
          // Ask the user to approve a risky action; answer returns via
          // 'agent:confirm-response' below and unblocks the tool.
          sender.send('agent:confirm', { id: ev.id, message: ev.message });
          break;
      }
    });

    if (detailOpen && detailWindow && !detailWindow.isDestroyed()) {
      detailWindow.webContents.send('detail:end');
    }
    // openedInDetails: tell the renderer to show the teaser (not the full reply)
    // when the answer was diverted to the details window.
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

// The renderer's Approve/Deny answer to a pending agent confirmation.
ipcMain.handle('agent:confirm-response', (_event, { id, approved } = {}) => {
  agent.resolveConfirm(id, approved);
  return { ok: true };
});

// Mode switcher: read the current mode ('chat'|'plan'|'agent'), or set it from
// the UI. Returns the resulting mode so the renderer can reflect it.
ipcMain.handle('agent:get-mode', () => currentMode());
ipcMain.handle('agent:set-mode', (_event, mode) => applyMode(mode));

// ---------------------------------------------------------------------------
// IPC: settings window (config / conversations / memory / system monitor)
// ---------------------------------------------------------------------------

// Config: the editable schema, current values, and per-field updates.
ipcMain.handle('settings:schema', () => configStore.schema());
ipcMain.handle('settings:get-all', () => ({
  values: configStore.snapshot(),
  mode: currentMode()
}));
ipcMain.handle('settings:set', (_event, { key, value } = {}) => {
  const res = configStore.set(key, value);
  if (res.ok) {
    // Some fields need a live side-effect beyond mutating config:
    if (configStore.VOICE_KEYS.includes(key)) reinitVoice();
    if (key === 'learningMode' && tray) tray.setContextMenu(buildTrayMenu());
  }
  return res;
});

// Models: list what the configured server advertises, and a connection probe.
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

// Conversations: list/get past transcripts, resume one into context, delete.
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

// Memory: list/delete the durable preferences learning mode stores.
ipcMain.handle('memory:list', () => memory.list());
ipcMain.handle('memory:delete', (_event, id) => ({ ok: memory.remove(id) }));
ipcMain.handle('memory:clear', () => {
  memory.clear();
  return { ok: true };
});

// System monitor: one live CPU/GPU/RAM/app sample (renderer polls on a timer).
ipcMain.handle('sys:sample', () => sysmon.sample());

// Open the settings window from the companion (gear button / /settings command).
ipcMain.on('settings:open', () => showSettingsWindow());

// Resize the window to fit its content, keeping the BOTTOM edge pinned so the
// sprite stays put on screen while the bubble grows upward. Driven by the
// renderer whenever the bubble/input changes size.
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
  if (y < workArea.y) y = workArea.y; // don't run off the top of the screen
  companionWindow.setBounds({ x: bounds.x, y, width: bounds.width, height });
});

ipcMain.on('window:hide', () => {
  if (companionWindow) companionWindow.hide();
});

ipcMain.on('app:quit', () => app.quit());

// --- Voice bridge ----------------------------------------------------------
// From the voice window:
ipcMain.on('voice:wake', (_event, payload) => {
  // The "unhide on voice call" the user asked for.
  if (companionWindow) companionWindow.show();
  toCompanion('leslie:voice-wake', payload || {});
});
ipcMain.on('voice:final', (_event, payload) => {
  toCompanion('leslie:voice-final', { ...(payload || {}), autoSend: config.voiceAutoSend });
});
ipcMain.on('voice:status', (_event, payload) => {
  toCompanion('leslie:voice-status', payload || {});
});

// From the companion window:
ipcMain.on('voice:set-active', (_event, value) => controlVoice('set-active', !!value));
ipcMain.on('voice:listen-once', () => controlVoice('listen-once'));

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  // Grant microphone access to our own windows (Electron denies media by default).
  const allowMedia = (permission) => permission === 'media' || permission === 'audioCapture';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowMedia(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // Previously-saved UI mode overrides the .env defaults. planMode wins if both
  // somehow persisted true (applyMode keeps them exclusive, but be defensive).
  config.agentMode = settings.get('agentMode', config.agentMode);
  config.planMode = settings.get('planMode', config.planMode);
  // Legacy: learningMode used to persist under its own key; it now rides on the
  // configStore (cfg.learningMode). Honour the old key as a fallback first.
  config.learningMode = settings.get('learningMode', config.learningMode);
  if (config.planMode) config.agentMode = false;

  // Re-apply persisted settings-window overrides on top of the .env defaults.
  configStore.applyPersisted();

  createWindow();
  createDetailWindow();
  if (config.voiceEnabled) createVoiceWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Let close handlers know a real quit is in progress (so they stop hiding).
app.on('before-quit', () => {
  app.isQuitting = true;
});

// Keep running in the tray even when the window is closed (desktop-pet behaviour).
app.on('window-all-closed', () => {
  // Intentionally do not quit on non-macOS; the tray keeps the app alive.
});

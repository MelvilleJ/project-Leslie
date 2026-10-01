'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, session, shell, protocol, net, dialog } = require('electron');
const path = require('node:path');

// The packaged build is named "LESLIE"; keep using the same settings folder as `npm start`.
if (app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'project-leslie'));
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const agent = require('./agent');
const contextWindow = require('./contextWindow');
const modelServer = require('./server/controller');
const hyprland = require('./hyprland');
const screenRecord = require('./tools/screenRecord');
const { profileCommand } = require('./intents');
const config = require('./config');
const settings = require('./settings');
const memory = require('./memory');
const configStore = require('./configStore');
const conversations = require('./conversations');
const sysmon = require('./sysmon');
const animations = require('./animations');
const { parseSpriteCss } = require('./spriteGrid');
const fsSuggest = require('./fsSuggest');
const listDirectory = require('./tools/listDirectory');
const readFile = require('./tools/readFile');
const readDocument = require('./tools/readDocument');
const { isDocument } = require('./tools/lib/docExtract');

const isDev = process.argv.includes('--dev');

const ROOT = path.join(__dirname, '..', '..');

// Must register before app is ready to use as <img> source under CSP.
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

// Mascot floats alone (collapsed) or with chat panel (expanded), anchored to right edge.
const COLLAPSED_WIDTH = 240;
const EXPANDED_WIDTH = 640;
const PANEL_HEIGHT = 440;
const PANEL_MARGIN = 24;

// Distinguish programmatic setBounds from genuine user drag.
let lastProgrammaticMove = 0;

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
  const x = workArea.x + workArea.width - COLLAPSED_WIDTH - PANEL_MARGIN;
  const y = workArea.y + workArea.height - PANEL_HEIGHT - PANEL_MARGIN;

  companionWindow = new BrowserWindow({
    width: COLLAPSED_WIDTH,
    height: PANEL_HEIGHT,
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
  companionWindow.webContents.once('did-finish-load', () => placeCompanion());
  if (!watchingHyprland) {
    watchingHyprland = true;
    hyprland.watch('LESLIE', () => placeCompanion());
  }

  if (isDev) {
    companionWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Filter out programmatic moves (see lastProgrammaticMove) via timestamp.
  let movePending = false;
  companionWindow.on('move', () => {
    if (Date.now() - lastProgrammaticMove < 250) return;
    if (movePending) return;
    movePending = true;
    setImmediate(() => {
      movePending = false;
      toCompanion('window:moved');
    });
  });

  companionWindow.on('blur', () => toCompanion('window:blur'));

  companionWindow.on('closed', () => {
    companionWindow = null;
    screen.removeListener('display-metrics-changed', redock);
    screen.removeListener('display-added', redock);
    screen.removeListener('display-removed', redock);
  });

  screen.on('display-metrics-changed', redock);
  screen.on('display-added', redock);
  screen.on('display-removed', redock);
}

function broadcastAnimations() {
  const cfg = animations.getConfig();
  for (const w of [companionWindow, settingsWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send('animations:changed', cfg);
  }
}

let trayProfile = null;

function switchProfileFromTray(profile) {
  modelServer.switchTo(profile).catch((err) => toCompanion('pi:event', { type: 'notify', level: 'error', message: err.message }));
}

function buildTrayMenu() {
  const modeItem = (label, mode) => ({
    label,
    type: 'radio',
    checked: currentMode() === mode,
    click: () => applyMode(mode)
  });
  return Menu.buildFromTemplate([
    { label: 'Show / Hide', click: () => toggleCompanion() },
    { label: 'Settings…', click: () => showSettingsWindow() },
    {
      label: 'New conversation',
      click: () => {
        agent.reset();
        toSettings('settings:conversations-changed');
      }
    },
    {
      label: 'Model',
      submenu: [
        { label: 'Everyday (RTX 3060)', type: 'radio', checked: trayProfile === 'everyday', click: () => switchProfileFromTray('everyday') },
        { label: 'Power (both GPUs)', type: 'radio', checked: trayProfile === 'power', click: () => switchProfileFromTray('power') },
        { type: 'separator' },
        { label: 'Models & GPUs…', click: () => showSettingsWindow('server') }
      ]
    },
    {
      label: 'Mode',
      submenu: [
        modeItem('Chat', 'chat'),
        modeItem('Plan (read-only, propose)', 'plan'),
        modeItem('Agent (run commands)', 'agent'),
        modeItem('Assistant (one-off tasks, no history)', 'assistant')
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

const iconPath = (size) => path.join(ROOT, 'assets', 'icons', `leslie-${size}.png`);
const APP_ICON = iconPath(256);

function createTray() {
  const icon = nativeImage.createFromPath(iconPath(32));
  icon.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(iconPath(64)) });

  tray = new Tray(icon);
  tray.on('click', () => toggleCompanion());
  tray.setToolTip('LESLIE - desktop companion');
  tray.setContextMenu(buildTrayMenu());
}

function currentMode() {
  if (config.planMode) return 'plan';
  if (config.taskMode) return 'assistant';
  if (config.agentMode) return 'agent';
  return 'chat';
}

// Assistant mode is agent mode's tools plus taskMode (no conversation history).
function applyMode(mode) {
  const m = ['chat', 'plan', 'agent', 'assistant'].includes(mode) ? mode : 'chat';
  config.planMode = m === 'plan';
  config.agentMode = m === 'agent' || m === 'assistant';
  config.taskMode = m === 'assistant';
  settings.set('planMode', config.planMode);
  settings.set('agentMode', config.agentMode);
  settings.set('taskMode', config.taskMode);
  if (tray) tray.setContextMenu(buildTrayMenu());
  toCompanion('agent:mode', currentMode());
  toSettings('agent:mode', currentMode());
  return currentMode();
}

function createDetailWindow() {
  detailWindow = new BrowserWindow({
    icon: APP_ICON,
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
    icon: APP_ICON,
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

function showSettingsWindow(panel) {
  if (!settingsWindow || settingsWindow.isDestroyed()) createSettingsWindow();
  if (!settingsWindow.isVisible()) settingsWindow.show();
  settingsWindow.focus();
  if (panel) {
    const contents = settingsWindow.webContents;
    const send = () => contents.send('settings:show-panel', panel);
    if (contents.isLoading()) contents.once('did-finish-load', send);
    else send();
  }
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

function onEngineChanged() {
  const pi = agent.pi();
  if (pi) pi.onUiEvent((ev) => {
    toCompanion('pi:event', ev);
    toSettings('pi:event', ev);
  });
  else agent.shutdown();
  toCompanion('engine:changed', config.engine);
  toSettings('engine:changed', config.engine);
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

async function buildMentionContext(mentions) {
  if (!Array.isArray(mentions) || !mentions.length) return '';
  const seen = new Set();
  const parts = [];
  for (const m of mentions.slice(0, 10)) {
    const p = m && m.path;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    try {
      if (m.type === 'dir') {
        const r = await listDirectory.run({ path: p });
        if (r.error) parts.push(`Folder ${p}: (${r.error})`);
        else {
          const lines = (r.entries || [])
            .map((e) => `${e.type === 'dir' ? '[dir] ' : ''}${e.name}`)
            .join('\n');
          parts.push(`Folder ${r.path} — ${r.count} item(s):\n${lines}`);
        }
      } else if (isDocument(p)) {
        // Word/PDF/Excel/etc. — extract text instead of reading raw bytes.
        const r = await readDocument.run({ path: p });
        if (r.error) parts.push(`Document ${p}: (${r.error})`);
        else parts.push(`Document ${r.path} (${r.kind}${r.truncated ? ', truncated' : ''}):\n${r.content}`);
      } else {
        const r = await readFile.run({ path: p });
        if (r.error) parts.push(`File ${p}: (${r.error})`);
        else parts.push(`File ${r.path}${r.truncated ? ' (truncated)' : ''}:\n${r.content}`);
      }
    } catch (err) {
      parts.push(`${p}: (could not read — ${err && err.message ? err.message : err})`);
    }
  }
  if (!parts.length) return '';
  return `The user attached the following from their computer for you to view:\n\n${parts.join('\n\n---\n\n')}`;
}

ipcMain.handle('agent:message', async (event, payload) => {
  const sender = event.sender;
  // Back-compat: payload may be a bare string or { text, mentions }.
  const text = typeof payload === 'string' ? payload : (payload && payload.text) || '';
  const mentions = (payload && payload.mentions) || [];
  const images = (payload && payload.images) || [];

  const profile = profileCommand(text);
  if (profile) return switchProfileCommand(profile);

  modelServer.turnStarted();
  try {
    const mentionContext = await buildMentionContext(mentions);
    const { reply, aborted } = await agent.sendMessage(text, (ev) => {
      if (sender.isDestroyed()) return;
      switch (ev.type) {
        case 'thinking':
          sender.send('agent:think', ev.text);
          break;
        case 'summary':
        case 'details':
          sender.send('agent:chunk', ev.text);
          break;
        case 'open-url':
          shell.openExternal(ev.url).catch((err) => {
            console.warn('[open-url] openExternal failed:', err && err.message);
          });
          break;
        case 'set-mode':
          applyMode(ev.mode);
          break;
        case 'tool':
          sender.send('agent:tool', ev);
          break;
        case 'confirm':
          sender.send('agent:confirm', { id: ev.id, message: ev.message });
          break;
        case 'user-message':
          sender.send('agent:user-message');
          break;
      }
    }, mentionContext, images);

    return { reply, aborted };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  } finally {
    modelServer.turnEnded();
  }
});

// "power mode" / "everyday mode" — handled without the model so it is instant
// and can't be misread; progress then shows as the model loads.
async function switchProfileCommand(profile) {
  const label = profile === 'power' ? 'Power' : 'Everyday';
  try {
    const st = await modelServer.status();
    if (st.activeProfile === profile) return { reply: `${label} mode is already on.` };
    modelServer.requestSwitch(profile);
    return { reply: `Switching to ${label} mode — ${profile === 'power' ? 'about 20' : 'about 10'} seconds.` };
  } catch (err) {
    return { error: `Couldn't switch to ${label} mode: ${err.message}` };
  }
}

ipcMain.on('agent:cancel', () => {
  agent.cancel();
  if (researchAbort) researchAbort.abort();
});

ipcMain.handle('agent:reset', () => {
  agent.reset();
  return { ok: true };
});

// Deep-research bypasses the agent loop to avoid context-window saturation.
const { research: runResearch } = require('./tools/lib/deepResearch/researcher');
const { formatReport: formatResearch } = require('./tools/lib/deepResearch/report');

let researchAbort = null;

ipcMain.handle('research:run', async (event, query) => {
  const sender = event.sender;
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return { error: 'empty query' };
  await contextWindow.refresh();
  const controller = new AbortController();
  researchAbort = controller;
  try {
    const out = await runResearch(q, {
      signal: controller.signal,
      emit: (e) => {
        if (!sender.isDestroyed()) sender.send('research:progress', e);
      }
    });
    const report = formatResearch(q, out);
    // Put the finished report into the agent's history so follow-up chat turns
    // ("make a document from this") can see it — the research flow otherwise
    // bypasses the agent loop entirely.
    if (!controller.signal.aborted) agent.recordResearch(q, report);
    return { report, aborted: controller.signal.aborted };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  } finally {
    if (researchAbort === controller) researchAbort = null;
  }
});

ipcMain.handle('agent:confirm-response', (_event, { id, approved } = {}) => {
  agent.resolveConfirm(id, approved);
  return { ok: true };
});

ipcMain.handle('agent:get-mode', () => currentMode());

ipcMain.handle('engine:get', () => config.engine);

screenRecord.onChange((state) => {
  toCompanion('recording:state', state);
  if (tray) tray.setToolTip(state.recording ? 'LESLIE — recording the screen' : 'LESLIE - desktop companion');
});
ipcMain.handle('recording:state', () => screenRecord.status());
ipcMain.handle('recording:stop', () => screenRecord.stop());

const settle = (promise) =>
  promise.then((data) => ({ ok: true, data })).catch((err) => ({ ok: false, error: err && err.message ? err.message : String(err) }));

ipcMain.handle('server:status', () => settle(modelServer.status()));
ipcMain.handle('server:switch', (_event, profile) => settle(modelServer.switchTo(profile)));
ipcMain.handle('server:service', (_event, action) => settle(modelServer.service(action)));
ipcMain.handle('server:unload', () => settle(modelServer.unloadAll()));
ipcMain.handle('server:logs', () => settle(modelServer.logs(80)));
ipcMain.handle('server:settings', () => settle(Promise.resolve(modelServer.loadSettings())));
ipcMain.handle('server:save', (_event, patch) => settle(Promise.resolve().then(() => modelServer.saveSettings(patch || {}))));
ipcMain.handle('server:models', () => settle(Promise.resolve(modelServer.listModels())));

modelServer.onEvent((ev) => {
  if (ev.type === 'status') {
    const active = ev.status.activeProfile;
    if (active !== trayProfile && tray) {
      trayProfile = active;
      tray.setContextMenu(buildTrayMenu());
    }
  }
  toCompanion('server:event', ev);
  toSettings('server:event', ev);
});

function requirePi() {
  const pi = agent.pi();
  if (!pi) throw new Error('The pi engine is not active.');
  return pi;
}

ipcMain.handle('pi:command', async (_event, { name, args } = {}) => {
  try {
    return { ok: true, data: await requirePi().command(name, args) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('pi:ui-response', (_event, { id, payload } = {}) => {
  if (agent.pi()) agent.pi().respondUi(id, payload);
  return { ok: true };
});

ipcMain.handle('pi:bash', async (event, { command, excludeFromContext } = {}) => {
  const sender = event.sender;
  try {
    const data = await requirePi().runBash(String(command || ''), excludeFromContext, (delta) => {
      if (!sender.isDestroyed()) sender.send('pi:bash-chunk', delta);
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});
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
    if (['baseURL', 'model', 'apiKey'].includes(key)) contextWindow.refresh({ force: true });
    if (key === 'engine') onEngineChanged();
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

// On the pi engine the conversation list is pi's own session store, shared
// with the pi terminal UI.
ipcMain.handle('conv:list', () => (agent.pi() ? agent.pi().listSessions() : conversations.list()));
ipcMain.handle('conv:get', (_event, id) => (agent.pi() ? agent.pi().getSession(id) : conversations.get(id)));
ipcMain.handle('conv:resume', (_event, id) => {
  const ok = agent.resume(id);
  return { ok };
});
ipcMain.handle('conv:delete', async (_event, id) => {
  if (!agent.pi()) return { ok: conversations.remove(id) };
  const file = await agent.pi().sessionFileFor(id);
  if (!file) return { ok: false, error: 'Only saved, inactive sessions can be deleted.' };
  await shell.trashItem(file);
  return { ok: true };
});
ipcMain.handle('conv:clear', () => {
  if (agent.pi()) return { ok: false, error: 'Delete pi sessions one at a time.' };
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

ipcMain.handle('fs:suggest', (_event, query) => fsSuggest.suggest(query));

// Sprite animations: mutations broadcast to companion and settings.
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

ipcMain.on('settings:open', (_event, panel) => showSettingsWindow(panel));

ipcMain.on('window:set-expanded', (_event, expanded) => {
  if (!companionWindow || companionWindow.isDestroyed()) return;
  const b = companionWindow.getBounds();
  const width = expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH;
  if (b.width === width) return;
  const right = b.x + b.width;
  lastProgrammaticMove = Date.now();
  companionWindow.setBounds({ x: right - width, y: b.y, width, height: b.height });
  // Wayland ignores the x above; re-anchor to the home display's corner.
  placeCompanion();
});

let watchingHyprland = false;

/** Pin the companion to its home display (Hyprland only; resolves false elsewhere). */
function placeCompanion(previousFocus = null) {
  if (!companionWindow || companionWindow.isDestroyed() || !companionWindow.isVisible()) return Promise.resolve(false);
  const win = companionWindow;
  return hyprland
    .pinToMonitor({
      pid: process.pid,
      title: 'LESLIE',
      monitor: config.homeMonitor,
      size: () => (win.isDestroyed() ? { width: 0, height: 0 } : win.getBounds()),
      previousFocus
    })
    .catch((err) => {
      console.warn('[hyprland] placement failed:', err.message);
      return false;
    });
}

function toggleCompanion() {
  if (!companionWindow || companionWindow.isDestroyed()) return;
  if (companionWindow.isVisible()) companionWindow.hide();
  else showCompanion();
}

/** Show the companion on its home display; `silent` leaves keyboard focus where it was. */
async function showCompanion({ silent = false } = {}) {
  if (!companionWindow || companionWindow.isDestroyed()) return;
  const previousFocus = silent ? await hyprland.focusedWindow() : null;
  if (!companionWindow.isVisible()) {
    if (silent) companionWindow.showInactive();
    else companionWindow.show();
  }
  await placeCompanion(previousFocus);
}

function redock() {
  if (!companionWindow || companionWindow.isDestroyed()) return;
  if (hyprland.available() && config.homeMonitor) {
    placeCompanion();
    return;
  }
  const b = companionWindow.getBounds();
  const { workArea } = screen.getDisplayMatching(b);
  const onScreen =
    b.x >= workArea.x && b.y >= workArea.y &&
    b.x + b.width <= workArea.x + workArea.width &&
    b.y + b.height <= workArea.y + workArea.height;
  if (onScreen) return;
  const x = workArea.x + workArea.width - b.width - PANEL_MARGIN;
  const y = workArea.y + workArea.height - PANEL_HEIGHT - PANEL_MARGIN;
  lastProgrammaticMove = Date.now();
  companionWindow.setBounds({ x, y, width: b.width, height: PANEL_HEIGHT });
}

ipcMain.on('window:hide', () => {
  if (companionWindow) companionWindow.hide();
});

ipcMain.on('app:quit', () => app.quit());

ipcMain.on('voice:wake', (_event, payload) => {
  showCompanion({ silent: true });
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

// Autostart plus the app launcher would otherwise give two mascots; a second
// launch just brings the running one forward, or toggles it with `leslie --toggle`
// (handy for a Hyprland keybind).
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', (_event, argv) => (argv.includes('--toggle') ? toggleCompanion() : showCompanion()));
}

app.whenReady().then(() => {
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
  config.taskMode = settings.get('taskMode', config.taskMode);
  config.learningMode = settings.get('learningMode', config.learningMode);
  if (config.planMode) config.agentMode = false;
  if (config.planMode || !config.agentMode) config.taskMode = false;

  configStore.applyPersisted();
  contextWindow.refresh();
  onEngineChanged();
  modelServer.startup();

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
  agent.shutdown();
  screenRecord.stop().catch(() => {});
});

app.on('window-all-closed', () => {
});

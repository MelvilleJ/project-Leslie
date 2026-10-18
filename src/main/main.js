'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, session, shell, protocol, net, dialog, Notification } = require('electron');
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
const setup = require('./setup');
const sysmon = require('./sysmon');
const helpers = require('./helpers');
const animations = require('./animations');
const aseprite = require('./aseprite');
const wardrobe = require('./wardrobe');
const tts = require('./tts');
const shortcuts = require('./shortcuts');
const policy = require('./pi/policy');
const permissions = require('./permissions');
const idleReset = require('./idleReset');
const greeting = require('./greeting');
const watch = require('./watch');
const { digest } = require('./watch/summarize');
const presence = require('./presence');
const docs = require('./docs');
const { parseSpriteCss } = require('./spriteGrid');
const fsSuggest = require('./fsSuggest');
const listDirectory = require('./tools/listDirectory');
const mediaControl = require('./tools/mediaControl');
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
// Each helper Leslie widens the window by one column (see #helpers in styles.css).
const HELPER_WIDTH = 84;
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
  for (const w of [companionWindow, detailWindow, settingsWindow, permissions.window()]) {
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

const STATE_LABELS = {
  idle: 'Idle', thinking: 'Thinking', longThink: 'Long think', toolCall: 'Tool call',
  talking: 'Talking', listening: 'Listening', moving: 'Moving'
};
const ASEPRITE_FILTER = { name: 'Aseprite', extensions: aseprite.EXTENSIONS.map((e) => e.slice(1)) };

/** Tray: pick an .aseprite file, add it to the library and optionally bind it to a state. */
async function importAsepriteFromMenu() {
  const pick = await dialog.showOpenDialog({
    title: 'Choose an Aseprite animation',
    filters: [ASEPRITE_FILTER],
    properties: ['openFile']
  });
  if (pick.canceled || !pick.filePaths[0]) return;
  const file = pick.filePaths[0];
  try {
    const clip = animations.importClip({ name: path.basename(file).replace(/\.(aseprite|ase)$/i, ''), pngPath: file });
    const states = animations.STATES;
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: 'Play animation',
      message: `Imported "${clip.name}" (${clip.frames} frames).`,
      detail: 'Play it for which state? It replaces that state\'s current animation.',
      buttons: [...states.map((s) => STATE_LABELS[s] || s), 'Just add to library'],
      cancelId: states.length
    });
    if (response < states.length) animations.setBinding(states[response], [clip.id]);
    broadcastAnimations();
  } catch (err) {
    dialog.showErrorBox('Aseprite import failed', err && err.message ? err.message : String(err));
  }
}

/** Tray: convert .aseprite files to spritesheet PNG + CSS beside the originals. */
async function convertAsepriteFromMenu() {
  const pick = await dialog.showOpenDialog({
    title: 'Convert Aseprite files to spritesheets',
    filters: [ASEPRITE_FILTER],
    properties: ['openFile', 'multiSelections']
  });
  if (pick.canceled || !pick.filePaths.length) return;
  const failed = [];
  let last = null;
  for (const file of pick.filePaths) {
    try {
      last = aseprite.exportSheet(file);
    } catch (err) {
      failed.push(`${path.basename(file)}: ${err && err.message ? err.message : err}`);
    }
  }
  if (failed.length) dialog.showErrorBox('Some files could not be converted', failed.join('\n'));
  if (last) shell.showItemInFolder(last);
}

let trayProfile = null;
let trayPowerOn = true;

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
        idleReset.cleared();
        toSettings('settings:conversations-changed');
      }
    },
    {
      label: 'Model',
      submenu: [
        { label: 'Everyday', type: 'radio', checked: trayProfile === 'everyday', click: () => switchProfileFromTray('everyday') },
        ...(trayPowerOn ? [{ label: 'Power', type: 'radio', checked: trayProfile === 'power', click: () => switchProfileFromTray('power') }] : []),
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
    {
      label: 'Animations',
      submenu: [
        { label: 'Import Aseprite file…', click: () => importAsepriteFromMenu() },
        { label: 'Convert Aseprite to spritesheet…', click: () => convertAsepriteFromMenu() },
        { type: 'separator' },
        { label: 'Animation settings…', click: () => showSettingsWindow('animations') }
      ]
    },
    { type: 'separator' },
    {
      label: 'Speak replies',
      type: 'checkbox',
      checked: config.ttsEnabled,
      click: (item) => tts.setEnabled(item.checked)
    },
    {
      label: 'Camera presence',
      type: 'checkbox',
      checked: config.cameraEnabled,
      click: (item) => setCameraEnabled(item.checked)
    },
    {
      label: 'Auto mode (skip prompts for safe commands)',
      type: 'checkbox',
      checked: config.autoApprove,
      click: (item) => setAutoApprove(item.checked)
    },
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

function setAutoApprove(on) {
  const { value } = configStore.set('autoApprove', on);
  autoApproveChanged(value);
  return value;
}

function autoApproveChanged(value) {
  if (tray) tray.setContextMenu(buildTrayMenu());
  toCompanion('permissions:auto', value);
  toSettings('settings:config-changed', { key: 'autoApprove', value });
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
    watchMedia();
  });

  voiceWindow.on('closed', () => {
    voiceWindow = null;
    clearTimeout(mediaTimer);
  });
}

function controlVoice(action, value) {
  if (voiceWindow && !voiceWindow.isDestroyed()) {
    voiceWindow.webContents.send('voice:control', { action, value });
  }
}

// A playing video talks through the same speakers, so while one plays she
// needs her name before treating speech as meant for her.
async function mediaPlaying() {
  const list = await mediaControl.players().catch(() => []);
  return list.some((p) => p.status === 'Playing');
}

const MEDIA_POLL_MS = 2000;
let mediaTimer = null;

function watchMedia() {
  clearTimeout(mediaTimer);
  let last = null;
  const check = async () => {
    const playing = await mediaPlaying();
    if (playing !== last) controlVoice('media', (last = playing));
    if (voiceWindow) mediaTimer = setTimeout(check, MEDIA_POLL_MS);
  };
  check();
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

helpers.onUpdate((list) => toCompanion('helpers:update', list));

function forwardPiEvents() {
  const pi = agent.pi();
  pi.onUiEvent((ev) => {
    if (ev.type === 'ui') return askPiDialog(pi, ev.request);
    toCompanion('pi:event', ev);
    toSettings('pi:event', ev);
  });
}

function askPiDialog(pi, req) {
  const prompt = {
    id: req.id,
    source: 'pi',
    method: req.method,
    title: req.title,
    message: req.message,
    options: req.options,
    placeholder: req.placeholder,
    prefill: req.prefill
  };
  // pi answers for itself when a dialog times out; just retire the prompt.
  permissions.request(prompt, (payload) => pi.respondUi(req.id, payload), req.timeout);
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

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGES = 8;

function cleanImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter((img) => img && typeof img.data === 'string' && img.data && IMAGE_TYPES.includes(img.mimeType))
    .slice(0, MAX_IMAGES)
    .map(({ data, mimeType }) => ({ type: 'image', data, mimeType }));
}

ipcMain.handle('agent:message', async (event, payload) => {
  const sender = event.sender;
  // Back-compat: payload may be a bare string or { text, mentions }.
  const text = typeof payload === 'string' ? payload : (payload && payload.text) || '';
  const mentions = (payload && payload.mentions) || [];
  const images = cleanImages(payload && payload.images);
  idleReset.userInput();

  const shortcut = images.length ? null : shortcuts.match(text);
  if (shortcut) return runShortcut(shortcut);

  const profile = profileCommand(text);
  if (profile) return switchProfileCommand(profile);

  modelServer.turnStarted();
  idleReset.turnStarted();
  const confirmIds = [];
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
          confirmIds.push(ev.id);
          permissions.request(
            { id: ev.id, source: 'leslie', method: 'approve', message: ev.message },
            ({ approved }) => agent.resolveConfirm(ev.id, approved)
          );
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
    idleReset.turnEnded();
    confirmIds.forEach(permissions.decline);
  }
});

async function runShortcut(shortcut) {
  const ctx = { setMode: applyMode, openUrl: (url) => shell.openExternal(url) };
  try {
    const tool = policy.bridgedTool(shortcut.tool);
    if (!tool) return { error: `"${shortcut.phrases[0]}" failed: ${shortcut.tool} isn't available in this mode` };
    const result = await tool.run(shortcut.args || {}, ctx);
    return { reply: shortcut.reply || shortcuts.describe(result) };
  } catch (err) {
    return { error: `"${shortcut.phrases[0]}" failed: ${err.message}` };
  }
}

// "power mode" / "everyday mode" — handled without the model so it is instant
// and can't be misread; progress then shows as the model loads.
async function switchProfileCommand(profile) {
  const label = profile === 'power' ? 'Power' : 'Everyday';
  try {
    const st = await modelServer.status();
    if (st.profiles.some((p) => p.name === profile && p.state === 'off')) {
      return { reply: `${label} mode isn't set up on this computer; turn it on in Settings → Models & GPUs.` };
    }
    if (st.activeProfile === profile) return { reply: `${label} mode is already on.` };
    modelServer.requestSwitch(profile);
    return { reply: `Switching to ${label} mode — ${profile === 'power' ? 'about 20' : 'about 10'} seconds.` };
  } catch (err) {
    return { error: `Couldn't switch to ${label} mode: ${err.message}` };
  }
}

ipcMain.on('agent:cancel', () => {
  permissions.declineAll('leslie');
  agent.cancel();
});

ipcMain.handle('agent:reset', () => {
  agent.reset();
  idleReset.cleared();
  return { ok: true };
});

idleReset.init(async () => {
  await agent.reset();
  toSettings('settings:conversations-changed');
  toCompanion('agent:idle-reset', config.idleResetMinutes);
});

ipcMain.handle('agent:get-mode', () => currentMode());
ipcMain.handle('permissions:get-auto', () => config.autoApprove);
ipcMain.handle('permissions:set-auto', (_event, on) => setAutoApprove(on));

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
    const powerOn = ev.status.profiles.some((p) => p.name === 'power' && p.state !== 'off');
    if ((active !== trayProfile || powerOn !== trayPowerOn) && tray) {
      trayProfile = active;
      trayPowerOn = powerOn;
      tray.setContextMenu(buildTrayMenu());
    }
  }
  toCompanion('server:event', ev);
  toSettings('server:event', ev);
});

ipcMain.handle('pi:command', async (_event, { name, args } = {}) => {
  try {
    return { ok: true, data: await agent.pi().command(name, args) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('pi:bash', async (event, { command, excludeFromContext } = {}) => {
  if (presence.snapshot().restricted) return { ok: false, error: 'Commands are disabled until the owner is back at the desk.' };
  const sender = event.sender;
  idleReset.userInput();
  idleReset.turnStarted();
  try {
    const data = await agent.pi().runBash(String(command || ''), excludeFromContext, (delta) => {
      if (!sender.isDestroyed()) sender.send('pi:bash-chunk', delta);
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    idleReset.turnEnded();
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
    if (configStore.VOICE_KEYS.includes(key)) reinitVoice();
    if (key === 'learningMode' && tray) tray.setContextMenu(buildTrayMenu());
    if (key === 'autoApprove') autoApproveChanged(res.value);
    if (key === 'ttsEnabled') tts.setEnabled(res.value);
    if (key === 'idleResetMinutes') idleReset.settingChanged();
    if (configStore.CAMERA_KEYS.includes(key)) {
      presence.settingsChanged();
      if (key === 'cameraEnabled' && tray) tray.setContextMenu(buildTrayMenu());
    }
  }
  return res;
});

ipcMain.handle('camera:devices', () => presence.devices().catch(() => []));
ipcMain.handle('camera:preview', () => presence.preview().catch(() => null));
ipcMain.handle('people:list', () => presence.people());
ipcMain.handle('people:enroll', (_event, { name, role } = {}) => presence.enroll({ name, role }));
ipcMain.handle('people:update', (_event, { id, patch } = {}) => presence.updatePerson(id, patch || {}));
ipcMain.handle('people:remove', (_event, id) => presence.removePerson(id));
ipcMain.handle('presence:get', () => presence.snapshot());

// Spoken replies: the companion asks per sentence and plays the audio itself.
ipcMain.handle('tts:speak', (_event, text) => tts.speak(text));
ipcMain.handle('tts:preview', (_event, voice) =>
  tts.speak("Hi, I'm Leslie. This is how I'll sound when I read my replies to you.", { force: true, voice }));
ipcMain.handle('tts:enabled', () => tts.isEnabled());
ipcMain.on('tts:cancel', () => tts.cancel());
// Her own voice would otherwise be transcribed (and could say her wake word).
ipcMain.on('tts:playing', (_event, playing) => controlVoice('speaking', Boolean(playing)));
ipcMain.on('tts:said', (_event, text) => controlVoice('said', String(text || '')));

ipcMain.handle('shortcuts:get', () => ({ shortcuts: shortcuts.list(), tools: policy.bridgedSpecs() }));
ipcMain.handle('shortcuts:save', (_event, list) => {
  try {
    return { ok: true, shortcuts: shortcuts.save(list) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
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

// The conversation list is pi's own session store, shared with the pi terminal UI.
ipcMain.handle('conv:list', () => agent.pi().listSessions());
ipcMain.handle('conv:get', (_event, id) => agent.pi().getSession(id));
ipcMain.handle('conv:resume', (_event, id) => {
  const ok = agent.resume(id);
  if (ok) idleReset.userInput();
  return { ok };
});
ipcMain.handle('conv:delete', async (_event, id) => {
  const file = await agent.pi().sessionFileFor(id);
  if (!file) return { ok: false, error: 'Only saved, inactive sessions can be deleted.' };
  await shell.trashItem(file);
  return { ok: true };
});
ipcMain.handle('conv:new', () => {
  agent.reset();
  idleReset.cleared();
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
    title: 'Choose a spritesheet PNG or Aseprite file',
    filters: [
      { name: 'Spritesheet', extensions: ['png', ...aseprite.EXTENSIONS.map((e) => e.slice(1))] }
    ],
    properties: ['openFile']
  });
  if (png.canceled || !png.filePaths[0]) return { cancelled: true };
  const pngPath = png.filePaths[0];
  const isAse = aseprite.isAsepritePath(pngPath);

  const cssPick = isAse ? { canceled: true } : await dialog.showOpenDialog(parent, {
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
    const name = path.basename(pngPath).replace(/\.(png|aseprite|ase)$/i, '');
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

ipcMain.handle('wardrobe:get', () => wardrobe.getState());

ipcMain.handle('wardrobe:set', (_event, patch) => {
  const state = wardrobe.update(patch || {});
  broadcastAnimations();
  return state;
});

ipcMain.on('settings:open', (_event, panel) => showSettingsWindow(panel));

let companionExpanded = false;
let helperCount = 0;

ipcMain.on('window:set-expanded', (_event, expanded) => {
  companionExpanded = Boolean(expanded);
  resizeCompanion();
});

ipcMain.on('window:set-helpers', (_event, count) => {
  helperCount = Math.max(0, Math.min(helpers.MAX_HELPERS, Number(count) || 0));
  resizeCompanion();
});

ipcMain.on('helpers:open', (_event, id) => {
  const h = helpers.output(id);
  if (!h) return;
  const body = h.report ? helperReportMarkdown(h.report) : h.output || (h.error ? `_${h.error}_` : '_Nothing yet._');
  const win = showDetailWindow();
  win.webContents.send('detail:begin', { question: `Helper: ${h.label}` });
  win.webContents.send('detail:chunk', `# ${h.label}\n\n**Task:** ${h.task}\n\n${body}`);
  win.webContents.send('detail:end');
});

function helperReportMarkdown(r) {
  const evidence = r.evidence.map((e) => `- ${e.found_in_sources ? '✓' : '✗ not in what it read:'} "${e.quote}" (${e.url})`).join('\n');
  const unknowns = r.unknowns ? `\n\n**Unsure about:** ${r.unknowns}` : '';
  return `**Answer:** ${r.answer}\n\n**Check:** ${r.verification} · confidence ${r.confidence || '?'}\n\n${evidence}${unknowns}`;
}

function resizeCompanion() {
  if (!companionWindow || companionWindow.isDestroyed()) return;
  const b = companionWindow.getBounds();
  const width = (companionExpanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH) + helperCount * HELPER_WIDTH;
  if (b.width === width) return;
  const right = b.x + b.width;
  lastProgrammaticMove = Date.now();
  companionWindow.setBounds({ x: right - width, y: b.y, width, height: b.height });
  // Wayland ignores the x above; re-anchor to the home display's corner.
  placeCompanion();
}

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
  if (payload && payload.state === 'error') console.warn('[voice]', payload.message || 'error');
  toCompanion('leslie:voice-status', payload || {});
});

ipcMain.on('voice:set-active', (_event, value) => controlVoice('set-active', !!value));
ipcMain.on('voice:listen-once', () => controlVoice('listen-once'));
ipcMain.on('voice:conversation', (_event, on) => controlVoice('conversation', !!on));
ipcMain.on('voice:conversation-ended', () => toCompanion('leslie:conversation-ended'));
ipcMain.handle('voice:follow-up', async () => {
  if (await mediaPlaying()) return false;
  controlVoice('listen-once');
  return true;
});

async function sayHello() {
  const name = presence.addressName();
  const text = (await modelServer.whenModelLoaded()) ? await greeting.generate({ name }) : greeting.fallback(name);
  console.log(`\x1b[33m${text}\x1b[0m`);
  const contents = companionWindow && !companionWindow.isDestroyed() && companionWindow.webContents;
  if (!contents) return;
  if (contents.isLoading()) contents.once('did-finish-load', () => toCompanion('agent:say', text));
  else toCompanion('agent:say', text);
}

function brief(text, spoken = text) {
  new Notification({ title: 'LESLIE', body: text, icon: APP_ICON }).show();
  toCompanion('agent:say', spoken);
}

// What the camera turned off when the desk emptied, so only that is turned back on.
const awayState = { mutedVoice: false, pausedMedia: false };

async function welcome({ person, awayMs, held }) {
  const awayMinutes = awayMs / 60000;
  const greet = person.role !== 'unknown' && awayMinutes >= config.cameraGreetAfterMin;
  if (!greet && !held.length) return;
  showCompanion({ silent: true });
  const loaded = await modelServer.whenModelLoaded();
  const guest = person.role === 'guest' ? person.name.split(/\s+/)[0] : '';
  const name = person.role === 'owner' ? person.name.split(/\s+/)[0] : '';
  const [hello, catchUp] = await Promise.all([
    greet ? (loaded ? greeting.generate({ name, awayMinutes, guest }) : guest ? `Hi, ${guest}.` : greeting.fallback(name)) : '',
    held.length ? digest(held) : ''
  ]);
  if (catchUp) brief(catchUp, [hello, catchUp].filter(Boolean).join(' '));
  else toCompanion('agent:say', hello);
}

// "Ask Leslie" on a doc comment runs as a chat turn in the companion, so the
// work shows there; her reply is posted back into the thread.
const docAsks = new Map();
let docAskSeq = 0;

function docCommentPrompt(name, thread) {
  const said = thread.messages.map((m) => `${m.author === 'leslie' ? 'Leslie' : 'User'}: ${m.text}`).join('\n');
  return [
    `A comment on the live doc "${name}" was sent to you.`,
    `It is on block [${thread.blockId}]${thread.quote ? `, about the words "${thread.quote}"` : ''}. The thread:`,
    said,
    '',
    'Do what the latest comment asks. To change the doc, doc_read it, then doc_edit only what was asked. ' +
      'If it is a question, answer it from the doc. Your reply is posted in the comment thread, so keep it to one or ' +
      'two short sentences: what you changed, or the answer.'
  ].join('\n');
}

function askLeslieAboutComment(name, thread) {
  const answer = (text) => {
    try {
      docs.store().reply(name, thread.id, { text, author: 'leslie' });
    } catch (err) {
      console.warn('[docs] could not post a reply:', err.message);
    }
  };
  if (!companionWindow || companionWindow.isDestroyed()) return answer("I can't pick this up right now: my window is closed.");
  const id = `doc-${++docAskSeq}`;
  docAsks.set(id, answer);
  showCompanion({ silent: true });
  const latest = thread.messages[thread.messages.length - 1].text;
  toCompanion('docs:ask', { id, prompt: docCommentPrompt(name, thread), label: `💬 On "${name}": ${latest}` });
}

function approvedPlanPrompt(name) {
  return [
    `The user approved your plan in the live doc "${name}", and you are now in agent mode. Carry it out now, step by step.`,
    'The user may have edited the plan after you wrote it: the doc below is what they approved, so follow it over ' +
      'anything said earlier. Do only what it says. If a step turns out to be wrong or unsafe, stop and say why instead of improvising.',
    '',
    '--- approved plan ---',
    docs.store().markdown(name).trim(),
    '--- end of plan ---',
    '',
    'When you are finished, reply with a short summary of what you did.'
  ].join('\n');
}

// Approving a plan doc switches to agent mode and runs the doc as a chat turn;
// how it went is shown on the doc's plan bar.
function carryOutPlan(name) {
  const settle = (status, note) => {
    try {
      docs.store().setPlan(name, status, note);
    } catch (err) {
      console.warn('[docs] could not update the plan:', err.message);
    }
  };
  if (!companionWindow || companionWindow.isDestroyed()) return settle('failed', "My window is closed, so I couldn't start.");
  applyMode('agent');
  const id = `doc-${++docAskSeq}`;
  docAsks.set(id, (text, failed) => settle(failed ? 'failed' : 'done', text));
  showCompanion({ silent: true });
  toCompanion('docs:ask', { id, prompt: approvedPlanPrompt(name), label: `✅ Approved plan: "${name}"` });
}

ipcMain.on('docs:answer', (_event, { id, reply, error } = {}) => {
  const answer = docAsks.get(id);
  if (!answer) return;
  docAsks.delete(id);
  answer(error ? `I couldn't do that: ${error}` : String(reply || '').trim() || 'Done.', Boolean(error));
});

function startPresence() {
  presence.start({
    arrived: (event) => welcome(event).catch((err) => console.warn('[presence] welcome failed:', err.message)),
    activity: () => idleReset.userInput(),
    changed: (snap) => toCompanion('leslie:presence', snap),
    announce: (text) => brief(text),
    gesture: (name) => {
      if (name === 'palm') {
        showCompanion({ silent: true });
        controlVoice('listen-once');
        toCompanion('leslie:voice-wake', { gesture: true });
      } else if (name === 'shush') {
        toCompanion('leslie:hush');
      }
    },
    empty: async () => {
      if (config.cameraAwayMuteVoice) {
        controlVoice('set-active', false);
        awayState.mutedVoice = true;
      }
      if (config.cameraAwayPauseMedia && (await mediaPlaying())) {
        await mediaControl.run({ action: 'pause' }).catch(() => {});
        awayState.pausedMedia = true;
      }
    },
    occupied: async () => {
      if (awayState.mutedVoice) controlVoice('set-active', true);
      if (awayState.pausedMedia) await mediaControl.run({ action: 'play' }).catch(() => {});
      awayState.mutedVoice = false;
      awayState.pausedMedia = false;
    }
  });
}

function setCameraEnabled(on) {
  configStore.set('cameraEnabled', on);
  presence.settingsChanged();
  if (tray) tray.setContextMenu(buildTrayMenu());
  toSettings('settings:config-changed', { key: 'cameraEnabled', value: config.cameraEnabled });
}

// Autostart plus the app launcher would otherwise give two mascots; a second
// launch just brings the running one forward, or toggles it with `leslie --toggle`
// (handy for a Hyprland keybind).
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', (_event, argv) => (argv.includes('--toggle') ? toggleCompanion() : showCompanion()));
}

app.whenReady().then(() => {
  // leslie-sprite://clips/<file> serves imported clips; leslie-sprite://builtin/<path> serves bundled ones.
  // .aseprite files are flattened into a spritesheet PNG on the fly.
  protocol.handle('leslie-sprite', (request) => {
    try {
      const url = new URL(request.url);
      const file = url.hostname === 'builtin'
        ? animations.builtinPath(decodeURIComponent(url.pathname).replace(/^\/+/, ''))
        : path.join(animations.clipsDir(), path.basename(url.pathname));
      if (aseprite.isAsepritePath(file)) {
        const sheet = aseprite.loadSheet(file, wardrobe.fromQuery(url.searchParams));
        return new Response(sheet.png, { headers: { 'Content-Type': 'image/png' } });
      }
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
  // First launch (or a setup left part-way): only the setup window, which
  // restarts LESLIE once everything is in place.
  if (setup.shouldRun()) {
    setup.open();
    return;
  }
  setup.registerMaintenance((ev) => toSettings('maintain:event', ev));
  contextWindow.refresh();
  permissions.init({ icon: APP_ICON });
  forwardPiEvents();
  startPresence();
  docs.start().then(() => {
    docs.onAsk(askLeslieAboutComment);
    docs.onApprove(carryOutPlan);
  });
  modelServer.startup().catch(() => {}).then(sayHello).then(() => watch.start(presence.holdOrAnnounce));

  createWindow();
  createDetailWindow();
  wardrobe.watchSchedule(broadcastAnimations);
  if (config.voiceEnabled) createVoiceWindow();
  createTray();
  const settingsArg = process.argv.find((a) => a.startsWith('--show-settings='));
  if (settingsArg) showSettingsWindow(settingsArg.slice('--show-settings='.length));
  tts.onEnabled((on) => {
    toCompanion('tts:enabled', on);
    toSettings('settings:config-changed', { key: 'ttsEnabled', value: on });
    if (tray) tray.setContextMenu(buildTrayMenu());
  });
  tts.warm();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  agent.shutdown();
  watch.stop();
  presence.stop();
  docs.stop();
  screenRecord.stop().catch(() => {});
  tts.shutdown();
});

app.on('window-all-closed', () => {
});

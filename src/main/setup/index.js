'use strict';

// The setup window's main-process side: it gathers what the screens need,
// starts the slow downloads as soon as their choice is made, then runs the
// rest and restarts LESLIE into the finished setup.

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const paths = require('./paths');
const hardware = require('./hardware');
const catalog = require('./catalog');
const engines = require('./engines');
const probe = require('./probe');
const packages = require('./packages');
const persona = require('./persona');
const state = require('./state');
const desktop = require('./desktop');
const { defaultChoices, downloadBytes } = require('./recommend');
const { buildTasks, Runner } = require('./tasks');
const { run } = require('./exec');
const maintain = require('./maintain');

const ROOT = path.join(__dirname, '..', '..', '..');

let win = null;
let gpus = null;
let abort = null;
let finishing = false;
const inflight = new Map();

/** First launch, or a setup left part-way. A hand-built install with no setup state is left alone. */
function shouldRun(argv = process.argv) {
  if (argv.includes('--setup')) return true;
  const saved = state.load();
  return saved ? !saved.finished : !probe.existingInstall().any;
}

// The command that starts this copy of LESLIE, for the launcher and the login
// service; a source checkout has none.
function appExec() {
  if (!app.isPackaged) return '';
  return process.env.APPIMAGE || process.execPath;
}

async function detect() {
  if (!gpus) gpus = await hardware.detectGpus();
  return gpus;
}

function send(ev) {
  if (win && !win.isDestroyed()) win.webContents.send('setup:event', ev);
}

/** Two runners asking for the same work (a prefetch, then the full run) share one attempt. */
function shared(tasks) {
  return tasks.map((t) => {
    const key = `${t.id}|${JSON.stringify(t.key)}`;
    return {
      ...t,
      run: (progress) => {
        if (!inflight.has(key)) inflight.set(key, Promise.resolve().then(() => t.run(progress)).finally(() => inflight.delete(key)));
        return inflight.get(key);
      }
    };
  });
}

function tasksFor(choices) {
  const configStore = require('../configStore');
  if (!abort || abort.signal.aborted) abort = new AbortController();
  return shared(buildTasks(choices, {
    appExec: appExec(),
    signal: abort.signal,
    setSettings: (values) => {
      for (const [key, value] of Object.entries(values)) configStore.set(key, value);
    }
  }));
}

function runnerFor(choices, opts) {
  const runner = new Runner(tasksFor(choices), opts);
  runner.on('event', send);
  return runner;
}

async function info() {
  const found = await detect();
  const defaults = defaultChoices(found);
  return {
    gpus: found,
    ramMiB: hardware.ramMiB(),
    defaults,
    builds: engines.builds(),
    models: Object.fromEntries(catalog.TIERS.map((t) => [t, catalog.forTier(t)])),
    existing: probe.existingInstall(),
    presets: persona.presets(),
    voices: require('../tts/voices').VOICES,
    distro: packages.distro(),
    hyprland: Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE),
    canInstallApp: Boolean(appExec()),
    systemLauncher: desktop.hasSystemLauncher(),
    resumed: state.load()
  };
}

async function monitors() {
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return [];
  const res = await run('hyprctl', ['-j', 'monitors']);
  try {
    return JSON.parse(res.stdout).map((m) => ({ name: m.name, label: `${m.name}: ${m.description || m.model || ''} (${m.width}×${m.height})`, focused: m.focused }));
  } catch {
    return [];
  }
}

function cameras() {
  const dir = '/dev/v4l/by-id';
  try {
    return fs.readdirSync(dir)
      .filter((d) => d.endsWith('index0'))
      .map((d) => ({ path: path.join(dir, d), label: d.replace(/^usb-/, '').replace(/-video-index0$/, '').replace(/_/g, ' ') }));
  } catch {
    return [];
  }
}

/** Is there a SearXNG with JSON output, or an OpenAI-style server, at url? */
async function testUrl({ kind, url }) {
  const base = String(url || '').replace(/\/+$/, '');
  try {
    if (kind === 'searxng') {
      const res = await fetch(`${base}/search?q=leslie&format=json`, { signal: AbortSignal.timeout(8000) });
      if (res.status === 403) return { ok: false, error: 'SearXNG answered, but JSON output is off (add json to search.formats).' };
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      await res.json();
      return { ok: true };
    }
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, models: (data.data || []).map((m) => m.id) };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'No answer within 8 seconds.' : err.message };
  }
}

/** The choices as setup-state.json may hold them: never with an API key. */
function storable(choices) {
  if (!choices || !choices.engine || !choices.engine.apiKey) return choices;
  const { apiKey, ...engine } = choices.engine;
  return { ...choices, engine };
}

function settle(promise) {
  return Promise.resolve(promise).then((data) => ({ ok: true, data }), (err) => ({ ok: false, error: err.message }));
}

let registered = false;
function register() {
  if (registered) return;
  registered = true;
  ipcMain.handle('setup:info', () => settle(info()));
  ipcMain.handle('setup:checks', async (_e, choices) =>
    settle(detect().then((g) => probe.systemChecks({ gpus: g, neededBytes: choices ? downloadBytes(choices) : 0 }))));
  ipcMain.handle('setup:download-bytes', (_e, choices) => settle(Promise.resolve(downloadBytes(choices))));
  ipcMain.handle('setup:install-packages', (_e, pkgs) => settle(packages.install(pkgs || [])));
  ipcMain.handle('setup:monitors', () => settle(monitors()));
  ipcMain.handle('setup:cameras', () => settle(Promise.resolve(cameras())));
  ipcMain.handle('setup:test-url', (_e, args) => testUrl(args || {}));
  ipcMain.handle('setup:save', (_e, choices) => settle(Promise.resolve(state.update({ choices: storable(choices) }))));
  ipcMain.handle('setup:cloud-providers', () => ({ ok: true, data: require('../pi/cloud').PROVIDERS }));
  ipcMain.handle('setup:cloud-models', (_e, { provider, apiKey } = {}) => settle(require('../pi/cloud').listModels(provider, apiKey)));
  // Start the big downloads while the remaining questions are answered.
  ipcMain.handle('setup:prefetch', (_e, choices) => {
    const ids = buildTasks(choices, {}).map((t) => t.id).filter((id) => id === 'engine' || id.startsWith('model:'));
    runnerFor(choices).runAll(ids).catch(() => {});
    return { ok: true, data: ids };
  });
  ipcMain.handle('setup:run', (_e, { choices, force } = {}) => {
    state.update({ choices: storable(choices), finished: false });
    const runner = runnerFor(choices, { force: force || [] });
    send({ type: 'plan', tasks: runner.plan() });
    return settle(runner.runAll().then((result) => {
      if (result.ok) state.update({ finished: true });
      return result;
    }));
  });
  ipcMain.handle('setup:cancel', () => {
    if (abort) abort.abort();
    return { ok: true };
  });
  ipcMain.handle('setup:adopt', () => settle(Promise.resolve(state.update({ finished: true, adopted: true }))));
  ipcMain.handle('setup:finish', (_e, { panel } = {}) => {
    finishing = true;
    const args = process.argv.slice(1).filter((a) => a !== '--setup' && !a.startsWith('--show-settings='));
    if (panel) args.push(`--show-settings=${panel}`);
    app.relaunch({ args });
    app.exit(0);
  });
}

let maintaining = null;

/** Settings → About: setup status, repair, engine update, uninstall. Events go to `notify`. */
function registerMaintenance(notify) {
  const configStore = () => require('../configStore');
  const ctx = () => ({
    appExec: appExec(),
    setSettings: (values) => {
      for (const [key, value] of Object.entries(values)) configStore().set(key, value);
    }
  });
  const exclusive = (label, fn) => {
    if (maintaining) return Promise.resolve({ ok: false, error: `${maintaining} is still running.` });
    maintaining = label;
    return settle(Promise.resolve().then(fn)).finally(() => { maintaining = null; });
  };
  ipcMain.handle('maintain:status', () => settle(Promise.resolve().then(() => ({ ...maintain.status(), ...maintain.uninstallPlan(), busy: maintaining }))));
  ipcMain.handle('maintain:rerun', () => {
    app.relaunch({ args: [...process.argv.slice(1).filter((a) => a !== '--setup'), '--setup'] });
    app.exit(0);
  });
  ipcMain.handle('maintain:repair', (_e, section) => exclusive(`Repairing ${section}`, async () => {
    const { runner } = maintain.repair(section, ctx());
    runner.on('event', notify);
    return runner.runAll();
  }));
  ipcMain.handle('maintain:update-engine', () => exclusive('The engine update', () =>
    maintain.updateEngine((p) => notify({ type: 'progress', id: 'engine', ...p, fraction: p.total ? p.done / p.total : undefined }))));
  ipcMain.handle('maintain:uninstall', (_e, opts) => exclusive('Uninstalling', async () => {
    await maintain.uninstall(opts || {});
    setTimeout(() => app.exit(0), 1500);
  }));
}

function open() {
  register();
  win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    title: 'Set up LESLIE',
    icon: path.join(ROOT, 'assets', 'icons', 'leslie-256.png'),
    backgroundColor: '#161619',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'setupPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'setup.html'));
  win.on('closed', () => {
    win = null;
    if (abort) abort.abort();
    // The app quits before aborted tasks report back, so record them here.
    const saved = state.load();
    if (saved) {
      for (const task of Object.values(saved.tasks)) if (task.status === 'running') Object.assign(task, { status: 'stopped', error: 'Setup was closed' });
      state.save(saved);
    }
    if (!finishing) app.quit();
  });
  return win;
}

module.exports = { shouldRun, open, registerMaintenance, paths };

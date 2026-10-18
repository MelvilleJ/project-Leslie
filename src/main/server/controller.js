'use strict';

// Electron-side glue for the model server: keeps LESLIE's connection and pi's
// model pointed at whatever profile is loaded, and reports status/progress.

const config = require('../config');
const contextWindow = require('../contextWindow');
const agent = require('../agent');
const server = require('./llamaServer');

let broadcast = () => {};
let switching = null;

function onEvent(fn) {
  broadcast = fn;
}

async function useModel(model) {
  config.baseURL = `${server.baseUrl()}/v1`;
  if (model) {
    config.model = model;
    config.serverModel = model;
  }
  await contextWindow.refresh({ force: true });
  if (!model || config.piModel === 'leslie') return;
  await agent.pi().command('useModel', { provider: 'llama.cpp', id: model });
}

async function status() {
  const st = await server.status();
  st.switching = Boolean(switching);
  require('../helpers').noteServerStatus(switching ? null : st);
  return st;
}

async function publish() {
  try {
    broadcast({ type: 'status', status: await status() });
  } catch {
  }
}

async function switchTo(profile) {
  if (switching) throw new Error('A model is already loading.');
  // The helpers' model is unloaded by the switch; stop them first.
  require('../helpers').stopAll();
  const progress = (text) => broadcast({ type: 'progress', text });
  switching = (async () => {
    const st = await server.status();
    if (!st.reachable) {
      progress('Starting the model server…');
      await server.service('start');
      await waitReachable();
    }
    const model = await server.switchProfile(profile, progress);
    followed = model;
    await useModel(model).catch((err) => {
      followed = null;
      console.warn('[server] pi model switch failed:', err.message);
      broadcast({ type: 'notify', level: 'error', message: `Loaded ${model}, but pi could not switch to it: ${err.message}` });
    });
    return model;
  })();
  try {
    return await switching;
  } finally {
    switching = null;
    publish();
  }
}

async function waitReachable(timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await server.routerModels();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('The model server did not start — see its log.');
}

async function service(action) {
  await server.service(action);
  if (action === 'start' || action === 'restart') await waitReachable().catch(() => {});
  publish();
}

// Follow models loaded outside LESLIE (the Everyday model finishing its load
// at login, or a switch made from the leslie-server TUI).
const WATCH_MS = 5000;
let watching = false;

let following = false;
let followed = null;
let followedKey = null;

async function followServer() {
  if (switching || following) return;
  following = true;
  try {
    const helperModel = server.loadSettings().helper.model;
    const models = await server.routerModels();
    if (models.some((m) => m.id === helperModel && m.status === 'loaded')) require('../helpers').noteHelperModelLoaded();
    const loaded = models.find((m) => m.status === 'loaded' && m.id !== helperModel);
    // Reloading the same model with a vision projector changes what pi may send it.
    const key = loaded && `${loaded.id}|${loaded.inputs.join(',')}`;
    if (!loaded || (loaded.id === followed && key === followedKey)) return;
    await useModel(loaded.id);
    followed = loaded.id;
    followedKey = key;
    console.log(`[server] now using ${loaded.id}`);
    publish();
  } catch (err) {
    console.warn('[server] could not follow the loaded model:', err.message);
  } finally {
    following = false;
  }
}

/** Resolves true once a model is loaded and in use, false if none loads in time. */
async function whenModelLoaded(timeoutMs = 5 * 60000) {
  if (!config.serverManaged) return true;
  const started = Date.now();
  while (!followed) {
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, WATCH_MS));
    await followServer();
  }
  return true;
}

/** At launch: bring the server up if needed, then keep LESLIE on whatever is loaded. */
async function startup() {
  if (!config.serverManaged) return;
  config.baseURL = `${server.baseUrl()}/v1`;
  try {
    const st = await server.status();
    if (!st.reachable && st.service.installed && st.service.active !== 'active') {
      await server.service('start');
      await waitReachable();
    }
  } catch (err) {
    console.warn('[server] startup:', err.message);
  }
  await followServer();
  if (!watching) {
    watching = true;
    setInterval(followServer, WATCH_MS).unref();
  }
  publish();
}

// A profile switch requested mid-reply (by the model_profile tool) waits until
// every running reply has finished, so the model isn't unloaded under itself.
let turnsInFlight = 0;
let pendingProfile = null;

function turnStarted() {
  turnsInFlight++;
}

// pi may still send a small follow-up request (e.g. naming the session) right
// after a reply; give it a moment before unloading the model under it.
const SETTLE_MS = 2000;

function turnEnded() {
  turnsInFlight = Math.max(0, turnsInFlight - 1);
  if (turnsInFlight || !pendingProfile) return;
  setTimeout(() => {
    if (turnsInFlight || !pendingProfile) return;
    const profile = pendingProfile;
    pendingProfile = null;
    switchTo(profile).catch((err) => broadcast({ type: 'notify', level: 'error', message: `Could not load ${profile}: ${err.message}` }));
  }, SETTLE_MS);
}

/** Switch now if idle, else after the current reply. Returns true when it started now. */
function requestSwitch(profile) {
  if (turnsInFlight) {
    pendingProfile = profile;
    return false;
  }
  switchTo(profile).catch((err) => broadcast({ type: 'notify', level: 'error', message: `Could not load ${profile}: ${err.message}` }));
  return true;
}

function saveSettings(patch) {
  const saved = server.saveSettings(patch);
  publish();
  return saved;
}

module.exports = {
  onEvent,
  status,
  publish,
  switchTo,
  requestSwitch,
  turnStarted,
  turnEnded,
  service,
  startup,
  whenModelLoaded,
  saveSettings,
  loadSettings: server.loadSettings,
  loadHelper: (onProgress) => server.loadHelper(onProgress),
  unloadHelper: () => server.unloadHelper(),
  listModels: () => server.listModels(),
  logs: (n) => server.logs(n),
  unloadAll: async () => {
    await server.unloadAll();
    publish();
  }
};

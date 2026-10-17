'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const config = require('../config');
const status = require('./status');
const { createTracker } = require('./tracker');
const { createPeople } = require('./people');
const { createClient } = require('./client');
const { createPresenceCore } = require('./core');
const { createGestureTracker } = require('./gestures');

const ACTIVITY_EVERY_MS = 60000;

const client = createClient(() => config.cameraServerUrl);
let people = null;
let core = null;
let handlers = {};
let unfollow = null;
let activityTimer = null;

function file(name) {
  return path.join(app.getPath('userData'), name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  try {
    fs.writeFileSync(file(name), JSON.stringify(value, null, 2));
  } catch (err) {
    console.warn(`[presence] could not save ${name}:`, err.message);
  }
}

function getPeople() {
  if (!people) {
    people = createPeople({
      load: () => readJson('leslie-people.json', []),
      save: (list) => writeJson('leslie-people.json', list)
    });
  }
  return people;
}

function cameraSettings(enabled) {
  return { enabled, device: config.cameraDevice, threshold: config.cameraMatchThreshold, hands: config.cameraGestures };
}

function connect() {
  if (unfollow) return;
  // The sidecar forgets its settings when it restarts, so send them on every (re)connect.
  unfollow = client.follow({
    onConnect: () => client.camera(cameraSettings(true)).catch(() => {}),
    onEvent: (event) => core.handle(event),
    onDisconnect: () => core.setActive(false)
  });
}

function disconnect() {
  unfollow?.();
  unfollow = null;
  core?.setActive(false);
}

/**
 * Start following the camera. `effects` receives arrived/left/empty/occupied/
 * changed/gesture/announce/activity callbacks (see core.js).
 */
function start(effects) {
  handlers = effects;
  const tracker = createTracker({
    arriveMs: config.cameraArriveSec * 1000,
    leaveMs: config.cameraLeaveSec * 1000
  });
  status.setRoster(getPeople().list());
  core = createPresenceCore({
    tracker,
    gestures: createGestureTracker(),
    people: getPeople(),
    status,
    held: readJson('leslie-presence.json', { held: [] }).held || [],
    saveHeld: (held) => writeJson('leslie-presence.json', { held }),
    handlers
  });
  clearInterval(activityTimer);
  activityTimer = setInterval(() => {
    if (status.snapshot().anyone) handlers.activity?.();
  }, ACTIVITY_EVERY_MS);
  if (config.cameraEnabled) connect();
}

function stop() {
  clearInterval(activityTimer);
  activityTimer = null;
  if (unfollow) client.camera(cameraSettings(false)).catch(() => {});
  disconnect();
}

/** Apply camera settings; the tracker timings take effect on restart. */
async function settingsChanged() {
  if (!core) return;
  if (config.cameraEnabled) {
    connect();
    await client.camera(cameraSettings(true)).catch(() => {});
  } else {
    await client.camera(cameraSettings(false)).catch(() => {});
    disconnect();
  }
}

function holdOrAnnounce(text) {
  if (core) core.holdOrAnnounce(text);
  else handlers.announce?.(text);
}

async function enroll({ name, role }) {
  if (!config.cameraEnabled) return { ok: false, error: 'Turn the camera on first.' };
  const list = getPeople();
  const person = list.add({ name, role });
  try {
    const res = await client.enroll(person.id);
    if (!res.ok) {
      list.remove(person.id);
      return { ok: false, error: res.error || 'Enrollment failed.' };
    }
    status.setRoster(list.list());
    core?.publish();
    return { ok: true, person, samples: res.samples };
  } catch (err) {
    list.remove(person.id);
    return { ok: false, error: `Vision service: ${err.message}` };
  }
}

function updatePerson(id, patch) {
  const person = getPeople().update(id, patch);
  status.setRoster(getPeople().list());
  core?.publish();
  return person ? { ok: true, person } : { ok: false, error: 'No such person.' };
}

async function removePerson(id) {
  const ok = getPeople().remove(id);
  await client.removePerson(id).catch(() => {});
  status.setRoster(getPeople().list());
  core?.publish();
  return { ok };
}

module.exports = {
  start,
  stop,
  settingsChanged,
  holdOrAnnounce,
  enroll,
  updatePerson,
  removePerson,
  people: () => getPeople().list(),
  devices: () => client.devices(),
  preview: () => client.preview(),
  snapshot: () => status.snapshot(),
  addressName: () => status.addressName()
};

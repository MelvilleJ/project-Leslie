'use strict';

const { UNKNOWN } = require('./tracker');

const STRANGER = { id: UNKNOWN, name: 'someone', role: 'unknown' };

/**
 * Applies sidecar events to the tracker and shared status, and calls back on
 * arrivals, departures, an emptied or reoccupied desk, held gestures, and briefings to hold.
 * Electron-free; index.js supplies storage and the effects.
 */
function createPresenceCore({ tracker, gestures = null, people, status, held = [], saveHeld = () => {}, handlers = {}, now = Date.now }) {
  let active = false;
  let anyone = false;
  let signature = '';

  const call = (name, ...args) => {
    try {
      return handlers[name]?.(...args);
    } catch (err) {
      console.warn(`[presence] ${name} handler failed:`, err.message);
    }
  };

  const resolve = (who) => (who === UNKNOWN ? STRANGER : people.find(who));

  function publish() {
    const { known, unknown } = active ? tracker.state() : { known: [], unknown: false };
    const present = known.map((id) => people.find(id)).filter(Boolean);
    const strangers = unknown || present.length < known.length;
    status.set({ active, present, unknown: strangers });

    const snap = status.snapshot();
    if (snap.anyone !== anyone) {
      anyone = snap.anyone;
      call(anyone ? 'occupied' : 'empty');
    }
    const next = JSON.stringify([snap.active, snap.present.map((p) => p.id), snap.unknown, snap.restricted]);
    if (next !== signature) {
      signature = next;
      call('changed', snap);
    }
  }

  function setActive(on) {
    if (on === active) return;
    active = on;
    tracker.reset(on ? now() : null);
    publish();
  }

  function observe(obs) {
    if (!active) return;
    for (const event of tracker.observe(obs)) {
      const person = resolve(event.who);
      if (!person) continue;
      if (event.type === 'left') {
        call('left', { person });
        continue;
      }
      let briefings = [];
      if (person.role === 'owner' && held.length) {
        briefings = held.map((h) => h.text);
        held.length = 0;
        saveHeld(held);
      }
      call('arrived', { person, awayMs: event.awayMs, held: briefings });
    }
    publish();
  }

  function handle(event) {
    if (event.type === 'status') setActive(Boolean(event.active));
    else if (event.type === 'observation') observe(event);
    else if (event.type === 'hands' && active && gestures) {
      for (const gesture of gestures.observe(event)) call('gesture', gesture);
    }
  }

  /** Brief the owner now if they are here (or the camera can't tell); otherwise keep it for their return. */
  function holdOrAnnounce(text) {
    if (!active || status.ownerPresent()) return call('announce', text);
    held.push({ text, at: now() });
    saveHeld(held);
    return undefined;
  }

  return { handle, setActive, holdOrAnnounce, publish, held: () => held.map((h) => h.text) };
}

module.exports = { createPresenceCore };

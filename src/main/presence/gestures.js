'use strict';

// A dropped frame or two (motion blur, a finger briefly misread) keeps a hold going.
const GAP_MS = 300;

/**
 * Turns per-frame hand poses into deliberate gestures: a pose has to be held
 * for a moment, and each gesture then rests before it can fire again.
 * Pure: time comes from the observations.
 */
function createGestureTracker({ holdMs = { palm: 1000, shush: 400 }, cooldownMs = 2500 } = {}) {
  let current = null;
  const lastFired = new Map();

  function observe({ ts, hands = [] }) {
    const pose = Object.keys(holdMs).find((g) => hands.some((h) => h.gesture === g)) || null;
    if (!pose) {
      if (current && ts - current.lastSeen > GAP_MS) current = null;
      return [];
    }
    if (!current || current.pose !== pose || ts - current.lastSeen > GAP_MS) {
      current = { pose, since: ts, lastSeen: ts, fired: false };
      return [];
    }
    current.lastSeen = ts;
    if (current.fired || ts - current.since < holdMs[pose]) return [];
    if (ts - (lastFired.get(pose) ?? -Infinity) < cooldownMs) return [];
    current.fired = true;
    lastFired.set(pose, ts);
    return [pose];
  }

  return { observe };
}

module.exports = { createGestureTracker };

'use strict';

const UNKNOWN = 'unknown';
// A sighting streak survives a missed frame or two (a blink, a turned head).
const STREAK_GAP_MS = 2500;

/**
 * Turns the sidecar's per-frame sightings into arrivals and departures.
 * Pure: time comes from the observations, so it is driven the same way in tests.
 */
function createTracker({
  arriveMs = 3000,
  leaveMs = 120000,
  unknownArriveMs = arriveMs * 3,
  unknownLeaveMs = Math.min(leaveMs, 15000)
} = {}) {
  let tracks = new Map();
  let leftAt = new Map();
  let since = null;

  function reset(ts = null) {
    tracks = new Map();
    leftAt = new Map();
    since = ts;
  }

  function observe({ ts, faces = [] }) {
    if (since === null) since = ts;
    const events = [];
    const seen = new Set(faces.map((f) => f.id || UNKNOWN));

    for (const who of seen) {
      const track = tracks.get(who);
      if (!track || (!track.present && ts - track.lastSeen > STREAK_GAP_MS)) {
        tracks.set(who, { firstSeen: ts, lastSeen: ts, present: false });
      } else {
        track.lastSeen = ts;
      }
    }

    // An unknown face that vanishes while someone recognised is in view was
    // most likely them before recognition caught up, so it lingers only briefly.
    const knownInView = [...seen].some((who) => who !== UNKNOWN);
    const leaveAfter = (who) => (who === UNKNOWN && knownInView ? unknownLeaveMs : leaveMs);

    for (const [who, track] of tracks) {
      if (!track.present && seen.has(who)) {
        const needed = who === UNKNOWN ? unknownArriveMs : arriveMs;
        if (ts - track.firstSeen >= needed) {
          track.present = true;
          events.push({ type: 'arrived', who, awayMs: ts - (leftAt.get(who) ?? since) });
        }
      } else if (track.present && ts - track.lastSeen >= leaveAfter(who)) {
        tracks.delete(who);
        leftAt.set(who, ts);
        events.push({ type: 'left', who });
      } else if (!track.present && ts - track.lastSeen > STREAK_GAP_MS) {
        tracks.delete(who);
      }
    }
    return events;
  }

  function state() {
    const present = [...tracks].filter(([, t]) => t.present).map(([who]) => who);
    return { known: present.filter((who) => who !== UNKNOWN), unknown: present.includes(UNKNOWN) };
  }

  return { observe, state, reset };
}

module.exports = { createTracker, UNKNOWN };

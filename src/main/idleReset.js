'use strict';

// Starts a fresh chat once the user has been quiet for config.idleResetMinutes.
// Only the user's own input counts as activity: a long reply or tool run does
// not keep a stale chat open, though a running turn is never cut off mid-way.

const config = require('./config');

let onReset = async () => {};
let timer = null;
let lastInput = 0;
let busy = 0;
let due = false;

function schedule() {
  clearTimeout(timer);
  timer = null;
  const ms = config.idleResetMinutes * 60000;
  if (!lastInput || !(ms > 0)) return;
  timer = setTimeout(fire, Math.max(0, lastInput + ms - Date.now()));
}

function fire() {
  timer = null;
  if (busy) {
    due = true;
    return;
  }
  due = false;
  lastInput = 0;
  onReset().catch((err) => console.warn('[idle-reset]', err && err.message));
}

module.exports = {
  init(callback) {
    onReset = callback;
  },
  userInput() {
    lastInput = Date.now();
    due = false;
    schedule();
  },
  /** The chat was reset by hand, so there is nothing left to time out. */
  cleared() {
    lastInput = 0;
    due = false;
    schedule();
  },
  turnStarted() {
    busy += 1;
  },
  turnEnded() {
    busy = Math.max(0, busy - 1);
    if (!busy && due) fire();
  },
  settingChanged: schedule
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/main/config');
const idleReset = require('../src/main/idleReset');

const MIN = 60000;

function setup(t, minutes = 30) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  config.idleResetMinutes = minutes;
  let resets = 0;
  idleReset.init(async () => {
    resets += 1;
  });
  idleReset.cleared();
  return () => resets;
}

test('resets once the user has been idle for the configured time', (t) => {
  const resets = setup(t);
  idleReset.userInput();
  t.mock.timers.tick(30 * MIN - 1);
  assert.equal(resets(), 0);
  t.mock.timers.tick(1);
  assert.equal(resets(), 1);
  t.mock.timers.tick(60 * MIN);
  assert.equal(resets(), 1, 'does not reset an already fresh chat');
});

test('new user input pushes the deadline back', (t) => {
  const resets = setup(t);
  idleReset.userInput();
  t.mock.timers.tick(20 * MIN);
  idleReset.userInput();
  t.mock.timers.tick(20 * MIN);
  assert.equal(resets(), 0);
  t.mock.timers.tick(10 * MIN);
  assert.equal(resets(), 1);
});

test('a running turn delays the reset until it ends', (t) => {
  const resets = setup(t);
  idleReset.userInput();
  idleReset.turnStarted();
  t.mock.timers.tick(45 * MIN);
  assert.equal(resets(), 0);
  idleReset.turnEnded();
  assert.equal(resets(), 1);
});

test('a manual reset cancels the timer', (t) => {
  const resets = setup(t);
  idleReset.userInput();
  idleReset.cleared();
  t.mock.timers.tick(60 * MIN);
  assert.equal(resets(), 0);
});

test('0 minutes turns it off, and changing the setting reschedules', (t) => {
  const resets = setup(t, 0);
  idleReset.userInput();
  t.mock.timers.tick(24 * 60 * MIN);
  assert.equal(resets(), 0);
  config.idleResetMinutes = 5;
  idleReset.settingChanged();
  t.mock.timers.tick(1);
  assert.equal(resets(), 1, 'already past the new deadline');
});

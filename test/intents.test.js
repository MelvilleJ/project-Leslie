'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { profileCommand, normalize } = require('../src/main/intents');

test('normalize strips the wake phrase, politeness and punctuation', () => {
  assert.equal(normalize('Hey Leslie, please mute!'), 'mute');
  assert.equal(normalize('  Clip   THIS. '), 'clip this');
  assert.equal(normalize('leslie can you stop clip'), 'stop clip');
});

test('profile commands are recognised', () => {
  for (const [text, want] of [
    ['power mode', 'power'],
    ['Switch to power mode', 'power'],
    ['hey leslie, go back to everyday mode please', 'everyday'],
    ['every day', 'everyday'],
    ['load the power model now', 'power']
  ]) {
    assert.equal(profileCommand(text), want, text);
  }
});

test('questions and longer sentences go to the model', () => {
  for (const text of ['what is power mode?', 'is everyday mode on', 'tell me about power mode', 'power mode is slow']) {
    assert.equal(profileCommand(text), null, text);
  }
});

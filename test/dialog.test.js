'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isClosing, invitesReply } = require('../src/renderer/dialog');

test('sign-offs end the exchange, however whisper punctuates them', () => {
  for (const t of [
    "Thank you, that's all.", "Thank you. That's all.", "That's all, thank you.", 'Thank you.',
    'Thanks Leslie.', "Thank you, that's all, Leslie.", 'Perfect, thanks.', 'That is all.', "Okay, I'm good.",
    'Great, thanks for that.', 'Cheers.', "No, that's it.", 'Nevermind.', 'Stop.', 'Thanks so much, bye.'
  ]) assert.ok(isClosing(t), t);
});

test('requests that mention thanks are still requests', () => {
  for (const t of [
    'Thanks, now open Spotify.', 'Thank you, can you also check my email?', "That's all for the music, now pause it.",
    'Stop the music.', 'Open Firefox.', "You're welcome.", ''
  ]) assert.ok(!isClosing(t), t);
});

test('only a question invites an answer without her name', () => {
  assert.ok(invitesReply('I found three files. Which one should I open?'));
  assert.ok(invitesReply('Shall I play it now, sir?"'));
  assert.ok(!invitesReply('Done, sir. The file is saved to Documents.'));
  assert.ok(!invitesReply('Is it raining? It is, sir. Bring an umbrella.'));
  assert.ok(!invitesReply(''));
});

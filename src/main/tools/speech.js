'use strict';

const tts = require('../tts');

module.exports = {
  name: 'speech',
  readOnly: true,
  description:
    "Mute or unmute LESLIE's spoken voice (her replies read aloud). Use when the user says things like " +
    '"mute", "be quiet", "stop talking out loud", "unmute", "talk to me", or asks whether her voice is on. ' +
    'Muting only silences speech; she still replies in text and still listens for the wake word.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['mute', 'unmute', 'toggle', 'status'], description: 'What to do.' }
    },
    required: ['action']
  },
  async run({ action }) {
    if (action === 'status') return { title: `Voice ${tts.isEnabled() ? 'on' : 'muted'}`, output: `Spoken replies are ${tts.isEnabled() ? 'on' : 'muted'}.` };
    if (!['mute', 'unmute', 'toggle'].includes(action)) throw new Error('action must be mute, unmute, toggle, or status');
    const on = action === 'toggle' ? !tts.isEnabled() : action === 'unmute';
    tts.setEnabled(on);
    return { title: on ? 'Voice on' : 'Voice muted', output: on ? 'Spoken replies are on.' : 'Spoken replies are muted.' };
  }
};

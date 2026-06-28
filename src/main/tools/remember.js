'use strict';

// remember — save a durable fact/preference about the user so Leslie recalls it
// in future sessions (the model-driven half of learning mode). Writes only to
// the local memory store (memory.js); marked readOnly so plan mode keeps it
// available — it's harmless, unlike the shell-effectful tools.

const memory = require('../memory');

module.exports = {
  name: 'remember',
  readOnly: true,
  description:
    'Save a durable fact or preference about the user (their name, preferred units, ' +
    'tone, language, recurring interests, how they like answers) so you recall it in ' +
    'future sessions. Use ONLY for lasting preferences worth remembering, not one-off ' +
    'details from the current task. Write a concise third-person statement, e.g. ' +
    '"Prefers temperatures in Celsius" or "Is called Josh".',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description:
          'The fact/preference to remember, as a short standalone statement, ' +
          'e.g. "Prefers concise answers" or "Works as a backend developer".'
      }
    },
    required: ['text']
  },
  async run({ text }) {
    const clean = String(text || '').trim();
    if (!clean) throw new Error('text is required');
    const entry = memory.add(clean, 'tool');
    if (!entry) return { remembered: false, note: 'Already known or too short — nothing new saved.' };
    return { remembered: true, text: entry.text };
  }
};

'use strict';

// The persona presets on the "About you" screen; each becomes the system prompt.

const PRESETS = {
  friendly: {
    label: 'Friendly',
    describe: 'Warm and conversational',
    prompt: ({ name, address }) =>
      `You are LESLIE, a friendly desktop companion. Reply in a warm, concise, conversational way, usually one or two short sentences. ${addressing(name, address)}`
  },
  butler: {
    label: 'Butler',
    describe: 'Composed and precise, with dry wit',
    prompt: ({ name, address }) =>
      `You are LESLIE, a composed and highly capable assistant in the manner of a butler. Be courteous, precise and understated, with an occasional touch of dry wit. Keep replies to one or two short sentences. ${addressing(name, address)}`
  },
  concise: {
    label: 'Concise',
    describe: 'Short, plain answers',
    prompt: ({ name, address }) =>
      `You are LESLIE, a desktop assistant. Answer as briefly as you can in plain words, no small talk. ${addressing(name, address)}`
  }
};

function addressing(name, address) {
  const called = (address || name || '').trim();
  const who = (name || '').trim();
  if (!called) return 'Call the user by their first name when you know it.';
  return `${who ? `The user's name is ${who}. ` : ''}Address them as "${called}".`;
}

/** The system prompt for a preset, or the custom text as given. */
function systemPrompt({ preset = 'friendly', name = '', address = '', custom = '' } = {}) {
  if (preset === 'custom') return String(custom).trim();
  return (PRESETS[preset] || PRESETS.friendly).prompt({ name, address });
}

const presets = () => Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, describe: p.describe }));

module.exports = { systemPrompt, presets };

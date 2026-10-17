'use strict';

const config = require('./config');
const { llmCall } = require('./tools/lib/llmCall');

const FALLBACKS = [
  'Welcome back{n}.', 'Good to see you{n}.', 'Hey{n}, all set when you are.',
  'Hi{n}, everything is ready.', 'Ready when you are{n}.', 'Welcome back{n}. What are we working on?'
];

// A fixed prompt still tends to repeat itself (and copies any example verbatim),
// so each boot gets a different tone and angle to nudge the model somewhere new.
const TONES = ['warm', 'cheerful', 'relaxed', 'playful', 'upbeat', 'friendly', 'lightly witty'];
const ANGLES = [
  'remark on the day of the week', 'offer your assistance', 'note that everything is ready',
  'remark on the time of day', 'welcome them back', 'ask what they would like to start with'
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const fallback = (name = '') => pick(FALLBACKS).replace('{n}', name ? `, ${name}` : '');

function timeOfDay(hour) {
  if (hour < 5) return 'late night';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 22) return 'evening';
  return 'night';
}

function tidy(text) {
  return String(text || '').split('\n').find((line) => line.trim())?.trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s*—\s*/g, ', ') || '';
}

function awayFor(minutes) {
  if (minutes < 90) return `${Math.round(minutes)} minutes`;
  return `${Math.round(minutes / 60)} hours`;
}

function situation({ name, guest, awayMinutes }) {
  if (guest) {
    return `${guest} (a guest of the owner, not the owner) just sat down at the computer. ` +
      `Greet ${guest} by name in one short, ${pick(TONES)} sentence.`;
  }
  const opening = awayMinutes
    ? `The user just came back to their desk after about ${awayFor(awayMinutes)} away.`
    : 'The user just turned on their computer.';
  const address = name ? `Call them ${name}` : 'Do not use a name or title';
  return `${opening} Greet them in one short, ${pick(TONES)} sentence, and ${pick(ANGLES)}. ` +
    `${address}: no pet names, no "dear", no "sir".`;
}

/**
 * A fresh one-line hello from the model, or a canned one if it can't be reached.
 * `name` is the owner's first name; `awayMinutes` makes it a welcome back;
 * `guest` greets someone other than the owner by name.
 */
async function generate({ name = '', awayMinutes = 0, guest = '' } = {}) {
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { weekday: 'long' });
  try {
    const text = tidy(await llmCall([
      { role: 'system', content: config.systemPrompt },
      {
        role: 'user',
        content: `It is ${day} ${timeOfDay(now.getHours())}. ${situation({ name, guest, awayMinutes })} Reply with the greeting only.`
      }
    ], { temperature: 0.8, maxTokens: 512, timeoutMs: 45000 }));
    if (text) return text;
  } catch (err) {
    console.warn('[greeting]', err.message);
  }
  return guest ? `Hi, ${guest}.` : fallback(name);
}

module.exports = { generate, fallback };

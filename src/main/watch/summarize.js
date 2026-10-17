'use strict';

const config = require('../config');
const { llmCall } = require('../tools/lib/llmCall');
const { wrapUntrusted } = require('../tools/lib/untrusted');
const presence = require('../presence/status');

const MAX_ITEMS = 10;
const MAX_DETAIL_CHARS = 1500;

const plural = (n, noun) => `${n} new ${noun}${n === 1 ? '' : 's'}`;

const named = (name) => (name ? `${name}, ` : '');

function fallback(source, items, name = presence.addressName()) {
  const text = `${plural(items.length, source.noun)}. The latest: ${items[items.length - 1].title}.`;
  return name ? `${named(name)}${text}` : text[0].toUpperCase() + text.slice(1);
}

function addressing() {
  const name = presence.addressName();
  return name ? ` Address them as ${name}.` : '';
}

function describe(items) {
  return items.slice(-MAX_ITEMS).map((item, i) => {
    const detail = item.detail ? `\n${item.detail.slice(0, MAX_DETAIL_CHARS)}` : '';
    return `#${i + 1} ${item.title}${detail}`;
  }).join('\n\n');
}

function tidy(text) {
  return String(text || '').trim().replace(/\s*—\s*/g, ', ').replace(/^["'“”]+|["'“”]+$/g, '');
}

/** A short spoken briefing on what just arrived, or a plain count if the model is unreachable. */
async function summarize(source, items) {
  const skipped = items.length > MAX_ITEMS ? ` (only the latest ${MAX_ITEMS} are shown)` : '';
  try {
    const text = tidy(await llmCall([
      { role: 'system', content: config.systemPrompt },
      {
        role: 'user',
        content:
          `There ${items.length === 1 ? 'is' : 'are'} ${plural(items.length, source.noun)}${skipped}. ` +
          'Brief the user on them in at most three short spoken sentences: who or what it is ' +
          `and anything that looks important or needs action.${addressing()} Plain prose, no lists or markdown, no em dashes.\n\n` +
          wrapUntrusted(source.name, describe(items))
      }
    ], { temperature: 0.3, maxTokens: 1024, timeoutMs: 60000 }));
    if (text) return text;
  } catch (err) {
    console.warn('[watch] summary failed:', err.message);
  }
  return fallback(source, items);
}

function digestFallback(briefings, name = presence.addressName()) {
  return `While you were away${name ? `, ${name}` : ''}: ${briefings.join(' ')}`;
}

/** Fold the briefings held while the owner was away into one short spoken catch-up. */
async function digest(briefings) {
  if (briefings.length === 1) return briefings[0];
  try {
    const text = tidy(await llmCall([
      { role: 'system', content: config.systemPrompt },
      {
        role: 'user',
        content:
          `The user was away from their desk. These ${briefings.length} briefings arrived meanwhile, oldest first. ` +
          `Catch them up in at most four short spoken sentences.${addressing()} Lead with anything that needs ` +
          'action. Plain prose, no lists or markdown, no em dashes.\n\n' +
          wrapUntrusted('held briefings', briefings.map((b, i) => `#${i + 1} ${b}`).join('\n'))
      }
    ], { temperature: 0.3, maxTokens: 1024, timeoutMs: 60000 }));
    if (text) return text;
  } catch (err) {
    console.warn('[watch] digest failed:', err.message);
  }
  return digestFallback(briefings);
}

module.exports = { summarize, fallback, digest, digestFallback };

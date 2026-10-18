'use strict';

// Lets a helper open the primary source (an official site, release page or
// docs) instead of answering from search snippets.

const { readPage } = require('./lib/webContent');

const PAGE_CHARS = 12000;
const FULL_CHARS = 400000;
const EXCERPT_CHARS = 700;
const MAX_EXCERPTS = 6;
const TIMEOUT_MS = 12000;

/** Passages around each match of `term`, so a long page's relevant part fits. */
function excerpts(text, term) {
  const needle = term.toLowerCase();
  const lower = text.toLowerCase();
  const out = [];
  let from = 0;
  while (out.length < MAX_EXCERPTS) {
    const at = lower.indexOf(needle, from);
    if (at === -1) break;
    const start = Math.max(0, at - EXCERPT_CHARS / 2);
    out.push(text.slice(start, start + EXCERPT_CHARS));
    from = start + EXCERPT_CHARS;
  }
  return out;
}

module.exports = {
  name: 'read_page',
  readOnly: true,
  helperOnly: true,
  description:
    'Open a web page and read its text. Use it on the most authoritative result (the official site, ' +
    'release page or documentation) to confirm an answer before reporting it. For a long page, pass ' +
    'look_for (e.g. a version number or keyword) to get the passages that mention it.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The page to read (http or https).' },
      look_for: { type: 'string', description: 'Optional: return only the passages containing this text.' }
    },
    required: ['url']
  },
  async run({ url, look_for: lookFor }, { signal } = {}) {
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('url must start with http:// or https://');
    const page = await readPage(url, lookFor ? FULL_CHARS : PAGE_CHARS, TIMEOUT_MS, signal);
    if (page.error) return { url, error: page.error };
    if (!lookFor) return { url, text: page.text, truncated: page.truncated };
    const found = excerpts(page.text, String(lookFor));
    return found.length ? { url, look_for: lookFor, passages: found } : { url, look_for: lookFor, note: 'Not found on this page.', start: page.text.slice(0, 2000) };
  }
};

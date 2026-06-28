'use strict';

// open_search — opens SearXNG search results in LESLIE's window for the user to
// browse (the HTML results page, not the JSON API). Use this when the user wants
// to *see* results; use web_search when the model needs results to answer.

const config = require('../config');

module.exports = {
  name: 'open_search',
  readOnly: true, // just displays results in LESLIE's window — allowed in plan mode
  description:
    "Open web search results in LESLIE's window for the user to browse. Use when the " +
    'user asks to look something up, search for, or find information they want to see ' +
    'themselves (as opposed to wanting a direct answer).',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for.' }
    },
    required: ['query']
  },
  async run({ query }, ctx) {
    if (!query || !String(query).trim()) throw new Error('query is required');
    const base = config.searxngUrl.replace(/\/+$/, '');
    const url = `${base}/search?${new URLSearchParams({ q: String(query) })}`;
    if (ctx && ctx.openUrl) ctx.openUrl(url);
    return { opened: url, query: String(query) };
  }
};

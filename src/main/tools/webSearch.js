'use strict';

const config = require('../config');

async function run({ query }) {
  if (!query || !String(query).trim()) {
    throw new Error('query is required');
  }

  const base = config.searxngUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({ q: String(query), format: 'json' });

  const res = await fetch(`${base}/search?${params}`, {
    headers: { Accept: 'application/json' }
  });
  if (!res.ok) {
    throw new Error(
      `SearXNG returned ${res.status} ${res.statusText} ` +
        `(is JSON output enabled in settings.yml?)`
    );
  }

  const data = await res.json();
  const results = (data.results || [])
    .slice(0, config.searchResults)
    .map((r, i) => ({
      rank: i + 1,
      title: r.title,
      url: r.url,
      snippet: (r.content || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    }));

  return {
    query: String(query),
    answers: data.answers || [],
    results
  };
}

module.exports = {
  name: 'web_search',
  readOnly: true,
  description:
    'Search the web via SearXNG for current or factual information — recent events, ' +
    'prices, documentation, or anything you are unsure about. Returns ranked results ' +
    'with titles, URLs, and snippets.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query, as you would type it into a search engine.'
      }
    },
    required: ['query']
  },
  run
};

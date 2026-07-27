'use strict';

const config = require('../config');
const { readPage } = require('./lib/webContent');

async function run({ query, max_pages }, ctx = {}) {
  if (!query || !String(query).trim()) {
    throw new Error('query is required');
  }
  const signal = ctx.signal;

  const base = config.searxngUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({ q: String(query), format: 'json' });

  const res = await fetch(`${base}/search?${params}`, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) {
    throw new Error(
      `SearXNG returned ${res.status} ${res.statusText} (is JSON output enabled in settings.yml?)`
    );
  }

  const data = await res.json();
  const wanted = Math.max(1, Math.min(Number(max_pages) || config.deepSearchPages, config.deepSearchPages));
  const top = (data.results || []).filter((r) => r && r.url).slice(0, wanted);

  const pages = await Promise.all(
    top.map(async (r, i) => {
      const page = await readPage(r.url, config.deepSearchChars, config.deepSearchTimeoutMs, signal);
      return {
        rank: i + 1,
        title: r.title,
        url: r.url,
        ...page
      };
    })
  );

  return {
    query: String(query),
    answers: data.answers || [],
    pages
  };
}

module.exports = {
  name: 'deep_search',
  readOnly: true,
  description:
    'Research a topic by searching the web and reading the full text of the top result ' +
    'pages (not just snippets). Use for questions that need synthesis across sources — ' +
    'comparisons, how-to guides, detailed or multi-fact answers. Slower than web_search; ' +
    'prefer web_search when a snippet would already answer the question.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query, as you would type it into a search engine.'
      },
      max_pages: {
        type: 'integer',
        description: 'How many top result pages to read (optional). Fewer is faster.'
      }
    },
    required: ['query']
  },
  run
};

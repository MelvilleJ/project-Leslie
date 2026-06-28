'use strict';

// deep_search — like web_search, but actually *reads* the top pages. It queries
// SearXNG for ranked results, then fetches each result page and extracts its
// readable text, so the model can synthesize an answer from page content rather
// than from snippets alone. Use it for research-style questions where a single
// search snippet is not enough (comparisons, how-tos, multi-source facts).

const config = require('../config');

// Strip an HTML document down to readable plain text. Deliberately simple — no
// DOM, no dependencies: drop script/style/noscript, turn tags into spaces,
// decode the few entities that matter, then collapse whitespace.
function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(?:p|div|h[1-6]|li|br|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

// Fetch one page and return its extracted text (truncated), or an error note.
async function readPage(url, charLimit) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.deepSearchTimeoutMs);
    let res;
    try {
      res = await fetch(url, {
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0 (LESLIE)' }
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { error: `HTTP ${res.status} ${res.statusText}` };

    const type = res.headers.get('content-type') || '';
    if (!/text\/html|xml|text\/plain/i.test(type)) {
      return { error: `unsupported content-type (${type.split(';')[0] || 'unknown'})` };
    }

    const html = await res.text();
    const text = htmlToText(html);
    if (!text) return { error: 'no readable text' };
    return {
      text: text.slice(0, charLimit),
      truncated: text.length > charLimit
    };
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? 'timed out' : err && err.message ? err.message : String(err);
    return { error: msg };
  }
}

async function run({ query, max_pages }) {
  if (!query || !String(query).trim()) {
    throw new Error('query is required');
  }

  const base = config.searxngUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({ q: String(query), format: 'json' });

  const res = await fetch(`${base}/search?${params}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(
      `SearXNG returned ${res.status} ${res.statusText} (is JSON output enabled in settings.yml?)`
    );
  }

  const data = await res.json();
  const wanted = Math.max(1, Math.min(Number(max_pages) || config.deepSearchPages, config.deepSearchPages));
  const top = (data.results || []).filter((r) => r && r.url).slice(0, wanted);

  // Read the pages concurrently — they're independent network calls.
  const pages = await Promise.all(
    top.map(async (r, i) => {
      const page = await readPage(r.url, config.deepSearchChars);
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
  readOnly: true, // information-gathering only — allowed in plan mode
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

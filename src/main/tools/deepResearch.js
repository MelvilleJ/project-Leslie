'use strict';

const { research } = require('./lib/deepResearch/researcher');
const { formatReport } = require('./lib/deepResearch/report');

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Turn a researcher progress event into a short line for the tool card / status line. */
function phaseLabel(e) {
  switch (e.phase) {
    case 'planning':
      return 'Planning research…';
    case 'searching':
      return e.queryPreview ? `Round ${e.round} · searching "${e.queryPreview}"` : `Round ${e.round} · searching…`;
    case 'reading':
      return e.url ? `Reading ${hostOf(e.url)}` : `Round ${e.round} · reading…`;
    case 'analyzing':
      return `Synthesizing (${e.totalFindings} source${e.totalFindings === 1 ? '' : 's'})…`;
    case 'writing':
      return 'Writing final report…';
    case 'error':
      return e.message || 'Search error';
    default:
      return '';
  }
}

async function run({ query }, ctx = {}) {
  if (!query || !String(query).trim()) {
    throw new Error('query is required');
  }

  const out = await research(String(query), {
    // Pass both a short human label (for the tool-card status/text) and the raw
    // structured event (to drive the live synapse visual in the renderer).
    emit: (e) => {
      if (typeof ctx.onProgress === 'function') ctx.onProgress({ label: phaseLabel(e), event: e });
    },
    signal: ctx.signal
  });

  return formatReport(String(query), out);
}

module.exports = {
  name: 'deep_research',
  readOnly: true,
  description:
    'Deeply research a topic: iteratively search the web, read and extract from many sources over ' +
    'several rounds, and synthesize a long, cited report. Use for open-ended, multi-faceted questions ' +
    'that need comprehensive analysis — comparisons, "what happened with X", "best options for Y". Much ' +
    'slower than web_search/deep_search (can take a few minutes) — prefer those for quick facts.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The research question to investigate thoroughly.'
      }
    },
    required: ['query']
  },
  run
};

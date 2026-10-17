'use strict';

const { research } = require('./lib/deepResearch/researcher');
const { formatReport, formatSummary, reportBody } = require('./lib/deepResearch/report');
const createDocument = require('./createDocument');
const config = require('../config');

const SAVE_FORMATS = ['docx', 'pdf', 'md', 'html'];
const DEFAULT_FORMAT = 'md';

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
    case 'summarizing':
      return 'Summarizing…';
    case 'error':
      return e.message || 'Search error';
    default:
      return '';
  }
}

// Word, PDF and HTML output doesn't render inline markdown, so drop the
// emphasis markers and spell links out instead of leaving raw syntax.
function plainInline(text) {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)');
}

// Saving from here keeps the model from re-typing a multi-page report into
// create_document, which local models truncate or paraphrase.
async function saveReport(query, out, format) {
  const body = reportBody(out);
  const date = new Date().toISOString().slice(0, 10);
  return createDocument.run({
    filename: `Research - ${query.slice(0, 80)} (${date})`,
    format,
    title: query,
    content: format === 'md' ? body : plainInline(body)
  });
}

async function run({ query, save_as: saveAs }, ctx = {}) {
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

  // Nothing was gathered, so there is no report worth saving.
  if (!out.findings.length) return formatReport(String(query), out);

  const requested = String(saveAs || '').toLowerCase();
  const format = SAVE_FORMATS.includes(requested) ? requested : DEFAULT_FORMAT;
  if (config.planMode) return `${formatReport(String(query), out)}\n\n(Not saved: plan mode can't write files.)`;
  const saved = await saveReport(String(query), out, format);
  return formatSummary(String(query), out, saved.message);
}

module.exports = {
  name: 'deep_research',
  readOnly: true,
  description:
    'Deeply research a topic: iteratively search the web, read and extract from many sources over ' +
    'several rounds, and synthesize a long, cited report. Use for open-ended, multi-faceted questions ' +
    'that need comprehensive analysis — comparisons, "what happened with X", "best options for Y". Much ' +
    'slower than web_search/deep_search (can take a few minutes) — prefer those for quick facts. ' +
    'When the user wants a report, document or file of the research, set save_as and the finished ' +
    "report (with sources) is saved to their Documents folder; don't rewrite it with create_document.",
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The research question to investigate thoroughly.'
      },
      save_as: {
        type: 'string',
        enum: SAVE_FORMATS,
        description: `Format for the saved report. Defaults to ${DEFAULT_FORMAT}; pick another only if the user asks for one.`
      }
    },
    required: ['query']
  },
  run
};

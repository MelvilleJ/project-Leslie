'use strict';

const { research } = require('./lib/deepResearch/researcher');
const { formatReport, formatSummary, reportBody } = require('./lib/deepResearch/report');
const createDocument = require('./createDocument');
const config = require('../config');
const docs = require('../docs');
const { pendingBlock } = require('../docs/blocks');

const SAVE_FORMATS = ['docx', 'pdf', 'md', 'html'];
const DEFAULT_FORMAT = 'md';
const PROGRESS_EVERY_MS = 1500;

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

/**
 * A markdown report goes into a live doc that opens as research starts: a
 * placeholder shows the current phase, then the finished report replaces it.
 */
function startLiveDoc(query, ctx) {
  const store = docs.store();
  const date = new Date().toISOString().slice(0, 10);
  let title = `Research - ${query.slice(0, 80)} (${date})`;
  for (let n = 2; store.exists(title); n++) title = `Research - ${query.slice(0, 80)} (${date}) ${n}`;
  const view = store.create(title, `# ${query}\n\n${pendingBlock('Researching: planning…')}\n`);
  store.readForLeslie(view.name);
  const id = view.blocks[view.blocks.length - 1].id;
  if (!docs.isOpen(view.name) && typeof ctx.openUrl === 'function') ctx.openUrl(docs.url(view.name));
  let shownAt = 0;
  const write = (text) => store.apply(view.name, [{ op: 'replace', id, text }], 'leslie').results[0].ok;
  return {
    name: view.name,
    progress(label) {
      if (!label || Date.now() - shownAt < PROGRESS_EVERY_MS) return;
      shownAt = Date.now();
      write(pendingBlock(`Researching: ${label}`));
    },
    finish: (markdown) => write(markdown) || store.apply(view.name, [{ op: 'insert', text: markdown }], 'leslie')
  };
}

async function run({ query, save_as: saveAs }, ctx = {}) {
  if (!query || !String(query).trim()) {
    throw new Error('query is required');
  }

  const requested = String(saveAs || '').toLowerCase();
  const format = SAVE_FORMATS.includes(requested) ? requested : DEFAULT_FORMAT;
  const live = format === 'md' && !config.planMode && docs.enabled() ? startLiveDoc(String(query), ctx) : null;

  let out;
  try {
    out = await research(String(query), {
      // Pass both a short human label (for the tool-card status/text) and the raw
      // structured event (to drive the live synapse visual in the renderer).
      emit: (e) => {
        if (typeof ctx.onProgress === 'function') ctx.onProgress({ label: phaseLabel(e), event: e });
        if (live) live.progress(phaseLabel(e));
      },
      signal: ctx.signal
    });
  } catch (err) {
    if (live) live.finish(`*Research stopped: ${err.message}*`);
    throw err;
  }

  // Nothing was gathered, so there is no report worth saving.
  if (!out.findings.length) {
    if (live) live.finish('*No sources turned up for this.*');
    return formatReport(String(query), out);
  }

  if (live) {
    live.finish(reportBody(out));
    return formatSummary(String(query), out, `the live doc "${live.name}", open in the browser at ${docs.url(live.name)}`);
  }
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
    "report (with sources) is saved for them (as markdown, a live doc they can edit with you); don't rewrite it with create_document.",
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

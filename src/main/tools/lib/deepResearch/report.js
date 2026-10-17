'use strict';

// Formats a completed research run into the text fed back to the model as the
// tool result. Unlike odysseus — where this report
// can be shown to the user directly — Leslie's tool output is always re-read
// by the model in the very next turn to write its reply, in the SAME
// constrained context window as the system prompt and history. So this stays
// deliberately lean: stats + the synthesized report body + a curated Sources
// list. No per-source raw-findings dump and no full analyzed-URLs list — both
// are pure audit detail that isn't rendered anywhere in the UI, and including
// them was blowing small local-model context windows (e.g. 4096 tokens) once
// the model tried to read its own research output back.

function isLowQualitySummary(summary) {
  const s = String(summary || '').trim();
  return !s || s.length < 20;
}

/** Deduplicated, citation-quality Sources list (filters low-quality/empty summaries). */
function dedupeSources(findings) {
  const seen = new Set();
  const lines = [];
  for (const f of findings || []) {
    if (!f || !f.url || seen.has(f.url)) continue;
    if (isLowQualitySummary(f.summary || f.evidence)) continue;
    seen.add(f.url);
    lines.push(`- [${f.title || f.url}](${f.url})`);
  }
  return lines;
}

/** Stats, report body and Sources: the part worth keeping as a document. */
function reportBody(out) {
  const { report, findings, stats } = out;
  const summaryLine = [
    `**Duration:** ${(stats.elapsedMs / 1000).toFixed(1)}s`,
    `**Rounds:** ${stats.rounds}`,
    `**Queries:** ${stats.queries}`,
    `**URLs Analyzed:** ${stats.urls}`
  ].join(' | ');

  const sourceLines = dedupeSources(findings);

  const sections = ['## Research Summary', '', summaryLine, '', '---', '', report, ''];
  if (sourceLines.length) sections.push('### Sources', '', ...sourceLines, '');
  return sections.join('\n').trim();
}

/**
 * @param {string} query
 * @param {{report:string, findings:object[], analyzedUrls:object[], stats:{rounds:number,queries:number,urls:number,elapsedMs:number}}} out
 */
function formatReport(query, out) {
  return ['---', '', reportBody(out), '', '---', '', `**Research complete. Cite sources above when relevant to "${query}".**`].join('\n');
}

/** What the model gets back once the full report is saved: the summary, where the report is, and sources. */
function formatSummary(query, out, savedMessage) {
  const sourceLines = dedupeSources(out.findings);
  const sections = ['## Research Summary', '', out.summary, '', `**Full report:** ${savedMessage}`, ''];
  if (sourceLines.length) sections.push('### Sources', '', ...sourceLines, '');
  sections.push(
    `**Research complete for "${query}". Give the user this summary and tell them where the full report is; don't repeat the whole report.**`
  );
  return sections.join('\n');
}

module.exports = { formatReport, formatSummary, reportBody };

'use strict';

// Checks a helper's report against what it actually read: each quote must
// appear in its tool results, and the answer's key terms must appear in those
// quotes. Small models paraphrase, blend dates and fill gaps from memory; this
// catches it without asking another model.

const MIN_QUOTE_CHARS = 8;
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'was', 'are', 'is', 'its', 'version', 'latest', 'current', 'stable', 'release', 'released']);

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’‚′`]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/ /g, ' ')
    .replace(/[*_#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every string in a tool result: bridged tools return JSON, so page text sits inside it escaped. */
function stringsIn(text, out = []) {
  let value = text;
  if (typeof text === 'string') {
    try {
      value = JSON.parse(text);
    } catch {
      out.push(text);
      return out;
    }
  }
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringsIn(v, out);
  else if (value !== null && value !== undefined) out.push(String(value));
  return out;
}

function corpusOf(sources) {
  return normalize(sources.flatMap((s) => stringsIn(s)).join('\n'));
}

/** A quote may skip text with an ellipsis; every piece must still be found. */
function quoteFound(quote, corpus) {
  const pieces = normalize(quote)
    .split(/\.\.\.|…/)
    .map((p) => p.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
  const total = pieces.reduce((n, p) => n + p.length, 0);
  return total >= MIN_QUOTE_CHARS && pieces.every((p) => corpus.includes(p));
}

const numbersIn = (text) => text.match(/\d+(?:[.:/-]\d+)*/g) || [];

/**
 * What the answer adds: its numbers and versions (failing those, its significant
 * words), minus anything the task already said ("Node.js 20") and asides in
 * parentheses ("4096 bytes (4 KB)").
 */
function keyTerms(answer, task) {
  const text = normalize(answer).replace(/\([^)]*\)/g, ' ');
  const given = new Set(numbersIn(normalize(task)));
  const numbers = numbersIn(text).filter((n) => !given.has(n));
  if (numbers.length) return { terms: [...new Set(numbers)], need: 1 };
  const words = [...new Set(text.match(/[a-z][a-z'-]{3,}/g) || [])].filter((w) => !STOP_WORDS.has(w));
  return { terms: words, need: 0.6 };
}

function termFound(term, text) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Whole numbers only, so "6.1" is not found inside "6.11" (but is inside "v6.1").
  if (/^\d/.test(term)) return new RegExp(`(?<![0-9.])${escaped}(?![0-9]|\\.[0-9])`).test(text);
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

/**
 * Verdict on a report: 'verified' (the quotes found in its sources back the
 * answer), 'partly' (some quotes found, answer not fully backed) or 'unverified'.
 * Quotes that were not found are flagged one by one either way.
 */
function verifyReport(report, sources, task = '') {
  const corpus = corpusOf(sources);
  const evidence = (Array.isArray(report.evidence) ? report.evidence : []).slice(0, 6).map((e) => ({
    url: String((e && e.url) || ''),
    quote: String((e && e.quote) || '').slice(0, 400),
    found: Boolean(e && quoteFound(e.quote, corpus))
  }));
  const backing = normalize(evidence.filter((e) => e.found).map((e) => e.quote).join(' '));
  const { terms, need } = keyTerms(report.answer, task);
  const hits = terms.filter((t) => termFound(t, backing)).length;
  const answerBacked = terms.length > 0 && hits / terms.length >= need;
  const found = evidence.filter((e) => e.found).length;

  let verdict = 'unverified';
  if (found && answerBacked) verdict = 'verified';
  else if (found) verdict = 'partly';
  return { verdict, evidence, answerBacked };
}

module.exports = { verifyReport, quoteFound, normalize, corpusOf };

'use strict';

// Fetch-a-URL-and-reduce-to-text helpers, shared by deep_search (single-shot)
// and deep_research (iterative). Extracted from the original deepSearch tool
// so both can reuse the same fetch/strip logic without duplicating it.

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

/**
 * Fetch a URL and reduce it to plain text, capped at charLimit.
 * @param {string} url
 * @param {number} charLimit max characters of text to return
 * @param {number} timeoutMs abort the fetch after this many ms
 * @returns {Promise<{text?:string, truncated?:boolean, error?:string}>}
 */
async function readPage(url, charLimit, timeoutMs, signal) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let onAbort;
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else {
        onAbort = () => ctrl.abort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    let res;
    try {
      res = await fetch(url, {
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0 (LESLIE)' }
      });
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
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

module.exports = { htmlToText, readPage };

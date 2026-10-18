'use strict';

// Checks ```mermaid blocks with mermaid's own parser, so a diagram that won't
// draw is reported to Leslie in the same tool reply that wrote it.

const MERMAID_BLOCK = /^\s*```mermaid[^\n]*\n([\s\S]*?)^\s*```/gm;
const MAX_ERROR = 400;

let parser = null;

function loadParser() {
  parser ??= (async () => {
    // mermaid's own DOMPurify (same module instance) has no hooks outside a
    // browser; parsing never builds HTML, so no-ops are enough.
    const { default: purify } = await import('dompurify');
    purify.addHook ??= () => {};
    purify.removeHook ??= () => {};
    purify.removeHooks ??= () => {};
    purify.sanitize ??= (s) => s;
    const { default: mermaid } = await import('mermaid');
    return mermaid;
  })().catch((err) => {
    console.warn('[docs] diagram check unavailable:', err.message);
    parser = null;
    return null;
  });
  return parser;
}

function diagramSources(markdown) {
  return [...String(markdown || '').matchAll(MERMAID_BLOCK)].map((m) => m[1]);
}

/** The mermaid blocks in `markdown` that don't parse, as `{ source, error }`. */
async function brokenDiagrams(markdown) {
  const sources = diagramSources(markdown);
  if (!sources.length) return [];
  const mermaid = await loadParser();
  if (!mermaid) return [];
  const broken = [];
  for (const source of sources) {
    try {
      await mermaid.parse(source);
    } catch (err) {
      broken.push({ source, error: String(err?.message || err).trim().slice(0, MAX_ERROR) });
    }
  }
  return broken;
}

module.exports = { brokenDiagrams, diagramSources };

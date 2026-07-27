'use strict';

// Tolerant parser for tool-call argument JSON. Weak local models routinely emit
// arguments that aren't strictly valid JSON — literal newlines/tabs inside a
// string value (the classic write_file/multi-line failure), trailing commas, or
// a truncated tail. A raw JSON.parse rejects all of these; this repairs the
// common cases the way a streaming SDK's tolerant parser would.

function stripFence(s) {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

// Escape raw control chars that appear INSIDE string literals, and track
// container/string state so a truncated tail can be closed.
function repair(input) {
  let out = '';
  let inStr = false;
  let esc = false;
  const stack = [];
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { out += ch; inStr = false; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      const code = ch.charCodeAt(0);
      if (code < 0x20) { out += '\\u' + code.toString(16).padStart(4, '0'); continue; }
      out += ch;
    } else if (ch === '"') {
      inStr = true; out += ch;
    } else if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']'); out += ch;
    } else if (ch === '}' || ch === ']') {
      if (stack[stack.length - 1] === ch) stack.pop();
      out += ch;
    } else {
      out += ch;
    }
  }
  if (inStr) out += '"'; // close a truncated final string
  out = out.replace(/,(\s*[}\]])/g, '$1'); // trailing commas
  while (stack.length) { // close truncated containers
    out = out.replace(/,\s*$/, '');
    out += stack.pop();
  }
  return out;
}

/**
 * Parse tool-call arguments into an object. Returns { ok, args }.
 * @param {string} raw the model-supplied arguments string
 */
function parseToolArgs(raw) {
  const s = stripFence(String(raw == null ? '' : raw).trim()) || '{}';
  const candidates = [s, repair(s)];
  const embedded = s.match(/\{[\s\S]*\}/);
  if (embedded) candidates.push(repair(embedded[0]));
  for (const cand of candidates) {
    try {
      const v = JSON.parse(cand);
      if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, args: v };
    } catch {}
  }
  return { ok: false, args: {} };
}

module.exports = { parseToolArgs, repair };

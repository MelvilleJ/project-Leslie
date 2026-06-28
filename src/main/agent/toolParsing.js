'use strict';

// Text-fallback tool-call parser. Some local models don't emit native OpenAI
// `tool_calls`; they write the call as text instead. This recovers those calls
// from the raw assistant content. Ported (shapes only) from Odysseus's
// src/tool_parsing.py. Pure functions — no Electron, unit-testable.
//
// Three notations are recognised:
//   1. XML:     <tool_call><invoke name="web_search"><parameter name="query">cats</parameter></invoke></tool_call>
//               (the <tool_call>/<function_call> wrapper is optional; bare <invoke> works)
//   2. Bracket: [TOOL_CALL]{ "name": "web_search", "arguments": { "query": "cats" } }[/TOOL_CALL]
//   3. Fenced:  ```json | ```tool_call | ```tool_code | ```<known_tool_name>
//               containing either {name, arguments} or, when fenced by a tool
//               name, the bare arguments object.
//
// Every recovered call is normalised to the native shape so the rest of the
// loop is channel-agnostic: { id, name, arguments } where `arguments` is a
// JSON STRING (exactly like OpenAI delta.tool_calls[].function.arguments).

let _seq = 0;
function genId() {
  return `fallback_${Date.now().toString(36)}_${(++_seq).toString(36)}`;
}

// Coerce a parsed args value into the canonical JSON-string form.
function argsToString(args) {
  if (args == null) return '{}';
  if (typeof args === 'string') {
    const t = args.trim();
    if (!t) return '{}';
    try {
      JSON.parse(t);
      return t; // already valid JSON text
    } catch {
      return JSON.stringify({ value: args }); // opaque string → wrap
    }
  }
  try {
    return JSON.stringify(args);
  } catch {
    return '{}';
  }
}

function pushCall(out, name, args) {
  const n = String(name || '').trim();
  if (!n) return;
  out.push({ id: genId(), name: n, arguments: argsToString(args) });
}

// --- 1. XML <invoke name="…"><parameter name="…">…</parameter></invoke> -----
// Bounded, forward-only scan via indexOf (no catastrophic backtracking on
// untrusted model output).
function parseXmlInvokes(text, out) {
  const lower = text.toLowerCase();
  let from = 0;
  for (;;) {
    const open = lower.indexOf('<invoke', from);
    if (open === -1) break;
    const nameMatch = /name\s*=\s*["']([^"']+)["']/i.exec(text.slice(open, open + 200));
    const gt = text.indexOf('>', open);
    if (!nameMatch || gt === -1) {
      from = open + 7;
      continue;
    }
    const close = lower.indexOf('</invoke>', gt);
    const inner = text.slice(gt + 1, close === -1 ? undefined : close);
    const args = {};
    const paramRe = /<parameter\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi;
    let pm;
    while ((pm = paramRe.exec(inner)) !== null) {
      args[pm[1]] = coerceScalar(pm[2].trim());
    }
    pushCall(out, nameMatch[1], args);
    from = close === -1 ? gt + 1 : close + 9;
  }
}

// Parameter values arrive as text; recover numbers/booleans/JSON where obvious.
function coerceScalar(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v)) && /^-?\d/.test(v)) return Number(v);
  if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
    try {
      return JSON.parse(v);
    } catch {
      /* fall through */
    }
  }
  return v;
}

// --- 2. [TOOL_CALL]{ … }[/TOOL_CALL] ----------------------------------------
function parseBracketCalls(text, out) {
  const re = /\[TOOL_CALL\]\s*([\s\S]*?)\[\/TOOL_CALL\]/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    addJsonCall(m[1].trim(), null, out);
  }
}

// --- 3. ```fence … ``` ------------------------------------------------------
function parseFencedCalls(text, knownNames, out) {
  const re = /```([A-Za-z0-9_-]*)\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const lang = (m[1] || '').toLowerCase();
    const body = m[2].trim();
    if (!body) continue;
    if (lang === 'json' || lang === 'tool_call' || lang === 'tool_code') {
      addJsonCall(body, null, out);
    } else if (knownNames.has(lang)) {
      // Fenced by a tool name: body is the arguments object for that tool.
      addJsonCall(body, lang, out);
    }
  }
}

// Parse a JSON blob that is either {name, arguments|parameters} (forcedName=null)
// or the bare arguments object for `forcedName`.
function addJsonCall(body, forcedName, out) {
  let obj;
  try {
    obj = JSON.parse(body);
  } catch {
    return; // not JSON — ignore (likely illustrative text)
  }
  if (Array.isArray(obj)) {
    for (const item of obj) addParsedObject(item, forcedName, out);
  } else {
    addParsedObject(obj, forcedName, out);
  }
}

function addParsedObject(obj, forcedName, out) {
  if (!obj || typeof obj !== 'object') return;
  if (forcedName) {
    pushCall(out, forcedName, obj);
    return;
  }
  const name = obj.name || obj.tool || obj.function;
  const args = obj.arguments ?? obj.parameters ?? obj.args ?? {};
  if (name) pushCall(out, name, args);
}

/**
 * Recover tool calls written as text in the model's content.
 * @param {string} rawContent the full assistant content for the turn
 * @param {{ knownNames?: Iterable<string> }} [opts] restrict fenced-by-name detection
 * @returns {{id:string,name:string,arguments:string}[]}
 */
function parseToolCalls(rawContent, opts = {}) {
  if (!rawContent || typeof rawContent !== 'string') return [];
  const knownNames = new Set([...(opts.knownNames || [])].map((s) => String(s).toLowerCase()));
  const out = [];
  parseXmlInvokes(rawContent, out);
  parseBracketCalls(rawContent, out);
  parseFencedCalls(rawContent, knownNames, out);
  // De-dupe identical (name + args) recoveries (a call can match two notations).
  const seen = new Set();
  return out.filter((c) => {
    const sig = `${c.name}:${c.arguments}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

module.exports = { parseToolCalls, argsToString };

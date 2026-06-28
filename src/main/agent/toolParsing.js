'use strict';

let _seq = 0;
function genId() {
  return `fallback_${Date.now().toString(36)}_${(++_seq).toString(36)}`;
}

function argsToString(args) {
  if (args == null) return '{}';
  if (typeof args === 'string') {
    const t = args.trim();
    if (!t) return '{}';
    try {
      JSON.parse(t);
      return t;
    } catch {
      return JSON.stringify({ value: args });
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

function coerceScalar(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v)) && /^-?\d/.test(v)) return Number(v);
  if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
    try {
      return JSON.parse(v);
    } catch {
    }
  }
  return v;
}

function parseBracketCalls(text, out) {
  const re = /\[TOOL_CALL\]\s*([\s\S]*?)\[\/TOOL_CALL\]/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    addJsonCall(m[1].trim(), null, out);
  }
}

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
      addJsonCall(body, lang, out);
    }
  }
}

function addJsonCall(body, forcedName, out) {
  let obj;
  try {
    obj = JSON.parse(body);
  } catch {
    return;
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
  const seen = new Set();
  return out.filter((c) => {
    const sig = `${c.name}:${c.arguments}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

module.exports = { parseToolCalls, argsToString };

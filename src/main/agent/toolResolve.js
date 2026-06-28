'use strict';

// Decide which tool-call channel a turn used. Ported from Odysseus's
// _resolve_tool_blocks (src/agent_loop.py).
//
// Rule: if the model emitted native `tool_calls`, trust ONLY those and do NOT
// also scan the prose for fenced blocks — for a model with a working native
// channel, a ```json fence in its reply is almost always an illustrative
// example for the user, and executing it causes accidental runs. Only when the
// native channel produced nothing do we fall back to parsing the text.

const { parseToolCalls, argsToString } = require('./toolParsing');

// Normalise a native OpenAI tool_call into { id, name, arguments(string) }.
function fromNative(tc, i) {
  return {
    id: tc.id || `call_${i}`,
    name: tc.function?.name || '',
    arguments: argsToString(tc.function?.arguments ?? '{}')
  };
}

/**
 * @param {object} turn result of streamTurn() — { toolCalls, rawContent }
 * @param {Iterable<string>} knownNames tool names (for fenced-by-name detection)
 * @returns {{ calls: {id,name,arguments:string}[], usedNative: boolean }}
 */
function resolveToolCalls(turn, knownNames) {
  const native = (turn.toolCalls || []).map(fromNative).filter((c) => c.name);
  if (native.length) {
    return { calls: native, usedNative: true };
  }
  const parsed = parseToolCalls(turn.rawContent || '', { knownNames });
  return { calls: parsed, usedNative: false };
}

module.exports = { resolveToolCalls };

'use strict';

const { parseToolCalls, argsToString } = require('./toolParsing');

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

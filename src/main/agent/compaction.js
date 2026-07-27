'use strict';

const config = require('../config');
const { llmCall, estimateTokens } = require('../tools/lib/llmCall');

const KEEP_TAIL = 4;

function historyTokens(history) {
  return history.reduce((s, m) => s + estimateTokens(m.content || ''), 0);
}

/**
 * If the conversation history is getting large relative to the context window,
 * summarize everything but the last few messages into one compact system note
 * and return the trimmed history. On any failure, returns history unchanged.
 */
async function maybeCompact(history) {
  if (!Array.isArray(history) || history.length <= KEEP_TAIL + 2) return history;
  const ctxTokens = Number(config.contextTokens) || 4096;
  if (historyTokens(history) <= Math.floor(ctxTokens * 0.5)) return history;

  const head = history.slice(0, -KEEP_TAIL);
  const tail = history.slice(-KEEP_TAIL);
  const convo = head.map((m) => `${m.role}: ${m.content}`).join('\n');

  let summary;
  try {
    summary = await llmCall(
      [{ role: 'user', content: `Summarize this conversation compactly, preserving key facts, decisions, names, numbers, and any open threads. Be terse:\n\n${convo}` }],
      { temperature: 0.2, maxTokens: 400, timeoutMs: 60000 }
    );
  } catch {
    return history;
  }
  if (!summary || !summary.trim()) return history;
  return [{ role: 'system', content: `[Summary of earlier conversation]\n${summary.trim()}` }, ...tail];
}

module.exports = { maybeCompact };

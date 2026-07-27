'use strict';

// Context-window budgeting for the agent loop. A single request to the model is
// system prompt + tool schemas + conversation history + any tool results +
// room for the reply, and all of it must fit the model's context window
// (n_ctx). On small local models that's easy to blow — especially when a tool
// like deep_research feeds a long result back in. This trims each request to
// fit before it's sent.

const config = require('../config');

// Conservative estimate: biased to OVER-count tokens (a smaller chars/token
// than real English ~4) because dense tool-schema JSON runs closer to this, and
// under-counting risks a hard 400. Pair with a reply margin below.
const CHARS_PER_TOKEN = 3;

function estimateTokens(text) {
  return Math.ceil(String(text == null ? '' : text).length / CHARS_PER_TOKEN);
}

function messageTokens(m) {
  let n = 4; // per-message role/formatting overhead
  if (typeof m.content === 'string') n += estimateTokens(m.content);
  if (m.tool_calls) n += estimateTokens(JSON.stringify(m.tool_calls));
  if (m.name) n += 2;
  return n;
}

function messagesTokens(messages) {
  return messages.reduce((s, m) => s + messageTokens(m), 0);
}

function truncateToTokens(text, maxTokens) {
  const maxChars = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN));
  const s = String(text);
  return s.length <= maxChars ? s : s.slice(0, maxChars);
}

// Minimum room the prompt-fitter always leaves free for the model's reply.
// There's no fixed completion cap anymore — the reply auto-fills whatever
// context is left after the (fitted) prompt (see completionBudget). This floor
// just guarantees the prompt never grows so large that there's no room to
// answer at all.
function replyReserve(ctx) {
  return Math.max(1024, Math.floor(ctx * 0.3));
}

// The completion budget for a request: all context left after the fitted
// prompt + tool specs, minus a small safety margin. This is what lets a reply
// "use all that is possible" instead of a fixed max_tokens. Returns 0 when no
// context window is configured (caller then omits max_tokens entirely).
function completionBudget(messages, specs) {
  const ctx = Number(config.contextTokens) || 0;
  if (ctx <= 0) return 0;
  const specsTokens = specs && specs.length ? estimateTokens(JSON.stringify(specs)) : 0;
  const remaining = ctx - messagesTokens(messages) - specsTokens - 150;
  return Math.max(256, remaining);
}

/**
 * Return a copy of `messages` trimmed to fit the model's context window,
 * reserving room for the tool specs and the completion. It (1) truncates any
 * single oversized message — this is what tames a large tool result fed back in
 * — then (2) drops the oldest plain history messages, never touching the
 * system message, the final message, or a tool_call/tool cluster (breaking that
 * pairing errors the API).
 *
 * @param {{role:string, content?:string, tool_calls?:object[]}[]} messages
 * @param {object[]} [specs] tool schemas advertised this turn (counted, not sent here)
 */
function fitContext(messages, specs, reserveOverride) {
  const ctx = Number(config.contextTokens) || 0;
  if (ctx <= 0) return messages;

  const specsTokens = specs && specs.length ? estimateTokens(JSON.stringify(specs)) : 0;
  const completionReserve = reserveOverride != null ? reserveOverride : replyReserve(ctx);
  const budget = ctx - specsTokens - completionReserve;
  if (budget <= 0) return messages; // pathological (specs alone overflow); let the server report it
  if (messagesTokens(messages) <= budget) return messages;

  const msgs = messages.map((m) => ({ ...m }));

  // 1. Truncate any single message that alone eats too much of the budget.
  const perMsgCap = Math.floor(budget * 0.5);
  for (const m of msgs) {
    if (typeof m.content === 'string' && estimateTokens(m.content) > perMsgCap) {
      m.content = truncateToTokens(m.content, perMsgCap) + '\n\n[…truncated to fit the model context window…]';
    }
  }

  // 2. Drop oldest droppable history until it fits. Skip system[0], the final
  //    message, and any tool_call/tool cluster message.
  while (messagesTokens(msgs) > budget && msgs.length > 2) {
    let idx = 1;
    while (idx < msgs.length - 1 && (msgs[idx].role === 'tool' || msgs[idx].tool_calls)) idx++;
    if (idx >= msgs.length - 1) break; // nothing safe left to drop
    msgs.splice(idx, 1);
  }

  return msgs;
}

/**
 * Fit an entire request (messages + tool specs + reply reserve) into the
 * context window. First trims messages with the specs counted; if the
 * irreducible core still won't fit — which happens on small models where the
 * tool schemas alone eat much of the window — it drops the specs for this turn
 * (better to answer without offering tools than to 400) and re-fits.
 *
 * @returns {{ messages: object[], specs: object[], droppedSpecs: boolean }}
 */
function fitRequest(messages, specs) {
  const ctx = Number(config.contextTokens) || 0;
  if (ctx <= 0) return { messages, specs: specs || [], droppedSpecs: false };

  const completionReserve = replyReserve(ctx);
  const withSpecs = fitContext(messages, specs);
  const specsTokens = specs && specs.length ? estimateTokens(JSON.stringify(specs)) : 0;

  if (messagesTokens(withSpecs) + specsTokens + completionReserve <= ctx) {
    return { messages: withSpecs, specs: specs || [], droppedSpecs: false };
  }

  // Still over even after trimming — the specs are the thing that won't fit.
  // Drop them and re-fit messages against the freed budget.
  return { messages: fitContext(messages, []), specs: [], droppedSpecs: true };
}

module.exports = { fitContext, fitRequest, completionBudget, estimateTokens, messagesTokens };

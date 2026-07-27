'use strict';

// Non-streaming chat-completions helper for tools that need many discrete LLM
// calls (plan/query/extract/synthesize/stop/final in deep_research), as
// opposed to streamTurn.js which drives the single, streaming, tool-using
// conversational turn.

const config = require('../../config');

/**
 * Strip reasoning-model scaffolding from a completion so the real answer is
 * left. Handles both <think>…</think> blocks and OpenAI "harmony" channels
 * (gpt-oss et al.), where content may arrive as
 *   <|channel|>analysis<|message|>…reasoning…<|channel|>final<|message|>…answer…
 * We keep only the final channel's text, then remove any leftover control
 * tokens. If none of these markers are present this is a near no-op.
 */
function stripThinking(text) {
  let s = String(text || '');
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const finalMarker = '<|channel|>final<|message|>';
  const fi = s.lastIndexOf(finalMarker);
  if (fi !== -1) s = s.slice(fi + finalMarker.length);
  s = s.replace(/<\|[^|]*\|>/g, ''); // strip any remaining harmony control tokens
  return s.trim();
}

/** Strip a ```json ... ``` / ``` ... ``` fence if the whole string is wrapped in one. */
function stripCodeBlock(text) {
  const s = String(text || '').trim();
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1].trim() : s;
}

/**
 * Best-effort JSON array parse. Weak/reasoning local models rarely return a
 * bare array — they wrap it in prose, echo the prompt's example array, or get
 * truncated. Ported from odysseus's tolerant parser: try the whole string,
 * then extract/repair an embedded array, preferring the LAST valid one (the
 * model's real answer, not an echoed example). Always returns string items.
 */
function parseJsonArray(text) {
  const s = stripCodeBlock(text);
  const asStrings = (arr) => arr.filter((x) => x != null).map((x) => String(x)).filter((x) => x.trim());

  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return asStrings(parsed);
  } catch {}

  // Truncated array (an opening '[' with no matching ']'): harvest quoted strings.
  const lastStart = s.lastIndexOf('[');
  if (lastStart !== -1 && s.indexOf(']', lastStart) === -1) {
    const items = (s.slice(lastStart).match(/"([^"]*)"/g) || []).map((q) => q.slice(1, -1));
    if (items.length) return asStrings(items);
  }

  // Scan every complete [...] and keep the last that parses (skips echoed examples).
  let last = null;
  const re = /\[[\s\S]*?\]/g;
  let m;
  while ((m = re.exec(s))) {
    try {
      const parsed = JSON.parse(m[0]);
      if (Array.isArray(parsed)) last = parsed;
    } catch {}
  }
  if (last) return asStrings(last);

  // Last resort: harvest quoted strings from the first array start.
  const firstStart = s.indexOf('[');
  if (firstStart !== -1) {
    const items = (s.slice(firstStart).match(/"([^"]*)"/g) || []).map((q) => q.slice(1, -1));
    if (items.length) return asStrings(items);
  }
  return [];
}

/**
 * Best-effort JSON object parse: whole string, then the first embedded {...}.
 */
function parseJsonObject(text) {
  const s = stripCodeBlock(text);
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

// Conservative chars-per-token estimate. No real tokenizer is available
// without a dependency, and local models vary, so this deliberately
// undercounts capacity (real English averages ~4 chars/token; dense/technical
// text can run closer to 2-3) rather than risk overflowing a small context.
const CHARS_PER_TOKEN = 2.5;

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}

function charsForTokens(tokenBudget) {
  return Math.max(0, Math.floor(tokenBudget * CHARS_PER_TOKEN));
}

/** True if an error from llmCall looks like a "prompt exceeds context window" rejection. */
function isContextOverflow(err) {
  const msg = err && err.message ? err.message : String(err || '');
  return /exceed|too (?:long|large)/i.test(msg) && /context/i.test(msg);
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One attempt at a non-streaming chat-completions call. Throws on any failure. */
async function llmCallOnce(messages, { temperature, maxTokens, timeoutMs, signal }) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

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

  try {
    const res = await fetch(`${config.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: false,
        temperature,
        max_tokens: maxTokens
      })
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Server responded ${res.status} ${res.statusText}${detail ? ' — ' + detail.slice(0, 200) : ''}`
      );
    }
    const data = await res.json();
    const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    return stripThinking(text);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Non-streaming chat-completions call with retries. Local model servers under
 * load routinely drop or time out a request that succeeds on the next attempt —
 * odysseus retries 3× and that's a big reason it's more robust than a single
 * shot. We retry transient failures but NOT context-overflow (which won't get
 * better by retrying) or a user-triggered abort.
 * @param {{role:string, content:string}[]} messages
 * @param {{temperature?:number, maxTokens?:number, timeoutMs?:number, signal?:AbortSignal}} [opts]
 */
async function llmCall(messages, { temperature = 0.3, maxTokens = 2048, timeoutMs = 60000, signal } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (signal && signal.aborted) throw new Error('aborted');
    try {
      return await llmCallOnce(messages, { temperature, maxTokens, timeoutMs, signal });
    } catch (err) {
      lastErr = err;
      // Don't waste attempts on errors that won't change: context overflow, or
      // a deliberate user cancel.
      if (isContextOverflow(err) || (signal && signal.aborted)) throw err;
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastErr;
}

module.exports = {
  llmCall,
  stripThinking,
  stripCodeBlock,
  parseJsonArray,
  parseJsonObject,
  estimateTokens,
  charsForTokens,
  isContextOverflow
};

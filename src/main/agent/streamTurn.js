'use strict';

// One streaming model turn over an OpenAI-compatible /chat/completions endpoint.
// Splits the content stream into channels (reasoning / summary / details) via
// tags the model is asked to use, accumulates native tool_calls, AND keeps the
// raw (pre-channel-parse) content so the text-fallback tool parser can scan it
// when the model emits no native tool_calls.
//
//   <think>…</think>       -> thinking  (thought bubble)
//   <summary>…</summary>   -> summary   (speech bubble)
//   <details>…</details>   -> details   (detail window)
// Untagged text defaults to the summary channel, so non-compliant models still
// work (everything just shows in the bubble).

const config = require('../config');

// Appended to the system prompt so the model produces a summary + optional details.
const FORMAT_INSTRUCTIONS = [
  'Structure every reply like this:',
  '<summary>One or two short sentences that answer directly.</summary>',
  'When the question genuinely warrants depth (explanations, steps, examples, comparisons, code), also append:',
  '<details>',
  'A thorough, well-structured answer in markdown.',
  '</details>',
  'Omit the <details> block entirely for simple questions. Never mention these tags to the user.'
].join('\n');

// Stream parser: when state S is active, emitted text goes to channel CHANNEL[S].
// Scanning finds the earliest of ANY marker, so section order can vary.
const MARKERS = [
  { tag: '<think>', to: 'thinking' },
  { tag: '</think>', to: 'summary' },
  { tag: '<summary>', to: 'summary' },
  { tag: '</summary>', to: 'details' }, // text after the summary defaults to details
  { tag: '<details>', to: 'details' },
  { tag: '</details>', to: 'details' }
];
const CHANNEL = { thinking: 'thinking', summary: 'summary', details: 'details' };

// Longest suffix of `s` that is a prefix of `marker` — lets us hold back a
// partial tag split across stream chunks instead of leaking it.
function partialSuffix(s, marker) {
  const max = Math.min(s.length, marker.length - 1);
  for (let k = max; k > 0; k--) {
    if (marker.startsWith(s.slice(s.length - k))) return k;
  }
  return 0;
}

/**
 * Stream one model turn. Emits onEvent({type, text}) live for the
 * thinking/summary/details channels, and resolves with the turn's summary +
 * details text, the raw content, and any native tool calls it requested.
 *
 * @param {{role:string, content?:string}[]} messages
 * @param {(event:{type:string, text?:string}) => void} onEvent
 * @param {{ tools?: object[] }} [opts] tool specs to advertise this turn (omit/empty = none)
 * @returns {Promise<{summary:string, details:string, rawContent:string, toolCalls:object[]}>}
 */
async function streamTurn(messages, onEvent, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const body = {
    model: config.model,
    messages,
    stream: true,
    temperature: config.temperature,
    max_tokens: config.maxTokens
  };
  const specs = opts.tools || [];
  if (config.toolsEnabled && specs.length) {
    body.tools = specs;
    body.tool_choice = 'auto';
  }

  const res = await fetch(`${config.baseURL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `Server responded ${res.status} ${res.statusText}` +
        (detail ? ` — ${detail.slice(0, 200)}` : '')
    );
  }

  let summary = '';
  let details = '';
  let rawContent = ''; // every content delta, untouched — for the text-fallback parser
  let contentBuffer = '';
  let state = 'summary'; // untagged content -> summary (graceful fallback)
  const toolCalls = [];

  const emit = (channel, text) => {
    if (!text) return;
    if (channel === 'summary') summary += text;
    else if (channel === 'details') details += text;
    onEvent({ type: channel, text });
  };

  const feedContent = (text) => {
    contentBuffer += text;
    for (;;) {
      let at = -1;
      let marker = null;
      for (const m of MARKERS) {
        const idx = contentBuffer.indexOf(m.tag);
        if (idx !== -1 && (at === -1 || idx < at)) {
          at = idx;
          marker = m;
        }
      }
      if (marker) {
        emit(CHANNEL[state], contentBuffer.slice(0, at));
        state = marker.to;
        contentBuffer = contentBuffer.slice(at + marker.tag.length);
        continue;
      }
      let hold = 0;
      for (const m of MARKERS) hold = Math.max(hold, partialSuffix(contentBuffer, m.tag));
      if (contentBuffer.length > hold) {
        emit(CHANNEL[state], contentBuffer.slice(0, contentBuffer.length - hold));
        contentBuffer = contentBuffer.slice(contentBuffer.length - hold);
      }
      break;
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') {
        finished = true;
        break;
      }
      try {
        const choice = JSON.parse(data).choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};

        const reason = delta.reasoning_content ?? delta.reasoning;
        if (reason) emit('thinking', reason);
        if (delta.content) {
          rawContent += delta.content;
          feedContent(delta.content);
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const slot =
              toolCalls[idx] ||
              (toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } });
            if (tc.id) slot.id = tc.id;
            if (tc.type) slot.type = tc.type;
            if (tc.function?.name) slot.function.name += tc.function.name;
            if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
          }
        }
      } catch {
        // Ignore keep-alives and any non-JSON noise.
      }
    }
  }

  if (contentBuffer) emit(CHANNEL[state], contentBuffer);
  return { summary, details, rawContent, toolCalls: toolCalls.filter(Boolean) };
}

module.exports = { streamTurn, FORMAT_INSTRUCTIONS };

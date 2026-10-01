'use strict';

const config = require('../config');

const FORMAT_INSTRUCTIONS = [
  'Structure replies: <summary>one or two sentences</summary><details>thorough answer in markdown</details>',
  'Omit <details> for simple questions. Never mention these tags to the user.'
].join('\n');

const MARKERS = [
  { tag: '<think>', to: 'thinking' },
  { tag: '</think>', to: 'summary' },
  { tag: '<summary>', to: 'summary' },
  { tag: '</summary>', to: 'details' },
  { tag: '<details>', to: 'details' },
  { tag: '</details>', to: 'details' }
];
const CHANNEL = { thinking: 'thinking', summary: 'summary', details: 'details' };

/** Reply text without reasoning or channel tags, for replaying stored messages. */
function stripReplyTags(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\/summary>/g, '\n\n')
    .replace(/<\/?(?:summary|details)>/g, '')
    .trim();
}

function partialSuffix(s, marker) {
  const max = Math.min(s.length, marker.length - 1);
  for (let k = max; k > 0; k--) {
    if (marker.startsWith(s.slice(s.length - k))) return k;
  }
  return 0;
}

/**
 * Routes streamed model text into thinking/summary/details channels by the
 * <think>/<summary>/<details> tags, holding back partial tags split across chunks.
 */
function createTagRouter(emit) {
  let buffer = '';
  let state = 'summary';
  return {
    feed(text) {
      buffer += text;
      for (;;) {
        let at = -1;
        let marker = null;
        for (const m of MARKERS) {
          const idx = buffer.indexOf(m.tag);
          if (idx !== -1 && (at === -1 || idx < at)) {
            at = idx;
            marker = m;
          }
        }
        if (marker) {
          emit(CHANNEL[state], buffer.slice(0, at));
          state = marker.to;
          buffer = buffer.slice(at + marker.tag.length);
          continue;
        }
        let hold = 0;
        for (const m of MARKERS) hold = Math.max(hold, partialSuffix(buffer, m.tag));
        if (buffer.length > hold) {
          emit(CHANNEL[state], buffer.slice(0, buffer.length - hold));
          buffer = buffer.slice(buffer.length - hold);
        }
        break;
      }
    },
    flush() {
      if (buffer) emit(CHANNEL[state], buffer);
      buffer = '';
    }
  };
}

async function streamTurn(messages, onEvent, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const body = {
    model: config.model,
    messages,
    stream: true,
    temperature: config.temperature
  };
  if (opts.maxTokens && opts.maxTokens > 0) body.max_tokens = opts.maxTokens;
  const specs = opts.tools || [];
  if (config.toolsEnabled && specs.length) {
    body.tools = specs;
    body.tool_choice = 'auto';
  }

  const res = await fetch(`${config.baseURL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal
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
  let rawContent = '';
  const toolCalls = [];

  const emit = (channel, text) => {
    if (!text) return;
    if (channel === 'summary') summary += text;
    else if (channel === 'details') details += text;
    onEvent({ type: channel, text });
  };

  const router = createTagRouter(emit);

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
          router.feed(delta.content);
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
      }
    }
  }

  router.flush();
  return { summary, details, rawContent, toolCalls: toolCalls.filter(Boolean) };
}

module.exports = { streamTurn, createTagRouter, stripReplyTags, FORMAT_INSTRUCTIONS };

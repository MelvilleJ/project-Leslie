'use strict';

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

module.exports = { createTagRouter, stripReplyTags, FORMAT_INSTRUCTIONS };

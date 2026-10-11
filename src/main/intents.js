'use strict';

// Commands simple enough to act on without the model — reliable, and instant
// for voice. Anything that doesn't match exactly goes to the model as usual.

const VERB = '(?:switch|change|go|move|set|turn|use|enable|load|activate|start|put)';
const PROFILE_COMMAND = new RegExp(
  `^(?:${VERB}(?: yourself| it)?(?: back)?(?: (?:to|into|on))?(?: the)? )?(power|everyday|every day)(?: mode| model| profile)?(?: on| now)?$`
);

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/^(?:hey |ok |okay )?leslie\b[,.!]?\s*/, '')
    .replace(/[.!,]+/g, ' ')
    .replace(/\b(?:please|pls|can you|could you|would you)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 'power' | 'everyday' when `text` is just a command to switch model profile. */
function profileCommand(text) {
  if (/\?/.test(text)) return null;
  const m = PROFILE_COMMAND.exec(normalize(text));
  if (!m) return null;
  return m[1] === 'power' ? 'power' : 'everyday';
}

module.exports = { profileCommand, normalize };

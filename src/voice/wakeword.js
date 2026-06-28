'use strict';

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

const cleanToken = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');

function isNameToken(token, target) {
  if (!token) return false;
  if (token === target) return true;
  const tol = target.length >= 6 ? 2 : 1;
  return levenshtein(token, target) <= tol;
}

/**
 * Detect the wake phrase in a transcript.
 * @param {string} transcript
 * @param {string} wakeWord  e.g. "hey leslie"
 * @returns {{ matched: boolean, command: string }}
 *   command = any words spoken after the wake phrase in the same utterance.
 */
function detectWake(transcript, wakeWord = 'hey leslie') {
  const target = cleanToken(wakeWord.split(/\s+/).pop() || 'leslie');
  const words = String(transcript).trim().split(/\s+/).filter(Boolean);

  for (let i = 0; i < words.length; i++) {
    if (isNameToken(cleanToken(words[i]), target)) {
      return { matched: true, command: words.slice(i + 1).join(' ').trim() };
    }
  }
  return { matched: false, command: '' };
}

module.exports = { detectWake, levenshtein, isNameToken };

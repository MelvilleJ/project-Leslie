'use strict';

//    no tool call. Inject one sharp nudge to actually call it; capped.

const config = require('../config');

const INTENT_RE =
  /(?:^|\n)\s*(?:let me|i'?ll|i will|i need to|i should|i'?m going to|let's)\s+(?:check|look|search|find|run|open|read|fetch|investigate|see|try|use|install|launch|execute)\b[^.\n]{0,140}/i;

function sigOf(calls) {
  return calls
    .map((c) => `${c.name}:${String(c.arguments || '').trim().slice(0, 120)}`)
    .sort()
    .join('|');
}

function createGuards() {
  const recentSigs = [];
  const callFreq = new Map();
  let stuckRounds = 0;
  let intentNudges = 0;

  const stuckLimit = Math.max(1, Number(config.loopStuckRounds) || 4);
  const runawayLimit = Math.max(2, Number(config.loopRunawayLimit) || 15);
  const maxIntentNudges = Math.max(0, Number(config.maxIntentNudges) ?? 2);

  /**
   * Record a round that executed tool calls.
   * @returns {{forceAnswer:boolean, reason?:string}}
   */
  function recordToolRound(calls, hadAnswerText) {
    const sig = sigOf(calls);
    const isRepeat = recentSigs.includes(sig);
    recentSigs.push(sig);
    if (recentSigs.length > 6) recentSigs.shift();
    for (const c of calls) {
      const k = `${c.name}:${String(c.arguments || '').trim().slice(0, 120)}`;
      callFreq.set(k, (callFreq.get(k) || 0) + 1);
    }

    if (isRepeat && !hadAnswerText) stuckRounds += 1;
    else stuckRounds = 0;

    let runaway = null;
    for (const [k, n] of callFreq) {
      if (n >= runawayLimit) {
        runaway = k.split(':')[0];
        break;
      }
    }

    if (stuckRounds >= stuckLimit || runaway) {
      return {
        forceAnswer: true,
        reason: runaway
          ? `calling ${runaway} with identical arguments over and over`
          : 'repeating the same tool calls without new progress'
      };
    }
    return { forceAnswer: false };
  }

  /**
   * When a round produced NO tool calls, decide whether to nudge the model that
   * announced an action but didn't act. Returns the nudge text, or null.
   */
  function intentNudge(answerText) {
    const text = (answerText || '').trim();
    if (!text || text.length >= 400 || text.includes('```')) return null;
    if (intentNudges >= maxIntentNudges) return null;
    const m = INTENT_RE.exec(text);
    if (!m) return null;
    intentNudges += 1;
    return (
      `You just wrote: "${m[0].trim()}" — but ended the turn without making the ` +
      'actual tool call. Emit the actual tool call now, or, if you decided not to, ' +
      'say so plainly in one sentence instead of restating the plan.'
    );
  }

  return { recordToolRound, intentNudge };
}

/** Graceful text when a turn yields nothing visible and no tools ran. */
function emptyFallback() {
  return "Sorry — I didn't manage to get that. Could you rephrase or give me a bit more detail?";
}

module.exports = { createGuards, emptyFallback, INTENT_RE };

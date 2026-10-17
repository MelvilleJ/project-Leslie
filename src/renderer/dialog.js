'use strict';

// When a spoken exchange is over, and when her reply invites an answer.

(function (global) {
  const FILLER = /\b(?:ok(?:ay)?|alright|right|great|perfect|cool|awesome|nice|good|lovely|brilliant|leslie|sir|mate|so|well|yes|yeah|no|nope|oh)\b/g;
  const THANKS = /\b(?:thanks?(?: you)?(?: (?:so|very) much)?|thank u|ta|cheers|much appreciated|appreciate it)\b/g;
  const DONE = /\b(?:that'?s (?:all|it|enough|everything)|that is (?:all|it)|stop|cancel|never ?mind|forget it|i'?m (?:good|done|all set|fine)|all (?:good|done|set)|we'?re (?:done|good)|no more|nothing else|that'?ll be all|that will be all|dismissed|bye|goodbye|see you|later)\b/g;
  const POLITE = /\b(?:you'?re|youre) welcome\b/;

  function words(text) {
    return String(text || '').toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * The user is wrapping up ("thank you. that's all", "perfect, thanks leslie"),
   * not asking for anything: nothing but thanks, sign-offs and filler.
   */
  function isClosing(text) {
    const w = words(text);
    if (!w || POLITE.test(w)) return false;
    const hasClosing = THANKS.test(w) || DONE.test(w);
    THANKS.lastIndex = 0;
    DONE.lastIndex = 0;
    if (!hasClosing) return false;
    const rest = w.replace(THANKS, ' ').replace(DONE, ' ').replace(FILLER, ' ').replace(/\b(?:and|for (?:that|now|everything|your help|the help))\b/g, ' ').trim();
    return rest === '';
  }

  /** Her reply asks something back, so an answer without her name makes sense. */
  function invitesReply(reply) {
    const text = String(reply || '').replace(/```[\s\S]*?```/g, ' ').trim();
    if (!text) return false;
    const last = text.split(/(?<=[.!?])\s+/).filter(Boolean).pop() || '';
    return /\?["')\]]*$/.test(last.trim());
  }

  const api = { isClosing, invitesReply };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.dialog = api;
})(typeof window !== 'undefined' ? window : null);

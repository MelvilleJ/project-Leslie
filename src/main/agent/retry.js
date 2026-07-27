'use strict';

const config = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  const msg = err.message || String(err);
  if (/\b(4\d\d)\b/.test(msg) && !/\b(408|429)\b/.test(msg)) return false; // 4xx except timeout/rate-limit
  if (/exceed|context size|too (?:long|large)/i.test(msg)) return false; // won't improve on retry
  return true; // network/5xx/timeout/reset
}

/**
 * Run an async fn with retries on transient failures. `onRetry(attempt, err)`
 * is called before each wait (e.g. to surface a "retrying…" status).
 */
async function withRetry(fn, { onRetry } = {}) {
  const max = Math.max(1, Number(config.llmMaxRetries) || 2);
  const base = Math.max(100, Number(config.llmRetryDelayMs) || 600);
  let lastErr;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= max || !isRetryable(err)) throw err;
      if (onRetry) onRetry(attempt, err);
      await sleep(base * attempt);
    }
  }
  throw lastErr;
}

module.exports = { withRetry, isRetryable };

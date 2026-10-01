'use strict';

const REFRESH_TTL_MS = 30000;
const PROBE_TIMEOUT_MS = 3000;
// Only used until llama.cpp answers (or if it can't be reached).
const FALLBACK_TOKENS = 4096;

const KEYS = ['contextTokens', 'researchContextTokens'];

let detected = null;
let detectedFor = '';
let checkedAt = 0;
let inflight = null;

async function getJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

const positive = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null);

function argValue(args, flags) {
  const i = (args || []).findIndex((a) => flags.includes(a));
  return i >= 0 ? args[i + 1] : undefined;
}

// llama.cpp reports the n_ctx it actually loaded (not the model's training
// maximum). Router mode answers /props with n_ctx 0, so ask per model there.
const PROBES = [
  async (root, model, headers) => {
    const props = await getJson(`${root}/props?model=${encodeURIComponent(model)}`, headers);
    return positive(props.default_generation_settings && props.default_generation_settings.n_ctx);
  },
  async (root, model, headers) => {
    const data = (await getJson(`${root}/v1/models`, headers)).data || [];
    const entry = data.find((m) => m.id === model) || data.find((m) => m.meta && m.meta.n_ctx) || {};
    return (
      positive(entry.meta && entry.meta.n_ctx) ||
      positive(argValue(entry.status && entry.status.args, ['-c', '--ctx-size']))
    );
  }
];

async function detect() {
  const config = require('./config');
  const root = String(config.baseURL || '').replace(/\/+$/, '').replace(/\/v1$/, '');
  const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
  for (const probe of PROBES) {
    try {
      const n = await probe(root, config.model, headers);
      if (n) return n;
    } catch {
    }
  }
  return null;
}

/**
 * Re-read the llama.cpp server's context size (cached briefly). Safe to call
 * before every request; a model swap on the server is picked up within the TTL.
 */
function refresh({ force = false } = {}) {
  const config = require('./config');
  const target = `${config.baseURL}|${config.model}`;
  if (!force && target === detectedFor && Date.now() - checkedAt < REFRESH_TTL_MS) return Promise.resolve(detected);
  if (inflight) return inflight;
  inflight = detect()
    .then((n) => {
      if (n && n !== detected) console.log(`[leslie] llama.cpp context window: ${n} tokens`);
      if (!n) console.warn(`[leslie] could not read the context window from ${config.baseURL}; assuming ${FALLBACK_TOKENS}`);
      detected = n;
      detectedFor = target;
      checkedAt = Date.now();
      return n;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Expose the detected size as read-only config values every consumer already uses. */
function install(config) {
  for (const key of KEYS) {
    Object.defineProperty(config, key, {
      enumerable: true,
      get: () => detected || FALLBACK_TOKENS
    });
  }
}

module.exports = { install, refresh };

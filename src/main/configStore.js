'use strict';

const config = require('./config');
const settings = require('./settings');

const SCHEMA = [
  { key: 'baseURL', type: 'string', group: 'Connection', label: 'Server base URL',
    help: 'OpenAI-compatible endpoint, including the /v1 suffix.' },
  { key: 'model', type: 'string', group: 'Connection', label: 'Model',
    help: 'Model id. llama.cpp / LM Studio ignore this; vLLM / Ollama need the real id.' },
  { key: 'apiKey', type: 'password', group: 'Connection', label: 'API key',
    help: 'Usually blank for local servers.' },
  { key: 'searxngUrl', type: 'string', group: 'Connection', label: 'SearXNG URL',
    help: 'Backs the web_search tool. JSON output must be enabled in SearXNG.' },

  { key: 'systemPrompt', type: 'text', group: 'Generation', label: 'System prompt',
    help: "LESLIE's persona. Kept short — replies show in a small bubble." },
  { key: 'temperature', type: 'number', group: 'Generation', label: 'Temperature',
    min: 0, max: 2, step: 0.05 },
  { key: 'maxTokens', type: 'number', group: 'Generation', label: 'Max tokens',
    min: 16, max: 32768, step: 16 },
  { key: 'historyLimit', type: 'number', group: 'Generation', label: 'History messages kept',
    min: 0, max: 200, step: 2, help: 'How many past messages stay in context.' },

  { key: 'osTarget', type: 'select', group: 'Behaviour', label: 'Operating system',
    options: [
      { value: 'windows', label: 'Windows' },
      { value: 'linux', label: 'Linux' }
    ],
    help: 'Which OS tools target. Affects the shell, package manager, and command syntax.' },
  { key: 'linuxDistro', type: 'select', group: 'Behaviour', label: 'Linux distribution',
    options: [
      { value: 'debian', label: 'Debian / Ubuntu (apt)' },
      { value: 'fedora', label: 'Fedora (dnf)' },
      { value: 'arch', label: 'Arch Linux (pacman)' }
    ],
    dependsOn: { key: 'osTarget', value: 'linux' },
    help: 'Selects the package manager used by the install_software tool.' },

  { key: 'toolsEnabled', type: 'boolean', group: 'Behaviour', label: 'Enable tools',
    help: 'Web search, deep search, open URL, etc. Needs a tool-capable model.' },
  { key: 'maxToolCalls', type: 'number', group: 'Behaviour', label: 'Max tool calls per message',
    min: 0, max: 30, step: 1 },
  { key: 'detailedResponses', type: 'boolean', group: 'Behaviour', label: 'Detailed answers (side window)' },
  { key: 'detailSentenceThreshold', type: 'number', group: 'Behaviour',
    label: 'Sentences before moving to details', min: 1, max: 20, step: 1 },
  { key: 'learningMode', type: 'boolean', group: 'Behaviour', label: 'Learning mode',
    help: 'Remember durable preferences across sessions.' },
  { key: 'searchResults', type: 'number', group: 'Behaviour', label: 'Search results fed back',
    min: 1, max: 20, step: 1 },

  { key: 'voiceAutoSend', type: 'boolean', group: 'Voice', label: 'Auto-send dictated text' },
  { key: 'wakeWord', type: 'string', group: 'Voice', label: 'Wake word',
    help: 'Matching is fuzzy and keys on the last word.' }
];

const BY_KEY = new Map(SCHEMA.map((f) => [f.key, f]));

const VOICE_KEYS = SCHEMA.filter((f) => f.group === 'Voice').map((f) => f.key);

function coerce(field, value) {
  switch (field.type) {
    case 'number': {
      let n = Number(value);
      if (!Number.isFinite(n)) n = config[field.key];
      if (typeof field.min === 'number') n = Math.max(field.min, n);
      if (typeof field.max === 'number') n = Math.min(field.max, n);
      return n;
    }
    case 'boolean':
      return Boolean(value);
    case 'select': {
      const opts = (field.options || []).map((o) => o.value);
      const s = String(value ?? '');
      return opts.length && !opts.includes(s) ? opts[0] : s;
    }
    default:
      return String(value ?? '');
  }
}

/** The editable schema (plain data, safe to send over IPC). */
function schema() {
  return SCHEMA;
}

/** Current values of every editable field (for populating the form). */
function snapshot() {
  const out = {};
  for (const f of SCHEMA) out[f.key] = config[f.key];
  return out;
}

/**
 * Set one field: validate, coerce, apply to the live config, and persist.
 * @returns {{ ok: true, key: string, value: any } | { ok: false, error: string }}
 */
function set(key, value) {
  const field = BY_KEY.get(key);
  if (!field) return { ok: false, error: `Unknown setting: ${key}` };
  const v = coerce(field, value);
  config[key] = v;
  settings.set(`cfg.${key}`, v);
  return { ok: true, key, value: v };
}

/** Re-apply persisted overrides onto config at startup (over the .env defaults). */
function applyPersisted() {
  for (const f of SCHEMA) {
    const stored = settings.get(`cfg.${f.key}`, undefined);
    if (stored !== undefined) config[f.key] = coerce(f, stored);
  }
}

module.exports = { schema, snapshot, set, applyPersisted, VOICE_KEYS };

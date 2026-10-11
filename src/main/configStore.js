'use strict';

const config = require('./config');
const settings = require('./settings');
const { VOICES } = require('./tts/voices');

const SCHEMA = [
  { key: 'engine', type: 'select', group: 'Connection', label: 'Agent engine',
    options: [
      { value: 'pi', label: 'pi coding agent' },
      { value: 'native', label: 'LESLIE (built-in)' }
    ],
    help: 'pi adds sessions, compaction, retries, skills, extensions and every pi provider. Needs pi installed.' },
  { key: 'piModel', type: 'string', group: 'Connection', label: 'pi model',
    dependsOn: { key: 'engine', value: 'pi' },
    help: "Blank = pi's default model. 'leslie' = the server below. Or provider/model, e.g. llama.cpp/Qwen3." },
  { key: 'piCommand', type: 'string', group: 'Connection', label: 'pi command',
    dependsOn: { key: 'engine', value: 'pi' },
    help: 'Path to the pi executable if it is not on PATH.' },
  { key: 'piCwd', type: 'string', group: 'Connection', label: 'pi working folder',
    dependsOn: { key: 'engine', value: 'pi' },
    help: 'Where pi runs and stores sessions. Blank = your home folder.' },

  { key: 'serverManaged', type: 'boolean', group: 'Connection', label: 'LESLIE manages the model server',
    help: 'Runs llama.cpp for you (Settings → Models & GPUs) and uses it automatically. Turn off to use the URL and model below.' },
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
    min: 0, max: 2, step: 0.05, dependsOn: { key: 'engine', value: 'native' } },
  { key: 'historyLimit', type: 'number', group: 'Generation', label: 'History messages kept',
    min: 0, max: 200, step: 2, help: 'How many past messages stay in context.',
    dependsOn: { key: 'engine', value: 'native' } },

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

  { key: 'homeMonitor', type: 'string', group: 'Behaviour', label: 'Home display',
    help: 'Hyprland monitor LESLIE always appears on, pinned across its workspaces (e.g. HDMI-A-1). Blank = wherever she opens.' },
  { key: 'toolsEnabled', type: 'boolean', group: 'Behaviour', label: 'Enable tools',
    help: 'Web search, deep search, open URL, etc. Needs a tool-capable model.' },
  { key: 'maxToolCalls', type: 'number', group: 'Behaviour', label: 'Max tool calls per message',
    min: 0, max: 30, step: 1, dependsOn: { key: 'engine', value: 'native' } },
  { key: 'detailedResponses', type: 'boolean', group: 'Behaviour', label: 'Detailed answers (side window)' },
  { key: 'detailSentenceThreshold', type: 'number', group: 'Behaviour',
    label: 'Sentences before moving to details', min: 1, max: 20, step: 1 },
  { key: 'autoApprove', type: 'boolean', group: 'Behaviour', label: 'Auto mode',
    help: 'Run commands without asking unless they look destructive (deleting, overwriting, sudo, uninstalling, killing processes…).' },
  { key: 'learningMode', type: 'boolean', group: 'Behaviour', label: 'Learning mode',
    help: 'Remember durable preferences across sessions.' },
  { key: 'idleResetMinutes', type: 'number', group: 'Behaviour', label: 'Reset chat after idle (minutes)',
    min: 0, max: 1440, step: 5,
    help: 'Starts a fresh chat after this long without a message from you, in every mode. The old chat stays under Conversations, ready to resume. 0 = never.' },
  { key: 'searchResults', type: 'number', group: 'Behaviour', label: 'Search results fed back',
    min: 1, max: 20, step: 1 },

  { key: 'sttBackend', type: 'select', group: 'Voice', label: 'Speech recognition',
    options: [
      { value: 'server', label: 'Whisper server (large-v3-turbo on the GPU)' },
      { value: 'local', label: 'In-app Whisper (small model, CPU)' }
    ],
    help: 'The server is set up by scripts/setup-whisper.sh (leslie-whisper service).' },
  { key: 'sttServerUrl', type: 'string', group: 'Voice', label: 'Speech server URL',
    dependsOn: { key: 'sttBackend', value: 'server' },
    help: 'OpenAI-style endpoint, including /v1.' },
  { key: 'voiceAutoSend', type: 'boolean', group: 'Voice', label: 'Auto-send dictated text' },
  { key: 'wakeWord', type: 'string', group: 'Voice', label: 'Wake word',
    help: 'Matching is fuzzy and keys on the last word.' },

  { key: 'ttsEnabled', type: 'boolean', group: 'Speech', label: 'Speak replies',
    help: 'Reads replies aloud with Kokoro-82M on the CPU. Say "mute" / "unmute" to toggle.' },
  { key: 'ttsVoice', type: 'select', group: 'Speech', label: 'Voice',
    options: VOICES.map((v) => ({ value: v.id, label: v.label })),
    help: 'Grades are from the model card; A/B voices sound most natural.' },
  { key: 'ttsSpeed', type: 'number', group: 'Speech', label: 'Speaking speed',
    min: 0.5, max: 2, step: 0.1 }
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

function schema() {
  return SCHEMA;
}

function snapshot() {
  const out = {};
  for (const f of SCHEMA) out[f.key] = config[f.key];
  return out;
}

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

'use strict';

// Cloud models through pi without pi's own /login: LESLIE keeps the API key
// (sealed in the desktop keyring by configStore) and hands it to pi in the
// provider's environment variable, so pi's auth.json is never written.

const { execFile } = require('node:child_process');
const config = require('../config');

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic (Claude)', env: 'ANTHROPIC_API_KEY' },
  { id: 'openai', label: 'OpenAI', env: 'OPENAI_API_KEY' },
  { id: 'google', label: 'Google Gemini', env: 'GEMINI_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter', env: 'OPENROUTER_API_KEY' },
  { id: 'mistral', label: 'Mistral', env: 'MISTRAL_API_KEY' },
  { id: 'groq', label: 'Groq', env: 'GROQ_API_KEY' },
  { id: 'xai', label: 'xAI', env: 'XAI_API_KEY' },
  { id: 'deepseek', label: 'DeepSeek', env: 'DEEPSEEK_API_KEY' }
];

const provider = (id) => PROVIDERS.find((p) => p.id === id) || null;

/** The environment variable pi reads the configured key from, or {}. */
function envFor({ cloudProvider, cloudApiKey } = config) {
  const p = provider(cloudProvider);
  return p && cloudApiKey ? { [p.env]: cloudApiKey } : {};
}

/** `pi --list-models <provider>` with the key set: [{ id, context, images }]. pi lists its own catalog, so this doesn't prove the key works. */
function listModels(providerId, apiKey) {
  const p = provider(providerId);
  if (!p) return Promise.reject(new Error(`Unknown provider ${providerId}`));
  const pi = require('./launcher').resolve();
  return new Promise((resolve, reject) => {
    execFile(pi.command, [...pi.prefix, '--list-models', p.id], { env: { ...process.env, ...pi.env, [p.env]: apiKey }, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split('\n').pop()));
      const rows = String(stdout).split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((cols) => cols[0] === p.id && cols[1]);
      resolve(rows.map(([, id, context, , , images]) => ({ id, context, images: images === 'yes' })));
    });
  });
}

module.exports = { PROVIDERS, provider, envFor, listModels };

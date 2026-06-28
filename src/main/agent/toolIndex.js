'use strict';

const config = require('../config');

const ALWAYS_AVAILABLE = new Set([]);

const KEYWORD_HINTS = [
  [['search', 'find', 'look up', 'lookup', 'google', 'news', 'latest', 'who is', 'what is', 'when', 'where'], ['web_search']],
  [['research', 'compare', 'comparison', 'in depth', 'in-depth', 'detailed', 'sources', 'how to', 'how do'], ['deep_search']],
  [['open', 'show', 'visit', 'go to', 'website', 'url', 'webpage', 'page', '.com', '.org', 'http'], ['open_url']],
  [['browse', 'search results', 'see results', 'look something up'], ['open_search']],
  [['launch', 'open app', 'start program', 'run app', 'calculator', 'notepad', 'browser', 'spotify', 'app'], ['open_app']],
  [['run', 'execute', 'command', 'powershell', 'terminal', 'shell', 'mkdir', 'move file', 'delete', 'folder', 'script'], ['run_command']],
  [['install', 'winget', 'download app', 'get app', 'set up', 'uninstall'], ['install_software']],
  [
    ['document', 'word', 'docx', 'pdf', 'spreadsheet', 'excel', 'xlsx', 'csv', 'report', 'letter', 'resume', 'cv', 'write a', 'create a doc', 'save as', 'export', 'make a file'],
    ['create_document']
  ]
];

function keywordSelect(query, tools) {
  const ql = (query || '').toLowerCase();
  const picked = new Set(ALWAYS_AVAILABLE);
  for (const [keywords, names] of KEYWORD_HINTS) {
    if (keywords.some((kw) => ql.includes(kw))) names.forEach((n) => picked.add(n));
  }
  const available = new Set(tools.map((t) => t.name));
  const result = [...picked].filter((n) => available.has(n));
  return result.length ? result : tools.map((t) => t.name);
}

let _extractor = null;
let _extractorPromise = null;
let _toolVecs = null;
let _toolVecsKey = '';

async function getExtractor() {
  if (_extractor) return _extractor;
  if (!_extractorPromise) {
    _extractorPromise = (async () => {
      const { pipeline } = require('@huggingface/transformers');
      _extractor = await pipeline('feature-extraction', config.toolRagModel);
      return _extractor;
    })();
  }
  return _extractorPromise;
}

async function embed(text) {
  const extractor = await getExtractor();
  const out = await extractor(text, { pooling: 'mean', normalize: true });
  return out.data;
}

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

async function ensureToolVecs(tools) {
  const key = tools.map((t) => t.name).sort().join(',');
  if (_toolVecs && _toolVecsKey === key) return;
  const vecs = new Map();
  for (const t of tools) {
    vecs.set(t.name, await embed(`${t.name}: ${t.description || ''}`));
  }
  _toolVecs = vecs;
  _toolVecsKey = key;
}

async function embeddingSelect(query, tools) {
  await ensureToolVecs(tools);
  const qv = await embed(query || '');
  const topK = Math.max(1, Number(config.toolRagTopK) || 4);
  const scored = tools
    .map((t) => ({ name: t.name, score: dot(qv, _toolVecs.get(t.name)) }))
    .sort((a, b) => b.score - a.score);
  const picked = new Set(ALWAYS_AVAILABLE);
  scored.slice(0, topK).forEach((s) => picked.add(s.name));
  const available = new Set(tools.map((t) => t.name));
  const result = [...picked].filter((n) => available.has(n));
  return result.length ? result : tools.map((t) => t.name);
}

/**
 * Select the relevant tool names for a query.
 * @param {string} query the user's latest message
 * @param {{name:string, description?:string}[]} tools the active tool metadata
 * @returns {Promise<string[]>} selected tool names
 */
async function selectTools(query, tools) {
  if (!config.toolRag || !tools.length) return tools.map((t) => t.name);
  if (config.toolRagEmbeddings) {
    try {
      return await embeddingSelect(query, tools);
    } catch (err) {
      console.warn('[toolRag] embedding select failed, using keywords:', err && err.message);
    }
  }
  return keywordSelect(query, tools);
}

module.exports = { selectTools, keywordSelect, ALWAYS_AVAILABLE, KEYWORD_HINTS };

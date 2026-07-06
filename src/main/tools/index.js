'use strict';

const config = require('../config');

const webSearch = require('./webSearch');
const deepSearch = require('./deepSearch');
const openUrl = require('./openUrl');
const openSearch = require('./openSearch');
const openApp = require('./openApp');
const remember = require('./remember');
const createDocument = require('./createDocument');
const runCommand = require('./runCommand');
const installSoftware = require('./installSoftware');
const listDirectory = require('./listDirectory');
const readFile = require('./readFile');
const readDocument = require('./readDocument');

const base = [webSearch, deepSearch, openUrl, openSearch, openApp, createDocument];
const agentTools = [runCommand, installSoftware];
// Read-only filesystem tools. OS-aware, non-destructive, so they're available in
// every mode (including plan mode's read-only investigation), gated only by the
// fsReadEnabled switch. read_document extracts text from Word/PDF/Excel/etc.
const fsTools = [listDirectory, readFile, readDocument];

function active() {
  const list = config.agentMode ? [...base, ...agentTools] : [...base];
  if (config.fsReadEnabled) list.push(...fsTools);
  if (config.learningMode) list.push(remember);
  return list;
}

/**
 * OpenAI-format tool specs to send to the model. An optional `filter` (array or
 * Set of names) narrows the list — used by the agent's tool-RAG selection so
 * only the relevant subset is advertised each turn. Omit for all active tools.
 */
function specs(filter) {
  const allow = filter ? new Set(filter) : null;
  return active()
    .filter((t) => !allow || allow.has(t.name))
    .map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
}

/**
 * Lightweight metadata for the active tools — name, description, and the
 * read-only flag the policy layer uses for plan-mode gating.
 */
function list() {
  return active().map((t) => ({
    name: t.name,
    description: t.description,
    readOnly: Boolean(t.readOnly)
  }));
}

/** Execute a tool by name with parsed args; resolves to its result. */
async function run(name, args, ctx) {
  const tool = active().find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(args || {}, ctx);
}

module.exports = { specs, list, run, names: () => active().map((t) => t.name) };

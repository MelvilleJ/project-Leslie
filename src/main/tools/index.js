'use strict';

// Tool registry. Add a tool by writing a module that exports
// { name, description, parameters, run(args, ctx) } and listing it here.
// `ctx` lets a tool drive the UI (e.g. ctx.openUrl to show a page in the window).

const config = require('../config');

const webSearch = require('./webSearch');
const deepSearch = require('./deepSearch');
const openUrl = require('./openUrl');
const openSearch = require('./openSearch');
const openApp = require('./openApp');
const remember = require('./remember');
const createDocument = require('./createDocument');
// Agent-mode tools execute shell commands — only loaded when explicitly enabled.
const runCommand = require('./runCommand');
const installSoftware = require('./installSoftware');

const base = [webSearch, deepSearch, openUrl, openSearch, openApp, createDocument];
// Shell-executing tools, gated behind agent mode (toggleable at runtime).
const agentTools = [runCommand, installSoftware];

// The currently-active tools, recomputed each call so a runtime toggle
// (config.agentMode / config.learningMode) takes effect immediately — no restart
// needed. `remember` is only offered while learning mode is on.
function active() {
  const list = config.agentMode ? [...base, ...agentTools] : [...base];
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

'use strict';

const config = require('../config');

const webSearch = require('./webSearch');
const deepSearch = require('./deepSearch');
const deepResearch = require('./deepResearch');
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
const writeFile = require('./writeFile');
const task = require('./task');
const setMode = require('./setMode');
const screenRecord = require('./screenRecord');
const screenshot = require('./screenshot');
const closeApp = require('./closeApp');
const modelProfile = require('./modelProfile');
const speech = require('./speech');

const base = [webSearch, deepSearch, deepResearch, openUrl, openSearch, openApp, closeApp, createDocument, task, setMode, modelProfile, screenRecord, screenshot, speech];
const agentTools = [runCommand, installSoftware];
const fsTools = [listDirectory, readFile, readDocument];

function active() {
  const list = config.agentMode ? [...base, ...agentTools] : [...base];
  if (config.fsReadEnabled) list.push(...fsTools);
  if (config.agentMode && config.fsWriteEnabled) list.push(writeFile);
  if (config.learningMode) list.push(remember);
  return list;
}

function specs(filter) {
  const allow = filter ? new Set(filter) : null;
  return active()
    .filter((t) => !allow || allow.has(t.name))
    .map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
}

function list() {
  return active().map((t) => ({
    name: t.name,
    description: t.description,
    readOnly: Boolean(t.readOnly),
    selfGates: Boolean(t.selfGates),
    required: (t.parameters && t.parameters.required) || []
  }));
}

async function run(name, args, ctx) {
  const tool = active().find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(args || {}, ctx);
}

/** Every tool regardless of mode, for configuring shortcuts. */
function catalog() {
  return [...base, ...agentTools, ...fsTools, writeFile, remember].map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters || { type: 'object', properties: {} }
  }));
}

module.exports = { specs, list, run, catalog, names: () => active().map((t) => t.name) };

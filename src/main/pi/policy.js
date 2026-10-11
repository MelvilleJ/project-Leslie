'use strict';

const os = require('node:os');
const config = require('../config');

// Leslie tools pi has no equivalent for. run_command, list_directory, read_file,
// write_file and task are covered by pi's bash, ls/find, read, write/edit and
// subagent extensions, so they are not bridged.
const BRIDGED = {
  web_search: require('../tools/webSearch'),
  deep_search: require('../tools/deepSearch'),
  deep_research: require('../tools/deepResearch'),
  open_url: require('../tools/openUrl'),
  open_search: require('../tools/openSearch'),
  open_app: require('../tools/openApp'),
  close_app: require('../tools/closeApp'),
  create_document: require('../tools/createDocument'),
  read_document: require('../tools/readDocument'),
  remember: require('../tools/remember'),
  install_software: require('../tools/installSoftware'),
  set_mode: require('../tools/setMode'),
  model_profile: require('../tools/modelProfile'),
  screen_record: require('../tools/screenRecord'),
  screenshot: require('../tools/screenshot'),
  speech: require('../tools/speech')
};

const PI_READ_TOOLS = ['read', 'grep', 'find', 'ls'];
const PI_WRITE_TOOLS = ['bash', 'edit', 'write'];

function cwd() {
  return config.piCwd || os.homedir();
}

function bridgedAllowed() {
  if (!config.toolsEnabled) return [];
  return Object.values(BRIDGED)
    .filter((t) => {
      if (t.name === 'install_software') return config.agentMode;
      if (t.name === 'read_document') return config.fsReadEnabled;
      if (t.name === 'remember') return config.learningMode;
      return true;
    })
    .filter((t) => !config.planMode || t.readOnly)
    .map((t) => t.name);
}

function piAllowed() {
  if (!config.toolsEnabled) return [];
  const list = config.fsReadEnabled || config.agentMode ? [...PI_READ_TOOLS] : [];
  if (config.agentMode && !config.planMode) list.push(...PI_WRITE_TOOLS);
  return list;
}

/** Tools Leslie manages in pi, and the subset the current mode allows. */
function toolSelection() {
  return {
    managedTools: [...PI_READ_TOOLS, ...PI_WRITE_TOOLS, ...Object.keys(BRIDGED)],
    activeTools: [...piAllowed(), ...bridgedAllowed()]
  };
}

function bridgedTool(name) {
  return bridgedAllowed().includes(name) ? BRIDGED[name] : null;
}

/** Specs for every bridged tool; the extension registers all, the mode picks the active ones. */
function bridgedSpecs() {
  return Object.values(BRIDGED).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters || { type: 'object', properties: {} },
    readOnly: Boolean(t.readOnly)
  }));
}

module.exports = { cwd, toolSelection, bridgedTool, bridgedSpecs };

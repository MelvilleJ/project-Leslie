'use strict';

// setup-state.json: the choices made and each task's outcome, so closing the
// window or rebooting mid-setup resumes instead of starting over.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');

const file = () => path.join(paths.CONFIG, 'setup-state.json');

const fresh = () => ({ version: 1, choices: {}, tasks: {}, finished: false });

function load() {
  try {
    return { ...fresh(), ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    return null;
  }
}

function save(state) {
  fs.mkdirSync(paths.CONFIG, { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file());
  return state;
}

function update(patch) {
  return save({ ...(load() || fresh()), ...patch });
}

function setTask(id, outcome) {
  const state = load() || fresh();
  state.tasks[id] = { ...outcome, at: new Date().toISOString() };
  return save(state);
}

/** Setup has never run, or was left part-way. */
const needed = () => {
  const state = load();
  return !state || !state.finished;
};

module.exports = { file, fresh, load, save, update, setTask, needed };

'use strict';

// Which pi to run: the configured command, else a pi on PATH (the user's own,
// kept current with `pi update`), else the copy bundled with LESLIE at the
// version her extension is tested against.

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { which } = require('../setup/exec');

const BUNDLED_CLI = path.join(__dirname, '..', '..', '..', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');

/** { command, prefix: arguments before pi's own, env, label } */
function resolve() {
  if (config.piCommand) return { command: config.piCommand, prefix: [], env: {}, label: config.piCommand };
  const onPath = which('pi');
  if (onPath) return { command: onPath, prefix: [], env: {}, label: onPath };
  if (fs.existsSync(BUNDLED_CLI)) {
    return { command: process.execPath, prefix: [path.join(__dirname, 'bundled.js'), BUNDLED_CLI], env: { ELECTRON_RUN_AS_NODE: '1' }, label: 'the bundled pi' };
  }
  return { command: 'pi', prefix: [], env: {}, label: 'pi' };
}

module.exports = { resolve, BUNDLED_CLI };

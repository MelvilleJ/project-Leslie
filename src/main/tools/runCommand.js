'use strict';

const { gate, execShell } = require('./lib/agentShell');
const config = require('../config');

module.exports = {
  name: 'run_command',
  get description() {
    const shell = config.osTarget === 'linux' ? 'bash' : 'PowerShell';
    return (
      `Run a shell command on the user's computer (${shell}). Use for system tasks the ` +
      'user asks for — creating folders, moving files, running programs, managing packages, ' +
      'etc. Safe/known commands run immediately; anything else asks the user to approve first. ' +
      'Always pass a clear explanation of what the command does.'
    );
  },
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The exact command line to run, e.g. "mkdir C:\\\\Users\\\\me\\\\Desktop\\\\notes".'
      },
      explanation: {
        type: 'string',
        description: 'A short, plain-language description of what this command does, for the user.'
      }
    },
    required: ['command']
  },
  async run({ command, explanation }, ctx) {
    if (!command || !String(command).trim()) throw new Error('command is required');
    const cmd = String(command).trim();

    const approved = await gate(cmd, ctx, explanation ? String(explanation) : undefined);
    if (!approved) return { command: cmd, cancelled: true, output: 'User declined to run the command.' };

    const { exitCode, output } = await execShell(cmd);
    return { command: cmd, exitCode, output };
  }
};

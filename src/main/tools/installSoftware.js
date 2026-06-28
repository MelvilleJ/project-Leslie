'use strict';

// install_software — agent-mode convenience wrapper around winget. Builds a
// well-formed `winget install` line (which is allowlisted, so it runs without a
// prompt by default) and reports the result. Only registered when
// LESLIE_AGENT_MODE=1 (see tools/index.js).

const { gate, execShell } = require('./lib/agentShell');

// Quote a value for a PowerShell argument (wrap in single quotes, escape any).
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

module.exports = {
  name: 'install_software',
  description:
    'Install an application on the user\'s computer via the Windows Package Manager (winget). ' +
    'Provide the package name (e.g. "Spotify") and/or its exact winget id (e.g. "Spotify.Spotify"). ' +
    'Prefer the id when you know it, since names can be ambiguous.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The application name, e.g. "Spotify" or "Visual Studio Code".' },
      id: { type: 'string', description: 'The exact winget package id, e.g. "Spotify.Spotify". Optional.' }
    }
  },
  async run({ name, id }, ctx) {
    const hasName = name && String(name).trim();
    const hasId = id && String(id).trim();
    if (!hasName && !hasId) throw new Error('name or id is required');

    const selector = hasId
      ? `--id ${psQuote(String(id).trim())}`
      : `--name ${psQuote(String(name).trim())}`;
    const command =
      `winget install -e ${selector} ` +
      '--accept-package-agreements --accept-source-agreements --disable-interactivity';

    const label = hasId ? String(id).trim() : String(name).trim();
    const approved = await gate(command, ctx, `Install "${label}" with winget.`);
    if (!approved) return { command, cancelled: true, output: 'User declined the installation.' };

    const { exitCode, output } = await execShell(command);
    return { command, exitCode, output };
  }
};

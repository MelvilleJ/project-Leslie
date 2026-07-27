'use strict';

const { gate, execShell } = require('./lib/agentShell');
const config = require('../config');

function getPkgManager() {
  if (config.osTarget !== 'linux') return { type: 'winget' };
  switch (config.linuxDistro) {
    case 'fedora': return { type: 'dnf' };
    case 'arch': return { type: 'pacman' };
    default: return { type: 'apt' };
  }
}

function buildCommand(pkg, { type }) {
  const name = pkg.trim();
  switch (type) {
    case 'dnf': return `dnf install -y ${name}`;
    case 'pacman': return `pacman -S --noconfirm ${name}`;
    case 'apt': return `apt-get install -y ${name}`;
    default: {
      const psQuote = (v) => `'${v.replace(/'/g, "''")}'`;
      return (
        `winget install -e --name ${psQuote(name)} ` +
        '--accept-package-agreements --accept-source-agreements --disable-interactivity'
      );
    }
  }
}

module.exports = {
  name: 'install_software',
  selfGates: true,
  get description() {
    if (config.osTarget === 'linux') {
      const mgr = { debian: 'apt', fedora: 'dnf', arch: 'pacman' }[config.linuxDistro] || 'apt';
      return (
        `Install an application on the user's Linux system using ${mgr}. ` +
        'Provide the package name as it appears in the distro repository.'
      );
    }
    return (
      "Install an application on the user's computer via the Windows Package Manager (winget). " +
      'Provide the package name (e.g. "Spotify") and/or its exact winget id (e.g. "Spotify.Spotify"). ' +
      'Prefer the id when you know it, since names can be ambiguous.'
    );
  },
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'The package or application name, e.g. "spotify", "Spotify.Spotify" (winget), "git" (apt/dnf/pacman).'
      },
      id: {
        type: 'string',
        description: 'The exact winget package id (Windows only), e.g. "Spotify.Spotify". Optional.'
      }
    }
  },
  async run({ name, id }, ctx) {
    const pm = getPkgManager();
    const hasName = name && String(name).trim();
    const hasId = id && String(id).trim();
    if (!hasName && !hasId) throw new Error('name or id is required');

    let command;
    if (pm.type === 'winget') {
      const psQuote = (v) => `'${String(v).replace(/'/g, "''")}'`;
      const selector = hasId
        ? `--id ${psQuote(String(id).trim())}`
        : `--name ${psQuote(String(name).trim())}`;
      command =
        `winget install -e ${selector} ` +
        '--accept-package-agreements --accept-source-agreements --disable-interactivity';
    } else {
      const pkg = (hasId ? String(id) : String(name)).trim();
      command = buildCommand(pkg, pm);
    }

    const label = (hasId ? String(id) : String(name)).trim();
    const approved = await gate(command, ctx, `Install "${label}" via ${pm.type}.`);
    if (!approved) return { command, cancelled: true, output: 'User declined the installation.' };

    const { exitCode, output } = await execShell(command);
    return { command, exitCode, output };
  }
};

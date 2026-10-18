'use strict';

// The launcher entries and icons for a copy of LESLIE that was unpacked by hand
// (the tarball). The AUR package installs its own system-wide.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const { run } = require('./exec');

const SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 512];
const ENTRY = 'leslie.desktop';

function entry(exec) {
  return `[Desktop Entry]
Type=Application
Name=LESLIE
Comment=Desktop AI companion
Exec=${exec}
Icon=leslie
Categories=Utility;
StartupWMClass=project-leslie
`;
}

async function installLauncher(exec, iconsDir = path.join(paths.RESOURCES, 'assets', 'icons')) {
  for (const size of SIZES) {
    const src = path.join(iconsDir, `leslie-${size}.png`);
    if (!fs.existsSync(src)) continue;
    const dir = path.join(paths.ICONS, `${size}x${size}`, 'apps');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, path.join(dir, 'leslie.png'));
  }
  fs.mkdirSync(paths.APPS, { recursive: true });
  fs.writeFileSync(path.join(paths.APPS, ENTRY), entry(exec));
  await run('gtk-update-icon-cache', ['-q', paths.ICONS]);
  await run('update-desktop-database', ['-q', paths.APPS]);
}

function removeLauncher() {
  fs.rmSync(path.join(paths.APPS, ENTRY), { force: true });
  for (const size of SIZES) fs.rmSync(path.join(paths.ICONS, `${size}x${size}`, 'apps', 'leslie.png'), { force: true });
}

const hasSystemLauncher = () => ['/usr/share/applications/leslie.desktop'].some((f) => fs.existsSync(f));

module.exports = { entry, installLauncher, removeLauncher, hasSystemLauncher };

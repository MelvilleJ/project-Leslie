'use strict';

// Desktop programs LESLIE's tools call, the features that need them, and how
// each distro packages them. Missing ones are installed in one pkexec call.

const fs = require('node:fs');
const { which, must } = require('./exec');

const same = (name) => ({ arch: name, debian: name, fedora: name, suse: name });

const TOOLS = [
  { bin: 'grim', feature: 'Screenshots', pkg: same('grim') },
  { bin: 'slurp', feature: 'Screenshots of a region', pkg: same('slurp') },
  { bin: 'wf-recorder', feature: 'Screen recording', pkg: same('wf-recorder') },
  { bin: 'playerctl', feature: 'Media control', pkg: same('playerctl') },
  { bin: 'mpv', feature: 'Playing videos', pkg: same('mpv') },
  { bin: 'yt-dlp', feature: 'Playing online videos', pkg: same('yt-dlp') },
  { bin: 'wl-copy', feature: 'Copying to the clipboard', pkg: same('wl-clipboard') },
  { bin: 'pactl', feature: 'Recording desktop audio', pkg: { arch: 'libpulse', debian: 'pulseaudio-utils', fedora: 'pulseaudio-utils', suse: 'pulseaudio-utils' } },
  { bin: 'v4l2-ctl', feature: 'Camera exposure control', pkg: same('v4l-utils') },
  { bin: 'curl', feature: 'Starting background services', pkg: same('curl') }
];

// The Vulkan engine needs the loader and a driver for each GPU vendor.
const VULKAN = {
  loader: { arch: 'vulkan-icd-loader', debian: 'libvulkan1', fedora: 'vulkan-loader', suse: 'libvulkan1' },
  amd: { arch: 'vulkan-radeon', debian: 'mesa-vulkan-drivers', fedora: 'mesa-vulkan-drivers', suse: 'libvulkan_radeon' },
  intel: { arch: 'vulkan-intel', debian: 'mesa-vulkan-drivers', fedora: 'mesa-vulkan-drivers', suse: 'libvulkan_intel' }
};

function parseOsRelease(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}

/** arch, debian, fedora or suse, from /etc/os-release; null when unknown. */
function family(osRelease) {
  const ids = [osRelease.ID, ...(osRelease.ID_LIKE || '').split(/\s+/)].filter(Boolean);
  for (const id of ids) {
    if (['arch', 'manjaro', 'endeavouros', 'cachyos'].includes(id)) return 'arch';
    if (['debian', 'ubuntu', 'linuxmint', 'pop'].includes(id)) return 'debian';
    if (['fedora', 'rhel', 'centos'].includes(id)) return 'fedora';
    if (id.startsWith('opensuse') || id === 'suse') return 'suse';
  }
  return null;
}

function distro() {
  try {
    return family(parseOsRelease(fs.readFileSync('/etc/os-release', 'utf8')));
  } catch {
    return null;
  }
}

const missingTools = () => TOOLS.filter((t) => !which(t.bin));

function installCommand(fam, pkgs) {
  switch (fam) {
    case 'arch': return ['pacman', '-S', '--needed', '--noconfirm', ...pkgs];
    case 'debian': return ['apt-get', 'install', '-y', ...pkgs];
    case 'fedora': return ['dnf', 'install', '-y', ...pkgs];
    case 'suse': return ['zypper', '--non-interactive', 'install', ...pkgs];
    default: return null;
  }
}

/** One polkit password prompt for every package. */
async function install(pkgs, fam = distro()) {
  const cmd = installCommand(fam, [...new Set(pkgs)]);
  if (!cmd) throw new Error('This Linux distribution is not recognised; install the packages with its package manager.');
  if (!which('pkexec')) throw new Error(`pkexec is missing; run this in a terminal: sudo ${cmd.join(' ')}`);
  await must('pkexec', cmd, { timeout: 30 * 60000 });
}

module.exports = { TOOLS, VULKAN, parseOsRelease, family, distro, missingTools, installCommand, install };

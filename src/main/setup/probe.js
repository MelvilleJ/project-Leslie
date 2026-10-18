'use strict';

// The system check on the first setup screen, and the existing-install
// detection behind "Keep my current setup".

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const paths = require('./paths');
const packages = require('./packages');
const units = require('./units');
const { run, which } = require('./exec');

const GB = 1024 ** 3;

function freeBytes(dir) {
  let probe = dir;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const s = fs.statfsSync(probe);
  return s.bavail * s.bsize;
}

function hasVulkanLoader() {
  return ['/usr/lib/libvulkan.so.1', '/usr/lib64/libvulkan.so.1', '/usr/lib/x86_64-linux-gnu/libvulkan.so.1'].some((f) => fs.existsSync(f));
}

function vulkanDrivers() {
  const dirs = ['/usr/share/vulkan/icd.d', '/etc/vulkan/icd.d'];
  return dirs.flatMap((d) => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  });
}

/**
 * Each check: { id, label, status: 'ok' | 'missing' | 'warn', required, detail, packages? }.
 * gpus come from hardware.detectGpus so the Vulkan checks match the hardware.
 */
async function systemChecks({ gpus = [], neededBytes = 0 } = {}) {
  const fam = packages.distro();
  const checks = [];
  const add = (c) => checks.push({ required: false, ...c });

  const sd = await run('systemctl', ['--user', 'is-system-running']);
  const sdState = sd.stdout.trim();
  add({ id: 'systemd', label: 'systemd user services', required: true,
    status: ['running', 'degraded', 'starting'].includes(sdState) ? 'ok' : 'missing',
    detail: sdState === 'degraded' ? 'running (some unrelated units failed)' : sdState || 'not available' });

  const session = process.env.XDG_SESSION_TYPE || (process.env.WAYLAND_DISPLAY ? 'wayland' : process.env.DISPLAY ? 'x11' : '');
  add({ id: 'session', label: 'Desktop session', status: session ? 'ok' : 'warn',
    detail: [session || 'unknown', process.env.HYPRLAND_INSTANCE_SIGNATURE ? 'Hyprland' : ''].filter(Boolean).join(', ') });

  const pw = await run('systemctl', ['--user', 'is-active', 'pipewire.service']);
  add({ id: 'pipewire', label: 'PipeWire audio', status: pw.stdout.trim() === 'active' ? 'ok' : 'warn',
    detail: pw.stdout.trim() === 'active' ? 'running' : 'not running: voice may not work' });

  const sources = await run('pactl', ['list', 'short', 'sources']);
  const mics = sources.stdout.split('\n').filter((l) => l.trim() && !l.includes('.monitor'));
  add({ id: 'mic', label: 'Microphone', status: mics.length ? 'ok' : 'warn',
    detail: mics.length ? `${mics.length} found` : 'none found: voice is optional' });

  let cameras = [];
  try {
    cameras = fs.readdirSync('/dev/v4l/by-id').filter((d) => d.endsWith('index0'));
  } catch {
  }
  add({ id: 'camera', label: 'Camera', status: cameras.length ? 'ok' : 'warn',
    detail: cameras.length ? `${cameras.length} found` : 'none found: the camera is optional' });

  const free = freeBytes(paths.DATA);
  add({ id: 'disk', label: 'Free disk space', required: true,
    status: free > neededBytes + 2 * GB ? 'ok' : 'missing',
    detail: `${(free / GB).toFixed(0)} GB free${neededBytes ? `, about ${Math.ceil(neededBytes / GB)} GB needed` : ''}` });

  const ram = os.totalmem();
  add({ id: 'ram', label: 'Memory', status: ram >= 8 * GB ? 'ok' : 'warn', detail: `${Math.round(ram / GB)} GB` });

  const needsVulkan = gpus.some((g) => g.vendor !== 'nvidia' && !g.integrated) || new Set(gpus.filter((g) => !g.integrated).map((g) => g.vendor)).size > 1;
  if (needsVulkan) {
    const pkgs = [];
    if (!hasVulkanLoader() && fam) pkgs.push(packages.VULKAN.loader[fam]);
    const drivers = vulkanDrivers().join(' ');
    for (const vendor of ['amd', 'intel']) {
      const wanted = gpus.some((g) => g.vendor === vendor && !g.integrated);
      const has = vendor === 'amd' ? /radeon/.test(drivers) : /intel/.test(drivers);
      if (wanted && !has && fam) pkgs.push(packages.VULKAN[vendor][fam]);
    }
    add({ id: 'vulkan', label: 'Vulkan graphics drivers', required: true, status: pkgs.length ? 'missing' : 'ok',
      detail: pkgs.length ? 'needed to run models on this GPU' : 'installed', packages: pkgs });
  }
  if (gpus.some((g) => g.driverMissing)) {
    add({ id: 'nvidia', label: 'NVIDIA driver', status: 'warn',
      detail: 'An NVIDIA GPU is present but its driver is not loaded; models will run on other hardware until it is installed.' });
  }

  for (const tool of packages.missingTools()) {
    add({ id: `tool:${tool.bin}`, label: tool.feature, status: 'warn', detail: `needs ${tool.bin}`, packages: fam ? [tool.pkg[fam]] : [] });
  }
  return { distro: fam, checks };
}

function ggufCount(dir) {
  try {
    return fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.gguf') && !path.basename(String(f)).startsWith('mmproj')).length;
  } catch {
    return 0;
  }
}

/** What a hand-built install already has; empty when this is a fresh machine. */
function existingInstall() {
  const home = os.homedir();
  const found = {
    router: units.exists(units.NAMES.router),
    whisper: units.exists('leslie-whisper.service'),
    speech: units.exists(units.NAMES.speech),
    vision: units.exists(units.NAMES.vision),
    presets: fs.existsSync(paths.ROUTER_PRESETS),
    serverSettings: fs.existsSync(path.join(paths.CONFIG, 'llama-server.json')),
    llamaServer: which('llama-server'),
    pi: which('pi'),
    models: ggufCount(path.join(home, 'models')),
    env: fs.existsSync(path.join(paths.CONFIG, '.env')) || fs.existsSync(path.join(paths.RESOURCES, '.env'))
  };
  found.any = found.router || found.serverSettings || found.models > 0;
  return found;
}

module.exports = { systemChecks, existingInstall, freeBytes };

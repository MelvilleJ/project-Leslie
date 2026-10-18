'use strict';

// What GPUs this machine has, which llama.cpp build suits them, and how big a
// model they can hold. Detection runs twice: from sysfs and nvidia-smi before
// there is a llama-server (to pick the build), then from `llama-server
// --list-devices`, which names devices the way the router expects.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./exec');

const VENDORS = { '0x10de': 'nvidia', '0x1002': 'amd', '0x8086': 'intel' };
const LABELS = { nvidia: 'NVIDIA GPU', amd: 'AMD GPU', intel: 'Intel GPU' };
// APUs report a small carve-out as VRAM.
const INTEGRATED_BELOW_MIB = 2048;

function readSys(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

// sysfs has no marketing name for AMD and Intel cards; lspci does.
async function pciName(dev) {
  let slot;
  try {
    slot = path.basename(fs.realpathSync(dev));
  } catch {
    return '';
  }
  const res = await run('lspci', ['-vmm', '-s', slot]);
  const m = res.ok && res.stdout.match(/^Device:\s*(.+)$/m);
  if (!m) return '';
  const bracketed = m[1].match(/\[([^\]]+)\]/g);
  return bracketed ? bracketed[bracketed.length - 1].slice(1, -1) : m[1];
}

const nvidiaSmi = () =>
  run('nvidia-smi', ['--query-gpu=name,memory.total,compute_cap,driver_version', '--format=csv,noheader,nounits']);

async function detectGpus({ drm = '/sys/class/drm', queryNvidia = nvidiaSmi } = {}) {
  const gpus = [];
  const nv = await queryNvidia();
  if (nv.ok) {
    for (const line of nv.stdout.trim().split('\n').filter(Boolean)) {
      const [name, total, computeCap, driver] = line.split(',').map((s) => s.trim());
      gpus.push({ vendor: 'nvidia', name: name.replace(/^NVIDIA GeForce /, 'GeForce '), vramMiB: Number(total) || 0, computeCap, driver });
    }
  }
  let cards = [];
  try {
    cards = fs.readdirSync(drm).filter((d) => /^card\d+$/.test(d)).sort();
  } catch {
  }
  let nvidiaCards = 0;
  for (const card of cards) {
    const dev = path.join(drm, card, 'device');
    const vendor = VENDORS[readSys(path.join(dev, 'vendor'))];
    if (!vendor) continue;
    if (vendor === 'nvidia') {
      nvidiaCards += 1;
      continue;
    }
    const vramMiB = Math.round(Number(readSys(path.join(dev, 'mem_info_vram_total')) || 0) / 1048576);
    gpus.push({
      vendor,
      name: readSys(path.join(dev, 'product_name')) || (await pciName(dev)) || LABELS[vendor],
      vramMiB,
      integrated: vramMiB < INTEGRATED_BELOW_MIB
    });
  }
  if (!nv.ok) {
    for (let i = 0; i < nvidiaCards; i += 1) gpus.push({ vendor: 'nvidia', name: LABELS.nvidia, vramMiB: 0, driverMissing: true });
  }
  return gpus;
}

const usable = (gpus) => gpus.filter((g) => !g.integrated && !g.driverMissing && g.vramMiB > 0);

/** The llama.cpp release build to download: cuda-12.8, vulkan, rocm or cpu. */
function chooseBuild(gpus, { rocm = false } = {}) {
  const discrete = usable(gpus);
  if (!discrete.length) return 'cpu';
  const vendors = new Set(discrete.map((g) => g.vendor));
  // One build has one GPU backend; Vulkan is the one every vendor speaks.
  if (vendors.size > 1) return 'vulkan';
  if (vendors.has('nvidia')) {
    // CUDA 12.x runs on any driver from 525 on (minor version compatibility).
    const major = Math.min(...discrete.map((g) => Number(String(g.driver || '').split('.')[0]) || 0));
    return major >= 525 ? 'cuda-12.8' : 'vulkan';
  }
  if (vendors.has('amd') && rocm) return 'rocm';
  return 'vulkan';
}

function tierForMiB(mib) {
  const gb = mib / 1024;
  if (gb < 5) return 'cpu';
  if (gb < 10) return 'small';
  if (gb < 20) return 'medium';
  return 'large';
}

/** everyday: what the largest single GPU can hold. power: what every GPU together can, when there is more than one. */
function tiers(gpus) {
  const discrete = usable(gpus);
  if (!discrete.length) return { everyday: 'cpu', power: null };
  const largest = Math.max(...discrete.map((g) => g.vramMiB));
  const total = discrete.reduce((n, g) => n + g.vramMiB, 0);
  return { everyday: tierForMiB(largest), power: discrete.length > 1 ? tierForMiB(total) : null };
}

const LIST_RE = /^\s*([A-Za-z]+)(\d+): (.+?) \((\d+) MiB, (\d+) MiB free\)\s*$/;

function parseListDevices(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(LIST_RE);
    if (m) out.push({ id: `${m[1]}${m[2]}`, backend: m[1], name: m[3], totalMiB: Number(m[4]), freeMiB: Number(m[5]) });
  }
  return out;
}

/**
 * One entry per physical GPU. A build with two backends lists a card once per
 * backend (CUDA0 and Vulkan1 for one RTX 3060); keep the native backend's entry,
 * while two identical cards on the same backend both stay.
 */
function physicalDevices(devices) {
  const key = (d) => d.name.replace(/\s*\(.*\)\s*$/, '').toLowerCase();
  const rank = (d) => (d.backend === 'Vulkan' ? 1 : 0);
  const best = new Map();
  for (const d of devices) best.set(key(d), Math.min(best.has(key(d)) ? best.get(key(d)) : 9, rank(d)));
  return devices.filter((d) => rank(d) === best.get(key(d)));
}

async function listDevices(binary) {
  const res = await run(binary, ['--list-devices'], { timeout: 60000 });
  return parseListDevices(`${res.stdout}\n${res.stderr}`);
}

/** Device lists for the profiles: Everyday on the largest GPU, Power across all of them. */
function profileDevices(devices) {
  const physical = physicalDevices(devices);
  if (!physical.length) return { everyday: '', power: '' };
  const largest = physical.reduce((a, b) => (b.totalMiB > a.totalMiB ? b : a));
  return {
    everyday: largest.id,
    power: physical.length > 1 ? physical.map((d) => d.id).join(',') : ''
  };
}

const ramMiB = () => Math.round(os.totalmem() / 1048576);

module.exports = { detectGpus, chooseBuild, tiers, tierForMiB, parseListDevices, physicalDevices, profileDevices, listDevices, ramMiB };

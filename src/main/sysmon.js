'use strict';

// System monitor — live CPU / RAM / GPU / app-process metrics for the settings
// window's "System" panel. Pure read-only sampling, no dependencies:
//   CPU   — aggregate busy% from os.cpus() time deltas between samples
//   RAM   — os.totalmem / freemem
//   App   — Electron app.getAppMetrics() summed across LESLIE's processes
//   GPU   — best-effort: nvidia-smi (NVIDIA) for live utilisation, else the
//           static adapter name from app.getGPUInfo (AMD/Intel have no simple
//           cross-platform live-utilisation source).

const os = require('node:os');
const { execFile } = require('node:child_process');
const { app } = require('electron');

// --- CPU --------------------------------------------------------------------
// os.cpus() reports cumulative tick counters; usage is the busy fraction of the
// delta between two reads. Keep the previous totals so each sample is the load
// since the last one.
let prevCpu = null;

function cpuTotals() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

function cpuUsagePct() {
  const now = cpuTotals();
  if (!prevCpu) {
    prevCpu = now;
    return 0;
  }
  const idleDelta = now.idle - prevCpu.idle;
  const totalDelta = now.total - prevCpu.total;
  prevCpu = now;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
}

// --- GPU (nvidia-smi, best effort, cached) ----------------------------------
// nvidia-smi is the only no-dependency source of live GPU utilisation on
// Windows. We run it on a throttle and cache the parsed result; non-NVIDIA
// machines (or no driver) just get the static adapter name from getGPUInfo.
let gpuCache = { ready: false, gpus: null, available: false, ts: 0 };
let gpuInFlight = false;
const GPU_REFRESH_MS = 1500;

function parseNvidiaSmi(stdout) {
  // CSV columns: name, util.gpu %, mem.used MiB, mem.total MiB, temp °C
  return stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, util, memUsed, memTotal, temp] = line.split(',').map((s) => s.trim());
      return {
        name,
        utilPct: Number(util),
        memUsedMB: Number(memUsed),
        memTotalMB: Number(memTotal),
        tempC: Number(temp),
        live: true
      };
    })
    .filter((g) => g.name);
}

function refreshGpu() {
  if (gpuInFlight || Date.now() - gpuCache.ts < GPU_REFRESH_MS) return;
  gpuInFlight = true;
  execFile(
    'nvidia-smi',
    [
      '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
      '--format=csv,noheader,nounits'
    ],
    { timeout: 4000, windowsHide: true },
    (err, stdout) => {
      gpuInFlight = false;
      gpuCache.ts = Date.now();
      gpuCache.ready = true;
      if (err || !stdout) {
        gpuCache.available = false;
        gpuCache.gpus = null;
        return;
      }
      try {
        const gpus = parseNvidiaSmi(stdout);
        gpuCache.gpus = gpus;
        gpuCache.available = gpus.length > 0;
      } catch {
        gpuCache.available = false;
        gpuCache.gpus = null;
      }
    }
  );
}

// Static adapter names from Electron's GPU info — the fallback when there's no
// live source. Fetched once and cached.
let staticGpuNames = null;
async function staticGpus() {
  if (staticGpuNames) return staticGpuNames;
  try {
    const info = await app.getGPUInfo('basic');
    const devices = (info && info.gpuDevice) || [];
    staticGpuNames = devices
      .map((d) => d.deviceString || d.driverVendor || '')
      .filter(Boolean)
      .map((name) => ({ name, live: false }));
  } catch {
    staticGpuNames = [];
  }
  return staticGpuNames;
}

async function gpuInfo() {
  refreshGpu(); // kick a (throttled) live refresh for next time
  if (gpuCache.available && gpuCache.gpus && gpuCache.gpus.length) {
    return { available: true, gpus: gpuCache.gpus };
  }
  // No live data — report static adapter name(s) so the panel isn't empty.
  const gpus = await staticGpus();
  return { available: false, gpus };
}

// --- App process metrics ----------------------------------------------------
function appMetrics() {
  let cpuPct = 0;
  let memKB = 0;
  let processes = 0;
  try {
    for (const m of app.getAppMetrics()) {
      processes += 1;
      cpuPct += (m.cpu && m.cpu.percentCPUUsage) || 0;
      memKB += (m.memory && m.memory.workingSetSize) || 0; // KB
    }
  } catch {
    // getAppMetrics can throw very early in startup; report zeros.
  }
  return {
    cpuPct: Math.round(cpuPct),
    memMB: Math.round(memKB / 1024),
    processes
  };
}

const MB = 1024 * 1024;

/**
 * One full system sample. Async because GPU info may need an awaited fallback.
 * @returns {Promise<object>}
 */
async function sample() {
  const totalmem = os.totalmem();
  const freemem = os.freemem();
  const usedmem = totalmem - freemem;
  const cores = os.cpus();

  const gpu = await gpuInfo();

  return {
    cpu: {
      usagePct: cpuUsagePct(),
      cores: cores.length,
      model: (cores[0] && cores[0].model.trim()) || 'CPU',
      loadAvg: os.loadavg()[0] // 0 on Windows, meaningful on *nix
    },
    mem: {
      usedMB: Math.round(usedmem / MB),
      totalMB: Math.round(totalmem / MB),
      pct: Math.round((usedmem / totalmem) * 100)
    },
    app: appMetrics(),
    gpu,
    host: {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      uptimeSec: Math.round(os.uptime())
    }
  };
}

module.exports = { sample };

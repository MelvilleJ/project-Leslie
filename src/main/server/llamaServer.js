'use strict';

// Runs llama.cpp's router as a systemd user service (leslie-llama) and switches
// between two model profiles: "everyday" (fits the RTX 3060 alone, loaded at
// login) and "power" (split across both GPUs). No Electron dependencies, so the
// terminal TUI (bin/leslie-server) shares it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'project-leslie');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'llama-server.json');
const PRESETS_FILE = path.join(CONFIG_DIR, 'llama-presets.ini');
const UNIT = 'leslie-llama.service';
const UNIT_FILE = path.join(os.homedir(), '.config', 'systemd', 'user', UNIT);

const PROFILES = ['everyday', 'power'];

const DEFAULTS = {
  binary: 'llama-server',
  modelsDir: path.join(os.homedir(), 'models'),
  host: '127.0.0.1',
  port: 8080,
  threads: 6,
  profiles: {
    everyday: {
      label: 'Everyday',
      description: 'RTX 3060 only — quick everyday tasks, loaded at login',
      model: 'gpt-oss-20b-unsloth',
      devices: 'CUDA0',
      tensorSplit: '',
      ctx: 32768,
      // null = let llama.cpp's --fit decide how much to offload to RAM for this GPU.
      cpuMoeLayers: null
    },
    power: {
      label: 'Power',
      description: 'RTX 3060 + RX 9060 XT — the strongest model',
      model: 'Qwen3.8-27B-UD-Q4_K_M',
      devices: 'CUDA0,Vulkan0',
      tensorSplit: '12,16',
      ctx: 65536,
      cpuMoeLayers: null
    }
  }
};

// --- Settings ---------------------------------------------------------------

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
  }
  const profiles = {};
  for (const name of PROFILES) profiles[name] = { ...DEFAULTS.profiles[name], ...((saved.profiles || {})[name] || {}) };
  return { ...DEFAULTS, ...saved, profiles };
}

function saveSettings(patch) {
  const current = loadSettings();
  const next = { ...current, ...patch, profiles: { ...current.profiles } };
  for (const name of PROFILES) {
    if (patch.profiles && patch.profiles[name]) next.profiles[name] = { ...current.profiles[name], ...patch.profiles[name] };
  }
  if (next.profiles.everyday.model === next.profiles.power.model) {
    throw new Error('Everyday and Power need different models.');
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`);
  writePresets(next);
  return next;
}

// --- Model discovery (mirrors how the router reads --models-dir) --------------

function ggufIn(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.gguf')).sort();
  } catch {
    return [];
  }
}

/** Models in the models folder: id → { model, mmproj?, bytes }. */
function listModels(settings = loadSettings()) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(settings.modelsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  const size = (p) => {
    try {
      return fs.statSync(p).size;
    } catch {
      return 0;
    }
  };
  for (const e of entries) {
    const full = path.join(settings.modelsDir, e.name);
    if (e.isFile() && e.name.endsWith('.gguf')) {
      out.push({ id: e.name.replace(/\.gguf$/, ''), model: full, bytes: size(full) });
    } else if (e.isDirectory() && !e.name.startsWith('.')) {
      const files = ggufIn(full);
      const mmproj = files.find((f) => f.startsWith('mmproj'));
      const shards = files.filter((f) => !f.startsWith('mmproj'));
      if (!shards.length) continue;
      const main = shards.find((f) => /-0*1-of-/.test(f)) || shards[0];
      out.push({
        id: e.name,
        model: path.join(full, main),
        mmproj: mmproj ? path.join(full, mmproj) : undefined,
        bytes: shards.reduce((n, f) => n + size(path.join(full, f)), 0)
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// --- Presets + unit ---------------------------------------------------------

function presetSection(profile, entry, loadOnStartup) {
  const lines = [`[${profile.model}]`, `model = ${entry.model}`];
  if (entry.mmproj) lines.push(`mmproj = ${entry.mmproj}`);
  lines.push(`device = ${profile.devices}`, `ctx-size = ${profile.ctx}`);
  if (profile.tensorSplit) lines.push(`tensor-split = ${profile.tensorSplit}`);
  if (profile.cpuMoeLayers > 0) lines.push(`n-cpu-moe = ${profile.cpuMoeLayers}`);
  if (loadOnStartup) lines.push('load-on-startup = true');
  return lines.join('\n');
}

function writePresets(settings = loadSettings()) {
  const models = new Map(listModels(settings).map((m) => [m.id, m]));
  // GPU layers and expert offload are left unset so llama.cpp's --fit sizes them
  // to each profile's devices; setting them globally would switch fitting off.
  const sections = ['version = 1', '', '[*]', 'jinja = true', `threads = ${settings.threads}`];
  for (const name of PROFILES) {
    const profile = settings.profiles[name];
    const entry = models.get(profile.model);
    if (entry) sections.push('', presetSection(profile, entry, name === 'everyday'));
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PRESETS_FILE, `${sections.join('\n')}\n`);
  return PRESETS_FILE;
}

function which(bin) {
  if (path.isAbsolute(bin)) return bin;
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
    }
  }
  return bin;
}

function unitText(settings) {
  const args = [
    which(settings.binary),
    '--models-dir', settings.modelsDir,
    '--models-preset', PRESETS_FILE,
    '--no-models-autoload',
    '--host', settings.host,
    '--port', String(settings.port)
  ];
  return [
    '[Unit]',
    'Description=LESLIE model server (llama.cpp router)',
    // Let the speech server claim its VRAM first so --fit sizes models around it.
    'After=network.target leslie-whisper.service',
    '',
    '[Service]',
    `ExecStart=${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=5',
    'TimeoutStopSec=30',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n');
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) })
    );
  });
}

const systemctl = (...args) => run('systemctl', ['--user', ...args]);

/** Write presets + the unit file; returns true when the unit changed (restart needed). */
async function installService(settings = loadSettings()) {
  writePresets(settings);
  const text = unitText(settings);
  let old = '';
  try {
    old = fs.readFileSync(UNIT_FILE, 'utf8');
  } catch {
  }
  if (old === text) return false;
  fs.mkdirSync(path.dirname(UNIT_FILE), { recursive: true });
  fs.writeFileSync(UNIT_FILE, text);
  await systemctl('daemon-reload');
  return true;
}

async function serviceState() {
  const [active, enabled] = await Promise.all([systemctl('is-active', UNIT), systemctl('is-enabled', UNIT)]);
  return { active: active.stdout.trim() || 'unknown', enabled: enabled.stdout.trim() === 'enabled', installed: fs.existsSync(UNIT_FILE) };
}

async function service(action) {
  if (!['start', 'stop', 'restart', 'enable', 'disable'].includes(action)) throw new Error(`bad action ${action}`);
  if (action === 'start' || action === 'restart' || action === 'enable') await installService();
  const res = await systemctl(action, UNIT);
  if (!res.ok) throw new Error(res.stderr.trim() || `systemctl ${action} failed`);
}

async function logs(lines = 60) {
  const res = await run('journalctl', ['--user', '-u', UNIT, '-n', String(lines), '--no-pager', '-o', 'cat']);
  return res.stdout;
}

// --- Router API ------------------------------------------------------------

function baseUrl(settings = loadSettings()) {
  return `http://${settings.host}:${settings.port}`;
}

async function api(route, body, { timeoutMs = 10000 } = {}) {
  const res = await fetch(`${baseUrl()}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
  }
  if (!res.ok) throw new Error((data && data.error && (data.error.message || data.error)) || text || `${res.status}`);
  return data;
}

async function routerModels() {
  const data = await api('/models');
  return (data.data || []).map((m) => ({ id: m.id, status: (m.status && m.status.value) || 'unknown' }));
}

// --- GPUs --------------------------------------------------------------------

async function gpus() {
  const out = [];
  const nv = await run('nvidia-smi', ['--query-gpu=name,memory.used,memory.total', '--format=csv,noheader,nounits']);
  if (nv.ok) {
    for (const line of nv.stdout.trim().split('\n').filter(Boolean)) {
      const [name, used, total] = line.split(',').map((s) => s.trim());
      out.push({ name: name.replace(/^NVIDIA GeForce /, ''), usedMiB: Number(used), totalMiB: Number(total) });
    }
  }
  let cards = [];
  try {
    cards = fs.readdirSync('/sys/class/drm').filter((d) => /^card\d+$/.test(d));
  } catch {
  }
  for (const card of cards) {
    const dev = path.join('/sys/class/drm', card, 'device');
    try {
      if (fs.readFileSync(path.join(dev, 'vendor'), 'utf8').trim() !== '0x1002') continue;
      const used = Number(fs.readFileSync(path.join(dev, 'mem_info_vram_used'), 'utf8'));
      const total = Number(fs.readFileSync(path.join(dev, 'mem_info_vram_total'), 'utf8'));
      out.push({ name: 'Radeon', usedMiB: Math.round(used / 1048576), totalMiB: Math.round(total / 1048576) });
    } catch {
    }
  }
  return out;
}

// --- Status + switching ------------------------------------------------------

async function status() {
  const settings = loadSettings();
  const [svc, gpuList] = await Promise.all([serviceState(), gpus()]);
  let models = [];
  let reachable = false;
  try {
    models = await routerModels();
    reachable = true;
  } catch {
  }
  const byId = new Map(models.map((m) => [m.id, m.status]));
  const profiles = PROFILES.map((name) => ({ name, ...settings.profiles[name], state: byId.get(settings.profiles[name].model) || 'missing' }));
  const loaded = models.filter((m) => m.status === 'loaded' || m.status === 'loading');
  const active = profiles.find((p) => p.state === 'loaded' || p.state === 'loading');
  return {
    url: baseUrl(settings),
    service: svc,
    reachable,
    profiles,
    activeProfile: active ? active.name : null,
    loaded: loaded.map((m) => m.id),
    gpus: gpuList
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(id, want, timeoutMs, onProgress) {
  const started = Date.now();
  for (;;) {
    const m = (await routerModels()).find((x) => x.id === id);
    const state = m ? m.status : 'missing';
    if (state === want) return;
    if (state === 'failed' || (want === 'loaded' && state === 'unloaded' && Date.now() - started > 5000)) {
      const tail = (await logs(15)).trim().split('\n').slice(-4).join(' | ');
      throw new Error(`${id} failed to load${tail ? `: ${tail}` : ''}`);
    }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${id} to be ${want}`);
    if (onProgress) onProgress(`${id}: ${state}…`);
    await sleep(1500);
  }
}

/** Make `profile` the only loaded model: unload everything else, then load it. */
async function switchProfile(profile, onProgress = () => {}) {
  const settings = loadSettings();
  const target = settings.profiles[profile];
  if (!target) throw new Error(`Unknown profile ${profile}`);
  const models = await routerModels();
  if (!models.some((m) => m.id === target.model)) throw new Error(`${target.model} is not in ${settings.modelsDir}`);
  for (const m of models) {
    if (m.id !== target.model && (m.status === 'loaded' || m.status === 'loading')) {
      onProgress(`Unloading ${m.id}…`);
      await api('/models/unload', { model: m.id });
      await waitFor(m.id, 'unloaded', 60000, onProgress);
    }
  }
  const current = models.find((m) => m.id === target.model);
  if (current.status !== 'loaded') {
    onProgress(`Loading ${target.model}…`);
    if (current.status !== 'loading') await api('/models/load', { model: target.model });
    await waitFor(target.model, 'loaded', 10 * 60000, onProgress);
  }
  onProgress(`${target.label} ready: ${target.model}`);
  return target.model;
}

async function unloadAll() {
  for (const m of await routerModels()) {
    if (m.status === 'loaded' || m.status === 'loading') await api('/models/unload', { model: m.id });
  }
}

module.exports = {
  PROFILES,
  CONFIG_DIR,
  PRESETS_FILE,
  UNIT,
  loadSettings,
  saveSettings,
  listModels,
  writePresets,
  installService,
  service,
  logs,
  baseUrl,
  routerModels,
  gpus,
  status,
  switchProfile,
  unloadAll
};

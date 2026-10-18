'use strict';

// Drives the shared llama.cpp router (the llama-router user service, set up by
// scripts/setup-llama-router.sh and usable by any app) and switches between two
// model profiles: "everyday" (loaded at login) and "power" (the strongest model,
// usually across every GPU). Either profile can opt into stopping
// speech recognition with stopsWhisper. No Electron dependencies, so the terminal TUI
// (bin/leslie-server) shares it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'project-leslie');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'llama-server.json');
const UNITS_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');
const WHISPER_UNIT = 'leslie-whisper.service';

const PROFILES = ['everyday', 'power'];

const DEFAULTS = {
  // Must match the router's unit (--models-dir, --models-preset, --host, --port).
  unit: 'llama-router.service',
  presetsFile: path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'llama-router', 'presets.ini'),
  modelsDir: path.join(os.homedir(), 'models'),
  host: '127.0.0.1',
  port: 8080,
  // Roughly the physical core count.
  threads: Math.max(1, Math.floor(os.availableParallelism() / 2)),
  profiles: {
    // Blank devices = every GPU llama.cpp finds; --fit sizes the offload to them.
    everyday: {
      label: 'Everyday',
      description: 'Quick everyday tasks, loaded at login',
      model: '',
      devices: '',
      tensorSplit: '',
      ctx: 32768,
      cacheType: '',
      specType: '',
      stopsWhisper: false,
      // null = let llama.cpp's --fit decide how much to offload to RAM for this GPU.
      cpuMoeLayers: null
    },
    power: {
      label: 'Power',
      description: 'The strongest model',
      model: '',
      devices: '',
      tensorSplit: '',
      ctx: 65536,
      cacheType: '',
      specType: '',
      stopsWhisper: false,
      cpuMoeLayers: null
    }
  },
  // A small model on the GPU Everyday leaves free, for the helper Leslies.
  // ctx is shared by its parallel slots, one per helper.
  helper: {
    label: 'Helpers',
    model: '',
    devices: '',
    ctx: 98304,
    parallel: 3,
    cacheType: '',
    idleMinutes: 5
  },
  // Router settings for models outside the two profiles, keyed by model id.
  // Without one, the router loads a model with no ctx-size and --fit shrinks the
  // context to whatever VRAM happens to be free.
  modelPresets: {}
};

const PRESET_FIELDS = ['devices', 'tensorSplit', 'ctx', 'cacheType', 'specType', 'cpuMoeLayers'];

const PRESET_DEFAULTS = {
  devices: '',
  tensorSplit: '',
  ctx: 32768,
  cacheType: '',
  specType: '',
  cpuMoeLayers: null
};

function cleanPreset(preset) {
  const out = { ...PRESET_DEFAULTS };
  for (const key of PRESET_FIELDS) if (preset[key] !== undefined) out[key] = preset[key];
  return out;
}

// --- Settings ---------------------------------------------------------------

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
  }
  const profiles = {};
  for (const name of PROFILES) profiles[name] = { ...DEFAULTS.profiles[name], ...((saved.profiles || {})[name] || {}) };
  const modelPresets = {};
  for (const [id, preset] of Object.entries(saved.modelPresets || {})) modelPresets[id] = cleanPreset(preset);
  const helper = { ...DEFAULTS.helper, ...(saved.helper || {}) };
  return { ...DEFAULTS, ...saved, profiles, helper, modelPresets };
}

function saveSettings(patch) {
  const current = loadSettings();
  const next = { ...current, ...patch, profiles: { ...current.profiles }, helper: { ...current.helper, ...(patch.helper || {}) } };
  for (const name of PROFILES) {
    if (patch.profiles && patch.profiles[name]) next.profiles[name] = { ...current.profiles[name], ...patch.profiles[name] };
  }
  // A null entry removes that model's preset.
  next.modelPresets = { ...current.modelPresets };
  for (const [id, preset] of Object.entries(patch.modelPresets || {})) {
    if (preset === null) delete next.modelPresets[id];
    else next.modelPresets[id] = cleanPreset({ ...next.modelPresets[id], ...preset });
  }
  if (next.profiles.everyday.model && next.profiles.everyday.model === next.profiles.power.model) {
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

// --- Shared presets file ----------------------------------------------------

// Tags the sections LESLIE owns in the shared presets file; everything else in
// it belongs to the user or other apps and is left alone.
const MANAGED = '; managed by LESLIE';
const NEW_PRESETS = 'version = 1\n\n[*]\njinja = true\n';

function presetSection(id, profile, entry, loadOnStartup, threads) {
  const lines = [`[${id}]`, MANAGED, `model = ${entry.model}`];
  if (entry.mmproj) lines.push(`mmproj = ${entry.mmproj}`);
  lines.push(`threads = ${threads}`);
  if (profile.devices) lines.push(`device = ${profile.devices}`);
  lines.push(`ctx-size = ${profile.ctx}`);
  if (profile.tensorSplit) lines.push(`tensor-split = ${profile.tensorSplit}`);
  if (profile.cpuMoeLayers > 0) lines.push(`n-cpu-moe = ${profile.cpuMoeLayers}`);
  if (profile.parallel > 1) lines.push(`parallel = ${profile.parallel}`);
  if (profile.cacheType) lines.push(`cache-type-k = ${profile.cacheType}`, `cache-type-v = ${profile.cacheType}`);
  if (profile.specType) lines.push(`spec-type = ${profile.specType}`);
  if (loadOnStartup) lines.push('load-on-startup = true');
  return lines.join('\n');
}

/** Rewrite LESLIE's sections of the shared presets file, keeping the rest. Returns true when it changed. */
function writePresets(settings = loadSettings()) {
  const models = new Map(listModels(settings).map((m) => [m.id, m]));
  // GPU layers and expert offload are left unset so llama.cpp's --fit sizes them
  // to each profile's devices; setting them globally would switch fitting off.
  const ours = new Map();
  for (const name of PROFILES) {
    const profile = settings.profiles[name];
    const entry = models.get(profile.model);
    if (entry) ours.set(profile.model, presetSection(profile.model, profile, entry, name === 'everyday', settings.threads));
  }
  const helperEntry = models.get(settings.helper.model);
  if (helperEntry && !ours.has(settings.helper.model)) {
    ours.set(settings.helper.model, presetSection(settings.helper.model, settings.helper, helperEntry, false, settings.threads));
  }
  for (const [id, preset] of Object.entries(settings.modelPresets)) {
    const entry = models.get(id);
    // A profile's own settings win over a preset for the same model.
    if (entry && !ours.has(id)) ours.set(id, presetSection(id, preset, entry, false, settings.threads));
  }

  let old = NEW_PRESETS;
  try {
    old = fs.readFileSync(settings.presetsFile, 'utf8');
  } catch {
  }
  // Split before each [section] header; LESLIE's sections (and any section for a
  // model LESLIE now configures) are dropped and re-added below.
  const [preamble, ...sections] = `\n${old}`.split(/^(?=\[[^\]\n]+\]\s*$)/m);
  const kept = sections.filter((sec) => {
    const id = sec.match(/^\[([^\]\n]+)\]/)[1];
    return id === '*' || (!sec.split('\n').includes(MANAGED) && !ours.has(id));
  });
  const text = `${[preamble, ...kept].map((s) => s.trim()).filter(Boolean).concat([...ours.values()]).join('\n\n')}\n`;
  if (text === old) return false;
  fs.mkdirSync(path.dirname(settings.presetsFile), { recursive: true });
  fs.writeFileSync(settings.presetsFile, text);
  return true;
}

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) })
    );
  });
}

const systemctl = (...args) => run('systemctl', ['--user', ...args]);

async function serviceState(unit = loadSettings().unit) {
  const [active, enabled] = await Promise.all([systemctl('is-active', unit), systemctl('is-enabled', unit)]);
  const state = enabled.stdout.trim();
  // is-enabled prints "not-found" (and fails) when no such unit exists.
  return { unit, active: active.stdout.trim() || 'unknown', enabled: state === 'enabled', installed: Boolean(state) && state !== 'not-found' };
}

/** Start or stop speech recognition; a no-op where it was never set up. */
async function setWhisper(on) {
  if (!fs.existsSync(path.join(UNITS_DIR, WHISPER_UNIT))) return;
  const res = await run('systemctl', ['--user', on ? 'start' : 'stop', WHISPER_UNIT], 90000);
  if (!res.ok) throw new Error(res.stderr.trim() || `could not ${on ? 'start' : 'stop'} speech recognition`);
}

async function service(action) {
  if (!['start', 'stop', 'restart', 'enable', 'disable'].includes(action)) throw new Error(`bad action ${action}`);
  const settings = loadSettings();
  if (!(await serviceState(settings.unit)).installed) {
    throw new Error(`${settings.unit} is not installed. Set it up with scripts/setup-llama-router.sh.`);
  }
  if (action === 'start' || action === 'restart') {
    writePresets(settings);
    // The router loads Everyday on start, which is sized around whisper's VRAM.
    await setWhisper(true);
  }
  const res = await systemctl(action, settings.unit);
  if (!res.ok) throw new Error(res.stderr.trim() || `systemctl ${action} failed`);
}

async function logs(lines = 60) {
  const res = await run('journalctl', ['--user', '-u', loadSettings().unit, '-n', String(lines), '--no-pager', '-o', 'cat']);
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
  return (data.data || []).map((m) => ({
    id: m.id,
    status: (m.status && m.status.value) || 'unknown',
    inputs: (m.architecture && m.architecture.input_modalities) || ['text']
  }));
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
  const [svc, gpuList] = await Promise.all([serviceState(settings.unit), gpus()]);
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
    modelPresets: settings.modelPresets,
    helper: { ...settings.helper, state: byId.get(settings.helper.model) || 'missing' },
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
  if (!target.model) throw new Error(`No model is chosen for ${target.label} yet (Settings → Models & GPUs).`);
  const models = await routerModels();
  if (!models.some((m) => m.id === target.model)) throw new Error(`${target.model} is not in ${settings.modelsDir}`);
  for (const m of models) {
    if (m.id !== target.model && (m.status === 'loaded' || m.status === 'loading')) {
      onProgress(`Unloading ${m.id}…`);
      await api('/models/unload', { model: m.id });
      await waitFor(m.id, 'unloaded', 60000, onProgress);
    }
  }
  // After the unloads, so stopping whisper never races a model still holding VRAM,
  // and before the load, so --fit sizes the new model around whisper's state.
  onProgress(target.stopsWhisper ? 'Stopping speech recognition…' : 'Starting speech recognition…');
  await setWhisper(!target.stopsWhisper);
  const current = models.find((m) => m.id === target.model);
  if (current.status !== 'loaded') {
    onProgress(`Loading ${target.model}…`);
    if (current.status !== 'loading') await api('/models/load', { model: target.model });
    await waitFor(target.model, 'loaded', 10 * 60000, onProgress);
  }
  onProgress(`${target.label} ready: ${target.model}`);
  return target.model;
}

/** Load the helper model next to the active profile (never unloading it). */
async function loadHelper(onProgress = () => {}) {
  const { model } = loadSettings().helper;
  const current = (await routerModels()).find((m) => m.id === model);
  if (!current) throw new Error(`The helper model ${model} is not in the models folder.`);
  if (current.status === 'loaded') return model;
  onProgress(`Loading ${model}…`);
  if (current.status !== 'loading') await api('/models/load', { model });
  await waitFor(model, 'loaded', 5 * 60000, onProgress);
  return model;
}

async function unloadHelper() {
  const { model } = loadSettings().helper;
  const current = (await routerModels()).find((m) => m.id === model);
  if (current && (current.status === 'loaded' || current.status === 'loading')) await api('/models/unload', { model });
}

async function unloadAll() {
  for (const m of await routerModels()) {
    if (m.status === 'loaded' || m.status === 'loading') await api('/models/unload', { model: m.id });
  }
}

module.exports = {
  PROFILES,
  CONFIG_DIR,
  loadSettings,
  saveSettings,
  listModels,
  writePresets,
  service,
  logs,
  baseUrl,
  routerModels,
  gpus,
  status,
  switchProfile,
  loadHelper,
  unloadHelper,
  unloadAll
};

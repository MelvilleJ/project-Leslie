'use strict';

// The install work for a set of setup choices, as tasks with dependencies, and
// a runner that executes them. Every task checks for its own result first, so
// re-running resumes, retries or repairs instead of starting over.
//
// choices:
//   engine    { mode: 'download' | 'existing' | 'remote' | 'cloud', build, binary, url,
//               provider, model, apiKey (cloud) }
//   everyday  catalog model id, power: catalog model id or ''
//   tiers     { everyday, power } from hardware.tiers
//   modelsDir where the GGUFs go
//   packages  distro packages to install first
//   vision    { enabled, runtime: 'cuda' | 'cpu' }
//   speech    { enabled, runtime: 'cuda' | 'cpu' }
//   settings  LESLIE settings to apply (configStore keys)
//   persona   { preset, name, address, custom } for the system prompt
//   launcher, startAtLogin  booleans
//   adopt     keep an existing hand-built install as it is

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const paths = require('./paths');
const catalog = require('./catalog');
const hardware = require('./hardware');
const engines = require('./engines');
const sidecars = require('./sidecars');
const units = require('./units');
const packages = require('./packages');
const desktop = require('./desktop');
const persona = require('./persona');
const state = require('./state');
const { download } = require('./download');
const { which } = require('./exec');

const server = () => require('../server/llamaServer');

function binaryFor(engine) {
  if (engine.mode === 'existing') return engine.binary || which('llama-server');
  return engines.serverFor(engine.build);
}

async function downloadModel(id, modelsDir, onProgress, signal) {
  const model = catalog.find(id);
  if (!model) throw new Error(`${id} is not in the model catalog.`);
  const total = catalog.totalBytes(model);
  let before = 0;
  for (const f of model.files) {
    const url = `https://huggingface.co/${model.repo}/resolve/main/${f.name}`;
    await download(url, path.join(modelsDir, model.id, f.name), {
      bytes: f.bytes,
      sha256: f.sha256,
      signal,
      onProgress: ({ done }) => onProgress({ text: `Downloading ${model.label}`, done: before + done, total })
    });
    before += f.bytes;
  }
}

/** Keeps a copy of a unit someone else wrote before replacing it. */
function writeUnit(name, text) {
  const file = units.unitPath(name);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== text) {
    const backup = `${file}.before-setup`;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  }
  units.write(name, text, { replace: true });
}

/** LESLIE settings implied by the choices, on top of choices.settings. */
function settingsFor(c) {
  const out = { ...(c.settings || {}) };
  if (c.persona && !out.systemPrompt) out.systemPrompt = persona.systemPrompt(c.persona);
  if (c.engine.mode === 'remote') Object.assign(out, { serverManaged: false, baseURL: c.engine.url });
  else if (c.engine.mode === 'cloud') {
    Object.assign(out, { serverManaged: false, piModel: `${c.engine.provider}/${c.engine.model}`, cloudProvider: c.engine.provider, cloudApiKey: c.engine.apiKey || '' });
  } else Object.assign(out, { serverManaged: true });
  if (c.speech && c.speech.enabled) Object.assign(out, { sttBackend: 'server', sttServerUrl: `http://127.0.0.1:${units.PORTS.speech}/v1` });
  else if (!c.adopt) out.sttBackend = 'local';
  if (c.vision) out.cameraEnabled = Boolean(c.vision.enabled);
  return out;
}

/**
 * ctx: { appExec, setSettings(values), signal }
 * appExec is the command that starts LESLIE (for the launcher and the login
 * service); without one those tasks are left out.
 */
function buildTasks(c, ctx = {}) {
  const tasks = [];
  const add = (t) => tasks.push({ deps: [], optional: false, key: null, ...t });
  const local = !['remote', 'cloud'].includes(c.engine.mode) && !c.adopt;
  const modelsDir = c.modelsDir || path.join(paths.MODELS, 'llm');
  const signal = ctx.signal;

  if (c.packages && c.packages.length) {
    add({ id: 'packages', label: 'Installing system packages', optional: true, key: c.packages,
      run: () => packages.install(c.packages) });
  }
  const afterPackages = c.packages && c.packages.length ? ['packages'] : [];

  if (c.launcher && ctx.appExec) {
    add({ id: 'launcher', label: 'Adding LESLIE to your applications', optional: true, key: ctx.appExec,
      run: () => desktop.installLauncher(ctx.appExec) });
  }

  const startDeps = [];
  if (local) {
    if (c.engine.mode === 'download') {
      add({ id: 'engine', label: 'Getting the model engine', deps: afterPackages, key: c.engine.build,
        run: (progress) => engines.install(c.engine.build, { onProgress: progress, signal }) });
    }
    const modelIds = [...new Set([c.everyday, c.power].filter(Boolean))];
    for (const id of modelIds) {
      const model = catalog.find(id);
      add({ id: `model:${id}`, label: `Downloading ${model ? model.label : id}`, key: [id, modelsDir],
        run: (progress) => downloadModel(id, modelsDir, progress, signal) });
    }
    add({
      id: 'profiles',
      label: 'Fitting the models to your GPUs',
      deps: [...(c.engine.mode === 'download' ? ['engine'] : []), ...modelIds.map((id) => `model:${id}`)],
      key: [c.engine, c.everyday, c.power, modelsDir],
      run: async () => {
        const binary = binaryFor(c.engine);
        if (!binary) throw new Error('No llama-server was found.');
        const devices = await hardware.listDevices(binary);
        const dev = hardware.profileDevices(devices);
        const everyday = c.everyday
          ? { ...catalog.profileFor(c.everyday, c.tiers.everyday), devices: dev.everyday, tensorSplit: '' }
          : { model: '' };
        const power = c.power
          ? { ...catalog.profileFor(c.power, c.tiers.power || 'large'), devices: dev.power || dev.everyday, tensorSplit: '', enabled: true }
          : { model: '', enabled: false };
        server().saveSettings({ modelsDir, binary, profiles: { everyday, power } });
      }
    });
    add({ id: 'router', label: 'Setting up the model server', deps: ['profiles'], key: [c.engine, modelsDir],
      run: async () => {
        writeUnit(units.NAMES.router, units.router({ binary: binaryFor(c.engine), modelsDir }));
        await units.enable(units.NAMES.router);
      } });
    startDeps.push('router');
  }

  const sidecarRuntime = (s) => (s.runtime === 'cuda' ? 'cuda' : 'cpu');
  if (c.vision && c.vision.enabled && !c.adopt) {
    add({ id: 'vision', label: 'Installing camera presence', deps: afterPackages, optional: true, key: sidecarRuntime(c.vision),
      run: async (progress) => {
        const { venv, modelsDir: dir } = await sidecars.installVision(sidecarRuntime(c.vision), { onProgress: progress, signal });
        writeUnit(units.NAMES.vision, units.vision({ venv, modelsDir: dir }));
        await units.enable(units.NAMES.vision);
      } });
    startDeps.push('vision');
  }
  if (c.speech && c.speech.enabled && !c.adopt) {
    add({ id: 'speech', label: 'Installing speech recognition', deps: afterPackages, optional: true, key: sidecarRuntime(c.speech),
      run: async (progress) => {
        const { venv, modelsDir: dir } = await sidecars.installSpeech(sidecarRuntime(c.speech), { onProgress: progress, signal });
        writeUnit(units.NAMES.speech, units.speech({ venv, modelsDir: dir, runtime: sidecarRuntime(c.speech) }));
        await units.enable(units.NAMES.speech);
      } });
    startDeps.push('speech');
  }

  // No key: it would put a cloud API key into setup-state.json, and saving is cheap to repeat.
  add({ id: 'settings', label: 'Saving your preferences', always: true,
    run: () => ctx.setSettings(settingsFor(c)) });

  if (c.startAtLogin && ctx.appExec) {
    add({ id: 'autostart', label: 'Starting LESLIE at login', optional: true, key: ctx.appExec,
      run: async () => {
        writeUnit(units.NAMES.app, units.app({ exec: ctx.appExec }));
        await units.enable(units.NAMES.app);
      } });
  }

  if (startDeps.length) {
    add({ id: 'start', label: 'Starting everything up', deps: startDeps, always: true,
      run: async (progress) => {
        // The sidecars first: llama.cpp's --fit sizes the model around the GPU memory they hold.
        for (const id of ['vision', 'speech']) {
          if (startDeps.includes(id) && units.exists(units.NAMES[id])) {
            progress({ text: `Starting ${id === 'vision' ? 'camera presence' : 'speech recognition'}` });
            await units.restart(units.NAMES[id]);
          }
        }
        if (startDeps.includes('router')) {
          progress({ text: 'Starting the model server' });
          await units.restart(units.NAMES.router);
          if (c.everyday) {
            await waitReachable();
            await server().switchProfile('everyday', (text) => progress({ text }));
          }
        }
      } });
  }
  return tasks;
}

async function waitReachable(timeoutMs = 60000) {
  const started = Date.now();
  for (;;) {
    try {
      await server().routerModels();
      return;
    } catch (err) {
      if (Date.now() - started > timeoutMs) throw new Error(`The model server did not answer: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * Runs tasks with their dependencies, in parallel where they allow. Emits
 * { type: 'task', id, status, error? } with status running | done | failed |
 * blocked | skipped, and { type: 'progress', id, text, fraction? }.
 * A task whose saved outcome is done for the same key is skipped unless
 * `force` lists it (repair) or it is marked `always` (applying settings,
 * starting services: cheap, and a rerun must not leave the old ones).
 */
class Runner extends EventEmitter {
  constructor(tasks, { record = true, force = [] } = {}) {
    super();
    this.tasks = new Map(tasks.map((t) => [t.id, t]));
    this.record = record;
    this.force = new Set(force);
    this.running = new Map();
    this.outcomes = new Map();
  }

  plan() {
    return [...this.tasks.values()].map(({ id, label, deps, optional }) => ({ id, label, deps, optional }));
  }

  _set(id, outcome) {
    this.outcomes.set(id, outcome);
    if (this.record) {
      const task = this.tasks.get(id);
      state.setTask(id, { ...outcome, key: JSON.stringify(task.key) });
    }
    this.emit('event', { type: 'task', id, ...outcome });
  }

  _alreadyDone(task) {
    if (task.always || !this.record || this.force.has(task.id)) return false;
    const saved = ((state.load() || {}).tasks || {})[task.id];
    return Boolean(saved && saved.status === 'done' && saved.key === JSON.stringify(task.key));
  }

  run(id) {
    if (!this.running.has(id)) this.running.set(id, this._run(id));
    return this.running.get(id);
  }

  async _run(id) {
    const task = this.tasks.get(id);
    if (!task) return 'done';
    const depResults = await Promise.all(task.deps.filter((d) => this.tasks.has(d)).map((d) => this.run(d).then((s) => [d, s])));
    const blocker = depResults.find(([d, s]) => s !== 'done' && s !== 'skipped' && !this.tasks.get(d).optional);
    if (blocker) {
      this._set(id, { status: 'blocked', error: `Waiting on "${this.tasks.get(blocker[0]).label}"` });
      return 'blocked';
    }
    if (this._alreadyDone(task)) {
      this._set(id, { status: 'skipped' });
      return 'skipped';
    }
    this._set(id, { status: 'running' });
    const progress = ({ text, done, total } = {}) =>
      this.emit('event', { type: 'progress', id, text, fraction: total ? Math.min(1, done / total) : undefined });
    try {
      await task.run(progress);
      this._set(id, { status: 'done' });
      return 'done';
    } catch (err) {
      this._set(id, { status: 'failed', error: err.message });
      return 'failed';
    }
  }

  /** Run every task (or those in `ids`, with their dependencies). Resolves to { ok, outcomes }. */
  async runAll(ids = [...this.tasks.keys()]) {
    await Promise.all(ids.map((id) => this.run(id)));
    const outcomes = Object.fromEntries(this.outcomes);
    const ok = [...this.outcomes].every(([id, o]) => this.tasks.get(id).optional || ['done', 'skipped'].includes(o.status));
    return { ok, outcomes };
  }
}

module.exports = { buildTasks, settingsFor, binaryFor, downloadModel, Runner };

'use strict';

// After setup: what it installed, repairing one part, moving to the engine
// build this release pins, and uninstalling. No Electron, so leslie-setup can
// share it.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const engines = require('./engines');
const units = require('./units');
const desktop = require('./desktop');
const state = require('./state');
const { buildTasks, Runner } = require('./tasks');

const server = () => require('../server/llamaServer');

// The tasks to re-run for each part, with the start-up step that brings it back.
const SECTIONS = {
  models: ['engine', 'profiles', 'router', 'start'],
  voice: ['speech', 'start'],
  camera: ['vision', 'start']
};

/** '<tag>-<build>' from an engine folder LESLIE downloaded, or null for any other llama-server. */
function engineOf(binary) {
  const root = path.join(paths.ENGINES, 'llama.cpp') + path.sep;
  if (!binary || !binary.startsWith(root)) return null;
  const dir = binary.slice(root.length).split(path.sep)[0];
  const m = dir.match(/^(b\d+)-(.+)$/);
  return m ? { tag: m[1], build: m[2] } : null;
}

function status() {
  const saved = state.load();
  const binary = server().loadSettings().binary || '';
  const engine = engineOf(binary);
  return {
    ranSetup: Boolean(saved && saved.choices && saved.choices.engine),
    finished: Boolean(saved && saved.finished),
    adopted: Boolean(saved && saved.adopted),
    failed: Object.entries((saved && saved.tasks) || {}).filter(([, t]) => t.status === 'failed').map(([id, t]) => ({ id, error: t.error })),
    engine: engine ? { ...engine, pinned: engines.tag, updateAvailable: engine.tag !== engines.tag } : { binary: binary || 'llama-server', managed: false },
    sections: Object.keys(SECTIONS)
  };
}

/** Re-run one part of setup from the saved choices. ctx is as for buildTasks. */
function repair(section, ctx) {
  const saved = state.load();
  if (!saved || !saved.choices || !saved.choices.engine) throw new Error('This install was not made by setup; run setup again to repair it.');
  const wanted = SECTIONS[section];
  if (!wanted) throw new Error(`Unknown part ${section}`);
  const choices = saved.choices;
  const tasks = buildTasks(choices, ctx);
  const ids = tasks.map((t) => t.id).filter((id) => wanted.includes(id) || (section === 'models' && id.startsWith('model:')));
  if (!ids.length) throw new Error(`Setup didn't install ${section === 'models' ? 'local models' : section} here.`);
  return { runner: new Runner(tasks, { force: ids }), ids };
}

/**
 * Install the engine build this release pins, point the router at it, and
 * load Everyday. If the model doesn't come up, the previous engine is put back.
 */
async function updateEngine(onProgress = () => {}) {
  const settings = server().loadSettings();
  const current = engineOf(settings.binary);
  if (!current) throw new Error('The model engine was not installed by setup, so it is left as it is.');
  if (current.tag === engines.tag) return { updated: false };
  const binary = await engines.install(current.build, { onProgress });
  const unitText = (bin) => units.router({ binary: bin, modelsDir: settings.modelsDir, presetsFile: settings.presetsFile, port: settings.port });
  const swap = async (bin) => {
    server().saveSettings({ binary: bin });
    units.write(units.NAMES.router, unitText(bin), { replace: true });
    await units.enable(units.NAMES.router);
    await units.restart(units.NAMES.router);
  };
  onProgress({ text: 'Restarting the model server on the new engine' });
  try {
    await swap(binary);
    await waitReachable();
    if (settings.profiles.everyday.model) await server().switchProfile('everyday', (text) => onProgress({ text }));
  } catch (err) {
    onProgress({ text: 'The new engine failed; going back to the previous one' });
    await swap(settings.binary);
    throw new Error(`The new engine did not work (${err.message}); the previous one is back in place.`);
  }
  for (const dir of engines.staleBuilds(current.build)) fs.rmSync(dir, { recursive: true, force: true });
  return { updated: true, from: current.tag, to: engines.tag };
}

async function waitReachable(timeoutMs = 60000) {
  const started = Date.now();
  for (;;) {
    try {
      return await server().routerModels();
    } catch (err) {
      if (Date.now() - started > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function dirBytes(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) total += fs.statSync(path.join(entry.parentPath || entry.path, entry.name)).size;
    }
  } catch {
  }
  return total;
}

// What uninstall would remove; personal data is only listed, never assumed.
const PERSONAL = ['leslie-settings.json', 'leslie-memory.json', 'leslie-conversations.json', 'leslie-people.json', 'faces',
  'leslie-animations.json', 'leslie-wardrobe.json', 'llama-server.json', 'setup-state.json', 'pi-manifest.json'];

function uninstallPlan() {
  return { modelsBytes: dirBytes(paths.MODELS), downloadsBytes: dirBytes(paths.ENGINES) + dirBytes(paths.SIDECARS) };
}

/**
 * Stop and remove the services setup wrote (a unit it replaced gets its
 * original back), the engine and Python services it downloaded, and the
 * launcher entry. Models and personal data only when asked.
 */
async function uninstall({ models = false, personal = false } = {}) {
  const saved = state.load() || { tasks: {} };
  const wrote = {
    router: saved.tasks.router && saved.tasks.router.status === 'done',
    vision: saved.tasks.vision && saved.tasks.vision.status === 'done',
    speech: saved.tasks.speech && saved.tasks.speech.status === 'done',
    app: saved.tasks.autostart && saved.tasks.autostart.status === 'done'
  };
  for (const [key, did] of Object.entries(wrote)) {
    if (!did) continue;
    const name = units.NAMES[key];
    const file = units.unitPath(name);
    const backup = `${file}.before-setup`;
    if (fs.existsSync(backup)) {
      await units.systemctl('stop', name);
      fs.renameSync(backup, file);
      await units.systemctl('daemon-reload');
    } else {
      await units.remove([name]);
    }
  }
  if (saved.tasks.launcher && saved.tasks.launcher.status === 'done') desktop.removeLauncher();
  fs.rmSync(paths.ENGINES, { recursive: true, force: true });
  fs.rmSync(paths.SIDECARS, { recursive: true, force: true });
  if (models) fs.rmSync(paths.MODELS, { recursive: true, force: true });
  if (personal) for (const name of PERSONAL) fs.rmSync(path.join(paths.CONFIG, name), { recursive: true, force: true });
  else state.save({ ...state.fresh(), uninstalled: true });
  if (fs.existsSync(paths.DATA) && !fs.readdirSync(paths.DATA).length) fs.rmdirSync(paths.DATA);
}

module.exports = { SECTIONS, engineOf, status, repair, updateEngine, uninstallPlan, uninstall };

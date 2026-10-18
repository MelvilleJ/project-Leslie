'use strict';

// Default setup choices for the detected hardware; the setup window and
// leslie-setup both start from these.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const hardware = require('./hardware');
const catalog = require('./catalog');

// Speech recognition takes about 1 GB; below this it would crowd the model.
const SPEECH_ON_GPU_MIB = 10 * 1024;

function defaultChoices(gpus) {
  const build = hardware.chooseBuild(gpus, { rocm: fs.existsSync('/opt/rocm') });
  const tiers = hardware.tiers(gpus);
  const everyday = catalog.recommended(tiers.everyday);
  const power = tiers.power ? catalog.recommended(tiers.power) : null;
  const nvidia = gpus.filter((g) => g.vendor === 'nvidia' && !g.driverMissing);
  const runtime = nvidia.length ? 'cuda' : 'cpu';
  return {
    engine: { mode: 'download', build },
    everyday: everyday ? everyday.id : '',
    power: power && everyday && power.id !== everyday.id ? power.id : '',
    tiers,
    modelsDir: path.join(paths.MODELS, 'llm'),
    packages: [],
    speech: { enabled: true, runtime: nvidia.some((g) => g.vramMiB >= SPEECH_ON_GPU_MIB) ? 'cuda' : 'cpu' },
    vision: { enabled: false, runtime },
    settings: {},
    launcher: false,
    startAtLogin: true,
    adopt: false
  };
}

/** Bytes still to download for these choices (models plus engine). */
function downloadBytes(c) {
  const engines = require('./engines');
  let n = 0;
  for (const id of new Set([c.everyday, c.power].filter(Boolean))) {
    const model = catalog.find(id);
    if (model && !fs.existsSync(path.join(c.modelsDir, model.id, model.files[0].name))) n += catalog.totalBytes(model);
  }
  if (c.engine.mode === 'download' && !engines.serverFor(c.engine.build)) {
    n += (engines.builds().find((b) => b.id === c.engine.build) || { bytes: 0 }).bytes;
  }
  return n;
}

module.exports = { defaultChoices, downloadBytes };

'use strict';

// Prebuilt llama.cpp releases, one folder per build under
// ~/.local/share/leslie/engines/llama.cpp. The version is pinned per LESLIE
// release (pins.json); nightly builds are not followed.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const pins = require('./pins.json');
const { download } = require('./download');
const { must } = require('./exec');

const { llamaCpp } = pins;

const builds = () => Object.entries(llamaCpp.builds).map(([id, b]) => ({ id, label: b.label, bytes: b.files.reduce((n, f) => n + f.bytes, 0) }));

const buildDir = (build) => path.join(paths.ENGINES, 'llama.cpp', `${llamaCpp.tag}-${build}`);

function findServer(dir) {
  for (const rel of ['llama-server', ...safeList(dir).map((d) => path.join(d, 'llama-server'))]) {
    const full = path.join(dir, rel);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** The installed llama-server for a build, or null. */
const serverFor = (build) => findServer(buildDir(build));

/**
 * Download and unpack a build; resolves to its llama-server path. The CUDA
 * builds come as two archives, and the runtime libraries must sit next to
 * llama-server (it looks in $ORIGIN).
 */
async function install(build, { onProgress = () => {}, signal } = {}) {
  const spec = llamaCpp.builds[build];
  if (!spec) throw new Error(`Unknown llama.cpp build ${build}`);
  const existing = serverFor(build);
  if (existing) return existing;

  const dir = buildDir(build);
  const archives = `${dir}.download`;
  const staging = `${dir}.partial`;
  const total = spec.files.reduce((n, f) => n + f.bytes, 0);
  let before = 0;
  for (const file of spec.files) {
    const url = llamaCpp.url.replace('{tag}', llamaCpp.tag).replace('{file}', file.name);
    await download(url, path.join(archives, file.name), {
      bytes: file.bytes,
      sha256: file.sha256,
      signal,
      onProgress: ({ done }) => onProgress({ text: `Downloading the ${spec.label} engine`, done: before + done, total })
    });
    before += file.bytes;
  }

  onProgress({ text: 'Unpacking the engine' });
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const file of spec.files) await must('tar', ['-xzf', path.join(archives, file.name), '-C', staging], { timeout: 300000, signal });
  const server = findServer(staging);
  if (!server) throw new Error('The engine archive has no llama-server in it.');
  const serverDir = path.dirname(server);
  for (const entry of safeList(staging)) {
    const full = path.join(staging, entry);
    if (full === serverDir || !fs.statSync(full).isDirectory()) continue;
    for (const lib of safeList(full)) fs.renameSync(path.join(full, lib), path.join(serverDir, lib));
    fs.rmSync(full, { recursive: true, force: true });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
  fs.rmSync(archives, { recursive: true, force: true });
  return serverFor(build);
}

/** Builds other than `keep` that are installed (left behind by an engine update). */
function staleBuilds(keep) {
  const root = path.join(paths.ENGINES, 'llama.cpp');
  return safeList(root).filter((d) => !d.endsWith('.download') && !d.endsWith('.partial') && d !== path.basename(buildDir(keep))).map((d) => path.join(root, d));
}

module.exports = { tag: llamaCpp.tag, builds, buildDir, serverFor, install, staleBuilds };

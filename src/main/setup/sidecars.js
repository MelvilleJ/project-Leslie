'use strict';

// The Python services (vision, speech), each in its own uv virtualenv under
// ~/.local/share/leslie/sidecars. uv also fetches the Python they need, so the
// system Python never matters.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const pins = require('./pins.json');
const { download, sha256Of } = require('./download');
const { must, run, which } = require('./exec');

const PYTHON = '3.12';

async function ensureUv({ onProgress = () => {}, signal } = {}) {
  const system = which('uv');
  if (system) return system;
  const dir = path.join(paths.ENGINES, 'uv');
  const bin = path.join(dir, 'uv');
  if (fs.existsSync(bin)) return bin;
  const archive = path.join(paths.ENGINES, 'uv.tar.gz');
  await download(pins.uv.url, archive, {
    bytes: pins.uv.bytes,
    sha256: pins.uv.sha256,
    signal,
    onProgress: ({ done, total }) => onProgress({ text: 'Downloading uv', done, total })
  });
  fs.mkdirSync(dir, { recursive: true });
  await must('tar', ['-xzf', archive, '-C', dir, '--strip-components=1']);
  fs.rmSync(archive, { force: true });
  return bin;
}

// pip builds the package in its source folder, and the app's own copy may be
// read-only (/usr/lib/leslie), so build from a copy.
function stageSource(name) {
  const src = path.join(paths.RESOURCES, name);
  const dest = path.join(paths.SIDECARS, `${name}-src`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => !/(^|\/)(build|tests|__pycache__|\.pytest_cache|[^/]*\.egg-info|\.venv|uv\.lock)$/.test(p)
  });
  return dest;
}

/**
 * Create or refresh a sidecar venv with one runtime extra (cuda or cpu). Both
 * extras of a package can provide the same module (onnxruntime and
 * onnxruntime-gpu), so the other extra's packages are removed first.
 */
async function installVenv(name, runtime, conflicting, { onProgress = () => {}, signal } = {}) {
  const uv = await ensureUv({ onProgress, signal });
  const venv = path.join(paths.SIDECARS, name);
  const env = { VIRTUAL_ENV: venv };
  onProgress({ text: `Preparing Python for ${name}` });
  await must(uv, ['venv', '-q', '--allow-existing', '--python', PYTHON, venv], { timeout: 600000, signal });
  if (conflicting.length) await run(uv, ['pip', 'uninstall', '-q', ...conflicting], { env, signal });
  onProgress({ text: `Installing the ${name} service (${runtime === 'cuda' ? 'GPU' : 'CPU'}), this can take a few minutes` });
  const src = stageSource(name);
  await must(uv, ['pip', 'install', '-q', '--reinstall-package', `leslie-${name}`, `${src}[${runtime}]`], { env, timeout: 30 * 60000, signal });
  return venv;
}

async function installVision(runtime, { onProgress = () => {}, signal } = {}) {
  const venv = await installVenv('vision', runtime, [runtime === 'cuda' ? 'onnxruntime' : 'onnxruntime-gpu'], { onProgress, signal });
  const dir = path.join(paths.MODELS, 'vision');
  const { faces, files } = pins.vision;
  for (const f of files) {
    await download(f.url, path.join(dir, f.name), {
      bytes: f.bytes,
      sha256: f.sha256,
      signal,
      onProgress: ({ done, total }) => onProgress({ text: `Downloading ${f.name}`, done, total })
    });
  }
  const missing = faces.extract.filter((f) => !fs.existsSync(path.join(dir, f.name)));
  if (missing.length) {
    const zip = path.join(dir, 'buffalo_l.zip');
    await download(faces.url, zip, {
      bytes: faces.bytes,
      signal,
      onProgress: ({ done, total }) => onProgress({ text: 'Downloading the face models', done, total })
    });
    const out = path.join(dir, 'buffalo_l');
    await must(path.join(venv, 'bin', 'python'), ['-I', '-m', 'zipfile', '-e', zip, out], { timeout: 300000, signal });
    for (const f of missing) {
      const found = fs.readdirSync(out, { recursive: true }).find((p) => path.basename(String(p)) === f.name);
      if (!found) throw new Error(`${f.name} is missing from the face model archive.`);
      // The archive has no published checksum, so its contents are checked instead.
      if ((await sha256Of(path.join(out, String(found)))) !== f.sha256) throw new Error(`${f.name} did not match its checksum.`);
      fs.renameSync(path.join(out, String(found)), path.join(dir, f.name));
    }
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
  }
  return { venv, modelsDir: dir };
}

async function installSpeech(runtime, { onProgress = () => {}, signal } = {}) {
  const venv = await installVenv('speech', runtime, [], { onProgress, signal });
  const dir = path.join(paths.MODELS, 'speech');
  onProgress({ text: 'Downloading the Whisper model' });
  await must(path.join(venv, 'bin', 'leslie-speech'), ['--download-only', '--device', runtime, '--models', dir], { timeout: 30 * 60000, signal });
  return { venv, modelsDir: dir };
}

module.exports = { ensureUv, installVenv, installVision, installSpeech, stageSource };

'use strict';

// Bundles the voice pipeline (transformers.js + the mic/VAD code) into a single
// ESM bundle for the hidden voice window, and copies the onnxruntime-web wasm
// assets next to it (referenced at runtime via env.backends.onnx.wasm.wasmPaths).

const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const ORT_DIR = path.join(RENDERER, 'ort');

async function main() {
  await esbuild.build({
    entryPoints: { 'voice.bundle': path.join(ROOT, 'src', 'voice', 'voice.js') },
    bundle: true,
    format: 'esm',
    splitting: true, // needed for transformers.js dynamic imports
    outdir: RENDERER,
    chunkNames: 'voice-chunk-[hash]',
    platform: 'browser',
    target: ['chrome124'],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'info'
  });

  // Copy ORT wasm/mjs assets so the renderer can load them from ./ort/ (no CDN).
  fs.mkdirSync(ORT_DIR, { recursive: true });
  const sources = [
    path.join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist'),
    path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist')
  ];
  let copied = 0;
  for (const dir of sources) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (/\.(wasm|mjs)$/i.test(file) && /ort|wasm/i.test(file)) {
        fs.copyFileSync(path.join(dir, file), path.join(ORT_DIR, file));
        copied++;
      }
    }
  }
  console.log(`build:voice — copied ${copied} ORT asset(s) to src/renderer/ort/`);
  if (copied === 0) {
    console.warn('build:voice — WARNING: no ORT wasm assets found; voice may fall back to CDN.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

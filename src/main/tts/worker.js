'use strict';

// Electron utility process: runs Kokoro-82M on the CPU so synthesis never blocks
// the main process. Requests are handled one at a time, in order.

const { createRequire } = require('node:module');

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
// fp32 is ~3x faster than q8 on desktop CPUs (onnxruntime's int8 kernels lose to its fp32 ones here).
const DTYPE = 'fp32';

let ttsPromise = null;
let queue = Promise.resolve();
let cancelledBefore = 0;

function loadModel(cacheDir) {
  if (!ttsPromise) {
    ttsPromise = (async () => {
      const { KokoroTTS } = require('kokoro-js');
      // kokoro-js's own `env` isn't transformers'; set the cache on the copy it loads,
      // or downloads land inside the (read-only) app archive.
      const { env } = createRequire(require.resolve('kokoro-js'))('@huggingface/transformers');
      if (cacheDir) env.cacheDir = cacheDir;
      return KokoroTTS.from_pretrained(MODEL_ID, { dtype: DTYPE, device: 'cpu' });
    })();
    ttsPromise.catch(() => {
      ttsPromise = null;
    });
  }
  return ttsPromise;
}

async function synthesize({ id, text, voice, speed, cacheDir }) {
  if (id <= cancelledBefore) return { id, cancelled: true };
  const tts = await loadModel(cacheDir);
  if (id <= cancelledBefore) return { id, cancelled: true };
  const audio = await tts.generate(text, { voice, speed });
  return { id, samples: audio.audio, sampleRate: audio.sampling_rate };
}

process.parentPort.on('message', ({ data: msg }) => {
  if (!msg) return;
  if (msg.type === 'cancel') {
    cancelledBefore = Math.max(cancelledBefore, msg.upTo);
    return;
  }
  if (msg.type === 'warm') {
    loadModel(msg.cacheDir).then(
      () => process.parentPort.postMessage({ type: 'ready' }),
      (err) => process.parentPort.postMessage({ type: 'error', error: String(err && err.message ? err.message : err) })
    );
    return;
  }
  if (msg.type !== 'speak') return;
  queue = queue.then(() =>
    synthesize(msg).then(
      (res) => process.parentPort.postMessage({ type: 'audio', ...res }),
      (err) => process.parentPort.postMessage({ type: 'audio', id: msg.id, error: String(err && err.message ? err.message : err) })
    )
  );
});

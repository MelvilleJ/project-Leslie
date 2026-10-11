'use strict';

import { pipeline, env } from '@huggingface/transformers';
import wake from './wakeword.js';

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = './ort/';
env.backends.onnx.wasm.numThreads = 1;

const bridge = window.voiceBridge;

let BACKEND = 'local';
let MODEL = 'Xenova/whisper-tiny.en';
let SERVER_URL = 'http://localhost:8080/v1';
let SERVER_MODEL = 'whisper-1';
let SERVER_API_KEY = '';
let WAKE = 'hey leslie';
let WAKE_TIMEOUT_MS = 8000;

let active = true;
// True while LESLIE's own speech is playing: drop mic input so she doesn't transcribe herself.
let selfSpeaking = false;
let awakeUntil = 0;
let transcriber = null;
let audioCtx = null;
let micStream = null;
let sampleRate = 16000;

const status = (state, message, progress) => bridge.status({ state, message, progress });

// Aggregate transformers.js download events into single 0–100 progress.
function makeProgress() {
  const files = new Map();
  let last = -1;
  return (e) => {
    if (!e || !e.file) return;
    if (typeof e.total === 'number' && e.total > 0) {
      files.set(e.file, { loaded: e.loaded || 0, total: e.total });
    }
    if (e.status === 'done') {
      const f = files.get(e.file);
      if (f) f.loaded = f.total;
    }
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    if (!total) return;
    const pct = Math.min(100, Math.round((loaded / total) * 100));
    if (pct !== last) {
      last = pct;
      status('loading', 'Loading speech model…', pct);
    }
  };
}

const JUNK = new Set(['', 'you', 'thank you.', 'thanks for watching!', '[blank_audio]', '(silence)']);
function isJunk(text) {
  const t = text.trim().toLowerCase();
  return t.length < 2 || JUNK.has(t);
}

// Probe for GPU; fall back to WASM if WebGPU unavailable.
async function pickDevice() {
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    }
  } catch {}
  return 'wasm';
}

async function getTranscriber() {
  if (transcriber) return transcriber;
  status('loading', 'Loading speech model…', 0);
  const device = await pickDevice();
  const progress_callback = makeProgress();
  // Use fp32 to avoid quantization issue with MatMulNBits weights.
  const dtype = 'fp32';
  try {
    transcriber = await pipeline('automatic-speech-recognition', MODEL, { device, dtype, progress_callback });
  } catch (err) {
    if (device === 'wasm') throw err;
    transcriber = await pipeline('automatic-speech-recognition', MODEL, { device: 'wasm', dtype, progress_callback });
  }
  status('idle');
  return transcriber;
}

async function transcribeLocal(samples) {
  const t = await getTranscriber();
  const out = await t(samples, { chunk_length_s: 30, return_timestamps: false });
  return (out && out.text ? out.text : '').trim();
}

function encodeWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

async function transcribeServer(samples) {
  const form = new FormData();
  form.append('file', encodeWav(samples, sampleRate), 'audio.wav');
  form.append('model', SERVER_MODEL);
  form.append('response_format', 'json');
  const headers = {};
  if (SERVER_API_KEY) headers['Authorization'] = `Bearer ${SERVER_API_KEY}`;
  const url = SERVER_URL.replace(/\/+$/, '') + '/audio/transcriptions';
  const res = await fetch(url, { method: 'POST', headers, body: form });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {}
    throw new Error(`STT server ${res.status} ${res.statusText}${detail ? ': ' + detail : ''}`);
  }
  const data = await res.json();
  return (data && typeof data.text === 'string' ? data.text : '').trim();
}

const isAwake = () => Date.now() < awakeUntil;

// Every sound above the VAD threshold is transcribed to scan for the wake word;
// only report it once she has actually been woken, or the mascot "listens" to noise.
async function transcribe(samples) {
  const awake = isAwake();
  if (awake) status('transcribing');
  try {
    return BACKEND === 'server'
      ? await transcribeServer(samples)
      : await transcribeLocal(samples);
  } finally {
    if (awake) status('idle');
  }
}

let wakeTimer = null;

function wakeUp(now) {
  awakeUntil = now + WAKE_TIMEOUT_MS;
  status('listening');
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    if (awakeUntil && !isAwake()) {
      awakeUntil = 0;
      status('idle');
    }
  }, WAKE_TIMEOUT_MS + 50);
}

function sleep() {
  awakeUntil = 0;
  clearTimeout(wakeTimer);
}

async function handleUtterance(samples) {
  if (!active) return;
  let text;
  try {
    text = await transcribe(samples);
  } catch (err) {
    status('error', String(err && err.message ? err.message : err));
    return;
  }
  const now = Date.now();
  if (now < awakeUntil) {
    if (isJunk(text)) return;
    sleep();
    bridge.final({ text });
    return;
  }
  if (isJunk(text)) return;

  const { matched, command } = wake.detectWake(text, WAKE);
  if (!matched) return;

  if (command) {
    bridge.wake({ command });
    bridge.final({ text: command });
  } else {
    bridge.wake({ command: '' });
    wakeUp(now);
  }
}

const FRAME = 4096;
const SPEECH_RMS = 0.012;
const SILENCE_MS = 600;
const MIN_MS = 300;
const MAX_MS = 15000;

async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  });

  audioCtx = new AudioContext({ sampleRate: 16000 });
  await audioCtx.resume();
  const source = audioCtx.createMediaStreamSource(micStream);
  const node = audioCtx.createScriptProcessor(FRAME, 1, 1);

  const rate = audioCtx.sampleRate;
  sampleRate = rate;
  const frameMs = (FRAME / rate) * 1000;
  let speaking = false;
  let silenceMs = 0;
  let chunks = [];
  let durMs = 0;

  const flush = () => {
    const collected = chunks;
    chunks = [];
    speaking = false;
    silenceMs = 0;
    const total = collected.reduce((n, c) => n + c.length, 0);
    if ((total / rate) * 1000 < MIN_MS) return;
    const samples = new Float32Array(total);
    let off = 0;
    for (const c of collected) {
      samples.set(c, off);
      off += c.length;
    }
    handleUtterance(samples);
  };

  node.onaudioprocess = (e) => {
    if (!active) {
      if (speaking) flush();
      return;
    }
    if (selfSpeaking) {
      chunks = [];
      speaking = false;
      silenceMs = 0;
      return;
    }
    const input = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);

    if (rms >= SPEECH_RMS) {
      if (!speaking) {
        speaking = true;
        durMs = 0;
      }
      chunks.push(new Float32Array(input));
      silenceMs = 0;
      durMs += frameMs;
      if (durMs >= MAX_MS) flush();
    } else if (speaking) {
      chunks.push(new Float32Array(input));
      silenceMs += frameMs;
      durMs += frameMs;
      if (silenceMs >= SILENCE_MS) flush();
    }
  };

  source.connect(node);
  node.connect(audioCtx.destination);
  status('idle');
}

bridge.onInit((cfg) => {
  if (cfg.sttBackend) BACKEND = cfg.sttBackend;
  if (cfg.sttModel) MODEL = cfg.sttModel;
  if (cfg.sttServerUrl) SERVER_URL = cfg.sttServerUrl;
  if (cfg.sttServerModel) SERVER_MODEL = cfg.sttServerModel;
  if (cfg.sttServerApiKey) SERVER_API_KEY = cfg.sttServerApiKey;
  if (cfg.wakeWord) WAKE = cfg.wakeWord;
  if (cfg.wakeTimeoutMs) WAKE_TIMEOUT_MS = cfg.wakeTimeoutMs;
  startMic().catch((err) => status('error', String(err && err.message ? err.message : err)));
});

bridge.onControl((msg) => {
  if (!msg) return;
  if (msg.action === 'set-active') {
    active = !!msg.value;
    if (!active) sleep();
    if (audioCtx) (active ? audioCtx.resume() : audioCtx.suspend());
    status(active ? 'idle' : 'off');
  } else if (msg.action === 'speaking') {
    selfSpeaking = !!msg.value;
  } else if (msg.action === 'listen-once') {
    active = true;
    if (audioCtx) audioCtx.resume();
    wakeUp(Date.now());
  }
});

'use strict';

// Voice pipeline (runs in the hidden voice window, bundled by esbuild).
//   mic -> energy VAD (segments speech) -> Whisper -> wake/command
// Whisper runs either locally (transformers.js) or on an external whisper server
// (OpenAI-compatible /audio/transcriptions), selected by sttBackend.
// Emits results to the main process via window.voiceBridge; the rest of the app
// never touches audio or the ML libs.

import { pipeline, env } from '@huggingface/transformers';
import wake from './wakeword.js';

// Load onnxruntime wasm assets from the local copy placed by build:voice.
env.allowLocalModels = false; // model weights still come from the HF hub (cached)
env.backends.onnx.wasm.wasmPaths = './ort/';
// Single-threaded WASM avoids needing SharedArrayBuffer / cross-origin isolation
// (not available on file:// without extra headers). WebGPU is used when present.
env.backends.onnx.wasm.numThreads = 1;

const bridge = window.voiceBridge;

// --- Config (provided by main on init) -------------------------------------
let BACKEND = 'local'; // 'local' (transformers.js) | 'server' (whisper server)
let MODEL = 'Xenova/whisper-tiny.en';
let SERVER_URL = 'http://localhost:8080/v1'; // base URL incl. /v1
let SERVER_MODEL = 'whisper-1';
let SERVER_API_KEY = '';
let WAKE = 'hey leslie';
let WAKE_TIMEOUT_MS = 8000;

// --- State -----------------------------------------------------------------
let active = true; // listening enabled
let awakeUntil = 0; // timestamp; while now < this we treat speech as a command
let transcriber = null;
let audioCtx = null;
let micStream = null;
let sampleRate = 16000; // actual mic/AudioContext rate, set in startMic

const status = (state, message) => bridge.status({ state, message });

// Whisper sometimes "hears" boilerplate on silence; ignore obvious junk.
const JUNK = new Set(['', 'you', 'thank you.', 'thanks for watching!', '[blank_audio]', '(silence)']);
function isJunk(text) {
  const t = text.trim().toLowerCase();
  return t.length < 2 || JUNK.has(t);
}

async function getTranscriber() {
  if (transcriber) return transcriber;
  status('loading', 'Loading speech model…');
  try {
    transcriber = await pipeline('automatic-speech-recognition', MODEL, { device: 'webgpu' });
  } catch (err) {
    // WebGPU unavailable — fall back to WASM.
    transcriber = await pipeline('automatic-speech-recognition', MODEL, { device: 'wasm' });
  }
  status('idle');
  return transcriber;
}

async function transcribeLocal(samples) {
  const t = await getTranscriber();
  const out = await t(samples, { chunk_length_s: 30, return_timestamps: false });
  return (out && out.text ? out.text : '').trim();
}

// Encode mono Float32 PCM as a 16-bit WAV blob (what whisper servers expect).
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
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
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

async function transcribe(samples) {
  status('transcribing');
  try {
    return BACKEND === 'server'
      ? await transcribeServer(samples)
      : await transcribeLocal(samples);
  } finally {
    status('idle');
  }
}

// Decide what an utterance means and notify main.
async function handleUtterance(samples) {
  if (!active) return;
  let text;
  try {
    text = await transcribe(samples);
  } catch (err) {
    status('error', String(err && err.message ? err.message : err));
    return;
  }
  if (isJunk(text)) return;

  const now = Date.now();
  if (now < awakeUntil) {
    // Already woken — this utterance is the command.
    awakeUntil = 0;
    bridge.final({ text });
    return;
  }

  const { matched, command } = wake.detectWake(text, WAKE);
  if (!matched) return;

  if (command) {
    // "Hey Leslie, <command>" in one breath.
    bridge.wake({ command });
    bridge.final({ text: command });
  } else {
    // Just the wake word — show up and listen for the next utterance.
    awakeUntil = now + WAKE_TIMEOUT_MS;
    bridge.wake({ command: '' });
    status('listening');
  }
}

// --- Mic capture + energy VAD ----------------------------------------------
const FRAME = 4096; // ScriptProcessor buffer size
const SPEECH_RMS = 0.012; // amplitude threshold to count a frame as speech
const SILENCE_MS = 600; // trailing silence that ends an utterance
const MIN_MS = 300; // ignore blips shorter than this
const MAX_MS = 15000; // hard cap per utterance

async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  });

  audioCtx = new AudioContext({ sampleRate: 16000 });
  await audioCtx.resume();
  const source = audioCtx.createMediaStreamSource(micStream);
  const node = audioCtx.createScriptProcessor(FRAME, 1, 1);

  const rate = audioCtx.sampleRate;
  sampleRate = rate; // remember for WAV encoding (server backend)
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
      chunks.push(new Float32Array(input)); // keep a little trailing audio
      silenceMs += frameMs;
      durMs += frameMs;
      if (silenceMs >= SILENCE_MS) flush();
    }
  };

  source.connect(node);
  node.connect(audioCtx.destination); // required for ScriptProcessor to fire
  status('idle');
}

// --- Control from main ------------------------------------------------------
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
    if (audioCtx) (active ? audioCtx.resume() : audioCtx.suspend());
    status(active ? 'idle' : 'off');
  } else if (msg.action === 'listen-once') {
    // Manual push-to-talk: treat the next utterance as a command.
    active = true;
    if (audioCtx) audioCtx.resume();
    awakeUntil = Date.now() + WAKE_TIMEOUT_MS;
    status('listening');
  }
});

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
let mediaPlaying = false;
// Conversation mode: everything the user says is for her, no name needed.
let conversation = false;
let conversationTimer = null;
const CONVERSATION_IDLE_MS = 120000;
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

const JUNK = new Set(['', 'you', 'thank you.', 'thanks for watching!']);
// Whisper writes noises as "(coughing)", "[clicking]" or "*cough*", or as a lone "Hmm."
const SOUND_LABEL = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪/g;
const FILLER = /^(?:\s*\b(?:u+h+|u+m+|h?m+|a+h+|o+h+|hu+h+|ugh|mhm|uh-huh)\b[\s.,!?]*)+$/;
function isJunk(text) {
  const t = text.toLowerCase().replace(SOUND_LABEL, '').trim();
  return t.length < 2 || JUNK.has(t) || FILLER.test(t);
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
  const awake = isAwake() || conversation;
  if (awake) status('transcribing');
  try {
    return BACKEND === 'server'
      ? await transcribeServer(samples)
      : await transcribeLocal(samples);
  } finally {
    if (awake) status(conversation ? 'listening' : 'idle');
  }
}

function setConversation(on) {
  conversation = on;
  clearTimeout(conversationTimer);
  status(on ? 'listening' : 'idle');
  if (on) {
    conversationTimer = setTimeout(() => {
      setConversation(false);
      bridge.conversationEnded();
    }, CONVERSATION_IDLE_MS);
  }
}

const keepConversation = () => conversation && setConversation(true);

let wakeTimer = null;

function wakeUp(now) {
  awakeUntil = now + WAKE_TIMEOUT_MS;
  status('listening');
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    if (awakeUntil && !isAwake()) {
      awakeUntil = 0;
      status(conversation ? 'listening' : 'idle');
    }
  }, WAKE_TIMEOUT_MS + 50);
}

function sleep() {
  awakeUntil = 0;
  clearTimeout(wakeTimer);
}

// What she has said lately, to recognise her own voice coming back from the speakers.
const SAID_MS = 30000;
let said = [];

// Short words (a, it, is) turn up in everyone's speech, so they say nothing about who spoke.
const wordsOf = (text) => String(text).toLowerCase().match(/[a-z0-9']{3,}/g) || [];

function rememberSaid(text) {
  const now = Date.now();
  said = said.filter((s) => now - s.at < SAID_MS);
  said.push({ at: now, words: new Set(wordsOf(text)) });
}

/** Share of the transcript's words that she said herself recently (0 = all the user). */
function echoShare(text) {
  const words = wordsOf(text);
  if (!words.length) return 1;
  const hers = words.filter((w) => said.some((s) => s.words.has(w))).length;
  return hers / words.length;
}

const ECHO_SHARE = 0.6;
const CLEAN_SHARE = 0.2;

// `overSpeech`: she was talking while this was recorded, so it may be her own
// voice from the speakers. Only her name at the start can interrupt her.
async function handleUtterance(samples, { startedAt, overSpeech }) {
  if (!active) return;
  let text;
  try {
    text = await transcribe(samples);
  } catch (err) {
    status('error', String(err && err.message ? err.message : err));
    return;
  }
  const now = Date.now();
  if (conversation && !overSpeech && !mediaPlaying) {
    if (isJunk(text) || echoShare(text) >= ECHO_SHARE) return;
    const { matched, command } = wake.detectWake(text, WAKE);
    const request = matched ? command : text;
    if (!request) return;
    keepConversation();
    bridge.final({ text: request });
    return;
  }
  if (!overSpeech && startedAt < awakeUntil) {
    if (isJunk(text)) return;
    sleep();
    bridge.final({ text });
    return;
  }
  if (isJunk(text)) return;

  const { matched, command } = wake.detectWake(text, WAKE, { anywhere: mediaPlaying });
  if (!matched) {
    if (overSpeech && !mediaPlaying) interrupt(text, now);
    return;
  }

  if (command) {
    bridge.wake({ command });
    bridge.final({ text: command });
  } else {
    bridge.wake({ command: '' });
    wakeUp(now);
  }
}

// The user talked over her: stop her and listen. If what was heard is clearly
// just them, it is the request itself; if it is mixed with her voice, ask again.
function interrupt(text, now) {
  const share = echoShare(text);
  if (share >= ECHO_SHARE) return;
  bridge.wake({ command: '', interrupt: true });
  if (share <= CLEAN_SHARE) bridge.final({ text });
  else wakeUp(now);
}

const FRAME = 4096;
const SPEECH_RMS = 0.012;
const SILENCE_MS = 600;
// Only loud stretches count: a chair click or a tap is a few tens of ms, a short "yes" is several hundred.
const MIN_VOICED_MS = 200;
const BLOCK = 512;
const MAX_MS = 15000;
// A video rarely goes quiet, so without a cap every utterance runs to MAX_MS.
const MEDIA_MAX_MS = 5000;

// At login the app can start before PipeWire has the mic ready, and a mic can be
// unplugged or PipeWire restarted later; keep trying instead of giving up once.
const MIC_RETRY_MAX_MS = 30000;
let micStarting = false;
let micFailing = false;

function stopMic() {
  if (micStream) for (const track of micStream.getTracks()) track.stop();
  micStream = null;
  if (audioCtx) audioCtx.close().catch(() => {});
  audioCtx = null;
}

async function ensureMic(retryMs = 1000) {
  if (micStream || micStarting) return;
  micStarting = true;
  try {
    await startMic();
    micFailing = false;
  } catch (err) {
    stopMic();
    if (!micFailing) status('error', `Microphone unavailable (${err && err.message ? err.message : err}); retrying.`);
    micFailing = true;
    setTimeout(() => ensureMic(Math.min(retryMs * 2, MIC_RETRY_MAX_MS)), retryMs);
  } finally {
    micStarting = false;
  }
}

navigator.mediaDevices.addEventListener('devicechange', () => ensureMic());

async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  });
  for (const track of micStream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      stopMic();
      status('error', 'Microphone disconnected; reconnecting.');
      micFailing = true;
      ensureMic();
    });
  }

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
  let voicedMs = 0;
  let startedAt = 0;
  let overSpeech = false;

  const flush = () => {
    const collected = chunks;
    const utterance = { startedAt, overSpeech };
    const voiced = voicedMs;
    chunks = [];
    speaking = false;
    silenceMs = 0;
    voicedMs = 0;
    if (voiced < MIN_VOICED_MS) return;
    const total = collected.reduce((n, c) => n + c.length, 0);
    const samples = new Float32Array(total);
    let off = 0;
    for (const c of collected) {
      samples.set(c, off);
      off += c.length;
    }
    handleUtterance(samples, utterance);
  };

  node.onaudioprocess = (e) => {
    if (!active) {
      if (speaking) flush();
      return;
    }
    const input = e.inputBuffer.getChannelData(0);
    let sum = 0;
    let loudBlocks = 0;
    for (let b = 0; b < input.length; b += BLOCK) {
      let blockSum = 0;
      for (let i = b; i < b + BLOCK; i++) blockSum += input[i] * input[i];
      sum += blockSum;
      if (Math.sqrt(blockSum / BLOCK) >= SPEECH_RMS) loudBlocks++;
    }
    const rms = Math.sqrt(sum / input.length);

    if (selfSpeaking && speaking) overSpeech = true;
    if (rms >= SPEECH_RMS) {
      if (!speaking) {
        speaking = true;
        durMs = 0;
        startedAt = Date.now() - frameMs;
        overSpeech = selfSpeaking;
      }
      chunks.push(new Float32Array(input));
      silenceMs = 0;
      durMs += frameMs;
      voicedMs += (loudBlocks * BLOCK * 1000) / rate;
      if (durMs >= (mediaPlaying ? MEDIA_MAX_MS : MAX_MS)) flush();
    } else if (speaking) {
      chunks.push(new Float32Array(input));
      silenceMs += frameMs;
      durMs += frameMs;
      if (silenceMs >= SILENCE_MS) flush();
    }
  };

  source.connect(node);
  node.connect(audioCtx.destination);
  if (!active) await audioCtx.suspend();
  status(active ? 'idle' : 'off');
}

bridge.onInit((cfg) => {
  if (cfg.sttBackend) BACKEND = cfg.sttBackend;
  if (cfg.sttModel) MODEL = cfg.sttModel;
  if (cfg.sttServerUrl) SERVER_URL = cfg.sttServerUrl;
  if (cfg.sttServerModel) SERVER_MODEL = cfg.sttServerModel;
  if (cfg.sttServerApiKey) SERVER_API_KEY = cfg.sttServerApiKey;
  if (cfg.wakeWord) WAKE = cfg.wakeWord;
  if (cfg.wakeTimeoutMs) WAKE_TIMEOUT_MS = cfg.wakeTimeoutMs;
  ensureMic();
});

bridge.onControl((msg) => {
  if (!msg) return;
  if (msg.action === 'set-active') {
    active = !!msg.value;
    if (!active) sleep();
    if (!active && conversation) {
      setConversation(false);
      bridge.conversationEnded();
    }
    if (audioCtx) (active ? audioCtx.resume() : audioCtx.suspend());
    status(active ? 'idle' : 'off');
  } else if (msg.action === 'speaking') {
    selfSpeaking = !!msg.value;
    if (!selfSpeaking) keepConversation();
  } else if (msg.action === 'conversation') {
    setConversation(!!msg.value);
  } else if (msg.action === 'media') {
    mediaPlaying = !!msg.value;
  } else if (msg.action === 'said') {
    rememberSaid(msg.value);
  } else if (msg.action === 'listen-once') {
    active = true;
    if (audioCtx) audioCtx.resume();
    wakeUp(Date.now());
  }
});

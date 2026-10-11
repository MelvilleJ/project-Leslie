'use strict';

// Kokoro-82M v1.0 English voices, best-rated first within each accent (grades from the model card).
const VOICES = [
  ['af_heart', 'Heart', 'US', 'female', 'A'],
  ['af_bella', 'Bella', 'US', 'female', 'A-'],
  ['af_nicole', 'Nicole', 'US', 'female', 'B-'],
  ['af_aoede', 'Aoede', 'US', 'female', 'C+'],
  ['af_kore', 'Kore', 'US', 'female', 'C+'],
  ['af_sarah', 'Sarah', 'US', 'female', 'C+'],
  ['af_alloy', 'Alloy', 'US', 'female', 'C'],
  ['af_nova', 'Nova', 'US', 'female', 'C'],
  ['af_sky', 'Sky', 'US', 'female', 'C-'],
  ['af_jessica', 'Jessica', 'US', 'female', 'D'],
  ['af_river', 'River', 'US', 'female', 'D'],
  ['am_fenrir', 'Fenrir', 'US', 'male', 'C+'],
  ['am_michael', 'Michael', 'US', 'male', 'C+'],
  ['am_puck', 'Puck', 'US', 'male', 'C+'],
  ['am_echo', 'Echo', 'US', 'male', 'D'],
  ['am_eric', 'Eric', 'US', 'male', 'D'],
  ['am_liam', 'Liam', 'US', 'male', 'D'],
  ['am_onyx', 'Onyx', 'US', 'male', 'D'],
  ['am_santa', 'Santa', 'US', 'male', 'D-'],
  ['am_adam', 'Adam', 'US', 'male', 'F+'],
  ['bf_emma', 'Emma', 'UK', 'female', 'B-'],
  ['bf_isabella', 'Isabella', 'UK', 'female', 'C'],
  ['bf_alice', 'Alice', 'UK', 'female', 'D'],
  ['bf_lily', 'Lily', 'UK', 'female', 'D'],
  ['bm_fable', 'Fable', 'UK', 'male', 'C'],
  ['bm_george', 'George', 'UK', 'male', 'C'],
  ['bm_lewis', 'Lewis', 'UK', 'male', 'D+'],
  ['bm_daniel', 'Daniel', 'UK', 'male', 'D']
].map(([id, name, accent, gender, grade]) => ({ id, label: `${name} — ${accent} ${gender} (${grade})` }));

const DEFAULT_VOICE = 'af_heart';

module.exports = { VOICES, DEFAULT_VOICE };

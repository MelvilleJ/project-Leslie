'use strict';

// Screen recording on Wayland (Hyprland) via wf-recorder: one monitor, optional
// audio, hardware H.264 through VAAPI with a software fallback. Stopping sends
// SIGINT so wf-recorder finalizes the file.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const config = require('../config');
const hyprland = require('../hyprland');

const STARTUP_CHECK_MS = 1500;
const STOP_TIMEOUT_MS = 8000;

const events = new EventEmitter();
let rec = null; // { child, file, monitor, startedAt }

function videosDir() {
  try {
    const dir = execFileSync('xdg-user-dir', ['VIDEOS'], { encoding: 'utf8' }).trim();
    if (dir && dir !== os.homedir()) return dir;
  } catch {
  }
  return path.join(os.homedir(), 'Videos');
}

function outputFile() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const dir = path.join(videosDir(), 'Recordings');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `Leslie ${stamp}.mp4`);
}

function audioSource(kind) {
  if (kind === 'none') return null;
  try {
    const pactl = (what) => execFileSync('pactl', [what], { encoding: 'utf8' }).trim();
    return kind === 'mic' ? pactl('get-default-source') : `${pactl('get-default-sink')}.monitor`;
  } catch {
    return null;
  }
}

// NVIDIA's driver has no VAAPI, so the default is the first render node on another GPU.
function renderNode() {
  if (config.recordRenderNode) return config.recordRenderNode;
  try {
    for (const node of fs.readdirSync('/sys/class/drm').filter((d) => /^renderD\d+$/.test(d)).sort()) {
      if (fs.readFileSync(`/sys/class/drm/${node}/device/vendor`, 'utf8').trim() !== '0x10de') return `/dev/dri/${node}`;
    }
  } catch {
  }
  return null;
}

function encoderArgs(hardware) {
  const node = hardware && renderNode();
  if (!node) return ['-c', 'libx264', '-p', 'preset=veryfast', '-p', 'crf=23'];
  return ['-c', 'h264_vaapi', '-d', node];
}

function publish() {
  events.emit('change', rec ? { recording: true, file: rec.file, monitor: rec.monitor, startedAt: rec.startedAt } : { recording: false });
}

/** Spawn wf-recorder; resolves once it has survived the first moments (bad encoders die fast). */
function spawnRecorder(file, monitor, audio, hardware) {
  const args = [...(monitor ? ['-o', monitor] : []), '-f', file, '-y', ...encoderArgs(hardware)];
  if (audio) args.push(`--audio=${audio}`);
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn('wf-recorder', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-2000);
    });
    const timer = setTimeout(() => resolve(child), STARTUP_CHECK_MS);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error('wf-recorder is not installed (sudo pacman -S wf-recorder).') : err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`wf-recorder exited (${code}): ${stderr.trim().split('\n').slice(-2).join(' ')}`));
    });
  });
}

async function start({ audio = 'desktop' } = {}) {
  if (rec) return { recording: true, already: true, file: rec.file };
  if (process.platform !== 'linux') throw new Error('Screen recording is only set up for Linux/Wayland.');
  const monitor = config.recordMonitor || (await hyprland.focusedMonitor());
  const file = outputFile();
  const source = audioSource(audio);
  let child;
  try {
    child = await spawnRecorder(file, monitor, source, true);
  } catch (err) {
    if (/not installed/.test(err.message)) throw err;
    child = await spawnRecorder(file, monitor, source, false);
  }
  rec = { child, file, monitor, startedAt: Date.now() };
  child.once('exit', () => {
    if (rec && rec.child === child) {
      rec = null;
      publish();
    }
  });
  publish();
  return { recording: true, file, monitor, audio: source ? audio : 'none' };
}

async function stop() {
  if (!rec) return { recording: false, note: 'Nothing was being recorded.' };
  const { child, file, startedAt } = rec;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGINT');
  const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
  await exited;
  clearTimeout(timer);
  rec = null;
  publish();
  return { recording: false, file, seconds: Math.round((Date.now() - startedAt) / 1000) };
}

function status() {
  return rec
    ? { recording: true, file: rec.file, seconds: Math.round((Date.now() - rec.startedAt) / 1000) }
    : { recording: false };
}

module.exports = {
  name: 'screen_record',
  readOnly: false,
  description:
    "Record the user's screen (their main monitor) to a video file. Use when the user asks to " +
    'start, stop, or check a screen recording ("start recording", "record my screen", "stop recording"). ' +
    'Starting is instant; the video is saved in Videos/Recordings when stopped.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'What to do.' },
      audio: {
        type: 'string',
        enum: ['desktop', 'mic', 'none'],
        description: "Audio to include when starting: computer sound (default), the microphone, or none."
      }
    },
    required: ['action']
  },
  async run({ action, audio }) {
    if (action === 'start') return start({ audio });
    if (action === 'stop') return stop();
    if (action === 'status') return status();
    throw new Error('action must be start, stop, or status');
  },
  start,
  stop,
  status,
  onChange: (fn) => events.on('change', fn)
};

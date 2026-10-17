'use strict';

// Play/pause/skip whatever is playing (browser video, Spotify, mpv...) through
// MPRIS via playerctl.

const { run } = require('./lib/hyprWindows');

const FORMAT = '{{playerName}}\t{{status}}\t{{artist}}\t{{title}}';

async function players() {
  const res = await run('playerctl', ['-a', 'metadata', '--format', FORMAT], 5000);
  if (!res.ok && /not found|ENOENT/i.test(res.stdout + res.code)) throw new Error('playerctl is not installed.');
  return parsePlayers(res.stdout);
}

function parsePlayers(stdout) {
  return String(stdout)
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [name, status, artist, title] = line.split('\t');
      return { name, status, artist: artist || '', title: title || '' };
    });
}

const ctl = (player, ...args) => run('playerctl', ['-p', player, ...args], 5000);

// What "pause" stopped, so "resume" brings back that and not some other paused tab.
let paused = [];

/** Players to act on: one named by the user, else the playing one, else the most recent. */
function pickTarget(list, wanted) {
  if (wanted) {
    const q = wanted.toLowerCase();
    return list.find((p) => p.name.toLowerCase().includes(q) || p.title.toLowerCase().includes(q)) || null;
  }
  return list.find((p) => p.status === 'Playing') || list[0] || null;
}

const describe = (p) => [p.title, p.artist].filter(Boolean).join(' by ') || p.name;

async function pause(list) {
  const playing = list.filter((p) => p.status === 'Playing');
  for (const p of playing) await ctl(p.name, 'pause');
  if (playing.length) paused = playing.map((p) => p.name);
  return playing.length ? { paused: playing.map(describe) } : { note: 'Nothing is playing.' };
}

async function resume(list, wanted) {
  const remembered = wanted ? [] : list.filter((p) => paused.includes(p.name) && p.status === 'Paused');
  const targets = remembered.length ? remembered : [pickTarget(list.filter((p) => p.status !== 'Playing'), wanted) || pickTarget(list, wanted)];
  if (!targets[0]) return { note: 'There is nothing to play.' };
  for (const p of targets) await ctl(p.name, 'play');
  paused = [];
  return { playing: targets.map(describe) };
}

module.exports = {
  name: 'media_control',
  readOnly: true,
  description:
    'Control media that is playing on the computer: YouTube or other video in the browser, Spotify, mpv and so on. ' +
    'Use for "pause", "resume", "play", "skip", "next song", "go back 10 seconds", "volume to 50", or "what is playing".',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['play', 'pause', 'toggle', 'next', 'previous', 'seek', 'volume', 'status'],
        description: 'play resumes what was paused; seek moves by `seconds`; volume sets `level`; status lists players.'
      },
      seconds: { type: 'number', description: 'For seek: seconds to move, negative to go back (e.g. -10).' },
      level: { type: 'number', description: 'For volume: 0 to 100.' },
      player: { type: 'string', description: 'Optional app or title to target, e.g. "spotify". Usually leave empty.' }
    },
    required: ['action']
  },
  async run({ action, seconds, level, player }) {
    const list = await players();
    if (!list.length) return { note: 'No media player is open.' };
    if (action === 'status') return { players: list.map((p) => ({ app: p.name, status: p.status, playing: describe(p) })) };
    if (action === 'pause') return pause(list);
    if (action === 'play') return resume(list, player);
    if (action === 'toggle') return list.some((p) => p.status === 'Playing') ? pause(list) : resume(list, player);

    const target = pickTarget(list, player);
    if (!target) return { note: `No player matches "${player}".` };
    if (action === 'next' || action === 'previous') {
      await ctl(target.name, action);
      return { [action === 'next' ? 'skipped' : 'went_back']: describe(target) };
    }
    if (action === 'seek') {
      const s = Number(seconds);
      if (!Number.isFinite(s) || !s) throw new Error('seconds is required for seek');
      await ctl(target.name, 'position', `${Math.abs(s)}${s < 0 ? '-' : '+'}`);
      return { seeked: s, in: describe(target) };
    }
    if (action === 'volume') {
      const v = Math.max(0, Math.min(100, Number(level)));
      if (!Number.isFinite(v)) throw new Error('level is required for volume');
      await ctl(target.name, 'volume', String(v / 100));
      return { volume: v, in: describe(target) };
    }
    throw new Error(`Unknown action "${action}"`);
  },
  players,
  parsePlayers,
  pickTarget
};

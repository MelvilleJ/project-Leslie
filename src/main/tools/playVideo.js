'use strict';

// One call for "play X full screen": open it, start it, fill the screen.

const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { run, clients, sel, dispatch } = require('./lib/hyprWindows');
const media = require('./mediaControl');

// Matches both window classes (app.zen_browser.zen) and MPRIS names (firefox.instance_1_284).
const BROWSER = /zen|firefox|librewolf|chrom|brave|vivaldi|opera|edge/i;
const READY_TIMEOUT_MS = 12000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the user asked for: a local file, a link, or something to search for. */
function classify(video) {
  const v = String(video || '').trim();
  const file = v.replace(/^~(?=\/|$)/, os.homedir());
  if (/^[/~]/.test(v) && fs.existsSync(file)) return { kind: 'file', value: file };
  if (/^https?:\/\//i.test(v)) return { kind: 'url', value: v };
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v)) return { kind: 'url', value: `https://${v}` };
  return { kind: 'search', value: v };
}

const isYouTubeWatch = (url) => /youtube\.com\/watch|youtu\.be\//i.test(url);

/** The top YouTube result for `query`, if yt-dlp is installed. */
async function topResult(query) {
  const res = await run('yt-dlp', ['--flat-playlist', '--print', 'id', `ytsearch1:${query}`], 20000);
  const id = res.ok && res.stdout.trim().split('\n')[0];
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

async function browserPlayers() {
  const res = await run('playerctl', ['-a', 'metadata', '--format', '{{playerName}}\t{{status}}\t{{artist}}\t{{title}}'], 5000);
  return media.parsePlayers(res.stdout).filter((p) => BROWSER.test(p.name));
}

// The new tab registers its video with the browser's media session once it loads.
async function waitForNewMedia(before) {
  const seen = new Set(before.map((p) => `${p.name}\t${p.title}`));
  const started = Date.now();
  while (Date.now() - started < READY_TIMEOUT_MS) {
    await sleep(500);
    const fresh = (await browserPlayers()).find((p) => p.title && !seen.has(`${p.name}\t${p.title}`));
    if (fresh) return fresh;
  }
  return null;
}

async function browserWindow() {
  return (await clients()).filter((c) => BROWSER.test(c.class)).sort((a, b) => a.focusHistoryID - b.focusHistoryID)[0] || null;
}

async function fillScreen(url) {
  const win = await browserWindow();
  if (!win) return false;
  const target = sel(win.address);
  await dispatch(`hl.dsp.focus({ window = ${target} })`);
  if (isYouTubeWatch(url)) {
    // The player's own fullscreen hides the page, not just the window's bars.
    await dispatch(`hl.dsp.send_shortcut({ mods = "", key = "f", window = ${target} })`);
    await sleep(1500);
    const now = (await clients()).find((c) => c.address === win.address);
    if (now && now.fullscreen) return true;
  }
  await dispatch(`hl.dsp.window.fullscreen({ mode = "fullscreen", action = "set", window = ${target} })`);
  return true;
}

function openInBrowser(url, ctx) {
  if (ctx && ctx.openUrl) return ctx.openUrl(url);
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = {
  name: 'play_video',
  readOnly: true,
  description:
    'Play a video full screen in one step: a YouTube or other video link, a local video file, or something to search ' +
    'for ("play the new Superman trailer"). Pauses anything else that is playing first. Prefer this over open_url ' +
    'whenever the user wants to watch something.',
  parameters: {
    type: 'object',
    properties: {
      video: { type: 'string', description: 'A video URL, a local file path, or search terms.' },
      fullscreen: { type: 'boolean', description: 'Default true. False to play it in a normal window.' }
    },
    required: ['video']
  },
  async run({ video, fullscreen = true }, ctx) {
    const target = classify(video);
    if (!target.value) throw new Error('video is required');
    await media.run({ action: 'pause' }).catch(() => {});

    if (target.kind === 'file') {
      spawn('mpv', [...(fullscreen ? ['--fs'] : []), target.value], { detached: true, stdio: 'ignore' }).unref();
      return { playing: target.value, via: 'mpv' };
    }

    let url = target.value;
    let note;
    if (target.kind === 'search') {
      url = await topResult(target.value);
      if (!url) {
        url = `https://www.youtube.com/results?search_query=${encodeURIComponent(target.value)}`;
        note = 'Opened YouTube search results. Install yt-dlp so the top result can play directly.';
      }
    }

    const before = await browserPlayers();
    openInBrowser(url, ctx);
    if (note) return { opened: url, note };

    const fresh = await waitForNewMedia(before);
    if (fresh && fresh.status !== 'Playing') await run('playerctl', ['-p', fresh.name, 'play'], 5000);
    if (fullscreen) await fillScreen(url).catch(() => {});
    if (!fresh) return { opened: url, note: 'Opened it, but could not confirm it started playing.' };
    return { playing: fresh.title, url, fullscreen: Boolean(fullscreen) };
  },
  classify,
  isYouTubeWatch
};

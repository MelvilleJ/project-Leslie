'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const media = require('../src/main/tools/mediaControl');
const { classify, isYouTubeWatch } = require('../src/main/tools/playVideo');

test('play_video tells files, links and searches apart', () => {
  assert.deepEqual(classify(os.homedir()), { kind: 'file', value: os.homedir() });
  assert.deepEqual(classify('~'), { kind: 'file', value: os.homedir() });
  assert.deepEqual(classify('https://youtu.be/abc'), { kind: 'url', value: 'https://youtu.be/abc' });
  assert.deepEqual(classify('youtube.com/watch?v=abc'), { kind: 'url', value: 'https://youtube.com/watch?v=abc' });
  assert.deepEqual(classify('the new Superman trailer'), { kind: 'search', value: 'the new Superman trailer' });
  assert.equal(classify('/no/such/video.mp4').kind, 'search');
});

test('only YouTube watch pages get the player fullscreen key', () => {
  assert.ok(isYouTubeWatch('https://www.youtube.com/watch?v=abc'));
  assert.ok(isYouTubeWatch('https://youtu.be/abc'));
  assert.ok(!isYouTubeWatch('https://www.youtube.com/results?search_query=x'));
  assert.ok(!isYouTubeWatch('https://vimeo.com/123'));
});

test('playerctl output is parsed per player', () => {
  const list = media.parsePlayers('firefox.instance_1_284\tPaused\t\tSome Video\nspotify\tPlaying\tArtist\tSong\n');
  assert.deepEqual(list, [
    { name: 'firefox.instance_1_284', status: 'Paused', artist: '', title: 'Some Video' },
    { name: 'spotify', status: 'Playing', artist: 'Artist', title: 'Song' }
  ]);
  assert.deepEqual(media.parsePlayers(''), []);
});

test('media commands go to the playing player unless one is named', () => {
  const list = media.parsePlayers('firefox.instance_1\tPaused\t\tVideo\nspotify\tPlaying\tArtist\tSong\n');
  assert.equal(media.pickTarget(list).name, 'spotify');
  assert.equal(media.pickTarget(list, 'firefox').name, 'firefox.instance_1');
  assert.equal(media.pickTarget(list, 'video').name, 'firefox.instance_1');
  assert.equal(media.pickTarget(list, 'vlc'), null);
  assert.equal(media.pickTarget(media.parsePlayers('mpv\tPaused\t\tclip\n')).name, 'mpv');
});

test('over a playing video the wake word counts anywhere in the transcript', () => {
  const { detectWake } = require('../src/voice/wakeword');
  const heard = 'and that is why the boss fight matters Leslie pause the video';
  assert.equal(detectWake(heard, 'Leslie').matched, false);
  assert.deepEqual(detectWake(heard, 'Leslie', { anywhere: true }), { matched: true, command: 'pause the video' });
});

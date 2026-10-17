'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/main/config');
const status = require('../src/main/presence/status');
const { createTracker } = require('../src/main/presence/tracker');
const { createPeople } = require('../src/main/presence/people');
const { createPresenceCore } = require('../src/main/presence/core');
const { parseSse } = require('../src/main/presence/client');
const { digestFallback } = require('../src/main/watch/summarize');
const policy = require('../src/main/pi/policy');

const OWNER = { id: 'p_owner', name: 'Joshua', role: 'owner' };
const GUEST = { id: 'p_guest', name: 'Sarah', role: 'guest' };

function frames(tracker, from, to, faces, step = 500) {
  const events = [];
  for (let ts = from; ts <= to; ts += step) events.push(...tracker.observe({ ts, faces }));
  return events;
}

test('a face must stay in view before it arrives, and out of view before it leaves', () => {
  const t = createTracker({ arriveMs: 3000, leaveMs: 10000 });
  assert.deepEqual(frames(t, 0, 2500, [{ id: 'a' }]), []);
  assert.deepEqual(frames(t, 3000, 3000, [{ id: 'a' }]), [{ type: 'arrived', who: 'a', awayMs: 3000 }]);
  assert.deepEqual(t.state(), { known: ['a'], unknown: false });
  assert.deepEqual(frames(t, 3500, 12500, []), []);
  assert.deepEqual(frames(t, 13000, 13000, []), [{ type: 'left', who: 'a' }]);
  assert.deepEqual(t.state(), { known: [], unknown: false });
});

test('a broken streak restarts the arrival count', () => {
  const t = createTracker({ arriveMs: 3000 });
  frames(t, 0, 2000, [{ id: 'a' }]);
  frames(t, 2500, 6000, []);
  assert.deepEqual(frames(t, 6500, 8500, [{ id: 'a' }]), []);
  assert.equal(frames(t, 9000, 9500, [{ id: 'a' }])[0].type, 'arrived');
});

test('the time away is measured from when they left', () => {
  const t = createTracker({ arriveMs: 1000, leaveMs: 2000 });
  frames(t, 0, 1000, [{ id: 'a' }]);
  const left = frames(t, 1500, 4000, []);
  assert.deepEqual(left, [{ type: 'left', who: 'a' }]);
  const back = frames(t, 60000, 61000, [{ id: 'a' }]);
  assert.deepEqual(back, [{ type: 'arrived', who: 'a', awayMs: 61000 - 3000 }]);
});

test('unrecognised faces need a longer look before they count', () => {
  const t = createTracker({ arriveMs: 1000, unknownArriveMs: 5000 });
  assert.deepEqual(frames(t, 0, 4500, [{ id: null }]), []);
  assert.equal(frames(t, 5000, 5000, [{ id: null }])[0].who, 'unknown');
  assert.deepEqual(t.state(), { known: [], unknown: true });
});

test('an unknown face replaced by a recognised one clears quickly', () => {
  const t = createTracker({ arriveMs: 1000, unknownArriveMs: 1000, leaveMs: 120000, unknownLeaveMs: 15000 });
  frames(t, 0, 1000, [{ id: null }]);
  frames(t, 1500, 3000, [{ id: 'a' }]);
  assert.deepEqual(t.state(), { known: ['a'], unknown: true });
  assert.deepEqual(frames(t, 3500, 16500, [{ id: 'a' }]), [{ type: 'left', who: 'unknown' }]);
  assert.deepEqual(t.state(), { known: ['a'], unknown: false });
});

test('an unknown face alone keeps the full leave time', () => {
  const t = createTracker({ arriveMs: 1000, unknownArriveMs: 1000, leaveMs: 120000, unknownLeaveMs: 15000 });
  frames(t, 0, 1000, [{ id: null }]);
  assert.deepEqual(frames(t, 1500, 60000, []), []);
  assert.deepEqual(t.state(), { known: [], unknown: true });
});

test('guest mode only applies when a non-owner is at the desk without the owner', (t) => {
  t.after(() => { config.cameraOwnerGating = true; status.set({ active: false }); });
  config.cameraOwnerGating = true;

  status.set({ active: false, present: [GUEST] });
  assert.equal(status.restricted(), false, 'camera off');
  status.set({ active: true, present: [] });
  assert.equal(status.restricted(), false, 'empty desk');
  status.set({ active: true, present: [OWNER, GUEST] });
  assert.equal(status.restricted(), false, 'owner with company');
  status.set({ active: true, present: [GUEST] });
  assert.equal(status.restricted(), true, 'guest alone');
  status.set({ active: true, present: [], unknown: true });
  assert.equal(status.restricted(), true, 'stranger alone');
  config.cameraOwnerGating = false;
  assert.equal(status.restricted(), false, 'gating off');
});

test('the agent is told who is present', (t) => {
  t.after(() => status.set({ active: false }));
  status.set({ active: false });
  assert.equal(status.format(), '');
  status.set({ active: true, present: [OWNER] });
  assert.equal(status.format(), 'Camera: the owner, Joshua, is at the desk. Call them Joshua.');
  status.set({ active: true, present: [OWNER, GUEST] });
  assert.match(status.format(), /Joshua, is at the desk with Sarah \(a guest\)\. Others can see/);
  status.set({ active: true, present: [GUEST], unknown: true });
  assert.match(status.format(), /^Camera: Sarah \(a guest\) and someone you do not recognise are at the desk and the owner is not\./);
  assert.match(status.format(), /private information/);
});

test('guest mode removes commands and private tools', (t) => {
  t.after(() => { status.set({ active: false }); Object.assign(config, saved); });
  const saved = { toolsEnabled: config.toolsEnabled, agentMode: config.agentMode, planMode: config.planMode,
    fsReadEnabled: config.fsReadEnabled, learningMode: config.learningMode, cameraOwnerGating: config.cameraOwnerGating };
  Object.assign(config, { toolsEnabled: true, agentMode: true, planMode: false, fsReadEnabled: true,
    learningMode: true, cameraOwnerGating: true });

  status.set({ active: true, present: [OWNER] });
  const owner = policy.toolSelection().activeTools;
  assert.ok(owner.includes('bash') && owner.includes('remember'));

  status.set({ active: true, present: [GUEST] });
  const guest = policy.toolSelection().activeTools;
  for (const name of ['bash', 'write', 'read', 'remember', 'read_document', 'install_software', 'screenshot']) {
    assert.ok(!guest.includes(name), `${name} should be off for guests`);
  }
  assert.ok(guest.includes('web_search'));
  assert.equal(policy.bridgedTool('remember'), null);
});

test('people: one owner at a time', () => {
  let stored = [];
  const people = createPeople({ load: () => [], save: (l) => { stored = l; } });
  const a = people.add({ name: 'Joshua', role: 'owner' });
  const b = people.add({ name: 'Sarah', role: 'owner' });
  assert.equal(people.find(a.id).role, 'guest');
  assert.equal(people.find(b.id).role, 'owner');
  people.update(a.id, { role: 'owner' });
  assert.deepEqual(people.list().map((p) => p.role), ['owner', 'guest']);
  assert.throws(() => people.add({ name: '  ' }));
  assert.equal(people.remove(b.id), true);
  assert.equal(stored.length, 1);
});

function coreHarness() {
  const calls = [];
  const saved = [];
  const roster = new Map([[OWNER.id, OWNER], [GUEST.id, GUEST]]);
  const core = createPresenceCore({
    tracker: createTracker({ arriveMs: 0, leaveMs: 1000 }),
    people: { find: (id) => roster.get(id) || null },
    status,
    saveHeld: (h) => saved.push(h.length),
    handlers: new Proxy({}, { get: (_t, name) => (arg) => calls.push([name, arg]) }),
    now: () => 0
  });
  return { core, calls, saved, names: () => calls.map(([n]) => n) };
}

test('briefings wait while the owner is away and come back on arrival', (t) => {
  t.after(() => status.set({ active: false }));
  const { core, calls, saved, names } = coreHarness();

  core.holdOrAnnounce('camera off: say it now');
  assert.deepEqual(calls.pop(), ['announce', 'camera off: say it now']);

  core.handle({ type: 'status', active: true });
  core.holdOrAnnounce('new email');
  core.handle({ type: 'observation', ts: 0, faces: [{ id: GUEST.id }] });
  core.holdOrAnnounce('db row');
  assert.ok(!names().includes('announce'));
  assert.deepEqual(saved, [1, 2]);

  core.handle({ type: 'observation', ts: 100, faces: [{ id: OWNER.id }, { id: GUEST.id }] });
  const arrived = calls.filter(([n]) => n === 'arrived').map(([, a]) => a);
  assert.equal(arrived.at(-1).person.id, OWNER.id);
  assert.deepEqual(arrived.at(-1).held, ['new email', 'db row']);
  assert.deepEqual(core.held(), []);

  core.holdOrAnnounce('another');
  assert.deepEqual(calls.at(-1), ['announce', 'another']);
});

test('an emptied desk and a reoccupied one are reported once each', (t) => {
  t.after(() => status.set({ active: false }));
  const { core, names } = coreHarness();
  core.handle({ type: 'status', active: true });
  core.handle({ type: 'observation', ts: 0, faces: [{ id: OWNER.id }] });
  core.handle({ type: 'observation', ts: 500, faces: [{ id: OWNER.id }] });
  core.handle({ type: 'observation', ts: 2000, faces: [] });
  core.handle({ type: 'observation', ts: 2500, faces: [] });
  const transitions = names().filter((n) => n === 'occupied' || n === 'empty' || n === 'left');
  assert.deepEqual(transitions, ['occupied', 'left', 'empty']);
});

test('parseSse keeps a partial event for the next chunk', () => {
  const { events, rest } = parseSse('data: {"a":1}\n\n: keepalive\n\ndata: {"b":');
  assert.deepEqual(events, [{ a: 1 }]);
  assert.equal(rest, 'data: {"b":');
  assert.deepEqual(parseSse(`${rest}2}\n\n`).events, [{ b: 2 }]);
});

test('the digest fallback keeps every briefing', () => {
  assert.equal(digestFallback(['One.', 'Two.'], 'Joshua'), 'While you were away, Joshua: One. Two.');
  assert.equal(digestFallback(['One.'], ''), 'While you were away: One.');
});

const { createGestureTracker } = require('../src/main/presence/gestures');

function hold(tracker, gesture, from, to, step = 33) {
  const fired = [];
  for (let ts = from; ts <= to; ts += step) fired.push(...tracker.observe({ ts, hands: gesture ? [{ gesture }] : [] }));
  return fired;
}

test('a gesture fires once it has been held, and only once per hold', () => {
  const g = createGestureTracker({ holdMs: { palm: 600 }, cooldownMs: 2500 });
  assert.deepEqual(hold(g, 'palm', 0, 500), []);
  assert.deepEqual(hold(g, 'palm', 533, 2000), ['palm']);
});

test('a brief flash of a pose does nothing, and a dropped frame keeps the hold', () => {
  const g = createGestureTracker({ holdMs: { palm: 600 } });
  assert.deepEqual(hold(g, 'palm', 0, 300), []);
  hold(g, null, 333, 1000);
  assert.deepEqual(hold(g, 'palm', 1033, 1400), []);
  hold(g, null, 1433, 1500);
  assert.deepEqual(hold(g, 'palm', 1533, 1700), ['palm']);
});

test('the same gesture rests before it can fire again', () => {
  const g = createGestureTracker({ holdMs: { shush: 400 }, cooldownMs: 2500 });
  assert.deepEqual(hold(g, 'shush', 0, 500), ['shush']);
  hold(g, null, 533, 1000);
  assert.deepEqual(hold(g, 'shush', 1033, 2000), []);
  hold(g, null, 2033, 2400);
  assert.deepEqual(hold(g, 'shush', 3000, 3500), ['shush']);
});

test('pointing is not a gesture event', () => {
  const g = createGestureTracker();
  assert.deepEqual(hold(g, 'point', 0, 3000), []);
});

test('she calls the person at the desk by first name', (t) => {
  t.after(() => { status.set({ active: false }); status.setRoster([]); });
  status.setRoster([{ ...OWNER, name: 'Joshua Melville' }, GUEST]);
  status.set({ active: false });
  assert.equal(status.addressName(), 'Joshua', 'camera off: the owner');
  status.set({ active: true, present: [GUEST] });
  assert.equal(status.addressName(), 'Sarah', 'guest alone');
  status.set({ active: true, present: [GUEST, { ...OWNER, name: 'Joshua Melville' }] });
  assert.equal(status.addressName(), 'Joshua', 'owner wins');
  status.set({ active: true, present: [], unknown: true });
  assert.equal(status.addressName(), '', 'stranger: no name');
  status.set({ active: true, present: [] });
  assert.equal(status.addressName(), 'Joshua', 'empty desk: the owner');
});

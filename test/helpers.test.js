'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/main/config');
const status = require('../src/main/presence/status');
const policy = require('../src/main/pi/policy');
const helpers = require('../src/main/helpers');
const { verifyReport } = require('../src/main/helperReport');

const EVERYDAY = { reachable: true, activeProfile: 'everyday', helper: { state: 'unloaded' } };

test.beforeEach(() => {
  Object.assign(config, { toolsEnabled: true, fsReadEnabled: true, agentMode: false, planMode: false });
  status.set({ active: false });
});
test.after(() => helpers.noteServerStatus(null));

test('delegate is offered only in Everyday mode with the helper model downloaded', () => {
  const offered = () => policy.toolSelection().activeTools.includes('delegate');
  helpers.noteServerStatus(EVERYDAY);
  assert.ok(offered());
  helpers.noteServerStatus({ ...EVERYDAY, activeProfile: 'power' });
  assert.ok(!offered(), 'power');
  helpers.noteServerStatus({ ...EVERYDAY, helper: { state: 'missing' } });
  assert.ok(!offered(), 'no helper model');
  helpers.noteServerStatus(null);
  assert.ok(!offered(), 'switching');
});

test('delegate stays available in plan mode but not to guests', () => {
  helpers.noteServerStatus(EVERYDAY);
  config.planMode = true;
  assert.ok(policy.toolSelection().activeTools.includes('delegate'));
  config.planMode = false;
  status.set({ active: true, present: [{ id: 'g', name: 'Guest', role: 'guest' }] });
  assert.ok(!policy.toolSelection().activeTools.includes('delegate'));
});

test('helpers only get look-up tools, even in agent mode', () => {
  config.agentMode = true;
  const { activeTools } = policy.helperSelection();
  for (const name of ['read', 'grep', 'find', 'ls', 'web_search', 'deep_search']) assert.ok(activeTools.includes(name), name);
  for (const name of ['bash', 'write', 'edit', 'open_app', 'install_software', 'remember', 'delegate', 'doc_create']) {
    assert.ok(!activeTools.includes(name), name);
    assert.equal(policy.helperTool(name), null, name);
  }
  assert.equal(policy.helperTool('web_search').name, 'web_search');
});

test('a guest at the desk leaves helpers with web search only', () => {
  status.set({ active: true, present: [{ id: 'g', name: 'Guest', role: 'guest' }] });
  assert.deepEqual(policy.helperSelection().activeTools, ['web_search', 'deep_search', 'read_page', 'report']);
});

test("a helper's pi events become its progress and report", () => {
  const h = { turns: 0, state: 'starting', step: '', output: '', error: null };
  helpers.applyEvent(h, { type: 'turn_start' });
  assert.equal(h.state, 'working');
  assert.equal(h.turns, 1);
  helpers.applyEvent(h, { type: 'tool_execution_start', toolName: 'web_search', args: { query: 'rx 9060 xt price' } });
  assert.equal(h.step, 'web_search: rx 9060 xt price');
  helpers.applyEvent(h, {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'About £300.' }] }
  });
  assert.equal(h.output, 'About £300.');
  h.turns = helpers.MAX_TURNS;
  assert.equal(helpers.applyEvent(h, { type: 'turn_start' }), 'too-many-turns');
});

test('delegating refuses when helpers are unavailable', async () => {
  helpers.noteServerStatus({ ...EVERYDAY, activeProfile: 'power' });
  await assert.rejects(helpers.delegate([{ label: 'x', task: 'y' }]), /Everyday mode/);
});

test("a helper's run ends at agent_end, since pi stays alive afterwards", () => {
  assert.equal(helpers.applyEvent({ turns: 1, state: 'working' }, { type: 'agent_end' }), 'finished');
});

test('read_page and report are for helpers only', () => {
  config.agentMode = true;
  helpers.noteServerStatus(EVERYDAY);
  const main = policy.toolSelection().activeTools;
  assert.ok(!main.includes('read_page') && !main.includes('report'));
  assert.equal(policy.bridgedTool('report'), null);
  assert.equal(policy.helperTool('report').name, 'report');
});

test('calling report ends the run and keeps its arguments', () => {
  const h = { turns: 1, state: 'working', sources: [] };
  helpers.applyEvent(h, { type: 'tool_execution_end', toolName: 'web_search', result: { content: [{ type: 'text', text: 'page text' }] } });
  assert.deepEqual(h.sources, ['page text']);
  const args = { answer: 'x', evidence: [] };
  assert.equal(helpers.applyEvent(h, { type: 'tool_execution_start', toolName: 'report', args }), 'finished');
  assert.equal(h.report, args);
});

// What a bridged tool returns: JSON with the page text escaped inside it.
const SOURCES = [
  JSON.stringify({ url: 'https://kernel.org', text: 'The latest stable kernel is 7.2.11,\nreleased on 2026-10-15.' }),
  'Electron 44.8.0 – “Stable” release notes'
];

test('a report is verified when its quotes were read and back the answer', () => {
  const r = verifyReport(
    { answer: 'Linux 7.2.11', evidence: [{ url: 'https://kernel.org', quote: 'latest stable kernel is 7.2.11, released' }] },
    SOURCES
  );
  assert.equal(r.verdict, 'verified');
});

test('quotes survive smart punctuation and ellipses, but not invention', () => {
  assert.equal(verifyReport({ answer: '44.8.0', evidence: [{ url: 'u', quote: 'Electron 44.8.0 - "Stable"' }] }, SOURCES).verdict, 'verified');
  assert.equal(verifyReport({ answer: '7.2.11', evidence: [{ url: 'u', quote: 'latest stable kernel … 2026-10-15' }] }, SOURCES).verdict, 'partly');
  assert.equal(verifyReport({ answer: '7.3', evidence: [{ url: 'u', quote: 'The latest stable kernel is 7.3' }] }, SOURCES).verdict, 'unverified');
});

test('an answer its quotes do not contain is only partly backed', () => {
  // "7.2.1" must not count as found inside "7.2.11".
  const r = verifyReport({ answer: 'Linux 7.2.1', evidence: [{ url: 'u', quote: 'The latest stable kernel is 7.2.11' }] }, SOURCES);
  assert.equal(r.verdict, 'partly');
  assert.equal(r.answerBacked, false);
});

test('one unfound quote does not sink an answer the other quotes back', () => {
  const r = verifyReport(
    {
      answer: 'Linux 7.2.11',
      evidence: [
        { url: 'u', quote: 'The latest stable kernel is 7.2.11' },
        { url: 'u', quote: 'Kernel 7.2.11 is the newest' }
      ]
    },
    SOURCES
  );
  assert.equal(r.verdict, 'verified');
  assert.deepEqual(r.evidence.map((e) => e.found), [true, false]);
});

test("numbers from the task and parenthetical asides are not the answer's claims", () => {
  const sources = ['Node.js 20.0.0 was released on 18 Apr 2023', 'the default page size is 4096 bytes'];
  const node = { answer: 'Node.js 20 was released on 18 April 2023', evidence: [{ url: 'u', quote: 'Node.js 20.0.0 was released on 18 Apr 2023' }] };
  assert.equal(verifyReport(node, sources, 'When was Node.js 20 released?').verdict, 'verified');
  const page = { answer: '4096 bytes (4 KB)', evidence: [{ url: 'u', quote: 'the default page size is 4096 bytes' }] };
  assert.equal(verifyReport(page, sources, 'SQLite default page size').verdict, 'verified');
});

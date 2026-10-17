'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWatcher } = require('../src/main/watch/watcher');
const { fallback } = require('../src/main/watch/summarize');
const { parseTable, newRowsQuery } = require('../src/main/watch/sources/postgres');
const { findPart } = require('../src/main/watch/sources/imap');

const quiet = { warn() {} };

function harness(source, state = {}) {
  const announced = [];
  const saved = [];
  const watcher = createWatcher({
    sources: [source],
    state,
    save: (s) => saved.push(JSON.parse(JSON.stringify(s))),
    summarize: async (_src, items) => `${items.length} new`,
    announce: async (text) => announced.push(text),
    log: quiet
  });
  return { watcher, announced, saved, state };
}

test('watcher stores the cursor and announces only when items arrive', async () => {
  const replies = [{ items: [], cursor: 5 }, { items: [{ title: 'a' }, { title: 'b' }], cursor: 7 }];
  const seen = [];
  const source = { name: 's', noun: 'thing', intervalMs: 1000, poll: async (c) => (seen.push(c), replies.shift()) };
  const { watcher, announced, state } = harness(source);

  await watcher.poll(source);
  assert.deepEqual(announced, []);
  await watcher.poll(source);
  assert.deepEqual(seen, [undefined, 5]);
  assert.deepEqual(announced, ['2 new']);
  assert.equal(state.s, 7);
});

test('a failing poll keeps the old cursor and does not throw', async () => {
  const source = { name: 's', noun: 'thing', intervalMs: 1000, poll: async () => { throw new Error('down'); } };
  const { watcher, announced, state } = harness(source, { s: 3 });
  await watcher.poll(source);
  assert.equal(state.s, 3);
  assert.deepEqual(announced, []);
});

test('overlapping polls of the same source are skipped', async () => {
  let calls = 0;
  let release;
  const source = {
    name: 's', noun: 'thing', intervalMs: 1000,
    poll: () => { calls += 1; return new Promise((r) => { release = () => r({ items: [], cursor: 1 }); }); }
  };
  const { watcher } = harness(source);
  const first = watcher.poll(source);
  await watcher.poll(source);
  release();
  await first;
  assert.equal(calls, 1);
});

test('fallback briefing counts items and names the latest', () => {
  const items = [{ title: 'from A: hi' }, { title: 'from B: lunch' }];
  assert.equal(fallback({ noun: 'email' }, items, 'Joshua'), 'Joshua, 2 new emails. The latest: from B: lunch.');
  assert.equal(fallback({ noun: 'email' }, items, ''), '2 new emails. The latest: from B: lunch.');
});

test('postgres table specs and queries quote identifiers', () => {
  assert.deepEqual(parseTable('orders'), { table: 'orders', column: 'id' });
  assert.deepEqual(parseTable('public.signups:created_at'), { table: 'public.signups', column: 'created_at' });

  const first = newRowsQuery({ table: 'public.signups', column: 'created_at' }, null);
  assert.match(first.text, /FROM "public"\."signups"  ORDER BY "created_at"/);
  assert.deepEqual(first.values, []);

  const next = newRowsQuery({ table: 'bad"name', column: 'id' }, '42');
  assert.match(next.text, /FROM "bad""name" WHERE "id" > \$1/);
  assert.deepEqual(next.values, ['42']);
});

test('imap picks the text part and skips attachments', () => {
  const tree = {
    type: 'multipart/mixed',
    childNodes: [
      { type: 'text/plain', part: '1', disposition: 'attachment' },
      { type: 'multipart/alternative', childNodes: [{ type: 'text/html', part: '2.2' }, { type: 'text/plain', part: '2.1' }] }
    ]
  };
  assert.equal(findPart(tree, 'text/plain'), '2.1');
  assert.equal(findPart(tree, 'text/html'), '2.2');
  assert.equal(findPart({ type: 'text/plain' }, 'text/plain'), '1');
});

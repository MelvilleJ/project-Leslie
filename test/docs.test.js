'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parse, serialize, alignIds, hash, pendingIntent } = require('../src/main/docs/blocks');
const { DocStore } = require('../src/main/docs/store');
const { createDocsServer } = require('../src/main/docs/server');

const SAMPLE = '# Plan\nIntro line\nmore intro\n\n\n- a\n- b\n\n```js\nconst x = 1;\n\nconst y = 2;\n```\n<!-- pending: Risks: what could slip -->\n';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leslie-docs-'));
  let clock = 1_000_000;
  const store = new DocStore(dir, { now: () => (clock += 1000) });
  return { dir, store, advance: (ms) => (clock += ms) };
}

test('parsing keeps every byte, splits headings and keeps fences whole', () => {
  const { lead, blocks } = parse(SAMPLE);
  assert.equal(serialize(lead, blocks), SAMPLE);
  assert.deepEqual(blocks.map((b) => b.text), [
    '# Plan',
    'Intro line\nmore intro',
    '- a\n- b',
    '```js\nconst x = 1;\n\nconst y = 2;\n```',
    '<!-- pending: Risks: what could slip -->'
  ]);
  assert.equal(pendingIntent(blocks[4].text), 'Risks: what could slip');
  assert.equal(serialize(...Object.values(parse('\n\nCRLF\r\nline\r\n'))), '\n\nCRLF\r\nline\r\n');
});

test('ids follow unchanged blocks and blocks edited in place', () => {
  const old = ['one', 'two', 'three'].map((text, i) => ({ id: `id${i}`, h: hash(text) }));
  assert.deepEqual(alignIds(old, ['zero', 'one', 'two', 'three']).slice(1), ['id0', 'id1', 'id2']);
  assert.deepEqual(alignIds(old, ['one', 'TWO!', 'three']), ['id0', 'id1', 'id2']);
  const dropped = alignIds(old, ['one', 'three']);
  assert.deepEqual(dropped, ['id0', 'id2']);
  const known = ['# T', 'Intro words here', 'A second paragraph', '- pack bags\n- book hotel', 'tail'].map((text, i) => ({ id: `k${i}`, text, h: hash(text) }));
  const restored = alignIds(known, ['# T', 'Intro words here, revised', '- pack bags\n- book hotel (done)', 'tail']);
  assert.deepEqual(restored, ['k0', 'k1', 'k3', 'k4'], 'edited blocks match the one they resemble, not the one in their slot');
});

test('ops replace, insert, delete and find, and the file stays plain markdown', () => {
  const { store } = tmpStore();
  const doc = store.create('Notes', '# Notes\n\nFirst para\n');
  const [title, para] = doc.blocks;
  store.readForLeslie('Notes');
  const out = store.apply('Notes', [
    { op: 'replace', id: para.id, text: 'First para, edited\n\nSecond para' },
    { op: 'insert', after: title.id, text: 'Lead sentence' },
    { op: 'find', find: 'edited', replace: 'revised' },
    { op: 'delete', id: 'missing' }
  ], 'leslie');
  assert.deepEqual(out.results.map((r) => r.ok), [true, true, true, false]);
  assert.equal(store.markdown('Notes'), '# Notes\n\nLead sentence\n\nFirst para, revised\n\nSecond para\n');
  assert.equal(fs.readFileSync(store.file('Notes'), 'utf8'), store.markdown('Notes'));
  assert.equal(out.doc.blocks[2].id, para.id, 'the replaced block keeps its id');
  store.apply('Notes', [{ op: 'insert', text: 'Tail' }], 'leslie');
  assert.ok(store.markdown('Notes').endsWith('Second para\n\nTail\n'));
});

test("Leslie can't overwrite a block the user changed since her last read", () => {
  const { store } = tmpStore();
  const doc = store.create('Shared', '# Shared\n\nDraft\n');
  const para = doc.blocks[1];
  assert.equal(store.apply('Shared', [{ op: 'replace', id: para.id, text: 'x' }], 'leslie').results[0].ok, false, 'unread doc');
  store.readForLeslie('Shared');
  store.apply('Shared', [{ op: 'replace', id: para.id, text: 'User wording' }], 'user');
  const refused = store.apply('Shared', [{ op: 'find', find: 'User', replace: 'Her' }], 'leslie');
  assert.match(refused.results[0].error, /edited by the user/);
  store.readForLeslie('Shared');
  assert.equal(store.apply('Shared', [{ op: 'find', find: 'User', replace: 'Her' }], 'leslie').results[0].ok, true);
  assert.equal(store.apply('Shared', [{ op: 'replace', id: para.id, text: 'Her wording again' }], 'leslie').results[0].ok, true, 'her own block');
});

test("a person's text survives Leslie deleting the block they were typing in", () => {
  const { store } = tmpStore();
  const doc = store.create('Race', '# Race\n\nTyping here\n');
  const para = doc.blocks[1];
  store.readForLeslie('Race');
  store.apply('Race', [{ op: 'delete', id: para.id }], 'leslie');
  store.apply('Race', [{ op: 'replace', id: para.id, after: doc.blocks[0].id, text: 'Typing here, more' }], 'user');
  assert.equal(store.markdown('Race'), '# Race\n\nTyping here, more\n');
  assert.equal(store.get('Race').blocks[1].id, para.id);
});

test('history keeps the state before each run of edits and restores it', () => {
  const { store, advance } = tmpStore();
  const doc = store.create('Hist', '# Hist\n\nv1\n');
  const id = doc.blocks[1].id;
  store.apply('Hist', [{ op: 'replace', id, text: 'v2' }], 'user');
  store.apply('Hist', [{ op: 'replace', id, text: 'v3' }], 'user');
  assert.equal(store.history('Hist').length, 1, 'one snapshot for a quick run of edits');
  advance(5 * 60 * 1000);
  store.apply('Hist', [{ op: 'replace', id, text: 'v4' }], 'user');
  const versions = store.history('Hist');
  assert.equal(versions.length, 2);
  assert.match(store.version('Hist', versions[0].id), /v3/);
  store.restore('Hist', versions[1].id);
  assert.equal(store.markdown('Hist'), '# Hist\n\nv1\n');
  assert.equal(store.get('Hist').blocks[1].id, id, 'restoring keeps ids');
});

test('comments thread on a block and track whether Leslie owes a reply', () => {
  const { store } = tmpStore();
  const doc = store.create('Talk', '# Talk\n\nSome claim here\n');
  const t = store.comment('Talk', { blockId: doc.blocks[1].id, quote: 'claim', text: 'Source?', ask: true });
  assert.equal(t.asked, true);
  store.reply('Talk', t.id, { text: 'Added one.', author: 'leslie' });
  const after = store.get('Talk').threads[0];
  assert.equal(after.asked, false);
  assert.deepEqual(after.messages.map((m) => m.author), ['user', 'leslie']);
  store.setThread('Talk', t.id, { resolved: true });
  assert.equal(store.get('Talk').threads[0].resolved, true);
});

test('ids and threads survive a restart, and outside edits keep ids', () => {
  const { dir, store } = tmpStore();
  const doc = store.create('Keep', '# Keep\n\nA\n\nB\n');
  store.comment('Keep', { blockId: doc.blocks[2].id, text: 'on B' });
  const again = new DocStore(dir);
  assert.deepEqual(again.get('Keep').blocks.map((b) => b.id), doc.blocks.map((b) => b.id));
  assert.equal(again.get('Keep').threads.length, 1);
  fs.writeFileSync(again.file('Keep'), '# Keep\n\nA, edited elsewhere\n\nB\n');
  again.reloadFromDisk('Keep');
  assert.deepEqual(again.get('Keep').blocks.map((b) => b.id), doc.blocks.map((b) => b.id));
  assert.equal(again.get('Keep').blocks[1].by, 'file');
});

test('the server only answers its own host and token', async () => {
  const { store } = tmpStore();
  store.create('Web', '# Web\n');
  const asked = [];
  const s2 = createDocsServer({ store, port: 18191 + Math.floor(Math.random() * 2000), onAsk: (name, t) => asked.push([name, t.id]) });
  await s2.listen();
  const base = s2.url().replace(/\/$/, '');
  try {
    const page = await (await fetch(`${base}/d/Web`)).text();
    const token = page.match(/name="leslie-token" content="([0-9a-f]+)"/)[1];
    assert.equal((await fetch(`${base}/api/docs`)).status, 403, 'no token');
    const ok = await fetch(`${base}/api/docs/web`, { headers: { 'x-leslie-token': token } });
    assert.equal((await ok.json()).name, 'Web', 'names resolve case-insensitively');
    const http = require('node:http');
    const status = await new Promise((resolve) =>
      http.get(`${base}/api/docs`, { headers: { host: 'evil.example:80', 'x-leslie-token': token } }, (res) => resolve(res.statusCode))
    );
    assert.equal(status, 421, 'foreign Host is refused');
    const blockId = store.get('Web').blocks[0].id;
    await fetch(`${base}/api/docs/Web/threads`, {
      method: 'POST',
      headers: { 'x-leslie-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockId, text: 'Make this longer', ask: true })
    });
    assert.equal(asked.length, 1);
  } finally {
    s2.close();
  }
});

test('a plan can be approved once, and its state survives a restart', async () => {
  const { dir, store } = tmpStore();
  store.create('Move dotfiles', '# Move dotfiles\n\n1. Copy them\n');
  const approved = [];
  const s2 = createDocsServer({ store, port: 18191 + Math.floor(Math.random() * 2000), onApprove: (name) => approved.push(name) });
  await s2.listen();
  const base = s2.url().replace(/\/$/, '');
  try {
    const token = (await (await fetch(`${base}/d/Move%20dotfiles`)).text()).match(/content="([0-9a-f]+)"/)[1];
    const approve = () =>
      fetch(`${base}/api/docs/Move%20dotfiles/plan`, {
        method: 'POST',
        headers: { 'x-leslie-token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' })
      });
    assert.equal((await approve()).status, 400, 'not a plan yet');
    store.setPlan('Move dotfiles', 'proposed');
    assert.equal((await approve()).status, 200);
    assert.equal((await approve()).status, 400, 'already approved');
    assert.deepEqual(approved, ['Move dotfiles']);
  } finally {
    s2.close();
  }
  store.setPlan('Move dotfiles', 'done', 'Copied them.');
  const reopened = new DocStore(dir);
  assert.equal(reopened.get('Move dotfiles').plan.status, 'done');
  assert.equal(reopened.get('Move dotfiles').plan.note, 'Copied them.');
});

test('code fences keep their language so the docs page can draw mermaid', () => {
  const { render } = require('../src/renderer/markdown');
  assert.match(render('```mermaid\nflowchart LR\n  A-->B\n```'), /<code class="language-mermaid">flowchart LR\n {2}A--&gt;B<\/code>/);
  assert.match(render('```\nplain\n```'), /<pre><code>plain<\/code><\/pre>/);
  assert.match(render('```bad"lang\nx\n```'), /<code class="language-bad">/);
});

test('requesting changes sends the queued comments and note as one round', async () => {
  const { store } = tmpStore();
  store.create('Stow', '# Stow\n\n1. Copy them\n\n2. Link them\n');
  const [, one, two] = store.get('Stow').blocks;
  assert.throws(() => store.requestChanges('Stow', 'x'), /isn't a plan/);
  store.setPlan('Stow', 'proposed');
  assert.throws(() => store.requestChanges('Stow', ' '), /Say what should change/);
  const queued = store.comment('Stow', { blockId: one.id, quote: 'Copy', text: 'Use rsync' });
  store.comment('Stow', { blockId: two.id, text: 'Already asked', ask: true });
  const replied = store.comment('Stow', { blockId: two.id, text: 'Why?' });
  store.reply('Stow', replied.id, { text: 'Because.', author: 'leslie' });

  const revised = [];
  const s2 = createDocsServer({ store, port: 18191 + Math.floor(Math.random() * 2000), onRevise: (name, round) => revised.push([name, round]) });
  await s2.listen();
  const base = s2.url().replace(/\/$/, '');
  try {
    const token = (await (await fetch(`${base}/d/Stow`)).text()).match(/content="([0-9a-f]+)"/)[1];
    const res = await fetch(`${base}/api/docs/Stow/plan`, {
      method: 'POST',
      headers: { 'x-leslie-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'request-changes', note: 'Add a backup step' })
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'revising');
  } finally {
    s2.close();
  }
  assert.equal(revised.length, 1);
  const [name, round] = revised[0];
  assert.equal(name, 'Stow');
  assert.equal(round.note, 'Add a backup step');
  assert.deepEqual(round.threads.map((t) => t.id), [queued.id], 'only open comments the user left last, not yet sent');
  assert.equal(store.get('Stow').threads.find((t) => t.id === queued.id).asked, true);
  assert.throws(() => store.requestChanges('Stow', 'again'), /isn't a plan/, 'one round at a time');

  store.finishRevision('Stow', [queued.id], { ok: false, note: 'Could not.' });
  const back = store.get('Stow').threads.find((t) => t.id === queued.id);
  assert.equal(back.asked, false);
  assert.equal(back.resolved, false, 'a failed round leaves the comment for the next one');
  assert.equal(store.get('Stow').plan.status, 'proposed');

  const again = store.requestChanges('Stow', '');
  store.finishRevision('Stow', again.threads.map((t) => t.id), { ok: true, note: 'Switched to rsync.' });
  assert.equal(store.get('Stow').threads.find((t) => t.id === queued.id).resolved, true);
  assert.deepEqual([store.get('Stow').plan.status, store.get('Stow').plan.note], ['proposed', 'Switched to rsync.']);
});

test('broken mermaid diagrams are found with their error', async () => {
  const { brokenDiagrams } = require('../src/main/docs/diagrams');
  const md = '# Plan\n\n```mermaid\nflowchart LR\n  A[Repo] --> B[Home]\n```\n\n```mermaid\nflowchart LR\n  A[[broken -->\n```\n';
  const broken = await brokenDiagrams(md);
  assert.equal(broken.length, 1);
  assert.match(broken[0].source, /broken/);
  assert.match(broken[0].error, /Parse error/);
  assert.deepEqual(await brokenDiagrams('no diagrams here'), []);
});

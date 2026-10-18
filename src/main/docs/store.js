'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { parse, serialize, alignIds, hash, newId, pendingIntent } = require('./blocks');

// History keeps the state before a change; a run of edits by one author inside
// this window shares a single snapshot.
const SNAPSHOT_EVERY_MS = 2 * 60 * 1000;
const HISTORY_LIMIT = 200;
// The browser re-sends "typing in this block" while the editor stays open.
const TYPING_TTL_MS = 20 * 1000;

function safeName(title) {
  const name = String(title || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120);
  if (!name) throw new Error('A doc needs a title.');
  return name;
}

class DocError extends Error {}

/**
 * Live markdown docs: each doc is `<dir>/<name>.md`, the file being the source
 * of truth. Block ids, comment threads and history live beside it in
 * `<dir>/.leslie/`. Every change bumps the doc's `rev` and emits `change`.
 *
 * Edits by Leslie are guarded: a block someone else changed since her last read
 * of the doc is refused, so a person's edit is never silently overwritten.
 */
// A comment the user left for the next revision round: open, not sent, and theirs last.
function isQueued(thread) {
  return !thread.resolved && !thread.asked && thread.messages[thread.messages.length - 1].author === 'user';
}

class DocStore extends EventEmitter {
  constructor(dir, { now = Date.now } = {}) {
    super();
    this.dir = dir;
    this.meta = path.join(dir, '.leslie');
    this.now = now;
    this.docs = new Map();
    this.watcher = null;
    fs.mkdirSync(path.join(this.meta, 'history'), { recursive: true });
  }

  file(name) {
    return path.join(this.dir, `${name}.md`);
  }

  sidecar(name) {
    return path.join(this.meta, `${name}.json`);
  }

  list() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => {
        const name = e.name.slice(0, -3);
        const stat = fs.statSync(this.file(name));
        return { name, modified: stat.mtimeMs, bytes: stat.size };
      })
      .sort((a, b) => b.modified - a.modified);
  }

  exists(name) {
    return fs.existsSync(this.file(name));
  }

  /** Resolves a name the model or a URL gave, forgiving case and a trailing ".md". */
  resolve(name) {
    const want = String(name || '').replace(/\.md$/i, '').trim();
    if (this.docs.has(want) || this.exists(want)) return want;
    const hit = this.list().find((d) => d.name.toLowerCase() === want.toLowerCase());
    if (!hit) throw new DocError(`No doc named "${want}".`);
    return hit.name;
  }

  load(name) {
    name = this.resolve(name);
    const cached = this.docs.get(name);
    if (cached) return cached;
    const content = fs.readFileSync(this.file(name), 'utf8');
    let side = {};
    try {
      side = JSON.parse(fs.readFileSync(this.sidecar(name), 'utf8'));
    } catch {
    }
    const { lead, blocks } = parse(content);
    const ids = alignIds(side.blocks || [], blocks.map((b) => b.text));
    const doc = {
      name,
      rev: side.rev || 1,
      lead,
      blocks: blocks.map((b, i) => ({ id: ids[i], text: b.text, sep: b.sep, h: hash(b.text), rev: side.rev || 1, by: 'file' })),
      threads: side.threads || [],
      plan: side.plan || null,
      leslieSeen: 0,
      typing: new Map(),
      written: content,
      lastSnapshot: { at: 0, by: null }
    };
    this.docs.set(name, doc);
    return doc;
  }

  create(title, markdown = '') {
    const name = safeName(title);
    if (this.exists(name)) throw new DocError(`A doc named "${name}" already exists.`);
    const body = String(markdown || '').trim() ? String(markdown).replace(/\s*$/, '\n') : `# ${name}\n`;
    fs.writeFileSync(this.file(name), body, { flag: 'wx' });
    const doc = this.load(name);
    this.save(doc);
    this.emit('list');
    return this.view(doc);
  }

  remove(name) {
    const doc = this.load(name);
    this.snapshot(doc, 'deleted', true);
    fs.rmSync(this.file(doc.name), { force: true });
    fs.rmSync(this.sidecar(doc.name), { force: true });
    this.docs.delete(doc.name);
    this.emit('list');
  }

  view(doc) {
    return {
      name: doc.name,
      rev: doc.rev,
      blocks: doc.blocks.map(({ id, text, h, by, rev }) => {
        const intent = pendingIntent(text);
        return intent === null ? { id, text, h, by, rev } : { id, text, h, by, rev, pending: intent };
      }),
      threads: doc.threads,
      plan: doc.plan
    };
  }

  get(name) {
    return this.view(this.load(name));
  }

  /** The doc as Leslie reads it; marks it seen, so her next edits are checked against this. */
  readForLeslie(name) {
    const doc = this.load(name);
    doc.leslieSeen = doc.rev;
    return this.view(doc);
  }

  markdown(name) {
    const doc = this.load(name);
    return serialize(doc.lead, doc.blocks);
  }

  save(doc) {
    const content = serialize(doc.lead, doc.blocks);
    const tmp = `${this.file(doc.name)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, this.file(doc.name));
    doc.written = content;
    this.saveSidecar(doc);
  }

  saveSidecar(doc) {
    const side = { rev: doc.rev, blocks: doc.blocks.map(({ id, h }) => ({ id, h })), threads: doc.threads, plan: doc.plan };
    fs.writeFileSync(this.sidecar(doc.name), JSON.stringify(side, null, 1));
  }

  historyDir(name) {
    return path.join(this.meta, 'history', name);
  }

  snapshot(doc, by, force = false) {
    const at = this.now();
    if (!force && doc.lastSnapshot.by === by && at - doc.lastSnapshot.at < SNAPSHOT_EVERY_MS) return;
    doc.lastSnapshot = { at, by };
    const dir = this.historyDir(doc.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${at}-${by}.md`), serialize(doc.lead, doc.blocks));
    const files = fs.readdirSync(dir).sort();
    for (const old of files.slice(0, Math.max(0, files.length - HISTORY_LIMIT))) fs.rmSync(path.join(dir, old));
  }

  history(name) {
    name = this.resolve(name);
    let files = [];
    try {
      files = fs.readdirSync(this.historyDir(name));
    } catch {
    }
    return files
      .map((f) => f.match(/^(\d+)-(\w+)\.md$/))
      .filter(Boolean)
      .map(([file, at, by]) => ({ id: file.slice(0, -3), at: Number(at), by }))
      .sort((a, b) => b.at - a.at);
  }

  version(name, id) {
    name = this.resolve(name);
    if (!/^\d+-\w+$/.test(String(id))) throw new DocError('Unknown version.');
    try {
      return fs.readFileSync(path.join(this.historyDir(name), `${id}.md`), 'utf8');
    } catch {
      throw new DocError('Unknown version.');
    }
  }

  restore(name, id) {
    const content = this.version(name, id);
    const doc = this.load(name);
    this.snapshot(doc, 'user', true);
    this.replaceAll(doc, content, 'user');
    return this.view(doc);
  }

  replaceAll(doc, content, by) {
    const { lead, blocks } = parse(content);
    const ids = alignIds(doc.blocks, blocks.map((b) => b.text));
    const before = new Map(doc.blocks.map((b) => [b.id, b]));
    doc.rev++;
    doc.lead = lead;
    doc.blocks = blocks.map((b, i) => {
      const h = hash(b.text);
      const prev = before.get(ids[i]);
      const same = prev && prev.h === h;
      return { id: ids[i], text: b.text, sep: b.sep, h, rev: same ? prev.rev : doc.rev, by: same ? prev.by : by };
    });
    this.save(doc);
    this.emit('change', { name: doc.name, by, doc: this.view(doc) });
  }

  /**
   * Applies ops in order; each one lands or is refused on its own.
   *   { op: 'replace', id, text }        text may hold several blocks; the first keeps the id
   *   { op: 'insert', after?|before?, text }   no anchor = end of the doc
   *   { op: 'delete', id }
   *   { op: 'find', find, replace, nth? }       exact text, inside one block
   * `by` is 'user' or 'leslie'. Returns per-op results plus the new rev.
   */
  apply(name, ops, by) {
    const doc = this.load(name);
    if (!Array.isArray(ops) || !ops.length) throw new DocError('No ops given.');
    const results = [];
    let changed = false;
    for (const op of ops) {
      try {
        const ids = this.applyOne(doc, op || {}, by, () => {
          if (!changed) this.snapshot(doc, by);
          if (!changed) doc.rev++;
          changed = true;
        });
        results.push({ ok: true, ids });
      } catch (err) {
        if (!(err instanceof DocError)) throw err;
        results.push({ ok: false, error: err.message });
      }
    }
    if (changed) {
      if (by === 'leslie') doc.leslieSeen = doc.rev;
      this.save(doc);
      this.emit('change', { name: doc.name, by, doc: this.view(doc) });
    }
    return { rev: doc.rev, results, doc: this.view(doc) };
  }

  applyOne(doc, op, by, begin) {
    const index = (id) => {
      const i = doc.blocks.findIndex((b) => b.id === id);
      if (i === -1) throw new DocError(`No block with id ${id}. Read the doc again for current ids.`);
      return i;
    };
    const guard = (b) => {
      if (by === 'leslie' && (doc.typing.get(b.id)?.until || 0) > this.now()) {
        throw new DocError(`The user is typing in block ${b.id} right now; leave it to them, or work on other blocks and try again shortly.`);
      }
      if (by === 'leslie' && b.by !== 'leslie' && b.rev > doc.leslieSeen) {
        throw new DocError(`Block ${b.id} was edited by the user since you read the doc; their edit stands. Read it again before changing it.`);
      }
    };
    const pieces = (text) => {
      const { blocks } = parse(String(text == null ? '' : text));
      return blocks;
    };
    const stamp = (b) => Object.assign(b, { h: hash(b.text), rev: doc.rev, by });

    switch (op.op) {
      case 'replace': {
        let i;
        try {
          i = index(op.id);
        } catch (err) {
          // The block this person was typing in was deleted under them: their text comes back.
          if (by !== 'user') throw err;
          return this.applyOne(doc, { op: 'insert', id: op.id, after: op.after, text: op.text }, by, begin);
        }
        guard(doc.blocks[i]);
        const parts = pieces(op.text);
        if (!parts.length) return this.applyOne(doc, { op: 'delete', id: op.id }, by, begin);
        begin();
        const tailSep = doc.blocks[i].sep;
        const fresh = parts.map((p, k) =>
          stamp({ id: k === 0 ? op.id : newId(), text: p.text, sep: k === parts.length - 1 ? tailSep || '\n' : p.sep })
        );
        doc.blocks.splice(i, 1, ...fresh);
        return fresh.map((b) => b.id);
      }
      case 'insert': {
        const parts = pieces(op.text);
        if (!parts.length) throw new DocError('Nothing to insert.');
        // A person's anchor may have been deleted under them: their text goes at the end instead.
        const anchor = (id) => (by === 'user' && !doc.blocks.some((b) => b.id === id) ? null : id);
        let at = doc.blocks.length;
        if (op.after && anchor(op.after)) at = index(op.after) + 1;
        else if (op.before && anchor(op.before)) at = index(op.before);
        // The browser picks the id of a paragraph it starts, so its live copy and the saved one match.
        const ownId = by === 'user' && /^[0-9a-f]{10}$/.test(op.id || '') && !doc.blocks.some((b) => b.id === op.id) ? op.id : null;
        begin();
        const fresh = parts.map((p, k) => stamp({ id: k === 0 && ownId ? ownId : newId(), text: p.text, sep: '\n\n' }));
        if (at === doc.blocks.length) {
          const last = doc.blocks[at - 1];
          fresh[fresh.length - 1].sep = last ? last.sep || '\n' : '\n';
          if (last) last.sep = '\n\n';
        }
        doc.blocks.splice(at, 0, ...fresh);
        return fresh.map((b) => b.id);
      }
      case 'delete': {
        const i = index(op.id);
        guard(doc.blocks[i]);
        begin();
        const [gone] = doc.blocks.splice(i, 1);
        if (i === doc.blocks.length && i > 0) doc.blocks[i - 1].sep = gone.sep;
        return [];
      }
      case 'find': {
        const find = String(op.find || '');
        if (!find) throw new DocError('find needs the exact text to look for.');
        const nth = Math.max(1, Number(op.nth) || 1);
        let seen = 0;
        for (const b of doc.blocks) {
          let from = 0;
          let at;
          while ((at = b.text.indexOf(find, from)) !== -1) {
            if (++seen === nth) {
              guard(b);
              begin();
              b.text = b.text.slice(0, at) + String(op.replace ?? '') + b.text.slice(at + find.length);
              stamp(b);
              return [b.id];
            }
            from = at + find.length;
          }
        }
        throw new DocError(`"${find.slice(0, 60)}" isn't in the doc${seen ? ` ${nth} times` : ''}. Quote it exactly as it stands.`);
      }
      default:
        throw new DocError(`Unknown op "${op.op}". Use replace, insert, delete or find.`);
    }
  }

  /** Marks the block someone has open in the editor (null when they leave it). */
  setTyping(name, id, clientKey) {
    const doc = this.load(name);
    for (const [blockId, entry] of doc.typing) if (entry.key === clientKey) doc.typing.delete(blockId);
    if (id) doc.typing.set(id, { key: clientKey, until: this.now() + TYPING_TTL_MS });
  }

  // --- comments --------------------------------------------------------------

  thread(doc, id) {
    const t = doc.threads.find((x) => x.id === id);
    if (!t) throw new DocError('No such comment thread.');
    return t;
  }

  touchThreads(doc) {
    this.saveSidecar(doc);
    this.emit('change', { name: doc.name, by: 'comment', doc: this.view(doc) });
  }

  comment(name, { blockId, quote, text, author = 'user', ask = false }) {
    const doc = this.load(name);
    if (!doc.blocks.some((b) => b.id === blockId)) throw new DocError('That block is gone.');
    if (!String(text || '').trim()) throw new DocError('A comment needs text.');
    const thread = {
      id: newId(),
      blockId,
      quote: String(quote || '').slice(0, 500),
      resolved: false,
      asked: Boolean(ask),
      messages: [{ id: newId(), author, text: String(text).trim(), at: this.now() }]
    };
    doc.threads.push(thread);
    this.touchThreads(doc);
    return thread;
  }

  reply(name, threadId, { text, author = 'user', ask = false }) {
    const doc = this.load(name);
    const thread = this.thread(doc, threadId);
    if (!String(text || '').trim()) throw new DocError('A reply needs text.');
    thread.messages.push({ id: newId(), author, text: String(text).trim(), at: this.now() });
    thread.asked = author === 'user' ? Boolean(ask) : false;
    if (author === 'user') thread.resolved = false;
    this.touchThreads(doc);
    return thread;
  }

  setThread(name, threadId, fields) {
    const doc = this.load(name);
    const thread = this.thread(doc, threadId);
    if ('resolved' in fields) thread.resolved = Boolean(fields.resolved);
    if ('asked' in fields) thread.asked = Boolean(fields.asked);
    this.touchThreads(doc);
    return thread;
  }

  // --- plans -----------------------------------------------------------------

  /**
   * A doc Leslie wrote in plan mode carries `{ status, at, note? }`: 'proposed'
   * until the user approves it, then 'approved', then 'done' or 'failed'.
   * Requesting changes sends it to 'revising' and back to 'proposed'.
   */
  setPlan(name, status, note) {
    const doc = this.load(name);
    doc.plan = status ? { status, at: this.now(), ...(note ? { note: String(note).slice(0, 600) } : {}) } : null;
    this.saveSidecar(doc);
    this.emit('change', { name: doc.name, by: 'plan', doc: this.view(doc) });
    return doc.plan;
  }

  approvePlan(name) {
    const doc = this.load(name);
    if (!doc.plan || !['proposed', 'failed'].includes(doc.plan.status)) throw new DocError("This doc isn't a plan waiting for approval.");
    return this.setPlan(name, 'approved');
  }

  /** Sends the user's note and every comment still waiting for Leslie as one revision round. */
  requestChanges(name, note) {
    const doc = this.load(name);
    if (!doc.plan || !['proposed', 'failed'].includes(doc.plan.status)) throw new DocError("This doc isn't a plan waiting for approval.");
    const text = String(note || '').trim().slice(0, 2000);
    const threads = doc.threads.filter(isQueued);
    if (!text && !threads.length) throw new DocError('Say what should change, or add comments to the plan first.');
    for (const t of threads) t.asked = true;
    this.saveSidecar(doc);
    this.setPlan(name, 'revising', text ? `You asked: ${text}` : '');
    return { note: text, threads: threads.map((t) => structuredClone(t)) };
  }

  /** Ends a revision round: its comments are resolved when it worked, or wait for the next round when it didn't. */
  finishRevision(name, threadIds, { ok, note }) {
    const doc = this.load(name);
    for (const t of doc.threads) {
      if (!threadIds.includes(t.id)) continue;
      t.asked = false;
      if (ok) t.resolved = true;
    }
    this.saveSidecar(doc);
    return this.setPlan(name, 'proposed', note);
  }

  // --- outside edits ---------------------------------------------------------

  /** Picks up edits made to the .md files by other programs (an editor, Obsidian, git). */
  watch() {
    if (this.watcher) return;
    const timers = new Map();
    try {
      this.watcher = fs.watch(this.dir, (_type, file) => {
        if (!file || !file.endsWith('.md') || file.includes('.tmp-')) return;
        clearTimeout(timers.get(file));
        timers.set(file, setTimeout(() => this.reloadFromDisk(file.slice(0, -3)), 150));
      });
    } catch (err) {
      console.warn('[docs] cannot watch', this.dir, err.message);
    }
  }

  reloadFromDisk(name) {
    const doc = this.docs.get(name);
    let content;
    try {
      content = fs.readFileSync(this.file(name), 'utf8');
    } catch {
      if (doc) this.docs.delete(name);
      this.emit('list');
      return;
    }
    if (!doc) return this.emit('list');
    if (content === doc.written) return;
    this.snapshot(doc, 'file');
    this.replaceAll(doc, content, 'file');
  }

  close() {
    if (this.watcher) this.watcher.close();
    this.watcher = null;
  }
}

module.exports = { DocStore, DocError, safeName };

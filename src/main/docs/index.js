'use strict';

const config = require('../config');
const { DocStore } = require('./store');
const { createDocsServer } = require('./server');

const OUTLINE_CHARS = 14000;

let store = null;
let server = null;
let askHandler = null;
let approveHandler = null;
let reviseHandler = null;

function enabled() {
  return config.liveDocsEnabled && Boolean(server);
}

async function start() {
  if (!config.liveDocsEnabled || server) return;
  store = new DocStore(config.liveDocsDir);
  store.watch();
  const candidate = createDocsServer({
    store,
    port: config.liveDocsPort,
    onAsk: (name, thread) => askHandler && askHandler(name, thread),
    onApprove: (name) => approveHandler && approveHandler(name),
    onRevise: (name, round) => reviseHandler && reviseHandler(name, round)
  });
  try {
    await candidate.listen();
    server = candidate;
    console.log(`[docs] live docs at ${server.url()} (${config.liveDocsDir})`);
  } catch (err) {
    console.warn(`[docs] could not listen on ${config.liveDocsPort}: ${err.message}`);
    store.close();
    store = null;
  }
}

function stop() {
  if (server) server.close();
  if (store) store.close();
  server = null;
  store = null;
}

function requireStore() {
  if (!enabled()) throw new Error('Live docs are off (LESLIE_LIVE_DOCS=0) or failed to start.');
  return store;
}

/** Called with (docName, thread) when someone sends a comment to Leslie. */
function onAsk(fn) {
  askHandler = fn;
}

/** Called with the doc name when the user approves a plan doc. */
function onApprove(fn) {
  approveHandler = fn;
}

/** Called with (docName, { note, threads }) when the user requests changes to a plan doc. */
function onRevise(fn) {
  reviseHandler = fn;
}

const PLAN_STATE = {
  proposed: 'a plan waiting for the user to approve it',
  revising: 'a plan the user asked you to revise',
  approved: 'an approved plan being carried out',
  done: 'a plan that was carried out',
  failed: 'a plan that was not carried out'
};

/** The doc as Leslie sees it: one line per block, `[id] text`, long docs cut short. */
function outline(view, { full = false } = {}) {
  const lines = [`Doc "${view.name}" (rev ${view.rev}) ${server.url(view.name)}`];
  if (view.plan) lines.push(`This doc is ${PLAN_STATE[view.plan.status] || 'a plan'}.`);
  let used = 0;
  let cut = 0;
  for (const b of view.blocks) {
    const body = b.pending !== undefined ? `(pending) ${b.pending}` : b.text;
    if (!full && used + body.length > OUTLINE_CHARS) {
      cut++;
      lines.push(`[${b.id}] ${body.split('\n')[0].slice(0, 80)}…`);
      continue;
    }
    used += body.length;
    lines.push(`[${b.id}] ${body}`);
  }
  if (cut) lines.push(`(${cut} long block(s) shortened; doc_read with an id shows one in full.)`);
  const open = view.threads.filter((t) => !t.resolved);
  if (open.length) {
    lines.push('', 'Open comments:');
    for (const t of open) {
      const last = t.messages[t.messages.length - 1];
      lines.push(`- on [${t.blockId}] "${t.quote.slice(0, 80)}": ${last.author}: ${last.text.slice(0, 200)}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  start,
  stop,
  enabled,
  onAsk,
  onRevise,
  onApprove,
  outline,
  store: requireStore,
  url: (name) => server && server.url(name),
  isOpen: (name) => Boolean(server && server.isOpen(name))
};

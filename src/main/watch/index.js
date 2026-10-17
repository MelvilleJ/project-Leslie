'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const config = require('../config');
const { createWatcher } = require('./watcher');
const { summarize } = require('./summarize');
const { createPostgresSource } = require('./sources/postgres');
const { createImapSource } = require('./sources/imap');

let watcher = null;

function stateFile() {
  return path.join(app.getPath('userData'), 'leslie-watch.json');
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('[watch] could not save state:', err.message);
  }
}

function configuredSources() {
  const sources = [];
  if (config.watchPgUrl && config.watchPgTables.length) {
    sources.push(createPostgresSource({
      url: config.watchPgUrl,
      tables: config.watchPgTables,
      intervalMs: config.watchPgIntervalSec * 1000
    }));
  }
  if (config.watchImapHost && config.watchImapUser) {
    sources.push(createImapSource({
      host: config.watchImapHost,
      port: config.watchImapPort,
      secure: config.watchImapSecure,
      user: config.watchImapUser,
      password: config.watchImapPassword,
      mailbox: config.watchImapMailbox,
      intervalMs: config.watchImapIntervalSec * 1000
    }));
  }
  return sources;
}

/** Start polling every configured source; announce(text) is called with each briefing. */
function start(announce) {
  stop();
  const sources = configuredSources();
  if (!sources.length) return;
  console.log(`[watch] polling ${sources.map((s) => s.name).join(', ')}`);
  watcher = createWatcher({ sources, state: loadState(), save: saveState, summarize, announce });
  watcher.start();
}

function stop() {
  watcher?.stop();
  watcher = null;
}

module.exports = { start, stop };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { stripReplyTags } = require('../agent/replyTags');

function readEntries(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
    }
  }
  return entries;
}

function textContent(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// The session's current position is its last entry; walking parents from there
// gives the active branch, which is what pi resumes.
function activeBranch(entries) {
  const byId = new Map();
  let leaf = null;
  for (const e of entries) {
    if (!e.id) continue;
    byId.set(e.id, e);
    leaf = e;
  }
  const branch = [];
  for (let e = leaf; e; e = e.parentId ? byId.get(e.parentId) : null) branch.push(e);
  return branch.reverse();
}

function title(entries) {
  let name = null;
  for (const e of entries) if (e.type === 'session_info') name = e.name || null;
  if (name) return name;
  const firstUser = entries.find((e) => e.type === 'message' && e.message && e.message.role === 'user');
  const first = firstUser ? textContent(firstUser.message.content).trim().split(/\r?\n/)[0] : '';
  if (!first) return 'New session';
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}

function summarize(file, currentFile) {
  const entries = readEntries(file);
  const header = entries.find((e) => e.type === 'session') || {};
  const messageCount = entries.filter(
    (e) => e.type === 'message' && e.message && (e.message.role === 'user' || e.message.role === 'assistant')
  ).length;
  let updatedAt = 0;
  try {
    updatedAt = fs.statSync(file).mtimeMs;
  } catch {
  }
  return {
    id: file,
    title: title(entries),
    createdAt: header.timestamp ? Date.parse(header.timestamp) : updatedAt,
    updatedAt,
    messageCount,
    current: file === currentFile
  };
}

/** Sessions in pi's session folder for this working directory, newest first. */
function list(dir, currentFile) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  return files
    .map((f) => summarize(path.join(dir, f), currentFile))
    .filter((s) => s.messageCount > 0 || s.current)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A session's active branch as readable user/assistant turns. */
function read(file) {
  const entries = readEntries(file);
  const messages = [];
  for (const e of activeBranch(entries)) {
    if (e.type === 'compaction') {
      messages.push({ role: 'system', content: `Earlier conversation compacted (${e.tokensBefore || '?'} tokens summarized).` });
      continue;
    }
    if (e.type !== 'message' || !e.message) continue;
    const m = e.message;
    if (m.role === 'user') messages.push({ role: 'user', content: textContent(m.content) });
    else if (m.role === 'assistant') {
      const text = stripReplyTags(textContent(m.content)).trim();
      const tools = (m.content || []).filter((b) => b.type === 'toolCall').map((b) => b.name);
      if (text || tools.length) messages.push({ role: 'assistant', content: text || `🔧 ${tools.join(', ')}` });
    } else if (m.role === 'bashExecution') {
      messages.push({ role: 'user', content: `$ ${m.command}` });
    }
  }
  return { id: file, title: title(entries), messages };
}

function isIn(dir, file) {
  const rel = path.relative(dir, String(file || ''));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.endsWith('.jsonl');
}

module.exports = { list, read, isIn };

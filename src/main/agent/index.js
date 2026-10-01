'use strict';

const config = require('../config');
const memory = require('../memory');
const conversations = require('../conversations');
const { FORMAT_INSTRUCTIONS } = require('./streamTurn');
const { runConversation } = require('./loop');
const { extractMemories } = require('./reflect');
const compaction = require('./compaction');
const { TASK_MODE_DIRECTIVE } = require('./toolPolicy');

/** @type {{ role: string, content: string }[]} */
let history = [];

let turnCount = 0;

const pendingConfirms = new Map();
let confirmSeq = 0;

/** Settle a pending confirmation with the user's choice (called from main). */
function resolveConfirm(id, approved) {
  const done = pendingConfirms.get(id);
  if (done) done(Boolean(approved));
}

let currentAbort = null;
function cancel() {
  if (currentAbort) currentAbort.abort();
}

function makeCtx(onEvent, signal) {
  return {
    signal,
    openUrl: (url) => onEvent({ type: 'open-url', url }),
    setMode: (mode) => onEvent({ type: 'set-mode', mode }),
    confirm: (message) =>
      new Promise((resolve) => {
        const id = `c${++confirmSeq}`;
        const done = (approved) => {
          if (!pendingConfirms.has(id)) return;
          pendingConfirms.delete(id);
          resolve(Boolean(approved));
        };
        pendingConfirms.set(id, done);
        const timer = setTimeout(() => done(false), 5 * 60 * 1000);
        if (timer.unref) timer.unref();
        onEvent({ type: 'confirm', id, message });
      })
  };
}

/**
 * Send a user message and stream back the reply, updating history.
 * @param {string} text
 * @param {(event: { type: string, text?: string, url?: string }) => void} onEvent
 * @returns {Promise<string>} the final summary text
 */
// OS facts the capability text adapts to, from the detected/configured target.
function osFacts() {
  if (config.osTarget === 'linux') {
    const distro =
      { debian: 'Debian/Ubuntu (apt)', fedora: 'Fedora (dnf)', arch: 'Arch Linux (pacman)' }[config.linuxDistro] ||
      'Linux';
    return { os: `Linux — ${distro}`, shell: 'bash' };
  }
  return { os: 'Windows', shell: 'PowerShell' };
}

// Read-only filesystem sentence, included only when those tools are enabled.
function fsClause(inAgent) {
  if (!config.fsReadEnabled) return '';
  return inAgent
    ? 'list_directory, read_file, and read_document (read-only: browse folders, read text files, and ' +
        'extract text from Word/PDF/Excel documents on this machine).'
    : 'and list_directory / read_file / read_document to browse folders, read text files, and open ' +
        'Word/PDF/Excel documents on this computer (read-only).';
}

function agentCapabilities() {
  const { os, shell } = osFacts();
  return [
    `AGENT MODE IS ON. You are running on the user's ${os} PC and have tools that REALLY execute here:`,
    `run_command (${shell}), install_software, open_app, open_url, web_search, deep_search, deep_research`,
    '(iterative multi-round research with a long cited report — slow, use only when the user wants',
    'thorough research, not for quick facts),',
    'create_document (make a real Word/PDF/Excel/text file and open it).',
    fsClause(true),
    'When the user asks you to DO something on their computer — clone a repo, create/move/delete files,',
    'install software, run a program, or look at their files — actually CALL the matching tool so it runs. Do',
    'NOT just print the command, and do NOT claim you are sandboxed or separated from their system: you are',
    'not. Your tools run on their machine. Safe/allowlisted commands run immediately; anything else shows the',
    `user an Approve/Deny prompt before it runs, so it is always safe to attempt the call. Use ${shell} syntax,`,
    'then report what actually happened from the tool output.',
    'You can also switch your own mode with set_mode (chat/plan/agent) when the user asks or a task needs it.'
  ].filter(Boolean).join(' ');
}

function chatCapabilities() {
  return [
    'You have tools that really work — call them instead of describing them: web_search and deep_search to',
    'look things up, deep_research for thorough multi-source research when the user wants a long, cited',
    'report (it is slow — a few minutes — so only use it when that depth is actually wanted), open_url to',
    'show a page, open_app to launch an app, and create_document to make a real',
    `Word/PDF/Excel/text file and open it. ${fsClause(false)}`,
    'You cannot run shell commands or install software in this mode.',
    'If the user asks for a system task that needs that (e.g. cloning a repo or installing something), you can',
    'switch yourself with set_mode ("agent") — or tell them to use the 🤖 button — rather than refusing.'
  ].filter(Boolean).join(' ');
}

// Plan mode is covered by the PLAN_MODE_DIRECTIVE the loop injects.
function modeCapabilities() {
  if (!config.toolsEnabled || config.planMode) return '';
  return config.agentMode ? agentCapabilities() : chatCapabilities();
}

function systemContent() {
  const parts = [config.systemPrompt];
  if (config.learningMode) {
    const remembered = memory.format();
    if (remembered) parts.push(remembered);
  }
  const caps = modeCapabilities();
  if (caps) parts.push(caps);
  if (config.taskMode) parts.push(TASK_MODE_DIRECTIVE);
  if (config.detailedResponses) parts.push(FORMAT_INSTRUCTIONS);
  return parts.join('\n\n');
}

async function runMessages(messages, onEvent, text) {
  const controller = new AbortController();
  currentAbort = controller;
  try {
    return await runConversation(messages, onEvent, makeCtx(onEvent, controller.signal), text, controller.signal);
  } finally {
    if (currentAbort === controller) currentAbort = null;
  }
}

/** Assistant mode: run one task with no history, and keep nothing afterwards. */
async function runTask(text, onEvent, contextText) {
  const messages = [
    { role: 'system', content: systemContent() },
    { role: 'user', content: contextText ? `${contextText}\n\n${text}` : text }
  ];
  const { summary, aborted } = await runMessages(messages, onEvent, text);
  return { reply: summary.trim(), aborted };
}

async function sendMessage(text, onEvent, contextText) {
  // "@"-mention attachments (file/folder contents) ride along with this turn's
  // user message so the model can see them, but only the clean text is stored in
  // history — keeping the transcript readable and within the history window.
  const userContent = contextText ? `${contextText}\n\n${text}` : text;

  history = await compaction.maybeCompact(history);

  const messages = [
    { role: 'system', content: systemContent() },
    ...history,
    { role: 'user', content: userContent }
  ];

  const { summary, details, aborted } = await runMessages(messages, onEvent, text);

  const stored = [summary.trim(), details.trim()].filter(Boolean).join('\n\n') || summary;
  history.push({ role: 'user', content: text }, { role: 'assistant', content: stored });
  if (history.length > config.historyLimit) {
    history = history.slice(history.length - config.historyLimit);
  }

  try {
    conversations.appendExchange(text, stored);
  } catch {
  }

  turnCount++;
  if (config.learningMode && config.learnEvery > 0 && turnCount % config.learnEvery === 0) {
    extractMemories(history.slice()).catch(() => {});
  }

  return { reply: summary.trim(), aborted };
}

/**
 * Record a completed /research run into the conversation history so follow-up
 * chat turns ("make a document from this") can see it. The dedicated research
 * flow bypasses the agent loop, so without this the report never enters history.
 */
function recordResearch(query, reportText) {
  const stored = String(reportText || '').trim();
  if (!stored) return;
  const userText = `[Deep research] ${query}`;
  history.push({ role: 'user', content: userText }, { role: 'assistant', content: stored });
  if (history.length > config.historyLimit) history = history.slice(history.length - config.historyLimit);
  try {
    conversations.appendExchange(userText, stored);
  } catch {
  }
}

/** Forget the conversation so far (and start a fresh transcript). */
function reset() {
  if (config.learningMode && config.learnEvery > 0 && history.length) {
    extractMemories(history.slice()).catch(() => {});
  }
  history = [];
  turnCount = 0;
  try {
    conversations.startNew();
  } catch {
  }
}

/**
 * Reload a stored conversation as the working context so follow-ups continue it.
 * Trims to the history window. @returns {boolean} whether it was found.
 */
function resume(id) {
  const messages = conversations.resume(id);
  if (!messages) return false;
  history = messages.slice(-config.historyLimit);
  turnCount = 0;
  return true;
}

module.exports = { sendMessage, runTask, reset, resolveConfirm, resume, cancel, recordResearch };

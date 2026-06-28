'use strict';

const config = require('../config');
const memory = require('../memory');
const conversations = require('../conversations');
const { FORMAT_INSTRUCTIONS } = require('./streamTurn');
const { runConversation } = require('./loop');
const { extractMemories } = require('./reflect');

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

function makeCtx(onEvent) {
  return {
    openUrl: (url) => onEvent({ type: 'open-url', url }),
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
const AGENT_CAPABILITIES = [
  'AGENT MODE IS ON. You are running on the user\'s Windows PC and have tools that REALLY execute here:',
  'run_command (PowerShell), install_software (winget), open_app, open_url, web_search, deep_search,',
  'create_document (make a real Word/PDF/Excel/text file and open it).',
  'When the user asks you to DO something on their computer — clone a repo, create/move/delete files,',
  'install software, run a program — actually CALL the matching tool so it runs. Do NOT just print the',
  'command, and do NOT claim you are sandboxed or separated from their system: you are not. Your tools',
  'run on their machine. Safe/allowlisted commands run immediately; anything else shows the user an',
  'Approve/Deny prompt before it runs, so it is always safe to attempt the call. Use PowerShell syntax,',
  'then report what actually happened from the tool output.'
].join(' ');

const CHAT_CAPABILITIES = [
  'You have tools that really work — call them instead of describing them: web_search and deep_search to',
  'look things up, open_url to show a page, open_app to launch an app, and create_document to make a real',
  'Word/PDF/Excel/text file and open it. You cannot run shell commands or install software in this mode.',
  'If the user asks for a system task that needs that (e.g. cloning a repo or installing something), tell',
  'them to switch to Agent mode (the 🤖 button) rather than refusing.'
].join(' ');

// Plan mode is covered by the PLAN_MODE_DIRECTIVE the loop injects.
function modeCapabilities() {
  if (!config.toolsEnabled || config.planMode) return '';
  return config.agentMode ? AGENT_CAPABILITIES : CHAT_CAPABILITIES;
}

async function sendMessage(text, onEvent) {
  const parts = [config.systemPrompt];
  if (config.learningMode) {
    const remembered = memory.format();
    if (remembered) parts.push(remembered);
  }
  const caps = modeCapabilities();
  if (caps) parts.push(caps);
  if (config.detailedResponses) parts.push(FORMAT_INSTRUCTIONS);
  const systemContent = parts.join('\n\n');

  const messages = [
    { role: 'system', content: systemContent },
    ...history,
    { role: 'user', content: text }
  ];

  const { summary, details } = await runConversation(messages, onEvent, makeCtx(onEvent), text);

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

  return summary.trim();
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

module.exports = { sendMessage, reset, resolveConfirm, resume };

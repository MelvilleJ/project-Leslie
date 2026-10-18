'use strict';

const config = require('../config');

// Extra system-prompt sections pi gets in plan and assistant mode.

function planModeDirective(liveDocs) {
  const investigate = [
    'PLAN MODE IS ACTIVE. Investigate freely with read-only tools: read, grep, find, ls, web search,',
    'and read-only shell commands (ls, cat, grep, git log, systemctl status, pacman -Q). You must NOT',
    "change anything on the user's computer: no installing software, launching apps, or changing files"
  ];
  if (!liveDocs) {
    return [
      ...investigate,
      '. When you have enough understanding, STOP and propose a concise, numbered plan of what you',
      'would do, then wait for the user to approve before acting.'
    ].join(' ');
  }
  return [
    ...investigate,
    `other than markdown in the live docs folder (${config.liveDocsDir}).`,
    'When you have enough understanding, write the plan as a live doc with doc_create (or doc_edit to',
    'revise one): a one-line goal, then numbered steps concrete enough to carry out later (the exact',
    'commands, files and settings). The doc gets an Approve button, and the user may edit it first.',
    'Then STOP: reply in one or two sentences pointing to the doc. Do not carry out any step yourself;',
    'approving it switches you to agent mode and sends you the plan to carry out.'
  ].join(' ');
}

const TASK_MODE_DIRECTIVE = [
  'ASSISTANT MODE IS ACTIVE. Each message is a standalone task: there is no earlier',
  'conversation and nothing you say is kept afterwards. Carry the task out now with your',
  'tools, then reply with one short sentence saying what you did (or why it could not be',
  'done). Only ask a question when the task is impossible without the answer.'
].join(' ');

module.exports = { planModeDirective, TASK_MODE_DIRECTIVE };

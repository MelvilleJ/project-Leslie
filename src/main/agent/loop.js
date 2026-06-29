'use strict';

// reliability guards, gates + executes tools, wraps their output as untrusted

const config = require('../config');
const tools = require('../tools');
const { streamTurn } = require('./streamTurn');
const { resolveToolCalls } = require('./toolResolve');
const { selectTools } = require('./toolIndex');
const { buildPolicy, wrapUntrusted } = require('./toolPolicy');
const { createGuards, emptyFallback } = require('./loopGuards');

function announceTool(onEvent, name, args) {
  let detail;
  if (name === 'web_search' || name === 'deep_search' || name === 'open_search') detail = `"${args.query ?? ''}"`;
  else if (name === 'open_url') detail = `"${args.url ?? ''}"`;
  else if (name === 'open_app') detail = `"${args.app ?? ''}"`;
  else if (name === 'run_command') detail = `"${args.command ?? ''}"`;
  else if (name === 'install_software') detail = `"${args.id || args.name || ''}"`;
  else if (name === 'create_document') detail = `"${args.filename ?? 'document'}.${args.format ?? 'txt'}"`;
  else if (name === 'remember') detail = `"${args.text ?? ''}"`;
  else detail = JSON.stringify(args);
  onEvent({ type: 'thinking', text: `\n🔧 ${name}(${detail})\n` });
  // Distinct signal (separate from reasoning text) so the UI can react to tool
  // use — e.g. the companion playing a "tool-call" animation.
  onEvent({ type: 'tool', name });
}

// single user message (already wrapped as untrusted by the caller).
function appendResults(messages, turn, usedNative, executed) {
  if (usedNative) {
    messages.push({
      role: 'assistant',
      content: turn.summary || null,
      tool_calls: executed.map((e) => ({
        id: e.call.id,
        type: 'function',
        function: { name: e.call.name, arguments: e.call.arguments }
      }))
    });
    for (const e of executed) {
      messages.push({ role: 'tool', tool_call_id: e.call.id, name: e.call.name, content: e.resultText });
    }
  } else {
    messages.push({ role: 'assistant', content: turn.rawContent || turn.summary || '' });
    const combined = executed.map((e) => `### ${e.call.name}\n${e.resultText}`).join('\n\n');
    messages.push({ role: 'user', content: combined });
  }
}

/**
 * Run model turns, executing any requested tools, until a final answer.
 * @param {object[]} messages full message array (system + history + user)
 * @param {(event:object)=>void} onEvent UI event sink (think/summary/details/open-url/confirm)
 * @param {object} ctx tool context (openUrl, confirm)
 * @param {string} userText the latest user message (drives tool selection)
 */
async function runConversation(messages, onEvent, ctx, userText) {
  let summary = '';
  let details = '';

  const metaList = tools.list();
  const metaByName = new Map(metaList.map((m) => [m.name, m]));
  const allNames = metaList.map((m) => m.name);
  const policy = buildPolicy(metaByName);
  const guards = createGuards();

  if (policy.planMode) {
    messages.unshift({ role: 'system', content: policy.directive });
  }

  let selectedNames = allNames;
  if (config.toolsEnabled) {
    try {
      selectedNames = await selectTools(userText, metaList);
    } catch {
      selectedNames = allNames;
    }
    const effectful = metaList.filter((m) => !m.readOnly).map((m) => m.name);
    selectedNames = Array.from(new Set([...selectedNames, ...effectful]));
    if (config.learningMode && metaByName.has('remember')) selectedNames.push('remember');
    selectedNames = policy.filterNames(selectedNames);
  }

  let forceAnswer = false;

  for (let step = 0; step <= config.maxToolCalls; step++) {
    const specs = forceAnswer || !config.toolsEnabled ? [] : tools.specs(selectedNames);
    const turn = await streamTurn(messages, onEvent, { tools: specs });
    summary += turn.summary;
    details += turn.details;

    const { calls, usedNative } = resolveToolCalls(turn, allNames);
    const hadAnswerText = Boolean((turn.summary || turn.details || '').trim());

    if (forceAnswer) {
      return { summary: summary || emptyFallback(), details };
    }

    if (!config.toolsEnabled || !calls.length) {
      const nudge = guards.intentNudge(turn.summary || turn.details);
      if (nudge && step < config.maxToolCalls) {
        messages.push({ role: 'assistant', content: turn.rawContent || turn.summary || '' });
        messages.push({ role: 'system', content: nudge });
        continue;
      }
      return { summary, details };
    }

    const verdict = guards.recordToolRound(calls, hadAnswerText);
    if (verdict.forceAnswer) {
      forceAnswer = true;
      messages.push({ role: 'assistant', content: turn.rawContent || turn.summary || '' });
      messages.push({
        role: 'system',
        content:
          `You're ${verdict.reason}. STOP calling tools and finish: either write your ` +
          'best answer now from what you already have, or say plainly what is blocking you.'
      });
      continue;
    }

    // Execute each call (policy-gated), wrapping output as untrusted data.
    const executed = [];
    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.arguments || '{}');
      } catch {
      }
      announceTool(onEvent, call.name, args);

      let resultText;
      if (!policy.allows(call.name)) {
        resultText = policy.reasonFor(call.name);
      } else {
        try {
          const result = await tools.run(call.name, args, ctx);
          resultText = typeof result === 'string' ? result : JSON.stringify(result);
        } catch (err) {
          resultText = `Error running ${call.name}: ${err && err.message ? err.message : String(err)}`;
        }
      }
      executed.push({ call, resultText: wrapUntrusted(call.name, resultText) });
    }

    appendResults(messages, turn, usedNative, executed);
  }

  return { summary: summary || '(stopped after too many tool calls)', details };
}

module.exports = { runConversation };

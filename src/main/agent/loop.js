'use strict';

const config = require('../config');
const tools = require('../tools');
const { streamTurn } = require('./streamTurn');
const { resolveToolCalls } = require('./toolResolve');
const { selectTools } = require('./toolIndex');
const { buildPolicy, wrapUntrusted } = require('./toolPolicy');
const { createGuards, emptyFallback } = require('./loopGuards');
const { fitRequest, completionBudget } = require('./budget');
const permission = require('./permission');
const { InvalidArgumentsError } = require('./errors');
const { withRetry } = require('./retry');
const { parseToolArgs } = require('./toolArgs');

function askMessage(name, detail) {
  return `Run ${name}${detail ? `: ${detail}` : ''}?`;
}

function toolDetail(name, args) {
  if (name === 'web_search' || name === 'deep_search' || name === 'open_search') return args.query ?? '';
  if (name === 'open_url') return args.url ?? '';
  if (name === 'open_app') return args.app ?? '';
  if (name === 'run_command') return args.command ?? '';
  if (name === 'install_software') return args.id || args.name || '';
  if (name === 'create_document') return `${args.filename ?? 'document'}.${args.format ?? 'txt'}`;
  if (name === 'remember') return args.text ?? '';
  if (name === 'read_file' || name === 'read_document' || name === 'list_directory') {
    return args.path ?? args.filename ?? args.dir ?? '';
  }
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
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

async function runConversation(messages, onEvent, ctx, userText, signal) {
  let summary = '';
  let details = '';
  const aborted = () => Boolean(signal && signal.aborted);

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
    // On large contexts, advertise all effectful tools; on small, trust per-query selection.
    if (config.contextTokens >= 8192) {
      const effectful = metaList.filter((m) => !m.readOnly).map((m) => m.name);
      selectedNames = Array.from(new Set([...selectedNames, ...effectful]));
    }
    if (config.learningMode && metaByName.has('remember')) selectedNames.push('remember');
    selectedNames = policy.filterNames(selectedNames);
  }

  let forceAnswer = false;

  for (let step = 0; step <= config.maxToolCalls; step++) {
    if (aborted()) return { summary, details, aborted: true };
    const wantSpecs = forceAnswer || !config.toolsEnabled ? [] : tools.specs(selectedNames);
    // Trim request to fit context window, dropping specs if needed to allow answers.
    const fit = fitRequest(messages, wantSpecs);
    const maxTokens = completionBudget(fit.messages, fit.specs);
    console.error(`[leslie] req step ${step}: msgs=${fit.messages.length} specs=${fit.specs.length} droppedSpecs=${fit.droppedSpecs} maxTokens=${maxTokens}`);
    let turn;
    try {
      turn = await withRetry(
        () => streamTurn(fit.messages, onEvent, { tools: fit.specs, maxTokens, signal }),
        { onRetry: (n) => onEvent({ type: 'thinking', text: `\n(model call failed, retrying #${n + 1}…)\n` }) }
      );
    } catch (err) {
      if (aborted() || (err && err.name === 'AbortError')) {
        return { summary, details, aborted: true };
      }
      throw err;
    }
    summary += turn.summary;
    details += turn.details;

    const { calls, usedNative } = resolveToolCalls(turn, allNames);
    const hadAnswerText = Boolean((turn.summary || turn.details || '').trim());

    console.error(`[leslie] step ${step}: native=${usedNative} calls=[${calls.map((c) => c.name).join(', ') || 'none'}] answerText=${hadAnswerText} rawLen=${(turn.rawContent || '').length}`);
    if (!calls.length && turn.rawContent) console.error('[leslie] raw content:', JSON.stringify(turn.rawContent.slice(0, 400)));

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

    if (aborted()) return { summary, details, aborted: true };

    // Execute each call (policy-gated), wrapping output as untrusted data.
    const executed = [];
    for (const [i, call] of calls.entries()) {
      if (aborted()) break;
      const meta = metaByName.get(call.name);
      const parsed = parseToolArgs(call.arguments);
      const args = parsed.args;
      const parseErr = !parsed.ok;
      const detail = toolDetail(call.name, args);
      const toolId = call.id || `tool-${step}-${i}`;
      onEvent({ type: 'thinking', text: `\n🔧 ${call.name}(${detail ? `"${detail}"` : ''})\n` });
      onEvent({ type: 'tool', phase: 'start', id: toolId, name: call.name, detail });

      let resultText;
      let title;
      let ok = true;
      const missing = ((meta && meta.required) || []).filter((k) => args[k] === undefined || args[k] === null);
      const decision = permission.decide(call.name, meta, args);
      console.error(`[leslie] run ${call.name}: parseOk=${!parseErr} missing=[${missing.join(',')}] decision=${decision} argKeys=[${Object.keys(args).join(',')}]`);

      if (parseErr) {
        resultText = new InvalidArgumentsError(call.name, 'the arguments were not valid JSON').message;
        ok = false;
      } else if (missing.length) {
        resultText = new InvalidArgumentsError(call.name, `missing required argument(s): ${missing.join(', ')}`).message;
        ok = false;
      } else if (decision === 'deny') {
        resultText = permission.denyReason(call.name);
        ok = false;
      } else {
        let approved = true;
        if (decision === 'ask') {
          approved = typeof ctx.confirm === 'function' ? await ctx.confirm(askMessage(call.name, detail)) : false;
          if (approved) permission.remember(call.name, args);
        }
        if (!approved) {
          resultText = `The user declined to run ${call.name}.`;
          ok = false;
        } else {
          const onProgress = (p) => {
            const d = typeof p === 'string' ? p : (p && p.label) || '';
            const research = p && typeof p === 'object' ? p.event : undefined;
            onEvent({ type: 'tool', phase: 'progress', id: toolId, name: call.name, detail: d, research });
          };
          try {
            const result = await tools.run(call.name, args, { ...ctx, onProgress });
            if (result && typeof result === 'object' && typeof result.output === 'string') {
              resultText = result.output;
              title = result.title;
            } else {
              resultText = typeof result === 'string' ? result : JSON.stringify(result);
            }
          } catch (err) {
            resultText = err instanceof InvalidArgumentsError
              ? err.message
              : `Error running ${call.name}: ${err && err.message ? err.message : String(err)}`;
            ok = false;
          }
        }
      }
      onEvent({ type: 'tool', phase: 'end', id: toolId, name: call.name, ok, title });
      console.error(`[leslie] done ${call.name}: ok=${ok} result=${JSON.stringify(String(resultText).slice(0, 200))}`);
      executed.push({ call, resultText: wrapUntrusted(call.name, resultText) });
    }

    appendResults(messages, turn, usedNative, executed);
  }

  return { summary: summary || '(stopped after too many tool calls)', details };
}

module.exports = { runConversation };

'use strict';

const MAX_DEPTH = 2;

module.exports = {
  name: 'run_subagent',
  readOnly: true,
  description:
    'Delegate a focused, self-contained sub-task to a scoped agent that runs its own tool loop and ' +
    'returns a concise result. Use for multi-step lookups or research you want handled in one shot. ' +
    'The subagent inherits the current mode (read-only in plan mode).',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The self-contained task for the subagent to complete.' }
    },
    required: ['prompt']
  },

  async run({ prompt }, ctx = {}) {
    const task = String(prompt || '').trim();
    if (!task) return 'No task provided.';
    const depth = (ctx.depth || 0) + 1;
    if (depth > MAX_DEPTH) return 'Subagent depth limit reached; do this step directly instead.';

    const { runConversation } = require('../agent/loop');
    const messages = [
      { role: 'system', content: 'You are a focused sub-agent. Complete the task using the available tools, then reply with a concise result. Do not chat or ask questions.' },
      { role: 'user', content: task }
    ];
    const childCtx = { ...ctx, depth };
    const { summary, details } = await runConversation(messages, () => {}, childCtx, task, ctx.signal);
    return [summary, details].filter((s) => s && s.trim()).join('\n\n') || '(subagent produced no result)';
  }
};

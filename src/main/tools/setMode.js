'use strict';

const MODES = ['chat', 'plan', 'agent', 'assistant'];

module.exports = {
  name: 'set_mode',
  readOnly: true,
  description:
    "Switch LESLIE's operating mode. 'chat' is conversation only; 'plan' investigates read-only " +
    'and writes a plan as a live doc for the user to approve; \'agent\' can run shell commands, install software, and change ' +
    'files; \'assistant\' runs each request as a one-off task without keeping the conversation. Use when the user asks to switch modes ("switch to agent mode", "go into plan mode") or ' +
    'when a task the user asked for needs a mode you are not in — in that case switch, then continue. ' +
    'The change applies from the next turn. NOT for "power mode" or "everyday mode" — those are ' +
    'model profiles; use model_profile for them.',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: MODES,
        description: "The mode to switch to: 'chat', 'plan', 'agent', or 'assistant'."
      }
    },
    required: ['mode']
  },
  async run({ mode }, ctx) {
    const m = String(mode || '').trim().toLowerCase();
    if (!MODES.includes(m)) {
      throw new Error(`mode must be one of: ${MODES.join(', ')}`);
    }
    if (typeof ctx.setMode !== 'function') throw new Error('mode switching is unavailable');
    ctx.setMode(m);
    return { title: `Mode → ${m}`, output: `Switched to ${m} mode. It takes effect on the next turn.` };
  }
};

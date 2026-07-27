'use strict';

const MODES = ['chat', 'plan', 'agent'];

module.exports = {
  name: 'set_mode',
  readOnly: true,
  description:
    "Switch LESLIE's operating mode. 'chat' is conversation only; 'plan' is read-only planning " +
    '(no changes to the computer); \'agent\' can run shell commands, install software, and change ' +
    'files. Use when the user asks to switch modes ("switch to agent mode", "go into plan mode") or ' +
    'when a task the user asked for needs a mode you are not in — in that case switch, then continue. ' +
    'The change applies from the next turn.',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: MODES,
        description: "The mode to switch to: 'chat', 'plan', or 'agent'."
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

'use strict';

// Switch the model server between the Everyday (RTX 3060) and Power (both GPUs)
// profiles. The model calling this is the one being swapped, so the switch is
// queued until the current reply has finished.

// Required lazily: the controller depends on the agent, which loads the tools.
const controller = () => require('../server/controller');

module.exports = {
  name: 'model_profile',
  readOnly: true,
  description:
    'Switch between POWER MODE and EVERYDAY MODE — which AI model LESLIE runs on. "power" loads the ' +
    'strongest model across both GPUs; "everyday" loads the fast model on one GPU. Use this whenever the ' +
    'user says "power mode", "everyday mode", or asks for a smarter/bigger/faster model; "status" reports ' +
    'which is active. (Chat/plan/agent/assistant are different — those use set_mode.) Loading takes ' +
    '10–30 seconds and starts right after your reply, so tell the user it is switching.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['everyday', 'power', 'status'],
        description: "'everyday' or 'power' to switch, 'status' to check."
      }
    },
    required: ['action']
  },
  async run({ action }) {
    const server = controller();
    const st = await server.status();
    if (action === 'status') {
      const active = st.profiles.find((p) => p.name === st.activeProfile);
      return {
        active: st.activeProfile || 'none',
        model: active ? active.model : null,
        profiles: st.profiles.map((p) => ({ name: p.name, model: p.model, gpus: p.devices, state: p.state }))
      };
    }
    if (action !== 'everyday' && action !== 'power') throw new Error("action must be 'everyday', 'power' or 'status'");
    if (st.activeProfile === action) return { already: action, note: `The ${action} model is already loaded.` };
    const now = server.requestSwitch(action);
    return {
      switching: action,
      note: now
        ? `Loading the ${action} model now.`
        : `The ${action} model loads as soon as this reply finishes (10–30 s). Tell the user it is switching.`
    };
  }
};

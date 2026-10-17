'use strict';

// Takes a fresh frame from the leslie-vision camera and hands it to the model,
// so it can say what the user is holding or showing and search for it.

const config = require('../config');
const { createClient } = require('../presence/client');

const client = createClient(() => config.cameraServerUrl);

/** false when llama.cpp says the loaded model has no image input; null when it can't tell. */
async function modelSeesImages() {
  if (!config.serverManaged || !config.serverModel) return null;
  try {
    const res = await fetch(`${config.baseURL}/models`, { signal: AbortSignal.timeout(3000) });
    const entry = ((await res.json()).data || []).find((m) => m.id === config.serverModel);
    const inputs = entry?.architecture?.input_modalities;
    return Array.isArray(inputs) ? inputs.includes('image') : null;
  } catch {
    return null;
  }
}

module.exports = {
  name: 'look',
  readOnly: true,
  description:
    "Look through the user's camera and see what is in front of it right now. Use for \"what am I holding\", " +
    '"what is this", "can you see this", "read this label", "how do I look" and similar. The image comes back ' +
    'to you to describe; if the user also asks to look it up, follow up with web_search using what you saw ' +
    '(brand, model, title or any printed text).',
  parameters: {
    type: 'object',
    properties: {
      focus: { type: 'string', description: 'What to pay attention to, e.g. "the object in my hand". Optional.' }
    }
  },
  async run({ focus } = {}) {
    if (!config.cameraEnabled) return { output: 'The camera is turned off. The user can turn it on from the tray or Settings → Camera.' };
    if ((await modelSeesImages()) === false) {
      return { output: `The current model (${config.serverModel}) cannot see images: it was loaded without a vision projector (mmproj).` };
    }
    let view;
    try {
      view = await client.look();
    } catch (err) {
      return { output: `Could not get a picture from the camera: ${err.message}` };
    }
    const jpeg = (data) => ({ data, mimeType: 'image/jpeg' });
    const hint = focus ? ` Focus on: ${focus}.` : '';
    if (view.crop) {
      return {
        output: "The user is pointing at something. The first image is a close-up of where they are pointing; the " +
          `second is the whole camera view for context.${hint} Identify what they are pointing at; if unsure, say what it most likely is.`,
        images: [jpeg(view.crop), jpeg(view.image)]
      };
    }
    return {
      output: `Here is the camera view, taken just now from in front of the user's desk.${hint} ` +
        'Describe what is relevant plainly; if you are unsure what an object is, say what it most likely is.',
      images: [jpeg(view.image)]
    };
  }
};

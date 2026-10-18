'use strict';

// How a helper finishes. LESLIE reads the arguments from the helper's event
// stream and checks every quote against what the helper read.

module.exports = {
  name: 'report',
  readOnly: true,
  helperOnly: true,
  description:
    'Finish your task: call this exactly once with your answer and the evidence for it. Each quote must ' +
    'be copied word for word from a page or search result you read in this task; LESLIE checks every ' +
    'quote against what you read and discards answers that the quotes do not back up.',
  parameters: {
    type: 'object',
    properties: {
      answer: { type: 'string', description: 'Just the direct answer, in one or two sentences. No extra background.' },
      evidence: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Where the quote came from.' },
            quote: { type: 'string', description: 'Exact text from that page or result (under 300 characters) that states the answer.' }
          },
          required: ['url', 'quote']
        }
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'low when sources disagree or only partly answer.' },
      unknowns: { type: 'string', description: 'Anything you could not confirm, or where sources disagreed.' }
    },
    required: ['answer', 'evidence', 'confidence']
  },
  async run() {
    return 'Report received. You are done: stop now.';
  }
};

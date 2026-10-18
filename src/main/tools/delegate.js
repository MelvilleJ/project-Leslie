'use strict';

// Hand small lookup tasks to helper Leslies running a small model on the
// second GPU, in parallel, so the main model's context stays clear.

// Required lazily: helpers loads the pi backend, which loads the tools.
const helpers = () => require('../helpers');

module.exports = {
  name: 'delegate',
  // Helpers only look things up, so delegating is fine in plan mode too.
  readOnly: true,
  description:
    'Send up to 3 small, independent lookup tasks to helper Leslies who work in parallel on a ' +
    'smaller model and report back. Helpers can search the web, read files and folders, and read ' +
    'documents and live docs; they cannot run commands, change anything, or see this conversation, ' +
    'so write each task so it stands alone (include names, paths and what to report). Use it for ' +
    'several separate look-ups at once (e.g. compare three products, check two folders) or one long ' +
    'search whose details you do not need. Do quick single look-ups yourself. Say exactly what each ' +
    'answer must contain with answer_format. Each report comes with quotes and a verification: ' +
    '"verified" means its quotes were found in what the helper read and back the answer; for ' +
    '"partly" or "unverified", treat the answer as a lead and check it yourself before relying on it.',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'A two-to-four word name shown under the helper, e.g. "Laptop prices".' },
            task: { type: 'string', description: 'The complete, self-contained task.' },
            answer_format: {
              type: 'string',
              description: 'What the answer must contain, e.g. "version number and release date" or "price in GBP with the shop".'
            }
          },
          required: ['label', 'task']
        }
      }
    },
    required: ['tasks']
  },
  async run({ tasks }, { signal, onProgress } = {}) {
    if (!Array.isArray(tasks) || !tasks.length) throw new Error('Give at least one task.');
    const reports = await helpers().delegate(tasks, { signal, onProgress });
    return { reports };
  }
};

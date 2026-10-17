'use strict';

const docs = require('../docs');

const nameParam = { type: 'string', description: 'The doc name, as doc_list or doc_create gave it.' };

function openInBrowser(name, ctx) {
  if (!docs.isOpen(name) && typeof ctx.openUrl === 'function') ctx.openUrl(docs.url(name));
}

function editSummary(store, name, out) {
  const lines = out.results.map((r, i) => (r.ok ? `op ${i + 1}: ok${r.ids.length ? ` → ${r.ids.join(', ')}` : ''}` : `op ${i + 1}: refused: ${r.error}`));
  const refused = out.results.some((r) => !r.ok);
  const view = refused ? store.readForLeslie(name) : out.doc;
  return `${lines.join('\n')}\n\n${docs.outline(view)}`;
}

const docList = {
  name: 'doc_list',
  readOnly: true,
  description: "List the user's live docs (markdown they and you edit together in the browser), newest first.",
  parameters: { type: 'object', properties: {} },
  async run() {
    const list = docs.store().list();
    if (!list.length) return 'No live docs yet.';
    return list.map((d) => `- ${d.name} (edited ${new Date(d.modified).toLocaleString()})`).join('\n');
  }
};

const docRead = {
  name: 'doc_read',
  readOnly: true,
  description:
    'Read a live doc as a list of blocks, each "[id] markdown", plus its open comments. ' +
    'Read before editing: the ids are what doc_edit targets, and edits to blocks the user changed since your last read are refused.',
  parameters: {
    type: 'object',
    properties: {
      name: nameParam,
      id: { type: 'string', description: 'Optional block id to show just that block in full.' }
    },
    required: ['name']
  },
  async run({ name, id }) {
    const store = docs.store();
    const view = store.readForLeslie(store.resolve(name));
    if (id) {
      const block = view.blocks.find((b) => b.id === id);
      return block ? `[${block.id}] ${block.text}` : `No block ${id} in "${view.name}".`;
    }
    return docs.outline(view);
  }
};

const docCreate = {
  name: 'doc_create',
  description:
    'Create a live doc and open it in the browser, where the user watches it fill and can edit it with you. ' +
    'For anything you will write in steps (research, long sections), put the title and one placeholder line per ' +
    'section, "<!-- pending: Section: what will go here -->", then fill each with doc_edit replace, one section per call. ' +
    'Prefer this over create_document when the user wants a doc to work on together.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Doc title; also its file name.' },
      markdown: { type: 'string', description: 'Initial markdown, usually "# Title" plus pending placeholders.' }
    },
    required: ['title']
  },
  async run({ title, markdown }, ctx = {}) {
    const store = docs.store();
    const view = store.create(title, markdown || `# ${title}\n`);
    openInBrowser(view.name, ctx);
    return `Created and opened.\n\n${docs.outline(store.readForLeslie(view.name))}`;
  }
};

const docEdit = {
  name: 'doc_edit',
  description:
    'Change a live doc block by block; the user sees each change live. Change only what was asked. Ops run in order and each lands or is refused on its own:\n' +
    '- {"op":"replace","id":"<block id>","text":"<markdown>"}: rewrite a block (several paragraphs allowed); empty text deletes it. Use it to fill a pending placeholder.\n' +
    '- {"op":"insert","after":"<block id>","text":"<markdown>"} (or "before"; neither = end of doc)\n' +
    '- {"op":"delete","id":"<block id>"}\n' +
    '- {"op":"find","find":"<exact words>","replace":"<new words>","nth":1}: reword in place without ids.\n' +
    'A refused op means the user edited that block since your read: keep their edit and read again.',
  parameters: {
    type: 'object',
    properties: {
      name: nameParam,
      ops: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['replace', 'insert', 'delete', 'find'] },
            id: { type: 'string' },
            after: { type: 'string' },
            before: { type: 'string' },
            text: { type: 'string' },
            find: { type: 'string' },
            replace: { type: 'string' },
            nth: { type: 'number' }
          },
          required: ['op']
        }
      }
    },
    required: ['name', 'ops']
  },
  async run({ name, ops }, ctx = {}) {
    const store = docs.store();
    const resolved = store.resolve(name);
    openInBrowser(resolved, ctx);
    return editSummary(store, resolved, store.apply(resolved, ops, 'leslie'));
  }
};

const docOpen = {
  name: 'doc_open',
  readOnly: true,
  description: 'Open a live doc (or the list of docs, with no name) in the browser for the user.',
  parameters: { type: 'object', properties: { name: nameParam } },
  async run({ name } = {}, ctx = {}) {
    const resolved = name ? docs.store().resolve(name) : null;
    if (typeof ctx.openUrl === 'function') ctx.openUrl(docs.url(resolved));
    return `Opened ${docs.url(resolved)}`;
  }
};

module.exports = [docList, docRead, docCreate, docEdit, docOpen];

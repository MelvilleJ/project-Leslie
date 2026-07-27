'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const config = require('../config');
const { resolvePath } = require('./lib/osPaths');
const { InvalidArgumentsError } = require('../agent/errors');

function underRoots(target, roots) {
  if (!roots.length) return true;
  return roots.some((root) => {
    const r = path.resolve(root);
    return target === r || target.startsWith(r + path.sep);
  });
}

function preview(target, content, exists, oldSize) {
  const bytes = Buffer.byteLength(content, 'utf8');
  const lines = content.split('\n');
  const head = lines.slice(0, 15).join('\n');
  const verb = exists ? `Overwrite existing file (${oldSize} B → ${bytes} B)` : `Create new file (${bytes} B)`;
  return `Write this file?\n${target}\n${verb}\n\n${head}${lines.length > 15 ? '\n…' : ''}`;
}

module.exports = {
  name: 'write_file',
  readOnly: false,
  selfGates: true,
  description:
    "Create or overwrite a plain text/code/config file at a path on the user's computer. " +
    'Use for saving notes, scripts, configs, data files, etc. For Word/PDF/Excel, use create_document instead.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Destination path: absolute, "~/…", or a named location like Documents.' },
      content: { type: 'string', description: 'The full text content to write.' },
      overwrite: { type: 'boolean', description: 'Set true to replace an existing file (still asks for approval).' }
    },
    required: ['path', 'content']
  },

  async run({ path: spec, content, overwrite }, ctx = {}) {
    if (!spec || !String(spec).trim()) throw new InvalidArgumentsError('write_file', 'path is required');
    if (typeof content !== 'string') throw new InvalidArgumentsError('write_file', 'content must be a string');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > config.fsWriteMaxBytes) {
      throw new InvalidArgumentsError('write_file', `content is ${bytes} bytes, over the ${config.fsWriteMaxBytes}-byte limit`);
    }

    const target = resolvePath(spec);
    if (!underRoots(target, config.fsWriteRoots)) {
      return `Refused: ${target} is outside the allowed write folders (${config.fsWriteRoots.join(', ') || 'none configured'}).`;
    }

    let exists = false;
    let oldSize = 0;
    try {
      const st = await fsp.stat(target);
      exists = st.isFile();
      oldSize = st.size;
    } catch {}

    if (typeof ctx.confirm === 'function') {
      const approved = await ctx.confirm(preview(target, content, exists, oldSize));
      if (!approved) return `User declined to write ${target}.`;
    }

    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
    return { title: `Wrote ${path.basename(target)}`, output: `${exists ? 'Overwrote' : 'Created'} ${target} (${bytes} bytes).` };
  }
};

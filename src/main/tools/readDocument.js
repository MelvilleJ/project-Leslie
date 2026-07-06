'use strict';

// Read-only document reader: extracts the text of Word (.docx), PDF (.pdf),
// Excel (.xlsx/.xls), and text-like files (csv, txt, md, html, json, …) so the
// companion can view them. Complements read_file (raw text/code) and reuses the
// same OS-aware path resolution as the other filesystem tools.

const fs = require('node:fs');
const config = require('../config');
const { resolvePath, isRootsRequest } = require('./lib/osPaths');
const { extractDocument, SUPPORTED } = require('./lib/docExtract');

module.exports = {
  name: 'read_document',
  readOnly: true,
  description:
    "Read the text of a document on the user's computer (read-only): Word (.docx), PDF (.pdf), " +
    'Excel (.xlsx/.xls), or text-like files (csv, txt, md, html, json, log, …). Use this for ' +
    'documents and spreadsheets; use read_file for plain code/text. Accepts an absolute path, ' +
    'a "~" path, or a shortcut-relative path (e.g. "Documents/report.docx", "downloads/data.xlsx"). ' +
    'Returns extracted text, truncated for very large documents.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Document to read: absolute path, "~/…", or shortcut-relative like "documents/report.pdf".'
      },
      maxChars: {
        type: 'number',
        description: 'Optional cap on how many characters of extracted text to return.'
      }
    },
    required: ['path']
  },

  async run({ path: spec, maxChars } = {}) {
    if (!spec || !String(spec).trim()) throw new Error('path is required');
    if (isRootsRequest(spec)) {
      return { error: 'That refers to the drive list, not a document. Use list_directory instead.' };
    }

    const target = resolvePath(spec);

    let stat;
    try {
      stat = fs.statSync(target);
    } catch (err) {
      return { path: target, error: `Cannot access document: ${err.code || err.message}` };
    }
    if (stat.isDirectory()) {
      return { path: target, error: 'That path is a directory. Use list_directory to list it.' };
    }

    const hardCap = Math.max(1, Number(config.fsDocMaxChars) || 20000);
    const requested = Number(maxChars) > 0 ? Number(maxChars) : hardCap;
    const cap = Math.min(requested, hardCap);

    try {
      const r = await extractDocument(target, { maxChars: cap });
      return {
        path: target,
        kind: r.kind,
        chars: r.chars,
        truncated: r.truncated,
        ...r.meta,
        content: r.text || '(the document contains no extractable text)'
      };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      return { path: target, error: `Could not read document: ${msg}`, supported: SUPPORTED };
    }
  }
};

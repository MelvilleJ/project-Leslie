'use strict';

// Text extraction from rich document formats, for the read_document tool and
// the "@" mention expansion. Reuses libraries already in the project:
//   .docx        — unzip with jszip, pull text out of word/document.xml
//   .pdf         — pdf-parse
//   .xlsx / .xls — exceljs (sheets flattened to tab-separated rows)
//   text-like    — read as UTF-8 (csv, txt, md, html, json, logs, config, …)
// Everything is required lazily so a missing optional lib only breaks its own
// format, not the whole tool.

const fs = require('node:fs');
const path = require('node:path');

// Formats handled by reading the bytes as UTF-8 text directly.
const TEXT_EXT = new Set([
  '.txt', '.text', '.md', '.markdown', '.csv', '.tsv', '.log', '.json', '.xml',
  '.html', '.htm', '.yml', '.yaml', '.ini', '.cfg', '.conf', '.toml', '.rtf', '.tex'
]);
const RICH_EXT = new Set(['.docx', '.pdf', '.xlsx', '.xls']);

/** Extensions this module knows how to turn into text. */
const SUPPORTED = [...RICH_EXT, ...TEXT_EXT].sort();

function extOf(file) {
  return path.extname(String(file || '')).toLowerCase();
}

/** True if `file`'s extension is a document format read_document should handle. */
function isDocument(file) {
  const e = extOf(file);
  return RICH_EXT.has(e) || TEXT_EXT.has(e);
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // last, so we don't double-decode
}

// WordprocessingML → plain text: tabs/breaks/paragraphs become whitespace, then
// every remaining tag is stripped, leaving the run text.
function wordXmlToText(xml) {
  const text = xml
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function extractDocx(filePath) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const doc = zip.file('word/document.xml');
  if (!doc) throw new Error('not a valid .docx (missing word/document.xml)');
  return wordXmlToText(await doc.async('string'));
}

async function extractPdf(filePath) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(fs.readFileSync(filePath));
  return { text: (data.text || '').trim(), pages: data.numpages };
}

function cellToStr(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.text != null) return String(v.text); // rich text / hyperlink
    if (v.result != null) return String(v.result); // formula result
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return '';
  }
  return String(v);
}

async function extractXlsx(filePath) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const out = [];
  let sheets = 0;
  wb.eachSheet((ws) => {
    sheets += 1;
    out.push(`## ${ws.name}`);
    ws.eachRow((row) => {
      const cells = Array.isArray(row.values) ? row.values.slice(1) : [];
      out.push(cells.map(cellToStr).join('\t'));
    });
    out.push('');
  });
  return { text: out.join('\n').trim(), sheets };
}

/**
 * Extract text from a document file, capped at `maxChars`.
 * @param {string} filePath absolute path
 * @param {{ maxChars?: number }} [opts]
 * @returns {Promise<{ kind: string, text: string, truncated: boolean, chars: number, meta?: object }>}
 */
async function extractDocument(filePath, opts = {}) {
  const ext = extOf(filePath);
  let kind;
  let text;
  let meta = {};

  if (ext === '.docx') {
    kind = 'docx';
    text = await extractDocx(filePath);
  } else if (ext === '.pdf') {
    kind = 'pdf';
    const r = await extractPdf(filePath);
    text = r.text;
    meta.pages = r.pages;
  } else if (ext === '.xlsx' || ext === '.xls') {
    kind = 'spreadsheet';
    const r = await extractXlsx(filePath);
    text = r.text;
    meta.sheets = r.sheets;
  } else if (TEXT_EXT.has(ext)) {
    kind = 'text';
    text = fs.readFileSync(filePath, 'utf8');
  } else {
    throw new Error(
      `unsupported document type "${ext || '(none)'}". Supported: ${SUPPORTED.join(', ')}`
    );
  }

  const full = text || '';
  const max = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : 0;
  const truncated = max > 0 && full.length > max;
  return {
    kind,
    text: truncated ? full.slice(0, max) : full,
    truncated,
    chars: full.length,
    meta
  };
}

module.exports = { extractDocument, isDocument, SUPPORTED, RICH_EXT, TEXT_EXT };

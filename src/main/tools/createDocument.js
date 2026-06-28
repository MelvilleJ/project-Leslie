'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../config');

const FORMATS = ['docx', 'pdf', 'xlsx', 'txt', 'md', 'html', 'csv'];
const DOCX_HEADINGS = ['HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6'];

function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isPipeRow(line) {
  return /\|/.test(line) && /\S/.test(line);
}
function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}
function parseCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function parseBlocks(content) {
  const lines = String(content || '').split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }
    if (isPipeRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = parseCells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isPipeRow(lines[i]) && !isTableSeparator(lines[i])) {
        rows.push(parseCells(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    blocks.push({ type: 'para', text: line.trim() });
    i++;
  }
  return blocks;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toRows(rows, content) {
  if (Array.isArray(rows) && rows.length) {
    return rows.map((r) => (Array.isArray(r) ? r : typeof r === 'object' && r ? Object.values(r) : [r]));
  }
  const table = parseBlocks(content).find((b) => b.type === 'table');
  if (table) return [table.header, ...table.rows].filter((r) => r.length);
  if (content && content.trim()) return content.trim().split(/\r?\n/).map((line) => line.split(','));
  return [];
}

function htmlTable(block) {
  const cols = block.header.length || Math.max(0, ...block.rows.map((r) => r.length));
  const pad = (r) => {
    const a = r.slice(0, cols);
    while (a.length < cols) a.push('');
    return a;
  };
  const head = block.header.length
    ? `<thead><tr>${pad(block.header).map((c) => `<th>${htmlEscape(c)}</th>`).join('')}</tr></thead>`
    : '';
  const body = block.rows.map((r) => `<tr>${pad(r).map((c) => `<td>${htmlEscape(c)}</td>`).join('')}</tr>`).join('');
  return `<table>${head}<tbody>${body}</tbody></table>`;
}

function blocksToHtml(blocks) {
  return blocks
    .map((b) => {
      if (b.type === 'heading') return `<h${b.level}>${htmlEscape(b.text)}</h${b.level}>`;
      if (b.type === 'table') return htmlTable(b);
      return `<p>${htmlEscape(b.text)}</p>`;
    })
    .join('\n');
}

function buildHtmlDocument(title, content) {
  const css =
    'body{font-family:Calibri,Arial,sans-serif;font-size:12pt;color:#111;margin:2em}' +
    'h1,h2,h3,h4{margin:.6em 0 .3em}' +
    'table{border-collapse:collapse;margin:.6em 0}' +
    'th,td{border:1px solid #999;padding:4px 10px;text-align:left;vertical-align:top}' +
    'th{background:#f0f0f0}';
  return (
    '<!doctype html>\n<html><head><meta charset="utf-8">' +
    `<title>${htmlEscape(title || 'Document')}</title><style>${css}</style></head>\n<body>\n` +
    (title ? `<h1>${htmlEscape(title)}</h1>\n` : '') +
    `${blocksToHtml(parseBlocks(content))}\n</body></html>\n`
  );
}

async function writeDocx(file, title, content) {
  const docx = require('docx');
  const { Document, Packer, Paragraph, HeadingLevel } = docx;
  const children = [];
  if (title) children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }));
  for (const b of parseBlocks(content)) {
    if (b.type === 'heading') {
      children.push(new Paragraph({ text: b.text, heading: HeadingLevel[DOCX_HEADINGS[b.level - 1]] }));
    } else if (b.type === 'table') {
      children.push(docxTable(docx, b));
    } else {
      children.push(new Paragraph(b.text));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  fs.writeFileSync(file, await Packer.toBuffer(doc));
}

function docxTable(docx, block) {
  const { Table, TableRow, TableCell, Paragraph, TextRun, WidthType, BorderStyle } = docx;
  const cols = block.header.length || Math.max(1, ...block.rows.map((r) => r.length));
  const pad = (r) => {
    const a = r.slice(0, cols);
    while (a.length < cols) a.push('');
    return a;
  };
  const edge = { style: BorderStyle.SINGLE, size: 1, color: '999999' };
  const cell = (text, bold) =>
    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(text), bold: !!bold })] })] });
  const rows = [];
  if (block.header.length) rows.push(new TableRow({ children: pad(block.header).map((c) => cell(c, true)) }));
  for (const r of block.rows) rows.push(new TableRow({ children: pad(r).map((c) => cell(c, false)) }));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: edge, bottom: edge, left: edge, right: edge, insideHorizontal: edge, insideVertical: edge },
    rows
  });
}

function electronPdfAvailable() {
  try {
    const e = require('electron');
    return !!(e && e.BrowserWindow && e.app && typeof e.app.isReady === 'function' && e.app.isReady());
  } catch {
    return false;
  }
}

async function writePdf(file, title, content) {
  if (electronPdfAvailable()) {
    await writePdfFromHtml(file, buildHtmlDocument(title, content));
  } else {
    await writePdfText(file, title, content);
  }
}

async function writePdfFromHtml(file, html) {
  const { BrowserWindow } = require('electron');
  const tmp = path.join(os.tmpdir(), `leslie-doc-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(tmp, html);
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({ printBackground: true });
    fs.writeFileSync(file, pdf);
  } finally {
    try {
      win.destroy();
    } catch {
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
    }
  }
}

async function writePdfText(file, title, content) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ margin: 50 });
  const stream = fs.createWriteStream(file);
  const done = new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
  doc.pipe(stream);
  if (title) doc.fontSize(20).text(title).moveDown();
  doc.fontSize(12);
  for (const b of parseBlocks(content)) {
    if (b.type === 'heading') doc.fontSize(Math.max(13, 19 - b.level)).text(b.text).fontSize(12).moveDown(0.2);
    else if (b.type === 'table') doc.text([b.header, ...b.rows].map((r) => r.join('  |  ')).join('\n')).moveDown(0.2);
    else doc.text(b.text || ' ');
  }
  doc.end();
  await done;
}

async function writeXlsx(file, title, rows) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet((title || 'Sheet1').slice(0, 31));
  for (const row of rows) ws.addRow(row);
  await wb.xlsx.writeFile(file);
}

function writeHtml(file, title, content) {
  const body = String(content || '');
  fs.writeFileSync(file, /<html[\s>]/i.test(body) ? body : buildHtmlDocument(title, content));
}

function writeCsv(file, rows, content) {
  const csv = rows.length ? rows.map((r) => r.map(csvCell).join(',')).join('\r\n') : String(content || '');
  fs.writeFileSync(file, csv);
}

function writeText(file, title, content) {
  fs.writeFileSync(file, title ? `${title}\n\n${content || ''}` : String(content || ''));
}

function openFile(file) {
  try {
    const { shell } = require('electron');
    if (shell && shell.openPath) shell.openPath(file);
  } catch {
  }
}

module.exports = {
  name: 'create_document',
  description:
    'Create a document file for the user and open it. Use when the user asks to make/write/save a ' +
    'Word document, PDF, Excel spreadsheet, text/markdown file, web page, or CSV. Supported formats: ' +
    'docx, pdf, xlsx, txt, md, html, csv. Put the body in `content` (plain text; lines starting with ' +
    '# become headings). For TABLES, write a markdown table in `content` (e.g. "| A | B |\\n| - | - ' +
    '|\\n| 1 | 2 |") — it becomes a REAL table in docx/pdf/html. For xlsx/csv pass `rows` as an array ' +
    "of arrays (one inner array per row), or a markdown table in `content`. The file is saved to the " +
    "user's Documents folder and opened automatically.",
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'Base file name without extension, e.g. "Q3 Report".' },
      format: { type: 'string', enum: FORMATS, description: 'Document format to create.' },
      title: { type: 'string', description: 'Optional document title / first heading.' },
      content: {
        type: 'string',
        description: 'Body text. Lines beginning with # are headings; markdown "| a | b |" tables become real tables.'
      },
      rows: {
        type: 'array',
        description: 'For xlsx/csv: rows of cells, e.g. [["Name","Score"],["Ann",10]].',
        items: { type: 'array', items: {} }
      }
    },
    required: ['filename', 'format']
  },

  async run({ filename, format, title, content, rows }, _ctx) {
    const fmt = String(format || '').toLowerCase();
    if (!FORMATS.includes(fmt)) {
      throw new Error(`Unsupported format "${format}". Use one of: ${FORMATS.join(', ')}.`);
    }
    const base =
      String(filename || 'document')
        .replace(/[\\/:*?"<>|]+/g, ' ')
        .replace(/\.[a-z0-9]+$/i, '')
        .trim()
        .slice(0, 120) || 'document';

    const dir = config.docsDir;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${base}.${fmt}`);

    switch (fmt) {
      case 'docx':
        await writeDocx(file, title, content);
        break;
      case 'pdf':
        await writePdf(file, title, content);
        break;
      case 'xlsx':
        await writeXlsx(file, title, toRows(rows, content));
        break;
      case 'csv':
        writeCsv(file, toRows(rows, content), content);
        break;
      case 'html':
        writeHtml(file, title, content);
        break;
      default:
        writeText(file, title, content);
    }

    let opened = false;
    if (config.docsAutoOpen) {
      openFile(file);
      opened = true;
    }

    const bytes = fs.statSync(file).size;
    return {
      success: true,
      path: file,
      format: fmt,
      bytes,
      opened,
      message: `Created ${fmt.toUpperCase()} "${base}.${fmt}" in ${dir}${opened ? ' and opened it' : ''}.`
    };
  }
};

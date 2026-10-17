'use strict';

const crypto = require('node:crypto');

// A placeholder for a section that is still being written: invisible in any
// other markdown viewer, shown as "coming" in the live editor.
const PENDING_RE = /^<!--\s*pending:\s*([\s\S]*?)\s*-->$/;
const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^\s{0,3}#{1,6}\s/;

function hash(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
}

function newId() {
  return crypto.randomBytes(5).toString('hex');
}

function pendingIntent(text) {
  const m = text.match(PENDING_RE);
  return m ? m[1] : null;
}

function pendingBlock(intent) {
  return `<!-- pending: ${String(intent).replace(/-->/g, '').trim()} -->`;
}

/**
 * Splits markdown into top-level blocks without losing a byte: each block keeps
 * the whitespace that followed it (`sep`), and `lead` is anything before the
 * first block, so `serialize(parse(md)) === md`. Headings are always their own
 * block; a fenced code block is one block, blank lines and all.
 */
function parse(md) {
  const src = String(md == null ? '' : md);
  const lines = [];
  for (let at = 0; at < src.length; ) {
    const nl = src.indexOf('\n', at);
    const end = nl === -1 ? src.length : nl;
    lines.push({ start: at, end, text: src.slice(at, end).replace(/\r$/, '') });
    at = nl === -1 ? src.length : nl + 1;
  }

  const spans = [];
  let cur = null;
  let fence = null;
  const close = () => {
    if (cur) spans.push(cur);
    cur = null;
  };
  for (const line of lines) {
    const contentEnd = src[line.end - 1] === '\r' ? line.end - 1 : line.end;
    if (fence) {
      cur.end = contentEnd;
      if (line.text.trim().startsWith(fence)) {
        fence = null;
        close();
      }
      continue;
    }
    if (!line.text.trim()) {
      close();
      continue;
    }
    const f = line.text.match(FENCE_RE);
    if (f || HEADING_RE.test(line.text)) close();
    if (!cur) cur = { start: line.start, end: contentEnd };
    else cur.end = contentEnd;
    if (f) fence = f[1];
    else if (HEADING_RE.test(line.text)) close();
  }
  close();

  const blocks = spans.map((s, i) => ({
    text: src.slice(s.start, s.end),
    sep: src.slice(s.end, i + 1 < spans.length ? spans[i + 1].start : src.length)
  }));
  return { lead: spans.length ? src.slice(0, spans[0].start) : src, blocks };
}

function serialize(lead, blocks) {
  return lead + blocks.map((b) => b.text + b.sep).join('');
}

function words(text) {
  return new Set(String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
}

function similarity(a, b) {
  if (!a.size && !b.size) return 1;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Carries ids from the old blocks over to the new texts: unchanged blocks keep
 * theirs (longest common run of hashes), and between two unchanged neighbours an
 * edited block keeps the id of the old block it most resembles, in order.
 * `old` entries carry `text` when known; without it, edits match by position.
 */
function alignIds(old, texts) {
  const a = old.map((b) => b.h);
  const b = texts.map(hash);
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ids = new Array(m).fill(null);
  const pairs = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  pairs.push([n, m]);
  let pi = 0;
  let pj = 0;
  for (const [i, j] of pairs) {
    const byWords = old.slice(pi, i).every((o) => typeof o.text === 'string');
    if (byWords) {
      let from = pi;
      for (let jj = pj; jj < j; jj++) {
        const mine = words(texts[jj]);
        let best = -1;
        let bestScore = 0.3;
        for (let ii = from; ii < i; ii++) {
          const score = similarity(mine, words(old[ii].text));
          if (score > bestScore) [best, bestScore] = [ii, score];
        }
        if (best !== -1) {
          ids[jj] = old[best].id;
          from = best + 1;
        }
      }
    }
    if (!byWords || (i - pi === j - pj && ids.slice(pj, j).every((id) => !id))) {
      for (let k = 0; k < Math.min(i - pi, j - pj); k++) ids[pj + k] = old[pi + k].id;
    }
    if (i < n) ids[j] = old[i].id;
    pi = i + 1;
    pj = j + 1;
  }
  const used = new Set();
  return ids.map((id) => {
    const out = id && !used.has(id) ? id : newId();
    used.add(out);
    return out;
  });
}

module.exports = { parse, serialize, alignIds, hash, newId, pendingIntent, pendingBlock };

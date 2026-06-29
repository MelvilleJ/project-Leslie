'use strict';

// Pure parser for the spritesheet ".css" grid breakdown LESLIE ships with
// (assets/animations/<name>/spritesheet.css) and that users upload alongside
// their own sheets. The format is a base `.sprite { width; height }` rule plus
// one `.sprite-N { background-position: -Xpx -Ypx }` rule per frame, e.g.:
//
//   .sprite       { width: 228px; height: 537px; }
//   .sprite-0     { background-position: -0px -0px; }
//   .sprite-1     { background-position: -228px -0px; }   // same row (y=0)
//   .sprite-4     { background-position: -0px -537px; }   // next row
//
// From this we derive the grid the animation engine needs:
//   frameW, frameH — the .sprite rule's width/height (or the position step)
//   frames         — number of distinct .sprite-N rules
//   cols           — number of frames sharing the first row (y === 0)
//
// Tolerant by design: any piece it can't find comes back null so the settings
// UI can fall back to manual entry instead of failing the import.

/**
 * @param {string} text raw CSS
 * @returns {{ frameW: number|null, frameH: number|null, cols: number|null, frames: number|null }}
 */
function parseSpriteCss(text) {
  const css = String(text || '');
  const out = { frameW: null, frameH: null, cols: null, frames: null };

  // Frame size from the base `.sprite { … }` rule (the one without a -N suffix).
  const base = css.match(/\.sprite\s*\{([^}]*)\}/);
  if (base) {
    const w = base[1].match(/width\s*:\s*(\d+(?:\.\d+)?)\s*px/i);
    const h = base[1].match(/height\s*:\s*(\d+(?:\.\d+)?)\s*px/i);
    if (w) out.frameW = Math.round(Number(w[1]));
    if (h) out.frameH = Math.round(Number(h[1]));
  }

  // Per-frame rules: collect indices, and the X positions on the first row plus
  // the set of distinct row offsets (Y) — both useful as size/column fallbacks.
  const re =
    /\.sprite-(\d+)\s*\{[^}]*background-position\s*:\s*(-?\d+(?:\.\d+)?)\s*px\s+(-?\d+(?:\.\d+)?)\s*px/gi;
  const indices = new Set();
  const firstRowX = new Set();
  const allY = new Set();
  let m;
  while ((m = re.exec(css))) {
    indices.add(Number(m[1]));
    const x = Math.abs(Math.round(Number(m[2])));
    const y = Math.abs(Math.round(Number(m[3])));
    if (y === 0) firstRowX.add(x);
    allY.add(y);
  }

  if (indices.size) out.frames = indices.size;
  if (firstRowX.size) out.cols = firstRowX.size;

  // Size fallbacks when the base rule was missing: infer from position steps.
  if (out.frameW == null && firstRowX.size >= 2) {
    const xs = [...firstRowX].sort((a, b) => a - b);
    out.frameW = xs[1] - xs[0];
  }
  if (out.frameH == null && allY.size >= 2) {
    const ys = [...allY].sort((a, b) => a - b);
    out.frameH = ys[1] - ys[0];
  }

  return out;
}

module.exports = { parseSpriteCss };

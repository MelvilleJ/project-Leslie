'use strict';

// Parse spritesheet.css: .sprite { width; height } plus .sprite-N { background-position } rules.
// Returns null for any piece missing so settings UI can fall back to manual entry.

function parseSpriteCss(text) {
  const css = String(text || '');
  const out = { frameW: null, frameH: null, cols: null, frames: null };

  const base = css.match(/\.sprite\s*\{([^}]*)\}/);
  if (base) {
    const w = base[1].match(/width\s*:\s*(\d+(?:\.\d+)?)\s*px/i);
    const h = base[1].match(/height\s*:\s*(\d+(?:\.\d+)?)\s*px/i);
    if (w) out.frameW = Math.round(Number(w[1]));
    if (h) out.frameH = Math.round(Number(h[1]));
  }

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

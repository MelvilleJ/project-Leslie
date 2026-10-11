#!/usr/bin/env node
'use strict';

// Split the hand-edited pixel Leslie clips into a layered wardrobe the app can dress at runtime.
// Usage: node scripts/build-pixel-wardrobe.js [--force]
// Reads assets/animations/pixel/<clip>/leslie-<clip>.aseprite (never modified) and writes
// assets/animations/pixel/wardrobe/leslie-<clip>.aseprite with a `body` layer and `top`/`bottom`/`shoes`
// groups, one child layer per clothing item. Existing wardrobe files may hold new hand-drawn clothes,
// so they are skipped unless --force is given.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const aseprite = require('../src/main/aseprite');

const PIXEL_DIR = path.join(__dirname, '..', 'assets', 'animations', 'pixel');
const OUT_DIR = path.join(PIXEL_DIR, 'wardrobe');
const CLIPS = ['idle', 'talking', 'thinking', 'tools', 'listening', 'moving'];

// The hoodie/joggers shades, darkest to lightest, as produced by build-pixel-sprites.py.
const SHADE = { '24,21,30': 'dark', '44,41,54': 'base', '58,55,70': 'light', '70,66,82': 'pale' };
const OUTLINE = [14, 10, 16];
const SKIN = [184, 118, 78];
const SKIN_SHADE = [152, 92, 60];
const WHITE = [240, 240, 236];
const GOLD = [237, 197, 74];
const STEEL = [150, 156, 170];

// Rows in the unshifted idle pose; the moving clip hops, so each frame is re-anchored on its feet.
const FEET_ROW = 135;
const NECK_ROW = 74;
const SLEEVE_ROW = 92;
const WAIST_ROW = 104;
const SHOE_ROW = 126;
const LEGS = [14, 47];
const ARMS = [17, 42];
const CENTER_COL = 30;

const tones = (dark, base, light, pale) => ({ dark, base, light, pale });
const DENIM = tones([28, 42, 76], [50, 72, 118], [68, 94, 146], [86, 112, 162]);

/** One frame split into regions, in idle-pose coordinates. Keys are y * width + x of the local pose. */
function analyse(rgba, width, height) {
  let bottom = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) bottom = Math.floor(i / 4 / width);
  const shift = bottom - FEET_ROW;
  const key = (x, y) => y * width + x;
  const inside = (x, y) => x >= 0 && x < width && y + shift >= 0 && y + shift < height;
  const color = (x, y) => {
    const o = ((y + shift) * width + x) * 4;
    return inside(x, y) && rgba[o + 3] ? [rgba[o], rgba[o + 1], rgba[o + 2]] : null;
  };
  const isOutline = (c) => c && c.every((v, i) => v === OUTLINE[i]);

  const region = new Map();
  const shade = new Map();
  for (let y = NECK_ROW; y <= FEET_ROW; y++) {
    for (let x = 0; x < width; x++) {
      const c = color(x, y);
      if (!c || isOutline(c)) continue;
      const s = SHADE[c.join(',')];
      if (s) {
        shade.set(key(x, y), s);
        region.set(key(x, y), y >= WAIST_ROW && x >= LEGS[0] && x <= LEGS[1] ? 'bottom' : 'top');
      } else if (y >= SHOE_ROW - 2) {
        region.set(key(x, y), 'shoes');
      }
    }
  }
  // Outlines go with the clothing they wrap, so swapping an item swaps its outline too.
  const outlineRegion = new Map();
  for (let y = NECK_ROW; y <= FEET_ROW; y++) {
    for (let x = 0; x < width; x++) {
      if (!isOutline(color(x, y))) continue;
      const near = new Set();
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) near.add(region.get(key(x + dx, y + dy)));
      const owner = ['shoes', 'bottom', 'top'].find((r) => near.has(r));
      if (owner) outlineRegion.set(key(x, y), owner);
    }
  }
  return { width, height, shift, key, inside, color, region, shade, outlineRegion };
}

function blank(frame) {
  return { frame, pixels: new Map() };
}

function put(layer, x, y, rgb) {
  if (layer.frame.inside(x, y)) layer.pixels.set(layer.frame.key(x, y), rgb);
}

const xy = (frame, k) => [k % frame.width, Math.floor(k / frame.width)];

function regionKeys(frame, name) {
  return [...frame.region].filter(([, r]) => r === name).map(([k]) => k);
}

/** Recolour an extracted item (keeping its outline) by mapping the hoodie/jogger shades onto `palette`. */
function retone(frame, name, palette, keep = () => true) {
  const layer = blank(frame);
  for (const k of regionKeys(frame, name)) {
    const [x, y] = xy(frame, k);
    if (keep(x, y)) put(layer, x, y, palette ? palette[frame.shade.get(k)] : frame.color(x, y));
  }
  for (const [k, r] of frame.outlineRegion) {
    const [x, y] = xy(frame, k);
    if (r === name && keep(x, y)) put(layer, x, y, OUTLINE);
  }
  return layer;
}

/** A new shape: fill `keys`, shade its edges (or reuse the original folds), and outline it. */
function shape(frame, keys, palette, colorAt) {
  const layer = blank(frame);
  const set = new Set(keys);
  const has = (x, y) => set.has(frame.key(x, y));
  for (const k of set) {
    const [x, y] = xy(frame, k);
    let tone = frame.shade.get(k) || 'base';
    if (!frame.shade.has(k)) {
      if (!has(x - 1, y)) tone = 'light';
      if (!has(x + 1, y) || !has(x, y + 1)) tone = 'dark';
    }
    put(layer, x, y, colorAt ? colorAt(x, y, tone) : palette[tone]);
  }
  for (const k of set) {
    const [x, y] = xy(frame, k);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (ny >= NECK_ROW && !has(nx, ny)) put(layer, nx, ny, OUTLINE);
    }
  }
  return layer;
}

/** Column span [min, max] of a region's pixels in row y, limited to xs in [lo, hi]. */
function span(frame, name, y, lo = 0, hi = frame.width - 1) {
  let min = Infinity;
  let max = -Infinity;
  for (let x = lo; x <= hi; x++) {
    if (frame.region.get(frame.key(x, y)) === name) {
      min = Math.min(min, x);
      max = Math.max(max, x);
    }
  }
  return min <= max ? [min, max] : null;
}

function isSkin(c) {
  return c && (c.join() === SKIN.join() || c.join() === SKIN_SHADE.join());
}

/** Column span of the hand skin in rows just below the sleeve, so forearms line up with the hands. */
function handSpan(frame, lo, hi) {
  for (let y = SLEEVE_ROW + 8; y < WAIST_ROW + 4; y++) {
    const xs = [];
    for (let x = lo; x <= hi; x++) if (isSkin(frame.color(x, y))) xs.push(x);
    if (xs.length >= 4) return [Math.min(...xs), Math.max(...xs)];
  }
  return null;
}

/** Everything that isn't clothing, plus bare skin under the clothes for items that show more of her. */
function bodyLayer(frame) {
  const layer = blank(frame);
  for (const k of regionKeys(frame, 'top')) {
    const [x, y] = xy(frame, k);
    if (y < SLEEVE_ROW || (x > ARMS[0] && x < ARMS[1])) put(layer, x, y, SKIN);
  }
  const clothed = (x, y) => frame.region.has(frame.key(x, y)) || frame.outlineRegion.has(frame.key(x, y));
  const skin = (x, y, rgb) => clothed(x, y) && put(layer, x, y, rgb);
  const limb = (x0, x1, y0, y1) => {
    for (let y = y0; y <= y1; y++) {
      skin(x0 - 1, y, OUTLINE);
      skin(x1 + 1, y, OUTLINE);
      for (let x = x0; x <= x1; x++) skin(x, y, x === x1 ? SKIN_SHADE : SKIN);
    }
  };
  for (const [lo, hi] of [[0, ARMS[0] + 3], [ARMS[1] - 3, frame.width - 1]]) {
    const hand = handSpan(frame, lo, hi);
    if (hand) limb(hand[0] + 1, hand[1] - 1, SLEEVE_ROW - 4, SLEEVE_ROW + 10);
  }
  for (const [lo, hi] of [[0, CENTER_COL], [CENTER_COL + 1, frame.width - 1]]) {
    const shoe = span(frame, 'shoes', SHOE_ROW, lo, hi);
    if (!shoe) continue;
    const mid = Math.round((shoe[0] + shoe[1]) / 2);
    limb(mid - 2, mid + 2, WAIST_ROW, SHOE_ROW - 1);
  }
  // The underlay stays inside the default outfit's silhouette, so the default outfit renders exactly as the original.
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const k = frame.key(x, y);
      const c = frame.color(x, y);
      if (c && !frame.region.has(k) && !frame.outlineRegion.has(k)) put(layer, x, y, c);
    }
  }
  return layer;
}

const isArm = (x, y) => y >= SLEEVE_ROW && (x <= ARMS[0] || x >= ARMS[1]);
const scoopNeck = (x, y) => y <= NECK_ROW + 1 && Math.abs(x - CENTER_COL) <= 3;

function teeKeys(frame) {
  return regionKeys(frame, 'top').filter((k) => {
    const [x, y] = xy(frame, k);
    return !isArm(x, y) && !scoopNeck(x, y);
  });
}

function zip(layer, color) {
  for (let y = NECK_ROW + 2; y < WAIST_ROW - 2; y++) {
    if (layer.pixels.has(layer.frame.key(CENTER_COL, y))) put(layer, CENTER_COL, y, color);
  }
  return layer;
}

const TOPS = {
  hoodie: (f) => retone(f, 'top'),
  'cream-sweater': (f) => {
    const layer = retone(f, 'top', tones([150, 126, 100], [212, 192, 160], [230, 214, 186], [196, 174, 140]));
    for (const k of regionKeys(f, 'top')) {
      const [x, y] = xy(f, k);
      if (f.shade.get(k) === 'base' && x % 3 === 0) put(layer, x, y, [196, 174, 140]);
    }
    return layer;
  },
  'red-zip': (f) => zip(retone(f, 'top', tones([96, 20, 30], [158, 34, 44], [194, 56, 58], [212, 84, 78])), WHITE),
  'pink-hoodie': (f) => retone(f, 'top', tones([176, 104, 132], [226, 150, 176], [240, 180, 200], [246, 198, 214])),
  'olive-jacket': (f) => zip(retone(f, 'top', tones([44, 56, 32], [76, 94, 52], [100, 122, 68], [118, 138, 84])), STEEL),
  tee: (f) => shape(f, teeKeys(f), tones([168, 168, 176], [224, 224, 228], [242, 242, 242], [204, 204, 212])),
  'striped-tee': (f) => {
    const white = tones([168, 168, 176], [224, 224, 228], [242, 242, 242], [204, 204, 212]);
    const navy = tones([22, 28, 60], [40, 52, 100], [56, 70, 126], [64, 80, 140]);
    return shape(f, teeKeys(f), null, (x, y, tone) => ((y - NECK_ROW) % 4 < 2 ? navy : white)[tone]);
  }
};

const BOTTOMS = {
  joggers: (f) => retone(f, 'bottom'),
  jeans: (f) => retone(f, 'bottom', DENIM),
  'track-pants': (f) => {
    const layer = retone(f, 'bottom', tones([16, 14, 20], [32, 30, 38], [44, 42, 52], [56, 54, 66]));
    for (let y = WAIST_ROW; y < SHOE_ROW; y++) {
      const legs = [span(f, 'bottom', y, 0, CENTER_COL), span(f, 'bottom', y, CENTER_COL + 1, f.width - 1)];
      if (legs[0]) put(layer, legs[0][0] + 1, y, WHITE);
      if (legs[1]) put(layer, legs[1][1] - 1, y, WHITE);
    }
    return layer;
  },
  'lavender-joggers': (f) => retone(f, 'bottom', tones([92, 78, 138], [132, 116, 180], [156, 140, 200], [170, 156, 210])),
  khakis: (f) => retone(f, 'bottom', tones([118, 96, 60], [166, 140, 94], [186, 162, 114], [198, 176, 130])),
  shorts: (f) => {
    const keys = regionKeys(f, 'bottom').filter((k) => xy(f, k)[1] <= WAIST_ROW + 8);
    return shape(f, keys, null, (x, y, tone) => (y === WAIST_ROW + 8 ? DENIM.pale : DENIM[tone]));
  },
  skirt: (f) => {
    const waist = span(f, 'bottom', WAIST_ROW) || LEGS;
    const keys = [];
    for (let i = 0; i <= 12; i++) {
      const flare = Math.floor(i / 4);
      for (let x = waist[0] - flare; x <= waist[1] + flare; x++) {
        if (!isSkin(f.color(x, WAIST_ROW + i))) keys.push(f.key(x, WAIST_ROW + i));
      }
    }
    const plaid = tones([70, 18, 26], [140, 32, 42], [170, 52, 56], [186, 70, 70]);
    return shape(f, keys, null, (x, y, tone) => ((x - waist[0]) % 4 === 0 || y === WAIST_ROW + 6
      ? [104, 22, 32] : plaid[tone]));
  },
  overalls: (f) => {
    const layer = retone(f, 'bottom', DENIM);
    const onTop = (x, y) => f.region.get(f.key(x, y)) === 'top';
    for (let y = SLEEVE_ROW; y < WAIST_ROW; y++) {
      for (let x = 20; x <= 41; x++) if (onTop(x, y)) put(layer, x, y, y === SLEEVE_ROW ? DENIM.dark : DENIM.base);
    }
    for (let y = NECK_ROW + 4; y < SLEEVE_ROW; y++) {
      for (const x of [22, 23, 38, 39]) if (onTop(x, y)) put(layer, x, y, x % 2 ? DENIM.base : DENIM.dark);
    }
    for (const x of [22, 39]) put(layer, x, SLEEVE_ROW, GOLD);
    return layer;
  }
};

const SHOES = {
  sneakers: (f) => retone(f, 'shoes'),
  'pink-sneakers': (f) => {
    const layer = retone(f, 'shoes');
    for (const [k, c] of layer.pixels) {
      const lum = c[0] + c[1] + c[2];
      if (c !== OUTLINE && lum < 600) layer.pixels.set(k, lum < 330 ? [168, 70, 110] : [232, 140, 176]);
    }
    return layer;
  },
  boots: (f) => {
    const keys = regionKeys(f, 'shoes');
    for (const [lo, hi] of [[0, CENTER_COL], [CENTER_COL + 1, f.width - 1]]) {
      const shoe = span(f, 'shoes', SHOE_ROW, lo, hi);
      if (!shoe) continue;
      for (let y = SHOE_ROW - 6; y < SHOE_ROW; y++) {
        for (let x = shoe[0] + 1; x <= shoe[1] - 1; x++) keys.push(f.key(x, y));
      }
    }
    return shape(f, keys, null, (x, y, tone) => {
      if (y >= FEET_ROW - 1) return [40, 26, 20];
      return tones([70, 42, 28], [112, 70, 44], [140, 92, 58], [156, 108, 70])[tone];
    });
  }
};

const DEFAULTS = { top: 'hoodie', bottom: 'joggers', shoes: 'sneakers' };

function chunk(type, data) {
  const head = Buffer.alloc(6);
  head.writeUInt32LE(data.length + 6);
  head.writeUInt16LE(type, 4);
  return Buffer.concat([head, data]);
}

function asepriteString(s) {
  const b = Buffer.from(s);
  const len = Buffer.alloc(2);
  len.writeUInt16LE(b.length);
  return Buffer.concat([len, b]);
}

function layerChunk({ name, group, level, visible }) {
  const head = Buffer.alloc(16);
  head.writeUInt16LE((visible ? 1 : 0) | 2, 0);
  head.writeUInt16LE(group ? 1 : 0, 2);
  head.writeUInt16LE(level, 4);
  head[12] = 255;
  return chunk(0x2004, Buffer.concat([head, asepriteString(name)]));
}

/** A cel cropped to its layer's pixels in this frame, or null when the layer is empty there. */
function celChunk(index, layer) {
  const { frame, pixels } = layer;
  if (!pixels.size) return null;
  const pts = [...pixels.keys()].map((k) => xy(frame, k));
  const x0 = Math.min(...pts.map((p) => p[0]));
  const y0 = Math.min(...pts.map((p) => p[1]));
  const w = Math.max(...pts.map((p) => p[0])) - x0 + 1;
  const h = Math.max(...pts.map((p) => p[1])) - y0 + 1;
  const rgba = Buffer.alloc(w * h * 4);
  for (const [k, c] of pixels) {
    const [x, y] = xy(frame, k);
    rgba.set([...c, 255], ((y - y0) * w + (x - x0)) * 4);
  }
  const head = Buffer.alloc(20);
  head.writeUInt16LE(index, 0);
  head.writeInt16LE(x0, 2);
  head.writeInt16LE(y0 + frame.shift, 4);
  head[6] = 255;
  head.writeUInt16LE(2, 7);
  head.writeUInt16LE(w, 16);
  head.writeUInt16LE(h, 18);
  return chunk(0x2005, Buffer.concat([head, zlib.deflateSync(rgba)]));
}

/** Layered RGBA .aseprite writer: `layers` is the stack bottom-up, `cels[f][i]` the layer i image in frame f. */
function writeAseprite(file, { width, height, layers, frames, tag }) {
  const tagHead = Buffer.alloc(10);
  tagHead.writeUInt16LE(1);
  const tagBody = Buffer.alloc(17);
  tagBody.writeUInt16LE(frames.length - 1, 2);
  const tags = chunk(0x2018, Buffer.concat([tagHead, tagBody, asepriteString(tag)]));

  const frameBufs = frames.map(({ cels, duration }, f) => {
    const chunks = [
      ...(f === 0 ? [...layers.map(layerChunk), tags] : []),
      ...cels.map((layer, i) => layer && celChunk(i, layer)).filter(Boolean)
    ];
    const data = Buffer.concat(chunks);
    const head = Buffer.alloc(16);
    head.writeUInt32LE(16 + data.length, 0);
    head.writeUInt16LE(0xf1fa, 4);
    head.writeUInt16LE(Math.min(chunks.length, 0xffff), 6);
    head.writeUInt16LE(duration, 8);
    head.writeUInt32LE(chunks.length, 12);
    return Buffer.concat([head, data]);
  });

  const body = Buffer.concat(frameBufs);
  const header = Buffer.alloc(128);
  header.writeUInt32LE(128 + body.length, 0);
  header.writeUInt16LE(0xa5e0, 4);
  header.writeUInt16LE(frames.length, 6);
  header.writeUInt16LE(width, 8);
  header.writeUInt16LE(height, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(1, 14);
  header.writeUInt16LE(100, 18);
  header[34] = 1;
  header[35] = 1;
  header.writeUInt16LE(16, 40);
  header.writeUInt16LE(16, 42);
  fs.writeFileSync(file, Buffer.concat([header, body]));
}

function buildClip(clip) {
  const doc = aseprite.parse(fs.readFileSync(path.join(PIXEL_DIR, clip, `leslie-${clip}.aseprite`)));
  const slots = [['top', TOPS], ['bottom', BOTTOMS], ['shoes', SHOES]];
  const layers = [{ name: 'body', level: 0, visible: true }];
  const makers = [bodyLayer];
  for (const [slot, items] of slots) {
    layers.push({ name: slot, group: true, level: 0, visible: true });
    makers.push(null);
    for (const [item, make] of Object.entries(items)) {
      layers.push({ name: item, level: 1, visible: DEFAULTS[slot] === item });
      makers.push(make);
    }
  }
  const frames = aseprite.flatten(doc).map(({ rgba, duration }) => {
    const frame = analyse(rgba, doc.width, doc.height);
    return { duration, cels: makers.map((make) => make && make(frame)) };
  });
  return { width: doc.width, height: doc.height, layers, frames, tag: clip };
}

function main() {
  const force = process.argv.includes('--force');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const clip of CLIPS) {
    const target = path.join(OUT_DIR, `leslie-${clip}.aseprite`);
    if (fs.existsSync(target) && !force) {
      console.log(`${clip}: exists, skipped (use --force to rebuild)`);
      continue;
    }
    const built = buildClip(clip);
    writeAseprite(target, built);
    console.log(`${clip}: ${built.frames.length} frames, ${built.layers.length} layers`);
  }
}

main();

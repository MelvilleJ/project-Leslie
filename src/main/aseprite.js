'use strict';

// Decode .aseprite/.ase files and flatten them into spritesheet PNGs for the avatar.
// Format reference: https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const HEADER_MAGIC = 0xa5e0;
const FRAME_MAGIC = 0xf1fa;
const CHUNK_OLD_PALETTE = 0x0004;
const CHUNK_LAYER = 0x2004;
const CHUNK_CEL = 0x2005;
const CHUNK_PALETTE = 0x2019;
const LAYER_VISIBLE = 1;
const LAYER_TYPE_GROUP = 1;
const LAYER_TYPE_TILEMAP = 2;
const CEL_RAW = 0;
const CEL_LINKED = 1;
const CEL_COMPRESSED = 2;

// Pixel sprites are upscaled to roughly the painted sheets' height so --avatar-scale treats both alike.
const TARGET_HEIGHT = 540;
const SHEET_COLS = 4;

const EXTENSIONS = ['.aseprite', '.ase'];

// Top-level groups whose child layers are interchangeable clothing items; an outfit shows one child per slot.
const WARDROBE_SLOTS = ['top', 'bottom', 'shoes'];

function isAsepritePath(file) {
  const lower = String(file).toLowerCase();
  return EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function readLayer(buf, off) {
  return {
    flags: buf.readUInt16LE(off),
    type: buf.readUInt16LE(off + 2),
    childLevel: buf.readUInt16LE(off + 4),
    opacity: buf[off + 12],
    name: buf.toString('utf8', off + 18, off + 18 + buf.readUInt16LE(off + 16))
  };
}

function readCel(buf, off, end) {
  const cel = {
    layer: buf.readUInt16LE(off),
    x: buf.readInt16LE(off + 2),
    y: buf.readInt16LE(off + 4),
    opacity: buf[off + 6],
    type: buf.readUInt16LE(off + 7),
    z: buf.readInt16LE(off + 9)
  };
  const data = off + 16;
  if (cel.type === CEL_LINKED) {
    cel.linkFrame = buf.readUInt16LE(data);
  } else if (cel.type === CEL_RAW || cel.type === CEL_COMPRESSED) {
    cel.w = buf.readUInt16LE(data);
    cel.h = buf.readUInt16LE(data + 2);
    const body = buf.subarray(data + 4, end);
    cel.pixels = cel.type === CEL_COMPRESSED ? zlib.inflateSync(body) : body;
  }
  return cel;
}

function readPalette(buf, off, palette) {
  const first = buf.readUInt32LE(off + 4);
  const last = buf.readUInt32LE(off + 8);
  let p = off + 20;
  for (let i = first; i <= last; i++) {
    const flags = buf.readUInt16LE(p);
    palette[i] = [buf[p + 2], buf[p + 3], buf[p + 4], buf[p + 5]];
    p += 6;
    if (flags & 1) p += 2 + buf.readUInt16LE(p);
  }
}

function readOldPalette(buf, off, palette) {
  const packets = buf.readUInt16LE(off);
  let p = off + 2;
  let index = 0;
  for (let i = 0; i < packets; i++) {
    index += buf[p];
    const count = buf[p + 1] || 256;
    p += 2;
    for (let c = 0; c < count; c++, p += 3) palette[index++] = [buf[p], buf[p + 1], buf[p + 2], 255];
  }
}

/** Parse an .aseprite buffer into header, layers, palette and per-frame cels. */
function parse(buf) {
  if (buf.length < 128 || buf.readUInt16LE(4) !== HEADER_MAGIC) throw new Error('Not an Aseprite file');
  const doc = {
    frameCount: buf.readUInt16LE(6),
    width: buf.readUInt16LE(8),
    height: buf.readUInt16LE(10),
    depth: buf.readUInt16LE(12),
    layerOpacityValid: (buf.readUInt32LE(14) & 1) === 1,
    transparentIndex: buf[28],
    layers: [],
    palette: [],
    frames: []
  };

  let off = 128;
  for (let f = 0; f < doc.frameCount; f++) {
    const frameSize = buf.readUInt32LE(off);
    if (buf.readUInt16LE(off + 4) !== FRAME_MAGIC) throw new Error(`Bad frame header at frame ${f}`);
    const oldCount = buf.readUInt16LE(off + 6);
    const newCount = buf.readUInt32LE(off + 12);
    const frame = { duration: buf.readUInt16LE(off + 8), cels: [] };

    let c = off + 16;
    const chunkCount = newCount || oldCount;
    for (let i = 0; i < chunkCount; i++) {
      const size = buf.readUInt32LE(c);
      const type = buf.readUInt16LE(c + 4);
      const data = c + 6;
      if (type === CHUNK_LAYER) doc.layers.push(readLayer(buf, data));
      else if (type === CHUNK_CEL) frame.cels.push(readCel(buf, data, c + size));
      else if (type === CHUNK_PALETTE) readPalette(buf, data, doc.palette);
      else if (type === CHUNK_OLD_PALETTE && !doc.palette.length) readOldPalette(buf, data, doc.palette);
      c += size;
    }
    doc.frames.push(frame);
    off += frameSize;
  }
  return doc;
}

/** Each layer's wardrobe slot and item name, if it is a direct child of a slot group. */
function wardrobeLayers(layers) {
  const parents = [];
  return layers.map((layer) => {
    parents[layer.childLevel] = layer;
    const parent = layer.childLevel === 1 ? parents[0] : null;
    const slot = parent && parent.type === LAYER_TYPE_GROUP && WARDROBE_SLOTS.includes(parent.name) ? parent.name : null;
    return slot ? { slot, item: layer.name } : null;
  });
}

/**
 * A layer renders only if it and every enclosing group are visible. For each slot the outfit names an item
 * present in this file, that item is shown and its siblings hidden; otherwise the file's own flags apply.
 */
function visibleLayers(layers, outfit = {}) {
  const wardrobe = wardrobeLayers(layers);
  const chosen = (slot) => outfit[slot] && wardrobe.some((w) => w && w.slot === slot && w.item === outfit[slot]);
  const visible = [];
  const groupVisible = [];
  layers.forEach((layer, i) => {
    const parentVisible = layer.childLevel === 0 || groupVisible[layer.childLevel - 1] !== false;
    const w = wardrobe[i];
    const isChosenSlot = layer.childLevel === 0 && WARDROBE_SLOTS.includes(layer.name) && chosen(layer.name);
    let own = (layer.flags & LAYER_VISIBLE) !== 0 || isChosenSlot;
    if (w && chosen(w.slot)) own = w.item === outfit[w.slot];
    const shown = parentVisible && own;
    groupVisible[layer.childLevel] = shown;
    visible.push(shown && layer.type !== LAYER_TYPE_TILEMAP);
  });
  return visible;
}

/** The clothing items a file offers, by slot: { top: [...], bottom: [...], shoes: [...] }. */
function wardrobeItems(file) {
  const items = Object.fromEntries(WARDROBE_SLOTS.map((slot) => [slot, []]));
  for (const w of wardrobeLayers(parse(fs.readFileSync(file)).layers)) if (w) items[w.slot].push(w.item);
  return items;
}

function pixelReader(doc) {
  if (doc.depth === 32) return (px, i) => [px[i * 4], px[i * 4 + 1], px[i * 4 + 2], px[i * 4 + 3]];
  if (doc.depth === 16) return (px, i) => [px[i * 2], px[i * 2], px[i * 2], px[i * 2 + 1]];
  return (px, i) => {
    const idx = px[i];
    if (idx === doc.transparentIndex) return [0, 0, 0, 0];
    return doc.palette[idx] || [0, 0, 0, 0];
  };
}

function blendOver(out, o, r, g, b, a) {
  if (a === 0) return;
  const da = out[o + 3] / 255;
  const sa = a / 255;
  const oa = sa + da * (1 - sa);
  out[o] = Math.round((r * sa + out[o] * da * (1 - sa)) / oa);
  out[o + 1] = Math.round((g * sa + out[o + 1] * da * (1 - sa)) / oa);
  out[o + 2] = Math.round((b * sa + out[o + 2] * da * (1 - sa)) / oa);
  out[o + 3] = Math.round(oa * 255);
}

/** Flatten every frame (normal blend mode only) into RGBA buffers, dressed in `outfit` if given. */
function flatten(doc, outfit) {
  const visible = visibleLayers(doc.layers, outfit);
  const read = pixelReader(doc);
  const resolve = (cel) => {
    if (cel.type !== CEL_LINKED) return cel;
    const src = doc.frames[cel.linkFrame] && doc.frames[cel.linkFrame].cels.find((c) => c.layer === cel.layer);
    return src ? { ...src, opacity: cel.opacity } : null;
  };

  return doc.frames.map((frame) => {
    const out = Buffer.alloc(doc.width * doc.height * 4);
    const cels = frame.cels
      .map(resolve)
      .filter((cel) => cel && cel.pixels && visible[cel.layer])
      .sort((a, b) => a.layer + a.z - (b.layer + b.z) || a.z - b.z);

    for (const cel of cels) {
      const layer = doc.layers[cel.layer];
      const layerOpacity = doc.layerOpacityValid ? layer.opacity : 255;
      const opacity = (cel.opacity * layerOpacity) / (255 * 255);
      for (let y = 0; y < cel.h; y++) {
        const ty = cel.y + y;
        if (ty < 0 || ty >= doc.height) continue;
        for (let x = 0; x < cel.w; x++) {
          const tx = cel.x + x;
          if (tx < 0 || tx >= doc.width) continue;
          const [r, g, b, a] = read(cel.pixels, y * cel.w + x);
          blendOver(out, (ty * doc.width + tx) * 4, r, g, b, Math.round(a * opacity));
        }
      }
    }
    return { duration: frame.duration, rgba: out };
  });
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function sheetScale(height) {
  return Math.max(1, Math.round(TARGET_HEIGHT / height));
}

/** Nearest-neighbour upscale of every frame into a COLS-wide sheet. */
function buildSheet(doc, frames) {
  const scale = sheetScale(doc.height);
  const fw = doc.width * scale;
  const fh = doc.height * scale;
  const cols = Math.min(SHEET_COLS, frames.length);
  const rows = Math.ceil(frames.length / cols);
  const sheetW = fw * cols;
  const sheet = Buffer.alloc(sheetW * fh * rows * 4);

  frames.forEach(({ rgba }, i) => {
    const ox = (i % cols) * fw;
    const oy = Math.floor(i / cols) * fh;
    for (let y = 0; y < fh; y++) {
      const srcRow = Math.floor(y / scale) * doc.width;
      const dstRow = ((oy + y) * sheetW + ox) * 4;
      for (let x = 0; x < fw; x++) {
        const s = (srcRow + Math.floor(x / scale)) * 4;
        rgba.copy(sheet, dstRow + x * 4, s, s + 4);
      }
    }
  });

  return {
    png: encodePng(sheetW, fh * rows, sheet),
    grid: { frameW: fw, frameH: fh, cols, frames: frames.length, frameMs: frames[0].duration || 100 }
  };
}

const cache = new Map();

/**
 * Render an .aseprite file as a spritesheet PNG plus its frame grid. Cached by mtime and outfit.
 * Aseprite allows per-frame durations; the avatar plays at a fixed rate, so frame 0's is used.
 * @param {{ top?: string, bottom?: string, shoes?: string }} [outfit] wardrobe item per slot
 * @returns {{ png: Buffer, grid: { frameW: number, frameH: number, cols: number, frames: number, frameMs: number } }}
 */
function loadSheet(file, outfit = {}) {
  const mtime = fs.statSync(file).mtimeMs;
  const key = `${file}\0${WARDROBE_SLOTS.map((slot) => outfit[slot] || '').join('\0')}`;
  const hit = cache.get(key);
  if (hit && hit.mtime === mtime) return hit.sheet;
  const doc = parse(fs.readFileSync(file));
  if (!doc.frames.length) throw new Error('Aseprite file has no frames');
  const sheet = buildSheet(doc, flatten(doc, outfit));
  cache.set(key, { mtime, sheet });
  return sheet;
}

/** CSS in the same .sprite/.sprite-N shape as the bundled sheets, so it re-imports with its grid. */
function sheetCss({ frameW, frameH, cols, frames }, pngName) {
  const lines = [
    '.sprite {',
    '  display: inline-block;',
    `  background: url('${pngName}') no-repeat;`,
    `  width: ${frameW}px;`,
    `  height: ${frameH}px;`,
    '  image-rendering: pixelated;',
    '}'
  ];
  for (let i = 0; i < frames; i++) {
    lines.push(`.sprite-${i} { background-position: -${(i % cols) * frameW}px -${Math.floor(i / cols) * frameH}px; }`);
  }
  return `${lines.join('\n')}\n`;
}

/** Write <name>.spritesheet.png + .css beside the source file; returns the PNG path. */
function exportSheet(file) {
  const { png, grid } = loadSheet(file);
  const base = file.replace(/\.(aseprite|ase)$/i, '');
  const pngPath = `${base}.spritesheet.png`;
  fs.writeFileSync(pngPath, png);
  fs.writeFileSync(`${base}.spritesheet.css`, sheetCss(grid, path.basename(pngPath)));
  return pngPath;
}

module.exports = {
  EXTENSIONS, WARDROBE_SLOTS, isAsepritePath, parse, flatten, loadSheet, exportSheet, wardrobeItems
};

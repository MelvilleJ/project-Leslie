#!/usr/bin/env python3
"""Build pixel-art Leslie clips (.aseprite + spritesheet.png/.css) from the painted idle sheet.

Usage: python3 scripts/build-pixel-sprites.py
Output: assets/animations/pixel/<clip>/{spritesheet.png,spritesheet.css,leslie-<clip>.aseprite}
"""
import struct
import zlib
from pathlib import Path

from PIL import Image, ImageEnhance

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'assets/animations/idle/spritesheet.png'
OUT_DIR = ROOT / 'assets/animations/pixel'

SPRITE_H = 128
CANVAS_W, CANVAS_H = 72, 140
ORIGIN = (4, 8)
SHEET_SCALE = 4
COLS = 4
FRAME_MS = 140

OUTLINE = (14, 10, 16, 255)
SKIN = (184, 118, 78, 255)
SKIN_SHADE = (152, 92, 60, 255)
MOUTH_DARK = (74, 22, 30, 255)
TONGUE = (176, 70, 78, 255)
WHITE = (240, 240, 236, 255)
GOLD = (237, 197, 74, 255)
STEEL = (150, 156, 170, 255)
STEEL_DARK = (90, 94, 110, 255)

# Quantizer output -> hand-tuned palette. The pure blacks are lifted so the hoodie keeps its folds.
REMAP = {
    (0, 0, 0): (24, 21, 30), (20, 22, 23): (44, 41, 54), (56, 56, 55): (70, 66, 82),
    (121, 45, 9): (112, 48, 30), (99, 83, 36): (118, 70, 46),
    (143, 91, 56): (152, 92, 60), (177, 109, 61): (184, 118, 78),
}
HOODIE_HIGHLIGHT = (58, 55, 70)

# Feature coordinates in base-sprite space (measured from the pixelated frame).
HEAD_ROWS = 68
LEFT_EYE = (12, 52, 23, 60)
RIGHT_EYE = (33, 52, 41, 60)
MOUTH = (28, 65)


def pixelate():
    src = Image.open(SRC).crop((0, 0, 228, 537))
    c = src.crop(src.getchannel('A').point(lambda a: 255 if a > 128 else 0).getbbox())
    w = round(c.width * SPRITE_H / c.height)
    rgb = c.convert('RGB').point(lambda v: int(255 * ((v / 255) ** 0.7)))
    rgb = ImageEnhance.Color(ImageEnhance.Contrast(rgb).enhance(1.15)).enhance(1.25)
    small = rgb.resize((w, SPRITE_H), Image.BOX)
    alpha = c.getchannel('A').resize((w, SPRITE_H), Image.BOX).point(lambda v: 255 if v > 110 else 0)
    q = small.quantize(18, method=Image.MAXCOVERAGE, dither=Image.NONE).convert('RGBA')
    q.putalpha(alpha)
    px = q.load()
    for y in range(q.height):
        for x in range(q.width):
            p = px[x, y]
            if not p[3]:
                continue
            if p[:3] == (54, 38, 24) and 72 <= y <= 93:
                px[x, y] = HOODIE_HIGHLIGHT + (255,)
            elif p[:3] in REMAP:
                px[x, y] = REMAP[p[:3]] + (255,)
    return q


def split(base):
    head = Image.new('RGBA', base.size)
    head.paste(base.crop((0, 0, base.width, HEAD_ROWS)), (0, 0))
    body = Image.new('RGBA', base.size)
    body.paste(base.crop((0, HEAD_ROWS, base.width, base.height)), (0, HEAD_ROWS))
    return head, body


def outline(img):
    out = img.copy()
    src, dst = img.load(), out.load()
    for y in range(img.height):
        for x in range(img.width):
            if src[x, y][3]:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < img.width and 0 <= ny < img.height and src[nx, ny][3]:
                    dst[x, y] = OUTLINE
                    break
    return out


def is_eye_pixel(p):
    r, g, b, a = p
    return a and (r + g + b < 260 or abs(r - g) < 20 and abs(g - b) < 20)


def close_eye(head, box, lid_row=57):
    x0, y0, x1, y1 = box
    px = head.load()
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if is_eye_pixel(px[x, y]):
                px[x, y] = SKIN
    for x in range(x0 + 1, x1):
        px[x, lid_row] = OUTLINE
    px[x0, lid_row - 1] = OUTLINE
    px[x1, lid_row - 1] = OUTLINE


def half_lid(head, box):
    """Drop the upper lid to mid-eye: a sleepy/focused look."""
    x0, y0, x1, y1 = box
    px = head.load()
    for y in range(y0, y0 + 3):
        for x in range(x0, x1 + 1):
            if is_eye_pixel(px[x, y]):
                px[x, y] = SKIN_SHADE if y < y0 + 2 else OUTLINE


def mouth(head, shape):
    mx, my = MOUTH
    px = head.load()
    if shape == 'small':
        for x in (mx - 1, mx, mx + 1):
            px[x, my] = MOUTH_DARK
    elif shape == 'open':
        for x in (mx - 1, mx, mx + 1):
            px[x, my] = MOUTH_DARK
            px[x, my + 1] = TONGUE
        px[mx - 2, my] = SKIN_SHADE
        px[mx + 2, my] = SKIN_SHADE
    elif shape == 'o':
        for x in (mx - 1, mx, mx + 1):
            px[x, my - 1] = MOUTH_DARK
            px[x, my + 1] = MOUTH_DARK
        px[mx - 1, my] = MOUTH_DARK
        px[mx + 1, my] = MOUTH_DARK
        px[mx, my] = TONGUE
    elif shape == 'smile':
        px[mx - 2, my - 1] = MOUTH_DARK
        for x in (mx - 1, mx, mx + 1):
            px[x, my] = MOUTH_DARK
        px[mx + 2, my - 1] = MOUTH_DARK


def dot(canvas, x, y, color, size=2):
    for dx in range(size):
        for dy in range(size):
            canvas.putpixel((x + dx, y + dy), color)


def gear(canvas, cx, cy, phase):
    teeth = [(0, -3), (3, 0), (0, 3), (-3, 0)] if phase % 2 == 0 else [(2, -2), (2, 2), (-2, 2), (-2, -2)]
    for tx, ty in teeth:
        dot(canvas, cx + tx, cy + ty, STEEL_DARK, 1)
    for dx in range(-2, 3):
        for dy in range(-2, 3):
            if abs(dx) + abs(dy) <= 3:
                canvas.putpixel((cx + dx, cy + dy), STEEL)
    canvas.putpixel((cx, cy), STEEL_DARK)


def sparkle(canvas, x, y, big):
    canvas.putpixel((x, y), WHITE)
    for d in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        canvas.putpixel((x + d[0], y + d[1]), GOLD)
    if big:
        for d in ((2, 0), (-2, 0), (0, 2), (0, -2)):
            canvas.putpixel((x + d[0], y + d[1]), GOLD)


def compose(head, body, head_dx=0, head_dy=0, dy=0, fx=None, fx_arg=None):
    sprite = Image.new('RGBA', head.size)
    sprite.alpha_composite(body)
    sprite.alpha_composite(head, (head_dx, head_dy))
    canvas = Image.new('RGBA', (CANVAS_W, CANVAS_H))
    canvas.alpha_composite(sprite, (ORIGIN[0], ORIGIN[1] + dy))
    canvas = outline(canvas)
    if fx:
        fx(canvas, fx_arg)
    return canvas


def variant(head, eyes=None, mouth_shape=None):
    h = head.copy()
    if eyes == 'closed':
        close_eye(h, LEFT_EYE)
        close_eye(h, RIGHT_EYE)
    elif eyes == 'half':
        half_lid(h, LEFT_EYE)
        half_lid(h, RIGHT_EYE)
    if mouth_shape:
        mouth(h, mouth_shape)
    return h


def build_clips(base):
    head, body = split(base)
    clips = {}

    bob = [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0]
    clips['idle'] = [
        compose(variant(head, eyes='closed') if i == 9 else head, body, head_dy=d)
        for i, d in enumerate(bob)
    ]

    talk = ['open', 'small', 'o', 'small', None, 'open', 'small', 'open', 'o', None]
    clips['talking'] = [
        compose(variant(head, mouth_shape=m), body, head_dy=1 if i % 4 in (1, 2) else 0)
        for i, m in enumerate(talk)
    ]

    def thought_dots(canvas, n):
        for i in range(n):
            x, y, size = 54 + i * 5, 20 - i * 5, 2 + i
            dot(canvas, x - 1, y - 1, OUTLINE, size + 2)
            dot(canvas, x, y, WHITE, size)
    thinking_head = variant(head, eyes='half')
    clips['thinking'] = [
        compose(thinking_head, body, head_dx=1 if i >= 4 else 0, fx=thought_dots, fx_arg=n)
        for i, n in enumerate([0, 1, 1, 2, 2, 3, 3, 3])
    ]

    def tool_fx(canvas, i):
        gear(canvas, 62, 12 + (1 if i % 4 in (1, 2) else 0), i)
        if i % 4 == 0:
            sparkle(canvas, 54, 6, i % 8 == 0)
    focused = variant(head, eyes='half', mouth_shape='small')
    clips['tools'] = [compose(focused, body, head_dy=1 if i % 4 in (2, 3) else 0, fx=tool_fx, fx_arg=i)
                      for i in range(8)]

    tilt = [0, 1, 1, 1, 1, 1, 0, 0]
    clips['listening'] = [
        compose(variant(head, eyes='closed' if i == 6 else None, mouth_shape='smile'), body, head_dx=t)
        for i, t in enumerate(tilt)
    ]

    hop = [(0, 1), (2, 1), (-2, 0), (-5, 0), (-6, 0), (-5, 0), (-2, 0), (2, 1), (0, 1), (0, 0)]
    clips['moving'] = [compose(head, body, head_dy=squash, dy=dy) for dy, squash in hop]
    return clips


def write_sheet(frames, folder):
    rows = (len(frames) + COLS - 1) // COLS
    fw, fh = CANVAS_W * SHEET_SCALE, CANVAS_H * SHEET_SCALE
    sheet = Image.new('RGBA', (fw * COLS, fh * rows))
    for i, f in enumerate(frames):
        sheet.alpha_composite(f.resize((fw, fh), Image.NEAREST), ((i % COLS) * fw, (i // COLS) * fh))
    sheet.save(folder / 'spritesheet.png', optimize=True)
    css = ['.sprite {', '  display: inline-block;', "  background: url('spritesheet.png') no-repeat;",
           f'  width: {fw}px;', f'  height: {fh}px;', '}']
    css += [f'.sprite-{i} {{ background-position: -{(i % COLS) * fw}px -{(i // COLS) * fh}px; }}'
            for i in range(len(frames))]
    (folder / 'spritesheet.css').write_text('\n'.join(css) + '\n')


def _chunk(kind, data):
    return struct.pack('<IH', len(data) + 6, kind) + data


def _string(s):
    b = s.encode()
    return struct.pack('<H', len(b)) + b


def write_aseprite(frames, path, tag):
    """Minimal RGBA .aseprite writer (one layer, one tag) per the official file-format spec."""
    w, h = frames[0].size
    colors = sorted({p for f in frames for p in f.getdata() if p[3]})
    palette = struct.pack('<III8x', len(colors), 0, len(colors) - 1) + b''.join(
        struct.pack('<HBBBB', 0, *c) for c in colors)
    layer = struct.pack('<HHHHHHB3x', 3, 0, 0, 0, 0, 0, 255) + _string('Leslie')
    tags = struct.pack('<H8x', 1) + struct.pack('<HHBH6x3sx', 0, len(frames) - 1, 0, 0, b'\0\0\0') \
        + _string(tag)

    body = b''
    for i, f in enumerate(frames):
        chunks = []
        if i == 0:
            chunks += [_chunk(0x2019, palette), _chunk(0x2004, layer), _chunk(0x2018, tags)]
        cel = struct.pack('<HhhBHh5x', 0, 0, 0, 255, 2, 0) + struct.pack('<HH', w, h) \
            + zlib.compress(f.tobytes())
        chunks.append(_chunk(0x2005, cel))
        data = b''.join(chunks)
        body += struct.pack('<IHHH2xI', 16 + len(data), 0xF1FA, min(len(chunks), 0xFFFF),
                            FRAME_MS, len(chunks)) + data

    header = struct.pack('<IHHHHHIHIIB3xHBBhhHH84x', 128 + len(body), 0xA5E0, len(frames), w, h,
                         32, 1, 100, 0, 0, 0, len(colors), 1, 1, 0, 0, 16, 16)
    path.write_bytes(header + body)


def main():
    clips = build_clips(pixelate())
    for name, frames in clips.items():
        folder = OUT_DIR / name
        folder.mkdir(parents=True, exist_ok=True)
        write_sheet(frames, folder)
        write_aseprite(frames, folder / f'leslie-{name}.aseprite', name)
        print(f'{name}: {len(frames)} frames')


if __name__ == '__main__':
    main()

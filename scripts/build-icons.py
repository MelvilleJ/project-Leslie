#!/usr/bin/env python3
"""Build LESLIE's app/tray icon: her head cut from the idle sprite on a transparent square.
Usage: python scripts/build-icons.py
Writes assets/icons/leslie-<size>.png for the standard hicolor sizes.
"""

import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPRITE = os.path.join(ROOT, "assets", "animations", "idle", "spritesheet.png")
OUT_DIR = os.path.join(ROOT, "assets", "icons")

FRAME = (0, 0, 228, 537)    # first idle frame
CHIN_Y = 277                # hoodie collar starts below this row
MARGIN = 0.03               # breathing room so the hair isn't clipped by the tray
MASTER = 1024
SIZES = (16, 22, 24, 32, 48, 64, 128, 256, 512)


def head(frame):
    cut = frame.crop((0, 0, frame.width, CHIN_Y))
    return cut.crop(cut.getbbox())


def squared(img):
    side = int(max(img.size) * (1 + 2 * MARGIN))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    return canvas.resize((MASTER, MASTER), Image.LANCZOS)


def main():
    frame = Image.open(SPRITE).convert("RGBA").crop(FRAME)
    icon = squared(head(frame))
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, f"leslie-{size}.png")
        icon.resize((size, size), Image.LANCZOS).save(path, optimize=True)
        print(path)


if __name__ == "__main__":
    main()

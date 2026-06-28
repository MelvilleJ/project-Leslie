#!/usr/bin/env python3
"""Rebuild the LESLIE spritesheet at higher resolution.

Pipeline: slice the original 76x179 frames out of the source sheet, upscale each
frame 4x with Real-ESRGAN (anime model, preserves alpha), Lanczos-downscale to the
target scale, repack into a new sheet, and regenerate the matching CSS. The result
is displayed at native size in the app so there is no blurry runtime scaling.

The original low-res sheet is preserved as assets/spritesheet.src.png and is always
the slicing source, so this script is safe to re-run (e.g. with a different scale).

Usage:
    python scripts/build-spritesheet.py [TARGET_SCALE]   # default 3
"""

import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image

# --- Layout of the ORIGINAL source sheet ------------------------------------
COLS = 4
FRAME_W = 76
FRAME_H = 179
FRAMES = 25  # sprite-0 .. sprite-24, row-major

ESRGAN_UPSCALE = 4            # native scale the model is run at
ESRGAN_MODEL = "realesrgan-x4plus-anime"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
SRC = os.path.join(ASSETS, "spritesheet.src.png")
EXE = os.path.join(ROOT, "tools", "realesrgan", "realesrgan-ncnn-vulkan.exe")
MODELS = os.path.join(ROOT, "tools", "realesrgan", "models")


def ensure_source():
    """The first run snapshots the current (low-res) sheet as the source."""
    if os.path.exists(SRC):
        return
    current = os.path.join(ASSETS, "spritesheet.png")
    img = Image.open(current)
    if img.size != (COLS * FRAME_W, ((FRAMES + COLS - 1) // COLS) * FRAME_H):
        sys.exit(
            f"Refusing to snapshot {current} as source: size {img.size} is not the "
            f"expected original {COLS * FRAME_W}x{((FRAMES + COLS - 1) // COLS) * FRAME_H}. "
            "If you already upscaled it, restore the 76x179 original first."
        )
    shutil.copy2(current, SRC)
    print(f"Snapshotted original source -> {SRC}")


def slice_frames(sheet, out_dir):
    for i in range(FRAMES):
        col, row = i % COLS, i // COLS
        box = (col * FRAME_W, row * FRAME_H, (col + 1) * FRAME_W, (row + 1) * FRAME_H)
        sheet.crop(box).save(os.path.join(out_dir, f"{i:02d}.png"))


def upscale_dir(in_dir, out_dir):
    cmd = [EXE, "-i", in_dir, "-o", out_dir,
           "-n", ESRGAN_MODEL, "-m", MODELS, "-s", str(ESRGAN_UPSCALE), "-f", "png"]
    print("Running:", " ".join(cmd))
    subprocess.run(cmd, check=True)


def repack(up_dir, scale):
    fw, fh = FRAME_W * scale, FRAME_H * scale
    rows = (FRAMES + COLS - 1) // COLS
    sheet = Image.new("RGBA", (COLS * fw, rows * fh), (0, 0, 0, 0))
    for i in range(FRAMES):
        frame = Image.open(os.path.join(up_dir, f"{i:02d}.png")).convert("RGBA")
        frame = frame.resize((fw, fh), Image.LANCZOS)
        col, row = i % COLS, i // COLS
        sheet.paste(frame, (col * fw, row * fh))
    return sheet, fw, fh


def css(fw, fh):
    lines = [
        ".sprite {",
        "  display: inline-block;",
        "  background: url('spritesheet.png') no-repeat;",
        f"  width: {fw}px;",
        f"  height: {fh}px;",
        "}",
    ]
    for i in range(FRAMES):
        col, row = i % COLS, i // COLS
        lines.append(f".sprite-{i} {{ background-position: -{col * fw}px -{row * fh}px; }}")
    return "\n".join(lines) + "\n"


def main():
    scale = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    if not os.path.exists(EXE):
        sys.exit(f"Real-ESRGAN binary not found at {EXE}")

    ensure_source()
    sheet = Image.open(SRC).convert("RGBA")

    with tempfile.TemporaryDirectory() as tmp:
        in_dir = os.path.join(tmp, "in")
        out_dir = os.path.join(tmp, "out")
        os.makedirs(in_dir)
        os.makedirs(out_dir)
        slice_frames(sheet, in_dir)
        upscale_dir(in_dir, out_dir)
        new_sheet, fw, fh = repack(out_dir, scale)

    css_text = css(fw, fh)
    for base in (ASSETS, ROOT):  # app uses assets/, test.html uses root copy
        new_sheet.save(os.path.join(base, "spritesheet.png"))
        with open(os.path.join(base, "spritesheet.css"), "w", encoding="utf-8") as f:
            f.write(css_text)

    print(f"Done. Frame {fw}x{fh}, sheet {new_sheet.size[0]}x{new_sheet.size[1]} ({scale}x).")


if __name__ == "__main__":
    main()

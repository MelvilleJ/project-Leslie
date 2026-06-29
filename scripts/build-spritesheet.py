#!/usr/bin/env python3
"""Upscale a LESLIE animation spritesheet with Real-ESRGAN.

Pipeline: slice the original frames out of the source sheet, upscale each frame 4x
with Real-ESRGAN (anime model, preserves alpha), Lanczos-downscale to a target
character height, repack into a new sheet, and regenerate the matching CSS. The
result is displayed at native size in the app so there is no blurry runtime scaling.

All animations are scaled to the same TARGET_HEIGHT so LESLIE stays the same size
when switching between them (idle / thinking / tools / ...).

Each animation lives in assets/animations/<name>/ as spritesheet.png + spritesheet.css.
The original low-res sheet is snapshotted once to spritesheet.src.png and its grid is
recorded in spritesheet.src.json, so re-runs always slice from the true source.

Usage:
    python scripts/build-spritesheet.py <name> [--height N]   # default height 537

Examples:
    python scripts/build-spritesheet.py tools
    python scripts/build-spritesheet.py thinking --height 537
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile

from PIL import Image

TARGET_HEIGHT = 537          # matches the idle sheet so all animations align
ESRGAN_UPSCALE = 4           # native scale the model is run at
ESRGAN_MODEL = "realesrgan-x4plus-anime"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANIM_DIR = os.path.join(ROOT, "assets", "animations")
EXE = os.path.join(ROOT, "tools", "realesrgan", "realesrgan-ncnn-vulkan.exe")
MODELS = os.path.join(ROOT, "tools", "realesrgan", "models")


def detect_grid(css_path, sheet):
    """Read frame size + count from a spritesheet.css and infer the column count."""
    text = open(css_path, encoding="utf-8").read()
    fw = int(re.search(r"width:\s*(\d+)px", text).group(1))
    fh = int(re.search(r"height:\s*(\d+)px", text).group(1))
    frames = len(re.findall(r"\.sprite-\d+\s*\{", text))
    cols = sheet.size[0] // fw
    return {"fw": fw, "fh": fh, "cols": cols, "frames": frames}


def ensure_source(folder):
    """Return (source Image, grid). First run snapshots the original sheet + grid."""
    png = os.path.join(folder, "spritesheet.png")
    src_png = os.path.join(folder, "spritesheet.src.png")
    src_json = os.path.join(folder, "spritesheet.src.json")

    if os.path.exists(src_png) and os.path.exists(src_json):
        grid = json.load(open(src_json, encoding="utf-8"))
        return Image.open(src_png).convert("RGBA"), grid

    if os.path.exists(src_png) != os.path.exists(src_json):
        raise SystemExit(
            f"{folder}: found only one of spritesheet.src.png / spritesheet.src.json. "
            "Restore the original low-res pair or delete both to re-snapshot."
        )

    # First run: the current sheet/css describe the original source.
    sheet = Image.open(png).convert("RGBA")
    grid = detect_grid(os.path.join(folder, "spritesheet.css"), sheet)
    shutil.copy2(png, src_png)
    json.dump(grid, open(src_json, "w", encoding="utf-8"))
    print(f"Snapshotted source -> {src_png} ({grid['fw']}x{grid['fh']}, {grid['frames']} frames)")
    return sheet, grid


def slice_frames(sheet, grid, out_dir):
    fw, fh, cols, n = grid["fw"], grid["fh"], grid["cols"], grid["frames"]
    for i in range(n):
        c, r = i % cols, i // cols
        sheet.crop((c * fw, r * fh, (c + 1) * fw, (r + 1) * fh)).save(
            os.path.join(out_dir, f"{i:02d}.png"))


def upscale_dir(in_dir, out_dir):
    cmd = [EXE, "-i", in_dir, "-o", out_dir,
           "-n", ESRGAN_MODEL, "-m", MODELS, "-s", str(ESRGAN_UPSCALE), "-f", "png"]
    print("Running:", " ".join(cmd))
    subprocess.run(cmd, check=True)


def repack(up_dir, grid, target_h):
    nfw = round(grid["fw"] * target_h / grid["fh"])   # proportional width
    nfh = target_h
    cols, n = grid["cols"], grid["frames"]
    rows = (n + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * nfw, rows * nfh), (0, 0, 0, 0))
    for i in range(n):
        frame = Image.open(os.path.join(up_dir, f"{i:02d}.png")).convert("RGBA")
        frame = frame.resize((nfw, nfh), Image.LANCZOS)
        c, r = i % cols, i // cols
        sheet.paste(frame, (c * nfw, r * nfh))
    return sheet, nfw, nfh


def css(grid, fw, fh):
    lines = [
        ".sprite {",
        "  display: inline-block;",
        "  background: url('spritesheet.png') no-repeat;",
        f"  width: {fw}px;",
        f"  height: {fh}px;",
        "}",
    ]
    for i in range(grid["frames"]):
        c, r = i % grid["cols"], i // grid["cols"]
        lines.append(f".sprite-{i} {{ background-position: -{c * fw}px -{r * fh}px; }}")
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("name", help="animation folder under assets/animations/")
    ap.add_argument("--height", type=int, default=TARGET_HEIGHT,
                    help=f"target frame height in px (default {TARGET_HEIGHT})")
    args = ap.parse_args()

    folder = os.path.join(ANIM_DIR, args.name)
    if not os.path.isdir(folder):
        raise SystemExit(f"No such animation folder: {folder}")
    if not os.path.exists(EXE):
        raise SystemExit(f"Real-ESRGAN binary not found at {EXE}")

    sheet, grid = ensure_source(folder)

    with tempfile.TemporaryDirectory() as tmp:
        in_dir, out_dir = os.path.join(tmp, "in"), os.path.join(tmp, "out")
        os.makedirs(in_dir)
        os.makedirs(out_dir)
        slice_frames(sheet, grid, in_dir)
        upscale_dir(in_dir, out_dir)
        new_sheet, fw, fh = repack(out_dir, grid, args.height)

    new_sheet.save(os.path.join(folder, "spritesheet.png"))
    open(os.path.join(folder, "spritesheet.css"), "w", encoding="utf-8").write(css(grid, fw, fh))
    print(f"Done. {args.name}: frame {fw}x{fh}, sheet "
          f"{new_sheet.size[0]}x{new_sheet.size[1]} ({grid['frames']} frames).")


if __name__ == "__main__":
    main()

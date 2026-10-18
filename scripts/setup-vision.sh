#!/usr/bin/env bash
# Camera presence for LESLIE: install the vision sidecar (SCRFD + ArcFace from
# InsightFace's buffalo_l, via onnxruntime on an NVIDIA GPU or the CPU) and run it
# as the leslie-vision user service on 127.0.0.1:8179.
# VISION_RUNTIME=cuda|cpu overrides the choice (default: cuda when nvidia-smi works).
# Idempotent: skips the download steps that are already done.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$HOME/.local/opt/leslie-vision"
MODEL_DIR="$HOME/models/vision"
PORT=8179
UNIT="$HOME/.config/systemd/user/leslie-vision.service"

command -v uv >/dev/null || { echo "uv is required (pacman -S uv)"; exit 1; }

if [ -z "${VISION_RUNTIME:-}" ]; then
  if nvidia-smi -L >/dev/null 2>&1; then VISION_RUNTIME=cuda; else VISION_RUNTIME=cpu; fi
fi
case "$VISION_RUNTIME" in
  cuda) other=onnxruntime ;;
  cpu) other=onnxruntime-gpu ;;
  *) echo "VISION_RUNTIME must be cuda or cpu" >&2; exit 1 ;;
esac

echo "→ python environment in $VENV ($VISION_RUNTIME)"
uv venv -q --allow-existing --python 3.12 "$VENV"
# Both packages provide the onnxruntime module, so drop the other one first.
VIRTUAL_ENV="$VENV" uv pip uninstall -q "$other" 2>/dev/null || true
VIRTUAL_ENV="$VENV" uv pip install -q --reinstall-package leslie-vision "$ROOT/vision[$VISION_RUNTIME]"

if [ ! -f "$MODEL_DIR/det_10g.onnx" ] || [ ! -f "$MODEL_DIR/w600k_r50.onnx" ]; then
  echo "→ downloading InsightFace buffalo_l"
  mkdir -p "$MODEL_DIR"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fL --progress-bar -o "$tmp/buffalo_l.zip" \
    https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip
  bsdtar -xf "$tmp/buffalo_l.zip" -C "$tmp"
  find "$tmp" -name det_10g.onnx -exec mv {} "$MODEL_DIR/" \;
  find "$tmp" -name w600k_r50.onnx -exec mv {} "$MODEL_DIR/" \;
fi

for model in palm_detection_mediapipe handpose_estimation_mediapipe; do
  if [ ! -f "$MODEL_DIR/${model}_2023feb.onnx" ]; then
    echo "→ downloading $model"
    curl -fsSL -o "$MODEL_DIR/${model}_2023feb.onnx" \
      "https://huggingface.co/opencv/$model/resolve/main/${model}_2023feb.onnx"
  fi
done

echo "→ leslie-vision.service"
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<EOF
[Unit]
Description=LESLIE camera presence (face detection + recognition)
# Start before the model server so llama.cpp's --fit sizes the Everyday model
# around the ~1 GB the vision models keep on the GPU.
Before=llama-router.service

[Service]
ExecStart=$VENV/bin/leslie-vision --host 127.0.0.1 --port $PORT --models $MODEL_DIR
ExecStartPost=/bin/sh -c 'for i in \$(seq 1 120); do curl -sf -o /dev/null http://127.0.0.1:$PORT/health && exit 0; sleep 0.5; done; exit 1'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable leslie-vision.service

echo
echo "Done. Start it now with: systemctl --user start leslie-vision"
echo "Then turn the camera on in LESLIE: Settings → Camera."

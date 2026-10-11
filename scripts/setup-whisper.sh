#!/usr/bin/env bash
# Speech recognition for LESLIE: build whisper.cpp (CUDA) and run
# Whisper large-v3-turbo as the leslie-whisper user service on 127.0.0.1:8178,
# exposing the OpenAI-style /v1/audio/transcriptions endpoint LESLIE's voice uses.
# Idempotent: skips the clone/build/download steps that are already done.
set -euo pipefail

SRC="$HOME/.local/src/whisper.cpp"
MODEL_DIR="$HOME/models/whisper"
MODEL="ggml-large-v3-turbo-q5_0"
PORT=8178
UNIT="$HOME/.config/systemd/user/leslie-whisper.service"
CUDA_ARCH="${CUDA_ARCH:-86}"   # RTX 3060

if [ ! -d "$SRC" ]; then
  tag=$(git ls-remote --tags --refs https://github.com/ggml-org/whisper.cpp.git | awk -F/ '{print $3}' |
    grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
  echo "→ cloning whisper.cpp $tag"
  git clone -q --depth 1 --branch "$tag" https://github.com/ggml-org/whisper.cpp.git "$SRC"
fi

if [ ! -x "$SRC/build/bin/whisper-server" ]; then
  echo "→ building whisper-server (CUDA, sm_$CUDA_ARCH)"
  cmake -S "$SRC" -B "$SRC/build" -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCH" \
    -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_SERVER=ON -DWHISPER_BUILD_TESTS=OFF -DBUILD_SHARED_LIBS=OFF
  cmake --build "$SRC/build" -j "$(nproc)" --target whisper-server
fi

if [ ! -f "$MODEL_DIR/$MODEL.bin" ]; then
  echo "→ downloading $MODEL"
  mkdir -p "$MODEL_DIR"
  bash "$SRC/models/download-ggml-model.sh" "$MODEL" "$MODEL_DIR"
fi

echo "→ leslie-whisper.service"
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<EOF
[Unit]
Description=LESLIE speech recognition (whisper.cpp, $MODEL)
# Start before the model server so llama.cpp's --fit sizes the Everyday model
# around the ~0.9 GB whisper keeps on the RTX 3060.
Before=llama-router.service

[Service]
ExecStart=$SRC/build/bin/whisper-server -m $MODEL_DIR/$MODEL.bin --host 127.0.0.1 --port $PORT --inference-path /v1/audio/transcriptions -l en -t 4 -fa
# Count as started only once the model is loaded and the port answers.
ExecStartPost=/bin/sh -c 'for i in \$(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:$PORT/ && exit 0; sleep 0.5; done; exit 1'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable leslie-whisper.service

echo
echo "Done. Start it now with: systemctl --user start leslie-whisper"
echo "LESLIE uses it when Settings → Voice → Speech recognition is set to the whisper server."

#!/usr/bin/env bash
# The shared llama.cpp model server: llama-server in router mode as the
# llama-router user service on 127.0.0.1:8080 (OpenAI-style API at /v1). It is
# not tied to LESLIE; any app can use it, and LESLIE only adds its own sections
# to the presets file. Leaves an existing unit or presets file untouched.
set -euo pipefail

MODELS="${MODELS:-$HOME/models}"
PORT="${PORT:-8080}"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/llama-router"
PRESETS="$CONF/presets.ini"
UNIT="$HOME/.config/systemd/user/llama-router.service"
BIN="$(command -v llama-server)" || { echo "llama-server is not on PATH (install llama.cpp first)" >&2; exit 1; }

mkdir -p "$CONF" "$(dirname "$UNIT")"

if [ -e "$PRESETS" ]; then
  echo "→ keeping $PRESETS"
else
  echo "→ $PRESETS"
  cat > "$PRESETS" <<INI
version = 1

[*]
jinja = true
INI
fi

if [ -e "$UNIT" ]; then
  echo "→ keeping $UNIT"
else
  echo "→ llama-router.service"
  cat > "$UNIT" <<UNIT
[Unit]
Description=llama.cpp model router
After=network.target

[Service]
ExecStart=$BIN --models-dir $MODELS --models-preset $PRESETS --no-models-autoload --host 127.0.0.1 --port $PORT
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=default.target
UNIT
fi

systemctl --user daemon-reload
systemctl --user enable llama-router.service

echo
echo "Done. Start it now with: systemctl --user start llama-router"
echo "Models in $MODELS are served at http://127.0.0.1:$PORT/v1; per-model settings go in $PRESETS."

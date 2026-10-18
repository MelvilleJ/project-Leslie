#!/usr/bin/env bash
# Install the built app for this user (no root): ~/.local/opt/leslie, launcher
# entries, icons, and the leslie.service user service that starts the app at
# login. LESLIE uses the shared llama-router service for its models; this sets
# it up via scripts/setup-llama-router.sh when it isn't installed yet.
# Build first with `npm run build:linux` (or run `npm run install:linux`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/dist/linux-unpacked"
DEST="$HOME/.local/opt/leslie"
BIN="$HOME/.local/bin"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor"
UNITS="$HOME/.config/systemd/user"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/project-leslie"

[ -x "$BUILD/leslie" ] || { echo "No build at $BUILD — run: npm run build:linux" >&2; exit 1; }

echo "→ app → $DEST"
mkdir -p "$BIN" "$APPS" "$UNITS" "$CONF"
mkdir -p "$(dirname "$DEST")"
rm -rf "${DEST:?}"
cp -a "$BUILD" "$DEST"

UNPACKED="$DEST/resources/app.asar.unpacked"
ln -sf "$DEST/leslie" "$BIN/leslie"
ln -sf "$UNPACKED/bin/leslie-server" "$BIN/leslie-server"

echo "→ icons"
for size in 16 22 24 32 48 64 128 256 512; do
  mkdir -p "$ICONS/${size}x${size}/apps"
  cp "$ROOT/assets/icons/leslie-$size.png" "$ICONS/${size}x${size}/apps/leslie.png"
done
gtk-update-icon-cache -q "$ICONS" 2>/dev/null || true

echo "→ launcher entries"
cat > "$APPS/leslie.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=LESLIE
Comment=Desktop AI companion (pi agent GUI)
Exec=$DEST/leslie
Icon=leslie
Categories=Utility;
StartupWMClass=project-leslie
EOF
cat > "$APPS/leslie-server.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=LESLIE Model Server
Comment=Start the llama.cpp server and switch Everyday / Power models
Exec=$BIN/leslie-server
Icon=leslie
Terminal=true
Categories=Utility;
EOF
update-desktop-database -q "$APPS" 2>/dev/null || true

echo "→ systemd user services"
cat > "$UNITS/leslie.service" <<EOF
[Unit]
Description=LESLIE desktop companion
PartOf=graphical-session.target
# The voice window opens the mic at startup, so wait for PipeWire to be up.
After=graphical-session.target llama-router.service pipewire.service pipewire-pulse.service wireplumber.service
Wants=llama-router.service pipewire.service wireplumber.service

[Service]
ExecStart=$DEST/leslie
Restart=on-failure
RestartSec=3
# SIGTERM only Electron's main process; it shuts its own helpers down. Signalling
# the whole cgroup kills the GPU/zygote processes first, and Chromium then aborts
# with "GPU process isn't usable" (SIGTRAP + core dump) on every stop.
KillMode=mixed
TimeoutStopSec=15

[Install]
WantedBy=graphical-session.target
EOF
systemctl --user daemon-reload
systemctl --user enable leslie.service
[ -e "$UNITS/llama-router.service" ] || bash "$ROOT/scripts/setup-llama-router.sh"
[ -e "$UNITS/leslie-vision.service" ] || bash "$ROOT/scripts/setup-vision.sh"

echo
echo "Installed. Both services start at login."
echo "  start now:      systemctl --user start llama-router leslie"
echo "  model server:   leslie-server   (or the 'LESLIE Model Server' launcher entry)"
echo "  logs:           journalctl --user -u leslie -u llama-router -f"

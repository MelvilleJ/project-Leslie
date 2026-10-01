#!/usr/bin/env bash
# Install the built app for this user (no root): ~/.local/opt/leslie, launcher
# entries, icons, and two systemd user services that start at login:
#   leslie-llama.service  llama.cpp router; loads the Everyday model
#   leslie.service        the LESLIE desktop app
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
StartupWMClass=LESLIE
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

# The installed app has no source checkout next to it; share the repo's .env.
if [ -f "$ROOT/.env" ] && [ ! -e "$CONF/.env" ]; then
  echo "→ linking $CONF/.env → $ROOT/.env"
  ln -s "$ROOT/.env" "$CONF/.env"
fi

echo "→ systemd user services"
cat > "$UNITS/leslie.service" <<EOF
[Unit]
Description=LESLIE desktop companion
PartOf=graphical-session.target
After=graphical-session.target leslie-llama.service
Wants=leslie-llama.service

[Service]
ExecStart=$DEST/leslie
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical-session.target
EOF
systemctl --user daemon-reload
"$BIN/leslie-server" enable
systemctl --user enable leslie.service

echo
echo "Installed. Both services start at login."
echo "  start now:      systemctl --user start leslie-llama leslie"
echo "  model server:   leslie-server   (or the 'LESLIE Model Server' launcher entry)"
echo "  logs:           journalctl --user -u leslie -u leslie-llama -f"

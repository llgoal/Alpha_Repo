#!/bin/bash
# Installs the ScoreLens recognition server (homr) on a Mac and keeps it
# running in the background, also after a restart.
#
#   bash music-sheet-player/server/install-mac.sh
#
# Run it again after pulling new code to restart the server.
set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.scorelens"
VENV="$STATE/venv"
PORT="${PORT:-8765}"
PLIST="$HOME/Library/LaunchAgents/com.scorelens.server.plist"
mkdir -p "$STATE" "$HOME/Library/LaunchAgents"

# 1. Python 3.11 or newer (macOS's own python3 is too old).
PY=""
for c in python3.13 python3.12 python3.11 /opt/homebrew/bin/python3 /usr/local/bin/python3 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if (3,11) <= sys.version_info[:2] < (3,16) else 1)' 2>/dev/null; then PY="$(command -v "$c")"; break; fi
done
if [ -z "$PY" ]; then
  echo "Python 3.11+ is needed. Install Homebrew (https://brew.sh), then run:"
  echo "    brew install python@3.12"
  echo "and run this script again."
  exit 1
fi
echo "Using $PY ($("$PY" --version))"

# 2. homr and its models (about 300 MB).
if [ ! -x "$VENV/bin/python" ]; then "$PY" -m venv "$VENV"; fi
"$VENV/bin/pip" install --upgrade --quiet pip
"$VENV/bin/pip" install --quiet "homr[cpu]==0.7.1"
echo "Downloading the homr models (first time only)…"
"$VENV/bin/homr" --init >/dev/null

# 3. Start now and at every login.
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.scorelens.server</string>
  <key>ProgramArguments</key><array>
    <string>$VENV/bin/python</string><string>$APP/server/server.py</string><string>--port</string><string>$PORT</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$VENV/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$STATE/server.log</string>
  <key>StandardErrorPath</key><string>$STATE/server.log</string>
</dict></plist>
PL
SVC="gui/$(id -u)/com.scorelens.server"
if launchctl print "$SVC" >/dev/null 2>&1; then
  # Already installed: restart it with the new code.
  launchctl bootout "$SVC" 2>/dev/null || true
  # bootout finishes in the background; wait until the old one is gone.
  for i in $(seq 1 20); do launchctl print "$SVC" >/dev/null 2>&1 || break; sleep 0.5; done
fi
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  launchctl kickstart -k "$SVC" 2>/dev/null || { echo "Could not start the server with launchctl. Try: launchctl kickstart -k $SVC"; exit 1; }
fi

for i in $(seq 1 30); do
  if [ -f "$STATE/key" ] && curl -s -o /dev/null "http://localhost:$PORT/"; then break; fi
  sleep 1
done
KEY="$(cat "$STATE/key" 2>/dev/null || true)"
if [ -z "$KEY" ]; then echo "The server did not start. See $STATE/server.log"; exit 1; fi
HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s).local"

echo
echo "ScoreLens server is running."
echo "  On this Mac:            http://localhost:$PORT/#key=$KEY"
echo "  On your home Wi-Fi:     http://$HOST:$PORT/#key=$KEY"
echo "Open one of these once on each phone or computer; it remembers the key."
if command -v tailscale >/dev/null 2>&1; then
  echo
  echo "To reach it from anywhere (Tailscale is installed):"
  echo "    tailscale funnel --bg $PORT"
  echo "then open  https://<this-mac>.<your-tailnet>.ts.net/#key=$KEY"
fi
echo "Logs: $STATE/server.log"

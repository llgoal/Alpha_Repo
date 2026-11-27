#!/bin/bash
# Installs the Frame Studio server on a Mac and keeps it running in the
# background, also after a restart.
#
#   brew install ffmpeg deno
#   bash frame-player/server/install-mac.sh
#
# To update: git pull, then run it again (it restarts the server and
# updates yt-dlp, which YouTube changes often make necessary).
set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.framestudio"
VENV="$STATE/venv"
PORT="${PORT:-8766}"
PLIST="$HOME/Library/LaunchAgents/com.framestudio.server.plist"
mkdir -p "$STATE" "$HOME/Library/LaunchAgents"
BREW_BIN=/opt/homebrew/bin
[ -d "$BREW_BIN" ] || BREW_BIN=/usr/local/bin
export PATH="$BREW_BIN:$PATH"

# 1. ffmpeg (frames and audio) and deno (yt-dlp needs it for YouTube).
missing=""
command -v ffmpeg >/dev/null 2>&1 || missing="$missing ffmpeg"
command -v deno >/dev/null 2>&1 || missing="$missing deno"
if [ -n "$missing" ]; then
  echo "Missing:$missing. Install Homebrew (https://brew.sh) if needed, then run:"
  echo "    brew install$missing"
  echo "and run this script again."
  exit 1
fi

# 2. Python 3.10 or newer (macOS's own python3 is too old for yt-dlp).
PY=""
for c in python3.13 python3.12 python3.11 python3.10 "$BREW_BIN/python3" python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3,10) else 1)' 2>/dev/null; then PY="$(command -v "$c")"; break; fi
done
if [ -z "$PY" ]; then
  echo "Python 3.10+ is needed:  brew install python@3.12  and run this script again."
  exit 1
fi
echo "Using $PY ($("$PY" --version))"

# 3. yt-dlp, always the newest.
if [ ! -x "$VENV/bin/python" ]; then "$PY" -m venv "$VENV"; fi
"$VENV/bin/pip" install --upgrade --quiet pip
"$VENV/bin/pip" install --upgrade --quiet "yt-dlp[default]"
echo "yt-dlp $("$VENV/bin/yt-dlp" --version)"

# 4. Start now and at every login.
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.framestudio.server</string>
  <key>ProgramArguments</key><array>
    <string>$VENV/bin/python</string><string>$APP/server/server.py</string><string>--port</string><string>$PORT</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$VENV/bin:$BREW_BIN:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$STATE/server.log</string>
  <key>StandardErrorPath</key><string>$STATE/server.log</string>
</dict></plist>
PL
SVC="gui/$(id -u)/com.framestudio.server"
if launchctl print "$SVC" >/dev/null 2>&1; then
  launchctl bootout "$SVC" 2>/dev/null || true
  for i in $(seq 1 20); do launchctl print "$SVC" >/dev/null 2>&1 || break; sleep 0.5; done
fi
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  launchctl kickstart -k "$SVC" 2>/dev/null || { echo "Could not start the server. Try: launchctl kickstart -k $SVC"; exit 1; }
fi

for i in $(seq 1 30); do
  if [ -f "$STATE/key" ] && curl -s -o /dev/null "http://localhost:$PORT/"; then break; fi
  sleep 1
done
KEY="$(cat "$STATE/key" 2>/dev/null || true)"
if [ -z "$KEY" ]; then echo "The server did not start. See $STATE/server.log"; exit 1; fi
HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s).local"

echo
echo "Frame Studio is running. Videos are kept in $STATE/videos"
echo "  On this Mac:            http://localhost:$PORT/#key=$KEY"
echo "  On your home Wi-Fi:     http://$HOST:$PORT/#key=$KEY"
PIN="$(cat "$STATE/pin" 2>/dev/null || true)"
echo "Open one of these once on each phone or computer; it remembers the key."
echo "Or open the page without the key and type this 8-digit PIN (handy in the car):  $PIN"
TS=""
command -v tailscale >/dev/null 2>&1 && TS=tailscale
[ -z "$TS" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
if [ -n "$TS" ]; then
  echo
  echo "To reach it from anywhere (port 443 is already used by the music reader):"
  echo "    $TS funnel --bg --https=8443 $PORT"
  echo "then open  https://<this-mac>.<your-tailnet>.ts.net:8443/#key=$KEY"
fi
echo "Logs: $STATE/server.log"

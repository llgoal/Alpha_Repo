#!/bin/bash
# Run every few minutes by the com.scorelens.update LaunchAgent (set up by
# install-mac.sh). Pulls new code for this checkout's branch; when the
# server's own files changed, reinstalls and restarts the server. The app's
# pages are served straight from the checkout, so they need no restart.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

APP="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(git -C "$APP" rev-parse --show-toplevel)" || exit 0
cd "$REPO"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" || { log "no upstream branch; nothing to do"; exit 0; }
git fetch --quiet "${UPSTREAM%%/*}" || { log "fetch failed"; exit 0; }
OLD="$(git rev-parse HEAD)"; NEW="$(git rev-parse "$UPSTREAM")"
[ "$OLD" = "$NEW" ] && exit 0
# Only a fast-forward: local edits or local commits are never overwritten.
if ! git merge --ff-only --quiet "$UPSTREAM"; then log "cannot fast-forward to $UPSTREAM (local changes?); skipped"; exit 0; fi
log "updated $(git rev-parse --short "$OLD") -> $(git rev-parse --short "$NEW")"
if git diff --name-only "$OLD" "$NEW" | grep -q '^music-sheet-player/server/'; then
  log "server changed: reinstalling"
  SCORELENS_FROM_UPDATE=1 bash "$APP/server/install-mac.sh" >/dev/null 2>&1 && log "server restarted" || log "reinstall failed; see ~/.scorelens/server.log"
fi

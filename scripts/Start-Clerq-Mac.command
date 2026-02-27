#!/bin/bash
# Double-click to start Clerq: gateway in background, then desktop app.
# Place this script in clerq/scripts/ and run from Finder (or from terminal).
# Requires: Node, pnpm. First time: Right-click → Open to allow unsigned script.

set -e
CLERQ_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$CLERQ_ROOT"

# Start gateway in background (port 18790)
if command -v pnpm >/dev/null 2>&1; then
  pnpm gateway &
else
  node packages/gateway/dist/cli.js &
fi
GWPID=$!
echo "Gateway starting (PID $GWPID)..."

# Give gateway a moment to bind
sleep 2

# Open desktop app: prefer built .app, else dev
APP="$CLERQ_ROOT/apps/desktop/src-tauri/target/release/bundle/macos/Clerq.app"
if [ -d "$APP" ]; then
  open "$APP"
  echo "Opened Clerq app."
else
  echo "No built app at $APP — running in dev mode."
  (cd apps/desktop && pnpm exec tauri dev)
  kill $GWPID 2>/dev/null || true
  exit 0
fi

# Leave gateway running; user can close terminal or leave it open
echo "Gateway is running. Close this window to stop the gateway (and use the app until then)."
wait $GWPID 2>/dev/null || true

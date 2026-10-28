#!/bin/bash
set -euo pipefail

PORT="${PORT:-${U_CHAN_CDP_PORT:-9222}}"

# Check if CDP port is already open
if nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1 || curl -s "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "Port $PORT already open; Chrome is already running with remote debugging."
  exit 0
fi

# Resolve Chrome binary
CANDIDATE_1="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CANDIDATE_2="$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [ -f "$CANDIDATE_1" ]; then
  CHROME_BIN="$CANDIDATE_1"
elif [ -f "$CANDIDATE_2" ]; then
  CHROME_BIN="$CANDIDATE_2"
else
  echo "Error: Google Chrome binary not found in /Applications or $HOME/Applications" >&2
  exit 1
fi

PROFILE_DIR="${U_CHAN_HOME:-$HOME/Library/Application Support/u-chan-secrets}/chrome-profile"
mkdir -p "$PROFILE_DIR"

exec "$CHROME_BIN" \
  "--remote-debugging-port=${PORT}" \
  --remote-debugging-address=127.0.0.1 \
  "--user-data-dir=${PROFILE_DIR}" \
  --no-first-run

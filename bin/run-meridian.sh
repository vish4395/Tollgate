#!/bin/zsh
# Starts Meridian bound to localhost only; the key proxy is the only public entry point.
set -e
GW="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(dirname "$(cat "$GW/.node-path")")"
export PATH="$NODE_BIN:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
export MERIDIAN_HOST=127.0.0.1
export MERIDIAN_PORT=4101
export MERIDIAN_API_KEY="$(cat "$GW/.internal-key")"
export MERIDIAN_PASSTHROUGH=1
export MERIDIAN_MAX_CONCURRENT=2
export MERIDIAN_NO_UPDATE_CHECK=1
export MERIDIAN_WORKDIR="$GW/work"
export MERIDIAN_TELEMETRY_PERSIST=1
export MERIDIAN_TELEMETRY_DB="$GW/data/meridian-telemetry.db"
export MERIDIAN_TELEMETRY_RETENTION_DAYS=7
mkdir -p "$GW/work" "$GW/data"

# The gateway's own Claude CLI home: its sessions, cache and settings never mix with yours.
# It signs in with its own long-lived token (bin/login.sh). Without a token it falls back to
# your normal sign-in in ~/.claude so it keeps working.
if [ -s "$GW/.oauth-token" ]; then
  export CLAUDE_CONFIG_DIR="$GW/claude-home"
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$GW/.oauth-token")"
  mkdir -p "$CLAUDE_CONFIG_DIR"
  # Keep transcripts short-lived and skip anything interactive.
  [ -f "$CLAUDE_CONFIG_DIR/settings.json" ] || echo '{ "cleanupPeriodDays": 7, "autoUpdates": false }' > "$CLAUDE_CONFIG_DIR/settings.json"
  echo "Using the gateway's own Claude home: $CLAUDE_CONFIG_DIR"
else
  echo "No .oauth-token yet: using the shared ~/.claude sign-in. Run bin/login.sh to separate it."
fi
exec "$NODE_BIN/node" "$GW/meridian/node_modules/@rynfar/meridian/dist/cli.js"

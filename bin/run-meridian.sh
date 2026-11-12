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
exec "$NODE_BIN/node" "$GW/meridian/node_modules/@rynfar/meridian/dist/cli.js"

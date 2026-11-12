#!/bin/zsh
# Starts the per-project key proxy and dashboard on 0.0.0.0:4100.
set -e
GW="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(cat "$GW/.node-path")"
cd "$GW"
exec "$NODE" --disable-warning=ExperimentalWarning --max-old-space-size=64 proxy/server.mjs "$@"

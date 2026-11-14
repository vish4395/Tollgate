#!/bin/sh
# macOS / Linux: install and start the gateway (see README).
cd "$(dirname "$0")" && exec node proxy/cli.mjs install "$@"

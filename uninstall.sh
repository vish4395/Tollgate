#!/bin/sh
cd "$(dirname "$0")" && exec node proxy/cli.mjs uninstall "$@"

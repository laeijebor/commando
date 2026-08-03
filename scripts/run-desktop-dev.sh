#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export COMMANDO_PORT="${COMMANDO_PORT:-4310}"
export COMMANDO_TOKEN="${COMMANDO_TOKEN:-commando-desktop-local}"

cd "$root"
exec npx concurrently -k -n daemon,web,swift -c green,cyan,magenta \
    "tsx watch server/index.ts" \
    "vite" \
    "bash scripts/run-desktop-dev-app.sh"

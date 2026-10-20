#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export COMMANDO_PORT="${COMMANDO_PORT:-4310}"
export COMMANDO_TOKEN="${COMMANDO_TOKEN:-commando-desktop-local}"
# Let paired phones reach the daemon over Tailscale whenever this Mac is on a
# tailnet (a 100.64.0.0/10 address). The daemon refuses to start with the flag
# on and no Tailscale interface, so it is only switched on automatically when
# one is up; set COMMANDO_TAILSCALE yourself to force it either way.
if [[ -z "${COMMANDO_TAILSCALE:-}" ]] && ifconfig 2>/dev/null | grep -qE 'inet 100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.'; then
  export COMMANDO_TAILSCALE=true
fi

cd "$root"
exec npx concurrently -k -n daemon,web,swift -c green,cyan,magenta \
    "tsx watch server/index.ts" \
    "vite" \
    "bash scripts/run-desktop-dev-app.sh"

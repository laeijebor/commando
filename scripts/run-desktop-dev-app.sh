#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port="${COMMANDO_PORT:-4310}"
token="${COMMANDO_TOKEN:-commando-desktop-local}"
encoded_token="$(COMMANDO_TOKEN_TO_ENCODE="$token" node -e 'process.stdout.write(encodeURIComponent(process.env.COMMANDO_TOKEN_TO_ENCODE ?? ""))')"
desktop_url="${COMMANDO_DESKTOP_URL:-http://127.0.0.1:5173/#token=$encoded_token}"
app="$root/apps/desktop/.build/Commando Dev.app"
instance="commando-desktop-dev-$(uuidgen)"
pid=""
launch_requested=false

COMMANDO_DESKTOP_BUILD_MODE=development \
bash "$root/scripts/build-desktop-app.sh"

find_instance_pid() {
    local match
    match="$(pgrep -f -- "--commando-dev-instance=$instance" || true)"
    if [[ "$match" =~ ^[0-9]+$ ]]; then
        printf '%s' "$match"
    fi
    return 0
}

clean_up() {
    local exit_code="$1"
    trap - EXIT INT TERM
    if [[ -z "$pid" && "$launch_requested" == true ]]; then
        for _ in {1..20}; do
            pid="$(find_instance_pid)"
            [[ -n "$pid" ]] && break
            sleep 0.1
        done
    fi
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        for _ in {1..20}; do
            kill -0 "$pid" 2>/dev/null || exit "$exit_code"
            sleep 0.1
        done
        kill -KILL "$pid" 2>/dev/null || true
    fi
    exit "$exit_code"
}

trap 'clean_up $?' EXIT
trap 'clean_up 130' INT
trap 'clean_up 143' TERM
launch_requested=true
open -n -F "$app" \
    --env "COMMANDO_PORT=$port" \
    --env "COMMANDO_DESKTOP_URL=$desktop_url" \
    --args "--commando-dev-instance=$instance"

for _ in {1..100}; do
    pid="$(find_instance_pid)"
    [[ -n "$pid" ]] && break
    sleep 0.1
done
if [[ -z "$pid" ]]; then
    printf 'Commando development app did not start\n' >&2
    exit 1
fi

while kill -0 "$pid" 2>/dev/null; do
    sleep 0.25
done
pid=""
launch_requested=false

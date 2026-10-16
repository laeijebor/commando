#!/usr/bin/env bash
# Run Commando day to day as a Release build: a launchd agent keeps a production
# daemon serving the built web UI, the Release desktop app lives in
# /Applications, and a Desktop "Rebuild Commando" icon rebuilds both from this
# checkout.
#
#   desktop-release.sh install  build and install everything, then start it
#   desktop-release.sh rebuild  rebuild from this checkout, restart the daemon, relaunch the app
#   desktop-release.sh start    start the daemon agent and open the app
#   desktop-release.sh stop     quit the app and unload the daemon agent (e.g. before npm run desktop:dev)
#   desktop-release.sh daemon   run the production daemon in the foreground (what the agent executes)

set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
root="$(cd "$(dirname "$script")/.." && pwd)"
label="${COMMANDO_RELEASE_LABEL:-dev.commando.daemon}"
state_dir="${COMMANDO_RELEASE_STATE_DIR:-$HOME/.commando}"
env_file="${COMMANDO_RELEASE_ENV_FILE:-$state_dir/desktop-release.env}"
log_dir="$state_dir/logs"
install_dir="${COMMANDO_DESKTOP_INSTALL_DIR:-/Applications}"
icon_dir="${COMMANDO_RELEASE_ICON_DIR:-$HOME/Desktop}"
app="$install_dir/Commando.app"
rebuild_icon="$icon_dir/Rebuild Commando.app"
agent_plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

log() { printf '[desktop-release] %s\n' "$*"; }
fail() { printf '[desktop-release] %s\n' "$*" >&2; exit 1; }

notify() {
    osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "Commando"' -e 'end run' "$1" >/dev/null 2>&1 || true
}

# The env file is the daemon's configuration: it is created once, seeded from
# the caller's COMMANDO_PORT/COMMANDO_TOKEN so agents already running in panes
# keep a token the daemon accepts, and may gain any other daemon variables.
ensure_env_file() {
    [[ -f "$env_file" ]] && return 0
    local token="${COMMANDO_TOKEN:-$(openssl rand -hex 24)}"
    mkdir -p "$(dirname "$env_file")"
    (umask 077 && printf 'COMMANDO_PORT=%s\nCOMMANDO_TOKEN=%s\n' "${COMMANDO_PORT:-4310}" "$token" >"$env_file")
    log "Created $env_file"
}

load_env() {
    [[ -f "$env_file" ]] || fail "Missing $env_file; run: $script install"
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
    port="${COMMANDO_PORT:-4310}"
    [[ -n "${COMMANDO_TOKEN:-}" ]] || fail "COMMANDO_TOKEN is not set in $env_file"
}

# Build into a staging directory and swap it in, so a failed build never
# leaves the running daemon without a UI.
build_web() {
    local staging="$root/.dist-staging"
    log "Building the web UI"
    (cd "$root" && node_modules/.bin/tsc -b && node_modules/.bin/vite build --outDir "$staging" --emptyOutDir)
    rm -rf "$root/dist.previous"
    [[ -d "$root/dist" ]] && mv "$root/dist" "$root/dist.previous"
    mv "$staging" "$root/dist"
    rm -rf "$root/dist.previous"
}

app_pid() {
    pgrep -f -- "^$app/Contents/MacOS/CommandoDesktop" | head -1 || true
}

quit_app() {
    local pid
    pid="$(app_pid)"
    [[ -n "$pid" ]] || return 0
    osascript -e 'on run argv' -e 'tell application (item 1 of argv) to quit' -e 'end run' "$app" >/dev/null 2>&1 || true
    for _ in {1..50}; do
        kill -0 "$pid" 2>/dev/null || return 0
        sleep 0.2
    done
    kill "$pid" 2>/dev/null || true
}

# The app gets no shell environment when opened from Finder or the Dock, so the
# daemon URL and token go into its Info.plist as LSEnvironment.
build_app() {
    log "Building the Release desktop app"
    COMMANDO_DESKTOP_BUILD_MODE=release bash "$root/scripts/build-desktop-app.sh"
    local staged="$root/dist/Commando.app"
    local launch_env
    launch_env="$(COMMANDO_PORT="$port" node -e '
        const port = process.env.COMMANDO_PORT
        const token = encodeURIComponent(process.env.COMMANDO_TOKEN)
        process.stdout.write(JSON.stringify({
            COMMANDO_PORT: port,
            COMMANDO_DESKTOP_URL: `http://127.0.0.1:${port}/#token=${token}`,
        }))')"
    plutil -replace LSEnvironment -json "$launch_env" "$staged/Contents/Info.plist"
    local identity="${COMMANDO_CODESIGN_IDENTITY:--}"
    if [[ "$identity" == "-" ]]; then
        codesign --force --deep --sign - --timestamp=none "$staged"
    else
        codesign --force --deep --sign "$identity" "$staged"
    fi

    quit_app
    mkdir -p "$install_dir"
    rm -rf "$app"
    cp -R "$staged" "$app"
    "$lsregister" -f "$app" >/dev/null 2>&1 || true
    log "Installed $app"
}

write_agent() {
    mkdir -p "$log_dir" "$(dirname "$agent_plist")"
    # A login, interactive zsh gives the daemon (and the agents it launches) the
    # same PATH and environment as a terminal.
    cat >"$agent_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>-lic</string>
        <string>exec "\$0" daemon</string>
        <string>$script</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>COMMANDO_RELEASE_ENV_FILE</key>
        <string>$env_file</string>
        <key>COMMANDO_RELEASE_STATE_DIR</key>
        <string>$state_dir</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>$log_dir/daemon-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>$log_dir/daemon-launchd.log</string>
</dict>
</plist>
PLIST
    plutil -lint "$agent_plist" >/dev/null
}

agent_loaded() {
    launchctl print "$domain/$label" >/dev/null 2>&1
}

wait_for_daemon() {
    for _ in {1..120}; do
        [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/")" == 200 ]] && return 0
        sleep 0.5
    done
    fail "The daemon did not answer on port $port; see $log_dir/daemon.log"
}

ensure_port_free() {
    local listener
    listener="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
    [[ -z "$listener" ]] || fail "Port $port is already in use (pid $listener). Stop npm run desktop:dev first."
}

restart_daemon() {
    if agent_loaded; then
        log "Restarting the daemon"
        launchctl kickstart -k "$domain/$label"
    else
        ensure_port_free
        [[ -f "$agent_plist" ]] || fail "Missing $agent_plist; run: $script install"
        log "Starting the daemon agent"
        launchctl bootstrap "$domain" "$agent_plist"
    fi
    wait_for_daemon
}

make_rebuild_icon() {
    mkdir -p "$icon_dir"
    rm -rf "$rebuild_icon"
    local command="nohup '$script' rebuild >/dev/null 2>&1 &"
    osacompile -o "$rebuild_icon" -e "do shell script \"/bin/zsh -lic \" & quoted form of \"$command\""
    log "Created $rebuild_icon"
}

rebuild_lock="$state_dir/desktop-release.lock"
rebuild_log="$log_dir/rebuild.log"

finish_rebuild() {
    local status=$?
    rmdir "$rebuild_lock" 2>/dev/null || true
    (( status == 0 )) || notify "Rebuild failed. Log: $rebuild_log"
}

rebuild() {
    mkdir -p "$log_dir"
    mkdir "$rebuild_lock" 2>/dev/null || fail "A rebuild is already running (remove $rebuild_lock if it is stale)"
    trap finish_rebuild EXIT
    exec > >(tee "$rebuild_log") 2>&1

    local revision
    revision="$(git -C "$root" log -1 --format='%h %s')"
    log "Rebuilding from $root at $revision"
    notify "Rebuilding from ${revision%% *}…"
    load_env
    agent_loaded || ensure_port_free
    build_web
    build_app
    restart_daemon
    open "$app"
    notify "Rebuilt ${revision%% *} and relaunched"
    log "Done"
}

run_daemon() {
    load_env
    mkdir -p "$log_dir"
    local log_file="$log_dir/daemon.log"
    if [[ -f "$log_file" ]] && (( $(stat -f %z "$log_file") > 20 * 1024 * 1024 )); then
        mv "$log_file" "$log_file.1"
    fi
    exec >>"$log_file" 2>&1
    printf '\n[desktop-release] %s starting daemon on port %s\n' "$(date '+%F %T')" "$port"
    cd "$root"
    [[ -f dist/index.html ]] || fail "No built web UI in $root/dist; run: $script rebuild"
    export NODE_ENV=production
    exec node_modules/.bin/tsx server/index.ts
}

case "${1:-}" in
    install)
        ensure_env_file
        write_agent
        make_rebuild_icon
        rebuild
        ;;
    rebuild) rebuild ;;
    start)
        load_env
        if agent_loaded; then wait_for_daemon; else restart_daemon; fi
        open "$app"
        ;;
    stop)
        quit_app
        if agent_loaded; then launchctl bootout "$domain/$label"; fi
        log "Stopped the release daemon and app"
        ;;
    daemon) run_daemon ;;
    *)
        sed -n '2,12p' "$script" | sed 's/^# \{0,1\}//'
        exit 2
        ;;
esac

#!/usr/bin/env bash
# Run Commando day to day as a Release build: a launchd agent keeps a production
# daemon serving the built web UI, the Release desktop app lives in
# /Applications, and a Desktop "Rebuild Commando" icon rebuilds both from this
# checkout.
#
#   desktop-release.sh install  build and install everything, then start it
#   desktop-release.sh rebuild  rebuild from this checkout, restart the daemon, relaunch the app
#   desktop-release.sh start    start the daemon agent and open the app
#   desktop-release.sh stop     quit the app and disable the daemon agent (e.g. before npm run desktop:dev)
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
service="gui/$(id -u)/$label"
rebuild_lock="$state_dir/desktop-release.lock"
rebuild_log="$log_dir/rebuild.log"
web_staging="$root/.dist-staging"
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
    # %q keeps the values literal when load_env sources the file.
    (umask 077 && printf 'COMMANDO_PORT=%q\nCOMMANDO_TOKEN=%q\n' "${COMMANDO_PORT:-4310}" "$token" >"$env_file")
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

# The agent and the Rebuild icon point at this checkout, so it must outlive
# them: a worktree is normally removed once its branch merges.
require_main_checkout() {
    [[ "$(git -C "$root" rev-parse --git-dir)" == "$(git -C "$root" rev-parse --git-common-dir)" ]] && return 0
    [[ -n "${COMMANDO_RELEASE_ALLOW_WORKTREE:-}" ]] && return 0
    fail "$root is a git worktree; run this from the main checkout, which the agent and Rebuild icon use"
}

agent_pid() {
    launchctl print "$service" 2>/dev/null | awk '$1 == "pid" { print $3; exit }'
}

agent_loaded() {
    launchctl print "$service" >/dev/null 2>&1
}

unload_agent() {
    agent_loaded || return 0
    launchctl bootout "$service" 2>/dev/null || true
    for _ in {1..50}; do
        agent_loaded || return 0
        sleep 0.2
    done
    fail "Could not unload $service"
}

ensure_port_free() {
    local listener
    listener="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
    [[ -z "$listener" ]] || fail "Port $port is already in use (pid $listener). Stop npm run desktop:dev first."
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

build_web() {
    log "Building the web UI"
    (cd "$root" && node_modules/.bin/tsc -b && node_modules/.bin/vite build --outDir "$web_staging" --emptyOutDir)
}

# The app gets no shell environment when opened from Finder or the Dock, so the
# daemon URL and token go into its Info.plist as LSEnvironment. That happens on
# a private copy: dist/ is served over HTTP without authentication.
build_app() {
    log "Building the Release desktop app"
    COMMANDO_DESKTOP_BUILD_MODE=release bash "$root/scripts/build-desktop-app.sh"
    app_staging="$(mktemp -d)/Commando.app"
    mv "$root/dist/Commando.app" "$app_staging"
    chmod -R go-rwx "$(dirname "$app_staging")"
    local launch_env
    launch_env="$(COMMANDO_PORT="$port" node -e '
        const port = process.env.COMMANDO_PORT
        const token = encodeURIComponent(process.env.COMMANDO_TOKEN)
        process.stdout.write(JSON.stringify({
            COMMANDO_PORT: port,
            COMMANDO_DESKTOP_URL: `http://127.0.0.1:${port}/#token=${token}`,
        }))')"
    plutil -replace LSEnvironment -json "$launch_env" "$app_staging/Contents/Info.plist"
    local identity="${COMMANDO_CODESIGN_IDENTITY:--}"
    local sign_args=(--force --deep --sign "$identity")
    [[ "$identity" == "-" ]] && sign_args+=(--timestamp=none)
    codesign "${sign_args[@]}" "$app_staging"
}

# Everything is built before anything is swapped, and the swap is followed
# straight away by the daemon restart, so the running UI never sees web assets
# from a different build than the daemon serving them.
install_builds() {
    quit_app
    rm -rf "$root/dist"
    mv "$web_staging" "$root/dist"
    mkdir -p "$install_dir"
    rm -rf "$app"
    mv "$app_staging" "$app"
    rmdir "$(dirname "$app_staging")"
    "$lsregister" -f "$app" >/dev/null 2>&1 || true
    log "Installed $app"
}

xml_escape() {
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# Renders and lints the agent into $agent_plist.new, so a bad plist fails before
# the running agent is unloaded.
write_agent() {
    mkdir -p "$log_dir" "$(dirname "$agent_plist")"
    local label_xml script_xml env_file_xml state_dir_xml launchd_log_xml
    label_xml="$(xml_escape "$label")"
    script_xml="$(xml_escape "$script")"
    env_file_xml="$(xml_escape "$env_file")"
    state_dir_xml="$(xml_escape "$state_dir")"
    launchd_log_xml="$(xml_escape "$log_dir/daemon-launchd.log")"
    # A login, interactive zsh gives the daemon (and the agents it launches) the
    # same PATH and environment as a terminal. Without ProcessType launchd
    # applies background CPU and I/O limits.
    cat >"$agent_plist.new" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label_xml</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>-lic</string>
        <string>exec "\$0" daemon</string>
        <string>$script_xml</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>COMMANDO_RELEASE_ENV_FILE</key>
        <string>$env_file_xml</string>
        <key>COMMANDO_RELEASE_STATE_DIR</key>
        <string>$state_dir_xml</string>
    </dict>
    <key>ProcessType</key>
    <string>Interactive</string>
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
    <string>$launchd_log_xml</string>
    <key>StandardErrorPath</key>
    <string>$launchd_log_xml</string>
</dict>
</plist>
PLIST
    plutil -lint "$agent_plist.new" >/dev/null || { rm -f "$agent_plist.new"; fail "Generated an invalid $agent_plist"; }
}

# Wait for a process other than the one that was running before: the old
# daemon keeps answering while it shuts down.
wait_for_daemon() {
    local previous_pid="${1:-}" pid
    for _ in {1..120}; do
        pid="$(agent_pid)"
        if [[ -n "$pid" && "$pid" != "$previous_pid" ]] &&
            [[ "$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/" || true)" == 200 ]]; then
            return 0
        fi
        sleep 0.5
    done
    fail "The daemon did not come up on port $port; see $log_dir/daemon.log"
}

restart_daemon() {
    [[ -f "$agent_plist" ]] || fail "Missing $agent_plist; run: $script install"
    launchctl enable "$service"
    if agent_loaded; then
        local previous_pid
        previous_pid="$(agent_pid)"
        log "Restarting the daemon"
        launchctl kickstart -k "$service"
        wait_for_daemon "$previous_pid"
    else
        ensure_port_free
        log "Starting the daemon agent"
        launchctl bootstrap "gui/$(id -u)" "$agent_plist"
        wait_for_daemon
    fi
}

make_rebuild_icon() {
    mkdir -p "$icon_dir"
    rm -rf "$rebuild_icon"
    local command="nohup '$script' rebuild >/dev/null 2>&1 &"
    osacompile -o "$rebuild_icon" -e "do shell script \"/bin/zsh -lic \" & quoted form of \"$command\""
    log "Created $rebuild_icon"
}

# A kernel flock on fd 9: it is atomic, and it is released when this shell exits
# or dies, so a crashed rebuild never leaves a stale lock behind.
take_rebuild_lock() {
    mkdir -p "$log_dir" "$(dirname "$rebuild_lock")"
    exec 9>>"$rebuild_lock"
    local held=0
    /usr/bin/perl -MFcntl=:flock -e 'open(my $fh, ">&=", 9) or exit 2; flock($fh, LOCK_EX | LOCK_NB) or exit 1' || held=$?
    if (( held == 1 )); then
        notify "A rebuild is already running"
        fail "A rebuild is already running (pid $(cat "$rebuild_lock" 2>/dev/null))"
    fi
    (( held == 0 )) || fail "Could not lock $rebuild_lock (perl exited $held)"
    printf '%s\n' $$ >"$rebuild_lock"
    trap finish_rebuild EXIT
}

finish_rebuild() {
    local status=$?
    (( status == 0 )) || notify "Rebuild failed. Log: $rebuild_log"
}

# install also (re)writes the agent once the builds succeed, so a failed first
# install leaves no agent behind to restart at every login.
rebuild() {
    local installing="${1:-}"
    take_rebuild_lock
    exec > >(tee "$rebuild_log") 2>&1

    local revision
    revision="$(git -C "$root" log -1 --format='%h %s')"
    log "Rebuilding from $root at $revision"
    notify "Rebuilding from ${revision%% *}…"
    load_env
    agent_loaded || ensure_port_free
    build_web
    build_app
    install_builds
    if [[ -n "$installing" ]]; then
        write_agent
        unload_agent
        mv -f "$agent_plist.new" "$agent_plist"
        make_rebuild_icon
    fi
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
        require_main_checkout
        ensure_env_file
        rebuild installing
        ;;
    rebuild)
        # The agent serves the main checkout, so a worktree rebuild would mix builds.
        require_main_checkout
        rebuild
        ;;
    start)
        load_env
        if agent_loaded; then wait_for_daemon; else restart_daemon; fi
        open "$app"
        ;;
    stop)
        quit_app
        # Disabling persists across logins, so the agent stays off until start.
        launchctl disable "$service"
        unload_agent
        log "Stopped the release daemon and app"
        ;;
    daemon) run_daemon ;;
    *)
        sed -n '2,12p' "$script" | sed 's/^# \{0,1\}//'
        exit 2
        ;;
esac

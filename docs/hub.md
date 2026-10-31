# Set up a Commando hub

A hub is a second Mac that stays available over your Tailscale tailnet and runs
Commando's daemon and agents while your main MacBook is closed. Setup installs
user login items, not a boot service: log into the hub after a restart (including
unlocking FileVault), and leave that account logged in. Logging out stops them.

## Prerequisites

- macOS, Node 20.19+ on the Node 20 line or Node 22.12+, tmux, git, and GitHub CLI
  authenticated with `gh auth login`.
- Tailscale running and connected to the same tailnet as your main MacBook, with
  the `tailscale` CLI on PATH and tailnet policy permitting access to port 4310
  (or your configured `COMMANDO_PORT`).
- A permanent Commando clone on the hub with dependencies already installed
  (`npm ci`). Use the main checkout, not a disposable worktree; the login item
  points at its `scripts/desktop-release.sh` and runs its production web build.
  Setup builds the web UI but installs no tools or dependencies.
- Agent CLIs on the login shell's PATH, with the accounts you want already
  authenticated. Setup reports `claude auth status --json` for every `~/.claude*`
  directory, `codex login status`, and Cursor's `agent status`. Missing/expired
  agent logins are warnings; setup never attempts login.
- An administrator account for the keep-awake installation. No sudo is needed
  when installing with `--no-keep-awake`.

## Run on the hub

```bash
scripts/hub-setup --dry-run
scripts/hub-setup
```

Dry-run performs read-only prerequisite/status checks, prints the planned file
contents and actions, and writes nothing. It does not build, load login items,
run sudo, or change sleep settings. Failed core prerequisites produce a complete
report and prevent installation.

Normal setup asks for sudo authentication once (`sudo -v`), validates a temporary
sudoers file with `visudo -cf`, and installs it as root with mode `0440`. It never
edits `/etc/sudoers`. The single rule is:

```sudoers
YOUR_USERNAME ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1
```

The installer uses your administrator privileges to install/remove that rule;
after installation it clears the cached sudo ticket (`sudo -k`) and checks both
exact commands with `sudo -n -l`. Setup stops if either check is refused. The
running watcher can elevate only those two exact commands. The Mac's sudo
configuration must include `/etc/sudoers.d` (the standard macOS configuration).

The watcher checks `pmset -g ps` immediately and every 30 seconds. On AC it sets
`sudo -n /usr/bin/pmset -a disablesleep 1`; on battery or an unreadable power
source it sets `0`. It changes the setting only when its observed state changes,
retries failed changes, and restores `0` on a normal stop. Power transitions can
take up to 30 seconds to be reflected. `disablesleep` is system-wide, so don't
run another tool that manages the same setting. A forced kill or power loss
cannot run a cleanup handler; uninstall explicitly restores `0` too.

Lid-closed laptops run warmer. Keep the hub on a desk with airflow, not inside a
bag. Use the power adapter if you want it awake with the lid shut.

To leave sleep management to macOS:

```bash
scripts/hub-setup --no-keep-awake
```

This skips keep-awake installation and sudo entirely. If a watcher was installed
earlier, it remains active: uninstall first, then reinstall with this flag to
remove it.

## Installed files and operation

| Path | Purpose |
| --- | --- |
| `~/Library/LaunchAgents/com.commando.hub.plist` | Daemon login item; restarts on failure, uses a login/interactive zsh PATH |
| `~/Library/LaunchAgents/com.commando.hub.keep-awake.plist` | Power watcher login item; restarts on failure |
| `~/.commando/hub.env` | Private (`0600`) shell config: port, persistent `COMMANDO_TOKEN`, `COMMANDO_TAILSCALE=1`, log directory |
| `~/.commando/hub-keep-awake.mjs` | Installed executable watcher, mode `0700` |
| `~/.commando/logs/hub/daemon.log` | Daemon output; rotates to `.1` at startup above 20 MiB |
| `~/.commando/logs/hub/daemon-launchd.log` | Login-item launcher output |
| `~/.commando/logs/hub-keep-awake/daemon-launchd.log` | Power changes and watcher errors |
| `/etc/sudoers.d/commando-hub-keep-awake` | The two-command rule above, owned by root, mode `0440` |
| Checkout `dist/`, `.dist-staging/`, `node_modules/.tmp/*.tsbuildinfo` | Production web build output/staging and compiler cache |

The daemon build, plist renderer, installation, restart and health check reuse
`scripts/desktop-release.sh`. Hub setup does not build or open the desktop app.
Its label and config are separate from the desktop release's
`dev.commando.daemon` and `desktop-release.env`. They still need different ports
if run simultaneously. Setup refuses to start a new daemon on an occupied port.

Rerun setup to rebuild and refresh the hub login items. The saved token and extra
settings in `hub.env` are preserved. `COMMANDO_PORT` and `COMMANDO_TOKEN` in the
setup environment seed the first installation only. Edit `hub.env` to change
them later. Setup always enables Tailscale and restores the hub log directory.
Dry-run masks values of variables whose names contain TOKEN, KEY, SECRET, or
PASSWORD, regardless of case or an `export` prefix.
You can also add `COMMANDO_OWNER_EMAIL` for the existing owner account flow.
Treat this file as trusted shell code, readable only by your account.

Setup prints the direct HTTP Tailscale IPv4 URL. Commando binds to loopback and
Tailscale interfaces, not every LAN interface. Tailscale encrypts the network
transport; Commando itself does not terminate HTTPS. MagicDNS HTTP or Tailscale
Serve requires the origin configuration described in
[Tailscale Access](../README.md#tailscale-access).

To read the owner/automation token on the hub:

```bash
bash -c 'source "$HOME/.commando/hub.env"; printf "%s\n" "$COMMANDO_TOKEN"'
```

Open `http://<hub-tailscale-ip>:4310/#token=<URL-encoded-token>` to authenticate.
Don't share that URL or token. In the authenticated sidebar, **Pair a phone**
creates a single-use QR code valid for two minutes. Scanning with the companion
gives the device its own revocable token, not the owner's token. The same dialog
lists and revokes paired devices; see [pairing](../README.md#pair-the-ios-companion).

## Connect from your MacBook

With Tailscale connected on your MacBook, open the printed hub URL in a browser
and authenticate using its token or configured owner account. This opens the
hub's own Commando instance. Multi-host UI and daemon-to-daemon proxy support
are coming in a separate change.

## Uninstall

Run from the same permanent checkout, as the same login user:

```bash
scripts/hub-setup --dry-run --uninstall
scripts/hub-setup --uninstall
```

Uninstall stops the watcher, explicitly restores `pmset -a disablesleep 0`, then
removes the sudoers drop-in, both login items, and the installed watcher. It needs sudo
even if keep-awake wasn't installed. It leaves the checkout, `hub.env`, logs,
sessions, and CLI credentials intact. It doesn't require Tailscale or working
agent logins. Builds or launch failures can leave a partial installation; fix
the reported problem and rerun, or uninstall. Nothing targets the desktop app's
LaunchAgent.

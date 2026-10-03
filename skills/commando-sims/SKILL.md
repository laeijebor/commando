---
name: commando-sims
description: Lease, adopt, label, and release iOS simulators for a Commando agent pane. Use before any iOS simulator work and when changing tasks or handing off a device for review.
---

# Commando simulator leases

Before using an iOS simulator, run this in your current agent pane:

```sh
$HOME/.commando/hooks/commando-sim.mjs lease --task "what you are doing" --metro 8101 --backend 3101
```

Use the returned JSON `udid` for all simulator work. A pane reuses its existing
lease. Commando chooses a free simulator from its own slim iPhone pool and grows
the pool when none are free. It boots it slim, verifies its slim status, and labels
it with the session name and task. Use `--device <udid>` only when the user names
a specific simulator; release an existing lease before switching devices.

Inspect the pool and its live device states with:

```sh
$HOME/.commando/hooks/commando-sim.mjs pool list
```

Pool management: `pool create [--count 1-8] [--device-type "iPhone name"]` creates
slim pool devices; `pool add <udid>...` slims and renames existing Shutdown iPhones
before adding them. `pool remove <udid>` removes membership only and refuses leased
devices. Pool names reuse the lowest free `Commando Pool <n>` number.

When the user asks to use a simulator that is already running, adopt that UDID:

```sh
$HOME/.commando/hooks/commando-sim.mjs adopt <udid> --task "what you are doing" --metro 8101 --backend 3101
```

Adopt requires a Booted iOS device and a pane without a lease. It claims and
labels the running device without rebooting, slimming, or verifying slim status;
an unslimmed adopted device is allowed. It accepts the same task, port and branch
metadata as lease. Otherwise always use `lease`.

Never boot a simulator another way. Never use an unslimmed simulator unless
adopting a running device at the user's request or the user explicitly asks for stock. If leasing fails, report the error and
resolve it before interacting with any device.

Keep driving the leased UDID with whatever tool the project uses, such as
Argent MCP. The CLI manages the lease and label; your project's tools manage
the app and its interactions.

Check ownership before driving a device:

```sh
$HOME/.commando/hooks/commando-sim.mjs list
```

Never drive a device held by another pane. Idle is only a flag; it does not
transfer ownership or permit taking someone else's device.

The list includes active and ended leases. Ended leases have no owner; the wall
keeps booted devices in their former group and under No lease until reclaimed.

Declare the ports you use at lease or adopt time: `--metro <port>` and `--backend <port>`
are shorthand for `--port metro=<port>` and `--port backend=<port>`. Add other
ports with repeatable `--port <name>=<port>` (at most six unique lowercase names).
Commando shows your purpose, live repository branch, and ports in Important terms.

Run `update` when the purpose, ports, or branch change. It requires an existing
lease and preserves fields you omit. Named ports replace matching names and keep
other ports; `--clear-ports` resets the list before adding supplied ports.
`--branch <name>` overrides the live pane branch.

```sh
$HOME/.commando/hooks/commando-sim.mjs update --task "checking empty state" --metro 8102
$HOME/.commando/hooks/commando-sim.mjs update --branch "feature/empty-state" --clear-ports --backend 3102
```

`label` still relabels the task, including when a result is ready for user review:

```sh
$HOME/.commando/hooks/commando-sim.mjs label "checking empty state"
$HOME/.commando/hooks/commando-sim.mjs label "ready: check empty state"
```

Keep the lease during review so the user can inspect the labelled device.
Release when done:

```sh
$HOME/.commando/hooks/commando-sim.mjs release
```

Release restores the original name and ends the lease. Normally it shuts down
the simulator; an adopted simulator stays running. If an adopted device stops
running, `lease` will not boot it implicitly: release, then lease again. If it fails, resolve the error and retry; do not assume ownership
has been cleared.

If the CLI is missing, tell the user to run `npm run hooks:install` in the
Commando repo, then retry leasing from the agent pane.

---
name: commando-sims
description: Lease, label, and release slim iOS simulators for a Commando agent pane. Use before any iOS simulator work and when changing tasks or handing off a device for review.
---

# Commando simulator leases

Before using an iOS simulator, run this in your current agent pane:

```sh
$HOME/.commando/hooks/commando-sim.mjs lease --task "what you are doing"
```

Use the returned JSON `udid` for all simulator work. A pane reuses its existing
lease. Commando chooses a free iPhone, boots it slim, verifies its slim status,
and labels it with the session name and task. To request a specific device,
add `--device <udid>`; release an existing lease before switching devices.

Never boot a simulator another way. Never use an unslimmed simulator unless
the user explicitly asks for stock. If leasing fails, report the error and
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

Relabel when the task changes, and when a result is ready for user review:

```sh
$HOME/.commando/hooks/commando-sim.mjs label "checking empty state"
$HOME/.commando/hooks/commando-sim.mjs label "ready: check empty state"
```

Keep the lease during review so the user can inspect the labelled device.
Release when done:

```sh
$HOME/.commando/hooks/commando-sim.mjs release
```

Release restores the original name, shuts down the simulator, and removes
its lease. If it fails, resolve the error and retry; do not assume ownership
has been cleared.

If the CLI is missing, tell the user to run `npm run hooks:install` in the
Commando repo, then retry leasing from the agent pane.

---
name: commando-devices
description: Take, wait for, claim and release Commando device locks on shared physical phones, the Android emulator and heavy Mac builds or exports. Use before touching a plugged-in device, booting or reconfiguring the shared emulator, profiling, or running xcodebuild / expo export / pod install / gradlew builds that a lock covers, and in scripts that do any of these.
---

# Commando device locks

Physical phones, the Android emulator and heavy Mac jobs are shared by every
agent on this machine. Commando keeps one queue per lock. Take the lock before
you touch the device, follow its release steps, and release it when done.

```sh
D="$HOME/.commando/hooks/commando-device.mjs"
node "$D" list                       # every lock, who holds it, who is waiting
node "$D" status                     # what this pane holds or waits for
```

## Agents

```sh
node "$D" lock pixel --as MASCOT --task "Rive round: cold launch x5" --estimate 25m
```

- Exit 0, `held …`: the device is yours. The output gives its serial and the
  release steps.
- Exit 3, `queued #N …`: someone else has it. **Do not touch the device.** Do
  other work or end your turn. Commando posts a message in this pane when it is
  your turn ("Pixel 5 is yours …").
- When that message arrives, claim within 5 minutes:
  `node "$D" claim pixel --as MASCOT`. If you miss it, the next task goes first
  and you stay queued; after three missed turns you leave the queue.
- When done, do the release steps the lock lists (restore the standard app, log
  start and finish, …), then `node "$D" release pixel --as MASCOT`.

Use `--as NAME` (your task name, e.g. MASCOT) so several agents or subagents in
one pane queue separately. Use the same name for claim and release.

Ask for `any-android`, `any-ios`, `any-phone` or `any` instead of a device
name when any matching device will do, for example to check that a new native
module loads. Name the device when results must be comparable (profiling).

`cancel [device]` leaves the queue. Running `lock` again is safe: you keep your
lock or your place.

## Scripts

Scripts block instead of being messaged. Tie the lock to the script's process
so it ends even if the script crashes:

```sh
D="$HOME/.commando/hooks/commando-device.mjs"
node "$D" lock pixel --as SWEEP --task "brightness sweep" --wait --pid $$ || exit 1
trap 'node "$D" release pixel --as SWEEP --pid $$' EXIT
```

`--wait 30m` gives up (exit 3) after 30 minutes. A script's `--pid` makes it a
separate owner from the agent that started it, so it waits even if that agent
holds the device.

The Mac builds lock (`heavy`) also waits while `xcodebuild`, `expo export`,
`pod install` or `gradlew` run outside the lock, so builds don't overlap.

## Setting up locks

```sh
node "$D" resource add pixel --name "Pixel 5" --kind android --serial 25121FDD4S00H7 --release "restore a2, log start and finish in NOTES.md"
node "$D" resource add heavy --name "Mac builds and exports" --kind host --busy xcodebuild --busy "expo export" --busy "pod install" --busy gradlew
node "$D" resource remove pixel
```

Kinds: `android`, `ios` (serial = CoreDevice identifier from
`xcrun devicectl list devices`), `emulator`, `host`. Only add or remove locks
when the user asks.

## Rules

- Never touch a device you do not hold, even if it looks idle.
- The user sees every holder and queue in Commando's Devices view and can
  reorder, pause, release or remove. If you are told your lock was released or
  your request removed, stop using the device.

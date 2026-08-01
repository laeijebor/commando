# Native terminal shell spike

This spike compares a direct Swift/AppKit shell with a Tauri 2 shell for a
future Commando UI where React owns the surrounding workspace and native
AppKit views render the visible terminal panes.

It deliberately uses an editable `NSTextView` instead of a terminal emulator.
The question answered here is whether each shell can compose, position, focus,
and occlude an arbitrary native view over a React-owned rectangle while Vite
keeps hot reloading. VT parsing and the live Commando pane protocol are the
next vertical slice.

## Shared contract

Both shells load the same Vite page from `ui/`. React renders the sidebar,
workspace, pane chrome, split controls, and a crosshatched terminal
placeholder. It sends one of these messages whenever layout changes:

```ts
type NativeTerminalMessage =
  | {
      kind: 'frame'
      x: number
      y: number
      width: number
      height: number
      visible: boolean
      scale: number
    }
  | { kind: 'focus' }
```

The rectangle is expressed in top-left CSS pixels. Each shell converts it to
AppKit coordinates and positions a sibling `NSScrollView` and `NSTextView`
above the `WKWebView`. The web overlay reports `visible: false`, because a
native sibling cannot participate in CSS stacking contexts.

## Run the Swift shell

Requirements: Swift 6 and macOS 14 or newer.

```bash
npm run spike:native-swift
```

The command starts Vite and the Swift executable together. Closing either
process stops the other.

Focused checks:

```bash
npm run spike:native-swift:test
```

## Run the Tauri shell

Requirements: Rust stable, Tauri's macOS prerequisites, and macOS 14 or newer.
With Homebrew's keg-only `rustup` formula:

```bash
brew install rustup
/opt/homebrew/opt/rustup/bin/rustup default stable
npm run spike:native-tauri
```

Tauri starts the same Vite page through `beforeDevCommand`.

Focused check:

```bash
npm run spike:native-tauri:check
```

## Findings

| Area | Swift/AppKit | Tauri 2 |
| --- | --- | --- |
| Native composition | Direct `WKWebView` plus native sibling views | Rust command plus an Objective-C AppKit shim attached to Tauri's `WKWebView` |
| Vite HMR | Preserved | Preserved |
| Initial geometry | Aligned directly | Initially shifted by the 28-point title-bar safe area; fixed by accounting for `WKWebView.safeAreaInsets` |
| Native focus/input | Direct first-responder control | Works through `run_on_main_thread` and the Objective-C shim |
| Web overlay | React explicitly hides the native sibling | Same explicit visibility bridge required |
| Automated coverage | Seven message and geometry tests | Rust compile checks; native behavior exercised in the running app |
| Cold release build on the spike machine | 10.42 seconds | 41.17 seconds after dependencies were fetched |
| Unbundled release executable | 148 KiB | 9.4 MiB |
| Framework leverage | Minimal; lifecycle and packaging remain ours | Window/config/capability conventions are supplied, but native composition still escapes to AppKit |

The timing and executable sizes are directional only. They exclude the Vite
assets, production daemon, app bundle metadata, signing, and notarization.

## Acceptance results

- Both shells rendered a real editable AppKit view over the shared React
  placeholder.
- Both shells accepted live placeholder-frame updates and retained Vite hot
  reload; the running Swift surface aligned with its initial placeholder.
- The Swift implementation covered frame decoding, clipping, scale conversion,
  and top-left-to-AppKit conversion with unit tests.
- The Tauri implementation exercised native focus and typing, sidebar-driven
  repositioning, resizing, and web-overlay hiding in the running app.
- A direct screenshot comparison found Tauri's title-bar safe-area offset; the
  final Objective-C bridge now includes that inset and aligns with the Swift
  result.

## Recommendation

Swift/AppKit is the cleaner foundation if native terminal surfaces become a
defining, macOS-first part of Commando. The hierarchy, focus system, clipping,
safe areas, accessibility, and eventual Metal-backed view all remain under
direct application control. Commando already carries Swift/AppKit expertise in
`apps/island`.

Tauri remains viable if its packaging conventions or future cross-platform
shell matter more. The spike shows, however, that native terminal composition
does not stay inside Tauri's normal abstraction: it still requires raw window
access, main-thread dispatch, native pointer lifetime management, and AppKit
code. The safe-area issue is a concrete example of the extra integration layer.

The next useful spike should use the Swift shell, replace `NSTextView` with one
candidate native terminal engine, and feed one real pane's existing
`pane_reset` and `pane_data` stream through the renderer-neutral sink boundary.
Keep xterm.js as the browser and remote-access renderer.

# Native terminal shell spike

This spike evaluates a direct Swift/AppKit shell and a Tauri 2 shell for a
future Commando UI where React owns the surrounding workspace and native
AppKit views render the visible terminal panes. The first iteration compared
composition with editable `NSTextView` fixtures. The second iteration advances
the Swift shell to a real SwiftTerm renderer connected to one live Commando
pane while leaving the Tauri comparison fixture unchanged.

## Shared contract

Both shells load the same Vite page from `ui/`. React renders the sidebar,
workspace, pane chrome, split controls, and a crosshatched terminal
placeholder. Both shells receive frame and focus messages:

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

The Swift shell also receives the existing renderer-neutral terminal sink
operations:

```ts
type SwiftTerminalStreamMessage =
  | {
      kind: 'reset'
      paneId: string
      data: string
      cols: number
      rows: number
      terminalState: PaneTerminalState
      revision: number
    }
  | { kind: 'data'; paneId: string; data: string; revision: number }
```

`data` is canonical base64, decoded directly to bytes on both sides without a
UTF-8 round trip. The rectangle is expressed in top-left CSS pixels. Swift
positions a SwiftTerm `TerminalView`; Tauri retains the original
`NSScrollView` and `NSTextView` fixture. Each native surface is a sibling above
the `WKWebView`. The web overlay reports `visible: false`, because a native
sibling cannot participate in CSS stacking contexts.

The Vite page owns daemon authentication, snapshots, subscription, reconnects,
and `PaneStreamRegistry`. Swift owns VT parsing, painting, focus, clipboard,
and native keyboard handling. Swift returns base64 input and measured terminal
dimensions through `window.__commandoNativeTerminalEvent`; React forwards them
through the existing input and resize messages.

## Run the Swift shell

Requirements: Swift 6, macOS 14 or newer, tmux, and at least one live pane.
Swift Package Manager resolves SwiftTerm 1.15.0 on the first build.

```bash
npm run spike:native-swift
```

The command starts the Commando daemon, Vite, and the Swift executable
together. Closing any process stops the others. It uses a deterministic local
development token and selects the first active live pane by default.

The endpoints and pane can be overridden when another checkout is running:

```bash
COMMANDO_PORT=4410 \
COMMANDO_NATIVE_UI_PORT=5290 \
COMMANDO_TOKEN=native-terminal-local \
COMMANDO_PANE_ID=%38 \
npm run spike:native-swift
```

Debug builds use SwiftTerm's CoreGraphics renderer because its debug Metal
path logs every frame and can keep requesting drawables while an overlay hides
the view. Set `COMMANDO_NATIVE_TERMINAL_METAL=1` to profile Metal in debug.
Release builds use Metal when available and fall back to CoreGraphics; setting
`COMMANDO_NATIVE_TERMINAL_METAL=0` disables it.

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

## Initial shell findings

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

These measurements predate the SwiftTerm integration and remain a comparison
of the initial composition shells only. They are directional and exclude the
Vite assets, production daemon, app bundle metadata, signing, and notarization.

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

## Live SwiftTerm results

- SwiftTerm 1.15.0 replaced the Swift shell's editable `NSTextView` and parsed
  a real pane's attributed seed and live byte stream.
- The UI reuses `PaneStreamRegistry`, so reset-before-data ordering, revision
  filtering, reconnect clearing, and buffering remain shared with xterm.js.
- A dedicated tmux pane rendered ANSI color, Unicode and wide glyphs, cursor
  state, shell output, and subsequent live output in the native view.
- Native keyboard input reached the selected pane and the resulting daemon
  output returned through the same terminal stream.
- SwiftTerm measured a 69-by-20 grid from the native viewport, acquired the
  existing resize lease, and restored the pane's original 80-by-24 dimensions
  when the shell exited.
- The React overlay hid the native sibling, and a Vite update reloaded and
  reseeded the page without restarting the Swift shell.
- The local token travels in the URL fragment, moves to `sessionStorage`, and
  is immediately removed from the visible URL.
- Swift message and ordering coverage increased from seven to fifteen tests;
  bridge helpers add eighteen Vitest cases.

The existing daemon `input` message is string-based. This iteration preserves
UTF-8, Escape, and ordinary control-key bytes, but it intentionally does not
add a new binary input message for NUL or legacy non-UTF-8 mouse reports.
xterm.js and the production browser terminal path are unchanged.

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

The second iteration validates that SwiftTerm can consume one real pane through
the existing sink boundary without displacing xterm.js. The next decision is
whether to promote this isolated shell into Commando's production workspace.
That work should define multi-pane native view lifecycle, binary-safe input,
selection and scrollback behavior, accessibility parity, packaging, signing,
and a browser-capability fallback before changing the production renderer.

# Persistent app-wide zoom level (desktop app)

**Problem.** `DesktopWebHost.zoomPercent` starts at 100 on every construction and
lives only in memory. Zoom is therefore per-window and per-launch: opening a new
window, or relaunching the app, throws away whatever the user set with ⌘- / ⌘=.
There is also no way back to 100% except counting keypresses.

**Goal.** One zoom percent for the whole app that survives relaunch, applies to
every window (workspace and detached web-pane) the moment it changes, and can be
reset with ⌘0.

**Scope.** Desktop app only. Browser users at `localhost` get their browser's own
per-origin zoom, which already persists. tmux pane zoom (`window_zoomed_flag` in
`server/tmux-resize-lease.ts`) is an unrelated concept and is untouched.

## Design

- **`apps/desktop/Sources/CommandoDesktop/ZoomPreference.swift`** (new),
  deliberately mirroring `WindowRestoration.swift`:
  - `enum ZoomPreference` — pure value logic, no AppKit. Constants
    `minimumPercent 50`, `maximumPercent 200`, `stepPercent 10`,
    `defaultPercent 100`; functions `sanitize(_:)` (clamp into range and snap to
    a 10% step; anything unusable becomes 100), `zoomedIn(from:)`,
    `zoomedOut(from:)`. The step arithmetic moves here out of `DesktopWebHost`
    so it is testable without a webview.
  - `protocol ZoomPreferenceStoring` + `UserDefaultsZoomPreferenceStore`
    (key `CommandoDesktop.zoomPercent.v1`), injected into `DesktopAppDelegate`
    exactly as `restorationStore` already is, so tests can supply a fake.
- **Ownership.** `DesktopAppDelegate` holds the single `zoomPercent`, sanitized
  from the store at init. Every change writes through to the store immediately —
  unlike window frames, which persist on terminate — so a crash cannot lose it.
- **Dispatch converges on the delegate.** Two paths reach zoom today: View menu
  items target `DesktopAppDelegate.zoomIn(_:)`, while `DesktopWindow.sendEvent`
  intercepts ⌘- / ⌘= and calls the session directly (the WKWebView otherwise
  swallows those key equivalents). For an app-wide value both must go through
  one owner:
  - `DesktopWindowControlling` and `DesktopWebHosting` lose `zoomIn()` /
    `zoomOut()` and gain `applyZoomPercent(_:)` — a pure "render at this percent"
    instruction that performs no arithmetic.
  - `DesktopWindowCommandHandling` (already reachable from a session through
    `setWindowCommandHandler`) gains `zoomIn()` / `zoomOut()` / `actualSize()`.
    `DesktopWindowSession` keeps a weak reference to that handler and forwards
    `zoomShortcutWasPressed` to it.
  - The delegate computes the next percent with `ZoomPreference`; if it differs
    from the current one it saves, then calls `applyZoomPercent` on **every**
    registered controller, workspace and `.webPane` alike. At a bound the call is
    a no-op that does not rewrite the store.
  - New windows are zoomed in `prepare(_:)` before `show()`, so restored and
    freshly opened windows come up already at the stored percent.
- **`DesktopWebHost.applyZoomPercent(_:)`** does what `setZoomPercent` does now
  (`webView.pageZoom`, `bridge.setZoomScale`, `webViewTiles.setZoomScale`, JS
  `resize` dispatch). The current percent is also re-asserted from the
  `didFinish` navigation callback, so a reload or a connection retry cannot
  silently drop back to 100%. That re-assert must bypass the existing
  `percent != zoomPercent` early return, which is otherwise kept: splitting the
  method into a guarded `applyZoomPercent(_:)` and an unguarded private
  `pushZoom()` keeps both behaviours honest.
- **Actual Size.** New View menu item after Zoom In, key equivalent `0`, target
  `DesktopAppDelegate.actualSize(_:)`. `"0"` joins `"-"` and `"="` in the
  `DesktopWindow.sendEvent` intercept so it also works while the webview holds
  focus.

## Testing

`swift test --package-path apps/desktop`

- `ZoomPreferenceTests` — clamping at both bounds; `sanitize` snapping off-step,
  out-of-range, and absent values to a legal percent; store round-trip through an
  ephemeral `UserDefaults` suite.
- `DesktopApplicationTests` — a stored percent is applied to windows created at
  launch and to a later `newWindow`; one zoom-in reaches every registered
  controller including a `.webPane` one; the new value is written to the store;
  zooming past a bound changes nothing and does not rewrite the store;
  `actualSize` returns to 100 and saves.
- `DesktopWebHostTests` — `applyZoomPercent` propagates the scale to the terminal
  bridge and web-view tiles, and the percent is re-applied after navigation
  finishes.

## Out of scope

- Per-window zoom levels (considered and rejected: one app-wide value, live-synced).
- Independent zoom for detached web-pane windows — they follow the shared value.
- Pinch-to-zoom or any new gesture surface.

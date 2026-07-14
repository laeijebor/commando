# tmux windows as tabs

## Problem

When a tmux session has multiple windows, the workspace renders every window as a
stacked section inside a vertically scrolling canvas. Real estate is split between
windows, and the toolbar `window-strip` merely scrolls to a section. Users want one
window at a time, selected via tabs.

## Decisions (approved 2026-07-14)

1. **Tabs fully replace the stacked view.** The canvas shows exactly one window
   (group) at a time.
2. **The tab bar evolves the existing toolbar `window-strip`.** No new chrome row;
   the per-group header (window name, pane count, layout controls) stays above the
   active window's panes. The strip remains hidden for single-window sessions.
3. **Tab selection is web-only view state.** Selecting a tab never runs tmux
   `select-window`, and external window changes never move the web tab. Opening a
   session defaults to tmux's active window.
4. **Inactive tabs: unmount but stay status-subscribed.** Only the active tab's
   panes are fully subscribed (mounted terminals, `pane_data` streaming). All other
   panes of the selected session use a new lightweight status-only subscription so
   working/needs-input badges stay live everywhere.

## Behavior

- Tab state is per session, in-memory (`Map<sessionId, windowId>`); falls back to
  the session's tmux-active window when unset or when the selected window vanishes
  from the snapshot.
- `jumpToGroup(windowId)` activates the tab instead of scrolling.
- `jumpToPane(paneId)` (palette, session tree) activates the pane's window tab
  first, then focuses the pane.
- Maximize keeps its existing behavior; the subscription already narrows to the
  maximized pane.
- Tabs show an attention badge when any pane in that window has `needs_input` or
  `failed` status.
- Tab switches re-subscribe the new window's panes; terminals re-seed from a server
  capture (same mechanism as switching sessions today).

## Protocol change

`shared/protocol.ts`: extend the `subscribe` client message with optional
`statusPaneIds?: string[]` — panes for which the client wants `agent_status`
updates but no `pane_data`.

## Server (`server/index.ts`)

- Track `client.statusPaneIds: Set<string>` alongside `subscribedPaneIds`.
- `emitAgentStatus` emits to clients that have the pane in either set.
- `handlePaneOutput` runs `observePaneData` + status inference whenever any client
  observes the pane (full or status-only); `pane_data` goes only to full
  subscribers.
- When a pane first becomes status-only observed, run a one-off server-side capture
  to prime the text tail and emit an initial status (no `pane_data`).
- `syncRequiredSessions` and text-tail cleanup account for both sets.

## Client (`src/App.tsx` + CSS)

- Active tab state as above; only the active group renders in `.workspace-canvas`,
  filling available height.
- Full subscription set: maximized pane if set, else active group's panes.
  Status-only set: all other panes of the selected session.
- `window-strip` buttons become tabs (`aria-pressed`/active by selected tab, not by
  scroll position), with attention badges.
- Remove scroll-to-group logic; the stacked mobile heuristic now applies within the
  single visible window.

## Testing

- Vitest: tab-selection state (default, fallback), subscription-set derivation,
  server status-only emission (status without `pane_data`, tail priming).
- Update `App.test.tsx` and e2e assumptions about stacked groups.

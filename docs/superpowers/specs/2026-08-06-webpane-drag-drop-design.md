# Web tile drag-and-drop, maximize, and URL editing — design

**Date:** 2026-08-06
**Status:** approved (drag-and-drop; maximize + URL editing addendum approved same day)

## Problem

Terminal panes can already be rearranged by dragging their headers onto each
other (swap via `set_window_layout`), and this works in every client
including the AppKit app. Web pane tiles cannot be dragged at all: they are
anchored to a terminal pane (`anchorPaneId` + `placement`) and the only way
to move one is to close it and reopen it elsewhere.

## Goal

Dragging a web tile's header and dropping it onto a terminal pane in the
same window re-anchors the tile to that pane, with the drop position picking
the placement. Terminal-pane drag behavior is unchanged.

Out of scope: cross-window and cross-session moves, insert (non-swap)
semantics for terminal panes, tiles as drop targets.

## Interaction

- The web tile card header is `draggable`, matching the terminal pane
  header affordance, for all tile engines (webkit iframe, native WKWebView,
  chromium screencast) — the header is DOM in every renderer.
- While a tile drag is in flight, hovering a terminal pane card previews
  the drop: cursor in the right half highlights the card's right edge
  ("anchor to the right of this pane"); cursor in the bottom half
  highlights the bottom edge ("anchor below"). Corner tie-break: whichever
  fractional coordinate is larger wins (`x/width > y/height` → right).
- Dropping calls the move API with the previewed placement. Dropping a tile
  onto its own anchor's other half simply flips its placement.
- Dropping a terminal pane onto a web tile does nothing; web tiles are not
  drop targets.
- AppKit compatibility: the drop preview is a DOM overlay inside the pane
  card, registered as a native-terminal occluder
  (`data-native-terminal-occluder`) so it renders above native SwiftTerm
  surfaces. Drag start/drop on headers and cards is the same HTML5
  machinery the existing terminal swap uses, already verified working in
  the AppKit app.

## Daemon

### Service

`WebPaneService.move(id, target)` where `target` is
`{ anchorPaneId, placement, sessionId, windowId }`:

- Unknown id → `WebPaneError(404)`.
- `placement` must be concrete `'right' | 'below'` — `'auto'` is rejected
  (400). Placement is state; it is never re-derived after open.
- Updates `anchorPaneId`, `placement`, `sessionId`, `windowId`; persists;
  returns the updated pane.

### API

`POST /api/web-panes/:id/move`, body `{ anchor, placement }`:

- Auth identical to open (owner cookie/token or agent hook token).
- `anchor` validated via `paneForId`; unknown pane → 404. The pane record
  supplies `sessionId`/`windowId` to the service.
- Same-window constraint: if the target anchor's `windowId` differs from
  the tile's current `windowId`, reject with 400. The invariant is
  enforced server-side, not just by UI reachability.
- Rate limited by the same token bucket as open.
- On success fires `onChange` → daemon broadcasts `web_panes`.

## Client

- `draggedPane` state becomes a tagged union:
  `{ kind: 'terminal'; groupId; paneId }` or
  `{ kind: 'web'; groupId; webPaneId }`.
- Terminal card `onDragOver`/`onDrop` branch on the kind:
  - `terminal`: today's swap path, unchanged.
  - `web`: compute placement from cursor position via a pure helper
    (`dropPlacementFor(rect, x, y): 'right' | 'below'`), set a preview
    class on the card, and on drop call `webPanesApi.move(webPaneId,
    anchor, placement)`.
- No optimistic layout mutation: the drop fires the API call and the
  layout re-renders when the daemon's `web_panes` broadcast lands (same
  consistency model as open/close; one round trip of latency).
- The tile header drag handlers live in the shared tile card chrome so all
  engines get them.

## Addendum: maximize a web tile

- The tile header gains a maximize/restore button with the same icons and
  toggle behavior as terminal panes (`Maximize2`/`Minimize2`).
- Reuses the single `maximizedPaneId` state — web ids (`w-…`) cannot
  collide with tmux ids (`%N`), so one thing is maximized at a time,
  terminal pane or tile. The workspace canvas shows just that tile
  (rendered as a single-leaf display tree); toggling restores the grid.
- tmux is untouched (tiles are not tmux panes; no zoom is involved) and no
  layout writes happen while anything is maximized (existing gate on
  `maximizedPaneId`).

## Addendum: change a tile's URL

- Clicking the URL text in the tile header opens an inline input (Enter
  commits, Escape cancels, blur cancels). Blur deliberately cancels rather
  than committing (diverging from the pane-rename UX): an accidental click
  elsewhere must not navigate the tile.
- Daemon: `WebPaneService.navigate(id, url)` runs the same trust policy as
  open: invalid URL → 400; localhost/allowlisted origins swap the URL and
  keep the tile `open`; an unconfirmed external origin swaps the URL and
  flips the tile to `pending` (the existing confirm card), so URL editing
  cannot bypass the origin gate. Unknown id → 404. Persisted.
- API: `POST /api/web-panes/:id/navigate`, body `{ url }`, same auth and
  rate limit as open. When the result is `open`, the existing
  `onConfirmed` hook fires so a chromium-engine tile's managed target
  navigates; webkit tiles simply re-render at the new URL.

## Testing

- Service unit tests: move updates + persists; 404 unknown id; 400 'auto'.
- Navigate service tests: localhost swap stays open; unconfirmed external
  flips to pending; allowlisted external stays open; invalid 400; unknown
  404. Navigate API tests: happy path fires `onChange` + `onConfirmed`;
  pending result does not fire `onConfirmed`; 401 unauthenticated.
- Maximize tests: tile maximize button toggles the canvas maximized state
  and renders only that tile; restore brings the grid back; terminal-pane
  maximize unchanged.
- API tests: happy path (anchor/placement updated, broadcast fired),
  cross-window 400, unknown anchor 404, auth 401.
- Client unit tests: `dropPlacementFor` halves and corner tie-break; drop
  dispatch (web drag → move call with computed placement; terminal drag →
  swap unchanged; drop with no drag in flight → no-op).
- End-to-end: isolated stack (tmux socket + daemon + vite per the repro
  recipe) driving a tile move; manual verification in the AppKit app.

# Tile review mode — design

**Date:** 2026-08-06
**Status:** Approved (brainstorm with Leo)
**Branch:** `tile-review`

## Motivation

Lavish (`lavish-axi`) proved a valuable loop: an agent renders an HTML artifact, the
user annotates elements in a browser and queues comments, and the agent receives
selector-anchored feedback through a blocking CLI poll. Its limits are structural: it
can only instrument HTML it serves itself, it needs its own background server and a
separate browser window, and the agent is blind to the real render (hence its
injected layout-warning telemetry).

Commando already has the stronger substrate: chromium tiles render *any* localhost
page beside the agent's tmux pane via a CDP screencast, the daemon holds a per-tile
CDP connection, and agents authenticate with the hook token. This feature adds the
missing piece — element-anchored user feedback — as a **review mode on chromium
tiles**, so any page in a tile (agent artifact, vite dev server, storybook, report)
becomes a reviewable surface.

Decisions locked during brainstorming:

- **Scope:** any chromium tile, not just agent-served artifacts.
- **Annotation UI:** client overlay + CDP hit-test. The page is never touched — no
  persistent script injection.
- **Transport:** long-poll REST on the daemon (lavish's proven harness-agnostic
  pattern), agent authenticates with the hook token.
- **Reply channel:** none. The agent's terminal sits beside the tile; the tile shows
  only a minimal ack ("agent received N notes").

## Data flow

```
user hovers/clicks ──▶ overlay (ChromiumTileCard)
                         │ inspect{x,y} over /ws/web-tiles/:id
                         ▼
                       daemon ──▶ CDP Runtime.evaluate(elementFromPoint → selector, rect, snippet)
                         │
                         ▼
                       overlay highlight + comment card → queued pills → Send
                         │ POST /api/web-panes/:id/feedback   (owner channel)
                         ▼
                       daemon feedback queue ──▶ GET /api/web-panes/:id/feedback?wait=30   (agent, hook token, long-poll)
                                                    └─ drain = ack → tile status line updates
```

## Server — element resolution

New method on the chromium engine (`server/chromium-engine.ts`):
`inspectAt(webPaneId, x, y, grade)`.

Implementation is a **single `Runtime.evaluate` call** per inspect, with a
self-contained function string — no CDP DOM-domain node bookkeeping
(getDocument/getNodeForLocation). The evaluated function:

1. `document.elementFromPoint(x, y)`
2. builds a stable CSS selector by walking up: prefer `id`, then `data-testid`,
   falling back to an `:nth-of-type` path
3. returns `{selector, tag, rect, text}`; for `grade: 'click'` it adds a trimmed
   `outerHTML` snippet capped at ~2KB

Properties: transient evaluation, nothing installed in the page; CDP evaluation is
not subject to the page's CSP; works unless the page's JS context has crashed.
Two grades keep hover cheap — `hover` returns selector+rect only, `click` adds
text/snippet. Coordinates arrive in the same viewport space the existing input
relay uses.

The selector-builder is authored as a plain exported function (stringified into the
evaluate call) so it is unit-testable outside CDP.

## Server — feedback queue & API

A per-pane feedback queue lives in the `WebPaneService` (`server/web-panes.ts`).
In-memory only: a daemon restart loses undelivered notes. Acceptable for v1 —
matches tile lifetimes.

Routes in `server/web-panes-api.ts`, following the existing auth split (owner/client
channel vs agent bearer hook token):

| Route | Auth | Behavior |
|---|---|---|
| `POST /api/web-panes/:id/feedback` | owner/client | Body `{notes: [...]}`. Queues notes. Caps: 50 queued notes per tile → 429; comment ≤ 4KB. |
| `GET /api/web-panes/:id/feedback?wait=30` | agent (hook token) | Long-poll, `wait` capped at 60s. Returns `{notes: [...]}` and **drains** the queue, or `{notes: []}` on timeout (agent re-polls). |

Note shape:

```json
{
  "selector": "string",
  "tag": "string",
  "text": "string",
  "rect": { "x": 0, "y": 0, "width": 0, "height": 0 },
  "comment": "string",
  "pageUrl": "string",
  "capturedAt": "ISO-8601"
}
```

- **Drain is the ack.** Draining broadcasts a pane-state update so every connected
  client's tile renders "agent received N notes · hh:mm". No separate ack endpoint.
- Tile close/DELETE discards the queue and ends any waiting poll with **404** — the
  agent's signal to stop polling.
- No agent-reply endpoint. The terminal next door is the reply channel.

## Protocol & client UI

Tile websocket (`shared/protocol.ts`, `server/web-tile-relay.ts`) gains a
request/response pair:

- client → daemon: `{kind: 'inspect', id, x, y, grade: 'hover' | 'click'}`
- daemon → client: `{kind: 'inspect-result', id, ok, selector?, rect?, tag?, text?, error?}`

Same 16KB message cap; the relay validates the message with the same rigor as
`parseTileInputEvent`.

`ChromiumTileCard.tsx` gets a **review-mode toggle** in the tile header. In review
mode:

- **Wheel events still forward** (the user can scroll to the element). **Clicks and
  keys are intercepted** by the overlay instead of relayed to the page.
- Hover sends throttled `hover` inspects — latest-wins, minimum 50ms apart. The
  overlay draws the returned rect as a highlight box.
- Click sends a `click` inspect and opens a comment card anchored to the rect.
  Saving adds a pill to the tile's pill strip. Pills are removable; **Send** posts
  the batch to the feedback endpoint and clears them.
- A status line renders the last-ack info from pane state.

## Agent workflow

Extend the **show-in-commando skill** (it already owns tile etiquette) with a
"collect review feedback" section: after opening a chromium tile for something
reviewable, run the long-poll as a background Bash task and keep working; each
response is a batch of selector-anchored notes to act on, then re-poll.

A `scripts/commando-feedback <webPaneId>` helper wraps the curl loop in the style of
`scripts/commando-open`.

Because notes carry `pageUrl` + selector, the agent can go straight from note to
edit, and can verify fixes over the tile's existing `/api/web-panes/:id/cdp`
endpoint before replying in its terminal.

## Error handling

- **Inspect failure** (CDP down, page crashed, cross-origin frame under the
  cursor): `inspect-result` carries `error`; the overlay shows a small "can't
  resolve element here" hint and no pill is queued.
- **Dead engine:** review mode follows the existing tile-error surface; the toggle
  is disabled while the screencast stream is down.
- **Poll errors:** 404 (tile closed) → stop polling; 401 → do not retry in a loop.
  Mirrors existing agent-endpoint behavior and is documented in the skill.

## Testing

- **Vitest, server:** inspect-message validation (malformed/oversized); long-poll
  semantics (queue→wake, timeout→empty, close→404, cap→429); ack broadcast in pane
  state. Follows existing `web-panes-api.test.ts` / `web-panes.test.ts` patterns.
- **Vitest, shared:** selector-builder unit tests against jsdom fixtures
  (`id` / `data-testid` / `:nth-of-type` fallbacks).
- **Vitest, client:** review-mode input interception (wheel passes, click
  intercepted); pill queue reducer; hover-throttle latest-wins.
- **End-to-end (manual, per CLAUDE.md):** `npm run dev`, open a chromium tile on a
  local page, annotate two elements, run the poll curl, confirm notes arrive and
  the ack line renders.

## Deferred (explicitly out of scope for v1)

- Webkit tiles (no CDP).
- Drag-rect / region annotations (cheap to add once the overlay exists).
- Text-range selection (would require DOM text ranges over CDP).
- Agent conversation panel in the tile.
- Feedback persistence across daemon restarts.

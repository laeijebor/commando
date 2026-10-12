# Agent canvas — design

Status: approved 2026-10-12 (redline review, rounds 1–3, sent with Build).
Discussion artifact: `.redline/canvas.html` in the `canvas` worktree.
Plan and checklist: Commando vault note `agent-canvas.md`.

## Goal

Agents lay out live, interactive HTML mockups ("frames") on a pan-and-zoom
canvas that opens as a side-panel tab beside their tmux pane. The user
navigates it, sees which frames are focal / interactive, jumps to labelled
components from an overview panel, drops comment pins, and sends them back to
the agent. Modelled on Claude Code's canvas artifact and the user's design
team's Figma conventions.

The canvas is a second redline surface: it reuses redline's artifact
registry, pending store, feedback journal, and `handoff` signal rather than
adding a parallel delivery system.

## Decisions (from review)

| Topic | Decision |
|---|---|
| Frame interaction | Inert until entered (double-click or Play); Esc leaves |
| Send timing | Both: per-comment "Send this" and a batching queue with "Send" |
| Delivery | Push into the agent pane when it can take it; journal (`/feedback`) stays as backup |
| Threads | Two-way: agent replies and resolves via an agent-token endpoint |
| Authoring | Folder + `canvas.json` + CLI + skill first; MCP layer later |
| Pan/zoom | Hand-rolled (CSS transform camera), no new dependency |
| Convergence | Canvas shares redline's queue/journal now; redline docs move to panel tabs later |
| Scope v1 | Include: user can drag frames (writes back to `canvas.json`), snapshot history, frame export. Exclude: drawing tools |
| Overview sources | Only agent-authored labels (`data-canvas-label`) |
| Agent spotlight | Agent can request "look at <label>"; user sees a toast with "Show me" (like navigate requests) |
| Label scope | Same attributes + overview wherever the frame script runs (later: redline docs, dev-server tabs) |
| Frame roles (R3) | Agents declare focus order, interactive vs static, ticket sections with status, variant headers, annotations |

## Authoring format

An agent writes a directory and registers it (same registry as redline
artifacts, `RedlineArtifactRegistry`):

```
.canvas/<topic>/
  canvas.json
  Settings.html  Notifications.html  …
  assets/…
```

`canvas.json` (validated server-side; unknown keys ignored, errors reported to
the agent by the CLI and shown in the tab):

```jsonc
{
  "title": "Settings, regrouped",
  "sections": [
    { "id": "regroup", "title": "Settings, regrouped", "ticket": "GIZMO-6094",
      "status": "ready-for-dev",          // idea | in-progress | ready-for-review | ready-for-dev | shipped
      "frames": ["settings", "notif", "accounts"] }
  ],
  "frames": [
    { "id": "settings", "title": "Settings (top level)", "platform": "Mobile",
      "src": "Settings.html", "x": 0, "y": 0, "w": 390, "h": 844,
      "focus": 1, "interactive": true },
    { "id": "accounts", "title": "Connected accounts", "src": "Accounts.html",
      "x": 960, "y": 0, "w": 390, "h": 844, "interactive": false,
      "variant": { "title": "Needs attention", "context": "Connected accounts",
                   "description": "Shown when an account's token has expired" } }
  ],
  "annotations": [
    { "id": "dev-outlook", "kind": "development",   // development | important | design | question
      "text": "Outlook row opens Account details.",
      "target": { "frame": "accounts", "label": "Outlook row" },  // or { "frame": "accounts" }
      "x": 1450, "y": 250, "w": 250 },
    { "id": "important", "kind": "important", "title": "Important",
      "items": ["Daily planning moves to the top group."], "x": -30, "y": -205 }
  ]
}
```

Inside frame HTML (plain HTML, no build step):

- `data-canvas-label="Outlook row"`, optional `data-canvas-group`, optional
  `data-canvas-id` (stable id when the visible name changes)
- `data-canvas-goto="<frameId>"` — Play-mode navigation between frames

## Architecture

- **Tab kind.** `WebPane.content` gains `{ kind: 'canvas'; artifactId: string; manifest: string }`
  (precedent: `{ kind: 'simulator' }`). `WebPaneCard` renders `CanvasPane`
  for it. Canvas tabs are panel tabs; engine is irrelevant (frames are
  plain sandboxed iframes served by the daemon from the artifact origin).
- **Camera.** One CSS `translate/scale` on a world layer holding frame
  iframes, sections, variant headers, annotations and an SVG connector
  layer. Pins, highlights and thread popovers live in a screen-space overlay
  so they stay legible at any zoom. Wheel pans; ctrl/⌘-wheel and pinch zoom
  around the cursor; drag on background pans; Fit fits all content; frames
  have `pointer-events: none` unless entered.
- **Live reload.** The daemon watches registered canvas dirs (debounced
  `fs.watch`). A changed frame file reloads only that iframe; a changed
  `canvas.json` re-lays-out without reloading untouched frames. Pushed over
  the existing web-tile relay socket or the web-panes broadcast.
- **Frame script** (M2). The daemon injects `/redline/canvas-frame.js` into
  canvas frame HTML it serves. Over `postMessage` it: reports labelled
  elements (`[data-canvas-label]`: name, group, id, rect) on load and on
  mutation; hit-tests a point → selector, rect, nearest label; follows
  `data-canvas-goto` in Play. Port the webkit queue bridge from branch
  `store` (commits 0437f71..a5268be: `shared/redline-pending.ts`, SDK
  postMessage transport, `POST /api/web-panes/:id/pending/response`, relay
  pushes to webkit tiles) so redline SDK components inside frames queue too.
  Those commits predate today's `TileReviewLayer`; port the behaviour, not
  the diff.
- **Comments.** Pins anchor to frame + point, plus selector/label when
  dropped on an element. They enter the existing `WebPanePendingStore` and
  deliver through `WebPaneFeedbackStore`; notes gain optional
  `canvas: { frameId, point, label?, labelId?, section?, ticket?, status?, focus?, interactive? }`.
- **Threads + push** (M3). `POST /api/web-panes/:id/threads/:threadId/replies`
  (agent token) with `{ text, resolve? }`. Push: deliver sent comments as the
  agent's next prompt — chat panes through the agent host send/queue path;
  Claude terminal panes only when hook status is idle; otherwise they wait
  in the journal.

## Milestones

1. **M1 · Canvas tab** — content kind, manifest validation, `CanvasPane`
   with camera/fit, frame iframes, sections + status chips, frame badges
   (focus ★n, ▶ interactive, Static, `[platform]` prefix), variant headers,
   annotations (frame-targeted connectors; label-targeted ones fall back to
   the frame until M2), Notes toggle, live reload, `scripts/commando-canvas`,
   `skills/canvas/SKILL.md`. Done when an agent can build the Settings
   example from the concept and the user can pan/zoom/fit it, and editing a
   frame file updates only that frame.
2. **M2 · Frame script, overview, comments** — frame script + bridge port,
   overview panel (Start here, Notes, Shared, Frames→groups→labels, Threads,
   filter, hover/select highlight, fly-to), label-targeted connectors, pins
   (frame + element + label), queue with Send / Send this, delivery through
   the journal with `canvas` context.
3. **M3 · Threads + push** — reply/resolve endpoint, thread UI, push
   delivery, agent spotlight request (toast "Show me").
4. **M4 · Play + user layout** — enter/exit interactive frames, Play
   click-through from focus 1, frame dragging written back to `canvas.json`,
   section status edit → feedback note.
5. **M5 · History + export + convergence** — snapshot per Send, frame export
   (HTML/PNG via daemon Chromium), redline docs as iframe panel tabs with full
   review via the frame script.

## Out of scope

Sharing/publishing outside the machine, multiplayer editing, drawing tools,
turning frames into production code (Send + Build already hands off).

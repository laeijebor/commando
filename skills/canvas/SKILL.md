---
name: canvas
description: Use when laying out multiple HTML mockups as frames in a Commando canvas tab for visual comparison, ticket sections, variants, and author notes.
argument-hint: <screens or variants to lay out>
---

# Agent canvas

Use a canvas for a spatial board of screens, flows or alternatives. Use a
redline document for a linear plan, report or proposal that needs prose and
review of document elements. Canvas displays inert frames with a label overview.
Double-click an interactive frame to enter it; its Live chip indicates that
controls and scrolling work. Esc or clicking the canvas background leaves it.
Static frames never become live. The comment tool takes precedence over live input.
▶ Play starts at focus 1 (or the first interactive frame), fits it, and follows
prototype links. Back retraces up to 50 frame visits; Esc exits Play.

Create plain HTML files with local assets and no build step:

```
.canvas/settings/
  canvas.json
  Settings.html
  Accounts.html
  assets/
```

Open once from the owning tmux pane:

```bash
scripts/commando-canvas .canvas/settings
# Or: scripts/commando-canvas .canvas/settings --manifest board.json
```

The script registers the folder with the existing redline artifact registry,
validates the manifest and prints the webPaneId. Missing or unparsable
manifests fail. Field validation warnings still open the usable content;
correct them in place. Reopening the same artifact at the same anchor selects
its existing tab. `COMMANDO_PORT` defaults to 4310; auth uses
`~/.commando/agent-hook-token` (or `COMMANDO_AGENT_HOOK_TOKEN_PATH`).

## Manifest

Coordinates and sizes use world pixels. All ids must be unique. Frame `src`
paths are relative to the registered canvas folder and cannot escape it.
Unknown keys are ignored. `title` and `frames` are required; `sections` and
`annotations` may be omitted. Frames require id, title, src, x and y; w/h
default to 390/844. Optional platform prefixes describe the target device.

```json
{
  "title": "Settings, regrouped",
  "sections": [
    { "id": "regroup", "title": "Settings, regrouped", "ticket": "GIZMO-6094",
      "status": "ready-for-dev", "frames": ["settings", "accounts"] }
  ],
  "frames": [
    { "id": "settings", "title": "Settings (top level)", "platform": "Mobile",
      "src": "Settings.html", "x": 0, "y": 0, "w": 390, "h": 844,
      "focus": 1, "interactive": true },
    { "id": "accounts", "title": "Connected accounts", "platform": "Mobile",
      "src": "Accounts.html", "x": 960, "y": 0, "interactive": false,
      "variant": { "title": "Needs attention", "context": "Connected accounts",
        "description": "Shown when an account token has expired" } }
  ],
  "annotations": [
    { "id": "dev-outlook", "kind": "development", "title": "Account details",
      "text": "Outlook row opens Account details.",
      "target": { "frame": "accounts", "label": "Outlook row" },
      "x": 1450, "y": 250, "w": 250 },
    { "id": "important", "kind": "important", "title": "Important",
      "items": ["Daily planning moves to the top group."],
      "x": -30, "y": -205, "w": 420 }
  ]
}
```

Frame roles:

- `focus`: positive integer defining the reading order (★ Focus 1, 2, …).
  Initial view fits focus frames; without focus it fits everything. Fit always
  includes everything. Set focus on the screens to discuss first.
- `interactive`: boolean distinguishing a planned clickable prototype (cyan
  ▶ Interactive) from a Static reference. Frames stay inert until double-clicked or entered through Play.
- Sections group frame ids with an optional ticket. Status must be `idea`,
  `in-progress`, `ready-for-review`, `ready-for-dev` or `shipped`.
- `variant`: title required, context and description optional; appears above
  its frame with a dashed leader. Leave enough room between variants.
- Annotations require id, kind, x/y. Optional title, text, string bullet
  `items`, width (default 300) and target `{frame, label?}`. Kinds are
  `development` (implementation guidance, green), `important` (cautions,
  amber), `design` (design reasoning, accent), `question` (open decisions,
  teal). Frame-target connectors point at the nearest frame edge. Label
  targets connect to the named element once its labels arrive, falling back
  to the frame edge while loading. Notes hides variants, annotations
  and their connectors.

## Label the frame HTML

The overview consumes `data-canvas-label` (display name), `data-canvas-group`
(region) and `data-canvas-id` (stable identity). Label the components a reviewer
would talk about, such as “Outlook row” or “Quiet hours”; avoid labelling every
wrapper. Group by region using the attribute on a labelled element or its
nearest ancestor. Use unique, stable `data-canvas-id` values when names may
change. Reuse label names across frames for comparable components: Shared
lists names found in at least two frames and cycles through their instances.
The filter matches label names; hover highlights and click selects and flies
to the element. Start here follows focus order; Notes jumps to note cards.
Label-targeted annotations match names within their target frame (use distinct
names there if they need distinct connectors). Frame ids used by the bridge
must match `^[A-Za-z0-9_-]{1,64}$`.
`data-canvas-goto="<frameId>"` is required for canvas click-through. The bridge
intercepts those clicks and flies to the target frame in Play or an entered
frame. Ordinary links do not navigate between canvas frames. Targets must be
manifest frame ids; static targets fit into view but stay inert.

```html
<div data-canvas-group="Accounts">
  <button data-canvas-label="Outlook row" data-canvas-group="Accounts"
          data-canvas-id="account-outlook" data-canvas-goto="accounts">
    Outlook
  </button>
</div>
```

## Collecting feedback

Editing files live-reloads the open tab. Never close/reopen it to refresh.
A frame HTML change reloads that frame; asset changes reload all frames;
manifest edits re-layout while preserving unchanged iframe ids and sources.
Frames run with `sandbox="allow-scripts"` without same-origin access.

Keep the printed webPaneId. Read the shared feedback journal as with redline:

```bash
scripts/commando-feedback <webPaneId>
scripts/commando-feedback <webPaneId> --wait 30
```

Comments can arrive as a pushed prompt in your anchor pane, or through
`commando-feedback` polling. Always drain with `commando-feedback` to collect
and acknowledge the journal, even after a pushed prompt. The script tracks its
acknowledgement cursor automatically. Keep the tab open for the next review.
Use the 💬 tool to drop a pin on a frame (Esc exits), Queue to batch notes,
and Send or Send this to deliver them through the shared feedback journal.
Notes carry `canvas` context: threadId, frameId, frameTitle, frame-local CSS pixel point,
label/labelId, section/ticket/status, focus and interactive. Prefer label +
frame over selector when finding the source to edit. The first matching
manifest section supplies section context. Queued pins survive reload; sent
pins appear in Threads and remain after journal acknowledgement.

Redline SDK controls work inside frames through the canvas queue bridge,
with pending snapshots scoped to the frame page URL. SDK question snapshots
are validated but ignored. Enter a frame to use its SDK controls; programmatic
SDK queue calls also work while inert. The review loop is two-way: reply in each thread, and resolve when done.
User follow-ups arrive through the same journal and reopen resolved threads.

```bash
scripts/commando-canvas threads <webPaneId> # JSON conversation and status
scripts/commando-canvas reply <webPaneId> <threadId> "Updated the Outlook row" --resolve
scripts/commando-canvas resolve <webPaneId> <threadId>
scripts/commando-canvas spotlight <webPaneId> "Outlook row" --frame accounts --message "Here is the updated state" --wait 30
```

Use spotlight to point the user at something you changed. The user chooses
Show me or Dismiss; the CLI returns a requestId and a decision (`pending`,
`accepted`, `dismissed`, `superseded`, or `closed`). `--wait` is 0–60 seconds;
a pending result can be polled with
`GET /api/web-panes/<webPaneId>/spotlight-requests/<requestId>?wait=30`.
Chat hosts queue pushed feedback during a turn. Terminal agents receive pushes
only in `done` status; busy or unknown panes are owed delivery until a later
completion. The journal remains the source of truth across daemon restarts.

## User layout and section status

In hand mode, users can drag frame label rows. Positions snap to 10 world pixels
and are written atomically to the manifest. Users can also choose any of the
five statuses from a section's status chip. This writes the new status and
queues then sends a feedback note with section, ticket and status context
through the shared journal and push delivery. A stale edit reloads the manifest
and asks the user to try again; a failed send leaves the note queued for Send.

Always re-read `canvas.json` (or the custom manifest path) before rewriting it.
Keep user-moved x/y positions and user-chosen section statuses, along with
unknown keys. Do not overwrite layout from an earlier in-memory copy. Agents
edit the file directly; the layout/status daemon endpoints require owner auth.

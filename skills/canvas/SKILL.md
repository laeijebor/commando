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

The scripts live in the **Commando repo checkout**, not the artifact/project
folder. Invoke `/absolute/path/to/commando/scripts/commando-canvas` and
`/absolute/path/to/commando/scripts/commando-feedback` when working elsewhere.

If those scripts are unavailable, use raw HTTP. For **every request** send the
agent-hook-token as `Authorization: Bearer <token>`, read from
`${COMMANDO_AGENT_HOOK_TOKEN_PATH:-$HOME/.commando/agent-hook-token}`. Use
`http://127.0.0.1:${COMMANDO_PORT:-4310}` as the base URL and
`Content-Type: application/json` for JSON bodies. Encode path ids and query values.

| CLI action | Raw HTTP fallback |
|---|---|
| Open: register directory | `POST /api/redline/artifacts` with `{"dir":"/absolute/canvas/folder"}`; retain returned `id` and `url` |
| Open: validate manifest | `GET /api/redline/artifacts/:id/canvas?manifest=canvas.json` (or custom manifest) |
| Open: create/select tab | `POST /api/web-panes` with `{"url":"<registered url>","anchor":"<TMUX_PANE>","engine":"webkit","content":{"kind":"canvas","artifactId":"<id>","manifest":"canvas.json"}}`; retain `webPaneId` |
| Feedback / `--wait` | `GET /api/web-panes/:webPaneId/feedback?wait=30&cursor=<last cursor>`; first poll omits cursor, next poll acknowledges returned cursor; fetch attachments before acknowledging; repeat while review is active |
| Threads | `GET /api/web-panes/:webPaneId/threads` |
| Reply / `--resolve` | `POST /api/web-panes/:webPaneId/threads/:threadId/replies` with `{"text":"Updated the row","resolve":true}` (false unless resolving) |
| Resolve / thread status | `POST /api/web-panes/:webPaneId/threads/:threadId/status` with `{"status":"resolved"}` (or `"open"`) |
| Spotlight / `--frame`, `--message`, `--wait` | `POST /api/web-panes/:webPaneId/spotlight?wait=30` with `{"label":"Outlook row","frame":"accounts","message":"Updated state"}`; optional frame/message; wait is 0–60 |
| Spotlight decision polling | `GET /api/web-panes/:webPaneId/spotlight-requests/:requestId?wait=30` |

The script registers the folder with the existing redline artifact registry,
validates the manifest and prints the webPaneId. Missing or unparsable
manifests fail. Field validation warnings still open the usable content;
correct them in place. Reopening the same artifact and manifest at the same anchor selects
its existing tab. `COMMANDO_PORT` defaults to 4310; auth uses
`~/.commando/agent-hook-token` (or `COMMANDO_AGENT_HOOK_TOKEN_PATH`).

## Manifest

Coordinates and sizes use world pixels. All frame, section and annotation ids
must be unique and match `^[A-Za-z0-9_-]{1,64}$`. Frame `src`
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
      "focus": 1, "interactive": true,
      "interactiveNote": "Supports dark mode — toggle the theme button in the menu" },
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
- `interactiveNote`: optional string, only with `interactive: true`. Hovering
  the ▶ Interactive badge shows it; say what the interactivity covers, e.g.
  “Supports dark mode — toggle the theme button in the menu”.
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

### Pages

Split a large canvas into pages when one board would be hard to navigate or
heavy to load; you decide when that helps. Each page is its own board: it
holds its own `sections`, `frames` and `annotations`, with its own
coordinates. Only the open page's frames load. The sidebar lists the pages
above the open page's components (a toolbar menu on narrow tiles), and the
tab remembers each page's zoom and the last page opened.

```json
{
  "title": "Trainer web app — new UI audit",
  "pages": [
    { "id": "today", "title": "Today and the rail",
      "sections": [{ "id": "s-today", "title": "Today and the rail", "status": "ready-for-review", "frames": ["p-today"] }],
      "frames": [{ "id": "p-today", "title": "Today — proposed", "src": "today.html", "x": 0, "y": 0, "focus": 1 }],
      "annotations": [] },
    { "id": "client", "title": "Client profile",
      "frames": [{ "id": "p-client", "title": "Client overview", "src": "client.html", "x": 0, "y": 0 }] }
  ]
}
```

- A manifest uses either `pages` or top-level `frames`/`sections`/`annotations`,
  not both. Without `pages` the canvas is a single page, as before.
- Pages need an `id` (unique among pages) and a `title`, and each page needs a
  `frames` array. Frame, section and note ids stay unique across the whole
  canvas, so prototype links (`data-canvas-goto`), question keys, threads and
  feedback work across pages.
- A section's frames and a note's target frame must be on the same page.
- `focus` numbers form one reading order across pages; Play starts at focus 1
  and follows prototype links onto other pages. Threads, questions, queued
  answers and spotlights open the right page.
- Order pages the way you want them read. The sidebar shows each page's
  section status (its least advanced section), frame count, open questions
  and open comments.

## Ask the user questions

Every `question` note is answerable on the canvas. Put the question itself in
`text`, at most 256 characters (longer ones are reported and get no answer
controls; put detail in `items`). The `title` is a short label such as "Your
call". Add `options` for a
choice; picking one queues it at once. Without options the note takes a text
answer. Every question also takes an optional note.

```json
{ "id": "q-recipe", "kind": "question", "title": "Your call",
  "text": "Should new copies of an archived recipe fail the save?",
  "options": ["Fail with a clear error (recommended)", "Allow the copy"],
  "target": { "frame": "open", "label": "Finding: recipe references" },
  "x": 6600, "y": -420, "w": 420 }
```

- `options`: 1–50 strings, each up to 256 characters. `multiple: true` allows
  several; the answer arrives as `"A, C"` and `response.data.choice` is the array.
- `key`: answer identity (defaults to the note id). Keep it stable between
  rounds and unique among question notes (a clashing key is reported and
  ignored). Re-answering before sending replaces the queued answer. An answer
  queued before you change the question's text or options no longer counts
  as its answer; it stays in the queue until the user replaces or removes it.
- Answers queue in the canvas's answer queue (the strip at the bottom of the
  canvas, same drawer as redline: edit, attach images, Send this, Send all,
  Send all + Build). The Questions tab in the overview lists every question
  note as Open, Queued, Sent or Answered.
- An answer note carries `response: {question, answer, note?, data?}` and
  `selector: [data-canvas-note="<id>"]`, with no `canvas` context. Find the
  note in `canvas.json` by that id.
- Once you have the answer, record it so the question is settled:
  `"answer": "Fail with a clear error (recommended)"`. The note then shows
  "Answered" with Reopen and leaves the answer queue. Until you do, a sent
  answer shows as "Sent · 2h ago". To ask again, change the text or options
  and remove `answer`; a note with a recorded `answer` stays settled.
- Use a question note when the decision belongs on the board; use plain
  annotations for open-ended review.

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

Interactive frames show a pulsing blue dot on each control that works, so
reviewers know what to try. Every `data-canvas-goto` element gets one, with a
tooltip naming its target frame. Mark other working controls (in-page JS such
as a theme toggle or an expanding row) with `data-canvas-hotspot`; its value is
an optional tooltip. Only mark controls that respond — leave decorative buttons
unmarked. Static frames, snapshots, comment mode and Notes off hide the dots.

```html
<button data-canvas-hotspot="Toggles dark mode" onclick="toggleTheme()">Theme</button>
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
and Send this (in the pin) or Send all (in the answer queue strip) to deliver
them through the shared feedback journal. A batch sent with Send all + Build
carries `handoff: {kind: "build", instruction}`; follow it as redline describes.
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

Users can drag frame label rows whenever comment mode is off and Play isn't running. Positions snap to 10 world pixels
and are written atomically to the manifest. Users can also choose any of the
five statuses from a section's status chip. This writes the new status and
queues then sends a feedback note with section, ticket and status context
through the shared journal and push delivery. A stale edit reloads the manifest
and asks the user to try again; a failed send leaves the note queued for Send.

Always re-read `canvas.json` (or the custom manifest path) before rewriting it.
Keep user-moved x/y positions and user-chosen section statuses, along with
unknown keys. Do not overwrite layout from an earlier in-memory copy. Agents
edit the file directly; the layout/status daemon endpoints require owner auth.

## History and frame export

History lists the newest 30 snapshots, with Live at the top. The daemon takes
one when comments are sent (Send, Send this, user thread follow-ups and section
status notes), so agents can refer to “the previous round”. Identical consecutive
content keeps the existing snapshot. Selecting a round opens its saved files
read-only: overview, pan and zoom still work; commenting, dragging, status edits,
Play and threads are unavailable. Back to live restores the live camera.

Snapshots include the manifest and local folder files, skipping hidden entries,
node_modules, symlinks and files over 5 MiB. If the folder exceeds 50 MiB, a
partial snapshot keeps only manifests and frame sources within that cap; assets
may be missing. History expires with the artifact registration.

Each frame label's ⤓ menu offers Download HTML (the source file only, without
bundled assets) and Download PNG (the live frame at its declared size, rendered
at 2× resolution). PNG requires the daemon's managed Chromium; missing-browser
errors explain how to install or configure it. PNG is available in Live; HTML
can also be downloaded from a snapshot. Export omits the canvas frame script.

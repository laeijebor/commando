---
name: canvas
description: Use when laying out multiple HTML mockups as frames in a Commando canvas tab for visual comparison, ticket sections, variants, and author notes.
argument-hint: <screens or variants to lay out>
---

# Agent canvas

Use a canvas for a spatial board of screens, flows or alternatives. Use a
redline document for a linear plan, report or proposal that needs prose and
review of document elements. Canvas displays inert frames with a label overview; Play mode and
comment pins arrive in later milestones. Do not imply
that an Interactive badge enables interaction yet.

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
  ▶ Interactive) from a Static reference. Frames stay inert until Play mode is implemented.
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
`data-canvas-goto` declares future Play navigation to a frame id.

```html
<div data-canvas-group="Accounts">
  <button data-canvas-label="Outlook row" data-canvas-group="Accounts"
          data-canvas-id="account-outlook" data-canvas-goto="accounts">
    Outlook
  </button>
</div>
```

## Edit and collect feedback

Editing files live-reloads the open tab. Never close/reopen it to refresh.
A frame HTML change reloads that frame; asset changes reload all frames;
manifest edits re-layout while preserving unchanged iframe ids and sources.
Frames run with `sandbox="allow-scripts"` without same-origin access.

Keep the printed webPaneId. Read the shared feedback journal as with redline:

```bash
scripts/commando-feedback <webPaneId>
scripts/commando-feedback <webPaneId> --wait 30
```

The script tracks its acknowledgement cursor automatically. Poll while awaiting feedback; use its selector and notes to edit the source,
then keep the tab open for the next review. Canvas pins and the frame review
bridge arrive in M2b. The Threads tab currently shows “No comments yet”.

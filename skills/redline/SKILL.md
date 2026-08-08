---
name: redline
description: Use when the user invokes /redline, or asks to review, annotate, mark up, or redline something visual in a Commando tile — a plan, mock, diagram, comparison, report, or an already-running page — and expects to click elements and send comments you then apply.
argument-hint: <what to build or show for review>
---

# Redline: reviewable artifact in a Commando tile

Show the user something visual in a chromium tile beside your pane, let them
annotate elements in the tile's review mode, and apply their notes in a loop —
the Lavish flow, native to Commando.

**REQUIRED SUB-SKILL:** show-in-commando — it owns tile mechanics (open/close,
auth, CDP endpoint, feedback polling, failure modes). This skill only adds the
redline workflow around it. If Commando is unavailable per that skill's
availability checks, say so and deliver the content in chat instead.

## 1. Get a URL

- **Args name a running page** (dev server, storybook, report): use that URL.
- **Otherwise author an artifact**: write a single self-contained HTML file to
  `.redline/<topic>.html` in the working directory (committed or not — user's
  repo conventions decide). Structure it for annotation: every logical section
  gets a stable `id`, so a note's `selector` maps straight to an edit point.
  Prevent horizontal overflow at every nesting level. Prefer inline SVG or
  server-rendered content — no CDN dependencies beyond the daemon's own kit
  (below).
- **Serve it via the daemon** — no port picking, no separate server process:
  `scripts/commando-serve .redline` (from a commando repo checkout), or
  directly:

  ```bash
  curl -sS -X POST -H "Authorization: Bearer $(cat ~/.commando/agent-hook-token)" \
    -H 'Content-Type: application/json' \
    -d "{\"dir\":\"$PWD/.redline\"}" \
    "http://127.0.0.1:${COMMANDO_PORT:-4310}/api/redline/artifacts"
  ```

  The response's `url` (with the artifact filename appended) is the tile URL.
  Registrations persist across daemon restarts (same directory keeps the same
  id and URLs, expiring after 7 days). If an artifact URL 404s anyway (dir
  moved or expired), just re-register — the same directory gets its old id
  back while the registration is alive.
- **Design, in priority order:**
  1. The user named a look — use it.
  2. Otherwise, inspect the subject project and match its design system.
  3. Otherwise, use the daemon-served kit — local, no CDN, works offline:

     ```html
     <link rel="stylesheet" href="http://127.0.0.1:4310/redline/design/daisyui.css">
     <link rel="stylesheet" href="http://127.0.0.1:4310/redline/design/daisyui-themes.css">
     <script src="http://127.0.0.1:4310/redline/design/tailwind.js"></script>
     ```

     (substitute `$COMMANDO_PORT` if set).

## Ready-made review controls (response queuing)

Load the SDK once: `<script src="http://127.0.0.1:4310/redline/sdk.js"></script>`
(substitute `$COMMANDO_PORT` if set). Components inject their own glass-panel
"Aura" styling and adapt to dark/light artifacts automatically — no design
kit needed for their appearance; override the accent by setting
`--redline-accent` / `--redline-accent2` on `:root`. Five custom elements,
one line each:

```html
<redline-choice key="plan" prompt="Which plan should we build?" options="Starter,Pro,Enterprise"></redline-choice>
<redline-approve key="hero" prompt="Hero section direction ok?"></redline-approve>
<redline-rating key="vibe" prompt="How close is the visual style?" max="5"></redline-rating>
<redline-ask key="naming" prompt="Better name for this feature?"></redline-ask>
<redline-question key="config" prompt="Tune the defaults">
  <label>Poll seconds <input name="poll" value="30"></label>
</redline-question>
```

Discipline the agent must know:
- Interacting with a control (checking a box, typing) only updates local
  state — nothing sends yet.
- The explicit **"Queue answer"** button queues, once per press.
- Queued answers land in the tile's pill strip next to annotations and only
  reach you when the user presses **Send** in the tile footer.
- Re-answering with the same `key` replaces the unsent one instead of adding
  a duplicate.
- For a custom control, call
  `window.redline.queueResponse({question, answer, data?, queueKey?, element?})`
  directly.

Notes that carry a component answer have a `response: {question, answer,
data?}` field — prefer it over parsing `comment`.

Use controls for decisions the user can make faster by clicking than typing;
use plain annotation for open-ended feedback (lavish's rule).

## Playbooks

Read the playbook that matches what you're building — before writing artifact
HTML, not after — from this skill's own directory:

| playbook | use when |
|---|---|
| `playbooks/diagram.md` | flows, architecture, state, sequences |
| `playbooks/comparison.md` | options, tradeoffs, current vs target |
| `playbooks/table.md` | dense records needing scan-friendly review |
| `playbooks/code.md` | source, patches, diffs, before/after code |
| `playbooks/plan.md` | product/technical plan for review |
| `playbooks/input.md` | collecting decisions/choices/triage from the user |

## 2. Open for review

Open the URL as a tile per show-in-commando with `"engine":"chromium"` —
review mode is chromium-only. Save the `webPaneId`. Then tell the user, in
one short message: what you built, what to look at first, and that the
**"Review this page"** toggle in the tile header starts annotation
(click an element → comment → Send).

## 3. The loop

1. Long-poll for notes in a background task (`scripts/commando-feedback
   <webPaneId>` in the commando repo, else the skill's curl). Empty notes
   after ~30s is normal — re-poll. Keep doing other queued work meanwhile.
   Delivery is at-least-once: notes are journaled daemon-side until acked
   (the script handles acking via the response `cursor`), so a killed or
   timed-out poll loses nothing — re-polling recovers the same notes; dedupe
   by note `id` if you see repeats.
2. For each note `{selector, tag, text, rect, comment, pageUrl}`: edit the
   artifact section (or the real source behind the running page) that the
   selector points at.
3. Make revisions visible: for an authored artifact, reload the tile over its
   CDP endpoint — `Page.navigate` to the same URL with a `?v=<n>` cache-bust
   — rather than deleting and reopening the tile. For a dev-served page,
   hot reload usually handles it. (Artifact responses are `no-store`, so a
   plain tile reload already shows edits — the cache-bust is harmless, not
   required.)
4. A note may be a component answer instead of an annotation — it carries a
   `response: {question, answer, data?}` field. Acknowledge it in your
   terminal reply the same way you acknowledge annotation notes.
5. Reply in your terminal with what changed per note, then re-poll.

## 4. Stop

- 404 from the feedback poll = the review ended AND nothing is left unread
  (a closed tile keeps serving unacked notes until you've fetched them):
  stop polling.
- When the user says it's done: close the tile you opened, unregister the
  artifact dir (`scripts/commando-serve --stop <id>`), and give the absolute
  path of the final artifact — the tile and registration are session
  plumbing; the artifact file is the deliverable and stays.

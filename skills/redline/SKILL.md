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
  Match the subject project's design system when mocking its UI; otherwise
  keep styling minimal and legible. Prevent horizontal overflow at every
  nesting level. Prefer inline SVG or server-rendered content — the tile is a
  plain localhost page, no CDN dependencies.
- Serve the artifact directory in a background task:
  `python3 -m http.server <port> --bind 127.0.0.1 --directory .redline`
  Pick a free high port (e.g. 4xxxx range); never 4310 (daemon) or the
  project's own dev ports.

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
2. For each note `{selector, tag, text, rect, comment, pageUrl}`: edit the
   artifact section (or the real source behind the running page) that the
   selector points at.
3. Make revisions visible: for an authored artifact, reload the tile over its
   CDP endpoint — `Page.navigate` to the same URL with a `?v=<n>` cache-bust
   — rather than deleting and reopening the tile. For a dev-served page,
   hot reload usually handles it.
4. Reply in your terminal with what changed per note, then re-poll.

## 4. Stop

- 404 from the feedback poll = tile closed by the user: stop polling, treat
  the review as ended.
- When the user says it's done: close the tile you opened, kill the artifact
  server, and give the absolute path of the final artifact — the tile and
  server are session plumbing; the artifact is the deliverable and stays.

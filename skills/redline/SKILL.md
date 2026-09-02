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
- **Otherwise author an artifact**: write an HTML entry point to
  `.redline/<topic>.html` in the working directory (committed or not — user's
  repo conventions decide). If faithful rendering needs project fonts, images,
  screenshots, or other local assets, copy them into a sibling
  `.redline/<topic>/` directory and reference them relatively. Structure the
  artifact for annotation: every logical section gets a stable `id`, so a
  note's `selector` maps straight to an edit point. Prevent horizontal overflow
  at every nesting level. Prefer local assets, inline SVG, or server-rendered
  content — no remote CDN dependencies beyond the daemon's own kit (below).
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
## Design source gate (required before writing HTML)

Decide the visual source in this strict order. Do not move to the next option
until the current one genuinely yields no evidence:

1. If the user named a look or design system, use it.
2. Otherwise, **inspect the subject project before authoring**. The subject may
   differ from the current working directory. Read the actual theme/Tailwind
   config, CSS variables, shared component styles, font setup, icons/assets,
   and representative screens. Reuse exact values and behavior rather than
   approximating them from memory. This step is complete only when you can name
   the files or running screens that supplied the visual evidence.
3. Only when the artifact is not representing an existing product, or the
   subject truly has no visual system, choose a deliberate new art direction.
   Define its typography, palette, spacing, component grammar, and interaction
   states explicitly. Do not present a generic wireframe as a faithful product
   mockup.
4. Use Commando's default artifact theme only as **document chrome** when none
   of the above supplies styling for the explanatory document. It is a local,
   responsive fallback for prose, tables, code, and review controls:

     ```html
     <html lang="en" data-redline-theme="commando">
     <head>
       <meta name="viewport" content="width=device-width, initial-scale=1">
       <link rel="stylesheet" href="http://127.0.0.1:4310/redline/design/default.css">
       <!-- Put artifact-specific CSS after this link. -->
     </head>
     <body>
       <div class="redline-layout">
         <redline-nav
           eyebrow="Project or ticket"
           heading="Artifact title"
           summary="One sentence explaining the decision."
           status="Ready for review"
         ></redline-nav>
         <main class="redline-shell redline-stack">
           <section id="summary" data-redline-section data-redline-label="Summary" class="redline-panel">
             <h2>Summary</h2>
             <p>...</p>
           </section>
           <section id="details" data-redline-section data-redline-label="Details" class="redline-panel">...</section>
         </main>
       </div>
       <script src="http://127.0.0.1:4310/redline/sdk.js"></script>
     </body>
     ```

     (substitute `$COMMANDO_PORT` if set). Useful classes include
     `redline-panel`, `redline-grid`, `redline-card`, `redline-callout`,
     `redline-badge`, `redline-metric`, `redline-table-wrap`, `redline-code`,
     `redline-diff-add`, `redline-diff-del`, and `redline-button`. The theme is
     scoped behind `data-redline-theme="commando"` and lives in a low-priority
     CSS layer; normal artifact styles loaded after it win. Do not load it on
     an existing running/project-styled page.

     Every document using this fallback must use the `redline-layout` +
     `<redline-nav>` shell, even when it has only a few sections. Give each
     logical section a stable `id`, `data-redline-section`, and a short
     `data-redline-label`; the component builds the left-hand structural links
     and highlights the current section. On narrow tiles it becomes a compact
     horizontal navigator that pins to the top of the tile while the header
     scrolls away. Omit the component only when matching an existing project's
     own navigation/design system.

     Tailwind and DaisyUI remain available for an authored fallback artifact
     that genuinely needs their utilities/components, but do not load them by
     default because their global resets add noise and can obscure the subject:

     ```html
     <link rel="stylesheet" href="http://127.0.0.1:4310/redline/design/daisyui.css">
     <link rel="stylesheet" href="http://127.0.0.1:4310/redline/design/daisyui-themes.css">
     <script src="http://127.0.0.1:4310/redline/design/tailwind.js"></script>
     ```

### Product UI is not document chrome

If the artifact previews, proposes, or compares product UI, read
`playbooks/mockup.md` in addition to every other applicable playbook. The
default theme may frame the explanation around a preview, but it must never be
the design source for the product surface itself. Scope the product CSS so it
uses the subject's own tokens, typography, assets, density, and states rather
than inheriting the fallback body's styles.

When showing current UI, capture and embed the real running page or screenshot
instead of rebuilding it from prose. When showing a proposed change, start from
that real state or a source-faithful replica and change only what the proposal
requires. If an exact source is unavailable, label the result as a concept and
state the chosen art direction; never imply that an invented miniature is a
faithful rendering.

## Structural navigation

`<redline-nav>` is provided by `/redline/sdk.js`. Its `eyebrow`, `heading`,
`summary`, `status`, optional `status-tone="warn|danger"`, and optional
`label` attributes define the navigation header. It discovers
`[data-redline-section][id]` elements after the document is ready; link text
comes from `data-redline-label`, then the section heading, then its id. Keep
labels short and ordered exactly like the document. The first/current visible
section receives `aria-current="location"` automatically, and the component
scrolls that link into view when it has drifted out of the rail or the pinned
top strip — so a long document never leaves the reader without their place.

## Discussion tracks

When one artifact holds several distinct conversations — requirements plus
deep dives like backend architecture and UI — give each topic a
`data-redline-track` and drop in the strip:

```html
<redline-tracks default="requirements" label="Discussions"></redline-tracks>

<section id="auth" data-redline-section data-redline-track="backend"
         data-redline-track-label="Backend" data-redline-status="open"> … </section>
<section id="log" data-redline-section data-redline-track="requirements"
         data-redline-track-all> … </section>
```

The strip renders one tab per track in document order, badged with that
track's open-question count, and switches which sections show. A section
marked `data-redline-track-all` (the decision log) stays visible on every
tab, and `<redline-nav>` follows the active track so it never links to a
section the user cannot see. Hidden tracks stay in the DOM, so a review note
captured on one tab still resolves by selector after the user switches.

`data-redline-track-label` on any section names its track; without one the
raw track key is shown. Read `playbooks/iteration.md` for when to split a
discussion into tracks at all.

## Image lightboxes

Wrap review screenshots in `<redline-lightbox>` so they can be focused without
losing their authored context. Keep the ordinary `figure` / `figcaption`
structure; the component copies the nearest figure caption into its modal:

```html
<figure>
  <redline-lightbox>
    <img src="expanded.png" alt="Expanded whole-session update sheet">
  </redline-lightbox>
  <figcaption>
    <strong>Expanded: whole-session handoff</strong>
    <p>The sheet overlays upward and preserves source pane IDs.</p>
  </figcaption>
</figure>
```

Click the image or focus it and press Enter/Space. The modal offers fit and
intrinsic-size views, includes the caption, and cycles every
`<redline-lightbox>` on the page in document order with Previous/Next buttons
or Left/Right Arrow keys. Escape or Close dismisses it and restores focus. For
a simple image without a figure, provide a short `caption` attribute instead.

## Ready-made review controls (response queuing)

Load the SDK once: `<script src="http://127.0.0.1:4310/redline/sdk.js"></script>`
(substitute `$COMMANDO_PORT` if set). Components inject their own glass-panel
"Aura" styling and adapt to dark/light artifacts automatically — no design
kit needed for their appearance; override the accent by setting
`--redline-accent` / `--redline-accent2` on `:root`. Five response controls,
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

The compact `options="Starter,Pro,Enterprise"` form is only for labels that do
not contain commas. If any label contains a comma, pass the entire option list
as a JSON array and wrap the HTML attribute in single quotes so each label stays
intact:

```html
<redline-choice key="set" prompt="Which set?" options='["Ten — Pulse, Crest, Kiln, Ridge (recommended)","Twelve — all six"]'></redline-choice>
```

Discipline the agent must know:
- Interacting with a control (checking a box, typing) only updates local
  state — nothing sends yet.
- The explicit **"Queue answer"** button queues, once per press.
- Every built-in control includes an optional note field. The answer and note
  remain separate in the structured response.
- Queued answers land in the tile's compact queue strip next to annotations
  and only reach you when the user presses **Send all** or **Send this**.
- Re-answering with the same `key` replaces the unsent one instead of adding
  a duplicate.
- The daemon rehydrates queued values after page reload. A green `Queued ✓`
  means the local draft matches the daemon; amber `Changed since queued`
  means the user must update the queued answer before it is sent. Controls
  without a key use their captured selector as a best-effort fallback.
- The queue drawer can edit answers and notes, attach PNG/JPEG/GIF/WebP images,
  preview/remove attachments, and send one answer without sending the rest.
- While review mode is active, queued selector-based notes stay highlighted on
  the live page. Click a highlight to edit or send that answer/comment in an
  anchored popover; use **Open full queue** there for attachments or removal.
- For a custom control, call
  `window.redline.queueResponse({question, answer, note?, data?, queueKey?, element?})`
  directly.
- A question the user has answered should be rewritten as settled rather than
  left live: `<redline-choice key="plan" resolved answer="Pro"
  answered-in="Round 2" note="…">` renders the recorded answer plus a
  **Reopen** button that restores the live control pre-filled. Add `locked` to
  drop the Reopen button. Multi-select answers keep the queued `"A, C"` form
  and render one chip per value.

Notes that carry a component answer have a `response: {question, answer,
note?, data?}` field — prefer it over parsing `comment`.

Use controls for decisions the user can make faster by clicking than typing;
use plain annotation for open-ended feedback (lavish's rule).

## Playbooks

Read **every** playbook that matches what you're building before writing
artifact HTML, not after. A plan containing a UI proposal requires both the
plan and mockup playbooks; a mockup comparison also requires comparison.

| playbook | use when |
|---|---|
| `playbooks/diagram.md` | flows, architecture, state, sequences |
| `playbooks/comparison.md` | options, tradeoffs, current vs target |
| `playbooks/table.md` | dense records needing scan-friendly review |
| `playbooks/code.md` | source, patches, diffs, before/after code |
| `playbooks/plan.md` | product/technical plan for review |
| `playbooks/mockup.md` | current or proposed product UI, screens, components, states |
| `playbooks/input.md` | collecting decisions/choices/triage from the user |
| `playbooks/iteration.md` | second round onward: settled vs live content, resolved controls |

## 2. Open for review

Open the URL as a tile per show-in-commando with `"engine":"chromium"` —
review mode is chromium-only. Save the `webPaneId`.

### Actual-tile quality gate

Before inviting the user to review, attach to that tile through its CDP
endpoint and inspect the page at the viewport the user is actually seeing:

1. Capture a screenshot of the full page and the first review viewport. Do not
   approve the artifact from HTML source alone.
2. Check console/runtime errors, broken images/fonts, horizontal page overflow,
   clipped controls, overlapping text, and empty or obviously placeholder UI.
3. For product UI, compare the screenshot against the inspected source screen,
   tokens, and component density. Product text and controls must remain legible
   at the tile width. Render previews at 1:1 scale when practical; if a scaled
   overview is necessary, label the scale and provide a focused full-size view
   or lightbox. Never shrink a whole phone/desktop into an illegible ornament.
4. Exercise the narrow layout and any interaction the review depends on. A
   responsive document is not enough if the embedded product mockup itself
   collapses poorly.
5. Fix and reload the same tile until these checks pass. If fidelity cannot be
   verified, say exactly what evidence is missing instead of calling it ready.

Then tell the user, in one short message: what you built, which design source
you used and why, what to look at first, and that the **"Review this page"**
toggle in the tile header starts annotation (click an element → comment →
Send).

## 3. The loop

1. Start a continuous long-poll loop in a background task
   (`scripts/commando-feedback <webPaneId>` in the commando repo, else the
   skill's curl). Empty notes after ~30s are heartbeats, not completion, so
   immediately re-poll. Keep the loop alive until the user ends review or the
   endpoint returns 404; if the task runner times out, restart it while review
   is active. Do not claim to be watching for notes unless a poll is actually
   running. Delivery is at-least-once: notes are journaled daemon-side until
   acked (the script handles the response `cursor`), so re-polling recovers
   unread notes. Correlate review identity by `reviewKey`, then `deliveryKey`,
   then note `id`; this ordering keeps pre-upgrade retries deduplicated. Track
   `reviewRevision`, treating an absent value as baseline revision 1. For the
   same review identity, the highest revision is authoritative and must supersede
   older review content or attachments. A new note with the same revision only
   updates delivery intent: do not apply its review edit twice, but do process
   the new `handoff`.
2. For each note `{selector, tag, text, rect, comment, pageUrl, reviewKey?, reviewRevision?, attachments?, handoff?}`:
   edit the
   artifact section (or the real source behind the running page) that the
   selector points at.
   From the second round onward this is not just an edit — read
   `playbooks/iteration.md` and apply it: mark the section's
   `data-redline-status`, stamp `data-redline-changed`, rewrite every answered
   control as `resolved` with the answer you received, fold the previous
   exchange into that topic's thread, and mirror the decision into the log.
   An answered question left live and empty makes the user answer it twice.
   Each attachment has `{name, contentType, size, path}`. Fetch every needed
   `path` with the agent hook bearer token before the next poll acknowledges
   that batch and releases its image bytes.
3. Make revisions visible: for an authored artifact, reload the tile over its
   CDP endpoint — `Page.navigate` to the same URL with a `?v=<n>` cache-bust
   — rather than deleting and reopening the tile. For a dev-served page,
   hot reload usually handles it. (Artifact responses are `no-store`, so a
   plain tile reload already shows edits — the cache-bust is harmless, not
   required.)
4. A note may be a component answer instead of an annotation — it carries a
   `response: {question, answer, note?, data?}` field. Acknowledge it in your
   terminal reply the same way you acknowledge annotation notes.
5. If the batch carries `handoff: {kind: "build", instruction}`, the user has
   signaled that review is intended to be complete and implementation should
   begin after every note and attachment is processed. Follow the handoff:
   use `/delegate:code` when that skill is available; otherwise use the
   preferred implementation approach in the repository's `AGENTS.md`, project
   memory, or equivalent instructions. This is a strong signal, not permission
   to guess: continue review or ask the user only when material clarification
   or human judgment is still required before coding can effectively begin.
6. Reply in your terminal with what changed per note, then re-poll.

## 4. Stop

- 404 from the feedback poll = the review ended AND nothing is left unread
  (a closed tile keeps serving unacked notes until you've fetched them):
  stop polling.
- If polling stops for any other reason, immediately tell the user why and
  that you are no longer watching for notes. Never let polling lapse silently.
- When the user says it's done: close the tile you opened, unregister the
  artifact dir (`scripts/commando-serve --stop <id>`), and give the absolute
  path of the final artifact — the tile and registration are session
  plumbing; the artifact file is the deliverable and stays.

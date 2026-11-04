---
name: commando-slides
description: Show slides, a deck or a one-pager in Commando; present a topic visually in a tile beside the agent terminal.
---

# Slides in Commando

Use the portable **slides** skill for authoring. Read and follow its deck
format, themes, writing guidance and `slides check` workflow. This skill adds
Commando delivery and review; it does not replace the portable authoring skill.
A deck is a folder with deck.html, slides.css, deck.js, themes/ and local assets.

## Open once

From the owning tmux pane:

```bash
{{COMMANDO_REPO}}/scripts/commando-slides /absolute/deck-folder
# Custom HTML filename (including an A4 one-pager):
{{COMMANDO_REPO}}/scripts/commando-slides /absolute/deck-folder onepager.html
```

The script prints the webPaneId. Retain it for feedback and spotlight.
Scripts live in the Commando repo checkout, not the deck folder.
Auth uses the agent hook token at
`${COMMANDO_AGENT_HOOK_TOKEN_PATH:-$HOME/.commando/agent-hook-token}`;
`COMMANDO_PORT` defaults to 4310. Slides are canvases whose manifest is HTML,
so existing canvas feedback, history and the answer queue apply.

## Review and questions

Read feedback while review is active:

```bash
{{COMMANDO_REPO}}/scripts/commando-feedback <webPaneId> --wait 30
{{COMMANDO_REPO}}/scripts/commando-slides threads <webPaneId>
{{COMMANDO_REPO}}/scripts/commando-slides reply <webPaneId> <threadId> "Updated the chart" --resolve
{{COMMANDO_REPO}}/scripts/commando-slides resolve <webPaneId> <threadId>
```

Keep polling the shared feedback journal, acknowledging its cursor on the next
poll. Read attachments before acknowledging. Thread comments retain the slide
id and frame-local point. Reply in the thread when the requested change is done.

Ask decisions on their slide:

```html
<aside class="ask" data-key="lead"
  data-options='["The symptom (recommended)","The fix"]'>Which opening?</aside>
```

Follow the portable format limits: question text ≤256 characters, stable unique
keys, 1–50 options if present, `data-multiple` for several choices. Without
options the card takes free text. Answers use the existing answer queue:
queued, sent, then answered when recorded. They arrive with
`selector: [data-canvas-note="ask-<key>"]` and a response containing the
question, answer and optional note. Record the received answer in `data-answer`
on that same aside. Preserve it when editing the slide; remove it and update
the prompt to ask a new question.

## Direct attention

Label meaningful elements with `data-canvas-label` and stable `data-canvas-id`.
Use slide ids from the deck for `--frame`:

```bash
{{COMMANDO_REPO}}/scripts/commando-slides spotlight <webPaneId> "Evidence chart" --frame evidence --message "Rebuilt with the new data"
```

The toast's Show me action opens that slide and highlights its label.

## Live editing, themes and exports

Just edit deck.html and assets. The open tab reloads and keeps the current slide
when its id still exists. Never reopen the deck to refresh it.

The theme menu previews `themes/*.css` without editing the deck. The user's
preview is remembered locally. To change the authored default, edit the deck's
`<link id="theme" href="themes/<name>.css">`. A brand-theme request arrives as
queued feedback; use its source to author another portable theme file.

Present uses fullscreen with arrows/space to navigate and Esc to exit.
History opens saved rounds read-only. The Export menu downloads PDF, PPTX,
current-slide PNG or a self-contained HTML. All exports need the portable
slides CLI installed and `npm install` run once in its folder; Chromium must
also be installed. `COMMANDO_SLIDES_CLI` can point to its slides.mjs entrypoint.
PPTX v1 uses one picture per slide with speaker notes. PNG downloads the current
slide rendered by the CLI; exporting every slide as a zip is not available yet.
Publishing to an evidence gallery is not available yet.

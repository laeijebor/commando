---
name: commando-ui
description: How to write replies that Commando's chat renders richly: inline images and SVG, clickable file and folder cards, Mermaid and pr-diagram diagrams, and interactive commando-ui blocks (choice, approve, checklist, table, stats). Use when a reply would be clearer with an image, a diagram, linked files, a structured table or status list, or when you need the user to pick between options or approve something.
---

# Writing for the Commando chat

Commando's chat renders your reply's Markdown with its own components. You never
send HTML or code: you write plain Markdown conventions and Commando draws them.
Everywhere else (GitHub, a terminal, another viewer) the same text still reads
as ordinary Markdown, so nothing breaks.

Use these only when they help. A short answer stays a short paragraph.

## Images

`![caption](/absolute/path/to/image.png)` shows the image inline. PNG, JPEG, GIF,
WebP and SVG work; an SVG animates. Use it for screenshots, renders, charts and
diagram files the user should see. A path in plain text or backticks is not an
image. Use absolute paths, or paths relative to the working folder.

## Files and folders

- `[label](path)` becomes a clickable card or chip that opens the file or folder.
- A backticked path such as `` `src/chat/ChatTimeline.tsx` `` becomes a chip when
  the path exists. Prefer a real path over describing where something is.
- Add a line with `:line` or `#L42`: `[the handler](server/api.ts:120)` or
  `` `server/api.ts#L120` `` opens at that line.
- A list where **every** item starts with a path (link or backticked) becomes a
  card list, with the rest of the item as its description:

  ```markdown
  - `server/api.ts`: the new endpoint
  - [src/chat/Card.tsx](src/chat/Card.tsx): the card component
  ```

  One item without a leading path keeps it as an ordinary list.

Paths that do not exist stay plain text, so do not guess them. Links to URLs are
clickable too; write them bare or as `[Preview](http://127.0.0.1:4330/page)`,
not in backticks.

## Diagrams

- ` ```mermaid ` renders a Mermaid diagram (flowchart, sequence, state, ER).
  Good for small structural sketches. Keep it under about 15 nodes.
- ` ```pr-diagram ` takes JSON and Commando renders it as an animated diagram.
  This fence is new and ships in a parallel change, so an older Commando may show
  it as plain code. If the fence shows as code, fall back to rendering an SVG
  file with the `pr-diagram` skill and show it with `![caption](path.svg)`.

## Interactive blocks: ` ```commando-ui `

The fence holds JSON, either one object or an array of up to 8. Each block is
`{ "component": <name>, "id"?: string, ...props }`. The catalog is fixed. Anything
else (an unknown component, bad JSON, wrong props or over-long text) is shown as a
plain code block with an "Invalid commando-ui block" note, so check the shape.

### `choice`: pick one option, or several

`{ prompt, options: string[2..8], multiple?: boolean }`. One click sends the answer
for a single choice; with `multiple` the user toggles options and presses Send.

```commando-ui
{ "component": "choice", "id": "archive-storage", "prompt": "Archive storage",
  "options": ["SQLite in ~/.commando (recommended)", "JSONL per session", "Keep both for one release"] }
```

The user's pick arrives as your next message: `Archive storage: SQLite in ~/.commando (recommended)`
(several picks are joined with `, `).

### `approve`: a go / no-go decision with an optional note

`{ prompt, approveLabel?, rejectLabel? }`.

```commando-ui
{ "component": "approve", "prompt": "Ship the migration", "approveLabel": "Ship it", "rejectLabel": "Hold" }
```

It arrives as `Approved: Ship the migration`, or `Rejected: Ship the migration — note: <their note>`.

### `checklist`: read-only status

`{ title?, items: { label, done? }[] }`. Shows progress; it cannot be ticked.

```commando-ui
{ "component": "checklist", "title": "Rollout", "items": [
  { "label": "Build passes", "done": true }, { "label": "Staging deploy", "done": true }, { "label": "Production deploy" } ] }
```

### `table`: compact data

`{ columns: string[], rows: (string|number)[][] }`. Up to 50 rows shown (more are
cut with a note); each row must have one cell per column. Wide tables scroll
sideways. Cells are plain text.

```commando-ui
{ "component": "table", "columns": ["Package", "Before", "After"],
  "rows": [["react", "18.3", "19.1"], ["vite", "5.4", "6.0"]] }
```

### `stats`: a row of metric tiles

`{ items: { label, value, delta?, tone?: "good" | "bad" | "neutral" }[] }`.

```commando-ui
{ "component": "stats", "items": [
  { "label": "Tests", "value": 1204, "delta": "+18", "tone": "good" },
  { "label": "Bundle", "value": "412 kB", "delta": "+6 kB", "tone": "bad" } ] }
```

## When to use what, and when not to

- **Choose the lightest form.** Plain prose or a Markdown list first. A table
  block for real tabular data, stats for a handful of headline numbers, a
  checklist for progress on steps. Do not wrap a trivial answer in a widget.
- **At most one interactive block (`choice` or `approve`) per reply**, and put it
  last. Wait for the answer before moving on.
- **Never ask the same question twice.** If a `choice` or `approve` block carries
  the question, do not repeat it in prose; one lead-in sentence is enough.
- Keep prompts and option labels short and self-explanatory, with the
  recommended option first and marked `(recommended)`.
- Interactive answers come back as ordinary user messages, so treat them as
  such. A block that was already answered stays settled.
- Do not use a block when the user needs free-form text (ask in prose), or when
  the reply will be read outside Commando (a commit message, a PR description).
- Use images and file links for things the user should look at or open, not to
  decorate. Do not list every touched file as cards; link the few that matter.

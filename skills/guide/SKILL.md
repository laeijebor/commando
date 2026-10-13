---
name: guide
description: Use when the user has to carry out a multi-step manual procedure themselves (dashboard clicks, secret rotation, deploy/merge runbooks, release checklists, device setup) — write it as a tickable Markdown guide and open it in a Commando side-panel tab, so the user can tick steps, add notes and send progress back to you.
argument-hint: <procedure the user needs to follow>
---

# Guides in Commando

A guide is a Markdown file that Commando renders as a tab beside your pane. Every
`- [ ]` item and `<checkpoint>` tag is a step that the user can tick and annotate
as they work. Each code block gets a copy button. When the user presses **Update
agent**, Commando pastes a summary of what changed (ticks, unticks and notes) into
your pane once you are idle. If you are mid-turn it waits until you are free.

Write a guide, not a chat message, whenever the user has to perform the steps.
Use a redline document for something the user only reviews. Use plain chat for a
single command.

## Write it

Put each guide in its own folder. The whole folder is served and watched, and
the CLI refuses repo roots.

```
.guides/stripe-webhooks.md
```

Format: GitHub-flavoured Markdown, plus these tags:

````markdown
# Stripe webhook rollout            ← the first H1 becomes the tab title

## Phase 1: legacy webhook secrets

<callout tone="warn" title="Before you merge #527">

These keep live legacy billing (78 subscriptions) working once the signature check is on.

</callout>

1. **Get the platform signing secret.**
   - [ ] Stripe → Live mode → Workbench → Webhooks → `graphql.vivi.fit/stripe/hooks` → Reveal → copy {#copy-platform}
2. **Store it in Doppler.** This keeps it out of your shell history.
   - [ ] Store the platform secret in Doppler: {#store-platform}

     ```sh
     pbpaste | doppler secrets set STRIPE_PLATFORM_WEBHOOK_SECRET --project fitliness-database --config prod_railway
     ```
   - [x] Railway sync is configured (I checked) {#railway-sync}

<checkpoint id="phase-1">Phase 1 done — both secrets match</checkpoint>
````

- **Steps** are task items: `- [ ] text`. Add a trailing `{#id}` (letters,
  digits, `-`, `_`) to give a step a stable id. Without one, the id is a slug of
  the text, and rewording the step resets its tick. Write `[x]` for steps you
  have already done or verified yourself; they render as done ("agent").
  The step text is the step's name in your updates, so make it say what the
  step does ("Store the secret in Doppler:", not "Run:").
- **`<checkpoint id="…">label</checkpoint>`** is a highlighted step. Use it where
  you want the user to report back ("phase 1 done"), instead of writing "tell me
  X". Add `done` (`<checkpoint id="x" done>`) once you have verified it.
- **`<callout tone="info|warn|danger|success" title="…">`** marks a warning or
  context. Leave a blank line after the opening tag and before the closing tag,
  otherwise the Markdown inside is not rendered.
- `<details><summary>…</summary>…</details>`, `<kbd>`, tables, images with
  relative paths inside the folder, and links all work.
- Put each command in its own fenced block so that it copies cleanly.
  Never put secret values in a guide. Point at where the secret lives instead.
- Scripts, styles, event handlers and other raw HTML are stripped. A guide is
  content, not an app.

## Open it

Run this from your own tmux pane. The script lives in the Commando repo
checkout, two levels up from this skill (`<commando>/scripts/commando-guide`):

```bash
/path/to/commando/scripts/commando-guide .guides/stripe-webhooks.md   # prints webPaneId
```

Running it again for the same file focuses the existing tab. Tell the user
you opened it beside your pane.

## While the user works

- **Updates arrive in your pane** as a prompt that starts with `Guide update
  from the user:`. It lists the steps ticked (✓), checkpoints reached (★), steps
  unticked (↺) and notes. Act on each one: verify the result where you can (for
  example with read-only queries, logs or `gh`), and answer any note that asks
  something.
- **Read the full state** at any time:

  ```bash
  /path/to/commando/scripts/commando-guide state <webPaneId>          # readable
  /path/to/commando/scripts/commando-guide state <webPaneId> --json
  ```

- **Respond by editing the guide file.** The tab re-renders live and keeps the
  user's ticks by step id. Mark the steps you verified `[x]`, mark a reached
  checkpoint `done`, and add a `<callout tone="success">` with what you checked
  or a `tone="danger"` callout when something is wrong. Then add or reorder
  the next phase. Keep the ids of existing steps.
- The user's own ticks and notes override your `[x]`. Never ask them to re-tick
  something because you changed the wording; keep the `{#id}` instead.
- Close the tab when the procedure is finished:
  `commando-guide close <webPaneId>`. Keep the file; it is the record of what
  happened.

## Raw HTTP

The scripts wrap these endpoints on `http://127.0.0.1:${COMMANDO_PORT:-4310}`.
Every call takes `Authorization: Bearer $(cat ~/.commando/agent-hook-token)`.

1. `POST /api/redline/artifacts` `{"dir":"/abs/.guides"}` returns `{id, url}`.
2. `POST /api/web-panes` `{"url":"<url>","anchor":"$TMUX_PANE","content":{"kind":"guide","artifactId":"<id>","file":"stripe-webhooks.md"}}`
   returns `{webPaneId}`.
3. `GET /api/web-panes/<webPaneId>/guide` returns `{guide: {title, steps:
   [{id, label, checkpoint, checked, byUser, note?}], changes, waiting,
   deliveredAt?}}`.

Ticking and **Update agent** are owner-only. Agents can read the state, but
cannot tick on the user's behalf. Mark a step `[x]` in the file instead.

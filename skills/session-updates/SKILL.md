---
name: session-updates
description: Maintain a pane-local Commando worklog. Use when starting meaningful work, creating or updating a plan, making a decision, encountering a blocker, completing verification, leaving a handoff, or when the user asks for a progress summary or update.
---

# Commando pane worklogs

Keep the current tmux pane easy to re-enter throughout its session. Commando
shows provider tasks automatically and derives pane-local milestones from
lifecycle hooks. Use the shared CLI when you have a deliberate summary,
decision, blocker, note, or next action to add to the current pane's worklog.
The worklog appears automatically after its first plan or activity and keeps
completed, current, and pending tasks visible above chronological history.

## Publish an update

The CLI reads `TMUX_PANE`, the private Commando hook token, and
`COMMANDO_PORT` automatically:

```bash
$HOME/.commando/hooks/commando-session-update.mjs \
  --headline "Reconnect fix verified" \
  --update decision "Keep the terminal fallback pane-local" \
  --next "Review focus behavior, then merge"
```

Supported update kinds are `changed`, `decision`, `check`, `blocker`, and
`note`. Add `--detail "..."` immediately after `--update` when the short text
needs one compact supporting line.

Use `--recap-markdown` for short Markdown prose and `--state` for one of
`working`, `needs_input`, `done`, `failed`, `stale`, or `unknown`. Use
`--clear-next` when the previous next action is complete and there is no new
one yet.

For multiline Markdown or several fields, send one JSON object over stdin:

```bash
$HOME/.commando/hooks/commando-session-update.mjs --stdin <<'JSON'
{
  "headline": "Handoff ready",
  "recapMarkdown": "Fixed the reconnect drift and verified **184 tests**.",
  "update": {
    "kind": "check",
    "text": "All repository checks passed",
    "detail": "typecheck, Vitest, and live focus flow"
  },
  "next": "Merge the verified branch"
}
JSON
```

## Content rules

- Keep the headline under one short sentence.
- Keep the agent's task list current so Commando can render checked, active,
  pending, and cancelled work accurately.
- Record only meaningful milestones, not every tool call. Lifecycle history is
  append-only for the tmux session, so repetitive updates become noise.
- Name a decision's consequence, not just that a decision happened.
- Use a blocker only when the user or another system must act.
- Keep exactly one current next action.
- Never include credentials, private keys, raw environment values, or terminal
  output that may contain secrets.
- Do not fail the user's task when Commando is unavailable; report the update
  failure briefly and continue the primary work.

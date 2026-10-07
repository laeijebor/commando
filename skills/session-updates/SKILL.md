---
name: session-updates
description: Maintain a pane-local Commando worklog. Use when starting meaningful work, creating or updating a plan, making a decision, encountering a blocker, completing verification, leaving a handoff, or when the user asks for a progress summary or update.
---

# Commando pane worklogs

Keep the current tmux pane easy to re-enter throughout its session. Commando
shows provider tasks when its bridge supplies structured task telemetry and
derives pane-local milestones from authenticated lifecycle hooks. Use the shared
CLI when you have a deliberate summary, decision, blocker, note, or next action
to add to the current pane's worklog.
The worklog fills in after its first plan or activity and keeps completed,
current, and pending tasks visible above chronological history when supplied.
The shared CLI has no structured tasks input. When automatic task telemetry is
unavailable, publish a short textual plan with `--recap-markdown` and one
`--next` action; this does not populate the checklist. Automatic Cursor todos
are unsupported in the current integration; use this textual-plan fallback.

The worklog handle also remains available before hook data arrives, so notes
and linked PRs are always accessible. If the worklog reports no agent hook
data, run Commando's `npm run hooks:install` on the daemon/tmux host, then restart
the agent when it is safe to do so. Running sessions may retain their old plugin
configuration.

When creating a PR, use the `commando-prs` skill: retrieve the pane marker
with `node "$HOME/.commando/hooks/commando-pr-marker.mjs"` and append it to
the PR body. Status hooks and worklog updates alone do not stamp PRs.

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

## Pin important terms

When adding or editing flagged behavior, pin the flag name. Pin a useful route
from the running stack when it helps the user return to the page without
searching the conversation. URLs open as links in the pane worklog:

```bash
$HOME/.commando/hooks/commando-session-update.mjs --feature-flag new-checkout
$HOME/.commando/hooks/commando-session-update.mjs --url http://localhost:5273/checkout --url-label "Checkout preview"
```

Publishing the same name or URL updates that entry instead of duplicating it.
Remove a stale reference with `--remove-feature-flag NAME` or `--remove-url URL`.
One reference action is accepted per call; it can accompany a headline or
milestone. With `--stdin`, send `"reference": {"action":"upsert", "kind":"feature_flag", "value":"new-checkout"}`
or use `kind: "url"` with an optional `label`. Use `action: "remove"` to unpin.
Only HTTP(S) URLs without embedded credentials are accepted. Keep these
references concise and session-relevant.

Pin an issue/ticket link, deployment preview, or build/release identifier when
it is relevant to the pane. Issue and deployment entries are clickable like
URLs; build and release IDs may optionally link to a CI run or release page:

```bash
$HOME/.commando/hooks/commando-session-update.mjs --issue https://github.com/acme/app/issues/42 --url-label "Checkout bug #42"
$HOME/.commando/hooks/commando-session-update.mjs --deployment https://preview.example.com/checkout --url-label "Checkout preview"
$HOME/.commando/hooks/commando-session-update.mjs --build build-1842 --link https://ci.example.com/build/1842
$HOME/.commando/hooks/commando-session-update.mjs --release v2.3.0
```

Use `--remove-issue URL`, `--remove-deployment URL`, `--remove-build ID`, or
`--remove-release ID` when they are no longer relevant. In `--stdin` JSON,
the corresponding `kind` values are `issue`, `deployment`, `build`, and
`release`; `url` on a build/release object is the optional link, while
`value` remains its identifier. For link kinds, `value` is the URL and
`label` is optional.

### Pin the resume command

Pin the command that restarts this conversation so the user can resume it from
the worklog after a restart or a tmux restore. The agent bridge prints the exact
command at session start when supported ("Resume command for this conversation:
..."); pin it verbatim, once per conversation. Otherwise use a confirmed
conversation ID,
never one inferred from the pane, branch, or a "latest conversation" alias.
A new `--session` replaces the previous one:

```bash
$HOME/.commando/hooks/commando-session-update.mjs --session "opencode --yolo -s ses_f08700672ffenN8gLm9kPx2xb6"
$HOME/.commando/hooks/commando-session-update.mjs --session "claudep --resume d227943a-841a-4dfa-94c7-afe2e0774487"
$HOME/.commando/hooks/commando-session-update.mjs --session "agent --resume=d227943a-841a-4dfa-94c7-afe2e0774487"
```

Claude uses `claudew` or `claudep` to match the config dir in use
(`CLAUDE_CONFIG_DIR` ending `.claudew` / `.claudep`), the OpenCode bridge supplies
`opencode --yolo -s <id>`, and Codex is `codex resume <id>`. Cursor's executable
is `agent`, with `agent --resume=<actual-conversation-id>`; replace the example
UUID with this conversation's real ID. Do not append `--force` or `--yolo` to
Cursor commands by default: those flags change approval policy. Cursor's
[CLI parameters](https://cursor.com/docs/cli/reference/parameters) document
resume and approval flags. Resume from the conversation's original checkout
or worktree. Exact-ID Cursor resume retained conversation context without a
fresh `sessionStart` in native acceptance; prompt hooks re-established activity.
Do not depend on newly injected startup context when resuming.
Clicking the term types the command
into the pane without pressing Enter; a separate button copies it. Only plain
words are accepted (no quotes, `;`, `&`, `|`, `$`, backticks or newlines), up to
300 characters. Remove it with `--remove-session COMMAND`.

Saved history after a tmux restore remains inactive until fresh authenticated
hooks reconnect it. A provider inferred from a process or pane title does not
verify restoration. Operational Cursor pane context requires a supported
foreground process with verified PID/ancestry and tmux socket association;
unsupported, background or non-tmux processes get no operational pane context.
Remote Cursor permission/question answers are unsupported in the current
integration; answer in the terminal. The completed ACP spike proves only
initialize transport with a new child, not production remote-answer support
or attachment to a live tmux process.
For multiline Cursor input through tmux or SSH, use Ctrl+J, as described
in [Cursor's CLI guide](https://cursor.com/docs/cli/using).

## Publish screenshots

Publish a screenshot round by naming its directory:

```bash
$HOME/.commando/hooks/commando-session-update.mjs \
  --screenshots "$PWD/.screenshots/<topic>"
```

The daemon creates the screenshots timeline event itself. Do not also pass
`--update` for the same publish. The flag composes with headline, recap, state,
and next-action flags when those fields genuinely changed.

Screenshot folders are scanned non-recursively for PNG, JPG/JPEG, GIF, and
WebP images. A publish scans at most 500 entries and omits images larger than
50 MiB. Republishing the same directory keeps its folder id while refreshing
its counts and previews. Published folders expire after 7 days.

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
- Keep the agent's task list current when its bridge supports structured task
  telemetry. Otherwise keep a textual plan and next action current; do not claim
  the update CLI synchronizes tasks.
- Record only meaningful milestones, not every tool call. Lifecycle history is
  append-only for the tmux session, so repetitive updates become noise.
- Name a decision's consequence, not just that a decision happened.
- Use a blocker only when the user or another system must act.
- Keep exactly one current next action.
- Never include credentials, private keys, raw environment values, or terminal
  output that may contain secrets.
- Do not fail the user's task when Commando is unavailable; report the update
  failure briefly and continue the primary work.

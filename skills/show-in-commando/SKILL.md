---
name: show-in-commando
description: Show the user a web page beside your terminal pane in Commando. Use whenever you serve or publish anything reviewable on localhost — a Lavish/HTML artifact, npx serve output, a vite/storybook/dev server, coverage or build reports, docs — or the user says "show me", "open it next to", or "in commando". Opens the URL as a tile in the Commando pane grid, anchored to the tmux pane you are running in.
---

# Show a page in Commando

Commando (the user's tmux cockpit) can render a web page as a tile in its
pane grid, right beside the tmux pane you are working in. When you have
something worth *seeing* — a served HTML page, a dev server, a report —
open it as a tile instead of only pasting a URL into chat.

## When this applies

All three must hold (otherwise just share the URL in your reply):

1. You are inside a tmux pane: `$TMUX_PANE` is set.
2. The Commando daemon is reachable on `http://127.0.0.1:${COMMANDO_PORT:-4310}`.
3. The agent hook token exists: `~/.commando/agent-hook-token`
   (or `$COMMANDO_AGENT_HOOK_TOKEN_PATH`).

## Open a tile

```bash
url="http://127.0.0.1:41300/my-page"   # must not contain double quotes
placement="auto"                        # right | below | auto
curl -sS -X POST "http://127.0.0.1:${COMMANDO_PORT:-4310}/api/web-panes" \
  -H "Authorization: Bearer $(cat "${COMMANDO_AGENT_HOOK_TOKEN_PATH:-$HOME/.commando/agent-hook-token}")" \
  -H 'Content-Type: application/json' \
  --data "{\"url\":\"${url}\",\"anchor\":\"${TMUX_PANE}\",\"placement\":\"${placement}\"}"
```

(If a checkout of the commando repo is handy, `scripts/commando-open <url>
[placement]` does exactly this.)

Response: `{"ok":true,"webPaneId":"w-…","beside":"%12","status":"open"}`.

- `status: "open"` — the tile is already visible in every connected
  Commando client. Tell the user you opened it beside your pane.
- `status: "pending"` — non-localhost origins need the user's one-click
  approval; the tile shows a confirm card. Tell the user it is waiting for
  their confirmation. Never try to confirm it yourself — confirmation is
  owner-only by design.

## Close a tile

```bash
curl -sS -X DELETE "http://127.0.0.1:${COMMANDO_PORT:-4310}/api/web-panes/<webPaneId>" \
  -H "Authorization: Bearer $(cat "${COMMANDO_AGENT_HOOK_TOKEN_PATH:-$HOME/.commando/agent-hook-token}")"
```

Close tiles you opened once they have served their purpose (e.g. the review
finished). Do not close tiles you did not open.

## Rules and failure modes

- localhost / 127.0.0.1 URLs open instantly; anything else pends for the
  user. Only `http:`/`https:` URLs are accepted.
- Prefer `placement: "auto"` (splits along the pane's longer edge);
  use `below` for short/wide content, `right` for tall content.
- At most a handful of tiles fit — open one, not one per artifact, and
  reuse it by closing the old tile before opening a replacement.
- 404 "Anchor tmux pane does not exist": your pane is not mirrored by this
  daemon — fall back to sharing the URL.
- 401 / connection refused / missing token file: Commando is not available —
  fall back to sharing the URL. Do not retry in a loop.
- 429: you are opening tiles too fast; stop and reuse the existing tile.

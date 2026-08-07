---
name: show-in-commando
description: Show the user a web page beside your terminal pane in Commando, or debug one together over CDP. Use whenever you serve or publish anything reviewable on localhost — a Lavish/HTML artifact, npx serve output, a vite/storybook/dev server, coverage or build reports, docs — or the user says "show me", "open it next to", or "in commando"; also when you want to debug a web page WITH the user (watch network requests, breakpoints, traces) — open it as a chromium-engine tile and attach Chrome DevTools Protocol to the page they are looking at. Opens the URL as a tile in the Commando pane grid, anchored to the tmux pane you are running in.
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
engine="webkit"                         # webkit (show) | chromium (debug over CDP)
curl -sS -X POST "http://127.0.0.1:${COMMANDO_PORT:-4310}/api/web-panes" \
  -H "Authorization: Bearer $(cat "${COMMANDO_AGENT_HOOK_TOKEN_PATH:-$HOME/.commando/agent-hook-token}")" \
  -H 'Content-Type: application/json' \
  --data "{\"url\":\"${url}\",\"anchor\":\"${TMUX_PANE}\",\"placement\":\"${placement}\",\"engine\":\"${engine}\"}"
```

(If a checkout of the commando repo is handy, `scripts/commando-open <url>
[placement] [--engine chromium]` does exactly this.)

Response: `{"ok":true,"webPaneId":"w-…","beside":"%12","status":"open","engine":"webkit"}`.

- `status: "open"` — the tile is already visible in every connected
  Commando client. Tell the user you opened it beside your pane.
- `status: "pending"` — non-localhost origins need the user's one-click
  approval; the tile shows a confirm card. Tell the user it is waiting for
  their confirmation. Never try to confirm it yourself — confirmation is
  owner-only by design.

## Choosing an engine — debugging a page WITH the user

Default (`webkit`, omit the field) is right for *showing* things: it is the
lightest renderer. Add `"engine":"chromium"` to the open body when you
intend to *debug* the page together — watch its network requests, set
breakpoints, take performance traces — or when you want the user to
annotate what you show them via review mode (below). The tile then renders
through the daemon's managed headless Chromium, and you can attach real CDP
to the very page the user is looking at:

```bash
curl -sS "http://127.0.0.1:${COMMANDO_PORT:-4310}/api/web-panes/<webPaneId>/cdp" \
  -H "Authorization: Bearer $(cat "${COMMANDO_AGENT_HOOK_TOKEN_PATH:-$HOME/.commando/agent-hook-token}")"
# → { "target": "ws://127.0.0.1:<port>/devtools/page/<id>",
#     "devtoolsFrontendUrl": "http://127.0.0.1:<port>/devtools/inspector.html?ws=…" }
```

- `target` is a raw CDP websocket for that one page — connect chrome-devtools
  MCP (`--browser-url http://127.0.0.1:<port>`) or any CDP client to it.
  Everything you do (navigate, evaluate, Network.enable) happens on the page
  the user is watching. Localhost pages only unless the owner has confirmed
  the origin; navigating the page to an unconfirmed external origin blanks
  it and asks the owner — do not fight this, ask the user instead.
- `devtoolsFrontendUrl` is a full DevTools UI for the same page — the user
  can open it themselves with the tile's 🛠 button, or you can open it as a
  second tile beside the page when the user asks to see the network tab.
- 503 from `/cdp`: no Chromium-family browser is installed for the engine —
  tell the user (installing Google Chrome, or setting COMMANDO_CHROMIUM_PATH,
  fixes it) and fall back to a webkit tile.
- A tile's engine is fixed at open. To switch, DELETE the tile and reopen
  the same URL with the other engine (this is cheap — do it when a showing
  session turns into a debugging session).

## Collecting review feedback on a chromium tile

Chromium tiles have a review mode: the user toggles it in the tile header,
clicks elements on your page, and queues comments. Each note reaches you
selector-anchored — `{selector, tag, text, rect, comment, pageUrl, capturedAt,
response?}` — so you can go straight from note to edit. `response?:
{question, answer, data?}` is present when the note came from an in-page
redline component (see the redline skill) rather than an element annotation
— prefer it over parsing `comment` when it's there.

After opening a chromium tile for something you want reviewed, poll for
feedback in a background task and keep working:

```bash
curl -sS "http://127.0.0.1:${COMMANDO_PORT:-4310}/api/web-panes/<webPaneId>/feedback?wait=30" \
  -H "Authorization: Bearer $(cat "${COMMANDO_AGENT_HOOK_TOKEN_PATH:-$HOME/.commando/agent-hook-token}")"
# → {"ok":true,"webPaneId":"w-…","cursor":3,"notes":[{"id":3,"selector":"#root > button","comment":"…", …}]}
```

(With a commando checkout handy, `scripts/commando-feedback <webPaneId>` wraps
this — including the cursor bookkeeping below; exit 4 means the review ended.)

- Empty `notes` after ~30s is normal — re-poll.
- Delivery is at-least-once: notes stay journaled on the daemon until acked,
  so a lost poll (killed task, timeout, even a daemon restart) loses nothing —
  the next poll redelivers them. Acknowledge by passing the previous
  response's `cursor` back (`…&cursor=3`). Polling without a cursor never
  acks; you just see the same notes again — dedupe by note `id`.
- Apply the feedback, verify over the tile's `/cdp` endpoint if useful, and
  reply in your own terminal — there is no chat panel in the tile.
- A closed tile keeps serving its unacked notes; 404 means the review is over
  AND nothing is left unread. Stop polling on 404 and never retry a 401 in a
  loop.

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

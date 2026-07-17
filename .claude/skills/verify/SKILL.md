---
name: verify
description: Build, launch, and drive commando to verify a change end-to-end in the running app
---

# Verifying commando changes

## Launch

`npm run dev` starts daemon (port 4310) + vite (port 5173, strict). If those
ports are taken by another checkout's dev instance, run a parallel stack:

```sh
# daemon in token mode (auth stays off unless COMMANDO_OWNER_EMAIL is set)
COMMANDO_PORT=4410 COMMANDO_TOKEN=<any-token> npx tsx server/index.ts

# vite proxying to that daemon (COMMANDO_PORT sets the proxy target)
COMMANDO_PORT=4410 npx vite --port 5273
```

Then open `http://127.0.0.1:5273/#token=<any-token>`. Without the token
fragment (or with `COMMANDO_OWNER_EMAIL` set) you land on the sign-in screen.

## Drive

Playwright works well headless (`chromium.launch()`, viewport 1440x900).
Scripts must live inside the repo dir to resolve `@playwright/test`. If the
browser binary is missing: `npx playwright install chromium-headless-shell`.

Useful flows: cockpit renders session tree + panes + HUD from the live
tmux server; `Meta+k` opens the command palette; sidebar "Linear" opens the
Linear board. The daemon mirrors the user's real tmux sessions — look, don't
type into panes.

## Gotchas

- `vite.config.ts` has `strictPort: true`; override port via CLI `--port`.
- A worktree needs its own `npm ci` (and the Playwright browser download).

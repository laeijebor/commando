# Commando Companion (Expo) — design

**Date:** 2026-09-18
**Status:** Round 1 decisions agreed (2026-09-18)
**Branch:** `claude/commando-companion-app-5v1pmi`
**Mockups:** `docs/mockups/2026-09-18-companion-app.html` (open in a browser; also published as an artifact)

## Motivation

Commando Island covers "what are my agents doing" while I am at the Mac. Away from
it, the only options are the web cockpit in mobile Safari over Tailscale (no push,
drawers everywhere, no way to answer a permission prompt) or nothing. The companion
app is the pocket version of the HUD: see every session, answer what needs
answering, read or drive a pane, review a redline tile, and start new work, with a
push notification when an agent finishes or stalls on a question.

Optimised for iPhone first, iPad landscape second. Android is a non-goal for v1 but
nothing below prevents it.

## Goals (v1)

1. Connect to one or more daemons over Tailscale; sign in as the owner.
2. Browse sessions, windows and panes with the HUD information (status, headline,
   activity, progress, changes, checks, recap) and the worklog, git stats, PRs and
   ports the desktop shows on the right.
3. View a pane live (xterm.js) and send input: messages, special keys, paste.
4. Start new sessions (with worktree + preparation command), new windows, split
   panes, and launch Claude / Codex / OpenCode / a shell in them.
5. Open commando/redline tiles through the daemon and answer redline questions,
   queue annotations, and Send / Send + Build.
6. Push notifications when an agent needs input, finishes, or fails; answer
   permission prompts and questions natively (also from the notification).

## Non-goals (v1)

- Linear and Notes areas.
- Editing tmux layouts / group presets / "Web owns tmux".
- Rendering webkit-engine tiles that only exist on the host's localhost (see Tiles).
- Multi-user / non-owner accounts.

## What the daemon already provides

The survey of `server/`, `shared/protocol.ts` and `src/` shows most of the app can be
built on existing owner-authenticated surfaces:

| Need | Existing surface |
| --- | --- |
| Auth | Better Auth cookie (`/api/auth/*`) or `COMMANDO_TOKEN` bearer / `?token=`; both work on `/ws` and every owner-facing `/api/*` route. Exceptions that take only the agent hook token: `/api/agent-status/hooks/*`, `/api/session-brief`, `/api/pane-target-marker`; `/companion/ws` additionally requires a loopback peer |
| Tailscale | `COMMANDO_TAILSCALE=true` binds Tailscale addresses and accepts Tailscale peers; a native client sends no `Origin`, so it passes the origin check. MagicDNS hostnames need `COMMANDO_TRUSTED_ORIGINS` |
| Sessions / windows / panes / ports | `snapshot` on `/ws`, `GET /api/snapshot` |
| Agent HUD | `agent_status` / `agent_status_snapshot` on `/ws`, including `details.requests` (pending questions and permissions, read-only) |
| Worklog | `session_brief` / `session_brief_snapshot` on `/ws` |
| Terminal | `subscribe` → `pane_reset` (seed) + `pane_data`; `input`, `paste`, `key`, `resize_pane` / `release_resize` |
| Git / PRs | `GET /api/git/summary`, `/api/git/file-diff`, `GET /api/prs/pane` |
| Create | `POST /api/tmux/sessions` (with `worktree: {branch, path?, prepareCommand?}`), `/api/tmux/windows`, `/api/tmux/panes`; `POST /api/pane-management/panes/:id/run {command}` |
| Manage | rename / delete session, window, pane; pane marks; kill ports |
| Tiles | `web_panes` on `/ws`, `GET/POST/DELETE /api/web-panes`, `POST …/confirm`; chromium screencast + input over `/ws/web-tiles/:id`; `?mode=review` gives pending-queue snapshots |
| Redline answers | owner routes under `/api/web-panes/:id/pending*`, `…/pending/send`, `…/pending/send-build` |

## Gaps to close on the daemon

1. **Answer channel for owners.** Only `/companion/ws` (loopback peer + agent hook
   token) can answer `AgentInteractionRequest`s, and the interaction broker only holds
   an agent's hook open while a companion consumer is connected. Add
   `answer_agent_request` (same shape as `CompanionClientMessage`, with
   `requestIdempotencyKey`) to `ClientMessage` on `/ws`, and count owner sockets that
   opt in as consumers. First valid answer wins; Island and phone can both be
   connected.
2. **Provider usage for owners.** `ProviderUsage[]` is only in the companion
   snapshot. Broadcast it on `/ws` (`{type:'provider_usage', usage}`) or add
   `GET /api/usage`; run the refresh loop while any consumer wants it.
3. **Push devices.** `POST /api/push/devices {expoPushToken, rules}` persisted under
   `~/.commando/push-devices.json`; the daemon posts to Expo's push API on
   `needs_input`, `done` (with recap headline), and `failed` transitions, honouring
   per-device quiet hours and muted sessions. Notification payload carries `paneId`
   and `requestId` so notification actions can answer directly.
4. **Codex lifecycle.** Codex has no hook endpoint; status is heuristic. Add a
   `commando-codex-notify` bridge installed into `~/.codex/config.toml` `notify` so
   "finished" is reliable. Permissions for Codex stay in the terminal for v1.
5. **Pairing (optional, later).** Daemon prints a QR (host, port, one-time code);
   the app exchanges it for a device token. Avoids typing Tailscale IPs and keeps the
   owner password off the phone. Not required for v1 if owner sign-in is acceptable.
6. **Tile URL rewriting.** Redline artifacts hardcode `http://127.0.0.1:4310/redline/sdk.js`.
   Screencast rendering sidesteps this (the page runs in the daemon's Chromium). If
   we later want native WebView rendering of artifacts, the daemon must serve them
   with rewritten asset URLs and a `__commandoRedlineQueue` shim.

## App architecture

- **Expo (SDK 54+), TypeScript, expo-router**, EAS dev client (WebView and push need
  native modules, so Expo Go is out). Lives at `apps/mobile` beside `apps/desktop`
  and `apps/island`, with its own `package.json`; shares `shared/protocol.ts` types
  via a path alias or a tiny `@commando/protocol` package.
- **Connection layer**: one `/ws` socket per host, reconnect with backoff, the same
  message parser as `src/useDaemon.ts`. HTTP calls reuse the cookie from the keychain
  (`expo-secure-store`). No `Origin` header is sent.
- **State**: zustand store keyed by host; selectors reproduce `agentHudGroups()` /
  `agentNeedsAttention()` / `STATUS_PRIORITY` verbatim so badges match the desktop.
- **Terminal**: `react-native-webview` hosting a bundled page with xterm.js
  (JetBrains Mono, Rosé Pine Moon palette, same options as `src/paneStream.ts`). The
  RN side owns the socket and forwards `pane_reset` / `pane_data` into the WebView;
  the WebView reports selection and scroll. Key bar and composer live in RN.
  - Default: render at the source pane's cols/rows and pan/zoom; no resize lease, so
    viewing from the phone never shrinks the pane on the Mac.
  - Opt-in "Fit to phone": takes the resize lease like the desktop's focused pane
    and releases it when the screen closes.
  - Composer sends `paste` (bracketed) followed by `key: Enter`, so multi-line
    prompts reach Claude Code intact. A "raw" mode sends `input` per keystroke for
    TUIs.
- **Tiles**: chromium tiles render via the screencast relay (PNG frames drawn into an
  `<Image>` or a canvas WebView); touch → `mouse` events using the mapping in
  `src/chromiumTileInput.ts`; the phone sends its own `viewport` (CSS px + DPR).
  Review mode mirrors `TileReviewLayer`: tap → `inspect{grade:'click'}` → comment card
  → `POST …/pending`; pending strip from `?mode=review` snapshots; Send all / Send +
  Build. Webkit tiles show "Reopen as chromium" (DELETE + POST with
  `engine:'chromium'`).
- **Notifications**: `expo-notifications` with categories `needs_input` (Answer /
  Open), `permission` (Allow once / Deny), `done`, `failed`. Foreground: in-app
  banner + haptic. Background answers call the answer channel over HTTPS if the
  socket is not up (`POST /api/agent-requests/:paneId/:requestId/answer`, thin
  wrapper over the same broker).
- **Theme**: the five desktop themes' tokens ported to a RN theme object;
  semantic colours are theme-invariant.

## Screens (see mockups)

1. **Hosts + sign-in** — host cards with reachability, sign-in sheet.
2. **Sessions (home)** — attention-first inbox: Needs you / Working / Done / Idle,
   usage tiles, + button.
3. **Pane** — live terminal, window/tile chips, HUD strip, key bar, composer, Info.
4. **Answer** — question with options / custom / note; permission with Allow once /
   Always / Deny.
5. **Info sheet** — worklog (headline, recap, plan, next), changes, PR, ports,
   screenshots, activity.
6. **Tile** — screencast tile with Browse / Review toggle, redline controls, pins,
   pending strip.
7. **New session** — name, repo, directory, worktree, preparation, agent + prompt.
8. **Notifications** — lock-screen actions.
9. **Settings** — notification rules, mutes, quiet hours, terminal, theme, hosts.
10. **iPad** — three columns: sessions / terminal / HUD + worklog.

## Decisions (agreed 2026-09-18)

1. **Auth:** owner email + password reusing the Better Auth session cookie. Pairing QR
   is a later nicety, not v1.
2. **Terminal sizing:** source-sized pane with pan and an opt-in "Fit to phone" that
   takes the resize lease.
3. **Webkit tiles:** prompt to reopen as chromium; no daemon HTTP proxy in v1.
4. **Push:** Expo push service. The daemon registers devices and posts to Expo's API.
5. **Codex callbacks are in v1:** the `hooks:install` command also installs a Codex
   `notify` bridge so Codex "finished" (and any other lifecycle events Codex emits)
   become hook-sourced status rather than heuristics.
6. **Home ordering:** both attention-first (grouped Needs you / Working / Done / Idle)
   and tree-first (repo → session → window → pane, like the desktop session tree),
   switched by a segmented toggle on the Sessions screen and remembered per device.
7. **Answer channel:** extend `/ws` with `answer_agent_request` so any owner client,
   not only the MacBook's loopback companion, can answer questions and permissions.
   Owner sockets that opt in count as interaction consumers; first valid answer wins
   and Island keeps working alongside.
8. **Distribution:** EAS dev build + TestFlight, personal use.
9. **Repo layout:** `apps/mobile` in this repo beside `apps/desktop` and `apps/island`.

## v1 plan checklist

- [x] Daemon: `answer_agent_request` on `/ws` + consumer counting (tests)
- [x] Daemon: provider usage broadcast for owners
- [x] Daemon: push device registry + Expo push sender + rules
- [x] Daemon: Codex notify bridge in `hooks:install` (v1)
- [x] App: scaffold `apps/mobile` (expo-router, theme, secure store, WS client)
- [x] App: Hosts + sign-in
- [x] App: Sessions screen with HUD data and usage, attention-first / tree-first toggle
- [ ] App: Pane screen with xterm WebView, key bar, composer
- [x] App: Answer screen (question + permission) and notification actions
- [ ] App: Info sheet (worklog, git, PR, ports, screenshots)
- [ ] App: New session / window / pane sheets
- [ ] App: Tiles list + chromium screencast + review mode + pending strip
- [ ] App: Settings (rules, mutes, quiet hours, terminal, theme) — rules, mutes, quiet hours and theme done; terminal rows wait on the pane screen
- [ ] App: iPad three-column layout
- [ ] E2E: daemon on a QA tmux socket + Tailscale, phone on the tailnet, full loop:
      notification → answer → agent continues → recap notification

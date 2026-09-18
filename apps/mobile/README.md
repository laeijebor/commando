# Commando companion (`apps/mobile`)

The pocket version of the Commando HUD: see every agent, answer what needs
answering, and start new work from an iPhone or iPad over Tailscale. Designed
against `docs/superpowers/specs/2026-09-18-companion-app-design.md` and the
mockups in `docs/mockups/2026-09-18-companion-app.html`.

Expo SDK 57, expo-router with typed routes, TypeScript strict, iOS and iPadOS
only. Bundle id `com.commando.companion`.

## What is here today

- **Hosts** — add a daemon, probe it with `GET /api/health`, sign in with the
  owner's Better Auth email and password or an automation token. The list, the
  tokens included, lives in the iOS keychain via `expo-secure-store`.
- **Sessions** — the attention inbox (usage tiles plus Needs you / Working /
  Done / Idle) and the repo → session → window → pane tree, switched by a
  segmented toggle that is remembered per device.
- **Pane** — the live terminal: xterm.js inside a WebView, fed by `pane_reset`
  and `pane_data` from `/ws`, with window and tile chips, the agent HUD strip, a
  key bar, and a composer that sends a bracketed paste followed by Enter (or, in
  raw mode, each keystroke as `input`).
- **Theme** — the five desktop themes, ported token for token from
  `src/styles.css`, with the choice persisted.
- **Info sheet** — pushed over a pane: the worklog (headline, recap, Next, plan
  checklist and activity timeline from `session_brief`), the HUD details when a
  pane has no brief, the diff from `GET /api/git/summary` polled every 15s with
  a file-diff viewer, linked pull requests from `GET /api/prs/pane`, the
  session's open ports with "Open as tile", and screenshot folders with a
  full-screen viewer.
- **Create** — new session (repository, directory, worktree branch and path,
  preparation command, agent and opening prompt), new window and split pane,
  reached from the "+" affordances on the tree's session and window rows.
- **Answer** — screen 04. A pending `AgentInteractionRequest` from
  `AgentStatus.details.requests` is rendered as one card per `AgentQuestion`
  (radio or checkbox options per `multiple`, descriptions, a custom-answer
  field per `custom`) with **Answer** and **Reject**, or, for a permission, the
  tool name and prompt over **Allow once / Always / Deny**. The answer goes out
  as `answer_agent_request` on the live socket and falls back to
  `POST /api/agent-requests/:paneId/:interactionId/answer` with the same id as
  the `idempotencyKey`. A request that is no longer pending says so.
- **Notifications** — permission, the Expo push token and a stable per-install
  device id in the keychain, registered with every host through
  `PUT /api/push/devices/:id`. See below.
- **Tiles** — every web pane the daemon holds, grouped by session, with the
  owner's confirmation card for an external origin, a "Reopen as chromium"
  offer for webkit tiles (which only exist inside the host's own WebView), and
  a "+" sheet that opens a URL beside a chosen pane. Opening a chromium tile
  streams it: the daemon's screencast arrives as PNG frames over
  `/ws/web-tiles/:id`, the phone sends its own viewport and pixel ratio so the
  page lays out for a phone, and touches become CDP input — tap is a click,
  a drag is a wheel, a long press is a right click. **Review** mode swaps taps
  for the `inspect` hit test, anchors a comment card to the element, draws a
  pin for every queued note, and puts the pending queue on a strip with
  Send all and Send + Build. The redline controls inside the page keep working
  through the screencast, because the queue binding lives in the daemon's
  Chromium.
- Activity is a navigable placeholder that already renders the live data it
  has.

## The terminal page

`src/terminal/terminal-html.ts` is generated, not written: a WebView has no
network of its own, so `scripts/build-terminal-html.mjs` inlines the xterm.js
bundle, its stylesheet and `src/terminal/page-script.js` into one document and
exports it as a string. Regenerate it after bumping `@xterm/xterm` or editing
the page script, and commit the result:

```sh
npm run build:terminal
```

The page only renders bytes and reports what it measures — React Native owns the
socket, the keyboard and the pane's size — so the parts worth testing live in
`src/terminal/bridge.ts` rather than inside the page. JetBrains Mono is not
available in a WebView without bundling the font, so the page falls back to the
system monospace stack; the Rosé Pine Moon palette and the xterm options match
`src/XtermPane.tsx` token for token.

A pane renders at its source `cols × rows` and pans sideways (Decision 2 in the
spec). The header's **Fit** toggle measures the page's own cell size, computes
cols/rows and takes the daemon's resize lease with `resize_pane`, which shrinks
the real tmux pane; it is released on toggle-off, on blur, on unmount and when
the socket drops. Its default lives in Settings → Terminal.

## Running it

```sh
npm install          # inside apps/mobile; the root install does not cover it
npx expo start       # or `npm run mobile:start` from the repo root
```

`expo-secure-store` and (later) the terminal WebView and push notifications are
native modules, so **Expo Go will not run this app**. Build an EAS dev client
once and then `expo start` against it:

```sh
npx eas build --profile development --platform ios
```

## Pointing at a daemon over Tailscale

Start the daemon on the Mac with Tailscale binding enabled:

```sh
COMMANDO_TAILSCALE=true npm start
```

Then add the host in the app as `studio.tail-1a2b.ts.net:4310` (or the raw
`100.x.y.z:4310` address). A MagicDNS hostname also needs the daemon to trust
it:

```sh
COMMANDO_TRUSTED_ORIGINS=http://studio.tail-1a2b.ts.net:4310
```

A native client sends no `Origin` header, so it passes the daemon's origin
check on its own; the trusted-origins list only matters for browser clients on
the same name. Token-only daemons work too — switch the sign-in sheet to "Use
automation token" and paste `COMMANDO_TOKEN`.

## Push notifications

The app registers one device per install with every host it knows:

- the device id is created once and kept in `expo-secure-store`, so a
  re-registration updates the same row in `~/.commando/push-devices.json`;
- the rules (needs input / finishes / fails, quiet hours in the device's IANA
  time zone, muted tmux sessions) are edited on the Settings screen, persisted
  locally and re-`PUT` to every host on change — the daemon evaluates them, so
  a mute stops the push at the source;
- the categories match the daemon's: `needs_input` ("Answer", "Open pane"),
  `permission` ("Allow once", "Deny" — both answered in the background over the
  HTTP answer route — and "Open"), `done` and `failed` (tap opens the pane);
- a tapped notification deep-links by its `data`. The payload carries no host
  id, so the app picks the registered host whose snapshot holds the pane, then
  the only registered host, then the host on screen.

A push token needs a real device and an EAS project id; on the simulator, or
without one, the Settings screen says so instead of failing silently.

## Shared protocol

`@commando/protocol` resolves to `<repo>/shared/protocol.ts` and
`@commando/tmux-create` to `<repo>/shared/tmux-create.ts` — the same files the
daemon and the web cockpit compile, never a copy. TypeScript learns about them
through the path aliases in `tsconfig.json`, Metro through `watchFolders` and
`resolver.extraNodeModules` in `metro.config.js`, and Jest through
`moduleNameMapper` in `package.json`.

The create flows keep their directory history and per-repo preparation commands
on the device (SecureStore, under the desktop's own
`commando.tmux-create.*` keys) and the sessions to notify about under
`commando.notify.sessions`. The daemon's
`/api/session-management/preferences` is not a home for them: it only persists
the session tree's grouping and drops every other key.

## Checks

```sh
npx tsc --noEmit     # or `npm run mobile:typecheck` from the repo root
npx jest             # or `npm run mobile:test`
npx expo config --type public
```

The root `npm run typecheck` and `npm test` deliberately skip this directory:
`tsc -b` excludes it and Vitest's `exclude` list does too, because React Native
sources need Metro's transformer, not Vite's.

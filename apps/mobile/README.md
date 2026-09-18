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
- **Theme** — the five desktop themes, ported token for token from
  `src/styles.css`, with the choice persisted.
- Pane, New session, Activity and Tiles are navigable placeholders that already
  render the live data they have. The terminal WebView is a later phase of the
  plan in the spec.

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

`@commando/protocol` resolves to `<repo>/shared/protocol.ts` — the same file the
daemon and the web cockpit compile, never a copy. TypeScript learns about it
through the path alias in `tsconfig.json`, Metro through `watchFolders` and
`resolver.extraNodeModules` in `metro.config.js`, and Jest through
`moduleNameMapper` in `package.json`.

## Checks

```sh
npx tsc --noEmit     # or `npm run mobile:typecheck` from the repo root
npx jest             # or `npm run mobile:test`
npx expo config --type public
```

The root `npm run typecheck` and `npm test` deliberately skip this directory:
`tsc -b` excludes it and Vitest's `exclude` list does too, because React Native
sources need Metro's transformer, not Vite's.

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
- Pane, Answer, Activity and Tiles are navigable placeholders that already
  render the live data they have. The terminal WebView, the answer channel and
  push notifications are later phases of the plan in the spec.

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

# Commando

Commando is a local-first cockpit for existing tmux sessions and coding agents. It keeps tmux as the source of truth while adding session navigation, app-owned pane layouts, UI-only pane maximize, terminal input, an agent attention HUD, and a native macOS notch companion.

## Requirements

- Node.js 24 or newer
- tmux 3.6 or newer
- An existing local tmux server
- macOS 14 or newer for Commando Island

## Development

```bash
npm install
COMMANDO_OWNER_EMAIL=leo@ijebor.com npm run dev
```

Open `http://127.0.0.1:5173`. On first use, Commando asks you to create the owner account with the configured email address and a password of at least 12 characters. Later visits restore a signed, `HttpOnly` session cookie; the session lasts 30 days and is refreshed while active.

To run the native companion during development, install the agent bridges once and launch the Swift package in another terminal:

```bash
npm run hooks:install
npm run island:dev
```

If `COMMANDO_OWNER_EMAIL` is unset, Commando retains its original token-only mode and prints an authenticated URL such as:

```text
http://127.0.0.1:5173/#token=<ephemeral-token>
```

Open that exact URL. Commando removes the token from the address bar and retains it in session storage for the current browser tab. Token authentication remains available alongside owner authentication for automation and recovery.

## Production

```bash
npm run build
COMMANDO_OWNER_EMAIL=leo@ijebor.com npm start
```

The production daemon serves the compiled app and prints its `127.0.0.1` URL.

## Commands

```bash
npm run hooks:install
npm run island:build
npm run island:test
npm run island:install
npm run typecheck
npm test
npm run build
```

## Agent Status Hooks

Install the authenticated Claude Code, Codex, and OpenCode status bridges for the current user:

```bash
npm run hooks:install
```

The command safely merges Commando entries into `~/.claude/settings.json`, writes the Claude bridge under `~/.commando/hooks/`, installs the global OpenCode plugin at `~/.config/opencode/plugins/commando-agent-status.js`, and points Codex's `notify` program at `~/.commando/hooks/commando-codex-notify.mjs`. It is safe to rerun after upgrading or changing configuration: unrelated settings, hooks, and plugin files are preserved, and prior Commando entries are replaced rather than duplicated.

For a named Claude profile, set Claude's standard `CLAUDE_CONFIG_DIR` while installing. Repeat the command for each profile that should report to Commando; the bridge, update CLI, hook token, and OpenCode plugin remain shared:

```bash
CLAUDE_CONFIG_DIR="$HOME/.claudep" npm run hooks:install
CLAUDE_CONFIG_DIR="$HOME/.claudey" npm run hooks:install
```

The installer generates a dedicated hook bearer token at `~/.commando/agent-hook-token`. The token is separate from browser and automation authentication, remains on disk with mode `0600`, and is read at hook runtime rather than embedded in generated files. Set `COMMANDO_AGENT_HOOK_TOKEN_PATH` for both installation and daemon startup to use another path. Hooks post to the loopback `COMMANDO_PORT`, defaulting to `4310`, and silently continue when Commando is unavailable.

The Claude and OpenCode bridges also provide the HUD with bounded task intent, normalized tool activity, todo progress, changed-file counts, check outcomes, attention prompts, and final-response metadata. They do not forward raw tool arguments or output, full shell commands, file contents, patches, reasoning, or complete message arrays. Final lines using the `🟢`, `🟡`, or `🔴` quick-recap convention become the completed card headline; otherwise Commando produces a deterministic local recap from the final response and structured progress. The latest completed recap remains visible until that pane starts another agent turn or closes.

The same authenticated lifecycle updates maintain a persisted worklog for each active tmux pane. A pane adds a collapsed right-side worklog handle as soon as an agent reports a plan or meaningful activity; expand it to see the current checklist above a chronological milestone history, short Markdown recap, and one next action. The worklog remembers its visibility per pane, automatically compacts when a pane is too narrow to spare terminal columns, survives daemon/browser reconnects, and is removed with its tmux session. Agents can publish deliberate milestones through `~/.commando/hooks/commando-session-update.mjs`. Run `npm run skills:install` to install the `session-updates` skill alongside the other Commando skills so Claude and OpenCode know when and how to maintain those handoffs.

Interactive bridges — Claude Code and OpenCode, not Codex — additionally forward bounded permission labels, question text, and answer labels while a request is pending. Values pass through the same credential redaction and size limits as HUD metadata. Claude Code receives answers through its synchronous `PermissionRequest` hook output; OpenCode receives them through its local permission and question SDK methods. If Commando Island is not connected, hooks return immediately and the normal terminal prompt remains in control.

### Codex

Codex CLI has no per-tool hook surface: its one external callback is the top-level `notify` program, which Codex spawns once per turn with a single JSON argument. The installer writes the bridge and merges a `notify` entry into `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). Because Commando ships no TOML parser, the merge is deliberately narrow: it rewrites only its own block, marked with a `# commando:codex-notify v1` comment, leaves every other line's text and position untouched, creates the file when missing, and never looks at a `notify` inside a `[table]`. A `notify` you already configured is preserved — the marker records it and the Commando bridge re-spawns it with the same JSON argument — and a `notify` Commando cannot safely parse is left exactly as it is, with an instruction printed instead:

```toml
# commando:codex-notify v1 wrapped=["notify-send","Codex"]
notify = ["node", "/Users/you/.commando/hooks/commando-codex-notify.mjs"]
```

The Codex bridge reports turn completion and nothing else. An `agent-turn-complete` callback becomes a hook-sourced `done` with the recap and headline taken from Codex's last assistant message and the turn intent from its input messages, so "Codex finished" stops being a guess. It cannot report tool activity, checks, file changes, or progress, and **Codex permission and approval prompts stay in the terminal** — they are never forwarded and cannot be answered from Commando or the companion app. Because the callback only describes the turn that just ended, heuristics take the pane back to `working` as soon as it visibly resumes, and the next callback records a fresh completion.

## Web Pane Tiles

Agents (and you) can open a web page as a tile in the pane grid, right beside a
tmux pane — a Lavish review page, an `npx serve` output, a vite dev server, or
docs. From inside any mirrored tmux pane:

```bash
scripts/commando-open http://127.0.0.1:41300/plan          # beside this pane
scripts/commando-open http://localhost:5173/ below         # placement: right|below|auto
```

The script posts to `POST /api/web-panes` with the agent hook token and this
pane's `$TMUX_PANE` as the anchor; the tile appears in every connected client.
In the UI, type a URL (or `localhost:5173` / `:5173` shorthand) into the ⌘K
palette to open a tile beside the focused pane, or Option-right-click a
detected port in the Ports panel and pick "Open as web tile".

Trust model: `localhost`/loopback URLs open immediately; any other origin
renders as a pending card until the owner clicks Open (optionally "Always
allow" to remember the origin). Web panes and the origin allowlist persist in
`~/.commando/web-panes.json`. Tiles exist only in Commando's rendered layout —
tmux never sees them; the real panes are resized around the tile through the
usual resize-lease machinery, and raw tmux attachments keep seeing only real
panes. The API also accepts owner auth: `GET /api/web-panes`,
`POST /api/web-panes {url, anchor, placement?, engine?}`,
`POST /api/web-panes/:id/confirm {allowOrigin?}`, `DELETE /api/web-panes/:id`,
`GET /api/web-panes/:id/cdp`.

### Chromium engine (CDP)

Pass `--engine chromium` (API: `"engine":"chromium"`) to render the tile
through a daemon-managed headless Chromium instead of an iframe/WKWebView.
The page streams into the tile via CDP screencast (input relays back), and
`GET /api/web-panes/:id/cdp` returns the page's raw CDP websocket plus a full
DevTools frontend URL — so an agent can watch network traffic, set
breakpoints, or trace the exact page you are looking at, and the tile's 🛠
button opens DevTools as a sibling tile. The browser runs with a throwaway
profile under `~/.commando/chromium-profile` and a loopback-only DevTools
port; the daemon discovers an installed Chromium-family browser
(Chrome/Canary/Chromium/Edge/Brave, override with `COMMANDO_CHROMIUM_PATH`,
or drop a Chrome-for-Testing build at `~/.commando/chrome-for-testing/chrome`).
The trust policy still applies: navigating a chromium tile to an unconfirmed
external origin blanks the page and re-shows the confirm card.

For agents, install the `show-in-commando` skill into the Claude Code and
OpenCode skill directories with `scripts/install-show-in-commando-skill`
(canonical copy: `skills/show-in-commando/SKILL.md`, safe to rerun after
edits). It teaches agents in any project to open served pages beside their
own pane and to fall back to sharing the URL when Commando is absent.

## Commando Island

Commando Island is a dependency-free SwiftUI/AppKit app under `apps/island`. It uses a non-activating top-center panel on every display, including Macs without a notch. The compact bar shows the current status, tmux session name, agent session title or stable agent-session reference, remaining provider usage, and total session count. Hover or click to expand the panel and see every tmux session. Pending permission requests and questions expand it automatically.

Build and install the ad-hoc signed app for the current user:

```bash
npm run hooks:install
npm run island:install
open "$HOME/Applications/Commando Island.app"
```

`island:install` defaults to `~/Applications`. Set `COMMANDO_ISLAND_INSTALL_DIR=/Applications` to choose another destination; that location may require administrator permissions.

Use the menu-bar icon's **Move to Display** submenu to move the island immediately and remember that monitor across launches. Choose **Use Pointer Location at Launch** to clear the preference and restore pointer-based placement.

Press **Fn+Option+F12** to toggle the bottom-screen visor terminal. On keyboards where F12 is already a function key, **Option+F12** is sufficient. The visor runs your account's login shell in a local PTY, separate from tmux, and keeps that shell alive when hidden. Press the shortcut again or click another app to hide it; shortcut dismissal restores the app that was active before the visor opened.

Open the actions menu in the expanded island header to enable or disable request interruptions, enter or exit **Minimal Mode**, or quit Commando Island. Request interruptions are enabled by default; disabling them keeps permission requests and agent questions available in the island without automatically expanding it or taking keyboard focus. Minimal Mode persists across launches and keeps the compact island on the left side of the camera notch, leaving the right menu-bar area clear; on displays without a notch, the smaller compact island remains top-centered.

The app connects only to `127.0.0.1` and reads the private `~/.commando/agent-hook-token` generated by `hooks:install`. It receives a companion-only snapshot: session names, agent-session identity, bounded HUD status, pending answer choices, quota percentages, and up to 40 lines of plain-text terminal output for the currently focused agent. While the companion is connected, the daemon retains bounded tails for live agents so their final output remains available after completion; collection stops as soon as an agent reports completion or failure, and the tails are cleared when the companion disconnects. Terminal output can contain sensitive data, but the companion endpoint is restricted to the authenticated loopback connection. The companion cannot request output from non-agent panes or send arbitrary terminal input.

Claude and Codex usage are fetched by the daemon directly from their provider usage endpoints using the CLI OAuth sessions already stored in macOS Keychain and `~/.codex/auth.json`. Credentials remain in the daemon process; the companion receives only percentages and reset timestamps. Providers that are signed out, rate limited, or do not expose a current window appear as unavailable rather than blocking the rest of the panel.

The same usage is also available to owner clients outside the island: a `/ws` socket receives `provider_usage` pushes after sending `watch_usage`, and `GET /api/usage` returns the cached snapshot, with the daemon running a single shared refresh loop for as long as any consumer wants it.

The companion uses `COMMANDO_PORT`, defaulting to `4310`, when run from a terminal. For an installed Finder-launched app using a non-default daemon port, set the app preference once:

```bash
defaults write com.commando.island CommandoPort -int 4310
```

Remove that override with `defaults delete com.commando.island CommandoPort`.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `COMMANDO_PORT` | Local daemon port | `4310` |
| `COMMANDO_OWNER_EMAIL` | Enables email/password auth and restricts first-owner creation to this address | Token-only mode |
| `COMMANDO_AUTH_DB_PATH` | Better Auth SQLite database | `~/.commando/auth.sqlite` |
| `COMMANDO_AUTH_SECRET_PATH` | Generated cookie-signing secret | `~/.commando/auth.secret` |
| `COMMANDO_AGENT_HOOK_TOKEN_PATH` | Persisted bearer token shared by installed agent hooks and the daemon | `~/.commando/agent-hook-token` |
| `COMMANDO_SESSION_BRIEFS_PATH` | Persisted pane-local worklogs and task history | `~/.commando/session-briefs.json` |
| `COMMANDO_PUSH_DEVICES_PATH` | Registered companion push devices and their notification rules | `~/.commando/push-devices.json` |
| `EXPO_ACCESS_TOKEN` | Expo access token sent as a bearer when posting push notifications | None (Expo accepts unauthenticated sends) |
| `BETTER_AUTH_SECRET` | Explicit cookie-signing secret of at least 32 characters | Generated and persisted locally |
| `BETTER_AUTH_URL` | Canonical auth URL, primarily for an HTTPS proxy | `http://127.0.0.1:<port>` |
| `COMMANDO_TOKEN` | Fixed bearer token for automation or recovery | Random per daemon start |
| `COMMANDO_TAILSCALE` | Also listen on detected Tailscale IPv4/IPv6 addresses | `false` |
| `COMMANDO_TRUSTED_ORIGINS` | Comma-separated additional exact HTTP(S) origins, such as a MagicDNS URL | None |
| `COMMANDO_STATE_PATH` | Saved workspace layout file | `~/.commando/state.json` |
| `COMMANDO_NOTES_DIR` | Explicit startup vault override; point this at a dedicated Markdown directory | Most recently opened vault, initially `~/.commando/notes-vaults/default` |
| `COMMANDO_NOTES_PATH` | Legacy JSON note file imported once on startup | `~/.commando/notes.json` |
| `COMMANDO_TMUX_SOCKET_NAME` | Connect through `tmux -L <name>` | Default tmux server |
| `COMMANDO_TMUX_SOCKET_PATH` | Connect through `tmux -S <path>` | Default tmux server |

Set only one tmux socket override.

## Tailscale Access

Build the production app, then enable Tailscale listeners explicitly:

```bash
npm run build
COMMANDO_OWNER_EMAIL=leo@ijebor.com COMMANDO_TAILSCALE=true npm start
```

Commando listens separately on `127.0.0.1` and each detected Tailscale address. It does not bind to every LAN interface, and it rejects peers outside the loopback and Tailscale address ranges. Open the Tailscale URL printed at startup.

Direct access by Tailscale IP needs no additional origin configuration. To use a MagicDNS hostname directly over HTTP, allow its exact origin:

```bash
COMMANDO_OWNER_EMAIL=leo@ijebor.com \
COMMANDO_TAILSCALE=true \
COMMANDO_TRUSTED_ORIGINS=http://machine.example-tailnet.ts.net:4310 \
npm start
```

If Tailscale Serve or another reverse proxy terminates HTTPS and forwards to the loopback listener, set both `COMMANDO_TRUSTED_ORIGINS` and `BETTER_AUTH_URL` to that public HTTPS origin. The proxy is responsible for TLS; Commando itself serves HTTP.

Email delivery, address verification, password-reset emails, invitations, and additional owners are intentionally deferred. The database schema and Better Auth integration can support those flows later without replacing existing accounts or sessions.

## Push Notifications

The companion app registers its Expo push token with the daemon, and the daemon posts a notification to Expo's push service (`https://exp.host/--/api/v2/push/send`, batched at 100 messages, 5 second timeout) when an agent needs input, finishes, or fails. Completion and failure pushes come only from hook-reported lifecycle events (Claude Code, OpenCode, Codex bridges), never from heuristic status, so an idle prompt does not read as a finished turn. Devices are persisted at `~/.commando/push-devices.json` with mode `0600`; at most 16 are kept. Set `EXPO_ACCESS_TOKEN` to send with an Expo access token. A device Expo reports as `DeviceNotRegistered` is dropped from the registry automatically.

All routes are owner-authenticated, take JSON bodies of at most 16 KiB, and live under `/api/push`:

| Route | Purpose |
| --- | --- |
| `GET /api/push/devices` | List registered devices |
| `PUT /api/push/devices/:id` | Register or update a device (the id is client-chosen, up to 64 characters of `A-Za-z0-9._-`) |
| `DELETE /api/push/devices/:id` | Remove a device |
| `POST /api/push/devices/:id/test` | Send a test notification to one device, ignoring its rules |

A registration body carries the Expo token, a display name, the platform, and the notification rules:

```json
{
  "expoPushToken": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
  "name": "iPhone",
  "platform": "ios",
  "rules": {
    "needsInput": true,
    "done": true,
    "failed": true,
    "quietHours": { "start": "23:00", "end": "07:00", "timeZone": "Europe/Berlin" },
    "mutedSessions": ["scratch"]
  }
}
```

Rules are evaluated per device: the three kind toggles, then `mutedSessions` (tmux session names, at most 64), then `quietHours`, which may cross midnight and is evaluated in the device's own IANA time zone. Multiple status changes for the same pane within one second are coalesced to the latest one, a pending request notifies at most once per request id, and a completion notifies once per recap.

Notifications use the categories `needs_input`, `permission`, `done` and `failed`, and carry a payload the app deep-links from:

```json
{
  "paneId": "%12",
  "sessionId": "$3",
  "sessionName": "island",
  "provider": "claude",
  "kind": "needs_input",
  "requestId": "req-1",
  "requestKind": "permission",
  "interactionId": "req-1"
}
```

`interactionId` is the pending request's id, so a notification action can answer it directly through `POST /api/agent-requests/:paneId/:interactionId/answer`.

## Markdown Notes

Commando stores each managed note as an individual Markdown file with YAML frontmatter. The Notes sidebar can create vaults, open existing Markdown directories, switch through recently used vaults, and clear that history without deleting any files. The most recently opened vault is restored on startup. `COMMANDO_NOTES_DIR` remains available as an explicit startup override.

The default vault is `~/.commando/notes-vaults/default`. On first use, an existing `~/.commando/notes` directory is moved there so previous notes remain available. Other Markdown files in a selected vault are left untouched unless they contain Commando's `commando_id` frontmatter field.

Folders in the sidebar map directly to directories in the active vault. Creating or moving a note updates its Markdown file location, and generated image attachments move with it so relative links continue to work in Obsidian.

The first startup after this format change imports notes from `COMMANDO_NOTES_PATH`, writes them as Markdown, and renames the source file to `notes.json.migrated`. IDs and timestamps are preserved. Commando polls for edits made in Obsidian and requires an explicit reload or overwrite if an external edit conflicts with unsaved browser changes.

The block editor intentionally exposes only content that round-trips through standard Markdown: paragraphs, headings, bulleted and numbered lists, checklists, tables, quotes, code blocks, dividers, links, images, bold, italic, strikethrough, and inline code.

## Pane Model

Commando discovers tmux sessions, windows, and panes by stable tmux IDs. It polls structural metadata once per second and refreshes immediately for tmux layout and pane-mode notifications. Visible sessions use persistent ignore-size tmux control-mode clients, attributed dual-buffer screen seeds, and pane-tagged live output streams rendered by xterm.js.

Group layout and ordering changes do not alter tmux's split layout. The available group presets are:

- Equal grid
- Full first, then halves
- Two full-width panes followed by two half-width panes
- Lead pane with a side stack

Dragging or using the move buttons changes only Commando's saved pane order. The focused pane temporarily owns its tmux window size: Commando saves the original window layout and sizing policy, zooms the focused pane, and resizes it to the browser terminal viewport. Maximizing the focused pane updates that lease to the larger viewport. Switching focus, leaving the workspace, disconnecting, or shutting down restores the original tmux dimensions, split layout, active pane, zoom state, and sizing policy.

Pane layouts expose draggable splitters between adjacent terminals. Vertical splitters change neighboring widths and horizontal splitters change neighboring heights without changing the group's outer size. Keyboard users can focus a splitter and use the arrow keys; hold Shift for larger steps. Double-clicking resets that split. Split ratios are stored locally in the browser and do not change the saved workspace definition.

The **Web owns tmux** checkbox keeps that baseline lease open and makes each browser group authoritative for its tmux window. Commando generates a checked tmux layout from the measured browser pane capacities, reapplies it after leaving a maximized pane, and preserves the browser's stable pane order. Incomplete final rows stretch to fill the window while ownership is active because tmux cannot represent empty grid cells. Unchecking restores the exact baseline captured when ownership began.

Pane groups have independent right-edge, bottom-edge, and corner drag handles in addition to the splitters between panes. Outer dimensions are saved with the workspace and feed the same terminal measurement path, so changing a group's footprint updates tmux while web ownership is active without discarding its internal split ratios. Arrow keys resize a focused handle, Shift uses a larger step, and double-click resets that axis to the responsive default.

Unfocused browser terminals preserve the source tmux pane's columns and rows. If the source grid is larger than its card, the grid scrolls instead of reflowing or clipping. Focused terminals request a real tmux resize and wait for the authoritative reseed instead of resizing xterm optimistically. Seeds restore the normal and alternate screens, tab stops, scroll margins, wrapping, keypad, mouse, and cursor state before live output resumes. xterm.js owns local scrollback, terminal attributes, Unicode cell widths, cursor state, and IME input. Literal input and semantic special keys use the persistent controller so tmux can preserve pane application-key modes without spawning a process for each key. Paste is sent through a dedicated tmux buffer with a 256 KiB UTF-8 limit.

The browser terminal renderer bundles JetBrains Mono and uses the Rosé Pine Moon palette from the local WezTerm profile. Production CSP allows inline styles because xterm.js requires measured inline canvas and viewport styles; scripts remain restricted to the application origin. The Refresh action also requests authoritative pane reseeds.

Tmux-generated copy-mode UI is not emitted by control mode. Page Up, Page Down, and the mouse wheel therefore navigate xterm.js scrollback and the source-sized current screen instead of entering tmux copy mode.

Selecting text in a Workspace terminal copies it to the browser device's clipboard. When a mouse-aware TUI owns pointer input, use Shift-drag on Linux and Windows or Option-drag on macOS to force terminal selection.

## Terminal Profile

The browser terminal mirrors the local WezTerm profile with a 10 px font size and the Rosé Pine Moon palette. It uses the scheme's original muted ANSI and bright colors without browser contrast correction, and bold ANSI colors use their bright variants to match WezTerm's default bold-color behavior.

The font stack starts with `JetBrains Mono`, then falls back to `SFMono-Regular`, `Cascadia Mono`, `Menlo`, `Consolas`, `Liberation Mono`, and the browser's generic monospace font. The browser bundles Fontsource's JetBrains Mono 400 and 700 faces. The AppKit desktop bundles matching Google Fonts Regular and Bold TTFs, registers them only for the app process, and resolves its terminal profile from those bundled files rather than requiring a system installation.

## Security

- The daemon binds only to `127.0.0.1` unless Tailscale access is explicitly enabled.
- Owner passwords are hashed by Better Auth and browser sessions use signed, `HttpOnly`, `SameSite=Lax` cookies.
- HTTP and WebSocket access accept either an owner session or the automation bearer token.
- Host, Origin, listener, and peer-address checks are limited to loopback and explicitly enabled Tailscale access.
- Owner registration is restricted to `COMMANDO_OWNER_EMAIL`; other email addresses cannot create accounts.
- Browser input can execute shell commands in the selected pane; access to Commando is equivalent to local shell access.
- Attributed seed captures, live stream buffers, and status-inference tails are bounded and kept in memory. Commando persists layouts, not terminal output.
- Production assets use a restrictive Content Security Policy.

For automated or destructive testing, use a dedicated tmux socket:

```bash
tmux -L commando-qa -f /dev/null new-session -d -s qa
COMMANDO_TMUX_SOCKET_NAME=commando-qa COMMANDO_TOKEN=qa-token npm run dev
```

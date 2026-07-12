# Commando

Commando is a local-first web cockpit for existing tmux sessions and coding agents. It keeps tmux as the source of truth while adding session navigation, app-owned pane layouts, UI-only pane maximize, terminal input, and an agent attention HUD.

## Requirements

- Node.js 24 or newer
- tmux 3.6 or newer
- An existing local tmux server

## Development

```bash
npm install
npm run dev
```

The daemon prints an authenticated URL such as:

```text
http://127.0.0.1:5173/#token=<ephemeral-token>
```

Open that exact URL. Commando removes the token from the address bar and retains it in session storage for the current browser tab.

## Production

```bash
npm run build
npm start
```

The production daemon serves the compiled app and prints its authenticated `127.0.0.1` URL.

## Commands

```bash
npm run typecheck
npm test
npm run build
```

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `COMMANDO_PORT` | Local daemon port | `4310` |
| `COMMANDO_TOKEN` | Fixed token for development or automation | Random per daemon start |
| `COMMANDO_STATE_PATH` | Saved workspace layout file | `~/.commando/state.json` |
| `COMMANDO_NOTES_DIR` | Markdown note directory; point this at a dedicated folder inside an Obsidian vault | `~/.commando/notes` |
| `COMMANDO_NOTES_PATH` | Legacy JSON note file imported once on startup | `~/.commando/notes.json` |
| `COMMANDO_TMUX_SOCKET_NAME` | Connect through `tmux -L <name>` | Default tmux server |
| `COMMANDO_TMUX_SOCKET_PATH` | Connect through `tmux -S <path>` | Default tmux server |

Set only one tmux socket override.

## Markdown Notes

Commando stores each managed note as an individual Markdown file with YAML frontmatter. To use an Obsidian vault, set `COMMANDO_NOTES_DIR` to a dedicated folder such as `/Users/me/Documents/MyVault/Commando`. Other Markdown files in that folder are left untouched unless they contain Commando's `commando_id` frontmatter field.

The first startup after this format change imports notes from `COMMANDO_NOTES_PATH`, writes them as Markdown, and renames the source file to `notes.json.migrated`. IDs and timestamps are preserved. Commando polls for edits made in Obsidian and requires an explicit reload or overwrite if an external edit conflicts with unsaved browser changes.

The block editor intentionally exposes only content that round-trips through standard Markdown: paragraphs, headings, bulleted and numbered lists, checklists, quotes, code blocks, dividers, links, bold, italic, strikethrough, and inline code.

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

Unfocused browser terminals preserve the source tmux pane's columns and rows. If the source grid is larger than its card, the grid scrolls instead of reflowing or clipping. Focused terminals request a real tmux resize and wait for the authoritative reseed instead of resizing xterm optimistically. Seeds restore the normal and alternate screens, tab stops, scroll margins, wrapping, keypad, mouse, and cursor state before live output resumes. xterm.js owns local scrollback, terminal attributes, Unicode cell widths, cursor state, and IME input. Literal input and semantic special keys use the persistent controller so tmux can preserve pane application-key modes without spawning a process for each key. Paste is sent through a dedicated tmux buffer with a 256 KiB UTF-8 limit.

The terminal renderer bundles JetBrains Mono and uses the Rosé Pine Moon palette from the local WezTerm profile. Production CSP allows inline styles because xterm.js requires measured inline canvas and viewport styles; scripts remain restricted to the application origin. The Refresh action also requests authoritative pane reseeds.

Tmux-generated copy-mode UI is not emitted by control mode. Page Up, Page Down, and the mouse wheel therefore navigate xterm.js scrollback and the source-sized current screen instead of entering tmux copy mode.

## Terminal Profile

The browser terminal mirrors the local WezTerm profile with a 10 px font size and the Rosé Pine Moon palette. It uses the scheme's original muted ANSI and bright colors without browser contrast correction, and bold ANSI colors use their bright variants to match WezTerm's default bold-color behavior.

The font stack starts with `JetBrains Mono`, then falls back to `SFMono-Regular`, `Cascadia Mono`, `Menlo`, `Consolas`, `Liberation Mono`, and the browser's generic monospace font. Commando does not currently bundle a web font, so exact JetBrains Mono rendering requires that font to be installed and available to the browser. Bundled browser font loading remains a follow-up.

## Security

- The daemon binds only to `127.0.0.1`.
- HTTP and WebSocket access require the ephemeral token.
- Host and Origin headers are limited to loopback hosts.
- Browser input can execute shell commands in the selected pane; access to Commando is equivalent to local shell access.
- Attributed seed captures, live stream buffers, and status-inference tails are bounded and kept in memory. Commando persists layouts, not terminal output.
- Production assets use a restrictive Content Security Policy.

For automated or destructive testing, use a dedicated tmux socket:

```bash
tmux -L commando-qa -f /dev/null new-session -d -s qa
COMMANDO_TMUX_SOCKET_NAME=commando-qa COMMANDO_TOKEN=qa-token npm run dev
```

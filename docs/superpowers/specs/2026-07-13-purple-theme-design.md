# Purple-throughout UI theme

**Date:** 2026-07-13
**Status:** Approved

## Problem

The commando UI mixes a green primary accent (`--green: #85f4b1`) and green-cast
dark neutrals with a purple that only appears on the Claude provider badge
(`--purple: #b9a3ff`). The palette should read as one purple theme.

## Decision

Full retint to purple, with semantic green preserved in exactly two places.

### Tokens (`src/styles.css` `:root`)

Keep the current lightness/contrast relationships; shift the hue cast from
green to purple:

| Token | Old | New |
|---|---|---|
| `--bg` | `#07100e` | `#0c0a14` |
| `--surface` | `#0a1411` | `#100d1a` |
| `--surface-raised` | `#0d1916` | `#131020` |
| `--surface-soft` | `#11201c` | `#181428` |
| `--surface-hover` | `#162721` | `#1f1a31` |
| `--border` | `#22362f` | `#2c2542` |
| `--border-strong` | `#315046` | `#443a63` |
| `--text` | `#f3f7f5` | `#f5f3fa` |
| `--text-soft` | `#bccbc6` | `#c6c0d6` |
| `--muted`, `--muted-dim` | `#82968e` | `#8f87a6` |

### Accent

- Add `--accent: #b9a3ff` and `--accent-ink: #0e0a1c`.
- Every decorative `var(--green)` / `var(--green-ink)` usage becomes
  `var(--accent)` / `var(--accent-ink)`: focus rings, primary buttons, active
  tabs, status dots and pulse animations, glows.
- Every decorative hardcoded `rgba(133, 244, 177, α)` becomes
  `rgba(185, 163, 255, α)`, including the body radial background glow.
- `src/linear-section.css`: live-status dot and drop-target greens go purple.
- `index.html`: `theme-color` meta → `#0c0a14`; favicon SVG fill → `#b9a3ff`,
  glyph stroke → dark purple ink.

### Semantic green (kept)

`--green: #85f4b1` stays defined, used only by:

- `.pane-state.done` (success state)
- `.pane-icon.provider-opencode` / `.agent-avatar.provider-opencode`
  (identity, distinguishes OpenCode from Claude's purple) — including their
  green rgba backgrounds

### Out of scope

- `src/XtermPane.tsx` ANSI terminal theme (content colors, Rosé Pine Moon)
- `.lavish/commando-product-blueprint.html` (generated document)

## Verification

`npm run typecheck`, `npm test`, then `npm run dev` and a visual pass in the
browser. Branch `purple-theme` is left unmerged for review.

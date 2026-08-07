# Redline components — Aura visual treatment

Date: 2026-08-07
Status: approved (design picked by Leo via a redline review session — option "C — Aura",
chosen over Signal, Quiet, and an Aura+pills hybrid; mock at the session scratchpad's
`redline-design-pick/index.html`)

## Problem

The redline components ship with DaisyUI utility classes but artifacts usually don't load
DaisyUI — agents correctly match the subject project's design system instead (the skill's
own priority order). The components then fall back to bare browser controls: unstyled
radios, default textareas, default buttons, clashing with otherwise polished artifacts.

## Goal

Components look excellent everywhere with **zero artifact cooperation**: no design-kit
dependency, no classes to include, automatic adaptation to dark and light artifacts.

## Design (the "Aura" treatment)

All work happens in `server/static/redline-sdk.js` (plus its test and two doc touches).

1. **Injected stylesheet.** The SDK injects a single `<style data-redline-styles>` block
   into `document.head` once at load (guarded like `defineOnce`; re-evaluation must not
   duplicate it). SDK markup drops every DaisyUI utility class (`btn`, `radio`,
   `checkbox`, `textarea`, `badge`, `rating`, `mask` …); components keep their structural
   classes (`redline-queue`, `redline-options`, `redline-prompt`, `redline-comment`,
   `redline-queued-badge`) which the stylesheet targets.

2. **Zero-specificity scoping.** Every rule is wrapped in `:where()` selectors rooted at
   the five element names (e.g. `:where(redline-choice) .redline-queue`), so artifact CSS
   overrides ours with any ordinary selector, no `!important` needed.

3. **The look** (per the approved mock):
   - Glass panel: rounded 16px, translucent surface
     (`color-mix(in oklab, currentColor 5%, transparent)`), `backdrop-filter: blur`,
     gradient border via the mask-composite trick, soft ambient radial glow anchored
     bottom-right.
   - Choices (choice single+multi, approve verdicts, rating 1..max): a segmented control —
     joined cells, hairline separators, selected cell filled with the accent gradient,
     white text; hover states; wraps gracefully (`flex-wrap`) when options are many/long.
     Native inputs stay in the DOM (visually hidden, accessible) exactly as today;
     selection styling via `label:has(:checked)`.
   - Textareas/inputs: translucent field, hairline border, accent border + soft glow on
     focus.
   - Queue button: accent gradient, glow shadow, translateY lift on hover, disabled state
     dimmed (binding-absent path unchanged).
   - Queued state: button turns success (green mix), text "Queued ✓"; the badge becomes a
     small success chip with a fade/slide-in animation. Same DOM hooks and text as today —
     tests and the note pipeline see no behavioral change.
   - Prompt: semibold, slight negative letter-spacing.

4. **Theming.** All neutrals derive from `currentColor` via `color-mix(in oklab, …)` —
   this is what makes one stylesheet correct on dark and light artifacts. Accent comes
   from CSS custom properties with defaults:
   `--redline-accent: #7c6cf6`, `--redline-accent2: #5aa9f7`, read on the component
   (inherited, so artifacts set them on `:root` or any ancestor). Browser floor: `:has()`
   and `color-mix()` (Chrome 121+ / any modern browser); tiles run the daemon-managed
   Chrome, so no fallback layer is needed — a very old external browser just gets
   uglier-but-functional controls.

5. **Behavior is untouched.** Queue discipline, binding contract, payload shapes,
   re-arm poller, caps — all unchanged. This is a presentation-only change; the jsdom
   tests change only where they assert class names that no longer exist (e.g. the
   rating's `mask mask-star-2`), not behavior. Add one new test: the style block is
   injected exactly once across double SDK evaluation.

6. **Docs.** `skills/redline/SKILL.md` + `playbooks/input.md`: one line each — components
   are fully self-styled (design kit not required for their looks) and the accent is
   overridable via `--redline-accent`/`--redline-accent2`.

## Verification

- jsdom suite green (updated), full `npm test` + typecheck green.
- Live visual check on an isolated stack before merge: one dark and one light artifact,
  screenshots of choice/approve/rating/ask in rest, hover-ish, selected, and queued
  states; confirm an artifact-set `--redline-accent` override takes effect.

## Out of scope

- Restyling the commando client's pill strip (already themed).
- Any change to transport, note shape, or the design-kit routes.

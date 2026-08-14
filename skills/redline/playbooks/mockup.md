# Playbook: mockup

Use for any artifact that shows current or proposed product UI: a whole screen,
device view, component, state, interaction, before/after, or visual direction.
This playbook is additive. Also read `plan.md`, `comparison.md`, or `input.md`
when the artifact performs those jobs.

## Start from evidence

Before writing markup, inspect the subject rather than the artifact shell:

- Capture the running current UI when it exists. Embed that screenshot for the
  current state instead of reconstructing it from prose.
- Read the exact token/theme files, font setup, component styles, and icons or
  images used by the relevant screen. Record the source paths for your own
  verification and name the design source when opening the review.
- Reuse real labels and representative data. Empty rectangles, lorem ipsum,
  generic circles, and invented navigation make a layout look finished while
  hiding whether it actually works.
- If there is no existing product system, state that clearly and define a
  deliberate concept direction before building. A concept is valid; an
  unlabeled generic wireframe pretending to be faithful is not.

## Preserve the product surface

The explanatory document and the product preview are different visual layers.
The Commando fallback theme may style the document around a mockup, but the
mockup must have scoped product CSS and its own tokens. Do not let fallback
body typography, panel padding, colors, or form rules cascade into the preview.

Prefer these sources, in order:

1. The real running page/component, opened directly when it is safe to review.
2. A screenshot of current UI plus a source-faithful proposed state beside it.
3. A DOM replica built from the project's exact tokens, assets, dimensions,
   states, and content.
4. An explicitly labeled concept with a documented new art direction.

## Scale and legibility

- Render focused component work at or near 1:1 CSS-pixel scale.
- For a whole mobile or desktop screen, size the frame to the target viewport.
  If it must be reduced to fit, label the scale and pair it with a full-size
  crop or `<redline-lightbox>` view of the area under review.
- Do not place a complete device mockup inside a narrow document card when that
  makes labels, controls, or state differences unreadable in the actual tile.
- Match the target's type sizes, line heights, control heights, radii, spacing,
  icon weight, shadows, borders, and density. Color matching alone is not
  fidelity.
- Show the states that make the decision real: default plus whichever of
  selected, hover/focus, loading, empty, error, expanded, keyboard, narrow, or
  long-content states apply.

## Comparisons

Before/after and option comparisons must keep the same viewport, data, crop,
and scale so differences are attributable to the proposal. Change only the
variables being reviewed. Put rationale outside the product surface rather
than annotating the mockup with UI that the product would never render.

## Required visual check

After opening the Chromium tile, use its CDP endpoint to capture the page at
the user's actual tile viewport. Compare the rendered preview with the source
evidence. Reject and revise the artifact if:

- text or controls are too small to review without zooming;
- the product preview inherits document-theme typography or spacing;
- content clips, overlaps, overflows, or disappears at the tile width;
- fonts, icons, or images failed to load;
- the current-state reconstruction differs materially from the real screen;
- the proposal is represented only by prose or a decorative miniature.

Do not tell the user the mockup is ready until this check passes or you have
explicitly disclosed what could not be verified.

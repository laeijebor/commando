# Playbook: comparison

Use for options, tradeoffs, or current-vs-target framing where the user needs
to pick one path forward.

## Shape

Two layouts, pick whichever reads better for the content:

- **Side-by-side cards** — one card per option, each with the same internal
  sections (summary, pros, cons, cost/effort) so eyes can scan row-by-row
  across cards.
- **Criteria × options table** — rows are decision-relevant criteria, columns
  are options. Only include criteria that actually move the decision; a row
  that scores identically across every option is noise, cut it.

Either way, end with a **verdict row/card**: which option you'd pick and why,
in one line. Don't make the reader assemble the verdict themselves from the
raw comparison.

## Recommendation

Visually mark the recommended option (border, badge, background tint —
whatever the design kit's accent color is) and state the reason in one line
directly under/beside it: "Recommended — least migration risk," not a
paragraph.

## Let the user decide in place

Pair the comparison with a `<redline-choice>` scoped to the options so the
user can pick the winner without leaving the tile:

```html
<redline-choice key="decision" prompt="Which approach should we build?"
  options="Option A,Option B,Option C"></redline-choice>
```

Put it right after the verdict, not buried at the bottom of the page.

## Keep it scannable

- Truncate long prose in cells; put detail in the card/row's expanded text or
  a footnote, not inline in the comparison grid.
- Consistent units and phrasing across rows — "2 days" not "2 days" in one
  row and "~2d" in the next.
- Prevent horizontal overflow: wrap a wide table in `overflow-x:auto` per the
  base SKILL.md rule.

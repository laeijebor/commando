# Playbook: table

Use for dense records that need scan-friendly review — logs, inventories,
config lists, anything row-oriented.

## Layout rules

- **Right-align numeric columns.** Left-aligned numbers are hard to compare
  down a column; right-aligned, the magnitudes line up.
- **One visual-emphasis column max.** Pick the single column the decision
  hinges on (status, risk, delta) and bold/color/badge only that one. Every
  column emphasized is no column emphasized.
- **Sticky header for >20 rows**: `position: sticky; top: 0` on the `<th>`
  row (with a background color so body rows don't show through) so the
  header stays visible while scrolling.
- **Wrap in `overflow-x: auto`**, never let the table force the page to
  scroll horizontally:

  ```html
  <div class="redline-table-wrap">
    <table>...</table>
  </div>
  ```

- **Truncate long cells, keep the full value on hover**: `text-overflow:
  ellipsis` plus a `title` attribute carrying the untruncated text — the
  reader can still get the full value without blowing up row height.

## Sort order

Sort by the column the decision actually needs — severity descending for a
triage table, chronological for a log, alphabetical only if the table is a
lookup reference rather than something being acted on. State the sort order
in a one-line caption above the table if it isn't obvious from the data.

## Annotation

Give the table's wrapping section a stable `id` per the base skill. If
individual rows are independently actionable (e.g. a triage list), consider
row-level `id`s too so a note can point at one row instead of "the table."

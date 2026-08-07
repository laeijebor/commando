# Playbook: code

Use for source excerpts, patches, diffs, or before/after comparisons.

## Markup

Plain `<pre><code>` with minimal inline highlighting — wrap keywords/strings
in `<span>`s with hand-picked colors if it genuinely helps, but do not pull
in highlight.js or any other CDN dependency. Artifacts stay dependency-free
beyond the daemon's own design kit.

## Diffs

Prefix added/removed lines with `+`/`-` and give each a colored left border
(green for additions, red for removals) so the diff reads at a glance without
relying on the prefix character alone:

```html
<pre><code
><span class="diff-add">+ const url = artifact.url</span>
<span class="diff-del">- const url = artifact.path</span>
</code></pre>
```

```css
.diff-add { border-left: 3px solid #2da44e; background: rgba(45,164,78,.08); }
.diff-del { border-left: 3px solid #cf222e; background: rgba(207,34,46,.08); }
```

## Heading every snippet

Every snippet gets a heading naming the file and line range it came from —
`server/redline.ts:42-58` — so a note on the snippet maps straight back to an
edit point, same as any other stable-`id` section.

## Line length

Wrap long lines (`white-space: pre-wrap; word-break: break-word` on the
`<code>` block) rather than letting the snippet force horizontal scroll on
the page. A wrapped line is still readable; a page that scrolls sideways to
show one function is not.

## Pairing with review controls

Pair a risky or debatable hunk with `<redline-approve>` right under it so the
user can sign off on that specific change instead of the whole artifact:

```html
<redline-approve key="hunk-42" prompt="OK to land this hunk?"></redline-approve>
```

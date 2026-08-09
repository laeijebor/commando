# Playbook: code

Use for source excerpts, patches, diffs, or before/after comparisons.

## Markup

Plain `<pre class="redline-code"><code>` with minimal inline highlighting — wrap keywords/strings
in `<span>`s with hand-picked colors if it genuinely helps, but do not pull
in highlight.js or any other CDN dependency. Artifacts stay dependency-free
beyond the daemon's own design kit.

## Diffs

Prefix added/removed lines with `+`/`-` and give each a colored left border
(green for additions, red for removals) so the diff reads at a glance without
relying on the prefix character alone:

```html
<pre class="redline-code"><code
><span class="redline-diff-add">+ const url = artifact.url</span>
<span class="redline-diff-del">- const url = artifact.path</span>
</code></pre>
```

Those classes are included in the default theme. When matching a project
design system instead, provide equivalent non-color cues and treatment there.

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

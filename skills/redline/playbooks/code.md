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

For an inspectable file change, prefer `<redline-code-diff>`: it reads plain
text from a direct `<pre data-diff-source>` child, numbers lines from unified
`@@` hunk headers, folds long unchanged runs, and offers Unified / Side by
side buttons (`view="side-by-side"` selects the initial alternate layout).
Its source is text, **never HTML**: escape `<`, `>`, and `&` in authored HTML
(`&lt;`, `&gt;`, `&amp;`). The SDK uses `textContent` when rendering rows, so
diff contents cannot become executable markup. Do not inject a raw patch into
`innerHTML`; create text nodes or escape it first. Anchor the component with a
stable ID and link to it from a `<redline-file-tree>` file's `data-diff="#id"`.
The component visibly labels its provenance: proposed/not applied by default,
or `provenance="actual"` for a verified repository diff. Supply `file` and
`range` for its compact source header. Each unified `@@` hunk receives a
stable `#<component-id>-hunk-1` target (and `-old` / `-new` counterparts in
the paired view), so a reviewer can link to a specific hunk.

```html
<redline-file-tree id="files" heading="Files">
  <ul><li id="session-map" data-path="server/session.ts" data-status="modify"
    data-diff="#session-diff">server/session.ts — proposed persistence change</li></ul>
</redline-file-tree>
<redline-code-diff id="session-diff" heading="Persistence change" file="server/session.ts" range="42–43">
  <pre data-diff-source>@@ -42,2 +42,2 @@
-return &lt;Session value={memory.get(id)} /&gt;
+return &lt;Session value={store.get(id)} /&gt;
 context line</pre>
</redline-code-diff>
```

Alternatively, author direct `[data-line][data-kind]` children for individually
numbered `context`, `delete`, and `add` lines. Their contents are still text;
`data-line` supplies the line number and the SDK supplies +/- prefixes:

```html
<redline-code-diff id="config-diff" heading="TTL change" file="server/config.ts" range="7" view="side-by-side">
  <div data-line="7" data-kind="delete">const ttl = 30</div>
  <div data-line="7" data-kind="add">const ttl = 60</div>
</redline-code-diff>
```

## Heading every snippet

Every snippet gets a heading naming the file and line range it came from —
`server/redline.ts:42-58` — so a note on the snippet maps straight back to an
edit point, same as any other stable-`id` section.

## Line length

For ordinary `<pre><code>`, wrap long lines (`white-space: pre-wrap;
word-break: break-word`). The dedicated diff keeps code alignment and scrolls
inside the component; it should never force the entire page sideways.

## Pairing with review controls

Pair a risky or debatable hunk with `<redline-approve>` right under it so the
user can sign off on that specific change instead of the whole artifact:

```html
<redline-approve key="hunk-42" prompt="OK to land this hunk?"></redline-approve>
```

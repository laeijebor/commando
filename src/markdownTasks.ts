const TASK_MARKER = /^([-*+]|\d+[.)])([ \t]+)\[([ xX])\]/

/**
 * Flip the `- [ ]` / `- [x]` marker of the task list item that starts at
 * `offset` in `markdown`. Offsets come from the source positions react-markdown
 * puts on `li` nodes, so a click maps back to exactly one item even when
 * several share the same text. Returns null when the offset does not land on a
 * task item, which keeps a stale render from rewriting unrelated Markdown.
 */
export function toggleMarkdownTaskAt(markdown: string, offset: number): string | null {
  if (!Number.isInteger(offset) || offset < 0 || offset >= markdown.length) return null
  const marker = TASK_MARKER.exec(markdown.slice(offset))
  if (!marker) return null
  const [matched, bullet, gap, state] = marker
  const checked = state !== ' '
  const box = offset + bullet.length + gap.length
  return `${markdown.slice(0, box)}[${checked ? ' ' : 'x'}]${markdown.slice(offset + matched.length)}`
}

/**
 * A deliberately small Markdown reader for recap text. The desktop worklog
 * runs `react-markdown` + GFM; the phone only has to render what an agent
 * actually writes in a recap — paragraphs, bullet lists, bold and inline code —
 * so this returns blocks of inline spans that the view maps onto `<Text>`.
 * Images are dropped, exactly as the desktop's `img()` override does.
 */

export type InlineSpan = { text: string; bold?: boolean; code?: boolean }

export type MarkdownBlock =
  | { kind: 'paragraph'; spans: InlineSpan[] }
  | { kind: 'heading'; level: number; spans: InlineSpan[] }
  | { kind: 'bullet'; spans: InlineSpan[]; ordinal?: string }

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__)/g
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g
const LINK = /\[([^\]]*)\]\(([^)]*)\)/g

/** `**bold**`, `__bold__` and `` `code` `` become spans; links keep their text. */
export function parseInline(source: string): InlineSpan[] {
  const cleaned = source.replace(IMAGE, '').replace(LINK, '$1')
  const spans: InlineSpan[] = []
  let index = 0
  for (const match of cleaned.matchAll(INLINE)) {
    const start = match.index ?? 0
    if (start > index) spans.push({ text: cleaned.slice(index, start) })
    const token = match[0]
    if (token.startsWith('`')) spans.push({ text: token.slice(1, -1), code: true })
    else spans.push({ text: token.slice(2, -2), bold: true })
    index = start + token.length
  }
  if (index < cleaned.length) spans.push({ text: cleaned.slice(index) })
  return spans.filter((span) => span.text.length > 0)
}

/** Splits recap Markdown into the block kinds the sheet knows how to draw. */
export function parseMarkdown(source: string | undefined): MarkdownBlock[] {
  if (!source) return []
  const blocks: MarkdownBlock[] = []
  let paragraph: string[] = []

  const flush = (): void => {
    if (!paragraph.length) return
    const spans = parseInline(paragraph.join(' '))
    if (spans.length) blocks.push({ kind: 'paragraph', spans })
    paragraph = []
  }

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line) {
      flush()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, spans: parseInline(heading[2] ?? '') })
      continue
    }
    const bullet = /^[-*+]\s+(.*)$/u.exec(line)
    if (bullet) {
      flush()
      const spans = parseInline(bullet[1] ?? '')
      if (spans.length) blocks.push({ kind: 'bullet', spans })
      continue
    }
    const ordered = /^(\d{1,3})[.)]\s+(.*)$/u.exec(line)
    if (ordered) {
      flush()
      const spans = parseInline(ordered[2] ?? '')
      if (spans.length) blocks.push({ kind: 'bullet', spans, ordinal: `${ordered[1] ?? ''}.` })
      continue
    }
    paragraph.push(line)
  }
  flush()
  return blocks
}

/**
 * PR descriptions and review comments are GitHub-flavoured Markdown with HTML
 * mixed in: hidden `<!-- … -->` state (Commando's PR markers, review bots'
 * bookkeeping), `<details>` folds, `<img>` tags from drag-and-drop uploads and
 * the odd `<br>`. The desktop renders that HTML through rehype; the phone's
 * native Markdown only knows Markdown, so this turns the common tags into
 * their Markdown equivalents and drops the rest. Fenced code is left alone.
 */

const FENCE = /^\s{0,3}(`{3,}|~{3,})/u

/** Tags dropped once their useful parts are converted; their text stays, on its own line for a block tag. */
const BLOCK_TAGS = /<\/?(?:p|div|details|picture|source|center|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|blockquote|hr)\b[^>]*>/giu
const INLINE_TAGS = /<\/?(?:span|sub|sup|small|kbd|ins|g-emoji|relative-time)\b[^>]*>/giu

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu').exec(tag)
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined
}

const CODE_SPAN = /(`+)[\s\S]*?\1/gu
const PLACEHOLDER = /\u0000(\d+)\u0000/gu

/** Inline code keeps its tags as written: they are set aside before converting and put back after. */
function convert(text: string): string {
  const spans: string[] = []
  const protectedText = text.replace(CODE_SPAN, (span) => `\u0000${spans.push(span) - 1}\u0000`)
  return convertHtml(protectedText).replace(PLACEHOLDER, (_whole, index: string) => spans[Number(index)] ?? '')
}

function convertHtml(text: string): string {
  return text
    // A line break inside a table row would split the row, so it becomes a separator there.
    .replace(/^(\s*\|.*)$/gmu, (row) => row.replace(/<br\s*\/?>/giu, ' · '))
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<img\b[^>]*>/giu, (tag) => {
      const src = attribute(tag, 'src')
      if (!src) return ''
      const alt = (attribute(tag, 'alt') ?? 'image').replace(/[[\]]/gu, '')
      return `\n\n![${alt}](${src})\n\n`
    })
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu, (_whole, attributes: string, inner: string) => {
      const href = attribute(attributes, 'href')
      const label = inner.replace(/<[^>]+>/gu, '').trim()
      if (!href) return label
      // An <a> wrapping an image becomes the image; the link still opens from the image viewer's source.
      if (/!\[[^\]]*\]\([^)]*\)/u.test(inner)) return inner
      return `[${label || href}](${href})`
    })
    .replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/giu, (_whole, inner: string) => `\n\n**${inner.replace(/<[^>]+>/gu, '').trim()}**\n\n`)
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/?(?:b|strong)>/giu, '**')
    .replace(/<\/?(?:i|em)>/giu, '_')
    .replace(/<code>([\s\S]*?)<\/code>/giu, '`$1`')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/giu, (_whole, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${inner.trim()}\n\n`)
    .replace(BLOCK_TAGS, '\n')
    .replace(INLINE_TAGS, '')
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/gu, '\n\n')
}

export function githubMarkdown(body: string): string {
  const out: string[] = []
  let prose: string[] = []
  let fence: string | null = null
  const flush = () => {
    if (prose.length) out.push(convert(prose.join('\n')))
    prose = []
  }
  for (const line of body.replace(/\r\n?/gu, '\n').split('\n')) {
    const marker = FENCE.exec(line)?.[1]
    if (fence) {
      out.push(line)
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
    } else if (marker) {
      flush()
      fence = marker
      out.push(line)
    } else {
      prose.push(line)
    }
  }
  flush()
  return out.join('\n').trim()
}

import { canvasRelativePath, parseCanvasManifest, type CanvasManifestResult } from './canvas-manifest.js'

type Element = { tag: string; attrs: Record<string, string>; children: (Element | string)[] }
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', middot: '·', copy: '©', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' }
export function decodeDeckText(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, key: string) => {
    if (!key.startsWith('#')) return entities[key.toLowerCase()] ?? entity
    const value = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1))
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : entity
  })
}

/** Small structural tokenizer: no DOM dependency, and raw script/style contents never become slides. */
function elements(html: string): Element {
  const root: Element = { tag: '', attrs: {}, children: [] }, stack = [root]
  const tokens = html.match(/<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+|</gi) ?? []
  for (const token of tokens) {
    if (token.startsWith('<!--')) continue
    const close = /^<\/([\w-]+)/.exec(token)
    if (close) { const index = stack.map((node) => node.tag).lastIndexOf(close[1].toLowerCase()); if (index > 0) stack.length = index; continue }
    const open = /^<([\w-]+)/.exec(token)
    if (!open) { stack.at(-1)!.children.push(token); continue }
    const tag = open[1].toLowerCase(), attrs: Record<string, string> = {}
    for (const match of token.slice(open[0].length, token.lastIndexOf('>')).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[match[1].toLowerCase()] = decodeDeckText(match[2] ?? match[3] ?? match[4] ?? '')
    const node = { tag, attrs, children: [] }
    stack.at(-1)!.children.push(node)
    if (!['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'script', 'style'].includes(tag) && !token.endsWith('/>')) stack.push(node)
  }
  return root
}
const children = (node: Element): Element[] => node.children.filter((child): child is Element => typeof child !== 'string')
const descendants = (node: Element): Element[] => children(node).flatMap((child) => [child, ...descendants(child)])
const hasClass = (node: Element, name: string) => (node.attrs.class ?? '').split(/\s+/).includes(name)
const rawText = (node: Element): string => node.children.map((child) => typeof child === 'string' ? decodeDeckText(child) : child.tag === 'br' ? ' ' : rawText(child)).join('')
const textOf = (node: Element): string => rawText(node).replace(/\s+/g, ' ').trim()
const validId = (id: string) => /^[A-Za-z0-9_-]{1,64}$/.test(id)

export function parseDeck(html: string, deckPath: string): CanvasManifestResult & { deck: NonNullable<CanvasManifestResult['deck']>; warnings: string[] } {
  const nodes = descendants(elements(html)), errors: string[] = [], warnings: string[] = []
  const meta = (name: string) => nodes.find((node) => node.tag === 'meta' && node.attrs.name === name)?.attrs.content
  const title = meta('deck:title') || textOf(nodes.find((node) => node.tag === 'title') ?? { tag: '', attrs: {}, children: [] }) || 'Slides'
  const rawSize = meta('deck:size'), size = rawSize === 'a4' ? 'a4' : '16:9'
  if (rawSize && rawSize !== 'a4' && rawSize !== '16:9') warnings.push(`deck:size: unknown size "${rawSize}"; using 16:9`)
  const width = size === 'a4' ? 794 : 1280, height = size === 'a4' ? 1123 : 720
  const themeHref = nodes.find((node) => node.tag === 'link' && node.attrs.id === 'theme')?.attrs.href
  const theme = /^themes\/([a-z0-9-]{1,40})\.css$/.exec(themeHref ?? '')?.[1] ?? 'ink'
  if (themeHref && !/^themes\/[a-z0-9-]{1,40}\.css$/.test(themeHref)) warnings.push('theme: expected themes/<name>.css')
  const deck: NonNullable<CanvasManifestResult['deck']> = { title, size, width, height, theme, slides: [] }
  const manifest: CanvasManifestResult['manifest'] = { title, pages: [], sections: [], frames: [], annotations: [] }
  const main = nodes.find((node) => node.tag === 'main' && hasClass(node, 'deck'))
  if (!main) errors.push(`${deckPath}: missing <main class="deck">`)
  if (!canvasRelativePath(deckPath)) errors.push(`${deckPath}: invalid deck path`)
  const ids = new Set<string>(), keys = new Set<string>()
  const slides = main ? children(main).filter((node) => node.tag === 'section' && hasClass(node, 'slide')) : []
  slides.forEach((node, index) => {
    const id = node.attrs.id ?? `slide-${index + 1}`
    if (!node.attrs.id) warnings.push(`slide ${index + 1}: missing id; using ${id}`)
    if (!validId(id) || ids.has(id)) { errors.push(`slide ${index + 1}: invalid or duplicate id "${id}"`); return }
    ids.add(id)
    const contents = descendants(node), title = node.attrs['data-title'] || textOf(contents.find((child) => child.tag === 'h1' || child.tag === 'h2') ?? { tag: '', attrs: {}, children: [] }) || `Slide ${index + 1}`
    const notes = contents.filter((child) => child.tag === 'aside' && hasClass(child, 'notes'))
    if (notes.length > 1) warnings.push(`${id}: at most one notes aside is allowed`)
    deck.slides.push({ id, title, notes: notes[0] ? textOf(notes[0]) : '' })
    const x = index * (width + 120)
    manifest.frames.push({ id, title, src: deckPath, slide: id, x, y: 0, w: width, h: height, focus: index + 1, interactive: false })
    contents.filter((child) => child.tag === 'aside' && hasClass(child, 'ask')).forEach((ask, i) => {
      const key = ask.attrs['data-key'] ?? `${id}-ask-${i + 1}`, text = textOf(ask)
      const fail = (reason: string) => errors.push(`${id} ask ${i + 1}: ${reason}`)
      if (!validId(key) || keys.has(key)) { fail('invalid or duplicate data-key'); return }
      keys.add(key)
      if (!text || text.length > 256) { fail('question text must be 1–256 characters'); return }
      let options: string[] | undefined
      if ('data-options' in ask.attrs) {
        try {
          const value: unknown = JSON.parse(ask.attrs['data-options'])
          if (!Array.isArray(value) || !value.length || value.length > 50 || !value.every((option) => typeof option === 'string' && option.trim() && option.length <= 256)) throw new Error()
          options = value
        } catch { fail('data-options must be JSON with 1–50 non-empty strings of at most 256 characters'); return }
      }
      const multiple = 'data-multiple' in ask.attrs
      if (multiple && !options) warnings.push(`${id} ask ${i + 1}: data-multiple requires options`)
      manifest.annotations.push({ id: `ask-${key}`, kind: 'question', key, text, options, multiple: multiple && !!options, ...('data-answer' in ask.attrs ? { answer: ask.attrs['data-answer'] } : {}), target: { frame: id }, x, y: height + 40 + i * 180, w: 360 })
    })
  })
  if (!slides.length) errors.push(`${deckPath}: no slides found`)
  return { manifest, errors, warnings, deck }
}

/** A canvas whose manifest is an HTML deck rather than canvas.json. */
export const isDeckPath = (path: string | null | undefined): boolean => typeof path === 'string' && path.endsWith('.html')
export const parseCanvasSource = (text: string, path: string): CanvasManifestResult => isDeckPath(path) ? parseDeck(text, path) : parseCanvasManifest(text)

import type { Dir, Stats } from 'node:fs'
import { opendir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { ChatItem, ChatReplyDeck, ChatReplyResource } from '../shared/agent-chat.js'
import { isDeckPath, parseDeck } from '../shared/deck.js'
import { localImagePath } from './chat-reply-images.js'

const parser = unified().use(remarkParse).use(remarkGfm)
type Node = { type: string; url?: string; value?: string; identifier?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } }
type Reference = { ref: string; explicit: boolean }
const localLink = (ref: string) => /^(?:\/(?!\/)|~\/|\.\.?\/|file:\/\/)/i.test(ref)

/** Only actual links and single-backtick inline code participate. */
export function markdownResourceReferences(text: string): Reference[] {
  const definitions = new Map<string, string>()
  const found: (Reference | { identifier: string })[] = []
  const visit = (node: Node) => {
    if (node.type === 'code') return
    if (node.type === 'definition' && node.identifier && node.url !== undefined && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url)
    if (node.type === 'link' && node.url) found.push({ ref: node.url, explicit: true })
    if (node.type === 'linkReference' && node.identifier) found.push({ identifier: node.identifier })
    if (node.type === 'inlineCode' && node.value && node.value.length <= 1024) {
      const raw = text.slice(node.position?.start.offset, node.position?.end.offset)
      const ref = node.value
      const path = ref.replace(/:\d+(?::\d+)?$/, '')
      if (/^`[^`]/.test(raw) && !raw.slice(1, -1).includes('\n') && !/[\r\n]/.test(ref) &&
        !/^[a-z][a-z\d+.-]*:/i.test(path) && !path.startsWith('//') &&
        (localLink(path) || path.includes('/') || /^[^\s/]+\.[a-z\d][\w.-]*$/i.test(path))) found.push({ ref, explicit: false })
    }
    node.children?.forEach(visit)
  }
  visit(parser.parse(text) as Node)
  const refs = found.flatMap((entry): Reference[] => {
    const ref = 'identifier' in entry ? definitions.get(entry.identifier) : entry.ref
    const explicit = 'identifier' in entry || entry.explicit
    return ref && (!explicit || localLink(ref)) ? [{ ref, explicit }] : []
  })
  // A link wins over code mentioning the same missing path.
  const unique = new Map<string, Reference>()
  for (const entry of refs) unique.set(entry.ref, { ...entry, explicit: entry.explicit || unique.get(entry.ref)?.explicit === true })
  return [...unique.values()]
}

type Metadata = Pick<Extract<ChatReplyResource, { kind: string }>, 'kind' | 'size' | 'mtimeMs' | 'entries'>

type Resolved = { path: string; metadata: Metadata } | { path: string; missing: true } | null
type ResourceFileSystem = { stat: (path: string) => Promise<Stats>; opendir: (path: string) => Promise<Dir>; readFile?: (path: string, encoding: 'utf8') => Promise<string> }
/** Larger HTML isn't read to look for a deck. */
const MAX_DECK_BYTES = 2 * 1024 * 1024
const absent = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')

export class ChatReplyResources {
  private readonly remembered = new Map<string, { mtimeMs: number; size: number; metadata: Metadata }>()
  private readonly parsed = new Map<string, { text: string; references: Reference[] }>()
  private readonly resolving = new Map<string, Promise<Resolved>>()
  private readonly decks = new Map<string, { mtimeMs: number; size: number; deck: Omit<ChatReplyDeck, 'folder' | 'manifest'> | null }>()
  private readonly loggedPaths = new Set<string>()
  private loggedFailure = false

  constructor(
    private readonly home = homedir(),
    private readonly log?: (message: string) => void,
    private readonly parse = markdownResourceReferences,
    private readonly files: ResourceFileSystem = { stat, opendir },
  ) {}

  async attach(items: readonly ChatItem[], cwd: string): Promise<ChatItem[]> {
    const attached: ChatItem[] = []
    // Preserve transcript order, with at most four filesystem operations in flight.
    for (let offset = 0; offset < items.length; offset += 25) {
      const end = Math.min(offset + 25, items.length)
      for (let start = offset; start < end; start += 4) {
        attached.push(...await Promise.all(items.slice(start, Math.min(start + 4, end)).map((item) =>
          item.kind === 'assistant_message' ? this.attachTo(item, cwd) : item)))
      }
      if (end < items.length) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    return attached
  }

  private references(item: Extract<ChatItem, { kind: 'assistant_message' }>): Reference[] {
    const known = this.parsed.get(item.id)
    if (known?.text === item.text) {
      this.parsed.delete(item.id)
      this.parsed.set(item.id, known)
      return known.references
    }
    const references = item.text.includes('`') || item.text.includes('[') ? this.parse(item.text) : []
    this.parsed.delete(item.id)
    this.parsed.set(item.id, { text: item.text, references })
    if (this.parsed.size > 2000) this.parsed.delete(this.parsed.keys().next().value!)
    return references
  }

  private async attachTo(item: Extract<ChatItem, { kind: 'assistant_message' }>, cwd: string): Promise<ChatItem> {
    try {
      const resources: ChatReplyResource[] = []
      for (const { ref, explicit } of this.references(item)) {
        const fragmentLine = explicit ? /#L(\d+)(?:-L\d+)?(?:$|[?&])/.exec(ref)?.[1] : undefined
        const address = explicit ? ref.split(/[?#]/, 1)[0] : ref
        const suffix = /:(\d+)(?::\d+)?$/.exec(address)
        const written = suffix ? address.slice(0, suffix.index) : address
        const path = localImagePath(written, cwd, this.home)
        if (!path) continue
        const resolved = await this.resolve(path)
        if (!resolved) continue
        if ('missing' in resolved) {
          if (explicit) resources.push({ ref, ...resolved })
        } else {
          const line = Number(fragmentLine ?? suffix?.[1])
          const deck = await this.deck(resolved.path, resolved.metadata.kind)
          resources.push({ ref, path: resolved.path, ...resolved.metadata, ...(line > 0 && Number.isSafeInteger(line) ? { line } : {}), ...(deck ? { deck } : {}) })
        }
        if (resources.length >= 50) break
      }
      const { resources: _previous, ...rest } = item
      return resources.length ? { ...rest, resources } : rest
    } catch (error) {
      if (!this.loggedFailure) {
        this.loggedFailure = true
        this.log?.(`Couldn't attach reply resources: ${error instanceof Error ? error.message : String(error)}`)
      }
      return item
    }
  }

  private report(path: string, error: unknown): void {
    if (this.loggedPaths.has(path)) return
    this.loggedPaths.add(path)
    if (this.loggedPaths.size > 500) this.loggedPaths.delete(this.loggedPaths.values().next().value!)
    this.log?.(`Couldn't read reply resource ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }

  private async resolve(path: string): Promise<Resolved> {
    const pending = this.resolving.get(path)
    if (pending) return pending
    const task = this.readPath(path)
    this.resolving.set(path, task)
    try { return await task } finally { this.resolving.delete(path) }
  }

  /** A slides deck: a folder with deck.html, or deck.html / another HTML page in such a folder. Parsed once per mtime. */
  private async deck(path: string, kind: 'file' | 'folder'): Promise<ChatReplyDeck | undefined> {
    const folder = kind === 'folder' ? path : dirname(path)
    const manifest = kind === 'folder' ? 'deck.html' : basename(path)
    // The slides tile reads only lowercase .html pages as decks (`isDeckPath`).
    if (kind === 'file' && !isDeckPath(manifest)) return undefined
    const html = join(folder, manifest)
    try {
      if (manifest !== 'deck.html' && !(await this.files.stat(join(folder, 'deck.html'))).isFile()) return undefined
      const stats = await this.files.stat(html)
      if (!stats.isFile() || stats.size > MAX_DECK_BYTES) return undefined
      let known = this.decks.get(html)
      if (known?.mtimeMs !== stats.mtimeMs || known.size !== stats.size) {
        const parsed = parseDeck(await (this.files.readFile ?? readFile)(html, 'utf8'), manifest).deck
        const slides = parsed.slides.length
        known = { mtimeMs: stats.mtimeMs, size: stats.size, deck: slides ? { title: parsed.title.slice(0, 200), slides, ...(parsed.slides[0].title ? { first: parsed.slides[0].title.slice(0, 200) } : {}) } : null }
        this.decks.delete(html)
        this.decks.set(html, known)
        if (this.decks.size > 200) this.decks.delete(this.decks.keys().next().value!)
      }
      return known.deck ? { ...known.deck, folder, manifest } : undefined
    } catch (error) {
      if (!absent(error)) this.report(html, error)
      return undefined
    }
  }

  private async readPath(written: string): Promise<Resolved> {
    let path = written
    let stats: Stats
    try { stats = await this.files.stat(path) } catch (error) {
      if (!absent(error)) { this.report(path, error); return null }
      let decoded: string
      try { decoded = decodeURIComponent(path) } catch { return { path, missing: true } }
      if (decoded === path) return { path, missing: true }
      try { stats = await this.files.stat(decoded); path = decoded } catch (error) {
        if (!absent(error)) { this.report(decoded, error); return null }
        return { path, missing: true }
      }
    }
    if (!stats.isFile() && !stats.isDirectory()) return null
    const known = this.remembered.get(path)
    if (known?.mtimeMs === stats.mtimeMs && known.size === stats.size &&
      (known.metadata.kind === 'file' || known.metadata.entries !== undefined)) return { path, metadata: known.metadata }
    const metadata: Metadata = { kind: stats.isDirectory() ? 'folder' : 'file', size: stats.size, mtimeMs: stats.mtimeMs }
    if (stats.isDirectory()) {
      try {
        let entries = 0
        for await (const _entry of await this.files.opendir(path)) { if (++entries >= 9999) break }
        metadata.entries = entries
      } catch (error) { this.report(path, error) }
    }
    this.remembered.delete(path)
    this.remembered.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, metadata })
    if (this.remembered.size > 500) this.remembered.delete(this.remembered.keys().next().value!)
    return { path, metadata }
  }
}

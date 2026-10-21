import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { ChatItem, ChatReplyImage, ChatReplyImageError } from '../shared/agent-chat.js'
import { MAX_STORED_IMAGE_BYTES, type ChatImageStore } from './chat-images.js'

/**
 * An agent shows a local image in its reply with Markdown, `![caption](/path.png)`.
 * The browser can't load a path on this machine, so the daemon stores the
 * file with the chat images and tells the renderer which stored image each
 * address means. Only images written that way are shown: a path in plain
 * text or backticks stays text.
 */

const MAX_IMAGES_PER_REPLY = 20
/** Remembered files, so a streaming reply doesn't reread its images on every update. */
const MAX_REMEMBERED = 500

const parser = unified().use(remarkParse).use(remarkGfm)

type MarkdownNode = { type: string; url?: string; identifier?: string; children?: MarkdownNode[] }

/** Image addresses in Markdown as the renderer reads them, in order, each once; code is skipped. */
export function markdownImageSources(text: string): string[] {
  if (!text.includes('![')) return []
  const definitions = new Map<string, string>()
  const found: ({ url: string } | { identifier: string })[] = []
  const visit = (node: MarkdownNode) => {
    if (node.type === 'image' && node.url) found.push({ url: node.url })
    else if (node.type === 'imageReference' && node.identifier) found.push({ identifier: node.identifier })
    else if (node.type === 'definition' && node.identifier && node.url !== undefined && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url)
    node.children?.forEach(visit)
  }
  visit(parser.parse(text) as MarkdownNode)
  const sources = found.map((entry) => 'url' in entry ? entry.url : definitions.get(entry.identifier)).filter((url): url is string => Boolean(url))
  return [...new Set(sources)]
}

/** The file an image address names on this machine, or null for a web address or anything else. */
export function localImagePath(src: string, cwd: string, home = homedir()): string | null {
  if (/^file:\/\//i.test(src)) {
    try {
      return fileURLToPath(src)
    } catch {
      return null
    }
  }
  // http:, data: and other schemes, protocol-relative addresses and fragments are not files.
  if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith('//') || src.startsWith('#')) return null
  if (src.startsWith('~/')) return join(home, src.slice(2))
  if (src.startsWith('~')) return null
  return isAbsolute(src) ? src : resolve(cwd, src)
}

type Resolved = { id: string } | { error: ChatReplyImageError }

export class ChatReplyImages {
  private readonly remembered = new Map<string, { mtimeMs: number; size: number; resolved: Resolved }>()

  constructor(
    private readonly store: Pick<ChatImageStore, 'saveReplyImage'>,
    private readonly home = homedir(),
  ) {}

  /** The items with each reply's local images attached; other items are returned as they are. */
  attach(items: readonly ChatItem[], cwd: string): Promise<ChatItem[]> {
    return Promise.all(items.map((item) => item.kind === 'assistant_message' ? this.attachTo(item, cwd) : item))
  }

  private async attachTo(item: Extract<ChatItem, { kind: 'assistant_message' }>, cwd: string): Promise<ChatItem> {
    const images: ChatReplyImage[] = []
    for (const src of markdownImageSources(item.text).slice(0, MAX_IMAGES_PER_REPLY)) {
      const path = localImagePath(src, cwd, this.home)
      if (path) images.push({ src, ...await this.resolve(path) })
    }
    const { images: _previous, ...rest } = item
    return images.length ? { ...rest, images } : rest
  }

  private async resolve(written: string): Promise<Resolved> {
    let path = written
    let stats = await stat(path).catch(() => null)
    // `My%20Shot.png` for `My Shot.png`: an agent may encode the address itself.
    if (!stats && path.includes('%')) {
      try {
        path = decodeURIComponent(path)
        stats = await stat(path).catch(() => null)
      } catch {
        // Not valid percent-encoding: the written path was the only candidate.
      }
    }
    if (!stats?.isFile()) return { error: 'missing' }
    if (stats.size > MAX_STORED_IMAGE_BYTES) return { error: 'too_large' }
    const known = this.remembered.get(path)
    if (known && known.mtimeMs === stats.mtimeMs && known.size === stats.size) return known.resolved
    let resolved: Resolved
    try {
      const saved = await this.store.saveReplyImage(await readFile(path))
      resolved = 'error' in saved ? { error: saved.error === 'too_large' ? 'too_large' : 'unsupported' } : { id: saved.id }
    } catch {
      // Unreadable now (permissions, or gone since the stat); not remembered, so a later update tries again.
      return { error: 'missing' }
    }
    this.remembered.delete(path)
    this.remembered.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, resolved })
    if (this.remembered.size > MAX_REMEMBERED) this.remembered.delete(this.remembered.keys().next().value!)
    return resolved
  }
}

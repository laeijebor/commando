import type { Stats } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { MAX_REPLY_EMBEDS, type ChatItem, type ChatReplyEmbed } from '../shared/agent-chat.js'
import { canvasRelativePath, encodeCanvasPath, parseCanvasManifest } from '../shared/canvas-manifest.js'
import { servableArtifactFolder } from './artifact-folders.js'
import { isEmbedAddress, localImagePath, markdownImageSources } from './chat-reply-images.js'
import type { RedlineArtifactRegistry } from './redline-artifacts.js'

/**
 * An agent shows an HTML mock-up or a canvas board inline with image syntax:
 * `![Accounts](.canvas/settings/Accounts.html)` or `![Board](.canvas/settings)`
 * (a canvas folder, or its manifest). The daemon checks each against the rule
 * resource tiles use (server/artifact-folders.ts), registers the artifact
 * folder and attaches the URL it serves the page from. Anything that fails
 * the rule gets `not-embeddable`, and the reply shows a chip instead.
 */

const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_FRAMES = 50
const MAX_REMEMBERED = 500
const IMAGE_EXTENSION = /\.(?:svg|png|jpe?g|gif|webp|avif|heic|bmp|ico|tiff?|pdf)$/i


type Resolved = Omit<ChatReplyEmbed, 'src'>
/** What a resolution depended on: the page or manifest's stamp, and the registration it made. */
type Remembered = { stamp: string; resolved: Resolved; registration?: { id: string; directory: string } }

const absent = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
const stampOf = (stats: Stats) => `${stats.mtimeMs}:${stats.size}`

export class ChatReplyEmbeds {
  private readonly remembered = new Map<string, Remembered>()
  private readonly resolving = new Map<string, Promise<Resolved | null>>()
  private readonly parsed = new Map<string, { text: string; sources: string[] }>()
  private loggedFailure = false

  constructor(private readonly options: {
    artifacts: Pick<RedlineArtifactRegistry, 'ensure' | 'directory'>
    home?: string
    /** Extra temporary roots the folder rule treats as broad, for tests. */
    tempRoots?: readonly string[]
    log?: (message: string) => void
  }) {}

  /** The items with each reply's embeds attached; never rejects. */
  attach(items: readonly ChatItem[], cwd: string): Promise<ChatItem[]> {
    return Promise.all(items.map((item) => item.kind === 'assistant_message' ? this.attachTo(item, cwd) : item))
  }

  private get home(): string {
    return this.options.home ?? homedir()
  }

  private sources(item: Extract<ChatItem, { kind: 'assistant_message' }>): string[] {
    const known = this.parsed.get(item.id)
    if (known?.text === item.text) return known.sources
    const sources = markdownImageSources(item.text)
    this.parsed.delete(item.id)
    this.parsed.set(item.id, { text: item.text, sources })
    if (this.parsed.size > 2000) this.parsed.delete(this.parsed.keys().next().value!)
    return sources
  }

  private async attachTo(item: Extract<ChatItem, { kind: 'assistant_message' }>, cwd: string): Promise<ChatItem> {
    const { embeds: _previous, ...rest } = item
    try {
      const embeds: ChatReplyEmbed[] = []
      for (const src of this.sources(item)) {
        const path = localImagePath(src, cwd, this.home)
        if (!path || IMAGE_EXTENSION.test(path)) continue
        const resolved = await this.resolve(path, cwd)
        if (resolved) embeds.push({ src, ...resolved })
        if (embeds.length >= MAX_REPLY_EMBEDS) break
      }
      return embeds.length ? { ...rest, embeds } : rest
    } catch (error) {
      this.report(error)
      return rest
    }
  }

  private report(error: unknown): void {
    if (this.loggedFailure) return
    this.loggedFailure = true
    this.options.log?.(`Couldn't attach a reply embed: ${error instanceof Error ? error.message : String(error)}`)
  }

  private resolve(path: string, cwd: string): Promise<Resolved | null> {
    const key = `${cwd}\0${path}`
    const pending = this.resolving.get(key)
    if (pending) return pending
    const task = this.read(path, cwd, key).catch((error: unknown) => {
      // A permission error or a file replaced mid-read: a chip now, and another try with the next update.
      this.report(error)
      return isEmbedAddress(path) ? { kind: /\.html?$/i.test(path) ? 'html' as const : 'canvas' as const, path, error: 'not-embeddable' as const } : null
    }).finally(() => this.resolving.delete(key))
    this.resolving.set(key, task)
    return task
  }

  /** Stats the address as written, then percent-decoded; null when neither is there. */
  private async statWritten(path: string): Promise<{ path: string; stats: Stats } | null> {
    try { return { path, stats: await stat(path) } } catch (error) {
      if (!absent(error)) throw error
    }
    let decoded: string
    try { decoded = decodeURIComponent(path) } catch { return null }
    if (decoded === path) return null
    try { return { path: decoded, stats: await stat(decoded) } } catch (error) {
      if (!absent(error)) throw error
      return null
    }
  }

  /** The embed an address means, or null when it isn't one (a plain image, say). */
  private async read(written: string, cwd: string, key: string): Promise<Resolved | null> {
    const html = /\.html?$/i.test(written)
    const kind = html ? 'html' as const : 'canvas' as const
    const found = await this.statWritten(written)
    if (!found) return isEmbedAddress(written) ? { kind, path: written, error: 'missing' } : null
    const { path, stats } = found
    // Only HTML files, canvas folders and manifests are embeds; anything else stays an image.
    if (html ? !stats.isFile() : !(stats.isDirectory() || (stats.isFile() && /\.json$/i.test(path)))) {
      return isEmbedAddress(path) ? { kind, path, error: 'not-embeddable' } : null
    }
    const refused: Resolved = { kind, path, error: 'not-embeddable' }
    const real = await realpath(path)
    const directory = stats.isDirectory() ? real : dirname(real)
    const manifest = stats.isDirectory() ? 'canvas.json' : basename(real)
    let target = stats
    if (!html) {
      if (canvasRelativePath(manifest) !== manifest) return refused
      try { target = await stat(join(directory, manifest)) } catch { return refused }
      if (!target.isFile()) return refused
    }
    const stamp = stampOf(target)
    const known = this.remembered.get(key)
    if (known?.stamp === stamp && (!known.registration || this.options.artifacts.directory(known.registration.id) === known.registration.directory)) {
      return known.resolved
    }
    const folder = await servableArtifactFolder(directory, { cwd, home: this.home, tempRoots: this.options.tempRoots })
    let remembered: Remembered
    if (!folder) remembered = { stamp, resolved: refused }
    else if (html) {
      const { id } = this.options.artifacts.ensure(folder)
      const file = relative(folder, real).split(sep).map(encodeURIComponent).join('/')
      remembered = { stamp, resolved: { kind, path, url: `/redline/artifacts/${id}/${file}` }, registration: { id, directory: folder } }
    } else {
      if (target.size > MAX_MANIFEST_BYTES) return { kind, path, error: 'invalid' }
      const { manifest: canvas, errors } = parseCanvasManifest(await readFile(join(directory, manifest), 'utf8'))
      // A manifest that isn't a JSON object can't be shown; field errors still leave usable frames.
      if (errors.some((error) => error.startsWith('canvas.json:'))) remembered = { stamp, resolved: { kind, path, error: 'invalid' } }
      else {
        // The canvas folder itself is registered, as `scripts/commando-canvas` does, so frame sources resolve inside it.
        const { id } = this.options.artifacts.ensure(directory)
        const frames = canvas.frames.slice(0, MAX_FRAMES).map((frame) => ({
          id: frame.id, title: frame.title, url: `/redline/artifacts/${id}/${encodeCanvasPath(frame.src)}`, w: frame.w, h: frame.h,
        }))
        remembered = {
          stamp,
          resolved: { kind, path, url: `/redline/artifacts/${id}/`, ...(canvas.title ? { title: canvas.title } : {}), frames },
          registration: { id, directory },
        }
      }
    }
    this.remembered.delete(key)
    this.remembered.set(key, remembered)
    if (this.remembered.size > MAX_REMEMBERED) this.remembered.delete(this.remembered.keys().next().value!)
    return remembered.resolved
  }
}

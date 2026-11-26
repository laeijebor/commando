import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeBoardUrl, type BoardItem } from '../shared/board.js'
import type { BoardStore } from './boards.js'
import type { BoardThumbCache } from './board-thumbs.js'

export const defaultBoardLinkPreviewsPath = (port: number) => join(homedir(), '.commando', `board-link-previews-${port}.json`)
const DAY = 86400_000, HTML_LIMIT = 512 * 1024, IMAGE_LIMIT = 5 * 1024 * 1024
const text = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (full, entity: string) => {
    if (entity[0] !== '#') return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' } as Record<string, string>)[entity.toLowerCase()] ?? full
    const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ''
  })
}
function attributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null)
  for (const match of tag.matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4])
  return attrs
}
function httpUrl(value: string | undefined, base: string): string | undefined {
  if (!value) return
  try { const url = new URL(value, base); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href } catch { /* Unusable metadata URL. */ }
}
export function parseLinkPreview(html: string, url: string): { title?: string; description?: string; siteName?: string; image?: string; favicon: string } {
  // Metadata-looking strings inside scripts/comments are not document metadata.
  html = html.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  const meta: Record<string, string> = Object.create(null)
  let favicon = new URL('/favicon.ico', url).href, best = -1
  for (const match of html.matchAll(/<(meta|link)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = attributes(match[0])
    if (match[1].toLowerCase() === 'meta') {
      const key = (attrs.property ?? attrs.name ?? '').toLowerCase()
      if (key && !meta[key]) meta[key] = attrs.content ?? ''
    } else {
      const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/)
      if (!rel.some((r) => r === 'icon' || r === 'apple-touch-icon')) continue
      const href = httpUrl(attrs.href, url)
      const size = Math.min(1024, parseInt(attrs.sizes ?? '', 10) || 0)
      const score = size + (rel.includes('apple-touch-icon') ? 1 : 0)
      if (href && score > best) { best = score; favicon = href }
    }
  }
  const title = text(meta['og:title'] || /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] || '').slice(0, 500)
  const description = text(meta['og:description'] || meta.description || '').slice(0, 2000)
  const siteName = text(meta['og:site_name'] || '').slice(0, 500)
  return { ...(title ? { title } : {}), ...(description ? { description } : {}), ...(siteName ? { siteName } : {}), image: httpUrl(meta['og:image'], url), favicon }
}

/** Deny private, link-local, unspecified, mapped, multicast and other non-global addresses. */
export function isPrivatePreviewHost(host: string): boolean {
  host = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'local') return true
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19))
  }
  if (isIP(host) === 6) return !/^[23]/.test(host) || /^2001:db8:/i.test(host)
  return false
}
type Address = { address: string; family: number }
type PreviewFetch = (url: string, init: RequestInit, address: Address) => Promise<Response>
// Pin the checked DNS answer in the socket lookup. Native fetch would resolve again after validation.
const pinnedFetch: PreviewFetch = (url, init, address) => new Promise((resolve, reject) => {
  const parsed = new URL(url)
  const req = (parsed.protocol === 'https:' ? httpsRequest : httpRequest)(parsed, {
    method: 'GET', headers: init.headers as Record<string, string>, signal: init.signal ?? undefined,
    lookup: (_host, options, callback) => {
      if (typeof options === 'object' && options.all) callback(null, [address])
      else callback(null, address.address, address.family)
    },
  }, (res) => {
    const headers = new Headers()
    for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    try {
      const status = res.statusCode ?? 500
      const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>
      if (!body) res.resume()
      resolve(new Response(body, { status, headers }))
    } catch (error) { res.destroy(); reject(error) }
  })
  req.on('error', reject); req.end()
})
class PrivateUrl extends Error { constructor(readonly url: string) { super('Private preview URL') } }
type Entry = { expires: number; preview?: NonNullable<BoardItem['preview']>; thumb?: BoardItem['thumb']; capture?: 'public' | 'private'; shotExpires?: number }
type Options = {
  store: BoardStore; thumbs: BoardThumbCache; statePath: string
  fetch?: PreviewFetch; resolve?: (host: string) => Promise<Address[]>; now?: () => number
}
export class BoardLinkPreviews {
  private readonly entries = new Map<string, Entry>()
  private loaded = false
  constructor(private readonly options: Options) {}
  private now(): number { return (this.options.now ?? Date.now)() }
  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(this.options.statePath)
      if (raw.length > 8 * 1024 * 1024) return
      const data: unknown = JSON.parse(raw.toString('utf8'))
      if (!Array.isArray(data)) return
      for (const row of data.slice(-2000)) {
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string') continue
        const [url, entry] = row as [string, Entry]
        if (normalizeBoardUrl(url) !== url || !entry || !Number.isFinite(entry.expires) || entry.expires <= this.now()) continue
        if (entry.preview && (typeof entry.preview !== 'object' || Object.entries(entry.preview).some(([k, v]) => !['title', 'description', 'siteName', 'image', 'favicon'].includes(k) || typeof v !== 'string' || v.length > 2000 || (['image', 'favicon'].includes(k) && !/^[0-9a-f]{64}$/.test(v))))) continue
        if (entry.thumb && (!/^[0-9a-f]{64}$/.test(entry.thumb.hash) || ![entry.thumb.w, entry.thumb.h].every((n) => Number.isFinite(n) && n > 0 && n <= 16384))) continue
        if (entry.capture !== undefined && !['public', 'private'].includes(entry.capture)) continue
        if (entry.shotExpires !== undefined && !Number.isFinite(entry.shotExpires)) continue
        this.entries.set(url, entry)
      }
    } catch { /* No preview cache, or corrupt state: start empty. */ }
  }
  private async save(): Promise<void> {
    for (const [url, entry] of this.entries) if (entry.expires <= this.now()) this.entries.delete(url)
    while (this.entries.size > 2000) this.entries.delete(this.entries.keys().next().value!)
    const tmp = `${this.options.statePath}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(tmp), { recursive: true, mode: 0o700 })
      await writeFile(tmp, JSON.stringify([...this.entries]), { mode: 0o600, flag: 'wx' })
      await rename(tmp, this.options.statePath)
    } finally { await rm(tmp, { force: true }) }
  }
  private async address(url: URL): Promise<Address> {
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (isPrivatePreviewHost(host)) throw new PrivateUrl(url.href)
    const answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await (this.options.resolve ?? ((host) => lookup(host, { all: true })))(host)
    if (!answers.length || answers.some((a) => !isIP(a.address) || isPrivatePreviewHost(a.address))) throw new PrivateUrl(url.href)
    return answers[0]
  }
  private async download(url: string, limit: number, image: boolean): Promise<{ bytes: Buffer; url: string }> {
    const signal = AbortSignal.timeout(5000)
    // Race DNS too: DNS resolution itself is not cancellable by node's lookup API.
    const abort = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('Link preview timed out')), { once: true }))
    return Promise.race([(async () => {
      for (let redirects = 0; ; redirects++) {
        if (signal.aborted) throw new Error('Link preview timed out')
        const parsed = new URL(url)
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid preview URL')
        const address = await this.address(parsed)
        if (signal.aborted) throw new Error('Link preview timed out')
        const response = await (this.options.fetch ?? pinnedFetch)(url, {
          signal, redirect: 'manual', credentials: 'omit', headers: { Accept: image ? 'image/*' : 'text/html', 'User-Agent': 'Commando link preview' },
        }, address)
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel()
          const next = httpUrl(response.headers.get('location') ?? undefined, url)
          if (redirects >= 3 || !next) throw new Error('Invalid/excessive preview redirects')
          url = next; continue
        }
        if (!response.ok || !(image ? /^image\//i : /^(?:text\/html|application\/xhtml\+xml)\b/i).test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new Error('Unexpected preview content type/status') }
        if (image && Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Preview body is too large') }
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Empty preview response')
        const chunks: Uint8Array[] = []; let length = 0
        try {
          while (length < limit) {
            const { done, value } = await reader.read()
            if (done) break
            const remaining = limit - length
            if (image && value.length > remaining) throw new Error('Preview image is too large')
            const chunk = value.subarray(0, remaining); chunks.push(chunk); length += chunk.length
            if (signal.aborted) throw new Error('Link preview timed out')
          }
          // Image bodies at the exact limit still need an EOF check.
          if (image && length === limit && !(await reader.read()).done) throw new Error('Preview image is too large')
        } finally { await reader.cancel().catch(() => {}) }
        return { bytes: Buffer.concat(chunks), url }
      }
    })(), abort])
  }
  async refresh(targetId: string, item: BoardItem): Promise<void> {
    if (item.kind !== 'link' || !item.ref.url) return
    let url: string
    try { url = normalizeBoardUrl(item.ref.url) } catch { return }
    if (!this.options.thumbs.canCapture(url)) return
    await this.load()
    let entry = this.entries.get(url)
    // Upgrade v1 cache entries so existing no-image links get shots immediately.
    if (entry && !entry.capture) {
      if (isPrivatePreviewHost(new URL(url).hostname)) entry.capture = 'private'
      else if (entry.preview && !entry.preview.image) entry.capture = 'public'
    }
    if (entry && entry.expires > this.now()) {
      const hashes = new Set([entry.preview?.image, entry.preview?.favicon, entry.thumb?.hash].filter((hash): hash is string => !!hash))
      // Metadata outlives the LRU thumbnail cache; refetch when either asset was evicted.
      if ((await Promise.all([...hashes].map((hash) => this.options.thumbs.has(hash)))).some((exists) => !exists)) entry = undefined
    }
    if (!entry || entry.expires <= this.now()) {
      try {
        const page = await this.download(url, HTML_LIMIT, false), parsed = parseLinkPreview(page.bytes.toString('utf8'), page.url)
        const { image, favicon, ...metadata } = parsed
        const preview: NonNullable<BoardItem['preview']> = metadata
        // Sequential downloads remain within the same single background job.
        for (const [key, asset] of [['image', image], ['favicon', favicon]] as const) {
          if (!asset) continue
          try { const data = await this.download(asset, IMAGE_LIMIT, true); const hash = await this.options.thumbs.image(data.bytes); if (hash) preview[key] = hash } catch { /* Metadata is useful even when an image fails. */ }
        }
        entry = { expires: this.now() + 7 * DAY, preview, ...(!image ? { capture: 'public' as const } : {}) }
      } catch (error) {
        entry = { expires: this.now() + 3600_000 }
        // A public URL redirecting into a private network is not a dev-server link.
        if (error instanceof PrivateUrl && error.url === url) entry.capture = 'private'
      }
      this.entries.set(url, entry)
      await this.save().catch(() => {}) // State failures must not lose a successful preview.
    }
    if (entry.capture && (!entry.shotExpires || entry.shotExpires <= this.now())) {
      const interval = entry.capture === 'private' ? 3600_000 : DAY
      const thumb = entry.capture === 'private' && !isPrivatePreviewHost(new URL(url).hostname)
        ? await this.options.thumbs.page(url, true) : await this.options.thumbs.page(url)
      if (thumb) entry.thumb = thumb
      entry.shotExpires = (Math.floor(this.now() / interval) + 1) * interval
      await this.save().catch(() => {})
    }
    if (entry.preview || entry.thumb) this.apply(targetId, item, { ...(entry.preview ? { preview: entry.preview } : {}), ...(entry.thumb ? { thumb: entry.thumb } : {}) })
  }
  private apply(target: string, item: BoardItem, patch: Pick<Partial<BoardItem>, 'preview' | 'thumb'>): void {
    if ((!patch.preview || JSON.stringify(item.preview) === JSON.stringify(patch.preview)) && (!patch.thumb || JSON.stringify(item.thumb) === JSON.stringify(patch.thumb))) return
    try { if (this.options.store.item(target, item.key).ref.url === item.ref.url) this.options.store.setPreview(target, item.key, patch) } catch { /* Deleted while fetching. */ }
  }
}

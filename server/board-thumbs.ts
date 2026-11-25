import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { setImmediate as yieldToHttp } from 'node:timers/promises'
import { parseCanvasSource } from '../shared/deck.js'
import { canvasRelativePath, encodeCanvasPath } from '../shared/canvas-manifest.js'
import type { BoardItem } from '../shared/board.js'
import type { BoardStore } from './boards.js'

export const BOARD_THUMB_HASH = /^[0-9a-f]{64}$/
export const BOARD_THUMB_WIDTHS = [320, 960] as const
export const defaultBoardThumbsPath = (port: number) => join(homedir(), '.commando', `board-thumbs-${port}`)
const MAX_CACHE_BYTES = 500 * 1024 * 1024
export const thumbHash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

/** One lazy, yielding queue for both rendering and network previews. No HTTP handler awaits it. */
export class BoardPreviewQueue {
  private jobs = new Map<string, () => Promise<void>>()
  private active = false
  private stopped = false
  private waiters: (() => void)[] = []
  constructor(private readonly error: (error: unknown) => void = () => {}) {}
  enqueue(key: string, job: () => Promise<void>): void {
    if (this.stopped) return
    // Keep one pending rerun even when the key is currently running (sources can change mid-render).
    this.jobs.set(key, job)
    if (!this.active) { this.active = true; void this.run() }
  }
  private async run(): Promise<void> {
    try {
      while (this.jobs.size && !this.stopped) {
        await yieldToHttp()
        if (this.stopped) break
        const [key, job] = this.jobs.entries().next().value!
        this.jobs.delete(key)
        try { await job() } catch (error) { this.error(error) }
      }
    } finally { this.active = false; for (const resolve of this.waiters.splice(0)) resolve() }
  }
  async idle(): Promise<void> { if (this.active) await new Promise<void>((resolve) => this.waiters.push(resolve)) }
  stop(): void { this.stopped = true; this.jobs.clear() }
}

type Run = (command: string, args: string[]) => Promise<void>
const runTool: Run = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 20_000, maxBuffer: 128 * 1024 }, (error) => error ? reject(error) : resolve())
})
type Capture = (url: string, w: number, h: number) => Promise<Buffer>
type Options = {
  root: string; origin: string; platform?: string; run?: Run; capture?: Capture
  maxBytes?: number; now?: () => number
}
export function pngDimensions(bytes: Buffer): { w: number; h: number } | undefined {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return
  const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20)
  if (w && h) return { w, h }
}

export class BoardThumbCache {
  private readonly run: Run
  constructor(private readonly options: Options) { this.run = options.run ?? runTool }
  private path(hash: string, width: number): string { return join(this.options.root, `${hash}-${width}.png`) }
  async read(hash: string, width: number): Promise<Buffer | undefined> {
    if (!BOARD_THUMB_HASH.test(hash) || !BOARD_THUMB_WIDTHS.includes(width as 320 | 960)) return
    try {
      const path = this.path(hash, width), bytes = await readFile(path)
      const now = new Date((this.options.now ?? Date.now)())
      await utimes(path, now, now).catch(() => {})
      return bytes
    } catch { return undefined }
  }
  async has(hash: string): Promise<boolean> {
    try { await Promise.all(BOARD_THUMB_WIDTHS.map((w) => access(this.path(hash, w)))); return true } catch { return false }
  }
  /** Downloaded assets have identities derived from their bytes, never from a third-party URL. */
  async image(bytes: Buffer): Promise<string | undefined> {
    const hash = thumbHash(['image', createHash('sha256').update(bytes).digest('hex')])
    if (await this.has(hash)) return hash
    if ((this.options.platform ?? process.platform) !== 'darwin') return undefined
    try {
      await this.withTemp(async (dir) => {
        const input = join(dir, 'input'); await writeFile(input, bytes)
        await this.resize(input, hash)
      })
    } catch { await this.remove(hash); return undefined }
    return await this.has(hash) ? hash : undefined
  }
  async source(item: BoardItem): Promise<{ hash: string; path?: string; url?: string; w: number; h: number } | undefined> {
    if (['pr', 'clip', 'link'].includes(item.kind)) return
    let path: string | undefined, signature: unknown[] = [], w = 1280, h = 800, url = item.ref.url
    if (item.ref.path) {
      path = await realpath(item.ref.path)
      const info = await stat(path)
      signature = [info.mtimeMs, info.size]
      if (info.isDirectory()) {
        // Include nested assets, not just the directory mtime (editing CSS does not change it).
        signature.push(await this.folderSignature(path))
        if (item.kind === 'canvas' || item.kind === 'slides') {
          const manifest = canvasRelativePath(item.ref.manifest ?? 'canvas.json')
          if (!manifest) return
          const source = await this.contained(path, manifest)
          if ((await stat(source)).size > 2 * 1024 * 1024) return
          const text = await readFile(source, 'utf8')
          const frames = parseCanvasSource(text, manifest).manifest.frames
          const frame = item.kind === 'slides' ? frames[0] : [...frames].sort((a, b) => (a.focus ?? Infinity) - (b.focus ?? Infinity))[0]
          if (!frame || !item.ref.artifactId) return
          await this.contained(path, frame.src)
          url = `${this.options.origin}/redline/artifacts/${item.ref.artifactId}/${encodeCanvasPath(frame.src)}${frame.slide ? `#${frame.slide}` : ''}`
          w = frame.w; h = frame.h; signature.push(manifest, text)
        }
      }
    }
    if (!path && !url) return
    return { hash: thumbHash([item.kind, path ?? url, ...signature, item.ref.manifest, item.ref.file, url]), path, url, w, h }
  }
  private async contained(root: string, file: string): Promise<string> {
    const path = await realpath(join(root, file)), rel = relative(root, path)
    if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Thumbnail source escapes artifact directory')
    return path
  }
  private async folderSignature(root: string): Promise<unknown[]> {
    const entries: unknown[] = []; let count = 0
    const visit = async (dir: string): Promise<void> => {
      const files = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
      for (const file of files) {
        if (++count > 5000) throw new Error('Thumbnail artifact exceeds 5000 entries')
        const path = join(dir, file.name)
        if (file.isSymbolicLink()) continue
        if (file.isDirectory()) await visit(path)
        else if (file.isFile()) { const s = await stat(path); entries.push([relative(root, path), s.mtimeMs, s.size]) }
        if (count % 50 === 0) await yieldToHttp()
      }
    }
    await visit(root); return entries
  }
  async render(item: BoardItem, source: NonNullable<Awaited<ReturnType<BoardThumbCache['source']>>>): Promise<BoardItem['thumb']> {
    const cached = await this.read(source.hash, 960)
    if (cached && await this.has(source.hash)) return { hash: source.hash, ...(pngDimensions(cached) ?? { w: 960, h: 600 }) }
    if ((this.options.platform ?? process.platform) !== 'darwin') return // TODO: portable image resampling through managed Chromium.
    try {
      await this.withTemp(async (dir) => {
        if (item.kind === 'screenshot' && source.path) await this.resize(source.path, source.hash)
        else if (['video', 'file'].includes(item.kind) && source.path) {
          for (const width of BOARD_THUMB_WIDTHS) {
            const out = join(dir, String(width)); await mkdir(out)
            await this.run('qlmanage', ['-t', '-s', String(width), '-o', out, source.path])
            const file = (await readdir(out)).find((name) => name.endsWith('.png'))
            if (!file) throw new Error('QuickLook returned no PNG')
            await this.publish(join(out, file), source.hash, width)
          }
        } else if (this.options.capture && source.url && this.canCapture(source.url)) {
          const bytes = await this.options.capture(source.url, source.w, source.h)
          const input = join(dir, 'capture.png'); await writeFile(input, bytes); await this.resize(input, source.hash)
        }
        // TODO: ChromiumEngine.screenshot rejects general page/private-link URLs. Do not repurpose live tiles.
      })
      const bytes = await this.read(source.hash, 960)
      if (bytes && await this.has(source.hash)) return { hash: source.hash, ...(pngDimensions(bytes) ?? { w: 960, h: 600 }) }
    } catch { await this.remove(source.hash) } // Missing sips/QuickLook/Chromium means the UI keeps its kind icon.
    return undefined
  }
  canCapture(url: string): boolean {
    try { const u = new URL(url); return u.origin === this.options.origin && u.pathname.startsWith('/redline/') } catch { return false }
  }
  async page(url: string): Promise<BoardItem['thumb']> {
    return this.render({ kind: 'page' } as BoardItem, { hash: thumbHash(['page', url]), url, w: 1280, h: 800 })
  }
  private async withTemp<T>(job: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'commando-board-thumb-'))
    try { return await job(dir) } finally { await rm(dir, { recursive: true, force: true }) }
  }
  private async resize(input: string, hash: string): Promise<void> {
    await this.withTemp(async (dir) => {
      for (const width of BOARD_THUMB_WIDTHS) {
        const out = join(dir, `${width}.png`)
        await this.run('sips', ['-s', 'format', 'png', '-Z', String(width), input, '--out', out])
        await this.publish(out, hash, width)
      }
    })
  }
  private async publish(input: string, hash: string, width: number): Promise<void> {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 })
    const tmp = join(this.options.root, `.${randomUUID()}.tmp`)
    try { await writeFile(tmp, await readFile(input), { mode: 0o600, flag: 'wx' }); await rename(tmp, this.path(hash, width)) }
    finally { await rm(tmp, { force: true }) }
  }
  private async remove(hash: string): Promise<void> { await Promise.all(BOARD_THUMB_WIDTHS.map((w) => rm(this.path(hash, w), { force: true }))) }
  async evict(): Promise<void> {
    let names: string[]
    try { names = await readdir(this.options.root) } catch { return }
    const entries = []
    for (const name of names) {
      if (!/^[0-9a-f]{64}-(320|960)\.png$/.test(name)) continue
      try { const s = await stat(join(this.options.root, name)); entries.push({ name, size: s.size, used: Math.max(s.atimeMs, s.mtimeMs) }) } catch { /* Another read/eviction may race. */ }
    }
    let total = entries.reduce((n, e) => n + e.size, 0)
    for (const entry of entries.sort((a, b) => a.used - b.used)) {
      if (total <= (this.options.maxBytes ?? MAX_CACHE_BYTES)) break
      await rm(join(this.options.root, entry.name), { force: true }); total -= entry.size
    }
  }
}

type LinkPreviewer = { refresh: (targetId: string, item: BoardItem) => Promise<void> }
/** Store reads perform only asynchronous stat work on the shared queue; changes debounce for five seconds. */
export class BoardThumbWorker {
  private readonly fingerprints = new Map<string, string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private stopped = false
  constructor(private readonly store: BoardStore, readonly cache: BoardThumbCache, readonly queue: BoardPreviewQueue, private readonly links?: LinkPreviewer) {}
  enqueue(targetId: string): void {
    this.queue.enqueue(`board:${targetId}`, async () => {
      for (const item of this.store.get(targetId).items) {
        if (this.stopped) return
        try {
          if (item.kind === 'link') { await this.links?.refresh(targetId, item); continue }
          const source = await this.cache.source(item)
          if (!source) continue
          const key = `${targetId}:${item.key}`, previous = this.fingerprints.get(key)
          this.fingerprints.set(key, source.hash)
          if (previous && previous !== source.hash) {
            clearTimeout(this.timers.get(key))
            const timer = setTimeout(() => { this.timers.delete(key); this.enqueue(targetId) }, 5000)
            timer.unref(); this.timers.set(key, timer); continue
          }
          if (this.timers.has(key)) continue
          if (item.thumb?.hash === source.hash && await this.cache.has(source.hash)) continue
          const thumb = await this.cache.render(item, source)
          // Never resurrect a removed item or attach a result to an edited/replaced source.
          if (thumb && (await this.cache.source(this.store.item(targetId, item.key)))?.hash === source.hash) this.store.setPreview(targetId, item.key, { thumb })
        } catch { /* Missing or unsupported sources stay as kind icons. */ }
        finally { await yieldToHttp() }
      }
      await this.cache.evict()
    })
  }
  changed(artifactId: string): void {
    for (const target of this.store.targets()) if (this.store.get(target).items.some((i) => i.ref.artifactId === artifactId)) this.enqueue(target)
  }
  stop(): void { this.stopped = true; for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); this.queue.stop() }
}

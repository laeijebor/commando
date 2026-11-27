import { open } from 'node:fs/promises'
import { statSync } from 'node:fs'
import type { WebPane } from '../shared/protocol.js'
import { parseCanvasSource } from '../shared/deck.js'
import type { RedlineArtifactRegistry } from './redline-artifacts.js'

const MAX_TITLE_BYTES = 2 * 1024 * 1024
const MAX_TITLES = 256
async function readManifest(path: string): Promise<string | undefined> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_TITLE_BYTES) return undefined
    const buffer = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    return length <= info.size ? buffer.subarray(0, length).toString('utf8') : undefined
  } finally { await file.close() }
}

type Title = { signature: string; value?: string }
/** Publication only stats manifests; bounded reads/parsing happen asynchronously on a miss. */
export class BoardTileTitles {
  private readonly cache = new Map<string, Title>()
  private pending: Promise<void> = Promise.resolve()
  constructor(private readonly options: {
    artifacts: Pick<RedlineArtifactRegistry, 'resolve'>
    changed: () => void
    read?: (path: string) => Promise<string | undefined>
  }) {}
  title(pane: WebPane): string | undefined {
    if (pane.content?.kind !== 'canvas') return pane.title?.trim() || undefined
    const { artifactId, manifest } = pane.content
    const path = this.options.artifacts.resolve(artifactId, manifest)
    if (!path) return
    try {
      const info = statSync(path), signature = JSON.stringify([info.mtimeMs, info.size, manifest])
      const cached = this.cache.get(path)
      this.cache.delete(path)
      if (cached?.signature === signature) { this.cache.set(path, cached); return cached.value }
      const entry: Title = { signature, value: cached?.value }
      this.cache.set(path, entry)
      while (this.cache.size > MAX_TITLES) this.cache.delete(this.cache.keys().next().value!)
      if (!info.isFile() || info.size > MAX_TITLE_BYTES) return entry.value
      this.pending = this.pending.then(async () => {
        if (this.cache.get(path) !== entry) return
        const source = await (this.options.read ?? readManifest)(path)
        if (this.cache.get(path) !== entry || source === undefined || Buffer.byteLength(source) > MAX_TITLE_BYTES) return
        const value = parseCanvasSource(source, manifest).manifest.title.trim().slice(0, 500) || undefined
        if (value !== entry.value) { entry.value = value; this.options.changed() }
      }).catch(() => {}) // A removed or malformed artifact never breaks publication.
      return entry.value
    } catch { return undefined }
  }
  async idle(): Promise<void> { await this.pending }
}

/** Latest revision per target, at most one notification per 250ms window. */
export class BoardChangeNotifications {
  private readonly pending = new Map<string, { rev: number; timer: ReturnType<typeof setTimeout> }>()
  constructor(private readonly changed: (targetId: string, rev: number) => void) {}
  enqueue(targetId: string, rev: number): void {
    const current = this.pending.get(targetId)
    if (current) { current.rev = Math.max(current.rev, rev); return }
    const entry = { rev, timer: setTimeout(() => {
      this.pending.delete(targetId); this.changed(targetId, entry.rev)
    }, 250) }
    entry.timer.unref(); this.pending.set(targetId, entry)
  }
  stop(): void { for (const { timer } of this.pending.values()) clearTimeout(timer); this.pending.clear() }
}

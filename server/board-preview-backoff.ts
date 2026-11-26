import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export function previewRetry(failures: number, now: number, initial = 5 * 60_000): { failures: number; retryAt: number } {
  failures = Math.min(failures + 1, 8)
  return { failures, retryAt: now + Math.min(initial * 2 ** (failures - 1), 6 * 3600_000) }
}
type Retry = ReturnType<typeof previewRetry>
/** Destination hashes stay stable across hourly/daily thumbnail buckets, so a
 * clock rollover cannot bypass backoff. Files contain no raw page URLs. */
export class BoardPageRetries {
  private readonly entries = new Map<string, Retry>()
  private loaded?: Promise<void>
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly path: string, private readonly now: () => number) {}
  private load(): Promise<void> {
    return this.loaded ??= (async () => {
      try {
        const bytes = await readFile(this.path)
        if (bytes.length > 512 * 1024) return
        const rows: unknown = JSON.parse(bytes.toString('utf8'))
        if (!Array.isArray(rows)) return
        for (const row of rows.slice(-2000)) {
          if (!Array.isArray(row) || row.length !== 2) continue
          const [key, retry] = row as [unknown, Retry]
          if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key) || !retry || !Number.isInteger(retry.failures) || retry.failures < 1 || retry.failures > 8 || !Number.isFinite(retry.retryAt) || retry.retryAt + 7 * 86400_000 <= this.now()) continue
          this.entries.set(key, retry)
        }
      } catch { /* A missing/corrupt retry cache never prevents a thumbnail. */ }
    })()
  }
  private save(): Promise<void> {
    for (const [key, retry] of this.entries) if (retry.retryAt + 7 * 86400_000 <= this.now()) this.entries.delete(key)
    while (this.entries.size > 2000) this.entries.delete(this.entries.keys().next().value!)
    const content = JSON.stringify([...this.entries])
    return this.writes = this.writes.then(async () => {
      const tmp = `${this.path}.${randomUUID()}.tmp`
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        await writeFile(tmp, content, { mode: 0o600, flag: 'wx' }); await rename(tmp, this.path)
      } finally { await rm(tmp, { force: true }) }
    }).catch(() => {}) // Keep in-memory throttling if persistence is unavailable.
  }
  async blocked(key: string): Promise<boolean> { await this.load(); return (this.entries.get(key)?.retryAt ?? 0) > this.now() }
  async failed(key: string): Promise<void> {
    await this.load(); this.entries.set(key, previewRetry(this.entries.get(key)?.failures ?? 0, this.now())); await this.save()
  }
  async succeeded(key: string): Promise<void> { await this.load(); if (this.entries.delete(key)) await this.save() }
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const WRITE_DELAY_MS = 2_000

/**
 * A pane id → timestamp map kept in a JSON file so it survives daemon restarts
 * (tmux keeps its pane ids across them). Writes are batched; a missing or
 * unreadable file starts empty.
 */
export class PaneTimes {
  private readonly times = new Map<string, number>()
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly path?: string) {
    if (!path) return
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        for (const [paneId, at] of Object.entries(parsed)) {
          if (/^%\d+$/.test(paneId) && typeof at === 'number' && Number.isFinite(at)) this.times.set(paneId, at)
        }
      }
    } catch { /* First run, or a damaged file: start empty. */ }
  }

  get(paneId: string): number | undefined { return this.times.get(paneId) }
  has(paneId: string): boolean { return this.times.has(paneId) }

  set(paneId: string, at: number): void {
    this.times.set(paneId, at)
    if (!this.path || this.timer) return
    this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS)
    this.timer.unref?.()
  }

  snapshot(): Record<string, number> { return Object.fromEntries(this.times) }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.path) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(this.snapshot()))
      renameSync(temporary, this.path)
    } catch (error) {
      console.warn('[commando] could not save pane times', this.path, error)
    }
  }
}

import type { WebPaneFeedbackInfo, WebPaneFeedbackNote } from '../shared/protocol.js'
import { WebPaneError } from './web-panes.js'

export const MAX_QUEUED_FEEDBACK_NOTES = 50
export const MAX_FEEDBACK_WAIT_MS = 60_000

type Waiter = {
  settle: (notes: WebPaneFeedbackNote[]) => void
  fail: (error: WebPaneError) => void
}

/**
 * In-memory per-tile review feedback: the tile UI enqueues notes, the agent
 * drains them over a long-poll. Draining is the ack — onDrain lets the daemon
 * broadcast the new state. Nothing here is persisted; feedback dies with the
 * tile (or the daemon), by design.
 */
export class WebPaneFeedbackStore {
  private readonly queues = new Map<string, WebPaneFeedbackNote[]>()
  private readonly waiters = new Map<string, Waiter[]>()
  private readonly drains = new Map<string, { count: number; at: number }>()

  constructor(
    private readonly onDrain: (webPaneId: string) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  enqueue(webPaneId: string, notes: WebPaneFeedbackNote[]): void {
    if (notes.length === 0) return
    const waiting = this.waiters.get(webPaneId)
    if (waiting && waiting.length > 0) {
      const queued = this.queues.get(webPaneId) ?? []
      this.queues.delete(webPaneId)
      const batch = [...queued, ...notes]
      waiting.shift()?.settle(this.recordDrain(webPaneId, batch))
      return
    }
    const queue = this.queues.get(webPaneId) ?? []
    if (queue.length + notes.length > MAX_QUEUED_FEEDBACK_NOTES) {
      throw new WebPaneError(429, `At most ${MAX_QUEUED_FEEDBACK_NOTES} notes can be queued per tile`)
    }
    this.queues.set(webPaneId, [...queue, ...notes])
  }

  drain(webPaneId: string, waitMs: number, signal?: AbortSignal): Promise<WebPaneFeedbackNote[]> {
    const queued = this.queues.get(webPaneId)
    if (queued && queued.length > 0) {
      this.queues.delete(webPaneId)
      return Promise.resolve(this.recordDrain(webPaneId, queued))
    }
    const wait = Math.max(0, Math.min(waitMs, MAX_FEEDBACK_WAIT_MS))
    if (wait === 0 || signal?.aborted) return Promise.resolve([])
    return new Promise<WebPaneFeedbackNote[]>((resolve, reject) => {
      const waiter: Waiter = {
        settle: (notes) => {
          cleanup()
          resolve(notes)
        },
        fail: (error) => {
          cleanup()
          reject(error)
        },
      }
      const timer = setTimeout(() => waiter.settle([]), wait)
      const onAbort = (): void => waiter.settle([])
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const list = this.waiters.get(webPaneId)
        if (list) {
          const index = list.indexOf(waiter)
          if (index >= 0) list.splice(index, 1)
          if (list.length === 0) this.waiters.delete(webPaneId)
        }
      }
      signal?.addEventListener('abort', onAbort)
      const list = this.waiters.get(webPaneId) ?? []
      list.push(waiter)
      this.waiters.set(webPaneId, list)
    })
  }

  /** Discards feedback state for panes that no longer exist. */
  retain(liveIds: ReadonlySet<string>): void {
    for (const map of [this.queues, this.drains] as const) {
      for (const id of [...map.keys()]) {
        if (!liveIds.has(id)) map.delete(id)
      }
    }
    for (const [id, list] of [...this.waiters]) {
      if (liveIds.has(id)) continue
      this.waiters.delete(id)
      for (const waiter of list) waiter.fail(new WebPaneError(404, 'Web pane does not exist'))
    }
  }

  info(): Record<string, WebPaneFeedbackInfo> {
    const result: Record<string, WebPaneFeedbackInfo> = {}
    for (const [id, queue] of this.queues) {
      if (queue.length > 0) result[id] = { queued: queue.length }
    }
    for (const [id, drain] of this.drains) {
      result[id] = {
        queued: result[id]?.queued ?? 0,
        lastDrainCount: drain.count,
        lastDrainAt: drain.at,
      }
    }
    return result
  }

  private recordDrain(webPaneId: string, notes: WebPaneFeedbackNote[]): WebPaneFeedbackNote[] {
    this.drains.set(webPaneId, { count: notes.length, at: this.now() })
    this.onDrain(webPaneId)
    return notes
  }
}

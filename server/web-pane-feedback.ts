import type { WebPaneFeedbackInfo, WebPaneFeedbackNote } from '../shared/protocol.js'
import { FeedbackJournal, type JournaledNote } from './web-pane-feedback-journal.js'
import { WebPaneError } from './web-panes.js'

export const MAX_QUEUED_FEEDBACK_NOTES = 50
export const MAX_FEEDBACK_WAIT_MS = 60_000

export type FeedbackDrainResult = {
  notes: WebPaneFeedbackNote[]
  /** Pass back on the next drain to acknowledge everything delivered here. */
  cursor: number
}

type Waiter = {
  settle: (result: FeedbackDrainResult) => void
  fail: (error: WebPaneError) => void
}

type PaneState = {
  /** Unacked notes in id order — the redeliverable backlog. */
  notes: JournaledNote[]
  /** Stable delivery keys accepted during this journal's lifetime. */
  deliveryKeys: Set<string>
  ackedUpTo: number
  /** Highest id ever handed to a drain response; acks are clamped to it. */
  deliveredUpTo: number
  nextId: number
}

/**
 * Per-tile review feedback with at-least-once delivery: the tile UI enqueues
 * notes, the agent drains them over a long-poll. Draining does NOT delete —
 * notes stay in the journal-backed backlog until the agent passes the drain
 * response's cursor back on a later poll. A lost poll response is therefore
 * recoverable: the retry (carrying the old cursor, or none) gets the same
 * notes again. The journal persists the backlog across daemon restarts and
 * closed tiles.
 */
export class WebPaneFeedbackStore {
  private readonly panes = new Map<string, PaneState>()
  private readonly waiters = new Map<string, Waiter[]>()
  private readonly drains = new Map<string, { count: number; at: number }>()

  constructor(
    private readonly journal: FeedbackJournal = new FeedbackJournal(),
    private readonly onDrain: (webPaneId: string) => void = () => undefined,
    private readonly now: () => number = Date.now,
    private readonly releaseAttachment: (attachmentId: string) => void = () => undefined,
  ) {}

  enqueue(webPaneId: string, notes: WebPaneFeedbackNote[]): void {
    if (notes.length === 0) return
    const state = this.state(webPaneId)
    const deliveryKeys = new Set(state.deliveryKeys)
    const freshDeliveryKeys: string[] = []
    const fresh = notes.filter((note) => {
      if (typeof note.deliveryKey !== 'string' || note.deliveryKey.length === 0) return true
      if (deliveryKeys.has(note.deliveryKey)) return false
      deliveryKeys.add(note.deliveryKey)
      freshDeliveryKeys.push(note.deliveryKey)
      return true
    })
    if (fresh.length === 0) return
    const undelivered = state.notes.filter((entry) => entry.id > state.deliveredUpTo).length
    if (undelivered + fresh.length > MAX_QUEUED_FEEDBACK_NOTES) {
      throw new WebPaneError(429, `At most ${MAX_QUEUED_FEEDBACK_NOTES} notes can be queued per tile`)
    }
    const entries: JournaledNote[] = fresh.map((note, index) => ({ id: state.nextId + index, note }))
    this.journal.appendNotes(webPaneId, entries)
    state.nextId += entries.length
    state.notes.push(...entries)
    for (const key of freshDeliveryKeys) state.deliveryKeys.add(key)
    const waiting = this.waiters.get(webPaneId)
    if (waiting && waiting.length > 0) {
      waiting.shift()?.settle(this.deliver(webPaneId, state))
    }
  }

  drain(
    webPaneId: string,
    waitMs: number,
    options: { cursor?: number; signal?: AbortSignal } = {},
  ): Promise<FeedbackDrainResult> {
    const state = this.state(webPaneId)
    if (options.cursor !== undefined) this.ack(webPaneId, state, options.cursor)
    if (state.notes.length > 0) {
      return Promise.resolve(this.deliver(webPaneId, state))
    }
    const wait = Math.max(0, Math.min(waitMs, MAX_FEEDBACK_WAIT_MS))
    const empty = (): FeedbackDrainResult => ({ notes: [], cursor: state.deliveredUpTo })
    if (wait === 0 || options.signal?.aborted) return Promise.resolve(empty())
    return new Promise<FeedbackDrainResult>((resolve, reject) => {
      const waiter: Waiter = {
        settle: (result) => {
          cleanup()
          resolve(result)
        },
        fail: (error) => {
          cleanup()
          reject(error)
        },
      }
      const timer = setTimeout(() => waiter.settle(empty()), wait)
      const onAbort = (): void => waiter.settle(empty())
      const cleanup = (): void => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        const list = this.waiters.get(webPaneId)
        if (list) {
          const index = list.indexOf(waiter)
          if (index >= 0) list.splice(index, 1)
          if (list.length === 0) this.waiters.delete(webPaneId)
        }
      }
      options.signal?.addEventListener('abort', onAbort)
      const list = this.waiters.get(webPaneId) ?? []
      list.push(waiter)
      this.waiters.set(webPaneId, list)
    })
  }

  /** Whether a pane (live or closed) still has answers nobody acknowledged. */
  hasUnacked(webPaneId: string): boolean {
    return this.state(webPaneId).notes.length > 0
  }

  referencesAttachment(webPaneId: string, attachmentId: string): boolean {
    return this.state(webPaneId).notes.some((entry) =>
      (entry.note.attachments ?? []).some((attachment) => attachment.id === attachmentId),
    )
  }

  referencedAttachmentIds(): Set<string> {
    const ids = this.journal.referencedAttachmentIds()
    for (const state of this.panes.values()) {
      for (const entry of state.notes) {
        for (const attachment of entry.note.attachments ?? []) ids.add(attachment.id)
      }
    }
    return ids
  }

  /**
   * Drops in-memory state and waiters for dead panes. Journals stay on disk —
   * a closed tile's answers remain fetchable until acked or expired.
   */
  retain(liveIds: ReadonlySet<string>): void {
    for (const map of [this.panes, this.drains] as const) {
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
    for (const [id, state] of this.panes) {
      const queued = state.notes.filter((entry) => entry.id > state.deliveredUpTo).length
      if (queued > 0) result[id] = { queued }
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

  private state(webPaneId: string): PaneState {
    let state = this.panes.get(webPaneId)
    if (!state) {
      const loaded = this.journal.load(webPaneId)
      state = {
        notes: loaded.notes,
        deliveryKeys: new Set(loaded.deliveryKeys),
        ackedUpTo: loaded.ackedUpTo,
        // A fresh process has no record of past deliveries; treating the
        // whole backlog as undelivered only re-offers it, which is the point.
        deliveredUpTo: loaded.ackedUpTo,
        nextId: loaded.nextId,
      }
      this.panes.set(webPaneId, state)
    }
    return state
  }

  private ack(webPaneId: string, state: PaneState, cursor: number): void {
    if (!Number.isFinite(cursor)) return
    // Never ack past what was actually delivered: a garbage cursor must not
    // silently discard answers nobody has seen.
    const effective = Math.min(Math.floor(cursor), state.deliveredUpTo)
    if (effective <= state.ackedUpTo) return
    const acknowledged = state.notes.filter((entry) => entry.id <= effective)
    this.journal.appendAck(webPaneId, effective)
    state.ackedUpTo = effective
    state.notes = state.notes.filter((entry) => entry.id > effective)
    this.journal.compact(webPaneId)
    for (const entry of acknowledged) {
      for (const attachment of entry.note.attachments ?? []) this.releaseAttachment(attachment.id)
    }
  }

  private deliver(webPaneId: string, state: PaneState): FeedbackDrainResult {
    const notes = state.notes.map((entry) => ({ ...entry.note, id: entry.id }))
    const last = state.notes[state.notes.length - 1]
    if (last && last.id > state.deliveredUpTo) state.deliveredUpTo = last.id
    this.drains.set(webPaneId, { count: notes.length, at: this.now() })
    this.onDrain(webPaneId)
    return { notes, cursor: state.deliveredUpTo }
  }
}

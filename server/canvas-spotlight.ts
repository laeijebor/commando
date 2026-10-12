import { randomBytes } from 'node:crypto'
import type { WebPaneNavigateDecision, CanvasSpotlightRequest } from '../shared/protocol.js'

export const MAX_SPOTLIGHT_WAIT_MS = 60_000
/** Settled decisions kept so an agent can still read its outcome after a timed-out wait. */
const MAX_SETTLED_DECISIONS = 256

type Settled = Exclude<WebPaneNavigateDecision, 'pending'>

type Entry = {
  webPaneId: string
  request: CanvasSpotlightRequest
  decision: WebPaneNavigateDecision
  waiters: Set<(decision: WebPaneNavigateDecision) => void>
}

/** Ephemeral canvas spotlight requests, one pending request per tab. */
export class CanvasSpotlightStore {
  private readonly entries = new Map<string, Entry>()
  private readonly pendingByPane = new Map<string, string>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Files a spotlight request, superseding any still-pending one for the tile. */
  requestSpotlight(webPaneId: string, target: Pick<CanvasSpotlightRequest, 'label' | 'labelId' | 'frame' | 'message'>, requestedBy?: string): CanvasSpotlightRequest {
    const previous = this.pendingByPane.get(webPaneId)
    if (previous) this.settle(previous, 'superseded')
    const request: CanvasSpotlightRequest = {
      id: `sr-${randomBytes(4).toString('hex')}`,
      ...target,
      ...(requestedBy ? { requestedBy } : {}),
      requestedAt: this.now(),
    }
    this.entries.set(request.id, { webPaneId, request, decision: 'pending', waiters: new Set() })
    this.pendingByPane.set(webPaneId, request.id)
    this.trimSettled()
    return request
  }

  /** The request's tile and current decision, or undefined for an unknown id. */
  lookup(requestId: string): { webPaneId: string; request: CanvasSpotlightRequest; decision: WebPaneNavigateDecision } | undefined {
    const entry = this.entries.get(requestId)
    return entry && { webPaneId: entry.webPaneId, request: entry.request, decision: entry.decision }
  }

  /** Settles a pending request. Returns false when it was already settled or unknown. */
  settle(requestId: string, decision: Settled): boolean {
    const entry = this.entries.get(requestId)
    if (!entry || entry.decision !== 'pending') return false
    entry.decision = decision
    if (this.pendingByPane.get(entry.webPaneId) === requestId) this.pendingByPane.delete(entry.webPaneId)
    for (const waiter of entry.waiters) waiter(decision)
    entry.waiters.clear()
    return true
  }

  /** Resolves with the decision once settled, or 'pending' after waitMs or on abort. */
  wait(requestId: string, waitMs: number, signal?: AbortSignal): Promise<WebPaneNavigateDecision> {
    const entry = this.entries.get(requestId)
    if (!entry) return Promise.resolve('closed')
    if (entry.decision !== 'pending' || waitMs <= 0 || signal?.aborted) {
      return Promise.resolve(entry.decision)
    }
    return new Promise((resolve) => {
      const finish = (decision: WebPaneNavigateDecision): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        entry.waiters.delete(finish)
        resolve(decision)
      }
      const onAbort = (): void => finish('pending')
      const timer = setTimeout(() => finish('pending'), waitMs)
      signal?.addEventListener('abort', onAbort)
      entry.waiters.add(finish)
    })
  }

  /** Settles requests for tiles that no longer exist. */
  retain(liveIds: ReadonlySet<string>): void {
    for (const [webPaneId, requestId] of [...this.pendingByPane]) {
      if (!liveIds.has(webPaneId)) this.settle(requestId, 'closed')
    }
  }

  pending(): Record<string, CanvasSpotlightRequest> {
    const result: Record<string, CanvasSpotlightRequest> = {}
    for (const [webPaneId, requestId] of this.pendingByPane) {
      const entry = this.entries.get(requestId)
      if (entry) result[webPaneId] = entry.request
    }
    return result
  }

  private trimSettled(): void {
    let excess = this.entries.size - MAX_SETTLED_DECISIONS - this.pendingByPane.size
    for (const [requestId, entry] of this.entries) {
      if (excess <= 0) break
      if (entry.decision === 'pending') continue
      this.entries.delete(requestId)
      excess -= 1
    }
  }
}

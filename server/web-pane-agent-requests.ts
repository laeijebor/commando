import { randomBytes } from 'node:crypto'
import type { WebPaneNavigateDecision, WebPaneNavigateRequest } from '../shared/protocol.js'

export const MAX_NAVIGATE_WAIT_MS = 60_000
/** Settled decisions kept so an agent can still read its outcome after a timed-out wait. */
const MAX_SETTLED_DECISIONS = 256

type Settled = Exclude<WebPaneNavigateDecision, 'pending'>

type Entry = {
  webPaneId: string
  request: WebPaneNavigateRequest
  decision: WebPaneNavigateDecision
  waiters: Set<(decision: WebPaneNavigateDecision) => void>
}

/**
 * Agent-initiated tile actions that the owner sees in the tile UI, held in
 * memory only. Navigate requests wait for the owner's accept/dismiss, one per
 * tile. Reloads need no approval: they bump a per-tile counter that viewers
 * watch, so whatever renders the tile (native webview, canvas, iframe)
 * reloads itself.
 */
export class WebPaneAgentRequests {
  private readonly entries = new Map<string, Entry>()
  private readonly pendingByPane = new Map<string, string>()
  private readonly reloadCounts = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Files a navigate request, superseding any still-pending one for the tile. */
  requestNavigate(webPaneId: string, url: string, requestedBy?: string): WebPaneNavigateRequest {
    const previous = this.pendingByPane.get(webPaneId)
    if (previous) this.settle(previous, 'superseded')
    const request: WebPaneNavigateRequest = {
      id: `nr-${randomBytes(4).toString('hex')}`,
      url,
      ...(requestedBy ? { requestedBy } : {}),
      requestedAt: this.now(),
    }
    this.entries.set(request.id, { webPaneId, request, decision: 'pending', waiters: new Set() })
    this.pendingByPane.set(webPaneId, request.id)
    this.trimSettled()
    return request
  }

  /** The request's tile and current decision, or undefined for an unknown id. */
  lookup(requestId: string): { webPaneId: string; request: WebPaneNavigateRequest; decision: WebPaneNavigateDecision } | undefined {
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

  reload(webPaneId: string): number {
    const next = (this.reloadCounts.get(webPaneId) ?? 0) + 1
    this.reloadCounts.set(webPaneId, next)
    return next
  }

  /** Settles requests for tiles that no longer exist and forgets their reloads. */
  retain(liveIds: ReadonlySet<string>): void {
    for (const [webPaneId, requestId] of [...this.pendingByPane]) {
      if (!liveIds.has(webPaneId)) this.settle(requestId, 'closed')
    }
    for (const webPaneId of [...this.reloadCounts.keys()]) {
      if (!liveIds.has(webPaneId)) this.reloadCounts.delete(webPaneId)
    }
  }

  navigateRequests(): Record<string, WebPaneNavigateRequest> {
    const result: Record<string, WebPaneNavigateRequest> = {}
    for (const [webPaneId, requestId] of this.pendingByPane) {
      const entry = this.entries.get(requestId)
      if (entry) result[webPaneId] = entry.request
    }
    return result
  }

  reloads(): Record<string, number> {
    return Object.fromEntries(this.reloadCounts)
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

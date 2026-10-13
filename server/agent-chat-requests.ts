import { randomBytes } from 'node:crypto'
import type { AgentChatDecision, AgentChatFailure, AgentChatInput, AgentChatOutcome, AgentChatRequest, AgentChatResult } from '../shared/agent-chats.js'

export const AGENT_CHAT_REQUEST_TTL_MS = 10 * 60_000
type Entry = {
  request: AgentChatRequest
  input: AgentChatInput
  decision: AgentChatDecision
  result?: AgentChatResult | AgentChatFailure
  accepting: boolean
  timer: ReturnType<typeof setTimeout>
  waiters: Set<() => void>
}

export class AgentChatRequests {
  private readonly entries = new Map<string, Entry>()
  constructor(private readonly changed: () => void = () => {}, private readonly now = Date.now) {}

  create(request: Omit<AgentChatRequest, 'id' | 'requestedAt'>, input: AgentChatInput): AgentChatRequest {
    this.expire()
    for (const [id, entry] of this.entries) {
      if (entry.request.callerTargetId === request.callerTargetId && entry.decision === 'pending' && !entry.accepting) this.settle(id, 'superseded')
    }
    const value: AgentChatRequest = { ...request, id: `cr-${randomBytes(12).toString('hex')}`, requestedAt: this.now() }
    const timer = setTimeout(() => { this.expire(); }, AGENT_CHAT_REQUEST_TTL_MS)
    timer.unref()
    this.entries.set(value.id, { request: value, input, decision: 'pending', accepting: false, timer, waiters: new Set() })
    this.trim()
    this.changed()
    return value
  }

  lookup(id: string): Entry | undefined {
    this.expire()
    return this.entries.get(id)
  }

  claim(id: string): Entry | undefined {
    const entry = this.lookup(id)
    if (!entry || entry.decision !== 'pending' || entry.accepting) return undefined
    entry.accepting = true
    clearTimeout(entry.timer)
    return entry
  }

  settle(id: string, decision: Exclude<AgentChatDecision, 'pending'>, result?: AgentChatResult | AgentChatFailure): boolean {
    const entry = this.entries.get(id)
    if (!entry || entry.decision !== 'pending') return false
    clearTimeout(entry.timer)
    entry.decision = decision
    entry.result = result
    for (const waiter of entry.waiters) waiter()
    entry.waiters.clear()
    this.changed()
    return true
  }

  pending(): Record<string, AgentChatRequest> {
    this.expire()
    return Object.fromEntries([...this.entries].filter(([, entry]) => entry.decision === 'pending').map(([id, entry]) => [id, entry.request]))
  }

  outcome(id: string): AgentChatOutcome | undefined {
    const entry = this.lookup(id)
    return entry && { ...(entry.result ?? { ok: true }), decision: entry.decision, requestId: id }
  }

  async wait(id: string, waitMs: number, signal?: AbortSignal): Promise<AgentChatOutcome | undefined> {
    const entry = this.lookup(id)
    if (entry?.decision === 'pending' && waitMs > 0 && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          clearTimeout(timer)
          entry.waiters.delete(finish)
          signal?.removeEventListener('abort', finish)
          resolve()
        }
        const timer = setTimeout(finish, waitMs)
        signal?.addEventListener('abort', finish, { once: true })
        entry.waiters.add(finish)
      })
    }
    return this.outcome(id)
  }

  private expire(): void {
    for (const [id, entry] of this.entries) {
      if (entry.decision === 'pending' && !entry.accepting && this.now() - entry.request.requestedAt >= AGENT_CHAT_REQUEST_TTL_MS) this.settle(id, 'expired')
    }
  }

  private trim(): void {
    let settled = [...this.entries.values()].filter((entry) => entry.decision !== 'pending').length
    for (const [id, entry] of this.entries) {
      if (settled <= 256) break
      if (entry.decision !== 'pending') { this.entries.delete(id); settled-- }
    }
  }
}

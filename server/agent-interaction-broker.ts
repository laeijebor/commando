import type {
  AgentInteractionAnswer,
  AgentInteractionRequest,
} from '../shared/protocol.js'

const DEFAULT_TIMEOUT_MS = 590_000

type PendingInteraction = {
  request: AgentInteractionRequest
  resolve: (answer: AgentInteractionAnswer | null) => void
  timer: NodeJS.Timeout
}

function validAnswer(
  request: AgentInteractionRequest,
  answer: AgentInteractionAnswer,
): boolean {
  if (request.kind === 'permission') {
    return answer.action === 'allow_once' ||
      answer.action === 'allow_always' ||
      answer.action === 'deny'
  }
  if (answer.action === 'reject') return true
  if (answer.action !== 'answer' || !Array.isArray(answer.answers)) return false
  if (answer.answers.length !== (request.questions?.length ?? 0)) return false
  return answer.answers.every((values) => (
    Array.isArray(values) &&
    values.length <= 12 &&
    values.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 300)
  ))
}

export class AgentInteractionBroker {
  private readonly pending = new Map<string, PendingInteraction>()
  private consumers = 0
  private onPendingChange: () => void = () => undefined

  constructor(private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  setConsumerCount(count: number): void {
    this.consumers = Math.max(0, count)
    if (this.consumers === 0) this.cancelAll()
  }

  hasConsumers(): boolean {
    return this.consumers > 0
  }

  setPendingChangeListener(listener: () => void): void {
    this.onPendingChange = listener
  }

  hasPending(paneId: string, requestId: string): boolean {
    return this.pending.has(this.key(paneId, requestId))
  }

  wait(
    paneId: string,
    request: AgentInteractionRequest,
  ): Promise<AgentInteractionAnswer | null> {
    if (!this.hasConsumers()) return Promise.resolve(null)
    const key = this.key(paneId, request.id)
    this.cancelKey(key)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        this.onPendingChange()
        resolve(null)
      }, this.timeoutMs)
      timer.unref()
      this.pending.set(key, { request, resolve, timer })
      this.onPendingChange()
    })
  }

  answer(
    paneId: string,
    requestId: string,
    answer: AgentInteractionAnswer,
  ): boolean {
    const key = this.key(paneId, requestId)
    const pending = this.pending.get(key)
    if (!pending || !validAnswer(pending.request, answer)) return false
    clearTimeout(pending.timer)
    this.pending.delete(key)
    this.onPendingChange()
    pending.resolve(answer)
    return true
  }

  cancel(paneId: string, requestId: string): boolean {
    return this.cancelKey(this.key(paneId, requestId))
  }

  cancelAll(): void {
    for (const key of [...this.pending.keys()]) this.cancelKey(key)
  }

  private cancelKey(key: string): boolean {
    const pending = this.pending.get(key)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.pending.delete(key)
    this.onPendingChange()
    pending.resolve(null)
    return true
  }

  private key(paneId: string, requestId: string): string {
    return `${paneId}\0${requestId}`
  }
}

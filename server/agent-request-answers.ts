import type { AgentInteractionAnswer } from '../shared/protocol.js'
import type { AgentInteractionBroker } from './agent-interaction-broker.js'
import type { AgentStatusChange, AgentStatusRegistry } from './agent-status-registry.js'

export const MAX_INTERACTION_ID_LENGTH = 200
const MAX_ANSWER_GROUPS = 8
const MAX_ANSWERS_PER_GROUP = 12
const MAX_ANSWER_LENGTH = 300

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isInteractionId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_INTERACTION_ID_LENGTH
}

/**
 * Shape validation shared by every answer channel. Whether the action suits the
 * pending request (permission versus question) is decided by the broker.
 */
export function parseAgentInteractionAnswer(value: unknown): AgentInteractionAnswer | null {
  if (!isRecord(value)) return null
  const action = value.action
  if (
    action !== 'allow_once' &&
    action !== 'allow_always' &&
    action !== 'deny' &&
    action !== 'answer' &&
    action !== 'reject'
  ) return null
  if (value.answers !== undefined) {
    if (
      !Array.isArray(value.answers) ||
      value.answers.length > MAX_ANSWER_GROUPS ||
      !value.answers.every((answer) => (
        Array.isArray(answer) &&
        answer.length <= MAX_ANSWERS_PER_GROUP &&
        answer.every((item) => (
          typeof item === 'string' && item.length > 0 && item.length <= MAX_ANSWER_LENGTH
        ))
      ))
    ) return null
    return { action, answers: value.answers as string[][] }
  }
  return { action }
}

export type AgentRequestAnswerCode = 'request_unavailable' | 'invalid_answer'

export type AgentRequestAnswerOutcome =
  | { ok: true; changed: boolean }
  | { ok: false; code: AgentRequestAnswerCode; message: string }

export type AgentRequestAnswerDependencies = {
  interactions: Pick<AgentInteractionBroker, 'answer' | 'hasPending'>
  registry: Pick<AgentStatusRegistry, 'resolveInteractionRequest'>
  onStatusChange: (change: AgentStatusChange) => void
  onAnswered?: () => void
}

/**
 * Answers one pending agent interaction: releases the agent's held hook, drops
 * the request from the status registry and republishes the result. Every answer
 * channel (companion hub, owner `/ws` sockets, the notification HTTP route)
 * funnels through here so the semantics cannot drift apart.
 */
export function answerAgentRequest(
  dependencies: AgentRequestAnswerDependencies,
  paneId: string,
  interactionId: string,
  answer: AgentInteractionAnswer,
): AgentRequestAnswerOutcome {
  if (!dependencies.interactions.hasPending(paneId, interactionId)) {
    return {
      ok: false,
      code: 'request_unavailable',
      message: 'The agent request is no longer pending',
    }
  }
  if (!dependencies.interactions.answer(paneId, interactionId, answer)) {
    return {
      ok: false,
      code: 'invalid_answer',
      message: 'The answer does not match the pending agent request',
    }
  }
  dependencies.onStatusChange(
    dependencies.registry.resolveInteractionRequest(paneId, interactionId),
  )
  dependencies.onAnswered?.()
  return { ok: true, changed: true }
}

/**
 * Bounded memory of recently used idempotency keys so a retried answer (a
 * reconnecting phone, a notification action delivered twice) re-acks instead of
 * answering a second, unrelated request that reused the id.
 */
export class IdempotencyKeyMemory {
  private readonly keys = new Set<string>()

  constructor(private readonly limit = 500) {}

  has(key: string): boolean {
    return this.keys.has(key)
  }

  remember(key: string): void {
    this.keys.add(key)
    if (this.keys.size <= this.limit) return
    const oldest = this.keys.values().next().value
    if (oldest !== undefined) this.keys.delete(oldest)
  }
}

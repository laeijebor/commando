import { describe, expect, it, vi } from 'vitest'

import type { AgentInteractionRequest } from '../shared/protocol.js'
import { AgentInteractionBroker } from './agent-interaction-broker.js'
import {
  answerAgentRequest,
  IdempotencyKeyMemory,
  isInteractionId,
  parseAgentInteractionAnswer,
} from './agent-request-answers.js'
import type { AgentStatusChange } from './agent-status-registry.js'

const permission: AgentInteractionRequest = {
  id: 'permission-1',
  kind: 'permission',
  prompt: 'Run tests?',
  createdAt: 1,
}

const question: AgentInteractionRequest = {
  id: 'question-1',
  kind: 'question',
  prompt: 'Which target?',
  questions: [{
    header: 'Target',
    question: 'Which target?',
    options: [{ label: 'macOS' }],
    multiple: false,
    custom: false,
  }],
  createdAt: 2,
}

function dependencies(interactions: AgentInteractionBroker) {
  const change: AgentStatusChange = { type: 'remove', paneId: '%1' }
  const onStatusChange = vi.fn()
  const onAnswered = vi.fn()
  const resolveInteractionRequest = vi.fn(() => change)
  return {
    onStatusChange,
    onAnswered,
    resolveInteractionRequest,
    change,
    deps: {
      interactions,
      registry: { resolveInteractionRequest },
      onStatusChange,
      onAnswered,
    },
  }
}

describe('answerAgentRequest', () => {
  it('answers the hook, resolves the registry request, and republishes', async () => {
    const interactions = new AgentInteractionBroker()
    interactions.registerConsumer()
    const waiting = interactions.wait('%1', permission)
    const context = dependencies(interactions)

    const outcome = answerAgentRequest(context.deps, '%1', 'permission-1', { action: 'allow_once' })

    expect(outcome).toEqual({ ok: true, changed: true })
    await expect(waiting).resolves.toEqual({ action: 'allow_once' })
    expect(context.resolveInteractionRequest).toHaveBeenCalledWith('%1', 'permission-1')
    expect(context.onStatusChange).toHaveBeenCalledWith(context.change)
    expect(context.onAnswered).toHaveBeenCalledTimes(1)
  })

  it('reports an unavailable request without touching the registry', () => {
    const interactions = new AgentInteractionBroker()
    const context = dependencies(interactions)

    const outcome = answerAgentRequest(context.deps, '%1', 'permission-1', { action: 'deny' })

    expect(outcome).toEqual({
      ok: false,
      code: 'request_unavailable',
      message: 'The agent request is no longer pending',
    })
    expect(context.resolveInteractionRequest).not.toHaveBeenCalled()
    expect(context.onStatusChange).not.toHaveBeenCalled()
  })

  it('keeps a pending request alive when the answer does not match its kind', async () => {
    const interactions = new AgentInteractionBroker()
    interactions.registerConsumer()
    const waiting = interactions.wait('%1', question)
    const context = dependencies(interactions)

    const outcome = answerAgentRequest(context.deps, '%1', 'question-1', { action: 'allow_once' })

    expect(outcome).toMatchObject({ ok: false, code: 'invalid_answer' })
    expect(interactions.hasPending('%1', 'question-1')).toBe(true)
    expect(context.onStatusChange).not.toHaveBeenCalled()

    expect(answerAgentRequest(context.deps, '%1', 'question-1', {
      action: 'answer',
      answers: [['macOS']],
    })).toEqual({ ok: true, changed: true })
    await expect(waiting).resolves.toEqual({ action: 'answer', answers: [['macOS']] })
  })

  it('lets the first valid answer win when two clients race', async () => {
    const interactions = new AgentInteractionBroker()
    interactions.registerConsumer()
    const waiting = interactions.wait('%1', permission)
    const island = dependencies(interactions)
    const phone = dependencies(interactions)

    expect(answerAgentRequest(island.deps, '%1', 'permission-1', { action: 'allow_once' }).ok).toBe(true)
    expect(answerAgentRequest(phone.deps, '%1', 'permission-1', { action: 'deny' })).toMatchObject({
      ok: false,
      code: 'request_unavailable',
    })
    await expect(waiting).resolves.toEqual({ action: 'allow_once' })
  })
})

describe('parseAgentInteractionAnswer', () => {
  it('accepts every action and bounded answer groups', () => {
    for (const action of ['allow_once', 'allow_always', 'deny', 'answer', 'reject'] as const) {
      expect(parseAgentInteractionAnswer({ action })).toEqual({ action })
    }
    expect(parseAgentInteractionAnswer({ action: 'answer', answers: [['a'], ['b']] })).toEqual({
      action: 'answer',
      answers: [['a'], ['b']],
    })
  })

  it('rejects unknown actions and oversized or empty answers', () => {
    expect(parseAgentInteractionAnswer(null)).toBeNull()
    expect(parseAgentInteractionAnswer({ action: 'allow' })).toBeNull()
    expect(parseAgentInteractionAnswer({ action: 'answer', answers: ['a'] })).toBeNull()
    expect(parseAgentInteractionAnswer({
      action: 'answer',
      answers: Array.from({ length: 9 }, () => ['a']),
    })).toBeNull()
    expect(parseAgentInteractionAnswer({
      action: 'answer',
      answers: [Array.from({ length: 13 }, () => 'a')],
    })).toBeNull()
    expect(parseAgentInteractionAnswer({ action: 'answer', answers: [['x'.repeat(301)]] })).toBeNull()
    expect(parseAgentInteractionAnswer({ action: 'answer', answers: [['']] })).toBeNull()
  })

  it('bounds interaction ids', () => {
    expect(isInteractionId('permission-1')).toBe(true)
    expect(isInteractionId('x'.repeat(200))).toBe(true)
    expect(isInteractionId('x'.repeat(201))).toBe(false)
    expect(isInteractionId('')).toBe(false)
    expect(isInteractionId(7)).toBe(false)
  })
})

describe('IdempotencyKeyMemory', () => {
  it('remembers recent keys and forgets the oldest past its limit', () => {
    const memory = new IdempotencyKeyMemory(2)
    memory.remember('a')
    memory.remember('b')
    expect(memory.has('a')).toBe(true)

    memory.remember('c')
    expect(memory.has('a')).toBe(false)
    expect(memory.has('b')).toBe(true)
    expect(memory.has('c')).toBe(true)
  })
})

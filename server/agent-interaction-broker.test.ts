import { describe, expect, it } from 'vitest'

import type { AgentInteractionRequest } from '../shared/protocol.js'
import { AgentInteractionBroker } from './agent-interaction-broker.js'

const permission: AgentInteractionRequest = {
  id: 'permission-1',
  kind: 'permission',
  prompt: 'Run tests?',
  createdAt: 1,
}

describe('AgentInteractionBroker', () => {
  it('does not hold provider hooks when no companion is connected', async () => {
    const broker = new AgentInteractionBroker()
    await expect(broker.wait('%1', permission)).resolves.toBeNull()
  })

  it('delivers validated answers to the matching provider hook', async () => {
    const broker = new AgentInteractionBroker()
    broker.registerConsumer()
    const waiting = broker.wait('%1', permission)

    expect(broker.hasPending('%1', permission.id)).toBe(true)
    expect(broker.answer('%1', permission.id, { action: 'allow_once' })).toBe(true)
    await expect(waiting).resolves.toEqual({ action: 'allow_once' })
    expect(broker.hasPending('%1', permission.id)).toBe(false)
    expect(broker.answer('%1', permission.id, { action: 'allow_once' })).toBe(false)
  })

  it('cancels a request when the provider answers it elsewhere', async () => {
    const broker = new AgentInteractionBroker()
    broker.registerConsumer()
    const waiting = broker.wait('%1', permission)

    expect(broker.cancel('%1', permission.id)).toBe(true)
    await expect(waiting).resolves.toBeNull()
    expect(broker.cancel('%1', permission.id)).toBe(false)
  })

  it('rejects mismatched answer shapes and releases hooks on disconnect', async () => {
    const broker = new AgentInteractionBroker()
    const release = broker.registerConsumer()
    const waiting = broker.wait('%1', permission)

    expect(broker.answer('%1', permission.id, {
      action: 'answer',
      answers: [['Production']],
    })).toBe(false)
    release()
    await expect(waiting).resolves.toBeNull()
  })

  it('holds hooks open until every registered consumer has released', async () => {
    const broker = new AgentInteractionBroker()
    const companion = broker.registerConsumer()
    const ownerSocket = broker.registerConsumer()
    expect(broker.consumerCount()).toBe(2)

    const waiting = broker.wait('%1', permission)
    companion()
    expect(broker.hasConsumers()).toBe(true)
    expect(broker.hasPending('%1', permission.id)).toBe(true)

    companion()
    expect(broker.consumerCount()).toBe(1)
    expect(broker.hasPending('%1', permission.id)).toBe(true)

    ownerSocket()
    expect(broker.hasConsumers()).toBe(false)
    await expect(waiting).resolves.toBeNull()
    await expect(broker.wait('%1', permission)).resolves.toBeNull()
  })

  it('accepts hooks again once a new consumer registers', async () => {
    const broker = new AgentInteractionBroker()
    const release = broker.registerConsumer()
    release()
    await expect(broker.wait('%1', permission)).resolves.toBeNull()

    broker.registerConsumer()
    const waiting = broker.wait('%1', permission)
    expect(broker.answer('%1', permission.id, { action: 'deny' })).toBe(true)
    await expect(waiting).resolves.toEqual({ action: 'deny' })
  })
})

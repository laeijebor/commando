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
    broker.setConsumerCount(1)
    const waiting = broker.wait('%1', permission)

    expect(broker.hasPending('%1', permission.id)).toBe(true)
    expect(broker.answer('%1', permission.id, { action: 'allow_once' })).toBe(true)
    await expect(waiting).resolves.toEqual({ action: 'allow_once' })
    expect(broker.hasPending('%1', permission.id)).toBe(false)
    expect(broker.answer('%1', permission.id, { action: 'allow_once' })).toBe(false)
  })

  it('cancels a request when the provider answers it elsewhere', async () => {
    const broker = new AgentInteractionBroker()
    broker.setConsumerCount(1)
    const waiting = broker.wait('%1', permission)

    expect(broker.cancel('%1', permission.id)).toBe(true)
    await expect(waiting).resolves.toBeNull()
    expect(broker.cancel('%1', permission.id)).toBe(false)
  })

  it('rejects mismatched answer shapes and releases hooks on disconnect', async () => {
    const broker = new AgentInteractionBroker()
    broker.setConsumerCount(1)
    const waiting = broker.wait('%1', permission)

    expect(broker.answer('%1', permission.id, {
      action: 'answer',
      answers: [['Production']],
    })).toBe(false)
    broker.setConsumerCount(0)
    await expect(waiting).resolves.toBeNull()
  })
})

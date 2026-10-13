import { afterEach, expect, it, vi } from 'vitest'
import { AgentChatRequests } from './agent-chat-requests.js'

afterEach(() => vi.useRealTimers())
const input = { title: 'Fix', prompt: 'Brief', location: 'session', split: 'right' } as const
const request = { callerPaneId: '%1', callerTargetId: 'parent', requestedBy: 'codex', reason: 'depth', summary: { location: 'session', title: 'Fix', provider: 'codex', promptPreview: 'Brief' } } as const

it('broadcasts expiry without an agent polling and wakes long-poll waiters', async () => {
  vi.useFakeTimers()
  const changed = vi.fn(), requests = new AgentChatRequests(changed)
  const value = requests.create(request, input)
  const waiting = requests.wait(value.id, 600_001)
  await vi.advanceTimersByTimeAsync(600_000)
  expect(await waiting).toMatchObject({ decision: 'expired', requestId: value.id })
  expect(changed).toHaveBeenCalledTimes(2)
  expect(requests.pending()).toEqual({})
})

it('wakes superseded waiters, times out as pending and removes aborted waits', async () => {
  vi.useFakeTimers()
  const requests = new AgentChatRequests()
  const first = requests.create(request, input)
  const waiting = requests.wait(first.id, 60_000)
  const second = requests.create(request, input)
  expect(await waiting).toMatchObject({ decision: 'superseded' })
  const timeout = requests.wait(second.id, 1000)
  await vi.advanceTimersByTimeAsync(1000)
  expect(await timeout).toMatchObject({ decision: 'pending' })
  const controller = new AbortController(), aborted = requests.wait(second.id, 60_000, controller.signal)
  controller.abort()
  expect(await aborted).toMatchObject({ decision: 'pending' })
  expect(requests.lookup(second.id)?.waiters.size).toBe(0)
  requests.settle(second.id, 'dismissed')
})

it('claims acceptance once and retains a final result without superseding an in-flight creation', () => {
  const requests = new AgentChatRequests()
  const first = requests.create(request, input)
  expect(requests.claim(first.id)).toBeDefined()
  expect(requests.claim(first.id)).toBeUndefined()
  const second = requests.create(request, input)
  expect(requests.lookup(first.id)?.decision).toBe('pending')
  requests.settle(first.id, 'accepted', { ok: false, status: 409, error: 'Branch conflict' })
  expect(requests.outcome(first.id)).toMatchObject({ decision: 'accepted', ok: false, error: 'Branch conflict' })
  requests.settle(second.id, 'dismissed')
})

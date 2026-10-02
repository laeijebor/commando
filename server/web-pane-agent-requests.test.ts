import { describe, expect, it } from 'vitest'
import { WebPaneAgentRequests } from './web-pane-agent-requests.js'

describe('WebPaneAgentRequests', () => {
  it('keeps one pending request per tile and supersedes older ones', async () => {
    const requests = new WebPaneAgentRequests(() => 1_000)
    const first = requests.requestNavigate('w-00000001', 'http://localhost:1/a', 'claude · gizmo')
    const waiting = requests.wait(first.id, 5_000)
    const second = requests.requestNavigate('w-00000001', 'http://localhost:1/b')

    expect(await waiting).toBe('superseded')
    expect(requests.navigateRequests()).toEqual({
      'w-00000001': { id: second.id, url: 'http://localhost:1/b', requestedAt: 1_000 },
    })
  })

  it('settles a request once and reports later waits immediately', async () => {
    const requests = new WebPaneAgentRequests()
    const request = requests.requestNavigate('w-00000001', 'http://localhost:1/')

    expect(requests.settle(request.id, 'accepted')).toBe(true)
    expect(requests.settle(request.id, 'dismissed')).toBe(false)
    expect(await requests.wait(request.id, 5_000)).toBe('accepted')
    expect(requests.navigateRequests()).toEqual({})
  })

  it('returns pending when the wait times out or the caller goes away', async () => {
    const requests = new WebPaneAgentRequests()
    const request = requests.requestNavigate('w-00000001', 'http://localhost:1/')
    expect(await requests.wait(request.id, 10)).toBe('pending')

    const controller = new AbortController()
    const aborted = requests.wait(request.id, 5_000, controller.signal)
    controller.abort()
    expect(await aborted).toBe('pending')
  })

  it('closes requests and forgets reloads for tiles that are gone', async () => {
    const requests = new WebPaneAgentRequests()
    const request = requests.requestNavigate('w-00000001', 'http://localhost:1/')
    requests.reload('w-00000001')
    requests.reload('w-00000002')
    const waiting = requests.wait(request.id, 5_000)

    requests.retain(new Set(['w-00000002']))

    expect(await waiting).toBe('closed')
    expect(requests.reloads()).toEqual({ 'w-00000002': 1 })
  })
})

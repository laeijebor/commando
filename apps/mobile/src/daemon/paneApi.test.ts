import { TmuxAgentLaunchCompatibilityError } from '@commando/tmux-create'
import type { Host } from '../hosts/types'
import { createTmuxSession, dismissSessionCreation, fetchPanePrs, retrySessionCreation, startSessionCreation } from './paneApi'

const host: Host = { id: 'fixture', name: 'fixture', baseUrl: 'http://localhost:4310', auth: { kind: 'token', token: 'fixture' } }
const created = { kind: 'session' as const, sessionId: '$1', sessionName: 'created', windowId: '@1', windowIndex: 0, windowName: 'agent', paneId: '%7', paneIndex: 0, panePath: '/tmp' }

it.each(['claude', 'codex', 'opencode', 'cursor'] as const)('preserves the target when an old daemon silently ignores requested %s launch', async (provider) => {
  const fetcher = jest.fn(async () => new Response(JSON.stringify({ created }), { status: 201 }))
  globalThis.fetch = fetcher as unknown as typeof fetch
  const error = await createTmuxSession(host, { name: 'created', agent: { provider } }).catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(TmuxAgentLaunchCompatibilityError)
  expect((error as TmuxAgentLaunchCompatibilityError).response.created).toEqual(created)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('accepts a matching acknowledgment and preserves literal prompt content in one request', async () => {
  const response = { created, agentLaunch: { version: 1, provider: 'cursor', paneId: '%7', mode: 'interactive-pty', state: 'initiated' } }
  const fetcher = jest.fn(async (_url: unknown, _init: unknown) => new Response(JSON.stringify(response), { status: 201 }))
  globalThis.fetch = fetcher as unknown as typeof fetch
  const request = { name: 'created', agent: { provider: 'cursor' as const, prompt: "Leo's spec\n$HOME" } }
  await expect(createTmuxSession(host, request)).resolves.toEqual(response)
  expect(fetcher).toHaveBeenCalledWith('http://localhost:4310/api/tmux/sessions', expect.objectContaining({ body: JSON.stringify(request) }))
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('accepts an old daemon response for a requested shell', async () => {
  globalThis.fetch = jest.fn(async () => new Response(JSON.stringify({ created }), { status: 201 })) as unknown as typeof fetch
  await expect(createTmuxSession(host, { name: 'created' })).resolves.toEqual({ created })
})

it('fetches PR badges through the daemon background cache with normal authentication', async () => {
  const fetcher = jest.fn(async (_url: unknown, _init: unknown) => new Response(JSON.stringify({ list: { pullRequests: [] } }), { status: 200 }))
  globalThis.fetch = fetcher as unknown as typeof fetch
  await fetchPanePrs(host, '%14', { background: true })
  expect(fetcher).toHaveBeenCalledWith('http://localhost:4310/api/prs/pane?paneId=%2514&background=1', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer fixture' }) }))
})

describe('background session creation', () => {
  const running = { id: 'c1', name: 'big', cwd: '/repo', branch: 'big', stage: 'checking-out', percent: 12, startedAt: 1 }

  it('answers the creation the daemon started', async () => {
    const fetcher = jest.fn(async (_url: unknown, _init: unknown) => new Response(JSON.stringify({ creation: running }), { status: 202 }))
    globalThis.fetch = fetcher as unknown as typeof fetch
    await expect(startSessionCreation(host, { name: 'big', cwd: '/repo' })).resolves.toEqual(running)
    expect(fetcher).toHaveBeenCalledWith('http://localhost:4310/api/tmux/session-creations', expect.objectContaining({ method: 'POST' }))
  })

  it('shows an early failure as the daemon worded it', async () => {
    globalThis.fetch = jest.fn(async () => new Response(JSON.stringify({ error: 'Branch big is checked out elsewhere' }), { status: 409 })) as unknown as typeof fetch
    await expect(startSessionCreation(host, { name: 'big' })).rejects.toThrow('Branch big is checked out elsewhere')
  })

  it('falls back to a synchronous create on a daemon without the route', async () => {
    const fetcher = jest.fn(async (url: unknown) => String(url).endsWith('/session-creations')
      ? new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
      : new Response(JSON.stringify({ created }), { status: 201 }))
    globalThis.fetch = fetcher as unknown as typeof fetch
    const creation = await startSessionCreation(host, { name: 'created', cwd: '/tmp' })
    expect(creation).toMatchObject({ stage: 'done', name: 'created', cwd: '/tmp', result: { created } })
    expect(fetcher).toHaveBeenLastCalledWith('http://localhost:4310/api/tmux/sessions', expect.anything())
  })

  it('retries and dismisses by id', async () => {
    const fetcher = jest.fn(async (_url: unknown, init: unknown) => (init as RequestInit).method === 'DELETE'
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ creation: { ...running, stage: 'preparing' } }), { status: 202 }))
    globalThis.fetch = fetcher as unknown as typeof fetch
    await expect(retrySessionCreation(host, 'c/1')).resolves.toMatchObject({ stage: 'preparing' })
    expect(fetcher).toHaveBeenLastCalledWith('http://localhost:4310/api/tmux/session-creations/c%2F1/retry', expect.objectContaining({ method: 'POST' }))
    await dismissSessionCreation(host, 'c1')
    expect(fetcher).toHaveBeenLastCalledWith('http://localhost:4310/api/tmux/session-creations/c1', expect.objectContaining({ method: 'DELETE' }))
  })
})

import { TmuxAgentLaunchCompatibilityError } from '@commando/tmux-create'
import type { Host } from '../hosts/types'
import { createTmuxSession } from './paneApi'

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

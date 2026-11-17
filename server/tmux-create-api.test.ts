import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { handleTmuxCreateApi } from './tmux-create-api.js'
import { TmuxCreator } from './tmux-create.js'

function request(input: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), { method: 'POST', headers: { 'content-type': 'application/json' } }) as IncomingMessage
}

it('rejects an unavailable Cursor CLI through the creation API before any tmux mutation', async () => {
  const run = vi.fn()
  const creator = new TmuxCreator(run, [], undefined, async () => { throw new Error('Cannot start agent: executable not found on the daemon PATH') })
  const response = { writeHead: vi.fn(), end: vi.fn() }
  const onCreated = vi.fn()
  await handleTmuxCreateApi(request({ name: 'cursor', agent: { provider: 'cursor' } }), response as unknown as ServerResponse, new URL('http://localhost/api/tmux/sessions'), creator, vi.fn(), onCreated)
  expect(response.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
  expect(JSON.parse(response.end.mock.calls[0][0])).toEqual({ error: 'Cannot start agent: executable not found on the daemon PATH' })
  expect(run).not.toHaveBeenCalled()
  expect(onCreated).not.toHaveBeenCalled()
})

it.each(['claude', 'codex', 'opencode', 'cursor'] as const)('acknowledges the requested %s PTY launch on the actual reported target', async (provider) => {
  const run = vi.fn(async () => ['$1', 'created', '@1', '0', 'agent', '%7', '0', '/tmp', '/tmp'].join('\u001f') + '\n')
  const creator = new TmuxCreator(run, [], undefined, async () => '/fake/cli', {})
  const response = { writeHead: vi.fn(), end: vi.fn() }
  await handleTmuxCreateApi(request({ name: 'created', agent: { provider, prompt: 'update' } }), response as unknown as ServerResponse, new URL('http://localhost/api/tmux/sessions'), creator, vi.fn(), vi.fn())
  expect(response.writeHead).toHaveBeenCalledWith(201, expect.any(Object))
  const result = JSON.parse(response.end.mock.calls[0][0])
  expect(result.agentLaunch).toEqual({ version: 1, provider, paneId: '%7', mode: 'interactive-pty', state: 'initiated' })
  expect(result.created.paneId).toBe('%7')
  expect(run).toHaveBeenCalledOnce()
})

it("offers pickers the profiles Settings allows, with their labels and default, and only picker fields", async () => {
  const response = { writeHead: vi.fn(), end: vi.fn() }
  const get = Object.assign(Readable.from([]), { method: 'GET', headers: {} }) as IncomingMessage
  const profiles = vi.fn(async () => [
    { name: 'claudew', configDir: '/h/.claudew', lastUsedAt: 2, label: 'Work', isDefault: true, hidden: false },
    { name: 'claudep', configDir: '/h/.claudep' },
  ])
  await handleTmuxCreateApi(get, response as unknown as ServerResponse, new URL('http://localhost/api/tmux/claude-profiles'), new TmuxCreator(vi.fn(), []), vi.fn(), vi.fn(), profiles)
  expect(JSON.parse(response.end.mock.calls[0][0])).toEqual({ profiles: [
    { name: 'claudew', configDir: '/h/.claudew', lastUsedAt: 2, label: 'Work', isDefault: true },
    { name: 'claudep', configDir: '/h/.claudep' },
  ] })
})

it('starts a session creation, answering 202 while it runs on and 201 when it was quick, and retries or dismisses it', async () => {
  const send = async (method: string, path: string, input?: unknown) => {
    const response: { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn> } = { writeHead: vi.fn(() => response), end: vi.fn((_body?: string) => undefined), setHeader: vi.fn() }
    const incoming = input === undefined
      ? Object.assign(Readable.from([]), { method, headers: {} }) as IncomingMessage
      : Object.assign(request(input), { method })
    await handleTmuxCreateApi(incoming, response as unknown as ServerResponse, new URL(`http://localhost${path}`), new TmuxCreator(vi.fn(), []), vi.fn(), vi.fn(), undefined, undefined, creations)
    const body = response.end.mock.calls[0]?.[0]
    return { status: response.writeHead.mock.calls[0]?.[0], body: body ? JSON.parse(body) : undefined }
  }
  const { SessionCreations } = await import('./session-creations.js')
  let slow = true
  const creations = new SessionCreations(async (_input, progress) => {
    if (slow) {
      progress('checking-out')
      throw new Error('git worktree add failed: fatal: disk full')
    }
    return { created: { kind: 'session', sessionId: '$1', sessionName: 'a', windowId: '@1', windowIndex: 0, windowName: 'a', paneId: '%1', paneIndex: 0, panePath: '/r' } }
  }, vi.fn())

  const started = await send('POST', '/api/tmux/session-creations', { name: 'a', cwd: '/r', worktree: { branch: 'a' } })
  expect(started).toMatchObject({ status: 202, body: { creation: { stage: 'checking-out' } } })
  const id = started.body.creation.id as string
  await new Promise((resolve) => setImmediate(resolve))
  expect(creations.list()[0]).toMatchObject({ id, stage: 'failed' })

  slow = false
  expect(await send('POST', `/api/tmux/session-creations/${id}/retry`, {})).toMatchObject({ status: 202, body: { creation: { id, stage: 'preparing' } } })
  await new Promise((resolve) => setImmediate(resolve))
  expect(await send('DELETE', `/api/tmux/session-creations/${id}`)).toEqual({ status: 204, body: undefined })
  expect(await send('DELETE', `/api/tmux/session-creations/${id}`)).toMatchObject({ status: 404 })

  expect(await send('POST', '/api/tmux/session-creations', { name: 'a', cwd: '/r' })).toMatchObject({ status: 201, body: { creation: { stage: 'done', result: { created: { paneId: '%1' } } } } })
})

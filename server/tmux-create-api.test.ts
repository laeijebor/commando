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

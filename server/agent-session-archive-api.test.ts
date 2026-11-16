import { createServer, type Server } from 'node:http'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentSessionArchiveApi, type AgentSessionArchiveDependencies } from './agent-session-archive-api.js'

const token = 'agent-session-archive-token-of-at-least-32-chars'
let server: Server
let baseUrl: string
let archive: ReturnType<typeof vi.fn<AgentSessionArchiveDependencies['archive']>>

beforeEach(async () => {
  archive = vi.fn<AgentSessionArchiveDependencies['archive']>(async (sessionId) => ({ archive: { id: 'a1', name: sessionId === '$2' ? 'old work' : '?' } }))
  const api = new AgentSessionArchiveApi({
    token,
    paneSession: (paneId) => paneId === '%1' ? { id: '$1', name: 'cleanup' } : null,
    sessions: () => [{ id: '$1', name: 'cleanup' }, { id: '$2', name: 'old work' }, { id: '$3', name: 'tilt-old-work' }],
    isAuxiliary: (sessionId) => sessionId === '$3',
    archive,
  })
  server = createServer((request, response) => {
    void api.handle(request, response, new URL(request.url ?? '/', 'http://127.0.0.1')).then((handled) => {
      if (!handled) { response.statusCode = 404; response.end() }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${baseUrl}/api/agent-sessions/archive`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'X-Commando-Pane': '%1', 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

describe('AgentSessionArchiveApi', () => {
  it('archives another session named by id and exact name', async () => {
    const response = await post({ sessionId: '$2', sessionName: 'old work' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, archive: { id: 'a1', name: 'old work' } })
    expect(archive).toHaveBeenCalledWith('$2')
  })

  it('rejects a wrong token', async () => {
    const response = await post({ sessionId: '$2', sessionName: 'old work' }, { Authorization: 'Bearer nope' })
    expect(response.status).toBe(401)
    expect(archive).not.toHaveBeenCalled()
  })

  it('refuses when the id now belongs to a differently named session', async () => {
    const response = await post({ sessionId: '$2', sessionName: 'something else' })
    expect(response.status).toBe(404)
    expect(archive).not.toHaveBeenCalled()
  })

  it('refuses to archive the caller’s own session', async () => {
    const response = await post({ sessionId: '$1', sessionName: 'cleanup' })
    expect(response.status).toBe(409)
    expect(archive).not.toHaveBeenCalled()
  })

  it('refuses a helper session, which closes with its owner', async () => {
    const response = await post({ sessionId: '$3', sessionName: 'tilt-old-work' })
    expect(response.status).toBe(409)
    expect(archive).not.toHaveBeenCalled()
  })

  it('needs a live caller pane', async () => {
    const response = await post({ sessionId: '$2', sessionName: 'old work' }, { 'X-Commando-Pane': '%9' })
    expect(response.status).toBe(404)
    expect(archive).not.toHaveBeenCalled()
  })

  it('passes on the archive error status', async () => {
    archive.mockRejectedValueOnce(Object.assign(new Error('Tmux session does not exist'), { status: 404 }))
    const response = await post({ sessionId: '$2', sessionName: 'old work' })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Tmux session does not exist' })
  })
})

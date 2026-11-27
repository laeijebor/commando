import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReportBackTaskSnapshot } from '../shared/report-back.js'
import { ReportBackApi } from './report-back-api.js'
import { ReportBackMcpServer } from './report-back-mcp.js'
import { ReportBackStore } from './report-back-store.js'

const tempDirs: string[] = []
const servers: Server[] = []

async function setup(options: {
  ownerAuthorized?: boolean
  onTaskUpdated?: (task: ReportBackTaskSnapshot) => void
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'commando-report-back-api-'))
  tempDirs.push(dir)
  const store = new ReportBackStore({ statePath: join(dir, 'state.json') })
  const api = new ReportBackApi({
    store,
    ownerAuthorized: async () => options.ownerAuthorized ?? true,
    listenerStatus: () => ({
      enabled: true,
      host: '127.0.0.1',
      port: 4311,
      url: 'http://127.0.0.1:4311/mcp',
    }),
    funnelStatus: async () => ({
      enabled: true,
      url: 'https://hub-mac.tail1234.ts.net/mcp',
    }),
    onTaskUpdated: options.onTaskUpdated,
  })

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    void api.handle(req, res, url).then((handled) => {
      if (!handled) {
        res.writeHead(404)
        res.end('unhandled')
      }
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { store, baseUrl: `http://127.0.0.1:${port}` }
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('ReportBackApi', () => {
  it('enforces owner authorization on every report-back route', async () => {
    const { baseUrl } = await setup({ ownerAuthorized: false })

    const statusRes = await fetch(`${baseUrl}/api/report-back/status`)
    expect(statusRes.status).toBe(401)
    expect(await statusRes.json()).toMatchObject({ code: 'unauthorized' })

    const mintRes = await fetch(`${baseUrl}/api/report-back/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-1' }),
    })
    expect(mintRes.status).toBe(401)
  })

  it('serves status, tasks, token minting/listing/revocation, and human replies', async () => {
    const onTaskUpdated = vi.fn()
    const { store, baseUrl } = await setup({ onTaskUpdated })

    const statusRes = await fetch(`${baseUrl}/api/report-back/status`)
    expect(statusRes.status).toBe(200)
    expect(statusRes.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await statusRes.json()).toEqual({
      listener: {
        enabled: true,
        host: '127.0.0.1',
        port: 4311,
        url: 'http://127.0.0.1:4311/mcp',
      },
      funnel: {
        enabled: true,
        url: 'https://hub-mac.tail1234.ts.net/mcp',
      },
    })

    const mintRes = await fetch(`${baseUrl}/api/report-back/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'cloud/task-9', label: 'Build MCP', ttlSeconds: 3600 }),
    })
    expect(mintRes.status).toBe(201)
    const minted = (await mintRes.json()) as { token: string; info: { tokenId: string; taskId: string; expiresAt: number; createdAt: number } }
    expect(minted.token.startsWith('cmrb_')).toBe(true)
    expect(minted.info.taskId).toBe('cloud/task-9')
    expect(minted.info.expiresAt - minted.info.createdAt).toBe(3_600_000)

    const tokensRes = await fetch(`${baseUrl}/api/report-back/tokens`)
    expect(tokensRes.status).toBe(200)
    const tokensBody = (await tokensRes.json()) as { tokens: Array<Record<string, unknown>> }
    expect(tokensBody.tokens).toHaveLength(1)
    expect(tokensBody.tokens[0].token).toBeUndefined()
    expect(tokensBody.tokens[0].tokenHash).toBeUndefined()

    // Agent asks a question, then owner inspects tasks and posts a reply.
    const asked = store.askUser('cloud/task-9', 'Ship it?', { label: 'Build MCP' })
    const tasksRes = await fetch(`${baseUrl}/api/report-back/tasks`)
    expect(tasksRes.status).toBe(200)
    const tasksBody = (await tasksRes.json()) as { tasks: ReportBackTaskSnapshot[] }
    expect(tasksBody.tasks).toHaveLength(1)
    expect(tasksBody.tasks[0].pendingQuestion?.id).toBe(asked.questionId)

    const replyRes = await fetch(
      `${baseUrl}/api/report-back/tasks/${encodeURIComponent('cloud/task-9')}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Yes, ship it!' }),
      },
    )
    expect(replyRes.status).toBe(201)
    const replyBody = (await replyRes.json()) as {
      reply: { cursor: string; message: string; questionId?: string }
      task: ReportBackTaskSnapshot
    }
    expect(replyBody.reply).toMatchObject({
      cursor: '1',
      message: 'Yes, ship it!',
      questionId: asked.questionId,
    })
    expect(replyBody.task.pendingQuestion).toBeUndefined()
    expect(replyBody.task.status).toBe('running')
    expect(onTaskUpdated).toHaveBeenCalledTimes(1)

    // Revoke token and verify 404 on unknown token.
    const revokeRes = await fetch(`${baseUrl}/api/report-back/tokens/${minted.info.tokenId}`, {
      method: 'DELETE',
    })
    expect(revokeRes.status).toBe(200)
    expect((await revokeRes.json()).token.revokedAt).toBeTypeOf('number')
    expect(store.authenticate(minted.token)).toBeNull()

    const missingRevoke = await fetch(`${baseUrl}/api/report-back/tokens/does-not-exist`, {
      method: 'DELETE',
    })
    expect(missingRevoke.status).toBe(404)
  })

  it('rejects bad methods, bad content-type, unknown fields, and unknown routes', async () => {
    const { baseUrl } = await setup()

    const badMethod = await fetch(`${baseUrl}/api/report-back/status`, { method: 'POST' })
    expect(badMethod.status).toBe(405)
    expect(badMethod.headers.get('allow')).toBe('GET')

    const badContentType = await fetch(`${baseUrl}/api/report-back/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    })
    expect(badContentType.status).toBe(415)

    const unknownField = await fetch(`${baseUrl}/api/report-back/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-1', extra: true }),
    })
    expect(unknownField.status).toBe(400)

    const unknownRoute = await fetch(`${baseUrl}/api/report-back/unknown`)
    expect(unknownRoute.status).toBe(404)
  })

  it('completes a full owner-API to loopback-MCP agent round-trip and revokes access', async () => {
    const updates: ReportBackTaskSnapshot[] = []
    const onTaskUpdated = (task: ReportBackTaskSnapshot) => updates.push(task)
    const { store, baseUrl } = await setup({ onTaskUpdated })
    const mcp = new ReportBackMcpServer({ store, port: 0, onTaskUpdated })
    const mcpAddr = await mcp.start()

    try {
      // 1. Owner mints per-task token.
      const mintRes = await fetch(`${baseUrl}/api/report-back/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: 'cma-session-1', label: 'Remote fix' }),
      })
      expect(mintRes.status).toBe(201)
      const { token, info } = (await mintRes.json()) as { token: string; info: { tokenId: string } }

      // 2. Cloud agent calls ask_user on loopback MCP.
      const askRes = await fetch(mcpAddr.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'ask_user', arguments: { question: 'Run DB migration?' } },
        }),
      })
      expect(askRes.status).toBe(200)

      // 3. Owner sees waiting task and replies.
      const tasksRes = await fetch(`${baseUrl}/api/report-back/tasks`)
      const tasksBody = (await tasksRes.json()) as { tasks: ReportBackTaskSnapshot[] }
      expect(tasksBody.tasks[0]).toMatchObject({
        taskId: 'cma-session-1',
        label: 'Remote fix',
        status: 'waiting',
      })
      expect(tasksBody.tasks[0].pendingQuestion?.question).toBe('Run DB migration?')

      const replyRes = await fetch(`${baseUrl}/api/report-back/tasks/cma-session-1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Approved, run it' }),
      })
      expect(replyRes.status).toBe(201)

      // 4. Agent reads human reply via MCP and marks task done.
      const readRes = await fetch(mcpAddr.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'read_messages', arguments: {} },
        }),
      })
      const readJson = (await readRes.json()) as {
        result: { structuredContent: { messages: Array<{ message: string }>; nextCursor: string } }
      }
      expect(readJson.result.structuredContent.messages.map((m) => m.message)).toEqual([
        'Approved, run it',
      ])

      const doneRes = await fetch(mcpAddr.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'set_status', arguments: { status: 'done', summary: 'Migration complete' } },
        }),
      })
      expect(doneRes.status).toBe(200)
      expect(updates.map((u) => u.status)).toEqual(['waiting', 'running', 'done'])

      // 5. Owner revokes token; agent is immediately rejected.
      const revokeRes = await fetch(`${baseUrl}/api/report-back/tokens/${info.tokenId}`, {
        method: 'DELETE',
      })
      expect(revokeRes.status).toBe(200)

      const rejected = await fetch(mcpAddr.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }),
      })
      expect(rejected.status).toBe(401)
    } finally {
      await mcp.close()
    }
  })
})

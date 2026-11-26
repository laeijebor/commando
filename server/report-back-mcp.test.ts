import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReportBackTaskSnapshot } from '../shared/report-back.js'
import {
  configuredReportBackPort,
  DEFAULT_REPORT_BACK_PORT,
  MCP_PROTOCOL_VERSION,
  REPORT_BACK_LOOPBACK_HOST,
  REPORT_BACK_MAX_BODY_BYTES,
  ReportBackMcpServer,
} from './report-back-mcp.js'
import { ReportBackStore } from './report-back-store.js'

const tempDirs: string[] = []
const runningServers: ReportBackMcpServer[] = []

function setup(onTaskUpdated?: (task: ReportBackTaskSnapshot) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'commando-report-back-mcp-'))
  tempDirs.push(dir)
  const store = new ReportBackStore({ statePath: join(dir, 'state.json') })
  const server = new ReportBackMcpServer({ store, port: 0, onTaskUpdated })
  runningServers.push(server)
  return { store, server }
}

async function rpcPost(url: string, token: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

afterEach(async () => {
  while (runningServers.length > 0) {
    await runningServers.pop()!.close()
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('configuredReportBackPort', () => {
  it('defaults to 4311 on default daemon port and disables on non-default daemon port', () => {
    expect(configuredReportBackPort({}, 4310, 4310)).toBe(DEFAULT_REPORT_BACK_PORT)
    expect(configuredReportBackPort({}, 4410, 4310)).toBeNull()
  })

  it('respects COMMANDO_REPORT_BACK_PORT overrides and rejects invalid/colliding ports', () => {
    expect(configuredReportBackPort({ COMMANDO_REPORT_BACK_PORT: '0' }, 4310, 4310)).toBeNull()
    expect(configuredReportBackPort({ COMMANDO_REPORT_BACK_PORT: '4511' }, 4410, 4310)).toBe(4511)
    expect(() => configuredReportBackPort({ COMMANDO_REPORT_BACK_PORT: '4310' }, 4310, 4310)).toThrow()
    expect(() => configuredReportBackPort({ COMMANDO_REPORT_BACK_PORT: 'abc' }, 4310, 4310)).toThrow()
    expect(() => configuredReportBackPort({ COMMANDO_REPORT_BACK_PORT: '70000' }, 4310, 4310)).toThrow()
  })
})

describe('ReportBackMcpServer', () => {
  it('binds only to 127.0.0.1 and enforces route, method, auth, headers, and body size cap', async () => {
    const { store, server } = setup()
    const addr = await server.start()
    expect(addr.host).toBe(REPORT_BACK_LOOPBACK_HOST)
    expect(addr.port).toBeGreaterThan(0)
    expect(addr.url).toBe(`http://127.0.0.1:${addr.port}/mcp`)
    expect(server.listenerStatus()).toEqual({ enabled: true, ...addr })

    const { token, info } = store.mintToken({ taskId: 'task-auth' })

    const notFound = await fetch(`http://127.0.0.1:${addr.port}/other`, { method: 'POST' })
    expect(notFound.status).toBe(404)
    expect(notFound.headers.get('x-content-type-options')).toBe('nosniff')

    const wrongMethod = await fetch(addr.url, { method: 'GET' })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')

    const noAuth = await fetch(addr.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    expect(noAuth.status).toBe(401)
    expect(noAuth.headers.get('www-authenticate')).toContain('Bearer')

    const badAuth = await rpcPost(addr.url, 'cmrb_invalid', { jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(badAuth.status).toBe(401)

    const wrongContentType = await fetch(addr.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: '{}',
    })
    expect(wrongContentType.status).toBe(415)

    const oversized = await fetch(addr.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad: 'a'.repeat(REPORT_BACK_MAX_BODY_BYTES + 64) }),
    })
    expect(oversized.status).toBe(413)

    // Revoking token immediately blocks further requests.
    store.revokeToken(info.tokenId)
    const revoked = await rpcPost(addr.url, token, { jsonrpc: '2.0', id: 2, method: 'ping' })
    expect(revoked.status).toBe(401)
  })

  it('handles MCP initialize, notifications/initialized, ping, and tools/list', async () => {
    const { store, server } = setup()
    const addr = await server.start()
    const { token } = store.mintToken({ taskId: 'task-proto' })

    const init = await rpcPost(addr.url, token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    })
    expect(init.status).toBe(200)
    expect(await init.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'commando-report-back', version: '1.0.0' },
      },
    })

    const initialized = await rpcPost(addr.url, token, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })
    expect(initialized.status).toBe(202)
    expect(await initialized.text()).toBe('')

    const ping = await rpcPost(addr.url, token, { jsonrpc: '2.0', id: 'p1', method: 'ping' })
    expect(await ping.json()).toEqual({ jsonrpc: '2.0', id: 'p1', result: {} })

    const list = await rpcPost(addr.url, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const listBody = (await list.json()) as { result: { tools: Array<{ name: string }> } }
    expect(listBody.result.tools.map((t) => t.name)).toEqual([
      'post_update',
      'ask_user',
      'read_messages',
      'set_status',
    ])
  })

  it('executes post_update, ask_user, read_messages, and set_status scoped to token taskId', async () => {
    const updatedTasks: ReportBackTaskSnapshot[] = []
    const onTaskUpdated = vi.fn((task: ReportBackTaskSnapshot) => updatedTasks.push(task))
    const { store, server } = setup(onTaskUpdated)
    const addr = await server.start()
    const { token } = store.mintToken({ taskId: 'cloud-42', label: 'Refactor auth' })

    const postRes = await rpcPost(addr.url, token, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'post_update', arguments: { message: 'Tests passing locally' } },
    })
    const postJson = (await postRes.json()) as { result: { structuredContent: Record<string, unknown> } }
    expect(postJson.result.structuredContent).toMatchObject({ ok: true, taskId: 'cloud-42' })

    const askRes = await rpcPost(addr.url, token, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'ask_user', arguments: { question: 'Should I push to origin?' } },
    })
    const askJson = (await askRes.json()) as { result: { structuredContent: { questionId: string; status: string } } }
    expect(askJson.result.structuredContent.questionId).toBeTruthy()
    expect(askJson.result.structuredContent.status).toBe('waiting')

    // Human replies via store; agent reads with cursor.
    store.postHumanReply('cloud-42', 'Yes, push the branch')
    const read1Res = await rpcPost(addr.url, token, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'read_messages', arguments: {} },
    })
    const read1Json = (await read1Res.json()) as {
      result: { structuredContent: { messages: Array<{ message: string; cursor: string }>; nextCursor: string } }
    }
    expect(read1Json.result.structuredContent.messages).toHaveLength(1)
    expect(read1Json.result.structuredContent.messages[0].message).toBe('Yes, push the branch')
    const cursor = read1Json.result.structuredContent.nextCursor

    const read2Res = await rpcPost(addr.url, token, {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'read_messages', arguments: { cursor } },
    })
    const read2Json = (await read2Res.json()) as {
      result: { structuredContent: { messages: unknown[]; nextCursor: string } }
    }
    expect(read2Json.result.structuredContent.messages).toEqual([])
    expect(read2Json.result.structuredContent.nextCursor).toBe(cursor)

    const statusRes = await rpcPost(addr.url, token, {
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'set_status', arguments: { status: 'done', summary: 'Branch pushed' } },
    })
    const statusJson = (await statusRes.json()) as {
      result: { structuredContent: { status: string; summary: string } }
    }
    expect(statusJson.result.structuredContent).toMatchObject({ status: 'done', summary: 'Branch pushed' })

    expect(onTaskUpdated).toHaveBeenCalledTimes(3)
    expect(updatedTasks.map((t) => t.status)).toEqual(['running', 'waiting', 'done'])
  })

  it('returns JSON-RPC errors for invalid JSON, unknown methods, unknown tools, and bad params', async () => {
    const { store, server } = setup()
    const addr = await server.start()
    const { token } = store.mintToken({ taskId: 'task-err' })

    const badJson = await fetch(addr.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{invalid',
    })
    expect(badJson.status).toBe(400)
    expect((await badJson.json()).error.code).toBe(-32700)

    const unknownMethod = await rpcPost(addr.url, token, { jsonrpc: '2.0', id: 1, method: 'unknown/method' })
    expect((await unknownMethod.json()).error.code).toBe(-32601)

    const unknownTool = await rpcPost(addr.url, token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'delete_everything', arguments: {} },
    })
    expect((await unknownTool.json()).error.code).toBe(-32602)

    const badStatus = await rpcPost(addr.url, token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'set_status', arguments: { status: 'exploded' } },
    })
    expect((await badStatus.json()).error.code).toBe(-32602)

    const extraArg = await rpcPost(addr.url, token, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'post_update', arguments: { message: 'hi', taskId: 'other-task' } },
    })
    expect((await extraArg.json()).error.code).toBe(-32602)
  })
})

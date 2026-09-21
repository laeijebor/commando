import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentInteractionRequest } from '../shared/protocol.js'
import { AgentInteractionBroker } from './agent-interaction-broker.js'
import { AgentRequestApi } from './agent-request-api.js'
import type { AgentStatusChange } from './agent-status-registry.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

const permission: AgentInteractionRequest = {
  id: 'permission-1',
  kind: 'permission',
  prompt: 'Run tests?',
  createdAt: 1,
}

const question: AgentInteractionRequest = {
  id: 'question/1',
  kind: 'question',
  prompt: 'Which target?',
  questions: [{
    header: 'Target',
    question: 'Which target?',
    options: [{ label: 'macOS' }],
    multiple: false,
    custom: false,
  }],
  createdAt: 2,
}

function setup(options: { paneExists?: (paneId: string) => boolean } = {}) {
  const interactions = new AgentInteractionBroker()
  interactions.registerConsumer()
  const change: AgentStatusChange = { type: 'remove', paneId: '%12' }
  const resolveInteractionRequest = vi.fn(() => change)
  const onStatusChange = vi.fn()
  const api = new AgentRequestApi({
    interactions,
    registry: { resolveInteractionRequest },
    onStatusChange,
    paneExists: options.paneExists ?? ((paneId) => paneId === '%12'),
  })
  return { interactions, api, resolveInteractionRequest, onStatusChange }
}

async function startApi(api: AgentRequestApi): Promise<string> {
  const server = createServer((request, response) => {
    void api.handle(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function answer(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/agent-requests/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('agent request answer API', () => {
  it('answers a pending request through the URL-encoded pane id', async () => {
    const context = setup()
    const waiting = context.interactions.wait('%12', permission)
    const baseUrl = await startApi(context.api)

    const response = await answer(baseUrl, '%2512/permission-1/answer', {
      answer: { action: 'allow_once' },
      idempotencyKey: 'notification-1',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, changed: true })
    await expect(waiting).resolves.toEqual({ action: 'allow_once' })
    expect(context.resolveInteractionRequest).toHaveBeenCalledWith('%12', 'permission-1')
    expect(context.onStatusChange).toHaveBeenCalledWith({ type: 'remove', paneId: '%12' })
  })

  it('decodes an interaction id that contains reserved characters', async () => {
    const context = setup()
    const waiting = context.interactions.wait('%12', question)
    const baseUrl = await startApi(context.api)

    const response = await answer(baseUrl, `%2512/${encodeURIComponent('question/1')}/answer`, {
      answer: { action: 'answer', answers: [['macOS']] },
      idempotencyKey: 'notification-2',
    })

    expect(response.status).toBe(200)
    await expect(waiting).resolves.toEqual({ action: 'answer', answers: [['macOS']] })
  })

  it('re-acks a repeated idempotency key without answering twice', async () => {
    const context = setup()
    context.interactions.wait('%12', permission)
    const baseUrl = await startApi(context.api)
    const body = { answer: { action: 'deny' }, idempotencyKey: 'notification-3' }

    const first = await answer(baseUrl, '%2512/permission-1/answer', body)
    const waiting = context.interactions.wait('%12', permission)
    const second = await answer(baseUrl, '%2512/permission-1/answer', body)

    expect(await first.json()).toEqual({ ok: true, changed: true })
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ ok: true, changed: false })
    expect(context.interactions.hasPending('%12', 'permission-1')).toBe(true)
    expect(context.resolveInteractionRequest).toHaveBeenCalledTimes(1)
    context.interactions.cancel('%12', 'permission-1')
    await expect(waiting).resolves.toBeNull()
  })

  it('reports 409 for a request that is no longer pending', async () => {
    const context = setup()
    const baseUrl = await startApi(context.api)

    const response = await answer(baseUrl, '%2512/permission-1/answer', {
      answer: { action: 'deny' },
      idempotencyKey: 'notification-4',
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'The agent request is no longer pending' })
    expect(context.onStatusChange).not.toHaveBeenCalled()
  })

  it('reports 400 for an answer that does not match the pending request', async () => {
    const context = setup()
    context.interactions.wait('%12', question)
    const baseUrl = await startApi(context.api)

    const response = await answer(baseUrl, `%2512/${encodeURIComponent('question/1')}/answer`, {
      answer: { action: 'allow_once' },
      idempotencyKey: 'notification-5',
    })

    expect(response.status).toBe(400)
    expect(context.interactions.hasPending('%12', 'question/1')).toBe(true)
  })

  it('rejects malformed bodies, pane ids, methods, and unknown panes', async () => {
    const context = setup()
    context.interactions.wait('%12', permission)
    const baseUrl = await startApi(context.api)

    const noKey = await answer(baseUrl, '%2512/permission-1/answer', {
      answer: { action: 'deny' },
    })
    const badAnswer = await answer(baseUrl, '%2512/permission-1/answer', {
      answer: { action: 'shrug' },
      idempotencyKey: 'notification-6',
    })
    const badPane = await answer(baseUrl, '12/permission-1/answer', {
      answer: { action: 'deny' },
      idempotencyKey: 'notification-7',
    })
    const unknownPane = await answer(baseUrl, '%2599/permission-1/answer', {
      answer: { action: 'deny' },
      idempotencyKey: 'notification-8',
    })
    const notFound = await answer(baseUrl, '%2512/permission-1', {
      answer: { action: 'deny' },
      idempotencyKey: 'notification-9',
    })
    const wrongMethod = await fetch(`${baseUrl}/api/agent-requests/%2512/permission-1/answer`)

    expect(noKey.status).toBe(400)
    expect(badAnswer.status).toBe(400)
    expect(badPane.status).toBe(400)
    expect(unknownPane.status).toBe(404)
    expect(notFound.status).toBe(404)
    expect(wrongMethod.status).toBe(405)
    expect(context.interactions.hasPending('%12', 'permission-1')).toBe(true)
  })

  it('ignores paths outside the agent request root', async () => {
    const context = setup()
    const handled = await context.api.handle(
      { method: 'POST', headers: {} } as never,
      { } as never,
      new URL('http://127.0.0.1/api/pane-management/panes/%2512/rename'),
    )
    expect(handled).toBe(false)
  })
})

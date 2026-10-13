import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexRpcClient } from './client.js'

function harness(options = {}) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) })
  const sent: Record<string, unknown>[] = []
  child.stdin.on('data', (chunk) => {
    const message = JSON.parse(String(chunk))
    sent.push(message)
    if (message.method === 'initialize') child.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'fake' } })}\n`)
  })
  const client = new CodexRpcClient({ cwd: '/tmp', spawn: () => child as unknown as ChildProcessWithoutNullStreams, ...options })
  const receive = (message: unknown) => child.stdout.write(`${JSON.stringify(message)}\n`)
  clients.push(() => { client.close(); child.emit('exit', 0, null) })
  return { child, client, sent, receive }
}
const clients: (() => void)[] = []
afterEach(() => { clients.splice(0).forEach((cleanup) => cleanup()); vi.useRealTimers() })

describe('CodexRpcClient', () => {
  it('initializes before initialized, correlates out-of-order replies and accepts split lines', async () => {
    const { client, child, sent, receive } = harness()
    await client.start()
    expect(sent.slice(0, 2)).toMatchObject([{ method: 'initialize', params: { capabilities: { experimentalApi: true } } }, { method: 'initialized' }])
    const first = client.request('model/list', {})
    const second = client.request('thread/read', { threadId: 't', includeTurns: true })
    receive({ id: sent[3]!.id, result: 'second' })
    const line = JSON.stringify({ id: sent[2]!.id, result: 'first' })
    child.stdout.write(line.slice(0, 8))
    child.stdout.write(`${line.slice(8)}\n`)
    expect(await first).toBe('first')
    expect(await second).toBe('second')
  })
  it('delivers notifications and server requests, errors on unsupported requests without hanging', async () => {
    const { client, sent, receive } = harness()
    const notification = vi.fn()
    client.onNotification(notification)
    client.onRequest((request) => {
      if (request.method !== 'approval') return false
      client.respond(request.id, { decision: 'accept' })
      return true
    })
    await client.start()
    receive({ method: 'item/started', params: { item: { id: 'i' } } })
    receive({ id: 'req', method: 'approval' })
    receive({ id: 0, method: 'mcpServer/elicitation/request' })
    expect(notification).toHaveBeenCalledWith({ method: 'item/started', params: { item: { id: 'i' } } })
    expect(sent.slice(-2)).toEqual([{ id: 'req', result: { decision: 'accept' } }, { id: 0, error: { code: -32601, message: 'Unsupported server request: mcpServer/elicitation/request' } }])
  })
  it('rejects RPC errors, ignores malformed input, and times out a missing response', async () => {
    vi.useFakeTimers()
    const { client, child, sent, receive } = harness({ timeoutMs: 20 })
    await client.start()
    child.stdout.write('bad json\nnull\n')
    const response = client.request('model/list', {})
    const rejected = expect(response).rejects.toThrow('bad params')
    receive({ id: sent.at(-1)!.id, error: { code: -32602, message: 'bad params' } })
    await rejected
    const timeout = expect(client.request('model/list', {})).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(20)
    await timeout
  })
  it('rejects outstanding calls on child exit and removes signal listeners', async () => {
    const count = process.listenerCount('SIGTERM')
    const { client, child } = harness()
    const closed = vi.fn()
    client.onClose(closed)
    await client.start()
    const pending = expect(client.request('model/list', {})).rejects.toThrow('exited')
    child.emit('exit', 1, null)
    await pending
    expect(closed).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()
    expect(process.listenerCount('SIGTERM')).toBe(count)
  })
  it('kills only its child, escalating once after the grace period', async () => {
    vi.useFakeTimers()
    const { client, child } = harness({ killGraceMs: 20 })
    await client.start()
    const pending = expect(client.request('model/list', {})).rejects.toThrow('closed')
    client.close()
    client.close()
    await pending
    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
    await vi.advanceTimersByTimeAsync(20)
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
  })
})


it('reports closed only after the owned child exits, cancelling escalation', async () => {
  vi.useFakeTimers()
  const { client, child } = harness({ killGraceMs: 20 })
  const closed = vi.fn()
  client.onClose(closed)
  await client.start()
  client.close()
  expect(closed).not.toHaveBeenCalled()
  child.emit('exit', 0, null)
  expect(closed).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(20)
  expect(child.kill.mock.calls).toEqual([['SIGTERM']])
})

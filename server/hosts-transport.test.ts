import { EventEmitter } from 'node:events'
import { request, type ClientRequest, type RequestOptions } from 'node:http'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { probeHost } from './hosts-health.js'
import { remoteRequest } from './hosts-transport.js'

vi.mock('node:http', async (original) => ({ ...await original<typeof import('node:http')>(), request: vi.fn() }))
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })
const host = { id: 'hub', name: 'Hub', baseUrl: 'http://127.0.0.1:4310', token: 'remote-secret', addedAt: 1 }

function transport(status = 200, body = '{"ok":true,"version":"v1"}') {
  const incoming = Object.assign(new PassThrough(), { statusCode: status })
  const outgoing = new EventEmitter()
  const socket = Object.assign(new EventEmitter(), { connecting: true })
  const destroy = vi.fn((error?: Error) => {
    if (error) outgoing.emit('error', error)
    outgoing.emit('close')
    return outgoing
  })
  const end = vi.fn(() => {
    queueMicrotask(() => {
      outgoing.emit('socket', socket)
      socket.emit('connect')
      outgoing.emit('response', incoming)
      if (!incoming.destroyed) incoming.end(body)
    })
  })
  incoming.once('close', () => outgoing.emit('close'))
  const setTimeout = vi.fn()
  Object.assign(outgoing, { destroy, end, setTimeout })
  vi.mocked(request).mockReturnValueOnce(outgoing as ClientRequest)
  return { outgoing, socket, incoming, destroy, setTimeout }
}

it('probes health and protected endpoints with the server-side credential', async () => {
  transport(); transport(200, '{}')
  expect(await probeHost(host)).toMatchObject({ state: 'online', version: 'v1' })
  expect(vi.mocked(request).mock.calls.map((args) => [String(args[0]), args[1]])).toEqual([
    ['http://127.0.0.1:4310/api/health', { method: 'GET', headers: { Authorization: 'Bearer remote-secret' }, signal: undefined }],
    ['http://127.0.0.1:4310/api/snapshot', { method: 'GET', headers: { Authorization: 'Bearer remote-secret' }, signal: undefined }],
  ])
})

it('installs the connect-time MagicDNS lookup on HTTP requests and both health probes', async () => {
  const remote = { ...host, baseUrl: 'http://hub.tailnet.ts.net:4310' }
  const direct = transport()
  remoteRequest(new URL(remote.baseUrl), { method: 'POST' })
  direct.outgoing.emit('close')
  transport(); transport(200, '{}')
  expect((await probeHost(remote)).state).toBe('online')
  expect(request).toHaveBeenCalledTimes(3)
  for (const args of vi.mocked(request).mock.calls) expect((args[1] as RequestOptions).lookup).toBeTypeOf('function')
})

it.each([401, 403])('classifies protected endpoint %s even when health succeeds', async (status) => {
  transport(); transport(status)
  expect(await probeHost(host)).toMatchObject({ state: 'unauthorized' })
})

it.each([[302, '{}'], [500, '{}'], [200, 'not json'], [200, '{"ok":false}'], [200, 'x'.repeat(65537)]])('fails closed on status %s or invalid health', async (status, body) => {
  transport(status as number, body as string)
  expect(await probeHost(host)).toMatchObject({ state: 'offline' })
  expect(request).toHaveBeenCalledTimes(1) // no redirect or protected probe after bad health
})

it('bounds connect time and configures an idle timeout', async () => {
  vi.useFakeTimers()
  const { outgoing, destroy, setTimeout } = transport()
  outgoing.on('error', () => {})
  remoteRequest(new URL(host.baseUrl), {})
  expect(setTimeout).toHaveBeenCalledWith(30_000, expect.any(Function))
  await vi.advanceTimersByTimeAsync(5_000)
  expect(destroy).toHaveBeenCalledWith(expect.objectContaining({ message: 'Remote connect timeout' }))
})

it('clears the connect timer once connected and destroys idle requests', async () => {
  vi.useFakeTimers()
  const { outgoing, socket, destroy, setTimeout } = transport()
  outgoing.on('error', () => {})
  remoteRequest(new URL(host.baseUrl), {})
  outgoing.emit('socket', socket); socket.emit('connect')
  await vi.advanceTimersByTimeAsync(5_000)
  expect(destroy).not.toHaveBeenCalled()
  setTimeout.mock.calls[0][1]()
  expect(destroy).toHaveBeenCalledWith(expect.objectContaining({ message: 'Remote idle timeout' }))
})

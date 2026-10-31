import { lookup, type LookupAddress } from 'node:dns'
import { mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage, RequestOptions } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { WebSocket } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { HostsProxy } from './hosts-proxy.js'
import { HostRegistry } from './hosts.js'
import { MAX_CHAT_HISTORY_BYTES } from './chat-replay.js'

vi.mock('node:dns', async (original) => ({ ...await original<typeof import('node:dns')>(), lookup: vi.fn() }))
vi.mock('ws', async (original) => {
  const actual = await original<typeof import('ws')>()
  const { EventEmitter } = await import('node:events')
  class Remote extends EventEmitter { terminate() { this.emit('close') } }
  return { ...actual, WebSocket: vi.fn(function () { return new Remote() }) }
})
afterEach(() => { vi.resetAllMocks() })

it.each(['127.0.0.1', '8.8.8.8'])('uses the checked lookup on WS connections resolving to %s', async (address) => {
  const directory = await mkdtemp(join(tmpdir(), 'commando-hosts-ws-dns-'))
  const registry = new HostRegistry(join(directory, 'hosts.json'))
  const host = registry.add({ name: 'Hub', baseUrl: 'http://hub.tailnet.ts.net:4310', token: 'remote-secret' })
  const proxy = new HostsProxy(registry, async () => true)
  const socket = new PassThrough()
  try {
    const request = Object.assign(new PassThrough(), { method: 'GET', headers: {} }) as unknown as IncomingMessage
    await proxy.upgrade(request, socket, Buffer.alloc(0), new URL(`http://localhost/h/${host.id}/ws`))
    const options = vi.mocked(WebSocket).mock.calls[0][2] as RequestOptions & { maxPayload: number }
    expect(options.maxPayload).toBeGreaterThan(MAX_CHAT_HISTORY_BYTES)
    expect(options.lookup).toBeTypeOf('function')
    vi.mocked(lookup).mockImplementationOnce((...args: unknown[]) => {
      const callback = args[2] as (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
      callback(null, [{ address, family: 4 }])
    })
    const result = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      options.lookup!('hub.tailnet.ts.net', { all: true }, (error) => resolve(error))
    })
    expect(result?.code).toBe(address === '127.0.0.1' ? undefined : 'EACCES')
    request.destroy()
  } finally { proxy.close(); socket.destroy(); await rm(directory, { recursive: true, force: true }) }
})

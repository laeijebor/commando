import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ calls: [] as { url: URL; options: Record<string, unknown>; body?: string }[], body: Buffer.from('page') }))
vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events')
  return { request: (url: URL, options: Record<string, unknown>, callback: (res: unknown) => void) => {
    const call = { url, options, body: undefined as string | undefined }; state.calls.push(call)
    const req = new EventEmitter() as InstanceType<typeof EventEmitter> & { end: (body?: string) => void }
    req.end = (body) => {
      call.body = body
      const res = new EventEmitter() as InstanceType<typeof EventEmitter> & { rawHeaders: string[]; statusCode: number; destroy: (error: Error) => void }
      let destroyed = false
      res.statusCode = 302; res.rawHeaders = ['Location', '/next', 'Connection', 'close']
      res.destroy = (error) => { destroyed = true; res.emit('error', error) }
      callback(res)
      queueMicrotask(() => { res.emit('data', state.body); if (!destroyed) res.emit('end') })
    }
    return req
  } }
})
vi.mock('node:https', async () => ({ request: (await import('node:http')).request }))
import { fetchCaptureRequest } from './board-capture-network.js'
import { registerBrowserDebuggingPort } from './board-capture-policy.js'

beforeEach(() => { state.calls = []; state.body = Buffer.from('page') })
describe('pinned capture transport (stub sockets)', () => {
  it('rejects newly registered debugging ports again at transport dispatch without opening a socket', async () => {
    let exit!: () => void
    registerBrowserDebuggingPort(9556, new Promise<void>((resolve) => { exit = resolve }))
    try {
      await expect(fetchCaptureRequest({ url: 'http://127.0.0.1:9556/json/version' }, { address: '127.0.0.1', family: 4 }, new AbortController().signal)).rejects.toThrow('debugging')
      expect(state.calls).toHaveLength(0)
    } finally { exit(); await Promise.resolve() }
  })
  it('keeps the original TLS host, pins lookup, preserves redirects without following them, and bounds headers/body', async () => {
    const address = { address: '93.184.216.34', family: 4 }
    const response = await fetchCaptureRequest({ url: 'https://public.example/app', method: 'POST', headers: { Host: 'spoofed', Connection: 'keep-alive', Cookie: 'capture-only=1' }, postData: 'body' }, address, new AbortController().signal)
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0].url.hostname).toBe('public.example')
    expect(state.calls[0]).toMatchObject({ body: 'body', options: { method: 'POST', headers: { Cookie: 'capture-only=1', 'accept-encoding': 'identity' } } })
    const lookup = state.calls[0].options.lookup as (host: string, opts: { all: boolean }, cb: ReturnType<typeof vi.fn>) => void
    const callback = vi.fn(); lookup('public.example', { all: true }, callback)
    expect(callback).toHaveBeenCalledWith(null, [address])
    expect(response).toMatchObject({ status: 302, headers: [{ name: 'Location', value: '/next' }], body: Buffer.from('page') })
  })
  it('fails oversized requests/responses without real Chromium, DNS or sockets', async () => {
    const address = { address: '93.184.216.34', family: 4 }, signal = new AbortController().signal
    await expect(fetchCaptureRequest({ url: 'https://public.example/', hasPostData: true }, address, signal)).rejects.toThrow('request body')
    expect(state.calls).toHaveLength(0)
    state.body = Buffer.alloc(20 * 1024 * 1024 + 1)
    await expect(fetchCaptureRequest({ url: 'https://public.example/' }, address, signal)).rejects.toThrow('20 MiB')
  })
})
